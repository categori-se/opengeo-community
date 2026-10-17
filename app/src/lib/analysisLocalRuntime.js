// The local development bridge is deliberately confined to the current
// loopback origin. Creating this adapter performs no requests or provisioning.
export function createLocalAnalysisRuntime({location = globalThis.location, fetch = globalThis.fetch} = {}) {
  const available = location?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  const unavailable = () => ({configured: false, languages: []});
  async function request(path, {body, signal, timeout = 5000} = {}) {
    if (!available) throw Error('Open the local development workspace to use a Local execution profile.');
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(new URL(path, location.origin), {method: body === undefined ? 'GET' : 'POST',
        credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
        ...(body === undefined ? {} : {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})});
      const reader = response.body?.getReader();let size = 0, text = '';
      const decoder = new TextDecoder('utf-8', {fatal: true});
      if (!reader) throw Error('Execution profile returned an empty response.');
      while (true) {
        const {done, value} = await reader.read();if (done) break;
        size += value.byteLength;
        if (size > 10 * 1024 ** 2) {await reader.cancel();throw Error('Execution response exceeds the console limit.');}
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
      if (!response.ok) throw Error(response.status === 404 ? 'Local execution is not configured.' : 'Local execution could not complete.');
      return JSON.parse(text);
    } finally {clearTimeout(timer);signal?.removeEventListener('abort', abort);}
  }
  return {
    async getNativeCapabilities() {
      if (!available) return unavailable();
      try {
        const value = await request('/__local/analysis/capabilities');
        return {configured: value?.enabled === true && !value.cleanupRequired,
          languages: (value?.languages ?? []).filter(item => item?.configured).map(item => item.language)};
      } catch {return unavailable();}
    },
    runNative({language, code, layers, signal}) {
      return request('/__local/analysis/run', {body: {language, code, layers}, signal, timeout: 40_000});
    }
  };
}
