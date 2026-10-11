import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {deflateSync} from "node:zlib";

import {snapshotTree} from "./release-utils.mjs";

const SHELL_CACHE_PREFIX = "opengeo-studio-shell-";
const SHELL_LIMIT_BYTES = 16 * 1024 * 1024;
const SHELL_FILE_LIMIT_BYTES = 2 * 1024 * 1024;

export async function writeStudioPwaAssets({
  outputRoot,
  applicationId,
  name,
  shortName = "OpenGeo Studio",
  description,
  startUrl = "/",
  routes = ["/"]
}) {
  const normalizedRoutes = routes.map(routePath);
  if (!normalizedRoutes.includes(routePath(startUrl))) {
    throw new Error("PWA start URL must be one of the sealed application routes");
  }
  const manifest = {
    id: "/",
    name: requiredText(name, "PWA name", 80),
    short_name: requiredText(shortName, "PWA short name", 20),
    description: requiredText(description, "PWA description", 160),
    start_url: routePath(startUrl),
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#111827",
    theme_color: "#4f8cff",
    categories: ["productivity", "utilities"],
    icons: [
      {src: "/icons/opengeo-192.png", sizes: "192x192", type: "image/png", purpose: "any"},
      {src: "/icons/opengeo-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable"}
    ]
  };
  await Promise.all([
    writeText(resolve(outputRoot, "manifest.webmanifest"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeText(resolve(outputRoot, "offline.html"), offlineHtml({name: manifest.name})),
    writeBinary(resolve(outputRoot, "icons/opengeo-192.png"), openGeoIconPng(192)),
    writeBinary(resolve(outputRoot, "icons/opengeo-512.png"), openGeoIconPng(512))
  ]);

  const beforeWorker = await snapshotTree(outputRoot);
  const shellFiles = beforeWorker.files.filter(({path, bytes}) => {
    if (!isCredentialFreeShellPath(path)) return false;
    if (bytes > SHELL_FILE_LIMIT_BYTES) {
      throw new Error(`PWA shell artifact exceeds the per-file bound: ${path}`);
    }
    return true;
  });
  const shellBytes = shellFiles.reduce((sum, {bytes}) => sum + bytes, 0);
  if (shellBytes > SHELL_LIMIT_BYTES) {
    throw new Error(`PWA shell exceeds the ${SHELL_LIMIT_BYTES}-byte cache bound`);
  }
  const precacheUrls = [...new Set([
    ...normalizedRoutes,
    "/offline.html",
    "/manifest.webmanifest",
    "/icons/opengeo-192.png",
    "/icons/opengeo-512.png",
    ...shellFiles.map(({path}) => `/${path}`)
  ])].sort();
  const version = createHash("sha256")
    .update(requiredText(applicationId, "PWA application id", 80))
    .update("\0")
    .update(beforeWorker.digest)
    .update("\0")
    .update(JSON.stringify(precacheUrls))
    .digest("hex")
    .slice(0, 20);
  await writeText(
    resolve(outputRoot, "service-worker.js"),
    serviceWorkerSource({applicationId, version, precacheUrls, routes: normalizedRoutes})
  );
  return {
    applicationId,
    cacheName: `${SHELL_CACHE_PREFIX}${applicationId}-${version}`,
    manifest,
    precacheUrls,
    shellBytes
  };
}

export function isCredentialFreeShellPath(path) {
  if (/^_file\/assets\/cog-reader-/.test(path)) return false;
  // Public index/raster readers remain optional at installation as well as import.
  if (/^_(?:node|npm)\/(?:hyparquet|hyparquet-compressors|hysnappy|fzstd|geotiff|proj4|mgrs|wkt-parser)@/.test(path)) return false;
  // Native expression evaluation is loaded only after selecting Cesium. Keep
  // its standalone parser out of installation-time downloads as well.
  if (/^_(?:node|npm)\/@maplibre\/maplibre-gl-style-spec@/.test(path)
    || /^_import\/lib\/cesiumStyle\.[A-Za-z0-9_-]+\.js$/.test(path)) return false;
  return path === "manifest.webmanifest"
    || path === "offline.html"
    || /^icons\/opengeo-(?:192|512)\.png$/.test(path)
    || /^_observablehq\//.test(path)
    || /^_import\//.test(path)
    || /^_node\//.test(path)
    || /^_npm\//.test(path)
    || /^_file\/style\.[A-Za-z0-9_-]+\.css$/.test(path)
    || /^_file\/fonts\//.test(path);
}

function serviceWorkerSource({applicationId, version, precacheUrls, routes}) {
  const cacheName = `${SHELL_CACHE_PREFIX}${applicationId}-${version}`;
  return `/* Generated from a sealed OpenGeo Studio build. Do not edit the release artifact. */
const CACHE_PREFIX = ${JSON.stringify(`${SHELL_CACHE_PREFIX}${applicationId}-`)};
const CACHE_NAME = ${JSON.stringify(cacheName)};
const CAPTURE_SYNC_TAG = "opengeo-field-capture-v1";
const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};
const SHELL_ROUTES = new Set(${JSON.stringify(routes)});

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!safeGet(request, url)) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request, url));
    return;
  }
  if (staticShellPath(url.pathname)) event.respondWith(cacheFirst(request));
});

self.addEventListener("sync", (event) => {
  if (event.tag === CAPTURE_SYNC_TAG) event.waitUntil(notifyCaptureClients("background-sync"));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "opengeo:capture-sync-request" && event.data?.version === 1) {
    event.waitUntil(notifyCaptureClients("client-request"));
  }
});

function safeGet(request, url) {
  if (request.method !== "GET" || url.origin !== self.location.origin) return false;
  if (request.headers.has("authorization") || (url.search && request.mode !== "navigate")) return false;
  return !url.pathname.startsWith("/api/")
    && url.pathname !== "/auth-config.json"
    && url.pathname !== "/runtime-auth-config.json"
    && !url.pathname.startsWith("/.well-known/");
}

async function networkFirstNavigation(request, url) {
  try {
    const response = await fetch(request);
    if (!response.ok) throw new Error("navigation response was not successful");
    if (!url.search && SHELL_ROUTES.has(url.pathname)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(url.pathname, response.clone());
    }
    return response;
  } catch {
    return await caches.match(url.pathname) ?? await caches.match("/offline.html");
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type !== "opaque") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

function staticShellPath(pathname) {
  return pathname === "/manifest.webmanifest"
    || pathname === "/offline.html"
    || /^\\/icons\\/opengeo-(?:192|512)\\.png$/.test(pathname)
    || /^\\\/(?:_observablehq|_import|_node|_npm)\\\//.test(pathname)
    || /^\\\/_file\\\/style\\.[A-Za-z0-9_-]+\\.css$/.test(pathname)
    || /^\\\/_file\\\/fonts\\\//.test(pathname);
}

async function notifyCaptureClients(reason) {
  const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true});
  for (const client of clients) {
    client.postMessage({type: "opengeo:capture-sync-request", version: 1, reason});
  }
}
`;
}

function offlineHtml({name}) {
  const title = escapeHtml(name);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#4f8cff"><title>${title} · Offline</title>
<style>html{color-scheme:dark;background:#111827;color:#f3f4f6;font:16px/1.5 system-ui,sans-serif}body{margin:0;display:grid;min-height:100vh;place-items:center}main{max-width:36rem;padding:2rem}a{color:#82b0ff}</style></head>
<body><main><h1>You’re offline</h1><p>The sealed ${title} shell is installed, but this page was not cached. Reconnect to load managed data. Field observations already saved on this device remain queued without an access token.</p><p><a href="/">Return to OpenGeo Studio</a></p></main></body></html>
`;
}

function openGeoIconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const center = (size - 1) / 2;
  const outer = size * 0.31;
  const inner = size * 0.13;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const distance = Math.abs(x - center) + Math.abs(y - center);
      const color = distance <= inner
        ? [17, 24, 39]
        : distance <= outer
          ? [79, 140, 255]
          : [17, 24, 39];
      raw[offset] = color[0];
      raw[offset + 1] = color[1];
      raw[offset + 2] = color[2];
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, {level: 9})),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function writeText(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, value, "utf8");
}

async function writeBinary(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, value);
}

function routePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("?")
    || value.includes("#") || value.includes("\\") || value.includes("..")) {
    throw new Error(`Unsafe PWA route: ${value}`);
  }
  return value === "/" ? value : value.replace(/\/$/, "");
}

function requiredText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
