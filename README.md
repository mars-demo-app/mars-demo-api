# mars-demo-api

Backend HTTP service for the **Mars Demo Shop** on DigitalOcean App Platform.

## Role in the app

| Concern | Detail |
| --- | --- |
| App Platform type | `services` component named `api` |
| Owned by | This repo |
| Wired from | [`mars-demo-app`](https://github.com/mars-demo-app/mars-demo-app) → `.do/app.yaml` |
| Runtime | Node.js buildpack (`environment_slug: node-js`) |
| Port | `8080` (`PORT` env) |
| Database | `${db.DATABASE_URL}` from the managed Postgres component |

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` (or `/health`) | Liveness + DB ping + demo knobs |
| `GET` | `/api/orders` | Recent orders |
| `POST` | `/api/orders` | Create order `{ customer_email, amount_cents }` |
| `POST` | `/api/orders/cancel` | Soft-cancel order `{ id }` → `status: cancelled` |
| `GET` | `/api/orders/by-email?email=` | Unindexed lookup (latent-bug / congestion path) |
| `POST` | `/api/demo/seed-orders` | Bulk insert for congestion demo (`confirm: "seed"`) |
| `GET`/`POST` | `/api/demo/burn-cpu` | Duty-cycled CPU burn (`duration_ms`, `duty_cycle`, `slice_ms`) |
| `GET`/`POST` | `/api/demo/burn-memory` | Grow RSS to `target_pct` of mem limit, hold `hold_ms` (single-burn) |

## Local run

```bash
npm install
export DATABASE_URL='postgres://mars:mars@127.0.0.1:5432/mars_demo'
export PGSSL=disable
# Apply schema from mars-demo-db first, then:
npm start
# http://127.0.0.1:8080/health
```

## Demo knobs (env)

Defaults are safe for normal browsing (no artificial delay, unlimited inflight).

| Env | Default | Purpose |
| --- | --- | --- |
| `DEMO_CRASH_AFTER_REQUESTS` | `0` | Exit after N successful demo requests (bad deploy) |
| `DEMO_HANDLER_DELAY_MS` | `0` | Artificial delay on non-health handlers (scale demo) |
| `DEMO_MAX_INFLIGHT` | `0` | Cap concurrent non-health handlers; `0` = unlimited. Over cap → HTTP 503 |
| `DEMO_PG_POOL_MAX` | `5` | pg pool size (small → connection wait under hammer) |
| `DEMO_SLOW_LOG_MS` | `500` | Warn-log successful handlers slower than this (`MARS_DEMO_SLOW`) |
| `DEMO_BURN_CPU_MAX_MS` | `180000` | Hard cap for `/demo/burn-cpu` duration |
| `DEMO_BURN_CPU_DUTY` | `0.35` | Default duty cycle (busy fraction per slice) |
| `DEMO_BURN_CPU_SLICE_MS` | `12` | Busy+yield slice length |
| `DEMO_BURN_CPU_MAX_BUSY_MS` | `6` | Hard cap on one busy burst |
| `DEMO_BURN_MEM_TARGET_PCT` | `0.9` | Target RSS as fraction of instance limit |
| `DEMO_MEM_LIMIT_MB` | _(auto)_ | Override instance memory limit (MiB); alias `DEMO_BURN_MEM_LIMIT_MB` |
| `DEMO_BURN_MEM_MAX_HOLD_MS` | `180000` | Hard cap for memory hold duration |
| `DEMO_BURN_MEM_CHUNK_MB` | `16` | Chunk size while climbing to target |

### Burn demos (CPU / memory)

Returns **202 Accepted** and burns in the background.

**CPU** — short event-loop busy/yield (`duty_cycle=0.35`, `slice_ms=12`). At most **one** CPU burn; stacking on an active mem burn → **429** unless `allow_stack:true`.

**Memory** — grow RSS toward **`target_pct` (default 0.9)** of the instance memory **limit**, then hold `hold_ms`. Never allocates past that target (leaves ~10% headroom for HTTP). At most **one** mem burn (**429** on double-click). If RSS is already ≥ target → **409** no-op.

**How the limit is chosen** (first match):

1. `DEMO_MEM_LIMIT_MB` or `DEMO_BURN_MEM_LIMIT_MB`
2. cgroup `memory.max` (v2) / `memory.limit_in_bytes` (v1)
3. `NODE_OPTIONS=--max-old-space-size=N` (heap hint only)
4. Fallback **512** (`apps-s-1vcpu-0.5gb`)

⚠️ **Exit 128 after `MARS_DEMO_BURN_MEM`** = App Platform **OOM-killed** the container. While restarting, the **gateway returns 504** — not an app 504 body. Fixed-size double retains (2×380MB) caused this; the 90% grow mode + single-burn guard prevent it.

| Endpoint | Defaults | Guards |
| --- | --- | --- |
| `/api/demo/burn-cpu` | `duration_ms=90000`, `duty_cycle=0.35`, `slice_ms=12` | one at a time |
| `/api/demo/burn-memory` | `target_pct=0.9`, `hold_ms=60000` | one at a time; stop at 90% of limit |

```bash
# UI defaults — grow to ~90% of instance limit, hold 60s
curl -sS -X POST https://mars-demo-4qji6.ondigitalocean.app/api/demo/burn-memory \
  -H 'Content-Type: application/json' \
  -d '{"target_pct":0.9,"hold_ms":60000}'

# Override detected limit (e.g. if cgroup unreadable locally)
DEMO_MEM_LIMIT_MB=512 npm start
```

### Log markers (App Platform `api` runtime logs)

| Marker | When |
| --- | --- |
| **`MARS_DEMO_5XX`** | Any HTTP 5xx the Node process returns (503 saturated, 500 handler errors, etc.) |
| **`MARS_DEMO_SLOW`** | Successful handler slower than `DEMO_SLOW_LOG_MS` (by-email hammer / seed) |
| **`MARS_DEMO_BURN_CPU`** | CPU burn start/end (and error) |
| **`MARS_DEMO_BURN_MEM`** | Memory burn start/end — includes `target_pct`, `limit_mb`, `rss_mb_before` / after |
| **`MARS_DEMO_OOM`** | Process received SIGTERM/SIGINT (graceful). **Cannot** catch cgroup OOM/SIGKILL (exit 128) |
| **`MARS_DEMO_ERROR_LOG`** | Cancel-break demo PR only (skips a duplicate `MARS_DEMO_5XX` line) |

Platform edge **504**s (gateway timeout — including while the container is OOM-restarting) are **not** emitted by Node and will not appear as `MARS_DEMO_5XX`.

### Suggested App Platform values for scale demo (mode C)

Set on component `api` (Runtime), then redeploy / wait for config apply:

```text
DEMO_HANDLER_DELAY_MS=800
DEMO_MAX_INFLIGHT=4
```

Then use UI **API load test** (or `make stress-api`). Remediation: raise `api` **instance_count** (e.g. 1 → 2+) in App Platform.

## App Platform fragment

This repo owns its App Platform component config in [`.do/component.yaml`](.do/component.yaml).
The parent [`mars-demo-app`](https://github.com/mars-demo-app/mars-demo-app) tracks this repo as a git submodule and merges fragments into `.do/app.yaml`.

When `.do/**` changes on `main`, workflow `notify-parent-spec` dispatches the parent's `compose-app-spec` workflow (requires secret `PARENT_DISPATCH_TOKEN`).
