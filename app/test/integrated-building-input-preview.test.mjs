import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBuildingInputPreviewRequest} from '../scripts/integrated-studio-analysis.mjs';

const path = '/projects/1938b127-af37-4c1e-8a90-c1d12282a172/datasets/2b53931f-1c74-4190-9174-56b502b65a3b/versions/0db0f821-65a0-4846-9204-6cffd0f0bead/objects/98000000-0000-4000-8000-000000000001/download';
const progress = {allowedDownloadPaths: [path]};

test('retained building preview admits normal reads and only its exact original ticket', () => {
  for (const method of ['GET', 'HEAD']) assert.doesNotThrow(() => assertBuildingInputPreviewRequest({path: '/datasets', method, progress}));
  assert.doesNotThrow(() => assertBuildingInputPreviewRequest({path, method: 'POST', progress}));
  for (const candidate of [path.replace('2b53931f', '3b53931f'), path.replace('0db0f821', '1db0f821'), path.replace('000000000001', '000000000002'), `${path}?copy=1`]) {
    assert.throws(() => assertBuildingInputPreviewRequest({path: candidate, method: 'POST', progress}), /exact admitted original/);
  }
});

test('retained building preview rejects writes, computation and unadmitted tickets', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.throws(() => assertBuildingInputPreviewRequest({path, method, progress}));
  for (const candidate of ['/projects', '/__local/upload', '/projects/p/maps', '/projects/p/uploads/request', '/projects/p/datasets/d/analysis-preview', '/datasets/d/metadata']) {
    assert.throws(() => assertBuildingInputPreviewRequest({path: candidate, method: 'POST', progress}));
  }
  assert.throws(() => assertBuildingInputPreviewRequest({path, method: 'POST', progress: {}}));
});
