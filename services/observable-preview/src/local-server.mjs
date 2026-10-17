/** Separate-origin, signed-cookie delivery for the existing retained local developer profile. */
import {createHash, createPublicKey, verify} from "node:crypto";
import {constants, closeSync, fstatSync, lstatSync, openSync, readFileSync} from "node:fs";
import {createServer} from "node:http";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseExchange} from "../authorize/preview-shell.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PREFIX = new RegExp(`^/organizations/${UUID}/projects/${UUID}/source-projects/${UUID}/builds/${UUID}/output/`);
const VERSION = new RegExp(`^${UUID}$`);
const COOKIE_NAMES = ["CloudFront-Policy", "CloudFront-Signature", "CloudFront-Key-Pair-Id"];
const SHELL = fileURLToPath(new URL("../authorize/", import.meta.url));
const MAX_OBJECT_BYTES = 96 * 1024 * 1024;
function requireValue(condition) {if (!condition) throw new Error("local_preview_denied");}
function exactKeys(value, keys) {return value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));}
function loopbackOrigin(value) {
  const url = new URL(value);
  requireValue(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
    && url.origin === value && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash);
  return url;
}
function safeOutputPath(path) {
  const prefix = PREFIX.exec(path)?.[0];
  requireValue(prefix);
  const names = path.slice(prefix.length).split("/");
  requireValue(path.length <= 1024 && names.length <= 8 && names.every(name =>
    /^[A-Za-z0-9_@][A-Za-z0-9._@-]{0,99}$/.test(name)
    && !/^(?:node_modules|dist|build|cache|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|.+\.(?:pem|key|p12|pfx))$/i.test(name)));
  return prefix;
}
function readRegular(path, maximum) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {const stat = fstatSync(fd);requireValue(stat.isFile() && stat.size > 0 && stat.size <= maximum);return readFileSync(fd);}
  finally {closeSync(fd);}
}
function cloudfrontBytes(value, maximum) {
  requireValue(typeof value === "string" && value.length <= maximum && /^[A-Za-z0-9_~-]+$/.test(value));
  const bytes = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "=").replaceAll("~", "/"), "base64");
  requireValue(bytes.toString("base64").replaceAll("+", "-").replaceAll("=", "_").replaceAll("/", "~") === value);
  return bytes;
}
export function verifyLocalPreviewCookies(header, {origin, keyPairId, publicKey, path, now = Date.now()}) {
  requireValue(typeof header === "string" && header.length <= 8192);
  const cookies = new Map();
  for (const part of header.split(";")) {
    const match = /^\s*([^=;\s]+)=([^;\s]+)\s*$/.exec(part);
    requireValue(match && COOKIE_NAMES.includes(match[1]) && !cookies.has(match[1]));cookies.set(match[1], match[2]);
  }
  requireValue(cookies.size === 3 && cookies.get("CloudFront-Key-Pair-Id") === keyPairId);
  const policyBytes = cloudfrontBytes(cookies.get("CloudFront-Policy"), 4096);
  const signature = cloudfrontBytes(cookies.get("CloudFront-Signature"), 2048);
  requireValue(verify("RSA-SHA1", policyBytes, publicKey, signature));
  const policy = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(policyBytes));
  requireValue(exactKeys(policy, ["Statement"]) && Array.isArray(policy.Statement) && policy.Statement.length === 1);
  const statement = policy.Statement[0];
  requireValue(exactKeys(statement, ["Resource", "Condition"]) && exactKeys(statement.Condition, ["DateLessThan"])
    && exactKeys(statement.Condition.DateLessThan, ["AWS:EpochTime"]));
  const expiry = statement.Condition.DateLessThan["AWS:EpochTime"];
  requireValue(Number.isSafeInteger(expiry) && expiry > now / 1000 && expiry <= now / 1000 + 900);
  const prefix = safeOutputPath(path);
  requireValue(statement.Resource === `${origin}${prefix}*`);
  return prefix;
}
function securityHeaders(response, studioOrigin, shell = false) {
  const base = ["default-src 'none'", "base-uri 'none'", "object-src 'none'", `frame-ancestors 'self' ${studioOrigin}`,
    `frame-src ${shell ? "'none'" : "'self'"}`, "form-action 'none'", "script-src-attr 'none'"];
  const content = shell ? ["script-src 'self'", "style-src 'self'", "connect-src 'self'"] : [
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' data:", "style-src 'self' 'unsafe-inline'", "font-src 'self' data: blob:",
    "img-src 'self' data: blob:", "connect-src 'self' data: blob:", "worker-src 'self' blob:", "manifest-src 'self'"];
  for (const [key, value] of Object.entries({"Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": [...base, ...content].join("; "),
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Cross-Origin-Resource-Policy": "same-origin"})) response.setHeader(key, value);
}
export function createLocalPreviewHandler({work, profile, studioOrigin, apiRequest, now = Date.now}) {
  const preview = loopbackOrigin(profile.previewOrigin);loopbackOrigin(studioOrigin);
  requireValue(studioOrigin !== preview.origin && /^[A-Za-z0-9]{1,128}$/.test(profile.previewKeyPairId)
    && profile.previewPublicKeyPath === "publication-preview-public.pem" && typeof apiRequest === "function");
  const directory = resolve(work), objects = join(directory, "objects");
  const publicKey = createPublicKey(readRegular(join(directory, profile.previewPublicKeyPath), 16384));
  requireValue(publicKey.asymmetricKeyType === "rsa" && publicKey.asymmetricKeyDetails.modulusLength >= 2048);
  return async (request, response) => {
    securityHeaders(response, studioOrigin);
    try {
      requireValue(request.headers.host === preview.host && !request.headers.authorization
        && (!request.headers.origin || request.headers.origin === preview.origin));
      const path = request.url;
      requireValue(typeof path === "string" && path.startsWith("/") && !/[?#%\\\x00-\x20]/.test(path));
      if (path === "/observable-preview/exchange") {
        requireValue(request.method === "POST" && request.headers.origin === preview.origin
          && request.headers["sec-fetch-site"] === "same-origin"
          && request.headers["content-type"] === "application/json");
        let size = 0;const chunks = [];
        for await (const chunk of request) {size += chunk.length;requireValue(size <= 2048);chunks.push(chunk);}
        const body = Buffer.concat(chunks), payload = JSON.parse(body);
        requireValue(exactKeys(payload, ["capability"]) && /^[A-Za-z0-9_-]{128,512}$/.test(payload.capability));
        const result = await apiRequest(path, {method: "POST", headers: {"content-type": "application/json", origin: preview.origin, "sec-fetch-site": "same-origin"}, body});
        if (result.status !== 200) return response.writeHead(result.status === 401 || result.status === 403 ? result.status : 403).end("Private preview unavailable");
        requireValue(result.body.length <= 4096);
        const exchange = parseExchange(JSON.parse(result.body));
        requireValue(Date.parse(exchange.expiresAt) > now());
        const setCookies = result.headers["set-cookie"];
        requireValue(Array.isArray(setCookies) && setCookies.length === 3);
        const cookieHeader = setCookies.map(cookie => cookie.split(";")[0]).join("; ");
        const prefix = verifyLocalPreviewCookies(cookieHeader, {origin: preview.origin, keyPairId: profile.previewKeyPairId, publicKey, path: exchange.entryPath, now: now()});
        requireValue(setCookies.every(cookie => typeof cookie === "string" && cookie.length <= 4096
          && cookie.split(";").some(part => part.trim() === `Path=${prefix}`)
          && /;\s*HttpOnly(?:;|$)/i.test(cookie) && /;\s*SameSite=Strict(?:;|$)/i.test(cookie) && !/;\s*Domain=/i.test(cookie)));
        return response.writeHead(200, {"Content-Type": "application/json", "Set-Cookie": setCookies}).end(result.body);
      }
      requireValue(request.method === "GET" || request.method === "HEAD");
      const shell = {"/authorize/": ["index.html", "text/html; charset=utf-8"], "/authorize/index.html": ["index.html", "text/html; charset=utf-8"],
        "/authorize/preview-shell.js": ["preview-shell.js", "text/javascript; charset=utf-8"], "/authorize/style.css": ["style.css", "text/css; charset=utf-8"]}[path];
      if (shell) {
        securityHeaders(response, studioOrigin, true);
        const body = readRegular(join(SHELL, shell[0]), 128 * 1024);
        return response.writeHead(200, {"Content-Type": shell[1]}).end(request.method === "HEAD" ? undefined : body);
      }
      verifyLocalPreviewCookies(request.headers.cookie, {origin: preview.origin, keyPairId: profile.previewKeyPairId, publicKey, path, now: now()});
      requireValue(lstatSync(objects).isDirectory() && !lstatSync(objects).isSymbolicLink());
      const index = JSON.parse(readRegular(join(directory, "objects.json"), MAX_OBJECT_BYTES));
      const matches = Object.entries(index).filter(([id, record]) => VERSION.test(id) && record.bucket === "local-pilot.invalid" && record.key === path.slice(1));
      requireValue(matches.length === 1);
      const [version, record] = matches[0];
      requireValue(record.version_id === version && Number.isSafeInteger(record.size_bytes) && record.size_bytes > 0 && record.size_bytes <= MAX_OBJECT_BYTES
        && /^[0-9a-f]{64}$/.test(record.checksum_sha256) && /^(?:text\/(?:html|css|javascript|plain|csv)|application\/(?:javascript|json|geo\+json|wasm|octet-stream|zip)|image\/[a-z0-9.+-]+|font\/[a-z0-9.+-]+)(?:; charset=utf-8)?$/i.test(record.content_type));
      const body = readRegular(join(objects, version), MAX_OBJECT_BYTES);
      requireValue(body.length === record.size_bytes && createHash("sha256").update(body).digest("hex") === record.checksum_sha256);
      return response.writeHead(200, {"Content-Type": record.content_type, "Content-Length": body.length}).end(request.method === "HEAD" ? undefined : body);
    } catch {return response.writeHead(403).end("Private preview unavailable");}
  };
}
export async function startLocalPreviewServer(options) {
  const url = loopbackOrigin(options.profile.previewOrigin);
  const server = createServer(createLocalPreviewHandler(options));
  server.requestTimeout = 15000;server.headersTimeout = 10000;server.maxHeadersCount = 32;
  await new Promise((done, reject) => {server.once("error", reject);server.listen(Number(url.port), "127.0.0.1", done);});
  return server;
}
