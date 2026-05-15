(() => {
  /* ── Config ──────────────────────────────────── */
  const STATUS_ORDER = ['capture', 'triage', 'design', 'plan', 'execute', 'review', 'shipped'];
  const STATUS_LABELS = {
    capture: 'Capture', triage: 'Triage', design: 'Design',
    plan: 'Plan', execute: 'Execute', review: 'Review', shipped: 'Shipped',
  };
  const TERMINAL = new Set(['shipped']);
  const RESOLVED = new Set(['completed', 'review', 'shipped']);
  const VALID_STATUSES = new Set(STATUS_ORDER);

  const COL_MIN_WIDTH = 140;
  const COL_MAX_WIDTH = Infinity;
  const COL_DEFAULT_WIDTH = 210;
  const STORAGE_KEY = 'gm-panel-columns';
  const FILTER_KEY = 'gm-panel-filters';

  /* ── State ───────────────────────────────────── */
  let currentView = 'board';
  let allItems = [];
  let searchResults = null;
  let projects = [];
  let epics = [];
  let connected = false;
  let loading = false;
  let availableModels = [];
  let modelsLoading = false;

  /* Filter state — composable, independent controls */
  let filters = {
    groupBy: 'status',        // 'status' | 'epic' | 'none'
    statuses: new Set(),       // empty = all; non-empty = only these
    epicId: '',                // '' = any; '__none__' = unassigned; or epic id
    topics: new Set(),         // empty = all; non-empty = only ideas with ANY of these
    hideShipped: true,         // hide shipped/completed/review ideas by default
  };

  /* Column state: { [status]: { width: number, collapsed: boolean } } */
  let columnState = {};

  /* Multi-select state */
  let selectedIds = new Set();
  let lastClickedId = null;   // for shift-range selection

  /* ── DOM refs ────────────────────────────────── */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const dom = {
    tabBoard: $('#tabBoard'),
    tabList: $('#tabList'),
    boardView: $('#boardView'),
    boardInner: $('#boardInner'),
    listView: $('#listView'),
    projectFilter: $('#projectFilter'),
    searchToggle: $('#searchToggle'),
    searchBar: $('#searchBar'),
    searchInput: $('#searchInput'),
    searchProject: $('#searchProject'),
    searchGoBtn: $('#searchGoBtn'),
    searchClose: $('#searchClose'),
    captureToggle: $('#captureToggle'),
    captureDrawer: $('#captureDrawer'),
    captureProject: $('#captureProject'),
    captureSummary: $('#captureSummary'),
    captureTopics: $('#captureTopics'),
    captureContent: $('#captureContent'),
    captureBtn: $('#captureBtn'),
    captureClose: $('#captureClose'),
    refreshBtn: $('#refreshBtn'),
    statusDot: $('#statusIndicator .status-dot'),
    statusText: $('#statusText'),
    toast: $('#toast'),
    detailBackdrop: $('#detailBackdrop'),
    detailPanel: $('#detailPanel'),
    detailClose: $('#detailClose'),
    detailArchiveBtn: $('#detailArchiveBtn'),
    detailDeleteBtn: $('#detailDeleteBtn'),
    detailContent: $('#detailContent'),
    detailStatusBadge: $('#detailStatusBadge'),
    detailStatusPills: $('#detailStatusPills'),
    detailTopics: $('#detailTopics'),
    detailTopicsSection: $('#detailTopicsSection'),
    detailProject: $('#detailProject'),
    detailId: $('#detailId'),
    detailEpicSection: $('#detailEpicSection'),
    detailEpic: $('#detailEpic'),
    filterToggle: $('#filterToggle'),
    filterPopover: $('#filterPopover'),
    filterBackdrop: $('#filterBackdrop'),
    filterChips: $('#filterChips'),
    fpGroupBy: $('#fpGroupBy'),
    fpStatus: $('#fpStatus'),
    fpEpic: $('#fpEpic'),
    fpTopic: $('#fpTopic'),
    fpClear: $('#fpClear'),
    contextMenu: $('#contextMenu'),
    contextMenuHeader: $('#contextMenuHeader'),
    contextMenuItems: $('#contextMenuItems'),
  };

  /* ── Bootstrap missing filter DOM (cached HTML compat) ── */
  function ensureFilterDom() {
    if (dom.filterPopover) return; // already in DOM

    // Create filter backdrop
    const backdrop = document.createElement('div');
    backdrop.className = 'filter-backdrop';
    backdrop.id = 'filterBackdrop';
    document.body.appendChild(backdrop);
    dom.filterBackdrop = backdrop;

    // Create filter popover
    const pop = document.createElement('div');
    pop.className = 'filter-popover';
    pop.id = 'filterPopover';
    pop.innerHTML = `
      <div class="fp-section">
        <div class="fp-label">Group by</div>
        <div class="fp-pills" id="fpGroupBy">
          <button class="fp-pill active" data-value="status">Status</button>
          <button class="fp-pill" data-value="epic">Epic</button>
          <button class="fp-pill" data-value="none">None</button>
        </div>
      </div>
      <div class="fp-section">
        <div class="fp-label">Status</div>
        <div class="fp-pills fp-multi" id="fpStatus"></div>
      </div>
      <div class="fp-section">
        <div class="fp-label">Epic</div>
        <select id="fpEpic" class="fp-select"><option value="">Any</option><option value="__none__">Unassigned</option></select>
      </div>
      <div class="fp-section">
        <div class="fp-label">Topic</div>
        <input id="fpTopic" class="fp-input" placeholder="Filter by topic…" />
      </div>
      <div class="fp-section">
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--text-secondary,#aaa);">
          <input type="checkbox" id="fpHideShipped" />
          <span>Hide resolved (completed / review / shipped)</span>
        </label>
      </div>
      <div class="fp-footer">
        <button class="btn btn-ghost" id="fpClear" style="font-size:11px;">Clear all</button>
      </div>`;
    document.body.appendChild(pop);
    dom.filterPopover = pop;
    dom.fpGroupBy = pop.querySelector('#fpGroupBy');
    dom.fpStatus = pop.querySelector('#fpStatus');
    dom.fpEpic = pop.querySelector('#fpEpic');
    dom.fpTopic = pop.querySelector('#fpTopic');
    dom.fpHideShipped = pop.querySelector('#fpHideShipped');
    dom.fpClear = pop.querySelector('#fpClear');

    // Create filter toggle if missing
    if (!dom.filterToggle) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost btn-icon';
      btn.id = 'filterToggle';
      btn.title = 'Filter & Group';
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
      // Insert before search toggle
      dom.searchToggle.parentElement.insertBefore(btn, dom.searchToggle);
      dom.filterToggle = btn;
    }

    // Create chips area if missing
    if (!dom.filterChips) {
      const chips = document.createElement('div');
      chips.className = 'filter-chips';
      chips.id = 'filterChips';
      // Insert after project filter
      const spacer = document.querySelector('.spacer');
      if (spacer) spacer.parentElement.insertBefore(chips, spacer);
      dom.filterChips = chips;
    }

    // Remove old groupByToggle if present
    const oldToggle = document.getElementById('groupByToggle');
    if (oldToggle) oldToggle.remove();

    // Create detail epic section if missing
    if (!document.getElementById('detailEpicSection')) {
      const topicsSection = document.getElementById('detailTopicsSection');
      if (topicsSection) {
        const epicSection = document.createElement('div');
        epicSection.id = 'detailEpicSection';
        epicSection.style.display = 'none';
        epicSection.innerHTML = '<div class="detail-section-label">Epic</div><div id="detailEpic"></div>';
        topicsSection.parentElement.insertBefore(epicSection, topicsSection.nextSibling);
        dom.detailEpicSection = epicSection;
        dom.detailEpic = epicSection.querySelector('#detailEpic');
      }
    }
  }
  ensureFilterDom();

  /* ── Helpers ─────────────────────────────────── */
  function escapeHtml(s) {
    return s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#39;');
  }

  function statusBg(s) { return `sb-${s}`; }
  function borderLeft(s) { return `bl-${s}`; }
  function colDotClass(s) { return `cd-${s}`; }

  let toastTimer = null;
  function showToast(msg, isError = false) {
    dom.toast.textContent = msg;
    dom.toast.className = `toast visible${isError ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.toast.className = 'toast'; }, 2500);
  }

  function setConnectionStatus(ok, text) {
    connected = ok;
    dom.statusDot.className = `status-dot ${ok ? 'ok' : (text === 'Connecting…' ? 'loading' : 'err')}`;
    dom.statusText.textContent = text;
  }

  async function fetchJson(url, options = {}) {
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function parseMultiValueParam(params, keys) {
    const values = [];
    keys.forEach((key) => {
      params.getAll(key).forEach((raw) => {
        String(raw || '')
          .split(/[\n,]/g)
          .map((v) => v.trim())
          .filter(Boolean)
          .forEach((v) => values.push(v));
      });
    });
    return [...new Set(values)];
  }

  function readStartupState() {
    const params = new URLSearchParams(location.search);
    const hash = location.hash.replace(/^#/, '').trim();
    const hashIdea = hash.match(/^idea\/(.+)$/);
    const hashEpic = hash.match(/^epic\/(.+)$/);

    const rawGroupBy = (params.get('groupBy') || params.get('group') || '').trim();
    const groupBy = ['status', 'epic', 'none'].includes(rawGroupBy) ? rawGroupBy : '';

    const rawView = (params.get('view') || '').trim();
    const view = ['board', 'list'].includes(rawView) ? rawView : '';

    const statuses = new Set(
      parseMultiValueParam(params, ['status', 'statuses'])
        .map((s) => s.toLowerCase())
        .filter((s) => VALID_STATUSES.has(s)),
    );

    const topics = new Set(parseMultiValueParam(params, ['topic', 'topics']));

    const epicIdFromQuery = (params.get('epic') || params.get('epicId') || '').trim();
    const ideaIdFromQuery = (params.get('idea') || params.get('ideaId') || '').trim();

    return {
      project: (params.get('project') || '').trim(),
      searchProject: (params.get('searchProject') || '').trim(),
      searchQuery: (params.get('query') || params.get('q') || '').trim(),
      groupBy,
      view,
      statuses,
      topics,
      epicId: hashEpic ? decodeURIComponent(hashEpic[1]) : epicIdFromQuery,
      ideaId: hashIdea ? decodeURIComponent(hashIdea[1]) : ideaIdFromQuery,
    };
  }

  function applyStartupState(startup) {
    if (startup.project) dom.projectFilter.value = startup.project;
    if (startup.searchProject) dom.searchProject.value = startup.searchProject;

    if (startup.view === 'board' || startup.view === 'list') {
      currentView = startup.view;
    }

    if (startup.groupBy) {
      filters.groupBy = startup.groupBy;
    }

    if (startup.statuses.size > 0) {
      filters.statuses = new Set(startup.statuses);
    }

    if (startup.topics.size > 0) {
      filters.topics = new Set(startup.topics);
    }

    if (startup.epicId) {
      filters.epicId = startup.epicId;
      if (!startup.groupBy) filters.groupBy = 'epic';
    }

    if (startup.searchQuery) {
      dom.searchInput.value = startup.searchQuery;
      dom.searchBar.classList.add('open');
    }
  }

  /* ── Column state persistence ────────────────── */
  function loadColumnState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          columnState = parsed;
          return;
        }
      }
    } catch { /* ignore */ }
    columnState = {};
  }

  function saveColumnState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(columnState));
    } catch { /* ignore */ }
  }

  function getColState(status) {
    if (!columnState[status]) {
      columnState[status] = { width: COL_DEFAULT_WIDTH, collapsed: false };
    }
    return columnState[status];
  }

  function setColWidth(status, width) {
    getColState(status).width = Math.max(COL_MIN_WIDTH, Math.min(COL_MAX_WIDTH, width));
    saveColumnState();
  }

  function toggleCollapsed(status) {
    const state = getColState(status);
    state.collapsed = !state.collapsed;
    saveColumnState();
  }

  /* ── API calls ───────────────────────────────── */
  async function loadProjects() {
    try {
      const data = await fetchJson('./api/projects');
      projects = Array.isArray(data.projects) ? data.projects : [];
      populateProjectSelects();
    } catch { /* ignore */ }
  }

  function populateProjectSelects() {
    [dom.projectFilter, dom.searchProject].forEach(sel => {
      const val = sel.value;
      const first = sel.options[0]?.textContent || 'All projects';
      sel.innerHTML = `<option value="">${first}</option>`;
      projects.forEach(p => {
        const name = typeof p === 'string' ? p : (p.project || p.name || p.id || '');
        if (name) sel.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      });
      sel.value = val;
    });
  }

  function modelKey(model) {
    return `${String(model?.provider || '').trim()}/${String(model?.id || '').trim()}`;
  }

  function modelLabel(model) {
    const provider = String(model?.provider || '').trim();
    const id = String(model?.id || '').trim();
    const name = String(model?.name || '').trim();
    return name ? `${name} (${provider})` : `${id} (${provider})`;
  }

  function parseModelValue(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const sep = raw.indexOf('/');
    if (sep <= 0) return null;
    const provider = raw.slice(0, sep).trim();
    const id = raw.slice(sep + 1).trim();
    if (!provider || !id) return null;
    return { provider, id };
  }

  function populateModelSelects() {
    const selects = document.querySelectorAll('[data-model-select]');
    selects.forEach((select) => {
      const currentValue = select.value;
      const options = ['<option value="">Runner default</option>'];
      availableModels
        .filter((model) => model.available !== false)
        .forEach((model) => {
          const key = modelKey(model);
          if (!key || key === '/') return;
          options.push(`<option value="${escapeHtml(key)}">${escapeHtml(modelLabel(model))}</option>`);
        });
      select.innerHTML = options.join('');
      select.value = currentValue && availableModels.some((model) => model.available !== false && modelKey(model) === currentValue)
        ? currentValue
        : '';
    });
  }

  async function loadModels() {
    modelsLoading = true;
    try {
      const data = await fetchJson('./api/models');
      availableModels = Array.isArray(data.models) ? data.models : [];
    } catch {
      availableModels = [];
    } finally {
      modelsLoading = false;
      populateModelSelects();
    }
  }

  async function loadEpics() {
    try {
      const params = new URLSearchParams();
      const proj = dom.projectFilter.value;
      if (proj) params.set('project', proj);
      const data = await fetchJson(`./api/epics?${params}`);
      epics = Array.isArray(data.epics) ? data.epics : [];
    } catch { /* ignore */ }
  }

  /* ── Filter persistence ────────────────────── */
  function loadFilters() {
    try {
      const raw = localStorage.getItem(FILTER_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p.groupBy) filters.groupBy = p.groupBy;
        if (Array.isArray(p.statuses)) filters.statuses = new Set(p.statuses);
        if (typeof p.epicId === 'string') filters.epicId = p.epicId;
        if (Array.isArray(p.topics)) filters.topics = new Set(p.topics);
        if (typeof p.hideShipped === 'boolean') filters.hideShipped = p.hideShipped;
      }
    } catch { /* ignore */ }
  }

  function saveFilters() {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({
        groupBy: filters.groupBy,
        statuses: [...filters.statuses],
        epicId: filters.epicId,
        topics: [...filters.topics],
        hideShipped: filters.hideShipped,
      }));
    } catch { /* ignore */ }
  }

  function clearFilters() {
    filters.statuses = new Set();
    filters.epicId = '';
    filters.topics = new Set();
    filters.hideShipped = true;
    saveFilters();
  }

  function hasActiveFilters() {
    return filters.statuses.size > 0 || filters.epicId !== '' || filters.topics.size > 0 || !filters.hideShipped;
  }

  /* ── Apply filters to items ──────────────── */
  function getFilteredItems() {
    let items = searchResults !== null ? searchResults : allItems;

    if (filters.statuses.size > 0) {
      items = items.filter(i => filters.statuses.has(String(i.status || 'capture')));
    }

    if (filters.epicId === '__none__') {
      items = items.filter(i => !i.epic_id);
    } else if (filters.epicId) {
      items = items.filter(i => String(i.epic_id || '') === filters.epicId);
    }

    if (filters.topics.size > 0) {
      items = items.filter(i => {
        const t = Array.isArray(i.topics) ? i.topics : [];
        return t.some(topic => filters.topics.has(topic));
      });
    }

    if (filters.hideShipped) {
      items = items.filter(i => !RESOLVED.has(String(i.status || 'capture')));
    }

    return items;
  }

  /* ── Collect all unique topics from data ──── */
  function getAllTopics() {
    const set = new Set();
    allItems.forEach(i => {
      if (Array.isArray(i.topics)) i.topics.forEach(t => set.add(t));
    });
    return [...set].sort();
  }

  async function loadItems() {
    loading = true;
    const params = new URLSearchParams();
    const proj = dom.projectFilter.value;
    if (proj) params.set('project', proj);
    params.set('includeCompleted', 'true');

    try {
      const data = await fetchJson(`./api/list?${params}`);
      allItems = Array.isArray(data.items) ? data.items : [];
      setConnectionStatus(true, `${allItems.length} ideas`);
    } catch (err) {
      setConnectionStatus(false, err.message);
    } finally {
      loading = false;
    }
  }

  async function doSearch() {
    const query = dom.searchInput.value.trim();
    if (!query) { searchResults = null; render(); return; }
    const params = new URLSearchParams({ query, limit: '20' });
    const proj = dom.searchProject.value;
    if (proj) params.set('project', proj);

    try {
      const data = await fetchJson(`./api/search?${params}`);
      searchResults = Array.isArray(data.items) ? data.items : [];
      showToast(`${searchResults.length} result(s)`);
    } catch (err) {
      showToast(err.message, true);
    }
    render();
  }

  async function captureIdea() {
    const description = dom.captureContent.value.trim();
    if (!description) { showToast('Description required', true); return; }
    const summary = dom.captureSummary ? dom.captureSummary.value.trim() : '';
    const project = dom.captureProject.value.trim() || 'PizzaPi';
    const topics = dom.captureTopics.value;

    try {
      await fetchJson('./api/capture', {
        method: 'POST',
        body: JSON.stringify({ description, summary, project, topics }),
      });
      dom.captureContent.value = '';
      if (dom.captureSummary) dom.captureSummary.value = '';
      dom.captureTopics.value = '';
      dom.captureDrawer.classList.remove('open');
      showToast('Idea captured ✓');
      await loadItems();
      render();
    } catch (err) {
      showToast(`Capture failed: ${err.message}`, true);
    }
  }

  async function moveIdea(id, to) {
    if (!to) return;
    try {
      await fetchJson('./api/move', { method: 'POST', body: JSON.stringify({ id, to }) });
      showToast(`Moved → ${to}`);
      await loadItems();
      render();
    } catch (err) {
      showToast(`Move failed: ${err.message}`, true);
    }
  }

  async function deleteIdea(id) {
    if (!id) return;
    if (!confirm('Are you sure you want to delete this idea? This cannot be undone.')) return;
    try {
      await fetchJson('./api/delete', { method: 'POST', body: JSON.stringify({ id }) });
      showToast('Idea deleted ✓');
      closeDetail();
      await loadItems();
      render();
    } catch (err) {
      showToast(`Delete failed: ${err.message}`, true);
    }
  }

  async function archiveIdea(id) {
    if (!id) return;
    try {
      await fetchJson('./api/archive', { method: 'POST', body: JSON.stringify({ id }) });
      showToast('Idea archived ✓');
      closeDetail();
      await loadItems();
      render();
    } catch (err) {
      showToast(`Archive failed: ${err.message}`, true);
    }
  }

  /* ── Selection helpers ───────────────────────── */
  function clearSelection() {
    selectedIds.clear();
    lastClickedId = null;
    document.querySelectorAll('.idea-card.selected').forEach(c => c.classList.remove('selected'));
    updateBulkBar();
  }

  /** Get the ordered list of visible idea IDs (respects current view & grouping). */
  function getVisibleOrderedIds() {
    const items = getDisplayItems();
    if (currentView === 'list' || filters.groupBy === 'none') return items.map(i => String(i.id));
    if (filters.groupBy === 'epic') {
      const epicIds = epics.map(e => e.id);
      const grouped = {};
      items.forEach(item => {
        const key = String(item.epic_id || '__none__');
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(item);
      });
      const order = epicIds.filter(id => grouped[id]?.length).concat(grouped['__none__']?.length ? ['__none__'] : []);
      const ids = [];
      order.forEach(eid => (grouped[eid] || []).forEach(i => ids.push(String(i.id))));
      return ids;
    }
    // status grouping
    const grouped = {};
    STATUS_ORDER.forEach(s => { grouped[s] = []; });
    items.forEach(item => {
      const s = String(item.status || 'capture');
      (grouped[s] || grouped.capture).push(item);
    });
    const ids = [];
    STATUS_ORDER.forEach(s => grouped[s].forEach(i => ids.push(String(i.id))));
    return ids;
  }

  function toggleSelectId(id) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    syncSelectionDom();
  }

  function selectRange(fromId, toId) {
    const ordered = getVisibleOrderedIds();
    const a = ordered.indexOf(fromId);
    const b = ordered.indexOf(toId);
    if (a === -1 || b === -1) { toggleSelectId(toId); return; }
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi; i++) selectedIds.add(ordered[i]);
    syncSelectionDom();
  }

  function syncSelectionDom() {
    document.querySelectorAll('.idea-card').forEach(c => {
      c.classList.toggle('selected', selectedIds.has(c.dataset.ideaId));
    });
    document.querySelectorAll('.list-item').forEach(li => {
      li.classList.toggle('selected', selectedIds.has(li.dataset.ideaId));
    });
    updateBulkBar();
  }

  /* ── Bulk action bar ───────────────────────── */
  const bulkBar = document.createElement('div');
  bulkBar.className = 'bulk-bar';
  bulkBar.innerHTML = `
    <span class="bulk-count"></span>
    <select class="bulk-move-select">
      <option value="">Move to…</option>
      ${STATUS_ORDER.map(s => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('')}
    </select>
    <button class="btn btn-primary bulk-orchestrate-btn" title="Orchestrate selected ideas">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      <span class="bulk-orchestrate-label">Orchestrate</span>
    </button>
    <button class="btn btn-ghost bulk-archive-btn" title="Archive selected">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
    </button>
    <button class="btn btn-ghost bulk-delete-btn" title="Delete selected">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </button>
    <button class="btn btn-ghost bulk-clear-btn" title="Clear selection">✕</button>
  `;
  document.body.appendChild(bulkBar);

  const bulkCountEl = bulkBar.querySelector('.bulk-count');
  const bulkMoveSelect = bulkBar.querySelector('.bulk-move-select');
  const bulkDeleteBtn = bulkBar.querySelector('.bulk-delete-btn');
  const bulkClearBtn = bulkBar.querySelector('.bulk-clear-btn');

  const bulkOrchestrateBtn = bulkBar.querySelector('.bulk-orchestrate-btn');
  const bulkOrchestrateLabelEl = bulkBar.querySelector('.bulk-orchestrate-label');

  function updateBulkBar() {
    const n = selectedIds.size;
    bulkBar.classList.toggle('visible', n > 0);
    bulkCountEl.textContent = `${n} selected`;
    bulkOrchestrateLabelEl.textContent = `Orchestrate ${n} Item${n === 1 ? '' : 's'}`;
  }

  bulkOrchestrateBtn.addEventListener('click', (e) => {
    if (selectedIds.size === 0) return;
    const items = allItems.filter(i => selectedIds.has(String(i.id)));
    if (!items.length) return;
    e.stopPropagation();
    showOrchestratePopover(bulkOrchestrateBtn, (customPrompt, model) => spawnItemsOrchestrator(items, customPrompt, model));
  });

  bulkMoveSelect.addEventListener('change', async () => {
    const to = bulkMoveSelect.value;
    if (!to || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    bulkMoveSelect.value = '';
    clearSelection();
    for (const id of ids) {
      try { await fetchJson('./api/move', { method: 'POST', body: JSON.stringify({ id, to }) }); }
      catch { /* continue */ }
    }
    showToast(`Moved ${ids.length} → ${to}`);
    await loadItems();
    render();
  });

  const bulkArchiveBtn = bulkBar.querySelector('.bulk-archive-btn');

  bulkArchiveBtn.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    clearSelection();
    for (const id of ids) {
      try { await fetchJson('./api/archive', { method: 'POST', body: JSON.stringify({ id }) }); }
      catch { /* continue */ }
    }
    showToast(`Archived ${ids.length} idea(s)`);
    await loadItems();
    render();
  });

  bulkDeleteBtn.addEventListener('click', async () => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} idea(s)? This cannot be undone.`)) return;
    clearSelection();
    for (const id of ids) {
      try { await fetchJson('./api/delete', { method: 'POST', body: JSON.stringify({ id }) }); }
      catch { /* continue */ }
    }
    showToast(`Deleted ${ids.length} idea(s)`);
    await loadItems();
    render();
  });

  bulkClearBtn.addEventListener('click', clearSelection);

  /* ── Context Menu ──────────────────────────── */
  let contextMenuForId = null;

  function closeContextMenu() {
    dom.contextMenu.classList.remove('visible');
    contextMenuForId = null;
  }

  function showContextMenu(e, idea) {
    e.preventDefault();
    e.stopPropagation();
    
    const id = String(idea.id || '');
    const status = String(idea.status || 'capture');
    contextMenuForId = id;

    // Set header
    dom.contextMenuHeader.textContent = idea.summary || idea.snippet || idea.description || id.slice(0, 8);

    // Build menu items
    dom.contextMenuItems.innerHTML = '';

    // Status options
    const statusLabel = document.createElement('div');
    statusLabel.style.cssText = 'padding: 4px 12px; font-size: 10px; color: var(--muted); text-transform: uppercase; margin-top: 4px; border-bottom: 1px solid var(--border); margin-bottom: 0;';
    statusLabel.textContent = 'Move to';
    dom.contextMenuItems.appendChild(statusLabel);

    STATUS_ORDER.forEach(s => {
      if (s === status) return; // Skip current status
      const item = document.createElement('button');
      item.className = 'context-menu-item';
      item.textContent = STATUS_LABELS[s];
      item.addEventListener('click', async () => {
        closeContextMenu();
        await moveIdea(id, s);
      });
      dom.contextMenuItems.appendChild(item);
    });

    // Divider
    const divider = document.createElement('div');
    divider.style.cssText = 'height: 1px; background: var(--border); margin: 4px 0;';
    dom.contextMenuItems.appendChild(divider);

    // Open in detail
    const detailItem = document.createElement('button');
    detailItem.className = 'context-menu-item';
    detailItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> Open';
    detailItem.addEventListener('click', () => {
      closeContextMenu();
      openDetail(id);
    });
    dom.contextMenuItems.appendChild(detailItem);

    // Archive
    const archiveItem = document.createElement('button');
    archiveItem.className = 'context-menu-item';
    archiveItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg> Archive';
    archiveItem.addEventListener('click', () => {
      closeContextMenu();
      archiveIdea(id);
    });
    dom.contextMenuItems.appendChild(archiveItem);

    // Delete
    const deleteItem = document.createElement('button');
    deleteItem.className = 'context-menu-item danger';
    deleteItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg> Delete';
    deleteItem.addEventListener('click', () => {
      closeContextMenu();
      deleteIdea(id);
    });
    dom.contextMenuItems.appendChild(deleteItem);

    // Position menu
    dom.contextMenu.classList.add('visible');
    // On narrow screens, CSS positions it as a bottom sheet — skip inline positioning
    if (window.innerWidth > 480) {
      dom.contextMenu.style.left = (e.clientX) + 'px';
      dom.contextMenu.style.top = (e.clientY) + 'px';
    } else {
      dom.contextMenu.style.left = '';
      dom.contextMenu.style.top = '';
    }
  }

  // Close context menu on clicks elsewhere
  document.addEventListener('click', (e) => {
    if (!dom.contextMenu.contains(e.target) && !e.target.closest('.idea-card')) {
      closeContextMenu();
    }
  });

  // Close context menu / clear selection on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dom.contextMenu.classList.contains('visible')) {
        closeContextMenu();
      } else if (selectedIds.size > 0) {
        clearSelection();
      }
    }
  });

  /* ── Rendering ───────────────────────────────── */
  function getDisplayItems() {
    return getFilteredItems();
  }

  /* ── Detail panel ──────────────────────────── */
  let openIdeaId = null;

  async function openDetail(ideaId) {
    const cached = allItems.find(i => String(i.id) === String(ideaId))
      || (searchResults && searchResults.find(i => String(i.id) === String(ideaId)));
    if (cached) renderDetail(cached);

    try {
      const data = await fetchJson(`./api/get?id=${encodeURIComponent(ideaId)}`);
      if (data.idea && openIdeaId === String(ideaId)) {
        renderDetail(data.idea);
      }
    } catch (err) {
      if (!cached) showToast(`Failed to load idea: ${err.message}`, true);
    }
  }

  function applyFilterFromDetail(type, value) {
    if (type === 'status') {
      filters.statuses = new Set([value]);
    } else if (type === 'epic') {
      filters.epicId = value;
    } else if (type === 'topic') {
      filters.topics.add(value);
    } else if (type === 'project') {
      dom.projectFilter.value = value;
    }
    saveFilters();
    closeDetail();
    if (type === 'project') {
      // Project change needs reload
      Promise.all([loadItems(), loadEpics()]).then(() => { renderFilterChips(); render(); });
    } else {
      renderFilterChips();
      render();
    }
  }

  function renderDetail(item) {
    openIdeaId = String(item.id || '');
    const status = String(item.status || 'capture');
    const summary = String(item.summary || '').trim();
    const description = String(item.description || item.snippet || item.content || '').trim();
    const project = String(item.project || '');
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const epicId = String(item.epic_id || '');

    // Content
    if (summary && description && summary !== description) {
      dom.detailContent.innerHTML = `<strong style="font-size:14px;display:block;margin-bottom:6px;">${escapeHtml(summary)}</strong>${escapeHtml(description)}`;
    } else {
      dom.detailContent.textContent = description || summary || '(empty)';
    }

    // Status badge — clickable to filter
    const badge = document.createElement('span');
    badge.className = `status-badge ${statusBg(status)} filterable`;
    badge.textContent = STATUS_LABELS[status] || status;
    badge.title = `Filter to ${STATUS_LABELS[status] || status}`;
    badge.addEventListener('click', () => applyFilterFromDetail('status', status));
    dom.detailStatusBadge.innerHTML = '';
    dom.detailStatusBadge.appendChild(badge);

    // Status pills (for changing status)
    dom.detailStatusPills.innerHTML = '';
    STATUS_ORDER.forEach(s => {
      const pill = document.createElement('button');
      pill.className = `status-pill sp-${s}${s === status ? ' current' : ''}`;
      pill.textContent = STATUS_LABELS[s];
      if (s !== status) {
        pill.addEventListener('click', async () => {
          await moveIdea(openIdeaId, s);
          try {
            const data = await fetchJson(`./api/get?id=${encodeURIComponent(openIdeaId)}`);
            if (data.idea) renderDetail(data.idea);
          } catch { /* board already refreshed */ }
        });
      }
      dom.detailStatusPills.appendChild(pill);
    });

    // Topics — each clickable to add topic filter
    if (topics.length > 0) {
      dom.detailTopicsSection.style.display = '';
      dom.detailTopics.innerHTML = '';
      topics.forEach(t => {
        const pill = document.createElement('span');
        pill.className = 'topic-pill filterable';
        pill.textContent = t;
        pill.title = `Filter to topic "${t}"`;
        pill.addEventListener('click', () => applyFilterFromDetail('topic', t));
        dom.detailTopics.appendChild(pill);
      });
    } else {
      dom.detailTopicsSection.style.display = 'none';
    }

    // Epic — clickable to filter
    const epicEl = dom.detailEpic || document.getElementById('detailEpic');
    const epicSection = dom.detailEpicSection || document.getElementById('detailEpicSection');
    if (epicEl && epicSection) {
      if (epicId) {
        const epicMap = {};
        epics.forEach(e => { epicMap[e.id] = e; });
        const epic = epicMap[epicId];
        const epicName = epic?.title || epicId.slice(0, 12);
        epicSection.style.display = '';
        epicEl.innerHTML = '';
        const epicBadge = document.createElement('span');
        epicBadge.className = 'detail-epic-badge filterable';
        epicBadge.textContent = epicName;
        epicBadge.title = `Filter to epic "${epicName}"`;
        epicBadge.addEventListener('click', () => applyFilterFromDetail('epic', epicId));
        epicEl.appendChild(epicBadge);
      } else {
        epicSection.style.display = '';
        epicEl.innerHTML = '';
        const unassigned = document.createElement('span');
        unassigned.className = 'detail-epic-badge filterable';
        unassigned.textContent = 'Unassigned';
        unassigned.style.opacity = '0.5';
        unassigned.title = 'Filter to unassigned ideas';
        unassigned.addEventListener('click', () => applyFilterFromDetail('epic', '__none__'));
        epicEl.appendChild(unassigned);
      }
    }

    // Project — clickable to filter
    dom.detailProject.innerHTML = '';
    const projSpan = document.createElement('span');
    projSpan.className = 'filterable';
    projSpan.textContent = project || '—';
    if (project) {
      projSpan.title = `Filter to project "${project}"`;
      projSpan.addEventListener('click', () => applyFilterFromDetail('project', project));
    }
    dom.detailProject.appendChild(projSpan);

    dom.detailId.textContent = openIdeaId;

    // Keep track of which item is open so the persistent spawn listener always uses latest
    detailSpawnBtnEl._currentItem = item;
    // Collapse spawn section when switching cards
    detailSpawnBodyEl.classList.remove('open');
    detailSpawnToggleEl.setAttribute('aria-expanded', 'false');
    detailSpawnPromptEl.value = '';
    detailSpawnPromptEl.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) spawnFromDetail(detailSpawnBtnEl._currentItem);
    };

    dom.detailBackdrop.classList.add('open');
    dom.detailPanel.offsetHeight; // force reflow
    dom.detailPanel.classList.add('open');
  }

  function closeDetail() {
    dom.detailPanel.classList.remove('open');
    dom.detailBackdrop.classList.remove('open');
    openIdeaId = null;
  }

  /* ── Drag & Drop helpers ───────────────────── */
  let draggedIdeaId = null;
  let draggedFromStatus = null;

  function clearAllDragOver() {
    document.querySelectorAll('.column.drag-over').forEach(c => c.classList.remove('drag-over'));
    document.querySelectorAll('.drop-placeholder').forEach(p => p.remove());
  }

  function ensurePlaceholder(colCards) {
    if (!colCards.querySelector('.drop-placeholder')) {
      const ph = document.createElement('div');
      ph.className = 'drop-placeholder';
      colCards.appendChild(ph);
    }
  }

  /* ── Collapse chevron SVG ──────────────────── */
  const CHEVRON_LEFT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';

  /* ── Resize handle logic ───────────────────── */
  function initResize(handleEl, colEl, status) {
    let startX = 0;
    let startWidth = 0;

    function onPointerMove(e) {
      const delta = e.clientX - startX;
      const newWidth = Math.max(COL_MIN_WIDTH, Math.min(COL_MAX_WIDTH, startWidth + delta));
      colEl.style.width = newWidth + 'px';
    }

    function onPointerUp(e) {
      handleEl.classList.remove('active');
      document.body.classList.remove('col-resizing');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);

      const delta = e.clientX - startX;
      const finalWidth = Math.max(COL_MIN_WIDTH, Math.min(COL_MAX_WIDTH, startWidth + delta));
      setColWidth(status, finalWidth);
    }

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startWidth = colEl.offsetWidth;
      handleEl.classList.add('active');
      document.body.classList.add('col-resizing');
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });
  }

  /* ── Card builder (Linear-style) ─────────────── */
  // status: the column status for drag-and-drop (null = no drag)
  // showStatus: show a status dot on the card (used in epic view)
  function buildIdeaCard(item, status, { showStatus = false } = {}) {
    const card = document.createElement('div');
    const id = String(item.id || '');
    const cardText = String(item.summary || item.snippet || item.description || item.content || '').trim();
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const itemStatus = String(item.status || 'capture');

    card.className = 'idea-card';
    card.dataset.ideaId = id;

    if (status !== null) {
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        draggedIdeaId = id;
        draggedFromStatus = status;
        e.dataTransfer.setData('text/plain', id);
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => card.classList.add('dragging'));
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        clearAllDragOver();
        draggedIdeaId = null;
        draggedFromStatus = null;
      });
    }

    let html = '<div class="card-content">';
    if (showStatus) {
      html += `<span class="card-status-dot cd-${itemStatus}" style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;flex-shrink:0;vertical-align:middle;"></span>`;
    }
    html += `${escapeHtml(cardText || '(empty)')}</div>`;
    html += '<div class="card-meta">';
    html += `<span class="card-id">${escapeHtml(id.slice(0, 6))}</span>`;
    const maxTopics = 2;
    topics.slice(0, maxTopics).forEach(t => {
      html += `<span class="topic-pill">${escapeHtml(t)}</span>`;
    });
    if (topics.length > maxTopics) html += `<span class="topic-pill">+${topics.length - maxTopics}</span>`;
    html += '</div>';

    card.innerHTML = html;
    card.addEventListener('click', (e) => {
      if (e.defaultPrevented || card.dataset.longPressed) return;
      if (e.shiftKey) {
        e.preventDefault();
        if (lastClickedId && lastClickedId !== id) {
          selectRange(lastClickedId, id);
        } else {
          toggleSelectId(id);
        }
        lastClickedId = id;
        return;
      }
      // If there's an active selection and user clicks without shift, clear it
      if (selectedIds.size > 0) {
        clearSelection();
        return;
      }
      openDetail(id);
    });
    card.addEventListener('contextmenu', (e) => {
      showContextMenu(e, item);
    });

    // Long-press for mobile context menu
    let longPressTimer = null;
    card.addEventListener('touchstart', (e) => {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        e.preventDefault();
        card.dataset.longPressed = '1';
        const touch = e.touches[0];
        showContextMenu({ clientX: touch.clientX, clientY: touch.clientY, preventDefault() {} }, item);
      }, 500);
    }, { passive: false });
    card.addEventListener('touchend', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      setTimeout(() => { delete card.dataset.longPressed; }, 50);
    });
    card.addEventListener('touchmove', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    });

    return card;
  }

  /* ── Board rendering ─────────────────────────── */
  function renderBoardEpic() {
    const items = getDisplayItems();
    const inner = dom.boardInner;
    inner.innerHTML = '';

    if (items.length === 0) {
      inner.innerHTML = `<div class="empty-state" style="width:100%;"><div class="empty-icon">📋</div><div class="empty-text">${searchResults !== null ? 'No search results' : 'No ideas yet'}</div></div>`;
      return;
    }

    // Build epic map: id → epic object
    const epicMap = {};
    epics.forEach(e => { epicMap[e.id] = e; });

    // Group items by epic_id
    const grouped = {}; // epic_id or '__none__' → items[]
    items.forEach(item => {
      const key = String(item.epic_id || '__none__');
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    });

    // Column order: epics that have items, then unassigned (filter shipped epics when hideShipped)
    const visibleEpics = filters.hideShipped ? epics.filter(e => !RESOLVED.has(e.status)) : epics;
    const epicIds = visibleEpics.map(e => e.id).filter(id => grouped[id]?.length > 0);
    if (grouped['__none__']?.length > 0) epicIds.push('__none__');

    epicIds.forEach(epicId => {
      const isUnassigned = epicId === '__none__';
      const epic = isUnassigned ? null : epicMap[epicId];
      const colItems = grouped[epicId] || [];

      const state = getColState('epic:' + epicId);
      const isCollapsed = state.collapsed;

      const col = document.createElement('div');
      col.className = `column${isCollapsed ? ' collapsed' : ''}`;
      col.dataset.epicId = epicId;
      if (!isCollapsed) col.style.width = state.width + 'px';

      const header = document.createElement('div');
      header.className = 'col-header';

      const dot = document.createElement('div');
      dot.className = 'col-dot cd-execute';
      if (isUnassigned) dot.className = 'col-dot cd-capture';

      const title = document.createElement('span');
      title.className = 'col-title';
      title.textContent = isUnassigned ? 'Unassigned' : (epic?.title || epicId);

      const countEl = document.createElement('span');
      countEl.className = 'col-count';
      countEl.textContent = colItems.length;

      const selectAllBtn = document.createElement('button');
      selectAllBtn.className = 'col-select-all-btn';
      selectAllBtn.title = 'Select all in column';
      selectAllBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
      selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const colIds = colItems.map(i => String(i.id));
        const allSelected = colIds.length > 0 && colIds.every(id => selectedIds.has(id));
        if (allSelected) {
          colIds.forEach(id => selectedIds.delete(id));
        } else {
          colIds.forEach(id => selectedIds.add(id));
        }
        lastClickedId = colIds[colIds.length - 1] || null;
        syncSelectionDom();
      });

      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'col-collapse-btn';
      collapseBtn.title = isCollapsed ? 'Expand column' : 'Collapse column';
      collapseBtn.innerHTML = CHEVRON_LEFT_SVG;
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapsed('epic:' + epicId);
        render();
      });

      header.append(dot, title, countEl, selectAllBtn, collapseBtn);
      col.appendChild(header);

      if (isCollapsed) {
        col.addEventListener('click', (e) => {
          if (e.target.closest('.col-collapse-btn')) return;
          toggleCollapsed('epic:' + epicId);
          render();
        });
      } else {
        const cards = document.createElement('div');
        cards.className = 'col-cards';

        colItems.forEach(item => {
          cards.appendChild(buildIdeaCard(item, null, { showStatus: true }));
        });

        col.appendChild(cards);

        const handle = document.createElement('div');
        handle.className = 'col-resize-handle';
        initResize(handle, col, 'epic:' + epicId);
        col.appendChild(handle);
      }

      inner.appendChild(col);
    });
  }

  function renderBoardNone() {
    const items = getDisplayItems();
    const inner = dom.boardInner;
    inner.innerHTML = '';
    if (items.length === 0) {
      inner.innerHTML = `<div class="empty-state" style="width:100%;"><div class="empty-icon">📋</div><div class="empty-text">${searchResults !== null ? 'No search results' : 'No ideas yet'}</div></div>`;
      return;
    }
    // Single column with all items
    const col = document.createElement('div');
    col.className = 'column';
    col.style.width = '100%';
    col.style.maxWidth = 'none';
    const header = document.createElement('div');
    header.className = 'col-header';
    const title = document.createElement('span');
    title.className = 'col-title';
    title.textContent = 'All Ideas';
    const countEl = document.createElement('span');
    countEl.className = 'col-count';
    countEl.textContent = items.length;
    header.append(title, countEl);
    col.appendChild(header);
    const cards = document.createElement('div');
    cards.className = 'col-cards';
    items.forEach(item => cards.appendChild(buildIdeaCard(item, null, { showStatus: true })));
    col.appendChild(cards);
    inner.appendChild(col);
  }

  function renderBoard() {
    if (filters.groupBy === 'epic') { renderBoardEpic(); return; }
    if (filters.groupBy === 'none') { renderBoardNone(); return; }

    const items = getDisplayItems();
    const grouped = {};
    STATUS_ORDER.forEach(s => { grouped[s] = []; });
    items.forEach(item => {
      const s = String(item.status || 'capture');
      if (grouped[s]) grouped[s].push(item);
      else if (grouped.capture) grouped.capture.push(item);
    });

    const inner = dom.boardInner;
    inner.innerHTML = '';

    const visibleStatuses = STATUS_ORDER.filter(s => grouped[s].length > 0 || !TERMINAL.has(s));

    if (items.length === 0) {
      inner.innerHTML = `
        <div class="empty-state" style="width:100%;">
          <div class="empty-icon">📋</div>
          <div class="empty-text">${searchResults !== null ? 'No search results' : 'No ideas yet'}</div>
        </div>`;
      return;
    }

    visibleStatuses.forEach(status => {
      const state = getColState(status);
      const isCollapsed = state.collapsed;

      const col = document.createElement('div');
      col.className = `column${isCollapsed ? ' collapsed' : ''}`;
      col.dataset.status = status;
      if (!isCollapsed) {
        col.style.width = state.width + 'px';
      }

      const count = grouped[status].length;

      // Build header
      const header = document.createElement('div');
      header.className = 'col-header';

      const dot = document.createElement('div');
      dot.className = `col-dot ${colDotClass(status)}`;

      const title = document.createElement('span');
      title.className = 'col-title';
      title.textContent = STATUS_LABELS[status];

      const countEl = document.createElement('span');
      countEl.className = 'col-count';
      countEl.textContent = count;

      const selectAllBtn = document.createElement('button');
      selectAllBtn.className = 'col-select-all-btn';
      selectAllBtn.title = 'Select all in column';
      selectAllBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>';
      selectAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const colIds = grouped[status].map(i => String(i.id));
        const allSelected = colIds.length > 0 && colIds.every(id => selectedIds.has(id));
        if (allSelected) {
          colIds.forEach(id => selectedIds.delete(id));
        } else {
          colIds.forEach(id => selectedIds.add(id));
        }
        lastClickedId = colIds[colIds.length - 1] || null;
        syncSelectionDom();
      });

      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'col-collapse-btn';
      collapseBtn.title = isCollapsed ? 'Expand column' : 'Collapse column';
      collapseBtn.innerHTML = CHEVRON_LEFT_SVG;
      collapseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapsed(status);
        render();
      });

      header.append(dot, title, countEl, selectAllBtn, collapseBtn);
      col.appendChild(header);

      // Click anywhere on collapsed column to expand
      if (isCollapsed) {
        col.addEventListener('click', (e) => {
          // Don't trigger if the collapse button itself was clicked (it handles its own)
          if (e.target.closest('.col-collapse-btn')) return;
          toggleCollapsed(status);
          render();
        });
      }

      if (!isCollapsed) {
        // Cards container
        const cards = document.createElement('div');
        cards.className = 'col-cards';

        /* Column drop zone handlers */
        cards.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (draggedFromStatus !== status) {
            col.classList.add('drag-over');
            ensurePlaceholder(cards);
          }
        });

        cards.addEventListener('dragleave', (e) => {
          if (!col.contains(e.relatedTarget)) {
            col.classList.remove('drag-over');
            const ph = cards.querySelector('.drop-placeholder');
            if (ph) ph.remove();
          }
        });

        cards.addEventListener('drop', async (e) => {
          e.preventDefault();
          clearAllDragOver();
          if (!draggedIdeaId || draggedFromStatus === status) return;
          const id = draggedIdeaId;
          const to = status;
          draggedIdeaId = null;
          draggedFromStatus = null;
          await moveIdea(id, to);
        });

        grouped[status].forEach(item => {
          cards.appendChild(buildIdeaCard(item, status));
        });

        col.appendChild(cards);

        // Resize handle
        const handle = document.createElement('div');
        handle.className = 'col-resize-handle';
        initResize(handle, col, status);
        col.appendChild(handle);
      }

      inner.appendChild(col);
    });
  }

  function renderListItem(item, container) {
    const el = document.createElement('div');
    el.className = 'list-item';

    const id = String(item.id || '');
    const status = String(item.status || 'capture');
    const listText = String(item.summary || item.snippet || item.description || item.content || '').trim();
    const topics = Array.isArray(item.topics) ? item.topics : [];

    let html = `<div class="li-status"><span class="col-dot ${colDotClass(status)}" style="width:8px;height:8px;"></span></div>`;
    html += `<div class="li-body">`;
    html += `<div class="li-content">${escapeHtml(listText || '(empty)')}</div>`;
    html += `<div class="li-meta">`;
    html += `<span class="card-id">${escapeHtml(id.slice(0, 6))}</span>`;
    topics.slice(0, 2).forEach(t => {
      html += `<span class="topic-pill">${escapeHtml(t)}</span>`;
    });
    if (topics.length > 2) html += `<span class="topic-pill">+${topics.length - 2}</span>`;
    html += `</div></div>`;

    el.innerHTML = html;
    el.dataset.ideaId = id;
    el.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        if (lastClickedId && lastClickedId !== id) {
          selectRange(lastClickedId, id);
        } else {
          toggleSelectId(id);
        }
        lastClickedId = id;
        return;
      }
      if (selectedIds.size > 0) {
        clearSelection();
        return;
      }
      openDetail(id);
    });
    container.appendChild(el);
  }

  function renderList() {
    const items = getDisplayItems();
    const container = dom.listView;
    container.innerHTML = '';

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📋</div>
          <div class="empty-text">${searchResults !== null ? 'No search results' : 'No ideas yet'}</div>
        </div>`;
      return;
    }

    if (filters.groupBy === 'epic') {
      const epicMap = {};
      epics.forEach(e => { epicMap[e.id] = e; });
      const grouped = {};
      items.forEach(item => {
        const key = String(item.epic_id || '__none__');
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(item);
      });
      const visibleEpics = filters.hideShipped ? epics.filter(e => !RESOLVED.has(e.status)) : epics;
      const epicIds = visibleEpics.map(e => e.id).filter(id => grouped[id]?.length > 0);
      if (grouped['__none__']?.length > 0) epicIds.push('__none__');
      epicIds.forEach(epicId => {
        const isUnassigned = epicId === '__none__';
        const epic = isUnassigned ? null : epicMap[epicId];
        const sectionItems = grouped[epicId] || [];
        const header = document.createElement('div');
        header.className = 'list-group-header';
        header.innerHTML = `<span class="list-group-dot cd-execute" style="${isUnassigned ? 'background:var(--muted);' : ''}"></span><span class="list-group-title">${escapeHtml(isUnassigned ? 'Unassigned' : (epic?.title || epicId))}</span><span class="list-group-count">${sectionItems.length}</span>`;
        container.appendChild(header);
        sectionItems.forEach(item => renderListItem(item, container));
      });
    } else if (filters.groupBy === 'status') {
      // Group by status with sticky headers
      const grouped = {};
      STATUS_ORDER.forEach(s => { grouped[s] = []; });
      items.forEach(item => {
        const s = String(item.status || 'capture');
        if (grouped[s]) grouped[s].push(item);
        else if (grouped.capture) grouped.capture.push(item);
      });
      const activeStatuses = STATUS_ORDER.filter(s => grouped[s].length > 0);
      activeStatuses.forEach(status => {
        const header = document.createElement('div');
        header.className = 'list-group-header';
        header.innerHTML = `<span class="list-group-dot ${colDotClass(status)}"></span><span class="list-group-title">${STATUS_LABELS[status]}</span><span class="list-group-count">${grouped[status].length}</span>`;
        container.appendChild(header);
        grouped[status].forEach(item => renderListItem(item, container));
      });
    } else {
      // No grouping — flat list
      items.forEach(item => renderListItem(item, container));
    }
  }

  function render() {
    if (currentView === 'board') renderBoard();
    else renderList();
    // Re-apply selection classes after DOM rebuild
    syncSelectionDom();
  }

  function switchView(view) {
    clearSelection();
    currentView = view;
    dom.tabBoard.classList.toggle('active', view === 'board');
    dom.tabList.classList.toggle('active', view === 'list');
    dom.boardView.classList.toggle('active', view === 'board');
    dom.listView.classList.toggle('active', view === 'list');
    render();
  }

  /* ── Events ──────────────────────────────────── */
  dom.tabBoard.addEventListener('click', () => switchView('board'));
  dom.tabList.addEventListener('click', () => switchView('list'));

  dom.projectFilter.addEventListener('change', async () => {
    searchResults = null;
    await Promise.all([loadItems(), loadEpics()]);
    populateFilterPopover();
    renderFilterChips();
    render();

  });

  /* ── Filter popover logic ────────────────────── */
  function openFilterPopover() {
    populateFilterPopover();
    dom.filterPopover.classList.add('open');
    dom.filterBackdrop.classList.add('open');
  }

  function closeFilterPopover() {
    dom.filterPopover.classList.remove('open');
    dom.filterBackdrop.classList.remove('open');
  }

  function populateFilterPopover() {
    // Group by pills
    dom.fpGroupBy.querySelectorAll('.fp-pill').forEach(pill => {
      pill.classList.toggle('active', pill.dataset.value === filters.groupBy);
    });

    // Status pills
    dom.fpStatus.innerHTML = '';
    STATUS_ORDER.forEach(s => {
      const pill = document.createElement('button');
      pill.className = 'fp-pill';
      pill.dataset.status = s;
      pill.textContent = STATUS_LABELS[s];
      if (filters.statuses.size === 0 || filters.statuses.has(s)) {
        pill.classList.add('active');
      }
      pill.addEventListener('click', () => {
        if (filters.statuses.size === 0) {
          // First click: select only this status
          filters.statuses = new Set([s]);
        } else if (filters.statuses.has(s)) {
          filters.statuses.delete(s);
          // If all removed, means "show all"
        } else {
          filters.statuses.add(s);
        }
        // If all statuses selected, clear (= show all)
        if (filters.statuses.size === STATUS_ORDER.length) filters.statuses = new Set();
        saveFilters();
        populateFilterPopover();
        renderFilterChips();
        render();
      });
      dom.fpStatus.appendChild(pill);
    });

    // Epic dropdown
    dom.fpEpic.innerHTML = '<option value="">Any</option><option value="__none__">Unassigned</option>';
    epics.forEach(e => {
      dom.fpEpic.innerHTML += `<option value="${escapeHtml(e.id)}">${escapeHtml(e.title || e.id)}</option>`;
    });
    dom.fpEpic.value = filters.epicId;

    // Topic pills
    const allTopics = getAllTopics();
    // Find or create topic pills container
    let topicPills = dom.fpTopic.parentElement.querySelector('.fp-topic-pills');
    if (!topicPills) {
      topicPills = document.createElement('div');
      topicPills.className = 'fp-topic-pills';
      dom.fpTopic.parentElement.appendChild(topicPills);
    }
    topicPills.innerHTML = '';
    const topicFilter = dom.fpTopic.value.toLowerCase().trim();
    const visibleTopics = topicFilter
      ? allTopics.filter(t => t.toLowerCase().includes(topicFilter))
      : allTopics.slice(0, 30);
    visibleTopics.forEach(t => {
      const pill = document.createElement('button');
      pill.className = `fp-topic-pill${filters.topics.has(t) ? ' active' : ''}`;
      pill.textContent = t;
      pill.addEventListener('click', () => {
        if (filters.topics.has(t)) filters.topics.delete(t);
        else filters.topics.add(t);
        saveFilters();
        populateFilterPopover();
        renderFilterChips();
        render();
      });
      topicPills.appendChild(pill);
    });
    if (allTopics.length > 30 && !topicFilter) {
      const more = document.createElement('span');
      more.className = 'fp-topic-pill';
      more.textContent = `+${allTopics.length - 30} more…`;
      more.style.cursor = 'default';
      more.style.opacity = '0.5';
      topicPills.appendChild(more);
    }

    // Hide shipped checkbox
    if (dom.fpHideShipped) {
      dom.fpHideShipped.checked = filters.hideShipped;
      // Remove old listener to avoid stacking
      dom.fpHideShipped.onchange = () => {
        filters.hideShipped = dom.fpHideShipped.checked;
        saveFilters();
        renderFilterChips();
        render();
      };
    }
  }

  function renderFilterChips() {
    dom.filterChips.innerHTML = '';
    const active = hasActiveFilters();
    dom.filterToggle.classList.toggle('has-filters', active);

    if (filters.statuses.size > 0 && filters.statuses.size < STATUS_ORDER.length) {
      const names = [...filters.statuses].map(s => STATUS_LABELS[s] || s).join(', ');
      addChip(`Status: ${names}`, () => { filters.statuses = new Set(); saveFilters(); renderFilterChips(); render(); });
    }

    if (filters.epicId) {
      const epicMap = {};
      epics.forEach(e => { epicMap[e.id] = e; });
      const label = filters.epicId === '__none__' ? 'Unassigned' : (epicMap[filters.epicId]?.title || filters.epicId.slice(0, 8));
      addChip(`Epic: ${label}`, () => { filters.epicId = ''; saveFilters(); renderFilterChips(); render(); });
    }

    if (filters.topics.size > 0) {
      const label = [...filters.topics].slice(0, 3).join(', ') + (filters.topics.size > 3 ? ` +${filters.topics.size - 3}` : '');
      addChip(`Topics: ${label}`, () => { filters.topics = new Set(); saveFilters(); renderFilterChips(); render(); });
    }

    if (!filters.hideShipped) {
      addChip('Showing resolved', () => { filters.hideShipped = true; saveFilters(); renderFilterChips(); render(); });
    }

    // Show "Spawn Orchestrator" button when a real epic is filtered
    if (filters.epicId && filters.epicId !== '__none__') {
      const btn = document.createElement('button');
      btn.className = 'spawn-orchestrator-btn';
      btn.title = 'Spawn an orchestrator session for this epic';
      btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Orchestrate';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showOrchestratePopover(btn, (customPrompt, model) => spawnEpicOrchestrator(filters.epicId, customPrompt, model));
      });
      dom.filterChips.appendChild(btn);
    }
  }

  function addChip(text, onRemove) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    const label = document.createElement('span');
    label.className = 'filter-chip-label';
    label.textContent = text;
    chip.appendChild(label);
    const x = document.createElement('button');
    x.className = 'filter-chip-x';
    x.textContent = '×';
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    chip.appendChild(x);
    dom.filterChips.appendChild(chip);
  }

  // Filter toggle button
  dom.filterToggle.addEventListener('click', () => {
    if (dom.filterPopover.classList.contains('open')) closeFilterPopover();
    else openFilterPopover();
  });
  dom.filterBackdrop.addEventListener('click', closeFilterPopover);

  // Group by pills
  dom.fpGroupBy.addEventListener('click', (e) => {
    const pill = e.target.closest('.fp-pill');
    if (!pill) return;
    filters.groupBy = pill.dataset.value;
    saveFilters();
    dom.fpGroupBy.querySelectorAll('.fp-pill').forEach(p => p.classList.toggle('active', p.dataset.value === filters.groupBy));
    render();
  });

  // Epic dropdown
  dom.fpEpic.addEventListener('change', () => {
    filters.epicId = dom.fpEpic.value;
    saveFilters();
    renderFilterChips();
    render();
  });

  // Topic search input
  dom.fpTopic.addEventListener('input', () => {
    populateFilterPopover();
  });

  // Clear all
  dom.fpClear.addEventListener('click', () => {
    clearFilters();
    dom.fpTopic.value = '';
    populateFilterPopover();
    renderFilterChips();
    render();
  });

  // Search
  dom.searchToggle.addEventListener('click', () => {
    const isOpen = dom.searchBar.classList.toggle('open');
    if (isOpen) {
      dom.captureDrawer.classList.remove('open');
      dom.searchInput.focus();
    } else {
      searchResults = null;
      dom.searchInput.value = '';
      render();
    }
  });
  dom.searchClose.addEventListener('click', () => {
    dom.searchBar.classList.remove('open');
    searchResults = null;
    dom.searchInput.value = '';
    render();
  });
  dom.searchGoBtn.addEventListener('click', doSearch);
  dom.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  // Capture
  dom.captureToggle.addEventListener('click', () => {
    const isOpen = dom.captureDrawer.classList.toggle('open');
    if (isOpen) {
      dom.searchBar.classList.remove('open');
      dom.captureContent.focus();
    }
  });
  dom.captureClose.addEventListener('click', () => dom.captureDrawer.classList.remove('open'));
  dom.captureBtn.addEventListener('click', captureIdea);
  dom.captureContent.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) captureIdea();
  });

  // Detail panel
  dom.detailClose.addEventListener('click', closeDetail);
  dom.detailArchiveBtn.addEventListener('click', () => {
    if (openIdeaId) archiveIdea(openIdeaId);
  });
  dom.detailDeleteBtn.addEventListener('click', () => {
    if (openIdeaId) deleteIdea(openIdeaId);
  });
  dom.detailBackdrop.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dom.filterPopover.classList.contains('open')) closeFilterPopover();
      else if (openIdeaId) closeDetail();
    }
  });

  // Refresh
  dom.refreshBtn.addEventListener('click', async () => {
    if (searchResults !== null && dom.searchInput.value.trim()) {
      await doSearch();
    } else {
      await loadItems();
      render();
    }
  });

  /* ── Settings ────────────────────────────────── */

  // { defaultCwd: string, projectCwds: { [project]: string } }
  let settings = { defaultCwd: '', projectCwds: {} };

  async function loadSettings() {
    try {
      const data = await fetchJson('./api/settings');
      const s = data?.settings ?? {};
      if (typeof s.defaultCwd === 'string') settings.defaultCwd = s.defaultCwd;
      if (s.projectCwds && typeof s.projectCwds === 'object' && !Array.isArray(s.projectCwds)) {
        settings.projectCwds = s.projectCwds;
      }
    } catch { /* non-fatal — keep defaults */ }
  }

  async function saveSettings() {
    try {
      await fetchJson('./api/settings', {
        method: 'POST',
        body: JSON.stringify(settings),
      });
    } catch { /* ignore */ }
  }

  /** Return the best cwd for the given project name (or global fallback). */
  function cwdForProject(projectName) {
    if (projectName && settings.projectCwds[projectName]) {
      return settings.projectCwds[projectName];
    }
    return settings.defaultCwd || '';
  }

  /* ── Settings modal DOM ──────────────────────── */
  const domSettings = {
    backdrop:    document.getElementById('settingsBackdrop'),
    modal:       document.getElementById('settingsModal'),
    close:       document.getElementById('settingsClose'),
    save:        document.getElementById('settingsSave'),
    defaultCwd:  document.getElementById('settingDefaultCwd'),
    toggle:      document.getElementById('settingsToggle'),
    projectRows: document.getElementById('settingsProjectRows'),
  };

  function renderSettingsProjectRows() {
    domSettings.projectRows.innerHTML = '';
    if (!projects.length) return;
    projects.forEach(p => {
      const name = typeof p === 'string' ? p : (p.project || p.name || p.id || '');
      if (!name) return;
      const row = document.createElement('div');
      row.className = 'settings-field';
      row.innerHTML = `
        <label class="settings-label">${escapeHtml(name)}</label>
        <input data-project="${escapeHtml(name)}" value="${escapeHtml(settings.projectCwds[name] || '')}" placeholder="e.g. ~/Projects/${escapeHtml(name)}" />`;
      domSettings.projectRows.appendChild(row);
    });
  }

  function openSettings() {
    domSettings.defaultCwd.value = settings.defaultCwd;
    renderSettingsProjectRows();
    domSettings.backdrop.classList.add('open');
    domSettings.modal.classList.add('open');
    domSettings.defaultCwd.focus();
  }

  function closeSettings() {
    domSettings.backdrop.classList.remove('open');
    domSettings.modal.classList.remove('open');
  }

  domSettings.toggle.addEventListener('click', openSettings);
  domSettings.close.addEventListener('click', closeSettings);
  domSettings.backdrop.addEventListener('click', closeSettings);

  domSettings.save.addEventListener('click', async () => {
    settings.defaultCwd = domSettings.defaultCwd.value.trim();
    settings.projectCwds = {};
    domSettings.projectRows.querySelectorAll('input[data-project]').forEach(input => {
      const val = input.value.trim();
      if (val) settings.projectCwds[input.dataset.project] = val;
    });
    await saveSettings();
    closeSettings();
    showToast('Settings saved');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && domSettings.modal.classList.contains('open')) closeSettings();
  });

  /* ── Spawn session (from detail panel) ────────── */
  const detailSpawnPromptEl = document.getElementById('detailSpawnPrompt');
  const detailSpawnBtnEl    = document.getElementById('detailSpawnBtn');
  const detailSpawnModelEl  = document.getElementById('detailSpawnModel');

  let spawning = false;

  /** Build a Godmother context block from an idea object. */
  function buildIdeaContext(item) {
    const topics = Array.isArray(item.topics) ? item.topics : [];
    const description = (item.description || item.snippet || item.content || '').trim();

    const rows = [
      ['ID',      item.id            || '—'],
      ['Project', item.project       || '—'],
      ['Status',  item.status        || '—'],
      ['Topics',  topics.join(', ')  || '—'],
      ['Summary', item.summary       || '—'],
    ];

    const lines = [];
    lines.push('## Godmother Idea');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    for (const [field, value] of rows) {
      lines.push(`| ${field} | ${value} |`);
    }
    lines.push('');
    lines.push(`To fetch full details: \`mcp_godmother_get_idea(id: "${item.id}")\``);

    if (description) {
      lines.push('');
      lines.push('### Description');
      lines.push('');
      lines.push(description);
    }

    return lines.join('\n');
  }

  /** Spawn a session pre-loaded with the given idea's context. */
  async function spawnFromDetail(item) {
    if (spawning || !item) return;

    const customPrompt = detailSpawnPromptEl.value.trim();
    const contextBlock = buildIdeaContext(item);
    const fullPrompt = customPrompt
      ? `${contextBlock}\n\n---\n\n${customPrompt}`
      : contextBlock;
    const model = parseModelValue(detailSpawnModelEl?.value);

    const cwd = cwdForProject(item.project || '') || undefined;

    spawning = true;
    detailSpawnBtnEl.disabled = true;
    detailSpawnBtnEl.textContent = 'Spawning…';

    try {
      const data = await fetchJson('./api/spawn-session', {
        method: 'POST',
        body: JSON.stringify({
          cwd,
          prompt: fullPrompt,
          ...(model ? { model } : {}),
        }),
      });
      detailSpawnPromptEl.value = '';
      showToast(`Session spawned ✓  ${data.sessionId ? data.sessionId.slice(0, 8) : ''}`);
    } catch (err) {
      showToast(`Spawn failed: ${err.message}`, true);
    } finally {
      spawning = false;
      detailSpawnBtnEl.disabled = false;
      detailSpawnBtnEl.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Spawn Session';
    }
  }

  // Single persistent click listener — reads _currentItem set by renderDetail
  detailSpawnBtnEl.addEventListener('click', () => spawnFromDetail(detailSpawnBtnEl._currentItem));

  /* ── Orchestrate popover ─────────────────── */
  let orchestratePopoverEl = null;

  function showOrchestratePopover(anchorEl, onConfirm) {
    closeOrchestratePopover();

    const popover = document.createElement('div');
    popover.className = 'orchestrate-popover';
    popover.innerHTML = `
      <div class="detail-spawn-row">
        <label class="detail-spawn-label" for="orchestrateModelSelect">Model</label>
        <select id="orchestrateModelSelect" class="detail-spawn-model fp-select" data-model-select>
          <option value="">Runner default</option>
        </select>
      </div>
      <label class="orchestrate-popover-label">Custom instructions <span class="orchestrate-optional">(optional)</span></label>
      <textarea class="orchestrate-popover-textarea" placeholder="e.g. Focus on backend changes only, skip UI work…" rows="3"></textarea>
      <div class="orchestrate-popover-actions">
        <button class="btn btn-ghost orchestrate-cancel-btn">Cancel</button>
        <button class="btn btn-primary orchestrate-confirm-btn">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Spawn
        </button>
      </div>
    `;

    // Position relative to anchor
    document.body.appendChild(popover);
    const rect = anchorEl.getBoundingClientRect();
    popover.style.top = (rect.bottom + 6) + 'px';
    popover.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 310)) + 'px';

    requestAnimationFrame(() => popover.classList.add('open'));
    orchestratePopoverEl = popover;

    const textarea = popover.querySelector('.orchestrate-popover-textarea');
    const confirmBtn = popover.querySelector('.orchestrate-confirm-btn');
    const cancelBtn = popover.querySelector('.orchestrate-cancel-btn');
    const modelSelect = popover.querySelector('[data-model-select]');

    populateModelSelects();
    textarea.focus();

    confirmBtn.addEventListener('click', () => {
      const val = textarea.value.trim();
      const model = parseModelValue(modelSelect?.value);
      closeOrchestratePopover();
      onConfirm(val || '', model);
    });
    cancelBtn.addEventListener('click', () => closeOrchestratePopover());

    // Close on outside click (next tick to avoid catching the trigger click)
    setTimeout(() => {
      document.addEventListener('click', orchestrateOutsideClick);
    }, 0);

    // Ctrl/Cmd+Enter to confirm
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        confirmBtn.click();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeOrchestratePopover();
      }
    });
  }

  function orchestrateOutsideClick(e) {
    if (orchestratePopoverEl && !orchestratePopoverEl.contains(e.target)) {
      closeOrchestratePopover();
    }
  }

  function closeOrchestratePopover() {
    document.removeEventListener('click', orchestrateOutsideClick);
    if (orchestratePopoverEl) {
      orchestratePopoverEl.remove();
      orchestratePopoverEl = null;
    }
  }

  /** Spawn an orchestrator session for an explicit list of ideas. */
  async function spawnItemsOrchestrator(items, customPrompt, selectedModel) {
    if (spawning || !items.length) return;

    // Determine project from first item (for cwd lookup)
    const project = items[0]?.project || '';

    const lines = [];
    lines.push(`## Orchestrator`);
    lines.push('');
    lines.push(`You are an orchestrator for the following Godmother ideas. Your job is to review them, plan the work, and dispatch subagents to execute each idea. Use the Godmother MCP tools to fetch full details for each idea as needed.`);
    lines.push('');
    lines.push(`### Ideas (${items.length})`);
    lines.push('');
    lines.push('| # | Status | Project | Summary | ID |');
    lines.push('|---|--------|---------|---------|-----|');
    items.forEach((item, i) => {
      const summary = (item.summary || item.description || '').slice(0, 80);
      lines.push(`| ${i + 1} | ${item.status || '—'} | ${item.project || '—'} | ${summary} | ${item.id} |`);
    });
    lines.push('');
    lines.push(`To fetch full idea details: \`mcp_godmother_get_idea(id: "<id>")\``);

    if (customPrompt) {
      lines.push('');
      lines.push(`### Additional Instructions`);
      lines.push('');
      lines.push(customPrompt);
    }

    const cwd = cwdForProject(project) || undefined;

    spawning = true;
    try {
      const data = await fetchJson('./api/spawn-session', {
        method: 'POST',
        body: JSON.stringify({
          cwd,
          prompt: lines.join('\n'),
          ...(selectedModel ? { model: selectedModel } : {}),
        }),
      });
      showToast(`Orchestrator spawned ✓  ${data.sessionId ? data.sessionId.slice(0, 8) : ''}`);
      clearSelection();
    } catch (err) {
      showToast(`Spawn failed: ${err.message}`, true);
    } finally {
      spawning = false;
    }
  }

  /** Spawn an orchestrator session for an entire epic. */
  async function spawnEpicOrchestrator(epicId, customPrompt, selectedModel) {
    if (spawning) return;

    const epicMap = {};
    epics.forEach(e => { epicMap[e.id] = e; });
    const epic = epicMap[epicId];
    if (!epic) { showToast('Epic not found', true); return; }

    // Gather all ideas belonging to this epic
    const epicItems = allItems.filter(i => String(i.epic_id) === epicId);

    // Build context prompt
    const lines = [];
    lines.push(`## Epic Orchestrator`);
    lines.push('');
    lines.push(`You are an orchestrator for the following Godmother epic. Your job is to review the ideas in this epic, plan the work, and dispatch subagents to execute each idea. Use the Godmother MCP tools to fetch full details for each idea as needed.`);
    lines.push('');
    lines.push(`### Epic: ${epic.title}`);
    if (epic.description) { lines.push(''); lines.push(epic.description); }
    lines.push('');
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| ID | ${epic.id} |`);
    lines.push(`| Project | ${epic.project || '—'} |`);
    lines.push(`| Status | ${epic.status || '—'} |`);
    lines.push('');
    lines.push(`### Ideas (${epicItems.length})`);
    lines.push('');

    if (epicItems.length === 0) {
      lines.push('_No ideas assigned to this epic yet._');
    } else {
      lines.push('| # | Status | Summary | ID |');
      lines.push('|---|--------|---------|-----|');
      epicItems.forEach((item, i) => {
        const summary = (item.summary || item.description || '').slice(0, 80);
        lines.push(`| ${i + 1} | ${item.status || '—'} | ${summary} | ${item.id} |`);
      });
    }

    lines.push('');
    lines.push(`To fetch full idea details: \`mcp_godmother_get_idea(id: "<id>")\``);
    lines.push(`To fetch epic details: \`mcp_godmother_get_epic(id: "${epic.id}")\``);

    if (customPrompt) {
      lines.push('');
      lines.push(`### Additional Instructions`);
      lines.push('');
      lines.push(customPrompt);
    }

    const cwd = cwdForProject(epic.project || '') || undefined;

    spawning = true;
    const btn = dom.filterChips.querySelector('.spawn-orchestrator-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Spawning…'; }

    try {
      const data = await fetchJson('./api/spawn-session', {
        method: 'POST',
        body: JSON.stringify({
          cwd,
          prompt: lines.join('\n'),
          ...(selectedModel ? { model: selectedModel } : {}),
        }),
      });
      showToast(`Orchestrator spawned ✓  ${data.sessionId ? data.sessionId.slice(0, 8) : ''}`);
    } catch (err) {
      showToast(`Spawn failed: ${err.message}`, true);
    } finally {
      spawning = false;
      renderFilterChips(); // re-render to restore button state
    }
  }

  // Expand/collapse toggle
  const detailSpawnToggleEl = document.getElementById('detailSpawnToggle');
  const detailSpawnBodyEl   = document.getElementById('detailSpawnBody');
  detailSpawnToggleEl.addEventListener('click', () => {
    const expanded = detailSpawnBodyEl.classList.toggle('open');
    detailSpawnToggleEl.setAttribute('aria-expanded', String(expanded));
    if (expanded) detailSpawnPromptEl.focus();
  });

  /* ── Bootstrap ───────────────────────────────── */
  async function boot() {
    loadColumnState();
    loadFilters();
    const startup = readStartupState();
    await loadSettings();

    try {
      const health = await fetchJson('./api/health');
      if (!health.ok) throw new Error(health.error || 'MCP not ready');
      setConnectionStatus(true, 'Connected');
    } catch (err) {
      setConnectionStatus(false, err.message);
      return;
    }

    await loadModels();
    await loadProjects();
    applyStartupState(startup);

    await Promise.all([loadItems(), loadEpics()]);
    renderFilterChips();
    switchView(currentView);

    if (startup.searchQuery) {
      await doSearch();
    }

    if (startup.ideaId) {
      openDetail(startup.ideaId);
    }
  }

  boot();
})();
