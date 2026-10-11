import {sha256} from "@noble/hashes/sha2.js";

export const ARCHIVE_HASH_CHUNK_BYTES = 4 * 1024 * 1024;

// Run in a dedicated worker: only one bounded slice is materialized at a time.
export async function hashArchiveFile(file, {signal, onProgress = () => {}} = {}) {
  if (!Number.isSafeInteger(file?.size) || file.size < 0 || typeof file.slice !== "function") {
    throw new Error("archive_file_invalid");
  }
  const hash = sha256.create();
  try {
    signal?.throwIfAborted();
    for (let offset = 0; offset < file.size; offset += ARCHIVE_HASH_CHUNK_BYTES) {
      signal?.throwIfAborted();
      const end = Math.min(offset + ARCHIVE_HASH_CHUNK_BYTES, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      signal?.throwIfAborted();
      if (bytes.length !== end - offset) throw new Error("archive_file_changed");
      hash.update(bytes);
      onProgress({hashedBytes: end, totalBytes: file.size});
    }
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    hash.destroy();
  }
}
