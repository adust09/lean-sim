# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`lean-sim` is a collection of interactive, in-browser simulators that visualize the mechanisms described in [Lean Consensus](https://github.com/leanEthereum/leanSpec). It is **vanilla JavaScript + HTML Canvas with no build step and no dependencies** — files load as classic `<script>` tags so the simulators run directly from `file://` or any static server. UI text and explanations are written in Japanese.

## Running

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

`index.html` is the landing page linking to each topic. There is no test runner, linter, or build — verification means opening the relevant page in a browser and checking the canvas/console.

## Architecture

A single shared shell drives every topic. The big picture spans three layers:

1. **`shared/`** — loaded first on every page.
   - `core.js` creates the global `P2P` namespace (`P2P.scenes` registry) and provides `P2P.util` (seeded mulberry32 RNG, math), `P2P.draw` (canvas helpers: `line`, `arrow`, `disc`, `glow`, `roundedRect`, `label`), `P2P.ui` (DOM control factory: `button`, `toggle`, `slider`, `group`), `P2P.colors`, and `P2P.ease`. Despite the `P2P` name, this namespace is shared by **all** topics, not just the P2P one.
   - `app.js` is the application shell: it owns the tab bar, the DPR-scaled canvas, the `requestAnimationFrame` loop, mouse forwarding, the live stats panel, and `#section`/`#description` panels. It reads `window.P2P_SCENE_ORDER` to know which scenes to show and in what order.
   - `style.css` — shared dark theme for the shell and landing page.

2. **`<topic>/index.html`** — one per topic (`p2p`, `ssz`, `time`, `state`, `consensus`, `protocol`). Each declares the shared shell layout (`#stage` canvas, `#tabs`, `#controls`, `#stats`, `#description`), loads `../shared/core.js`, then its own `js/scenes/*.js`, sets `window.P2P_SCENE_ORDER = [...]`, and **loads `../shared/app.js` last** (order matters: scenes must register before the shell boots).

3. **`<topic>/js/scenes/*.js`** — each file is one scene (one tab). It wraps itself in an IIFE and registers onto `P2P.scenes[id]`. Scenes are self-contained: state, simulation, rendering, and controls all live in the one file.

### Scene interface

Every scene object implements this contract (consumed by `app.js`):

- Metadata: `id`, `title`, `sectionRef` (e.g. `"2.3"`, used for the `§` badge/tab), `descriptionHTML`.
- Lifecycle: `init(env)` (env = `{width, height}`, called once on first activation), `resize(w, h)`, `update(dt)` (dt in seconds, capped at 0.05), `render(ctx)`.
- Interaction: `onMouse(type, x, y)` where `type` is `"move"` or `"click"` (optional).
- Panels: `getStats()` returns `[{label, value}]` rows (diffed each frame); `buildControls(container)` appends `P2P.ui` controls.

## Conventions

- Keep scene logic inside the scene file's IIFE; reach shared functionality only through the `P2P.*` namespace.
- Use `P2P.util.makeRng(seed)` for any randomness so layouts/animations stay reproducible.
- Adding a topic: create `<topic>/index.html` (copy an existing one), add scene files under `<topic>/js/scenes/`, set `P2P_SCENE_ORDER`, and add a card to the root `index.html`. No other wiring is needed.
- Scene files anchor explanations to specific spec sections — the leading block comment cites the `§` it visualizes; keep that mapping accurate when editing.
