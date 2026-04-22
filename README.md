# concept-graph

A wiki + force-directed graph component for visualizing concepts produced by an LLM or agent. Zero dependencies. Ships as ES module and UMD. Mounts on any `HTMLElement`.

The API is deliberately tiny — three methods.

---

## Install

Copy the two files you need into your project:

- `dist/concept-graph.esm.js` — for bundlers (Vite, esbuild, webpack, LiveView)
- `dist/concept-graph.umd.js` — for plain `<script>` tags

Or publish the folder to npm and `npm install concept-graph`.

---

## API

```js
new ConceptGraph(el, options?)
```

`el` is any `HTMLElement`. Options (all optional):

| option          | default       | description                                      |
|-----------------|---------------|--------------------------------------------------|
| `height`        | `620`         | Component height in px.                          |
| `initialMode`   | `'default'`   | `'default'` \| `'provenance'` \| `'confidence'`. |
| `initialFocus`  | `null`        | Concept id to open on mount.                     |
| `onFocus`       | `null`        | `(concept) => void` when a node is clicked.      |
| `onModeChange`  | `null`        | `(mode) => void` when the mode chip is toggled.  |

### Methods

```js
graph.setData({ concepts, relations });  // (re)populate the graph
graph.focusConcept(id);                  // open wiki panel for id
graph.setMode('provenance');             // switch edge encoding
graph.fit();                             // recenter and auto-zoom
graph.destroy();                         // unmount + free resources
```

### Data shape

```js
const concepts = [
  {
    id:      "carbon-pricing-elasticity",          // required, unique
    label:   "Carbon pricing elasticity",          // display name
    kind:    "claim",                              // 'claim' | 'hypothesis' | 'fact'
    run:     0,                                    // integer — which agent run produced this
    summary: "Short-run demand response clusters around −0.3...",
    created: "2026-04-12T14:22Z"                   // optional, shown in metadata
  },
  // ...
];

const relations = [
  {
    source:     "carbon-pricing-elasticity",       // concept id
    target:     "rebate-mechanism",                 // concept id
    type:       "refine",                           // 'derive' | 'refine' | 'contradict' | any string
    confidence: 0.82                                // 0..1 (non-numeric values are coerced)
  },
  // ...
];
```

Array-tuple form is also accepted: `["source-id", "target-id", "refine", 0.82]`.

`type` accepts any string. The three legacy types (`derive` / `refine` /
`contradict`) are special-cased with passive forms for incoming edges
(`derived-by`, `refined-by`, `contradicted-by`) and map to the three
coloured verb pills. Any other string is shown verbatim, with an `←`
prefix on incoming edges to keep direction readable (e.g. `created`,
`named_after`, `wrote`). Underscores are rendered as spaces.

---

## Usage

### Plain HTML

```html
<div id="graph"></div>
<script src="dist/concept-graph.umd.js"></script>
<script>
  const g = new ConceptGraph(document.getElementById("graph"), { height: 640 });
  g.setData({ concepts, relations });
</script>
```

### ES module / bundler

```js
import { ConceptGraph } from "concept-graph";

const g = new ConceptGraph(el);
g.setData({ concepts, relations });
// later...
g.destroy();
```

### Phoenix LiveView

Copy `dist/concept-graph.esm.js` and `dist/concept-graph-hook.js` to `assets/vendor/`, then wire the hook into `app.js`:

```js
import { ConceptGraphHook } from "../vendor/concept-graph-hook";

let liveSocket = new LiveSocket("/live", Socket, {
  hooks: { ConceptGraph: ConceptGraphHook },
  params: { _csrf_token: csrfToken }
});
```

In your HEEX template:

```heex
<div id="concept-graph"
     phx-hook="ConceptGraph"
     phx-update="ignore"
     data-height="620"
     data-focus={@focused_id}
     data-concepts={Jason.encode!(@concepts)}
     data-relations={Jason.encode!(@relations)}>
</div>
```

`phx-update="ignore"` is essential — LiveView must not re-render the canvas contents on each diff. Data flows in through `data-*` attributes; the hook diffs them and calls `setData` only when they actually change.

The hook pushes events to the LiveView when the user interacts:

```elixir
def handle_event("concept_focused", %{"id" => id}, socket) do
  {:noreply, assign(socket, focused_id: id)}
end

def handle_event("mode_changed", %{"mode" => mode}, socket) do
  {:noreply, assign(socket, graph_mode: mode)}
end
```

The server can drive the UI by assigning `@focused_id` or a mode — the hook's `updated()` callback picks up the change and forwards it to the component.

---

## Interactions

| action                    | what happens                                                    |
|---------------------------|-----------------------------------------------------------------|
| click node                | opens its wiki entry in the right panel                         |
| drag node                 | pins it; release to let physics take over                       |
| drag empty space          | pans the canvas                                                 |
| scroll / pinch            | zooms around the cursor                                         |
| `1` / `2` / `3`           | switches to default / provenance / confidence mode              |
| `F`                       | fits the graph to the viewport                                  |
| `Esc`                     | deselects the focused node                                      |
| click a relation in panel | navigates to that concept (wiki-style)                          |

---

## Theming

All colours, fonts and radii are driven by CSS custom properties. Declare
them on any ancestor (`:root`, `body`, or the component's container) and the
graph — panel, sidebar, **and canvas** — will track them. Toggling a
`body.light` / `body.dark` class is enough to re-theme the whole component
without re-mounting it.

| token                 | falls back to                                  | used for                                  |
|-----------------------|------------------------------------------------|-------------------------------------------|
| `--black`             | `#000000`                                      | canvas stage background                   |
| `--surface`           | `#111111`                                      | topbar, sidebar, right panel, node fill   |
| `--surface-raised`    | `#1A1A1A`                                      | active chip background, tooltip           |
| `--border`            | `#2E2E2E`                                      | dividers, canvas grid, idle chip border   |
| `--border-visible`    | `#555555`                                      | sidebar swatches, hover chip border       |
| `--text-disabled`     | `#8F8F8F`                                      | crumbs, HUD, sidebar section headings     |
| `--text-secondary`    | `#B8B8B8`                                      | body text, node labels                    |
| `--text-primary`      | `#E8E8E8`                                      | target labels, `fact` nodes               |
| `--text-display`      | `#FFFFFF`                                      | panel `<h2>`, focused node stroke         |
| `--accent`            | `#D71921`                                      | `contradict` edges + verb pill            |
| `--success`           | `#4A9E5C`                                      | `refine` verb, live dot                   |
| `--warning`           | `#D4A843`                                      | `amber` tag                               |
| `--interactive`       | `#5B9BF6`                                      | `derive` verb, `violet` tag               |
| `--font-body`         | `Space Grotesk, system-ui, sans-serif`         | body text, node labels                    |
| `--font-mono`         | `Space Mono, ui-monospace, Menlo, monospace`   | chips, verbs, section labels, counts      |

The canvas reads these tokens from `getComputedStyle(el)` every frame, so
toggling dark/light at runtime repaints immediately with no redraw glue.
Standalone usage without the tokens falls back to a dark-instrument palette
(the original look).

The component pairs well with [Cicrus](https://github.com/marcelolebre/cicrus)
which declares every token above on `:root` / `body.light`.

---

## The three modes

**Default.** Relation type is encoded in line style (solid = derives, thicker = refines, dashed = contradicts). Confidence bleeds through as subtle width modulation. A small colored pip on each node shows its agent run. Reads calmly at rest.

**Provenance.** Edges recolor by the source node's agent run. Useful for seeing which run contributed which subgraph.

**Confidence.** Edges go grayscale; width and opacity scale with confidence. Weak links fade; high-confidence ones thicken. Makes epistemic structure pop.

---

## License

MIT.
