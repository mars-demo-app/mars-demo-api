"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL;
const CRASH_AFTER = Number(process.env.DEMO_CRASH_AFTER_REQUESTS || 0);

let requestCount = 0;

function pgPoolConfig(url) {
  if (process.env.PGSSL === "disable") {
    return { connectionString: url, ssl: false, max: 5 };
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
    max: 5,
  };
}

const pool = DATABASE_URL ? new Pool(pgPoolConfig(DATABASE_URL)) : null;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
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

async function handleHealth(_req, res) {
  let db = "skipped";
  if (pool) {
    try {
      await pool.query("SELECT 1");
      db = "ok";
    } catch (err) {
      db = `error: ${err.message}`;
      return json(res, 503, { ok: false, db, service: "mars-demo-api" });
    }
  }
  json(res, 200, {
    ok: true,
    service: "mars-demo-api",
    db,
    crash_after_requests: CRASH_AFTER || null,
    requests_seen: requestCount,
  });
}

async function handleListOrders(_req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const { rows } = await pool.query(
    `SELECT id, customer_email, amount_cents, status, created_at
     FROM orders
     ORDER BY created_at DESC
     LIMIT 25`
  );
  maybeCrashAfterSuccess();
  json(res, 200, { orders: rows });
}

async function handleCreateOrder(req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const body = await readJson(req);
  const email = String(body.customer_email || "").trim().toLowerCase();
  const amount = Number(body.amount_cents);
  if (!email || !email.includes("@") || !Number.isFinite(amount) || amount <= 0) {
    return json(res, 400, { error: "customer_email and positive amount_cents are required" });
  }
  const { rows } = await pool.query(
    `INSERT INTO orders (customer_email, amount_cents, status)
     VALUES ($1, $2, 'created')
     RETURNING id, customer_email, amount_cents, status, created_at`,
    [email, Math.floor(amount)]
  );
  maybeCrashAfterSuccess();
  json(res, 201, rows[0]);
}

async function handleLookupByEmail(req, res, url) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return json(res, 400, { error: "email query param required" });

  // Latent bug path: filter on customer_email without a supporting index (see mars-demo-db).
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
  json(res, 200, { email, took_ms: Date.now() - started, orders: rows });
}

// Soft-cancel: set status to 'cancelled'. Idempotent if already cancelled.
async function handleCancelOrder(req, res) {
  if (!pool) return json(res, 503, { error: "DATABASE_URL not configured" });
  const body = await readJson(req);
  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return json(res, 400, { error: "positive numeric id is required" });
  }

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
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    // App Platform ingress strips nothing by default when matching /api prefix;
    // accept both /api/... and /... for local runs.
    const path = url.pathname.replace(/^\/api/, "") || "/";

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
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message || "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`mars-demo-api listening on :${PORT}`);
  if (!DATABASE_URL) {
    console.warn("DATABASE_URL is not set; DB routes will return 503");
  }
});
