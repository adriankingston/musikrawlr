// musikrawlr — search MusicBrainz artists, grow a band↔musician graph.
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = {
    q: $('#q'), results: $('#results'), panel: $('#panel'), empty: $('#empty'),
    legend: $('#legend'), status: $('#status'), tip: $('#tip'), stage: $('#stage'),
    fit: $('#fit'), clear: $('#clear'), glow: $('#glow'),
    credit: $('#credit'), timebar: $('#timebar'), tbPlay: $('#tb-play'),
    relfilter: $('#relfilter'), relList: $('#rel-list'), relState: $('#rel-state'),
    degrees: $('#degrees'), degA: $('#deg-a'), degB: $('#deg-b'),
    degState: $('#deg-state'), degResult: $('#deg-result'),
    tbYear: $('#hud-year'), tbRange: $('#tb-range'), tbHist: $('#tb-hist'), tbAll: $('#tb-all'),
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const PANEL_EMPTY = el.panel.innerHTML;

  // ---------- API ----------
  async function api(path) {
    const r = await fetch(path);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const d = await r.json(); if (d.error) msg = d.error; } catch { /* not json */ }
      throw new Error(msg);
    }
    return r.json();
  }

  // ---------- Graph style ----------
  // Relationship type → visual class. Everything else renders as a faint "other".
  const REL_CLASS = {
    'member of band': 'member',
    'subgroup': 'member',
    'parent': 'family',
    'sibling': 'family',
    'married': 'family',
    'involved with': 'family',
    'is person': 'family',
    'collaboration': 'collab',
    'founder': 'collab',
    'supporting musician': 'collab',
    'instrumental supporting musician': 'collab',
    'vocal supporting musician': 'collab',
    'conductor position': 'collab',
    'artistic director': 'collab',
    'composer-in-residence': 'collab',
    'teacher': 'collab',
  };

  // Each expanded BAND claims the next hue; its membership edges inherit it,
  // so scenes read as colour fields and shared musicians become the seams.
  const HUB_HUES = ['#e8537a', '#f2a03d', '#4cd97b', '#2ee6c8', '#4aa8ff', '#8f7bff', '#c85cff', '#ff7ab6', '#9adf4e', '#ffd166'];
  let hueCounter = 0;

  const PAL = {
    leaf: '#aac0ca', personHub: '#ffd166',
    label: '#e5edf0', outline: '#111d22',
    member: '#7e97a2', family: '#ff8fa3', collab: '#2ee6c8', other: '#445b64',
    loading: '#2ee6c8',
  };
  const pal = () => PAL;

  // Short display names for the wordier MusicBrainz relationship types.
  const TYPE_SHORT = {
    'member of band': 'member',
    'supporting musician': 'supporting',
    'instrumental supporting musician': 'supporting (instr.)',
    'vocal supporting musician': 'supporting (vocals)',
    'is person': 'same person',
  };

  function hueOf(n) {
    const i = n.data('hueIdx');
    if (i == null) return null;
    return HUB_HUES[i % HUB_HUES.length];
  }

  function nodeColor(n) {
    const p = pal();
    return hueOf(n) || (n.hasClass('expanded') ? p.personHub : p.leaf);
  }

  function mixHex(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const ch = (sa, sb) => Math.round(sa + (sb - sa) * t);
    const r = ch((pa >> 16) & 255, (pb >> 16) & 255);
    const g = ch((pa >> 8) & 255, (pb >> 8) & 255);
    const bl = ch(pa & 255, pb & 255);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  // Glow colour: hubs pool light in their own hue (nudged toward white so it
  // reads as light, not paint); leaves glow starlight blue-white.
  function glowColor(n) {
    const hue = hueOf(n) || (n.hasClass('expanded') ? PAL.personHub : null);
    return hue ? mixHex(hue, '#ffffff', 0.3) : '#dcecff';
  }

  // Years served, so the people who WERE the band stand out from the dozens
  // who passed through. Unlike edgeWindow (which borrows the band's whole
  // life-span so undated members still show on the timeline), this counts
  // ONLY recorded dates — otherwise every undated member ties with the
  // founder. An unknown start means unknown tenure, not a long one.
  function tenureOf(ed) {
    const d = ed.data();
    if (d.by == null) return 0;
    let end = d.ey;
    if (end == null) {
      // Still a member: runs to the band's end, or to now if it's going.
      const bandEnd = ed.target().data('lsEy');
      end = d.ended ? bandEnd : (bandEnd ?? NOW_YEAR);
    }
    return end == null ? 0 : Math.max(0, end - d.by);
  }

  const bandSpan = (band) => {
    const by = band.data('lsBy');
    if (by == null) return null;
    return Math.max(1, (band.data('lsEy') ?? NOW_YEAR) - by);
  };

  // How central someone was to a band, 0–1. Share of the band's own lifetime
  // leads, because absolute years don't compare across bands: Kurt Cobain was
  // 100% of Nirvana's seven years, and shouldn't read smaller than a mid-tier
  // member of a band that ran for forty. Absolute length still counts for
  // something, so a 42-year run outranks a 3-year band's founder.
  function edgeProminence(ed) {
    const yrs = tenureOf(ed);
    const span = bandSpan(ed.target());
    const cover = span ? Math.min(1, yrs / span) : 0;
    return cover * 0.7 + (Math.min(yrs, 45) / 45) * 0.3;
  }

  function computeProminence() {
    cy.edges('[cls="member"]').forEach((ed) => {
      ed.data('tenure', tenureOf(ed));
      ed.data('eprom', edgeProminence(ed));
    });
    cy.nodes().forEach((n) => {
      const eds = n.connectedEdges('[cls="member"]');
      let base = 0;
      let original = false;
      const stints = new Map();
      eds.forEach((ed) => {
        base = Math.max(base, ed.data('eprom') || 0);
        if ((ed.data('attrs') || '').includes('original')) original = true;
        const other = ed.source().id() === n.id() ? ed.target().id() : ed.source().id();
        stints.set(other, (stints.get(other) || 0) + 1);
      });
      // Left and came back: Karl Burns rejoined The Fall repeatedly — that
      // churn is itself a sign of being central to the band.
      const rejoins = Math.max(0, Math.max(0, ...stints.values()) - 1);
      // Fame only ever ADDS. Someone with no Wikipedia entry must never be
      // pushed below a famous blow-in, and coverage is thin for independent
      // and non-Anglophone scenes.
      const fame = (Math.min(n.data('fame') || 0, 25) / 25) * 0.35;
      n.data('prom', Math.min(1, base + (original ? 0.08 : 0) + Math.min(rejoins * 0.06, 0.12) + fame));
    });
  }

  function nodeSize(n) {
    const deg = n.data('deg') || 0;
    if (n.hasClass('expanded')) return Math.min(34 + deg * 2.4, 64);
    return Math.min(14 + deg * 2 + (n.data('prom') || 0) * 24, 40);
  }

  // Gentle per-edge arc (deterministic from the id) — organic, not spokes.
  function edgeArc(e) {
    let h = 0;
    const id = e.id();
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    const mag = 16 + (Math.abs(h) % 3) * 9;
    return (h % 2 ? mag : -mag);
  }

  function edgeColor(e) {
    const p = pal();
    if (e.data('cls') !== 'member') return null;
    const t = cy.getElementById(e.data('target'));
    const s = cy.getElementById(e.data('source'));
    return hueOf(t) || hueOf(s) || p.member;
  }

  function cyStyle() {
    const p = pal();
    return [
      { selector: 'node', style: {
        width: nodeSize,
        height: nodeSize,
        'background-color': nodeColor,
        label: 'data(label)',
        'font-size': (n) => (n.hasClass('expanded') ? 14 : 11),
        'font-family': 'Quantico, system-ui, sans-serif',
        color: p.label,
        'text-valign': 'bottom',
        'text-margin-y': 7,
        'text-wrap': 'wrap',
        'text-max-width': 130,
        'text-opacity': 0.72,
        'border-width': 0,
        'overlay-opacity': 0,
      } },
      // Everything is named; the important nodes just read louder.
      { selector: 'node.expanded, node.notable, node.hover, node.seed, node:selected', style: {
        'text-opacity': 1,
      } },
      { selector: 'node.loading', style: {
        'border-width': 3, 'border-style': 'dashed', 'border-color': p.loading, 'border-opacity': 1,
      } },
      { selector: 'edge', style: {
        'curve-style': 'unbundled-bezier',
        'control-point-distances': edgeArc,
        'control-point-weights': 0.5,
        width: 1.1,
        'line-color': p.other,
        'line-opacity': 0.45,
        'line-style': 'dashed',
        label: 'data(tlabel)',
        'font-size': 8.5,
        'font-family': 'Quantico, system-ui, sans-serif',
        color: p.label,
        'text-opacity': 0,
        'overlay-opacity': 0,
      } },
      { selector: 'edge[cls="member"]', style: {
        width: 'mapData(eprom, 0, 1, 1.2, 4.2)',
        'line-style': 'solid',
        'line-color': edgeColor,
        'line-opacity': 0.6,
      } },
      { selector: 'edge[cls="family"]', style: {
        width: 1.6, 'line-style': 'dotted', 'line-color': p.family, 'line-opacity': 0.8,
      } },
      { selector: 'edge[cls="collab"]', style: {
        width: 1.4, 'line-style': 'dashed', 'line-color': p.collab, 'line-opacity': 0.55,
      } },
      // Non-membership relationships are rare and ambiguous — name them
      // permanently (member edges reveal theirs on hover/selection).
      { selector: 'edge[cls != "member"]', style: { 'text-opacity': 0.85 } },
      // Highlighted: edges of the hovered/selected node — labels appear here.
      { selector: 'edge.hl, edge:selected', style: {
        'line-opacity': 1, width: 2.4, 'text-opacity': 1,
      } },
      // Time-scrub mode (last, so it wins): inactive elements recede,
      // undated relationships ghost rather than pretend to a date.
      { selector: 'node.t-dim', style: { opacity: 0.12 } },
      { selector: 'edge.t-dim', style: { 'line-opacity': 0.05, 'text-opacity': 0 } },
      { selector: 'edge.t-ghost', style: { 'line-opacity': 0.13, 'text-opacity': 0 } },
      // :selected outranks plain classes in cytoscape's specificity, so pin
      // the time-dim down for selected elements too (kept faintly visible).
      { selector: 'node.t-dim:selected', style: { opacity: 0.25 } },
      { selector: 'edge.t-dim:selected', style: { 'line-opacity': 0.15 } },
      // Filtered out by relationship type — gone entirely, not just dimmed.
      { selector: '.f-off', style: { display: 'none' } },
      // The route between two artists, once you've found it.
      { selector: 'node.on-path', style: {
        'border-width': 3, 'border-color': '#ffffff', 'border-opacity': 1, 'text-opacity': 1,
      } },
      { selector: 'edge.on-path', style: {
        'line-color': '#ffffff', 'line-opacity': 1, width: 3, 'text-opacity': 1,
      } },
    ];
  }

  const cy = cytoscape({
    container: $('#cy'),
    style: cyStyle(),
    wheelSensitivity: 0.25,
    minZoom: 0.12,
    maxZoom: 3,
  });
  window.cy = cy; // console access for debugging

  // The pane/container can be 0×0 at init or change size later — keep
  // cytoscape's cached viewport dimensions honest or fit() breaks silently.
  new ResizeObserver(() => {
    cy.resize();
    queueGlow();
    if (!el.timebar.hidden) drawHist();
  }).observe($('#cy'));

  // ---------- Ambient glow layer ----------
  // A canvas UNDER the graph: every node pools light with a wide, eased
  // radial falloff, blended additively so neighbouring glows merge into
  // nebulae. Redrawn (rAF-throttled) after every cytoscape render frame.
  const glowCtx = el.glow.getContext('2d');
  let glowQueued = false;

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  function drawGlow() {
    glowQueued = false;
    const w = el.stage.clientWidth;
    const h = el.stage.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.glow.width !== Math.round(w * dpr) || el.glow.height !== Math.round(h * dpr)) {
      el.glow.width = Math.round(w * dpr);
      el.glow.height = Math.round(h * dpr);
    }
    glowCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glowCtx.clearRect(0, 0, w, h);
    glowCtx.globalCompositeOperation = 'lighter';
    const zoom = cy.zoom();
    cy.nodes().forEach((n) => {
      if (!n.visible()) return;
      const pos = n.renderedPosition();
      const r0 = (nodeSize(n) * zoom) / 2;
      const R = Math.min(340, Math.max(34, r0 * (n.hasClass('expanded') ? 8 : 6)));
      if (pos.x < -R || pos.y < -R || pos.x > w + R || pos.y > h + R) return;
      // 35% bright at the very centre, easing out through a smooth
      // exponential-ish ramp (enough stops that no banding shows).
      let a = 0.35;
      if (n.selected()) a = 0.6;
      if (n.hasClass('on-path')) a = Math.max(a, 0.72); // the found route burns brighter
      if (n.hasClass('t-dim')) a *= 0.08;
      const [cr, cg, cb] = hexToRgb(glowColor(n));
      const g = glowCtx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, R);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      g.addColorStop(0.1, `rgba(${cr},${cg},${cb},${a * 0.72})`);
      g.addColorStop(0.22, `rgba(${cr},${cg},${cb},${a * 0.46})`);
      g.addColorStop(0.36, `rgba(${cr},${cg},${cb},${a * 0.27})`);
      g.addColorStop(0.52, `rgba(${cr},${cg},${cb},${a * 0.14})`);
      g.addColorStop(0.72, `rgba(${cr},${cg},${cb},${a * 0.055})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      glowCtx.fillStyle = g;
      glowCtx.fillRect(pos.x - R, pos.y - R, R * 2, R * 2);
    });
    glowCtx.globalCompositeOperation = 'source-over';
  }

  function queueGlow() {
    if (glowQueued) return;
    glowQueued = true;
    requestAnimationFrame(drawGlow);
  }
  cy.on('render', queueGlow);

  // ---------- Graph building ----------
  const expanded = new Set();
  const loading = new Set();

  const kindOf = (t) => (t ? (t === 'Person' ? 'person' : 'group') : 'unknown');

  const yr = (s) => { const m = /^(\d{4})/.exec(s || ''); return m ? +m[1] : null; };

  function fmtYears(r) {
    const b = (r.begin || '').slice(0, 4);
    const e = (r.end || '').slice(0, 4);
    if (b && !e) return r.ended ? b + '–?' : b + '–';
    if (b && e) return b === e ? b : `${b}–${e}`;
    if (e) return '–' + e;
    return '';
  }

  function ensureNode(a, opts = {}) {
    const ex = cy.getElementById(a.id);
    if (ex.nonempty()) {
      if (ex.data('kind') === 'unknown' && a.type) ex.data('kind', kindOf(a.type));
      return ex;
    }
    const def = {
      group: 'nodes',
      data: {
        id: a.id, name: a.name, label: a.name,
        kind: kindOf(a.type), disambiguation: a.disambiguation || '', deg: 0,
      },
    };
    if (opts.position) def.position = opts.position;
    if (opts.renderedPosition) def.renderedPosition = opts.renderedPosition;
    return cy.add(def);
  }

  function addArtist(a) {
    const node = ensureNode(a);
    node.data('full', a);
    const ls = a['life-span'] || {};
    node.data('lsBy', yr(ls.begin));
    node.data('lsEy', yr(ls.end));
    if (a.type) node.data('kind', kindOf(a.type));
    if (a.disambiguation) node.data('disambiguation', a.disambiguation);
    node.addClass('expanded');
    // Expanded bands claim the next hue; their member edges pick it up
    // automatically (edge colour is resolved per-render from the endpoints).
    if (node.data('kind') === 'group' && node.data('hueIdx') == null) {
      node.data('hueIdx', hueCounter++);
    }
    const pos = node.position();
    let added = 0;
    const rels = (a.relations || []).filter((r) => r.artist && r.artist.id !== a.id);
    // New neighbours spawn evenly on a circle around their anchor, so the
    // layout starts untangled and unfolds locally instead of from a pile.
    const newCount = rels.filter((r) => cy.getElementById(r.artist.id).empty()).length || 1;
    // Size the ring to the crowd: a fixed radius piles 51 Fall members on top
    // of each other and the layout never fully digs them apart. Each node
    // needs ~95px of arc for its label, so grow the circle to suit.
    const ring = Math.max(200, (newCount * 95) / (2 * Math.PI));
    let newIdx = 0;
    for (const r of rels) {
      if (cy.getElementById(r.artist.id).empty()) {
        const ang = (newIdx++ / newCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
        ensureNode(r.artist, {
          position: { x: pos.x + Math.cos(ang) * ring, y: pos.y + Math.sin(ang) * ring },
        });
      } else {
        ensureNode(r.artist); // may upgrade an unknown node's kind
      }
      const [src, tgt] = r.direction === 'backward' ? [r.artist.id, a.id] : [a.id, r.artist.id];
      if (r.type === 'member of band') {
        // The membership edge itself tells us who's the person and who's the band.
        const s = cy.getElementById(src);
        const t = cy.getElementById(tgt);
        if (s.data('kind') === 'unknown') s.data('kind', 'person');
        if (t.data('kind') === 'unknown') t.data('kind', 'group');
      }
      const key = `${src}|${tgt}|${r.type}|${r.begin || ''}`;
      if (cy.getElementById(key).nonempty()) continue;
      const yearsTxt = fmtYears(r);
      const short = TYPE_SHORT[r.type] || r.type;
      cy.add({ group: 'edges', data: {
        id: key, source: src, target: tgt,
        cls: REL_CLASS[r.type] || 'other', type: r.type,
        years: yearsTxt, attrs: (r.attributes || []).join(', '),
        tlabel: yearsTxt ? `${short} · ${yearsTxt}` : short,
        by: yr(r.begin), ey: yr(r.end), ended: !!r.ended,
      } });
      added++;
    }
    graphChanged();
    return added;
  }

  // Shared refresh after any structural change: degree-driven sizing,
  // bridge labels, filters, overlays/timeline, and a fresh layout pass.
  function graphChanged() {
    cy.nodes().forEach((n) => {
      n.data('deg', Math.min(n.degree(false), 12));
      // Musicians linked into 3+ things are the bridges — label them.
      n.toggleClass('notable', n.data('kind') === 'person' && n.degree(false) >= 3);
    });
    computeProminence();
    refreshDegrees();
    queueFame();
    applyRelFilter();
    renderRelFilter();
    updateOverlays();
    runLayout();
  }

  // ---------- Relationship-type filter ----------
  // Some relationships swamp everything else — Nirvana pulls in dozens of
  // tribute acts — so each type can be switched off. Hiding a type also
  // hides any node left with nothing visible attaching it to the graph.
  const hiddenTypes = new Set();

  function applyRelFilter() {
    cy.batch(() => {
      cy.edges().forEach((ed) => ed.toggleClass('f-off', hiddenTypes.has(ed.data('type'))));
      cy.nodes().forEach((n) => {
        const keep = n.hasClass('expanded') || n.hasClass('seed')
          || n.connectedEdges().some((ed) => !ed.hasClass('f-off'));
        n.toggleClass('f-off', !keep);
      });
    });
  }

  function renderRelFilter() {
    const counts = new Map();
    cy.edges().forEach((ed) => {
      const t = ed.data('type');
      counts.set(t, (counts.get(t) || 0) + 1);
    });
    el.relfilter.hidden = counts.size === 0;
    if (!counts.size) return;
    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    el.relList.innerHTML = rows.map(([type, n]) => {
      const off = hiddenTypes.has(type);
      return `<label class="rel-row${off ? ' off' : ''}">`
        + `<input type="checkbox" data-rel="${esc(type)}"${off ? '' : ' checked'}>`
        + `<i class="line line-${REL_CLASS[type] || 'other'}"></i>`
        + `<span class="rel-name">${esc(TYPE_SHORT[type] || type)}</span>`
        + `<span class="rel-count">${n}</span></label>`;
    }).join('');
    const off = rows.filter(([t]) => hiddenTypes.has(t)).length;
    el.relState.textContent = off ? `${rows.length - off}/${rows.length}` : '';
  }

  el.relList.addEventListener('change', (e) => {
    const cb = e.target.closest('[data-rel]');
    if (!cb) return;
    if (cb.checked) hiddenTypes.delete(cb.dataset.rel);
    else hiddenTypes.add(cb.dataset.rel);
    applyRelFilter();
    renderRelFilter();
    runLayout();
  });

  // ---------- Six degrees ----------
  // How many hops separate two artists on the canvas. The route is computed
  // over what you've actually uncovered, so "no route yet" is the game: keep
  // expanding until the two halves meet.
  let degPrev = null; // last known distance, to notice the moment it connects
  let degUserPicked = false; // once you choose ends yourself, we stop retargeting

  function optionsFor(sel, keep) {
    const nodes = cy.nodes(':visible').sort((a, b) =>
      a.data('name').localeCompare(b.data('name')));
    sel.innerHTML = nodes.map((n) =>
      `<option value="${n.id()}">${esc(n.data('name'))}</option>`).join('');
    if (keep && sel.querySelector(`option[value="${keep}"]`)) sel.value = keep;
    return nodes;
  }

  function refreshDegrees() {
    const nodes = cy.nodes(':visible');
    el.degrees.hidden = nodes.length < 2;
    if (el.degrees.hidden) {
      cy.elements().removeClass('on-path');
      el.degState.textContent = '';
      degPrev = null;
      return;
    }
    let a = el.degA.value;
    let b = el.degB.value;
    // Until you choose your own ends, the game tracks what you've opened:
    // first hub against the most recent one. `expanded` is a Set, so it
    // already remembers the order you opened them in.
    if (!degUserPicked) {
      const hubs = [...expanded].filter((id) => cy.getElementById(id).nonempty());
      if (hubs.length > 1) {
        a = hubs[0];
        b = hubs[hubs.length - 1];
      } else {
        a = a || nodes[0].id();
        b = b || nodes[nodes.length - 1].id();
      }
    }
    optionsFor(el.degA, a);
    optionsFor(el.degB, b);
    computeDegrees({ announce: true });
  }

  function computeDegrees(opts = {}) {
    cy.elements().removeClass('on-path');
    const a = cy.getElementById(el.degA.value);
    const b = cy.getElementById(el.degB.value);
    if (a.empty() || b.empty() || a.id() === b.id()) {
      el.degState.textContent = '';
      el.degResult.innerHTML = '<span class="pe-hint">Pick two different artists.</span>';
      degPrev = null;
      return;
    }
    const dij = cy.elements(':visible').dijkstra({ root: a, weight: () => 1, directed: false });
    const dist = dij.distanceTo(b);

    if (!Number.isFinite(dist)) {
      el.degState.textContent = 'no route';
      el.degResult.innerHTML = '<span class="pe-hint">No route yet — expand members and'
        + ' bands until the two sides meet.</span>';
      degPrev = Infinity;
      return;
    }

    const path = dij.pathTo(b);
    path.addClass('on-path');
    const hops = path.nodes();
    el.degState.textContent = `${dist} step${dist === 1 ? '' : 's'}`;
    const chain = hops.map((n, i) =>
      (i ? '<span class="deg-sep"> → </span>' : '')
      + `<button data-goto="${n.id()}">${esc(n.data('name'))}</button>`).join('');
    el.degResult.innerHTML = `<span class="deg-hit">${dist} step${dist === 1 ? '' : 's'}</span>`
      + ` apart<div class="deg-chain">${chain}</div>`;

    // Celebrate only when the GRAPH closed the gap. Switching the dropdown
    // from an unconnected pair to a connected one isn't a discovery.
    if (opts.announce && degPrev === Infinity) {
      const via = hops.slice(1, -1).map((n) => n.data('name')).join(' → ');
      setStatus(`Connected in ${dist} steps${via ? ` · via ${via}` : ''}`, false, 6000);
      queueGlow();
    }
    degPrev = dist;
  }

  const degPick = () => { degUserPicked = true; degPrev = null; computeDegrees(); };
  el.degA.addEventListener('change', degPick);
  el.degB.addEventListener('change', degPick);
  el.degResult.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goto]');
    if (!b) return;
    const n = cy.getElementById(b.dataset.goto);
    if (n.nonempty()) {
      cy.$(':selected').unselect();
      n.select();
      cy.animate({ center: { eles: n } }, { duration: 250 });
    }
  });

  // ---------- Fame (Wikidata sitelinks), batched ----------
  // One query covers a whole line-up, so this is cheap; it lands a beat after
  // the graph draws and quietly re-sizes the nodes.
  const fameAsked = new Set();
  let fameTimer = 0;

  function queueFame() {
    clearTimeout(fameTimer);
    fameTimer = setTimeout(fetchFame, 350);
  }

  async function fetchFame() {
    const ids = cy.nodes().map((n) => n.id()).filter((id) => !fameAsked.has(id));
    if (!ids.length) return;
    ids.forEach((id) => fameAsked.add(id));
    for (let i = 0; i < ids.length; i += 100) {
      try {
        const d = await api('/api/notability?ids=' + ids.slice(i, i + 100).join(','));
        cy.batch(() => {
          for (const [id, n] of Object.entries(d.sitelinks || {})) {
            const node = cy.getElementById(id);
            if (node.nonempty() && n) node.data('fame', n);
          }
        });
        computeProminence();
        queueGlow();
      } catch { /* fame is a bonus — a failure just leaves sizes as they are */ }
    }
  }

  // Sweep satellites that no longer connect to anything worth keeping.
  function removeOrphans() {
    cy.nodes()
      .filter((m) => m.degree(true) === 0 && !m.hasClass('expanded') && !m.hasClass('seed'))
      .forEach((m) => cy.remove(m));
  }

  // Collapse: fold an expanded node back to its bridges — its edges to other
  // hubs survive (they're part of those hubs' stories), everything that only
  // existed because of this expansion is swept away. Re-expanding is instant
  // (server cache) and reuses the same hue.
  function collapseNode(id) {
    const n = cy.getElementById(id);
    if (n.empty() || !expanded.has(id)) return;
    cy.batch(() => {
      n.connectedEdges().forEach((ed) => {
        const other = ed.source().id() === id ? ed.target() : ed.source();
        if (!other.hasClass('expanded')) cy.remove(ed);
      });
      n.removeClass('expanded');
      expanded.delete(id);
      removeOrphans();
    });
    graphChanged();
    if (n.selected()) renderPanelNode(n);
  }

  // Remove: take the node (and anything orphaned by its departure) off the
  // canvas entirely.
  function removeNode(id) {
    const n = cy.getElementById(id);
    if (n.empty()) return;
    const wasSelected = n.selected();
    cy.batch(() => {
      cy.remove(n);
      expanded.delete(id);
      removeOrphans();
    });
    graphChanged();
    if (wasSelected) panelEmpty();
  }

  let layoutObj = null;

  // `fresh: true` throws away the current positions and solves from scratch.
  // Nudging an existing arrangement is right for one more expansion, but once
  // several hubs are open the old layout is a local minimum the simulation
  // can't climb out of — clusters stay tangled however long it runs.
  function runLayout(opts = {}) {
    if (layoutObj) { try { layoutObj.stop(); } catch { /* already done */ } }
    cy.resize();
    const n = cy.nodes(':visible').length;
    const dur = opts.fresh ? 700 : 500;
    layoutObj = cy.layout({
      name: 'cose',
      // Filtered-out elements shouldn't reserve space in the layout.
      eles: cy.elements(':visible'),
      animate: 'end',
      animationDuration: dur,
      fit: true,
      padding: 60,
      randomize: !!opts.fresh,
      nodeDimensionsIncludeLabels: true,
      // Hubs shove much harder than leaves, so each band keeps its own
      // territory instead of its satellites interleaving with the next one's.
      nodeRepulsion: (node) => (node.hasClass('expanded') ? 1600000 : 150000),
      // Hub-to-hub links stretch long; a member sits close to its band.
      idealEdgeLength: (ed) =>
        (ed.source().hasClass('expanded') && ed.target().hasClass('expanded') ? 380 : 130),
      nodeOverlap: 60,
      gravity: n > 60 ? 0.15 : 0.35,
      numIter: n > 40 ? 4000 : 2500,
      componentSpacing: 180,
    });
    layoutObj.run();
    // Re-fit after the position tween has finished — cose computes its own fit
    // before animating, so late movement can drift out of view.
    clearTimeout(runLayout._refit);
    runLayout._refit = setTimeout(() => {
      cy.resize();
      cy.animate({ fit: { eles: cy.elements(':visible'), padding: 70 } }, { duration: 220 });
    }, dur + 140);
  }

  async function expand(id) {
    if (expanded.has(id) || loading.has(id)) return;
    loading.add(id);
    const n0 = cy.getElementById(id);
    if (n0.nonempty()) n0.addClass('loading');
    const label = n0.nonempty() ? n0.data('name') : 'artist';
    setStatus(`Fetching ${label} from MusicBrainz…`);
    try {
      const a = await api('/api/artist?id=' + id);
      expanded.add(id);
      const added = addArtist(a);
      setStatus(`${a.name}: ${added} connection${added === 1 ? '' : 's'} added`, false, 2600);
      const sel = cy.$('node:selected');
      if (sel.length && sel[0].id() === id) renderPanelNode(sel[0]);
    } catch (err) {
      setStatus(`Couldn't fetch ${label}: ${err.message}`, true, 5000);
    } finally {
      loading.delete(id);
      const n = cy.getElementById(id);
      if (n.nonempty()) n.removeClass('loading');
    }
  }

  // ---------- Status pill ----------
  let statusTimer = 0;
  function setStatus(msg, isErr, autohideMs) {
    clearTimeout(statusTimer);
    el.status.hidden = !msg;
    if (!msg) return;
    el.status.textContent = msg;
    el.status.classList.toggle('err', !!isErr);
    if (autohideMs) statusTimer = setTimeout(() => { el.status.hidden = true; }, autohideMs);
  }

  function updateOverlays() {
    const has = cy.nodes().length > 0;
    el.empty.hidden = has;
    el.legend.hidden = !has;
    el.credit.hidden = has; // the legend carries the credit once a graph exists
    if (!has) el.relfilter.hidden = true;
    updateTimeRange();
  }

  // ---------- Timeline (scrub the years) ----------
  const NOW_YEAR = new Date().getFullYear();
  const time = { active: false, playing: false, year: null, min: 1950, max: NOW_YEAR, timer: 0 };

  // A membership with missing dates borrows them from the band's life-span:
  // an undated founder shines for the band's whole run instead of ghosting,
  // and an "ended, start unknown" stint can't predate the band's formation.
  function edgeWindow(ed) {
    const d = ed.data();
    let by = d.by;
    let ey = d.ey;
    if (d.cls === 'member') {
      const band = ed.target(); // member edges always point person → band
      if (by == null) by = band.data('lsBy') ?? null;
      if (ey == null) ey = band.data('lsEy') ?? null;
    }
    return { by, ey };
  }

  // true = active at year y · false = dated but inactive · null = undated
  function onAt(w, y) {
    if (w.by == null && w.ey == null) return null;
    if (w.by != null && w.ey != null) return w.by <= y && y <= w.ey;
    if (w.by != null) return w.by <= y;
    return y <= w.ey;
  }

  function applyTime(y) {
    y = Math.max(time.min, Math.min(time.max, y));
    time.active = true;
    time.year = y;
    el.tbYear.textContent = y;
    el.tbRange.value = y;
    cy.batch(() => {
      cy.edges().forEach((ed) => {
        const on = onAt(edgeWindow(ed), y);
        ed.toggleClass('t-ghost', on === null);
        ed.toggleClass('t-dim', on === false);
      });
      cy.nodes().forEach((n) => {
        let on = n.connectedEdges().some((ed) => !ed.hasClass('t-dim') && !ed.hasClass('t-ghost'));
        if (!on && n.data('kind') === 'group') {
          // A band hub stays alive through its own life-span even when its
          // membership dates are missing.
          const by = n.data('lsBy');
          const ey = n.data('lsEy');
          on = by != null && by <= y && (ey == null || y <= ey);
        }
        n.toggleClass('t-dim', !on);
      });
    });
  }

  function exitTime() {
    pauseTime();
    time.active = false;
    time.year = null;
    el.tbYear.textContent = 'All time';
    el.tbRange.value = el.tbRange.max;
    cy.batch(() => cy.elements().removeClass('t-dim t-ghost'));
  }

  function pauseTime() {
    time.playing = false;
    el.tbPlay.textContent = '▶';
    clearInterval(time.timer);
  }

  function playTime() {
    if (time.playing) return pauseTime();
    if (!time.active || time.year >= time.max) applyTime(time.min);
    time.playing = true;
    el.tbPlay.textContent = '⏸';
    time.timer = setInterval(() => {
      if (time.year >= time.max) return pauseTime();
      applyTime(time.year + 1);
    }, 240);
  }

  function updateTimeRange() {
    let min = Infinity;
    let max = -Infinity;
    let dated = false;
    cy.edges().forEach((ed) => {
      const w = edgeWindow(ed);
      if (w.by != null || w.ey != null) {
        dated = true;
        min = Math.min(min, w.by ?? w.ey);
        max = Math.max(max, w.ey ?? NOW_YEAR);
      }
    });
    cy.nodes('[kind="group"]').forEach((n) => {
      const by = n.data('lsBy');
      if (by != null) {
        min = Math.min(min, by);
        max = Math.max(max, n.data('lsEy') ?? NOW_YEAR);
      }
    });
    const show = dated && cy.nodes().length > 0;
    el.timebar.hidden = !show;
    if (!show) {
      // No dated material left to scrub — don't strand a stale year filter.
      if (time.active) exitTime();
      return;
    }
    time.min = min;
    time.max = Math.max(max, min + 1);
    el.tbRange.min = time.min;
    el.tbRange.max = time.max;
    if (time.active) applyTime(time.year);
    else el.tbRange.value = time.max;
    drawHist();
  }

  function drawHist() {
    const c = el.tbHist;
    const w = c.parentElement.clientWidth;
    const h = 26;
    const dpr = window.devicePixelRatio || 1;
    if (!w) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const span = time.max - time.min + 1;
    const windows = cy.edges('[cls="member"]').map((ed) => edgeWindow(ed));
    const counts = [];
    let peak = 1;
    for (let i = 0; i < span; i++) {
      let k = 0;
      for (const w of windows) if (onAt(w, time.min + i)) k++;
      counts.push(k);
      if (k > peak) peak = k;
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    ctx.globalAlpha = 0.38;
    const bw = w / span;
    counts.forEach((k, i) => {
      if (!k) return;
      const bh = Math.max(2, (k / peak) * (h - 3));
      ctx.fillRect(i * bw + 0.5, h - bh, Math.max(1, bw - 1), bh);
    });
    ctx.globalAlpha = 1;
  }

  // ---------- HUD collapse/expand ----------
  function setHudCollapsed(box, head, on) {
    box.classList.toggle('collapsed', on);
    head.setAttribute('aria-expanded', String(!on));
  }

  for (const head of document.querySelectorAll('.hud-head')) {
    const box = head.closest('.hud-box');
    const key = 'musikrawlr.hud.' + head.dataset.hud;
    // Closed by default — the canvas is the point; open state is remembered.
    let collapsed = true;
    try { collapsed = localStorage.getItem(key) !== '0'; } catch { /* private mode */ }
    setHudCollapsed(box, head, collapsed);
    head.addEventListener('click', () => {
      const on = !box.classList.contains('collapsed');
      setHudCollapsed(box, head, on);
      try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* private mode */ }
      // The histogram canvas measures 0 wide while hidden — redraw on reveal.
      if (!on && head.dataset.hud === 'time') drawHist();
    });
  }

  el.tbPlay.addEventListener('click', playTime);
  el.tbAll.addEventListener('click', exitTime);
  el.tbRange.addEventListener('input', () => { pauseTime(); applyTime(+el.tbRange.value); });

  // ---------- Detail panel ----------
  const LINK_LABELS = {
    'official homepage': 'Website', wikidata: 'Wikidata', discogs: 'Discogs',
    allmusic: 'AllMusic', 'last.fm': 'Last.fm', songkick: 'Songkick',
    setlistfm: 'Setlist.fm', bandcamp: 'Bandcamp', soundcloud: 'SoundCloud',
    'youtube music': 'YouTube Music', youtube: 'YouTube', IMDb: 'IMDb',
  };

  function urlLinks(full) {
    const seen = new Set();
    const out = [{ label: 'MusicBrainz', href: `https://musicbrainz.org/artist/${full.id}` }];
    for (const r of full.relations || []) {
      if (!r.url || !LINK_LABELS[r.type] || seen.has(r.type)) continue;
      seen.add(r.type);
      out.push({ label: LINK_LABELS[r.type], href: r.url.resource });
    }
    return out.slice(0, 8);
  }

  // Years served on a single relationship, where the data allows it.
  function relSpan(r) {
    const b = yr(r.begin);
    if (b == null) return null;
    const e = yr(r.end);
    const end = e != null ? e : (r.ended ? null : NOW_YEAR);
    return end == null ? null : Math.max(0, end - b);
  }

  function relSection(title, rels, withType) {
    if (!rels.length) return '';
    // Longest stints first — the people who WERE the band rise to the top,
    // rather than being buried among dozens of short-term members.
    const sorted = [...rels].sort((a, b) =>
      (relSpan(b) ?? -1) - (relSpan(a) ?? -1)
      || (a.begin || '9999').localeCompare(b.begin || '9999'));
    const rows = sorted.map((r) => {
      const attrs = (r.attributes || []).join(', ');
      const sub = withType
        ? `<span class="r-attrs">${esc(r.type)}${attrs ? ' · ' + esc(attrs) : ''}</span>`
        : (attrs ? `<span class="r-attrs">${esc(attrs)}</span>` : '');
      const n = relSpan(r);
      const dur = n != null && n >= 1 ? `<i>${n} yr${n === 1 ? '' : 's'}</i>` : '';
      return `<div class="p-rel"><span><a data-goto="${r.artist.id}" data-name="${esc(r.artist.name)}">${esc(r.artist.name)}</a>${sub}</span><span class="r-years">${esc(fmtYears(r))}${dur}</span></div>`;
    }).join('');
    return `<div class="p-section"><h3>${esc(title)} · ${rels.length}</h3>${rows}</div>`;
  }

  function renderPanelNode(n) {
    const full = n.data('full');
    const kind = n.data('kind');
    let html = `<h2 class="p-name">${esc(n.data('name'))}</h2>`;
    const disamb = (full && full.disambiguation) || n.data('disambiguation');
    if (disamb) html += `<p class="p-disamb">${esc(disamb)}</p>`;

    const chips = [`<span class="p-chip kind-${kind === 'person' ? 'person' : 'group'}">${kind === 'person' ? 'Musician' : kind === 'group' ? 'Band' : 'Artist'}</span>`];
    if (full) {
      const ls = full['life-span'] || {};
      const years = fmtYears({ begin: ls.begin, end: ls.end, ended: ls.ended });
      if (years) chips.push(`<span class="p-chip">${kind === 'group' ? 'Active ' : ''}${esc(years)}</span>`);
      const area = (full.area && full.area.name) || full.country;
      if (area) chips.push(`<span class="p-chip">${esc(area)}</span>`);
    }
    html += `<div class="p-chips">${chips.join('')}</div>`;

    if (full && full.genres && full.genres.length) {
      const gs = [...full.genres].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 5);
      html += `<div class="p-chips">${gs.map((g) => `<span class="p-chip p-genre">${esc(g.name)}</span>`).join('')}</div>`;
    }

    const actions = [];
    if (!expanded.has(n.id())) {
      actions.push(`<button class="p-expand" data-expand="${n.id()}"${loading.has(n.id()) ? ' disabled' : ''}>${loading.has(n.id()) ? 'Expanding…' : 'Expand connections'}</button>`);
    } else {
      actions.push(`<button class="p-expand" data-collapse="${n.id()}">Collapse</button>`);
    }
    actions.push(`<button class="p-expand p-danger" data-remove="${n.id()}" title="Take this node off the canvas">Remove</button>`);
    html += `<div class="p-actions">${actions.join('')}</div>`;
    html += `<div class="p-enrich" data-enrich-for="${n.id()}"><p class="pe-hint">Looking up Wikipedia, Discogs &amp; Cover Art Archive…</p></div>`;

    if (full) {
      const rels = (full.relations || []).filter((r) => r.artist);
      const members = rels.filter((r) => r.type === 'member of band' && r.direction === 'backward');
      const bands = rels.filter((r) => r.type === 'member of band' && r.direction === 'forward');
      const others = rels.filter((r) => r.type !== 'member of band');
      html += relSection('Members', members);
      html += relSection('Bands', bands);
      html += relSection('Connections', others, true);
      const links = urlLinks(full);
      html += `<div class="p-section"><h3>Links</h3><div class="p-links">${links.map((l) => `<a href="${esc(l.href)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join('')}</div></div>`;
    } else {
      html += `<p class="pe-hint">Not fetched yet — expand to load dates, genres and connections.</p>`;
    }
    el.panel.innerHTML = html;
    fillEnrich(n.id());
  }

  // ---------- Panel enrichment (Wikipedia / Wikidata / Cover Art Archive) ----------
  const enrichCache = new Map();

  function loadEnrich(id) {
    if (!enrichCache.has(id)) {
      enrichCache.set(id, api('/api/enrich?id=' + id).catch(() => null));
    }
    return enrichCache.get(id);
  }

  function fillEnrich(id) {
    loadEnrich(id).then((enr) => {
      const holder = el.panel.querySelector(`[data-enrich-for="${id}"]`);
      if (!holder) return; // the panel has moved on to something else
      holder.innerHTML = enrichHtml(enr);
    });
  }

  function enrichHtml(enr) {
    if (!enr || (!enr.bio && !enr.image && !(enr.releaseGroups || []).length)) return '';
    let h = '';
    if (enr.image) {
      h += `<img class="p-photo" src="${esc(enr.image)}" alt="" loading="lazy" onerror="this.remove()">`;
    }
    if (enr.bio && enr.bio.text) {
      h += `<p class="p-bio">${esc(enr.bio.text)}${enr.bio.url ? ` <a href="${esc(enr.bio.url)}" target="_blank" rel="noopener">${esc(enr.bio.source)} →</a>` : ''}</p>`;
    }
    if (enr.releaseGroups && enr.releaseGroups.length) {
      h += `<div class="p-section"><h3>Albums</h3><div class="p-albums">${enr.releaseGroups.map((rg) =>
        `<a class="p-album" href="https://musicbrainz.org/release-group/${rg.id}" target="_blank" rel="noopener" title="${esc(rg.title)}${rg.year ? ` (${rg.year})` : ''}">` +
        `<img src="https://coverartarchive.org/release-group/${rg.id}/front-250" alt="" loading="lazy" onerror="this.closest('.p-album').remove()">` +
        `<span>${esc(rg.year || '')}</span></a>`).join('')}</div></div>`;
    }
    return h;
  }

  function renderPanelEdge(ed) {
    const d = ed.data();
    const s = cy.getElementById(d.source).data('name');
    const t = cy.getElementById(d.target).data('name');
    el.panel.innerHTML = `
      <h2 class="p-name">${esc(s)} <span style="color:var(--muted)">→</span> ${esc(t)}</h2>
      <div class="p-chips">
        <span class="p-chip">${esc(d.type)}</span>
        ${d.years ? `<span class="p-chip">${esc(d.years)}</span>` : ''}
      </div>
      ${d.attrs ? `<p>${esc(d.attrs)}</p>` : ''}`;
  }

  const panelEmpty = () => { el.panel.innerHTML = PANEL_EMPTY; };

  el.panel.addEventListener('click', (e) => {
    const ex = e.target.closest('[data-expand]');
    if (ex) { expand(ex.dataset.expand); renderPanelNode(cy.getElementById(ex.dataset.expand)); return; }
    const co = e.target.closest('[data-collapse]');
    if (co) { collapseNode(co.dataset.collapse); return; }
    const rm = e.target.closest('[data-remove]');
    if (rm) { removeNode(rm.dataset.remove); return; }
    const go = e.target.closest('[data-goto]');
    if (go) goTo(go.dataset.goto, go.dataset.name);
  });

  function goTo(id, name) {
    let n = cy.getElementById(id);
    if (n.empty()) n = ensureNode({ id, name });
    cy.$(':selected').unselect();
    n.select();
    cy.animate({ center: { eles: n }, duration: 250 });
    if (!expanded.has(id)) expand(id);
  }

  // ---------- Graph events ----------
  cy.on('select', 'node', (e) => {
    renderPanelNode(e.target);
    e.target.connectedEdges().addClass('hl');
  });
  cy.on('unselect', 'node', (e) => e.target.connectedEdges().removeClass('hl'));
  cy.on('select', 'edge', (e) => renderPanelEdge(e.target));
  cy.on('unselect', () => setTimeout(() => { if (cy.$(':selected').empty()) panelEmpty(); }, 0));

  // Right-click closes: collapse an expanded node, remove anything else.
  cy.on('cxttap', 'node', (e) => {
    const id = e.target.id();
    if (expanded.has(id)) collapseNode(id);
    else removeNode(id);
    hideTip();
  });
  $('#cy').addEventListener('contextmenu', (e) => e.preventDefault());

  // Delete/Backspace removes the selected node (unless typing in a field).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    const t = document.activeElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const sel = cy.$('node:selected');
    if (sel.length) { e.preventDefault(); removeNode(sel[0].id()); }
  });

  // Manual double-tap detection (works for touch too).
  let lastTap = { id: null, t: 0 };
  cy.on('tap', 'node', (e) => {
    const id = e.target.id();
    const now = Date.now();
    if (lastTap.id === id && now - lastTap.t < 380) {
      expand(id);
      lastTap = { id: null, t: 0 };
    } else {
      lastTap = { id, t: now };
    }
  });

  // Says why a node is sized the way it is — the longest stint, what share of
  // that band's life it covers, and how widely written about they are.
  function whyProminent(n) {
    const eds = n.connectedEdges('[cls="member"]');
    const bits = [];
    if (eds.length) {
      const best = eds.max((ed) => ed.data('eprom') || 0);
      const ed = best.ele;
      const yrs = ed.data('tenure');
      const span = bandSpan(ed.target());
      if (yrs) {
        const pct = span ? Math.round(Math.min(1, yrs / span) * 100) : null;
        bits.push(`${yrs} yr${yrs === 1 ? '' : 's'} in ${ed.target().data('name')}`
          + (pct != null ? ` · ${pct === 100 ? 'its whole life' : pct + '% of its life'}` : ''));
      }
    }
    const fame = n.data('fame');
    if (fame) bits.push(`${fame} Wikipedia article${fame === 1 ? '' : 's'}`);
    return bits.length ? `<div class="t-sub">${esc(bits.join(' · '))}</div>` : '';
  }

  // Tooltips
  function showTip(html, e) {
    el.tip.innerHTML = html;
    el.tip.hidden = false;
    const r = el.stage.getBoundingClientRect();
    const pos = e.renderedPosition || { x: 0, y: 0 };
    el.tip.style.left = Math.max(4, Math.min(pos.x + 14, r.width - el.tip.offsetWidth - 8)) + 'px';
    el.tip.style.top = Math.max(4, Math.min(pos.y + 14, r.height - el.tip.offsetHeight - 8)) + 'px';
  }
  const hideTip = () => { el.tip.hidden = true; };
  cy.on('mouseover', 'node', (e) => {
    const n = e.target;
    n.addClass('hover');
    n.connectedEdges().addClass('hl');
    const sub = n.data('disambiguation') || (n.data('kind') === 'person' ? 'Musician' : n.data('kind') === 'group' ? 'Band' : '');
    const hint = expanded.has(n.id())
      ? '<div class="t-sub">Right-click to collapse</div>'
      : '<div class="t-sub">Double-click to expand · right-click to remove</div>';
    showTip(`<strong>${esc(n.data('name'))}</strong>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}${whyProminent(n)}${hint}`, e);
  });
  cy.on('mouseout', 'node', (e) => {
    e.target.removeClass('hover');
    e.target.connectedEdges().not(cy.$('node:selected').connectedEdges()).removeClass('hl');
  });
  cy.on('mouseover', 'edge', (e) => {
    e.target.addClass('hl');
    const d = e.target.data();
    const s = cy.getElementById(d.source).data('name');
    const t = cy.getElementById(d.target).data('name');
    const sub = [d.years, d.attrs].filter(Boolean).join(' · ');
    showTip(`<strong>${esc(s)}</strong> ${esc(d.type)} <strong>${esc(t)}</strong>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}`, e);
  });
  cy.on('mouseout', 'edge', (e) => {
    if (!e.target.selected() && !e.target.connectedNodes(':selected').length) e.target.removeClass('hl');
  });
  cy.on('mouseout', 'node, edge', hideTip);
  cy.on('viewport', hideTip);
  cy.on('drag', 'node', hideTip);

  // ---------- Search ----------
  let searchTimer = 0;
  let searchSeq = 0;
  let currentResults = [];
  let active = -1;

  function showResults(html) { el.results.innerHTML = html; el.results.hidden = false; }
  function hideResults() { el.results.hidden = true; currentResults = []; active = -1; }

  async function doSearch(q) {
    const seq = ++searchSeq;
    showResults('<div class="r-hint">Searching…</div>');
    try {
      const d = await api('/api/search?q=' + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      currentResults = (d.artists || []).slice(0, 10);
      active = -1;
      if (!currentResults.length) return showResults('<div class="r-hint">No artists found.</div>');
      showResults(currentResults.map((a, i) => {
        const kind = a.type === 'Person' ? 'person' : a.type ? 'group' : 'other';
        const sub = [a.disambiguation, a.area || a.country, fmtYears(a)].filter(Boolean).join(' · ');
        return `<button class="r-item" data-i="${i}"><span class="r-name">${esc(a.name)}</span><span class="r-badge ${kind}">${esc(a.type || 'Artist')}</span>${sub ? `<div class="r-sub">${esc(sub)}</div>` : ''}</button>`;
      }).join(''));
    } catch (err) {
      if (seq === searchSeq) showResults(`<div class="r-hint">Search failed: ${esc(err.message)}</div>`);
    }
  }

  el.q.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = el.q.value.trim();
    if (q.length < 2) { hideResults(); return; }
    searchTimer = setTimeout(() => doSearch(q), 320);
  });

  el.q.addEventListener('keydown', (e) => {
    if (el.results.hidden) return;
    const items = [...el.results.querySelectorAll('.r-item')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = e.key === 'ArrowDown'
        ? (active + 1) % items.length
        : (active - 1 + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = currentResults[active >= 0 ? active : 0];
      if (pick) addSeed(pick);
    } else if (e.key === 'Escape') {
      hideResults();
    }
  });

  el.results.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.r-item');
    if (b) { e.preventDefault(); addSeed(currentResults[+b.dataset.i]); }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) hideResults();
  });

  function addSeed(a) {
    hideResults();
    el.q.value = '';
    const n = ensureNode(a, {
      renderedPosition: { x: el.stage.clientWidth / 2, y: el.stage.clientHeight / 2 },
    });
    n.addClass('seed');
    updateOverlays();
    cy.$(':selected').unselect();
    n.select();
    expand(a.id);
  }

  async function seedByName(name) {
    setStatus(`Finding ${name}…`);
    try {
      const d = await api('/api/search?q=' + encodeURIComponent(name));
      const a = (d.artists || []).find((x) => x.name.toLowerCase() === name.toLowerCase()) || (d.artists || [])[0];
      if (!a) throw new Error('no match');
      addSeed(a);
    } catch (err) {
      setStatus(`Couldn't find ${name}: ${err.message}`, true, 5000);
    }
  }

  el.empty.addEventListener('click', (e) => {
    const c = e.target.closest('[data-seed]');
    if (!c) return;
    // Starters carry their MBID: several are ambiguous by name (four
    // different bands are called "The Swingers"), so never guess.
    if (c.dataset.mbid) addSeed({ id: c.dataset.mbid, name: c.dataset.seed });
    else seedByName(c.dataset.seed);
  });

  // ---------- Toolbar ----------
  // Fit used to just zoom out on whatever tangle was there. Once more than one
  // hub is open the arrangement has usually drifted from the single-hub one it
  // grew out of, so tidy it properly first; with one hub, just frame it.
  el.fit.addEventListener('click', () => {
    cy.resize();
    if (cy.nodes('.expanded').length > 1) {
      setStatus('Re-arranging…', false, 1400);
      runLayout({ fresh: true });
    } else {
      cy.animate({ fit: { eles: cy.elements(':visible'), padding: 70 } }, { duration: 220 });
    }
  });
  el.clear.addEventListener('click', () => {
    exitTime();
    cy.elements().remove();
    expanded.clear();
    hiddenTypes.clear();
    hueCounter = 0;
    el.degA.innerHTML = '';
    el.degB.innerHTML = '';
    degUserPicked = false;
    panelEmpty();
    updateOverlays();
    refreshDegrees();
    setStatus('');
  });

  // ---------- Boot ----------
  updateOverlays();
  queueGlow();
})();
