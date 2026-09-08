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
    strLeagueCountry: league.country || '',
    strLeagueBadge: league.logo || null,
    strHomeTeam: (teams.home && teams.home.name) || '',
    strAwayTeam: (teams.away && teams.away.name) || '',
    strHomeTeamBadge: (teams.home && teams.home.logo) || null,
    strAwayTeamBadge: (teams.away && teams.away.logo) || null,
    homeTeamId: (teams.home && teams.home.id) ? String(teams.home.id) : null,
    awayTeamId: (teams.away && teams.away.id) ? String(teams.away.id) : null,
    dateEvent,
    strTime: strTime || '00:00:00',
    intHomeScore: goals.home == null ? null : String(goals.home),
    intAwayScore: goals.away == null ? null : String(goals.away),
    strStatus: mapFixtureStatus(fixture.status && fixture.status.short),
    strStatusShort: (fixture.status && fixture.status.short) || '',
    strVenue: (fixture.venue && fixture.venue.name) || '',
    strCity: (fixture.venue && fixture.venue.city) || '',
    strTimestamp: fixture.timestamp || null,
    strRound: league.round || '',
    intLeagueId: league.id || null,
    intSeason: league.season || null,
    fixtureId: fixture.id || null,
  };
}

async function handleRefreshMatches(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  const adminKey = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_SYNC_SECRET || adminKey !== env.ADMIN_SYNC_SECRET) {
    return json({ error: 'permission-denied', message: 'مفتاح المزامنة غير صحيح.' }, 403);
  }

  const apiKey = env.API_FOOTBALL_KEY;
  if (!apiKey) return json({ error: 'failed-precondition', message: 'API_FOOTBALL_KEY غير مضبوط في Worker.' }, 500);

  const date = (body && body.date) || new Date().toISOString().slice(0, 10);
  const apiUrl = `https://v3.football.api-sports.io/fixtures?date=${encodeURIComponent(date)}`;

  const response = await fetch(apiUrl, { headers: { 'x-apisports-key': apiKey } });
  if (!response.ok) return json({ error: 'api-error', message: `API-Football HTTP ${response.status}.` }, 502);

  const payload = await response.json();
  const fixtures = Array.isArray(payload.response) ? payload.response : [];
  const allowed = fixtures.filter((fx) => isAllowedLeague(fx && fx.league && fx.league.name)).map(normalizeFixture);

  return json({ ok: true, date, count: allowed.length, matches: allowed });
}

async function handleGetMatchStats(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid-argument', message: 'body غير صالح.' }, 400); }
  const adminKey = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_SYNC_SECRET || adminKey !== env.ADMIN_SYNC_SECRET) return json({ error: 'permission-denied', message: 'مفتاح المزامنة غير صحيح.' }, 403);
  const apiKey = env.API_FOOTBALL_KEY;
  const fixtureId = body && body.fixtureId;
  if (!apiKey || !fixtureId) return json({ error: 'invalid-argument', message: 'fixtureId مطلوب.' }, 400);
  const response = await fetch(`https://v3.football.api-sports.io/fixtures?id=${encodeURIComponent(fixtureId)}`, { headers: { 'x-apisports-key': apiKey } });
  if (!response.ok) return json({ error: 'api-error', message: `API-Football HTTP ${response.status}.` }, 502);
  const payload = await response.json();
  return json({ ok: true, response: payload.response || [] });
}

async function handleGetPreMatchInfo(request, env) {
  let body;
  try { body = await request.json(); } catch (_) { return json({ error: 'invalid-argument', message: 'body غير صالح.' }, 400); }
  const adminKey = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_SYNC_SECRET || adminKey !== env.ADMIN_SYNC_SECRET) return json({ error: 'permission-denied', message: 'مفتاح المزامنة غير صحيح.' }, 403);
  const apiKey = env.API_FOOTBALL_KEY;
  const homeTeamId = body && body.homeTeamId;
  const awayTeamId = body && body.awayTeamId;
  if (!apiKey || !homeTeamId || !awayTeamId) return json({ error: 'invalid-argument', message: 'homeTeamId و awayTeamId مطلوبان.' }, 400);

  const headers = { 'x-apisports-key': apiKey };
  const [homeLast, awayLast, h2h] = await Promise.all([
    fetch(`https://v3.football.api-sports.io/fixtures?team=${encodeURIComponent(homeTeamId)}&last=5`, { headers }).then(r => r.ok ? r.json() : ({ response: [] })).catch(() => ({ response: [] })),
    fetch(`https://v3.football.api-sports.io/fixtures?team=${encodeURIComponent(awayTeamId)}&last=5`, { headers }).then(r => r.ok ? r.json() : ({ response: [] })).catch(() => ({ response: [] })),
    fetch(`https://v3.football.api-sports.io/fixtures/headtohead?h2h=${encodeURIComponent(homeTeamId)}-${encodeURIComponent(awayTeamId)}&last=5`, { headers }).then(r => r.ok ? r.json() : ({ response: [] })).catch(() => ({ response: [] })),
  ]);

  return json({ ok: true, homeLast: homeLast.response || [], awayLast: awayLast.response || [], h2h: h2h.response || [] });
}

// ---------------------------------------------------------------------------
// RistoAnime importer — server-side HTML reader only.
// It never guesses a playback URL: episode entries must contain a real
// /watch/ link, or the normal episode page is fetched to resolve that link.
// ---------------------------------------------------------------------------
function ristoDecodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#039;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#x2F;/gi, '/');
}
function ristoText(value) {
  return ristoDecodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}
function ristoAbsUrl(value, base) {
  try {
    const u = new URL(ristoDecodeHtml(value), base || 'https://ristoanime.me/');
    if (u.hostname !== 'ristoanime.me' && u.hostname !== 'www.ristoanime.me') return '';
    return u.href;
  } catch (_) { return ''; }
}
function ristoAttr(tag, name) {
  const m = String(tag || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']+)`, 'i'));
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
  const titleTag = String(block || '').match(/<(?:h[1-6]|a|span|div)\b[^>]*>([\s\S]{1,300})<\/(?:h[1-6]|a|span|div)>/i);
  const attrTitle = ristoAttr(block, 'title') || ristoAttr(block, 'alt');
  return ristoText(titleTag?.[1] || attrTitle);
}
function ristoEpisodeNumber(title, url) {
  const text = `${title || ''} ${url || ''}`;
  const m = text.match(/(?:الحلقة|episode|ep)[^0-9]{0,12}(\d+(?:\.\d+)?)/i) || text.match(/[-_]([0-9]{1,4})(?:[-_/]|$)/);
  return m ? Number(m[1]) : null;
}
function ristoIsEpisodeUrl(url) { return /ristoanime\.me\/(?:[^/]+\/)?(?:انمي|anime)[^/]*الحلقة|episode|الحلقة-/i.test(url); }
function ristoIsWatchUrl(url) { return /\/watch\/?(?:\?|$)/i.test(url); }
function ristoUnique(items, keyFn) {
  const map = new Map(); for (const item of items) { const key = keyFn(item); if (key && !map.has(key)) map.set(key, item); } return [...map.values()];
}
function ristoFindNextPage(html, base) {
  const re = /<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]{0,120})<\/a>/gi; let m;
  while ((m = re.exec(html))) {
    const text = ristoText(m[3]); const rel = ristoAttr(m[1], 'rel'); const cls = ristoAttr(m[1], 'class'); const url = ristoAbsUrl(m[2], base);
    if (url && (/next/i.test(rel) || /next|pagination-next|التالي|الصفحة التالية/i.test(`${cls} ${text}`))) return url;
  }
  return '';
}
function ristoParseCatalog(html, base) {
  const out = []; const re = /<(?:article|div|li)\b[^>]*(?:class|id)=["'][^"']*(?:item|post|anime|series|movie|card)[^"']*["'][^>]*>[\s\S]{0,5000}?<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]{0,5000}?<\/a>[\s\S]{0,5000}?<\/(?:article|div|li)>/gi; let m;
  while ((m = re.exec(html))) {
    const block = m[0]; const url = ristoAbsUrl(m[1], base); if (!url || !/\/series\//i.test(url)) continue;
    const title = ristoTitleFromBlock(block) || url.split('/').filter(Boolean).pop() || 'أنمي'; const thumbnail = ristoImageFromBlock(block, base); out.push({ url, title, thumbnail });
  }
  if (!out.length) {
    const fallback = /<a\b[^>]*href=["']([^"']+\/series\/[^"']*)["'][^>]*>([\s\S]{0,500})<\/a>/gi;
    while ((m = fallback.exec(html))) { const url = ristoAbsUrl(m[1], base); if (!url) continue; out.push({ url, title: ristoText(m[2]) || url.split('/').filter(Boolean).pop() || 'أنمي', thumbnail: ristoImageFromBlock(m[0], base) }); }
  }
  return ristoUnique(out, x => x.url);
}
function ristoParseWatchLinks(html, base, inheritedThumbnail) {
  const out = []; const re = /<a\b[^>]*href=["']([^"']+\/watch\/?(?:\?[^"']*)?)["'][^>]*>[\s\S]{0,1000}?<\/a>/gi; let m;
  while ((m = re.exec(html))) { const url = ristoAbsUrl(m[1], base); if (!url || !ristoIsWatchUrl(url)) continue; const title = ristoTitleFromBlock(m[0]) || url.split('/').filter(Boolean).pop() || 'حلقة'; out.push({ watchUrl: url, title, episodeNumber: ristoEpisodeNumber(title, url), thumbnail: ristoImageFromBlock(m[0], base) || inheritedThumbnail || null }); }
  return ristoUnique(out, x => x.watchUrl);
}
function ristoParseEpisodePageLinks(html, base, inheritedThumbnail) {
  const out = []; const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]{0,1000}?<\/a>/gi; let m;
  while ((m = re.exec(html))) { const url = ristoAbsUrl(m[1], base); if (!url || !ristoIsEpisodeUrl(url) || ristoIsWatchUrl(url)) continue; const title = ristoTitleFromBlock(m[0]) || url.split('/').filter(Boolean).pop() || 'حلقة'; out.push({ episodeUrl: url, title, episodeNumber: ristoEpisodeNumber(title, url), thumbnail: ristoImageFromBlock(m[0], base) || inheritedThumbnail || null }); }
  return ristoUnique(out, x => x.episodeUrl);
}
function ristoParseSeasonLinks(html, base) {
  const out = []; const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]{0,500}?<\/a>/gi; let m;
  while ((m = re.exec(html))) { const url = ristoAbsUrl(m[1], base); const text = ristoText(m[0]); if (!url || !/\/series\//i.test(url) || !/(الموسم|season|s\s*\d+)/i.test(text)) continue; out.push({ url, title: text }); }
  return ristoUnique(out, x => x.url);
}
function ristoSeriesTitle(html, fallback) {
  const h1 = String(html || '').match(/<h1\b[^>]*>([\s\S]{1,500})<\/h1>/i); const og = String(html || '').match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)/i); return ristoText(h1?.[1] || og?.[1] || fallback || 'أنمي بلا اسم');
}
function ristoSeriesThumbnail(html, base) {
  const og = String(html || '').match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i); if (og?.[1]) { const u = ristoAbsUrl(og[1], base); if (u) return u; }
  const img = String(html || '').match(/<img\b[^>]*>/i)?.[0] || ''; return ristoAbsUrl(ristoAttr(img, 'src'), base) || '';
}
async function ristoFetch(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; RistoAnimeImporter/1.0)' } });
  if (!response.ok) throw new Error(`RistoAnime HTTP ${response.status}`); return await response.text();
}
async function handleRistoAnimeImport(request, env) {
  const adminKey = request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_SYNC_SECRET || adminKey !== env.ADMIN_SYNC_SECRET) return json({ error: 'permission-denied', message: 'مفتاح المزامنة غير صحيح.' }, 403);
  let body = {}; try { body = await request.json(); } catch (_) {}
  const action = body?.action || 'catalog';
  const url = ristoAbsUrl(body?.url || 'https://ristoanime.me/series/', 'https://ristoanime.me/'); if (!url) return json({ error: 'invalid-argument', message: 'رابط RistoAnime غير صالح.' }, 400);
  try {
    const html = await ristoFetch(url);
    if (action === 'catalog') return json({ ok: true, series: ristoParseCatalog(html, url), nextPageUrl: ristoFindNextPage(html, url) || null });
    if (action === 'series') {
      const title = ristoSeriesTitle(html, body?.fallbackTitle || 'أنمي بلا اسم'); const thumbnail = ristoSeriesThumbnail(html, url) || body?.fallbackThumbnail || null;
      const directWatch = ristoParseWatchLinks(html, url, thumbnail); const episodePages = ristoParseEpisodePageLinks(html, url, thumbnail); const seasonLinks = ristoParseSeasonLinks(html, url);
      return json({ ok: true, title, thumbnail, episodes: directWatch, episodePages, seasons: seasonLinks, nextPageUrl: ristoFindNextPage(html, url) || null });
    }
    if (action === 'resolveEpisodes') {
      const urls = Array.isArray(body?.urls) ? body.urls.slice(0, 40).map(x => ristoAbsUrl(x, url)).filter(Boolean) : [];
      const resolved = [];
      for (const episodeUrl of urls) { try { const episodeHtml = await ristoFetch(episodeUrl); const links = ristoParseWatchLinks(episodeHtml, episodeUrl, body?.fallbackThumbnail || null); if (links[0]) resolved.push({ ...links[0], episodeUrl }); } catch (_) {} }
      return json({ ok: true, episodes: resolved });
    }
    if (action === 'episode') {
      const links = ristoParseWatchLinks(html, url, body?.fallbackThumbnail || null); return json({ ok: true, episodes: links });
    }
    return json({ error: 'invalid-argument', message: 'إجراء RistoAnime غير معروف.' }, 400);
  } catch (error) { return json({ error: 'risto-fetch-failed', message: error?.message || 'تعذر قراءة RistoAnime.' }, 502); }
}

async function runScheduledSync(env) {
  try {
    if (!env.ADMIN_SYNC_SECRET) return;
    const request = new Request('https://worker.internal/refreshMatches', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': env.ADMIN_SYNC_SECRET }, body: JSON.stringify({ date: new Date().toISOString().slice(0, 10) }) });
    await handleRefreshMatches(request, env);
  } catch (_) {}
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/getStreamUrl') return handleGetStreamUrl(request, env);
    if (request.method === 'POST' && url.pathname === '/refreshMatches') return handleRefreshMatches(request, env);
    if (request.method === 'POST' && url.pathname === '/getMatchStats') return handleGetMatchStats(request, env);
    if (request.method === 'POST' && url.pathname === '/getPreMatchInfo') return handleGetPreMatchInfo(request, env);
    if (request.method === 'POST' && url.pathname === '/ristoAnime/import') return handleRistoAnimeImport(request, env);
    const hlsMatch = request.method === 'GET' && url.pathname.match(/^\/hls\/([^/]+)\/(.+)$/);
    if (hlsMatch) { const [, channelId, file] = hlsMatch; return handleHlsProxy(request, env, channelId, file); }
    return json({ error: 'not-found', message: 'مسار غير معروف.' }, 404);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runScheduledSync(env)); },
};
