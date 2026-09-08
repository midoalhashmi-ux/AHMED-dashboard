import { getDoc, setDoc } from './firestore.js';
import {
  HLS_TOKEN_TTL_SECONDS,
  signHlsToken,
  verifyHlsToken,
  buildHlsPlaybackUrl,
  rewriteHlsPlaylist,
} from './hls.js';

// ============================================================================
// بديل Firebase Cloud Functions لهذا المشروع — يعمل على Cloudflare Workers،
// بدون الحاجة لخطة Blaze أو حساب فوترة سعودي عبر CNTXT، وبنفس فكرة الحماية
// تماماً: كل سرّ (مفتاح API-Football، بيانات حساب خدمة Google) يبقى هنا
// فقط، ولا يصل إطلاقاً لكود الموبايل أو المتصفح.
//
// نقطتان يخدمهما هذا الملف:
//   1) POST /getStreamUrl   — يُستدعى من تطبيق المشغل، يرجّع رابط m3u8 الحقيقي.
//   2) POST /refreshMatches — يُستدعى من لوحة التحكم (زر "مزامنة الآن").
//   3) scheduled()          — Cron Trigger كل ساعة، نفس منطق refreshMatches.
// ============================================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// 1) getStreamUrl — نفس منطق دالة Firebase الأصلية بالضبط.
// ---------------------------------------------------------------------------
async function handleGetStreamUrl(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid-argument', message: 'body غير صالح.' }, 400);
  }

  const channelId = body && body.channelId;
  if (!channelId || typeof channelId !== 'string') {
    return json({ error: 'invalid-argument', message: 'channelId مطلوب.' }, 400);
  }

  const [streamDoc, channelDoc] = await Promise.all([
    getDoc(env, `privateStreams/${channelId}`),
    getDoc(env, `channels/${channelId}`),
  ]);

  if (channelDoc && channelDoc.status === 'disabled') {
    return json({ error: 'permission-denied', message: 'هذه القناة موقوفة مؤقتاً.' }, 403);
  }

  if (channelDoc && channelDoc.protected === false && channelDoc.directUrl) {
    return json({ url: channelDoc.directUrl, expiresIn: null });
  }

  if (!streamDoc) {
    return json({ error: 'not-found', message: 'لم يتم تسجيل مصدر بث لهذه القناة بعد.' }, 404);
  }

  // لو القناة مربوطة برابط API خارجي (مثل سكربتات جلب الروابط اللحظية)،
  // نجيب الرابط الحقيقي "حي" من نفس هذا الـ API عند كل طلب مشاهدة فعلي —
  // بدل الاعتماد على رابط مخزَّن قديم قد يكون انتهى. لو الجلب الحي فشل
  // (السيرفر الخارجي واقف، أو رجّع شكل غير متوقع)، نرجع لآخر رابط ناجح
  // محفوظ في privateStreams.url بدل ما تنقطع المشاهدة بالكامل.
  let url = streamDoc.url;
  if (streamDoc.apiUrl && typeof streamDoc.apiUrl === 'string') {
    try {
      const liveResponse = await fetch(streamDoc.apiUrl, {
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
      if (liveResponse.ok) {
        const liveBody = await liveResponse.json();
        if (liveBody && typeof liveBody.url === 'string' && liveBody.url) {
          url = liveBody.url;
          // نخزّن آخر رابط ناجح كنسخة احتياطية (fallback)، وننتظر اكتمال
          // الحفظ (لا fire-and-forget) لأن /hls (بروكسي التشغيل الفعلي)
          // يقرأ نفس هذا الحقل بعد لحظات — لازم يجده محدَّثاً فوراً.
          await setDoc(env, `privateStreams/${channelId}`, {
            url,
            apiUrl: streamDoc.apiUrl,
            updatedAt: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    } catch (_) {
      // نتجاهل الخطأ ونكمل بالرابط المخزَّن (url) كنسخة احتياطية أدناه.
    }
  }

  if (!url || typeof url !== 'string') {
    return json({ error: 'not-found', message: 'رابط البث لهذه القناة غير مضبوط.' }, 404);
  }

  // بدل إرجاع رابط المصدر الحقيقي مباشرة (كان يبقى صالحاً 4 ساعات كاملة
  // ومكشوفاً بالكامل لأي حد يعترض الطلب أو يفحص التطبيق) — نرجّع رابط
  // موقّت يمر عبر هذا الـ Worker نفسه (بروكسي)، فرابط privateStreams
  // الحقيقي ما يوصل لجهاز المستخدم إطلاقاً ولا حتى لحظة واحدة.
  const requestUrl = new URL(request.url);
  const exp = Math.floor(Date.now() / 1000) + HLS_TOKEN_TTL_SECONDS;
  const sig = await signHlsToken(env, channelId, exp);
  const playbackUrl = buildHlsPlaybackUrl(requestUrl.origin, channelId, exp, sig);

  return json({ url: playbackUrl, kind: 'hls', expiresIn: HLS_TOKEN_TTL_SECONDS });
}

// ---------------------------------------------------------------------------
// 1.5) بروكسي بث HLS — يتحقق من التوكن، يجيب من المصدر الحقيقي (بدون
//      كشفه)، ويعيد كتابة الـ m3u8 ليمر كل segment عبر نفس الـ Worker.
// ---------------------------------------------------------------------------
async function handleHlsProxy(request, env, channelId, file) {
  const requestUrl = new URL(request.url);
  const exp = requestUrl.searchParams.get('exp');
  const sig = requestUrl.searchParams.get('sig');

  const valid = await verifyHlsToken(env, channelId, exp, sig);
  if (!valid) {
    return json({ error: 'invalid-token', message: 'رابط غير صالح أو منتهي.' }, 403);
  }

  const streamDoc = await getDoc(env, `privateStreams/${channelId}`);
  const originUrl = streamDoc && streamDoc.url;
  if (!originUrl || typeof originUrl !== 'string') {
    return json({ error: 'not-found', message: 'رابط البث لهذه القناة غير مضبوط.' }, 404);
  }

  // نفترض إن originUrl هو رابط ملف m3u8 الرئيسي؛ باقي الملفات (segments)
  // تُبنى بنفس مجلد المصدر مع اسم الملف المطلوب.
  const originBase = originUrl.substring(0, originUrl.lastIndexOf('/'));
  const targetUrl = file === 'playlist.m3u8' ? originUrl : `${originBase}/${file}`;

  const originResponse = await fetch(targetUrl, {
    headers: { 'user-agent': 'Mozilla/5.0' },
  });

  if (!originResponse.ok) {
    return json({ error: 'origin-fetch-failed', message: 'تعذر الوصول لمصدر البث.' }, 502);
  }

  if (file.endsWith('.m3u8')) {
    const text = await originResponse.text();
    const rewritten = rewriteHlsPlaylist(text, channelId, exp, sig, requestUrl.origin);
    return new Response(rewritten, {
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': 'no-store',
        ...CORS_HEADERS,
      },
    });
  }

  // segments (.ts / .m4s) تُبثّ كما هي مباشرة بدون تحميلها كاملة بالذاكرة
  return new Response(originResponse.body, {
    headers: {
      'content-type': originResponse.headers.get('content-type') || 'video/mp2t',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

// ---------------------------------------------------------------------------
// 2) مباريات اليوم — API-Football
// ---------------------------------------------------------------------------
//
// قائمة الدوريات/الكؤوس المسموحة فقط (نفس القائمة بالضبط الموجودة في
// lib/core/data/football_ar_translations.dart بالتطبيق) — نستبعد أي دوري
// آخر هنا مباشرة عند المصدر بدل الاعتماد فقط على فلترة التطبيق، حتى لا
// تُخزَّن أصلاً مئات مباريات الدرجة الثانية/الثالثة والدول غير المطلوبة في
// Firestore (توفير تخزين + سرعة تحميل الشاشة). القائمتان يجب أن تبقيا
// متطابقتين — أي إضافة دوري جديد لازم تنعكس بالملفين معاً.
const ALLOWED_LEAGUE_NAMES = new Set([
  'saudi professional league', 'saudi pro league', 'saudi king cup',
  'egyptian premier league',
  'uae arabian gulf league', 'uae pro league',
  'qatar stars league',
  'iraqi premier league',
  'kuwaiti premier league',
  'moroccan botola pro',
  'tunisian ligue 1',
  'algerian ligue professionnelle 1',
  'caf champions league', 'caf confederation cup',
  'afc champions league', 'afc champions league elite',
  'english premier league', 'premier league',
  'spanish la liga', 'la liga',
  'italian serie a', 'serie a',
  'german bundesliga', 'bundesliga',
  'french ligue 1', 'ligue 1',
  'uefa champions league', 'uefa europa league', 'uefa europa conference league',
  'fifa world cup', 'world cup',
  'fifa club world cup', 'club world cup',
  'world cup qualification caf', 'world cup - qualification africa',
  'world cup qualification afc', 'world cup - qualification asia',
  'africa cup of nations',
  'afc asian cup',
  'premier soccer league', 'betway premiership',
  'npfl', 'nigeria professional football league',
  'fa cup', 'copa del rey', 'coppa italia', 'dfb pokal', 'dfb-pokal',
  'coupe de france', 'efl cup', 'carabao cup',
]);

function isAllowedLeague(leagueName) {
  return ALLOWED_LEAGUE_NAMES.has((leagueName || '').toString().trim().toLowerCase());
}

function mapFixtureStatus(shortStatus) {
  const s = (shortStatus || '').toString().toUpperCase();
  if (['1H', '2H', 'HT', 'ET', 'P', 'LIVE', 'BT'].includes(s)) return 'LIVE';
  if (['FT', 'AET', 'PEN'].includes(s)) return 'FT';
  if (['PST', 'CANC', 'ABD', 'SUSP', 'INT'].includes(s)) return 'PST';
  return 'NS';
}

function normalizeFixture(fx) {
  const fixture = fx.fixture || {};
  const league = fx.league || {};
  const teams = fx.teams || {};
  const goals = fx.goals || {};

  const dateIso = (fixture.date || '').toString();
  const dateEvent = dateIso.split('T')[0] || '';
  const timePart = dateIso.split('T')[1] || '00:00:00';
  const strTime = timePart.replace(/[+-]\d{2}:\d{2}$/, '').replace('Z', '');

  return {
    idEvent: String(fixture.id ?? ''),
    strLeague: league.name || '',
    // ناقص سابقاً — بدونه أي دوري بنفس الاسم بأكثر من دولة (Premier
    // League إنجلترا/مصر، Serie A إيطاليا/البرازيل، Bundesliga
    // ألمانيا/النمسا) يوصل للتطبيق بدولة فاضية، فتستبعده isSupportedLeague
    // بالكامل ظناً منه أن التصنيف غير مؤكد.
    strLeagueCountry: league.country || '',
    strLeagueBadge: league.logo || null,
    strHomeTeam: (teams.home && teams.home.name) || '',
    strAwayTeam: (teams.away && teams.away.name) || '',
    strHomeTeamBadge: (teams.home && teams.home.logo) || null,
    strAwayTeamBadge: (teams.away && teams.away.logo) || null,
    // معرّفا الفريقين في API-Football — لازمان لجلب معلومات ما قبل
    // المباراة (getPreMatchInfo): آخر 5 مباريات لكل فريق + آخر مواجهات.
    homeTeamId: (teams.home && teams.home.id) ? String(teams.home.id) : null,
    awayTeamId: (teams.away && teams.away.id) ? String(teams.away.id) : null,
    dateEvent,
    strTime: strTime || '00:00:00',
    intHomeScore: goals.home ?? null,
    intAwayScore: goals.away ?? null,
    strStatus: mapFixtureStatus(fixture.status && fixture.status.short),
    strVenue: (fixture.venue && fixture.venue.name) || null,
  };
}

async function fetchFixturesOnce(env, dateStr) {
  const response = await fetch(
      `https://v3.football.api-sports.io/fixtures?date=${dateStr}`,
      { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } },
  );

  if (!response.ok) {
    throw new Error(`تعذر الاتصال بـ API-Football (${response.status}).`);
  }

  const body = await response.json();

  // API-Football يرجّع HTTP 200 حتى في حالة خطأ فعلي (مفتاح غير صالح،
  // انتهاء الحصة اليومية/الدقيقية، معامل غير صحيح...) — الخطأ يظهر فقط
  // داخل body.errors مع response فاضية. بدون هذا الفحص كانت كل هذه
  // الحالات تُعامَل بصمت على أنها "0 مباراة اليوم" بدل إظهار السبب
  // الحقيقي، وهذا على الأغلب هو سبب اختفاء كل المباريات فجأة.
  const apiErrors = body.errors;
  const hasApiErrors = apiErrors &&
      (Array.isArray(apiErrors) ? apiErrors.length > 0 : Object.keys(apiErrors).length > 0);
  if (hasApiErrors) {
    throw new Error(`API-Football رجّع خطأ: ${JSON.stringify(apiErrors)}`);
  }

  return (body.response || []).map(normalizeFixture);
}

async function fetchAndStoreFixtures(env, dateStr, { finalize = false, retryOnEmpty = false } = {}) {
  let allEvents = await fetchFixturesOnce(env, dateStr);

  // السبب الفعلي وراء "الساعة 6 = صفر، الساعة 7 = 300، الساعة 8 = صفر...":
  // API-Football نفسه يرجّع أحياناً استجابة فارغة تماماً لطلب سليم 100%
  // (بدون أي خطأ HTTP ولا خطأ داخل body.errors) ثم يرجّع النتائج الصحيحة
  // فوراً عند إعادة نفس الطلب بعد ثوانٍ — وهذا ما كان يفسّر لماذا "مزامنة
  // الآن" اليدوية كانت تُصلح الوضع فوراً بعد ظهوره فارغاً تلقائياً. الحل:
  // إعادة محاولة واحدة بعد مهلة قصيرة قبل اعتماد نتيجة فارغة، فقط أثناء
  // المزامنة التلقائية غير المراقَبة (retryOnEmpty=true) حيث لا يوجد
  // مستخدم ينتظر الرد فوراً كما في زر "مزامنة الآن" اليدوي.
  if (allEvents.length === 0 && retryOnEmpty) {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    try {
      allEvents = await fetchFixturesOnce(env, dateStr);
    } catch (_) {
      // تجاهل فشل إعادة المحاولة — نكمل بالنتيجة الفارغة الأصلية ونطبّق
      // حماية "عدم الكتابة فوق بيانات جيدة سابقة" أدناه.
    }
  }

  // الطلب بدون أي تصفية يرجّع مئات المباريات يومياً (كل درجات ودوريات
  // العالم، حتى الدرجات الهاوية والشبابية المغمورة والدول غير المطلوبة).
  // نطبّق فلترين معاً:
  //   1) isAllowedLeague — يستبعد أي دوري ليس ضمن القائمة المعتمدة
  //      (درجة أولى فقط من الدوريات/الكؤوس المطلوبة).
  //   2) شعارات كاملة — الدوريات المسموحة نفسها نادراً ما ينقصها شعار،
  //      لكن نُبقي الفحص احتياطاً لمنع أي صورة مكسورة.
  const events = [];
  let excludedLeagueCount = 0;
  let excludedBadgeCount = 0;
  const excludedLeagueSample = new Set();

  for (const event of allEvents) {
    if (!isAllowedLeague(event.strLeague)) {
      excludedLeagueCount++;
      if (excludedLeagueSample.size < 15) excludedLeagueSample.add(event.strLeague);
      continue;
    }
    if (!(event.strHomeTeamBadge && event.strAwayTeamBadge && event.strLeagueBadge)) {
      excludedBadgeCount++;
      continue;
    }
    events.push(event);
  }

  // حماية إضافية: إن رجعت هذه المزامنة بصفر مباراة رغم إعادة المحاولة،
  // ولدينا فعلاً بيانات جيدة مخزّنة سابقاً لنفس اليوم، لا نمسحها بصفر —
  // على الأرجح هذه استجابة مؤقتة من API-Football وليست حقيقة "لا مباريات
  // اليوم". نُحدّث updatedAt فقط ليعكس وقت آخر محاولة، ونُبقي المباريات
  // كما هي حتى المزامنة التالية.
  if (events.length === 0 && retryOnEmpty) {
    const existing = await getDoc(env, `matches_daily/${dateStr}`);
    if (existing && Array.isArray(existing.events) && existing.events.length > 0) {
      await setDoc(env, `matches_daily/${dateStr}`, {
        ...existing,
        updatedAt: new Date(),
      });
      return {
        count: existing.events.length,
        rawCount: existing.rawResultsCount ?? existing.events.length,
        keptExisting: true,
      };
    }
  }

  await setDoc(env, `matches_daily/${dateStr}`, {
    events,
    updatedAt: new Date(),
    source: 'api-football',
    rawResultsCount: allEvents.length,
    // تشخيص مؤقت: يوضح سبب استبعاد كل مباراة لم تظهر في القائمة النهائية،
    // بدل التخمين. excludedLeagueSample أسماء دوريات فعلية من المصدر لم
    // تُطابق isAllowedLeague — تفيد لو الاسم مختلف عمّا هو متوقع بالقائمة.
    debugExcludedByLeague: excludedLeagueCount,
    debugExcludedByBadge: excludedBadgeCount,
    debugExcludedLeagueSample: Array.from(excludedLeagueSample),
    // finalized = true يعني "يوم ماضٍ اكتملت نتائجه ولن يُعاد جلبه مرة
    // أخرى" — هذا هو أساس توفير حصة API-Football عند تفعيل نافذة الأيام
    // الماضية (راجع runScheduledSync أدناه).
    finalized: finalize,
  });

  return { count: events.length, rawCount: allEvents.length };
}

function todayDateKey() {
  return dateKeyOffset(0);
}

// يرجّع مفتاح تاريخ (YYYY-MM-DD) بإزاحة أيام عن اليوم الحالي (UTC).
// offset موجب = أيام قادمة، سالب = أيام ماضية.
function dateKeyOffset(offsetDays) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + offsetDays);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// مزامنة نافذة 7 أيام (من -3 إلى +3) بأقل استهلاك ممكن لحصة API-Football:
//   - اليوم: تُجلب كل ساعة (نفس ما كان سابقاً) لأنها الوحيدة التي تحتاج
//     تحديث نتائج مباشر خلال اليوم.
//   - الأيام القادمة (+1 إلى +3): تُجلب مرة واحدة فقط يومياً (عند الساعة
//     0 بتوقيت UTC) — الجدول لا يتغير كل ساعة، يكفي تحديث يومي (يلتقط
//     أي تأجيل/تعديل موعد).
//   - الأيام الماضية (-1 إلى -3): تُجلب مرة واحدة واحدة فقط طوال عمرها
//     (عند تحوّلها لأول مرة إلى "يوم ماضٍ")، ثم تُعلَّم finalized=true
//     ولا يُعاد الاتصال بـ API-Football لأجلها إطلاقاً بعد ذلك — نتيجة
//     مباراة منتهية لن تتغير.
//
// الحصيلة: 24 طلب/يوم (اليوم كل ساعة) + ~4 طلبات إضافية فقط مرة واحدة
// يومياً (3 أيام قادمة + يوم ماضٍ واحد جديد) ≈ 28 طلب/يوم، بدل 168 لو
// جُلبت كل الأيام السبعة كل ساعة.
async function runScheduledSync(env) {
  try {
    // retryOnEmpty: true — هذه هي المزامنة التلقائية غير المراقَبة، فمن
    // الأفضل تحمّل ثانية إضافية لإعادة محاولة عند استجابة فارغة بدل تخزين
    // "0 مباراة" خاطئة قد تبقى ظاهرة للمستخدمين ساعة كاملة حتى المزامنة
    // التالية.
    await fetchAndStoreFixtures(env, dateKeyOffset(0), { retryOnEmpty: true });
  } catch (_) {
    // فشل مزامنة اليوم لا يجب أن يمنع محاولة مزامنة الأيام القادمة/الماضية
    // أدناه (كانت سابقاً تتوقف بالكامل لأن هذا الاستدعاء لم يكن ضمن try/catch،
    // فأي خطأ عابر بمصدر البيانات كان يُسقط التشغيل كله لتلك الساعة).
  }

  const hour = new Date().getUTCHours();

  // مشكلة كانت هنا: الأيام القادمة (غداً وبعد غد...) كانت تُجلب فقط عند
  // الساعة 0 UTC بالضبط. لو التطبيق فُتح في أي وقت آخر قبل أول تشغيل
  // للووركر بعد منتصف الليل (مثلاً بعد نشر أول مرة، أو بعد توقف مؤقت)،
  // يبقى مستند "غداً" غير موجود إطلاقاً في Firestore طوال اليوم كامل،
  // فتظهر الشاشة فارغة رغم وجود مباريات فعلية. الحل: نجلب اليوم القادم
  // فوراً لو مستنده غير موجود أصلاً (بغض النظر عن الساعة)، ثم نكتفي
  // بتحديث مرة واحدة يومياً عند منتصف الليل بعد أول تعبئة (لالتقاط أي
  // تأجيل/تعديل موعد لاحقاً) — بدون أي زيادة في استهلاك الحصة اليومية
  // في الوضع المستقر.
  for (const offset of [1, 2, 3]) {
    const dateStr = dateKeyOffset(offset);
    try {
      const existing = await getDoc(env, `matches_daily/${dateStr}`);
      if (!existing || hour === 0) {
        await fetchAndStoreFixtures(env, dateStr, { retryOnEmpty: true });
      }
    } catch (_) {
      // تجاهل فشل يوم قادم واحد، لا نوقف بقية المزامنة بسببه.
    }
  }

  for (const offset of [-1, -2, -3]) {
    const dateStr = dateKeyOffset(offset);
    try {
      const existing = await getDoc(env, `matches_daily/${dateStr}`);
      if (existing && existing.finalized === true) continue;
      if (!existing || hour === 0) {
        await fetchAndStoreFixtures(env, dateStr, { finalize: true, retryOnEmpty: true });
      }
    } catch (_) {
      // نفس الشيء — يوم ماضٍ واحد يفشل لا يوقف البقية، وسيُعاد المحاولة
      // غداً تلقائياً لأنه لن يكون finalized بعد.
    }
  }
}

async function handleRefreshMatches(request, env) {
  const adminKey = request.headers.get('x-admin-key');
  if (!env.ADMIN_SYNC_SECRET || adminKey !== env.ADMIN_SYNC_SECRET) {
    return json({ error: 'permission-denied', message: 'غير مصرح.' }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    // body اختياري — لو ما أُرسل، نستخدم تاريخ اليوم.
  }

  // يدعم مزامنة يوم واحد (body.date) أو نافذة الأيام كاملة دفعة واحدة
  // (body.syncWindow = true) — مفيد لزر "مزامنة الآن" بلوحة التحكم بعد
  // نشر هذا التحديث لأول مرة، حتى تمتلئ الأيام السبعة فوراً بدل انتظار
  // المزامنة التلقائية اليومية.
  if (body.syncWindow === true) {
    const results = {};
    for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
      const dateStr = dateKeyOffset(offset);
      try {
        results[dateStr] = await fetchAndStoreFixtures(env, dateStr, { finalize: offset < 0, retryOnEmpty: true });
      } catch (error) {
        results[dateStr] = `error: ${String(error && error.message || error)}`;
      }
    }
    return json({ ok: true, results });
  }

  const dateStr = body.date || todayDateKey();
  try {
    const { count, rawCount } = await fetchAndStoreFixtures(env, dateStr, { retryOnEmpty: true });
    return json({ ok: true, count, rawCount, date: dateStr });
  } catch (error) {
    return json({ ok: false, message: String(error && error.message || error) }, 500);
  }
}

// ---------------------------------------------------------------------------
// 3) إحصائيات مباراة واحدة عند فتحها من التطبيق (استحواذ، تسديدات،
//    ركنيات، بطاقات...) — مع كاش بـ Firestore حتى يشترك كل المستخدمين
//    بنفس النتيجة المخزّنة بدل أن يستهلك كل ضغطة من كل مستخدم طلب
//    API-Football منفصل:
//      - مباراة منتهية: تُخزّن نهائياً، لا يُعاد جلبها أبداً بعد أول مرة.
//      - مباراة مباشرة: كاش لمدة دقيقة واحدة فقط قبل إعادة الجلب.
//      - مباراة لم تبدأ: لا يُرسل أي طلب لـ API-Football أصلاً (العميل
//        يتحقق من الحالة محلياً قبل الاتصال بهذه النقطة).
// ---------------------------------------------------------------------------
const LIVE_STATS_CACHE_MS = 60 * 1000;

async function handleGetMatchStats(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid-argument', message: 'body غير صالح.' }, 400);
  }

  const fixtureId = body && body.fixtureId;
  if (!fixtureId || typeof fixtureId !== 'string') {
    return json({ error: 'invalid-argument', message: 'fixtureId مطلوب.' }, 400);
  }

  const cacheKey = `matches_stats/${fixtureId}`;
  const cached = await getDoc(env, cacheKey);
  const now = Date.now();

  if (cached) {
    const isFresh = cached.matchFinished === true
        || (now - (cached.fetchedAtMs || 0)) < LIVE_STATS_CACHE_MS;
    if (isFresh) {
      return json({ statistics: cached.statistics, cached: true });
    }
  }

  let response;
  try {
    response = await fetch(
        `https://v3.football.api-sports.io/fixtures/statistics?fixture=${encodeURIComponent(fixtureId)}`,
        { headers: { 'x-apisports-key': env.API_FOOTBALL_KEY } },
    );
  } catch (_) {
    if (cached) return json({ statistics: cached.statistics, cached: true, stale: true });
    return json({ error: 'upstream-error', message: 'تعذر الاتصال بمصدر الإحصائيات.' }, 502);
  }

  if (!response.ok) {
    if (cached) return json({ statistics: cached.statistics, cached: true, stale: true });
    return json({ error: 'upstream-error', message: 'تعذر جلب الإحصائيات حالياً.' }, 502);
  }

  const data = await response.json();
  const rawTeams = data.response || [];

  if (rawTeams.length === 0) {
    return json({ statistics: null, message: 'لا توجد إحصائيات متاحة لهذه المباراة بعد.' });
  }

  const statistics = rawTeams.map((team) => ({
    teamId: (team.team && team.team.id) ?? null,
    teamName: (team.team && team.team.name) || '',
    stats: (team.statistics || []).map((s) => ({ type: s.type, value: s.value })),
  }));

  // نعتمد على العميل لإخبارنا هل المباراة انتهت (body.finished) بدل
  // طلب API إضافي فقط لمعرفة الحالة — الحالة أصلاً معروفة عند العميل
  // من matches_daily.
  const matchFinished = body.finished === true;

  await setDoc(env, cacheKey, {
    statistics,
    matchFinished,
    fetchedAtMs: now,
  });

  return json({ statistics, cached: false });
}

// ---------------------------------------------------------------------------
// 4) معلومات ما قبل المباراة: آخر 5 مباريات لكل فريق + آخر مواجهات مباشرة
//    بينهما. كاش مشترك بين كل المستخدمين لمدة 12 ساعة، بمفتاح مبني على
//    رقمي الفريقين فقط (بدون ترتيب مضيف/ضيف) — بهذا الشكل أي عدد من
//    المستخدمين يفتحون أي مباراة بين نفس الفريقين خلال نفس اليوم يشتركون
//    في 3 طلبات API-Football واحدة فقط بدل 3 طلبات لكل فتحة شاشة.
// ---------------------------------------------------------------------------
async function fetchApiFootballJson(env, path) {
  const response = await fetch(`https://v3.football.api-sports.io${path}`, {
    headers: { 'x-apisports-key': env.API_FOOTBALL_KEY },
  });
  if (!response.ok) {
    throw new Error(`API-Football HTTP ${response.status}`);
  }
  const body = await response.json();
  const apiErrors = body.errors;
  const hasApiErrors = apiErrors &&
      (Array.isArray(apiErrors) ? apiErrors.length > 0 : Object.keys(apiErrors).length > 0);
  if (hasApiErrors) {
    throw new Error(`API-Football رجّع خطأ: ${JSON.stringify(apiErrors)}`);
  }
  return body.response || [];
}

// يحوّل مباراة سابقة (من fixtures أو headtohead) إلى نتيجة مبسّطة من
// منظور فريق واحد (perspectiveTeamId) — فوز/تعادل/خسارة + الخصم + التاريخ.
// يتجاهل المباريات غير المنتهية (لا نتيجة نهائية بعد).
function buildFormEntry(fx, perspectiveTeamId) {
  const fixture = fx.fixture || {};
  const league = fx.league || {};
  const teams = fx.teams || {};
  const goals = fx.goals || {};
  const statusShort = (fixture.status && fixture.status.short) || '';
  if (!['FT', 'AET', 'PEN'].includes(statusShort)) return null;
  if (goals.home == null || goals.away == null) return null;

  const homeId = teams.home && teams.home.id;
  const isHome = String(homeId) === String(perspectiveTeamId);
  const dateIso = (fixture.date || '').toString();

  return {
    opponentEn: isHome ? ((teams.away && teams.away.name) || '') : ((teams.home && teams.home.name) || ''),
    teamScore: isHome ? goals.home : goals.away,
    opponentScore: isHome ? goals.away : goals.home,
    dateEvent: dateIso.split('T')[0] || '',
    leagueNameEn: league.name || '',
  };
}

const PRE_MATCH_CACHE_MS = 12 * 60 * 60 * 1000; // 12 ساعة

async function handleGetPreMatchInfo(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid-argument', message: 'body غير صالح.' }, 400);
  }

  const homeTeamId = body && body.homeTeamId;
  const awayTeamId = body && body.awayTeamId;
  if (!homeTeamId || !awayTeamId) {
    return json({ error: 'invalid-argument', message: 'homeTeamId و awayTeamId مطلوبان.' }, 400);
  }

  // مفتاح الكاش لا يعتمد على ترتيب مضيف/ضيف — نفس زوج الفريقين يعيد
  // استخدام نفس النتيجة المخزّنة بغض النظر عن مين المضيف في هذه المباراة.
  const pairKey = [String(homeTeamId), String(awayTeamId)].sort().join('_');
  const cacheKey = `prematch_info/${pairKey}`;

  const cached = await getDoc(env, cacheKey);
  const now = Date.now();
  if (cached && (now - (cached.fetchedAtMs || 0)) < PRE_MATCH_CACHE_MS) {
    return json({ info: cached.info, cached: true });
  }

  try {
    const [h2hRaw, homeRaw, awayRaw] = await Promise.all([
      fetchApiFootballJson(env, `/fixtures/headtohead?h2h=${homeTeamId}-${awayTeamId}&last=5`),
      fetchApiFootballJson(env, `/fixtures?team=${homeTeamId}&last=5`),
      fetchApiFootballJson(env, `/fixtures?team=${awayTeamId}&last=5`),
    ]);

    const info = {
      h2h: h2hRaw.map((fx) => buildFormEntry(fx, homeTeamId)).filter(Boolean),
      homeForm: homeRaw.map((fx) => buildFormEntry(fx, homeTeamId)).filter(Boolean),
      awayForm: awayRaw.map((fx) => buildFormEntry(fx, awayTeamId)).filter(Boolean),
    };

    await setDoc(env, cacheKey, { info, fetchedAtMs: now });
    return json({ info, cached: false });
  } catch (error) {
    if (cached) return json({ info: cached.info, cached: true, stale: true });
    return json({ error: 'upstream-error', message: 'تعذر جلب معلومات ما قبل المباراة حالياً.' }, 502);
  }
}

// ---------------------------------------------------------------------------
// التوجيه (Routing)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RistoAnime importer — server-side HTML reader only. It returns public page
// metadata and confirmed /watch/ links; it never downloads or proxies video.
// ---------------------------------------------------------------------------
function ristoDecodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—').replace(/&#x27;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return _; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch (_) { return _; } });
}
function ristoText(value) {
  return ristoDecodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}
function ristoAbsUrl(value, base) {
  try {
    const u = new URL(ristoDecodeHtml(value), base || 'https://ristoanime.me/');
    if (u.hostname !== 'ristoanime.me' && u.hostname !== 'www.ristoanime.me') return '';
    u.hash = '';
    return u.href;
  } catch (_) { return ''; }
}
function ristoAttr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*["\\\']([^"\\\']+)', 'i');
  const m = String(tag || '').match(re);
  return m ? ristoDecodeHtml(m[1]) : '';
}
function ristoImageFromBlock(block, base) {
  const img = String(block || '').match(/<img\b[^>]*>/i)?.[0] || '';
  const candidates = [ristoAttr(img, 'data-src'), ristoAttr(img, 'data-lazy-src'), ristoAttr(img, 'src'), ristoAttr(img, 'data-original')];
  for (const candidate of candidates) {
    const url = ristoAbsUrl(candidate, base);
    if (url) return url;
  }
  const srcset = ristoAttr(img, 'srcset');
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    const url = ristoAbsUrl(first, base);
    if (url) return url;
  }
  return '';
}
function ristoTitleFromBlock(block) {
  const titleTag = String(block || '').match(/<(?:h[1-6]|a|span)[^>]*>([\s\S]*?)<\/(?:h[1-6]|a|span)>/i);
  const attrTitle = String(block || '').match(/\b(?:title|aria-label)=["']([^"']+)["']/i)?.[1] || '';
  return ristoText(titleTag?.[1] || attrTitle);
}
function ristoEpisodeNumber(title, url) {
  const source = `${title || ''} ${url || ''}`;
  const m = source.match(/(?:الحلقة|episode|ep)[\s._-]*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}
function ristoIsEpisodeUrl(url) {
  return /\/\b(?:انمي|anime)\b.*(?:الحلقة|episode|ep)[-_]?\d+/i.test(url) || /الحلقة[-_]?\d+/i.test(url);
}
function ristoIsWatchUrl(url) { return /\/watch\/?(?:\?|$)/i.test(url); }
function ristoUnique(items, keyFn) {
  const seen = new Set(); const out = [];
  for (const item of items) { const key = keyFn(item); if (!key || seen.has(key)) continue; seen.add(key); out.push(item); }
  return out;
}
function ristoFindNextPage(html, base) {
  const links = [...String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const m of links) {
    const text = ristoText(m[2]);
    const rel = ristoAttr(m[0], 'rel');
    const cls = ristoAttr(m[0], 'class');
    const url = ristoAbsUrl(m[1], base);
    if (!url || /\bnext\b|التالي|الصفحة التالية/i.test(`${text} ${rel} ${cls}`)) return url || '';
  }
  return '';
}
function ristoParseCatalog(html, base) {
  const out = [];
  const anchors = [...String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)];
  for (const m of anchors) {
    const url = ristoAbsUrl(m[1], base);
    if (!url || !url.includes('/series/')) continue;
    if (/\b(?:offset|page)=/i.test(url)) continue;
    const block = m[0];
    const title = ristoTitleFromBlock(block) || ristoAttr(block, 'title');
    const thumbnail = ristoImageFromBlock(block, base);
    if (!title && !thumbnail) continue;
    out.push({ url, title: title || url.split('/').filter(Boolean).pop(), thumbnail: thumbnail || null });
  }
  return ristoUnique(out, x => x.url);
}
function ristoParseWatchLinks(html, base, inheritedThumbnail) {
  const out = [];
  const anchors = [...String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)];
  for (const m of anchors) {
    const url = ristoAbsUrl(m[1], base);
    if (!url || !ristoIsWatchUrl(url)) continue;
    const title = ristoTitleFromBlock(m[0]) || url.split('/').filter(Boolean).pop() || 'حلقة';
    out.push({ watchUrl: url, title, episodeNumber: ristoEpisodeNumber(title, url), thumbnail: ristoImageFromBlock(m[0], base) || inheritedThumbnail || null });
  }
  return ristoUnique(out, x => x.watchUrl);
}
function ristoParseEpisodePageLinks(html, base, inheritedThumbnail) {
  const out = [];
  const anchors = [...String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)];
  for (const m of anchors) {
    const url = ristoAbsUrl(m[1], base);
    if (!url || !ristoIsEpisodeUrl(url)) continue;
    const title = ristoTitleFromBlock(m[0]) || url.split('/').filter(Boolean).pop() || 'حلقة';
    out.push({ url, title, episodeNumber: ristoEpisodeNumber(title, url), thumbnail: ristoImageFromBlock(m[0], base) || inheritedThumbnail || null });
  }
  return ristoUnique(out, x => x.url);
}
function ristoParseSeasonLinks(html, base) {
  const out = [];
  const anchors = [...String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi)];
  for (const m of anchors) {
    const url = ristoAbsUrl(m[1], base);
    const title = ristoText(m[2] || '') || ristoTitleFromBlock(m[0]);
    if (!url || !title) continue;
    if (!/(?:الموسم|season|s\d+)/i.test(`${title} ${url}`)) continue;
    out.push({ url, title });
  }
  return ristoUnique(out, x => x.url);
}
function ristoSeriesTitle(html, fallback) {
  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const og = String(html || '').match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i);
  return ristoText(h1?.[1] || og?.[1] || fallback || 'أنمي بلا اسم');
}
function ristoSeriesThumbnail(html, base) {
  const og = String(html || '').match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i);
  const fromOg = ristoAbsUrl(og?.[1] || '', base); if (fromOg) return fromOg;
  const img = String(html || '').match(/<img\b[^>]*>/i)?.[0] || '';
  return ristoAbsUrl(ristoAttr(img, 'src'), base) || '';
}
async function ristoFetch(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; RistoAnimeCatalogBot/1.0)', accept: 'text/html,application/xhtml+xml' }, redirect: 'follow' });
  if (!response.ok) throw new Error(`RistoAnime HTTP ${response.status}`);
  return await response.text();
}
async function handleRistoAnimeImport(request, env) {
  const adminKey = request.headers.get('x-admin-key');
  if (!env.ADMIN_SYNC_SECRET || adminKey !== env.ADMIN_SYNC_SECRET) return json({ error: 'permission-denied', message: 'غير مصرح.' }, 403);
  let body = {};
  try { body = await request.json(); } catch (_) {}
  const action = body?.action;
  const url = ristoAbsUrl(body?.url || SOURCE_URL, SOURCE_URL);
  if (!url) return json({ error: 'invalid-argument', message: 'رابط RistoAnime غير صالح.' }, 400);
  try {
    const html = await ristoFetch(url);
    if (action === 'catalog') {
      return json({ series: ristoParseCatalog(html, url), nextPageUrl: ristoFindNextPage(html, url) || null });
    }
    if (action === 'series') {
      const title = ristoSeriesTitle(html, body?.fallbackTitle || 'أنمي بلا اسم');
      const thumbnail = ristoSeriesThumbnail(html, url) || body?.fallbackThumbnail || null;
      const directWatch = ristoParseWatchLinks(html, url, thumbnail);
      const episodePages = ristoParseEpisodePageLinks(html, url, thumbnail);
      const seasonLinks = ristoParseSeasonLinks(html, url);
      return json({
        title, thumbnail,
        episodes: directWatch.length ? directWatch : episodePages,
        seasons: seasonLinks.map(s => ({ ...s, episodes: [] })),
        nextPageUrl: ristoFindNextPage(html, url) || null,
      });
    }
    if (action === 'resolveEpisodes') {
      const urls = Array.isArray(body?.urls) ? body.urls.slice(0, 40).map(x => ristoAbsUrl(x, url)).filter(Boolean) : [];
      const results = [];
      for (let i = 0; i < urls.length; i += 8) {
        const part = urls.slice(i, i + 8);
        const resolved = await Promise.all(part.map(async episodeUrl => {
          try {
            const episodeHtml = await ristoFetch(episodeUrl);
            const links = ristoParseWatchLinks(episodeHtml, episodeUrl, body?.fallbackThumbnail || null);
            return links[0] ? { ...links[0], originalUrl: episodeUrl } : null;
          } catch (_) { return null; }
        }));
        results.push(...resolved.filter(Boolean));
      }
      return json({ episodes: results });
    }
    if (action === 'resolveEpisode') {
      const links = ristoParseWatchLinks(html, url, body?.fallbackThumbnail || null);
      if (!links.length) return json({ error: 'not-found', message: 'لم يتم العثور على رابط /watch/ مؤكد لهذه الحلقة.' }, 404);
      return json({ episode: links[0] });
    }
    return json({ error: 'invalid-argument', message: 'action غير معروف.' }, 400);
  } catch (error) {
    return json({ error: 'upstream-error', message: error?.message || 'تعذر قراءة RistoAnime.' }, 502);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/getStreamUrl') {
      return handleGetStreamUrl(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/refreshMatches') {
      return handleRefreshMatches(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/getMatchStats') {
      return handleGetMatchStats(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/getPreMatchInfo') {
      return handleGetPreMatchInfo(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/ristoAnime/import') {
      return handleRistoAnimeImport(request, env);
    }

    const hlsMatch = request.method === 'GET' && url.pathname.match(/^\/hls\/([^/]+)\/(.+)$/);
    if (hlsMatch) {
      const [, channelId, file] = hlsMatch;
      return handleHlsProxy(request, env, channelId, file);
    }

    return json({ error: 'not-found', message: 'مسار غير معروف.' }, 404);
  },

  // Cron Trigger — مضبوط في wrangler.toml ليعمل كل ساعة تلقائياً.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledSync(env));
  },
};
