import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {MapFilterEditor} from '../src/components/MapFilterEditor.js';
test('typed membership editor applies and negates lists without applying invalid input',()=>{
 const dom=new JSDOM('<body/>'),previous=globalThis.document;globalThis.document=dom.window.document;
 try {
  const values=[],editor=MapFilterEditor({layer:{},fields:['status'],onApply:v=>values.push(v)});
  const field=name=>editor.querySelector(`[aria-label="${name}"]`);
  const apply=[...editor.querySelectorAll('button')].find(b=>b.textContent==='Apply map filter');
  field('Filter operator').value='in';field('Filter operator').onchange();
  field('Filter value').value='reviewed\npending';apply.click();
  assert.deepEqual(values.at(-1),['in',['get','status'],['literal',['reviewed','pending']]]);
  field('Filter operator').value='not_in';field('Filter value type').value='number';field('Filter value').value='1\n2.5';apply.click();
  assert.deepEqual(values.at(-1),['!',['in',['get','status'],['literal',[1,2.5]]]]);
  field('Filter value').value='1\nwrong';apply.click();assert.equal(values.length,2);
  assert.match(editor.querySelector('[role=status]').textContent,/Unsupported/);
 }finally{globalThis.document=previous;dom.window.close();}
});

test('reopened filters restore controls and preserve literal text',()=>{
 const dom=new JSDOM('<body/>'),previous=globalThis.document;globalThis.document=dom.window.document;
 try{
  const saved=['!',['in',['get','status'],['literal',[' reviewed ','pending']]]];
  let applied;const editor=MapFilterEditor({layer:{filter:saved},fields:['other','status'],onApply:v=>applied=v});
  assert.equal(editor.querySelector('[aria-label="Filter field"]').value,'status');
  assert.equal(editor.querySelector('[aria-label="Filter operator"]').value,'not_in');
  assert.equal(editor.querySelector('[aria-label="Filter value"]').value,' reviewed \npending');
  [...editor.querySelectorAll('button')].find(b=>b.textContent==='Apply map filter').click();assert.deepEqual(applied,saved);
 }finally{globalThis.document=previous;dom.window.close();}
});
