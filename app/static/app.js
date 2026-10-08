// Pixiv Vault SPA
const $ = (sel) => document.querySelector(sel);
const app = document.getElementById('app');

// 程序化换层/恢复滚动期间挂起“滚动记忆”：DOM 重建产生的瞬时滚动、
// 以及上一层的延迟/合并 scroll 事件，都会按“事件时 curLevel”错记到新层，故须挂起。
let _scrollRestoring = false;
let _scrollRestoreGen = 0;

const state = {
  view: 'browse',
  // 浏览状态
  authors: [],
  entries: [],
  characters: [],
  images: [],
  breadcrumb: [],
  scrollPosByLevel: {},  // 每层滚动位置（0=作者 1=系列 2=角色 3=图片），面包屑返回时恢复
  curLevel: 0,         // 0=作者 1=系列 2=角色 3=图片
  searchMode: false,   // true=全库搜索视图（仅 Enter 触发）
  searchQuery: '',
  searchResults: null, // 最近一次全库搜索结果（返回原地恢复用）
  returnTo: null,      // {query, results, scrollY}：从搜索结果进入图片层时记录
  _viewBeforeSearch: null, // 打开搜索前的视图（取消搜索后回到它）
  // 排序（localStorage 持久化）
  sortMode: localStorage.getItem('pixiv_sort') === 'name' ? 'name' : 'date',  // 默认按日期
  // 查看器
  viewer: null,
  dlMode: 'tag',        // 'collection' | 'tag'
  previewMeta: null,
  selectedTags: [],     // 按点击顺序的已选标签
  tasks: {},            // task_id -> { el: {status, bar, log}, done }
  _pollTimer: null,
};

const ICONS = {
  folder: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
  image: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5L6 21"/></svg>',
  film: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>',
  chevron: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  back: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  close: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  search: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/></svg>',
  sort: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M8 4v14"/><path d="m4.5 14.5 3.5 3.5 3.5-3.5"/><path d="M16 20V6"/><path d="m12.5 9.5 3.5-3.5 3.5 3.5"/></svg>',
  refresh: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 4v5h-5"/></svg>',
  shuffle: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.35" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.35" fill="currentColor" stroke="none"/></svg>',
};

function showView(name) {
  if (state.view !== name) cleanupViewerOnTabSwitch();
  state.view = name;
  state.searchMode = false;
  state.searchQuery = '';
  state.returnTo = null;
  closeMenu();
  syncChrome();
  if (name === 'browse') renderBrowse();
  if (name === 'download') renderDownload();
  if (name === 'settings') renderSettings();
}

// 切换 tab 时清理查看器资源（动图定时器/Viewer.js），避免后台持续请求
function cleanupViewerOnTabSwitch() {
  _ugCancel = true;
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
  _ugAbortPending();
  _ugImgs = []; _ugFrameData = [];  // 释放预加载帧内存
  if (_viewer) { try { _viewer.destroy(); } catch (e) {} _viewer = null; }
  state.viewer = null;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return res.json();
}

// ================= 浏览视图 =================

function browseShell() {
  // 层内过滤已移除：搜索统一走右下搜索钮的全库搜索（Enter 触发）。
  // 顶/底固定 chrome 由 index.html 提供；面包屑是内容第一行，随内容滚动。
  return `
    <div class="page">
      <div id="breadcrumb"></div>
      <div id="content"></div>
    </div>`;
}

async function renderBrowse() {
  resetSearch();
  state.returnTo = null;
  state.curLevel = 0;
  state.breadcrumb = [];
  if (state.authors.length === 0) {
    const d = await api('/api/tree/authors');
    state.authors = d.authors;
  }
  state.scrollPosByLevel[0] = 0;
  app.innerHTML = browseShell();
  renderBreadcrumb();
  renderAuthors();
  _restoreScroll(0);
}

// ================= 全库搜索（唯一搜索语义 · 仅 Enter 触发） =================
// 输入不触发请求；仅回车调 /api/search（backend 内存索引，首次后台构建）。
// 结果即一层：点条目进图片层，返回原地恢复结果（state.returnTo）。
let _searchPoll = null;

const SEARCH_HISTORY_KEY = 'pixiv_search_history';
const SEARCH_HISTORY_MAX = 8;

function loadSearchHistory() {
  try { return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]').slice(0, SEARCH_HISTORY_MAX); }
  catch (e) { return []; }
}
function saveSearchHistory(q) {
  const h = loadSearchHistory().filter(x => x !== q);
  h.unshift(q);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(h.slice(0, SEARCH_HISTORY_MAX)));
}
function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HISTORY_KEY);
  renderSearchHistory();
}
function runSearchFromHistory(i) {
  const w = loadSearchHistory()[i];
  const inp = $('#search-input');
  if (!w || !inp) return;
  inp.value = w;
  runSearch(w, true);
}
function clearSearchInput() {
  const inp = $('#search-input');
  if (!inp) return;
  inp.value = '';
  const clr = $('.sclr');
  if (clr) clr.style.display = 'none';
  renderSearchHistory();
  inp.focus();
}

function searchShell() {
  // 底部搜索条：胶囊输入框 + 独立取消钮（返回），与固定 chrome 同层
  return `
    <div class="page">
      <div id="search-body"></div>
    </div>
    <div id="search-bar">
      <div class="sfield">
        <span class="sico">${ICONS.search}</span>
        <input id="search-input" type="search" placeholder="搜索角色 / 系列（全库 · 回车）" autocomplete="off" autocapitalize="off">
        <button class="sclr" onclick="clearSearchInput()" aria-label="清除">${ICONS.x}</button>
      </div>
      <button id="search-cancel" onclick="closeSearch()" title="返回" aria-label="返回">${ICONS.close}</button>
    </div>`;
}

// 挂载搜索视图（首次进入传 null；从结果返回时传 returnTo 以原地恢复）
function mountSearch(rt) {
  state.searchMode = true;
  state.searchQuery = (rt && rt.query) || '';
  app.innerHTML = searchShell();
  const inp = $('#search-input');
  if (inp) {
    inp.value = state.searchQuery;
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(inp.value.trim(), true); }
      else if (e.key === 'Escape') { closeSearch(); }
    });
    // 仅切换「清除」按钮可见性，不触发请求（搜索只由 Enter 触发）
    inp.addEventListener('input', () => {
      const clr = $('.sclr');
      if (clr) clr.style.display = inp.value ? 'flex' : 'none';
    });
    const clr0 = $('.sclr');
    if (clr0) clr0.style.display = inp.value ? 'flex' : 'none';  // 恢复结果时也要按值同步
    inp.focus();
  }
  if (rt && rt.results) {
    state.searchResults = rt.results;
    renderSearchResults(state.searchQuery, rt.results);
  } else {
    state.searchResults = null;
    renderSearchHistory();
  }
  syncChrome();
  closeMenu();
}

function openSearch() {
  if (state.searchMode) { const i = $('#search-input'); if (i) i.focus(); return; }
  // 记住来源视图：搜索是顶层视图，取消后应回到原 tab（而非固定回浏览）
  state._viewBeforeSearch = state.view;
  state.returnTo = null;
  cleanupViewerOnTabSwitch();
  mountSearch(null);
}

function closeSearch() {
  if (_searchPoll) { clearTimeout(_searchPoll); _searchPoll = null; }
  state.searchMode = false;
  state.searchQuery = '';
  state.searchResults = null;
  const back = state._viewBeforeSearch || 'browse';
  state._viewBeforeSearch = null;
  if (back !== 'browse') {
    showView(back);
  } else {
    renderLevelView();
    _restoreScroll(state.scrollPosByLevel[state.curLevel] || 0);  // 恢复离开层的滚动位置
  }
}

async function runSearch(q, remember) {
  if (!q) { renderSearchHistory(); return; }
  if (_searchPoll) { clearTimeout(_searchPoll); _searchPoll = null; }
  state.searchQuery = q;
  if (remember) saveSearchHistory(q);
  renderSearchLoading();
  await searchOnce(q);
}

async function searchOnce(q, attempt = 0) {
  let d;
  try { d = await api(`/api/search?q=${enc(q)}&limit=200`); }
  catch (e) { renderSearchError(String(e)); return; }
  if (d.state !== 'ready') {
    if (attempt >= 40) {  // ~60s 上限，NAS 持续不可读时避免无限轮询
      renderSearchError('索引构建超时（NAS 不可读？），稍后重试');
      return;
    }
    renderSearchLoading('正在构建全库索引（首次约 20s）…');
    _searchPoll = setTimeout(() => {
      if (state.searchMode && state.searchQuery === q) searchOnce(q, attempt + 1);
    }, 1500);
    return;
  }
  state.searchResults = d.results || [];
  renderSearchResults(q, state.searchResults);
}

function renderSearchLoading(msg) {
  const box = $('#search-body');
  if (!box) return;
  box.innerHTML = `<div class="text-center text-gray-400 py-16 text-sm fade-in">
    <div class="inline-block w-8 h-8 border-2 border-pixiv-blue border-t-transparent rounded-full animate-spin mb-3"></div>
    <div>${esc(msg || '搜索中…')}</div></div>`;
}

function renderSearchError(msg) {
  const box = $('#search-body');
  if (!box) return;
  box.innerHTML = `<div class="empty-hint">搜索失败：${esc(msg)}</div>`;
}

function renderSearchHistory() {
  const box = $('#search-body');
  if (!box) return;
  const h = loadSearchHistory();
  box.innerHTML = h.length ? `
    <div class="sect">搜索历史</div>
    <div class="chips">${h.map((w, i) => `<button class="chip" onclick="runSearchFromHistory(${i})">${esc(w)}</button>`).join('')}</div>
    <button class="linkbtn" onclick="clearSearchHistory()">清除历史</button>`
    : `<div class="empty-hint">输入关键词后按回车，跨作者搜索角色 / 系列</div>`;
}

function renderSearchResults(q, results) {
  const box = $('#search-body');
  if (!box) return;
  const header = results.length
    ? `<div class="text-xs text-gray-400 my-3">“${esc(q)}” 全库命中 <b style="color:var(--accent)">${results.length}</b> 个角色 / 系列</div>`
    : `<div class="text-xs text-gray-400 my-3">“${esc(q)}” 无跨作者命中</div>`;
  const rows = results.map(r => `
    <button onclick="jumpToChar('${esc(r.author)}','${esc(r.series)}','${esc(r.character)}')" class="row-item">
      <div class="row-th">${ICONS.image}</div>
      <div class="row-tx"><b>${esc(r.character)}</b><i>${esc(r.author)} › ${esc(r.series)}</i></div>
      <span class="row-chev">${ICONS.chevron}</span>
    </button>`).join('');
  box.innerHTML = `<div class="fade-in">${header}<div>${rows}</div></div>`;
}

// 搜索结果深链：进入图片层；记 returnTo 以便返回原地恢复结果
function jumpToChar(author, series, character) {
  if (state.searchMode) {
    state.returnTo = { query: state.searchQuery, results: state.searchResults || [], scrollY: window.scrollY };
    // 进入图片层即浏览上下文：否则 view 仍是 download/settings → 返回钮消失、returnTo 卡死
    state.view = 'browse';
    updateTabPill();
  } else {
    state.returnTo = null;
  }
  loadImages(author, series, character);
}

// 层级导航时重置搜索状态
function resetSearch() {
  state.searchMode = false;
  state.searchQuery = '';
  state.searchResults = null;
}

// 层内过滤已移除：保留空实现，使各层渲染始终走完整列表分支
function query() { return ''; }

function renderBreadcrumb() {
  const el = $('#breadcrumb');
  syncChrome();
  if (!el) return;
  if (state.searchMode) { el.innerHTML = ''; return; }
  const crumbs = state.breadcrumb;
  // 从搜索结果进入：只显示「搜索结果 › 当前项」。
  // 不暴露 author/series 层级——那些层的缓存数据属于上一次浏览的其它作者，
  // 显示成全路径会变成「点了没反应/串数据」的失效面包屑。
  if (state.returnTo) {
    const cur = crumbs.length ? crumbs[crumbs.length - 1] : '';
    // 与浏览面包屑统一：每一项可点，点 = 回到该项上层。
    // 搜索来源下当前项的「上层」= 搜索结果列表 → 点角色名即返回结果。
    el.innerHTML = `<div class="bc">
      <button class="bc-c root" onclick="goBack()">${ICONS.search}<span>搜索结果</span></button>
      ${cur ? `<span class="bc-s">›</span><button class="bc-c now" onclick="goBack()">${esc(cur)}</button>` : ''}
    </div>`;
    return;
  }
  // 正常层级：每一项都可点（含最后一项 → 上一层），最后一项高亮
  el.innerHTML = crumbs.length
    ? `<div class="bc">${crumbs.map((c, i) => `
        <button class="bc-c${i === crumbs.length - 1 ? ' now' : ''}" onclick="navCrumb(${i})">${esc(c)}</button>${i < crumbs.length - 1 ? '<span class="bc-s">›</span>' : ''}
      `).join('')}</div>`
    : '';
}

function navCrumb(i) {
  _saveScrollNow();          // 记录离开层位置（此刻 DOM 仍为旧层）
  state.returnTo = null;     // 面包屑返回 = 离开搜索来源
  state.breadcrumb = state.breadcrumb.slice(0, i);
  state.curLevel = i;
  resetSearch();
  renderLevelView();
  _restoreScroll(state.scrollPosByLevel[i]);
}

// ================= 固定 chrome：返回 / ⋯ 菜单 / 导航胶囊 =================

// 按当前 curLevel 渲染层级视图（不重新拉取数据）
function renderLevelView() {
  app.innerHTML = browseShell();
  renderBreadcrumb();   // 内部会 syncChrome()
  if (state.curLevel === 0) renderAuthors();
  else if (state.curLevel === 1) renderSeries();
  else if (state.curLevel === 2) renderCharacters();
  else renderImages();
}

// 同步固定 chrome：返回/标题、⋯ 可见性、底栏与搜索钮、胶囊选中
function syncChrome() {
  const searching = !!state.searchMode;
  // 搜索视图是顶层视图：不显示返回（用底部搜索条的独立取消钮退出）
  const canBack = !searching && state.view === 'browse' && (!!state.returnTo || state.curLevel > 0);

  const back = $('#btn-back');
  if (back) back.style.display = canBack ? '' : 'none';

  // 标题：搜索视图「搜索」；顶层显示 section 名（iOS 实践：顶层用标题而非返回）
  const titleEl = $('#page-title');
  if (titleEl) {
    let title = '';
    if (searching) title = '搜索';
    else if (!canBack) {
      title = state.view === 'download' ? '下载'
            : state.view === 'settings' ? '设置' : '浏览';
    }
    titleEl.textContent = title;
    titleEl.style.display = title ? 'flex' : 'none';
  }

  const menuBtn = $('#btn-menu');
  if (menuBtn) menuBtn.style.display = (state.view === 'browse' && !searching) ? '' : 'none';
  const tabbar = $('#tabbar');
  if (tabbar) tabbar.style.display = searching ? 'none' : '';
  const fab = $('#btn-search');
  if (fab) fab.style.display = searching ? 'none' : '';
  updateTabPill();
}

function updateTabPill() {
  const nav = $('#tabbar');
  if (!nav || nav.style.display === 'none') return;
  const segs = [...nav.querySelectorAll('.seg')];
  const i = Math.max(0, segs.findIndex(s => s.dataset.view === state.view));
  segs.forEach((s, k) => s.classList.toggle('on', k === i));
  const pill = $('#tab-pill');
  const s = segs[i];
  if (pill && s) {
    pill.style.width = s.offsetWidth + 'px';
    pill.style.transform = `translateX(${s.offsetLeft}px)`;  // offsetLeft 已相对 #tabbar(position:relative)
  }
}

// 统一的返回：仅浏览层级用（顶层/搜索视图不出现返回）
function goBack() {
  closeMenu();
  if (state.view !== 'browse') return;
  if (state.searchMode) { closeSearch(); return; }
  if (state.returnTo) {
    const rt = state.returnTo;
    state.returnTo = null;
    mountSearch(rt);
    requestAnimationFrame(() => window.scrollTo(0, rt.scrollY || 0));
    return;
  }
  if (state.curLevel > 0) navCrumb(state.curLevel - 1);
}

function closeMenu() {
  const p = $('#menu-pop');
  if (p) p.style.display = 'none';
}

function toggleMenu() {
  const p = $('#menu-pop');
  if (!p) return;
  if (p.style.display !== 'none') { closeMenu(); return; }
  renderMenu();
  p.style.display = 'block';
}

function renderMenu() {
  const p = $('#menu-pop');
  if (!p) return;
  const sortDate = state.sortMode !== 'name';
  // 选中态：图标转为 accent「纯色」，不加 badge
  p.innerHTML = [
    `<button class="mi${sortDate ? ' on' : ''}" onclick="menuSort('date')"><span class="mic">${ICONS.sort}</span><span class="k">排序：按日期</span></button>`,
    `<button class="mi${sortDate ? '' : ' on'}" onclick="menuSort('name')"><span class="mic">${ICONS.sort}</span><span class="k">排序：按名称</span></button>`,
    '<div class="msep"></div>',
    `<button class="mi" onclick="menuRefresh()"><span class="mic">${ICONS.refresh}</span><span class="k">刷新本层</span></button>`,
    `<button class="mi" onclick="menuRandom()"><span class="mic">${ICONS.shuffle}</span><span class="k">随机角色</span></button>`,
  ].join('');
}

function menuSort(mode) {
  state.sortMode = mode;
  localStorage.setItem('pixiv_sort', mode);
  closeMenu();
  if (!state.searchMode) renderLevelView();
}

function menuRefresh() {
  closeMenu();
  refreshLevel();
}

function menuRandom() {
  closeMenu();
  randomChar();
}

// 随机角色：走全库索引（首次需建索引 → 轮询后跳转）
async function randomChar(attempt = 0) {
  // 仅在浏览上下文轮询/跳转（切到下载/设置或进了搜索就放弃）
  if (state.view !== 'browse' || state.searchMode) return;
  let d;
  try { d = await api('/api/random'); }
  catch (e) { toast('随机角色失败：' + (e && e.message ? e.message : e)); return; }  // 不再静默
  if (d.state !== 'ready') {
    if (attempt >= 40) { toast('随机角色：索引构建超时'); return; }
    if (attempt === 0) toast('正在构建全库索引（首次约 20s）…');
    setTimeout(() => randomChar(attempt + 1), 1500);
    return;
  }
  if (!d.item) { toast('随机角色：索引为空'); return; }
  state.returnTo = null;
  jumpToChar(d.item.author, d.item.series, d.item.character);
}

let _toastTimer = null;
function toast(msg, ms = 1800) {
  const el = document.createElement('div');
  el.className = 'fixed left-1/2 -translate-x-1/2 z-[70] px-4 py-2 rounded-full text-white text-sm';
  el.style.background = 'rgba(28,28,30,.86)';
  el.style.bottom = 'calc(12px + var(--dock) + 16px + env(safe-area-inset-bottom))';
  el.textContent = msg;
  document.body.appendChild(el);
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.remove(), ms);
}

window.addEventListener('resize', () => { if (!state.searchMode) updateTabPill(); });

// 刷新当前层数据（不依赖浏览器缓存，重新拉取）；搜索态下重跑搜索
async function refreshLevel() {
  if (state.searchMode) {
    const q = state.searchQuery;
    if (q) await runSearch(q);
    return;
  }
  _saveScrollNow();
  const i = state.curLevel;
  const keep = state.scrollPosByLevel[i] || 0;
  if (i === 0) {
    const d = await api('/api/tree/authors');
    state.authors = d.authors;
    renderAuthors();
  } else if (i === 1) {
    const d = await api(`/api/tree/entries?author=${enc(state.breadcrumb[0])}`);
    state.entries = d.entries;
    renderSeries();
  } else if (i === 2) {
    const d = await api(`/api/tree/characters?author=${enc(state.breadcrumb[0])}&series=${enc(state.breadcrumb[1])}`);
    state.characters = d.characters;
    renderCharacters();
  } else if (i === 3) {
    const b = state.breadcrumb;
    const qs = b[2] ? `author=${enc(b[0])}&series=${enc(b[1])}&character=${enc(b[2])}` : `author=${enc(b[0])}&series=${enc(b[1])}`;
    const d = await api(`/api/tree/images?${qs}`);
    state.images = d.images;
    renderImages();
  }
  _restoreScroll(keep);
}

// 切换排序（名称/日期），持久化到 localStorage
function renderAuthors() {
  const q = query();
  const base = sortItems(state.authors, 'author');
  const list = q ? base.filter(a => a.author.toLowerCase().includes(q)) : base;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无匹配作者'); return; }
  content.innerHTML = list.map(a => `
    <button onclick="loadSeries('${esc(a.author)}')" class="row-item">
      <div class="row-th">${ICONS.folder}</div>
      <div class="row-tx"><b>${esc(a.author)}</b><i>作者 · ${fmtDate(a.mtime)}</i></div>
      <span class="row-chev">${ICONS.chevron}</span>
    </button>`).join('');
}

async function loadSeries(author) {
  const d = await api(`/api/tree/entries?author=${enc(author)}`);
  _saveScrollNow();
  state.entries = d.entries;
  state.returnTo = null;
  state.breadcrumb = [author];
  state.curLevel = 1;
  state.scrollPosByLevel[1] = 0;
  resetSearch();
  app.innerHTML = browseShell();
  renderBreadcrumb();
  renderSeries();
  _restoreScroll(0);
}

function renderSeries() {
  const q = query();
  const base = sortItems(state.entries, 'name');
  const list = q ? base.filter(e => (e.name || '').toLowerCase().includes(q)) : base;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无系列'); return; }
  content.innerHTML = list.map(e => {
    if (e.kind === 'ugoira') {
      return `<button onclick="openUgoiraDirect('${esc(e.author)}','${esc(e.name)}')" class="row-item">
        <div class="row-th">${ICONS.film}</div>
        <div class="row-tx"><b>${esc(e.name)}</b><i>动图 · ${fmtDate(e.mtime)}</i></div>
        <span class="row-chev">${ICONS.chevron}</span>
      </button>`;
    }
    const isFlat = e.kind === '_未分類' || e.kind === '_未分类';
    const label = isFlat ? '未分类' : '系列';
    const onclick = isFlat ? `loadImages('${esc(e.author)}','${esc(e.name)}')` : `loadCharacters('${esc(e.author)}','${esc(e.name)}')`;
    return `<button onclick="${onclick}" class="row-item">
      <div class="row-th">${ICONS.folder}</div>
      <div class="row-tx"><b>${esc(e.name)}</b><i>${label} · ${fmtDate(e.mtime)}</i></div>
      <span class="row-chev">${ICONS.chevron}</span>
    </button>`;
  }).join('');
}

async function loadCharacters(author, series) {
  const d = await api(`/api/tree/characters?author=${enc(author)}&series=${enc(series)}`);
  _saveScrollNow();
  state.characters = d.characters;
  state.returnTo = null;
  state.breadcrumb = [author, series];
  state.curLevel = 2;
  state.scrollPosByLevel[2] = 0;
  resetSearch();
  app.innerHTML = browseShell();
  renderBreadcrumb();
  renderCharacters();
  _restoreScroll(0);
}

function renderCharacters() {
  const q = query();
  const base = sortItems(state.characters, 'name');
  const list = q ? base.filter(c => (c.name || '').toLowerCase().includes(q)) : base;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无角色'); return; }
  content.innerHTML = list.map(c => {
    const icon = `<div class="row-th">${c.kind === 'ugoira' ? ICONS.film : ICONS.image}</div>`;
    const cb = c.kind === 'ugoira' ? `openUgoiraDirect('${esc(c.author)}','${esc(c.name)}')` : `loadImages('${esc(c.author)}','${esc(c.series)}','${esc(c.name)}')`;
    return `<button onclick="${cb}" class="row-item">
      ${icon}
      <div class="row-tx"><b>${esc(c.name)}</b><i>${c.kind === 'ugoira' ? '动图' : '角色'} · ${fmtDate(c.mtime)}</i></div>
      <span class="row-chev">${ICONS.chevron}</span>
    </button>`;
  }).join('');
}

// 角色层：直接展示同角色所有图片（平铺网格）；character 为空适配 _未分类 平铺
async function loadImages(author, series, character) {
  const qs = character ? `author=${enc(author)}&series=${enc(series)}&character=${enc(character)}` : `author=${enc(author)}&series=${enc(series)}`;
  const d = await api(`/api/tree/images?${qs}`);
  _saveScrollNow();
  state.images = d.images;
  state.breadcrumb = character ? [author, series, character] : [author, series];
  state.curLevel = 3;
  state.scrollPosByLevel[3] = 0;
  resetSearch();
  app.innerHTML = browseShell();
  renderBreadcrumb();
  renderImages();
  _restoreScroll(0);
}

function renderImages() {
  const q = query();
  const list = q ? state.images.filter(im => (im.id || '').toLowerCase().includes(q)) : state.images;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无图片'); return; }
  const grid = list.map((im) => {
    const thumb = `/api/thumb/file?rel=${enc(relPath(im, im.file))}`;
    const ugBadge = im.type === 'ugoira'
      ? `<div class="absolute top-1 right-1 w-5 h-5 rounded bg-black/60 text-white flex items-center justify-center">${ICONS.film}</div>`
      : '';
    return `<button onclick="openViewerAtByFile('${esc(im.file)}')" class="block w-full group relative">
      <div class="tilecard">
        <div class="grid-img bg-pixiv-light overflow-hidden flex items-center justify-center">
          <img src="${thumb}" loading="lazy" class="w-full h-full object-cover group-active:scale-95 transition"
            onerror="this.parentElement.innerHTML='<div class=&quot;w-full h-full flex items-center justify-center text-gray-300 text-xs&quot;>无</div>'">
        </div>
      </div>
      ${ugBadge}
    </button>`;
  }).join('');
  content.innerHTML = `<div class="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">${grid}</div>`;
}

function openViewerAtByFile(file) {
  const idx = state.images.findIndex(im => im.file === file);
  if (idx >= 0) openViewerAt(idx);
}

function relPath(im, file) {
  return `${im.author}/${im.series}/${im.character}/${file}`;
}

// ================= 查看器 =================

let _viewer = null;          // Viewer.js 实例（仅静态图）

// 从任意层级打开：图片列表（当前角色下的全部图片）
function openViewerAt(idx) {
  _saveScrollNow();  // 打开查看器前固定当前层位置（同步读 scrollY，不依赖事件时序）
  const im = state.images[idx];
  // 动图：独立播放器，不经 Viewer.js；支持同目录动图左右滑动切换
  if (im && im.type === 'ugoira') {
    const ugList = state.images.filter(x => x.type === 'ugoira');
    const ugIdx = ugList.findIndex(x => x.file === im.file);
    openUgoiraPlayer(ugList, Math.max(0, ugIdx));
    return;
  }
  // 静态图：Viewer.js 管理全部图片，从 idx 开始
  const staticItems = state.images
    .filter(x => x.type !== 'ugoira')
    .map(x => ({ ...x }));
  // 找到当前静态图在新列表中的索引
  const cur = state.images[idx];
  const start = staticItems.findIndex(x => x.file === cur.file);
  state.viewer = {
    pages: { list: staticItems, start: Math.max(0, start) },
    title: `${state.breadcrumb[2] || ''}`,
    animTimer: null,
  };
  renderViewer();
}

function openUgoiraDirect(author, base) {
  // 从当前层收集动图列表（作者层平铺 or 角色层 ugoira 条目）
  let list = [];
  if (state.curLevel === 1) {
    list = state.entries.filter(e => e.kind === 'ugoira' && e.author === author)
      .map(e => ({ type: 'ugoira', author: e.author, series: '', character: '', id: e.name }));
  } else if (state.curLevel === 2) {
    list = state.characters.filter(c => c.kind === 'ugoira' && c.author === author)
      .map(c => ({ type: 'ugoira', author: c.author, series: c.series, character: '', id: c.name }));
  }
  const idx = list.findIndex(x => x.id === base);
  openUgoiraPlayer(list.length ? list : [{ type: 'ugoira', author, series: '', character: '', id: base }], Math.max(0, idx));
}

function renderViewer() {
  const v = state.viewer;
  app.innerHTML = `
    <div id="viewer" class="fixed inset-0 z-[2025] overflow-hidden pointer-events-none">
      <ul class="viewer-list" style="display:none">
        ${v.pages.list.map((it, i) => `
          <li><img src="/api/img?author=${enc(it.author)}&series=${enc(it.series)}&character=${enc(it.character)}&file=${enc(it.file)}" data-idx="${i}"></li>
        `).join('')}
      </ul>
      <div class="absolute top-0 inset-x-0 bg-gradient-to-b from-black/70 to-transparent p-4 text-white flex items-center gap-3 z-[2020] pointer-events-auto" style="padding-top: calc(1rem + env(safe-area-inset-top))">
        <button onclick="hideViewer()" class="p-1 -ml-1 opacity-80">${ICONS.back}</button>
        <div class="flex-1 truncate text-sm">${esc(v.title || '')}</div>
        <div id="v-count" class="text-xs bg-black/40 rounded px-2 py-1"></div>
      </div>
    </div>`;
  const list = app.querySelector('.viewer-list');
  const imgs = list.querySelectorAll('img');
  imgs.forEach(img => {
    img.addEventListener('error', () => {
      img.src = '/api/thumb/file?rel=' + enc(relPath(v.pages.list[+img.dataset.idx], v.pages.list[+img.dataset.idx].file));
    });
  });
  _viewer = new Viewer(list, {
    initialView: v.pages.start,
    inline: false,
    title: false,
    backdrop: "static",   // 保留遮罩但禁用点击空白关闭，统一用返回按钮
    toolbar: {
      zoomIn: 1, zoomOut: 1, oneToOne: 1,
      reset: 1, prev: 1, play: 0, next: 1,
      rotateLeft: 0, rotateRight: 0, flipHorizontal: 0, flipVertical: 0,
      close: 0,
    },
    button: false,
    navbar: false,
    tooltip: false,
    movable: true,
    zoomable: true,
    rotatable: false,
    scalable: false,
    transition: false,
    fullscreen: false,
    // 键盘统一由 app.js 的 document keydown 路由（静态/动图共用）。
    // 关闭 Viewer.js 自带键盘，避免与自定义处理器叠加导致 ←/→ 一次跳两张。
    keyboard: false,
    viewed(e) {
      const idx = e.detail.index;
      $('#v-count').textContent = `${idx + 1}/${v.pages.list.length}`;
    },
    hidden() {
      if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
      destroyViewer();
      closeViewer();
    },
  });
  _viewer.show();
  _viewer.view(v.pages.start);
}

function destroyViewer() {
  if (_viewer) { try { _viewer.destroy(); } catch (e) {} _viewer = null; }
}

// ================= 动图独立播放器（不经 Viewer.js） =================

let _ugTimer = null;   // 动图播放定时器
let _ugCancel = false;  // 动图播放取消标志
let _ugActive = false;  // 动图播放器是否激活（键盘路由用）
let _ugPaused = false;  // 动图暂停状态

let _ugList = [];      // 当前播放器动图列表
let _ugIdx = 0;        // 当前动图索引
let _ugFrameData = []; // 当前动图 frames
let _ugImgs = [];      // 预加载帧 Image[]（播放零网络；生命周期=播放器，切换/关闭即释放）
let _ugPending = [];   // 预加载中的 Image（切换/关闭时置 src='' 中止在途请求）
let _ugGen = 0;        // 加载代际计数（滑动切换时使旧请求失效）

// 中止在途的帧预加载（置 src='' 让浏览器取消请求），并清空引用
function _ugAbortPending() {
  _ugPending.forEach(im => { try { im.src = ''; } catch (e) {} });
  _ugPending = [];
}

function toggleUgoiraPause() {
  if (!_ugActive) return;
  _ugPaused = !_ugPaused;
  if (_ugPaused) {
    if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  } else {
    _ugPlay();
  }
  const stage = $('#v-stage');
  if (stage) {
    const badge = stage.querySelector('.ug-pause-badge');
    if (_ugPaused && !badge) {
      const d = document.createElement('div');
      d.className = 'ug-pause-badge absolute top-3 left-3 text-xs bg-black/60 text-white rounded px-2 py-1 pointer-events-none';
      d.textContent = '已暂停';
      stage.appendChild(d);
    } else if (!_ugPaused && badge) {
      badge.remove();
    }
  }
}

function openUgoiraPlayer(ugList, idx) {
  _saveScrollNow();  // 打开前固定当前层位置
  _suspendScrollMemory();  // 覆盖层重建 DOM 时勿改动底层列表的滚动记忆
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
  _ugCancel = false;
  _ugActive = true;
  _ugPaused = false;
  _ugList = ugList;
  _ugIdx = idx;
  _ugFrameData = [];
  _ugImgs = [];
  _ugAbortPending();
  app.innerHTML = `
    <div id="viewer" class="fixed inset-0 bg-black z-[2025] overflow-hidden">
      <div id="v-stage" class="w-full h-full flex items-center justify-center touch-pan-y"></div>
      <div class="absolute top-0 inset-x-0 bg-gradient-to-b from-black/70 to-transparent p-4 text-white flex items-center gap-3 z-[2020]" style="padding-top: calc(1rem + env(safe-area-inset-top))">
        <button onclick="closeViewer()" class="p-1 -ml-1 opacity-80">${ICONS.back}</button>
        <div class="flex-1 truncate text-sm">${esc(ugList[idx].id)}</div>
        ${ugList.length > 1 ? `<div id="v-count" class="text-xs bg-black/40 rounded px-2 py-1">${idx + 1}/${ugList.length}</div>` : ''}
      </div>
    </div>`;
  const stage = $('#v-stage');
  stage.innerHTML = `<div class="text-white p-6 text-center text-sm fade-in">加载动图中…</div>`;
  bindUgoiraGestures(stage);
  loadUgoiraAt(_ugIdx);
}

function loadUgoiraAt(idx) {
  if (_ugCancel) return;
  const gen = ++_ugGen;
  _ugIdx = idx;
  _ugPaused = false;
  _ugImgs = [];  // 释放上一部动图的预加载帧
  _ugAbortPending();  // 中止上一部动图在途的帧请求
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  const item = _ugList[idx];
  const stage = $('#v-stage');
  stage.innerHTML = `<div class="text-white p-6 text-center text-sm fade-in">加载动图中…</div>`;
  const titleEl = document.querySelector('#viewer .flex-1.truncate');
  if (titleEl) titleEl.textContent = item.id;
  const cntEl = $('#v-count');
  if (cntEl) cntEl.textContent = `${idx + 1}/${_ugList.length}`;
  const qs = `author=${enc(item.author)}&base=${enc(item.id)}&series=${enc(item.series || '')}&character=${enc(item.character || '')}`;
  const frameUrl = (f) => `/api/ugoira/frame?${qs}&file=${enc(f.file)}`;
  fetch(`/api/ugoira/frames?${qs}`)
    .then(res => { if (!res.ok) throw new Error('frames 请求失败'); return res.json(); })
    .then(frames => {
      if (_ugCancel || gen !== _ugGen || !Array.isArray(frames) || frames.length === 0) throw new Error('无帧数据');
      _ugFrameData = frames;
      stage.innerHTML = `<div class="text-white p-6 text-center"><canvas id="v-canvas"></canvas></div>`;
      // 预加载全部帧到内存 Image：播放期间零网络请求（生命周期=播放器实例，切换/关闭即释放）。
      // 帧响应带 Cache-Control/ETag（见 app/main.py），跨次打开走浏览器缓存/304。
      return Promise.all(frames.map(f => new Promise((res, rej) => {
        const im = new Image();
        _ugPending.push(im);
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('帧加载失败: ' + f.file));
        im.src = frameUrl(f);
      })));
     })
    .then(imgs => {
      if (_ugCancel || gen !== _ugGen) return;
      _ugPending = [];  // 已全部加载，脱离中止集合（勿与 _ugImgs 重引用）
      const canvas = $('#v-canvas');
      if (!canvas) return;
      const W = imgs[0].naturalWidth, H = imgs[0].naturalHeight;
      const maxW = window.innerWidth - 32, maxH = window.innerHeight * 0.6;
      const r = Math.min(maxW / W, maxH / H, 1);
      canvas.width = W; canvas.height = H;
      canvas.style.width = (W * r) + 'px'; canvas.style.height = (H * r) + 'px';
      canvas.getContext('2d').drawImage(imgs[0], 0, 0, W, H);  // 首帧（单帧动图也显示）
      _ugImgs = imgs;
      _ugPlay();
    })
    .catch(err => {
      if (!_ugCancel && gen === _ugGen) stage.innerHTML = `<div class="text-white/70 p-6 text-center text-sm">动图加载失败: ${esc(err.message)}</div>`;
    });
}

// 动图帧播放调度（从内存预加载帧绘制，零网络；暂停后恢复也走这里）
function _ugPlay() {
  if (_ugCancel || _ugPaused) return;
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  const canvas = $('#v-canvas');
  const frames = _ugFrameData;
  const imgs = _ugImgs;
  if (!canvas || !frames || frames.length < 2 || imgs.length !== frames.length) return;
  const ctx = canvas.getContext('2d');
  const gen = _ugGen;
  let fi = 1 % frames.length;  // 首帧已由 loadUgoiraAt 绘制
  const step = () => {
    if (_ugCancel || _ugPaused || gen !== _ugGen) return;
    const im = imgs[fi];
    if (im) ctx.drawImage(im, 0, 0, canvas.width, canvas.height);
    const delay = frames[fi].delay || 120;
    fi = (fi + 1) % frames.length;
    _ugTimer = setTimeout(step, delay);
  };
  _ugTimer = setTimeout(step, frames[0].delay || 120);
}

function bindUgoiraGestures(stage) {
  let sx = 0, sy = 0, tracking = false;
  stage.addEventListener('pointerdown', e => {
    tracking = true; sx = e.clientX; sy = e.clientY;
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointerup', e => {
    if (!tracking) return;
    tracking = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0 && _ugIdx < _ugList.length - 1) loadUgoiraAt(_ugIdx + 1);
      else if (dx > 0 && _ugIdx > 0) loadUgoiraAt(_ugIdx - 1);
    }
  });
  stage.addEventListener('pointercancel', () => { tracking = false; });
}

function hideViewer() {
  if (_viewer) _viewer.hide();
  else closeViewer();
}

function closeViewer() {
  _ugCancel = true;
  _ugActive = false;
  _ugPaused = false;
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  _ugAbortPending();  // 中止在途帧请求
  _ugImgs = []; _ugFrameData = [];  // 释放预加载帧内存
  if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
  destroyViewer();
  state.viewer = null;
  // 恢复原列表
  if (state.curLevel === 3 && state.images.length) {
    app.innerHTML = browseShell();
    renderBreadcrumb();
    renderImages();
    _restoreScroll(state.scrollPosByLevel[3]);
  } else if (state.curLevel === 2) {
    loadCharacters(state.breadcrumb[0], state.breadcrumb[1]);
  } else if (state.curLevel === 1) {
    loadSeries(state.breadcrumb[0]);
  } else {
    renderBrowse();
  }
}

function nextPage() { if (_viewer) _viewer.next(); }
function prevPage() { if (_viewer) _viewer.prev(); }

// 键盘：静态 viewer（Viewer.js）或动图播放器
document.addEventListener('keydown', (e) => {
  if (_ugActive) {
    if (e.key === 'ArrowRight' && _ugIdx < _ugList.length - 1) loadUgoiraAt(_ugIdx + 1);
    else if (e.key === 'ArrowLeft' && _ugIdx > 0) loadUgoiraAt(_ugIdx - 1);
    else if (e.key === 'Escape') closeViewer();
    else if (e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); toggleUgoiraPause(); }
    return;
  }
  if (!state.viewer) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); nextPage(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); prevPage(); }
  if (e.key === 'Escape') hideViewer();
});

// 记录列表滚动位置（按当前层级）；仅浏览态、非搜索、非查看器且未挂起时记录
window.addEventListener('scroll', () => {
  if (state.view !== 'browse' || state.searchMode || state.viewer || _scrollRestoring) return;
  state.scrollPosByLevel[state.curLevel] = window.scrollY;
});

// 立即记录“离开层”的滚动位置（DOM 仍为旧层，window.scrollY 即真实位置）
function _saveScrollNow() {
  if (state.view !== 'browse' || state.searchMode || state.viewer) return;
  state.scrollPosByLevel[state.curLevel] = window.scrollY;
}

// 两帧后解除挂起（此时换层与恢复引发的 scroll 事件均已派发完）；代际守卫防提前解挂
function _endScrollSuspend(gen) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen === _scrollRestoreGen) _scrollRestoring = false;
  }));
}

// 恢复某层滚动位置（挂起期间不写记忆）
function _restoreScroll(y) {
  _scrollRestoring = true;
  const gen = ++_scrollRestoreGen;
  requestAnimationFrame(() => {
    window.scrollTo(0, y || 0);
    _endScrollSuspend(gen);
  });
}

// 仅挂起记忆、不滚动（如打开动图播放器覆盖层，底层列表位置需保原样）
function _suspendScrollMemory() {
  _scrollRestoring = true;
  _endScrollSuspend(++_scrollRestoreGen);
}

// ================= 工具函数 =================

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function enc(s) { return encodeURIComponent(s ?? ''); }
function empty(msg) { return `<div class="text-center text-gray-400 py-10 text-sm">${msg}</div>`; }

// 按名称或日期排序（日期降序：最新在前；名称升序）
function sortItems(items, nameKey) {
  const arr = [...items];
  if (state.sortMode === 'date') {
    arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  } else {
    arr.sort((a, b) => String(a[nameKey] || '').localeCompare(String(b[nameKey] || ''), 'zh-Hans-CN'));
  }
  return arr;
}

// mtime 时间戳 → 可读日期
function fmtDate(ts) {
  if (!ts) return '未知';
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ================= 下载视图 =================

function renderDownload() {
  // 切回下载 tab：丢弃上一次会话的 DOM 引用与轮询，从服务端重新拉取任务
  if (state._pollTimer) { clearInterval(state._pollTimer); state._pollTimer = null; }
  state.tasks = {};
  app.innerHTML = `
    <div class="page py-4">
      <div class="flex gap-2 mb-4">
        <input id="dl-url" type="text" placeholder="粘贴 pixiv 链接 (artworks/{id})" class="field flex-1 min-w-0">
        <button id="dl-preview" onclick="doPreview()" class="btn-primary">预览</button>
      </div>
      <div id="dl-result"></div>
      <div id="dl-task-list" class="mt-4"></div>
    </div>`;
  // 拉取服务端已有任务（含快捷指令 API 触发的），渲染下载中/失败任务
  syncChrome();
  loadServerTasks();
}

// 拉取服务端全部下载任务并渲染（复用 showTask 轮询机制）
async function loadServerTasks() {
  const list = $('#dl-task-list');
  if (!list) return;
  try {
    const d = await api('/api/download');
    for (const t of d.tasks) {
      if (state.tasks[t.task_id]) continue;  // 本会话已跟踪的跳过
      showTask(t, {
        url: t.url,
        series: t.series,
        characters: t.characters,
        is_collection: t.is_collection,
      });
      // 立即渲染状态/按钮（否则已终结任务会短暂显示失效的取消按钮）
      updateTaskUI(t.task_id, t);
    }
  } catch (e) {
    // 列表拉取失败不影响手工创建任务
  }
}

async function doPreview() {
  const url = $('#dl-url').value.trim();
  const result = $('#dl-result');
  if (!url) return;
  const m = url.match(/(?:artworks|illust)\/(\d+)/);
  if (!m) { result.innerHTML = '<div class="text-red-500 text-sm">链接格式不正确</div>'; return; }
  const wid = m[1];
  result.innerHTML = '<div class="skeleton h-32 w-full"></div>';
  try {
    const p = await api('/api/download/preview/' + wid, { method: 'POST' });
    renderPreview(p);
  } catch (err) {
    result.innerHTML = `<div class="text-red-500 text-sm p-4" style="background:#FFF4F3;border-radius:var(--r-tile)">预览失败: ${esc(err.message)}</div>`;
  }
}

function renderPreview(p) {
  const r18 = p.xRestrict > 0;
  state.previewMeta = p;
  state.dlMode = 'tag';
  state.selectedTags = [];
  $('#dl-result').innerHTML = `
    <div class="card p-4">
      <div class="flex items-start gap-3 mb-3">
        <div class="row-th" style="width:var(--ctrl);height:var(--ctrl)">${p.is_ugoira ? ICONS.film : ICONS.image}</div>
        <div class="row-tx">
          <b>${esc(p.title)}</b>
          <i>by ${esc(p.userName)}</i>
          <div class="flex gap-1.5 mt-1.5 flex-wrap">
            ${r18 ? '<span class="badge danger">R-18</span>' : ''}
            ${p.is_ugoira ? `<span class="badge alt">动图 ${p.ugoira.frames}帧</span>` : ''}
            <span class="badge">${p.pageCount} 页</span>
          </div>
        </div>
      </div>
      <div class="text-sm font-medium mb-2">归档方式</div>
      <div class="grid grid-cols-2 gap-2 mb-3">
        <button id="mode-collection" onclick="setDlMode('collection')" class="btn-ghost" style="width:100%">Collection</button>
        <button id="mode-tag" onclick="setDlMode('tag')" class="btn-primary" style="width:100%">标签选择</button>
      </div>
      <div id="dl-mode-body">
        <div class="text-xs text-gray-500 mb-2">点击标签选择：首个 = 系列，其余 = 角色；「无系列」表示不设系列</div>
        <div id="tag-picker" class="flex flex-wrap gap-2 mb-2"></div>
        <div id="pick-tip" class="text-xs text-gray-500 mb-4 min-h-4">未选择（将归档到 _未分类）</div>
      </div>
      <div class="flex gap-2">
        <button id="dl-start" onclick="startDownload('${p.id}')" class="btn-primary" style="flex:1">开始下载</button>
        <button onclick="renderDownload()" class="btn-ghost">取消</button>
      </div>
    </div>`;
  renderTagPicker(p.tags);
}

function setDlMode(mode) {
  state.dlMode = mode;
  const p = state.previewMeta;
  const colBtn = $('#mode-collection');
  const tagBtn = $('#mode-tag');
  const body = $('#dl-mode-body');
  const active = 'btn-primary', idle = 'btn-ghost';
  colBtn.className = mode === 'collection' ? active : idle;
  tagBtn.className = mode === 'tag' ? active : idle;
  colBtn.style.width = '100%'; tagBtn.style.width = '100%';
  if (mode === 'collection') {
    body.innerHTML = `
      <div class="text-xs text-gray-500 mb-4 card p-3">归档到 <span class="font-medium">Collections/${esc(p.id)}_${esc(p.title)}</span>。用于无系列/无正式名称角色（网络热梗、原创角色等）。若需按系列/角色归档请切换到「标签选择」。</div>`;
  } else {
    body.innerHTML = `
      <div class="text-xs text-gray-500 mb-2">点击标签选择：首个 = 系列，其余 = 角色；「无系列」表示不设系列</div>
      <div id="tag-picker" class="flex flex-wrap gap-2 mb-2"></div>
      <div id="pick-tip" class="text-xs text-gray-500 mb-4 min-h-4">未选择（将归档到 _未分类）</div>`;
    renderTagPicker(p.tags);
  }
}

function renderTagPicker(tags) {
  const picker = $('#tag-picker');
  picker.innerHTML = [...tags, '无系列'].map(t => `
    <button data-tag="${esc(t)}" class="chip" onclick="toggleTag(this)">${esc(t)}</button>`).join('');
  // 渲染已选状态
  state.selectedTags.forEach(t => {
    const el = picker.querySelector(`.chip[data-tag="${CSS.escape(t)}"]`);
    if (el) el.classList.add('chip-on');
  });
  classifyPicked();
}

// 系列/角色按点击顺序：selectedTags[0] = 系列，其余 = 角色；「无系列」置顶时无系列
function classifyPicked() {
  const chips = [...document.querySelectorAll('#tag-picker .chip')];
  chips.forEach(c => c.classList.remove('chip-series', 'chip-character'));
  const on = state.selectedTags || [];
  let series = null, characters = [];
  if (on.length > 0) {
    if (on[0] === '无系列') {
      series = null;
      characters = on.slice(1);
    } else {
      series = on[0];
      characters = on.slice(1).filter(t => t !== '无系列');
    }
  }
  chips.forEach(c => {
    if (c.dataset.tag === series) c.classList.add('chip-series');
    else if (characters.includes(c.dataset.tag)) c.classList.add('chip-character');
  });
  const tip = $('#pick-tip');
  if (tip) {
    tip.textContent = series ? `系列：${series}${characters.length ? '｜角色：' + characters.join('、') : ''}`
      : characters.length ? `角色：${characters.join('、')}（无系列，将归档到 _未分类）`
      : '未选择（将归档到 _未分类）';
  }
  return { series, characters };
}

function toggleTag(el) {
  const tag = el.dataset.tag;
  const idx = (state.selectedTags || []).indexOf(tag);
  if (idx >= 0) {
    state.selectedTags.splice(idx, 1);
    el.classList.remove('chip-on');
  } else {
    state.selectedTags.push(tag);
    el.classList.add('chip-on');
    // 「无系列」置顶：清除已选系列（原系列转为角色）
    if (tag === '无系列') {
      const others = state.selectedTags.filter(t => t !== '无系列');
      state.selectedTags = ['无系列', ...others];
    }
  }
  classifyPicked();
}

function startDownload(workId, opts = {}) {
  const url = opts.url !== undefined ? opts.url : $('#dl-url').value.trim();
  let series = opts.series !== undefined ? opts.series : null;
  let characters = opts.characters !== undefined ? opts.characters : [];
  let isCollection = opts.is_collection !== undefined ? opts.is_collection : false;
  if (opts.url === undefined) {
    if (state.dlMode === 'collection') {
      isCollection = true;
    } else {
      const c = classifyPicked();
      series = c.series; characters = c.characters;
    }
  }
  const btn = $('#dl-start');
  if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
  api('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, series, characters, is_collection: isCollection })
  }).then(task => {
    // 清空输入框并重置预览区域（仅 UI 发起时）
    if (opts.url === undefined) {
      $('#dl-url').value = '';
      state.previewMeta = null;
      state.selectedTags = [];
      const r = $('#dl-result');
      if (r) r.innerHTML = '';
    }
    if (btn) { btn.disabled = false; btn.textContent = '开始下载'; }
    showTask(task, { url, series, characters, is_collection: isCollection });
  }).catch(err => {
    if (btn) { btn.disabled = false; btn.textContent = '开始下载'; }
    alert('下载任务创建失败: ' + err.message);
  });
}

function showTask(task, meta) {
  const list = $('#dl-task-list');
  if (!list) return;
  const id = task.task_id;
  const div = document.createElement('div');
  div.className = 'card p-4 mb-3';
  div.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <div class="font-medium text-sm">作品 ${esc(task.work_id)}</div>
      <div class="task-status text-xs"></div>
    </div>
    <div class="h-2 bg-gray-100 rounded-full overflow-hidden mb-2">
      <div class="task-bar h-full bg-pixiv-blue transition-all" style="width:0%"></div>
    </div>
    <div class="task-log text-xs text-gray-500 max-h-32 overflow-auto bg-gray-50 font-mono" style="border-radius:var(--r-tile);padding:8px"></div>
    <div class="flex gap-2 mt-2 task-actions">
      <button class="task-cancel btn-danger">取消</button>
    </div>`;
  list.insertBefore(div, list.firstChild);  // 新任务置顶
  const entry = {
    statusEl: div.querySelector('.task-status'),
    barEl: div.querySelector('.task-bar'),
    logEl: div.querySelector('.task-log'),
    actionsEl: div.querySelector('.task-actions'),
    meta: meta || {},
  };
  div.querySelector('.task-cancel').onclick = () => cancelTask(id);
  state.tasks[id] = entry;
  ensurePolling();
}

function ensurePolling() {
  if (state._pollTimer) return;
  state._pollTimer = setInterval(pollAllTasks, 2000);
}

async function pollAllTasks() {
  const ids = Object.keys(state.tasks);
  if (ids.length === 0) {
    clearInterval(state._pollTimer);
    state._pollTimer = null;
    return;
  }
  for (const id of ids) {
    const entry = state.tasks[id];
    if (!entry || entry.done) continue;
    try {
      const t = await api('/api/download/' + id);
      updateTaskUI(id, t);
    } catch (e) {
      // 任务不存在则自动清除
      const e2 = state.tasks[id];
      if (e2) {
        const div = divOf(e2);
        if (div) div.remove();
        delete state.tasks[id];
      }
    }
  }
}

function updateTaskUI(id, t) {
  const entry = state.tasks[id];
  if (!entry) return;
  const pct = t.total > 0 ? Math.round(t.progress / t.total * 100) : 0;
  entry.barEl.style.width = pct + '%';
  let label;
  if (t.status === 'running') label = `${pct}%`;
  else if (t.status === 'done') label = `<span style="color:var(--ok);margin-right:2px">${ICONS.check}</span>完成 → ${esc(t.target || '')}`;
  else if (t.status === 'error') label = `<span style="color:var(--danger);margin-right:2px">${ICONS.x}</span>${esc(t.error || '失败')}`;
  else if (t.status === 'cancelled') label = '已取消';
  else if (t.status === 'queued') label = '排队中…';
  else label = esc(String(t.status));
  entry.statusEl.innerHTML = label;
  if (t.log && t.log.length) {
    entry.logEl.innerHTML = t.log.map(l => esc(l)).join('<br>');
    entry.logEl.scrollTop = entry.logEl.scrollHeight;
  }
  if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
    entry.done = true;
    // 终结状态隐藏取消按钮（任务已结束，无法取消）
    const cancelBtn = divOf(entry).querySelector('.task-cancel');
    if (cancelBtn) cancelBtn.remove();
    // 失败时显示「重试」按钮（点击重试会清除原任务）
    if (t.status === 'error' && entry.meta && entry.meta.url) {
      if (!entry.retryBtn) {
        const btn = document.createElement('button');
        btn.className = 'btn-accent-ghost';
        btn.textContent = '重试';
        btn.onclick = () => retryTask(entry.meta);
        entry.actionsEl.appendChild(btn);
        entry.retryBtn = btn;
      }
    }
    // 下载完成（done）自动清除；错误/取消保留供查看/重试
    if (t.status === 'done') {
      setTimeout(() => clearTask(id), 2500);
    }
  }
}

async function clearTask(taskId) {
  try {
    await api('/api/download/' + taskId + '/clear', { method: 'DELETE' });
  } catch (e) {
    // 服务端已无该任务（如已被其他会话清除）时仍允许本地移除；其余错误提示
    if (!String(e.message).includes('404')) {
      alert('清除失败: ' + e.message);
      return;
    }
  }
  const entry = state.tasks[taskId];
  if (entry) {
    const div = divOf(entry);
    if (div) div.remove();
    delete state.tasks[taskId];
  }
}

function divOf(entry) {
  return entry.actionsEl ? entry.actionsEl.closest('.card') : null;
}

function retryTask(meta) {
  // 找到原任务并清除（服务端 DELETE + 本地移除），然后重新下载
  const id = state.tasks && Object.keys(state.tasks).find(k => {
    const e = state.tasks[k];
    return e && e.meta === meta;
  });
  if (id) clearTask(id);
  const m = meta.url.match(/(?:artworks|illust)\/(\d+)/);
  const wid = m ? m[1] : '';
  startDownload(wid, meta);
}

async function cancelTask(taskId) {
  await api('/api/download/' + taskId, { method: 'DELETE' });
  pollAllTasks();
}

// ================= 设置视图 =================

async function renderSettings() {
  const d = await api('/api/config');
  const cfg = d.config;
  app.innerHTML = `
    <div class="page py-4">
      <div class="card p-4 mb-4">
        <div class="font-medium mb-3">网络代理</div>
        <div class="grid grid-cols-3 gap-2 mb-3">
          <select id="cfg-scheme" class="field">
            <option value="">直连</option><option value="http">HTTP</option>
            <option value="https">HTTPS</option><option value="socks5">SOCKS5</option>
          </select>
          <input id="cfg-host" placeholder="host" value="${esc(cfg.proxy.host)}" class="field">
          <input id="cfg-port" placeholder="port" value="${esc(cfg.proxy.port)}" class="field">
        </div>
        <button onclick="saveConfig()" class="btn-primary">保存配置</button>
      </div>
      <div class="card p-4 mb-4">
        <div class="font-medium mb-2">cookies 状态</div>
        <div id="cookie-status" class="text-sm text-gray-500">${d.cookies.ok ? 'cookies 有效' : 'cookies 无效: ' + esc(d.cookies.reason)}</div>
      </div>
      <div class="card p-4">
        <div class="font-medium mb-2">数据目录</div>
        <div class="text-sm text-gray-500 break-all">${esc(d.root)}</div>
      </div>
    </div>`;
  const s = document.getElementById('cfg-scheme');
  if (s) s.value = cfg.proxy.scheme || '';
  syncChrome();
}

async function saveConfig() {
  const scheme = $('#cfg-scheme').value;
  const host = $('#cfg-host').value.trim();
  const port = $('#cfg-port').value.trim();
  await api('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proxy: { scheme, host, port } })
  });
  alert('配置已保存');
}

// 初始化
showView('browse');
