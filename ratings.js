import {
  collection,
  getDocs,
  query,
  where,
  writeBatch,
  doc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

// نفس عنوان الـ Worker المستخدم بباقي لوحة التحكم (site-importer.js/app.js).
const WORKER_BASE_URL = 'https://binsheikh-api.binsheikh.workers.dev';
const SYNC_SECRET_STORAGE_KEY = 'binsheikh-admin-sync-secret';
// أقسام (أفلام/مسلسلات/أنمي) في دفعة واحدة، بفاصل زمني بين كل طلب والتالي
// حتى لا نتجاوز حدود معدّل Jikan العامة (3 طلبات/ثانية تقريباً).
const REQUEST_DELAY_MS = 500;
const RATED_CONTENT_TYPES = ['movies', 'series', 'anime'];

let firebaseReady = false;
let db = null;

let adminSyncSecret = '';
try { adminSyncSecret = sessionStorage.getItem(SYNC_SECRET_STORAGE_KEY) || ''; } catch (_) {}

let running = false;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// نفس أسلوب site-importer.js: أول استخدام بجلسة جديدة يطلب المفتاح مرة
// واحدة ويخزّنه بنفس مفتاح sessionStorage المشترك بين كل أدوات اللوحة.
function getAdminKey() {
  if (adminSyncSecret) return adminSyncSecret;
  const value = window.prompt('أدخل مفتاح مزامنة Worker الخاص بلوحة التحكم:');
  if (!value?.trim()) throw new Error('لم يتم إدخال مفتاح المزامنة.');
  adminSyncSecret = value.trim();
  try { sessionStorage.setItem(SYNC_SECRET_STORAGE_KEY, adminSyncSecret); } catch (_) {}
  return adminSyncSecret;
}

async function searchRating(title, contentType) {
  const key = getAdminKey();
  const response = await fetch(`${WORKER_BASE_URL}/ratings/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': key },
    body: JSON.stringify({ title, contentType }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || !data.ok) {
    throw new Error(data?.message || `فشل الطلب (${response.status})`);
  }
  return data; // { ok, rating, source, matchedTitle }
}

function setProgress(text) {
  const el = document.querySelector('#ratings-progress');
  if (el) el.textContent = text;
}

async function updateAllRatings() {
  if (running) return;
  if (!firebaseReady || !db) {
    setProgress('تعذر الاتصال بخدمة لوحة التحكم. أعد تحميل الصفحة وحاول مرة أخرى.');
    return;
  }
  running = true;
  const button = document.querySelector('#ratings-update-button');
  if (button) button.disabled = true;

  try {
    const categoriesQuery = query(
      collection(db, 'categories'),
      where('contentType', 'in', RATED_CONTENT_TYPES),
    );
    const snapshot = await getDocs(categoriesQuery);
    const categories = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));

    if (!categories.length) {
      setProgress('لا توجد أقسام أفلام/مسلسلات/أنمي بعد.');
      return;
    }

    let done = 0;
    let matched = 0;
    let failed = 0;

    for (const category of categories) {
      done += 1;
      setProgress(`جارٍ الفحص (${done}/${categories.length})… "${category.title || ''}"`);
      try {
        const result = await searchRating(category.title || '', category.contentType);
        const batch = writeBatch(db);
        batch.set(doc(db, 'categories', category.id), {
          rating: result.rating ?? null,
          ratingSource: result.rating != null ? result.source : null,
          ratingCheckedAt: serverTimestamp(),
        }, { merge: true });
        await batch.commit();
        if (result.rating != null) matched += 1;
      } catch (error) {
        failed += 1;
        // نكمل لباقي الأقسام حتى لو فشل قسم واحد (شبكة، أو Jikan/TMDB متعطّل مؤقتاً)
      }
      await sleep(REQUEST_DELAY_MS);
    }

    setProgress(`اكتمل: ${matched} قسم حصل على تقييم، ${categories.length - matched - failed} بدون تطابق واضح${failed ? `، ${failed} فشل الاتصال بها` : ''}.`);
  } catch (error) {
    setProgress(`تعذر تحديث التقييمات: ${String(error?.message || error)}`);
  } finally {
    running = false;
    if (button) button.disabled = false;
  }
}

async function boot() {
  for (let i = 0; i < 100 && !window.__AHMED_DASHBOARD_FIREBASE__; i += 1) await sleep(50);
  const shared = window.__AHMED_DASHBOARD_FIREBASE__;
  if (shared) { db = shared.db; firebaseReady = true; }

  const button = document.querySelector('#ratings-update-button');
  if (button) button.addEventListener('click', updateAllRatings);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
