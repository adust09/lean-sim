# lean-sim

A collection of **interactive, in-browser simulators** that visualize the mechanisms of the
[leanEthereum/leanSpec](https://github.com/leanEthereum/leanSpec) **Python reference
implementation** ("Lean Consensus"). Run them in the browser to build intuition.

Vanilla JavaScript + HTML Canvas — **no build step and no dependencies**. Files load as classic
`<script>` tags, so the simulators run directly from `file://` or any static server. UI text and
explanations are in Japanese.

> **Source of truth:** the simulators are kept faithful to the leanSpec **Python code**
> (`src/lean_spec/`), not the older PDF — which diverges from the implementation and is not in the
> repo. Each scene's badge and inline references point at the implementation file/function it
> visualizes (e.g. `config.py`, `fork_choice.py`, `state_transition.py`).

## Running

```bash
python3 -m http.server 8000
# open http://localhost:8000 in your browser
```

`index.html` is the landing page linking to each topic. There is no build, test runner, or
linter — verification means opening the relevant page and checking the canvas/console.

## Simulators

| Topic | leanSpec reference | What it shows |
| --- | --- | --- |
| **SSZ** (`ssz/`) | `ssz/` · `crypto/merkleization.py` | serialize (offsets) → merkleize (SHA-256) → Merkle proof, over real leanSpec containers |
| **Time** (`time/`) | `config.py` · `clock.py` · `timeline.py` | slot clock (5 intervals × 800 ms) and proposal-timing vs the aggregation / safe-target points |
| **State** (`state/`) | `state_transition.py` · `containers/state.py` | the state transition Υ over the full State/Block anatomy (validators registry, count-based 2/3) |
| **P2P** (`p2p/`) | `node/networking/` | discovery (static bootstrap + ENR; discv5 planned), QUIC 1-RTT, gossipsub, req-resp, node lifecycle |
| **Consensus** (`consensus/`) | `fork_choice.py` · `slot.py` · `containers/aggregation.py` | LMD-GHOST fork choice + 3SF justification, and Single→MultiMessageAggregate signature merge |
| **Protocol** (`protocol/`) | `forks/lstar/` | the whole chain on a 5-interval heartbeat — propagation, voting, aggregation, GHOST — with parameter-driven fork phenomena (finality stall / equivocation / partition / withholding reorg) |

## Architecture

A single shared shell in `shared/` drives every topic:

- `core.js` — the global `P2P` namespace: seeded RNG, math, canvas drawing helpers, the `P2P.ui`
  control factory, colors, and the `P2P.scenes` registry.
- `app.js` — the application shell: tab bar, DPR-scaled canvas, animation loop, mouse forwarding,
  and the live stats / description panels.
- `style.css` — the shared dark theme.

Each `<topic>/index.html` loads `core.js`, then its own `js/scenes/*.js` (one self-contained scene
per tab), sets `window.P2P_SCENE_ORDER`, and loads `app.js` last. See [CLAUDE.md](CLAUDE.md) for the
full scene interface and project conventions.
