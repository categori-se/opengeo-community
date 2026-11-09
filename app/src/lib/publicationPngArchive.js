import {Zip, ZipPassThrough, strToU8} from "fflate";
import {sha256} from "@noble/hashes/sha2.js";

export const PUBLICATION_PNG_ARCHIVE_LIMITS = Object.freeze({pages: 64, pageBytes: 64 * 1024 * 1024,
  pagePixels: 20_000_000, zipBytes: 3 * 1024 * 1024 * 1024, pageMilliseconds: 45_000,
  totalMilliseconds: 60 * 60 * 1000});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMPTY = new Uint8Array();
const failure = (code) => Object.assign(new Error(code), {code});
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function validatePublicationPngPlan(plan, {baseUrl = globalThis.location?.href ?? "https://localhost/"} = {}) {
  if (!exact(plan, ["schemaVersion", "organizationId", "projectId", "editionId", "editionNumber",
    "manifestChecksumSha256", "filename", "pages"]) || plan.schemaVersion !== "opengeo.publication-png-archive.1"
    || ![plan.organizationId, plan.projectId, plan.editionId].every(id => typeof id === "string" && UUID.test(id))
    || !Number.isSafeInteger(plan.editionNumber) || plan.editionNumber < 1
    || typeof plan.manifestChecksumSha256 !== "string" || !HASH.test(plan.manifestChecksumSha256)
    || typeof plan.filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,175}\.zip$/.test(plan.filename)
    || plan.filename.includes("..") || !Array.isArray(plan.pages) || !plan.pages.length
    || plan.pages.length > PUBLICATION_PNG_ARCHIVE_LIMITS.pages) throw failure("publication_png_plan_invalid");
  let base;
  try { base = new URL(baseUrl); } catch { throw failure("publication_png_url_invalid"); }
  const slugs = new Set();
  const pages = plan.pages.map(page => {
    if (!exact(page, ["slug", "label", "url"]) || typeof page.slug !== "string" || page.slug.length > 128
      || !SLUG.test(page.slug) || slugs.has(page.slug) || typeof page.label !== "string" || !page.label.trim()
      || page.label.length > 512 || /[\u0000-\u001f\u007f]/.test(page.label) || typeof page.url !== "string"
      || /[\s\\%]/.test(page.url) || /(?:^|\/)\.\.?(?:\/|$)/.test(page.url)) throw failure("publication_png_page_invalid");
    slugs.add(page.slug);
    let url;
    try { url = new URL(page.url, base); } catch { throw failure("publication_png_url_invalid"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const path = `/public/organizations/${plan.organizationId}/projects/${plan.projectId}/site-editions/${plan.editionId}/print/pages/${page.slug}.png`;
    if (url.username || url.password || url.search || url.hash || ![path, `/api${path}`].includes(url.pathname)
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback && url.origin === base.origin))) {
      throw failure("publication_png_url_invalid");
    }
    return Object.freeze({slug: page.slug, label: page.label, url: url.href});
  });
  return Object.freeze({...plan, pages: Object.freeze(pages)});
}

const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc, bytes) {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
const u32 = (bytes, offset = 0) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);

// Inspect chunk framing/CRC as bytes arrive, retaining only the PNG header and
// one chunk's bookkeeping. Pixel decoding belongs to the existing PNG renderer.
class PngInspector {
  signature = 0; header = new Uint8Array(8); headerSize = 0; remaining = null;
  crcBytes = new Uint8Array(4); crcSize = 0; chunks = 0; idat = false; ended = false;
  consume(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    let offset = 0;
    while (offset < bytes.length) {
      if (this.ended) throw failure("publication_png_trailing_bytes");
      if (this.signature < 8) {
        if (bytes[offset++] !== signature[this.signature++]) throw failure("publication_png_signature_invalid");
      } else if (this.remaining === null) {
        const count = Math.min(8 - this.headerSize, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + count), this.headerSize); this.headerSize += count; offset += count;
        if (this.headerSize !== 8) continue;
        this.length = this.remaining = u32(this.header);
        this.type = String.fromCharCode(...this.header.subarray(4));
        if (!/^[A-Za-z]{4}$/.test(this.type) || this.length > PUBLICATION_PNG_ARCHIVE_LIMITS.pageBytes
          || (!this.chunks && (this.type !== "IHDR" || this.length !== 13))
          || (this.chunks && this.type === "IHDR") || (this.type === "IEND" && this.length !== 0)) {
          throw failure("publication_png_chunk_invalid");
        }
        this.crc = crcUpdate(0xffffffff, this.header.subarray(4));
        if (this.type === "IHDR") this.ihdr = new Uint8Array(13);
        if (this.type === "IDAT") this.idat = true;
      } else if (this.remaining) {
        const count = Math.min(this.remaining, bytes.length - offset), part = bytes.subarray(offset, offset + count);
        if (this.type === "IHDR") this.ihdr.set(part, this.length - this.remaining);
        this.crc = crcUpdate(this.crc, part); this.remaining -= count; offset += count;
      } else {
        const count = Math.min(4 - this.crcSize, bytes.length - offset);
        this.crcBytes.set(bytes.subarray(offset, offset + count), this.crcSize); this.crcSize += count; offset += count;
        if (this.crcSize !== 4) continue;
        if (u32(this.crcBytes) !== ((this.crc ^ 0xffffffff) >>> 0)) throw failure("publication_png_crc_invalid");
        if (this.type === "IHDR") {
          const width = u32(this.ihdr), height = u32(this.ihdr, 4);
          const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
          if (!width || !height || width > 20_000_000 || height > 20_000_000
            || width * height > PUBLICATION_PNG_ARCHIVE_LIMITS.pagePixels
            || !depths[this.ihdr[9]]?.includes(this.ihdr[8]) || this.ihdr[10] || this.ihdr[11] || this.ihdr[12] > 1) {
            throw failure("publication_png_dimensions_invalid");
          }
          this.width = width; this.height = height;
        }
        if (this.type === "IEND") {
          if (!this.idat) throw failure("publication_png_data_missing");
          this.ended = true;
        }
        this.chunks++; this.remaining = null; this.headerSize = 0; this.crcSize = 0;
      }
    }
  }
  finish() { if (!this.ended) throw failure("publication_png_truncated"); }
}

function serverChecksums(headers) {
  const declared = [];
  for (const name of ["X-OpenGeo-Checksum-SHA256", "X-Checksum-SHA256", "X-Content-SHA256"]) {
    const value = headers.get(name);
    if (value !== null) {
      if (!HASH.test(value.toLowerCase())) throw failure("publication_png_server_checksum_invalid");
      declared.push({header: name, sha256: value.toLowerCase()});
    }
  }
  for (const name of ["Digest", "Content-Digest"]) {
    const value = headers.get(name);
    if (value === null) continue;
    const match = /(?:^|,)\s*sha-256\s*=\s*(:?)([A-Za-z0-9+/]{43}=)\1\s*(?:,|$)/i.exec(value);
    if (!match) {
      if (/sha-256\s*=/i.test(value)) throw failure("publication_png_server_checksum_invalid");
      continue; // Other digest algorithms make no SHA-256 claim.
    }
    let raw;
    try { raw = atob(match[2]); } catch { throw failure("publication_png_server_checksum_invalid"); }
    if (raw.length !== 32) throw failure("publication_png_server_checksum_invalid");
    declared.push({header: name, sha256: [...raw].map(char => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")});
  }
  return declared;
}

export function publicationPngZipStream(input, {signal, fetch: fetchImpl = globalThis.fetch, onProgress = () => {}} = {}) {
  const plan = validatePublicationPngPlan(input);
  if (typeof fetchImpl !== "function" || typeof onProgress !== "function") throw failure("publication_png_options_invalid");
  const abort = new AbortController();
  let reader, controller, totalTimer, pageTimer, finished = false, iterator;
  const cleanup = () => { clearTimeout(totalTimer); clearTimeout(pageTimer); signal?.removeEventListener("abort", externalAbort); };
  const stop = reason => {
    if (finished) return;
    finished = true; abort.abort(reason); cleanup();
    if (reader) void reader.cancel(reason).catch(() => {});
    if (iterator) void iterator.return().catch(() => {});
  };
  const fail = reason => { if (finished) return; stop(reason); controller.error(reason); };
  const externalAbort = () => fail(signal.reason ?? new DOMException("Aborted", "AbortError"));
  const guard = () => { if (abort.signal.aborted) throw abort.signal.reason; };
  async function* archive() {
    const pending = []; let zipBytes = 0;
    const zip = new Zip((error, bytes) => {
      if (error) throw error;
      zipBytes += bytes.length;
      if (zipBytes > PUBLICATION_PNG_ARCHIVE_LIMITS.zipBytes) throw failure("publication_png_zip_limit");
      if (bytes.length) pending.push(bytes);
    });
    const entry = name => {
      const file = new ZipPassThrough(name);
      file.mtime = new Date(1980, 0, 1, 0, 0, 0); // fflate encodes local DOS fields.
      zip.add(file); return file;
    };
    const pages = [];
    try {
      for (const page of plan.pages) {
        guard();
        pageTimer = setTimeout(() => fail(failure("publication_png_page_timeout")), PUBLICATION_PNG_ARCHIVE_LIMITS.pageMilliseconds);
        const response = await fetchImpl(page.url, {signal: abort.signal, credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer"});
        guard();
        if (!response.ok || response.redirected || (response.url && response.url !== page.url)) throw failure("publication_png_response_invalid");
        if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "image/png"
          || !response.body?.getReader) throw failure("publication_png_content_type_invalid");
        const contentLength = response.headers.get("Content-Length");
        if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > PUBLICATION_PNG_ARCHIVE_LIMITS.pageBytes)) {
          throw failure("publication_png_page_limit");
        }
        const declared = serverChecksums(response.headers), png = new PngInspector(), hash = sha256.create();
        const path = `pages/${String(pages.length + 1).padStart(3, "0")}-${page.slug}.png`;
        let sizeBytes = 0, file;
        reader = response.body.getReader();
        try {
          while (true) {
            guard();
            const {done, value} = await reader.read(); guard();
            if (done) break;
            if (!(value instanceof Uint8Array)) throw failure("publication_png_body_invalid");
            sizeBytes += value.length;
            if (sizeBytes > PUBLICATION_PNG_ARCHIVE_LIMITS.pageBytes) throw failure("publication_png_page_limit");
            for (let offset = 0; offset < value.length; offset += 65_536) {
              guard();
              const chunk = value.subarray(offset, Math.min(value.length, offset + 65_536));
              png.consume(chunk); hash.update(chunk);
              if (!file) file = entry(path);
              file.push(chunk, false);
              while (pending.length) { guard(); yield pending.shift(); }
            }
          }
          png.finish();
          if (contentLength !== null && sizeBytes !== Number(contentLength)) throw failure("publication_png_content_length_mismatch");
          const checksumSha256 = [...hash.digest()].map(byte => byte.toString(16).padStart(2, "0")).join("");
          if (declared.some(check => check.sha256 !== checksumSha256)) throw failure("publication_png_checksum_mismatch");
          file.push(EMPTY, true);
          pages.push({slug: page.slug, label: page.label, url: page.url, path, sizeBytes, width: png.width, height: png.height,
            checksumSha256, serverChecksum: declared.length ? {status: "verified", headers: declared.map(check => check.header)}
              : {status: "not-exposed", note: "SHA-256 computed locally; no readable server SHA-256 was supplied."}});
          clearTimeout(pageTimer); pageTimer = undefined;
          onProgress({completedPages: pages.length, totalPages: plan.pages.length, slug: page.slug});
          while (pending.length) { guard(); yield pending.shift(); }
        } finally {
          hash.destroy();
          await reader.cancel().catch(() => {}); reader.releaseLock(); reader = undefined;
        }
      }
      const manifest = {schemaVersion: plan.schemaVersion, organizationId: plan.organizationId, projectId: plan.projectId,
        editionId: plan.editionId, editionNumber: plan.editionNumber, manifestChecksumSha256: plan.manifestChecksumSha256,
        filename: plan.filename, pages};
      const manifestBytes = strToU8(JSON.stringify(manifest, null, 2) + "\n");
      const manifestHash = [...sha256(manifestBytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      for (const [name, bytes] of [["manifest.json", manifestBytes], ["checksums.sha256", strToU8(
        pages.map(page => `${page.checksumSha256}  ${page.path}\n`).join("") + `${manifestHash}  manifest.json\n`)]]) {
        guard(); const file = entry(name); file.push(bytes, true);
        while (pending.length) { guard(); yield pending.shift(); }
      }
      zip.end();
      while (pending.length) { guard(); yield pending.shift(); }
    } finally { zip.terminate(); }
  }
  return new ReadableStream({
    start(value) {
      controller = value;
      signal?.addEventListener("abort", externalAbort, {once: true});
      if (signal?.aborted) externalAbort();
      iterator = archive();
    },
    async pull() {
      if (finished) return;
      totalTimer ??= setTimeout(() => fail(failure("publication_png_total_timeout")), PUBLICATION_PNG_ARCHIVE_LIMITS.totalMilliseconds);
      try {
        const item = await iterator.next();
        if (finished) return;
        if (item.done) { finished = true; cleanup(); controller.close(); }
        else controller.enqueue(item.value);
      } catch (error) { fail(error); }
    },
    cancel(reason) { stop(reason ?? new DOMException("Cancelled", "AbortError")); }
  }, {highWaterMark: 0});
}
