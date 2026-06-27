# MnMdb submission API (Cloudflare Worker + D1)

Receives community marker submissions, holds them for moderation, and serves approved
ones back to the static site. Anonymous submissions; Cloudflare Turnstile + per-IP
rate-limiting guard against bots/spam; everything is `pending` until approved.

## One-time setup

Run these from this `api/` folder. `npx` fetches `wrangler` on first use — no global install.

1. Create a free Cloudflare account: https://dash.cloudflare.com/sign-up (no card needed).
2. `npx wrangler login` — authorize in the browser.
3. `npx wrangler d1 create mnmdb` — copy the `database_id` it prints into `wrangler.toml`.
4. `npx wrangler d1 execute mnmdb --remote --file=schema.sql` — creates the table.
5. `npx wrangler secret put ADMIN_TOKEN` — type a strong password (your moderation login).
6. `npx wrangler deploy` — prints your `https://mnmdb-api.<you>.workers.dev` URL.

Later: add Turnstile (`npx wrangler secret put TURNSTILE_SECRET`) and a custom route
(`api.mnm-db.com`). Until `TURNSTILE_SECRET` is set, the bot check is skipped so you can test.

## Endpoints

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| GET  | `/health`        | anyone | liveness check |
| GET  | `/markers`       | anyone | approved markers (the site draws these) |
| POST | `/submit`        | anyone | submit a marker → pending queue |
| GET  | `/admin/pending` | admin  | list pending submissions |
| POST | `/admin/approve` | admin  | `{ "id": N }` → approve |
| POST | `/admin/reject`  | admin  | `{ "id": N }` → reject |

Admin calls send `Authorization: Bearer <ADMIN_TOKEN>`.

## Local dev

`npx wrangler dev` runs it at `http://localhost:8787`. Use `--local` for a local D1.
