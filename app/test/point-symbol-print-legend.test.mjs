import assert from "node:assert/strict";
import {test} from "node:test";
import {JSDOM} from "jsdom";
import {ProjectPrintEditor, capturePrintMap, printPageSvg} from "../src/components/ProjectPrintEditor.js";
import {newProjectPrintLayout, printLayerPresentation, definitionForPrintFrame, validateProjectPrintLayouts, projectPrintLayouts, PROJECT_PRINT_SCHEMA} from "../src/lib/printLayouts.js";
import {pointSymbolPreviewSvg} from "../src/lib/pointSymbols.js";
import {resolveLayerStyle} from "../src/lib/layerStyleReference.js";
import {thematicStyleDefinition} from "../src/lib/symbologyCatalog.js";
import {graduatedColorExpression} from "../src/lib/thematicStyle.js";
import {continuousStyleDefinition} from "../src/lib/continuousStyle.js";

const png = `data:image/png;base64,${Buffer.from([137,80,78,71,13,10,26,10]).toString("base64")}`;
function fixture({pointSymbol = "hospital", renderer = "single", categorySymbols, circleRadius = 8} = {}) {
  const layer = {layerId: "health", datasetId: "health", geometryType: "Point", visible: true, opacity: .7,
    title: "Care facilities", attribution: "Clinic survey", labels: {},
    style: {pointSymbol, circleColor: "#dc2626", circleRadius, renderer,
      ...(categorySymbols ? {categoryField: "kind", categorySymbols} : {})}};
  const circle = {id: "health-points", type: "circle", paint: {"circle-color": "#dc2626"}};
  let render;
  const map = {isStyleLoaded: () => true, areTilesLoaded: () => true, isMoving: () => false,
    getCanvas: () => ({width: 80, height: 60, toDataURL: () => png}),
    once: (_, callback) => {render = callback;}, triggerRepaint: () => queueMicrotask(render),
    getCenter: () => ({lng: 85, lat: 27}), getZoom: () => 4, getPitch: () => 0, getBearing: () => 0,
    getProjection: () => ({type: "globe"}), getStyle: () => ({layers: [circle]})};
  const handle = {layerIds: [circle.id]}, handles = new Map([[layer.layerId, handle]]);
  const record = {id: "map", version: 2, name: "Care facilities", definition: {layers: [layer]}};
  return {layer, circle, handle, record, context: {map, layers: [layer], handles, renderer: "maplibre", ready: true}};
}
async function withPage(action) {
  const dom = new JSDOM("<!doctype html><body></body>"), previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {await action();} finally {globalThis.document = previous;dom.window.close();}
}
function pageFor(value, capture, options = {}, rendering = {}) {
  const layout = newProjectPrintLayout(value.record, "layout");
  Object.assign(layout, {northArrow: false, scaleBar: false, graticule: false}, options);
  return printPageSvg(layout, new Map([["layout:main", capture]]), "layout", rendering);
}

function dataFixture(values = [-3, 0, 4, null, "5"]) {
  const value = fixture();value.layer.sourceType = "geojson-object";
  const geojson = {type: "FeatureCollection", features: values.map((score, index) => ({type: "Feature", id: index,
    properties: {score, name: index < 2 ? "same" : `Row ${index}`, exact: "900719925474099312345"}, geometry: {type: "Point", coordinates: [85, 27]}}))};
  const source = {layerId: value.layer.layerId, datasetId: value.layer.datasetId, datasetVersionId: null, sourceVersion: null};
  value.context.getPrintDataSource = layerId => layerId === source.layerId ? {id: source.layerId, title: value.layer.title,
    geojson, inputPin: {...source, featureGeneration: 1, checksumSha256: null}} : null;
  const table = {id: "attributes", type: "table", title: "Attributes", xMm: 10, yMm: 105, widthMm: 133, heightMm: 75,
    mapFrameId: "main", source, rowLimit: 5, columns: ["name", "score", "exact"]};
  const chart = {id: "values", type: "chart", title: "Recorded scores", xMm: 153, yMm: 105, widthMm: 134, heightMm: 75,
    mapFrameId: "main", source, rowLimit: 5, chartType: "bar", labelField: "name", valueField: "score", altText: "Individual recorded scores"};
  return {...value, geojson, table, chart};
}

test("source data frames retain exact table cells, honest bar gaps and current-only SVG metadata", async () => withPage(async () => {
  const value = dataFixture(), frames = [value.table, value.chart];
  const capture = await capturePrintMap(value.context, value.record, {dataFrames: frames});
  const page = pageFor(value, capture, {dataFrames: frames});
  assert.equal(page.querySelectorAll('[data-print-data-frame]').length, 2);
  assert.equal(page.querySelectorAll('[data-print-cell]').length, 15);
  assert.equal(page.querySelector('[data-print-cell="0:2"] title').textContent, '900719925474099312345');
  assert.equal(page.querySelector('[data-print-bar="1"]').getAttribute('width'), '0');
  assert.equal(page.querySelectorAll('[data-print-bar]').length, 3);
  assert.match(page.textContent, /unavailable values are gaps/);
  const metadata = JSON.parse(page.querySelector('metadata').textContent);
  assert.equal(metadata.captures[0].dataFrames[0].rows[0][2], '900719925474099312345');
  assert.equal(metadata.captures[0].dataFrames[1].rawValues[4], '5');
  assert.deepEqual(metadata.captures[0].dataFrames.map(item => item.frameId), ['attributes','values']);
  assert.deepEqual(JSON.parse(pageFor(value,capture,{dataFrames:[value.chart]}).querySelector('metadata').textContent).captures[0].dataFrames.map(item=>item.frameId),['values']);
  const changed=structuredClone(value.table);changed.columns=['score'];
  assert.throws(()=>pageFor(value,capture,{dataFrames:[changed]}),/stale or invalid/);
  const covered={...value.chart,yMm:30};assert.throws(()=>pageFor(value,capture,{dataFrames:[covered]}),/away from the map legend/);
  assert.ok(pageFor(value,capture,{dataFrames:[covered]}, {preview:true}));
  assert.ok(pageFor(value,capture,{dataFrames:frames,frames:[{...newProjectPrintLayout(value.record,'layout').frames[0],heightMm:70}]}));
}));

test("line data frames break at unavailable rows and preserve source record order", async () => withPage(async () => {
  const value=dataFixture([1,null,'2',4,5]);value.chart.chartType='line';
  const capture=await capturePrintMap(value.context,value.record,{dataFrames:[value.chart]});
  const page=pageFor(value,capture,{dataFrames:[value.chart]});
  assert.deepEqual([...page.querySelectorAll('[data-print-line-point]')].map(node=>node.getAttribute('data-print-line-point')),['0','3','4']);
  assert.equal(page.querySelectorAll('[data-print-line-run]').length,1);
  assert.equal(page.querySelector('[data-print-line-run]').getAttribute('points').split(' ').length,2);
  assert.equal(page.querySelector('[data-print-data-frame]').getAttribute('aria-label'),value.chart.altText);
  const short={...value.chart,heightMm:20};assert.throws(()=>pageFor(value,capture,{dataFrames:[short]}),/more height/);
  assert.ok(pageFor(value,capture,{dataFrames:[short]}, {preview:true}));
}));

test("Print data controls save source configuration, arrange frames and require fresh data capture after reopen", async () => withPage(async () => {
  const value=dataFixture([-3,0,'4']);value.record.projectId='project';
  const layout=newProjectPrintLayout(value.record,'layout');Object.assign(layout,{northArrow:false,scaleBar:false,graticule:false});
  value.record.definition.extensions={opengeoPrintLayouts:{schemaVersion:PROJECT_PRINT_SCHEMA,projectId:value.record.id,layouts:[layout]}};
  const workbench=document.createElement('div');workbench.getPrintContext=()=>value.context;
  let saved, writes=0;
  const adapter={updateMap:async(projectId,mapId,{expectedVersion,changes})=>{assert.equal(expectedVersion,2);writes++;saved={...structuredClone(value.record),version:3,definition:structuredClone(changes.definition)};return structuredClone(saved);}};
  const editor=ProjectPrintEditor({state:{selectedMap:value.record,project:{id:'project'},organization:{id:'org'},adapter},workbench,editFrame:()=>workbench,canSave:true});document.body.append(editor);
  const button = (root,text) => [...root.querySelectorAll('button')].find(node=>node.textContent===text);
  const settle=async(test)=>{for(let n=0;n<100;n++){if(test())return;await new Promise(resolve=>setTimeout(resolve,1));}assert.fail('UI did not settle');};
  button(editor,'Add source table').click();assert.equal(editor.querySelectorAll('[data-print-frame]').length,3);
  button(editor,'Add source chart').click();
  const outline=[...editor.querySelectorAll('[data-print-frame]:not([data-print-resize])')].find(node=>node.getAttribute('aria-label').includes('Values'));
  outline.dispatchEvent(new document.defaultView.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
  button(editor,'Capture map frame').click();await settle(()=>editor.querySelector('[role="status"]').textContent.startsWith('Captured'));
  button(editor,'Save layout').click();await settle(()=>writes===1&&editor.querySelector('[role="status"]').textContent.includes('revision 3'));
  const stored=projectPrintLayouts(saved).layouts[0];assert.equal(stored.dataFrames.length,2);
  assert.equal(stored.dataFrames[1].labelField,'name');assert.equal(stored.dataFrames[1].valueField,'score');
  assert.equal(stored.dataFrames[1].xMm,152.5);assert.deepEqual(saved.definition.layers,value.record.definition.layers);
  assert.equal(JSON.stringify(saved.definition).includes('900719925474099312345'),false);
  editor.dispose();editor.remove();
  const reopened=ProjectPrintEditor({state:{selectedMap:saved,project:{id:'project'},organization:{id:'org'},adapter:{}},workbench,editFrame:()=>workbench});document.body.append(reopened);
  assert.equal(reopened.querySelectorAll('[data-print-data-frame]').length,0);
  assert.match(reopened.querySelector('.print-stage').textContent,/capture linked map/);
  button(reopened,'Capture map frame').click();await settle(()=>reopened.querySelector('[role="status"]').textContent.startsWith('Captured'));
  assert.equal(reopened.querySelectorAll('[data-print-data-frame]').length,2);assert.equal(writes,1);
  reopened.dispose();
}));

async function referencedThematicFixture(geometryType = "Polygon", suppliedDefinition = null) {
  const value = fixture(), id = "d0000000-0000-4000-8000-000000000002";
  const definition = suppliedDefinition ?? thematicStyleDefinition({geometry: geometryType.includes("Line") ? "line" : "fill",
    colors: ["#440154", "#21918c", "#fde725"], breaks: [20, 40], nullColor: "#9ca3af",
    outlineColor: "#17212b", outlineWidth: 1, opacity: .8}, "score", "Screening index");
  const checksumSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(definition)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  Object.assign(value.layer, {title: "Screening index", geometryType, license: "CC-BY-4.0",
    styleReference: {projectId: id, resourceId: id, styleId: id, versionNumber: 2, checksumSha256, format: "maplibre"},
    style: {renderer: "graduated", graduated: {field: "stale_inline_score"}, fill: "#abcdef", stroke: "#abcdef"}});
  const adapter = {getResource: async () => ({id, projectId: id, datasetId: value.layer.datasetId}),
    getResourceStyleVersion: async () => ({id, resourceId: id, title: "Screening index", versionNumber: 2, format: "maplibre", checksumSha256, definition})};
  value.handle.boundStyle = await resolveLayerStyle(adapter, value.layer);
  value.paints = value.handle.boundStyle.parts.map((part, index) => ({...structuredClone(part), id: `${value.layer.layerId}-style-${index}`}));
  value.handle.layerIds = value.paints.map(part => part.id);
  value.context.map.getStyle = () => ({layers: value.paints});
  return value;
}

const continuousStops = [{value: -2.5, color: "#000000"}, {value: -2.49, color: "#ff0000"}, {value: 17.5, color: "#ffff00"}];
async function continuousFixture(geometryType = "Polygon") {
  return referencedThematicFixture(geometryType, continuousStyleDefinition({geometry: geometryType.includes("Line") ? "line" : "fill",
    stops: continuousStops, nullColor: "#9ca3af", opacity: 1, outlineColor: "#17212b", outlineWidth: 1}, "score", "Screening index"));
}

test("continuous Print scales retain exact pinned stops, proportional ticks and separate numeric fallback", async () => withPage(async () => {
  for (const geometry of ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]) {
    const value = await continuousFixture(geometry), before = structuredClone(value.record);
    const capture = await capturePrintMap(value.context, value.record), group = capture.continuousLegends[0];
    assert.deepEqual(group.stops, continuousStops);assert.equal(group.field, "score");
    assert.equal(group.interpolation, "linear");assert.deepEqual(group.noData, {label: "Missing or nonnumeric", color: "#9ca3af"});
    assert.deepEqual(capture.numericLegends, []);
    const page = pageFor(value, capture, {legendFormat: "color-bars"});
    const bar = page.querySelector('[data-continuous-color-bar="health"]');assert.ok(bar);
    const stops = [...bar.querySelectorAll('[data-continuous-stop]')];
    assert.deepEqual(stops.map(stop => stop.getAttribute("stop-color")), continuousStops.map(stop => stop.color));
    assert.equal(Number(stops[0].getAttribute("offset")), 0);assert.equal(Number(stops[2].getAttribute("offset")), 1);
    assert.ok(Math.abs(Number(stops[1].getAttribute("offset")) - .0005) < 1e-12);
    const ramp = bar.querySelector('[data-continuous-ramp]'), top = Number(ramp.getAttribute("y")), height = Number(ramp.getAttribute("height"));
    for (const tick of bar.querySelectorAll('[data-continuous-tick]')) {
      const expected = top + (17.5 - Number(tick.dataset.continuousTick)) / 20 * height;
      assert.ok(Math.abs(Number(tick.getAttribute("points").split(" ")[0].split(",")[1]) - expected) < 1e-10);
    }
    const labelYs = [...bar.querySelectorAll('text')].filter(node => ["-2.5", "-2.49", "17.5"].includes(node.textContent)).map(node => Number(node.getAttribute("y")));
    for (let i = 1; i < labelYs.length; i++) assert.ok(labelYs[i] - labelYs[i - 1] >= 3.99);
    assert.equal(bar.querySelector('[data-color-bar-no-data]').getAttribute("fill"), "#9ca3af");
    assert.match(bar.textContent, /Linear interpolation/);
    assert.match([...bar.querySelectorAll("text")].map(node => node.textContent).join(" "), /before map opacity and background blending/);
    assert.match(page.textContent, /CC-BY-4.0/);
    assert.equal(page.querySelector('[data-classed-color-bar]'), null);
    assert.deepEqual(JSON.parse(page.querySelector("metadata").textContent).captures[0].continuousLegends, capture.continuousLegends);
    assert.equal(pageFor(value, capture).querySelector('[data-continuous-color-bar]'), null);
    assert.equal(pageFor(value, capture, {legendFormat: "classed-bars"}).querySelector('[data-continuous-color-bar]'), null);
    assert.deepEqual(value.record, before);
  }
}));

test("continuous Print capture rejects changed or unresolved pinned paint", async () => {
  const value = await continuousFixture();
  value.handle.boundStyle.reference.versionNumber++;
  await assert.rejects(capturePrintMap(value.context, value.record), /pinned Style is not resolved/);
  value.handle.boundStyle.reference.versionNumber--;
  value.paints[0].paint["fill-color"][2][4] = "#123456";
  await assert.rejects(capturePrintMap(value.context, value.record), /displayed styling differs/);
});

test("continuous Print scale values stay exact and reject insufficient label width", async () => withPage(async () => {
  const stops = [{value: .12345678901234566, color: "#000000"}, {value: 1.2345678901234567, color: "#ffffff"}];
  const value = await referencedThematicFixture("Polygon", continuousStyleDefinition({geometry: "fill", stops,
    nullColor: "#9ca3af", opacity: 1, outlineColor: "#17212b", outlineWidth: 1}, "score", "Screening index"));
  const capture = await capturePrintMap(value.context, value.record);
  assert.match(pageFor(value, capture, {legendFormat: "color-bars"}).textContent, /0\.12345678901234566/);
  const frame = newProjectPrintLayout(value.record, "layout").frames[0];frame.widthMm = 248;
  assert.throws(() => pageFor(value, capture, {legendFormat: "color-bars", frames: [frame]}), /Widen the legend area/);
}));

test("continuous Print metadata rejects altered stops, private fields and mismatched captured rows", async () => withPage(async () => {
  const value = await continuousFixture(), captured = await capturePrintMap(value.context, value.record);
  for (const mutate of [
    c => c.continuousLegends[0].stops[1].value = -2.5,
    c => c.continuousLegends[0].stops[1].color = "url(https://untrusted.example/color)",
    c => c.continuousLegends[0].privateConfiguration = "never-copy",
    c => c.continuousLegends[0].count++,
    c => c.legend[0].color = "#ffffff",
    c => c.continuousLegends.push(structuredClone(c.continuousLegends[0]))
  ]) {
    const changed = structuredClone(captured);mutate(changed);
    assert.throws(() => pageFor(value, changed, {legendFormat: "color-bars"}), /continuous/);
  }
}));

test("mixed continuous and classed Print bars retain their actual scale representation", async () => withPage(async () => {
  const value = await continuousFixture(), second = await referencedThematicFixture("LineString");
  second.layer.layerId = "second";second.layer.title = "Classed index";
  second.paints.forEach((part, index) => part.id = `second-style-${index}`);second.handle.layerIds = second.paints.map(part => part.id);
  value.context.layers.push(second.layer);value.record.definition.layers.push(second.layer);value.context.handles.set("second", second.handle);
  value.context.map.getStyle = () => ({layers: [...value.paints, ...second.paints]});
  const capture = await capturePrintMap(value.context, value.record), layout = newProjectPrintLayout(value.record, "layout");
  layout.frames[0].heightMm = 220;
  const page = pageFor(value, capture, {legendFormat: "color-bars", page: {...layout.page, size: "A3", widthMm: 420, heightMm: 297}, frames: layout.frames});
  assert.equal(page.querySelectorAll('[data-continuous-color-bar]').length, 1);
  assert.equal(page.querySelectorAll('[data-classed-color-bar]').length, 1);
  assert.equal(page.querySelectorAll('[color-interpolation="sRGB"]').length, 1);
  assert.equal(page.querySelectorAll('[data-color-bar-interval]').length, 4);
}));

test("Print continuous color-bar controls persist the choice and reopen without retained pixels", async () => withPage(async () => {
  const value = await continuousFixture(), layout = newProjectPrintLayout(value.record, "continuous-layout");
  Object.assign(layout, {northArrow: false, scaleBar: false});
  value.record.definition.extensions = {opengeoPrintLayouts: {schemaVersion: PROJECT_PRINT_SCHEMA, projectId: value.record.id, layouts: [layout]}};
  const workbench = document.createElement("div");workbench.getPrintContext = () => value.context;
  let saved, writes = 0;
  const state = {selectedMap: value.record, project: {id: "container"}, organization: {id: "org"},
    adapter: {updateMap: async (projectId, id, request) => {
      assert.equal(projectId, "container");assert.equal(id, value.record.id);assert.equal(request.expectedVersion, 2);writes++;
      saved = {...structuredClone(value.record), projectId, version: 3, definition: request.changes.definition};return saved;
    }}};
  const editor = ProjectPrintEditor({state, workbench, editFrame: () => {}, canSave: true});document.body.append(editor);
  const select = editor.querySelector('[aria-label="Main map legend display"]');select.value = "color-bars";
  select.dispatchEvent(new document.defaultView.Event("change"));
  [...editor.querySelectorAll("button")].find(node => node.textContent === "Save layout").click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(writes, 1);assert.equal(projectPrintLayouts(saved).layouts[0].legendFormat, "color-bars");editor.dispose();editor.remove();
  const reopened = ProjectPrintEditor({state: {...state, selectedMap: saved}, workbench, editFrame: () => {}, canSave: false});document.body.append(reopened);
  assert.equal(reopened.querySelector('[aria-label="Main map legend display"]').value, "color-bars");
  assert.equal(reopened.querySelectorAll('.print-stage svg image').length, 0);reopened.dispose();
}));

test("reusable graduated Polygon and Line Styles print their resolved ranges and real fallback semantics", async () => withPage(async () => {
  for (const geometry of ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]) {
    const value = await referencedThematicFixture(geometry), before = structuredClone({record: value.record, bound: value.handle.boundStyle});
    const capture = await capturePrintMap(value.context, value.record);
    assert.deepEqual(capture.legend.slice(0, 4), [
      {label: "Screening index · score < 0", color: "#9ca3af"},
      {label: "Screening index · score 0 – < 20", color: "#440154"},
      {label: "Screening index · score 20 – < 40", color: "#21918c"},
      {label: "Screening index · score ≥ 40", color: "#fde725"}
    ]);
    assert.deepEqual(capture.displayNotes, ["Screening index · score uses numeric conversion; missing values or failed conversions use -1."]);
    assert.deepEqual(capture.legend[4], {label: capture.displayNotes[0]});
    const page = pageFor(value, capture);
    for (const color of ["#9ca3af", "#440154", "#21918c", "#fde725"]) assert.ok(page.querySelector(`rect[fill="${color}"]`));
    assert.match(page.textContent, /score ≥ 40/);
    assert.doesNotMatch([...page.querySelectorAll("text")].map(node => node.textContent).join(" "), /stale_inline_score|No data/);
    assert.equal(page.querySelector('rect[fill="#abcdef"]'), null);
    assert.deepEqual(capture.sourceMetadata[0], {layerId: value.layer.layerId, datasetId: value.layer.datasetId,
      datasetVersionId: null, sourceVersion: null, title: "Screening index", license: "CC-BY-4.0",
      sourceAttribution: "Clinic survey", curatedAttribution: null});
    assert.deepEqual(capture.presentation[0].styleReference, value.layer.styleReference);
    assert.deepEqual(JSON.parse(capture.signature), {view: capture.view, presentation: capture.presentation});
    assert.deepEqual({record: value.record, bound: value.handle.boundStyle}, before);
  }
}));

test("reusable graduated legends preserve negative and fractional bounds instead of inventing a no-data swatch", async () => withPage(async () => {
  const value = await referencedThematicFixture("LineString");
  const expression = ["step", ["to-number", ["coalesce", ["get", "score"], -1], -1], "#440154", -2.5, "#21918c", 0.125, "#fde725"];
  value.handle.boundStyle.parts[0].paint["line-color"] = structuredClone(expression);
  value.paints[0].paint["line-color"] = structuredClone(expression);
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend.slice(0, 3).map(row => row.label), [
    "Screening index · score < -2.5", "Screening index · score -2.5 – < 0.125", "Screening index · score ≥ 0.125"
  ]);
  assert.match(capture.displayNotes[0], /missing values or failed conversions use -1/);
  assert.doesNotMatch(pageFor(value, capture).textContent, /No data/);
}));

test("unresolved or changed reusable graduated paint cannot produce a misleading Print legend", async () => {
  const value = await referencedThematicFixture();
  value.handle.boundStyle.reference.versionNumber++;
  await assert.rejects(capturePrintMap(value.context, value.record), /pinned Style is not resolved/);
  value.handle.boundStyle.reference.versionNumber--;
  value.paints[0].paint["fill-color"][4] = "#abcdef";
  await assert.rejects(capturePrintMap(value.context, value.record), /displayed styling differs from the pinned Style/);
  value.paints[0].paint["fill-color"] = "#abcdef";
  await assert.rejects(capturePrintMap(value.context, value.record), /displayed styling differs from the pinned Style/);
});

test("unsupported reusable Style encodings disclose the missing legend without using inline or outline colors", async () => withPage(async () => {
  const value = await referencedThematicFixture();
  const expression = ["match", ["get", "kind"], "low", "#440154", "#fde725"];
  value.handle.boundStyle.parts[0].paint["fill-color"] = structuredClone(expression);
  value.paints[0].paint["fill-color"] = structuredClone(expression);
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend, [{label: "Screening index · A print legend is unavailable for this Style encoding."}]);
  assert.deepEqual(capture.displayNotes, [capture.legend[0].label]);
  const page = pageFor(value, capture);
  assert.match(page.textContent, /print legend is unavailable/);
  assert.equal(page.querySelector('rect[fill="#abcdef"],rect[fill="#17212b"]'), null);
}));

test("classed bars retain exact reusable intervals, equal contiguous bands and real fallback notes", async () => withPage(async () => {
  const value = await referencedThematicFixture(), capture = await capturePrintMap(value.context, value.record);
  const before = structuredClone(capture);
  const page = pageFor(value, capture, {legendFormat: "classed-bars"});
  const bar = page.querySelector('[data-classed-color-bar="health"]');assert.ok(bar);
  const segments = [...bar.querySelectorAll('[data-color-bar-interval]')];
  assert.deepEqual(segments.map(node => node.getAttribute('fill')), ['#9ca3af','#440154','#21918c','#fde725']);
  assert.equal(new Set(segments.map(node => node.getAttribute('height'))).size, 1);
  for (let i=1;i<segments.length;i++) assert.equal(Number(segments[i].getAttribute('y')), Number(segments[i-1].getAttribute('y'))+Number(segments[i-1].getAttribute('height')));
  assert.match(bar.textContent, /score/);assert.match(bar.textContent, /Equal-height class bands/);
  assert.match(bar.textContent, /0 – < 20/);assert.match(bar.textContent, /≥ 40/);
  assert.match(bar.textContent, /failed conversions use -1/);
  assert.equal(bar.querySelector('[data-color-bar-no-data]'), null);
  assert.deepEqual(capture.numericLegends[0].intervals.map(({minimum,maximum}) => [minimum,maximum]), [[null,0],[0,20],[20,40],[40,null]]);
  assert.deepEqual(capture,before);
  assert.match([...page.querySelectorAll('text')].map(x=>x.textContent).join(' '), /License: CC-BY-4.0/);
  assert.equal(pageFor(value,capture).querySelector('[data-classed-color-bar]'),null);
}));

test("inline classed bars retain a separate no-data swatch from actual rendered fallback paint", async () => withPage(async () => {
  const value = fixture();value.layer.geometryType='Polygon';delete value.layer.style.pointSymbol;
  value.layer.style={renderer:'graduated',fill:'#cbd5e1',graduated:{field:'value',breaks:[-2.5,0,0.125,50],colors:['#440154','#3b528b','#21918c','#5ec962','#fde725'],noDataColor:'#eeeeee',noDataLabel:'Unreported'}};
  value.circle.type='fill';value.circle.paint={'fill-color':graduatedColorExpression(value.layer.style.graduated,'#cbd5e1')};
  const capture=await capturePrintMap(value.context,value.record);
  const page=pageFor(value,capture,{legendFormat:'classed-bars',sourceNotes:false});
  const bar=page.querySelector('[data-classed-color-bar]');assert.ok(bar);
  assert.equal(bar.querySelectorAll('[data-color-bar-interval]').length,5);
  assert.equal(bar.querySelector('[data-color-bar-no-data]').getAttribute('fill'),'#cbd5e1');
  assert.equal(bar.querySelector('rect[fill="#eeeeee"]'),null);assert.match(bar.textContent,/Unreported/);
  assert.match(bar.textContent,/-2.5 – < 0/);assert.match(bar.textContent,/0 – < 0.125/);
  assert.match(bar.textContent,/Only numeric values use these classes/);
  assert.match([...page.querySelectorAll('text')].map(x=>x.textContent).join(' '),/Care facilities · License: not recorded/);
  assert.match(page.textContent,/Clinic survey/);
  value.circle.paint['fill-color'][2][1]=['get','different'];
  await assert.rejects(capturePrintMap(value.context,value.record),/displayed numeric styling differs/);
}));

test("multiple numeric Layers keep independent color bars and Point glyphs remain swatches", async () => withPage(async () => {
  const value=await referencedThematicFixture(), second=await referencedThematicFixture('LineString');
  second.layer.layerId='second';second.layer.title='Second index';
  second.paints.forEach((part,index)=>part.id=`second-style-${index}`);second.handle.layerIds=second.paints.map(part=>part.id);
  value.context.layers.push(second.layer);value.record.definition.layers.push(second.layer);value.context.handles.set('second',second.handle);
  value.context.map.getStyle=()=>({layers:[...value.paints,...second.paints]});
  const capture=await capturePrintMap(value.context,value.record), page=pageFor(value,capture,{legendFormat:'classed-bars'});
  assert.deepEqual([...page.querySelectorAll('[data-classed-color-bar]')].map(node=>node.getAttribute('data-classed-color-bar')),['health','second']);
  const bars=[...page.querySelectorAll('[data-classed-color-bar]')];
  const a=bars[0].querySelectorAll('[data-color-bar-interval]'),b=bars[1].querySelectorAll('[data-color-bar-interval]');
  assert.ok(Number(b[0].getAttribute('y'))>Number(a[a.length-1].getAttribute('y'))+Number(a[a.length-1].getAttribute('height')));
  const point=fixture(), pointCapture=await capturePrintMap(point.context,point.record);
  const pointPage=pageFor(point,pointCapture,{legendFormat:'classed-bars'});
  assert.ok(pointPage.querySelector('[data-point-symbol="hospital"]'));
  assert.equal(pointPage.querySelector('[data-classed-color-bar]'),null);
  assert.match(pointPage.textContent,/No supported numeric color bar; swatches retained/);
}));

test("classed bar metadata is bounded, rejects unsafe colors and preserves exact fractional intervals", async () => withPage(async () => {
  const value=await referencedThematicFixture('LineString');
  const expression=['step',['to-number',['coalesce',['get','score'],-1],-1],'#440154',-2.5,'#21918c',0.125,'#fde725'];
  value.handle.boundStyle.parts[0].paint['line-color']=structuredClone(expression);value.paints[0].paint['line-color']=structuredClone(expression);
  const capture=await capturePrintMap(value.context,value.record);
  assert.match(pageFor(value,capture,{legendFormat:'classed-bars'}).textContent,/-2.5 – < 0.125/);
  const unsafe=structuredClone(capture);unsafe.numericLegends[0].intervals[0].color='url(https://unbound.example/a.svg)';
  assert.throws(()=>pageFor(value,unsafe,{legendFormat:'classed-bars'}),/Invalid captured numeric intervals/);
  const mismatch=structuredClone(capture);mismatch.numericLegends[0].intervals[1].minimum=-9;
  assert.throws(()=>pageFor(value,mismatch,{legendFormat:'classed-bars'}),/Invalid captured numeric intervals/);
  const overlap=structuredClone(capture);overlap.numericLegends.push(structuredClone(overlap.numericLegends[0]));
  assert.throws(()=>pageFor(value,overlap,{legendFormat:'classed-bars'}),/Invalid captured numeric legends/);
  const short=newProjectPrintLayout(value.record,'layout');Object.assign(short,{legendFormat:'classed-bars',northArrow:false,scaleBar:false,graticule:false});short.frames[0].heightMm=30;
  assert.throws(()=>printPageSvg(short,new Map([['layout:main',capture]]),'layout'),/legend overlaps source notes/);
  assert.throws(()=>pageFor(value,capture,{legendFormat:'continuous'}),/Invalid print legend format/);
  const small=pageFor(value,capture);assert.ok(small);
  assert.throws(()=>pageFor(value,capture,{legendFormat:'classed-bars',page:{widthMm:297,heightMm:60,marginMm:10}}),/legend is taller/);
}));

test("captured legends retain the actual known Point glyph, color, radius and attribution", async () => withPage(async () => {
  const value = fixture(), capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend, [{label: "Care facilities", color: "#dc2626", opacity: .7,
    pointStyle: {pointSymbol: "hospital", circleColor: "#dc2626", circleRadius: 8}}]);
  assert.deepEqual(capture.attribution, ["Clinic survey"]);
  const page = pageFor(value, capture), icon = page.querySelector('[data-point-symbol="hospital"]');
  assert.ok(icon);assert.equal(Number(icon.getAttribute("width")), 16 * 25.4 / 96);
  assert.equal(icon.getAttribute("opacity"), "0.7");
  const svg = decodeURIComponent(icon.getAttribute("href").split(",").slice(1).join(","));
  assert.match(svg, /fill="#dc2626"/);assert.match(svg, /<rect/);
  assert.doesNotMatch(svg, /<script|(?:href|src)="https?:|onload|<image/);
  assert.equal(page.querySelector('image:not([data-point-symbol])').getAttribute("href"), png);
}));

test("direct Print Studio capture loads imported Maki and OSM legends before generating the page", async () => withPage(async () => {
  const maki = "maki-8-2-0-hospital", osm = "osm-carto-1cc4b89c-amenity--hospital";
  assert.throws(() => pointSymbolPreviewSvg({pointSymbol: maki}), /assets have not been loaded/);
  const value = fixture({renderer: "category", pointSymbol: "circle", categorySymbols: {Hospital: maki, Clinic: osm}});
  value.circle.paint["circle-color"] = ["match", ["to-string", ["get", "kind"]], "Hospital", "#dc2626", "Clinic", "#2563eb", "#64748b"];
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend.map(row => row.pointStyle.pointSymbol), [maki, osm, "circle"]);
  const icons = [...pageFor(value, capture).querySelectorAll("[data-point-symbol]")];
  assert.deepEqual(icons.map(icon => icon.dataset.pointSymbol), [maki, osm, "circle"]);
  for (let index = 0; index < 2; index++) {
    const svg = decodeURIComponent(icons[index].getAttribute("href").split(",").slice(1).join(","));
    assert.equal(svg, pointSymbolPreviewSvg(capture.legend[index].pointStyle));
    assert.match(svg, /<rect/);assert.doesNotMatch(svg, /<script|<image|(?:href|src)="https?:/);
  }
  assert.equal(capture.dataUrl, png);
}));

test("hospital and clinic categories have distinct matching glyph and color rows with a fallback", async () => withPage(async () => {
  const value = fixture({renderer: "category", pointSymbol: "circle", categorySymbols: {Hospital: "hospital", Clinic: "clinic"}});
  value.circle.paint["circle-color"] = ["match", ["to-string", ["get", "kind"]], "Hospital", "#dc2626", "Clinic", "#2563eb", "#64748b"];
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend.map(row => [row.label, row.pointStyle.pointSymbol, row.color]), [
    ["Care facilities · Hospital", "hospital", "#dc2626"],
    ["Care facilities · Clinic", "clinic", "#2563eb"],
    ["Care facilities · Other values", "circle", "#64748b"]
  ]);
  assert.deepEqual([...pageFor(value, capture).querySelectorAll("[data-point-symbol]")].map(node => node.dataset.pointSymbol), ["hospital", "clinic", "circle"]);
}));

test("pinned Point glyphs drive the legend while non-Point layers retain rectangle swatches", async () => withPage(async () => {
  const value = fixture();
  value.layer.styleReference = {styleId: "pinned"};
  value.handle.boundStyle = {pointSymbolStyle: {...value.layer.style, pointSymbol: "clinic"}};
  value.layer.style.pointSymbol = "flag";
  assert.equal((await capturePrintMap(value.context, value.record)).legend[0].pointStyle.pointSymbol, "clinic");
  value.layer.geometryType = "Polygon";value.circle.type = "fill";value.circle.paint = {"fill-color": "#16a34a"};
  const capture = await capturePrintMap(value.context, value.record);
  assert.deepEqual(capture.legend, [{label: "Care facilities", color: "#16a34a"}]);
  const page = pageFor(value, capture);
  assert.equal(page.querySelectorAll("[data-point-symbol]").length, 0);
  assert.ok(page.querySelector('rect[fill="#16a34a"]'));
}));

test("Point legend caps and generated SVG input validation remain enforced", async () => withPage(async () => {
  const value = fixture({renderer: "category", categorySymbols: Object.fromEntries(Array.from({length: 40}, (_, index) => [`Type ${index}`, "clinic"]))});
  await assert.rejects(capturePrintMap(value.context, value.record), /legend exceeds 40 rows/);
  const safe = fixture(), capture = await capturePrintMap(safe.context, safe.record);
  capture.legend[0].pointStyle.pointSymbol = "https://unbound.example/icon.svg";
  assert.throws(() => pageFor(safe, capture), /Unknown point symbol/);
  capture.legend[0].pointStyle.pointSymbol = "hospital";
  capture.legend[0].pointStyle.circleColor = "url(https://unbound.example/icon.svg)";
  assert.throws(() => pageFor(safe, capture), /Invalid point legend color/);
}));

test("print frames preserve their own clustering choice and remove absent overrides", () => {
  const value = fixture(), originalStyle = structuredClone(value.layer.style);
  value.layer.pointClustering = {enabled: true, radius: 44, maxZoom: 12};
  const layout = newProjectPrintLayout(value.record, "layout"), frame = layout.frames[0];
  const collection = {schemaVersion: PROJECT_PRINT_SCHEMA, projectId: value.record.id, layouts: [layout]};
  assert.deepEqual(validateProjectPrintLayouts(collection, value.record), collection);
  assert.deepEqual(frame.presentation[0].pointClustering, value.layer.pointClustering);
  value.layer.pointClustering.radius = 90;
  assert.equal(definitionForPrintFrame(value.record, frame).layers[0].pointClustering.radius, 44);
  frame.presentation[0].pointClustering.enabled = false;
  assert.equal(definitionForPrintFrame(value.record, frame).layers[0].pointClustering.enabled, false);
  delete frame.presentation[0].pointClustering;
  assert.equal(Object.hasOwn(definitionForPrintFrame(value.record, frame).layers[0], "pointClustering"), false);
  assert.deepEqual(value.layer.style, originalStyle);
  for (const invalid of [null, {enabled: true, radius: 15, maxZoom: 12}, {enabled: true, radius: 44, maxZoom: 23},
    {enabled: true, radius: 44, maxZoom: 12, distance: 100}]) {
    frame.presentation[0].pointClustering = invalid;
    assert.throws(() => validateProjectPrintLayouts(collection, value.record), /cluster/i);
  }
  delete value.layer.pointClustering;
  assert.equal(Object.hasOwn(printLayerPresentation(value.layer), "pointClustering"), false);
});

test("cluster passes preserve point legend styling and disclose zoom-dependent counts", async () => withPage(async () => {
  const value = fixture();
  value.layer.pointClustering = {enabled: true, radius: 44, maxZoom: 12};
  const cluster = {id: "health-clusters", type: "circle", paint: {"circle-color": "#2563eb"}},
    count = {id: "health-cluster-count", type: "symbol"};
  value.handle.clusterLayerIds = [cluster.id, count.id];
  value.handle.layerIds.unshift(cluster.id, count.id);
  value.context.map.getStyle = () => ({layers: [cluster, count, value.circle]});
  const capture = await capturePrintMap(value.context, value.record);
  assert.equal(capture.legend[0].color, "#dc2626");
  assert.equal(capture.legend[0].pointStyle.pointSymbol, "hospital");
  assert.deepEqual(capture.presentation[0].pointClustering, value.layer.pointClustering);
  assert.match(capture.legend[1].label, /44 screen pixels per Layer.*change with zoom/);
  assert.deepEqual(capture.displayNotes, [capture.legend[1].label]);
  const page = pageFor(value, capture);
  assert.match(page.textContent, /Counts group points/);
  const layout = newProjectPrintLayout(value.record, "layout");
  Object.assign(layout, {legend: false, northArrow: false, scaleBar: false, graticule: false});
  assert.match(printPageSvg(layout, new Map([["layout:main", capture]]), "layout").textContent, /44 screen pixels per Layer/);
}));
