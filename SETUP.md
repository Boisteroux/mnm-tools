# SETUP.md — getting a new machine up and running

Everything below assumes you're setting up mnm-tools on a fresh computer. Almost the
whole project is on GitHub, so it's mostly clone + install, plus two files git can't
carry (they're private/secret and deliberately excluded).

## 1. Install the tools (one-time)

- **Git** — https://git-scm.com
- **Node.js LTS** — https://nodejs.org (gives you `node`, `npm`, `npx`)
- Your editor + **Claude Code**

You do **not** need ffmpeg / streamlink / tesseract. Those are only for *capturing*
auctions, and the DigitalOcean VPS does that 24/7 on its own — a dev machine never
touches capture.

## 2. Clone the repo — ideally to the same path

```
cd C:\Users\zacha\Desktop
git clone https://github.com/Boisteroux/mnm-tools.git MnM-Minimap
cd MnM-Minimap
npm install
git config core.hooksPath .githooks   # activate the pre-commit secret scanner
```

> **Don't skip that last line.** The secret scanner in `.githooks/pre-commit` only
> runs when git is told where to find it, and that setting is machine-local — a fresh
> `git clone` does NOT carry it. Without this, commits skip the scan silently.

> **Why the same path** (`Desktop\MnM-Minimap`): Claude Code names its per-project
> memory folder after the project's path. Cloning to the same location means the copied
> memory (step 4) drops straight in. A different path works too — you'd just rename the
> memory folder to match the new path.

## 3. Run it

- **Website (MnMdb):** `npx serve mnmdb -l 5601` → open http://localhost:5601
- **Desktop app (MnM Map):** `npm start`

## 4. Bring the two things a fresh clone WON'T have

Git ignores these on purpose (private/secret), so move them manually — see the
**move bundle** (`mnm-move-bundle/`) created alongside this repo, which packages both:

| What | Goes to | Why |
|------|---------|-----|
| **Claude memory** (`memory/` folder) | `C:\Users\<you>\.claude\projects\C--Users-<you>-Desktop-MnM-Minimap\memory\` | So Claude keeps all our decisions, the VPS runbook, and in-flight work. Create the parent folders if missing. |
| **VPS SSH key** (`mnm_vps`, `mnm_vps.pub`) | `C:\Users\<you>\.ssh\` | To SSH into the auction server (157.230.222.54) to check/manage it. |
| **Preview config** (`launch.json`, optional) | `<repo>\.claude\launch.json` | Lets Claude Code start the local website server by name. |

Move the bundle by **USB or another secure transfer** — it contains a private SSH key.
Don't email it, upload it, or commit it. Delete the bundle once you've copied it in.

If you skip the SSH key, everything still works — you just can't manage the droplet
until you copy it (or generate a new key and add its `.pub` to the server). If you skip
the memory, the code is 100% intact; Claude just starts without our history.

## 5. Logins to redo on the new machine

- **GitHub push** — your first `git push` prompts a browser login / Personal Access
  Token (the repo uses HTTPS). Cloning read-only needs nothing.
- **Cloudflare** (`npx wrangler login`) — only if you deploy the Worker/D1/R2.

## 6. The one habit to keep

The VPS auto-commits fresh auction data to `main` all day, so **always
`git pull --rebase` before you start working** — otherwise your first push is rejected
as "behind."

---

Rebuilding the server itself (rare) is documented in `VPS-SETUP.md`. Project
orientation for Claude/contributors is in `CLAUDE.md`.
