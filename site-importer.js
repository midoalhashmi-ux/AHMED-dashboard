import {
  doc,
  serverTimestamp,
  writeBatch,
  collection,
  query,
  where,
  getDocs,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const WORKER_BASE_URL = 'https://binsheikh-api.binsheikh.workers.dev';
const SYNC_SECRET_STORAGE_KEY = 'binsheikh-admin-sync-secret';
const STATE_PREFIX = 'siteAutoImportStateV2:';
const LAST_URL_KEY = 'siteAutoImportLastUrl';
const LAST_TYPE_KEY = 'siteAutoImportLastType';
const LAST_PARENT_KEY = 'siteAutoImportLastParent';
const BATCH_SIZE = 450;
const PAGE_LIMIT = 1000;

let firebaseReady = false;
let auth = null;
let db = null;

let adminSyncSecret = '';
try { adminSyncSecret = sessionStorage.getItem(SYNC_SECRET_STORAGE_KEY) || ''; } catch (_) {}

let running = false;
let stopRequested = false;
let currentState = freshState();
let currentStateKey = '';
// معرّفات Firestore (أقسام + حلقات) المكتوبة فعلياً من قبل لهذا الرابط.
// تبقى محفوظة حتى بعد اكتمال المهمة وبدء دورة جديدة — بها نتخطى إعادة
// كتابة أي شيء موجود مسبقاً ونكتب فقط ما هو جديد فعلاً (راجع importOneSeries).
let knownIds = new Set();

function freshState() {
  return {
    version: 4, pages: [], seriesIndex: 0, doneSeries: 0, importedEpisodes: 0, importedCategories: 0,
    startedAt: null, lastError: '', completed: false, knownIds: [],
    // بعض المواقع تعرض صفحة "معلومات الحلقة" بدون أي مصدر تشغيل، والمشاهدة
    // الفعلية بنفس الرابط + مقطع إضافي (مثلاً ".../watch/") — يُكتشف مرة
    // واحدة فقط من أول حلقة (انظر ensureWatchSuffix) ويُطبَّق على الباقي.
    watchSuffixChecked: false, watchSuffix: '',
  };
}
function loadState(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || freshState(); }
  catch (_) { return freshState(); }
}
function saveState() {
  if (!currentStateKey) return;
  currentState.knownIds = Array.from(knownIds);
  localStorage.setItem(currentStateKey, JSON.stringify(currentState));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function hashId(input) {
  // deterministic, URL-safe Firestore IDs; no crypto dependency needed in the browser.
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i; h2 = Math.imul(h2, 0x85ebca6b);
  }
  return `site_${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}
function stateKeyFor(url) { return `${STATE_PREFIX}${hashId(url)}`; }

function isValidHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) { return false; }
}

// نفس أسلوب app.js تماماً: أول استخدام بجلسة جديدة يطلب المفتاح مرة واحدة
// ويخزّنه بنفس مفتاح sessionStorage المشترك، بدل الفشل الصامت إن لم يكن
// المستخدم قد استخدم زر "مزامنة المباريات" بنفس الجلسة أولاً.
function getAdminKey() {
  if (adminSyncSecret) return adminSyncSecret;
  const value = window.prompt('أدخل مفتاح مزامنة Worker الخاص بلوحة التحكم:');
  if (!value?.trim()) throw new Error('لم يتم إدخال مفتاح المزامنة.');
  adminSyncSecret = value.trim();
  try { sessionStorage.setItem(SYNC_SECRET_STORAGE_KEY, adminSyncSecret); } catch (_) {}
  return adminSyncSecret;
}

async function worker(path, body) {
  const key = getAdminKey();
  const response = await fetch(`${WORKER_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    adminSyncSecret = '';
    try { sessionStorage.removeItem(SYNC_SECRET_STORAGE_KEY); } catch (_) {}
  }
  if (!response.ok) throw new Error(data.message || data.error || `Worker HTTP ${response.status}`);
  return data;
}

// يُستدعى مرة واحدة فقط لكل رابط (يُحفظ بالحالة) — يفتح حلقة واحدة فعلية
// ليكتشف هل رابط الحلقة المباشر يشتغل كمصدر تشغيل، أو إنه صفحة "معلومات"
// فقط والمشاهدة الحقيقية بنفس الرابط + مقطع إضافي (مثال: RistoAnime يحتاج
// "/watch/" إضافية). إن اكتُشف مقطع، يُطبَّق على كل حلقات هذا الموقع بدون
// فتح كل حلقة على حدة.
async function ensureWatchSuffix(sampleUrl) {
  if (currentState.watchSuffixChecked) return;
  currentState.watchSuffixChecked = true;
  currentState.watchSuffix = '';
  if (sampleUrl) {
    try {
      const data = await worker('/import/site', { action: 'resolveEpisode', url: sampleUrl });
      const watchUrl = data && data.watchUrl;
      const base = sampleUrl.replace(/\/$/, '');
      if (watchUrl && watchUrl !== base && watchUrl.startsWith(base)) {
        currentState.watchSuffix = watchUrl.slice(base.length);
      }
    } catch (_) { /* أفضل جهد — نبقي روابط الحلقات المباشرة عند الفشل */ }
  }
  saveState();
}
function applyWatchSuffix(url) {
  if (!url) return url;
  return currentState.watchSuffix ? `${url.replace(/\/$/, '')}${currentState.watchSuffix}` : url;
}

async function commitOperations(ops) {
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    if (stopRequested) throw new Error('__STOP__');
    const batch = writeBatch(db);
    ops.slice(i, i + BATCH_SIZE).forEach(op => op.run(batch));
    await batch.commit();
    updateProgress(`تم حفظ دفعة ${Math.min(i + BATCH_SIZE, ops.length)} / ${ops.length}`);
    await sleep(20);
  }
}

function categoryOp(id, title, parentId, order, thumbnail, contentType) {
  return {
    id,
    kind: 'category',
    run: batch => batch.set(doc(db, 'categories', id), {
      title: title || 'بدون اسم',
      iconUrl: thumbnail || null,
      parentId: parentId || null,
      order: Number.isFinite(order) ? order : 0,
      isPremium: false,
      contentType,
      updatedAt: serverTimestamp(),
    }, { merge: true }),
  };
}
function episodeOp(id, categoryId, title, sourceUrl, order, thumbnail) {
  return {
    id,
    kind: 'episode',
    run: batch => batch.set(doc(db, 'channels', id), {
      categoryId,
      title: title || 'بدون اسم',
      logoUrl: thumbnail || null,
      streamType: 'web',
      sourceUrl,
      directUrl: null,
      protected: false,
      sourceHeaders: {},
      apiHeaders: {},
      order: Number.isFinite(order) ? order : 0,
      updatedAt: serverTimestamp(),
    }, { merge: true }),
  };
}

// نفس مجموعة البطاقات التي يديرها closeAllFormCards() في app.js — تُغلق هنا
// عند فتح بطاقة الاستيراد، ويُغلق العكس من app.js (انظر التعديل هناك).
const OTHER_FORM_CARD_SELECTORS = ['#category-form-card', '#channel-form-card', '#marquee-form-card', '#bulk-form-card'];

function createUI() {
  const addMenu = document.querySelector('#add-menu');
  if (!addMenu || document.querySelector('#site-auto-import-item')) return;
  const item = document.createElement('button');
  item.type = 'button';
  item.id = 'site-auto-import-item';
  item.setAttribute('role', 'menuitem');
  item.dataset.addType = 'site-auto';
  item.textContent = '🌐 استيراد تلقائي من رابط موقع';
  addMenu.insertBefore(item, addMenu.firstChild);
  item.addEventListener('click', () => openImporter());

  const card = document.createElement('section');
  card.id = 'site-import-card';
  card.className = 'card category-form-card hidden';
  card.innerHTML = `
    <div>
      <h2>🌐 استيراد تلقائي من رابط موقع</h2>
      <p class="muted">الصق رابط صفحة قائمة الأعمال من أي موقع (وليس موقعاً واحداً بعينه) — يقرأ الأقسام والمواسم والحلقات تلقائياً ويحفظها في دفعات آمنة بدون تغيير المشغل أو مصادر HLS/API الحالية.</p>
    </div>
    <div class="category-form" style="gap:12px">
      <label>رابط صفحة القائمة
        <input id="site-import-url" type="url" placeholder="https://example.com/anime-list/" />
      </label>
      <label>نوع المحتوى
        <select id="site-import-type">
          <option value="anime">🍥 أنمي</option>
          <option value="series">📺 مسلسلات</option>
          <option value="movies">🎬 أفلام</option>
          <option value="channels">📺 قنوات</option>
        </select>
      </label>
      <label>القسم الوجهة <span class="optional-label">اختياري</span>
        <span style="display:flex;gap:8px;align-items:center">
          <select id="site-import-parent" style="flex:1"><option value="">— بدون (قسم رئيسي مستقل) —</option></select>
          <button type="button" id="site-import-refresh-parents" class="secondary-button" title="تحديث القائمة">🔄</button>
        </span>
      </label>
      <p class="muted" style="margin:0">اتركه فارغاً ليضيف كل عمل كقسم رئيسي مستقل، أو اختر قسماً موجوداً (أنشئه أولاً بزر «+ إضافة» ← «📁 قسم») ليضيف كل الأعمال المستورَدة بداخله — مثلاً أنشئ قسم «تركية» داخل المسلسلات ثم اختره هنا.</p>
      <div id="site-import-progress" class="form-message" role="status">جاهز.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" id="site-import-start">بدء / استئناف</button>
        <button type="button" id="site-import-stop" class="secondary-button">إيقاف آمن</button>
        <button type="button" id="site-import-reset" class="secondary-button">إعادة ضبط المهمة</button>
        <button type="button" id="site-import-close" class="secondary-button">إغلاق</button>
      </div>
      <p class="muted" style="margin:0">الإيقاف لا يحذف أي بيانات؛ يمكن استئناف المهمة لاحقاً. بعد اكتمال المهمة، ضغط «بدء / استئناف» مرة ثانية (مثلاً بعد يوم) يتحقق من الموقع من جديد لكنه يتخطى كل عمل مستورد سابقاً دون تغيير ويكتب فقط الحلقات الجديدة فعلاً. لكل رابط مهمة مستقلة، فتغيير الرابط لا يؤثر على تقدّم المهام الأخرى.</p>
    </div>`;
  const anchor = document.querySelector('#bulk-form-card') || document.querySelector('#category-form-card');
  anchor?.parentElement?.insertBefore(card, anchor);

  const urlInput = card.querySelector('#site-import-url');
  const typeSelect = card.querySelector('#site-import-type');
  const parentSelect = card.querySelector('#site-import-parent');
  card.querySelector('#site-import-start').addEventListener('click', () => runImport());
  card.querySelector('#site-import-close').addEventListener('click', () => card.classList.add('hidden'));
  card.querySelector('#site-import-stop').addEventListener('click', () => { stopRequested = true; updateProgress('سيتم الإيقاف بعد اكتمال الدفعة الحالية…'); });
  card.querySelector('#site-import-refresh-parents').addEventListener('click', () => loadParentOptions(parentSelect, typeSelect.value));
  typeSelect.addEventListener('change', () => loadParentOptions(parentSelect, typeSelect.value));
  card.querySelector('#site-import-reset').addEventListener('click', () => {
    if (running) return;
    const url = urlInput.value.trim();
    if (!isValidHttpUrl(url)) { updateProgress('أدخل رابطاً صالحاً أولاً لإعادة ضبط مهمته.'); return; }
    currentStateKey = stateKeyFor(url);
    currentState = freshState();
    knownIds = new Set();
    saveState();
    updateProgress('تمت إعادة ضبط المهمة لهذا الرابط بالكامل — الاستيراد القادم سيعيد كتابة كل شيء من جديد.');
  });

  try {
    const lastUrl = localStorage.getItem(LAST_URL_KEY) || '';
    const lastType = localStorage.getItem(LAST_TYPE_KEY) || 'anime';
    urlInput.value = lastUrl;
    typeSelect.value = lastType;
    if (lastUrl) {
      currentStateKey = stateKeyFor(lastUrl);
      currentState = loadState(currentStateKey);
      knownIds = new Set(currentState.knownIds || []);
    }
  } catch (_) {}
  loadParentOptions(parentSelect, typeSelect.value);
  updateProgress(currentState.completed ? 'اكتملت آخر مهمة لهذا الرابط — اضغط «بدء / استئناف» للتحقق من أي جديد فقط.' : (currentState.pages.length ? 'جاهز للاستئناف.' : 'أدخل رابط صفحة القائمة واختر نوع المحتوى، ثم اضغط «بدء / استئناف».'));
}

// يعبّئ القسم الوجهة بالأقسام الرئيسية الموجودة فعلياً لنفس نوع المحتوى
// (مثلاً: أنشئ قسم "تركية" داخل المسلسلات يدوياً، ثم يظهر هنا لتختاره).
async function loadParentOptions(select, contentType) {
  const previous = select.value;
  const lastParent = (() => { try { return localStorage.getItem(LAST_PARENT_KEY) || ''; } catch (_) { return ''; } })();
  select.innerHTML = '<option value="">— بدون (قسم رئيسي مستقل) —</option>';
  if (!db) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'categories'),
      where('contentType', '==', contentType),
      where('parentId', '==', null),
    ));
    const items = [];
    snap.forEach(d => items.push({ id: d.id, title: d.data()?.title || d.id }));
    items.sort((a, b) => a.title.localeCompare(b.title, 'ar'));
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = item.title;
      select.appendChild(opt);
    }
    const restore = items.some(i => i.id === previous) ? previous : (items.some(i => i.id === lastParent) ? lastParent : '');
    select.value = restore;
  } catch (_) { /* أفضل جهد — يبقى الخيار الافتراضي فقط عند الفشل */ }
}

function updateProgress(text) {
  const el = document.querySelector('#site-import-progress');
  if (el) el.textContent = text;
}
function openImporter() {
  const card = document.querySelector('#site-import-card');
  if (!card) return;
  OTHER_FORM_CARD_SELECTORS.forEach(sel => document.querySelector(sel)?.classList.add('hidden'));
  card.classList.remove('hidden');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const typeSelect = card.querySelector('#site-import-type');
  const parentSelect = card.querySelector('#site-import-parent');
  if (typeSelect && parentSelect) loadParentOptions(parentSelect, typeSelect.value);
}

async function discoverCatalog(startUrl) {
  const series = [];
  const seenPages = new Set();
  let pageUrl = startUrl;
  while (pageUrl && !seenPages.has(pageUrl) && seenPages.size < PAGE_LIMIT) {
    if (stopRequested) throw new Error('__STOP__');
    seenPages.add(pageUrl);
    updateProgress(`جاري قراءة قائمة المحتوى… صفحة ${seenPages.size}`);
    const data = await worker('/import/site', { action: 'catalog', url: pageUrl });
    for (const item of (data.series || [])) {
      if (item.url && !series.some(x => x.url === item.url)) series.push(item);
    }
    pageUrl = data.nextPageUrl || '';
  }
  if (!series.length) throw new Error('لم يتم العثور على أي عناصر في صفحة القائمة. تأكد من صحة الرابط.');
  return series;
}

async function collectSeriesData(item) {
  const episodes = [];
  const seasons = [];
  const seen = new Set();
  let pageUrl = item.url;
  let first = true;
  let title = '';
  let thumbnail = null;
  while (pageUrl && !seen.has(pageUrl) && seen.size < PAGE_LIMIT) {
    if (stopRequested) throw new Error('__STOP__');
    seen.add(pageUrl);
    const data = await worker('/import/site', { action: 'series', url: pageUrl, fallbackTitle: item.title, fallbackThumbnail: item.thumbnail });
    if (first) { title = data.title || ''; thumbnail = data.thumbnail || null; first = false; }
    for (const ep of (data.episodes || [])) if (!episodes.some(e => e.url === ep.url)) episodes.push(ep);
    for (const season of (data.seasons || [])) if (!seasons.some(s => s.url === season.url)) seasons.push(season);
    pageUrl = data.nextPageUrl || '';
  }
  return { title, thumbnail, episodes, seasons };
}

async function importOneSeries(item, index, contentType, parentCategoryId) {
  updateProgress(`(${index + 1}/${currentState.pages.length}) ${item.title || 'عنصر'} — قراءة المواسم والحلقات…`);
  const collected = await collectSeriesData(item);
  // عنوان بطاقة القائمة أنظف من عنوان صفحة العمل نفسها في الغالب — صفحة
  // العمل غالبًا عنوانها SEO كامل يكرر اسم الموقع أو عبارات إضافية.
  const dataTitle = item.title || collected.title || 'بدون اسم';
  const thumbnail = item.thumbnail || collected.thumbnail || null;
  const showId = hashId(`category|${item.url}`);
  const ops = [categoryOp(showId, dataTitle, parentCategoryId || null, index + 1, thumbnail, contentType)];
  let episodeCount = 0; // عدّاد ترقيم احتياطي فقط لحلقة بلا رقم صريح

  const seasonEntries = collected.seasons.length
    ? collected.seasons
    : [{ title: '', url: item.url, episodes: collected.episodes }];

  for (let si = 0; si < seasonEntries.length; si += 1) {
    const season = seasonEntries[si];
    let seasonEpisodes = Array.isArray(season.episodes) ? season.episodes : [];
    if (season.url && season.url !== item.url && !seasonEpisodes.length) {
      const seasonData = await collectSeriesData({ url: season.url, title: season.title, thumbnail });
      seasonEpisodes = seasonData.episodes;
    }
    const hasSeasonName = collected.seasons.length > 0;
    const seasonId = hasSeasonName ? hashId(`category|${item.url}|season|${season.url || season.title || si}`) : showId;
    if (hasSeasonName) {
      ops.push(categoryOp(seasonId, season.title || `الموسم ${si + 1}`, showId, si + 1, thumbnail, contentType));
    }
    if (seasonEpisodes.length) await ensureWatchSuffix(seasonEpisodes[0].url);
    for (const ep of seasonEpisodes) {
      if (!ep.url) continue;
      const n = Number.isFinite(ep.episodeNumber) ? ep.episodeNumber : episodeCount + 1;
      const title = ep.title || `${dataTitle} - الحلقة ${n}`;
      const id = hashId(`episode|${seasonId}|${ep.url}`);
      ops.push(episodeOp(id, seasonId, title, applyWatchSuffix(ep.url), n, ep.thumbnail || thumbnail));
      episodeCount += 1;
    }
  }
  // تخطّي كل ما سبق كتابته فعلياً — هذا ما يمنع إعادة استهلاك الوقت وحصة
  // Firestore على أعمال كاملة لم يتغيّر فيها شيء؛ لازم نفتح صفحة العمل
  // لنعرف هل فيه جديد، لكن ما نكتب إلا الجديد فعلاً.
  const newOps = ops.filter(op => !knownIds.has(op.id));
  if (!newOps.length) return { categoryCount: 0, episodeCount: 0 };
  await commitOperations(newOps);
  for (const op of newOps) knownIds.add(op.id);
  const newCategoryCount = newOps.filter(op => op.kind === 'category').length;
  const newEpisodeCount = newOps.filter(op => op.kind === 'episode').length;
  return { categoryCount: newCategoryCount, episodeCount: newEpisodeCount };
}

async function runImport() {
  if (running) return;
  const card = document.querySelector('#site-import-card');
  const url = card.querySelector('#site-import-url').value.trim();
  const contentType = card.querySelector('#site-import-type').value;
  const parentCategoryId = card.querySelector('#site-import-parent').value || '';
  if (!isValidHttpUrl(url)) { updateProgress('أدخل رابط صفحة القائمة أولاً (يبدأ بـ http:// أو https://).'); return; }
  if (!firebaseReady || !auth || !db) { updateProgress('تعذر الاتصال بخدمة لوحة التحكم. أعد تحميل الصفحة وحاول مرة أخرى.'); return; }
  if (!auth.currentUser) { updateProgress('سجّل الدخول إلى لوحة التحكم أولاً.'); return; }

  try {
    localStorage.setItem(LAST_URL_KEY, url);
    localStorage.setItem(LAST_TYPE_KEY, contentType);
    localStorage.setItem(LAST_PARENT_KEY, parentCategoryId);
  } catch (_) {}
  currentStateKey = stateKeyFor(url);
  currentState = loadState(currentStateKey);
  knownIds = new Set(currentState.knownIds || []);
  running = true; stopRequested = false;
  currentState.startedAt ||= new Date().toISOString();
  currentState.lastError = '';
  saveState();
  try {
    if (!currentState.pages.length || currentState.completed) {
      // دورة جديدة (أول مرة، أو بعد اكتمال سابق) — نحتفظ بذاكرة knownIds
      // وbwatchSuffix عبر الدورات؛ هذا ما يخلي كل عمل مكتمل يُتخطّى فوراً
      // بمجرد ما نكتشف إنه ما فيه جديد فيه، بدل إعادة كتابته بالكامل كل
      // مرة، ويمنع إعادة اكتشاف مقطع "watch" من الصفر كل دورة.
      const preservedWatchChecked = currentState.watchSuffixChecked;
      const preservedWatchSuffix = currentState.watchSuffix;
      currentState = freshState();
      currentState.knownIds = Array.from(knownIds);
      currentState.watchSuffixChecked = preservedWatchChecked || false;
      currentState.watchSuffix = preservedWatchSuffix || '';
      currentState.startedAt = new Date().toISOString();
      currentState.pages = await discoverCatalog(url);
      saveState();
    }
    while (currentState.seriesIndex < currentState.pages.length) {
      if (stopRequested) throw new Error('__STOP__');
      const result = await importOneSeries(currentState.pages[currentState.seriesIndex], currentState.seriesIndex, contentType, parentCategoryId);
      currentState.importedCategories += result.categoryCount;
      currentState.importedEpisodes += result.episodeCount;
      currentState.doneSeries += 1;
      currentState.seriesIndex += 1;
      saveState();
      updateProgress(`تم ${currentState.doneSeries}/${currentState.pages.length} — ${currentState.importedEpisodes} حلقة جديدة.`);
    }
    currentState.completed = true; saveState();
    updateProgress(`اكتمل الفحص: ${currentState.importedCategories} قسم و${currentState.importedEpisodes} حلقة جديدة فعلاً (ما تم تخطيه من المحتوى السابق لم تتم إعادة كتابته).`);
    window.dispatchEvent(new CustomEvent('site-import-complete'));
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
