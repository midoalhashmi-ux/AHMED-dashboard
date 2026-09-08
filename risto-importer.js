const WORKER_BASE_URL = 'https://binsheikh-api.binsheikh.workers.dev';
const SYNC_SECRET_STORAGE_KEY = 'binsheikh-admin-sync-secret';
const STATE_KEY = 'ristoAnimeAutoImportStateV1';
const SOURCE_URL = 'https://ristoanime.me/series/';
const BATCH_SIZE = 450;

let firebaseReady = false;
let auth = null;
let db = null;
let running = false;
let stopRequested = false;
let currentState = loadState();

function freshState() { return { version: 1, pageUrl: SOURCE_URL, pages: [], seriesIndex: 0, doneSeries: 0, importedEpisodes: 0, importedCategories: 0, startedAt: null, lastError: '', completed: false }; }
function loadState() { try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || freshState(); } catch (_) { return freshState(); } }
function saveState() { localStorage.setItem(STATE_KEY, JSON.stringify(currentState)); }
function secret() { try { return sessionStorage.getItem(SYNC_SECRET_STORAGE_KEY) || ''; } catch (_) { return ''; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function ensureFirebase() {
  if (firebaseReady) return;
  const [{ getApps, getApp, initializeApp }, { getFirestore, collection, doc, writeBatch }, { getAuth }] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js'),
    import('https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js')
  ]);
  const appModule = await import('./app.js');
  const config = appModule.firebaseConfig;
  if (!config) throw new Error('تعذر الوصول إلى إعداد Firebase الموجود في لوحة التحكم.');
  const app = getApps().length ? getApp() : initializeApp(config);
  db = getFirestore(app); auth = getAuth(app);
  window.__ristoFirebase = { collection, doc, writeBatch };
  firebaseReady = true;
}
function hashId(input) { let h = 2166136261; for (let i=0;i<input.length;i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619); } return `risto_${(h>>>0).toString(16)}_${input.length.toString(36)}`; }
function bilingualTitle(title) {
  const t = String(title || '').replace(/\s+/g,' ').trim();
  if (/\p{Script=Arabic}/u.test(t) && /[A-Za-z]/.test(t)) return t;
  return t;
}
function episodeTitle(seriesTitle, number, fallback) { const n = number == null ? null : Number(number); return bilingualTitle(`${seriesTitle || fallback || 'أنمي'}${n == null ? '' : ` - الحلقة ${n}`}`); }
function numberOf(ep) { const n = Number(ep?.episodeNumber); return Number.isFinite(n) ? n : null; }
async function worker(action, payload={}) {
  const response = await fetch(`${WORKER_BASE_URL}/ristoAnime/import`, { method:'POST', headers:{'Content-Type':'application/json','x-admin-key':secret()}, body:JSON.stringify({action,...payload}) });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.message || `Worker HTTP ${response.status}`);
  return data;
}
async function commitRows(rows) {
  const { doc, writeBatch } = window.__ristoFirebase; for (let i=0;i<rows.length;i+=BATCH_SIZE) { const batch=writeBatch(db); for (const row of rows.slice(i,i+BATCH_SIZE)) batch.set(doc(db,row.path),row.data,{merge:true}); await batch.commit(); await sleep(20); }
}
function ui() {
  let box=document.getElementById('risto-importer-card'); if(box) return box;
  box=document.createElement('section'); box.id='risto-importer-card'; box.className='card category-form-card hidden'; box.innerHTML=`<div><h2>🤖 استيراد RistoAnime تلقائياً</h2><p class="muted">يقرأ الموقع عبر Worker ويحفظ الأنمي والمواسم والحلقات تلقائياً على دفعات.</p></div><div class="form-actions"><button id="risto-start" type="button">بدء / استئناف الاستيراد</button><button id="risto-stop" class="secondary-button" type="button">إيقاف بعد الدفعة الحالية</button><button id="risto-reset" class="secondary-button" type="button">مسح التقدم</button></div><p id="risto-progress" class="form-message" role="status"></p>`;
  document.querySelector('#home-panel')?.prepend(box); return box;
}
function progress(text){ const el=document.getElementById('risto-progress'); if(el) el.textContent=text; }
async function importSeries(item) {
  let url=item.url, page=0, episodes=[], title=item.title, thumb=item.thumbnail;
  do { const data=await worker('series',{url,fallbackTitle:title,fallbackThumbnail:thumb}); title=bilingualTitle(data.title||title); thumb=data.thumbnail||thumb; episodes.push(...(data.episodes||[])); const pages=data.nextPageUrl; url=pages||null; page++; if(page>200) break; } while(url && !stopRequested);
  const direct=episodes.slice();
  const unresolved=[];
  let data=await worker('series',{url:item.url,fallbackTitle:title,fallbackThumbnail:thumb});
  for(const ep of data.episodePages||[]) if(!direct.some(x=>x.watchUrl===ep.episodeUrl)) unresolved.push(ep.episodeUrl);
  for(let i=0;i<unresolved.length;i+=40){ if(stopRequested) break; const r=await worker('resolveEpisodes',{url:item.url,urls:unresolved.slice(i,i+40),fallbackThumbnail:thumb}); direct.push(...(r.episodes||[])); }
  const unique=[...new Map(direct.filter(x=>x.watchUrl).map(x=>[x.watchUrl,x])).values()].sort((a,b)=>(numberOf(a)??999999)-(numberOf(b)??999999));
  const categoryId=hashId(`anime|${item.url}`); const rows=[{path:`categories/${categoryId}`,data:{title,iconUrl:thumb||null,parentId:'',order:currentState.doneSeries,contentType:'anime',updatedAt:new Date()}}];
  for(const ep of unique){ const n=numberOf(ep); const id=hashId(`${categoryId}|${ep.watchUrl}`); rows.push({path:`channels/${id}`,data:{categoryId,title:episodeTitle(title,n,ep.title),logoUrl:ep.thumbnail||thumb||null,streamType:'web',sourceUrl:ep.watchUrl,directUrl:null,protected:false,sourceHeaders:{},apiHeaders:{},order:n==null?999999:n,updatedAt:new Date()}}); }
  await commitRows(rows); currentState.importedCategories++; currentState.importedEpisodes+=unique.length; currentState.doneSeries++; saveState(); return unique.length;
}
async function run(){ if(running)return; running=true; stopRequested=false; currentState.lastError=''; currentState.completed=false; currentState.startedAt=currentState.startedAt||new Date().toISOString(); saveState(); try { await ensureFirebase(); let pageUrl=currentState.pageUrl||SOURCE_URL; let pageGuard=0; while(pageUrl&&!stopRequested){ const data=await worker('catalog',{url:pageUrl}); const list=data.series||[]; for(let i=currentState.seriesIndex;i<list.length;i++){ if(stopRequested)break; currentState.seriesIndex=i; saveState(); progress(`جارٍ الاستيراد: ${currentState.doneSeries} أنمي • ${currentState.importedEpisodes} حلقة`); await importSeries(list[i]); currentState.seriesIndex=i+1; saveState(); } if(stopRequested) break; pageUrl=data.nextPageUrl||null; currentState.pageUrl=pageUrl; currentState.seriesIndex=0; saveState(); pageGuard++; if(pageGuard>1000)break; } currentState.completed=!stopRequested; saveState(); progress(currentState.completed?`اكتمل الاستيراد: ${currentState.doneSeries} أنمي • ${currentState.importedEpisodes} حلقة`:`تم الإيقاف. يمكنك الاستئناف لاحقاً.`); } catch(e){ currentState.lastError=e?.message||String(e); saveState(); progress(`توقف بسبب خطأ: ${currentState.lastError}`); } finally { running=false; } }
function bind(){ const box=ui(); document.getElementById('risto-start').onclick=run; document.getElementById('risto-stop').onclick=()=>{stopRequested=true;progress('سيتم الإيقاف بعد إنهاء العملية الحالية…');}; document.getElementById('risto-reset').onclick=()=>{if(running)return;currentState=freshState();saveState();progress('تم مسح التقدم.');}; progress(currentState.completed?`آخر استيراد مكتمل: ${currentState.doneSeries} أنمي • ${currentState.importedEpisodes} حلقة`:'جاهز للاستيراد التلقائي.'); }
function addMenuItem(){ const menu=document.getElementById('add-menu'); if(!menu||menu.querySelector('[data-add-type="risto-auto"]'))return; const b=document.createElement('button'); b.type='button'; b.dataset.addType='risto-auto'; b.setAttribute('role','menuitem'); b.textContent='🤖 استيراد RistoAnime تلقائياً'; b.onclick=()=>{menu.classList.add('hidden');const box=ui();box.classList.remove('hidden');box.scrollIntoView({behavior:'smooth',block:'start'});}; menu.appendChild(b); }
function boot(){ const timer=setInterval(()=>{ if(document.getElementById('add-menu')&&document.getElementById('home-panel')){clearInterval(timer);bind();addMenuItem();}},300); }
boot();
