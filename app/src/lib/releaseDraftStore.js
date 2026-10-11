const PREFIX = 'opengeo.release-draft.v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TTL = 24 * 60 * 60 * 1000;
const validDraft = draft => draft && UUID.test(draft.creation_key) && Number.isSafeInteger(draft.version_number)
  && draft.version_number > 0 && typeof draft.title === 'string' && draft.title.length <= 200
  && typeof draft.attribution === 'string' && draft.attribution.length <= 2000
  && ['', 'CC0-1.0', 'CC-BY-4.0', 'PDDL-1.0'].includes(draft.license);

export async function openReleaseDraftStore(adapter, browser, artifactId) {
  if (!UUID.test(artifactId) || !adapter.getSession || !adapter.organizationProvider) return null;
  const account = await adapter.organizationProvider();
  const session = await adapter.getSession({signal: AbortSignal.timeout(15000)});
  if (!UUID.test(session.userId) || !UUID.test(account)
      || !session.memberships.some(item => item.organizationId === account)
      || await adapter.organizationProvider() !== account) return null;
  const scope = PREFIX + JSON.stringify([new URL(adapter.baseUrl || '/', browser.location.href).href, session.userId, account]);
  const key = scope + ':' + artifactId;
  const storage = browser.sessionStorage;
  return {
    async verify() {
      const current = await adapter.getSession({signal: AbortSignal.timeout(15000)});
      return current.userId === session.userId && await adapter.organizationProvider() === account
        && current.memberships.some(item => item.organizationId === account);
    },
    read() {
      try {
        const raw = storage.getItem(key); if (!raw) return null;
        if (raw.length > 20000) {storage.removeItem(key); return null;}
        const record = JSON.parse(raw);
        if (record.artifactId !== artifactId || !validDraft(record.draft) || typeof record.submitted !== 'boolean'
            || !Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now() || record.expiresAt > Date.now() + TTL) {
          storage.removeItem(key); return null;
        }
        return record;
      } catch {return null;}
    },
    write(draft, submitted) {
      if (!validDraft(draft)) return false;
      try {
        // Bound drafts in this verified user/account/API scope; never evict another active draft.
        const keys = Array.from({length:storage.length},(_,index)=>storage.key(index)).filter(item=>item?.startsWith(scope+':'));
        for (const item of keys) {
          try {if (JSON.parse(storage.getItem(item)).expiresAt <= Date.now()) storage.removeItem(item);} catch {storage.removeItem(item);}
        }
        if (!storage.getItem(key) && keys.filter(item=>storage.getItem(item)).length >= 16) return false;
        storage.setItem(key, JSON.stringify({artifactId, draft, submitted, expiresAt:Date.now()+TTL}));
        return true;
      } catch {return false;}
    },
    clear() {try {storage.removeItem(key); return true;} catch {return false;}}
  };
}
