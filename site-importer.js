import {
  doc,
  serverTimestamp,
  writeBatch,
  collection,
  query,
  where,
  getDocs,
  setDoc,
  deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const WORKER_BASE_URL = 'https://binsheikh-api.binsheikh.workers.dev';
const SYNC_SECRET_STORAGE_KEY = 'binsheikh-admin-sync-secret';
const STATE_PREFIX = 'siteAutoImportStateV2:';
const LAST_URL_KEY = 'siteAutoImportLastUrl';
const LAST_TYPE_KEY = 'siteAutoImportLastType';
const LAST_PARENT_KEY = 'siteAutoImportLastParent';
const LAST_WATCH_EXAMPLE_KEY = 'siteAutoImportLastWatchExample';
const LAST_PAGE_EXAMPLE_KEY = 'siteAutoImportLastPageExample';
const BATCH_SIZE = 450;
const PAGE_LIMIT = 1000;
// أقصى عدد صفحات حلقات لعمل واحد — أقل بكثير من PAGE_LIMIT (المستخدم
// لصفحة القائمة الرئيسية اللي فعلاً ممكن يكون فيها مئات الصفحات). ما فيه
// مسلسل واحد يحتاج فعلياً أكثر من هذا لصفحات قائمة حلقاته — لو صار،
// الأرجح مصدر "الصفحة التالية" بموقع المصدر يلف على نفسه (رابط متغيّر
// بدون نهاية فعلية)، فنوقف عند هذا الحد بدل ما نعلّق المهمة كاملة عليه
// لساعات.
const SERIES_PAGE_LIMIT = 60;
// مهلة أقصى لكل طلب لووركر الاستيراد — بدونها طلب واحد عالق (شبكة، أو
// الووركر نفسه معلّق بجلب صفحة المصدر) يوقف المهمة كاملة بلا أي رسالة
// خطأ ولا إمكانية إيقاف حقيقية، لأن "إيقاف آمن" يُفحص فقط بين الطلبات لا
// أثناء انتظار طلب واحد عالق.
const WORKER_TIMEOUT_MS = 25000;

let firebaseReady = false;
let auth = null;
let db = null;

let adminSyncSecret = '';
try { adminSyncSecret = sessionStorage.getItem(SYNC_SECRET_STORAGE_KEY) || ''; } catch (_) {}

let running = false;
let stopRequested = false;
// طلب الووركر الحالي قيد الانتظار (لو فيه) — يسمح لزر «إيقاف آمن» بقطع
// طلب عالق فوراً بدل انتظار مهلته (25 ثانية) أو أكثر لو تبويب المتصفح
// بالخلفية أخّر تنفيذ مؤقّت القطع التلقائي (راجع worker() تحت).
let activeAbortController = null;
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
    version: 7, pages: [], seriesIndex: 0, doneSeries: 0, importedEpisodes: 0, importedCategories: 0,
    importedMergedSources: 0, reclassifiedCount: 0,
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
  const controller = new AbortController();
  activeAbortController = controller;
  const timeout = setTimeout(() => controller.abort(), WORKER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${WORKER_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      // قُطع الطلب إما تلقائياً (مهلة 25 ثانية) أو يدوياً بزر «إيقاف آمن»
      // (راجع مستمع الزر أدناه، يستدعي activeAbortController.abort() فوراً).
      // التفريق بينهما بعلامة stopRequested — إيقاف يدوي يظهر كإيقاف آمن
      // عادي، لا كخطأ مهلة مربك.
      if (stopRequested) throw new Error('__STOP__');
      throw new Error(`انتهت مهلة الانتظار (${WORKER_TIMEOUT_MS / 1000} ثانية) بلا رد من الخادم — ${body?.url || path}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (activeAbortController === controller) activeAbortController = null;
  }
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

// بعض المواقع لا تضع أي رابط "الصفحة التالية" قابل للاكتشاف تلقائياً بصفحة
// القائمة (رابط مخفي بجافاسكريبت، أو نمط ترقيم غير معتاد)، فيتوقف
// discoverCatalog بعد الصفحة الأولى فقط رغم وجود صفحات أخرى فعلياً. لو
// المستخدم حطّ "رابط الصفحة الثانية" يدوياً، نقارنه برابط الصفحة الأولى
// (المدخل بالنموذج) لاستخراج نمط الترقيم (الفرق الوحيد المتوقع رقم الصفحة
// نفسه، زي ".../page/2/" مقابل ".../page/3/")، ثم نولّد روابط الصفحات
// التالية مباشرة بدل انتظار اكتشافها من HTML الموقع.
function derivePageUrlPattern(startUrl, exampleUrl) {
  try {
    const trimSlash = (s) => (s.endsWith('/') ? s.slice(0, -1) : s);
    const base = trimSlash(startUrl);
    const example = trimSlash(exampleUrl);
    if (!example.startsWith(base) || example === base) return null;
    const suffix = example.slice(base.length); // مثلاً "/page/2"
    const match = suffix.match(/\d+(?!.*\d)/); // آخر رقم بالمقطع المتبقي (رقم الصفحة)
    if (!match) return null;
    const digits = match[0];
    const idx = suffix.lastIndexOf(digits);
    const template = suffix.slice(0, idx) + '{page}' + suffix.slice(idx + digits.length);
    return { base, template };
  } catch (_) { return null; }
}
function pageUrlFor(pattern, pageNum) {
  return `${pattern.base}${pattern.template.replace('{page}', String(pageNum))}/`;
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
      // مصدر واحد بالبداية دائماً، مُرقَّم ترتيبياً — هذا بالضبط ما يظهر
      // كزر بالمشغّل ("سيرفر 1"). راجع episodeSourceMergeOp أدناه لكيف
      // يضاف "سيرفر 2" لاحقاً عند استيراد نفس العمل من موقع آخر.
      sources: [{ label: 'سيرفر 1', url: sourceUrl }],
      directUrl: null,
      protected: false,
      sourceHeaders: {},
      apiHeaders: {},
      order: Number.isFinite(order) ? order : 0,
      updatedAt: serverTimestamp(),
    }, { merge: true }),
  };
}

// دمج المصادر عبر المواقع: نفس العمل (مسلسل/فلم/أنمي) مستورد سابقاً من
// موقع آخر لنفس القسم الوجهة — بدل تكرار قسم/حلقة منفصلة بالكامل، تُضاف
// هذه الحلقة الجديدة كمصدر إضافي لنفس مستند الحلقة الموجود (sources[]).
// تطبيق المشغّل يقرأ هذه القائمة كسيرفرات بديلة — لو فشل السيرفر الأول
// يجرّب التالي تلقائياً (راجع channel_source_resolver.dart بمستودع
// BinSheikh وwatch_screen.dart بمستودع sports_player).
//
// مطابقة العنوان تتجاهل التشكيل واختلافات الألف/الياء/التاء المربوطة
// الشائعة بالعربية، وتختصر لحروف/أرقام فقط — عناوين متطابقة معنىً لكن
// بإملاء مختلف قليلاً بين موقعين لا تفوّت الدمج بسبب هذا فقط.
function normalizeTitleForMatch(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // diacritics لاتينية (لو وُجدت)
    .replace(/[ً-ٰٟ]/g, '') // تشكيل عربي
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// كشف نوع المحتوى الفعلي لكل عنصر على حدة — لصفحة قائمة مختلطة (أفلام
// ومسلسلات وأنمي بنفس الرابط) بدل تصنيف كل شيء بالنوع الواحد المختار
// بالنموذج بغض النظر عن حقيقته.
//
// فيلم مقابل عمل بحلقات: إشارة بنائية موثوقة تماماً — عنصر بلا مواسم
// وبحلقة واحدة أو بلا حلقات (صفحة مشاهدة مباشرة) هو فيلم، بغض النظر عن
// النوع المختار. نفحصها دائماً لأننا أصلاً نجلب هذه البيانات لكل عنصر.
//
// أنمي مقابل مسلسل: لا توجد إشارة بنائية موثوقة (الاثنان مواسم+حلقات) —
// فقط كلمات دالة بالرابط/العنوان، وغيابها لا يعني أبداً "ليس أنمي" (أنمي
// كثير بعناوين مترجمة عربياً بلا أي كلمة إنجليزية دالة). لذلك هذا الاتجاه
// يُستخدم فقط للترقية لأنمي (حتى لو اختار المستخدم مسلسلات)، لا للتخفيض
// منه — تخمين "ليس أنمي" من غياب كلمة غير موثوق بما يكفي ليُبنى عليه قرار.
const ANIME_HINT_WORDS = ['anime', 'أنمي', 'انمي', 'animeworld', 'crunchyroll', 'manga', 'مانجا'];
function looksLikeAnime(item) {
  const text = `${item.url} ${item.title || ''}`.toLowerCase();
  return ANIME_HINT_WORDS.some((word) => text.includes(word));
}
function guessContentType(item, collected, selectedType) {
  if (selectedType === 'channels') return selectedType; // بث مباشر، بنية مختلفة تماماً — لا نلمسها
  const hasEpisodicStructure = collected.seasons.length > 0 || collected.episodes.length > 1;
  if (!hasEpisodicStructure) return 'movies';
  if (looksLikeAnime(item)) return 'anime';
  return selectedType === 'movies' ? 'series' : selectedType;
}

// سجل "المواقع المعروفة" (Firestore: importSites/{domain}) — بديل مؤكَّد
// لتخمين guessContentType أعلاه لأي موقع يُضاف هنا مرة واحدة: نوعه بيقين
// بدل تخمين تلقائي بلا دليل قاطع (تحديداً أنمي مقابل مسلسل، حيث لا توجد
// إشارة بنائية موثوقة أصلاً). يُحمَّل مرة واحدة لعمر الصفحة ويُحدَّث محلياً
// مع كل إضافة/حذف بدل إعادة القراءة من Firestore في كل مرة.
let knownSites = new Map(); // domain -> {contentType, label}
let knownSitesLoaded = false;

function domainFromUrl(value) {
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch (_) { return ''; }
}

async function loadKnownSites() {
  if (knownSitesLoaded || !db) return;
  knownSitesLoaded = true;
  try {
    const snap = await getDocs(collection(db, 'importSites'));
    snap.forEach((d) => {
      const data = d.data() || {};
      knownSites.set(d.id, { contentType: data.contentType || 'series', label: data.label || '' });
    });
  } catch (_) { /* أفضل جهد — بدون السجل، الاستيراد يرجع للتخمين التلقائي كالمعتاد */ }
  renderKnownSitesList();
}

async function addKnownSite(rawDomain, contentType) {
  const domain = domainFromUrl(rawDomain) || rawDomain.trim().toLowerCase().replace(/^www\./, '');
  if (!domain || !domain.includes('.')) {
    updateProgress('أدخل دومين صالحاً (مثلاً example.com) قبل الإضافة.');
    return;
  }
  try {
    await setDoc(doc(db, 'importSites', domain), {
      domain, contentType, addedAt: serverTimestamp(),
    }, { merge: true });
    knownSites.set(domain, { contentType, label: '' });
    renderKnownSitesList();
  } catch (_) {
    window.alert('تعذر إضافة الموقع. تحقق من قواعد Firestore وحاول مرة أخرى.');
  }
}

async function removeKnownSite(domain) {
  try {
    await deleteDoc(doc(db, 'importSites', domain));
    knownSites.delete(domain);
    renderKnownSitesList();
  } catch (_) {
    window.alert('تعذر حذف الموقع. حاول مرة أخرى.');
  }
}

const CONTENT_TYPE_LABELS = { anime: '🍥 أنمي', series: '📺 مسلسلات', movies: '🎬 أفلام', channels: '📺 قنوات' };

function renderKnownSitesList() {
  const list = document.querySelector('#site-import-known-list');
  if (!list) return;
  if (!knownSites.size) {
    list.innerHTML = '<p class="muted" style="margin:0">لا مواقع مضافة بعد.</p>';
    return;
  }
  list.innerHTML = [...knownSites.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, info]) => `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid rgba(255,255,255,0.12);border-radius:8px">
        <span style="flex:1;direction:ltr;text-align:left">${domain}</span>
        <span class="muted">${CONTENT_TYPE_LABELS[info.contentType] || info.contentType}</span>
        <button type="button" class="secondary-button" data-remove-known-site="${domain}">🗑</button>
      </div>
    `).join('');
  list.querySelectorAll('[data-remove-known-site]').forEach((button) => {
    button.addEventListener('click', () => removeKnownSite(button.dataset.removeKnownSite));
  });
}

// عند لصق/تعديل رابط الاستيراد: لو دومينه مسجَّل بسجل المواقع المعروفة،
// يملأ حقل «نوع المحتوى» تلقائياً بنوعه المؤكَّد ويظهر تنبيهاً — بدل ترك
// المستخدم يختار يدوياً ويخاطر بنوع خاطئ لموقع يعرف نوعه فعلاً مسبقاً.
function applyKnownSiteHint(urlValue, typeSelect, hintEl) {
  const domain = domainFromUrl(urlValue);
  const known = domain ? knownSites.get(domain) : null;
  if (!known) {
    hintEl.classList.add('hidden');
    return;
  }
  typeSelect.value = known.contentType;
  hintEl.textContent = `✓ موقع معروف (${domain}) — النوع: ${CONTENT_TYPE_LABELS[known.contentType] || known.contentType}`;
  hintEl.classList.remove('hidden');
}

// ذاكرة مؤقتة (لعمر المهمة الحالية فقط) لأقسام كل نوع محتوى — تُجلب مرة
// واحدة لكل نوع، وتُحدَّث محلياً كل ما أنشأنا قسماً جديداً بنفس هذا
// الاستيراد، بدل استعلام Firestore لكل عمل على حدة. خانة منفصلة لكل نوع
// (لا خانة واحدة) لأن صفحة قائمة مختلطة قد تُنتج أنواعاً مختلفة متتالية
// (راجع guessContentType) — خانة واحدة كانت ستُفرَّغ وتُعاد تعبئتها من
// Firestore بكل تبديل نوع بدل الاستفادة من الذاكرة فعلياً.
let existingCategoriesCacheByType = new Map();
async function loadExistingCategories(contentType) {
  if (existingCategoriesCacheByType.has(contentType)) {
    return existingCategoriesCacheByType.get(contentType);
  }
  const list = [];
  try {
    const snap = await getDocs(query(collection(db, 'categories'), where('contentType', '==', contentType)));
    snap.forEach(d => list.push({ id: d.id, title: d.data()?.title || '', parentId: d.data()?.parentId || null }));
  } catch (_) { /* أفضل جهد — عدم العثور على تطابق يعني إنشاء قسم جديد كالمعتاد */ }
  existingCategoriesCacheByType.set(contentType, list);
  return list;
}
function rememberNewCategory(contentType, id, title, parentId) {
  existingCategoriesCacheByType.get(contentType)?.push({ id, title, parentId: parentId || null });
}
function findExistingCategory(list, parentId, title) {
  const norm = normalizeTitleForMatch(title);
  if (!norm) return null;
  const target = parentId || null;
  return list.find(c => (c.parentId || null) === target && normalizeTitleForMatch(c.title) === norm) || null;
}

// حلقات قسم/موسم موجود مسبقاً — تُجلب مرة واحدة فقط لكل موسم فعلياً محتاج
// فحص تكرار (موسم جديد كلياً بهذا الاستيراد لا يحتاج، لا يوجد تحته شيء بعد).
async function loadExistingEpisodes(seasonId) {
  const list = [];
  try {
    const snap = await getDocs(query(collection(db, 'channels'), where('categoryId', '==', seasonId)));
    snap.forEach(d => {
      const data = d.data() || {};
      list.push({
        id: d.id,
        title: data.title || '',
        order: Number(data.order) || 0,
        sourceUrl: data.sourceUrl || '',
        sources: Array.isArray(data.sources) ? data.sources : [],
      });
    });
  } catch (_) {}
  return list;
}
// رقم الحلقة أدق من العنوان (عناوين الحلقات كثيراً ما تتطابق حرفياً بين
// مواقع مختلفة أصلاً، لكن رقم الحلقة أقل عرضة لاختلافات صياغة العنوان).
function findExistingEpisode(list, order, title) {
  if (Number.isFinite(order)) {
    const byOrder = list.find(e => e.order === order);
    if (byOrder) return byOrder;
  }
  const norm = normalizeTitleForMatch(title);
  if (!norm) return null;
  return list.find(e => normalizeTitleForMatch(e.title) === norm) || null;
}
function episodeSourceMergeOp(existing, newUrl) {
  const sources = existing.sources.length
    ? existing.sources.slice()
    : (existing.sourceUrl ? [{ label: 'سيرفر 1', url: existing.sourceUrl }] : []);
  if (sources.some(s => s.url === newUrl)) return null; // نفس الرابط مضاف مسبقاً — لا شيء جديد
  sources.push({ label: `سيرفر ${sources.length + 1}`, url: newUrl });
  return {
    id: existing.id,
    kind: 'episode-merge',
    run: batch => batch.set(doc(db, 'channels', existing.id), {
      sources,
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
    <div class="site-import-form">
      <fieldset class="source-settings-card">
        <legend>🔗 رابط الاستيراد</legend>
        <label>رابط صفحة القائمة
          <input id="site-import-url" type="url" placeholder="https://example.com/anime-list/" />
        </label>
        <p id="site-import-known-hint" class="muted hidden" style="margin:-6px 0 0"></p>
        <details id="site-import-known-sites-panel" class="source-headers">
          <summary>🌐 المواقع المعروفة (نوع مؤكَّد بدل التخمين)</summary>
          <div id="site-import-known-list" style="display:flex;flex-direction:column;gap:6px;margin:10px 0"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input id="site-import-known-domain" type="text" placeholder="دومين الموقع، مثلاً: example.com" style="flex:1;min-width:160px" />
            <select id="site-import-known-type">
              <option value="anime">🍥 أنمي</option>
              <option value="series">📺 مسلسلات</option>
              <option value="movies">🎬 أفلام</option>
              <option value="channels">📺 قنوات</option>
            </select>
            <button type="button" id="site-import-known-add" class="secondary-button">+ إضافة</button>
          </div>
          <p class="muted" style="margin:6px 0 0">أضف أي موقع تستورد منه بانتظام مع نوعه الحقيقي — الاستيراد يستخدم هذا النوع بيقين لأي رابط من نفس الدومين بدل تخمينه تلقائياً، ويملأ حقل «نوع المحتوى» تحت هذا تلقائياً عند لصق رابط دومين معروف.</p>
        </details>
      </fieldset>

      <fieldset class="source-settings-card">
        <legend>🎯 نوع المحتوى والقسم الوجهة</legend>
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
        <div id="site-import-parent-panel" class="hidden source-headers">
          <input id="site-import-parent-search" type="text" placeholder="ابحث عن قسم بالاسم…" style="width:100%;margin-bottom:8px;box-sizing:border-box" />
          <div id="site-import-parent-breadcrumb" class="muted" style="margin-bottom:6px;font-size:0.85em"></div>
          <div id="site-import-parent-list" style="max-height:260px;overflow:auto;display:flex;flex-direction:column;gap:4px"></div>
        </div>
        <p class="muted" style="margin:8px 0 0">اتركه فارغاً ليضيف كل عمل كقسم رئيسي مستقل، أو تصفّح/ابحث عن أي قسم موجود (بأي مستوى) — أنشئه أولاً بزر «+ إضافة» ← «📁 قسم» لو ما كان موجوداً — ليضيف كل الأعمال المستورَدة بداخله.</p>
      </fieldset>

      <details class="source-headers">
        <summary>⚙️ أمثلة روابط لتحسين الدقة <span class="optional-label">اختياري</span></summary>
        <label>رابط الصفحة الثانية من القائمة
          <input id="site-import-page-example" type="url" placeholder="https://example.com/category/name/page/2/" />
        </label>
        <p class="muted" style="margin:0">القسم اللي له عدة صفحات (زر «التالي» أو أرقام صفحات أسفل القائمة) — لو الاستيراد يجلب الصفحة الأولى فقط ويتوقف، افتح صفحة رقم 2 من نفس القسم بالموقع والصق رابطها هنا كما هو. يُستخرج منه نمط الترقيم (مثلاً «page/2/») ويُستخدم لتوليد بقية الصفحات مباشرة بدل انتظار اكتشافها تلقائياً من الموقع.</p>
        <label style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">مثال رابط حلقة تعمل فعلياً
          <input id="site-import-watch-example" type="url" placeholder="https://example.com/watch/episodes/serie-x-season-1-episode-2/see/" />
        </label>
        <p class="muted" style="margin:0">اتركه فارغاً ليكتشف الكود نمط رابط المشاهدة تلقائياً لكل عمل على حدة (الافتراضي). لو حطيته، يُستخدم مباشرة لكل حلقات كل الأعمال بهذا الاستيراد بدل التخمين — افتح أي حلقة بالموقع فعلياً وتأكد إنها تشتغل، والصق رابطها هنا كما هو.</p>
      </details>

      <div class="site-import-actions">
        <div id="site-import-progress" class="form-message" role="status">جاهز.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" id="site-import-start">بدء / استئناف</button>
          <button type="button" id="site-import-stop" class="secondary-button">إيقاف آمن</button>
          <button type="button" id="site-import-reset" class="secondary-button">إعادة ضبط المهمة</button>
          <button type="button" id="site-import-close" class="secondary-button">إغلاق</button>
        </div>
        <p class="muted" style="margin:0">الإيقاف لا يحذف أي بيانات؛ يمكن استئناف المهمة لاحقاً. بعد اكتمال المهمة، ضغط «بدء / استئناف» مرة ثانية (مثلاً بعد يوم) يتحقق من الموقع من جديد لكنه يتخطى كل عمل مستورد سابقاً دون تغيير ويكتب فقط الحلقات الجديدة فعلاً. لكل رابط مهمة مستقلة، فتغيير الرابط لا يؤثر على تقدّم المهام الأخرى.</p>
      </div>
    </div>`;
  const anchor = document.querySelector('#bulk-form-card') || document.querySelector('#category-form-card');
  anchor?.parentElement?.insertBefore(card, anchor);

  const urlInput = card.querySelector('#site-import-url');
  const typeSelect = card.querySelector('#site-import-type');
  const knownHint = card.querySelector('#site-import-known-hint');
  loadKnownSites().then(() => applyKnownSiteHint(urlInput.value, typeSelect, knownHint));
  urlInput.addEventListener('input', () => applyKnownSiteHint(urlInput.value, typeSelect, knownHint));
  card.querySelector('#site-import-known-add').addEventListener('click', () => {
    const domainInput = card.querySelector('#site-import-known-domain');
    const typeInput = card.querySelector('#site-import-known-type');
    addKnownSite(domainInput.value, typeInput.value);
    domainInput.value = '';
  });
  card.querySelector('#site-import-start').addEventListener('click', () => runImport());
  card.querySelector('#site-import-close').addEventListener('click', () => card.classList.add('hidden'));
  card.querySelector('#site-import-stop').addEventListener('click', () => {
    stopRequested = true;
    // يقطع أي طلب ووركر عالق حالياً فوراً بدل انتظار مهلته (25 ثانية)، أو
    // أكثر بكثير لو تبويب المتصفح بالخلفية (راجع activeAbortController).
    activeAbortController?.abort();
    updateProgress('سيتم الإيقاف الآن…');
  });
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
    const lastPageExample = localStorage.getItem(LAST_PAGE_EXAMPLE_KEY) || '';
    urlInput.value = lastUrl;
    typeSelect.value = lastType;
    card.querySelector('#site-import-watch-example').value = lastWatchExample;
    card.querySelector('#site-import-page-example').value = lastPageExample;
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

async function discoverCatalog(startUrl, pagePattern) {
  const series = [];
  const seenPages = new Set();
  let pageUrl = startUrl;
  let pageNum = 1;
  while (pageUrl && !seenPages.has(pageUrl) && seenPages.size < PAGE_LIMIT) {
    if (stopRequested) throw new Error('__STOP__');
    seenPages.add(pageUrl);
    updateProgress(`جاري قراءة قائمة المحتوى… صفحة ${seenPages.size}`);
    let data;
    try {
      data = await worker('/import/site', { action: 'catalog', url: pageUrl });
    } catch (error) {
      // ترقيم يدوي: صفحة مولَّدة (رقم 2 فأكثر) رجّعت خطأ (غالباً 404) —
      // هذا أسلوب مواقع كثيرة (خصوصاً ووردبرس) للإشارة "لا توجد صفحة بعد
      // هذي" بدل رابط "التالي" صريح أو صفحة فارغة بردّ 200. نعامله كنهاية
      // طبيعية للترقيم بدل فشل المهمة كاملة — طالما هذي ليست أول صفحة
      // (رابط المستخدم نفسه، لو فشل فهو خطأ حقيقي يستحق الإيقاف والتبليغ).
      if (pagePattern && pageNum > 1) break;
      throw error;
    }
    let addedAny = false;
    for (const item of (data.series || [])) {
      if (item.url && !series.some(x => x.url === item.url)) { series.push(item); addedAny = true; }
    }
    if (pagePattern) {
      // ترقيم يدوي: نتوقف فقط لما صفحة مولَّدة ترجع بلا عناصر جديدة فعلاً
      // (سواء فارغة كلياً، أو موقع أعاد توجيهها لنفس محتوى صفحة سابقة) —
      // بدل الاعتماد على "الصفحة التالية" المكتشفة تلقائياً من HTML الموقع.
      if (!addedAny) break;
      pageNum += 1;
      pageUrl = pageUrlFor(pagePattern, pageNum);
    } else {
      pageUrl = data.nextPageUrl || '';
    }
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
  while (pageUrl && !seen.has(pageUrl) && seen.size < SERIES_PAGE_LIMIT) {
    if (stopRequested) throw new Error('__STOP__');
    seen.add(pageUrl);
    // فقط من الصفحة الثانية فصاعداً — الصفحة الأولى مغطاة برسالة التقدّم
    // اللي كتبها importOneSeries قبل هذا الاستدعاء أصلاً.
    if (seen.size > 1) {
      updateProgress(`${item.title || 'العمل الحالي'} — قراءة صفحة الحلقات ${seen.size}…`);
    }
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

  // نوع المحتوى الفعلي لهذا العنصر تحديداً. الموقع المعروف (راجع سجل
  // «المواقع المعروفة» بالنموذج) نوعه بيقين مؤكَّد مسبقاً — يُستخدم مباشرة
  // بدل التخمين. غير ذلك، guessContentType تخمين بأفضل جهد (موثوق لفيلم
  // مقابل عمل بحلقات، أضعف لأنمي مقابل مسلسل). لو صفحة القائمة نوع واحد
  // فعلاً (الحالة الشائعة)، detectedType نفس contentType المختار دائماً
  // ولا يتغيّر شيء. لو مختلفة (صفحة قائمة مختلطة، أو موقع معروف بنوع غير
  // المختار بالنموذج)، القسم الوجهة المختار ينتمي لشجرة النوع الآخر أصلاً
  // فلا معنى لوضع هذا العنصر بداخله — يُضاف كقسم رئيسي مستقل بنوعه الحقيقي.
  const detectedType = knownSites.get(domainFromUrl(item.url))?.contentType
    || guessContentType(item, collected, contentType);
  const reclassified = detectedType !== contentType;
  const effectiveParentId = reclassified ? null : (parentCategoryId || null);
  const existingCategories = await loadExistingCategories(detectedType);

  // نفس العمل مستورد مسبقاً (من موقع آخر على الأغلب) بنفس القسم الوجهة؟
  // نعيد استخدام قسمه بدل إنشاء نسخة مكررة كاملة — بدون لمس عنوانه/صورته
  // الحاليين (قد يكونا عُدِّلا يدوياً). حلقاته المطابقة تكتسب هذا الموقع
  // كمصدر إضافي بدل تكرارها (راجع episodeSourceMergeOp تحت).
  const existingShow = findExistingCategory(existingCategories, effectiveParentId, dataTitle);
  const showId = existingShow ? existingShow.id : hashId(`category|${item.url}`);
  const ops = [];
  let episodeCount = 0; // عدّاد ترقيم احتياطي فقط لحلقة بلا رقم صريح
  let mergedSourceCount = 0;
  // يصير true أول ما أي موسم يكتب شيئاً فعلياً (حلقة جديدة أو مصدر مدمج) —
  // لو بقيت false للنهاية (كل المواسم بلا حلقات، أو موسم واحد بلا اسم
  // بلا حلقات) لا يُنشأ لا العمل ولا أي موسم منه إطلاقاً. راجع الشرحين
  // أسفل — هذا بالضبط ما يمنع إضافة مسلسل/موسم فارغ بلا حلقات حقيقية.
  let showHasAnyContent = false;

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
    // موسم بلا أي حلقة إطلاقاً (صفحة موسم معطوبة مؤقتاً، أو قسم فرعي بلا
    // محتوى فعلي بالموقع المصدر) — تخطّيه كلياً بدل إنشائه فارغاً. لا يمسّ
    // هذا موسماً/عملاً موجوداً مسبقاً بلوحة التحكم، فقط يمنع إنشاء واحد
    // جديد فارغ.
    if (!seasonEpisodes.length) continue;

    const hasSeasonName = collected.seasons.length > 0;
    const seasonTitle = season.title || `الموسم ${si + 1}`;
    let seasonId;
    let seasonIsNew;
    if (!hasSeasonName) {
      seasonId = showId;
      seasonIsNew = !existingShow;
    } else {
      const existingSeason = findExistingCategory(existingCategories, showId, seasonTitle);
      seasonIsNew = !existingSeason;
      seasonId = existingSeason
        ? existingSeason.id
        : hashId(`category|${item.url}|season|${season.url || season.title || si}`);
    }
    // مثال رابط حلقة يدوي (لو محطوط) يتخطّى التخمين التلقائي كلياً — يُطبَّق
    // نفسه على كل الأعمال بهذا الاستيراد بدل اكتشاف نمط مستقل لكل عمل.
    const watchSuffix = forcedWatchSuffix !== undefined
      ? forcedWatchSuffix
      : await ensureWatchSuffix(item.url, seasonEpisodes[0].url);
    // موسم/عمل جديد كلياً بهذا الاستيراد لا يحتاج فحص تكرار — لا يوجد أي
    // حلقة تحته أصلاً بعد. الموسم الموجود مسبقاً (من موقع آخر) فقط يحتاج
    // جلب حلقاته الحالية لمطابقتها بالحلقات الجديدة بدل تكرارها.
    const existingEpisodes = seasonIsNew ? [] : await loadExistingEpisodes(seasonId);
    const seasonOps = [];
    for (const ep of seasonEpisodes) {
      if (!ep.url) continue;
      const n = Number.isFinite(ep.episodeNumber) ? ep.episodeNumber : episodeCount + 1;
      const title = ep.title || `${dataTitle} - الحلقة ${n}`;
      const finalUrl = applyWatchSuffix(ep.url, watchSuffix);
      const match = existingEpisodes.length ? findExistingEpisode(existingEpisodes, n, title) : null;
      if (match) {
        const mergeOp = episodeSourceMergeOp(match, finalUrl);
        if (mergeOp) { seasonOps.push(mergeOp); mergedSourceCount += 1; }
      } else {
        const id = hashId(`episode|${seasonId}|${ep.url}`);
        seasonOps.push(episodeOp(id, seasonId, title, finalUrl, n, ep.thumbnail || thumbnail));
      }
      episodeCount += 1;
    }
    // كل حلقات هذا الموسم بلا رابط صالح، أو كلها مطابقة لمصدر موجود مسبقاً
    // فعلاً (لا شيء جديد لدمجه) — لا شيء يُكتب لهذا الموسم فلا معنى لإنشائه
    // لو كان جديداً.
    if (!seasonOps.length) continue;
    showHasAnyContent = true;
    if (hasSeasonName && seasonIsNew) {
      ops.push(categoryOp(seasonId, seasonTitle, showId, si + 1, thumbnail, detectedType));
      rememberNewCategory(detectedType, seasonId, seasonTitle, showId);
    }
    ops.push(...seasonOps);
  }
  if (!showHasAnyContent) return { categoryCount: 0, episodeCount: 0, mergedSourceCount: 0, reclassified: false };
  if (!existingShow) {
    ops.unshift(categoryOp(showId, dataTitle, effectiveParentId, index + 1, thumbnail, detectedType));
    rememberNewCategory(detectedType, showId, dataTitle, effectiveParentId);
  }
  // تخطّي كل ما سبق كتابته فعلياً — هذا ما يمنع إعادة استهلاك الوقت وحصة
  // Firestore على أعمال كاملة لم يتغيّر فيها شيء؛ لازم نفتح صفحة العمل
  // لنعرف هل فيه جديد، لكن ما نكتب إلا الجديد فعلاً. دمج مصدر (episode-
  // merge) مستثنى من هذا الفحص: مُعرّفه هو مستند حلقة من استيراد/موقع آخر
  // (مو مكتوب أصلاً بذاكرة knownIds الخاصة بهذه المهمة)، وepisodeSourceMergeOp
  // نفسها أعلاه ترجع null لو المصدر مضاف مسبقاً فلا حاجة لفحص إضافي هنا.
  const newOps = ops.filter(op => op.kind === 'episode-merge' || !knownIds.has(op.id));
  if (!newOps.length) return { categoryCount: 0, episodeCount: 0, mergedSourceCount: 0, reclassified: false };
  await commitOperations(newOps);
  for (const op of newOps) knownIds.add(op.id);
  const newCategoryCount = newOps.filter(op => op.kind === 'category').length;
  const newEpisodeCount = newOps.filter(op => op.kind === 'episode').length;
  const newMergedSourceCount = newOps.filter(op => op.kind === 'episode-merge').length;
  return {
    categoryCount: newCategoryCount,
    episodeCount: newEpisodeCount,
    mergedSourceCount: newMergedSourceCount,
    reclassified,
  };
}

async function runImport() {
  if (running) return;
  const card = document.querySelector('#site-import-card');
  const url = card.querySelector('#site-import-url').value.trim();
  const contentType = card.querySelector('#site-import-type').value;
  const parentCategoryId = selectedParentId || '';
  const watchExample = card.querySelector('#site-import-watch-example').value.trim();
  const pageExample = card.querySelector('#site-import-page-example').value.trim();
  if (!isValidHttpUrl(url)) { updateProgress('أدخل رابط صفحة القائمة أولاً (يبدأ بـ http:// أو https://).'); return; }
  if (!firebaseReady || !auth || !db) { updateProgress('تعذر الاتصال بخدمة لوحة التحكم. أعد تحميل الصفحة وحاول مرة أخرى.'); return; }
  if (!auth.currentUser) { updateProgress('سجّل الدخول إلى لوحة التحكم أولاً.'); return; }
  if (watchExample && !isValidHttpUrl(watchExample)) { updateProgress('رابط مثال الحلقة غير صالح — امسحه أو صحّحه.'); return; }
  if (pageExample && !isValidHttpUrl(pageExample)) { updateProgress('رابط مثال الصفحة الثانية غير صالح — امسحه أو صحّحه.'); return; }

  // لو محطوط، يتجاوز اكتشاف نمط المشاهدة التلقائي كلياً لكل هذا الاستيراد.
  const forcedWatchSuffix = watchExample ? deriveWatchSuffixFromExample(watchExample) : undefined;
  // لو محطوط، يتجاوز اكتشاف "الصفحة التالية" التلقائي من HTML الموقع كلياً
  // ويولّد روابط الصفحات مباشرة من النمط المستخرَج (راجع derivePageUrlPattern).
  const pagePattern = pageExample ? derivePageUrlPattern(url, pageExample) : null;
  if (pageExample && !pagePattern) { updateProgress('تعذّر فهم نمط رابط الصفحة الثانية — تأكد إنه نفس رابط صفحة القائمة بالضبط + جزء إضافي فيه رقم الصفحة.'); return; }
  // إعادة تحميل أقسام كل نوع من Firestore بداية كل مهمة استيراد — تجنّباً
  // لذاكرة مطابقة قديمة لو تغيّر شيء يدوياً بلوحة التحكم منذ آخر استيراد
  // بنفس الجلسة (راجع loadExistingCategories/findExistingCategory).
  existingCategoriesCacheByType = new Map();

  try {
    localStorage.setItem(LAST_URL_KEY, url);
    localStorage.setItem(LAST_TYPE_KEY, contentType);
    localStorage.setItem(LAST_PARENT_KEY, parentCategoryId);
    localStorage.setItem(LAST_WATCH_EXAMPLE_KEY, watchExample);
    localStorage.setItem(LAST_PAGE_EXAMPLE_KEY, pageExample);
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
      currentState.pages = await discoverCatalog(url, pagePattern);
      saveState();
    }
    while (currentState.seriesIndex < currentState.pages.length) {
      if (stopRequested) throw new Error('__STOP__');
      const result = await importOneSeries(currentState.pages[currentState.seriesIndex], currentState.seriesIndex, contentType, parentCategoryId, forcedWatchSuffix);
      currentState.importedCategories += result.categoryCount;
      currentState.importedEpisodes += result.episodeCount;
      // مهام محفوظة قبل إضافة هذا العدّاد لا تملكه أصلاً بذاكرتها المحفوظة.
      currentState.importedMergedSources = (currentState.importedMergedSources || 0) + (result.mergedSourceCount || 0);
      currentState.reclassifiedCount = (currentState.reclassifiedCount || 0) + (result.reclassified ? 1 : 0);
      currentState.doneSeries += 1;
      currentState.seriesIndex += 1;
      saveState();
      const mergedSuffix = currentState.importedMergedSources ? ` — ${currentState.importedMergedSources} مصدر إضافي لحلقات موجودة` : '';
      updateProgress(`تم ${currentState.doneSeries}/${currentState.pages.length} — ${currentState.importedEpisodes} حلقة جديدة${mergedSuffix}.`);
    }
    currentState.completed = true; saveState();
    const mergedNote = currentState.importedMergedSources
      ? ` و${currentState.importedMergedSources} مصدر إضافي أُضيف لحلقات موجودة مسبقاً (من موقع آخر لنفس العمل)`
      : '';
    // صفحة قائمة مختلطة (أفلام/مسلسلات/أنمي بنفس الرابط) — راجع
    // guessContentType: عناصر صُنِّفت بنوع مختلف عمّا اخترته بالنموذج،
    // وأُضيفت كقسم رئيسي مستقل بنوعها الصحيح بدل القسم الوجهة المختار.
    const reclassifiedNote = currentState.reclassifiedCount
      ? ` — تنبيه: ${currentState.reclassifiedCount} عنصر اكتُشف بنوع مختلف عن المختار (فيلم بلا حلقات، أو أنمي بكلمة دالة) وأُضيف كقسم رئيسي مستقل بنوعه الصحيح بدل داخل القسم الوجهة`
      : '';
    updateProgress(`اكتمل الفحص: ${currentState.importedCategories} قسم و${currentState.importedEpisodes} حلقة جديدة فعلاً${mergedNote} (ما تم تخطيه من المحتوى السابق لم تتم إعادة كتابته).${reclassifiedNote}`);
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
