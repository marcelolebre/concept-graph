# concept-graph

A single-component wiki + force-directed graph for visualizing LLM/agent concepts.
Primary consumer: Phoenix LiveView apps (currently: Icarus Hub's `/knowledge` view).

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
- **Theme via CSS custom properties.** The canvas reads tokens from
  `getComputedStyle(el)` every frame so dark/light toggles on `body`
  repaint without remounting. Tokens line up with
  [cicrus](https://github.com/marcelolebre/cicrus).

## Build

    node scripts/build.js

Produces `dist/concept-graph.esm.js` and `dist/concept-graph.umd.js`.
No bundler, no watch mode — it's 30 lines of text transformation.

## Test locally

    python3 -m http.server 8000
    # open http://localhost:8000/examples/plain.html

## Data model

See README for the canonical shape. Summary:

- **Concepts** have `id`, `label`, `kind`, `run`, `summary`, optional `created`.
- **Relations** have `source`, `target`, `type`, `confidence` (0..1).
- Array-tuple form is accepted: `["src", "tgt", "refine", 0.82]`.

### Kind taxonomy (visual layer)

Seven concrete kinds map onto three Cicrus colour tokens. Anything
outside the list falls through to `interactive`. The single source of
truth is `KIND_TOKEN` at the top of `src/concept-graph.js`
(re-exported as `KIND_TAG_CLASS` / `KIND_STROKE` for back-compat):

| token         | kinds                                  | meaning                             |
|---------------|----------------------------------------|-------------------------------------|
| `success`     | `person`, `organization`               | real-world nouns you can point at   |
| `warning`     | `observation`, `decision`, `artifact`  | things that happened / were decided |
| `interactive` | `concept`, `entity`                    | abstractions + the root entity node |

### Glyph language (instrument-dial)

All glyphs share the same silhouette — a thin stroked ring. Kind is
encoded by a small set of filled dots riding on the ring, not by
varying the outer shape. One dial family, different needle positions.

| kind           | mark                                          |
|----------------|-----------------------------------------------|
| `concept`      | empty ring                                    |
| `entity`       | double-stroke ring + centre dot *(the break)* |
| `person`       | 1 dot @ 12 o'clock                            |
| `artifact`     | 1 dot @ 6 o'clock                             |
| `decision`     | 2 dots @ 9 + 3                                |
| `organization` | 3 dots @ 12 / 4 / 8                           |
| `observation`  | dashed ring (transient / witness)             |

`entity` is the single "break the pattern" moment per Cicrus craft
rules — everything else shares the same ring weight. No hash-driven
rotation or facet jitter: same input = same glyph across reloads,
percussive/mechanical rather than decorative-random.

### Relation taxonomy (edge layer)

Relations are canonicalised into **three buckets** at render time:

- `related` — derives, refines, any generic positive relation. Green/interactive.
- `indirectly-related` — weaker or transitive links. Muted.
- `contradicts` — conflicts or rebuttals. Red/accent.

The three legacy strings (`derive`, `refine`, `contradict`) still work
and are special-cased with passive forms (`derived-by`, `refined-by`,
`contradicted-by`) for incoming edges on the wiki panel. Any other
string is kept verbatim and shown with an `←` prefix on incoming edges
(e.g. `created`, `named_after`, `wrote`). Underscores render as spaces.

### Three modes

- **default** — relation bucket encoded in line style + color; confidence
  modulates width subtly. Node glyphs are silent on provenance — the
  dial is the whole visual.
- **provenance** — edges recolor by the source node's agent run; the
  node ring itself switches to the run colour so the whole subgraph
  reads as one voice. Default mode is silent on run so the two
  languages don't compete.
- **confidence** — edges go grayscale; width and opacity scale with
  confidence. Weak links fade; high-confidence ones thicken.

## Integration with Icarus Hub

- `apps/icarus_hub/assets/vendor/concept-graph.esm.js` is vendored from `dist/`.
- Hub reads `~/daneel/graphify-out/graph.json` (produced by
  [graphify](https://pypi.org/project/graphify/)) and passes the
  `{ concepts, relations }` payload through `data-*` attributes.
- Commits that sync this repo into Hub are titled
  `Knowledge: pull concept-graph@<short-sha>` — keep that convention so
  the provenance is traceable.

## Known things to decide

- Persistence of layout across sessions (currently in-memory only)
- Search/filter UI for graphs >100 nodes
- Touch gestures (pan works, pinch-zoom doesn't)
- Edge bundling for dense subgraphs
