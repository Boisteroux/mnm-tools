# Security

This is a fan-made, non-commercial project. It has **no backend and uses no
secret keys** — the desktop app publishes using your *local* GitHub login (the
`gh` CLI token in your OS keychain), and reads the community wiki through a
public, key-less API. So there's nothing secret in this repo by design.

To keep it that way, two safety nets are in place so a credential can never
accidentally land in the public repo:

## 1. GitHub secret scanning + push protection (server-side)
Enabled on the repo. GitHub scans for known secret formats and **blocks any push**
that contains one. Free for public repositories.

## 2. Pre-commit hook (client-side)
`.githooks/pre-commit` scans staged changes for likely secrets (API keys, tokens,
private keys, password assignments) and **blocks the commit** before it happens.

**Enable it after cloning** (one time):

```sh
git config core.hooksPath .githooks
```

Bypass for a genuine false positive: `git commit --no-verify`.

## If a secret ever does leak
1. **Rotate it first** — revoke/regenerate the key. Removing the file is not
   enough; it stays in git history and may already be scraped.
2. Then remove it from the code (and history if needed).

## Reporting
Found something? Open an issue (without including the secret) or email
zak@threefires.xyz.
