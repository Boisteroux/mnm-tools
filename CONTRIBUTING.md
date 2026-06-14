# Contributing to MnM Map

Thanks for wanting to help! This is a community map tool for *Monsters &
Memories*, and contributions of all kinds are welcome — code, zone maps,
marker data, bug reports, and ideas.

## Ways to contribute

- **Report a bug or request a feature** — open an [Issue](../../issues).
- **Share marker data** — export a zone (or all zones) and attach the file to
  an Issue, or open a Pull Request.
- **Improve the app** — fix a bug or add a feature via a Pull Request (steps
  below).

## Setting up for development

You'll need [Node.js](https://nodejs.org) (LTS) installed.

```bash
git clone https://github.com/YOUR_USERNAME/mnm-map.git
cd mnm-map
npm install        # downloads Electron and other dependencies
npm start          # launches the app
```

> If `npm install` can't download the Electron binary on your network, see the
> note in the README — you can fetch it directly from the Electron releases page.

## Project layout

| File / folder      | What it does                                            |
|--------------------|---------------------------------------------------------|
| `main.js`          | Electron main process: window, game-log watching, wiki + file IPC |
| `preload.js`       | Safe bridge between the window and the main process     |
| `renderer/`        | The app UI — `index.html`, `styles.css`, `app.js` (map, markers, overlay) |
| `package.json`     | Dependencies, scripts, and the installer build config   |

## Making a change

1. **Fork** this repo (button on GitHub), then clone your fork.
2. Create a branch: `git checkout -b my-change`.
3. Make your change and test it with `npm start`.
4. Commit and push to your fork.
5. Open a **Pull Request** describing what you changed and why.

Keep changes focused, and match the style of the surrounding code. If you're
unsure about an idea, open an Issue first to discuss it.

## Building the installer

`npm run dist` produces a Windows installer in `dist/` (used for releases).
