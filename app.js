import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// عنوان Cloudflare Worker (بديل Firebase Cloud Functions — بدون خطة Blaze
// ولا حساب فوترة سعودي عبر CNTXT). استبدله بالعنوان الحقيقي بعد
// "wrangler deploy" — راجع cloudflare-worker/README.md.
const WORKER_BASE_URL = 'https://binsheikh-api.binsheikh.workers.dev';
// لا نضع ADMIN_SYNC_SECRET داخل JavaScript المنشور. يُدخل مشغّل لوحة التحكم
// المفتاح مرة واحدة لكل جلسة متصفح، ويبقى في sessionStorage ولا يدخل المستودع.
const SYNC_SECRET_STORAGE_KEY = 'binsheikh-admin-sync-secret';
let adminSyncSecret = '';
try {
  adminSyncSecret = sessionStorage.getItem(SYNC_SECRET_STORAGE_KEY) || '';
} catch (_) {}

function getAdminSyncSecret() {
  if (adminSyncSecret) return adminSyncSecret;
  const value = window.prompt('أدخل مفتاح مزامنة المباريات الخاص بالـ Worker:');
  if (!value?.trim()) throw new Error('لم يتم إدخال مفتاح المزامنة.');
  adminSyncSecret = value.trim();
  try { sessionStorage.setItem(SYNC_SECRET_STORAGE_KEY, adminSyncSecret); } catch (_) {}
  return adminSyncSecret;
}

// إعدادات تطبيق الويب من مشروع Firebase نفسه. لا تضع هنا كلمات مرور المستخدمين.
const firebaseConfig = {
  apiKey: 'AIzaSyAhbhgXXfR7A9AGsDk0c8GCp0bvvhyzw2g',
  authDomain: 'sports-stream-app-36a7a.firebaseapp.com',
  projectId: 'sports-stream-app-36a7a',
  storageBucket: 'sports-stream-app-36a7a.firebasestorage.app',
  messagingSenderId: '207449859236',
  appId: '1:207449859236:web:b371a927db431000ceb231',
  measurementId: 'G-YX8E8NCN8F',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const views = {
  loading: document.querySelector('#loading-view'),
  login: document.querySelector('#login-view'),
  dashboard: document.querySelector('#dashboard-view'),
};
const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginError = document.querySelector('#login-error');
const categoriesLoading = document.querySelector('#categories-loading');
const categoriesError = document.querySelector('#categories-error');
const categoriesEmpty = document.querySelector('#categories-empty');
const categoriesList = document.querySelector('#categories-list');
const categoriesCount = document.querySelector('#categories-count');
const categoryFormCard = document.querySelector('#category-form-card');
const categoryForm = document.querySelector('#category-form');
const categoryEditId = document.querySelector('#category-edit-id');
const categorySaveButton = document.querySelector('#category-save-button');
const categoryCloseButton = document.querySelector('#category-close-button');
const categoryFormMessage = document.querySelector('#category-form-message');
const categoryParent = document.querySelector('#category-parent');
const categoryContentType = document.querySelector('#category-content-type');
const contentTypeTabs = document.querySelectorAll('#content-type-tabs [data-content-type]');
const categoriesTitle = document.querySelector('#categories-title');
const categoriesContext = document.querySelector('#categories-context');
const categoryFormTitle = document.querySelector('#category-form-title');
const backToRoot = document.querySelector('#back-to-root');
const backToHome = document.querySelector('#back-to-home');
const retryCategories = document.querySelector('#retry-categories');
const groupButtons = document.querySelectorAll('.nav-group-button[data-group]');
const subNavs = document.querySelectorAll('[data-group-nav]');
const subNavButtons = document.querySelectorAll('.sub-nav [data-panel]');

// ---- تحديد متعدد وحذف جماعي (أقسام) ----
const categoriesSelectToggle = document.querySelector('#categories-select-toggle');
const categoriesBulkBar = document.querySelector('#categories-bulk-bar');
const categoriesSelectedCount = document.querySelector('#categories-selected-count');
const categoriesBulkDelete = document.querySelector('#categories-bulk-delete');
const categoriesSelectCancel = document.querySelector('#categories-select-cancel');
const categoriesSelectAll = document.querySelector('#categories-select-all');
let categorySelectMode = false;
let activeContentType = 'channels';
const selectedCategoryIds = new Set();

// ---- زر "+ إضافة" الموحّد وبطاقاته ----
const addMenuToggle = document.querySelector('#add-menu-toggle');
const addMenu = document.querySelector('#add-menu');
const addMenuChannelButton = addMenu.querySelector('[data-add-type="channel"]');
const addMenuMarqueeButton = addMenu.querySelector('[data-add-type="marquee"]');

const channelFormCard = document.querySelector('#channel-form-card');
const channelForm = document.querySelector('#channel-form');
const channelCategory = document.querySelector('#channel-category');
const channelTitle = document.querySelector('#channel-title');
const channelLogo = document.querySelector('#channel-logo');
const channelSourceUrl = document.querySelector('#channel-source-url');
const channelSourceType = document.querySelector('#channel-source-type');
const channelProtectedToggle = document.querySelector('#channel-protected-toggle');
const channelProtectionWrap = document.querySelector('#channel-protection-wrap');
const channelApiReferer = document.querySelector('#channel-api-referer');
const channelApiUserAgent = document.querySelector('#channel-api-user-agent');
const channelSourceReferer = document.querySelector('#channel-source-referer');
const channelSourceUserAgent = document.querySelector('#channel-source-user-agent');
const channelSourceHelp = document.querySelector('#channel-source-help');
const channelEditId = document.querySelector('#channel-edit-id');
const channelFormTitle = document.querySelector('#channel-form-title');
const channelSaveButton = document.querySelector('#channel-save-button');
const channelCloseButton = document.querySelector('#channel-close-button');
const channelFormMessage = document.querySelector('#channel-form-message');
const channelsSection = document.querySelector('#channels-section');
const channelsTitle = document.querySelector('#channels-title');
const channelsList = document.querySelector('#channels-list');
const channelsLoading = document.querySelector('#channels-loading');
const channelsEmpty = document.querySelector('#channels-empty');
const channelsCount = document.querySelector('#channels-count');
const CHANNELS_EMPTY_HTML = channelsEmpty.innerHTML;

// ---- تحديد متعدد وحذف جماعي (قنوات) ----
const channelsSelectToggle = document.querySelector('#channels-select-toggle');
const channelsBulkBar = document.querySelector('#channels-bulk-bar');
const channelsSelectedCount = document.querySelector('#channels-selected-count');
const channelsBulkDelete = document.querySelector('#channels-bulk-delete');
const channelsSelectCancel = document.querySelector('#channels-select-cancel');
const channelsSelectAll = document.querySelector('#channels-select-all');
let channelSelectMode = false;
const selectedChannelIds = new Set();

const marqueeFormCard = document.querySelector('#marquee-form-card');
const marqueeForm = document.querySelector('#marquee-form');
const marqueeFormTitle = document.querySelector('#marquee-form-title');
const marqueeText = document.querySelector('#marquee-text');
const marqueeFormMessage = document.querySelector('#marquee-form-message');
const marqueeSaveButton = document.querySelector('#marquee-save-button');
const marqueeCloseButton = document.querySelector('#marquee-close-button');
const marqueePreview = document.querySelector('#marquee-preview');

// ---- استيراد دفعة أقسام وقنوات ----
const bulkFormCard = document.querySelector('#bulk-form-card');
const bulkForm = document.querySelector('#bulk-form');
const bulkTextarea = document.querySelector('#bulk-json');
const bulkFormMessage = document.querySelector('#bulk-form-message');
const bulkSaveButton = document.querySelector('#bulk-save-button');
const bulkCloseButton = document.querySelector('#bulk-close-button');

let currentChannels = [];
let currentCategories = [];
let currentParentId = null;

// ---- المباريات (API-Football عبر Cloud Function) ----
const syncMatchesButton = document.querySelector('#sync-matches-button');
const syncWindowButton = document.querySelector('#sync-window-button');
const matchesStatusText = document.querySelector('#matches-status-text');
const matchesDebugText = document.querySelector('#matches-debug-text');
const matchesMessage = document.querySelector('#matches-message');

// ---- الرسائل (contactMessages) ----
const messagesLoading = document.querySelector('#messages-loading');
const messagesEmpty = document.querySelector('#messages-empty');
const messagesList = document.querySelector('#messages-list');
const messagesCount = document.querySelector('#messages-count');
const messagesBadge = document.querySelector('#messages-badge');
let currentMessages = [];

// ---- الشروط والأحكام / سياسة الخصوصية ----
const legalForm = document.querySelector('#legal-form');
const legalTerms = document.querySelector('#legal-terms');
const legalPrivacy = document.querySelector('#legal-privacy');
const legalMessage = document.querySelector('#legal-message');

// ---- الإعلانات (settings/ads) ----
const adsForm = document.querySelector('#ads-form');
const adsEnabled = document.querySelector('#ads-enabled');
const adsMessage = document.querySelector('#ads-message');
const admobAppId = document.querySelector('#admob-app-id');
const admobBannerId = document.querySelector('#admob-banner-id');
const admobInterstitialId = document.querySelector('#admob-interstitial-id');
const admobRewardedId = document.querySelector('#admob-rewarded-id');
const applovinSdkKey = document.querySelector('#applovin-sdk-key');
const applovinBannerId = document.querySelector('#applovin-banner-id');
const applovinInterstitialId = document.querySelector('#applovin-interstitial-id');
const applovinRewardedId = document.querySelector('#applovin-rewarded-id');
const unityGameId = document.querySelector('#unity-game-id');
const unityBannerId = document.querySelector('#unity-banner-id');
const unityInterstitialId = document.querySelector('#unity-interstitial-id');
const unityRewardedId = document.querySelector('#unity-rewarded-id');

function showView(name) {
  Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== name));
}

function resetCategories() {
  categoriesLoading.classList.remove('hidden');
  categoriesError.classList.add('hidden');
  categoriesEmpty.classList.add('hidden');
  categoriesList.classList.add('hidden');
  categoriesList.innerHTML = '';
  categoriesCount.textContent = 'جارٍ التحميل…';
  retryCategories.classList.add('hidden');
}

function showCategories(categories) {
  currentCategories = categories;
  categoriesLoading.classList.add('hidden');
  categoriesError.classList.add('hidden');
  renderCurrentCategoryView();
}

function closeAllFormCards() {
  categoryFormCard.classList.add('hidden');
  channelFormCard.classList.add('hidden');
  marqueeFormCard.classList.add('hidden');
  bulkFormCard.classList.add('hidden');
}

function updateAddMenuAvailability() {
  const disabled = currentParentId === null;
  addMenuChannelButton.disabled = disabled;
  addMenuMarqueeButton.disabled = disabled;
  addMenuChannelButton.classList.toggle('disabled-hint', disabled);
  addMenuMarqueeButton.classList.toggle('disabled-hint', disabled);
}

function openCategoryForm(existingId) {
  closeAllFormCards();
  const parent = currentCategories.find((item) => item.id === currentParentId);
  const parentTitle = parent?.title || '';
  categoryFormMessage.textContent = '';
  categoryFormMessage.classList.remove('error');
  if (existingId) {
    const category = currentCategories.find((item) => item.id === existingId);
    categoryEditId.value = existingId;
    categoryForm.elements.title.value = category?.title || '';
    categoryForm.elements.image.value = category?.iconUrl || '';
    categoryFormTitle.textContent = `تعديل: ${category?.title || ''}`;
    categoryContentType.value = category?.contentType || 'channels';
    categorySaveButton.textContent = 'حفظ التعديل';
  } else {
    categoryEditId.value = '';
    categoryForm.reset();
    categoryFormTitle.textContent = currentParentId ? `إضافة قسم داخل «${parentTitle}»` : 'إضافة قسم رئيسي';
    categorySaveButton.textContent = 'إضافة القسم';
  }
  categoryParent.value = currentParentId || '';
  categoryContentType.value = currentParentId ? (currentCategories.find((item) => item.id === currentParentId)?.contentType || activeContentType) : activeContentType;
  categoryFormCard.classList.remove('hidden');
}

function contentEntryLabel(contentType) {
  return ({ channels: 'قناة', movies: 'فيلم', series: 'مسلسل', anime: 'أنمي' }[contentType] || 'محتوى');
}

async function openChannelForm(existingId) {
  if (currentParentId === null) return;
  closeAllFormCards();
  const parent = currentCategories.find((item) => item.id === currentParentId);
  const contentType = parent?.contentType || activeContentType;
  const label = contentEntryLabel(contentType);
  channelCategory.value = currentParentId;
  channelFormMessage.textContent = '';
  channelFormMessage.classList.remove('error');

  const setSourceUi = (type) => {
    const streamType = ['web', 'api'].includes(type) ? type : 'hls';
    channelSourceType.value = streamType;
    channelProtectionWrap.classList.toggle('hidden', streamType !== 'hls');
    const checked = streamType === 'hls' ? channelProtectedToggle.checked : false;
    channelProtectedToggle.disabled = streamType !== 'hls';
    if (streamType === 'web') {
      channelSourceUrl.placeholder = 'https://example.com/live';
      channelSourceHelp.textContent = 'صفحة ويب: يحفظ الرابط ويحاول المشغل اكتشاف مصدر HLS/MP4 العام تلقائياً، وإذا تعذر التحقق يبقى داخل WebView.';
    } else if (streamType === 'api') {
      channelSourceUrl.placeholder = 'http://example.com/api/channel/4';
      channelSourceHelp.textContent = 'API: يحفظ رابط API المستقر فقط، ويجلب المشغل رابط HLS المؤقت أثناء التشغيل. Headers API للطلب الأول وHeaders التشغيل للرابط النهائي.';
    } else {
      channelSourceUrl.placeholder = 'https://example.com/live/playlist.m3u8';
      channelSourceHelp.textContent = 'HLS: يمكنك تفعيل حماية برابط مؤقت أو إيقافها لحفظ الرابط مباشرة. Referer/User-Agent محفوظان ضمن خصائص التشغيل.';
    }
    if (streamType !== 'hls') channelProtectedToggle.checked = false;
    else channelProtectedToggle.checked = checked;
  };
  channelSourceType.onchange = () => setSourceUi(channelSourceType.value);

  if (existingId) {
    const channel = currentChannels.find((item) => item.id === existingId);
    if (!channel) return;
    channelEditId.value = channel.id;
    channelTitle.value = channel.title || '';
    channelLogo.value = channel.logoUrl || '';
    const streamType = ['web', 'api'].includes(channel.streamType) ? channel.streamType : 'hls';
    const sourceHeaders = channel.sourceHeaders && typeof channel.sourceHeaders === 'object' ? channel.sourceHeaders : {};
    const apiHeaders = channel.apiHeaders && typeof channel.apiHeaders === 'object' ? channel.apiHeaders : {};
    channelApiReferer.value = apiHeaders.referer || '';
    channelApiUserAgent.value = apiHeaders['user-agent'] || apiHeaders.userAgent || '';
    channelSourceReferer.value = sourceHeaders.referer || '';
    channelSourceUserAgent.value = sourceHeaders['user-agent'] || sourceHeaders.userAgent || '';
    channelProtectedToggle.checked = channel.protected !== false;
    channelSourceType.value = streamType;
    if (streamType === 'web' || streamType === 'api') {
      channelSourceUrl.value = channel.sourceUrl || '';
    } else if (channel.protected !== false) {
      channelSourceUrl.value = '';
      try {
        const snapshot = await getDoc(doc(db, 'privateStreams', channel.id));
        channelSourceUrl.value = snapshot.data()?.url || '';
      } catch (_) {}
    } else {
      channelSourceUrl.value = channel.directUrl || '';
    }
    setSourceUi(streamType);
    channelFormTitle.textContent = `تعديل: ${channel.title || label}`;
    channelSaveButton.textContent = 'حفظ التعديل';
  } else {
    channelForm.reset();
    channelEditId.value = '';
    channelCategory.value = currentParentId;
    channelSourceType.value = 'hls';
    channelProtectedToggle.checked = true;
    channelApiReferer.value = '';
    channelApiUserAgent.value = '';
    channelSourceReferer.value = '';
    channelSourceUserAgent.value = '';
    setSourceUi('hls');
    channelFormTitle.textContent = `إضافة ${label} داخل «${parent?.title || ''}»`;
    channelSaveButton.textContent = 'حفظ';
  }
  channelFormCard.classList.remove('hidden');
}
function openMarqueeForm() {
  if (currentParentId === null) return;
  closeAllFormCards();
  const parent = currentCategories.find((item) => item.id === currentParentId);
  marqueeFormTitle.textContent = `نص متحرك لقسم «${parent?.title || ''}»`;
  marqueeText.value = parent?.marqueeText || '';
  marqueeFormMessage.textContent = '';
  marqueeFormMessage.classList.remove('error');
  marqueeFormCard.classList.remove('hidden');
}

function openBulkForm() {
  closeAllFormCards();
  bulkFormMessage.textContent = '';
  bulkFormMessage.classList.remove('error');
  bulkFormCard.classList.remove('hidden');
}

function renderMarqueePreview() {
  const parent = currentCategories.find((item) => item.id === currentParentId);
  if (currentParentId !== null && parent?.marqueeText) {
    marqueePreview.textContent = `🔄 ${parent.marqueeText}`;
    marqueePreview.classList.remove('hidden');
  } else {
    marqueePreview.classList.add('hidden');
  }
}

function renderChannelsForCurrentCategory() {
  if (currentParentId === null) {
    channelsSection.classList.add('hidden');
    return;
  }
  channelsSection.classList.remove('hidden');
  channelsLoading.classList.add('hidden');
  channelsEmpty.innerHTML = CHANNELS_EMPTY_HTML;
  const parent = currentCategories.find((item) => item.id === currentParentId);
  const contentType = parent?.contentType || activeContentType;
  const label = contentEntryLabel(contentType);
  const collectionLabel = ({ channels: 'قنوات', movies: 'أفلام', series: 'مسلسلات', anime: 'أنمي' }[contentType] || 'محتوى');
  channelsTitle.textContent = `${collectionLabel} «${parent?.title || ''}»`;
  const list = currentChannels
    .filter((channel) => channel.categoryId === currentParentId)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  channelsCount.textContent = `${list.length} ${collectionLabel}`;
  if (!list.length) {
    channelsEmpty.classList.remove('hidden');
    channelsList.classList.add('hidden');
    return;
  }
  channelsEmpty.classList.add('hidden');
  channelsList.innerHTML = list.map((channel, index) => {
    const logo = channel.logoUrl
      ? `<img class="channel-logo" src="${escapeHtml(channel.logoUrl)}" alt="${escapeHtml(channel.title || '')}" loading="lazy">`
      : `<div class="channel-logo category-image-placeholder">${contentType === 'anime' ? '🍥' : contentType === 'movies' ? '🎬' : contentType === 'series' ? '📺' : '📺'}</div>`;
    const checkbox = channelSelectMode ? `<label class="select-checkbox-wrap"><input type="checkbox" class="select-checkbox" data-select-channel="${escapeHtml(channel.id)}" ${selectedChannelIds.has(channel.id) ? 'checked' : ''}></label>` : '';
    const sourceType = ['web', 'api'].includes(channel.streamType) ? channel.streamType : 'hls';
    const sourceLabel = sourceType === 'web' ? 'صفحة ويب' : sourceType === 'api' ? 'API ديناميكي' : 'HLS / m3u8';
    const protectionLabel = sourceType === 'hls' ? (channel.protected === false ? 'بدون حماية' : 'حماية برابط مؤقت') : '';
    const status = [sourceLabel, protectionLabel].filter(Boolean).join(' • ');
    return `<article class="card channel-item content-item-card">${checkbox}<div class="content-card-media">${logo}</div><div class="channel-info content-card-info"><span class="content-card-number">${index + 1}</span><h3>${escapeHtml(channel.title || `${label} بلا اسم`)}</h3><p class="content-card-source">${escapeHtml(status)}</p></div><div class="channel-actions"><button type="button" data-edit-channel="${escapeHtml(channel.id)}">تعديل</button><button class="delete-category-button" type="button" data-delete-channel="${escapeHtml(channel.id)}">حذف</button></div></article>`;
  }).join('');
  channelsList.classList.remove('hidden');
}
function categoryMatchesContentType(category) {
  if (currentParentId) return true;
  // Existing categories without contentType remain in the original Channels area.
  return (category.contentType || 'channels') === activeContentType;
}

function renderCurrentCategoryView() {
  const parent = currentCategories.find((category) => category.id === currentParentId);
  if (currentParentId && !parent) currentParentId = null;
  const visibleCategories = currentCategories.filter(
    (category) => (category.parentId || null) === currentParentId,
  ).filter(categoryMatchesContentType);
  const isRoot = currentParentId === null;
  const parentTitle = parent?.title || '';
  const typeNames = { channels: 'القنوات', movies: 'الأفلام', series: 'المسلسلات', anime: 'الأنمي' };
  const activeTypeName = typeNames[activeContentType] || 'المحتوى';
  categoriesTitle.textContent = isRoot ? `أقسام ${activeTypeName}` : `داخل قسم: ${parentTitle}`;
  categoriesContext.textContent = isRoot
    ? 'اختر قسماً لعرض ما بداخله، أو أضف عنصراً من زر «+ إضافة».'
    : `كل قسم تضيفه هنا يصبح فرعياً داخل «${parentTitle}».`;
  backToRoot.classList.toggle('hidden', isRoot);
  categoriesCount.textContent = `${visibleCategories.length} قسم`;

  if (visibleCategories.length === 0) {
    categoriesEmpty.classList.remove('hidden');
    categoriesList.classList.add('hidden');
  } else {
    categoriesEmpty.classList.add('hidden');
    categoriesList.innerHTML = visibleCategories.map(({ id, ...category }, index) => {
      const title = escapeHtml(category.title || 'قسم بلا اسم');
      const image = category.iconUrl
        ? `<img class="category-image" src="${escapeHtml(category.iconUrl)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'), {className: 'category-image-placeholder', textContent: '⚽'}))">`
        : '<div class="category-image-placeholder" aria-hidden="true">⚽</div>';
      const childrenCount = currentCategories.filter((item) => item.parentId === id).length;
      const checkbox = categorySelectMode ? `<label class="select-checkbox-wrap"><input type="checkbox" class="select-checkbox" data-select-category="${escapeHtml(id)}" ${selectedCategoryIds.has(id) ? 'checked' : ''}></label>` : '';
      const orderControl = `<label class="order-control">الترتيب <input type="number" class="order-input" data-reorder-category="${escapeHtml(id)}" min="1" max="${visibleCategories.length}" value="${index + 1}"></label>`;
      return `<article class="card category-card">${checkbox}${image}<div class="category-details"><h3>${title}</h3><p class="category-meta"><span>${childrenCount ? `${childrenCount} أقسام داخلية` : 'لا توجد أقسام داخلية'}</span>${category.isPremium ? '<span class="premium-tag">اشتراك</span>' : '<span>عام</span>'}</p>${orderControl}<button class="open-category-button" type="button" data-open-category="${escapeHtml(id)}">فتح القسم</button><div class="category-tools"><button type="button" data-edit-category="${escapeHtml(id)}">تعديل</button><button class="delete-category-button" type="button" data-delete-category="${escapeHtml(id)}">حذف</button></div></div></article>`;
    }).join('');
    categoriesList.classList.remove('hidden');
  }

  renderMarqueePreview();
  renderChannelsForCurrentCategory();
  updateAddMenuAvailability();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

// ترتيب Swap: الرقم الجديد يتبادل مكانه مع العنصر الموجود في ذلك المركز فقط.
async function swapCategoryOrder(categoryId, newPosition) {
  const siblings = currentCategories
    .filter((item) => (item.parentId || null) === currentParentId)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const fromIndex = siblings.findIndex((item) => item.id === categoryId);
  const toIndex = newPosition - 1;
  if (fromIndex === -1 || toIndex < 0 || toIndex >= siblings.length || toIndex === fromIndex) {
    renderCurrentCategoryView();
    return;
  }
  const a = siblings[fromIndex];
  const b = siblings[toIndex];
  const orderA = a.order ?? 0;
  const orderB = b.order ?? 0;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'categories', a.id), { order: orderB });
    batch.update(doc(db, 'categories', b.id), { order: orderA });
    await batch.commit();
    await loadCategories();
  } catch (_) {
    window.alert('تعذر تبديل الترتيب. حاول مرة أخرى.');
    renderCurrentCategoryView();
  }
}

// ترتيب Swap: الرقم الجديد يتبادل مكانه مع العنصر الموجود في ذلك المركز فقط.
async function swapChannelOrder(channelId, newPosition) {
  const siblings = currentChannels
    .filter((item) => item.categoryId === currentParentId)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const fromIndex = siblings.findIndex((item) => item.id === channelId);
  const toIndex = newPosition - 1;
  if (fromIndex === -1 || toIndex < 0 || toIndex >= siblings.length || toIndex === fromIndex) {
    renderChannelsForCurrentCategory();
    return;
  }
  const a = siblings[fromIndex];
  const b = siblings[toIndex];
  const orderA = a.order ?? Date.now();
  const orderB = b.order ?? Date.now() + 1;
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'channels', a.id), { order: orderB });
    batch.update(doc(db, 'channels', b.id), { order: orderA });
    await batch.commit();
    await loadChannels();
  } catch (_) {
    window.alert('تعذر تبديل الترتيب. حاول مرة أخرى.');
    renderChannelsForCurrentCategory();
  }
}

async function loadCategories() {
  resetCategories();
  const categoriesQuery = query(collection(db, 'categories'), orderBy('order'));
  try {
    const snapshot = await Promise.race([
      getDocs(categoriesQuery),
      new Promise((_, reject) => window.setTimeout(
        () => reject(new Error('timeout')), 12000,
      )),
    ]);
    showCategories(snapshot.docs.map((document) => ({ id: document.id, ...document.data() })));
  } catch (_) {
    categoriesLoading.classList.add('hidden');
    categoriesCount.textContent = 'تعذر التحميل';
    categoriesError.textContent = 'تعذر الاتصال بقاعدة الأقسام. اضغط زر إعادة المحاولة. إذا تكرر الخطأ، أعد تسجيل الدخول ثم جرّب مرة أخرى.';
    categoriesError.classList.remove('hidden');
    retryCategories.classList.remove('hidden');
  }
}

async function loadChannels() {
  if (currentParentId !== null) {
    channelsSection.classList.remove('hidden');
    channelsLoading.classList.remove('hidden');
    channelsList.classList.add('hidden');
    channelsEmpty.classList.add('hidden');
  }
  try {
    const snapshot = await Promise.race([
      getDocs(collection(db, 'channels')),
      new Promise((_, reject) => window.setTimeout(() => reject(new Error('timeout')), 12000)),
    ]);
    currentChannels = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
    renderChannelsForCurrentCategory();
  } catch (_) {
    currentChannels = [];
    if (currentParentId !== null) {
      channelsLoading.classList.add('hidden');
      channelsList.classList.add('hidden');
      channelsEmpty.classList.remove('hidden');
      channelsEmpty.innerHTML = '<h2>تعذر تحميل القنوات</h2><p>تأكد من إضافة صلاحية channels في قواعد Firestore أدناه.</p>';
    }
  }
}

// روابط HLS المحمية القديمة محفوظة في privateStreams، أما المصدر الديناميكي
// فيحفظ عنوان API المستقر فقط داخل channels.sourceUrl. لا يقرأ تطبيق المحتوى
// هذه التفاصيل أبداً؛ المشغل المنفصل يحل المصدر عند التشغيل. القنوات غير
// المحمية تُحفظ مباشرة داخل channels.directUrl (قراءة عامة، بدون تأخير التوكن).
async function loadChannelSources(channels) {
  await Promise.all(channels.map(async (channel) => {
    const input = document.querySelector(`[data-source-input="${channel.id}"]`);
    const typeSelect = document.querySelector(`[data-source-type="${channel.id}"]`);
    const status = document.querySelector(`[data-source-status="${channel.id}"]`);
    if (!input) return;
    const sourceHeaders = channel.sourceHeaders && typeof channel.sourceHeaders === 'object' ? channel.sourceHeaders : {};
    const apiHeaders = channel.apiHeaders && typeof channel.apiHeaders === 'object' ? channel.apiHeaders : {};
    const refererInput = document.querySelector(`[data-source-referer="${channel.id}"]`);
    const userAgentInput = document.querySelector(`[data-source-user-agent="${channel.id}"]`);
    const apiRefererInput = document.querySelector(`[data-api-referer="${channel.id}"]`);
    const apiUserAgentInput = document.querySelector(`[data-api-user-agent="${channel.id}"]`);
    if (refererInput) refererInput.value = sourceHeaders.referer || '';
    if (userAgentInput) userAgentInput.value = sourceHeaders['user-agent'] || sourceHeaders.userAgent || '';
    if (apiRefererInput) apiRefererInput.value = apiHeaders.referer || '';
    if (apiUserAgentInput) apiUserAgentInput.value = apiHeaders['user-agent'] || apiHeaders.userAgent || '';
    const streamType = ['web', 'api'].includes(channel.streamType) ? channel.streamType : 'hls';
    if (typeSelect) typeSelect.value = streamType;
    if ((streamType === 'web' || streamType === 'api') && channel.sourceUrl) {
      input.value = channel.sourceUrl;
      if (status) status.textContent = streamType === 'api' ? 'محفوظ كرابط API مستقر (بدون m3u8 مؤقت)' : 'محفوظ كرابط صفحة ويب';
      return;
    }
    const isProtected = channel.protected !== false;
    if (!isProtected) {
      if (channel.directUrl) { input.value = channel.directUrl; if (status) status.textContent = 'محفوظ بدون حماية (بدون تأخير)'; }
      return;
    }
    try {
      const snapshot = await getDoc(doc(db, 'privateStreams', channel.id));
      const data = snapshot.data();
      if (data?.url) {
        input.value = data.url;
        if (status) status.textContent = 'محفوظ ومحمي برابط مؤقت';
      }
    } catch (_) {
      if (status) status.textContent = 'تعذر تحميل المصدر الحالي';
    }
  }));
}

async function saveChannelSource(channelId) {
  const input = document.querySelector(`[data-source-input="${channelId}"]`);
  const status = document.querySelector(`[data-source-status="${channelId}"]`);
  const button = document.querySelector(`[data-save-source="${channelId}"]`);
  const protectedToggle = document.querySelector(`[data-protected-toggle="${channelId}"]`);
  const typeSelect = document.querySelector(`[data-source-type="${channelId}"]`);
  const refererInput = document.querySelector(`[data-source-referer="${channelId}"]`);
  const userAgentInput = document.querySelector(`[data-source-user-agent="${channelId}"]`);
  const apiRefererInput = document.querySelector(`[data-api-referer="${channelId}"]`);
  const apiUserAgentInput = document.querySelector(`[data-api-user-agent="${channelId}"]`);
  if (!input) return;
  const url = input.value.trim();
  const referer = refererInput?.value.trim() || '';
  const userAgent = userAgentInput?.value.trim() || '';
  const apiReferer = apiRefererInput?.value.trim() || '';
  const apiUserAgent = apiUserAgentInput?.value.trim() || '';
  const sourceHeaders = {};
  const apiHeaders = {};
  if (referer) sourceHeaders.referer = referer;
  if (userAgent) sourceHeaders['user-agent'] = userAgent;
  if (apiReferer) apiHeaders.referer = apiReferer;
  if (apiUserAgent) apiHeaders['user-agent'] = apiUserAgent;
  const streamType = ['web', 'api'].includes(typeSelect?.value) ? typeSelect.value : 'hls';
  if (!url) { if (status) { status.textContent = 'أدخل رابط المصدر أولاً'; status.classList.add('error'); } return; }
  if (!/^https?:\/\//i.test(url)) { if (status) { status.textContent = 'الرابط يجب أن يبدأ بـ http:// أو https://'; status.classList.add('error'); } return; }
  if (streamType === 'api' && /\.(m3u8?|mpd|mp4)(?:[?#]|$)/i.test(url)) {
    if (status) {
      status.textContent = 'مصدر API يجب أن يكون رابط API مستقراً، وليس رابط m3u8/فيديو مؤقتاً.';
      status.classList.add('error');
    }
    return;
  }
  if (button) { button.disabled = true; button.textContent = 'جارٍ الحفظ…'; }
  if (status) status.classList.remove('error');
  try {
    if (streamType === 'web') {
      await updateDoc(doc(db, 'channels', channelId), { streamType: 'web', sourceUrl: url, protected: false, directUrl: null, sourceHeaders, apiHeaders: {} });
      if (status) status.textContent = 'تم الحفظ ✓ صفحة ويب';
    } else if (streamType === 'api') {
      await updateDoc(doc(db, 'channels', channelId), { streamType: 'api', sourceUrl: url, protected: false, directUrl: null, sourceHeaders, apiHeaders });
      if (status) status.textContent = 'تم الحفظ ✓ API مستقر (سيُجلب m3u8 وقت التشغيل)';
    } else {
      const isProtected = protectedToggle ? protectedToggle.checked : true;
      if (isProtected) {
        await setDoc(doc(db, 'privateStreams', channelId), { url, updatedAt: serverTimestamp() }, { merge: true });
        await updateDoc(doc(db, 'channels', channelId), { streamType: 'hls', sourceUrl: null, protected: true, directUrl: null, sourceHeaders, apiHeaders: {} });
        if (status) status.textContent = 'تم الحفظ ✓ HLS محمي برابط مؤقت';
      } else {
        await updateDoc(doc(db, 'channels', channelId), { streamType: 'hls', sourceUrl: null, protected: false, directUrl: url, sourceHeaders, apiHeaders: {} });
        if (status) status.textContent = 'تم الحفظ ✓ HLS بدون حماية';
      }
    }
    const channel = currentChannels.find((item) => item.id === channelId);
    if (channel) Object.assign(channel, streamType === 'web' || streamType === 'api'
      ? { streamType, sourceUrl: url, protected: false, directUrl: null, sourceHeaders, apiHeaders }
      : { streamType: 'hls', sourceHeaders, apiHeaders: {}, protected: Boolean(protectedToggle?.checked), directUrl: protectedToggle?.checked ? null : url, sourceUrl: null });
  } catch (_) {
    if (status) { status.textContent = 'تعذر الحفظ. تحقق من قواعد Firestore.'; status.classList.add('error'); }
  } finally {
    if (button) { button.disabled = false; button.textContent = 'حفظ المصدر'; }
  }
}

async function loadPlayerSettings() {
  try {
    const snapshot = await getDoc(doc(db, 'settings', 'player'));
    const data = snapshot.data();
    if (!data) return;
    document.querySelector('#player-scheme').value = data.deepLinkScheme || 'sportsplayer';
    document.querySelector('#player-package').value = data.androidPackage || '';
    document.querySelector('#player-store-url').value = data.storeUrl || '';
    document.querySelector('#player-min-version').value = data.minVersion || '';
    document.querySelector('#player-update-url').value = data.updateUrl || '';
    document.querySelector('#player-show-source-page').checked = data.showSourcePage !== false;
    document.querySelector('#premium-enabled').checked = data.premiumEnabled === true;
    document.querySelector('#premium-url').value = data.premiumUrl || '';
    document.querySelector('#premium-button-text').value = data.premiumButtonText || '';
  } catch (_) {
    // إعدادات المشغل اختيارية إلى أن ينشر تطبيق المشغل في Google Play.
  }
}

// ==========================================================================
// مباريات اليوم — حالة المزامنة وزر "مزامنة الآن"
// ==========================================================================
// تُقرأ فقط للعرض هنا (نفس مستند matches_daily/{today} الذي يقرأه التطبيق).
// الكتابة الفعلية تتم حصراً داخل Cloud Function refreshMatches (Admin SDK)،
// وليس من هذا الملف — راجع firestore.rules (allow write: if false;).
function todayDateKey() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function formatTimestamp(value) {
  if (!value?.toDate) return 'غير معروف';
  return value.toDate().toLocaleString('ar-EG', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

// يعرض بالضبط لماذا اختفت مباريات دوري معيّن من النتيجة النهائية، بدل
// التخمين: rawResultsCount = كل ما رجع من API-Football قبل أي فلترة،
// debugExcludedByLeague = عدد المباريات المستبعدة لأن اسم دوريها غير
// موجود في القائمة المعتمدة بالووركر (cloudflare-worker/src/index.js —
// ALLOWED_LEAGUE_NAMES)، وdebugExcludedLeagueSample أسماء فعلية من
// المصدر لم تُطابق القائمة — لو ظهر هنا اسم دوري تتوقعه (مثلاً الدوري
// المصري أو السعودي)، يعني اسم API-Football الفعلي مختلف عن المتوقع
// بالقائمة ويحتاج تحديث هناك.
function renderMatchesDebug(data) {
  const excludedLeague = data.debugExcludedByLeague ?? 0;
  const excludedBadge = data.debugExcludedByBadge ?? 0;
  const sample = Array.isArray(data.debugExcludedLeagueSample) ? data.debugExcludedLeagueSample : [];
  if (!excludedLeague && !excludedBadge) {
    matchesDebugText.classList.add('hidden');
    matchesDebugText.textContent = '';
    return;
  }
  const parts = [];
  if (typeof data.rawResultsCount === 'number') parts.push(`إجمالي من المصدر: ${data.rawResultsCount}`);
  if (excludedLeague) parts.push(`مستبعدة (دوري غير مدعوم): ${excludedLeague}`);
  if (excludedBadge) parts.push(`مستبعدة (شعار ناقص): ${excludedBadge}`);
  let text = parts.join(' · ');
  if (sample.length) text += ` — أمثلة أسماء دوريات مستبعدة: ${sample.join('، ')}`;
  matchesDebugText.textContent = text;
  matchesDebugText.classList.remove('hidden');
}

async function loadMatchesStatus() {
  matchesStatusText.textContent = 'جارٍ التحميل…';
  matchesDebugText.classList.add('hidden');
  try {
    const snapshot = await getDoc(doc(db, 'matches_daily', todayDateKey()));
    const data = snapshot.data();
    if (!data) {
      matchesStatusText.textContent = 'لا توجد مزامنة اليوم بعد. اضغط «مزامنة الآن».';
      return;
    }
    const count = Array.isArray(data.events) ? data.events.length : 0;
    matchesStatusText.textContent = `آخر تحديث: ${formatTimestamp(data.updatedAt)} · ${count} مباراة اليوم`;
    renderMatchesDebug(data);
  } catch (_) {
    matchesStatusText.textContent = 'تعذر قراءة حالة المزامنة.';
  }
}

// دالة مشتركة بين الزرين: "مزامنة الآن" (يوم اليوم فقط، body: {date})
// و"إعادة مزامنة كل الأيام" (النافذة كاملة -3..+3، body: {syncWindow: true}).
// نفس نقطة /refreshMatches بجسم مختلف — راجع cloudflare-worker/src/index.js.
async function runMatchesSync(button, body, { busyText, idleText, successMessage }) {
  button.disabled = true;
  button.textContent = busyText;
  matchesMessage.classList.add('hidden');
  matchesMessage.classList.remove('error-card');
  try {
    const syncSecret = getAdminSyncSecret();
    const response = await fetch(`${WORKER_BASE_URL}/refreshMatches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': syncSecret },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (response.status === 401 || response.status === 403) {
      adminSyncSecret = '';
      try { sessionStorage.removeItem(SYNC_SECRET_STORAGE_KEY); } catch (_) {}
    }
    if (!response.ok || result.ok === false) {
      throw new Error(result.message || `HTTP ${response.status}`);
    }
    matchesMessage.textContent = successMessage(result);
    matchesMessage.classList.remove('hidden');
    await loadMatchesStatus();
  } catch (error) {
    matchesMessage.textContent = error?.message
      ? `تعذرت المزامنة: ${error.message}`
      : 'تعذرت المزامنة. تأكد من ضبط أسرار Worker (راجع cloudflare-worker/README.md) ومن تحديث WORKER_BASE_URL في هذا الملف.';
    matchesMessage.classList.remove('hidden');
    matchesMessage.classList.add('error-card');
  } finally {
    button.disabled = false;
    button.textContent = idleText;
  }
}

syncMatchesButton?.addEventListener('click', () => runMatchesSync(
  syncMatchesButton,
  { date: todayDateKey() },
  {
    busyText: 'جارٍ المزامنة…',
    idleText: 'مزامنة الآن',
    successMessage: (result) => `تمت المزامنة بنجاح — ${result.count ?? 0} مباراة.`,
  },
));

syncWindowButton?.addEventListener('click', () => runMatchesSync(
  syncWindowButton,
  { syncWindow: true },
  {
    busyText: 'جارٍ مزامنة كل الأيام… (قد تستغرق وقتاً أطول)',
    idleText: 'إعادة مزامنة كل الأيام (-3 إلى +3)',
    successMessage: (result) => {
      const entries = Object.entries(result.results || {});
      const okDays = entries.filter(([, value]) => typeof value === 'object' && value !== null);
      const totalMatches = okDays.reduce((sum, [, value]) => sum + (value.count ?? 0), 0);
      const failedDays = entries.filter(([, value]) => typeof value === 'string');
      let message = `تمت مزامنة نافذة الأيام (-3 إلى +3) — ${totalMatches} مباراة إجمالاً عبر ${okDays.length} يوم.`;
      if (failedDays.length) {
        const details = failedDays.map(([date, value]) => `${date} (${value})`).join('، ');
        message += ` تعذر جلب ${failedDays.length} يوم: ${details}.`;
      }
      return message;
    },
  },
));

// ==========================================================================
// الرسائل الواردة (contactMessages) — تواصل معنا / إبلاغ عن رابط معطوب
// ==========================================================================
const MESSAGE_TYPE_LABELS = { general: 'تواصل معنا', broken_link: 'رابط معطوب' };

async function loadMessages() {
  messagesLoading.classList.remove('hidden');
  messagesEmpty.classList.add('hidden');
  messagesList.classList.add('hidden');
  try {
    const messagesQuery = query(collection(db, 'contactMessages'), orderBy('createdAt', 'desc'), limit(100));
    const snapshot = await getDocs(messagesQuery);
    currentMessages = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    messagesLoading.classList.add('hidden');

    const newCount = currentMessages.filter((message) => message.status !== 'read').length;
    messagesCount.textContent = `${currentMessages.length} رسالة`;
    if (newCount > 0) {
      messagesBadge.textContent = String(newCount);
      messagesBadge.classList.remove('hidden');
    } else {
      messagesBadge.classList.add('hidden');
    }

    if (!currentMessages.length) {
      messagesEmpty.classList.remove('hidden');
      return;
    }

    messagesList.innerHTML = currentMessages.map((message) => {
      const isBroken = message.type === 'broken_link';
      const typeLabel = MESSAGE_TYPE_LABELS[message.type] || 'رسالة';
      const isRead = message.status === 'read';
      const channelInfo = message.channelInfo
        ? `<p class="message-channel-info">القناة/الرابط المُبلَّغ عنه: ${escapeHtml(message.channelInfo)}</p>`
        : '';
      return `<article class="card message-item">
        <div class="message-item-head">
          <span class="message-type-tag${isBroken ? ' broken-link' : ''}">${typeLabel}</span>
          <span class="message-status-tag ${isRead ? 'read' : 'new'}">${isRead ? 'تمت القراءة' : 'جديدة'}</span>
          <span class="message-date">${formatTimestamp(message.createdAt)}</span>
        </div>
        <p class="message-body">${escapeHtml(message.message || '')}</p>
        ${channelInfo}
        <div class="message-actions">
          ${isRead
            ? ''
            : `<button type="button" data-mark-read="${escapeHtml(message.id)}">تحديد كمقروءة</button>`}
          <button class="delete-category-button" type="button" data-delete-message="${escapeHtml(message.id)}">حذف</button>
        </div>
      </article>`;
    }).join('');
    messagesList.classList.remove('hidden');
  } catch (_) {
    messagesLoading.classList.add('hidden');
    messagesEmpty.classList.remove('hidden');
    messagesEmpty.innerHTML = '<h2>تعذر تحميل الرسائل</h2><p>تأكد من صلاحيات القراءة على contactMessages في قواعد Firestore.</p>';
  }
}

messagesList?.addEventListener('click', async (event) => {
  const markRead = event.target.closest('[data-mark-read]');
  const remove = event.target.closest('[data-delete-message]');
  if (markRead) {
    try { await updateDoc(doc(db, 'contactMessages', markRead.dataset.markRead), { status: 'read' }); await loadMessages(); }
    catch (_) { window.alert('تعذر تحديث حالة الرسالة.'); }
    return;
  }
  if (remove) {
    if (!window.confirm('حذف هذه الرسالة نهائياً؟')) return;
    try { await deleteDoc(doc(db, 'contactMessages', remove.dataset.deleteMessage)); await loadMessages(); }
    catch (_) { window.alert('تعذر حذف الرسالة.'); }
  }
});

// ==========================================================================
// الشروط والأحكام وسياسة الخصوصية (settings/legal)
// ==========================================================================
async function loadLegalSettings() {
  try {
    const snapshot = await getDoc(doc(db, 'settings', 'legal'));
    const data = snapshot.data();
    if (!data) return;
    legalTerms.value = data.terms || '';
    legalPrivacy.value = data.privacy || '';
  } catch (_) {
    // النصوص القانونية اختيارية إلى أن تُضاف لأول مرة من هنا.
  }
}

legalForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  legalMessage.textContent = '';
  legalMessage.classList.remove('error');
  try {
    await setDoc(doc(db, 'settings', 'legal'), {
      terms: legalTerms.value.trim(),
      privacy: legalPrivacy.value.trim(),
      updatedAt: serverTimestamp(),
    }, { merge: true });
    legalMessage.textContent = 'تم حفظ النصوص، وستظهر فوراً في التطبيق.';
  } catch (_) {
    legalMessage.textContent = 'تعذر الحفظ. تحقق من قواعد Firestore.';
    legalMessage.classList.add('error');
  }
});

// ==========================================================================
// الإعلانات — أكواد الشبكات ومفتاح التشغيل/الإيقاف (settings/ads)
// ==========================================================================
async function loadAdsSettings() {
  try {
    const snapshot = await getDoc(doc(db, 'settings', 'ads'));
    const data = snapshot.data();
    if (!data) return;
    adsEnabled.checked = data.enabled !== false;
    admobAppId.value = data.admob?.appId || '';
    admobBannerId.value = data.admob?.bannerId || '';
    admobInterstitialId.value = data.admob?.interstitialId || '';
    admobRewardedId.value = data.admob?.rewardedId || '';
    applovinSdkKey.value = data.applovin?.sdkKey || '';
    applovinBannerId.value = data.applovin?.bannerId || '';
    applovinInterstitialId.value = data.applovin?.interstitialId || '';
    applovinRewardedId.value = data.applovin?.rewardedId || '';
    unityGameId.value = data.unity?.gameId || '';
    unityBannerId.value = data.unity?.bannerId || '';
    unityInterstitialId.value = data.unity?.interstitialId || '';
    unityRewardedId.value = data.unity?.rewardedId || '';
  } catch (_) {
    // إعدادات الإعلانات اختيارية إلى أن تُضاف لأول مرة من هنا.
  }
}

adsForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  adsMessage.textContent = '';
  adsMessage.classList.remove('error');
  try {
    await setDoc(doc(db, 'settings', 'ads'), {
      enabled: adsEnabled.checked,
      admob: {
        appId: admobAppId.value.trim(),
        bannerId: admobBannerId.value.trim(),
        interstitialId: admobInterstitialId.value.trim(),
        rewardedId: admobRewardedId.value.trim(),
      },
      applovin: {
        sdkKey: applovinSdkKey.value.trim(),
        bannerId: applovinBannerId.value.trim(),
        interstitialId: applovinInterstitialId.value.trim(),
        rewardedId: applovinRewardedId.value.trim(),
      },
      unity: {
        gameId: unityGameId.value.trim(),
        bannerId: unityBannerId.value.trim(),
        interstitialId: unityInterstitialId.value.trim(),
        rewardedId: unityRewardedId.value.trim(),
      },
      updatedAt: serverTimestamp(),
    }, { merge: true });
    adsMessage.textContent = 'تم حفظ إعدادات الإعلانات، وستُطبَّق فوراً في التطبيق.';
  } catch (_) {
    adsMessage.textContent = 'تعذر الحفظ. تحقق من قواعد Firestore.';
    adsMessage.classList.add('error');
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    document.querySelector('#owner-email').textContent = user.email || 'المالك';
    showView('dashboard');
    loadCategories();
    loadChannels();
    loadPlayerSettings();
    loadMatchesStatus();
    loadMessages();
    loadLegalSettings();
    loadAdsSettings();
    return;
  }
  showView('login');
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';
  loginButton.disabled = true;
  loginButton.textContent = 'جارٍ تسجيل الدخول…';
  try {
    await signInWithEmailAndPassword(auth, loginForm.email.value.trim(), loginForm.password.value);
  } catch (error) {
    loginError.textContent = 'تعذر تسجيل الدخول. تأكد من البريد وكلمة المرور، ومن تفعيل تسجيل الدخول بالبريد الإلكتروني في Firebase.';
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'تسجيل الدخول';
  }
});

document.querySelector('#logout-button').addEventListener('click', () => signOut(auth));
retryCategories.addEventListener('click', loadCategories);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  addMenu.classList.add('hidden');
  addMenuToggle.setAttribute('aria-expanded', 'false');
  closeAllFormCards();
});
function showPanel(panelId) {
  document.querySelectorAll('.admin-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== panelId));
}

updateChannelAddMenuLabel();

contentTypeTabs.forEach((button) => button.addEventListener('click', () => {
  if (currentParentId) currentParentId = null;
  activeContentType = button.dataset.contentType || 'channels';
  updateChannelAddMenuLabel();
  contentTypeTabs.forEach((item) => item.classList.toggle('active', item === button));
  categorySelectMode = false;
  categoriesBulkBar.classList.add('hidden');
  closeAllFormCards();
  renderCurrentCategoryView();
}));

groupButtons.forEach((button) => button.addEventListener('click', () => {
  groupButtons.forEach((item) => item.classList.toggle('active', item === button));
  const group = button.dataset.group;
  const activeSubNav = document.querySelector(`[data-group-nav="${group}"]`);
  subNavs.forEach((nav) => nav.classList.toggle('hidden', nav !== activeSubNav));

  if (activeSubNav) {
    const activeSubButton = activeSubNav.querySelector('.nav-button.active') || activeSubNav.querySelector('.nav-button');
    activeSubNav.querySelectorAll('.nav-button').forEach((item) => item.classList.toggle('active', item === activeSubButton));
    showPanel(activeSubButton?.dataset.panel);
  } else {
    const directPanel = document.querySelector(`.admin-panel[data-group="${group}"]`);
    showPanel(directPanel?.id);
  }
}));

subNavButtons.forEach((button) => button.addEventListener('click', () => {
  const nav = button.closest('.sub-nav');
  nav.querySelectorAll('.nav-button').forEach((item) => item.classList.toggle('active', item === button));
  showPanel(button.dataset.panel);
}));

categoriesList.addEventListener('change', (event) => {
  const input = event.target.closest('[data-reorder-category]');
  if (!input) return;
  const newPosition = parseInt(input.value, 10);
  if (!newPosition) return;
  swapCategoryOrder(input.dataset.reorderCategory, newPosition);
});

categoriesList.addEventListener('click', (event) => {
  const checkbox = event.target.closest('[data-select-category]');
  if (checkbox) {
    const id = checkbox.dataset.selectCategory;
    if (checkbox.checked) selectedCategoryIds.add(id); else selectedCategoryIds.delete(id);
    updateCategoriesBulkBar();
    return;
  }
  const edit = event.target.closest('[data-edit-category]');
  const remove = event.target.closest('[data-delete-category]');
  if (edit) return editCategory(edit.dataset.editCategory);
  if (remove) return deleteCategory(remove.dataset.deleteCategory);
  const button = event.target.closest('[data-open-category]');
  if (!button) return;
  if (categorySelectMode) return;
  currentParentId = button.dataset.openCategory;
  closeAllFormCards();
  renderCurrentCategoryView();
});

function updateCategoriesBulkBar() {
  categoriesSelectedCount.textContent = `${selectedCategoryIds.size} محدد`;
  categoriesBulkDelete.disabled = selectedCategoryIds.size === 0;
  const visibleIds = currentCategories
    .filter((item) => (item.parentId || null) === currentParentId)
    .filter(categoryMatchesContentType)
    .map((item) => item.id);
  categoriesSelectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedCategoryIds.has(id));
  categoriesSelectAll.indeterminate = selectedCategoryIds.size > 0
    && selectedCategoryIds.size < visibleIds.length
    && visibleIds.some((id) => selectedCategoryIds.has(id));
}

categoriesSelectAll.addEventListener('change', () => {
  const visibleIds = currentCategories
    .filter((item) => (item.parentId || null) === currentParentId)
    .filter(categoryMatchesContentType)
    .map((item) => item.id);
  if (categoriesSelectAll.checked) {
    visibleIds.forEach((id) => selectedCategoryIds.add(id));
  } else {
    visibleIds.forEach((id) => selectedCategoryIds.delete(id));
  }
  updateCategoriesBulkBar();
  renderCurrentCategoryView();
});

categoriesSelectToggle.addEventListener('click', () => {
  categorySelectMode = !categorySelectMode;
  selectedCategoryIds.clear();
  categoriesBulkBar.classList.toggle('hidden', !categorySelectMode);
  categoriesSelectToggle.textContent = categorySelectMode ? 'إلغاء وضع التحديد' : 'تحديد للحذف';
  updateCategoriesBulkBar();
  renderCurrentCategoryView();
});

categoriesSelectCancel.addEventListener('click', () => {
  categorySelectMode = false;
  selectedCategoryIds.clear();
  categoriesBulkBar.classList.add('hidden');
  categoriesSelectToggle.textContent = 'تحديد للحذف';
  renderCurrentCategoryView();
});

categoriesBulkDelete.addEventListener('click', async () => {
  const ids = [...selectedCategoryIds];
  if (!ids.length) return;

  // إذا تم تحديد قسم رئيسي مع قسم فرعي، نحذف كل شجرة القسم مرة واحدة بدون تكرار.
  const allCategoryIds = new Set();
  ids.forEach((id) => getCategoryDeleteTree(id).forEach((categoryId) => allCategoryIds.add(categoryId)));
  const categoryIdSet = new Set(allCategoryIds);
  const channelCount = currentChannels.filter((channel) => categoryIdSet.has(channel.categoryId)).length;
  const childCount = Math.max(0, allCategoryIds.size - ids.length);
  const details = [
    `${allCategoryIds.size} قسم`,
    childCount ? `${childCount} قسم فرعي` : '',
    channelCount ? `${channelCount} قناة` : '',
  ].filter(Boolean).join(' و');

  if (!window.confirm(`سيتم حذف ${details} نهائياً مع جميع العناصر التابعة. هل تريد المتابعة؟`)) return;
  if (!requestDeleteConfirmation('أدخل كلمة المرور لتأكيد الحذف الجماعي للأقسام وجميع العناصر التابعة:')) return;

  categoriesBulkDelete.disabled = true;
  try {
    const refs = [
      ...allCategoryIds.map((categoryId) => doc(db, 'categories', categoryId)),
      ...currentChannels
        .filter((channel) => categoryIdSet.has(channel.categoryId))
        .map((channel) => doc(db, 'channels', channel.id)),
    ];
    for (let i = 0; i < refs.length; i += 450) {
      const batch = writeBatch(db);
      refs.slice(i, i + 450).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    selectedCategoryIds.clear();
    categorySelectMode = false;
    categoriesBulkBar.classList.add('hidden');
    categoriesSelectToggle.textContent = 'تحديد للحذف';
    await Promise.all([loadCategories(), loadChannels()]);
    window.alert('تم حذف الأقسام والعناصر التابعة لها بنجاح.');
  } catch (_) {
    window.alert('تعذر الحذف. تحقق من قواعد Firestore وحاول مرة أخرى.');
    categoriesBulkDelete.disabled = false;
  }
});

function editCategory(id) {
  openCategoryForm(id);
}

function getCategoryDeleteTree(rootId) {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    currentCategories.forEach((item) => {
      if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        changed = true;
      }
    });
  }
  return [...ids];
}

function requestDeleteConfirmation(message) {
  return window.confirm(message.replace('أدخل كلمة المرور لتأكيد', 'هل أنت متأكد من'));
}

async function deleteCategoryTree(rootId) {
  const categoryIds = getCategoryDeleteTree(rootId);
  const categoryIdSet = new Set(categoryIds);
  const channelIds = currentChannels
    .filter((channel) => categoryIdSet.has(channel.categoryId))
    .map((channel) => channel.id);
  const refs = [
    ...categoryIds.map((categoryId) => doc(db, 'categories', categoryId)),
    ...channelIds.map((channelId) => doc(db, 'channels', channelId)),
  ];

  // Firestore batches have a 500-operation limit, so delete in safe chunks.
  for (let i = 0; i < refs.length; i += 450) {
    const batch = writeBatch(db);
    refs.slice(i, i + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  return { categoryCount: categoryIds.length, channelCount: channelIds.length };
}

async function deleteCategory(id) {
  const category = currentCategories.find((item) => item.id === id);
  if (!category) return;
  const categoryIds = getCategoryDeleteTree(id);
  const categoryIdSet = new Set(categoryIds);
  const channelCount = currentChannels.filter((channel) => categoryIdSet.has(channel.categoryId)).length;
  const childCount = Math.max(0, categoryIds.length - 1);
  const details = [
    childCount ? `${childCount} قسم فرعي` : '',
    channelCount ? `${channelCount} قناة` : '',
  ].filter(Boolean).join(' و');
  const warning = details
    ? `سيتم حذف «${category.title || ''}» وجميع ما بداخله${details ? ` (${details})` : ''} نهائياً. هل تريد المتابعة؟`
    : `حذف «${category.title || ''}» نهائياً؟`;
  if (!window.confirm(warning)) return;
  if (!requestDeleteConfirmation('أدخل كلمة المرور لتأكيد حذف القسم وجميع العناصر التابعة له:')) return;

  try {
    const result = await deleteCategoryTree(id);
    if (currentParentId && categoryIdSet.has(currentParentId)) currentParentId = category.parentId || null;
    selectedCategoryIds.clear();
    await Promise.all([loadCategories(), loadChannels()]);
    window.alert(`تم الحذف بنجاح: ${result.categoryCount} قسم و${result.channelCount} قناة.`);
  } catch (_) {
    window.alert('تعذر الحذف. لم تكتمل العملية بالكامل. تحقق من قواعد Firestore وحاول مرة أخرى.');
  }
}

backToHome.addEventListener('click', () => {
  currentParentId = null;
  selectedCategoryIds.clear();
  categorySelectMode = false;
  categoriesBulkBar.classList.add('hidden');
  closeAllFormCards();
  const homeButton = document.querySelector('.nav-button[data-panel="home-panel"]');
  document.querySelectorAll('.nav-button[data-panel]').forEach((item) => item.classList.toggle('active', item === homeButton));
  showPanel('home-panel');
  renderCurrentCategoryView();
});

backToRoot.addEventListener('click', () => {
  currentParentId = null;
  selectedCategoryIds.clear();
  if (categorySelectMode) updateCategoriesBulkBar();
  closeAllFormCards();
  renderCurrentCategoryView();
});

// ---- زر "+ إضافة" الموحّد: فتح/إغلاق القائمة واختيار نوع العنصر ----
addMenuToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  const willOpen = addMenu.classList.contains('hidden');
  addMenu.classList.toggle('hidden', !willOpen);
  addMenuToggle.setAttribute('aria-expanded', String(willOpen));
});
document.addEventListener('click', (event) => {
  if (addMenu.classList.contains('hidden')) return;
  if (event.target.closest('.add-menu-wrap')) return;
  addMenu.classList.add('hidden');
  addMenuToggle.setAttribute('aria-expanded', 'false');
});
addMenu.addEventListener('click', (event) => {
  const item = event.target.closest('[data-add-type]');
  if (!item || item.disabled) return;
  addMenu.classList.add('hidden');
  addMenuToggle.setAttribute('aria-expanded', 'false');
  const type = item.dataset.addType;
  if (type === 'category') openCategoryForm(null);
  else if (type === 'channel') openChannelForm(null);
  else if (type === 'marquee') openMarqueeForm();
  else if (type === 'bulk') openBulkForm();
});
bulkCloseButton.addEventListener('click', () => {
  bulkForm.reset();
  closeAllFormCards();
});
bulkForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  bulkFormMessage.textContent = '';
  bulkFormMessage.classList.remove('error');

  let data;
  try {
    data = JSON.parse(bulkTextarea.value);
  } catch (_) {
    bulkFormMessage.textContent = 'صيغة JSON غير صحيحة. تأكد من نسخ النص كاملاً.';
    bulkFormMessage.classList.add('error');
    return;
  }

  const categories = Array.isArray(data.categories) ? data.categories : [];
  const looseChannels = Array.isArray(data.channels) ? data.channels : [];

  if (!categories.length && !looseChannels.length) {
    bulkFormMessage.textContent = 'لم يتم العثور على أقسام أو قنوات في النص.';
    bulkFormMessage.classList.add('error');
    return;
  }
  if (looseChannels.length && currentParentId === null) {
    bulkFormMessage.textContent = 'لإضافة قنوات مباشرة بدون قسم جديد، افتح قسماً أولاً، أو ضعها داخل "categories".';
    bulkFormMessage.classList.add('error');
    return;
  }

  bulkSaveButton.disabled = true;
  bulkSaveButton.textContent = 'جارٍ الاستيراد…';
  try {
    const batch = writeBatch(db);
    const baseOrder = Date.now();
    let categoryCount = 0;
    let channelCount = 0;
    let channelOrderCounter = 0;

    categories.forEach((cat, index) => {
      const categoryRef = doc(collection(db, 'categories'));
      batch.set(categoryRef, {
        title: cat.title,
        iconUrl: cat.iconUrl || null,
        marqueeText: cat.marqueeText || null,
        isPremium: Boolean(cat.isPremium),
        parentId: currentParentId,
        order: baseOrder + index,
        createdAt: serverTimestamp(),
      });
      categoryCount += 1;

      const channels = Array.isArray(cat.channels) ? cat.channels : [];
      channels.forEach((ch) => {
        const channelRef = doc(collection(db, 'channels'));
        batch.set(channelRef, {
          categoryId: categoryRef.id,
          title: ch.title,
          subtitle: ch.subtitle || '',
          status: ch.status || 'live',
          logoUrl: ch.logoUrl || null,
          playerChannelKey: ch.playerChannelKey || null,
           streamType: ['web', 'api'].includes(ch.streamType) ? ch.streamType : 'hls',
           sourceUrl: ['web', 'api'].includes(ch.streamType) ? (ch.sourceUrl || ch.apiUrl || ch.streamUrl || null) : null,
           apiHeaders: ch.apiHeaders && typeof ch.apiHeaders === 'object' ? ch.apiHeaders : {},
          sourceHeaders: ch.sourceHeaders && typeof ch.sourceHeaders === 'object' ? ch.sourceHeaders : {},
          viewCount: 0,
          order: baseOrder + channelOrderCounter,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        channelOrderCounter += 1;
        channelCount += 1;
      });
    });

    looseChannels.forEach((ch) => {
      const channelRef = doc(collection(db, 'channels'));
      batch.set(channelRef, {
        categoryId: currentParentId,
        title: ch.title,
        subtitle: ch.subtitle || '',
        status: ch.status || 'live',
        logoUrl: ch.logoUrl || null,
        playerChannelKey: ch.playerChannelKey || null,
        viewCount: 0,
        order: baseOrder + channelOrderCounter,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      channelOrderCounter += 1;
      channelCount += 1;
    });

    await batch.commit();
    bulkFormMessage.classList.remove('error');
    bulkFormMessage.textContent = `تم استيراد ${categoryCount} قسم و ${channelCount} قناة بنجاح ✓`;
    bulkTextarea.value = '';
    window.setTimeout(async () => {
      closeAllFormCards();
      await loadCategories();
    }, 900);
  } catch (error) {
    bulkFormMessage.textContent = 'تعذر تنفيذ الاستيراد. تحقق من قواعد Firestore وصيغة JSON.';
    bulkFormMessage.classList.add('error');
  } finally {
    bulkSaveButton.disabled = false;
    bulkSaveButton.textContent = 'استيراد';
  }
});
categoryCloseButton.addEventListener('click', () => {
  categoryForm.reset();
  categoryEditId.value = '';
  closeAllFormCards();
});
marqueeCloseButton.addEventListener('click', () => {
  marqueeForm.reset();
  closeAllFormCards();
});
marqueeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (currentParentId === null) return;
  const text = marqueeText.value.trim();
  marqueeFormMessage.textContent = '';
  marqueeFormMessage.classList.remove('error');
  marqueeSaveButton.disabled = true;
  try {
    await updateDoc(doc(db, 'categories', currentParentId), { marqueeText: text || null });
    const parent = currentCategories.find((item) => item.id === currentParentId);
    if (parent) parent.marqueeText = text || null;
    marqueeFormMessage.textContent = text ? 'تم حفظ النص المتحرك ✓' : 'تم حذف النص المتحرك ✓';
    renderMarqueePreview();
    window.setTimeout(() => closeAllFormCards(), 700);
  } catch (_) {
    marqueeFormMessage.textContent = 'تعذر الحفظ. تحقق من قواعد Firestore.';
    marqueeFormMessage.classList.add('error');
  } finally {
    marqueeSaveButton.disabled = false;
  }
});

categoryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = categoryForm.elements.title.value.trim();
  const iconUrl = categoryForm.elements.image.value.trim();
  if (!title) return;

  categoryFormMessage.textContent = '';
  categoryFormMessage.classList.remove('error');
  categorySaveButton.disabled = true;
  const isEdit = Boolean(categoryEditId.value);
  categorySaveButton.textContent = isEdit ? 'جارٍ الحفظ…' : 'جارٍ الإضافة…';
  try {
    if (isEdit) {
      await updateDoc(doc(db, 'categories', categoryEditId.value), { title, iconUrl: iconUrl || null, contentType: currentCategories.find((item) => item.id === categoryEditId.value)?.contentType || categoryContentType.value || 'channels' });
    } else {
      await addDoc(collection(db, 'categories'), {
        title,
        iconUrl: iconUrl || null,
        parentId: currentParentId,
        contentType: currentParentId ? (currentCategories.find((item) => item.id === currentParentId)?.contentType || activeContentType) : activeContentType,
        order: Date.now(),
        isPremium: false,
        createdAt: serverTimestamp(),
      });
    }
    categoryForm.reset();
    categoryEditId.value = '';
    closeAllFormCards();
    await loadCategories();
  } catch (error) {
    categoryFormMessage.textContent = isEdit
      ? 'تعذر حفظ التعديل. تأكد أنك دخلت بحساب المالك ثم أعد المحاولة.'
      : 'تعذر حفظ القسم. تأكد أنك دخلت بحساب المالك ثم أعد المحاولة.';
    categoryFormMessage.classList.add('error');
  } finally {
    categorySaveButton.disabled = false;
    categorySaveButton.textContent = isEdit ? 'حفظ التعديل' : 'إضافة القسم';
  }
});

function resetChannelForm() {
  channelForm.reset();
  channelEditId.value = '';
  channelSourceType.value = 'hls';
  channelProtectedToggle.checked = true;
  channelProtectedToggle.disabled = false;
  channelProtectionWrap.classList.remove('hidden');
  channelFormTitle.textContent = 'إضافة محتوى';
  channelSaveButton.textContent = 'حفظ';
  channelFormMessage.textContent = '';
}

function updateChannelAddMenuLabel() {
  if (!addMenuChannelButton) return;
  const label = contentEntryLabel(activeContentType);
  addMenuChannelButton.textContent = `➕ ${label}`;
}

function readChannelSourceForm() {
  const streamType = ['web', 'api'].includes(channelSourceType.value) ? channelSourceType.value : 'hls';
  const url = channelSourceUrl.value.trim();
  const sourceHeaders = {};
  const apiHeaders = {};
  const sourceReferer = channelSourceReferer.value.trim();
  const sourceUserAgent = channelSourceUserAgent.value.trim();
  const apiReferer = channelApiReferer.value.trim();
  const apiUserAgent = channelApiUserAgent.value.trim();
  if (sourceReferer) sourceHeaders.referer = sourceReferer;
  if (sourceUserAgent) sourceHeaders['user-agent'] = sourceUserAgent;
  if (apiReferer) apiHeaders.referer = apiReferer;
  if (apiUserAgent) apiHeaders['user-agent'] = apiUserAgent;
  return { streamType, url, protected: streamType === 'hls' ? channelProtectedToggle.checked : false, sourceHeaders, apiHeaders };
}

channelForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentParentId || !channelTitle.value.trim()) return;
  const source = readChannelSourceForm();
  if (!source.url) {
    channelFormMessage.textContent = 'أدخل رابط المصدر أولاً.';
    channelFormMessage.classList.add('error');
    return;
  }
  if (!/^https?:\/\//i.test(source.url)) {
    channelFormMessage.textContent = 'رابط المصدر يجب أن يبدأ بـ http:// أو https://';
    channelFormMessage.classList.add('error');
    return;
  }
  if (source.streamType === 'api' && /\.(m3u8?|mpd|mp4)(?:[?#]|$)/i.test(source.url)) {
    channelFormMessage.textContent = 'مصدر API يجب أن يكون رابط API مستقراً، وليس رابط m3u8/فيديو مؤقتاً.';
    channelFormMessage.classList.add('error');
    return;
  }
  channelFormMessage.textContent = '';
  channelFormMessage.classList.remove('error');
  const data = {
    categoryId: currentParentId,
    title: channelTitle.value.trim(),
    logoUrl: channelLogo.value.trim() || null,
    updatedAt: serverTimestamp(),
    streamType: source.streamType,
    protected: source.protected,
    directUrl: null,
    sourceUrl: null,
    sourceHeaders: source.sourceHeaders,
    apiHeaders: source.apiHeaders,
  };
  channelSaveButton.disabled = true;
  channelSaveButton.textContent = 'جارٍ الحفظ…';
  try {
    let channelId = channelEditId.value;
    if (channelId) {
      await updateDoc(doc(db, 'channels', channelId), data);
    } else {
      const created = await addDoc(collection(db, 'channels'), { ...data, viewCount: 0, order: Date.now(), createdAt: serverTimestamp() });
      channelId = created.id;
    }

    if (source.streamType === 'web' || source.streamType === 'api') {
      await updateDoc(doc(db, 'channels', channelId), {
        streamType: source.streamType,
        sourceUrl: source.url,
        protected: false,
        directUrl: null,
        sourceHeaders: source.sourceHeaders,
        apiHeaders: source.streamType === 'api' ? source.apiHeaders : {},
      });
    } else if (source.protected) {
      await setDoc(doc(db, 'privateStreams', channelId), { url: source.url, updatedAt: serverTimestamp() }, { merge: true });
      await updateDoc(doc(db, 'channels', channelId), {
        streamType: 'hls', sourceUrl: null, protected: true, directUrl: null,
        sourceHeaders: source.sourceHeaders, apiHeaders: {},
      });
    } else {
      await updateDoc(doc(db, 'channels', channelId), {
        streamType: 'hls', sourceUrl: null, protected: false, directUrl: source.url,
        sourceHeaders: source.sourceHeaders, apiHeaders: {},
      });
    }
    resetChannelForm();
    closeAllFormCards();
    await loadChannels();
  } catch (_) {
    channelFormMessage.textContent = 'تعذر حفظ المحتوى. تحقق من قواعد Firestore.';
    channelFormMessage.classList.add('error');
  } finally {
    channelSaveButton.disabled = false;
    channelSaveButton.textContent = channelEditId.value ? 'حفظ التعديل' : 'حفظ';
  }
});

channelCloseButton.addEventListener('click', () => { resetChannelForm(); closeAllFormCards(); });
channelsList.addEventListener('change', (event) => {
  const input = event.target.closest('[data-reorder-channel]');
  if (!input) return;
  const newPosition = parseInt(input.value, 10);
  if (!newPosition) return;
  swapChannelOrder(input.dataset.reorderChannel, newPosition);
});
channelsList.addEventListener('click', async (event) => {
  const checkbox = event.target.closest('[data-select-channel]');
  if (checkbox) {
    const id = checkbox.dataset.selectChannel;
    if (checkbox.checked) selectedChannelIds.add(id); else selectedChannelIds.delete(id);
    updateChannelsBulkBar();
    return;
  }
  const edit = event.target.closest('[data-edit-channel]'); const remove = event.target.closest('[data-delete-channel]'); const saveSource = event.target.closest('[data-save-source]');
  if (edit) return openChannelForm(edit.dataset.editChannel);
  if (remove) { const channel = currentChannels.find((item) => item.id === remove.dataset.deleteChannel); if (!window.confirm(`حذف «${channel?.title || ''}»؟`)) return; try { await deleteDoc(doc(db, 'channels', remove.dataset.deleteChannel)); await loadChannels(); } catch (_) { window.alert('تعذر الحذف.'); } return; }
  if (saveSource) { await saveChannelSource(saveSource.dataset.saveSource); }
});

function updateChannelsBulkBar() {
  channelsSelectedCount.textContent = `${selectedChannelIds.size} محدد`;
  channelsBulkDelete.disabled = selectedChannelIds.size === 0;
  const visibleIds = currentChannels
    .filter((item) => item.categoryId === currentParentId)
    .map((item) => item.id);
  channelsSelectAll.checked = visibleIds.length > 0 && visibleIds.every((id) => selectedChannelIds.has(id));
  channelsSelectAll.indeterminate = selectedChannelIds.size > 0
    && selectedChannelIds.size < visibleIds.length
    && visibleIds.some((id) => selectedChannelIds.has(id));
}

channelsSelectAll.addEventListener('change', () => {
  const visibleIds = currentChannels
    .filter((item) => item.categoryId === currentParentId)
    .map((item) => item.id);
  if (channelsSelectAll.checked) {
    visibleIds.forEach((id) => selectedChannelIds.add(id));
  } else {
    visibleIds.forEach((id) => selectedChannelIds.delete(id));
  }
  updateChannelsBulkBar();
  renderChannelsForCurrentCategory();
});

channelsSelectToggle.addEventListener('click', () => {
  channelSelectMode = !channelSelectMode;
  selectedChannelIds.clear();
  channelsBulkBar.classList.toggle('hidden', !channelSelectMode);
  channelsSelectToggle.textContent = channelSelectMode ? 'إلغاء وضع التحديد' : 'تحديد للحذف';
  updateChannelsBulkBar();
  renderChannelsForCurrentCategory();
});

channelsSelectCancel.addEventListener('click', () => {
  channelSelectMode = false;
  selectedChannelIds.clear();
  channelsBulkBar.classList.add('hidden');
  channelsSelectToggle.textContent = 'تحديد للحذف';
  renderChannelsForCurrentCategory();
});

channelsBulkDelete.addEventListener('click', async () => {
  const ids = [...selectedChannelIds];
  if (!ids.length) return;
  if (!window.confirm(`حذف ${ids.length} قناة نهائياً؟`)) return;
  channelsBulkDelete.disabled = true;
  try {
    await Promise.all(ids.map((id) => deleteDoc(doc(db, 'channels', id))));
    selectedChannelIds.clear();
    channelSelectMode = false;
    channelsBulkBar.classList.add('hidden');
    channelsSelectToggle.textContent = 'تحديد للحذف';
    await loadChannels();
  } catch (_) {
    window.alert('تعذر حذف بعض القنوات. حاول مرة أخرى.');
    channelsBulkDelete.disabled = false;
  }
});

document.querySelector('#theme-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const message = document.querySelector('#theme-message');
  try { await setDoc(doc(db, 'settings', 'theme'), { primaryColor: document.querySelector('#primary-color').value, backgroundColor: document.querySelector('#background-color').value }, { merge: true }); message.textContent = 'تم حفظ الألوان، وستظهر في التطبيق.'; }
  catch (_) { message.textContent = 'تعذر حفظ الألوان. تحقق من قواعد Firestore.'; message.classList.add('error'); }
});

document.querySelector('#player-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#player-message');
  const scheme = document.querySelector('#player-scheme').value.trim().replaceAll('://', '');
  const androidPackage = document.querySelector('#player-package').value.trim();
  const storeUrl = document.querySelector('#player-store-url').value.trim();
  const minVersion = document.querySelector('#player-min-version').value.trim();
  const updateUrl = document.querySelector('#player-update-url').value.trim();
  const showSourcePage = document.querySelector('#player-show-source-page').checked;
  const premiumEnabled = document.querySelector('#premium-enabled').checked;
  const premiumUrl = document.querySelector('#premium-url').value.trim();
  const premiumButtonText = document.querySelector('#premium-button-text').value.trim();
  try {
    await setDoc(doc(db, 'settings', 'player'), {
      deepLinkScheme: scheme,
      androidPackage,
      storeUrl,
      minVersion,
      updateUrl,
      showSourcePage,
      premiumEnabled,
      premiumUrl,
      premiumButtonText,
      updatedAt: serverTimestamp(),
    }, { merge: true });

    // نفس رابط Google Play متاح أيضاً للتطبيق الرئيسي عبر settings/app.
    // نحفظ الاسمين للتوافق مع الإصدارات الحالية والقديمة.
    await setDoc(doc(db, 'settings', 'app'), {
      storeUrl,
      appStoreUrl: storeUrl,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    message.classList.remove('error');
    message.textContent = 'تم حفظ إعدادات المشغل.';
  } catch (_) {
    message.classList.add('error');
    message.textContent = 'تعذر حفظ إعدادات المشغل. تحقق من قواعد Firestore.';
  }
});
