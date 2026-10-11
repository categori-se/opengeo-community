import assert from 'node:assert/strict';
import {it} from 'node:test';
import {publicationSourceRoot} from '../src/lib/publicationSourceRoot.js';

it('uses the full Framework source root for nested entry pages', () => {
  assert.equal(publicationSourceRoot('src/methods/analysis.md',['package.json','src/methods/analysis.md']),'src');
  assert.equal(publicationSourceRoot('src/index.md',['package.json','src/index.md']),'src');
});
it('retains flat Framework routes instead of treating the entry parent as a root', () => {
  assert.equal(publicationSourceRoot('src/index.md',['src/index.md']),'');
  assert.equal(publicationSourceRoot('methods/analysis.md',['package.json','methods/analysis.md']),'');
  assert.equal(publicationSourceRoot('index.md',['index.md']),'');
});
it('keeps notebook and static publications inside their entry directory', () => {
  assert.equal(publicationSourceRoot('src/index.html',['src/index.html']),'src');
  assert.equal(publicationSourceRoot('notebooks/index.ipynb',['notebooks/index.ipynb']),'notebooks');
  assert.equal(publicationSourceRoot('index.ipynb',['index.ipynb']),'');
});
