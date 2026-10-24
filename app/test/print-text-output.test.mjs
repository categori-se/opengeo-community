import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {appendPrintTextFrames, reflowPrintPdfTextFrames} from "../src/lib/printTextSvg.js";
import {printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout} from "../src/lib/printLayouts.js";
import {preparePrintVectorPdfSvg} from "../src/lib/printVectorPdf.js";

function fixture() {
  const dom = new JSDOM("<!doctype html><body></body>"), doc = dom.window.document;
  const record = {id:"map",version:2,name:"Text sheet",definition:{layers:[],mapViews:[{center:[0,0],zoom:4,pitch:0,bearing:0}]}};
  const layout = newProjectPrintLayout(record,"layout");layout.legend=false;layout.northArrow=false;layout.scaleBar=false;
  layout.textFrames=[{id:"text",type:"text",title:"Literal note",text:"A  <tag>&\n\nCafé Ω",xMm:20,yMm:40,widthMm:90,heightMm:40,fontSizePt:10,color:"#123456",background:"#fff7ed",alignment:"right"}];
  return {dom,doc,layout,svg:doc.createElementNS("http://www.w3.org/2000/svg","svg")};
}

test("literal output preserves spaces, blank lines, escaping, colors and one alignment offset",()=>{
  const {dom,layout,svg}=fixture();try {
    appendPrintTextFrames(svg,layout);const lines=[...svg.querySelectorAll("text")], frame=layout.textFrames[0];
    assert.deepEqual(lines.map(n=>n.textContent),["A  <tag>&","","Café Ω"]);
    assert.equal(svg.querySelector("tag"),null);assert.ok(lines.every(n=>n.getAttribute("xml:space")==="preserve"&&n.getAttribute("fill")==="#123456"&&n.getAttribute("text-anchor")==="start"));
    assert.equal(svg.querySelector('[data-print-text-frame] rect').getAttribute("fill"),"#fff7ed");
    const size=10*25.4/72;
    assert.ok(Math.abs(Number(lines[0].getAttribute("x"))-(frame.xMm+frame.widthMm-1-Array.from(lines[0].textContent).length*size))<1e-9);
    assert.equal(svg.querySelector("defs rect").getAttribute("width"),"90");
    const serialized=new dom.window.XMLSerializer().serializeToString(svg);assert.match(serialized,/&lt;tag&gt;&amp;/);
    reflowPrintPdfTextFrames(svg,layout,"ExactPrintFont");assert.equal(svg.querySelectorAll('[data-print-text-frame]').length,1);
    assert.equal(svg.querySelectorAll("[id=print-text-0]").length,1);assert.equal(svg.querySelector("text").getAttribute("font-family"),"ExactPrintFont");
  }finally{dom.window.close();}
});

test("export refuses overflow while preview explains it without silently truncating body",()=>{
  const {dom,layout,svg}=fixture();try {
    layout.textFrames[0].heightMm=5;assert.throws(()=>appendPrintTextFrames(svg,layout),/height/);
    const preview=svg.cloneNode(false);appendPrintTextFrames(preview,layout,{preview:true});assert.match(preview.textContent,/Increase text frame/);
    assert.equal(layout.textFrames[0].text,"A  <tag>&\n\nCafé Ω");
  }finally{dom.window.close();}
});

test("owned page keeps text independent of required source notes and direct PDF accepts only preserving text whitespace",()=>{
  const {dom,layout}=fixture(), prior=globalThis.document;globalThis.document=dom.window.document;
  try {
    const svg=printPageSvg(layout,new Map(),layout.id,{preview:true});
    assert.ok(svg.querySelector('[data-print-text-frame]'));assert.match(svg.textContent,/capture/i);
    // Minimal closed vector fixture exercises the converter's attribute boundary.
    svg.querySelectorAll("image").forEach(n=>n.remove());
    const metadata=svg.querySelector("metadata"), data=JSON.parse(metadata.textContent);data.mapRepresentation="vector";metadata.textContent=JSON.stringify(data);
    const map=dom.window.document.createElementNS(svg.namespaceURI,"g");map.setAttribute("data-print-vector-map","a".repeat(64));svg.append(map);
    assert.doesNotThrow(()=>preparePrintVectorPdfSvg(svg,layout));
    const line=svg.querySelector('[data-print-text-frame] text');line.setAttribute("xml:space","default");assert.throws(()=>preparePrintVectorPdfSvg(svg,layout),/whitespace/);
    line.setAttribute("xml:space","preserve");map.setAttribute("xml:space","preserve");assert.throws(()=>preparePrintVectorPdfSvg(svg,layout),/whitespace/);
  }finally{globalThis.document=prior;dom.window.close();}
});
