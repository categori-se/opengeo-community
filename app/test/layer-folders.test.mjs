import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {LayerFolders, editLayerFolders} from '../src/components/LayerFolders.js';
const layers = [{layerId:'a',title:'Rivers'}, {layerId:'b',title:'Roads'}];
it('moves multiple references without changing sources and retains empty folders', () => {
  const tree = [{kind:'group',id:'old',title:'Old',children:[{kind:'layer',layerId:'a'}]}];
  const next = editLayerFolders(tree,layers,{ids:['a','b'],name:'Survey',id:'new'});
  assert.equal(tree[0].children.length,1);
  assert.equal(next[0].children.length,0);
  assert.deepEqual(next[1].children.map(n=>n.layerId),['a','b']);
  const root = editLayerFolders(next,layers,{ids:['a','b']});
  assert.equal(root[1].children.length,0);
  assert.deepEqual(root.slice(2).map(n=>n.layerId),['a','b']);
  assert.throws(()=>editLayerFolders(tree,layers,{ids:['a'],destination:'missing'}), /existing destination/);
});
it('creates a nested folder through the visible form and moves selected layers together', () => {
  const dom = new JSDOM('<body/>'); const previous = globalThis.document; globalThis.document = dom.window.document;
  try {
    let saved;
    const root = LayerFolders({tree:[{kind:'group',id:'parent',title:'Survey',children:[]}],layers,onApply:tree=>saved=tree});
    document.body.append(root);
    root.querySelector('select').value='parent';
    root.querySelector('input:not([type=checkbox])').value='Field work';
    [...root.querySelectorAll('button')].find(b=>b.textContent==='Select all').click();
    [...root.querySelectorAll('button')].find(b=>b.textContent==='Create folder').click();
    assert.equal(saved[0].children[0].title,'Field work');
    assert.deepEqual(saved[0].children[0].children.map(n=>n.layerId),['a','b']);
  } finally {globalThis.document=previous;dom.window.close();}
});
