// Bound decoded response bytes, including chunked and compressed transfers.
export async function readProviderJson(url, {fetchImplementation = globalThis.fetch, signal,
  maxBytes = 2 * 1024 * 1024, label = "Metadata"} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error("Invalid provider response limit");
  const tooLarge = () => Object.assign(new Error(`${label} exceeds ${Number((maxBytes / 1024 / 1024).toFixed(2))} MB`), {code: "provider_response_too_large"});
  const response = await fetchImplementation(url, {signal, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store"});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) {await response.body?.cancel(); throw tooLarge();}
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      chunks.push(value);
    }
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) {buffer.set(chunk, offset); offset += chunk.byteLength;}
  const text = new TextDecoder("utf-8", {ignoreBOM: true}).decode(buffer);
  const data = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!data || typeof data !== "object" || Array.isArray(data) || data.error) throw new Error(`Provider did not return valid ${label.toLowerCase()}`);
  return {data, bytes, text, contentType: response.headers.get("content-type") || "application/json", retrievedAt: new Date().toISOString()};
}
