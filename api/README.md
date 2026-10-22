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
5. `npx wrangler secret put OWNER_DISCORD_IDS` — your Discord user id (the owner: full admin, and the only one who can add/remove admins). Moderation is Discord sign-in only; there is no password.
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

Admin calls send `Authorization: Bearer <Discord session token>` from a signed-in admin (the owner, the `admins` table, or `ADMIN_DISCORD_IDS`). Promote/demote is owner-only.

### Play-data sharing (MnM Map's opt-in "Share with MnMdb")

Run `migrate-contributions.sql` once on an existing database, and set the
`EXPORT_TOKEN` secret (the VPS reads approved data with it; keep it out of the repo).

| Method | Path | Who | Purpose |
|--------|------|-----|---------|
| POST | `/contrib/register`  | the app | one-time anonymous install credential |
| POST | `/contrib/upload`    | the app (install bearer) | replace this install's rolled-up EA counts; optional Discord `session` |
| GET  | `/contrib/status`    | the app (install bearer) | pending / approved / rejected + last share |
| POST | `/contrib/forget`    | the app (install bearer) | stop + delete everything this install shared |
| GET  | `/contrib/export`    | `EXPORT_TOKEN` or admin | approved contributions, for `tracker/build-ea-data.js` |
| GET  | `/admin/contributors` | admin | who's sharing, with a summary |
| POST | `/admin/contributors/approve` · `reject` · `delete` | admin | `{ "id": "<install id>" }` |

New installs are `pending` until approved once; trusted/admin Discord users signed in
inside the app are approved automatically (trusting someone also approves their installs).

## Local dev

`npx wrangler dev` runs it at `http://localhost:8787`. Use `--local` for a local D1.
