# concept-graph

A single-component wiki + force-directed graph for visualizing LLM/agent concepts.
Primary consumer: Phoenix LiveView apps.

## Architecture constraints (non-negotiable)

- **Zero runtime dependencies.** No npm installs for the library itself.
- **Single source of truth:** `src/concept-graph.js`. Both dist builds are
  generated from this one file by `scripts/build.js`.
- **API surface is deliberately minimal:** `constructor`, `setData`,
  `focusConcept`, `setMode`, `fit`, `destroy`. Resist adding more.
- **Styles are injected once** under `.cg-root` namespace. Never leak into
  the host page.
- **LiveView-safe:** `setData` must preserve node positions by id across
  calls, because the server will re-push the full concept list on every
  agent tick.

## Build

    node scripts/build.js

Produces `dist/concept-graph.esm.js` and `dist/concept-graph.umd.js`.
No bundler, no watch mode — it's 30 lines of text transformation.

## Test locally

    python3 -m http.server 8000
    # open http://localhost:8000/examples/plain.html

## Data model

See README. Concepts have id/label/kind/run/summary. Relations have
source/target/type/confidence. Three edge types: derive, refine, contradict.
Three modes: default, provenance, confidence.

## Known things to decide

- Persistence of layout across sessions (currently in-memory only)
- Search/filter UI for graphs >100 nodes
- Touch gestures (pan works, pinch-zoom doesn't)
- Edge bundling for dense subgraphs
