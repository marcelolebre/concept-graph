// concept-graph.js
// A wiki + force-directed graph component for visualizing LLM/agent concepts.
// Zero dependencies. Mounts on any HTMLElement. Works in LiveView hooks,
// React effects, vanilla pages, etc.
//
// Usage:
//   import { ConceptGraph } from 'concept-graph';
//   const g = new ConceptGraph(el, { height: 620 });
//   g.setData({ concepts: [...], relations: [...] });
//   // ...later:
//   g.destroy();

const RUN_COLORS = ['#5eead4', '#a78bfa', '#fbbf24', '#f472b6', '#60a5fa', '#34d399'];

// Kind taxonomy → visual treatment. Every concrete kind that graphify
// emits gets an intentional colour; anything unknown falls through to
// `violet` / default border. Three CSS tag classes (teal / amber /
// violet) are re-used across seven kinds so the palette stays tight.
//
//   teal    — real-world nouns you can point at (person, organization)
//   amber   — things-that-happened or decisions made (observation, decision, artifact)
//   violet  — abstract concepts and the root entity node
//
// KIND_STROKE maps to cicrus theme tokens on the canvas so the ring
// colour of each node matches its sidebar pill colour.
const KIND_TAG_CLASS = {
  person: 'teal', organization: 'teal',
  observation: 'amber', decision: 'amber', artifact: 'amber',
  concept: 'violet', entity: 'violet',
};
const KIND_STROKE = {
  person: 'success', organization: 'success',
  observation: 'warning', decision: 'warning', artifact: 'warning',
  concept: 'interactive', entity: 'interactive',
};

// Parse a hex colour (#rgb or #rrggbb) or rgb[a]() string into [r,g,b,a].
// Returns null if the colour can't be parsed. Used to blend cicrus tokens
// in confidence mode so the component tracks dark/light themes.
function parseColor(str) {
  if (!str) return null;
  const s = str.trim();
  if (s[0] === '#') {
    const hex = s.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        1,
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        1,
      ];
    }
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m) {
    const parts = m[1].split(',').map(p => parseFloat(p));
    if (parts.length >= 3) return [parts[0], parts[1], parts[2], parts[3] != null ? parts[3] : 1];
  }
  return null;
}

function mixRgba(a, b, t, alpha) {
  const ca = parseColor(a) || [128, 128, 128, 1];
  const cb = parseColor(b) || [232, 232, 232, 1];
  const lerp = (x, y) => Math.round(x + (y - x) * t);
  return `rgba(${lerp(ca[0], cb[0])},${lerp(ca[1], cb[1])},${lerp(ca[2], cb[2])},${alpha})`;
}

const DEFAULT_OPTIONS = {
  height: 620,
  initialMode: 'default',      // 'default' | 'provenance' | 'confidence'
  initialFocus: null,          // concept id to focus on mount
  onFocus: null,               // (concept) => void
  onModeChange: null,          // (mode) => void
};

export class ConceptGraph {
  constructor(el, options = {}) {
    if (!el || !(el instanceof HTMLElement)) {
      throw new Error('ConceptGraph: first argument must be an HTMLElement');
    }
    this.el = el;
    this.opts = { ...DEFAULT_OPTIONS, ...options };
    this._destroyed = false;

    this._state = {
      concepts: [],
      relations: [],
      nodes: [],
      edges: [],
      idToNode: new Map(),
      mode: this.opts.initialMode,
      focus: null,
      hovered: null,
      // Sidebar filter highlights. `filterKind` and `filterEdgeType` are
      // mutually independent toggles: clicking a Concept-kind row pins
      // that kind; clicking a Relation row pins that edge type. Both
      // dim everything else on the canvas. null = no filter.
      filterKind: null,
      filterEdgeType: null,
      cam: { x: 0, y: 0, zoom: 1 },
      dragging: null,
      panning: false,
      lastMouse: null,
      raf: null,
      W: 0, H: 0, DPR: window.devicePixelRatio || 1,
    };

    this._injectStyles();
    this._renderShell();
    this._bindEvents();
    this._startLoop();
  }

  // ---------- public API ----------

  setData({ concepts = [], relations = [] } = {}) {
    if (this._destroyed) return;
    const s = this._state;

    // preserve positions for nodes that already exist (smooth updates)
    const prevPos = new Map();
    for (const n of s.nodes) prevPos.set(n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy });

    s.concepts = concepts;
    s.relations = relations;
    s.idToNode = new Map();

    const count = concepts.length || 1;
    s.nodes = concepts.map((c, i) => {
      const prev = prevPos.get(c.id);
      const angle = (i / count) * Math.PI * 2;
      const n = {
        ...c,
        x: prev ? prev.x : 400 + Math.cos(angle) * 160,
        y: prev ? prev.y : 260 + Math.sin(angle) * 160,
        vx: prev ? prev.vx : 0,
        vy: prev ? prev.vy : 0,
        deg: 0,
        pinned: false,
      };
      s.idToNode.set(c.id, n);
      return n;
    });

    s.edges = relations
      .map(r => {
        const source = typeof r.source === 'string' ? r.source : r[0];
        const target = typeof r.target === 'string' ? r.target : r[1];
        const type   = r.type || r[2] || 'derive';
        // `label` is the original/specific verb (e.g. "named after",
        // "wrote") surfaced on the node detail panel. `type` is the
        // canonical bucket used for filtering, colouring and the sidebar
        // legend. Standalone callers that only pass `type` get the type
        // as the label.
        const label = r.label || r[4] || type;
        // Confidence must be numeric — the physics step does
        // `0.5 + conf * 0.8` every tick. A non-number (e.g. "EXTRACTED")
        // propagates NaN into every node position within a few ticks and
        // the entire canvas blanks. Coerce to a float with a sane default.
        const rawConf = r.confidence != null ? r.confidence : (r[3] != null ? r[3] : 0.5);
        let conf = typeof rawConf === 'number' ? rawConf : parseFloat(rawConf);
        if (!Number.isFinite(conf)) conf = 0.7;
        const s_ = s.idToNode.get(source);
        const t_ = s.idToNode.get(target);
        if (!s_ || !t_) return null;
        return { s: s_, t: t_, type, label, conf };
      })
      .filter(Boolean);

    for (const e of s.edges) { e.s.deg++; e.t.deg++; }

    this._renderSidebar();
    this._updateHud();

    // focus
    let focus = null;
    if (this.opts.initialFocus) focus = s.idToNode.get(this.opts.initialFocus);
    if (!focus && s.nodes.length) {
      // pick highest-degree node as default focus
      let best = s.nodes[0];
      for (const n of s.nodes) if (n.deg > best.deg) best = n;
      focus = best;
    }
    s.focus = focus;
    if (focus) this._updatePanel(focus);

    // relax the layout briefly for a clean initial state (only if no prev positions)
    if (prevPos.size === 0) {
      for (let i = 0; i < 240; i++) this._step();
      this._fitCamera();
    }
  }

  focusConcept(id) {
    const n = this._state.idToNode.get(id);
    if (!n) return;
    this._state.focus = n;
    this._updatePanel(n);
  }

  setMode(mode) {
    if (!['default', 'provenance', 'confidence'].includes(mode)) return;
    this._state.mode = mode;
    this.el.querySelectorAll('.cg-chip[data-mode]').forEach(c => {
      c.classList.toggle('on', c.dataset.mode === mode);
    });
    this._updateHud();
    this.opts.onModeChange && this.opts.onModeChange(mode);
  }

  fit() { this._fitCamera(); }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._state.raf) cancelAnimationFrame(this._state.raf);
    if (this._resizeObs) this._resizeObs.disconnect();
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('keydown', this._onKeyDown);
    this.el.innerHTML = '';
    this.el.classList.remove('cg-root');
  }

  // ---------- internal: shell ----------

  _injectStyles() {
    if (document.getElementById('cg-styles')) return;
    const style = document.createElement('style');
    style.id = 'cg-styles';
    style.textContent = CG_CSS;
    document.head.appendChild(style);
  }

  _renderShell() {
    this.el.classList.add('cg-root');
    this.el.style.setProperty('--cg-height', this.opts.height + 'px');
    this.el.innerHTML = `
      <div class="cg-top">
        <div class="cg-brand"><span class="cg-dot"></span> agent://wiki</div>
        <span class="cg-sep">/</span>
        <span class="cg-path" data-cg="path">concepts</span>
        <div class="cg-spacer"></div>
        <span class="cg-chip" data-mode="default">Default <kbd>1</kbd></span>
        <span class="cg-chip" data-mode="provenance">Provenance <kbd>2</kbd></span>
        <span class="cg-chip" data-mode="confidence">Confidence <kbd>3</kbd></span>
      </div>
      <div class="cg-body">
        <aside class="cg-side" data-cg="sidebar"></aside>
        <div class="cg-stage" data-cg="stage">
          <canvas data-cg="canvas"></canvas>
          <div class="cg-hud"><b data-cg="hud-focus">—</b> &nbsp;·&nbsp; <span data-cg="hud-meta">0 nodes · 0 edges</span></div>
          <div class="cg-zoom">
            <button data-cg="zoom-in" aria-label="Zoom in">+</button>
            <button data-cg="zoom-out" aria-label="Zoom out">−</button>
            <button data-cg="zoom-fit" aria-label="Fit">fit</button>
          </div>
          <div class="cg-tooltip" data-cg="tooltip"></div>
        </div>
        <aside class="cg-panel" data-cg="panel"></aside>
      </div>
    `;

    this._dom = {
      path: this.el.querySelector('[data-cg="path"]'),
      sidebar: this.el.querySelector('[data-cg="sidebar"]'),
      stage: this.el.querySelector('[data-cg="stage"]'),
      canvas: this.el.querySelector('[data-cg="canvas"]'),
      hudFocus: this.el.querySelector('[data-cg="hud-focus"]'),
      hudMeta: this.el.querySelector('[data-cg="hud-meta"]'),
      tooltip: this.el.querySelector('[data-cg="tooltip"]'),
      panel: this.el.querySelector('[data-cg="panel"]'),
    };
    this._ctx = this._dom.canvas.getContext('2d');
    this._setMode(this.opts.initialMode);
    this._resizeCanvas();

    this._resizeObs = new ResizeObserver(() => this._resizeCanvas());
    this._resizeObs.observe(this._dom.stage);
  }

  _setMode(mode) { this.setMode(mode); }

  _renderSidebar() {
    const s = this._state;

    // Relation rows: three canonical buckets with stable order, regardless
    // of which buckets happen to have edges in the current graph. This is
    // a deliberate taxonomy choice (see GraphifyGraph.canonical_type) —
    // collapsing ~30 LLM-extracted verbs into {related, indirectly-related,
    // contradicts} so the legend is useful at a glance. Specific verbs
    // survive on the node detail pills via `e.label`.
    const relCounts = new Map();
    for (const e of s.edges) {
      const t = e.type || 'related';
      relCounts.set(t, (relCounts.get(t) || 0) + 1);
    }
    const canonicalOrder = [
      ['related',            ''      ],
      ['indirectly-related', 'thick' ],
      ['contradicts',        'dashed'],
    ];
    const shownRels = new Set();
    const relRows = canonicalOrder.map(([type, lnClass]) => {
      const cnt = relCounts.get(type) || 0;
      if (cnt === 0) return '';
      shownRels.add(type);
      const label = String(type).replace(/-/g, ' ');
      const active = s.filterEdgeType === type ? ' active' : '';
      return `<div class="cg-side-item cg-filter${active}" data-filter-edge="${escapeAttr(type)}"><span class="cg-ln ${lnClass}"></span><span>${escapeHtml(label)}</span><span class="cg-count">${String(cnt).padStart(2,'0')}</span></div>`;
    }).join('');
    // Defensive tail: any off-taxonomy types (shouldn't happen with
    // graphify normalisation, but the component is used standalone too).
    const extraRows = [...relCounts.entries()]
      .filter(([t]) => !shownRels.has(t))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, cnt]) => {
        const label = String(type).replace(/[_-]/g, ' ');
        const active = s.filterEdgeType === type ? ' active' : '';
        return `<div class="cg-side-item cg-filter${active}" data-filter-edge="${escapeAttr(type)}"><span class="cg-ln"></span><span>${escapeHtml(label)}</span><span class="cg-count">${String(cnt).padStart(2,'0')}</span></div>`;
      }).join('');
    const relRowsAll = relRows + extraRows;

    const kinds = new Map();
    for (const n of s.nodes) kinds.set(n.kind || 'concept', (kinds.get(n.kind || 'concept') || 0) + 1);
    // Swatch colour follows the same taxonomy as the right-panel pill
    // and the node ring, so one glance connects sidebar row ↔ canvas.
    const kindRows = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([kind, cnt]) => {
        const strokeToken = KIND_STROKE[kind];
        const colorVar = strokeToken === 'success'     ? 'var(--cg-success)'
                       : strokeToken === 'warning'     ? 'var(--cg-warning)'
                       : strokeToken === 'interactive' ? 'var(--cg-interactive)'
                       : 'var(--cg-border-visible)';
        const style = `background:transparent;border-color:${colorVar};`;
        const active = s.filterKind === kind ? ' active' : '';
        return `<div class="cg-side-item cg-filter${active}" data-filter-kind="${escapeAttr(kind)}"><span class="cg-sq" style="${style}"></span><span>${escapeHtml(kind)}</span><span class="cg-count">${String(cnt).padStart(2,'0')}</span></div>`;
      }).join('');

    this._dom.sidebar.innerHTML = `
      <h4>Relation</h4>
      ${relRowsAll || '<div class="cg-side-empty">—</div>'}
      <h4>Concept kind</h4>
      ${kindRows || '<div class="cg-side-empty">—</div>'}
    `;

    // Click handlers: toggle the filter, re-render (for the `.active`
    // class), then trigger a redraw. Redraw is implicit via the animation
    // loop, but we call _draw() to keep the highlight change snappy on
    // slow laptops where the rAF cadence might lag.
    this._dom.sidebar.querySelectorAll('[data-filter-edge]').forEach(el => {
      el.addEventListener('click', () => {
        const t = el.dataset.filterEdge;
        s.filterEdgeType = s.filterEdgeType === t ? null : t;
        this._renderSidebar();
        this._draw();
      });
    });
    this._dom.sidebar.querySelectorAll('[data-filter-kind]').forEach(el => {
      el.addEventListener('click', () => {
        const k = el.dataset.filterKind;
        s.filterKind = s.filterKind === k ? null : k;
        this._renderSidebar();
        this._draw();
      });
    });
  }

  _updatePanel(n) {
    if (!n) { this._dom.panel.innerHTML = ''; return; }
    const s = this._state;
    const rels = s.edges
      .filter(e => e.s === n || e.t === n)
      .map(e => {
        const outgoing = e.s === n;
        const other = outgoing ? e.t : e.s;
        // Pill verb = the *original* verb ("created", "named after",
        // "wrote") so specificity stays visible on node focus. Pill
        // colour/class = the canonical bucket (related /
        // indirectly-related / contradicts) which maps to the legend.
        // Incoming edges get a leading arrow so direction is readable.
        const canonical = e.type || 'related';
        const rawVerb = String(e.label || canonical).replace(/_/g, ' ');
        const verb = outgoing ? rawVerb : '← ' + rawVerb;
        const cls = canonical === 'contradicts' ? 'contradict'
                  : canonical === 'indirectly-related' ? 'refine'
                  : 'derive';
        return `<div class="cg-rel">
          <span class="cg-verb ${cls}">${escapeHtml(verb)}</span>
          <span class="cg-target" data-goto="${escapeAttr(other.id)}">${escapeHtml(other.label || other.id)}</span>
          <span class="cg-conf">${Math.round(e.conf * 100)}%</span>
        </div>`;
      }).join('');

    const kind = n.kind || 'concept';
    const kindClass = KIND_TAG_CLASS[kind] || 'violet';

    this._dom.panel.innerHTML = `
      <div class="cg-panel-head">
        <div class="cg-panel-crumbs">wiki <span class="cg-panel-sep">›</span> ${escapeHtml(n.id)}</div>
        <h2>${escapeHtml(n.label || n.id)}</h2>
        <div class="cg-panel-tags">
          <span class="cg-tag ${kindClass}">${escapeHtml(kind)}</span>
          <span class="cg-tag">degree ${n.deg}</span>
        </div>
      </div>
      <div class="cg-panel-body">
        <div class="cg-sec">Summary</div>
        <p>${escapeHtml(n.summary || 'No summary provided.')}</p>
        <div class="cg-sec">Relationships</div>
        ${rels || '<div class="cg-side-empty">No relationships.</div>'}
        <div class="cg-sec">Metadata</div>
        <dl class="cg-meta">
          <dt>id</dt><dd>${escapeHtml(n.id)}</dd>
          <dt>kind</dt><dd>${escapeHtml(kind)}</dd>
          <dt>degree</dt><dd>${n.deg}</dd>
          ${n.created ? `<dt>created</dt><dd>${escapeHtml(String(n.created))}</dd>` : ''}
        </dl>
      </div>
    `;

    this._dom.panel.querySelectorAll('.cg-target').forEach(t => {
      t.addEventListener('click', () => {
        const target = this._state.idToNode.get(t.dataset.goto);
        if (target) {
          this._state.focus = target;
          this._updatePanel(target);
        }
      });
    });

    this._dom.hudFocus.textContent = n.id;
    this.opts.onFocus && this.opts.onFocus(n);
  }

  _updateHud() {
    const s = this._state;
    this._dom.hudMeta.textContent =
      `${s.nodes.length} nodes · ${s.edges.length} edges · mode:${s.mode}`;
  }

  // ---------- internal: events ----------

  _bindEvents() {
    const cvs = this._dom.canvas;

    cvs.addEventListener('mousedown', (e) => {
      const rect = cvs.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const hit = this._hitNode(sx, sy);
      if (hit) { this._state.dragging = hit; hit.pinned = true; }
      else { this._state.panning = true; }
      this._state.lastMouse = [sx, sy];
      this._state.downMouse = [sx, sy];
    });

    this._onMouseMove = (e) => {
      const rect = cvs.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const s = this._state;
      if (s.dragging) {
        const [wx, wy] = this._toWorld(sx, sy);
        s.dragging.x = wx; s.dragging.y = wy;
        s.dragging.vx = 0; s.dragging.vy = 0;
      } else if (s.panning && s.lastMouse) {
        const [lx, ly] = s.lastMouse;
        s.cam.x -= (sx - lx) / s.cam.zoom;
        s.cam.y -= (sy - ly) / s.cam.zoom;
        s.lastMouse = [sx, sy];
      } else {
        const inside = sx >= 0 && sy >= 0 && sx <= s.W && sy <= s.H;
        const h = inside ? this._hitNode(sx, sy) : null;
        if (h !== s.hovered) {
          s.hovered = h;
          if (h) {
            this._dom.tooltip.style.display = 'block';
            this._dom.tooltip.innerHTML =
              `<div><span class="cg-k">concept</span>${escapeHtml(h.label || h.id)}</div>` +
              `<div><span class="cg-k">kind</span>${escapeHtml(h.kind || 'concept')}</div>` +
              `<div><span class="cg-k">degree</span>${h.deg}</div>`;
          } else {
            this._dom.tooltip.style.display = 'none';
          }
        }
        if (h) {
          this._dom.tooltip.style.left = (sx + 14) + 'px';
          this._dom.tooltip.style.top = (sy + 14) + 'px';
        }
      }
    };
    window.addEventListener('mousemove', this._onMouseMove);

    this._onMouseUp = (e) => {
      const s = this._state;
      const rect = cvs.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      if (s.dragging) {
        const down = s.downMouse || [sx, sy];
        const moved = Math.hypot(down[0] - sx, down[1] - sy);
        if (moved < 3) {
          s.focus = s.dragging;
          this._updatePanel(s.dragging);
        }
        s.dragging.pinned = false;
        s.dragging = null;
      }
      s.panning = false;
      s.lastMouse = null;
      s.downMouse = null;
    };
    window.addEventListener('mouseup', this._onMouseUp);

    cvs.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = cvs.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const [wx, wy] = this._toWorld(sx, sy);
      const factor = Math.exp(-e.deltaY * 0.0015);
      this._state.cam.zoom = clamp(this._state.cam.zoom * factor, 0.3, 3);
      const [wx2, wy2] = this._toWorld(sx, sy);
      this._state.cam.x += wx - wx2;
      this._state.cam.y += wy - wy2;
    }, { passive: false });

    this.el.querySelectorAll('.cg-chip[data-mode]').forEach(chip => {
      chip.addEventListener('click', () => this.setMode(chip.dataset.mode));
    });
    this.el.querySelector('[data-cg="zoom-in"]').onclick = () => this._state.cam.zoom = clamp(this._state.cam.zoom * 1.2, 0.3, 3);
    this.el.querySelector('[data-cg="zoom-out"]').onclick = () => this._state.cam.zoom = clamp(this._state.cam.zoom / 1.2, 0.3, 3);
    this.el.querySelector('[data-cg="zoom-fit"]').onclick = () => this._fitCamera();

    this._onKeyDown = (e) => {
      // only respond to keys when our stage has focus or is hovered
      if (!this.el.contains(document.activeElement) && !this.el.matches(':hover')) return;
      if (e.key === '1') this.setMode('default');
      else if (e.key === '2') this.setMode('provenance');
      else if (e.key === '3') this.setMode('confidence');
      else if (e.key === 'f' || e.key === 'F') this._fitCamera();
      else if (e.key === 'Escape') {
        this._state.focus = null;
        this._updatePanel(null);
        this._dom.hudFocus.textContent = '—';
      }
    };
    document.addEventListener('keydown', this._onKeyDown);
  }

  // ---------- internal: layout & rendering ----------

  _resizeCanvas() {
    const s = this._state;
    const rect = this._dom.stage.getBoundingClientRect();
    s.W = Math.max(300, rect.width);
    s.H = Math.max(200, rect.height);
    s.DPR = window.devicePixelRatio || 1;
    const cvs = this._dom.canvas;
    cvs.width  = Math.floor(s.W * s.DPR);
    cvs.height = Math.floor(s.H * s.DPR);
    cvs.style.width  = s.W + 'px';
    cvs.style.height = s.H + 'px';
    this._ctx.setTransform(s.DPR, 0, 0, s.DPR, 0, 0);
  }

  _toScreen(x, y) {
    const s = this._state;
    return [(x - s.cam.x) * s.cam.zoom + s.W/2, (y - s.cam.y) * s.cam.zoom + s.H/2];
  }
  _toWorld(sx, sy) {
    const s = this._state;
    return [(sx - s.W/2) / s.cam.zoom + s.cam.x, (sy - s.H/2) / s.cam.zoom + s.cam.y];
  }

  _fitCamera() {
    const s = this._state;
    if (!s.nodes.length) return;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const n of s.nodes) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const pad = 80;
    const gw = (maxX - minX) + pad*2;
    const gh = (maxY - minY) + pad*2;
    const zx = s.W / gw, zy = s.H / gh;
    s.cam.zoom = Math.min(zx, zy, 1.1);
    s.cam.x = (minX + maxX)/2;
    s.cam.y = (minY + maxY)/2;
  }

  _step() {
    const s = this._state;
    const REPEL = 5500, SPRING = 0.01, REST = 110, DAMP = 0.86, GRAVITY = 0.004;
    const nodes = s.nodes, edges = s.edges;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i+1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx*dx + dy*dy;
        if (d2 < 36) d2 = 36;
        const d = Math.sqrt(d2);
        const f = REPEL / d2;
        const fx = (dx/d) * f, fy = (dy/d) * f;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }
    for (const e of edges) {
      const dx = e.t.x - e.s.x, dy = e.t.y - e.s.y;
      const d = Math.sqrt(dx*dx + dy*dy) || 1;
      const diff = d - REST;
      const k = SPRING * (0.5 + e.conf * 0.8);
      const fx = (dx/d) * diff * k, fy = (dy/d) * diff * k;
      e.s.vx += fx; e.s.vy += fy;
      e.t.vx -= fx; e.t.vy -= fy;
    }
    for (const n of nodes) {
      if (n.pinned) { n.vx = 0; n.vy = 0; continue; }
      n.vx += (400 - n.x) * GRAVITY;
      n.vy += (260 - n.y) * GRAVITY;
      n.vx *= DAMP; n.vy *= DAMP;
      n.x += n.vx; n.y += n.vy;
    }
  }

  _nodeRadius(n) { return 5 + Math.min(n.deg, 6) * 1.2; }

  // Resolve a CSS custom property declared on the root element (so the
  // component tracks cicrus tokens in whichever document it's mounted in).
  // Falls back to the supplied default for standalone usage without the
  // cicrus stylesheet. Cached per _draw() to avoid per-edge CSSOM hits.
  _readTheme() {
    const cs = getComputedStyle(this.el);
    const v = (name, fallback) => {
      const raw = cs.getPropertyValue(name).trim();
      return raw || fallback;
    };
    return {
      border: v('--border', '#2E2E2E'),
      borderVisible: v('--border-visible', '#555555'),
      textDisabled: v('--text-disabled', '#8F8F8F'),
      textSecondary: v('--text-secondary', '#B8B8B8'),
      textPrimary: v('--text-primary', '#E8E8E8'),
      textDisplay: v('--text-display', '#FFFFFF'),
      surface: v('--surface', '#111111'),
      surfaceRaised: v('--surface-raised', '#1A1A1A'),
      accent: v('--accent', '#D71921'),
      success: v('--success', '#4A9E5C'),
      warning: v('--warning', '#D4A843'),
      interactive: v('--interactive', '#5B9BF6'),
      fontBody: v('--font-body', 'ui-sans-serif, system-ui, sans-serif'),
    };
  }

  _edgeStyle(e, theme) {
    // Canonical buckets drive edge styling. Keep the three legacy aliases
    // (`contradict`, `refine`, `derive`) as synonyms so existing callers
    // that pre-date the canonical taxonomy still render correctly.
    const mode = this._state.mode;
    const t = e.type;
    const isContradict = t === 'contradicts' || t === 'contradict';
    const isIndirect   = t === 'indirectly-related' || t === 'refine';
    let color = theme.border, width = 1, dash = null;
    if (mode === 'default') {
      if (isContradict) { dash = [3, 3]; color = theme.accent; }
      else if (isIndirect) { width = 1.5; color = theme.borderVisible; }
      width *= (0.7 + e.conf * 1.2);
    } else if (mode === 'confidence') {
      // Confidence mode: low conf → faint edge, high conf → visible text color.
      // Blend between borderVisible and textPrimary in grayscale space so
      // dark and light modes both produce legible ramps.
      const tt = Math.max(0, Math.min(1, e.conf));
      const a = 0.25 + tt * 0.65;
      color = mixRgba(theme.borderVisible, theme.textPrimary, tt, a);
      width = 0.7 + tt * 2.5;
      if (isContradict) dash = [3, 3];
    } else if (mode === 'provenance') {
      color = RUN_COLORS[(e.s.run ?? 0) % RUN_COLORS.length];
      width = 0.7 + e.conf * 1.6;
      if (isContradict) dash = [3, 3];
    }
    return { color, width, dash };
  }

  _neighborSet(n) {
    const set = new Set([n.id]);
    for (const e of this._state.edges) {
      if (e.s === n) set.add(e.t.id);
      if (e.t === n) set.add(e.s.id);
    }
    return set;
  }

  _drawGrid(theme) {
    const ctx = this._ctx, s = this._state;
    const step = 40 * s.cam.zoom;
    const [wx, wy] = this._toWorld(0, 0);
    const offX = ((-wx * s.cam.zoom) % step + step) % step;
    const offY = ((-wy * s.cam.zoom) % step + step) % step;
    ctx.fillStyle = theme.border;
    for (let y = offY; y < s.H; y += step) {
      for (let x = offX; x < s.W; x += step) ctx.fillRect(x, y, 1, 1);
    }
  }

  _draw() {
    const ctx = this._ctx, s = this._state;
    const theme = this._readTheme();
    ctx.clearRect(0, 0, s.W, s.H);
    this._drawGrid(theme);

    const hl = s.focus ? this._neighborSet(s.focus) : null;

    // Sidebar filter dimming. Two sources:
    //   - filterKind pins nodes of that kind and the edges between them
    //   - filterEdgeType pins edges of that type and their endpoints
    // Non-matching content drops to alpha 0.12 (still visible as context
    // but clearly de-emphasised).
    const DIM = 0.12;
    const matchEdge = (e) => {
      if (s.filterEdgeType && (e.type || 'related') !== s.filterEdgeType) return false;
      if (s.filterKind) {
        const sk = e.s.kind || 'concept';
        const tk = e.t.kind || 'concept';
        if (sk !== s.filterKind && tk !== s.filterKind) return false;
      }
      return true;
    };
    const matchNode = (n) => {
      if (s.filterKind && (n.kind || 'concept') !== s.filterKind) return false;
      if (s.filterEdgeType) {
        let touched = false;
        for (const e of s.edges) {
          if ((e.type || 'related') === s.filterEdgeType && (e.s === n || e.t === n)) { touched = true; break; }
        }
        if (!touched) return false;
      }
      return true;
    };
    const hasFilter = !!(s.filterKind || s.filterEdgeType);

    for (const e of s.edges) {
      const [sx, sy] = this._toScreen(e.s.x, e.s.y);
      const [tx, ty] = this._toScreen(e.t.x, e.t.y);
      const style = this._edgeStyle(e, theme);
      // An active sidebar filter takes precedence over the focus-neighbor
      // dimming. Without this, a filter hit on a non-neighbor of the focus
      // node (e.g. "persons" who aren't direct neighbors of the default-
      // focused node) got stuck at 0.3 alpha from the focus pass and never
      // brightened. Filter intent is global; focus is contextual.
      let alpha = 1;
      if (hasFilter) {
        alpha = matchEdge(e) ? 1 : DIM;
      } else if (hl) {
        alpha = (hl.has(e.s.id) && hl.has(e.t.id)) ? 1 : 0.22;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = style.color;
      ctx.lineWidth = style.width;
      if (style.dash) ctx.setLineDash(style.dash); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      const mx = (sx + tx)/2, my = (sy + ty)/2;
      const dx = tx - sx, dy = ty - sy;
      const nx = -dy, ny = dx;
      const nlen = Math.sqrt(nx*nx + ny*ny) || 1;
      ctx.quadraticCurveTo(mx + (nx/nlen)*8, my + (ny/nlen)*8, tx, ty);
      ctx.stroke();
      ctx.restore();
    }

    for (const n of s.nodes) {
      const [x, y] = this._toScreen(n.x, n.y);
      const r = this._nodeRadius(n) * Math.sqrt(s.cam.zoom);
      let alpha = 1;
      if (hasFilter) {
        alpha = matchNode(n) ? 1 : DIM;
      } else if (hl && !hl.has(n.id)) {
        alpha = 0.3;
      }

      ctx.save();
      ctx.globalAlpha = alpha;

      const isFocus = s.focus === n;
      const isHover = s.hovered === n;
      let fill = theme.surface, stroke = theme.borderVisible, strokeW = 1, dash = null;
      // Stroke colour comes from the kind taxonomy so the graph at a
      // glance tells you what sort of nodes dominate (people vs concepts
      // vs artifacts). Legacy kinds (hypothesis/fact) kept as a thin
      // compat layer in case standalone callers still use them.
      const kind = n.kind || 'concept';
      const kindStroke = KIND_STROKE[kind];
      if (kindStroke) stroke = kindStroke === 'success' ? theme.success
                            : kindStroke === 'warning' ? theme.warning
                            : kindStroke === 'interactive' ? theme.interactive
                            : kindStroke === 'accent' ? theme.accent
                            : theme.borderVisible;
      if (kind === 'hypothesis') { dash = [2, 2]; stroke = theme.textDisabled; }
      if (kind === 'fact')       { fill = theme.textPrimary; stroke = theme.textPrimary; }
      if (s.mode === 'provenance') { stroke = RUN_COLORS[(n.run ?? 0) % RUN_COLORS.length]; strokeW = 1.5; }
      if (isFocus || isHover)      { stroke = theme.textDisplay; strokeW = 1.8; }

      ctx.fillStyle = fill;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = strokeW;
      if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (s.mode !== 'provenance') {
        ctx.setLineDash([]);
        ctx.fillStyle = RUN_COLORS[(n.run ?? 0) % RUN_COLORS.length];
        ctx.globalAlpha = alpha * 0.8;
        ctx.beginPath();
        ctx.arc(x + r*0.7, y - r*0.7, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      const showLabel = isFocus || isHover || n.deg >= 4;
      if (showLabel && n.label) {
        ctx.globalAlpha = alpha;
        ctx.font = (isFocus ? '500 ' : '300 ') + '11px ' + theme.fontBody;
        ctx.fillStyle = isFocus ? theme.textDisplay : theme.textSecondary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(n.label, x, y + r + 4);
      }
      ctx.restore();
    }
  }

  _hitNode(sx, sy) {
    const s = this._state;
    for (const n of s.nodes) {
      const [x, y] = this._toScreen(n.x, n.y);
      const r = this._nodeRadius(n) * Math.sqrt(s.cam.zoom) + 4;
      const dx = sx - x, dy = sy - y;
      if (dx*dx + dy*dy <= r*r) return n;
    }
    return null;
  }

  _startLoop() {
    const tick = () => {
      if (this._destroyed) return;
      this._step();
      this._draw();
      this._state.raf = requestAnimationFrame(tick);
    };
    tick();
  }
}

// ---------- helpers ----------

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---------- styles ----------

// ---------------------------------------------------------------------------
// Styling
//
// The component is styled against the Cicrus design-system tokens
// (see https://github.com/marcelolebre/cicrus / icarus/skills/cicrus-design).
// Every colour, font and radius maps to a CSS custom property declared on
// `<body>` so toggling `body.light` on the host document flips the whole
// graph — panel, sidebar and canvas — between dark and light mode.
//
// When consumed outside cicrus, the fallbacks after each `var(…, fallback)`
// kick in and reproduce the original dark-instrument palette so the
// component still works standalone.
// ---------------------------------------------------------------------------

const CG_CSS = `
.cg-root {
  /* Cicrus tokens with standalone fallbacks. */
  --cg-black:            var(--black, #000000);
  --cg-surface:          var(--surface, #111111);
  --cg-surface-raised:   var(--surface-raised, #1A1A1A);
  --cg-border:           var(--border, #2E2E2E);
  --cg-border-visible:   var(--border-visible, #555555);
  --cg-text-disabled:    var(--text-disabled, #8F8F8F);
  --cg-text-secondary:   var(--text-secondary, #B8B8B8);
  --cg-text-primary:     var(--text-primary, #E8E8E8);
  --cg-text-display:     var(--text-display, #FFFFFF);
  --cg-accent:           var(--accent, #D71921);
  --cg-success:          var(--success, #4A9E5C);
  --cg-warning:          var(--warning, #D4A843);
  --cg-interactive:      var(--interactive, #5B9BF6);
  --cg-font-body:        var(--font-body, 'Space Grotesk', system-ui, sans-serif);
  --cg-font-mono:        var(--font-mono, 'Space Mono', ui-monospace, Menlo, monospace);

  font-family: var(--cg-font-body);
  color: var(--cg-text-primary);
  background: var(--cg-black);
  border: 1px solid var(--cg-border);
  border-radius: 8px;
  overflow: hidden;
  display: grid;
  grid-template-rows: 40px 1fr;
  height: var(--cg-height, 620px);
  box-sizing: border-box;
  transition: background 250ms cubic-bezier(0.25, 0.1, 0.25, 1),
              border-color 250ms cubic-bezier(0.25, 0.1, 0.25, 1),
              color 250ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.cg-root * { box-sizing: border-box; }

/* ---------- top bar ---------- */
.cg-top {
  display: flex; align-items: center; gap: 14px; padding: 0 14px;
  border-bottom: 1px solid var(--cg-border); background: var(--cg-surface);
  font-size: 12px; color: var(--cg-text-disabled);
}
.cg-brand { display: flex; align-items: center; gap: 8px; color: var(--cg-text-primary); font-weight: 400; }
.cg-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--cg-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--cg-success) 15%, transparent);
}
.cg-sep { color: var(--cg-border-visible); }
.cg-path { font-family: var(--cg-font-mono); font-size: 11px; letter-spacing: 0.04em; }
.cg-spacer { flex: 1; }
.cg-chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--cg-border); border-radius: 999px; padding: 4px 10px;
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--cg-text-secondary); background: transparent; cursor: pointer;
  user-select: none; transition: border-color 150ms cubic-bezier(0.25, 0.1, 0.25, 1),
                                  color 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.cg-chip:hover { border-color: var(--cg-border-visible); color: var(--cg-text-primary); }
.cg-chip.on {
  border-color: var(--cg-text-secondary);
  color: var(--cg-text-display);
  background: var(--cg-surface-raised);
}
.cg-chip kbd {
  font-family: var(--cg-font-mono); font-size: 10px; color: var(--cg-text-disabled);
  background: var(--cg-black); border: 1px solid var(--cg-border); border-radius: 3px;
  padding: 0 4px; margin-left: 2px;
}

/* ---------- layout ---------- */
.cg-body { display: grid; grid-template-columns: 200px 1fr 320px; min-height: 0; }

/* ---------- left sidebar ---------- */
.cg-side {
  border-right: 1px solid var(--cg-border);
  padding: 12px 10px;
  overflow: auto;
  background: var(--cg-surface);
}
.cg-side h4 {
  font-family: var(--cg-font-mono);
  font-size: 10px; font-weight: 400; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--cg-text-disabled); margin: 12px 4px 8px;
}
.cg-side h4:first-child { margin-top: 2px; }
.cg-side-item {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 4px;
  color: var(--cg-text-secondary); font-size: 12px;
}
.cg-side-empty { color: var(--cg-text-disabled); font-size: 11px; padding: 4px 6px; }

/* Clickable filter rows: hover reveals the interactive ring, active
   row shows a subtle raised background + brighter text, and an accent
   bar on the left rail so the pinned filter reads at a glance. */
.cg-side-item.cg-filter {
  cursor: pointer;
  position: relative;
  transition: color 150ms cubic-bezier(0.25, 0.1, 0.25, 1),
              background 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.cg-side-item.cg-filter:hover { color: var(--cg-text-primary); background: var(--cg-surface-raised); }
.cg-side-item.cg-filter.active {
  color: var(--cg-text-display);
  background: var(--cg-surface-raised);
}
.cg-side-item.cg-filter.active::before {
  content: '';
  position: absolute;
  left: -10px; top: 4px; bottom: 4px;
  width: 2px;
  background: var(--cg-text-display);
  border-radius: 2px;
}
.cg-sq { width: 8px; height: 8px; border-radius: 2px; border: 1px solid var(--cg-border-visible); flex-shrink: 0; }
.cg-ln { width: 18px; height: 1px; background: var(--cg-border-visible); flex-shrink: 0; }
.cg-ln.dashed { background: none; border-top: 1px dashed var(--cg-border-visible); height: 0; }
.cg-ln.thick { height: 2px; background: var(--cg-text-primary); }
.cg-count {
  margin-left: auto; color: var(--cg-text-disabled);
  font-family: var(--cg-font-mono);
  font-variant-numeric: tabular-nums; font-size: 11px; letter-spacing: 0.04em;
}

/* ---------- canvas stage ---------- */
.cg-stage {
  position: relative;
  background: var(--cg-black);
  overflow: hidden;
}
.cg-stage canvas { display: block; width: 100%; height: 100%; }
.cg-hud {
  position: absolute; top: 10px; left: 12px;
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.08em; text-transform: lowercase;
  color: var(--cg-text-disabled); pointer-events: none;
}
.cg-hud b { color: var(--cg-text-secondary); font-weight: 400; }
.cg-zoom { position: absolute; bottom: 12px; left: 12px; display: flex; gap: 4px; }
.cg-zoom button {
  width: 26px; height: 26px; background: var(--cg-surface); border: 1px solid var(--cg-border);
  color: var(--cg-text-secondary); border-radius: 999px;
  cursor: pointer; font-size: 13px; line-height: 1; padding: 0;
  transition: border-color 150ms cubic-bezier(0.25, 0.1, 0.25, 1),
              color 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
}
.cg-zoom button[data-cg="zoom-fit"] {
  width: auto; padding: 0 10px;
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
}
.cg-zoom button:hover { border-color: var(--cg-border-visible); color: var(--cg-text-primary); }
.cg-tooltip {
  position: absolute; pointer-events: none;
  background: var(--cg-surface-raised); border: 1px solid var(--cg-border-visible);
  border-radius: 4px; padding: 6px 9px;
  font-size: 11px; color: var(--cg-text-primary); white-space: nowrap;
  display: none; z-index: 5;
}
.cg-tooltip .cg-k {
  font-family: var(--cg-font-mono); font-size: 10px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--cg-text-disabled); margin-right: 6px;
}

/* ---------- right panel ---------- */
.cg-panel {
  border-left: 1px solid var(--cg-border);
  background: var(--cg-surface);
  display: flex; flex-direction: column; min-height: 0;
}
.cg-panel-head { padding: 16px 16px 12px; border-bottom: 1px solid var(--cg-border); }
.cg-panel-crumbs {
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.08em; text-transform: lowercase;
  color: var(--cg-text-disabled); margin-bottom: 8px;
}
.cg-panel-sep { color: var(--cg-border-visible); margin: 0 5px; }
.cg-panel h2 {
  font-size: 18px; font-weight: 400;
  margin: 0 0 10px; letter-spacing: -0.01em;
  color: var(--cg-text-display);
}
.cg-panel-tags { display: flex; gap: 6px; flex-wrap: wrap; }

/* Cicrus badges: border-only pill, font-mono uppercase, category colour on
   text + border, transparent background. */
.cg-tag {
  font-family: var(--cg-font-mono);
  font-size: 10px; font-weight: 400;
  letter-spacing: 0.06em; text-transform: uppercase;
  padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--cg-border-visible);
  color: var(--cg-text-secondary);
  background: transparent;
}
.cg-tag.teal {
  color: var(--cg-success);
  border-color: color-mix(in srgb, var(--cg-success) 35%, transparent);
}
.cg-tag.amber {
  color: var(--cg-warning);
  border-color: color-mix(in srgb, var(--cg-warning) 35%, transparent);
}
.cg-tag.violet {
  color: var(--cg-interactive);
  border-color: color-mix(in srgb, var(--cg-interactive) 35%, transparent);
}
.cg-panel-body {
  padding: 16px; overflow: auto; flex: 1;
  font-size: 13px; line-height: 1.55; color: var(--cg-text-secondary);
}
.cg-panel-body p { margin: 0 0 12px; font-weight: 300; }
.cg-sec {
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--cg-text-disabled);
  margin: 20px 0 10px; font-weight: 400;
}
.cg-sec:first-child { margin-top: 4px; }
.cg-rel {
  display: flex; align-items: center; gap: 8px; padding: 8px 4px;
  border-bottom: 1px dashed var(--cg-border); font-size: 12px;
}
.cg-rel:last-child { border-bottom: 0; }
.cg-verb {
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--cg-text-secondary);
  padding: 3px 8px; border: 1px solid var(--cg-border-visible); border-radius: 999px;
  min-width: 96px; text-align: center;
  background: transparent;
}
.cg-verb.contradict {
  color: var(--cg-accent);
  border-color: color-mix(in srgb, var(--cg-accent) 35%, transparent);
}
.cg-verb.refine {
  color: var(--cg-success);
  border-color: color-mix(in srgb, var(--cg-success) 35%, transparent);
}
.cg-verb.derive {
  color: var(--cg-interactive);
  border-color: color-mix(in srgb, var(--cg-interactive) 35%, transparent);
}
.cg-target { color: var(--cg-text-primary); cursor: pointer; flex: 1; }
.cg-target:hover {
  text-decoration: underline;
  text-decoration-color: var(--cg-border-visible);
}
.cg-conf {
  font-family: var(--cg-font-mono); font-size: 10px; letter-spacing: 0.04em;
  color: var(--cg-text-disabled); font-variant-numeric: tabular-nums;
}
.cg-meta { display: grid; grid-template-columns: 90px 1fr; gap: 6px 10px; font-size: 12px; margin: 0; }
.cg-meta dt {
  font-family: var(--cg-font-mono);
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--cg-text-disabled);
}
.cg-meta dd {
  margin: 0; color: var(--cg-text-primary);
  font-family: var(--cg-font-mono); font-size: 11px; letter-spacing: 0.02em;
}

@media (max-width: 900px) {
  .cg-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
  .cg-side {
    max-height: 120px; border-right: 0;
    border-bottom: 1px solid var(--cg-border);
    display: flex; flex-wrap: wrap; gap: 10px;
  }
  .cg-side h4 { width: 100%; margin: 0; }
  .cg-panel {
    border-left: 0; border-top: 1px solid var(--cg-border);
    max-height: 260px;
  }
}
`;

export default ConceptGraph;
