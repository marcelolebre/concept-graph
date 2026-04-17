// Phoenix LiveView hook for the concept-graph component.
//
// INSTALL:
//   1. Copy this file to: assets/vendor/concept-graph-hook.js
//   2. Copy dist/concept-graph.esm.js to: assets/vendor/concept-graph.js
//   3. In assets/js/app.js:
//
//        import { ConceptGraphHook } from "../vendor/concept-graph-hook";
//        let liveSocket = new LiveSocket("/live", Socket, {
//          hooks: { ConceptGraph: ConceptGraphHook },
//          params: { _csrf_token: csrfToken }
//        });
//
// USAGE IN A HEEX TEMPLATE:
//
//   <div id="concept-graph"
//        phx-hook="ConceptGraph"
//        phx-update="ignore"
//        data-height="620"
//        data-concepts={Jason.encode!(@concepts)}
//        data-relations={Jason.encode!(@relations)}>
//   </div>
//
// phx-update="ignore" is important — LiveView must not replace the canvas
// contents on every render. Updates flow through data-* attributes, which
// the hook's updated() callback re-reads.
//
// The hook also pushes events to the server when the user focuses a concept
// or changes modes. Handle them with handle_event/3:
//
//   def handle_event("concept_focused", %{"id" => id}, socket), do: ...
//   def handle_event("mode_changed",    %{"mode" => m}, socket), do: ...

import { ConceptGraph } from "./concept-graph.js";

export const ConceptGraphHook = {
  mounted() {
    const height = parseInt(this.el.dataset.height || "620", 10);
    const initialFocus = this.el.dataset.focus || null;

    this.graph = new ConceptGraph(this.el, {
      height,
      initialFocus,
      onFocus: (concept) => {
        this.pushEventTo(this.el, "concept_focused", { id: concept.id });
      },
      onModeChange: (mode) => {
        this.pushEventTo(this.el, "mode_changed", { mode });
      },
    });

    this._lastData = null;
    this._syncData();
  },

  updated() {
    // Only re-push data if it actually changed. Stringifying the dataset
    // lets us cheaply diff without deep-comparing parsed objects.
    this._syncData();

    // allow the server to drive focus or mode
    const focus = this.el.dataset.focus;
    if (focus && this.graph) this.graph.focusConcept(focus);

    const mode = this.el.dataset.mode;
    if (mode && this.graph) this.graph.setMode(mode);
  },

  destroyed() {
    if (this.graph) this.graph.destroy();
    this.graph = null;
  },

  _syncData() {
    const raw = (this.el.dataset.concepts || "") + "|" + (this.el.dataset.relations || "");
    if (raw === this._lastData) return;
    this._lastData = raw;

    let concepts = [], relations = [];
    try { concepts = JSON.parse(this.el.dataset.concepts || "[]"); } catch (e) {}
    try { relations = JSON.parse(this.el.dataset.relations || "[]"); } catch (e) {}

    if (this.graph) this.graph.setData({ concepts, relations });
  },
};

export default ConceptGraphHook;
