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
        const conf   = r.confidence != null ? r.confidence : (r[3] != null ? r[3] : 0.5);
        const s_ = s.idToNode.get(source);
        const t_ = s.idToNode.get(target);
        if (!s_ || !t_) return null;
        return { s: s_, t: t_, type, conf };
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
    const counts = { derive: 0, refine: 0, contradict: 0 };
    for (const e of s.edges) if (counts[e.type] != null) counts[e.type]++;

    const runs = new Map();
    for (const n of s.nodes) runs.set(n.run ?? 0, (runs.get(n.run ?? 0) || 0) + 1);
    const runRows = [...runs.entries()].sort((a,b) => a[0]-b[0]).map(([run, cnt]) => {
      const color = RUN_COLORS[run % RUN_COLORS.length];
      return `<div class="cg-side-item"><span class="cg-sq" style="background:${color};border-color:${color};"></span><span>run.${String(run).padStart(4,'0')}</span><span class="cg-count">${String(cnt).padStart(2,'0')}</span></div>`;
    }).join('');

    const kinds = new Map();
    for (const n of s.nodes) kinds.set(n.kind || 'claim', (kinds.get(n.kind || 'claim') || 0) + 1);
    const kindRows = [...kinds.entries()].map(([kind, cnt]) => {
      const style = kind === 'hypothesis' ? 'border-style:dashed;' :
                    kind === 'fact'       ? 'background:#bababa;border-color:#bababa;' :
                                            'background:#1a1a1a;';
      return `<div class="cg-side-item"><span class="cg-sq" style="${style}"></span><span>${kind}</span><span class="cg-count">${String(cnt).padStart(2,'0')}</span></div>`;
    }).join('');

    this._dom.sidebar.innerHTML = `
      <h4>Relation</h4>
      <div class="cg-side-item"><span class="cg-ln"></span><span>derives-from</span><span class="cg-count">${String(counts.derive).padStart(2,'0')}</span></div>
      <div class="cg-side-item"><span class="cg-ln thick"></span><span>refines</span><span class="cg-count">${String(counts.refine).padStart(2,'0')}</span></div>
      <div class="cg-side-item"><span class="cg-ln dashed"></span><span>contradicts</span><span class="cg-count">${String(counts.contradict).padStart(2,'0')}</span></div>
      <h4>Agent run</h4>
      ${runRows || '<div class="cg-side-empty">—</div>'}
      <h4>Concept kind</h4>
      ${kindRows || '<div class="cg-side-empty">—</div>'}
    `;
  }

  _updatePanel(n) {
    if (!n) { this._dom.panel.innerHTML = ''; return; }
    const s = this._state;
    const rels = s.edges
      .filter(e => e.s === n || e.t === n)
      .map(e => {
        const outgoing = e.s === n;
        const other = outgoing ? e.t : e.s;
        const verb = e.type === 'derive' ? (outgoing ? 'derives' : 'derived-by')
                   : e.type === 'refine' ? (outgoing ? 'refines' : 'refined-by')
                                         : (outgoing ? 'contradicts' : 'contradicted-by');
        const cls = e.type === 'contradict' ? 'contradict' : e.type === 'refine' ? 'refine' : 'derive';
        return `<div class="cg-rel">
          <span class="cg-verb ${cls}">${escapeHtml(verb)}</span>
          <span class="cg-target" data-goto="${escapeAttr(other.id)}">${escapeHtml(other.label || other.id)}</span>
          <span class="cg-conf">${Math.round(e.conf * 100)}%</span>
        </div>`;
      }).join('');

    const kindClass = n.kind === 'claim' ? 'teal' : n.kind === 'hypothesis' ? 'amber' : 'violet';
    const runLabel = 'run.' + String(n.run ?? 0).padStart(4, '0');

    this._dom.panel.innerHTML = `
      <div class="cg-panel-head">
        <div class="cg-panel-crumbs">wiki <span class="cg-panel-sep">›</span> ${escapeHtml(n.id)}</div>
        <h2>${escapeHtml(n.label || n.id)}</h2>
        <div class="cg-panel-tags">
          <span class="cg-tag ${kindClass}">${escapeHtml(n.kind || 'claim')}</span>
          <span class="cg-tag">degree ${n.deg}</span>
          <span class="cg-tag violet">${escapeHtml(runLabel)}</span>
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
          <dt>kind</dt><dd>${escapeHtml(n.kind || 'claim')}</dd>
          <dt>run</dt><dd>${escapeHtml(runLabel)}</dd>
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
              `<div><span class="cg-k">kind</span>${escapeHtml(h.kind || 'claim')} <span class="cg-k" style="margin-left:8px;">run</span>run.${String(h.run ?? 0).padStart(4,'0')}</div>` +
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

  _edgeStyle(e) {
    const mode = this._state.mode;
    let color = '#2f2f2f', width = 1, dash = null;
    if (mode === 'default') {
      if (e.type === 'contradict') { dash = [3, 3]; color = '#3a2a2a'; }
      if (e.type === 'refine')     { width = 1.5; color = '#3a3a3a'; }
      width *= (0.7 + e.conf * 1.2);
    } else if (mode === 'confidence') {
      const g = Math.round(40 + e.conf * 160);
      color = `rgba(${g},${g},${g},${0.35 + e.conf*0.55})`;
      width = 0.7 + e.conf * 2.5;
      if (e.type === 'contradict') dash = [3, 3];
    } else if (mode === 'provenance') {
      color = RUN_COLORS[(e.s.run ?? 0) % RUN_COLORS.length];
      width = 0.7 + e.conf * 1.6;
      if (e.type === 'contradict') dash = [3, 3];
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

  _drawGrid() {
    const ctx = this._ctx, s = this._state;
    const step = 40 * s.cam.zoom;
    const [wx, wy] = this._toWorld(0, 0);
    const offX = ((-wx * s.cam.zoom) % step + step) % step;
    const offY = ((-wy * s.cam.zoom) % step + step) % step;
    ctx.fillStyle = '#141414';
    for (let y = offY; y < s.H; y += step) {
      for (let x = offX; x < s.W; x += step) ctx.fillRect(x, y, 1, 1);
    }
  }

  _draw() {
    const ctx = this._ctx, s = this._state;
    ctx.clearRect(0, 0, s.W, s.H);
    this._drawGrid();

    const hl = s.focus ? this._neighborSet(s.focus) : null;

    for (const e of s.edges) {
      const [sx, sy] = this._toScreen(e.s.x, e.s.y);
      const [tx, ty] = this._toScreen(e.t.x, e.t.y);
      const style = this._edgeStyle(e);
      let alpha = 1;
      if (hl) alpha = (hl.has(e.s.id) && hl.has(e.t.id)) ? 1 : 0.22;
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
      if (hl && !hl.has(n.id)) alpha = 0.3;

      ctx.save();
      ctx.globalAlpha = alpha;

      const isFocus = s.focus === n;
      const isHover = s.hovered === n;
      let fill = '#0f0f0f', stroke = '#4a4a4a', strokeW = 1, dash = null;
      const kind = n.kind || 'claim';
      if (kind === 'hypothesis') { dash = [2, 2]; stroke = '#6a6a6a'; }
      if (kind === 'fact')       { fill = '#e6e6e6'; stroke = '#e6e6e6'; }
      if (s.mode === 'provenance') { stroke = RUN_COLORS[(n.run ?? 0) % RUN_COLORS.length]; strokeW = 1.5; }
      if (isFocus || isHover)      { stroke = '#ffffff'; strokeW = 1.8; }

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
        ctx.font = (isFocus ? '600 ' : '') + '11px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = isFocus ? '#fff' : '#bababa';
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

const CG_CSS = `
.cg-root {
  font-family: ui-sans-serif, -apple-system, "Inter", system-ui, sans-serif;
  color: #e6e6e6;
  background: #0a0a0a;
  border: 1px solid #1e1e1e;
  border-radius: 10px;
  overflow: hidden;
  display: grid;
  grid-template-rows: 40px 1fr;
  height: var(--cg-height, 620px);
  box-sizing: border-box;
}
.cg-root * { box-sizing: border-box; }
.cg-top {
  display: flex; align-items: center; gap: 14px; padding: 0 14px;
  border-bottom: 1px solid #1e1e1e; background: #0c0c0c;
  font-size: 12px; color: #9a9a9a;
}
.cg-brand { display: flex; align-items: center; gap: 8px; color: #e6e6e6; font-weight: 500; }
.cg-dot { width: 6px; height: 6px; border-radius: 50%; background: #5eead4; box-shadow: 0 0 0 3px rgba(94,234,212,0.1); }
.cg-sep { color: #3a3a3a; }
.cg-path { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
.cg-spacer { flex: 1; }
.cg-chip {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid #1e1e1e; border-radius: 6px; padding: 4px 8px;
  font-size: 11px; color: #bababa; background: #111; cursor: pointer;
  user-select: none; transition: border-color 120ms, color 120ms;
}
.cg-chip:hover { border-color: #2e2e2e; color: #fff; }
.cg-chip.on { border-color: #3d3d3d; color: #fff; background: #161616; }
.cg-chip kbd {
  font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #6a6a6a;
  background: #0a0a0a; border: 1px solid #242424; border-radius: 3px; padding: 0 4px; margin-left: 2px;
}
.cg-body { display: grid; grid-template-columns: 200px 1fr 320px; min-height: 0; }
.cg-side {
  border-right: 1px solid #1e1e1e; padding: 12px 10px; font-size: 12px; overflow: auto; background: #0a0a0a;
}
.cg-side h4 {
  font-size: 10px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase;
  color: #6a6a6a; margin: 10px 4px 6px;
}
.cg-side h4:first-child { margin-top: 2px; }
.cg-side-item {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 5px;
  color: #bababa; font-size: 12px;
}
.cg-side-empty { color: #5a5a5a; font-size: 11px; padding: 4px 6px; }
.cg-sq { width: 8px; height: 8px; border-radius: 2px; border: 1px solid #3a3a3a; flex-shrink: 0; }
.cg-ln { width: 18px; height: 1px; background: #3a3a3a; flex-shrink: 0; }
.cg-ln.dashed { background: none; border-top: 1px dashed #3a3a3a; height: 0; }
.cg-ln.thick { height: 2px; background: #bababa; }
.cg-count { margin-left: auto; color: #5a5a5a; font-variant-numeric: tabular-nums; font-size: 11px; }
.cg-stage {
  position: relative; background: radial-gradient(circle at center, #0d0d0d 0%, #070707 100%); overflow: hidden;
}
.cg-stage canvas { display: block; width: 100%; height: 100%; }
.cg-hud {
  position: absolute; top: 10px; left: 12px; font-size: 11px; color: #6a6a6a;
  font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.04em; pointer-events: none;
}
.cg-hud b { color: #bababa; font-weight: 500; }
.cg-zoom { position: absolute; bottom: 10px; left: 12px; display: flex; gap: 4px; }
.cg-zoom button {
  width: 26px; height: 26px; background: #111; border: 1px solid #1e1e1e; color: #bababa;
  border-radius: 5px; cursor: pointer; font-size: 13px; line-height: 1; padding: 0;
}
.cg-zoom button[data-cg="zoom-fit"] { width: auto; padding: 0 8px; font-size: 11px; }
.cg-zoom button:hover { border-color: #2e2e2e; color: #fff; }
.cg-tooltip {
  position: absolute; pointer-events: none; background: #0f0f0f; border: 1px solid #2a2a2a;
  border-radius: 6px; padding: 6px 9px; font-size: 11px; color: #e6e6e6; white-space: nowrap;
  box-shadow: 0 4px 12px rgba(0,0,0,0.6); display: none; z-index: 5;
}
.cg-tooltip .cg-k { color: #6a6a6a; margin-right: 4px; }
.cg-panel {
  border-left: 1px solid #1e1e1e; background: #0c0c0c; display: flex; flex-direction: column; min-height: 0;
}
.cg-panel-head { padding: 14px 16px 12px; border-bottom: 1px solid #1e1e1e; }
.cg-panel-crumbs { font-size: 11px; color: #6a6a6a; font-family: ui-monospace, Menlo, monospace; margin-bottom: 8px; }
.cg-panel-sep { color: #3a3a3a; margin: 0 5px; }
.cg-panel h2 { font-size: 17px; font-weight: 500; margin: 0 0 6px; letter-spacing: -0.01em; color: #fff; }
.cg-panel-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.cg-tag {
  font-size: 10px; padding: 2px 7px; border-radius: 10px; border: 1px solid #242424;
  color: #9a9a9a; letter-spacing: 0.02em;
}
.cg-tag.teal { color: #5eead4; border-color: rgba(94,234,212,0.25); }
.cg-tag.amber { color: #fbbf24; border-color: rgba(251,191,36,0.25); }
.cg-tag.violet { color: #a78bfa; border-color: rgba(167,139,250,0.3); }
.cg-panel-body { padding: 14px 16px; overflow: auto; flex: 1; font-size: 13px; line-height: 1.55; color: #bababa; }
.cg-panel-body p { margin: 0 0 12px; }
.cg-sec {
  font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #6a6a6a;
  margin: 16px 0 8px; font-weight: 500;
}
.cg-sec:first-child { margin-top: 4px; }
.cg-rel {
  display: flex; align-items: center; gap: 8px; padding: 6px 4px;
  border-bottom: 1px dashed #1a1a1a; font-size: 12px;
}
.cg-rel:last-child { border-bottom: 0; }
.cg-verb {
  font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #6a6a6a;
  padding: 1px 5px; border: 1px solid #242424; border-radius: 3px;
  letter-spacing: 0.04em; min-width: 90px; text-align: center;
}
.cg-verb.contradict { color: #f87171; border-color: rgba(248,113,113,0.3); }
.cg-verb.refine     { color: #5eead4; border-color: rgba(94,234,212,0.3); }
.cg-verb.derive     { color: #a78bfa; border-color: rgba(167,139,250,0.3); }
.cg-target { color: #e6e6e6; cursor: pointer; flex: 1; }
.cg-target:hover { text-decoration: underline; text-decoration-color: #3a3a3a; }
.cg-conf { font-family: ui-monospace, Menlo, monospace; font-size: 10px; color: #6a6a6a; font-variant-numeric: tabular-nums; }
.cg-meta { display: grid; grid-template-columns: 90px 1fr; gap: 6px 10px; font-size: 12px; margin: 0; }
.cg-meta dt { color: #6a6a6a; }
.cg-meta dd { margin: 0; color: #e6e6e6; font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
@media (max-width: 900px) {
  .cg-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
  .cg-side { max-height: 120px; border-right: 0; border-bottom: 1px solid #1e1e1e; display: flex; flex-wrap: wrap; gap: 10px; }
  .cg-side h4 { width: 100%; margin: 0; }
  .cg-panel { border-left: 0; border-top: 1px solid #1e1e1e; max-height: 260px; }
}
`;

export default ConceptGraph;
