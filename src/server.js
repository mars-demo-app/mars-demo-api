"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { Pool } = require("pg");

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
 * Burn-CPU: duty-cycled busy/yield on the event loop so HTTP stays responsive
 * while average CPU stays elevated for a ~60–90s Insights window.
 * (Hard worker-thread pegging caused gateway 504s on 1 vCPU while averages
 * still looked low — see playbook D.)
 */
const BURN_CPU_MAX_MS = Math.max(100, Number(process.env.DEMO_BURN_CPU_MAX_MS || 180_000) || 180_000);
const BURN_CPU_DEFAULT_MS = 90_000;
const BURN_CPU_DEFAULT_DUTY = Math.min(
  0.95,
  Math.max(0.1, Number(process.env.DEMO_BURN_CPU_DUTY || 0.7) || 0.7)
);
const BURN_CPU_DEFAULT_SLICE_MS = Math.max(
  5,
  Math.min(200, Number(process.env.DEMO_BURN_CPU_SLICE_MS || 40) || 40)
);

/**
 * Burn-memory hard caps. Instance is apps-s-1vcpu-0.5gb — defaults aim to fill
 * most of RSS for a clear Insights blip; max can OOM/restart.
 */
const BURN_MEM_MAX_MB = Math.max(1, Number(process.env.DEMO_BURN_MEM_MAX_MB || 450) || 450);
const BURN_MEM_MAX_HOLD_MS = Math.max(100, Number(process.env.DEMO_BURN_MEM_MAX_HOLD_MS || 180_000) || 180_000);
const BURN_MEM_DEFAULT_MB = 380;
const BURN_MEM_DEFAULT_HOLD_MS = 60_000;

const MARKER_5XX = "MARS_DEMO_5XX";
const MARKER_SLOW = "MARS_DEMO_SLOW";
const MARKER_CANCEL_BREAK = "MARS_DEMO_ERROR_LOG";
const MARKER_BURN_CPU = "MARS_DEMO_BURN_CPU";
const MARKER_BURN_MEM = "MARS_DEMO_BURN_MEM";

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
  let db = "skipped";
  let orderCount = null;
  if (pool) {
    try {
      await pool.query("SELECT 1");
      db = "ok";
      const count = await pool.query("SELECT COUNT(*)::bigint AS n FROM orders");
      orderCount = Number(count.rows[0].n);
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
      burn_caps: {
        cpu_max_ms: BURN_CPU_MAX_MS,
        cpu_default_ms: BURN_CPU_DEFAULT_MS,
        cpu_default_duty: BURN_CPU_DEFAULT_DUTY,
        cpu_default_slice_ms: BURN_CPU_DEFAULT_SLICE_MS,
        mem_max_mb: BURN_MEM_MAX_MB,
        mem_max_hold_ms: BURN_MEM_MAX_HOLD_MS,
      },
      log_markers: {
        five_xx: MARKER_5XX,
        slow: MARKER_SLOW,
        burn_cpu: MARKER_BURN_CPU,
        burn_mem: MARKER_BURN_MEM,
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

/**
 * One-click volume for the missing-index congestion demo.
 * Uses generate_series; does NOT create an email index.
 */
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
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

function yieldEventLoop(ms) {
  if (ms <= 0) {
    return new Promise((resolve) => setImmediate(resolve));
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Duty-cycled burn on the main event loop: busy-spin for duty*slice, then
 * yield so HTTP/health can run. Sustains elevated average CPU for duration_ms
 * without pegging the only vCPU into gateway 504s.
 */
async function dutyCycleCpuBurn(durationMs, dutyCycle, sliceMs) {
  const end = Date.now() + durationMs;
  let ops = 0;
  let slices = 0;
  let x = 0x12345678;
  while (Date.now() < end) {
    const workMs = Math.max(1, Math.floor(sliceMs * dutyCycle));
    const pauseMs = Math.max(0, sliceMs - workMs);
    const sliceEnd = Date.now() + workMs;
    while (Date.now() < sliceEnd) {
      for (let i = 0; i < 25_000; i++) {
        x = Math.imul(x, 1664525) + 1013904223;
      }
      ops += 25_000;
    }
    slices += 1;
    await yieldEventLoop(pauseMs);
  }
  return { ops, slices, x };
}

/**
 * POST/GET /api/demo/burn-cpu
 * Starts a background duty-cycled burn; returns 202 immediately.
 * Params: duration_ms (default 90000), duty_cycle (default 0.7), slice_ms (default 40).
 * Legacy `workers` is ignored (hard workers caused 504s on 1 vCPU).
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
    body.duty_cycle ?? url.searchParams.get("duty_cycle"),
    BURN_CPU_DEFAULT_DUTY,
    0.1,
    0.95
  );
  const sliceMs = clampInt(
    body.slice_ms ?? url.searchParams.get("slice_ms"),
    BURN_CPU_DEFAULT_SLICE_MS,
    5,
    200
  );

  if (cpuBurnsActive >= 1) {
    return json(res, 429, {
      error: "cpu burn already in progress",
      cpu_burns_active: cpuBurnsActive,
      hint: "wait for the current burn to finish (only one sustained burn at a time)",
    });
  }

  cpuBurnsActive += 1;
  const started = Date.now();
  console.error(
    JSON.stringify({
      marker: MARKER_BURN_CPU,
      event: "start",
      duration_ms: durationMs,
      duty_cycle: dutyCycle,
      slice_ms: sliceMs,
      mode: "duty_cycle",
      rss_mb: rssMb(),
      caps: { max_ms: BURN_CPU_MAX_MS },
      note: "yields every slice so HTTP/health stay responsive on 1 vCPU",
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
    mode: "duty_cycle",
    duration_ms: durationMs,
    duty_cycle: dutyCycle,
    slice_ms: sliceMs,
    work_ms_per_slice: Math.floor(sliceMs * dutyCycle),
    yield_ms_per_slice: Math.max(0, sliceMs - Math.floor(sliceMs * dutyCycle)),
    marker: MARKER_BURN_CPU,
    rss_mb: rssMb(),
    note:
      "Sustained duty-cycled burn (busy then yield) — watch Insights CPU over ~duration_ms; HTTP should stay healthy (no hard worker peg)",
  });
}

/**
 * Allocate+touch memory in chunks, retain globally for hold_ms, then release.
 * Returns 202 after allocation so long holds are not cut by gateway timeouts.
 */
function allocateRetainedMemory(mb) {
  const chunkMb = 32;
  const chunks = [];
  let allocated = 0;
  while (allocated < mb) {
    const thisMb = Math.min(chunkMb, mb - allocated);
    const buf = Buffer.allocUnsafe(thisMb * 1024 * 1024);
    // Force physical pages into RSS (allocUnsafe is uninitialized).
    for (let i = 0; i < buf.length; i += 4096) buf[i] = 0xaa;
    buf[buf.length - 1] = 0x55;
    chunks.push(buf);
    allocated += thisMb;
  }
  return chunks;
}

/**
 * POST/GET /api/demo/burn-memory
 * Params: mb (default 380), hold_ms (default 60000). Hard-capped by env.
 */
async function handleBurnMemory(req, res, url) {
  const body = req.method === "POST" ? await readJson(req) : {};
  const mb = clampInt(
    body.mb ?? url.searchParams.get("mb"),
    BURN_MEM_DEFAULT_MB,
    1,
    BURN_MEM_MAX_MB
  );
  const holdMs = clampInt(
    body.hold_ms ?? url.searchParams.get("hold_ms"),
    BURN_MEM_DEFAULT_HOLD_MS,
    100,
    BURN_MEM_MAX_HOLD_MS
  );

  if (memBurnsActive >= 2) {
    return json(res, 429, {
      error: "memory burn already in progress",
      mem_burns_active: memBurnsActive,
      hint: "wait for the current burn to finish",
    });
  }

  memBurnsActive += 1;
  const started = Date.now();
  const rssBefore = rssMb();
  console.error(
    JSON.stringify({
      marker: MARKER_BURN_MEM,
      event: "start",
      mb,
      hold_ms: holdMs,
      rss_mb: rssBefore,
      mode: "background",
      caps: { max_mb: BURN_MEM_MAX_MB, max_hold_ms: BURN_MEM_MAX_HOLD_MS },
      warning: "High mb can OOM/restart a small App Platform instance",
    })
  );

  let chunks;
  try {
    chunks = allocateRetainedMemory(mb);
    retainedMemChunks.push(...chunks);
  } catch (err) {
    memBurnsActive -= 1;
    console.error(
      JSON.stringify({
        marker: MARKER_BURN_MEM,
        event: "error",
        mb,
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
        hint: "Allocation failed — lower mb (instance may be near its memory cap)",
      },
      { skipFiveXxLog: true }
    );
  }

  const rssAfterAlloc = rssMb();
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
        mb,
        hold_ms: holdMs,
        took_ms: Date.now() - started,
        rss_mb: rssMb(),
        retained_chunks: retainedMemChunks.length,
      })
    );
  }, holdMs);

  return json(res, 202, {
    ok: true,
    accepted: true,
    burn: "memory",
    mb,
    hold_ms: holdMs,
    marker: MARKER_BURN_MEM,
    rss_mb_before: rssBefore,
    rss_mb_after_alloc: rssAfterAlloc,
    retained_chunks: retainedMemChunks.length,
    note:
      "Memory retained in-process for hold_ms — watch Insights memory; logs emit MARS_DEMO_BURN_MEM start/end",
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

server.listen(PORT, () => {
  console.log(`mars-demo-api listening on :${PORT}`);
  console.log(
    `demo knobs: DELAY_MS=${HANDLER_DELAY_MS} MAX_INFLIGHT=${MAX_INFLIGHT || "unlimited"} PG_POOL_MAX=${PG_POOL_MAX}`
  );
  if (!DATABASE_URL) {
    console.warn("DATABASE_URL is not set; DB routes will return 503");
  }
});
