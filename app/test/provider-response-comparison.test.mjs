import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {ProviderResponseComparison} from "../src/components/ProviderResponseComparison.js";
it("compares explicit source selection exactly without executing or normalizing source text",()=>{
 const dom=new JSDOM("<!doctype html>");const old=globalThis.document;globalThis.document=dom.window.document;
 try{
  const text='<img src="https://invalid.test/tracker">\n{"license":null}\n';
  const source={id:"urn:old:1",sourceUrl:"https://example.org/wfs",retrievedAt:"2026-01-01",content:text};
  const root=ProviderResponseComparison({sources:[source,{...source,id:"urn:old:2",content:text.trimEnd()}],text});
  assert.equal(root.querySelector("pre"),null);
  const select=root.querySelector("select");select.value="0";select.dispatchEvent(new dom.window.Event("change"));
  assert.match(root.textContent,/Exact source text is unchanged/);assert.equal(root.querySelector("pre").textContent,text);
  assert.equal(root.querySelector("img"),null);
  select.value="1";select.dispatchEvent(new dom.window.Event("change"));assert.match(root.textContent,/differs, beginning at line 2/);
  assert.equal(root.querySelectorAll("pre")[1].textContent,text);
  select.value="";select.dispatchEvent(new dom.window.Event("change"));assert.equal(root.querySelector("pre"),null);
  assert.equal(source.content,text);
  assert.match(ProviderResponseComparison({text}).textContent,/No earlier source text/);
 }finally{globalThis.document=old;dom.window.close();}
});
