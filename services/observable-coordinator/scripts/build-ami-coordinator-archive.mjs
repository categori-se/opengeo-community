import {lstat, mkdir, readFile, readdir, realpath, writeFile} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const TRANSPORT_ROOT = resolve(PACKAGE_ROOT, "../api/src/opengeo_api");
export const PUBLIC_FILE_TRANSPORT_MODULES = Object.freeze([
  "__init__.py", "source_archiver.py", "connection_verification.py", "s3_endpoints.py"
]);
const MEMBERS = Object.freeze([
  "package.json",
  "src",
  "scripts/run-host.mjs",
  "scripts/verify-host.mjs",
  "scripts/configure-host-logs.mjs"
]);

export async function buildCoordinatorArchive(outputPath) {
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("one coordinator archive output path is required");
  }
  const output = resolve(outputPath);
  if (output === PACKAGE_ROOT || !output.endsWith(".tar")) {
    throw new Error("coordinator archive output must end in .tar");
  }
  await mkdir(dirname(output), {recursive: true, mode: 0o700});
  const packageRoot = await realpath(PACKAGE_ROOT);
  const records = [];
  for (const member of MEMBERS) {
    await appendMember(records, packageRoot, member);
  }
  for (const module of PUBLIC_FILE_TRANSPORT_MODULES) {
    await appendMember(records, TRANSPORT_ROOT, module, `python/opengeo_api/${module}`);
  }
  records.push(Buffer.alloc(1024));
  await writeFile(output, Buffer.concat(records), {mode: 0o600});
  return output;
}

async function appendMember(records, packageRoot, name, archiveName = name) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("/") || name.includes("..")) {
    throw new Error("coordinator archive member is invalid");
  }
  const path = resolve(packageRoot, name);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
    throw new Error("coordinator archive accepts only files and directories");
  }
  if (metadata.isDirectory()) {
    const directoryName = `${archiveName.replace(/\/$/, "")}/`;
    records.push(tarHeader(directoryName, 0, "5", 0o755));
    for (const child of (await readdir(path)).sort()) {
      await appendMember(records, packageRoot, `${name}/${child}`, `${archiveName}/${child}`);
    }
    return;
  }
  const bytes = await readFile(path);
  records.push(tarHeader(archiveName, bytes.length, "0", 0o644), bytes);
  const remainder = bytes.length % 512;
  if (remainder !== 0) records.push(Buffer.alloc(512 - remainder));
}

function tarHeader(name, size, type, mode) {
  if (Buffer.byteLength(name) > 100 || !Number.isSafeInteger(size) || size < 0) {
    throw new Error("coordinator archive member exceeds USTAR limits");
  }
  const header = Buffer.alloc(512);
  field(header, 0, 100, name);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  field(header, 156, 1, type);
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const encoded = checksum.toString(8).padStart(6, "0");
  field(header, 148, 6, encoded);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function field(buffer, offset, length, value) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error("coordinator archive header field is too long");
  bytes.copy(buffer, offset);
}

function octal(buffer, offset, length, value) {
  field(buffer, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const output = await buildCoordinatorArchive(process.argv[2]);
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
