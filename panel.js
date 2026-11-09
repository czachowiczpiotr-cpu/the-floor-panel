/* Panel znajomych: nowe kategorie + podmiana słabych zdjęć → jeden plik .json do gry */
const OWNER = 'Piotrkowi';          // „Wyślij Piotrkowi”
const MAX_PX = [1280, 900];         // jak w grze
const MIN_GOOD = 20;                // tyle zdjęć wystarcza na pojedynek
const CATALOG = (window.CATALOG || []);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').trim().replace(/\s+/g, ' ');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------- zapis w przeglądarce (IndexedDB) ---------------- */
const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('thefloor-panel', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('cats', { keyPath: 'id' });
      r.result.createObjectStore('repl', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('abort'));
    });
  };
  return {
    all: s => run(s, 'readonly', st => st.getAll()),
    put: (s, v) => run(s, 'readwrite', st => st.put(v)),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    clear: s => run(s, 'readwrite', st => st.clear()),
  };
})();

/* ---------------- stan ---------------- */
let cats = [];          // [{id, name, items:[{id, a, blob}], created}]
let repl = {};          // key "slug|odpowiedź" → {key, slug, a, blob}
let curCat = null;      // edytowana kategoria
const urls = new Map(); // blob → objectURL (bez wycieków pamięci)
const urlOf = blob => { if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob)); return urls.get(blob); };

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
async function persist(cat) {
  try { await DB.put('cats', cat); }
  catch (e) { console.error(e); toast('⚠️ Nie udało się zapisać – za mało miejsca w telefonie?', 4000); }
}
let saveTimer = null;
const persistSoon = cat => { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(cat), 400); };

/* ---------------- zdjęcia ---------------- */
async function decode(file) {
  // 1) szybka ścieżka, 2) <img> (Safari umie HEIC z iPhone'a)
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {}
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}
async function shrink(file) {
  const src = await decode(file);
  const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
  if (!w || !h) throw new Error('puste zdjęcie');
  const k = Math.min(1, MAX_PX[0] / w, MAX_PX[1] / h);
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.84));
  if (!blob) throw new Error('nie udało się zapisać');
  return blob;
}
// nazwa pliku jako podpowiedź – ale nie „IMG_2041”
function guessAnswer(name) {
  const base = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  if (/^(img|dsc|dcim|pxl|photo|image|zdj|screenshot|zrzut|whatsapp|fb img|signal|received|mvimg|snapchat|pexels|unsplash)/i.test(base)) return '';
  if (/^[\d\s.]+$/.test(base) || /^[a-f0-9 ]{16,}$/i.test(base) || /\d{6,}/.test(base)) return '';
  return base.length <= 60 ? base[0].toUpperCase() + base.slice(1) : '';
}

/* ---------------- nawigacja ---------------- */
function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== id);
  window.scrollTo(0, 0);
}
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  for (const t of ['new', 'fix', 'send']) $('#tab-' + t).classList.toggle('hidden', t !== name);
  if (name === 'new') renderMyCats();
  if (name === 'fix') renderFix();
  if (name === 'send') renderSend();
  try { localStorage.setItem('tfp.tab', name); } catch (e) {}
}

/* ---------------- moje kategorie ---------------- */
function catStatus(c) {
  const missing = c.items.filter(i => !norm(i.a)).length;
  if (!norm(c.name)) return ['bad', 'brak nazwy'];
  if (!c.items.length) return ['bad', 'brak zdjęć'];
  if (missing) return ['warn', `${missing} bez podpisu`];
  if (dupes(c).length) return ['bad', 'powtórzone hasła'];
  if (c.items.length < MIN_GOOD) return ['warn', `${c.items.length} zdjęć – dodaj jeszcze`];
  return ['ok', `gotowe · ${c.items.length} zdjęć`];
}
function dupes(c) {
  const seen = new Map(), out = new Set();
  for (const i of c.items) {
    const k = norm(i.a).toLowerCase();
    if (!k) continue;
    if (seen.has(k)) out.add(norm(i.a)); else seen.set(k, 1);
  }
  return [...out];
}
function renderMyCats() {
  const box = $('#myCats');
  box.innerHTML = cats.length ? '' : '<p class="hint center">Nie masz jeszcze żadnej kategorii.</p>';
  for (const c of cats) {
    const [cls, txt] = catStatus(c);
    const d = document.createElement('div');
    d.className = 'catCard';
    d.innerHTML = `${c.items[0] ? `<img class="cover" src="${urlOf(c.items[0].blob)}" alt="">` : '<div class="cover"></div>'}
      <div class="meta"><b>${esc(norm(c.name) || 'Bez nazwy')}</b><span class="pill ${cls}">${esc(txt)}</span></div><span>›</span>`;
    d.onclick = () => openCat(c);
    box.appendChild(d);
  }
  updateBadge();
}
function newCat() {
  const c = { id: uid(), name: '', items: [], created: Date.now() };
  cats.push(c);
  persist(c);
  openCat(c);
  setTimeout(() => $('#catName').focus(), 50);
}
function openCat(c) {
  curCat = c;
  $('#catName').value = c.name;
  renderCat();
  showView('catView');
}
function renderCat() {
  const c = curCat, [cls, txt] = catStatus(c);
  $('#catState').className = 'pill ' + cls;
  $('#catState').textContent = txt;
  const missing = c.items.filter(i => !norm(i.a)).length;
  $('#catLabel').classList.toggle('hidden', !c.items.length);
  $('#catLabel').textContent = missing ? `✍️ Podpisz zdjęcia (${missing} bez podpisu)` : '✍️ Przejrzyj podpisy';
  const g = $('#catGrid');
  g.innerHTML = '';
  c.items.forEach((it, idx) => {
    const d = document.createElement('div');
    d.className = 'tile';
    d.innerHTML = `<img loading="lazy" src="${urlOf(it.blob)}" alt=""><div class="cap ${norm(it.a) ? '' : 'empty'}">${esc(norm(it.a) || 'bez podpisu')}</div>`;
    d.onclick = () => openLabeler(idx);
    g.appendChild(d);
  });
}
async function addPhotos(files) {
  const c = curCat;
  if (!files.length) return;
  const bar = $('#catProgress'), fill = bar.querySelector('div'), lab = bar.querySelector('span');
  bar.classList.remove('hidden');
  const bad = [], start = c.items.length;
  for (let i = 0; i < files.length; i++) {
    lab.textContent = `Wczytuję ${i + 1} / ${files.length}…`;
    fill.style.width = (100 * i / files.length) + '%';
    try {
      const blob = await shrink(files[i]);
      c.items.push({ id: uid(), a: guessAnswer(files[i].name), blob });
      if (i % 5 === 4) await persist(c);   // co kilka zdjęć – na wypadek zamknięcia karty
    } catch (e) { bad.push(files[i].name); }
  }
  fill.style.width = '100%';
  await persist(c);
  setTimeout(() => bar.classList.add('hidden'), 400);
  renderCat();
  if (bad.length) toast(`Nie udało się wczytać ${bad.length} zdjęć (zły format?)`, 4000);
  const added = c.items.length - start;
  if (added) {
    toast(`Dodano ${added} zdjęć – teraz je podpisz ✍️`);
    const firstEmpty = c.items.findIndex((it, i) => i >= start && !norm(it.a));
    if (firstEmpty >= 0) openLabeler(firstEmpty);
  }
}

/* ---------------- podpisywanie zdjęć po kolei ---------------- */
let labIdx = 0;
function openLabeler(i) {
  labIdx = Math.max(0, Math.min(i, curCat.items.length - 1));
  $('#labeler').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderLabeler();
}
function renderLabeler() {
  const it = curCat.items[labIdx];
  if (!it) return closeLabeler();
  $('#labImg').src = urlOf(it.blob);
  $('#labCount').textContent = `${labIdx + 1} / ${curCat.items.length}`;
  $('#labInput').value = it.a;
  $('#labPrev').disabled = labIdx === 0;
  $('#labNext').textContent = labIdx === curCat.items.length - 1 ? 'Gotowe ✓' : 'Dalej →';
  setTimeout(() => $('#labInput').focus({ preventScroll: true }), 30);
}
function commitLabel() {
  const it = curCat.items[labIdx];
  if (it) { it.a = norm($('#labInput').value); persistSoon(curCat); }
}
function labStep(dir) {
  commitLabel();
  if (dir > 0 && labIdx === curCat.items.length - 1) return closeLabeler();
  labIdx = Math.max(0, labIdx + dir);
  renderLabeler();
}
function closeLabeler() {
  commitLabel();
  $('#labeler').classList.add('hidden');
  document.body.style.overflow = '';
  persist(curCat);
  renderCat();
  const missing = curCat.items.filter(i => !norm(i.a)).length;
  if (!missing && curCat.items.length) toast('Wszystkie zdjęcia podpisane 👍');
}
function labDelete() {
  if (!confirm('Usunąć to zdjęcie z kategorii?')) return;
  curCat.items.splice(labIdx, 1);
  persist(curCat);
  if (!curCat.items.length) return closeLabeler();
  if (labIdx >= curCat.items.length) labIdx = curCat.items.length - 1;
  renderLabeler();
}

/* ---------------- poprawianie istniejących zdjęć ---------------- */
let fixItem = null;
function renderFixSelect() {
  const sel = $('#fixCat');
  sel.innerHTML = CATALOG.map(c => {
    const n = Object.values(repl).filter(r => r.slug === c.slug).length;
    return `<option value="${esc(c.slug)}">${esc(c.name)}${n ? ` (✓ ${n})` : ''}</option>`;
  }).join('');
  let last = null; try { last = localStorage.getItem('tfp.fixCat'); } catch (e) {}
  if (last && CATALOG.some(c => c.slug === last)) sel.value = last;
}
function renderFix() {
  if (!CATALOG.length) { $('#fixGrid').innerHTML = '<p class="hint">Brak katalogu zdjęć.</p>'; return; }
  const keep = $('#fixCat').value;
  renderFixSelect();
  if (keep) $('#fixCat').value = keep;
  const cat = CATALOG.find(c => c.slug === $('#fixCat').value) || CATALOG[0];
  const q = norm($('#fixSearch').value).toLowerCase();
  const g = $('#fixGrid');
  g.innerHTML = '';
  for (const it of cat.items) {
    if (q && !it.a.toLowerCase().includes(q)) continue;
    const r = repl[cat.slug + '|' + it.a];
    const d = document.createElement('div');
    d.className = 'tile' + (r ? ' done' : '');
    d.innerHTML = `<img loading="lazy" src="${r ? urlOf(r.blob) : it.t}" alt="">${r ? '<span class="badge">nowe</span>' : ''}<div class="cap">${esc(it.a)}</div>`;
    d.onclick = () => openFixer(cat, it);
    g.appendChild(d);
  }
  if (!g.children.length) g.innerHTML = '<p class="hint">Nic nie pasuje.</p>';
}
function openFixer(cat, it) {
  fixItem = { cat, it };
  const r = repl[cat.slug + '|' + it.a];
  $('#fxCat').textContent = cat.name;
  $('#fxAnswer').textContent = it.a;
  $('#fxOld').src = it.t;
  $('#fxNewFig').classList.toggle('hidden', !r);
  if (r) $('#fxNew').src = urlOf(r.blob);
  $('#fxUndo').classList.toggle('hidden', !r);
  $('#fxGoogle').href = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(it.a);
  $('#fixer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeFixer() {
  $('#fixer').classList.add('hidden');
  document.body.style.overflow = '';
  renderFix(); updateBadge();
}
async function fixPick(file) {
  if (!file || !fixItem) return;
  try {
    const blob = await shrink(file);
    const { cat, it } = fixItem, key = cat.slug + '|' + it.a;
    repl[key] = { key, slug: cat.slug, a: it.a, blob };
    await DB.put('repl', repl[key]);
    toast('Podmienione ✓');
    openFixer(cat, it);
  } catch (e) { toast('Nie udało się wczytać tego zdjęcia', 3500); }
}
async function fixUndo() {
  const { cat, it } = fixItem, key = cat.slug + '|' + it.a;
  delete repl[key];
  await DB.del('repl', key).catch(() => {});
  openFixer(cat, it);
}

/* ---------------- wysyłka ---------------- */
function problems() {
  const out = [];
  for (const c of cats) {
    const name = norm(c.name) || 'Bez nazwy';
    if (!c.items.length) continue;                      // pusta kategoria po prostu się nie wyśle
    if (!norm(c.name)) out.push(`Kategoria bez nazwy (${c.items.length} zdjęć) – nadaj jej nazwę.`);
    const missing = c.items.filter(i => !norm(i.a)).length;
    if (missing) out.push(`„${name}”: ${missing} zdjęć bez podpisu.`);
    const d = dupes(c);
    if (d.length) out.push(`„${name}”: powtórzone hasła – ${d.slice(0, 4).join(', ')}.`);
  }
  const names = cats.filter(c => c.items.length).map(c => norm(c.name).toLowerCase()).filter(Boolean);
  const dn = names.filter((n, i) => names.indexOf(n) !== i);
  if (dn.length) out.push(`Dwie kategorie mają tę samą nazwę: „${dn[0]}”.`);
  return out;
}
function sendable() { return { c: cats.filter(c => c.items.length), r: Object.values(repl) }; }
function updateBadge() {
  const { c, r } = sendable();
  $('#sendBadge').textContent = (c.length + r.length) || '';
}
function renderSend() {
  const { c, r } = sendable();
  const photos = c.reduce((s, x) => s + x.items.length, 0);
  $('#sendSummary').innerHTML = `
    <div class="sumRow"><span>Nowe kategorie</span><b>${c.length} <small class="hint">(${photos} zdjęć)</small></b></div>
    <div class="sumRow"><span>Poprawione zdjęcia</span><b>${r.length}</b></div>`;
  const pr = problems(), warn = c.filter(x => x.items.length < MIN_GOOD).map(x => `„${esc(norm(x.name) || 'Bez nazwy')}” ma tylko ${x.items.length} zdjęć – w grze mogą się powtarzać. Lepiej ${MIN_GOOD}+.`);
  $('#sendProblems').innerHTML = pr.map(p => `<div class="problem">⛔ ${esc(p)}</div>`).join('') + warn.map(w => `<div class="warnBox">⚠️ ${w}</div>`).join('');
  const btn = $('#sendGo');
  btn.disabled = !!pr.length || !(c.length + r.length);
  btn.textContent = `📤 Wyślij ${OWNER}`;
  updateBadge();
}
const toDataURL = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
async function buildPack() {
  const { c, r } = sendable(), me = getName();
  const pack = { thefloor: 2, from: me, created: new Date().toISOString(), cats: [], repl: [] };
  for (const cat of c) {
    const items = [];
    for (const it of cat.items) items.push({ a: norm(it.a), img: await toDataURL(it.blob) });
    pack.cats.push({ id: cat.id, name: norm(cat.name), items });
  }
  for (const x of r) pack.repl.push({ slug: x.slug, a: x.a, img: await toDataURL(x.blob) });
  return pack;
}
async function send() {
  if (problems().length) return renderSend();
  const btn = $('#sendGo');
  btn.disabled = true; btn.textContent = 'Pakuję…';
  try {
    const pack = await buildPack();
    const fname = `the-floor-od-${(pack.from || 'znajomego').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}.json`;
    const file = new File([JSON.stringify(pack)], fname, { type: 'application/json' });
    let how = 'pobrany';
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'The Floor – kategorie' }); how = 'udostępniony'; }
      catch (e) { if (e.name === 'AbortError') { renderSend(); return; } download(file); }
    } else download(file);
    const mb = (file.size / 1048576).toFixed(1);
    $('#sendDone').classList.remove('hidden');
    $('#sendDone').innerHTML = how === 'pobrany'
      ? `✅ Plik <b>${esc(fname)}</b> (${mb} MB) jest w Pobranych. Wyślij go ${OWNER} na Messengerze/WhatsAppie.`
      : `✅ Plik (${mb} MB) wysłany. Dzięki!<br><span class="hint">Możesz dalej poprawiać – następny plik zastąpi ten.</span>`;
  } catch (e) {
    console.error(e);
    toast('Coś poszło nie tak przy pakowaniu. Spróbuj jeszcze raz.', 4000);
  }
  renderSend();
}
function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}
async function wipe() {
  if (!confirm('Na pewno usunąć wszystkie twoje kategorie i poprawki z tego telefonu?')) return;
  await DB.clear('cats'); await DB.clear('repl');
  cats = []; repl = {};
  $('#sendDone').classList.add('hidden');
  showTab('new');
}

/* ---------------- samouczek ---------------- */
let tourIdx = 0;
function openTour() {
  tourIdx = 0;
  $('#tour').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderTour();
}
function renderTour() {
  const slides = document.querySelectorAll('.slide');
  slides.forEach((s, i) => s.classList.toggle('on', i === tourIdx));
  $('#tourDots').innerHTML = [...slides].map((_, i) => `<i class="${i === tourIdx ? 'on' : ''}"></i>`).join('');
  $('#tourNext').textContent = tourIdx === slides.length - 1 ? 'Zaczynam! 🚀' : 'Dalej →';
  $('#tourSkip').classList.toggle('hidden', tourIdx === slides.length - 1);
}
function closeTour() {
  $('#tour').classList.add('hidden');
  document.body.style.overflow = '';
  try { localStorage.setItem('tfp.tour', '1'); } catch (e) {}
}

/* ---------------- imię ---------------- */
const getName = () => { try { return localStorage.getItem('tfp.name') || ''; } catch (e) { return ''; } };
function setName(n) { try { localStorage.setItem('tfp.name', n); } catch (e) {} $('#who').textContent = n ? `👤 ${n}` : ''; }

/* ---------------- start ---------------- */
function bind() {
  $('#gateGo').onclick = () => {
    const n = norm($('#gateName').value);
    if (!n) return $('#gateName').focus();
    setName(n); showView('main'); showTab('new');
    let seen = false; try { seen = !!localStorage.getItem('tfp.tour'); } catch (e) {}
    if (!seen) openTour();
  };
  $('#gateName').onkeydown = e => { if (e.key === 'Enter') $('#gateGo').click(); };
  $('#who').onclick = () => { $('#gateName').value = getName(); showView('gate'); };
  $('#help').onclick = openTour;
  $('#tourSkip').onclick = closeTour;
  $('#tourNext').onclick = () => {
    if (tourIdx >= document.querySelectorAll('.slide').length - 1) return closeTour();
    tourIdx++; renderTour();
  };
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  $('#newCat').onclick = newCat;
  $('#catBack').onclick = () => { persist(curCat); showView('main'); showTab('new'); };
  $('#catName').oninput = e => { curCat.name = e.target.value; persistSoon(curCat); renderCat(); };
  $('#catFiles').onchange = e => { const f = [...e.target.files]; e.target.value = ''; addPhotos(f); };
  $('#catLabel').onclick = () => {
    const i = curCat.items.findIndex(x => !norm(x.a));
    openLabeler(i >= 0 ? i : 0);
  };
  $('#catDelete').onclick = async () => {
    if (!confirm(`Usunąć kategorię „${norm(curCat.name) || 'Bez nazwy'}” razem ze zdjęciami?`)) return;
    cats = cats.filter(c => c !== curCat);
    await DB.del('cats', curCat.id).catch(() => {});
    showView('main'); showTab('new');
  };
  $('#labClose').onclick = closeLabeler;
  $('#labPrev').onclick = () => labStep(-1);
  $('#labNext').onclick = () => labStep(1);
  $('#labDel').onclick = labDelete;
  $('#labInput').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); labStep(1); } };
  $('#fixCat').onchange = () => { try { localStorage.setItem('tfp.fixCat', $('#fixCat').value); } catch (e) {} $('#fixSearch').value = ''; renderFix(); };
  $('#fixSearch').oninput = renderFix;
  $('#fxClose').onclick = closeFixer;
  $('#fxFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; fixPick(f); };
  $('#fxUndo').onclick = fixUndo;
  $('#sendGo').onclick = send;
  $('#wipe').onclick = wipe;
  window.addEventListener('beforeunload', () => { if (curCat) persist(curCat); });
}

(async function init() {
  bind();
  try {
    cats = (await DB.all('cats')).sort((a, b) => a.created - b.created);
    for (const r of await DB.all('repl')) repl[r.key] = r;
  } catch (e) {
    console.error(e);
    toast('⚠️ Ta przeglądarka nie zapisuje danych (tryb prywatny?). Nie zamykaj karty przed wysłaniem.', 6000);
  }
  const n = getName();
  setName(n);
  if (!n) return showView('gate');
  showView('main');
  let tab = 'new'; try { tab = localStorage.getItem('tfp.tab') || 'new'; } catch (e) {}
  showTab(['new', 'fix', 'send'].includes(tab) ? tab : 'new');
})();
