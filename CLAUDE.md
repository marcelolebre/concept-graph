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

Seven concrete kinds get an intentional palette and glyph. Anything
outside the list falls through to the `violet` / `interactive`
defaults. Visual mapping lives at the top of `src/concept-graph.js`
(`KIND_TAG_CLASS`, `KIND_STROKE`):

| bucket    | kinds                                  | meaning                             |
|-----------|----------------------------------------|-------------------------------------|
| teal      | `person`, `organization`               | real-world nouns you can point at   |
| amber     | `observation`, `decision`, `artifact`  | things that happened / were decided |
| violet    | `concept`, `entity`                    | abstractions + the root entity node |

Each concept also gets a deterministic per-id glyph variant (FNV-1a hash
over `id` → rotation, facet count, inner ornament phase) so the same
concept looks the same across reloads and machines.

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
  modulates width subtly. A small colored pip per node shows its agent run.
- **provenance** — edges recolor by the source node's agent run. Useful
  for seeing which run contributed which subgraph.
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
