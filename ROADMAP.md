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
  sale prices, with wild outliers auto-trimmed (IQR fence) so one bad value can't
  skew the range. Logged frictionlessly via the in-app "Log a Trade" panel (merged
  on Publish). Data lives in `mnmdb/trades.json`.
- **mnmdb website** — searchable item / mob / resource database, economy-focused
  home (most-valuable & most-fought mobs, priciest items, valuable resources,
  recent trades). Live at https://boisteroux.github.io/mnm-tools
- **Home charts** — magnitude bars on the home leaderboards, a rarity × value
  scatter (rare + valuable = chase loot), and a per-mob "where the value comes
  from" breakdown bar. All dependency-free inline SVG/CSS.
- **Value by level bracket** — home "Best value by level" groups mobs into L1-10,
  L11-20, … by their wiki level and ranks value/kill in each. Lights up further as
  play spans more levels and wiki-level coverage grows.
- **Biggest movers** — home ticker of items whose 7-day average sell price moved
  most vs the previous week. Fills in as trade data accumulates.
- **Web map viewer** — read-only "Maps" section on the site shows the curated zone
  maps with their markers (hover to read). Updated on Publish.
- **One-click publish** — "Publish to MnMdb" button in the app (owner build only)
  regenerates the site data from your ledger and pushes it live in ~30s.
- **Crafting profitability** — 182 wiki recipes across 11 tradeskills (header-aware
  parser; ingredients → output, trivial) on
  tradeskill + item pages, with a craft **margin** (output value − materials value).
  Recipe reference is live now; margins fill in as crafted-item prices accumulate.
- **Sharing & look** — public repo, MIT license, Windows installer, sunset branding,
  warm UI theme, Outfit font shared by the app and site.

## 🔜 Next up

- **Improve mob-level coverage** — level ranges (e.g. "3-7") are now kept, lifting
  coverage 36% → 59%. The rest genuinely have no level on the wiki yet (the ashira
  family especially) — fills in as the wiki is updated. Revisit bracket size
  (5s vs 10s) once play spans more levels.
- **Community trade submission (serverless)** — for now, trade prices come from
  the in-app logger (frictionless, no account). True *web* submission needs a
  receiver a static site can't provide; the right answer is a tiny serverless
  endpoint (e.g. a free Cloudflare Worker) that a plain no-login form POSTs to —
  the minimal version of the crowdsourcing server. Parked until the audience
  justifies it. (The GitHub-issue form was dropped as too much friction; outlier
  trimming is already in, which is what makes low-friction submission safe later.)
- **Map viewer — refinements** (remaining):
  - ✅ Placeholder + screenshots excluded; mapless zones show **Map coming soon**.
    ✅ **Review Zone Maps** panel. ✅ **Downscale** on export (37MB → 6.7MB).
  - **NPC map tagging (bigger project — parked)** — tag individual useful NPCs on
    city maps (esp. **starter quest NPCs**), not whole districts. District-level
    tagging was tried and reverted as not useful. The wiki has the data: its NPC
    table lists each NPC + location, and `parseCityPois` (in git history at commit
    `ccdb9f7`) already extracts NPCs grouped by district — a good starting point.
    Needs a thought-through per-NPC placement flow + which NPCs are worth showing.
  - **Layered city maps** — multi-level zones (cities with above/below floors)
    shown as switchable layers in the viewer.
  - **Official / shared maps** — carry community or "official" maps, not just the
    locally-curated set.
  - Keep an eye out for any other zones rendering wrong (markers off, bad crop).
- ✅ **Harvest zones** — resources now show "Gathered in: [zones]" (item pages,
  Gathering table, zone pages), from the zone logged on each harvest.
- **More wiki enrichment** — wider item-stat / icon / mob-level coverage.
  (Note: vendor *buy* prices and live auction prices are NOT obtainable — no
  merchant data in the wiki or logs, and the game doesn't save chat to disk.)
- **Crowdsourcing server** — pool everyone's data so the site is live and
  community-wide, and trades aggregate automatically. The big lift (hosting +
  moderation); also what makes publishing fully hands-off.
- **Tip jar** — optional Ko-fi/donation link once you're ready.
- **Polish** — first/last seen, table filters, sample-size confidence on values.

## 💡 Potential features (idea log)

A running brainstorm to pull from when deciding what's next. Each notes the data
it needs (★ = data we already have).

**Time-based (★ ledger has timestamps on every event)**
- **Coin/hour & kills/hour** — real ROI of a farm spot from event timing. ★
- **"Best farm right now" recommender** — rank mobs/zones by value-per-time for a
  goal (coin / a mat / a tradeskill stack). ★
- **Session Replay** — animate a play session on the map (dot hops zones, loot
  pops, coin ticks). Login is detectable in Player.log; logout inferred from the
  ledger going quiet. Could auto-generate a recap when the game closes. ★
- **Spawn-timer estimation** — infer named-mob respawn windows from kill
  timestamps. Rough solo, strong once crowdsourced. ★

**Economy**
- **M&M Market Index** — a commodity basket charted over time (stock-ticker vibe).
- **Arbitrage finder** — vendor buy ("Sold by") < player sell → flip for profit.
- **Supply-chain calculator** — walk raw mats → intermediates → finished goods
  through the 182-recipe graph (value at each step). ★ (recipes)
- **Inflation tracker** — total coin minted (kill coin) over time = money supply. ★

**Personal / gamified (per-character add-ons)**
- **M&M Wrapped** — shareable recap card (hours, coin, fav zone, rarest drop). Run
  monthly and/or a live "your stats" page on the site. ★
- **Drop-luck meter** — your observed rate vs community average (needs crowdsourced
  baseline). Tracks per character. ★ (personal half)
- **Auto-achievements** — milestones mined from the ledger. ★
- **Drop Simulator** — Monte-Carlo "kill this 100×" from observed rates. ★

**Community**
- **Discord bot** — `!price`, `!drops` in chat. *Best owned/supported by the M&M
  QA team* rather than self-hosted; tag as a "hand-off" feature.
- **Natural-language queries** — "most profitable thing to cook?" answered from the
  dataset via an LLM.

**Visualization (outlandish-but-buildable)**
- **The Economy Web** — force-directed graph: mobs → drops → recipes → outputs →
  vendors; click a node, see what flows. ★
- **Sankey food-chain** — raw mats flowing through tradeskills into finished goods,
  ribbon width = volume/value. ★ (recipes + harvest)
- **Illustrated Bestiary** — mob compendium (wiki art + stats + drop/value). ★
- **Economic what-if** — ripple a price change through the crafting graph. ★

**Off the table** (so we don't chase them): live player x/y position (not in
logs), auction-chat scraping (chat isn't on disk).

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
