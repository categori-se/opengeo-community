import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ANALYSIS_ACCOUNT, ANALYSIS_PACKAGE_MEMBERS, probeCachedProfile, verifyHost} from '../scripts/verify-host.mjs';
import {sha256} from '../src/contracts.mjs';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function fixture() {
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch;
  const envelope = {schemaVersion: 1, architecture, profiles: Object.fromEntries([
    ['python', '/usr/local/bin/python3'], ['javascript', '/usr/local/bin/node'], ['bash', '/bin/bash']
  ].map(([language, interpreter], index) => [language, {image: 'sha256:' + String(index + 1).repeat(64), interpreter}]))};
  const files = new Map(ANALYSIS_PACKAGE_MEMBERS.map(path => ['/opt/opengeo/' + path, Buffer.from('fixture:' + path)]));
  const pkg = {schemaVersion: 'opengeo.analysis-package.1', files: ANALYSIS_PACKAGE_MEMBERS.map(path => {
    const bytes = files.get('/opt/opengeo/' + path);return {path, size_bytes: bytes.length, checksum_sha256: sha256(bytes)};
  })};
  files.set('/opt/opengeo/analysis-package.json', Buffer.from(JSON.stringify(pkg)));
  files.set('/etc/systemd/system/opengeo-analysis-coordinator.service', Buffer.from('fixture unit'));
  files.set('/etc/passwd', Buffer.from('opengeo-analysis:x:10002:10002::/var/lib/opengeo-analysis:/sbin/nologin\n'));
  files.set('/etc/group', Buffer.from('opengeo-analysis:x:10002:\n'));
  files.set('/etc/subuid', Buffer.from('opengeo-coordinator:200000:65536\nopengeo-analysis:265536:65536\n'));
  files.set('/etc/subgid', files.get('/etc/subuid'));
  const manifest = {schemaVersion: 'opengeo.analysis-runner-ami-manifest.1', architecture, nodeVersion: 'v24.19.0',
    profilesSha256: sha256(canonical(envelope)), packageManifestSha256: sha256(files.get('/opt/opengeo/analysis-package.json')),
    serviceUnitSha256: sha256(files.get('/etc/systemd/system/opengeo-analysis-coordinator.service')), account: ANALYSIS_ACCOUNT};
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  files.set('/opt/opengeo/analysis-runner-ami-manifest.json', manifestBytes);
  const environment = {HOME: ANALYSIS_ACCOUNT.home, XDG_RUNTIME_DIR: '/run/opengeo-analysis',
    OPEN_GEO_ANALYSIS_WORKSPACE_ROOT: ANALYSIS_ACCOUNT.home, OPEN_GEO_ANALYSIS_PROFILES_JSON: JSON.stringify(envelope),
    OPEN_GEO_ANALYSIS_PROFILES_SHA256: manifest.profilesSha256, OPEN_GEO_ANALYSIS_RUNNER_AMI_EVIDENCE_SHA256: 'a'.repeat(64),
    OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256: sha256(manifestBytes)};
  const probes = [];
  return {files, environment, probes, architecture, options: {environment, uid: 10002, gid: 10002, groups: [10002], architecture, nodeVersion: 'v24.19.0',
    readBytes: async path => {assert.ok(files.has(path), path);return files.get(path);},
    statPath: async path => {const file = files.has(path), workspace = [ANALYSIS_ACCOUNT.home, '/run/opengeo-analysis'].includes(path);
      return {uid: workspace ? 10002 : 0, gid: workspace ? 10002 : 0, mode: workspace ? 0o700 : 0o444,
        size: files.get(path)?.length, isFile: () => file, isDirectory: () => !file, isSymbolicLink: () => false};},
    probe: async (profile, selected) => {probes.push(selected.language);return {image: profile.image, architecture,
      interpreter: profile.interpreter, cachedOnly: true, network: 'none'};}}};
}

test('host preflight binds private account, exact source/unit/profile hashes and all three cached interpreter probes', async () => {
  const f = fixture(), result = await verifyHost(f.options);
  assert.deepEqual(f.probes, ['python', 'javascript', 'bash']);
  assert.equal(result.manifestSha256, f.environment.OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256);
  assert.equal(result.evidenceSha256, 'a'.repeat(64));
});

test('host preflight rejects another identity, writable source, changed unit/source and overlapping subordinate mappings before execution', async () => {
  for (const change of [
    f => {f.options.uid = 10001;},
    f => {f.options.groups = [10002, 0];},
    f => {f.environment.HOME = '/root';},
    f => {f.environment.OPEN_GEO_ANALYSIS_RUNNER_AMI_MANIFEST_SHA256 = 'b'.repeat(64);},
    f => {f.files.set('/opt/opengeo/' + ANALYSIS_PACKAGE_MEMBERS[0], Buffer.from('changed'));},
    f => {f.files.set('/etc/systemd/system/opengeo-analysis-coordinator.service', Buffer.from('changed unit'));},
    f => {f.files.set('/etc/subuid', Buffer.from('other:265500:1000\nopengeo-analysis:265536:65536\n'));},
    f => {f.files.set('/etc/group', Buffer.from('opengeo-analysis:x:0:\n'));},
    f => {const stat = f.options.statPath;f.options.statPath = async path => ({...await stat(path), mode: 0o777});}
  ]) {
    const f = fixture();change(f);await assert.rejects(verifyHost(f.options));assert.deepEqual(f.probes, []);
  }
});

test('host preflight refuses changed profile JSON, uncached/wrong architecture and substituted interpreter probes', async () => {
  const f = fixture();f.environment.OPEN_GEO_ANALYSIS_PROFILES_JSON = f.environment.OPEN_GEO_ANALYSIS_PROFILES_JSON.replace('/bin/bash', '/bin/sh');
  await assert.rejects(verifyHost(f.options));assert.deepEqual(f.probes, []);
  for (const change of [{cachedOnly: false}, {architecture: 'other'}, {interpreter: '/bin/sh'}, {network: 'host'}]) {
    const f = fixture();f.options.probe = async (profile) => ({image: profile.image, architecture: f.architecture,
      interpreter: profile.interpreter, cachedOnly: true, network: 'none', ...change});
    await assert.rejects(verifyHost(f.options));
  }
});

test('cached profile probe uses the maintained isolation flags, fixed interpreter, no pulls/network/credentials, and exact cleanup', () => {
  const calls = [], image = 'sha256:' + 'a'.repeat(64), profile = {image, interpreter: '/usr/local/bin/python3'};
  const execute = (command, args, options) => {
    calls.push({command, args, options});
    return {status: 0, stdout: args[0] === 'image' ? JSON.stringify([{Id: image, Architecture: 'amd64'}])
      : args[0] === 'run' ? 'Python 3.14.0\n' : ''};
  };
  assert.equal(probeCachedProfile(profile, {architecture: 'amd64', language: 'python'}, {execute,
    environment: {HOME: '/var/lib/opengeo-analysis', PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/opengeo-analysis', AWS_SECRET_ACCESS_KEY: 'excluded'}}).cachedOnly, true);
  const run = calls.find(call => call.args[0] === 'run');
  for (const flag of ['--pull=never', '--network=none', '--unsetenv-all', '--read-only', '--cap-drop=all', '--entrypoint=/usr/local/bin/python3']) assert.ok(run.args.includes(flag));
  assert.deepEqual(run.args.slice(-2), [image, '--version']);
  assert.ok(!Object.keys(run.options.env).some(key => key.startsWith('AWS_')));
  const name = run.args.find(arg => arg.startsWith('--name=')).slice('--name='.length);
  assert.deepEqual(calls.at(-1).args, ['rm', '--force', '--ignore', '--time=0', name]);
});

test('failed cached version probe still attempts bounded exact cleanup and a wrong image never runs', () => {
  const image = 'sha256:' + 'a'.repeat(64), calls = [];
  assert.throws(() => probeCachedProfile({image, interpreter: '/usr/local/bin/node'}, {architecture: 'amd64', language: 'javascript'}, {
    execute: (_command, args) => {calls.push(args);return {status: args[0] === 'run' ? 1 : 0,
      stdout: args[0] === 'image' ? JSON.stringify([{Id: image, Architecture: 'amd64'}]) : ''};}}));
  assert.equal(calls.at(-1)[0], 'rm');
  const wrong = [];
  assert.throws(() => probeCachedProfile({image, interpreter: '/usr/local/bin/node'}, {architecture: 'amd64', language: 'javascript'}, {
    execute: (_command, args) => {wrong.push(args);return {status: 0, stdout: JSON.stringify([{Id: 'sha256:' + 'b'.repeat(64), Architecture: 'amd64'}])};}}));
  assert.equal(wrong.length, 1);
});
