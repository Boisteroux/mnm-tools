# MnM Tools — Roadmap

A living list of what's built and what's next. **Add ideas anytime** — even from
your phone: edit this file on github.com (pencil icon → commit), or open an Issue.

## ✅ Shipped

- **Map app** — community wiki zone maps, custom markers by category, zone
  auto-follow (reads the game log), transparent in-game overlay, remembers
  window/overlay position.
- **Multi-map zones** — manual map switcher (e.g. Evershade Weald ⇄ Faelindral) in
  the sidebar + overlay, driven by `zone-aliases.json`. (Auto-swap on the lift
  isn't possible — the log has no player position.)
- **Drop tracker** — reads the game's Ledger files and auto-rescans as you play;
  drop rates, vendor sell values (regular vs. shady), coin per kill, farming value,
  and which zones things come from.
- **Accurate drop rates** — rates are per *looted corpse* (loots clustered by
  time), not per kill, because the game only logs kills for some mobs. Thin-sample
  rates (<10 corpses) are faded as "rough".
- **Trade value v1** — item pages show a 30-day high/low + 7-day average of player
  sale prices. Submit two ways: the in-app "Log a Trade" panel (merged on Publish)
  or a phone-friendly GitHub issue form. Data lives in `mnmdb/trades.json`.
- **mnmdb website** — searchable item / mob / resource database, economy-focused
  home (most-valuable & most-fought mobs, priciest items, valuable resources,
  recent trades). Live at https://boisteroux.github.io/mnm-tools
- **Home charts** — magnitude bars on the home leaderboards, a rarity × value
  scatter (rare + valuable = chase loot), and a per-mob "where the value comes
  from" breakdown bar. All dependency-free inline SVG/CSS.
- **Value by level bracket** — home "Best value by level" groups mobs into L1-10,
  L11-20, … by their wiki level and ranks value/kill in each. Lights up further as
  play spans more levels and wiki-level coverage grows.
- **One-click publish** — "Publish to MnMdb" button in the app (owner build only)
  regenerates the site data from your ledger and pushes it live in ~30s.
- **Sharing & look** — public repo, MIT license, Windows installer, sunset branding,
  warm UI theme.

## 🔜 Next up

- **Improve mob-level coverage** — the level brackets only rank mobs that have a
  wiki level; right now ~20 valuable mobs have none, so they're unranked. Widen
  the mob wiki enrichment (and revisit bracket size 5s vs 10s) as play spans more
  levels.
- **Biggest movers** — items whose 7-day average jumped/dropped the most (a little
  market ticker). Unlocks once trade data accumulates.
- **Trade ingest** — a small `gh`-powered script to fold accepted "trade" issues
  into `trades.json`, so web submissions don't need hand-copying.
- **Harvest zones** — show where each resource is gathered.
- **More wiki enrichment** — wider item-stat / icon / mob-level coverage.
  (Note: vendor *buy* prices and live auction prices are NOT obtainable — no
  merchant data in the wiki or logs, and the game doesn't save chat to disk.)
- **Crowdsourcing server** — pool everyone's data so the site is live and
  community-wide, and trades aggregate automatically. The big lift (hosting +
  moderation); also what makes publishing fully hands-off.
- **Tip jar** — optional Ko-fi/donation link once you're ready.
- **Polish** — first/last seen, table filters, sample-size confidence on values.

## 📱 Good phone tasks (no app needed)

Things you can do from github.com on your phone while away from the PC:

- **Log trade prices** — on any item page, tap **Submit a price** (opens a GitHub
  issue form). Or open an Issue with the `trade` label.
- **Map a vendor** — edit `mnmdb/vendors.json` to record which NPC buys which item
  types (powers the "Sold to" list).
- **Add a multi-map zone** — edit `zone-aliases.json` when you find another
  city/under-zone pair like Evershade Weald / Faelindral.
- **Jot ideas** — add a line to the Inbox below.

## 📥 Inbox — drop new ideas here

- _(add anything, rough is fine — we'll sort it out together)_
