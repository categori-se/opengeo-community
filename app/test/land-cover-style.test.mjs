import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {select} from 'd3';
import * as Plot from '@observablehq/plot';
import {chromium} from 'playwright';
import {StyleLibrary} from '../src/components/StyleLibrary.js';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {createLandCoverStyle, landCoverPresets, landCoverModuleSource} from '../src/lib/landCoverStyle.js';

const SVG = 'http://www.w3.org/2000/svg';
function scene() {return new JSDOM('<body/>');}
function svg(document) {const node = document.createElementNS(SVG, 'svg'); node.setAttribute('width', '64'); node.setAttribute('height', '64'); document.body.append(node); return node;}

it('keeps independent SVGs collision-free, stable on reinstall and locally self-contained', () => {
  const dom = scene(), document = dom.window.document;
  try {
    const a = createLandCoverStyle({document}), b = createLandCoverStyle({document});
    const first = svg(document), second = svg(document); a.install(first); b.install(second); a.install(first);
    assert.notEqual(a.paint('water').fill, b.paint('water').fill);
    assert.equal(first.querySelectorAll('pattern').length, 18);
    for (const adapter of [a, b]) for (const name of Object.keys(landCoverPresets)) {
      const id = adapter.paint(name).fill.slice(5, -1);
      assert.equal(document.getElementById(id)?.localName, 'pattern');
    }
    assert.throws(() => a.install(second), /separate/);
    assert.equal(document.querySelectorAll('image,script,foreignObject,[href]').length, 0);
  } finally {dom.window.close();}
});

it('rejects external paint/attributes, unsafe namespaces, invalid widths and unknown classes', () => {
  const dom = scene(), document = dom.window.document;
  try {
    for (const options of [{namespace: 'x\" onload=\"evil'}, {overrides: {water: {background: 'url(https://bad.test)'}}},
      {overrides: {water: {onload: 'evil'}}}, {overrides: {water: {width: Infinity}}}, {overrides: {unknown: {}}}]) {
      assert.throws(() => createLandCoverStyle({document, ...options}));
    }
    const adapter = createLandCoverStyle({document});
    assert.throws(() => adapter.paint('__proto__'), /Unknown/);
    assert.throws(() => adapter.plotGeoOptions('properties.kind'), /accessor/);
  } finally {dom.window.close();}
});

it('uses real D3 and Plot geo channels and paints their local SVG patterns in cached Chromium', async () => {
  const dom = scene(), document = dom.window.document;
  let browser;
  try {
    const d3svg = svg(document), d3style = createLandCoverStyle({document}); d3style.install(d3svg);
    const shapes = select(d3svg).selectAll('rect.land').data([{kind: 'forest'}]).join('rect')
      .attr('class', 'land').attr('width', 64).attr('height', 64);
    d3style.applyD3(shapes, datum => datum.kind);
    assert.equal(shapes.attr('fill'), d3style.paint('forest').fill);
    const feature = {type: 'Feature', properties: {kind: 'water'}, geometry: {type: 'Polygon', coordinates: [[[0, 0], [0, 20], [20, 20], [20, 0], [0, 0]]]}};
    const plotStyle = createLandCoverStyle({document}), options = plotStyle.plotGeoOptions(datum => datum.properties.kind);
    assert.equal(options.fill.scale, null);
    const plot = Plot.plot({document, width: 64, height: 64, margin: 0, projection: 'identity', marks: [Plot.geo([feature], options)]});
    document.body.append(plot); plotStyle.install(plot);
    assert.equal(plot.querySelector('g[aria-label="geo"] path').getAttribute('fill'), plotStyle.paint('water').fill);
    assert.notEqual(plotStyle.paint('water').fill, d3style.paint('water').fill);
    const executablePath = existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium-browser';
    browser = await chromium.launch({headless: true, executablePath, args: ['--no-sandbox']});
    const page = await browser.newPage(); await page.route('**/*', route => route.abort());
    for (const [node, name] of [[d3svg, 'forest'], [plot, 'water']]) {
      const pixels = await page.evaluate(async markup => {
        const image = new Image(); image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup); await image.decode();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, 64, 64).data];
      }, node.outerHTML);
      for (const color of [landCoverPresets[name].foreground, landCoverPresets[name].background]) {
        const rgb = color.slice(1).match(/../g).map(value => parseInt(value, 16)); let matches = 0;
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] === 255 && rgb.every((value, index) => Math.abs(pixels[i + index] - value) < 3)) matches++;
        assert(matches > 8, `${name} ${color} must paint real pixels`);
      }
    }
  } finally {await browser?.close(); dom.window.close();}
});

it('shows eighteen local land-cover references, selects distinct class paint and copies D3/Plot examples without adapter calls',async()=>{
  const dom=new JSDOM('<body/>'),previous=new Map(),copied=[];
  for(const name of ['document','DOMParser','Option']){previous.set(name,globalThis[name]);globalThis[name]=dom.window[name];}
  Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)}});
  const adapter=new Proxy({kind:'fixture'},{get:(target,key)=>key in target?target[key]:()=>assert.fail(`Reference must not call ${String(key)}`)});
  let root;
  try{
    root=StyleLibrary({adapter,containers:[]});document.body.append(root);const reference=root.querySelector('[aria-label="Land-cover reference"]');
    assert.equal(reference.localName,'details');assert.equal(reference.open,false);assert.equal(reference.querySelector('summary').textContent,'Map Folio · D3 and Plot patterns');
    assert.equal(reference.querySelectorAll('button.style-preset-card').length,18);
    const wetland=reference.querySelector('[aria-label="Wetlands reference preset"] svg'),marsh=reference.querySelector('[aria-label="Marsh reference preset"] svg');
    const pattern=svg=>svg.querySelector(`[id="${svg.lastElementChild.getAttribute('fill').slice(5,-1)}"]`);
    assert.equal(pattern(wetland).getAttribute('width'),'32');assert.equal(pattern(marsh).getAttribute('width'),'24');
    assert.notEqual(pattern(wetland).querySelector('rect').getAttribute('fill'),pattern(marsh).querySelector('rect').getAttribute('fill'));
    assert.equal(new Set([...reference.querySelectorAll('pattern')].map(node=>node.id)).size,324);
    reference.querySelector('[aria-label="Marsh reference preset"]').click();
    assert.equal(root.querySelector('[aria-label="Pattern spacing"]').value,'24');assert.equal(root.querySelector('[aria-label="Pattern color"]').value,'#438fba');
    reference.querySelector('[aria-label="Evergreen forest reference preset"]').click();
    assert.equal(root.querySelector('[aria-label="Pattern spacing"]').value,'24');assert.equal(root.querySelector('[aria-label="Pattern color"]').value,'#285d43');
    reference.querySelector('[aria-label="Orchards reference preset"]').click();
    assert.equal(root.querySelector('[aria-label="Pattern"]').value,'dots');assert.equal(root.querySelector('[aria-label="Pattern line width"]').value,'3');
    for(const name of ['D3','Plot']){[...reference.querySelectorAll('button')].find(button=>button.textContent===`Copy ${name} example`).click();await Promise.resolve();}
    assert.match(copied[0],/applyD3/);assert.match(copied[1],/plotGeoOptions/);assert.match(copied[0],/opengeo-landcover\.js/);
    assert.doesNotMatch(copied.join(''),/properties\.cover/);assert.match(reference.textContent,/Choose a class for each layer/);
    assert([...reference.querySelectorAll('button')].some(button=>button.textContent==='Download module'));
    assert.equal(root.querySelector('[aria-label="Data library"]').value,'');assert.equal(root.shouldBlockNavigation(),false);
  }finally{root?.dispose();for(const[name,value]of previous)if(value===undefined)delete globalThis[name];else globalThis[name]=value;dom.window.close();}
});

it('downloads a standalone module that executes the maintained API with real D3 and Plot',async()=>{
  const dom=scene(),document=dom.window.document,previous=new Map();let root,downloaded,filename;const revoked=[];
  for(const name of ['document','DOMParser','Option']){previous.set(name,globalThis[name]);globalThis[name]=dom.window[name];}
  const oldCreate=URL.createObjectURL,oldRevoke=URL.revokeObjectURL;
  URL.createObjectURL=blob=>{downloaded=blob;return 'blob:opengeo-landcover-test';};URL.revokeObjectURL=url=>revoked.push(url);
  dom.window.HTMLAnchorElement.prototype.click=function(){filename=this.download;};
  try{
    root=StyleLibrary({adapter:{kind:'fixture'},containers:[]});document.body.append(root);
    [...root.querySelectorAll('button')].find(button=>button.textContent==='Download module').click();
    assert.equal(filename,'opengeo-landcover.js');assert.equal(downloaded.type,'text/javascript;charset=utf-8');
    const source=await downloaded.text();assert.equal(source,landCoverModuleSource());
    assert.doesNotMatch(source,/\bimport\s|https?:\/\/(?!www\.w3\.org)|<image|\beval\(|new Function/);
    const {outputFiles}=await build({entryPoints:[fileURLToPath(new URL('../src/lib/landCoverStyle.js',import.meta.url))],bundle:true,minify:true,format:'esm',write:false});
    const compiled=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
    const module=await import('data:text/javascript;base64,'+Buffer.from(compiled.landCoverModuleSource()).toString('base64'));
    assert.deepEqual(module.landCoverPresets,landCoverPresets);
    const first=svg(document),a=module.createLandCoverStyle({document});a.install(first);
    const shapes=select(first).selectAll('rect.land').data([{}]).join('rect').attr('class','land');a.applyD3(shapes,()=> 'forest');
    assert.equal(shapes.attr('fill'),a.paint('forest').fill);assert.equal(shapes.attr('stroke'),landCoverPresets.forest.stroke);
    const feature={type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[0,0],[0,20],[20,20],[20,0],[0,0]]]}};
    const b=module.createLandCoverStyle({document});const plot=Plot.plot({document,width:64,height:64,projection:'identity',marks:[Plot.geo([feature],b.plotGeoOptions(()=> 'water'))]});b.install(plot);
    assert.equal(plot.querySelector('g[aria-label="geo"] path').getAttribute('fill'),b.paint('water').fill);
    assert.notEqual(a.paint('water').fill,b.paint('water').fill);assert.equal(document.querySelector('a[download]'),null);
    await new Promise(resolve=>setTimeout(resolve,1050));assert.deepEqual(revoked,['blob:opengeo-landcover-test']);
  }finally{root?.dispose();URL.createObjectURL=oldCreate;URL.revokeObjectURL=oldRevoke;for(const[name,value]of previous)if(value===undefined)delete globalThis[name];else globalThis[name]=value;dom.window.close();}
});
