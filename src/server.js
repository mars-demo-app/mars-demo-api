"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { Pool } = require("pg");
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL;
const CRASH_AFTER = Number(process.env.DEMO_CRASH_AFTER_REQUESTS || 0);
/** Artificial per-request delay for scale demos. 0 = off (safe default). */
const HANDLER_DELAY_MS = Math.max(0, Number(process.env.DEMO_HANDLER_DELAY_MS || 0) || 0);
/** Cap concurrent in-flight non-health handlers. 0 = unlimited (safe default). */
const MAX_INFLIGHT = Math.max(0, Number(process.env.DEMO_MAX_INFLIGHT || 0) || 0);
/** pg pool size; keep small so unindexed hammers show connection wait. */
const PG_POOL_MAX = Math.max(1, Number(process.env.DEMO_PG_POOL_MAX || 5) || 5);
/** Hard cap for one-click seed endpoint. */
const SEED_MAX = 200_000;
/** Warn-log successful handlers slower than this (ms). Helps when edge 504s never reach Node. */
const SLOW_LOG_MS = Math.max(0, Number(process.env.DEMO_SLOW_LOG_MS || 500) || 0);

/**
 * Burn-CPU: short duty-cycled busy/yield on the event loop.
 * On 1 vCPU, a busy worker_thread still starves HTTP via the OS scheduler
 * (→ gateway 504) even while Insights averages look low. Keeping bursts
 * short (≤~10ms) lets health/API run between spins for a sustained graph.
 */
const BURN_CPU_MAX_MS = Math.max(100, Number(process.env.DEMO_BURN_CPU_MAX_MS || 180_000) || 180_000);
const BURN_CPU_DEFAULT_MS = 90_000;
const BURN_CPU_DEFAULT_DUTY = Math.min(
  0.98,
  Math.max(0.1, Number(process.env.DEMO_BURN_CPU_DUTY || process.env.DEMO_BURN_CPU_TARGET_PCT || 0.95) || 0.95)
);
const BURN_CPU_DEFAULT_SLICE_MS = Math.max(
  5,
  Math.min(100, Number(process.env.DEMO_BURN_CPU_SLICE_MS || 20) || 20)
);
/** Hard cap on one busy burst — high enough for ~95% duty with short yields. */
const BURN_CPU_MAX_BUSY_MS = Math.max(
  1,
  Math.min(50, Number(process.env.DEMO_BURN_CPU_MAX_BUSY_MS || 19) || 19)
);

/**
 * Burn-memory: grow RSS toward target_pct of the instance memory limit, then hold.
 * apps-s-1vcpu-0.5gb ≈ 512MiB cgroup — default 95% crosses common 90% alert
 * thresholds while leaving ~5% headroom for HTTP. Single-burn only (exit 128 OOM).
 */
const BURN_MEM_MAX_HOLD_MS = Math.max(100, Number(process.env.DEMO_BURN_MEM_MAX_HOLD_MS || 180_000) || 180_000);
const BURN_MEM_DEFAULT_HOLD_MS = 60_000;
const BURN_MEM_DEFAULT_TARGET_PCT = Math.min(
  0.98,
  Math.max(0.5, Number(process.env.DEMO_BURN_MEM_TARGET_PCT || 0.95) || 0.95)
);
/** Chunk size while approaching the target (keeps alloc incremental + yields). */
const BURN_MEM_CHUNK_MB = Math.max(
  1,
  Math.min(64, Number(process.env.DEMO_BURN_MEM_CHUNK_MB || 16) || 16)
);
/** Fallback when cgroup / DEMO_MEM_LIMIT_MB unavailable (App Platform 0.5gb slug). */
const BURN_MEM_LIMIT_FALLBACK_MB = Math.max(
  64,
  Number(process.env.DEMO_MEM_LIMIT_MB || process.env.DEMO_BURN_MEM_LIMIT_MB || 512) || 512
);

const MARKER_5XX = "MARS_DEMO_5XX";
const MARKER_SLOW = "MARS_DEMO_SLOW";
const MARKER_CANCEL_BREAK = "MARS_DEMO_ERROR_LOG";
const MARKER_BURN_CPU = "MARS_DEMO_BURN_CPU";
const MARKER_BURN_MEM = "MARS_DEMO_BURN_MEM";
const MARKER_OOM = "MARS_DEMO_OOM";

let requestCount = 0;
let inflight = 0;
let peakInflight = 0;
let saturatedTotal = 0;
let cpuBurnsActive = 0;
let memBurnsActive = 0;
/** Retained during memory burns so V8 cannot GC the allocation early. */
const retainedMemChunks = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pgPoolConfig(url) {
  if (process.env.PGSSL === "disable") {
    return { connectionString: url, ssl: false, max: PG_POOL_MAX };
  }
  // DO managed PG URLs include sslmode=require; pg v8 treats that as verify-full.
  let cleaned = url;
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("uselibpqcompat");
    cleaned = u.toString();
  } catch {
    cleaned = url;
  }
  return {
    connectionString: cleaned,
    ssl: { rejectUnauthorized: false },
    max: PG_POOL_MAX,
  };
}

const pool = DATABASE_URL ? new Pool(pgPoolConfig(DATABASE_URL)) : null;

function bindRequestContext(req, res, path) {
  res.__mars = {
    method: req.method || "GET",
    path: path || "/",
  };
}

/**
 * Send JSON. Every 5xx logs once with marker MARS_DEMO_5XX unless the body
 * already carries MARS_DEMO_ERROR_LOG (cancel-break path logs its own line).
 */
function json(res, status, body, opts = {}) {
  if (status >= 500 && !opts.skipFiveXxLog && body?.marker !== MARKER_CANCEL_BREAK) {
    const ctx = res.__mars || {};
    console.error(
      JSON.stringify({
        marker: MARKER_5XX,
        level: "error",
        status,
        method: ctx.method || null,
        path: ctx.path || null,
        error: body?.error || body?.db || "server error",
        detail: body?.hint || body?.marker || null,
        inflight,
        demo_max_inflight: MAX_INFLIGHT || null,
      })
    );
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function maybeLogSlow(res, tookMs, extra = {}) {
  if (!SLOW_LOG_MS || tookMs < SLOW_LOG_MS) return;
  const ctx = res.__mars || {};
  console.warn(
    JSON.stringify({
      marker: MARKER_SLOW,
      level: "warn",
      status: 200,
      method: ctx.method || null,
      path: ctx.path || null,
      took_ms: tookMs,
      threshold_ms: SLOW_LOG_MS,
      ...extra,
    })
  );
}

function maybeCrashAfterSuccess() {
  if (!CRASH_AFTER || CRASH_AFTER <= 0) return;
  requestCount += 1;
  if (requestCount >= CRASH_AFTER) {
    console.error(
      `[demo] DEMO_CRASH_AFTER_REQUESTS=${CRASH_AFTER} reached; exiting to simulate bad deploy`
    );
    setTimeout(() => process.exit(1), 50);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Apply delay + inflight gate. Health bypasses this. */
async function withDemoLoad(res, work) {
  if (MAX_INFLIGHT > 0 && inflight >= MAX_INFLIGHT) {
    saturatedTotal += 1;
    return json(res, 503, {
      error: "api saturated",
      demo_max_inflight: MAX_INFLIGHT,
      inflight,
      hint: "Scale the api component instance_count (or raise DEMO_MAX_INFLIGHT / lower DEMO_HANDLER_DELAY_MS)",
    });
  }
  inflight += 1;
  if (inflight > peakInflight) peakInflight = inflight;
  try {
    if (HANDLER_DELAY_MS > 0) await sleep(HANDLER_DELAY_MS);
    return await work();
  } finally {
    inflight -= 1;
  }
}

async function handleHealth(_req, res) {
  // Keep /api/health cheap: exact COUNT(*) over multi-million seed rows
  // saturates the small pg pool and trips App Platform readiness / gateway 504s.
  // Use planner estimate (reltuples) so the demo still shows scale.
  let db = "skipped";
  let orderCount = null;
  let orderCountApprox = false;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      db = "ok";
      const count = await pool.query(
        `SELECT GREATEST(reltuples, 0)::bigint AS n
         FROM pg_class
         WHERE oid = 'public.orders'::regclass`
      );
      orderCount = Number(count.rows[0].n);
      orderCountApprox = true;
    } catch (err) {
      db = `error: ${err.message}`;
      return json(res, 503, { ok: false, db, service: "mars-demo-api" });
    }
  }
  json(res, 200, {
    ok: true,
    service: "mars-demo-api",
    db,
    order_count: orderCount,
    order_count_approx: orderCountApprox,
    crash_after_requests: CRASH_AFTER || null,
    requests_seen: requestCount,
    demo: {
      handler_delay_ms: HANDLER_DELAY_MS,
      max_inflight: MAX_INFLIGHT || null,
      pg_pool_max: PG_POOL_MAX,
      slow_log_ms: SLOW_LOG_MS || null,
      inflight,
      peak_inflight: peakInflight,
      saturated_total: saturatedTotal,
      cpu_burns_active: cpuBurnsActive,
      mem_burns_active: memBurnsActive,
      burn_caps: (() => {
        const lim = detectMemLimitMb();
        return {
          cpu_max_ms: BURN_CPU_MAX_MS,
          cpu_default_ms: BURN_CPU_DEFAULT_MS,
          cpu_default_duty: BURN_CPU_DEFAULT_DUTY,
          cpu_target_pct: BURN_CPU_DEFAULT_DUTY,
          cpu_default_slice_ms: BURN_CPU_DEFAULT_SLICE_MS,
          cpu_max_busy_ms: BURN_CPU_MAX_BUSY_MS,
          mem_default_hold_ms: BURN_MEM_DEFAULT_HOLD_MS,
          mem_max_hold_ms: BURN_MEM_MAX_HOLD_MS,
          mem_target_pct: BURN_MEM_DEFAULT_TARGET_PCT,
          mem_chunk_mb: BURN_MEM_CHUNK_MB,
          mem_limit_mb: lim.limit_mb,
          mem_limit_source: lim.source,
        };
      })(),
      log_markers: {
        five_xx: MARKER_5XX,
        slow: MARKER_SLOW,
        burn_cpu: MARKER_BURN_CPU,
        burn_mem: MARKER_BURN_MEM,
        oom: MARKER_OOM,
      },
    },
  });
}

async function handleListOrders(_req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  return withDemoLoad(res, async () => {
    const { rows } = await pool.query(
      `SELECT id, customer_email, amount_cents, status, created_at
       FROM orders
       ORDER BY created_at DESC
       LIMIT 25`
    );
    maybeCrashAfterSuccess();
    json(res, 200, { orders: rows });
  });
}

async function handleCreateOrder(req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const body = await readJson(req);
  const email = String(body.customer_email || "").trim().toLowerCase();
  const amount = Number(body.amount_cents);
  if (!email || !email.includes("@") || !Number.isFinite(amount) || amount <= 0) {
    return json(res, 400, { error: "customer_email and positive amount_cents are required" });
  }
  return withDemoLoad(res, async () => {
    const { rows } = await pool.query(
      `INSERT INTO orders (customer_email, amount_cents, status)
       VALUES ($1, $2, 'created')
       RETURNING id, customer_email, amount_cents, status, created_at`,
      [email, Math.floor(amount)]
    );
    maybeCrashAfterSuccess();
    json(res, 201, rows[0]);
  });
}

async function handleLookupByEmail(req, res, url) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return json(res, 400, { error: "email query param required" });

  // Latent bug path: filter on customer_email without a supporting index (see mars-demo-db).
  return withDemoLoad(res, async () => {
    const started = Date.now();
    const { rows } = await pool.query(
      `SELECT id, customer_email, amount_cents, status, created_at
       FROM orders
       WHERE customer_email = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [email]
    );
    maybeCrashAfterSuccess();
    const took_ms = Date.now() - started;
    maybeLogSlow(res, took_ms, { email, rows: rows.length, kind: "by-email" });
    json(res, 200, {
      email,
      took_ms,
      orders: rows,
      note: "customer_email has no index on main — concurrent hammers congest the DB",
    });
  });
}

// Soft-cancel: set status to 'cancelled'. Idempotent if already cancelled.
async function handleCancelOrder(req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const body = await readJson(req);
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json(res, 400, { error: "positive numeric id is required" });
  }

  return withDemoLoad(res, async () => {
    const existing = await pool.query(
      `SELECT id, customer_email, amount_cents, status, created_at
       FROM orders WHERE id = $1`,
      [Math.floor(id)]
    );
    if (!existing.rowCount) {
      return json(res, 404, { error: "order not found", id: Math.floor(id) });
    }
    const order = existing.rows[0];
    if (order.status === "cancelled") {
      return json(res, 200, { order, already_cancelled: true });
    }

    const { rows } = await pool.query(
      `UPDATE orders SET status = 'cancelled'
       WHERE id = $1
       RETURNING id, customer_email, amount_cents, status, created_at`,
      [Math.floor(id)]
    );
    maybeCrashAfterSuccess();
    json(res, 200, { order: rows[0], already_cancelled: false });
  });
}

async function handleSeedOrders(req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const body = await readJson(req);
  if (body.confirm !== "seed") {
    return json(res, 400, {
      error: 'body must include confirm: "seed"',
      example: { confirm: "seed", count: 80000, hotpath_extra: 200 },
    });
  }
  const count = Math.min(
    SEED_MAX,
    Math.max(0, Math.floor(Number(body.count || 80_000)))
  );
  const hotpathExtra = Math.min(
    5_000,
    Math.max(0, Math.floor(Number(body.hotpath_extra || 200)))
  );
  const hotpath = String(body.hotpath_email || "hotpath@example.com")
    .trim()
    .toLowerCase();

  // Seed is intentionally outside withDemoLoad so scale knobs don't block prep.
  const started = Date.now();
  const before = await pool.query("SELECT COUNT(*)::bigint AS n FROM orders");
  await pool.query(
    `INSERT INTO orders (customer_email, amount_cents, status)
     SELECT
       'bulk-' || g::text || '@example.com',
       500 + (g % 5000),
       'created'
     FROM generate_series(1, $1) AS g`,
    [count]
  );
  if (hotpathExtra > 0) {
    await pool.query(
      `INSERT INTO orders (customer_email, amount_cents, status)
       SELECT $1, 2500 + (g % 100), 'created'
       FROM generate_series(1, $2) AS g`,
      [hotpath, hotpathExtra]
    );
  }
  const after = await pool.query("SELECT COUNT(*)::bigint AS n FROM orders");
  const took_ms = Date.now() - started;
  maybeLogSlow(res, took_ms, {
    kind: "seed-orders",
    inserted_bulk: count,
    orders_after: Number(after.rows[0].n),
  });
  json(res, 200, {
    inserted_bulk: count,
    inserted_hotpath: hotpathExtra,
    hotpath_email: hotpath,
    orders_before: Number(before.rows[0].n),
    orders_after: Number(after.rows[0].n),
    took_ms,
    reminder: "No index on customer_email — use Hammer lookups next",
  });
}

function clampInt(raw, fallback, min, max) {
  // null/undefined/"" must use fallback — Number(null) is 0 and would clamp to min.
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(raw, fallback, min, max) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

/**
 * Resolve instance memory limit (MiB).
 * Order: DEMO_MEM_LIMIT_MB / DEMO_BURN_MEM_LIMIT_MB → cgroup v2/v1 →
 * NODE_OPTIONS --max-old-space-size (heap hint only) → 512 (apps-s-1vcpu-0.5gb).
 */
function detectMemLimitMb() {
  const fromEnv = Number(process.env.DEMO_MEM_LIMIT_MB || process.env.DEMO_BURN_MEM_LIMIT_MB || 0);
  if (Number.isFinite(fromEnv) && fromEnv >= 64) {
    return { limit_mb: Math.floor(fromEnv), source: "env" };
  }

  const cgroupPaths = [
    "/sys/fs/cgroup/memory.max", // v2
    "/sys/fs/cgroup/memory/memory.limit_in_bytes", // v1
  ];
  for (const path of cgroupPaths) {
    try {
      const raw = fs.readFileSync(path, "utf8").trim();
      if (!raw || raw === "max") continue;
      const bytes = Number(raw);
      // Ignore absurd unrestricted v1 sentinels (~2^63).
      if (!Number.isFinite(bytes) || bytes <= 0 || bytes > 1e15) continue;
      const mb = Math.floor(bytes / (1024 * 1024));
      if (mb >= 64) {
        return {
          limit_mb: mb,
          source: path.includes("memory.max") ? "cgroup_v2" : "cgroup_v1",
        };
      }
    } catch {
      /* not in a cgroup or unreadable */
    }
  }

  const nodeOpts = process.env.NODE_OPTIONS || "";
  const m = nodeOpts.match(/--max-old-space-size=(\d+)/i);
  if (m) {
    const mb = Number(m[1]);
    if (Number.isFinite(mb) && mb >= 64) {
      return { limit_mb: Math.floor(mb), source: "node_options_max_old_space" };
    }
  }

  return { limit_mb: BURN_MEM_LIMIT_FALLBACK_MB, source: "fallback_512" };
}

/**
 * Short busy bursts on the event loop, then yield via setTimeout/setImmediate.
 * Defaults (~19ms busy / ~1ms yield @ duty 0.95 / slice 20) sustain high CPU
 * for Insights while still letting health/API run between spins.
 */
function yieldFor(ms) {
  return new Promise((resolve) => {
    if (ms <= 1) {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, ms);
  });
}

async function dutyCycleCpuBurn(durationMs, dutyCycle, sliceMs) {
  const end = performance.now() + durationMs;
  let ops = 0;
  let slices = 0;
  let x = 0x12345678;
  while (performance.now() < end) {
    const workMs = Math.max(
      1,
      Math.min(BURN_CPU_MAX_BUSY_MS, Math.floor(sliceMs * dutyCycle))
    );
    const pauseMs = Math.max(1, sliceMs - workMs);
    const sliceEnd = performance.now() + workMs;
    while (performance.now() < sliceEnd) {
      for (let i = 0; i < 512; i++) {
        x = Math.imul(x, 1664525) + 1013904223;
      }
      ops += 512;
    }
    slices += 1;
    await yieldFor(pauseMs);
  }
  return { ops, slices, x };
}

/**
 * POST/GET /api/demo/burn-cpu
 * Background duty-cycled burn; returns 202 immediately.
 * Params: duration_ms (default 90000), duty_cycle|target_pct (default 0.95), slice_ms (default 20).
 * Legacy `workers` ignored — worker pegs cause 504s on 1 vCPU.
 */
async function handleBurnCpu(req, res, url) {
  const body = req.method === "POST" ? await readJson(req) : {};
  const durationMs = clampInt(
    body.duration_ms ?? url.searchParams.get("duration_ms"),
    BURN_CPU_DEFAULT_MS,
    100,
    BURN_CPU_MAX_MS
  );
  const dutyCycle = clampFloat(
    body.duty_cycle ??
      body.target_pct ??
      url.searchParams.get("duty_cycle") ??
      url.searchParams.get("target_pct"),
    BURN_CPU_DEFAULT_DUTY,
    0.1,
    0.98
  );
  const sliceMs = clampInt(
    body.slice_ms ?? url.searchParams.get("slice_ms"),
    BURN_CPU_DEFAULT_SLICE_MS,
    5,
    100
  );

  const allowStack =
    body.allow_stack === true ||
    url.searchParams.get("allow_stack") === "1" ||
    url.searchParams.get("allow_stack") === "true";

  if (cpuBurnsActive >= 1) {
    return json(res, 429, {
      error: "cpu burn already in progress",
      cpu_burns_active: cpuBurnsActive,
      hint: "wait for the current burn to finish (only one sustained CPU burn at a time)",
    });
  }
  if (memBurnsActive >= 1 && !allowStack) {
    return json(res, 429, {
      error: "memory burn in progress — refuse stacking CPU+mem on small instances",
      mem_burns_active: memBurnsActive,
      hint: "wait for mem burn to end, or pass allow_stack:true (OOM risk on 0.5GiB)",
    });
  }

  cpuBurnsActive += 1;
  const started = Date.now();
  const workMs = Math.max(
    1,
    Math.min(BURN_CPU_MAX_BUSY_MS, Math.floor(sliceMs * dutyCycle))
  );
  const pauseMs = Math.max(1, sliceMs - workMs);
  console.error(
    JSON.stringify({
      marker: MARKER_BURN_CPU,
      event: "start",
      duration_ms: durationMs,
      duty_cycle: dutyCycle,
      slice_ms: sliceMs,
      work_ms_per_slice: workMs,
      yield_ms_per_slice: pauseMs,
      mode: "duty_cycle_event_loop",
      rss_mb: rssMb(),
      caps: { max_ms: BURN_CPU_MAX_MS },
      note: "short busy bursts + setTimeout yield; avoids 1-vCPU worker starvation 504s",
    })
  );

  dutyCycleCpuBurn(durationMs, dutyCycle, sliceMs)
    .then((result) => {
      console.error(
        JSON.stringify({
          marker: MARKER_BURN_CPU,
          event: "end",
          duration_ms: durationMs,
          duty_cycle: dutyCycle,
          slice_ms: sliceMs,
          took_ms: Date.now() - started,
          ops: result.ops,
          slices: result.slices,
          rss_mb: rssMb(),
        })
      );
    })
    .catch((err) => {
      console.error(
        JSON.stringify({
          marker: MARKER_BURN_CPU,
          event: "error",
          error: err.message,
          rss_mb: rssMb(),
        })
      );
    })
    .finally(() => {
      cpuBurnsActive -= 1;
    });

  return json(res, 202, {
    ok: true,
    accepted: true,
    burn: "cpu",
    mode: "duty_cycle_event_loop",
    duration_ms: durationMs,
    duty_cycle: dutyCycle,
    slice_ms: sliceMs,
    work_ms_per_slice: workMs,
    yield_ms_per_slice: pauseMs,
    marker: MARKER_BURN_CPU,
    rss_mb: rssMb(),
    note:
      "Sustained short busy/yield burn — HTTP should stay healthy; watch Insights CPU over ~duration_ms",
  });
}

/**
 * Touch pages so RSS grows (allocUnsafe is uninitialized).
 */
function touchBuffer(buf) {
  for (let i = 0; i < buf.length; i += 4096) buf[i] = 0xaa;
  if (buf.length) buf[buf.length - 1] = 0x55;
}

/**
 * Grow retained buffers until process RSS reaches targetRssMb (never past it).
 * Yields between chunks so health/API can run during the climb.
 */
async function growRssTowardTarget(targetRssMb, chunkMb) {
  const chunks = [];
  let allocatedMb = 0;
  let rss = rssMb();
  while (rss < targetRssMb) {
    const remaining = targetRssMb - rss;
    // Never round up — stop when less than 1 MiB of headroom remains.
    const thisMb = Math.min(chunkMb, Math.floor(remaining));
    if (thisMb < 1) break;
    const buf = Buffer.allocUnsafe(thisMb * 1024 * 1024);
    touchBuffer(buf);
    chunks.push(buf);
    retainedMemChunks.push(buf);
    allocatedMb += thisMb;
    rss = rssMb();
    // If this chunk overshot (accounting lag), stop — do not allocate more.
    if (rss >= targetRssMb) break;
    await new Promise((resolve) => setImmediate(resolve));
    rss = rssMb();
  }
  return { chunks, allocatedMb, rss_mb: rssMb() };
}

/**
 * POST/GET /api/demo/burn-memory
 * Grow RSS toward target_pct (default 0.95) of the instance memory limit, hold hold_ms.
 * Params: target_pct, hold_ms. Optional legacy `mb` ignored for sizing (logged if present).
 * Single active mem burn only (429 on second click).
 */
async function handleBurnMemory(req, res, url) {
  const body = req.method === "POST" ? await readJson(req) : {};
  const holdMs = clampInt(
    body.hold_ms ?? url.searchParams.get("hold_ms"),
    BURN_MEM_DEFAULT_HOLD_MS,
    100,
    BURN_MEM_MAX_HOLD_MS
  );
  const targetPct = clampFloat(
    body.target_pct ?? url.searchParams.get("target_pct"),
    BURN_MEM_DEFAULT_TARGET_PCT,
    0.5,
    0.98
  );
  const allowStack =
    body.allow_stack === true ||
    url.searchParams.get("allow_stack") === "1" ||
    url.searchParams.get("allow_stack") === "true";

  if (memBurnsActive >= 1) {
    return json(res, 429, {
      error: "memory burn already in progress",
      mem_burns_active: memBurnsActive,
      hint: "Do not double-click — wait for hold_ms to end. A second retain OOMs 0.5GiB (exit 128 → gateway 504s while restarting)",
    });
  }
  if (cpuBurnsActive >= 1 && !allowStack) {
    return json(res, 429, {
      error: "cpu burn in progress — refuse stacking CPU+mem on small instances",
      cpu_burns_active: cpuBurnsActive,
      hint: "wait for CPU burn to end, or pass allow_stack:true (OOM risk on 0.5GiB)",
    });
  }

  const { limit_mb: limitMb, source: limitSource } = detectMemLimitMb();
  const targetRssMb = Math.floor(limitMb * targetPct);
  const rssBefore = rssMb();

  if (rssBefore >= targetRssMb) {
    return json(res, 409, {
      error: "RSS already at or above target — no-op",
      rss_mb: rssBefore,
      target_rss_mb: targetRssMb,
      target_pct: targetPct,
      limit_mb: limitMb,
      limit_source: limitSource,
      hint: "Process is already near the burn target; wait for GC/release or lower target_pct",
    });
  }

  memBurnsActive += 1;
  const started = Date.now();
  console.error(
    JSON.stringify({
      marker: MARKER_BURN_MEM,
      event: "start",
      target_pct: targetPct,
      limit_mb: limitMb,
      limit_source: limitSource,
      target_rss_mb: targetRssMb,
      hold_ms: holdMs,
      rss_mb_before: rssBefore,
      chunk_mb: BURN_MEM_CHUNK_MB,
      legacy_mb_ignored: body.mb ?? url.searchParams.get("mb") ?? null,
      mode: "grow_to_target_pct",
      warning:
        "Exit 128 after BURN_MEM = cgroup OOM kill (unloggable SIGKILL); gateway 504s until restart",
    })
  );

  let grow;
  try {
    grow = await growRssTowardTarget(targetRssMb, BURN_MEM_CHUNK_MB);
  } catch (err) {
    memBurnsActive -= 1;
    console.error(
      JSON.stringify({
        marker: MARKER_BURN_MEM,
        event: "error",
        target_pct: targetPct,
        limit_mb: limitMb,
        error: err.message,
        rss_mb: rssMb(),
      })
    );
    return json(
      res,
      500,
      {
        error: err.message || "memory burn failed",
        marker: MARKER_BURN_MEM,
        rss_mb: rssMb(),
        limit_mb: limitMb,
        hint: "Allocation failed — instance may be near its memory cap",
      },
      { skipFiveXxLog: true }
    );
  }

  const rssAfterAlloc = grow.rss_mb;
  const chunks = grow.chunks;
  setTimeout(() => {
    for (const buf of chunks) {
      const idx = retainedMemChunks.indexOf(buf);
      if (idx >= 0) retainedMemChunks.splice(idx, 1);
    }
    chunks.length = 0;
    memBurnsActive -= 1;
    console.error(
      JSON.stringify({
        marker: MARKER_BURN_MEM,
        event: "end",
        target_pct: targetPct,
        limit_mb: limitMb,
        limit_source: limitSource,
        target_rss_mb: targetRssMb,
        hold_ms: holdMs,
        allocated_mb: grow.allocatedMb,
        took_ms: Date.now() - started,
        rss_mb_before: rssBefore,
        rss_mb_after: rssMb(),
        retained_chunks: retainedMemChunks.length,
      })
    );
  }, holdMs);

  return json(res, 202, {
    ok: true,
    accepted: true,
    burn: "memory",
    mode: "grow_to_target_pct",
    target_pct: targetPct,
    limit_mb: limitMb,
    limit_source: limitSource,
    target_rss_mb: targetRssMb,
    hold_ms: holdMs,
    allocated_mb: grow.allocatedMb,
    marker: MARKER_BURN_MEM,
    rss_mb_before: rssBefore,
    rss_mb_after_alloc: rssAfterAlloc,
    retained_chunks: retainedMemChunks.length,
    note:
      "Grew RSS toward ~target_pct of instance limit and holding — headroom left for HTTP; do not double-click",
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  // App Platform ingress strips nothing by default when matching /api prefix;
  // accept both /api/... and /... for local runs.
  const path = url.pathname.replace(/^\/api/, "") || "/";
  bindRequestContext(req, res, path);

  try {
    if (req.method === "GET" && (path === "/health" || path === "/")) {
      return await handleHealth(req, res);
    }
    if (req.method === "GET" && path === "/orders") {
      return await handleListOrders(req, res);
    }
    // Must be registered before POST /orders.
    if (req.method === "POST" && path === "/orders/cancel") {
      return await handleCancelOrder(req, res);
    }
    if (req.method === "POST" && path === "/orders") {
      return await handleCreateOrder(req, res);
    }
    if (req.method === "GET" && path === "/orders/by-email") {
      return await handleLookupByEmail(req, res, url);
    }
    if (req.method === "POST" && path === "/demo/seed-orders") {
      return await handleSeedOrders(req, res);
    }
    if (
      (req.method === "POST" || req.method === "GET") &&
      path === "/demo/burn-cpu"
    ) {
      return await handleBurnCpu(req, res, url);
    }
    if (
      (req.method === "POST" || req.method === "GET") &&
      path === "/demo/burn-memory"
    ) {
      return await handleBurnMemory(req, res, url);
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    // Structured 5xx log comes from json(); keep a one-line stack for operators.
    console.error(
      JSON.stringify({
        marker: MARKER_5XX,
        level: "error",
        event: "unhandled_handler_error",
        method: req.method || null,
        path,
        error: err.message || "internal error",
        stack: typeof err.stack === "string" ? err.stack.split("\n").slice(0, 4) : null,
      })
    );
    json(res, 500, { error: err.message || "internal error" }, { skipFiveXxLog: true });
  }
});

// SIGKILL (cgroup OOM → exit 128) cannot be caught. Log what we can on graceful stops.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.error(
      JSON.stringify({
        marker: MARKER_OOM,
        level: "warn",
        event: "process_signal",
        signal: sig,
        rss_mb: rssMb(),
        cpu_burns_active: cpuBurnsActive,
        mem_burns_active: memBurnsActive,
        note: "Graceful signal — if App Platform logged exit 128 right after BURN_MEM, that was OOM/SIGKILL (unloggable); gateway 504s until the new process listens",
      })
    );
    process.exit(0);
  });
}

server.listen(PORT, () => {
  console.log(`mars-demo-api listening on :${PORT}`);
  console.log(
    `demo knobs: DELAY_MS=${HANDLER_DELAY_MS} MAX_INFLIGHT=${MAX_INFLIGHT || "unlimited"} PG_POOL_MAX=${PG_POOL_MAX} MEM_TARGET_PCT=${BURN_MEM_DEFAULT_TARGET_PCT} MEM_LIMIT_FALLBACK_MB=${BURN_MEM_LIMIT_FALLBACK_MB}`
  );
  if (!DATABASE_URL) {
    console.warn("DATABASE_URL is not set; DB routes will return 503");
  }
});
