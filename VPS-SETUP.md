# Running the auction tracker on a cheap always-on server (VPS)

This moves the auction capture off GitHub's flaky scheduler and off your PC, onto
a tiny ~$5/month Linux server that runs 24/7. It runs the **same scripts** we use
locally: capture a frame every 2 min, publish prices every ~15 min, push to
GitHub (which auto-deploys the site). Reliable, hands-off, ~$5/mo.

You do the parts that need your accounts/payment (create the server, add one
GitHub key). Everything else is copy-paste. Total time ~20–30 min.

---

## 1. Create the server

Any provider works; cheapest reliable options:
- **Hetzner Cloud** — `CX22` (~€3.79/mo) — cheapest, great value. https://console.hetzner.cloud
- **DigitalOcean** — Basic Droplet, $6/mo — most beginner-friendly UI. https://cloud.digitalocean.com
- **Vultr / Linode** — $5/mo — also fine.

When creating it:
- **Image / OS:** Ubuntu **24.04 LTS**
- **Size:** the smallest (1 vCPU, 1 GB RAM is plenty — the work is tiny)
- **Auth:** add an SSH key if you have one, or set a root password (you can use the provider's web console to log in).
- Note the server's **IP address** when it finishes.

---

## 2. Connect to it

On Windows, open **Windows Terminal** (or PowerShell) and:

```
ssh root@YOUR_SERVER_IP
```

(Or use the provider's "Console"/"Launch terminal" button in their web UI — no SSH client needed.)

Everything below is run on the server.

---

## 3. Install what it needs

```bash
apt-get update
apt-get install -y git ffmpeg tesseract-ocr curl
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
# streamlink (newest, via pipx)
apt-get install -y pipx
pipx install streamlink
pipx ensurepath
```

Verify (each should print a version):

```bash
node --version && ffmpeg -version | head -1 && tesseract --version | head -1 && ~/.local/bin/streamlink --version
```

---

## 4. Get the code

```bash
cd /opt
git clone https://github.com/Boisteroux/mnm-tools.git
cd mnm-tools
```

No `npm install` needed — the tracker scripts use only built-in Node modules.
(The HTTPS clone above is read-only. Step 6 sets up write access for pushing.)

---

## 5. Set up a GitHub "deploy key" so the server can push

This is the one part that touches GitHub. A deploy key is an SSH key that can
push to **only this repo** — safer than a broad token.

On the server:

```bash
ssh-keygen -t ed25519 -C "mnm-vps" -f ~/.ssh/mnm_deploy -N ""
cat ~/.ssh/mnm_deploy.pub
```

Copy the line it prints (starts with `ssh-ed25519 …`).

In your browser: **GitHub → the mnm-tools repo → Settings → Deploy keys → Add deploy key**
- Title: `mnm-vps`
- Key: paste the line
- ✅ **Check "Allow write access"**
- Save.

Back on the server, tell git to use that key and switch the repo to SSH:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/mnm_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

cd /opt/mnm-tools
git remote set-url origin git@github.com:Boisteroux/mnm-tools.git
git config user.name "mnm-vps"
git config user.email "mnm-vps@users.noreply.github.com"
ssh -o StrictHostKeyChecking=accept-new -T git@github.com   # say yes; "successfully authenticated" is expected
git pull   # confirm it can talk to GitHub
```

---

## 6. Run it as two always-on services

These keep running across reboots and restart themselves if they ever stop.

Create the capture service:

```bash
cat > /etc/systemd/system/mnm-capture.service <<'EOF'
[Unit]
Description=MnM auction capture (frame -> OCR -> parse)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/mnm-tools
ExecStart=/usr/bin/node tracker/capture-auctions.js
Environment=MNM_DATA=/opt/mnm-tools/auction-data
Environment=MNM_HOURS=100000
Environment=MNM_PRUNE_HOURS=72
Environment=MNM_FFMPEG=ffmpeg
Environment=MNM_TESSERACT=tesseract
Environment=MNM_STREAMLINK=/root/.local/bin/streamlink
Environment=PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
```

Create the publish service (commits + pushes every 15 min):

```bash
cat > /etc/systemd/system/mnm-publish.service <<'EOF'
[Unit]
Description=MnM auction publish (state -> auctions.json -> git push)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/mnm-tools
ExecStart=/usr/bin/node tracker/auto-publish-auctions.js
Environment=MNM_DATA=/opt/mnm-tools/auction-data
Environment=MNM_HOURS=100000
Environment=MNM_PUBLISH_INTERVAL=900
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
```

Start and enable both:

```bash
systemctl daemon-reload
systemctl enable --now mnm-capture mnm-publish
```

---

## 7. Turn off the GitHub cloud capture (so they don't fight)

Once the VPS is publishing, the GitHub Actions capture would double-publish and
race it. Disable it (keep the site-deploy workflow — it still runs on each push):

- Browser: **GitHub → mnm-tools → Actions → "Capture auctions (cloud)" → ⋯ → Disable workflow**
- Or from anywhere with the gh CLI: `gh workflow disable capture-auctions.yml --repo Boisteroux/mnm-tools`

(To go back to GitHub later, re-enable it and stop the VPS services.)

---

## 8. Verify + everyday commands

```bash
# live capture log (should show a cycle every ~2 min)
journalctl -u mnm-capture -f
# publish log (should push every ~15 min)
journalctl -u mnm-publish -f
```

You should see the site's `auctions.json` getting new "Auto-publish auction
prices" commits on GitHub every ~15 min, and mnm-db.com updating automatically.

Handy later:
- Update to the latest code: `cd /opt/mnm-tools && git pull && systemctl restart mnm-capture mnm-publish`
- Stop everything: `systemctl disable --now mnm-capture mnm-publish`
- Check status: `systemctl status mnm-capture mnm-publish`

---

## Notes / gotchas

- **Cadence is adjustable:** capture interval via `MNM_INTERVAL` (seconds, default 120 = 2 min) on the capture service; publish interval via `MNM_PUBLISH_INTERVAL` (default 900 = 15 min) on the publish service. Keep publish ≥ ~6 min so GitHub Pages' ~10-builds/hour limit is respected.
- **If streamlink can't find the stream** ("no stream url"), the channel may be offline or moved — the loop just skips that cycle and retries; nothing breaks.
- **If pushes fail**, re-check the deploy key has *write access* and that `ssh -T git@github.com` authenticates.
- The `auction-data/` folder (state + frames) lives outside git and is pruned to 72h so it stays small.
- Cost control: this is the smallest instance; you can destroy the server anytime from the provider dashboard to stop billing.
