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
