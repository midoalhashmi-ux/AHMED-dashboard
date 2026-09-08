import {
  doc,
  serverTimestamp,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const WORKER_BASE_URL = 'https://binsheikh-api.binsheikh.workers.dev';
const SYNC_SECRET_STORAGE_KEY = 'binsheikh-admin-sync-secret';
const STATE_KEY = 'ristoAnimeAutoImportStateV1';
const SOURCE_URL = 'https://ristoanime.me/series/';
const BATCH_SIZE = 450;
const PAGE_LIMIT = 1000;
const SERIES_LIMIT = 10000;

let firebaseReady = false;
let auth = null;
let db = null;

let running = false;
let stopRequested = false;
let currentState = loadState();

function loadState() {
  try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || freshState(); }
  catch (_) { return freshState(); }
}
function freshState() {
  return { version: 1, pageUrl: SOURCE_URL, pages: [], seriesIndex: 0, doneSeries: 0, importedEpisodes: 0, importedCategories: 0, startedAt: null, lastError: '', completed: false };
}
function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(currentState)); }
function secret() { try { return sessionStorage.getItem(SYNC_SECRET_STORAGE_KEY) || ''; } catch (_) { return ''; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function hashId(input) {
  // deterministic, URL-safe Firestore IDs; no crypto dependency needed in the browser.
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i; h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `risto_${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeUrl(url) {
  try { return new URL(url, 'https://ristoanime.me').href; } catch (_) { return ''; }
}
function normalizeWatchUrl(url) {
  const absolute = normalizeUrl(url);
  if (!absolute || !absolute.startsWith('https://ristoanime.me/')) return '';
  return absolute.includes('/watch/') ? absolute : '';
}
function bilingualTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return title || 'أنمي بلا اسم';
}
function episodeNumber(value) {
  const m = String(value || '').match(/(?:الحلقة|episode|ep|رقم)\s*[-#:]?\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

async function worker(path, body) {
  const key = secret();
  if (!key) throw new Error('مفتاح مزامنة Worker غير موجود في جلسة لوحة التحكم.');
  const response = await fetch(`${WORKER_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Worker HTTP ${response.status}`);
  return data;
}

async function commitOperations(ops) {
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    if (stopRequested) throw new Error('__STOP__');
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_SIZE).forEach(op => op(batch));
    await batch.commit();
    updateProgress(`تم حفظ دفعة ${Math.min(i + BATCH_SIZE, ops.length)} / ${ops.length}`);
    await sleep(20);
  }
}

function categoryOp(id, title, parentId, order, thumbnail) {
  return batch => batch.set(doc(db, 'categories', id), {
    title: bilingualTitle(title),
    iconUrl: thumbnail || null,
    parentId: parentId || null,
    order: Number.isFinite(order) ? order : 0,
    isPremium: false,
    contentType: 'anime',
    updatedAt: serverTimestamp(),
  }, { merge: true });
}
function episodeOp(id, categoryId, title, sourceUrl, order, thumbnail) {
  return batch => batch.set(doc(db, 'channels', id), {
    categoryId,
    title: bilingualTitle(title),
    logoUrl: thumbnail || null,
    streamType: 'web',
    sourceUrl,
    directUrl: null,
    protected: false,
    sourceHeaders: {},
    apiHeaders: {},
    order: Number.isFinite(order) ? order : 0,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

function createUI() {
  const addMenu = document.querySelector('#add-menu');
  if (!addMenu || document.querySelector('#risto-auto-import-item')) return;
  const item = document.createElement('button');
  item.type = 'button';
  item.id = 'risto-auto-import-item';
  item.setAttribute('role', 'menuitem');
  item.dataset.addType = 'risto-auto';
  item.textContent = '🤖 استيراد RistoAnime تلقائياً';
  addMenu.insertBefore(item, addMenu.firstChild);
  item.addEventListener('click', () => openImporter());

  const card = document.createElement('section');
  card.id = 'risto-import-card';
  card.className = 'card category-form-card hidden';
  card.innerHTML = `
    <div>
      <h2>🤖 استيراد RistoAnime تلقائياً</h2>
      <p class="muted">يقرأ الأقسام والحلقات من RistoAnime عبر Worker، ويحفظها في دفعات آمنة بدون تغيير المشغل أو مصادر HLS/API الحالية.</p>
    </div>
    <div class="category-form" style="gap:12px">
      <label>نطاق الاستيراد
        <select id="risto-import-scope"><option value="all">كل الأنميات</option></select>
      </label>
      <div id="risto-import-progress" class="form-message" role="status">جاهز.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" id="risto-start">بدء / استئناف</button>
        <button type="button" id="risto-stop" class="secondary-button">إيقاف آمن</button>
        <button type="button" id="risto-reset" class="secondary-button">إعادة ضبط المهمة</button>
      </div>
      <p class="muted" style="margin:0">الإيقاف لا يحذف أي بيانات؛ يمكن استئناف المهمة لاحقاً، والمعرّفات ثابتة لمنع التكرار.</p>
    </div>`;
  const anchor = document.querySelector('#bulk-form-card') || document.querySelector('#category-form-card');
  anchor?.parentElement?.insertBefore(card, anchor);
  card.querySelector('#risto-start').addEventListener('click', () => runImport());
  card.querySelector('#risto-stop').addEventListener('click', () => { stopRequested = true; updateProgress('سيتم الإيقاف بعد اكتمال الدفعة الحالية…'); });
  card.querySelector('#risto-reset').addEventListener('click', () => {
    if (running) return;
    currentState = freshState(); saveState(); updateProgress('تمت إعادة ضبط المهمة.');
  });
  updateProgress(currentState.completed ? 'اكتملت آخر مهمة.' : 'جاهز للاستيراد أو الاستئناف.');
}

function updateProgress(text) {
  const el = document.querySelector('#risto-import-progress');
  if (el) el.textContent = text;
}
function openImporter() {
  const card = document.querySelector('#risto-import-card');
  if (!card) return;
  document.querySelectorAll('.card').forEach(el => { if (el.id !== 'risto-import-card') el.classList.add('hidden'); });
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function discoverCatalog() {
  const series = [];
  const seenPages = new Set();
  let pageUrl = currentState.pageUrl || SOURCE_URL;
  while (pageUrl && !seenPages.has(pageUrl) && seenPages.size < PAGE_LIMIT) {
    if (stopRequested) throw new Error('__STOP__');
    seenPages.add(pageUrl);
    updateProgress(`جاري قراءة قائمة الأنميات… صفحة ${seenPages.size}`);
    const data = await worker('/ristoAnime/import', { action: 'catalog', url: pageUrl });
    for (const item of (data.series || [])) {
      const url = normalizeUrl(item.url);
      if (!url || !url.includes('ristoanime.me')) continue;
      if (!series.some(x => x.url === url)) series.push({ ...item, url });
    }
    pageUrl = data.nextPageUrl ? normalizeUrl(data.nextPageUrl) : '';
  }
  if (!series.length) throw new Error('لم يتم العثور على أنميات في قائمة RistoAnime.');
  currentState.pages = series;
  currentState.pageUrl = '';
  saveState();
  return series;
}

async function collectSeriesData(item) {
  const pages = [];
  const seasons = [];
  const seen = new Set();
  let pageUrl = item.url;
  let first = true;
  while (pageUrl && !seen.has(pageUrl) && seen.size < PAGE_LIMIT) {
    seen.add(pageUrl);
    const data = await worker('/ristoAnime/import', { action: 'series', url: pageUrl, fallbackTitle: item.title, fallbackThumbnail: item.thumbnail });
    if (first) {
      pages.push(data);
      first = false;
    } else {
      pages.push({ ...data, title: '', thumbnail: null, seasons: [] });
    }
    for (const season of (data.seasons || [])) {
      if (!seasons.some(s => s.url === season.url)) seasons.push(season);
    }
    pageUrl = data.nextPageUrl ? normalizeUrl(data.nextPageUrl) : '';
  }
  return { pages, seasons };
}

async function resolveEpisodePages(episodes, thumbnail) {
  const unresolved = episodes.filter(ep => !normalizeWatchUrl(ep.watchUrl || ep.url) && ep.url).map(ep => ep.url);
  const resolved = new Map();
  for (let i = 0; i < unresolved.length; i += 40) {
    if (stopRequested) throw new Error('__STOP__');
    const chunk = unresolved.slice(i, i + 40);
    const data = await worker('/ristoAnime/import', { action: 'resolveEpisodes', urls: chunk, fallbackThumbnail: thumbnail });
    for (const ep of (data.episodes || [])) if (ep.originalUrl) resolved.set(ep.originalUrl, ep);
  }
  return episodes.map(ep => {
    const direct = normalizeWatchUrl(ep.watchUrl || ep.url);
    if (direct) return { ...ep, watchUrl: direct };
    return resolved.get(ep.url) || null;
  }).filter(Boolean);
}

async function importOneSeries(item, index) {
  updateProgress(`(${index + 1}/${currentState.pages.length}) ${item.title || 'أنمي'} — قراءة المواسم والحلقات…`);
  const collected = await collectSeriesData(item);
  const first = collected.pages[0] || {};
  const dataTitle = first.title || item.title || 'أنمي بلا اسم';
  const thumbnail = item.thumbnail || first.thumbnail || null;
  const showKey = item.url;
  const showId = hashId(`category|${showKey}`);
  const ops = [categoryOp(showId, dataTitle, null, index + 1, thumbnail)];
  let categoryCount = 1;
  let episodeCount = 0;

  // Build season buckets from real season pages. If there are no season links,
  // the show itself is the episode container.
  const seasonEntries = collected.seasons.length
    ? collected.seasons
    : [{ title: '', url: item.url, episodes: collected.pages.flatMap(p => p.episodes || []) }];

  for (let si = 0; si < seasonEntries.length; si += 1) {
    const season = seasonEntries[si];
    let seasonEpisodes = Array.isArray(season.episodes) ? season.episodes : [];
    if (season.url && season.url !== item.url) {
      const seasonData = await collectSeriesData({ ...item, url: season.url, title: season.title, thumbnail });
      seasonEpisodes = seasonData.pages.flatMap(p => p.episodes || []);
    } else if (!seasonEpisodes.length) {
      seasonEpisodes = collected.pages.flatMap(p => p.episodes || []);
    }
    seasonEpisodes = await resolveEpisodePages(seasonEpisodes, thumbnail);
    const hasSeasonName = collected.seasons.length > 0 || season.title;
    const seasonId = hasSeasonName ? hashId(`category|${showKey}|season|${season.url || season.title || si}`) : showId;
    if (hasSeasonName) {
      ops.push(categoryOp(seasonId, season.title || `الموسم ${si + 1}`, showId, si + 1, thumbnail));
      categoryCount += 1;
    }
    for (const ep of seasonEpisodes) {
      const watchUrl = normalizeWatchUrl(ep.watchUrl || ep.url);
      if (!watchUrl) continue;
      const n = episodeNumber(ep.title) ?? Number(ep.episodeNumber);
      const title = ep.title || `${dataTitle} - الحلقة ${Number.isFinite(n) ? n : episodeCount + 1}`;
      const id = hashId(`episode|${seasonId}|${watchUrl}`);
      ops.push(episodeOp(id, seasonId, title, watchUrl, Number.isFinite(n) ? n : episodeCount + 1, ep.thumbnail || thumbnail));
      episodeCount += 1;
    }
  }
  if (!episodeCount) return { categoryCount, episodeCount: 0 };
  await commitOperations(ops);
  return { categoryCount, episodeCount };
}

async function runImport() {
  if (running) return;
  if (!firebaseReady || !auth || !db) { updateProgress('تعذر الاتصال بخدمة لوحة التحكم. أعد تحميل الصفحة وحاول مرة أخرى.'); return; }
  if (!auth.currentUser) { updateProgress('سجّل الدخول إلى لوحة التحكم أولاً.'); return; }
  if (!secret()) { updateProgress('مفتاح Worker غير موجود في الجلسة. استخدم نفس مفتاح مزامنة اللوحة ثم أعد المحاولة.'); return; }
  running = true; stopRequested = false;
  currentState.startedAt ||= new Date().toISOString();
  currentState.lastError = '';
  saveState();
  try {
    if (!currentState.pages.length || currentState.completed) {
      currentState = freshState();
      currentState.startedAt = new Date().toISOString();
      const series = await discoverCatalog();
      currentState.pages = series;
      currentState.seriesIndex = 0;
      currentState.doneSeries = 0;
      currentState.importedEpisodes = 0;
      currentState.importedCategories = 0;
      saveState();
    }
    while (currentState.seriesIndex < currentState.pages.length) {
      if (stopRequested) throw new Error('__STOP__');
      const result = await importOneSeries(currentState.pages[currentState.seriesIndex], currentState.seriesIndex);
      currentState.importedCategories += result.categoryCount;
      currentState.importedEpisodes += result.episodeCount;
      currentState.doneSeries += 1;
      currentState.seriesIndex += 1;
      saveState();
      updateProgress(`تم ${currentState.doneSeries}/${currentState.pages.length} أنمي — ${currentState.importedEpisodes} حلقة.`);
    }
    currentState.completed = true; saveState();
    updateProgress(`اكتمل الاستيراد: ${currentState.importedCategories} قسم و${currentState.importedEpisodes} حلقة. لا توجد بيانات مكررة بسبب المعرّفات الثابتة.`);
    window.dispatchEvent(new CustomEvent('risto-import-complete'));
  } catch (error) {
    if (error?.message === '__STOP__') {
      saveState(); updateProgress('تم الإيقاف بأمان. اضغط «بدء / استئناف» للمتابعة.');
    } else {
      currentState.lastError = String(error?.message || error); saveState();
      updateProgress(`توقفت المهمة بسبب خطأ: ${currentState.lastError} — يمكنك الاستئناف بعد إصلاحه.`);
    }
  } finally { running = false; stopRequested = false; }
}

async function boot() {
  for (let i = 0; i < 100 && !window.__AHMED_DASHBOARD_FIREBASE__; i += 1) await sleep(50);
  const shared = window.__AHMED_DASHBOARD_FIREBASE__;
  if (shared) { auth = shared.auth; db = shared.db; firebaseReady = true; }
  createUI();
  if (auth) auth.onAuthStateChanged(() => createUI());
  // إبقاء لوحة التحكم الأصلية كما هي؛ الاستيراد لا يعمل تلقائياً عند فتح الصفحة حتى لا يبدأ آلاف العمليات دون قصد.
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
