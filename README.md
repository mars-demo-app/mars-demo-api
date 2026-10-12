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
| `GET`/`POST` | `/api/demo/burn-cpu` | Busy-loop CPU burn (`duration_ms`, `workers`) |
| `GET`/`POST` | `/api/demo/burn-memory` | Allocate+hold memory (`mb`, `hold_ms`) then release |

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
| `DEMO_BURN_CPU_DUTY` | `0.7` | Default duty cycle (fraction of each slice spent busy) |
| `DEMO_BURN_CPU_SLICE_MS` | `40` | Busy+yield slice length |
| `DEMO_BURN_MEM_MAX_MB` | `450` | Hard cap for `/demo/burn-memory` allocation |
| `DEMO_BURN_MEM_MAX_HOLD_MS` | `180000` | Hard cap for memory hold duration |

### Burn demos (CPU / memory)

Returns **202 Accepted** and burns in the background.

**CPU** uses a **duty-cycled** busy/yield loop on the event loop (`duty_cycle` × `slice_ms` busy, then yield). That keeps HTTP/health responsive on a **1 vCPU** instance while holding elevated average CPU for 60–90s (graph-friendly). Hard worker-thread pegging is intentionally gone — it caused gateway **504**s while Insights averages still looked low.

| Endpoint | Defaults | Max / notes |
| --- | --- | --- |
| `/api/demo/burn-cpu` | `duration_ms=90000`, `duty_cycle=0.7`, `slice_ms=40` | duration max 180s; duty 0.1–0.95 |
| `/api/demo/burn-memory` | `mb=380`, `hold_ms=60000` | 450 MB / 180s |

```bash
# UI default — sustained ~90s (should not 504 other requests)
curl -sS -X POST https://mars-demo-4qji6.ondigitalocean.app/api/demo/burn-cpu \
  -H 'Content-Type: application/json' \
  -d '{"duration_ms":90000,"duty_cycle":0.7,"slice_ms":40}'

# Hotter but still yielding (more average CPU, still answer HTTP)
curl -sS -X POST https://mars-demo-4qji6.ondigitalocean.app/api/demo/burn-cpu \
  -H 'Content-Type: application/json' \
  -d '{"duration_ms":120000,"duty_cycle":0.85,"slice_ms":40}'

curl -sS -X POST https://mars-demo-4qji6.ondigitalocean.app/api/demo/burn-memory \
  -H 'Content-Type: application/json' -d '{"mb":380,"hold_ms":60000}'
```

### Log markers (App Platform `api` runtime logs)

| Marker | When |
| --- | --- |
| **`MARS_DEMO_5XX`** | Any HTTP 5xx the Node process returns (503 saturated, 500 handler errors, etc.) |
| **`MARS_DEMO_SLOW`** | Successful handler slower than `DEMO_SLOW_LOG_MS` (by-email hammer / seed) |
| **`MARS_DEMO_BURN_CPU`** | CPU burn start/end (and error) |
| **`MARS_DEMO_BURN_MEM`** | Memory burn start/end (and error) |
| **`MARS_DEMO_ERROR_LOG`** | Cancel-break demo PR only (skips a duplicate `MARS_DEMO_5XX` line) |

Platform edge **504**s (gateway timeout with no response from the container) cannot be logged by the app. Hammer/Seed should still produce `MARS_DEMO_SLOW` and any app-emitted `MARS_DEMO_5XX` (e.g. 503 when `DEMO_MAX_INFLIGHT` is set).

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

## Demo PR: broken cancel

On branch `demo/mars-error-log-marker`, `POST /api/orders/cancel` is intentionally broken:
it attempts an invalid column update, returns HTTP 500, and prints a JSON line containing
the searchable marker `MARS_DEMO_ERROR_LOG` (no process exit).

Demo flow: merge → open the shop UI → **Cancel latest order** → see failure → search
runtime logs for `MARS_DEMO_ERROR_LOG` → launch a MARS investigation.
