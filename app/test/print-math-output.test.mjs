import assert from "node:assert/strict";
import {test} from "node:test";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {JSDOM} from "jsdom";
import {jsPDF} from "jspdf";
import {preparePrintMath, sanitizedPrintMath, printMathLegalFiles} from "../src/lib/printMathSvg.js";
import {appendPrintTextFrames, reflowPrintPdfTextFrames} from "../src/lib/printTextSvg.js";
import {printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout} from "../src/lib/printLayouts.js";
import {preparePrintVectorPdfSvg, registerPrintPdfFontAttribution, registerPrintPdfMetadata} from "../src/lib/printVectorPdf.js";
await preparePrintMath();
const source=String.raw`\frac{\alpha+\sqrt{x^2+1}}{\sum_{i=1}^{n} i}\quad\begin{pmatrix}1&2\\3&4\end{pmatrix}`;
function fixture(){const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
 const record={id:'map',name:'Equation sheet',definition:{layers:[],mapViews:[{center:[0,0],zoom:4,pitch:0,bearing:0}]}},layout=newProjectPrintLayout(record,'layout');layout.legend=false;layout.northArrow=false;layout.scaleBar=false;
 layout.textFrames=[{id:'math',type:'math',title:'Equation',text:source,xMm:20,yMm:40,widthMm:160,heightMm:40,fontSizePt:14,color:'#123456',background:'none',alignment:'right'}];
 return{dom,doc,layout,svg:doc.createElementNS('http://www.w3.org/2000/svg','svg')};}

test('equation uses real detached vector glyphs with physical geometry, source and source-independent literal text',()=>{
 const{dom,layout,svg}=fixture();try{appendPrintTextFrames(svg,layout);const math=svg.querySelector('[data-print-math]');assert.ok(math);assert.ok(math.querySelectorAll('path').length>15);assert.equal(math.querySelector('text,use,svg,image,style,foreignObject'),null);assert.equal(math.getAttribute('fill'),'#123456');assert.equal(math.querySelector('title').textContent,source);assert.match(math.getAttribute('transform'),/^translate\(.+\) scale\(.+\) translate\(/);
 const before=math.outerHTML;reflowPrintPdfTextFrames(svg,layout,'ExactPrintFont');assert.equal(svg.querySelector('[data-print-math]').outerHTML,before);assert.equal(svg.querySelectorAll('[data-print-math]').length,1);
 layout.textFrames[0].widthMm=10;assert.throws(()=>appendPrintTextFrames(svg.cloneNode(false),layout),/exceeds.*frame/);
 }finally{dom.window.close();}
});

test('math SVG reconstruction rejects executable, linked, text fallback and malformed geometry content',()=>{
 const{dom,doc}=fixture();try{const wrap=s=>`<svg xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
 for(const input of ['<script/>','<use href="#a"/>','<text>fallback</text>','<image href="https://example.invalid/x"/>','<svg/>','<path d="M0 0" onclick="x"/>','<g style="fill:red"/>','<g transform="translate(Infinity)"/>','<path d="M0 0 url(x)"/>','<rect x="NaN"/>'])assert.throws(()=>sanitizedPrintMath(doc,wrap(input)),/equation/);
 assert.throws(()=>sanitizedPrintMath(doc,'<!DOCTYPE svg><svg/>'),/equation/);assert.doesNotThrow(()=>sanitizedPrintMath(doc,wrap('<g transform="scale(1 -1)"><path d="M0 0L1 1Z"/></g>')));
 }finally{dom.window.close();}
});

test('equation source/full font terms stay in owned SVG metadata and six fixed plain-text PDF attachments',async()=>{
 const{dom,layout}=fixture(),prior=globalThis.document;globalThis.document=dom.window.document;
 try{const svg=printPageSvg(layout,new Map(),'layout',{preview:true}),record=JSON.parse(svg.querySelector('metadata').textContent);assert.equal(record.math.representation,'outlined-glyphs');assert.equal(record.math.licenses.length,4);assert.equal(record.layout.textFrames[0].text,source);assert.ok(svg.querySelector('[data-print-math]'));
 const metadata=svg.querySelector('metadata');record.mapRepresentation='vector';metadata.textContent=JSON.stringify(record);const map=dom.window.document.createElementNS(svg.namespaceURI,'g');map.setAttribute('data-print-vector-map','a'.repeat(64));svg.append(map);assert.doesNotThrow(()=>preparePrintVectorPdfSvg(svg,layout));
 const legal=printMathLegalFiles(layout);for(const file of legal)assert.equal(createHash('sha256').update(file.body).digest('hex'),file.sha256);
 const root=new URL('../src/assets/render-fonts/opengeo-open-sans-v1/1/',import.meta.url),fixed=await Promise.all(['LICENSE.txt','NOTICE.txt'].map(name=>readFile(new URL(name,root))));
 const files=[{name:'OpenSans-LICENSE.txt',bytes:fixed[0]},{name:'OpenSans-NOTICE.txt',bytes:fixed[1]},...legal.map(f=>({name:f.name,bytes:new TextEncoder().encode(f.body)}))];const pdf=new jsPDF();registerPrintPdfFontAttribution(pdf,files);const output=pdf.output();assert.equal((output.match(/\/Type \/EmbeddedFile/g)??[]).length,6);assert.match(output,/MathJax-TeX-FONT-NOTICE/);assert.match(output,/SIL OPEN FONT LICENSE/);assert.match(output,/Design Science/);
 const tree=output.match(/<< \/Names \[([^\]]+)\] >>/)[1];const names=[...tree.matchAll(/\(([^)]+)\)/g)].map(x=>x[1]);assert.deepEqual(names,[...names].sort());
 }finally{globalThis.document=prior;dom.window.close();}
});


test('PDF metadata preserves literal source through one XML encoding, including matrix ampersands and markup',()=>{
 const record={layout:{textFrames:[{type:'math',text:source},{type:'text',text:'Literal <map> & &amp; source'}]},notice:'Copyright A & B'};
 const pdf=new jsPDF();registerPrintPdfMetadata(pdf,record);const serialized=pdf.output(),xml=serialized.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/)[0],dom=new JSDOM(xml,{contentType:'application/xml'});
 try{const value=[...dom.window.document.querySelectorAll('*')].find(n=>n.localName==='metadata');assert.deepEqual(JSON.parse(value.textContent),record);}finally{dom.window.close();}
});
