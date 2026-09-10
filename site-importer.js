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
const LAST_WATCH_EXAMPLE_KEY = 'siteAutoImportLastWatchExample';
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

// حالة نافذة اختيار "القسم الوجهة" — قائمة مسطّحة لكل أقسام نفس نوع
// المحتوى، ومسار التصفّح الحالي بداخلها (راجع createParentPicker).
let parentPickerCategories = [];
let parentPickerContentType = '';
let parentPickerPath = [];
let selectedParentId = '';
let selectedParentLabel = '— بدون (قسم رئيسي مستقل) —';

function freshState() {
  return {
    version: 5, pages: [], seriesIndex: 0, doneSeries: 0, importedEpisodes: 0, importedCategories: 0,
    startedAt: null, lastError: '', completed: false, knownIds: [],
    // بعض المواقع تعرض صفحة "معلومات الحلقة" بدون أي مصدر تشغيل، والمشاهدة
    // الفعلية بنفس الرابط + مقطع إضافي (مثلاً ".../see/"). يُكتشف مرة واحدة
    // فقط من أول حلقة **لكل عمل (مسلسل/أنمي) على حدة** ويُطبَّق على باقي
    // حلقاته هو فقط — راجع ensureWatchSuffix. كان يُكتشف مرة واحدة للموقع
    // كاملاً (مسلسل → بيانات → مسلسل → ...) فيطبَّق خطأً على أعمال أخرى
    // بنفس الموقع لها نمط رابط مختلف، فتُستورد بعض حلقاتها برابط صفحة
    // المعلومات بدل رابط المشاهدة الحقيقي.
    watchSuffixCache: {},
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

// يُستدعى مرة واحدة فقط لكل عمل (seriesKey — رابط صفحة المسلسل/الأنمي
// نفسه، وليس الموقع كاملاً) — يفتح حلقة واحدة فعلية من هذا العمل تحديداً
// ليكتشف هل رابط الحلقة المباشر يشتغل كمصدر تشغيل، أو إنه صفحة "معلومات"
// فقط والمشاهدة الحقيقية بنفس الرابط + مقطع إضافي (مثال: RistoAnime يحتاج
// "/watch/" إضافية). النتيجة تُخزَّن بالحالة لهذا العمل تحديداً وتُطبَّق
// على كل حلقاته هو فقط — مواقع فيها أعمال بأنماط روابط مختلفة (بعضها
// يحتاج المقطع الإضافي وبعضها لا) كانت تفشل مع اكتشاف عام لموقع كامل.
async function ensureWatchSuffix(seriesKey, sampleUrl) {
  const cache = currentState.watchSuffixCache || (currentState.watchSuffixCache = {});
  if (Object.prototype.hasOwnProperty.call(cache, seriesKey)) return cache[seriesKey];
  if (!sampleUrl) return '';
  try {
    const data = await worker('/import/site', { action: 'resolveEpisode', url: sampleUrl });
    const watchUrl = data && data.watchUrl;
    const base = sampleUrl.replace(/\/$/, '');
    // نخزّن النتيجة فقط عند نجاح الفحص فعلياً — سواء اكتُشف مقطع أو تأكّد
    // عدم الحاجة له. فشل الفحص نفسه (شبكة، مهلة...) لا يُخزَّن كـ"لا يحتاج
    // مقطع" نهائياً، حتى لا يُقفَل هذا العمل على نتيجة خاطئة بسبب عطل
    // عابر — تُعاد المحاولة بموسم/استئناف لاحق بدل قفلها للأبد.
    const suffix = watchUrl && watchUrl !== base && watchUrl.startsWith(base)
      ? watchUrl.slice(base.length)
      : '';
    cache[seriesKey] = suffix;
    saveState();
    return suffix;
  } catch (_) {
    return '';
  }
}
function applyWatchSuffix(url, suffix) {
  if (!url) return url;
  return suffix ? `${url.replace(/\/$/, '')}${suffix}` : url;
}

// يُستخدم لما يحط المستخدم "مثال رابط حلقة تعمل فعلياً" يدوياً بدل الاعتماد
// على التخمين التلقائي (ensureWatchSuffix). الافتراض: آخر مقطع بالرابط هو
// الجزء الإضافي المسؤول عن المشاهدة الفعلية (زي "/see/" أو "/watch/")،
// وباقي الرابط هو نفس رابط الحلقة الخام اللي يُستخرج من صفحة القائمة —
// نفس النمط الملاحظ فعلياً بأكثر من موقع.
function deriveWatchSuffixFromExample(exampleUrl) {
  try {
    const u = new URL(exampleUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return '';
    return `/${parts[parts.length - 1]}/`;
  } catch (_) { return ''; }
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
      <label>القسم الوجهة <span class="optional-label">اختياري</span></label>
      <div style="display:flex;gap:8px;align-items:center">
        <button type="button" id="site-import-parent-toggle" class="secondary-button" style="flex:1;text-align:right">— بدون (قسم رئيسي مستقل) —</button>
        <button type="button" id="site-import-refresh-parents" class="secondary-button" title="تحديث القائمة">🔄</button>
      </div>
      <div id="site-import-parent-panel" class="hidden" style="border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:8px;margin-top:-6px">
        <input id="site-import-parent-search" type="text" placeholder="ابحث عن قسم بالاسم…" style="width:100%;margin-bottom:8px;box-sizing:border-box" />
        <div id="site-import-parent-breadcrumb" class="muted" style="margin-bottom:6px;font-size:0.85em"></div>
        <div id="site-import-parent-list" style="max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:4px"></div>
      </div>
      <p class="muted" style="margin:0">اتركه فارغاً ليضيف كل عمل كقسم رئيسي مستقل، أو تصفّح/ابحث عن أي قسم موجود (بأي مستوى) — أنشئه أولاً بزر «+ إضافة» ← «📁 قسم» لو ما كان موجوداً — ليضيف كل الأعمال المستورَدة بداخله.</p>
      <label>مثال رابط حلقة تعمل فعلياً <span class="optional-label">اختياري</span>
        <input id="site-import-watch-example" type="url" placeholder="https://example.com/watch/episodes/serie-x-season-1-episode-2/see/" />
      </label>
      <p class="muted" style="margin:0">اتركه فارغاً ليكتشف الكود نمط رابط المشاهدة تلقائياً لكل عمل على حدة (الافتراضي). لو حطيته، يُستخدم مباشرة لكل حلقات كل الأعمال بهذا الاستيراد بدل التخمين — افتح أي حلقة بالموقع فعلياً وتأكد إنها تشتغل، والصق رابطها هنا كما هو.</p>
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
  card.querySelector('#site-import-start').addEventListener('click', () => runImport());
  card.querySelector('#site-import-close').addEventListener('click', () => card.classList.add('hidden'));
  card.querySelector('#site-import-stop').addEventListener('click', () => { stopRequested = true; updateProgress('سيتم الإيقاف بعد اكتمال الدفعة الحالية…'); });
  card.querySelector('#site-import-refresh-parents').addEventListener('click', () => refreshParentPicker(typeSelect.value));
  card.querySelector('#site-import-parent-toggle').addEventListener('click', () => toggleParentPicker(typeSelect.value));
  card.querySelector('#site-import-parent-search').addEventListener('input', (e) => renderParentPicker(e.target.value));
  typeSelect.addEventListener('change', () => {
    selectedParentId = '';
    selectedParentLabel = '— بدون (قسم رئيسي مستقل) —';
    updateParentToggleLabel();
    card.querySelector('#site-import-parent-panel').classList.add('hidden');
    refreshParentPicker(typeSelect.value);
  });
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
    const lastWatchExample = localStorage.getItem(LAST_WATCH_EXAMPLE_KEY) || '';
    urlInput.value = lastUrl;
    typeSelect.value = lastType;
    card.querySelector('#site-import-watch-example').value = lastWatchExample;
    if (lastUrl) {
      currentStateKey = stateKeyFor(lastUrl);
      currentState = loadState(currentStateKey);
      knownIds = new Set(currentState.knownIds || []);
    }
  } catch (_) {}
  refreshParentPicker(typeSelect.value);
  updateProgress(currentState.completed ? 'اكتملت آخر مهمة لهذا الرابط — اضغط «بدء / استئناف» للتحقق من أي جديد فقط.' : (currentState.pages.length ? 'جاهز للاستئناف.' : 'أدخل رابط صفحة القائمة واختر نوع المحتوى، ثم اضغط «بدء / استئناف».'));
}

// نافذة اختيار "القسم الوجهة": تصفّح شجرة الأقسام (مثل اللوحة نفسها) بدل
// قائمة مسطّحة تخلط كل مئات الأعمال المستوردة سابقاً مع المجلدات الحقيقية،
// بالإضافة إلى بحث فوري بالاسم بأي مستوى.
function updateParentToggleLabel() {
  const btn = document.querySelector('#site-import-parent-toggle');
  if (btn) btn.textContent = selectedParentLabel;
}
function categoryById(id) { return parentPickerCategories.find(c => c.id === id); }
function childrenOf(parentId) {
  return parentPickerCategories
    .filter(c => (c.parentId || null) === (parentId || null))
    .sort((a, b) => a.title.localeCompare(b.title, 'ar'));
}
function breadcrumbLabel(id) {
  const parts = [];
  let current = categoryById(id);
  while (current) { parts.unshift(current.title); current = current.parentId ? categoryById(current.parentId) : null; }
  return parts.join(' ← ') || '— بدون (قسم رئيسي مستقل) —';
}

async function refreshParentPicker(contentType) {
  parentPickerCategories = [];
  parentPickerContentType = contentType;
  parentPickerPath = [];
  if (db) {
    try {
      const snap = await getDocs(query(collection(db, 'categories'), where('contentType', '==', contentType)));
      snap.forEach(d => parentPickerCategories.push({ id: d.id, title: d.data()?.title || d.id, parentId: d.data()?.parentId || null }));
    } catch (_) { /* أفضل جهد — تبقى القائمة فارغة عند الفشل */ }
  }
  try {
    const lastParent = localStorage.getItem(LAST_PARENT_KEY) || '';
    if (lastParent && !selectedParentId && categoryById(lastParent)) {
      selectedParentId = lastParent;
      selectedParentLabel = breadcrumbLabel(lastParent);
      updateParentToggleLabel();
    }
  } catch (_) {}
  const panel = document.querySelector('#site-import-parent-panel');
  if (panel && !panel.classList.contains('hidden')) renderParentPicker(document.querySelector('#site-import-parent-search')?.value || '');
}

function toggleParentPicker(contentType) {
  const panel = document.querySelector('#site-import-parent-panel');
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  if (!willOpen) return;
  const search = document.querySelector('#site-import-parent-search');
  if (search) search.value = '';
  if (parentPickerContentType !== contentType) refreshParentPicker(contentType).then(() => renderParentPicker(''));
  else renderParentPicker('');
  if (search) setTimeout(() => search.focus(), 50);
}

function selectParent(id) {
  selectedParentId = id || '';
  selectedParentLabel = id ? breadcrumbLabel(id) : '— بدون (قسم رئيسي مستقل) —';
  updateParentToggleLabel();
  try { localStorage.setItem(LAST_PARENT_KEY, selectedParentId); } catch (_) {}
  document.querySelector('#site-import-parent-panel')?.classList.add('hidden');
}

function renderParentPicker(searchValue) {
  const list = document.querySelector('#site-import-parent-list');
  const breadcrumbEl = document.querySelector('#site-import-parent-breadcrumb');
  if (!list || !breadcrumbEl) return;
  list.innerHTML = '';

  const addRow = (label, onSelect, { hasChildren = false, onEnter = null } = {}) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.className = 'secondary-button';
    selectButton.style.cssText = 'flex:1;text-align:right';
    selectButton.textContent = label;
    selectButton.addEventListener('click', onSelect);
    row.appendChild(selectButton);
    if (hasChildren) {
      const enterButton = document.createElement('button');
      enterButton.type = 'button';
      enterButton.className = 'secondary-button';
      enterButton.title = 'فتح هذا القسم لعرض ما بداخله';
      enterButton.textContent = '◂ فتح';
      enterButton.addEventListener('click', onEnter);
      row.appendChild(enterButton);
    }
    list.appendChild(row);
  };

  const trimmed = (searchValue || '').trim();
  if (trimmed) {
    breadcrumbEl.textContent = `نتائج البحث عن «${trimmed}»`;
    const lower = trimmed.toLowerCase();
    const matches = parentPickerCategories.filter(c => c.title.toLowerCase().includes(lower)).slice(0, 60);
    if (!matches.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.style.margin = '4px 0';
      empty.textContent = 'لا نتائج.';
      list.appendChild(empty);
      return;
    }
    for (const cat of matches) addRow(breadcrumbLabel(cat.id), () => selectParent(cat.id));
    return;
  }

  breadcrumbEl.innerHTML = '';
  const crumbs = ['الجذر', ...parentPickerPath.map(id => categoryById(id)?.title || id)];
  crumbs.forEach((label, i) => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = label;
    a.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer';
    a.addEventListener('click', (e) => { e.preventDefault(); parentPickerPath = parentPickerPath.slice(0, i); renderParentPicker(''); });
    breadcrumbEl.appendChild(a);
    if (i < crumbs.length - 1) breadcrumbEl.appendChild(document.createTextNode('  ←  '));
  });

  if (!parentPickerPath.length) addRow('— بدون (قسم رئيسي مستقل) —', () => selectParent(''));
  const currentParentId = parentPickerPath.length ? parentPickerPath[parentPickerPath.length - 1] : null;
  const items = childrenOf(currentParentId);
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.margin = '4px 0';
    empty.textContent = 'لا توجد أقسام فرعية هنا.';
    list.appendChild(empty);
  }
  for (const cat of items) {
    const hasChildren = childrenOf(cat.id).length > 0;
    addRow(cat.title, () => selectParent(cat.id), {
      hasChildren,
      onEnter: (e) => { e.stopPropagation(); parentPickerPath = [...parentPickerPath, cat.id]; renderParentPicker(''); },
    });
  }
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
  if (typeSelect) refreshParentPicker(typeSelect.value);
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

async function importOneSeries(item, index, contentType, parentCategoryId, forcedWatchSuffix) {
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
    // مثال رابط حلقة يدوي (لو محطوط) يتخطّى التخمين التلقائي كلياً — يُطبَّق
    // نفسه على كل الأعمال بهذا الاستيراد بدل اكتشاف نمط مستقل لكل عمل.
    const watchSuffix = forcedWatchSuffix !== undefined
      ? forcedWatchSuffix
      : (seasonEpisodes.length ? await ensureWatchSuffix(item.url, seasonEpisodes[0].url) : '');
    for (const ep of seasonEpisodes) {
      if (!ep.url) continue;
      const n = Number.isFinite(ep.episodeNumber) ? ep.episodeNumber : episodeCount + 1;
      const title = ep.title || `${dataTitle} - الحلقة ${n}`;
      const id = hashId(`episode|${seasonId}|${ep.url}`);
      ops.push(episodeOp(id, seasonId, title, applyWatchSuffix(ep.url, watchSuffix), n, ep.thumbnail || thumbnail));
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
  const parentCategoryId = selectedParentId || '';
  const watchExample = card.querySelector('#site-import-watch-example').value.trim();
  if (!isValidHttpUrl(url)) { updateProgress('أدخل رابط صفحة القائمة أولاً (يبدأ بـ http:// أو https://).'); return; }
  if (!firebaseReady || !auth || !db) { updateProgress('تعذر الاتصال بخدمة لوحة التحكم. أعد تحميل الصفحة وحاول مرة أخرى.'); return; }
  if (!auth.currentUser) { updateProgress('سجّل الدخول إلى لوحة التحكم أولاً.'); return; }
  if (watchExample && !isValidHttpUrl(watchExample)) { updateProgress('رابط مثال الحلقة غير صالح — امسحه أو صحّحه.'); return; }

  // لو محطوط، يتجاوز اكتشاف نمط المشاهدة التلقائي كلياً لكل هذا الاستيراد.
  const forcedWatchSuffix = watchExample ? deriveWatchSuffixFromExample(watchExample) : undefined;

  try {
    localStorage.setItem(LAST_URL_KEY, url);
    localStorage.setItem(LAST_TYPE_KEY, contentType);
    localStorage.setItem(LAST_PARENT_KEY, parentCategoryId);
    localStorage.setItem(LAST_WATCH_EXAMPLE_KEY, watchExample);
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
      // وwatchSuffixCache عبر الدورات؛ هذا ما يخلي كل عمل مكتمل يُتخطّى
      // فوراً بمجرد ما نكتشف إنه ما فيه جديد فيه، بدل إعادة كتابته بالكامل
      // كل مرة، ويمنع إعادة اكتشاف مقطع "watch" من الصفر لكل عمل بكل دورة.
      const preservedWatchSuffixCache = currentState.watchSuffixCache;
      currentState = freshState();
      currentState.knownIds = Array.from(knownIds);
      currentState.watchSuffixCache = preservedWatchSuffixCache || {};
      currentState.startedAt = new Date().toISOString();
      currentState.pages = await discoverCatalog(url);
      saveState();
    }
    while (currentState.seriesIndex < currentState.pages.length) {
      if (stopRequested) throw new Error('__STOP__');
      const result = await importOneSeries(currentState.pages[currentState.seriesIndex], currentState.seriesIndex, contentType, parentCategoryId, forcedWatchSuffix);
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
