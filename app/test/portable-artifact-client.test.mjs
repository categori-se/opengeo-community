import assert from 'node:assert/strict';
import {it} from 'node:test';
import {OpenGeoApiClient} from '../src/lib/apiClient.js';
it('routes portable edition operations and accepts retained object history',async()=>{
  const id='11111111-1111-4111-8111-111111111111', calls=[];
  const client=Object.create(OpenGeoApiClient.prototype);
  client.request=async(...args)=>{calls.push(args);return {id,revision:1,current_version_number:null,version_number:null,editions:[{version_number:1,output_object_id:id}]};};
  await client.readArtifactEdition(id,id,null,true,'portable-map-html');
  assert.match(calls[0][0],/metadata_only=true&representation=portable-map-html$/);
  await client.selectArtifactCurrent(id,id,1,1,'portable-map-html');
  assert.match(calls[1][0],/current\?representation=portable-map-html$/);
  await assert.rejects(client.readArtifactEdition(id,id,null,false,'invalid'));
  assert.equal(calls.length,2);
});

const artifactId = '11111111-1111-4111-8111-111111111111';
const shareId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const shareUrl = `https://viewer.example/shared/organizations/${accountId}/artifact-shares/${shareId}/view`;
const shareDraft = () => ({creation_key: otherId, version_number: 2, title: 'Private field map', password: '  literal passphrase  '});
const shareRecord = () => ({id: shareId, artifact_id: artifactId, version_number: 2, title: 'Private field map',
  created_at: '2026-10-07T12:00:00Z', revoked_at: null});
function shareClient(payload, {baseUrl = 'https://api.example', tokenProvider = () => 'owner-token',
  organizationProvider = () => accountId} = {}) {
  const calls = [];
  const client = new OpenGeoApiClient({baseUrl, tokenProvider, organizationProvider,
    fetchImplementation: async (url, options) => {
      calls.push({url, options});
      return new Response(JSON.stringify(typeof payload === 'function' ? payload(url, options) : payload),
        {status: 200, headers: {'content-type': 'application/json'}});
    }});
  return {client, calls};
}
function shareContext(client) {
  return {tokenProvider: client.tokenProvider, organizationProvider: client.organizationProvider,
    baseUrl: client.baseUrl, token: 'owner-token', organization: accountId};
}

it('routes protected share history, creation and revocation without changing literal passwords', async () => {
  const {client, calls} = shareClient(url => url.endsWith('/revoke') ? {id: shareId, revoked: true}
    : url.includes('?') ? {can_publish: true, records: [{...shareRecord(), view_url: shareUrl}], has_more: false}
    : {...shareRecord(), view_url: shareUrl});
  const context = shareContext(client);
  const history = await client.listArtifactShares(artifactId, {limit: 5, offset: 10, context});
  assert.deepEqual(history, {can_publish: true, records: [{...shareRecord(), view_url: shareUrl}], has_more: false});
  assert.equal(calls[0].url, `https://api.example/artifacts/${artifactId}/shares?limit=5&offset=10`);
  const draft = shareDraft();
  assert.deepEqual(await client.createArtifactShare(artifactId, draft, {context}), {id: shareId, view_url: shareUrl});
  assert.deepEqual(JSON.parse(calls[1].options.body), draft);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(new Headers(calls[1].options.headers).get('X-OpenGeo-Organization'), accountId);
  assert.deepEqual(await client.revokeArtifactShare(shareId, {context}), {id: shareId, revoked: true});
  assert.equal(calls[2].url, `https://api.example/artifact-shares/${shareId}/revoke`);
  assert.equal(calls[2].options.body, undefined);
  assert.equal(await client.protectedArtifactShareUrl(shareId), shareUrl);
  assert.deepEqual([...client.protectedArtifactUrls.values()], [shareUrl]);
});

it('rejects invalid or extended share drafts before sending a write', async () => {
  const {client, calls} = shareClient({id: shareId});
  for (const draft of [null, {...shareDraft(), extra: true}, {...shareDraft(), creation_key: 'invalid'},
    {...shareDraft(), version_number: 0}, {...shareDraft(), version_number: 1.5},
    {...shareDraft(), title: '   '}, {...shareDraft(), title: 'x'.repeat(201)},
    {...shareDraft(), password: 'x'.repeat(11)}, {...shareDraft(), password: 'x'.repeat(129)},
    {...shareDraft(), password: 123456789012}]) {
    await assert.rejects(client.createArtifactShare(artifactId, draft), TypeError);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await client.createArtifactShare(artifactId, shareDraft()), {id: shareId});
  assert.equal(calls.length, 1);
});

it('refuses leaked credentials and malformed share history without caching any URLs', async () => {
  let history;
  const {client} = shareClient(() => history);
  const valid = () => ({can_publish: true, records: [{...shareRecord(), view_url: shareUrl}], has_more: false});
  for (const field of ['password', 'password_hash', 'credentials']) {
    history = valid();
    history.records.push({...shareRecord(), [field]: 'sensitive'});
    await assert.rejects(client.listArtifactShares(artifactId), {code: 'invalid_api_response'});
    assert.equal(client.protectedArtifactUrls.size, 0);
    history = {...valid(), [field]: 'sensitive'};
    await assert.rejects(client.listArtifactShares(artifactId), {code: 'invalid_api_response'});
  }
  for (const change of [{artifact_id: otherId}, {id: 'invalid'}, {version_number: 0}, {title: ' '},
    {title: 'x'.repeat(201)}, {created_at: 'invalid'}, {revoked_at: 'invalid'}]) {
    history = valid();
    Object.assign(history.records[0], change);
    await assert.rejects(client.listArtifactShares(artifactId), {code: 'invalid_api_response'});
  }
  history = {...valid(), can_publish: 'true'};
  await assert.rejects(client.listArtifactShares(artifactId), {code: 'invalid_api_response'});
  history = {...valid(), has_more: 0};
  await assert.rejects(client.listArtifactShares(artifactId), {code: 'invalid_api_response'});
  assert.equal(client.protectedArtifactUrls.size, 0);
});

it('validates protected viewer URLs and keeps canonical URLs scoped to the selected account', async () => {
  let receipt, account = accountId;
  const {client} = shareClient(() => receipt, {baseUrl: '/api', organizationProvider: () => account});
  for (const view_url of ['http://viewer.example' + new URL(shareUrl).pathname,
    shareUrl + '?password=secret', shareUrl + '#token', shareUrl.replace('viewer.example', 'user:pass@viewer.example'),
    shareUrl.replace(accountId, otherId), shareUrl.replace(shareId, otherId), shareUrl + '/extra',
    shareUrl.replace('/shared/', '/api/api/shared/'), 'invalid']) {
    receipt = {id: shareId, view_url};
    await assert.rejects(client.createArtifactShare(artifactId, shareDraft()), {code: 'invalid_api_response'});
  }
  receipt = {id: shareId, view_url: shareUrl};
  await client.createArtifactShare(artifactId, shareDraft());
  assert.equal(await client.protectedArtifactShareUrl(shareId), shareUrl);
  const studioUrl = shareUrl.replace('https://viewer.example/', 'https://studio.opengeo.tools/api/');
  receipt = {id: shareId, view_url: studioUrl};
  await client.createArtifactShare(artifactId, shareDraft());
  assert.equal(await client.protectedArtifactShareUrl(shareId), studioUrl);
  account = otherId;
  await assert.rejects(client.protectedArtifactShareUrl(shareId), {code: 'invalid_api_response'});
  const {client: direct} = shareClient({id: shareId});
  assert.equal(await direct.protectedArtifactShareUrl(shareId),
    `https://api.example/shared/organizations/${accountId}/artifact-shares/${shareId}/view`);
  const {client: studio} = shareClient({id: shareId}, {baseUrl: 'https://studio.opengeo.tools/api'});
  assert.equal(await studio.protectedArtifactShareUrl(shareId), studioUrl);
});

it('rejects malformed create and revocation receipts', async () => {
  let receipt;
  const {client} = shareClient(() => receipt);
  for (const value of [{id: 'invalid'}, {id: shareId, password_hash: 'leaked'}, {id: shareId, password: 'leaked'},
    {...shareRecord(), artifact_id: otherId}, {...shareRecord(), version_number: 1},
    {...shareRecord(), created_at: 'invalid'}, {...shareRecord(), title: ' '}]) {
    receipt = value;
    await assert.rejects(client.createArtifactShare(artifactId, shareDraft()), {code: 'invalid_api_response'});
  }
  for (const value of [{id: otherId, revoked: true}, {id: shareId, revoked: false}, {id: shareId, revoked: true, password_hash: 'leaked'}]) {
    receipt = value;
    await assert.rejects(client.revokeArtifactShare(shareId), {code: 'invalid_api_response'});
  }
});

it('blocks captured account or sign-in changes before share reads and writes', async () => {
  let token = 'owner-token', account = accountId;
  const {client, calls} = shareClient({id: shareId}, {tokenProvider: () => token, organizationProvider: () => account});
  const context = shareContext(client);
  const operations = [() => client.listArtifactShares(artifactId, {context}),
    () => client.createArtifactShare(artifactId, shareDraft(), {context}),
    () => client.revokeArtifactShare(shareId, {context})];
  for (const change of [() => {token = 'other-token';}, () => {token = 'owner-token'; account = otherId;}]) {
    change();
    for (const operation of operations) await assert.rejects(operation(), {code: 'collection_context_changed'});
  }
  assert.equal(calls.length, 0);
});

it('freezes supplied share context and rechecks sign-in immediately before dispatch', async () => {
  let token = 'owner-token';
  const {client, calls} = shareClient({id: shareId}, {tokenProvider: () => token});
  const context = shareContext(client), originalOptions = client.collectionRequestOptions;
  client.collectionRequestOptions = function(organization, captured) {
    assert.equal(Object.isFrozen(captured), true);
    assert.notEqual(captured, context);
    context.token = 'changed-caller-context';
    const options = originalOptions.call(this, organization, captured);
    return {...options, beforeDispatch: async () => {await options.beforeDispatch(); token = 'other-token';}};
  };
  await assert.rejects(client.createArtifactShare(artifactId, shareDraft(), {context}), {code: 'collection_context_changed'});
  assert.equal(calls.length, 0);
});
