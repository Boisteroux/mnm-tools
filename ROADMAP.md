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

## 🔜 Next up

- **Wiki enrichment** — item stats (damage / AC / weight / slot / level), vendor
  *buy* prices, item icons, node → resource links ("Copper Ore from Copper
  Veins"), mob levels. (One build unlocks several of these.)
- **Vendor tagging** — confirm regular / shady / specialist vendors per item.
- **Harvest zones** — show where each resource is gathered.
- **Crowdsourcing** — pool everyone's data on a server so the site is live and
  community-wide (needs hosting + moderation — the bigger lift).
- **Trade value (7-day high/low)** — *blocked by data, not effort.* The game does
  **not** save chat to disk (Player.log is engine logging; chats.json is only
  window layout), so we can't scrape Auction/WTS "selling X for Y plat" messages.
  The Ledger only records *your own* NPC vendor sells (act_24) — no player-to-
  player trades are logged for Boisterous. Realistic paths: (a) aggregate NPC
  vendor prices we already have, or (b) a manual/crowd "I sold X for Y" submission
  form on the site. Live auction scraping would need a game-side chat export.
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
