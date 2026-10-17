// Opt-in addition to the existing AMI bake. Never run on an application request.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as FS from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const {chmodSync, chownSync, readFileSync, rmSync, writeFileSync} = FS;

const HASH = /^[0-9a-f]{64}$/;
const HOME = '/var/lib/opengeo-analysis', RUNTIME = '/run/opengeo-analysis';
const NAME = 'opengeo-analysis', UID = 10002, SUBIDS = 265536, COUNT = 65536;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...keys].sort().join()) throw Error('Invalid analysis bake inputs');
}
function command(file, args, options = {}) {
  const result = spawnSync(file, args, {encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024, ...options});
  if (result.error || result.status !== 0) throw Error(`Analysis bake command failed: ${file}`);
  return result.stdout;
}
function verifyFile(path, expected, maximum, filesystem = FS) {
  const info = filesystem.lstatSync(path);
  if (!HASH.test(expected ?? '') || !info.isFile() || info.isSymbolicLink() || info.size > maximum
    || info.size < 1 || sha(filesystem.readFileSync(path)) !== expected) throw Error('Analysis bake artifact mismatch');
}
function safeArchive(path, {run = command, maximumBytes = 1024 * 1024 * 1024, maximumMembers = 4096} = {}) {
  const members = run('tar', ['--list', '--file', path]).trim().split('\n');
  if (!members.length || members.length > maximumMembers || new Set(members).size !== members.length || members.some(name => {
    const parts = name.replace(/\/$/, '').split('/');
    return !/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('/') || parts.some(part => part === '..' || part === '');
  })) throw Error('Unsafe analysis archive members');
  const entries = run('tar', ['--list', '--verbose', '--numeric-owner', '--file', path]).trim().split('\n');
  let total = 0;
  if (entries.length !== members.length || entries.some(line => {
    const entry = /^[-d][rwxStTs-]{9}\s+\d+\/\d+\s+(\d+)\s+/.exec(line);
    if (!entry || !Number.isSafeInteger(Number(entry[1]))) return true;
    total += Number(entry[1]);return total > maximumBytes;
  })) throw Error('Analysis archive links or oversized contents are forbidden');
  return members;
}
const OWNED_DIRECTORIES = new Set([HOME, `${HOME}/tmp`, RUNTIME, `${HOME}/.config`, `${HOME}/.config/containers`]);
function pathDirectories(path) {
  const parts = path.split('/').filter(Boolean);return parts.map((_part, index) => '/' + parts.slice(0, index + 1).join('/'));
}
function rootDirectory(path, {filesystem = FS, create = false} = {}) {
  for (const directory of pathDirectories(path)) {
    if (!filesystem.existsSync(directory)) {
      // lstat, unlike exists, also detects a dangling symlink.
      try {filesystem.lstatSync(directory);throw Error('Unsafe analysis installation directory');}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (!create) continue;
      filesystem.mkdirSync(directory, {mode: 0o755});filesystem.chmodSync(directory, 0o755);
    }
    if (!filesystem.existsSync(directory)) continue;
    const info = filesystem.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022)) {
      throw Error('Unsafe analysis installation directory');
    }
  }
}
export function ensureAnalysisDirectory(path, {filesystem = FS} = {}) {
  if (!OWNED_DIRECTORIES.has(path)) throw Error('Invalid analysis runtime directory');
  for (const directory of pathDirectories(path)) {
    if (!filesystem.existsSync(directory)) {
      try {filesystem.lstatSync(directory);throw Error('Unsafe analysis runtime directory');}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (directory !== path) throw Error('Missing analysis runtime parent');
      filesystem.mkdirSync(directory, {mode: 0o700});filesystem.chownSync(directory, UID, UID);
    }
    const owned = directory === HOME || directory.startsWith(HOME + '/') || directory === RUNTIME;
    const info = filesystem.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== (owned ? UID : 0)
      || info.gid !== (owned ? UID : 0) || (info.mode & 0o022)) throw Error('Unsafe analysis runtime directory');
  }
  filesystem.chmodSync(path, 0o700);
}
function installedFile(path, expectedBytes, filesystem = FS) {
  let info;try {info = filesystem.lstatSync(path);} catch (error) {if (error.code === 'ENOENT') return false;throw error;}
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022)
    || !filesystem.readFileSync(path).equals(expectedBytes)) throw Error('Analysis bundle differs from installed shared runtime; rebuild from one source');
  return true;
}
function writeImmutable(path, bytes, filesystem = FS) {
  if (installedFile(path, bytes, filesystem)) return;
  filesystem.writeFileSync(path, bytes, {mode: 0o444, flag: 'wx'});filesystem.chmodSync(path, 0o444);
}
function identityExists(kind, value) {
  const result = spawnSync('getent', [kind, value], {timeout: 1000, encoding: 'utf8', maxBuffer: 16384});
  if (result.error || ![0, 2].includes(result.status)) throw Error('Cannot verify analysis identity allocation');
  return result.status === 0;
}
function asUser(args) {
  return command('runuser', ['-u', NAME, '--', 'env', `HOME=${HOME}`, `XDG_RUNTIME_DIR=${RUNTIME}`, ...args], {cwd: HOME});
}

export async function installAnalysisRunner(payloadDirectory, {filesystem = FS, run = command,
  uid = process.getuid?.(), architecture = process.arch, nodeVersion = process.version, identity = identityExists} = {}) {
  if (uid !== 0) throw Error('Analysis bake requires the root installer');
  const payload = resolve(payloadDirectory);
  if (payload !== '/tmp/opengeo-analysis-payload') throw Error('Use the fixed analysis bake staging directory');
  const payloadInfo = filesystem.lstatSync(payload);
  if (!payloadInfo.isDirectory() || payloadInfo.isSymbolicLink()) throw Error('Unsafe analysis bake staging directory');
  const inputInfo = filesystem.lstatSync(join(payload, 'inputs.json'));
  if (!inputInfo.isFile() || inputInfo.isSymbolicLink() || inputInfo.size < 1 || inputInfo.size > 16384) throw Error('Invalid analysis bake inputs');
  const raw = filesystem.readFileSync(join(payload, 'inputs.json'));
  if (raw.length !== inputInfo.size || raw.length > 16384) throw Error('Analysis bake inputs are too large');
  const inputs = JSON.parse(raw);closed(inputs, ['schemaVersion', 'package', 'profiles', 'profilesSha256', 'images']);
  closed(inputs.package, ['file', 'sha256']);
  if (inputs.schemaVersion !== 'opengeo.analysis-ami-inputs.1' || inputs.package.file !== 'analysis.tar'
    || !HASH.test(inputs.profilesSha256 ?? '') || sha(canonical(inputs.profiles)) !== inputs.profilesSha256
    || !Array.isArray(inputs.images) || inputs.images.length < 1 || inputs.images.length > 3) throw Error('Invalid analysis bake inputs');
  const packagePath = join(payload, inputs.package.file);verifyFile(packagePath, inputs.package.sha256, 2 * 1024 * 1024, filesystem);
  const work = filesystem.mkdtempSync('/tmp/opengeo-analysis-install-');
  try {
    const members = safeArchive(packagePath, {run, maximumBytes: 2 * 1024 * 1024, maximumMembers: 12});
    const expected = ['analysis-package.json', 'analysis-coordinator/scripts/verify-host.mjs',
      ...['contracts', 'coordinator', 'runtime'].map(name => `analysis-coordinator/src/${name}.mjs`),
      ...['analysis-runner', 'aws-sigv4', 'compiler-policy', 'contracts', 'page-cache-transport', 'podman-runner',
        'production-adapters'].map(name => `observable-coordinator/src/${name}.mjs`)].sort();
    if (members.slice().sort().join() !== expected.join()) throw Error('Unexpected analysis package member');
    run('tar', ['--extract', '--file', packagePath, '--directory', work, '--no-same-owner', '--no-same-permissions']);
    const packageBytes = filesystem.readFileSync(join(work, 'analysis-package.json')), manifest = JSON.parse(packageBytes);
    closed(manifest, ['schemaVersion', 'files']);
    if (manifest.schemaVersion !== 'opengeo.analysis-package.1' || !Array.isArray(manifest.files)
      || manifest.files.length !== 11 || new Set(manifest.files.map(row => row.path)).size !== manifest.files.length) throw Error('Invalid analysis package manifest');
    for (const row of manifest.files) {
      closed(row, ['path', 'size_bytes', 'checksum_sha256']);
      if (row.path === 'analysis-package.json' || !expected.includes(row.path) || !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1) throw Error('Invalid analysis package file');
      const source = join(work, row.path);verifyFile(source, row.checksum_sha256, 2 * 1024 * 1024, filesystem);
      if (filesystem.lstatSync(source).size !== row.size_bytes) throw Error('Analysis package size mismatch');
    }
    // Parse only the checksum-verified staged closure. No /opt, account or image mutation
    // happens until profiles, architecture, complete OCI inventory and unit all validate.
    const {parseProfileEnvelope} = await import(pathToFileURL(join(work, 'analysis-coordinator/src/runtime.mjs')));
    const profiles = parseProfileEnvelope(canonical(inputs.profiles), inputs.profilesSha256);
    if ((architecture === 'x64' ? 'amd64' : architecture) !== inputs.profiles.architecture
      || nodeVersion !== 'v24.19.0') throw Error('Analysis bake architecture or Node mismatch');
    const expectedImages = new Set(Object.values(profiles).map(profile => profile.image)), images = new Set();let totalBytes = 0;
    for (const image of inputs.images) {
      closed(image, ['file', 'sha256', 'image']);
      if (!/^[a-z0-9][a-z0-9._-]{0,79}\.tar$/.test(image.file) || image.file === 'analysis.tar'
        || !expectedImages.has(image.image) || images.has(image.image)) throw Error('Invalid analysis image inventory');
      const path = join(payload, image.file);verifyFile(path, image.sha256, 1024 * 1024 * 1024, filesystem);
      safeArchive(path, {run});totalBytes += filesystem.lstatSync(path).size;images.add(image.image);
    }
    if (new Set(inputs.images.map(image => image.file)).size !== inputs.images.length
      || images.size !== expectedImages.size || totalBytes > 1024 * 1024 * 1024) throw Error('Incomplete or oversized analysis image inventory');
    const unitPath = '/tmp/opengeo-analysis-coordinator.service', unitInfo = filesystem.lstatSync(unitPath);
    if (!unitInfo.isFile() || unitInfo.isSymbolicLink() || unitInfo.size < 1 || unitInfo.size > 16384) throw Error('Invalid analysis service unit');
    const unit = filesystem.readFileSync(unitPath);
    if (unit.length !== unitInfo.size) throw Error('Invalid analysis service unit');
    if (identity('passwd', String(UID)) || identity('group', String(UID))
      || identity('passwd', NAME) || identity('group', NAME)) throw Error('Analysis identity already allocated');
    for (const file of ['/etc/subuid', '/etc/subgid']) {
      let rows = [];
      try {
        const info = filesystem.lstatSync(file);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o022)) throw Error('Unsafe analysis subordinate ID file');
        rows = filesystem.readFileSync(file, 'utf8').trim().split('\n');
      } catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (rows.filter(Boolean).some(row => {
        const [name, start, count, extra] = row.split(':');
        return extra !== undefined || !/^[0-9]+$/.test(start ?? '') || !/^[0-9]+$/.test(count ?? '')
          || !Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(count)) || Number(count) < 1
          || !Number.isSafeInteger(Number(start) + Number(count)) || name === NAME
          || Number(start) <= SUBIDS + COUNT - 1 && Number(start) + Number(count) - 1 >= SUBIDS;
      })) throw Error('Analysis subordinate IDs already allocated or invalid');
    }
    for (const directory of OWNED_DIRECTORIES) {
      try {filesystem.lstatSync(directory);throw Error('Analysis runtime directory already allocated');}
      catch (error) {if (error.code !== 'ENOENT') throw error;}
    }
    const amiManifest = {schemaVersion: 'opengeo.analysis-runner-ami-manifest.1', architecture: inputs.profiles.architecture,
      nodeVersion, profilesSha256: inputs.profilesSha256, packageManifestSha256: sha(packageBytes), serviceUnitSha256: sha(unit),
      account: {name: NAME, uid: UID, gid: UID, home: HOME, subuidStart: SUBIDS, subgidStart: SUBIDS, subidCount: COUNT}};
    installedFile('/opt/opengeo/analysis-runner-ami-manifest.json', Buffer.from(canonical(amiManifest) + '\n'), filesystem);
    const files = manifest.files.map(row => ({path: join('/opt/opengeo', row.path), bytes: filesystem.readFileSync(join(work, row.path))}));
    files.push({path: '/opt/opengeo/analysis-package.json', bytes: packageBytes});
    // Inspect every existing destination before creating any package directory/file.
    for (const file of files) {rootDirectory(resolve(file.path, '..'), {filesystem});installedFile(file.path, file.bytes, filesystem);}
    rootDirectory('/etc/systemd/system', {filesystem});installedFile('/etc/systemd/system/opengeo-analysis-coordinator.service', unit, filesystem);
    for (const file of files) {rootDirectory(resolve(file.path, '..'), {filesystem, create: true});writeImmutable(file.path, file.bytes, filesystem);}
    return {inputs, packageBytes, unit, amiManifest};
  } finally {filesystem.rmSync(work, {recursive: true, force: true});}
}

async function main() {
  const {inputs, unit, amiManifest} = await installAnalysisRunner(process.argv[2]);
  command('groupadd', ['--system', '--gid', String(UID), NAME]);
  command('useradd', ['--system', '--uid', String(UID), '--gid', String(UID), '--home-dir', HOME, '--create-home', '--shell', '/sbin/nologin', NAME]);
  for (const file of ['/etc/subuid', '/etc/subgid']) writeFileSync(file, `${NAME}:${SUBIDS}:${COUNT}\n`, {flag: 'a', mode: 0o644});
  for (const path of [HOME, `${HOME}/tmp`, RUNTIME, `${HOME}/.config`, `${HOME}/.config/containers`]) ensureAnalysisDirectory(path);
  writeFileSync(`${HOME}/.config/containers/containers.conf`, '[engine]\ncgroup_manager="cgroupfs"\nevents_logger="file"\n', {mode: 0o600, flag: 'wx'});
  chownSync(`${HOME}/.config/containers/containers.conf`, UID, UID);
  const payload = '/tmp/opengeo-analysis-payload';chownSync(payload, 0, UID);chmodSync(payload, 0o750);
  for (const image of inputs.images) {
    const path = join(payload, image.file);chownSync(path, 0, UID);chmodSync(path, 0o440);
    asUser(['podman', 'load', '--input', path]);
    const inspection = JSON.parse(asUser(['podman', 'image', 'inspect', image.image]));
    if (inspection.length !== 1 || inspection[0].Id !== image.image || inspection[0].Architecture !== inputs.profiles.architecture) throw Error('Analysis cached image mismatch');
    const output = `/opt/opengeo/analysis-image-${image.image.slice(7)}-vulnerabilities.json`;
    command('/usr/local/sbin/opengeo-trivy', ['--cache-dir', '/tmp/opengeo-trivy-cache', '--offline-scan', '--skip-db-update',
      'image', '--skip-java-db-update', '--input', path, '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--format', 'json', '--output', output]);
    const report = JSON.parse(readFileSync(output));
    if (report.SchemaVersion !== 2 || !Array.isArray(report.Results)
      || report.Results.some(row => (row.Vulnerabilities ?? []).some(value => ['HIGH', 'CRITICAL'].includes(value.Severity)))) throw Error('Analysis image security gate failed');
    chmodSync(output, 0o444);
  }
  writeImmutable('/etc/systemd/system/opengeo-analysis-coordinator.service', unit);
  writeImmutable('/opt/opengeo/analysis-runner-ami-manifest.json', Buffer.from(canonical(amiManifest) + '\n'));
  command('systemctl', ['daemon-reload']);
  command('systemctl', ['disable', 'opengeo-analysis-coordinator.service']);
  command('systemctl', ['disable', 'opengeo-observable-coordinator.service']);
  rmSync(payload, {recursive: true, force: true});rmSync('/tmp/opengeo-analysis-coordinator.service');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {process.stderr.write('Analysis AMI installation failed; do not admit this bake.\n');process.exitCode = 1;});
}
