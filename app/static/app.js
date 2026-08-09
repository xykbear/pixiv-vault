// Pixiv Vault SPA
const $ = (sel) => document.querySelector(sel);
const app = document.getElementById('app');

const state = {
  view: 'browse',
  // 浏览状态
  authors: [],
  entries: [],
  characters: [],
  images: [],
  breadcrumb: [],
  scrollPos: 0,        // 列表滚动位置（关闭查看器后恢复）
  curLevel: 0,         // 0=作者 1=系列 2=角色 3=图片
  // 查看器
  viewer: null,
  dlMode: 'tag',        // 'orig' | 'tag'
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
  search: '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
  check: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

function showView(name) {
  if (state.view !== name) cleanupViewerOnTabSwitch();
  state.view = name;
  ['browse', 'download', 'settings'].forEach(v => {
    const nav = document.getElementById('nav-' + v);
    if (v === name) {
      nav.classList.remove('text-gray-400', 'border-transparent');
      nav.classList.add('text-pixiv-blue', 'border-pixiv-blue');
    } else {
      nav.classList.add('text-gray-400', 'border-transparent');
      nav.classList.remove('text-pixiv-blue', 'border-pixiv-blue');
    }
  });
  if (name === 'browse') renderBrowse();
  if (name === 'download') renderDownload();
  if (name === 'settings') renderSettings();
}

// 切换 tab 时清理查看器资源（动图定时器/Viewer.js），避免后台持续请求
function cleanupViewerOnTabSwitch() {
  _ugCancel = true;
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
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
  return `
    <div class="max-w-4xl mx-auto">
      <div class="sticky top-0 z-40 bg-pixiv-light/95 backdrop-blur px-4 pt-3 pb-2">
        <div id="breadcrumb" class="text-sm text-gray-500 mb-2 flex items-center gap-1 flex-wrap overflow-x-auto no-scrollbar"></div>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">${ICONS.search}</span>
          <input id="search" type="search" placeholder="搜索" autocomplete="off"
            class="w-full pl-10 pr-4 py-2.5 rounded-lg border border-pixiv-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-pixiv-blue/30">
        </div>
      </div>
      <div id="content" class="px-4 py-3"></div>
    </div>`;
}

async function renderBrowse() {
  state.curLevel = 0;
  state.breadcrumb = [];
  state.scrollPos = 0;
  if (state.authors.length === 0) {
    const d = await api('/api/tree/authors');
    state.authors = d.authors;
  }
  app.innerHTML = browseShell();
  bindSearch();
  renderBreadcrumb();
  renderAuthors();
}

function bindSearch() {
  const s = $('#search');
  if (s) s.addEventListener('input', filterCurrent);
}

function filterCurrent() {
  if (state.curLevel === 0) renderAuthors();
  else if (state.curLevel === 1) renderSeries();
  else if (state.curLevel === 2) renderCharacters();
  else if (state.curLevel === 3) renderImages();
}

function query() {
  return ($('#search')?.value || '').toLowerCase().trim();
}

function renderBreadcrumb() {
  const el = $('#breadcrumb');
  if (!el) return;
  const crumbs = state.breadcrumb;
  el.innerHTML = crumbs.length ? crumbs.map((c, i) => `
    <button class="text-pixiv-blue shrink-0" onclick="navCrumb(${i})">${esc(c)}</button>${i < crumbs.length - 1 ? '<span class="mx-1 text-gray-300">›</span>' : ''}
  `).join('') : '';
}

function navCrumb(i) {
  if (i === 0) { renderBrowse(); return; }
  if (i === 1) { loadSeries(state.breadcrumb[0]); return; }
  if (i === 2) { loadCharacters(state.breadcrumb[0], state.breadcrumb[1]); return; }
}

function renderAuthors() {
  const q = query();
  const list = q ? state.authors.filter(a => a.author.toLowerCase().includes(q)) : state.authors;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无匹配作者'); return; }
  content.innerHTML = list.map(a => `
    <button onclick="loadSeries('${esc(a.author)}')"
      class="w-full text-left bg-white rounded-lg p-3 mb-2 border border-pixiv-border hover:shadow-sm transition flex items-center gap-3">
      <div class="w-10 h-10 rounded-md bg-pixiv-light flex items-center justify-center text-pixiv-blue shrink-0">${ICONS.folder}</div>
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">${esc(a.author)}</div>
        <div class="text-xs text-gray-400">作者</div>
      </div>
      <span class="text-gray-300">${ICONS.chevron}</span>
    </button>`).join('');
}

async function loadSeries(author) {
  const d = await api(`/api/tree/entries?author=${enc(author)}`);
  state.entries = d.entries;
  state.breadcrumb = [author];
  state.curLevel = 1;
  state.scrollPos = 0;
  app.innerHTML = browseShell();
  bindSearch();
  renderBreadcrumb();
  renderSeries();
}

function renderSeries() {
  const q = query();
  const list = q ? state.entries.filter(e => (e.name || '').toLowerCase().includes(q)) : state.entries;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无系列'); return; }
  content.innerHTML = list.map(e => {
    if (e.kind === 'ugoira') {
      return `<button onclick="openUgoiraDirect('${esc(e.author)}','${esc(e.name)}')"
        class="w-full text-left bg-white rounded-lg p-3 mb-2 border border-pixiv-border hover:shadow-sm transition flex items-center gap-3">
        <div class="w-10 h-10 rounded-md bg-purple-50 text-purple-500 flex items-center justify-center shrink-0">${ICONS.film}</div>
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${esc(e.name)}</div>
          <div class="text-xs text-gray-400">动图</div>
        </div>
        <span class="text-gray-300">${ICONS.chevron}</span>
      </button>`;
    }
    const isFlat = e.kind === 'オリジナル' || e.kind === '_未分類' || e.kind === '_未分类';
    const label = isFlat ? (e.kind === 'オリジナル' ? 'オリジナル' : '未分类') : '系列';
    const onclick = isFlat ? `loadImages('${esc(e.author)}','${esc(e.name)}')` : `loadCharacters('${esc(e.author)}','${esc(e.name)}')`;
    return `<button onclick="${onclick}"
      class="w-full text-left bg-white rounded-lg p-3 mb-2 border border-pixiv-border hover:shadow-sm transition flex items-center gap-3">
      <div class="w-10 h-10 rounded-md bg-pixiv-light text-pixiv-blue flex items-center justify-center shrink-0">${ICONS.folder}</div>
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">${esc(e.name)}</div>
        <div class="text-xs text-gray-400">${label}</div>
      </div>
      <span class="text-gray-300">${ICONS.chevron}</span>
    </button>`;
  }).join('');
}

async function loadCharacters(author, series) {
  const d = await api(`/api/tree/characters?author=${enc(author)}&series=${enc(series)}`);
  state.characters = d.characters;
  state.breadcrumb = [author, series];
  state.curLevel = 2;
  state.scrollPos = 0;
  app.innerHTML = browseShell();
  bindSearch();
  renderBreadcrumb();
  renderCharacters();
}

function renderCharacters() {
  const q = query();
  const list = q ? state.characters.filter(c => (c.name || '').toLowerCase().includes(q)) : state.characters;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无角色'); return; }
  content.innerHTML = list.map(c => {
    const icon = c.kind === 'ugoira'
      ? '<div class="w-10 h-10 rounded-md bg-purple-50 text-purple-500 flex items-center justify-center shrink-0">' + ICONS.film + '</div>'
      : '<div class="w-10 h-10 rounded-md bg-pixiv-light text-pixiv-blue flex items-center justify-center shrink-0">' + ICONS.image + '</div>';
    const cb = c.kind === 'ugoira' ? `openUgoiraDirect('${esc(c.author)}','${esc(c.name)}')` : `loadImages('${esc(c.author)}','${esc(c.series)}','${esc(c.name)}')`;
    return `<button onclick="${cb}"
      class="w-full text-left bg-white rounded-lg p-3 mb-2 border border-pixiv-border hover:shadow-sm transition flex items-center gap-3">
      ${icon}
      <div class="flex-1 min-w-0">
        <div class="font-medium truncate">${esc(c.name)}</div>
        <div class="text-xs text-gray-400">${c.kind === 'ugoira' ? '动图' : '角色'}</div>
      </div>
      <span class="text-gray-300">${ICONS.chevron}</span>
    </button>`;
  }).join('');
}

// 角色层：直接展示同角色所有图片（平铺网格）；character 为空适配 オリジナル/未分类 平铺
async function loadImages(author, series, character) {
  const qs = character ? `author=${enc(author)}&series=${enc(series)}&character=${enc(character)}` : `author=${enc(author)}&series=${enc(series)}`;
  const d = await api(`/api/tree/images?${qs}`);
  state.images = d.images;
  state.breadcrumb = character ? [author, series, character] : [author, series];
  state.curLevel = 3;
  state.scrollPos = 0;
  app.innerHTML = browseShell();
  bindSearch();
  renderBreadcrumb();
  renderImages();
}

function renderImages() {
  const q = query();
  const list = q ? state.images.filter(im => (im.id || '').toLowerCase().includes(q)) : state.images;
  const content = $('#content');
  if (!list.length) { content.innerHTML = empty('无图片'); return; }
  const grid = list.map((im, idx) => {
    const thumb = im.type === 'ugoira'
      ? `/api/thumb/file?rel=${enc(relPath(im, im.file))}`
      : `/api/thumb/file?rel=${enc(relPath(im, im.file))}`;
    return `<button onclick="openViewerAt(${idx})" class="block w-full group">
      <div class="bg-white rounded-lg overflow-hidden border border-pixiv-border">
        <div class="grid-img bg-pixiv-light overflow-hidden flex items-center justify-center">
          <img src="${thumb}" loading="lazy" class="w-full h-full object-cover group-active:scale-95 transition"
            onerror="this.parentElement.innerHTML='<div class=&quot;w-full h-full flex items-center justify-center text-gray-300 text-xs&quot;>无</div>'">
        </div>
      </div>
    </button>`;
  }).join('');
  content.innerHTML = `<div class="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">${grid}</div>`;
}

function relPath(im, file) {
  return `${im.author}/${im.series}/${im.character}/${file}`;
}

// ================= 查看器 =================

let _viewer = null;          // Viewer.js 实例（仅静态图）

// 从任意层级打开：图片列表（当前角色下的全部图片）
function openViewerAt(idx) {
  const im = state.images[idx];
  // 动图：独立播放器，不经 Viewer.js
  if (im && im.type === 'ugoira') {
    openUgoiraPlayer(im);
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
  openUgoiraPlayer({ type: 'ugoira', author, series: '', character: '', id: base });
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
    keyboard: true,
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

function openUgoiraPlayer(item) {
  if (_ugTimer) { clearInterval(_ugTimer); _ugTimer = null; }
  if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
  _ugCancel = false;
  app.innerHTML = `
    <div id="viewer" class="fixed inset-0 bg-black z-[2025] overflow-hidden">
      <div id="v-stage" class="w-full h-full flex items-center justify-center"></div>
      <div class="absolute top-0 inset-x-0 bg-gradient-to-b from-black/70 to-transparent p-4 text-white flex items-center gap-3 z-[2020]" style="padding-top: calc(1rem + env(safe-area-inset-top))">
        <button onclick="closeViewer()" class="p-1 -ml-1 opacity-80">${ICONS.back}</button>
        <div class="flex-1 truncate text-sm">${esc(item.id)}</div>
      </div>
    </div>`;
  const stage = $('#v-stage');
  stage.innerHTML = `<div class="text-white p-6 text-center text-sm fade-in">加载动图中…</div>`;
  const author = item.author;
  const base = item.id;
  fetch(`/api/ugoira/frames?author=${enc(author)}&base=${enc(base)}`)
    .then(res => { if (!res.ok) throw new Error('frames 请求失败'); return res.json(); })
    .then(frames => {
      if (_ugCancel || !Array.isArray(frames) || frames.length === 0) throw new Error('无帧数据');
      stage.innerHTML = `<div class="text-white p-6 text-center"><canvas id="v-canvas"></canvas></div>`;
      const canvas = $('#v-canvas');
      const ctx = canvas.getContext('2d');
      const img = new Image();
      img.src = `/api/ugoira/frame?author=${enc(author)}&base=${enc(base)}&file=${enc(frames[0].file)}`;
      return new Promise((res, rej) => {
        img.onload = () => res({ frames, img });
        img.onerror = () => rej(new Error('首帧加载失败'));
      });
    })
    .then(({ frames, img }) => {
      if (_ugCancel) return;
      const W = img.naturalWidth, H = img.naturalHeight;
      const maxW = window.innerWidth - 32, maxH = window.innerHeight * 0.6;
      const r = Math.min(maxW / W, maxH / H, 1);
      const canvas = $('#v-canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = W; canvas.height = H;
      canvas.style.width = (W * r) + 'px'; canvas.style.height = (H * r) + 'px';
      ctx.drawImage(img, 0, 0, W, H);
      let fi = 1;
      let loading = false;
      const tick = () => {
        if (_ugCancel) return;
        if (loading) return;
        loading = true;
        ctx.drawImage(img, 0, 0, W, H);
        const nf = frames[fi];
        fi = (fi + 1) % frames.length;
        img.onload = () => { loading = false; if (!_ugCancel) _ugTimer = setTimeout(tick, nf.delay || 120); };
        img.onerror = () => { loading = false; if (!_ugCancel) _ugTimer = setTimeout(tick, nf.delay || 120); };
        img.src = `/api/ugoira/frame?author=${enc(author)}&base=${enc(base)}&file=${enc(nf.file)}`;
      };
      _ugTimer = setTimeout(tick, frames[0].delay || 120);
    })
    .catch(err => {
      if (!_ugCancel) stage.innerHTML = `<div class="text-white/70 p-6 text-center text-sm">动图加载失败: ${esc(err.message)}</div>`;
    });
}

function hideViewer() {
  if (_viewer) _viewer.hide();
  else closeViewer();
}

function closeViewer() {
  _ugCancel = true;
  if (_ugTimer) { clearTimeout(_ugTimer); _ugTimer = null; }
  if (state.viewer && state.viewer.animTimer) clearInterval(state.viewer.animTimer);
  destroyViewer();
  state.viewer = null;
  // 恢复原列表
  if (state.curLevel === 3 && state.images.length) {
    app.innerHTML = browseShell();
    bindSearch();
    renderBreadcrumb();
    renderImages();
    requestAnimationFrame(() => {
      window.scrollTo(0, state.scrollPos);
    });
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

// 键盘
document.addEventListener('keydown', (e) => {
  if (!state.viewer) return;
  if (e.key === 'ArrowRight') nextPage();
  if (e.key === 'ArrowLeft') prevPage();
  if (e.key === 'Escape') hideViewer();
});

// 记录列表滚动位置
window.addEventListener('scroll', () => {
  if (!state.viewer) state.scrollPos = window.scrollY;
});

// ================= 工具函数 =================

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function enc(s) { return encodeURIComponent(s ?? ''); }
function empty(msg) { return `<div class="text-center text-gray-400 py-10 text-sm">${msg}</div>`; }

// ================= 下载视图 =================

function renderDownload() {
  app.innerHTML = `
    <div class="max-w-2xl mx-auto px-4 py-4">
      <h2 class="text-lg font-semibold mb-4">下载作品</h2>
      <div class="flex gap-2 mb-4">
        <input id="dl-url" type="text" placeholder="粘贴 pixiv 链接 (artworks/{id})"
          class="flex-1 px-3 py-2 rounded-lg border border-pixiv-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-pixiv-blue/30">
        <button id="dl-paste" onclick="doPaste()" class="px-3 py-2 rounded-lg border border-pixiv-border bg-white text-sm text-gray-600">粘贴</button>
        <button id="dl-preview" onclick="doPreview()" class="px-4 py-2 rounded-lg bg-pixiv-blue text-white text-sm font-medium">预览</button>
      </div>
      <div id="dl-result"></div>
      <div id="dl-task-list" class="mt-4 space-y-3"></div>
    </div>`;
}

async function doPaste() {
  const input = $('#dl-url');
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      input.value = text.trim();
      input.focus();
    }
  } catch (e) {
    input.focus();
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
    result.innerHTML = `<div class="text-red-500 text-sm bg-red-50 rounded-lg p-4">预览失败: ${esc(err.message)}</div>`;
  }
}

function renderPreview(p) {
  const r18 = p.xRestrict > 0;
  state.previewMeta = p;
  state.dlMode = 'tag';
  state.selectedTags = [];
  $('#dl-result').innerHTML = `
    <div class="bg-white rounded-lg border border-pixiv-border p-4">
      <div class="flex items-start gap-3 mb-3">
        <div class="w-12 h-12 rounded-lg bg-pixiv-light flex items-center justify-center text-pixiv-blue shrink-0">${p.is_ugoira ? ICONS.film : ICONS.image}</div>
        <div class="flex-1 min-w-0">
          <div class="font-medium truncate">${esc(p.title)}</div>
          <div class="text-xs text-gray-400">by ${esc(p.userName)}</div>
          <div class="flex gap-2 mt-1 flex-wrap">
            ${r18 ? '<span class="text-xs bg-red-500 text-white rounded px-2 py-0.5">R-18</span>' : ''}
            ${p.is_ugoira ? `<span class="text-xs bg-purple-500 text-white rounded px-2 py-0.5">动图 ${p.ugoira.frames}帧</span>` : ''}
            <span class="text-xs bg-gray-100 rounded px-2 py-0.5">${p.pageCount}页</span>
          </div>
        </div>
      </div>
      <div class="text-sm font-medium mb-2">归档方式</div>
      <div class="grid grid-cols-2 gap-2 mb-3">
        <button id="mode-orig" onclick="setDlMode('orig')" class="px-3 py-2 rounded-lg border text-sm border-pixiv-border bg-white text-gray-600">オリジナル</button>
        <button id="mode-tag" onclick="setDlMode('tag')" class="px-3 py-2 rounded-lg border text-sm bg-pixiv-blue text-white border-pixiv-blue">标签选择</button>
      </div>
      <div id="dl-mode-body">
        <div class="text-xs text-gray-500 mb-2">点击标签选择：首个 = 系列，其余 = 角色；「无系列」表示不设系列</div>
        <div id="tag-picker" class="flex flex-wrap gap-2 mb-2"></div>
        <div id="pick-tip" class="text-xs text-gray-500 mb-4 min-h-4">未选择（将归档到 _未分类）</div>
      </div>
      <div class="flex gap-2">
        <button id="dl-start" onclick="startDownload('${p.id}')" class="flex-1 px-4 py-3 rounded-lg bg-pixiv-blue text-white font-medium">开始下载</button>
        <button onclick="renderDownload()" class="px-4 py-3 rounded-lg border border-pixiv-border text-sm">取消</button>
      </div>
    </div>`;
  renderTagPicker(p.tags);
}

function setDlMode(mode) {
  state.dlMode = mode;
  const p = state.previewMeta;
  const origBtn = $('#mode-orig');
  const tagBtn = $('#mode-tag');
  const body = $('#dl-mode-body');
  const active = 'bg-pixiv-blue text-white border-pixiv-blue';
  const idle = 'border-pixiv-border bg-white text-gray-600';
  origBtn.className = `px-3 py-2 rounded-lg border text-sm ${mode === 'orig' ? active : idle}`;
  tagBtn.className = `px-3 py-2 rounded-lg border text-sm ${mode === 'tag' ? active : idle}`;
  if (mode === 'orig') {
    body.innerHTML = `
      <div class="text-xs text-gray-500 mb-4 bg-pixiv-light rounded-lg p-3">归档到 <span class="font-medium">オリジナル/${esc(p.id)}</span>。若需按系列/角色归档请切换到「标签选择」。</div>`;
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
    <button data-tag="${esc(t)}" class="chip px-3 py-1.5 rounded-full border border-pixiv-border bg-white text-xs text-gray-600"
      onclick="toggleTag(this)">${esc(t)}</button>`).join('');
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
  let isOrig = opts.is_original !== undefined ? opts.is_original : false;
  if (opts.url === undefined) {
    if (state.dlMode === 'orig') {
      isOrig = true;
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
    body: JSON.stringify({ url, series, characters, is_original: isOrig })
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
    showTask(task, { url, series, characters, is_original: isOrig });
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
  div.className = 'bg-white rounded-lg border border-pixiv-border p-4';
  div.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <div class="font-medium text-sm">作品 ${esc(task.work_id)}</div>
      <div class="task-status text-xs"></div>
    </div>
    <div class="h-2 bg-gray-100 rounded-full overflow-hidden mb-2">
      <div class="task-bar h-full bg-pixiv-blue transition-all" style="width:0%"></div>
    </div>
    <div class="task-log text-xs text-gray-500 max-h-32 overflow-auto bg-gray-50 rounded p-2 font-mono"></div>
    <div class="flex gap-2 mt-2 task-actions">
      <button class="task-cancel px-3 py-1.5 rounded border border-red-200 text-red-500 text-xs">取消</button>
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
      // 任务不存在则标记为已移除
      const e2 = state.tasks[id];
      if (e2 && e2.statusEl) e2.statusEl.textContent = '已移除';
      if (e2) e2.done = true;
    }
  }
}

function updateTaskUI(id, t) {
  const entry = state.tasks[id];
  if (!entry) return;
  const pct = t.total > 0 ? Math.round(t.progress / t.total * 100) : 0;
  entry.barEl.style.width = pct + '%';
  let label = t.status;
  if (t.status === 'running') label = `${pct}%`;
  else if (t.status === 'done') label = '✅ 完成 → ' + (t.target || '');
  else if (t.status === 'error') label = '❌ ' + (t.error || '失败');
  else if (t.status === 'cancelled') label = '已取消';
  else if (t.status === 'queued') label = '排队中…';
  entry.statusEl.textContent = label;
  if (t.log && t.log.length) {
    entry.logEl.innerHTML = t.log.map(l => esc(l)).join('<br>');
    entry.logEl.scrollTop = entry.logEl.scrollHeight;
  }
  if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') {
    entry.done = true;
    // 失败时显示「重试」按钮
    if (t.status === 'error' && entry.meta && entry.meta.url) {
      if (!entry.retryBtn) {
        const btn = document.createElement('button');
        btn.className = 'px-3 py-1.5 rounded border border-pixiv-blue text-pixiv-blue text-xs';
        btn.textContent = '重试';
        btn.onclick = () => retryTask(entry.meta);
        entry.actionsEl.appendChild(btn);
        entry.retryBtn = btn;
      }
    }
  }
}

function retryTask(meta) {
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
    <div class="max-w-2xl mx-auto px-4 py-4">
      <h2 class="text-lg font-semibold mb-4">设置</h2>
      <div class="bg-white rounded-lg border border-pixiv-border p-4 mb-4">
        <div class="font-medium mb-3">网络代理</div>
        <div class="grid grid-cols-3 gap-2 mb-3">
          <select id="cfg-scheme" class="px-2 py-2 rounded-lg border border-pixiv-border text-sm bg-white">
            <option value="">直连</option><option value="http">HTTP</option>
            <option value="https">HTTPS</option><option value="socks5">SOCKS5</option>
          </select>
          <input id="cfg-host" placeholder="host" value="${esc(cfg.proxy.host)}" class="px-2 py-2 rounded-lg border border-pixiv-border text-sm">
          <input id="cfg-port" placeholder="port" value="${esc(cfg.proxy.port)}" class="px-2 py-2 rounded-lg border border-pixiv-border text-sm">
        </div>
        <button onclick="saveConfig()" class="px-4 py-2 rounded-lg bg-pixiv-blue text-white text-sm">保存配置</button>
      </div>
      <div class="bg-white rounded-lg border border-pixiv-border p-4 mb-4">
        <div class="font-medium mb-2">cookies 状态</div>
        <div id="cookie-status">${d.cookies.ok ? 'cookies 有效' : 'cookies 无效: ' + esc(d.cookies.reason)}</div>
      </div>
      <div class="bg-white rounded-lg border border-pixiv-border p-4">
        <div class="font-medium mb-2">数据目录</div>
        <div class="text-sm text-gray-500 break-all">${esc(d.root)}</div>
      </div>
    </div>`;
  const s = document.getElementById('cfg-scheme');
  s.value = cfg.proxy.scheme || '';
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
