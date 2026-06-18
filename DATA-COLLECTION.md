# What mnm-tools reads from the game

This document describes **exactly** what the mnm-tools companion app reads from
Monsters & Memories' local files, so the developers can review it. It is written
to be transparent and complete. If anything here is not acceptable, we will
change it — just let us know.

**Summary:** the app reads two local files **read-only** (it never writes to or
modifies any game file), pulls a handful of gameplay events to build personal
drop/vendor/harvest stats, and processes everything locally. Only aggregate
stats (names + rates/prices/counts) are optionally published, by the user, to
their own public GitHub repo. No raw log files are ever uploaded.

---

## 1. `Player.log` — used only to detect the current zone

- Path: `%USERPROFILE%\AppData\LocalLow\Niche Worlds Cult\Monsters and Memories\Player.log`
  (falls back to `Player-prev.log`).
- The app scans **only** for lines matching `Start zoning process to <zone>` and
  reads the zone name (e.g. `evergrove`). This drives the "follow my zone" map
  switching so the right zone map is shown.
- It reads only newly-appended bytes, polled every ~2 seconds.
- **Nothing else** in this log is parsed or stored — not combat, networking,
  rendering, account data, or anything else.

## 2. Ledger files — used for drop / vendor / harvest stats

- Path: `…\Monsters and Memories\<server>\<Character>\Ledger\<Character>_Character_<date>.json`
  (and `_Social_<date>.json`).
- These are the game's own activity ledger. The app extracts **only these four
  event types**:

  | Event code | Data taken | Used for |
  |---|---|---|
  | `act_13` (loot) | item name + the mob it dropped from | drop rates |
  | `act_14` (kill) | mob name, coin amount, zone | kill/corpse counts, coin per kill |
  | `act_24` (vendor sale) | item name + the price the player sold it for | vendor sell values |
  | `act_27` (harvest) | resource name | gathering tallies |

- For those four event types only, the app also reads each event's **timestamp
  and current-zone tag** (both already present on the event). These are used
  locally to (a) group loots into "corpses" for drop rates and (b) power a local
  **Session Replay** recap — a per-play-session summary of zones visited, kills,
  loot, harvests and coin earned. Timestamps and the session timeline stay on
  the user's machine; they are **not** part of what gets published.
- **Every other event type in these files is ignored.**

It then derives aggregate tallies — drop rates (items looted ÷ looted corpses),
vendor sell prices, harvest counts, coin per kill — keyed by item / mob /
resource **name**.

---

## What the app does NOT do

- **Never modifies** game files. All access is strictly read-only.
- **Does not read** chat (`chats.json`), the quest journal, settings, controls,
  window layouts, or any network/account data.
- **Does not collect** account information, the character name, or other
  players' names. (The ledger files do contain the player's own character name
  in some fields, and the `_Social_` ledger contains party events with other
  players' names — the app opens those files but pulls **only** the four event
  types above, so none of that personal/social data is stored or published.)
- **Only the player's own logged activity** is read — their loots, kills, sales,
  and harvests. The app cannot and does not see anyone else's data.
- **All processing is local.** Aggregate stats (item/mob/resource names plus
  rates/prices/counts) are published only when the user explicitly clicks
  Publish, and only to that user's own public GitHub repository. **No raw log
  files are uploaded, ever.**

## Two things we want to be upfront about

1. **Base64:** several ledger string fields (mob names, zone names, prices) are
   base64-encoded. The app decodes them. This is trivial encoding, not
   encryption or DRM, but we want to be transparent that decoding happens.
2. **Maps and item/mob stats** shown on the companion website come from the
   **community wiki (monstersandmemories.miraheze.org)**, not from the game
   client. That is a separate, public source — no map or stat data is scraped
   from the game files.

---

*mnm-tools is a fan-made, unofficial, non-commercial companion tool. We want to
respect the game and its team — if any of the above is a concern, we'll adjust
or remove it. Reach out to **Boisterous** on the Monsters & Memories Discord.*
