import assert from "node:assert/strict";
import {it} from "node:test";
import {JSDOM} from "jsdom";
import {compareWfsSchemas} from "../src/lib/wfsSchemaComparison.js";
import {ProviderResponseComparison} from "../src/components/ProviderResponseComparison.js";

const fields='<x:element name="id" type="x:integer"/><x:element name="name" type="x:string"/>';
const schema=value=>`<x:schema xmlns:x="http://www.w3.org/2001/XMLSchema" xmlns:p="urn:facilities" xmlns:g="http://www.opengis.net/gml/3.2" targetNamespace="urn:facilities"><x:element name="facilities" type="p:Feature"/><x:complexType name="Feature"><x:complexContent><x:extension base="g:AbstractFeatureType"><x:sequence>${value}</x:sequence></x:extension></x:complexContent></x:complexType></x:schema>`;
it("compares selected WFS declarations by name and resolved type, with explicit unsupported cases",()=>{
 const dom=new JSDOM();const Parser=dom.window.DOMParser;
 const compare=(a,b,ref="p:facilities")=>compareWfsSchemas(a,b,ref,Parser);
 const a=schema(fields), b=schema('<x:element name="id" type="x:string" minOccurs="0"/><x:element name="status" type="x:string"/>');
 const result=compare(a,b);
 assert.equal(result.available,true);
 assert.deepEqual(result.changes.map(({kind,name})=>[kind,name]),[["changed","id"],["removed","name"],["added","status"]]);
 assert.equal(result.changes[0].after.minOccurs,"0");
 assert.deepEqual(compare(a,schema(fields.split("/>").slice(0,2).reverse().join("/>") + "/>")).changes,[]);
 assert.deepEqual(compare(a,a.replaceAll("x:","xs:").replace('xmlns:x=','xmlns:xs=')).changes,[]);
 for(const bad of [a.replace('targetNamespace="urn:facilities"','targetNamespace="urn:other"'),a.replace('g:AbstractFeatureType','p:Other'),a.replace('name="name"','name="id"'),a.replace('<x:sequence>','<x:choice>').replace('</x:sequence>','</x:choice>'),'<!DOCTYPE schema SYSTEM "https://invalid.test/schema">'+a,a.slice(0,-10)]) assert.equal(compare(a,bad).available,false);
 assert.equal(compare(a,b,"p:missing").available,false);
 dom.window.close();
});
it("shows field changes only after document selection and preserves raw XML",()=>{
 const dom=new JSDOM();const old=globalThis.document;globalThis.document=dom.window.document;
 try {
  const source={id:"old",content:schema(fields),sourceUrl:"https://example.org/wfs",retrievedAt:"2026-09-23"};
  const text=schema('<x:element name="id" type="x:integer"/>');
  const original=JSON.stringify(source);
  const root=ProviderResponseComparison({sources:[source],text,sourceType:"wfs",collectionRef:"p:facilities"});
  assert.equal(root.querySelector('[aria-label="WFS field changes"]'),null);
  const select=root.querySelector("select");select.value="0";select.dispatchEvent(new dom.window.Event("change"));
  assert.match(root.textContent,/removed: name/);assert.match(root.textContent,/does not change the registered field selection/);
  assert.equal([...root.querySelectorAll("pre")].at(-1).textContent,text);assert.equal(JSON.stringify(source),original);
 }finally{globalThis.document=old;dom.window.close();}
});
