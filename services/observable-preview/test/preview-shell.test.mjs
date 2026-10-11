import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  capabilityFromHash,
  exchangeCapability,
  parseExchange
} from "../authorize/preview-shell.js";

const CAPABILITY = "A".repeat(160);
const ENTRY =
  "/organizations/10000000-0000-4000-8000-000000000459/" +
  "projects/50000000-0000-4000-8000-000000000459/" +
  "source-projects/b0000000-0000-4000-8000-000000000459/" +
  "builds/e0000000-0000-4000-8000-000000000459/output/index.html";

describe("private Observable preview bootstrap", () => {
  it("accepts only one bounded URL-fragment capability", () => {
    assert.equal(capabilityFromHash(`#cap=${CAPABILITY}`), CAPABILITY);
    for (const hash of ["", "#token=" + CAPABILITY, "#cap=short", `#cap=${CAPABILITY}&x=1`]) {
      assert.throws(() => capabilityFromHash(hash), /preview_capability/);
    }
  });

  it("posts the capability only in a no-store same-origin body", async () => {
    let observed;
    const result = await exchangeCapability(CAPABILITY, async (url, options) => {
      observed = {url, options};
      return {
        ok: true,
        async json() {
          return {
            entry_path: ENTRY,
            expires_at: "2026-08-22T20:15:00Z",
            publication_authorized: false
          };
        }
      };
    });
    assert.equal(result.entryPath, ENTRY);
    assert.equal(observed.url, "/observable-preview/exchange");
    assert.deepEqual(observed.options, {
      method: "POST",
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({capability: CAPABILITY})
    });
    assert.equal(observed.url.includes(CAPABILITY), false);
  });

  it("rejects storage widening, publication authority, and traversal in exchange data", () => {
    const valid = {
      entry_path: ENTRY,
      expires_at: "2026-08-22T20:15:00Z",
      publication_authorized: false
    };
    assert.deepEqual(parseExchange(valid), {
      entryPath: ENTRY,
      expiresAt: valid.expires_at
    });
    for (const invalid of [
      {...valid, bucket: "source.opengeo.tools"},
      {...valid, publication_authorized: true},
      {...valid, entry_path: ENTRY.replace("index.html", "../secret.html")},
      {...valid, entry_path: ENTRY.replace("index.html", "nested//index.html")},
      {...valid, entry_path: ENTRY.replace("index.html", ".hidden/index.html")},
      {...valid, entry_path: ENTRY.replace("10000000", "------------------------------------")},
      {...valid, entry_path: "https://opengeo.tools/index.html"}
    ]) assert.throws(() => parseExchange(invalid), /preview_exchange_invalid/);
  });
});
