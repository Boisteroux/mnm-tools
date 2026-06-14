# MnM Map

A map and marker companion app for the MMO **Monsters & Memories**, which ships
without an in-game map. MnM Map gives you zone maps from the community wiki,
lets you mark resource nodes / NPCs / crafting stations, follows you between
zones automatically by reading the game's log, and can float as a transparent
overlay on top of the game.

> Fan-made and unofficial. Not affiliated with or endorsed by the developers of
> Monsters & Memories (Niche Worlds Cult). Use at your own discretion.

---

## For players — just want to use it?

1. Go to the [**Releases**](../../releases) page.
2. Download the latest `MnM-Map-Setup-x.x.x.exe`.
3. Run it and follow the installer. That's it — no other software needed.

### Using the app

- **Zones appear automatically** as you enter them in-game (it reads the game's
  log file — it never touches or modifies the game).
- Use **Import All** once to pull every zone and its map from the community wiki.
- **Click a category button** (Ore, Herbs, …), then click the map to drop markers.
- **Checkboxes** show/hide each marker type.
- **Enter Game Overlay Mode** floats the map over your game (run the game in
  *Borderless Windowed*; on a second monitor it works in any mode).
- **Export / Import Zones** to share your markers (and maps) with friends.

Your maps and markers are saved automatically to `%AppData%\mnm-minimap`.

---

## For contributors — want to improve it?

```bash
git clone https://github.com/YOUR_USERNAME/mnm-map.git
cd mnm-map
npm install
npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and how to submit
changes. Building the installer yourself: `npm run dist`.

---

## Support the project

MnM Map is free and open-source (MIT). If it's made your adventures easier and
you'd like to chip in a couple of bucks, there's a **Sponsor** button at the top
of the repo — entirely optional, always appreciated. 🍻

## License

[MIT](LICENSE) — free to use, modify, and share, with credit.
