import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {containerIsolationArguments} from '../../observable-coordinator/src/podman-runner.mjs';
import {LANGUAGES, SHA256, closed, sha256} from '../src/contracts.mjs';
import {parseProfileEnvelope} from '../src/runtime.mjs';

export const ANALYSIS_ACCOUNT = Object.freeze({name: 'opengeo-analysis', uid: 10002, gid: 10002,
  home: '/var/lib/opengeo-analysis', subuidStart: 265536, subgidStart: 265536, subidCount: 65536});
export const ANALYSIS_PACKAGE_MEMBERS = Object.freeze([
  'analysis-coordinator/scripts/verify-host.mjs',
  ...['contracts', 'coordinator', 'runtime'].map(name => `analysis-coordinator/src/${name}.mjs`),
  ...['analysis-runner', 'aws-sigv4', 'compiler-policy', 'contracts', 'page-cache-transport', 'podman-runner',
    'production-adapters'].map(name => `observable-coordinator/src/${name}.mjs`)
].sort());
const PACKAGE_ROOT = '/opt/opengeo';
const MANIFEST_PATH = `${PACKAGE_ROOT}/analysis-runner-ami-manifest.json`;
const PACKAGE_MANIFEST_PATH = `${PACKAGE_ROOT}/analysis-package.json`;
const UNIT_PATH = '/etc/systemd/system/opengeo-analysis-coordinator.service';
const invalid = () => new Error('analysis_host_verification_failed');
function check(condition) {if (!condition) throw invalid();}
function document(bytes, maximum = 65536) {
  check(Buffer.isBuffer(bytes) && bytes.length > 1 && bytes.length <= maximum);
  try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {throw invalid();}
}
function accountFiles(passwd, group, subuid, subgid) {
  const row = passwd.split('\n').filter(line => line.split(':')[0] === ANALYSIS_ACCOUNT.name);
  check(row.length === 1);
  const values = row[0].split(':');
  check(Number(values[2]) === ANALYSIS_ACCOUNT.uid && Number(values[3]) === ANALYSIS_ACCOUNT.gid
    && values[5] === ANALYSIS_ACCOUNT.home);
  const groupRows = group.split('\n').filter(line => line.split(':')[0] === ANALYSIS_ACCOUNT.name);
  check(groupRows.length === 1 && Number(groupRows[0].split(':')[2]) === ANALYSIS_ACCOUNT.gid);
  for (const [contents, key] of [[subuid, 'subuidStart'], [subgid, 'subgidStart']]) {
    const selected = contents.split('\n').filter(line => line.split(':')[0] === ANALYSIS_ACCOUNT.name);
    check(selected.length === 1 && selected[0] === `${ANALYSIS_ACCOUNT.name}:${ANALYSIS_ACCOUNT[key]}:${ANALYSIS_ACCOUNT.subidCount}`);
    for (const line of contents.split('\n').filter(Boolean)) {
      const [name, start, count] = line.split(':');
      check(Number.isSafeInteger(Number(start)) && Number.isSafeInteger(Number(count)) && Number(count) > 0);
      if (name !== ANALYSIS_ACCOUNT.name) check(Number(start) + Number(count) <= ANALYSIS_ACCOUNT[key]
        || Number(start) >= ANALYSIS_ACCOUNT[key] + ANALYSIS_ACCOUNT.subidCount);
    }
  }
}

export async function verifyHost({environment = process.env, architecture = process.arch,
  uid = process.getuid?.(), gid = process.getgid?.(), groups = process.getgroups?.() ?? [], nodeVersion = process.version,
  readBytes = path => readFile(path), statPath = path => lstat(path), probe = probeCachedProfile} = {}) {
  const arch = architecture === 'x64' ? 'amd64' : architecture;
  check(uid === ANALYSIS_ACCOUNT.uid && gid === ANALYSIS_ACCOUNT.gid && ['arm64', 'amd64'].includes(arch));
  check(groups.every(group => group === ANALYSIS_ACCOUNT.gid));
  check(environment.HOME === ANALYSIS_ACCOUNT.home && environment.XDG_RUNTIME_DIR === '/run/opengeo-analysis'
    && environment.OPEN_GEO_ANALYSIS_WORKSPACE_ROOT === ANALYSIS_ACCOUNT.home);
  check(SHA256.test(environment.OPEN_GEO_ANALYSIS_RUNNER_AMI_EVIDENCE_SHA256 ?? '')
    && SHA256.test(environment.OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256 ?? ''));
  const immutable = async path => {
    const metadata = await statPath(path);
    check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.uid === 0 && metadata.gid === 0
      && (metadata.mode & 0o022) === 0 && metadata.size >= 1 && metadata.size <= 1024 * 1024);
    const bytes = await readBytes(path);check(bytes.length === metadata.size);return bytes;
  };
  for (const path of [PACKAGE_ROOT, `${PACKAGE_ROOT}/analysis-coordinator`, `${PACKAGE_ROOT}/analysis-coordinator/scripts`,
    `${PACKAGE_ROOT}/analysis-coordinator/src`, `${PACKAGE_ROOT}/observable-coordinator`, `${PACKAGE_ROOT}/observable-coordinator/src`]) {
    const metadata = await statPath(path);
    check(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === 0 && metadata.gid === 0
      && (metadata.mode & 0o022) === 0);
  }
  const manifestBytes = await immutable(MANIFEST_PATH), manifest = document(manifestBytes);
  check(sha256(manifestBytes) === environment.OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256);
  closed(manifest, ['schemaVersion', 'architecture', 'nodeVersion', 'profilesSha256', 'packageManifestSha256', 'serviceUnitSha256', 'account']);
  closed(manifest.account, Object.keys(ANALYSIS_ACCOUNT));
  check(manifest.schemaVersion === 'opengeo.analysis-runner-ami-manifest.1' && manifest.architecture === arch
    && manifest.nodeVersion === 'v24.19.0' && nodeVersion === manifest.nodeVersion
    && Object.keys(ANALYSIS_ACCOUNT).every(key => manifest.account[key] === ANALYSIS_ACCOUNT[key])
    && ['profilesSha256', 'packageManifestSha256', 'serviceUnitSha256'].every(key => SHA256.test(manifest[key] ?? ''))
    && manifest.profilesSha256 === environment.OPEN_GEO_ANALYSIS_PROFILES_SHA256);
  const envelope = document(Buffer.from(environment.OPEN_GEO_ANALYSIS_PROFILES_JSON ?? ''));
  check(envelope.architecture === arch);
  const profiles = parseProfileEnvelope(environment.OPEN_GEO_ANALYSIS_PROFILES_JSON, manifest.profilesSha256);
  const packageBytes = await immutable(PACKAGE_MANIFEST_PATH), pkg = document(packageBytes);
  check(sha256(packageBytes) === manifest.packageManifestSha256);
  closed(pkg, ['schemaVersion', 'files']);
  check(pkg.schemaVersion === 'opengeo.analysis-package.1' && Array.isArray(pkg.files)
    && pkg.files.length === ANALYSIS_PACKAGE_MEMBERS.length);
  for (const [index, item] of pkg.files.entries()) {
    closed(item, ['path', 'size_bytes', 'checksum_sha256']);
    check(item.path === ANALYSIS_PACKAGE_MEMBERS[index] && Number.isSafeInteger(item.size_bytes)
      && item.size_bytes > 0 && item.size_bytes <= 1024 * 1024 && SHA256.test(item.checksum_sha256 ?? ''));
    const bytes = await immutable(`${PACKAGE_ROOT}/${item.path}`);
    check(bytes.length === item.size_bytes && sha256(bytes) === item.checksum_sha256);
  }
  check(sha256(await immutable(UNIT_PATH)) === manifest.serviceUnitSha256);
  accountFiles(...await Promise.all(['/etc/passwd', '/etc/group', '/etc/subuid', '/etc/subgid'].map(async path =>
    (await readBytes(path)).toString('utf8'))));
  for (const path of [ANALYSIS_ACCOUNT.home, '/run/opengeo-analysis']) {
    const metadata = await statPath(path);
    check(metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === uid && metadata.gid === gid
      && (metadata.mode & 0o777) === 0o700);
  }
  for (const language of LANGUAGES) {
    const profile = profiles[language], result = await probe(profile, {architecture: arch, language});
    check(result.image === profile.image && result.architecture === arch && result.interpreter === profile.interpreter
      && result.cachedOnly === true && result.network === 'none');
  }
  // Admission outside this process must bind evidence to the final AMI and this
  // manifest. Checking a reference's shape here does not authenticate that evidence.
  return {architecture: arch, profilesSha256: manifest.profilesSha256, packageManifestSha256: manifest.packageManifestSha256,
    manifestSha256: sha256(manifestBytes), evidenceSha256: environment.OPEN_GEO_ANALYSIS_RUNNER_AMI_EVIDENCE_SHA256};
}

/** Explicit startup probe only: fixed interpreter --version, cached image, no network or credentials. */
export function probeCachedProfile(profile, {architecture, language}, {execute = spawnSync, environment = process.env} = {}) {
  const env = Object.fromEntries(['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
    .filter(key => typeof environment[key] === 'string').map(key => [key, environment[key]]));
  const command = (args, timeout = 5000) => {
    const result = execute('podman', args, {env, encoding: 'utf8', timeout, maxBuffer: 65536, shell: false});
    check(!result.error && result.status === 0 && Buffer.byteLength(result.stdout ?? '') <= 65536);return result.stdout;
  };
  const inspected = JSON.parse(command(['image', 'inspect', profile.image]));
  check(Array.isArray(inspected) && inspected.length === 1 && inspected[0].Id === profile.image
    && inspected[0].Architecture === architecture);
  const name = `opengeo-analysis-preflight-${randomUUID()}`;
  try {
    const version = command(['run', '--rm', '--pull=never', `--name=${name}`,
      ...containerIsolationArguments({memoryMiB: 256, cpuMillis: 1000}, {pids: 32, nofile: 256}),
      '--unsetenv-all', '--env=PATH=/usr/local/bin:/usr/bin:/bin', '--env=LANG=C.UTF-8',
      '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m', `--entrypoint=${profile.interpreter}`, profile.image, '--version']);
    check((language === 'python' ? /^Python \d+\./ : language === 'javascript' ? /^v\d+\./ : /^GNU bash, version \d+\./).test(version));
  } finally {command(['rm', '--force', '--ignore', '--time=0', name], 3000);}
  return {image: profile.image, architecture, interpreter: profile.interpreter, cachedOnly: true, network: 'none'};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {await verifyHost();}
  catch {console.error('analysis_host_verification_failed');process.exitCode = 1;}
}
