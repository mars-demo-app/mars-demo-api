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
| `GET` | `/api/health` (or `/health`) | Liveness + DB ping + runtime knobs |
| `GET` | `/api/orders` | Recent orders |
| `POST` | `/api/orders` | Create order `{ customer_email, amount_cents }` |
| `POST` | `/api/orders/cancel` | Soft-cancel order `{ id }` → `status: cancelled` |
| `GET` | `/api/orders/by-email?email=` | Lookup orders by email (normal app traffic) |
| `GET`/`POST` | `/api/demo/burn-cpu` | Duty-cycled CPU load — **202**; re-POST **extends** duration |
| `GET`/`POST` | `/api/demo/burn-memory` | Grow RSS to `target_pct` of mem limit — **202**; re-POST **extends** hold |
| `POST` | `/api/demo/crash-now` | `exit(1)` after `{"confirm":"crash"}` |
| `POST` | `/api/demo/seed-orders` | Bulk insert sample orders (`confirm: "seed"`) |

## Local run

```bash
npm install
export DATABASE_URL='postgres://mars:mars@127.0.0.1:5432/mars_demo'
export PGSSL=disable
# Apply schema from mars-demo-db first, then:
npm start
# http://127.0.0.1:8080/health
```

## Runtime knobs (env)

Defaults are safe for normal browsing (no artificial delay, unlimited inflight).

| Env | Default | Purpose |
| --- | --- | --- |
| `DEMO_EXIT_AFTER_REQUESTS` | `0` | Exit after N successful handlers (alias `DEMO_CRASH_AFTER_REQUESTS`) |
| `DEMO_HANDLER_DELAY_MS` | `0` | Artificial delay on non-health handlers |
| `DEMO_MAX_INFLIGHT` | `0` | Cap concurrent non-health handlers; `0` = unlimited. Over cap → HTTP 503 |
| `DEMO_PG_POOL_MAX` | `5` | pg pool size |
| `DEMO_BURN_CPU_MAX_MS` | `180000` | Hard cap for one CPU burn window from “now” when extending |
| `DEMO_BURN_CPU_DUTY` / `DEMO_BURN_CPU_TARGET_PCT` | `0.95` | Default busy fraction per slice (alias) |
| `DEMO_BURN_CPU_SLICE_MS` | `20` | Busy+yield slice length (~19ms busy / ~1ms yield @ 0.95) |
| `DEMO_BURN_CPU_MAX_BUSY_MS` | `19` | Hard cap on one busy burst |
| `DEMO_BURN_MEM_TARGET_PCT` | `0.95` | Target RSS as fraction of instance limit |
| `DEMO_MEM_LIMIT_MB` | _(auto)_ | Override instance memory limit (MiB); alias `DEMO_BURN_MEM_LIMIT_MB` |
| `DEMO_BURN_MEM_MAX_HOLD_MS` | `180000` | Hard cap for memory hold window from “now” when extending |
| `DEMO_BURN_MEM_CHUNK_MB` | `16` | Chunk size while climbing to target |

### Load demos (CPU / memory / restart)

Returns **202 Accepted** and runs work in the background. Runtime logs and API bodies stay neutral.

**CPU** — short event-loop busy/yield (`duty_cycle`/`target_pct`=0.95, `slice_ms`=20). One active burner; a second `POST` **extends** `ends_at` by `duration_ms` (capped) and returns `extended: true`, `new_ends_at`. Stacking on an active mem burn → **429** unless `allow_stack:true`.

**Memory** — grow RSS toward **`target_pct` (default 0.95)** of the instance memory **limit**, then hold. Never allocates past that target. A second `POST` **extends** the hold (`extended: true`, `new_ends_at`) without a second retain. If RSS is already ≥ target with no active burn → **409** no-op.

**How the limit is chosen** (first match):

1. `DEMO_MEM_LIMIT_MB` or `DEMO_BURN_MEM_LIMIT_MB`
2. cgroup `memory.max` (v2) / `memory.limit_in_bytes` (v1)
3. `NODE_OPTIONS=--max-old-space-size=N` (heap hint only)
4. Fallback **512** (`apps-s-1vcpu-0.5gb`)

⚠️ Pushing memory hard on a small instance can OOM-kill the container (exit 128). While restarting, the **gateway may return 504**.

| Endpoint | Defaults | Behavior |
| --- | --- | --- |
| `/api/demo/burn-cpu` | `duration_ms=120000`, `duty_cycle=0.95` | **202**; re-POST extends |
| `/api/demo/burn-memory` | `target_pct=0.95`, `hold_ms=120000` | **202**; re-POST extends hold |
| `/api/demo/crash-now` | `{"confirm":"crash"}` | `exit(1)` after **202** |
| `/api/demo/seed-orders` | `confirm: "seed"` | bulk insert sample rows |

```bash
BASE=https://mars-demo-4qji6.ondigitalocean.app

# CPU — returns immediately; re-POST extends the same burn
curl -sS -X POST "$BASE/api/demo/burn-cpu" \
  -H 'Content-Type: application/json' \
  -d '{"duration_ms":120000,"duty_cycle":0.95}'
curl -sS -X POST "$BASE/api/demo/burn-cpu" \
  -H 'Content-Type: application/json' \
  -d '{"duration_ms":60000}'   # → extended:true, new_ends_at:…

# Memory — grow to ~95% of instance limit; re-POST extends hold
curl -sS -X POST "$BASE/api/demo/burn-memory" \
  -H 'Content-Type: application/json' \
  -d '{"target_pct":0.95,"hold_ms":120000}'

# Restart metrics — process exit (no env redeploy)
curl -sS -X POST "$BASE/api/demo/crash-now" \
  -H 'Content-Type: application/json' -d '{"confirm":"crash"}'
```

**Instance size tip:** Prefer **`apps-s-1vcpu-1gb`** (or larger) for memory burns. On `0.5gb`, RSS→95% is one step from OOM/exit 128 and gateway **504**s while the container restarts.

**What MARS should infer (not from planted log strings):**

- CPU / memory pressure → App Platform utilization gauges (clear sustained spike vs idle; organic peaks are often ≪ 90%)
- Restart / crash-loop → Insights `do.apps.restart_count` / tip `app_restarts_total` + platform deploy/build signals (`/demo/crash-now`)
- Latency / index issues → **managed DB Insights**, not app log markers or synthetic slow-order fixtures

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
