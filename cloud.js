/* Wysyłka z panelu do chmury (Supabase): anonimowe konto na telefon, zdjęcia w storage, wiersze w tabelach. */
const Cloud = (() => {
  const cfg = window.FLOOR_CLOUD || {};
  let sb = null, uid = null;
  const enabled = () => !!(cfg.url && cfg.key && window.supabase);

  async function connect() {
    if (!sb) sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, storageKey: 'tfp.auth', autoRefreshToken: true } });
    const { data: { session } } = await sb.auth.getSession();
    if (session) { uid = session.user.id; return; }
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    uid = data.user.id;
  }
  const bucket = () => sb.storage.from('floor');
  async function upload(path, blob) {
    const { error } = await bucket().upload(path, blob, { upsert: true, contentType: 'image/jpeg', cacheControl: '31536000' });
    if (error) throw error;
  }
  async function removeUnused(folder, keep) {
    const { data, error } = await bucket().list(folder, { limit: 1000 });
    if (error || !data) return;
    const stale = data.map(f => `${folder}/${f.name}`).filter(p => !keep.has(p));
    for (let i = 0; i < stale.length; i += 100) await bucket().remove(stale.slice(i, i + 100));
  }
  const mine = p => typeof p === 'string' && p.startsWith(uid + '/');
  const check = ({ error }) => { if (error) throw error; };

  // wysyła wszystko, co się zmieniło; onStep(zrobione, wszystkie)
  async function sync({ cats, repl, deletedCats, author, onStep, persistCat, persistRepl }) {
    await connect();
    const todo = cats.reduce((s, c) => s + c.items.filter(i => !mine(i.path)).length, 0)
      + repl.filter(r => r.blob && !mine(r.path)).length;
    let done = 0;
    const step = () => onStep && onStep(++done, todo);

    for (const c of cats) {
      for (const it of c.items) {
        if (mine(it.path)) continue;
        const path = `${uid}/${c.id}/${it.id}.jpg`;
        await upload(path, it.blob);
        it.path = path;
        step();
      }
      await persistCat(c);   // zapamiętaj ścieżki – przerwana wysyłka nie zaczyna od zera
      check(await sb.from('cats').upsert({
        id: `${uid}:${c.id}`, author, name: c.name.trim(),
        items: c.items.map(i => ({ a: i.a.trim(), path: i.path })), updated_at: new Date().toISOString(),
      }));
      await removeUnused(`${uid}/${c.id}`, new Set(c.items.map(i => i.path)));
    }
    for (const id of deletedCats) {
      check(await sb.from('cats').delete().eq('id', `${uid}:${id}`));
      await removeUnused(`${uid}/${id}`, new Set());
    }
    // zmiany w istniejących kategoriach: jeden wiersz „@kategoria” na osobę, zestaw w chmurze = zestaw w telefonie
    const bySlug = new Map();
    for (const r of repl) {
      if (r.blob && !mine(r.path)) {
        const path = `${uid}/repl/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        await upload(path, r.blob);
        r.path = path;
        await persistRepl(r);
        step();
      }
      const na = String(r.na || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      let op;
      if (r.add) { if (!na || !r.path) continue; op = { add: 1, a: na, path: r.path }; }
      else {
        op = { orig: r.a };
        if (r.del) op.del = 1;
        else { if (na && na !== r.a) op.a = na; if (r.blob && r.path) op.path = r.path; }
        if (!op.del && !op.a && !op.path) continue;
      }
      if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
      bySlug.get(r.slug).push(op);
    }
    const keepOvl = new Set();
    for (const [slug, ops] of bySlug) {
      const id = `${uid}:@${slug}`;
      keepOvl.add(id);
      check(await sb.from('cats').upsert({ id, author, name: ('@' + slug).slice(0, 40), items: ops, updated_at: new Date().toISOString() }));
    }
    const { data: myRows, error: e1 } = await sb.from('cats').select('id').eq('owner', uid);
    if (!e1) {
      const gone = myRows.map(x => x.id).filter(id => id.includes(':@') && !keepOvl.has(id));
      if (gone.length) check(await sb.from('cats').delete().in('id', gone));
    }
    // stary format podmian (tabela repl) – przeniesione do wierszy „@”, więc sprzątamy
    const { data: oldRepl, error: e2 } = await sb.from('repl').select('id').eq('owner', uid);
    if (!e2 && oldRepl.length) check(await sb.from('repl').delete().in('id', oldRepl.map(x => x.id)));
    await removeUnused(`${uid}/repl`, new Set(repl.filter(r => r.blob).map(r => r.path)));
    return { uploaded: done };
  }

  return { enabled, sync };
})();
