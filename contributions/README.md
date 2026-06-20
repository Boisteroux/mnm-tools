# Contributions — pooled play data from trusted friends

This folder holds play-data files exported by trusted friends, which get **merged
into the shared MnMdb site** the next time the owner clicks **Publish to MnMdb**.

## How it works

1. **A friend exports their data.** In the app's sidebar (Drop Tracker section)
   they click **“Export my data to share”**. That saves one JSON file —
   `mnm-data-<character>-<date>.json` — containing only rolled-up counts (drops,
   kills, harvests, vendor prices, logged trades). No raw chat, no personal files,
   nothing is uploaded by the app itself.

2. **They send the owner the file** (Discord, etc.).

3. **The owner drops the file into this folder** and clicks **Publish**. On publish,
   every `*.json` here is pooled with the owner's own ledger via `mergeAggs` — raw
   counts are **summed before rates are computed**, so 200 corpses observed across
   four players count exactly like 200 from one. Friends' logged trades are merged
   into `trades.json` too (de-duplicated).

   The merged data names its `contributors` in `data.json`, and the commit message
   notes how many contributors were folded in.

## Notes

- These files are committed to the repo, so the pooled site data is reproducible
  and every contribution is traceable.
- Only the owner can publish — friends contribute *data*, never push access or
  credentials. This is the lightweight, trusted-friends version of full
  crowdsourcing (see the **Crowdsourcing server** item in `ROADMAP.md`).
- A file is ignored here if it isn't valid JSON or has no `agg` field, so a stray
  file won't break a publish.
