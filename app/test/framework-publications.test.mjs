import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {FrameworkPublications} from "../src/components/FrameworkPublications.js";
import {PublicationInputDistribution} from "../src/components/PublicationInputDistribution.js";
import {OpenGeoApiClient, parseFrameworkPublications} from "../src/lib/apiClient.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ID = "11111111-1111-4111-8111-111111111111";
const fixture = () => ({source_project_id: ID, can_publish: true, dispatch_configured: true,
  mounts: [{id: ID, hostname: "opengeo.tools", mount_path: "/analysis/reading-beyond-visible/", generation: 1, enabled: true}],
  reviews: [{id: ID, build_job_id: ID, mount_id: ID, hostname: "opengeo.tools", mount_path: "/analysis/reading-beyond-visible/",
    result_checksum_sha256: "a".repeat(64), output_tree_checksum_sha256: "b".repeat(64), expected_generation: 1,
    previous_release_prefix: "releases/previous", reviewed_at: "2026-09-10T00:00:00Z", expires_at: "2099-09-11T00:00:00Z", approved_at: null}]});
const button = (root, title) => [...root.querySelectorAll("button")].find(element => element.textContent === title);

test("review reload never publishes; approval is explicit and is not reported as a release", async () => {
  const dom = new JSDOM("<body></body>"); const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const raw = fixture(); let approvals = 0;
    const adapter = {getFrameworkPublications: async () => parseFrameworkPublications(raw, ID),
      listObservableBuildJobs: async () => [{id: ID, sourceProjectId: ID, sourceRevisionNumber: 1, state: "succeeded", resultChecksumSha256: "a".repeat(64)}],
      approveFrameworkPublication: async (project, source, review) => {assert.equal(review, ID); approvals++; raw.reviews[0].approved_at = "2026-09-10T01:00:00Z"; return parseFrameworkPublications(raw, ID);}};
    const root = FrameworkPublications({adapter, projectId: ID, sourceProjectId: ID});
    await tick(); assert.equal(approvals, 0);
    button(root, "Approve and publish").click(); await tick(); assert.equal(approvals, 0);
    root.querySelector('input[name="approve-publication-output"]').checked = true;
    button(root, "Approve and publish").click(); await tick(); assert.equal(approvals, 1);
    assert.match(root.textContent, /Approval is not proof of deployment/);
    button(root, "Reload publication reviews").click(); await tick(); assert.equal(approvals, 1);
    assert.ok(button(root, "Resume approved publication"));
    raw.dispatch_configured = false;
    button(root, "Reload publication reviews").click(); await tick();
    assert.equal(button(root, "Resume approved publication").disabled, true);
  } finally {globalThis.document = previous; dom.window.close();}
});

test("publication responses reject foreign source identities and unsafe destinations", () => {
  assert.throws(() => parseFrameworkPublications(fixture(), "another-source"));
  const raw = fixture(); raw.mounts[0].hostname = "opengeo.tools@evil.invalid";
  assert.throws(() => parseFrameworkPublications(raw, ID));
  raw.mounts[0].hostname = "opengeo.tools"; raw.reviews[0].mount_path = "/../studio/";
  assert.throws(() => parseFrameworkPublications(raw, ID));
});

test('address reservation is explicit, constrained to approved hosting and keeps its identity after an uncertain response', async () => {
  const dom = new JSDOM('<body></body>'); const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const raw = {...fixture(), mounts: [], reviews: [], can_configure_destinations: true,
      origins: [{id:ID,hostname:'opengeo.tools',path_prefix:'/publications/'}]};
    const reservations = [];
    const adapter = {getFrameworkPublications: async () => parseFrameworkPublications(raw,ID), listObservableBuildJobs: async () => [],
      reserveFrameworkPublicationDestination: async (project,source,body) => {
        assert.equal(project,ID); assert.equal(source,ID); reservations.push(body);
        if (reservations.length === 1) throw Error('Response lost');
        raw.mounts.push({id:body.reservationId,hostname:'opengeo.tools',mount_path:'/publications/atlas/',generation:2,enabled:true});
        return parseFrameworkPublications(raw,ID);
      }, reviewFrameworkPublication: async () => assert.fail('No release review during address configuration'),
      approveFrameworkPublication: async () => assert.fail('No publishing during address configuration')};
    const root = FrameworkPublications({adapter,projectId:ID,sourceProjectId:ID}); document.body.append(root);
    await tick(); assert.equal(reservations.length,0);
    function enter(value) {const input=root.querySelector('[aria-label="Address name"]');input.value=value;input.dispatchEvent(new dom.window.Event('input'));}
    enter('../atlas'); assert.equal(button(root,'Reserve address').disabled,true);
    enter('atlas'); assert.equal(root.querySelector('output').textContent,'https://opengeo.tools/publications/atlas/');
    button(root,'Reserve address').click(); await tick(); assert.equal(reservations.length,1);
    assert.match(root.textContent,/could not be confirmed/);
    button(root,'Reload publication reviews').click(); await tick();
    enter('atlas'); button(root,'Reserve address').click(); await tick();
    assert.equal(reservations.length,2); assert.deepEqual(reservations[0],reservations[1]);
    assert.equal(reservations[1].originId,ID); assert.equal(reservations[1].slug,'atlas');
    assert(root.textContent.includes('https://opengeo.tools/publications/atlas/'));
    assert.equal(root.querySelector('.publication-release-history details'),null);
  } finally {globalThis.document=previous;dom.window.close();}
});

test('hosting options reject authenticated origins, root prefixes and leaked administrator configuration', () => {
  const raw = {...fixture(),can_configure_destinations:true,origins:[{id:ID,hostname:'pages.studio.opengeo.tools',path_prefix:'/publications/'}]};
  assert.equal(parseFrameworkPublications(raw,ID).origins[0].urlPrefix,'https://pages.studio.opengeo.tools/publications/');
  for (const hostname of ['studio.opengeo.tools','preview.studio.opengeo.tools','maps-preview.studio.opengeo.tools','api.opengeo.tools']) {
    assert.throws(() => parseFrameworkPublications({...raw,origins:[{...raw.origins[0],hostname}]},ID),/Unsafe public hosting/);
  }
  assert.throws(() => parseFrameworkPublications({...raw,origins:[{...raw.origins[0],path_prefix:'/'}]},ID));
  assert.throws(() => parseFrameworkPublications({...raw,can_configure_destinations:false},ID));
});

test('one publication can reserve and select addresses on each approved public host without publishing', async () => {
  const dom = new JSDOM('<body></body>');
  const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const origins = [
      {id:'22222222-2222-4222-8222-222222222222',hostname:'pages.studio.opengeo.tools',path_prefix:'/publications/'},
      {id:'33333333-3333-4333-8333-333333333333',hostname:'opengeo.tools',path_prefix:'/articles/'},
      {id:'44444444-4444-4444-8444-444444444444',hostname:'atlas.example.org',path_prefix:'/research/'}
    ];
    const raw = {...fixture(),mounts:[],reviews:[],can_configure_destinations:true,origins};
    const reservations = [], reviews = [];
    const adapter = {
      getFrameworkPublications:async()=>parseFrameworkPublications(raw,ID),
      listObservableBuildJobs:async()=>[{id:ID,sourceProjectId:ID,sourceRevisionNumber:3,state:'succeeded',resultChecksumSha256:'a'.repeat(64)}],
      reserveFrameworkPublicationDestination:async(project,source,body)=>{
        assert.equal(project,ID); assert.equal(source,ID);
        const origin=origins.find(origin=>origin.id===body.originId);
        assert.ok(origin); reservations.push(body);
        raw.mounts.push({id:body.reservationId,hostname:origin.hostname,mount_path:`${origin.path_prefix}${body.slug}/`,generation:1,enabled:true});
        return parseFrameworkPublications(raw,ID);
      },
      reviewFrameworkPublication:async(project,source,body)=>{
        assert.equal(project,ID); assert.equal(source,ID); reviews.push(body);
        return parseFrameworkPublications(raw,ID);
      },
      approveFrameworkPublication:async()=>assert.fail('Address selection must not approve a release')
    };
    const root=FrameworkPublications({adapter,projectId:ID,sourceProjectId:ID});
    document.body.append(root); await tick();
    assert.equal(reservations.length,0);
    for(const origin of origins) {
      const hosting=root.querySelector('[aria-label="Public hosting"]');
      hosting.value=origin.id; hosting.dispatchEvent(new dom.window.Event('change'));
      const name=root.querySelector('[aria-label="Address name"]');
      name.value='field-atlas'; name.dispatchEvent(new dom.window.Event('input'));
      assert.equal(root.querySelector('output').textContent,`https://${origin.hostname}${origin.path_prefix}field-atlas/`);
      button(root,'Reserve address').click(); await tick();
    }
    assert.equal(new Set(reservations.map(r=>r.reservationId)).size,3);
    assert.equal(reviews.length,0);
    const destinations=root.querySelector('[aria-label="Publication destination"]');
    assert.deepEqual([...destinations.options].map(o=>o.textContent),
      origins.map(o=>`https://${o.hostname}${o.path_prefix}field-atlas/`));
    destinations.value=reservations[2].reservationId;
    button(root,'Prepare publication review').click(); await tick();
    assert.equal(reviews.length,1);
    assert.equal(reviews[0].mountId,reservations[2].reservationId);
    assert.equal(reviews[0].buildJobId,ID);
    assert.equal(reviews[0].resultChecksumSha256,'a'.repeat(64));
  } finally {globalThis.document=previous;dom.window.close();}
});

test('address client validates scope and sends only an explicit reservation request', async () => {
  const client = new OpenGeoApiClient({tokenProvider: () => 'fixture'});
  const calls = [];
  client.request = async (...args) => {calls.push(args); return {...fixture(), reviews: []};};
  const body = {reservationId: ID, originId: ID, slug: 'atlas'};
  for (const change of [{slug:'../atlas'}, {slug:'/atlas/'}, {slug:''}, {originId:'foreign'}, {reservationId:'invalid'}]) {
    await assert.rejects(client.reserveFrameworkPublicationDestination(ID, ID, {...body, ...change}));
  }
  await assert.rejects(client.reserveFrameworkPublicationDestination('invalid', ID, body));
  await assert.rejects(client.reserveFrameworkPublicationDestination(ID, 'invalid', body));
  assert.equal(calls.length, 0);
  const result = await client.reserveFrameworkPublicationDestination(ID, ID, body);
  assert.equal(result.sourceProjectId, ID);
  assert.deepEqual(calls, [[`/projects/${ID}/source-projects/${ID}/publications/destinations`, {
    method: 'POST', body: {reservation_id: ID, origin_id: ID, slug: 'atlas', acknowledgment: 'reserve-address-without-publishing'}
  }]]);
});

test("saved deployment progress reloads and rollback prepares a new review without publishing", async () => {
  const dom = new JSDOM("<body></body>"); const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    const raw = fixture(); let reviews = 0;
    raw.reviews[0].approved_at = "2026-09-10T01:00:00Z";
    raw.reviews[0].deployment = {stage: "copying", completed_files: 2, total_files: 8,
      error_code: null, updated_at: "2026-09-10T01:01:00Z", release_prefix: null};
    const adapter = {getFrameworkPublications: async () => parseFrameworkPublications(raw, ID),
      listObservableBuildJobs: async () => [],
      reviewFrameworkPublication: async (project, source, request) => {
        assert.equal(request.buildJobId, ID); assert.equal(request.mountId, ID);
        assert.notEqual(request.reviewId, ID); assert.equal(request.resultChecksumSha256, "a".repeat(64));
        reviews++; return parseFrameworkPublications(raw, ID);
      }};
    const root = FrameworkPublications({adapter, projectId: ID, sourceProjectId: ID});
    await tick(); assert.match(root.textContent, /2 of 8 files retained/);
    raw.reviews[0].deployment = {...raw.reviews[0].deployment, stage: "deployed", completed_files: 8, release_prefix: `releases/framework-${ID}`};
    button(root, "Reload publication reviews").click(); await tick();
    assert.match(root.textContent, /Published release:/);
    assert.equal(button(root, "Resume approved publication"), undefined);
    assert.equal(root.querySelector("a").href, "https://opengeo.tools/analysis/reading-beyond-visible/");
    assert.equal(reviews, 0);
    button(root, "Prepare rollback to this build").click(); await tick();
    assert.equal(reviews, 1);
    raw.reviews[0].deployment.release_prefix = "releases/unrelated";
    assert.throws(() => parseFrameworkPublications(raw, ID), /Invalid publication deployment/);
  } finally {globalThis.document = previous; dom.window.close();}
});

const distributionMetadata = (change = {}) => ({sourceRevisionId: ID, sourceManifestChecksumSha256: 'a'.repeat(64),
  compilerImageDigest: 'sha256:' + 'b'.repeat(64), artifactInputId: null, artifactInputsChecksumSha256: null,
  outputProfile: 'default-32m', archiveFiles: [{path: 'data/original.tif', attachmentId: ID, datasetId: ID,
    datasetVersionId: ID, resourceId: ID, resourceVersionId: ID, title: 'Original land cover', sizeBytes: 64_912_721,
    checksumSha256: 'c'.repeat(64), license: 'CC-BY-4.0', attribution: 'Provider credit', canPublish: true}],
  artifacts: [], approvals: [], ...change});
const distributionApproval = (id = ID, change = {}) => ({id, checksum: 'd'.repeat(64), revoked: false,
  manifest: {sourceProjectId: ID, sourceRevisionId: ID, sourceManifestChecksumSha256: 'a'.repeat(64),
    compilerImageDigest: 'sha256:' + 'b'.repeat(64), outputProfile: 'default-32m', artifactInputsChecksumSha256: null, ...change}});
const publicFile = (change = {}) => ({referenceId: ID, path: 'data/source.tif', kind: 'referenced-public-file',
  custody: 'referenced', datasetId: ID, sourceVersion: 1, resourceId: ID, resourceVersionId: ID,
  resourceVersionNumber: 1, currentResourceVersionId: ID, distributionId: 'original-tiff',
  url: 'https://data.example.org/landcover.tif', contentType: 'image/tiff', sizeBytes: 33_554_433,
  checksumSha256: 'c'.repeat(64), title: 'Land cover source', license: null, attribution: null,
  canPublish: true, ...change});
async function inputFixture(adapter, options = {}) {
  const dom = new JSDOM('<body></body>'); const previous = globalThis.document; globalThis.document = dom.window.document;
  const root = PublicationInputDistribution({adapter, projectId: ID, sourceProjectId: ID, sourceRevisionId: ID, canManage: true, ...options});
  document.body.append(root);
  return {root, dom, change(control, value) {if (control.type === 'checkbox') control.checked = value; else control.value = value;
    control.dispatchEvent(new dom.window.Event(control.type === 'text' ? 'input' : 'change'));},
    close() {globalThis.document = previous; dom.window.close();}};
}
test('linked file review is deliberate and larger private output requires its exact acknowledgement', async () => {
  let reads = 0; const f = await inputFixture({getPublicationInputDistributions: async () => {reads++; return distributionMetadata();}});
  try {
    await tick(); assert.equal(reads, 0); assert.deepEqual(f.root.getBuildOptions(), {});
    f.change(f.root.querySelector('select'), 'archive-96m');
    assert.equal(f.root.isBuildAllowed(), false); assert.throws(() => f.root.getBuildOptions(), /Allow the larger/);
    f.change(f.root.querySelector('input[name="allow-up-to-96-mib-output"]'), true);
    assert.deepEqual(f.root.getBuildOptions(), {outputProfile: 'archive-96m', sizeAcknowledgment: 'allow-up-to-96-mib-output'});
    button(f.root, 'Review linked files').click(); await tick();
    assert.equal(reads, 1); assert.match(f.root.textContent, /64,912,721 bytes/);
    assert.match(f.root.textContent, /86,550,296 bytes/); assert.match(f.root.textContent, /before HTML and runtime code/);
    assert.match(f.root.textContent, /build time, storage and download traffic/);
  } finally {f.close();}
});
test('publication editor authority cannot substitute for Dataset publication permission', async () => {
  let writes = 0; const data = distributionMetadata(); data.archiveFiles[0].canPublish = false;
  const f = await inputFixture({getPublicationInputDistributions: async () => data, createPublicationInputDistribution: async () => {writes++;}});
  try {
    button(f.root, 'Review linked files').click(); await tick();
    assert.equal(button(f.root, 'Approve these files for public sharing').disabled, true);
    assert.match(f.root.textContent, /Dataset publication permission is required/);
    assert.deepEqual(f.root.getBuildOptions(), {}); assert.equal(writes, 0);
  } finally {f.close();}
});
test('public source file sharing requires explicit terms and keeps private build options separate', async () => {
  let reads = 0; const writes = [];
  const file = publicFile();
  const f = await inputFixture({
    getPublicationInputDistributions: async () => {reads++; return distributionMetadata({archiveFiles: [], referencedFiles: [file]});},
    createPublicationInputDistribution: async (...args) => {writes.push(args[3]); return distributionApproval(args[3].approvalId);}
  });
  try {
    await tick(); assert.equal(reads, 0); assert.equal(writes.length, 0);
    assert.match(f.root.textContent, /Linked file size: not reviewed/);
    button(f.root, 'Review linked files').click(); await tick();
    assert.equal(reads, 1); assert.match(f.root.textContent, /Source files/);
    assert.doesNotMatch(f.root.textContent, /Archived files/);
    assert.equal(f.root.querySelector('a').href, file.url);
    assert.match(f.root.textContent, /read from the public source when building/);
    assert.equal((await f.root.ensureReviewed()).requiresApproval, true);
    const approve = button(f.root, 'Approve these files for public sharing');
    const terms = f.root.querySelector('[aria-label="License for data/source.tif"]');
    assert.equal(terms.value, ''); assert.equal(approve.disabled, true);
    f.change(terms, 'CC-BY-4.0');
    f.change(f.root.querySelector('[aria-label="Attribution for data/source.tif"]'), 'ICIMOD · original source');
    assert.equal(approve.disabled, true);
    f.change(f.root.querySelector('input[name^="share-file-"]'), true);
    assert.equal(approve.disabled, false); approve.click(); await tick();
    assert.equal(writes.length, 1); assert.deepEqual(writes[0].archiveRights, []);
    assert.deepEqual(writes[0].referencedRights, [{referenceId: ID, relativePath: file.path,
      license: 'CC-BY-4.0', attribution: 'ICIMOD · original source', acknowledgment: 'publish-exact-referenced-file'}]);
    assert.equal(f.root.getBuildOptions().distributionApprovalId, writes[0].approvalId);
    assert.deepEqual(f.root.getBuildOptions({purpose: 'preview'}), {});
    f.change(terms, 'CC0-1.0'); assert.equal(f.root.getSelectedApproval(), null);
    assert.equal(writes.length, 1);
  } finally {f.close();}
});
test('a readable public source file does not grant its publication permission', async () => {
  const f = await inputFixture({
    getPublicationInputDistributions: async () => distributionMetadata({archiveFiles: [],
      referencedFiles: [publicFile({canPublish: false})]}),
    createPublicationInputDistribution: async () => assert.fail('Read access cannot approve public distribution')
  });
  try {
    button(f.root, 'Review linked files').click(); await tick();
    assert.equal(button(f.root, 'Approve these files for public sharing').disabled, true);
    assert.equal(f.root.querySelector('[aria-label="License for data/source.tif"]').disabled, true);
    assert.deepEqual(await f.root.ensureReviewed(), {requiresApproval: true, distributionApprovalId: null});
    assert.deepEqual(f.root.getBuildOptions({purpose: 'preview'}), {});
  } finally {f.close();}
});
test('a lost approval response is recovered by its exact saved identity without another write', async () => {
  let saved = null; const writes = [], reads = [];
  const f = await inputFixture({getPublicationInputDistributions: async (...args) => {reads.push(args); return distributionMetadata({approvals: saved ? [saved] : []});},
    createPublicationInputDistribution: async (...args) => {writes.push(args[3]); saved = distributionApproval(args[3].approvalId); throw Error('response lost');}});
  try {
    button(f.root, 'Review linked files').click(); await tick();
    const approvalButton = button(f.root, 'Approve these files for public sharing');
    assert.equal(approvalButton.disabled, true);
    f.change(f.root.querySelector('input[name^="share-file-"]'), true);
    assert.equal(approvalButton.disabled, false); approvalButton.click(); await tick();
    assert.equal(writes.length, 1); assert.equal(approvalButton.disabled, true); assert.equal(f.root.getSelectedApproval(), null);
    assert.deepEqual(writes[0].archiveRights, [{attachmentId: ID, relativePath: 'data/original.tif', license: 'CC-BY-4.0',
      attribution: 'Provider credit', acknowledgment: 'publish-exact-archive-file'}]);
    button(f.root, 'Check saved sharing approvals').click(); await tick();
    assert.equal(reads.length, 2); assert.equal(writes.length, 1); assert.equal(f.root.getSelectedApproval().id, saved.id);
    assert.deepEqual(f.root.getBuildOptions(), {distributionApprovalId: saved.id});
    f.root.setContext({sourceRevisionId: 'different'}); assert.equal(f.root.getSelectedApproval(), null);
    assert.deepEqual(f.root.getBuildOptions(), {});
  } finally {f.close();}
});
test('a private map cannot silently become public and saved approval revocation remains explicit', async () => {
  const map = {artifactId: ID, version: 2, path: 'maps/example.html', projectId: ID, resourceId: ID, canPublish: true, releases: []};
  const f = await inputFixture({getPublicationInputDistributions: async () => distributionMetadata({archiveFiles: [], artifacts: [map]}),
    createPublicationInputDistribution: async () => assert.fail('A private map cannot be approved')});
  try {
    button(f.root, 'Review linked files').click(); await tick();
    assert.equal(button(f.root, 'Approve these files for public sharing').disabled, true);
    assert.match(f.root.textContent, /needs an approved public release/);
    assert.equal(f.root.querySelector('a').getAttribute('href'), `/workspaces?project=${ID}&manage=resources#resource-${ID}`);
  } finally {f.close();}
  let revocations = 0;
  const saved = distributionApproval();
  const g = await inputFixture({getPublicationInputDistributions: async () => distributionMetadata({approvals: [saved]}),
    revokePublicationInputDistribution: async (...args) => {assert.equal(args[3], ID); revocations++;}});
  try {
    button(g.root, 'Review linked files').click(); await tick(); button(g.root, 'Use this approval').click();
    assert.equal(g.root.getSelectedApproval().id, ID);
    button(g.root, 'Revoke').click(); await tick(); assert.equal(revocations, 0);
    g.change(g.root.querySelector('input[name^="revoke-"]'), true); button(g.root, 'Revoke').click(); await tick();
    assert.equal(revocations, 1); assert.equal(g.root.getSelectedApproval(), null); assert.equal(saved.revoked, true);
  } finally {g.close();}
});
test('public review binds file approval to the existing successful preview and never recompiles it', async () => {
  const dom = new JSDOM('<body></body>'); const previous = globalThis.document; globalThis.document = dom.window.document;
  let metadataReads = 0, approvals = 0; const reviews = [];
  const build = {id: ID, sourceProjectId: ID, sourceRevisionId: ID, sourceRevisionNumber: 2, state: 'succeeded',
    resultChecksumSha256: 'e'.repeat(64), request: {sourceManifestChecksumSha256: 'a'.repeat(64), compilerImageDigest: 'sha256:' + 'b'.repeat(64)}};
  const adapter = {getFrameworkPublications: async () => parseFrameworkPublications({...fixture(), reviews: []}, ID),
    listObservableBuildJobs: async () => [build], createObservableBuildJob: async () => assert.fail('Review must reuse this exact build'),
    getPublicationInputDistributions: async (...args) => {assert.deepEqual(args[3], {buildJobId: ID}); metadataReads++; return distributionMetadata();},
    createPublicationInputDistribution: async (...args) => {approvals++; return distributionApproval(args[3].approvalId);},
    reviewFrameworkPublication: async (...args) => {reviews.push(args[2]); return parseFrameworkPublications({...fixture(), reviews: []}, ID);}};
  try {
    const root = FrameworkPublications({adapter, projectId: ID, sourceProjectId: ID}); document.body.append(root); await tick();
    assert.equal(metadataReads, 0);
    button(root, 'Prepare publication review').click(); await tick();
    assert.equal(metadataReads, 1); assert.equal(reviews.length, 0); assert.match(root.textContent, /existing build will be reused/);
    const ack = root.querySelector('input[name^="share-file-"]'); ack.checked = true; ack.dispatchEvent(new dom.window.Event('change'));
    button(root, 'Approve these files for public sharing').click(); await tick(); assert.equal(approvals, 1);
    button(root, 'Prepare publication review').click(); await tick();
    assert.equal(reviews.length, 1); assert.equal(reviews[0].buildJobId, ID);
    assert.equal(reviews[0].distributionApprovalId.length, 36); assert.equal(metadataReads, 1);
  } finally {globalThis.document = previous; dom.window.close();}
});
