// Band graph — search MusicBrainz artists, grow a band↔musician graph.
'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const el = {
    q: $('#q'), results: $('#results'), panel: $('#panel'), empty: $('#empty'),
    legend: $('#legend'), status: $('#status'), tip: $('#tip'), stage: $('#stage'),
    fit: $('#fit'), clear: $('#clear'), themeSwitch: $('#theme-switch'),
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

  // ---------- Theme ----------
  const THEME_KEY = 'bandgraph.theme';
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
    syncThemeSwitch();
    cy.style().fromJson(cyStyle()).update();
  }
  function syncThemeSwitch() {
    el.themeSwitch.dataset.on = theme();
    for (const b of el.themeSwitch.querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.themeOpt === theme()));
    }
  }
  el.themeSwitch.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-theme-opt]');
    if (b) setTheme(b.dataset.themeOpt);
  });

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

  function cyStyle() {
    const p = theme() === 'dark' ? {
      person: '#f99e7e', group: '#58c4ec', unknown: '#7d828d',
      label: '#e9e7e2', outline: '#131519',
      member: '#8b95a6', family: '#f99e7e', collab: '#2ad0cb', other: '#535a67',
      ring: '#34e2ad', sel: '#ffd166',
    } : {
      person: '#f78c6b', group: '#118ab2', unknown: '#98a0ad',
      label: '#21252d', outline: '#f7f6f3',
      member: '#8b95a6', family: '#f78c6b', collab: '#0cb0a9', other: '#c6ccd6',
      ring: '#06d6a0', sel: '#d99a00',
    };
    return [
      { selector: 'node', style: {
        width: 'mapData(deg, 0, 12, 26, 58)',
        height: 'mapData(deg, 0, 12, 26, 58)',
        'background-color': p.unknown,
        label: 'data(label)',
        'font-size': 11,
        'font-family': 'system-ui, sans-serif',
        color: p.label,
        'text-outline-color': p.outline,
        'text-outline-width': 2,
        'text-valign': 'bottom',
        'text-margin-y': 7,
        'text-wrap': 'wrap',
        'text-max-width': 120,
        'border-width': 0,
        'overlay-opacity': 0,
      } },
      { selector: 'node[kind="person"]', style: { 'background-color': p.person } },
      { selector: 'node[kind="group"]', style: { 'background-color': p.group } },
      { selector: 'node.expanded', style: { 'border-width': 3, 'border-color': p.ring } },
      { selector: 'node.loading', style: { 'border-width': 3, 'border-style': 'dashed', 'border-color': p.sel } },
      { selector: 'node:selected', style: { 'border-width': 4, 'border-color': p.sel } },
      { selector: 'edge', style: {
        'curve-style': 'bezier',
        width: 1.3,
        'line-color': p.other,
        'line-style': 'dashed',
        label: 'data(years)',
        'font-size': 9,
        color: p.label,
        'text-outline-color': p.outline,
        'text-outline-width': 1.5,
        'text-rotation': 'autorotate',
        'overlay-opacity': 0,
      } },
      { selector: 'edge[cls="member"]', style: { width: 2.6, 'line-style': 'solid', 'line-color': p.member } },
      { selector: 'edge[cls="family"]', style: { width: 2, 'line-style': 'dotted', 'line-color': p.family } },
      { selector: 'edge[cls="collab"]', style: { width: 1.8, 'line-style': 'dashed', 'line-color': p.collab } },
      { selector: 'edge:selected', style: { 'line-color': p.sel, width: 3.2 } },
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
  new ResizeObserver(() => cy.resize()).observe($('#cy'));

  // ---------- Graph building ----------
  const expanded = new Set();
  const loading = new Set();

  const kindOf = (t) => (t ? (t === 'Person' ? 'person' : 'group') : 'unknown');

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
    if (a.type) node.data('kind', kindOf(a.type));
    if (a.disambiguation) node.data('disambiguation', a.disambiguation);
    node.addClass('expanded');
    const pos = node.position();
    let added = 0;
    const rels = (a.relations || []).filter((r) => r.artist && r.artist.id !== a.id);
    // New neighbours spawn evenly on a circle around their anchor, so the
    // layout starts untangled and unfolds locally instead of from a pile.
    const newCount = rels.filter((r) => cy.getElementById(r.artist.id).empty()).length || 1;
    let newIdx = 0;
    for (const r of rels) {
      if (cy.getElementById(r.artist.id).empty()) {
        const ang = (newIdx++ / newCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.2;
        ensureNode(r.artist, {
          position: { x: pos.x + Math.cos(ang) * 180, y: pos.y + Math.sin(ang) * 180 },
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
      cy.add({ group: 'edges', data: {
        id: key, source: src, target: tgt,
        cls: REL_CLASS[r.type] || 'other', type: r.type,
        years: fmtYears(r), attrs: (r.attributes || []).join(', '),
      } });
      added++;
    }
    cy.nodes().forEach((n) => n.data('deg', Math.min(n.degree(false), 12)));
    updateOverlays();
    runLayout();
    return added;
  }

  let layoutObj = null;
  function runLayout() {
    if (layoutObj) { try { layoutObj.stop(); } catch { /* already done */ } }
    cy.resize();
    layoutObj = cy.layout({
      name: 'cose',
      animate: 'end',
      animationDuration: 500,
      fit: true,
      padding: 60,
      randomize: false,
      nodeDimensionsIncludeLabels: true,
      idealEdgeLength: 130,
      nodeRepulsion: 100000,
      nodeOverlap: 30,
      gravity: 0.4,
      numIter: 2500,
      componentSpacing: 140,
    });
    layoutObj.run();
    // Re-fit after the position tween has finished — cose computes its own fit
    // before animating, so late movement can drift out of view.
    clearTimeout(runLayout._refit);
    runLayout._refit = setTimeout(() => {
      cy.resize();
      cy.animate({ fit: { eles: cy.elements(), padding: 70 } }, { duration: 220 });
    }, 640);
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
  }

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

  function relSection(title, rels, withType) {
    if (!rels.length) return '';
    const sorted = [...rels].sort((a, b) => (a.begin || '9999').localeCompare(b.begin || '9999'));
    const rows = sorted.map((r) => {
      const attrs = (r.attributes || []).join(', ');
      const sub = withType
        ? `<span class="r-attrs">${esc(r.type)}${attrs ? ' · ' + esc(attrs) : ''}</span>`
        : (attrs ? `<span class="r-attrs">${esc(attrs)}</span>` : '');
      return `<div class="p-rel"><span><a data-goto="${r.artist.id}" data-name="${esc(r.artist.name)}">${esc(r.artist.name)}</a>${sub}</span><span class="r-years">${esc(fmtYears(r))}</span></div>`;
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

    if (!expanded.has(n.id())) {
      html += `<button class="p-expand" data-expand="${n.id()}"${loading.has(n.id()) ? ' disabled' : ''}>${loading.has(n.id()) ? 'Expanding…' : 'Expand connections'}</button>`;
    }

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
  cy.on('select', 'node', (e) => renderPanelNode(e.target));
  cy.on('select', 'edge', (e) => renderPanelEdge(e.target));
  cy.on('unselect', () => setTimeout(() => { if (cy.$(':selected').empty()) panelEmpty(); }, 0));

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
    const sub = n.data('disambiguation') || (n.data('kind') === 'person' ? 'Musician' : n.data('kind') === 'group' ? 'Band' : '');
    const hint = expanded.has(n.id()) ? '' : '<div class="t-sub">Double-click to expand</div>';
    showTip(`<strong>${esc(n.data('name'))}</strong>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}${hint}`, e);
  });
  cy.on('mouseover', 'edge', (e) => {
    const d = e.target.data();
    const s = cy.getElementById(d.source).data('name');
    const t = cy.getElementById(d.target).data('name');
    const sub = [d.years, d.attrs].filter(Boolean).join(' · ');
    showTip(`<strong>${esc(s)}</strong> ${esc(d.type)} <strong>${esc(t)}</strong>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ''}`, e);
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
    if (c) seedByName(c.dataset.seed);
  });

  // ---------- Toolbar ----------
  el.fit.addEventListener('click', () => { cy.resize(); cy.fit(undefined, 70); });
  el.clear.addEventListener('click', () => {
    cy.elements().remove();
    expanded.clear();
    panelEmpty();
    updateOverlays();
    setStatus('');
  });

  // ---------- Boot ----------
  syncThemeSwitch();
  updateOverlays();
})();
