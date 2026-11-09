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
      + repl.filter(r => !mine(r.path)).length;
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
    // podmiany zdjęć: zestaw w chmurze = zestaw w telefonie
    for (const r of repl) {
      if (!mine(r.path)) {
        const path = `${uid}/repl/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        await upload(path, r.blob);
        r.path = path;
        await persistRepl(r);
        step();
      }
      check(await sb.from('repl').upsert({
        id: `${uid}|${r.slug}|${r.a}`, author, slug: r.slug, a: r.a, path: r.path, updated_at: new Date().toISOString(),
      }));
    }
    const { data: remoteRepl, error } = await sb.from('repl').select('id').eq('owner', uid);
    if (!error) {
      const keepIds = new Set(repl.map(r => `${uid}|${r.slug}|${r.a}`));
      const gone = remoteRepl.map(x => x.id).filter(id => !keepIds.has(id));
      if (gone.length) check(await sb.from('repl').delete().in('id', gone));
    }
    await removeUnused(`${uid}/repl`, new Set(repl.map(r => r.path)));
    return { uploaded: done };
  }

  return { enabled, sync };
})();
