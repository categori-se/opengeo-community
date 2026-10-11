import {chromium} from "playwright";
import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";
const app = new URL("../", import.meta.url);
const worker = await readFile(new URL("dist/archive-runtime/hash-worker.js", app), "utf8");
const client = await readFile(new URL("src/lib/archiveHashClient.js", app), "utf8");
const browser = await chromium.launch({headless: true, executablePath: "/usr/bin/chromium-browser"});
let rejectedRequests = 0;
try {
  const page = await browser.newPage();
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === "https://studio.opengeo.tools") {
      if (url.pathname === "/_local-check/hash") return route.fulfill({contentType: "text/html", body: "<!doctype html><title>Archive hashing check</title>"});
      if (url.pathname === "/_local-check/hash-client.js") return route.fulfill({contentType: "text/javascript", body: client});
      if (url.pathname === "/archive-runtime/hash-worker.js") return route.fulfill({contentType: "text/javascript", body: worker});
    }
    rejectedRequests++;
    return route.abort();
  });
  await page.goto("https://studio.opengeo.tools/_local-check/hash");
  const result = await page.evaluate(async () => {
    const {hashArchiveFileInWorker} = await import("/_local-check/hash-client.js");
    const bytes = new Uint8Array(9 * 1024 * 1024 + 17).fill(0xa5);
    const file = new File([bytes], "original.geojson");
    const progress = [];
    const sha256 = await hashArchiveFileInWorker(file, {onProgress: value => progress.push(value.hashedBytes)});
    const controller = new AbortController();
    let cancelled = false;
    try {
      await hashArchiveFileInWorker(file, {signal: controller.signal, onProgress: () => controller.abort()});
    } catch (error) {cancelled = error.name === "AbortError";}
    return {sha256, progress, cancelled, bytes: file.size};
  });
  const expected = createHash("sha256").update(Buffer.alloc(result.bytes, 0xa5)).digest("hex");
  if (result.sha256 !== expected || !result.cancelled || result.progress.length !== 3
    || result.progress.at(-1) !== result.bytes || rejectedRequests) throw Error("Archive worker acceptance failed");
  const receipt = {status: "passed", checkedAt: new Date().toISOString(), ...result,
    workerSha256: createHash("sha256").update(worker).digest("hex"), externalRequests: 0,
    scope: "Actual built worker in Chromium; bounded hashing and cancellation, not the full uploader or deployment"};
  await writeFile(new URL("../.local-archives/bhutan-local-20260920/archive-hash-browser.json", app), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt));
} finally {await browser.close();}
