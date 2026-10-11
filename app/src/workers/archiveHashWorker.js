import {hashArchiveFile} from "../lib/archiveFileHash.js";

// One file per worker. The owner terminates on abort/error/completion; cancellation
// cannot leave a hashing task running or let a late result enter a new account.
let started = false;
self.onmessage = async ({data}) => {
  if (started) return;
  started = true;
  try {
    const sha256 = await hashArchiveFile(data.file, {
      onProgress: (progress) => self.postMessage({type: "progress", ...progress})
    });
    self.postMessage({type: "complete", sha256});
  } catch {
    self.postMessage({type: "error", code: "archive_hash_failed"});
  }
};
