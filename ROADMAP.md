# MnM Tools — Roadmap

A living list of what's built and what's next. **Add ideas anytime** — even from
your phone: edit this file on github.com (pencil icon → commit), or open an Issue.

## ✅ Shipped

- **Map app** — community wiki zone maps, custom markers by category, zone
  auto-follow (reads the game log), transparent in-game overlay, remembers
  window/overlay position.
- **Drop tracker** — reads the game's Ledger files and auto-rescans as you play;
  drop rates, vendor sell values (regular vs. shady), coin per kill, farming
  value, and which zones things come from.
- **mnmdb website** — searchable item / mob / resource database with sortable
  tables. Live at https://boisteroux.github.io/mnm-tools
- **Sharing** — public repo, MIT license, Windows installer, sunset branding.
- **One-click publish** — "Publish to MnMdb" button in the app (owner build only)
  regenerates the site data from your ledger and pushes it live in ~30s.
- **Multi-map zones** — manual map switcher (Evershade Weald ⇄ Faelindral) in the
  sidebar + overlay, driven by zone-aliases.json.
- **Trade value v1** — item pages show a 7-day high/low of player sale prices.
  Submit prices two ways: the in-app "Log a Trade" panel (merged on Publish) or a
  phone-friendly GitHub issue form. Data lives in mnmdb/trades.json.

## 🔜 Next up

- **Wiki enrichment** — item stats (damage / AC / weight / slot / level), vendor
  *buy* prices, item icons, node → resource links ("Copper Ore from Copper
  Veins"), mob levels. (One build unlocks several of these.)
- **Vendor tagging** — confirm regular / shady / specialist vendors per item.
- **Harvest zones** — show where each resource is gathered.
- **Crowdsourcing** — pool everyone's data on a server so the site is live and
  community-wide (needs hosting + moderation — the bigger lift).
- **Trade value — next steps** — v1 ships manual logging (in-app + GitHub issues).
  Still wanted: an easy way to fold accepted issue submissions into trades.json
  (a small `gh`-powered ingest script), and — once the crowdsourcing server
  exists — pooling everyone's logged trades automatically. (Note: live auction
  scraping stays impossible; the game doesn't save chat to disk.)
- **Multi-map zones (e.g. Evershade Weald ⇄ Faelindral)** — some zones share one
  game zone-code but have two maps (the weald below vs. the elf city above the
  lift). The log can't tell them apart (no player position in the ledger), so
  *automatic* swap-on-lift isn't possible from current data. Plan: a manual
  map-switch in the overlay for zones flagged as multi-map. Discrepancies are
  stored in `zone-aliases.json` so new cases are a one-line edit (phone-friendly).
- **Tip jar** — optional Ko-fi/donation link once you're ready.
- **First/last seen, leaderboards, table filters** — smaller polish items.

## 📥 Inbox — drop new ideas here

- _(add anything, rough is fine — we'll sort it out together)_
