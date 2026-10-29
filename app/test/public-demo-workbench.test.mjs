import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {WorkbenchView} from "../src/components/WorkbenchView.js";
import {emptyMapDefinition} from "../src/lib/mapDefinition.js";
import {spatialBodyDefinition} from "../src/lib/spatialBody.js";
import {savedProjectVersionFile} from "../src/lib/projectFileFormat.js";
import {readBrowserProjectFile} from "../src/lib/browserProjectFile.js";
import {describe, it} from "node:test";
import {JSDOM} from "jsdom";

import {PublicDemoWorkbench, createPublicDemoSource} from "../src/components/PublicDemoWorkbench.js";
import {DEFAULT_WORKBENCH_COLOR_MODE} from "../src/components/WorkbenchView.js";
import {StartPage} from "../src/components/StartPage.js";
import {BASEMAPS, STYLE_PALETTES} from "../src/lib/workbenchConfig.js";

const CATALOG = JSON.parse(await readFile(
  new URL("../src/data/public-demo-catalog.json", import.meta.url),
  "utf8"
));
const COMMUNITY_GEOJSON = JSON.parse(await readFile(
  new URL("../src/data/sample-public-facilities.geojson", import.meta.url),
  "utf8"
));
const MASSGIS = JSON.parse(await readFile(
  new URL("../src/data/massgis-enviroscreen.json", import.meta.url),
  "utf8"
));

if(process.env.OPEN_GEO_GPX_DIST){await checkGpxBrowser();process.exit(0);}

it("graphics failure retains Catalog additions and draft state, disables capture and recovers only on Retry", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url:"https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window), listeners = new Map();let shell, creates = 0, removes = 0;
  const layer = {layerId:"catalog-source",datasetId:"catalog-source",title:"Retained Catalog Layer",
    sourceType:"geojson-object",geometryType:"Point",visible:true,style:{},labels:{enabled:false}};
  const data = {type:"FeatureCollection",features:[{type:"Feature",properties:{name:"Retained"},
    geometry:{type:"Point",coordinates:[2,3]}}]};
  const map = {
    on(type, callback) {listeners.set(type,callback);}, off(type) {listeners.delete(type);},
    resize() {}, isStyleLoaded:()=>false, getZoom:()=>2, getBearing:()=>0,getPitch:()=>0,
    getCenter:()=>({lng:0,lat:0}),getStyle:()=>({version:8,sources:{},layers:[]}),getLayer:()=>null,
  };
  try {
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
    shell = WorkbenchView({workspace:{workspaceId:"50000000-0000-4000-8000-000000000001",title:"Graphics recovery"},
      project:emptyMapDefinition(),role:"local",publicDemo:true,restoreBrowserDraft:false,initialPanel:"catalog",
      browserCatalog:[{id:"retained",title:layer.title,load:async()=>({layer,geojson:data})}],
      rendererAdapter:{id:"maplibre",initialize(){},registerProtocol(){},createMap(){
        creates++;if(creates===1)throw Error("WebGL2 unavailable");return map;
      },disposeMap(){removes++;throw Error("SDK teardown failed");}}});
    document.body.append(shell);
    await waitFor(()=>shell.querySelector(".gis-map-startup-error"));
    assert.equal(creates,1);assert.equal(shell.getPrintContext().ready,false);
    assert.match(shell.getPrintContext().unavailableReason,/Map graphics unavailable/);
    let captures=0;
    await assert.rejects(shell.getPrintContext().withPrintResolution({maxWidth:600,maxHeight:300},()=>{captures++;}),/Retry the map/);
    assert.equal(captures,0);
    shell.querySelector('[aria-label="Review and add Retained Catalog Layer"]').click();
    const dialog = await waitFor(()=>document.querySelector(".browser-layer-registration"));
    dialog.querySelector("form").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
    await waitFor(()=>!dialog.isConnected);
    assert.equal(shell.__opengeoLayers.length,1);
    assert.deepEqual(shell.__opengeoData.get(shell.__opengeoLayers[0].layerId),data);
    assert.match(shell.querySelector('[data-status-field="message"]').textContent,/Layer was added/);
    assert.equal(creates,1,"Rendering the draft never retries graphics automatically");
    shell.querySelector(".gis-map-startup-error button").click();
    await waitFor(()=>listeners.has("webglcontextlost"));
    assert.equal(creates,2);assert.equal(shell.getPrintContext().map,map);
    assert.equal(shell.querySelector(".gis-map-startup-error"),null);
    assert.equal(shell.__opengeoLayers.length,1);
    map.resize = () => {throw Error("graphics resize failed");};
    const separator = shell.querySelector('[aria-label="Resize layers panel"]');
    assert.doesNotThrow(()=>separator.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true})));
    assert.equal(shell.getPrintContext().map,null);
    map.resize = () => {};
    shell.querySelector(".gis-map-startup-error button").click();
    await waitFor(()=>listeners.has("webglcontextlost"));
    assert.equal(creates,3);
    listeners.get("webglcontextlost")({});
    assert.equal(shell.getPrintContext().map,null);
    assert.equal(shell.__opengeoLayers.length,1);
    assert.match(shell.querySelector('[data-status-field="loading"]').textContent,/graphics unavailable/);
    assert.doesNotThrow(()=>shell.dispose());assert.doesNotThrow(()=>shell.dispose());
    assert.ok(removes>=1);
  } finally {shell?.dispose?.();shell?.remove();restore();dom.window.close();}
});

it("graphics display and camera-fit failures after Catalog add keep one committed Layer and close review", async () => {
  const dom = new JSDOM("<!doctype html><body></body>",{url:"https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window), listeners = new Map();let shell, fits=0;
  const layer = {layerId:"catalog-source",datasetId:"catalog-source",title:"Display failure Layer",sourceType:"geojson-object",
    geometryType:"Point",visible:true,style:{},labels:{enabled:false}};
  const data = {type:"FeatureCollection",features:[{type:"Feature",properties:{name:"Kept"},geometry:{type:"Point",coordinates:[2,3]}}]};
  const map = {on(type,callback){listeners.set(type,callback);},off(type){listeners.delete(type);},resize(){},
    isStyleLoaded:()=>false,getZoom:()=>2,getBearing:()=>0,getPitch:()=>0,getCenter:()=>({lng:0,lat:0}),
    getStyle:()=>({version:8,sources:{},layers:[]}),getLayer:()=>null,getSource:()=>null,
    addSource(){throw Error("graphics display failed");},fitBounds(){fits++;throw Error("camera painter unavailable");}};
  try {
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
    shell=WorkbenchView({workspace:{workspaceId:"50000000-0000-4000-8000-000000000001",title:"Add recovery"},
      project:emptyMapDefinition(),role:"local",publicDemo:true,restoreBrowserDraft:false,initialPanel:"catalog",
      browserCatalog:[{id:"display-failure",title:layer.title,load:async()=>({layer,geojson:data})}],
      rendererAdapter:{id:"maplibre",initialize(){},registerProtocol(){},createMap:()=>map,disposeMap(){}}});
    document.body.append(shell);await waitFor(()=>listeners.has("click"));
    shell.querySelector('[aria-label="Review and add Display failure Layer"]').click();
    const dialog=await waitFor(()=>document.querySelector(".browser-layer-registration"));
    dialog.querySelector("form").dispatchEvent(new dom.window.Event("submit",{bubbles:true,cancelable:true}));
    await waitFor(()=>!dialog.isConnected);
    assert.equal(shell.__opengeoLayers.length,1);assert.equal(fits,1);
    assert.deepEqual(shell.__opengeoData.get(shell.__opengeoLayers[0].layerId),data);
    assert.equal(shell.getPrintContext().ready,false);
    assert.match(shell.querySelector('[data-status-field="message"]').textContent,/Layer was added/);
    assert.equal(document.querySelector(".browser-layer-registration"),null);
  } finally {shell?.dispose?.();shell?.remove();restore();dom.window.close();}
});

it("browser Catalog cancellation ignores late reads and permits a deliberate retry without adding a Layer", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window); let shell;
  const reads = [];
  const candidate = {layer: {layerId: "original", title: "Pending source", sourceType: "geojson-object", geometryType: "Point", style: {}, labels: {}},
    geojson: {type: "FeatureCollection", features: []}};
  try {
    shell = WorkbenchView({workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Cancel Catalog"},
      project: emptyMapDefinition(), role: "local", publicDemo: true, restoreBrowserDraft: false, initialPanel: "catalog",
      browserCatalog: [{id: "pending", title: "Pending source", load: ({signal}) => new Promise((resolve, reject) => reads.push({signal, resolve, reject}))}]});
    document.body.append(shell);
    const row = shell.querySelector('[data-browser-catalog-layer="pending"]');
    const add = row.querySelector('[aria-label="Review and add Pending source"]');
    const cancel = row.querySelector('[aria-label="Cancel loading Pending source"]');
    add.click(); assert.equal(add.disabled, true); assert.equal(cancel.hidden, false);
    cancel.click(); assert.equal(reads[0].signal.aborted, true); assert.equal(add.disabled, false);
    assert.match(row.textContent, /Review cancelled/); assert.equal(cancel.hidden, true);
    add.click(); assert.equal(reads.length, 2);
    reads[0].resolve(candidate); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector(".browser-layer-registration"), null);
    assert.equal(add.disabled, true); assert.equal(shell.__opengeoLayers.length, 0);
    reads[1].resolve(candidate);
    await waitFor(() => document.querySelector(".browser-layer-registration"));
    assert.equal(document.querySelectorAll(".browser-layer-registration").length, 1);
    assert.equal(shell.__opengeoLayers.length, 0); assert.equal(add.disabled, false);
  } finally {shell?.dispose?.(); shell?.remove(); restore(); dom.window.close();}
});

it("browser Catalog search and disposal cancel owned review attempts without consuming a late shared read", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window); let shell;
  const reads = [];
  try {
    shell = WorkbenchView({workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Retire Catalog"},
      project: emptyMapDefinition(), role: "local", publicDemo: true, restoreBrowserDraft: false, initialPanel: "catalog",
      browserCatalog: [{id: "pending", title: "Pending source", load: ({signal}) => new Promise(resolve => reads.push({signal, resolve}))}]});
    document.body.append(shell);
    shell.querySelector('[aria-label="Review and add Pending source"]').click();
    const search = shell.querySelector('[aria-label="Search Layers"]');
    search.value = "other"; search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(reads[0].signal.aborted, true);
    search.value = ""; search.dispatchEvent(new dom.window.Event("input"));
    shell.querySelector('[aria-label="Review and add Pending source"]').click();
    shell.dispose(); assert.equal(reads[1].signal.aborted, true);
    for (const read of reads) read.resolve({layer: {title: "Late shared result"}});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.querySelector(".browser-layer-registration"), null);
    assert.equal(shell.__opengeoLayers.length, 0);
  } finally {shell?.dispose?.(); shell?.remove(); restore(); dom.window.close();}
});

it("selected Processing controls come first while unrelated analysis stays collapsed and reachable", async () => {
  const dom = new JSDOM("<!doctype html><body></body>",{url:"https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window);let shell;
  try {
    shell=WorkbenchView({workspace:{workspaceId:"50000000-0000-4000-8000-000000000001",title:"Focused processing"},
      project:emptyMapDefinition(),role:"local",publicDemo:true,restoreBrowserDraft:false,initialPanel:"processing"});
    document.body.append(shell);
    const selected=shell.querySelector(".gis-processing-selected-tool"), others=shell.querySelector(".gis-processing-other-tools");
    assert.ok(selected);assert.equal(others.open,false);
    assert.ok(selected.compareDocumentPosition(others)&dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.equal(selected.querySelector('[aria-label="Tool"]').value,"count");
    assert.ok([...selected.querySelectorAll("button")].some(button=>button.textContent==="Run"));
    others.open=true;others.dispatchEvent(new dom.window.Event("toggle"));
    const choice=selected.querySelector('[aria-label="Tool"]');choice.value="bounds";
    choice.dispatchEvent(new dom.window.Event("change",{bubbles:true}));
    assert.equal(shell.querySelector('.gis-processing-selected-tool [aria-label="Tool"]').value,"bounds");
    assert.equal(shell.querySelector(".gis-processing-other-tools").open,true);
    const menu=shell.querySelector('[data-menu="processing"]');menu.querySelector("button").click();
    const toolbox = [...shell.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === "Processing Toolbox");
    assert.ok(toolbox); toolbox.click(); shell.dispatchEvent(new dom.window.Event("workbench:render"));
    assert.equal(shell.querySelector('.gis-processing-selected-tool [aria-label="Tool"]').value,"bounds");
    assert.equal(shell.querySelector('.gis-processing-other-tools').open,true);
    shell.querySelector('[data-menu="processing"] button').click();
    [...shell.querySelectorAll('[role="menuitem"]')].find(button=>button.textContent==="Compare surface and terrain heights…").click();
    shell.dispatchEvent(new dom.window.Event("workbench:render"));
    const focused=shell.querySelector(".gis-processing-other-tools");
    assert.equal(focused.contains(shell.querySelector(".gis-processing-selected-tool")),true);
    const height=shell.querySelector(".gis-raster-height-difference");
    assert.ok(height);assert.equal(height.open,true);assert.equal(focused.contains(height),false);
  } finally {shell?.dispose?.();shell?.remove();restore();dom.window.close();}
});

it("Layer names keep full selection labels while information and ordering remain in existing overflow", () => {
  const dom=new JSDOM("<!doctype html><body></body>",{url:"https://studio.opengeo.tools/"});
  const restore=installDomGlobals(dom.window);let shell;
  const title="A long regional environmental monitoring Layer name with complete provenance";
  try {
    shell=WorkbenchView({workspace:{workspaceId:"50000000-0000-4000-8000-000000000001",title:"Layer names"},
      project:emptyMapDefinition(),role:"local",publicDemo:true,restoreBrowserDraft:false,
      layers:[{layerId:"long-name",title,sourceType:"geojson-object",geometryType:"Point",visible:true,style:{},labels:{}}]});
    document.body.append(shell);
    const row=shell.querySelector('[data-layer-id="long-name"]'), top=row.querySelector(".gis-layer-row-top"),more=row.querySelector(".gis-layer-more");
    assert.equal(top.children.length,4);assert.equal(top.querySelector(".gis-layer-name").textContent,title);
    assert.equal(top.querySelector(".gis-layer-name").getAttribute("aria-label"),`Select layer ${title}`);
    assert.ok(more.contains(row.querySelector(".gis-layer-order-controls")));
    more.open=true;row.querySelector(".gis-layer-info-toggle").click();
    assert.equal(row.querySelector(".gis-layer-info").hidden,false);
    assert.ok(row.querySelector(`[aria-label="Move ${title} up"]`));
    assert.ok(more.querySelector('button[title="Open attribute table"]'));
  } finally {shell?.dispose?.();shell?.remove();restore();dom.window.close();}
});

it("Workbench save shortcuts use the existing enabled command and respect modal, permission and Print boundaries", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspaces"});
  const restore = installDomGlobals(dom.window); const shells = []; let saves = 0;
  try {
    const options = {workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Keyboard save"},
      role: "owner", project: emptyMapDefinition(), layers: [], persistenceMode: "api", restoreBrowserDraft: false,
      saveProject: async definition => {saves++; return {id: "50000000-0000-4000-8000-000000000002", version: saves, definition};}};
    const keyListeners = new Set(), addListener = dom.window.addEventListener.bind(dom.window), removeListener = dom.window.removeEventListener.bind(dom.window);
    dom.window.addEventListener = (type, listener, options) => {if (type === "keydown") keyListeners.add(listener); return addListener(type, listener, options);};
    dom.window.removeEventListener = (type, listener, options) => {if (type === "keydown") keyListeners.delete(listener); return removeListener(type, listener, options);};
    const mount = overrides => {const shell = WorkbenchView({...options, ...overrides}); shell.getClientRects = () => [{}]; document.body.append(shell); shells.push(shell); return shell;};
    const shell = mount(), send = (target, options = {}) => {
      const event = new dom.window.KeyboardEvent("keydown", {key: "s", code: "KeyS", ctrlKey: true, bubbles: true, cancelable: true, ...options});
      target.dispatchEvent(event); return event;
    };
    let clicks = 0; shell.addEventListener("click", event => {if (event.target.closest(".gis-save-command")) clicks++;});
    assert.equal(send(shell).defaultPrevented, true); assert.equal(saves, 1); assert.equal(clicks, 1);
    await waitFor(() => shell.dataset.saveState === "saved");
    assert.equal(send(shell, {ctrlKey: false, metaKey: true}).defaultPrevented, true); assert.equal(saves, 2); assert.equal(clicks, 2);
    await waitFor(() => shell.dataset.saveState === "saved");
    const control = document.createElement("input"); shell.querySelector(".gis-top-actions").append(control); control.focus();
    shell.dispatchEvent(new dom.window.Event("workbench:render"));
    assert.equal(control.isConnected, false);
    assert.equal(document.activeElement, document.body);
    assert.equal(send(document.body).defaultPrevented, true, "Body focus after a full render still belongs to the only visible Workbench");
    assert.equal(saves, 3); await waitFor(() => shell.dataset.saveState === "saved");
    const outside = document.createElement("input"); document.body.append(outside);
    assert.equal(send(outside).defaultPrevented, false); assert.equal(saves, 3); outside.remove();
    shell.hidden = true; assert.equal(send(document.body).defaultPrevented, false); shell.hidden = false;
    shell.inert = true; shell.setAttribute("inert", ""); assert.equal(send(document.body).defaultPrevented, false); shell.removeAttribute("inert"); shell.inert = false;
    shell.getClientRects = () => []; assert.equal(send(document.body).defaultPrevented, false); shell.getClientRects = () => [{}];
    const other = mount(); assert.equal(send(document.body).defaultPrevented, false, "Two visible Workbenches cannot claim body focus");
    other.hidden = true; assert.equal(send(document.body).defaultPrevented, true); assert.equal(saves, 4); await waitFor(() => shell.dataset.saveState === "saved");
    other.dispose(); other.remove(); assert.equal(keyListeners.size, 1);
    const completedSaves = saves;
    for (const modifiers of [{shiftKey: true}, {altKey: true}, {ctrlKey: false, metaKey: false}]) {
      assert.equal(send(shell, modifiers).defaultPrevented, false); assert.equal(saves, completedSaves);
    }
    const prevented = new dom.window.KeyboardEvent("keydown", {key: "s", ctrlKey: true, bubbles: true, cancelable: true});
    prevented.preventDefault(); shell.dispatchEvent(prevented); assert.equal(saves, completedSaves);
    const save = shell.querySelector(".gis-save-command"); save.disabled = true;
    assert.equal(send(shell).defaultPrevented, false); assert.equal(saves, completedSaves); save.disabled = false;
    for (const tag of ["dialog", "section"]) {
      const dialog = document.createElement(tag), field = document.createElement("input");
      if (tag === "section") dialog.setAttribute("role", "dialog");
      dialog.append(field); shell.append(dialog);
      assert.equal(send(field).defaultPrevented, false); assert.equal(saves, completedSaves); dialog.remove();
    }
    const ownedModal = document.createElement("section"); ownedModal.setAttribute("role", "dialog"); shell.querySelector(".gis-modal-layer").append(ownedModal);
    assert.equal(send(shell).defaultPrevented, false); assert.equal(saves, completedSaves); ownedModal.remove();
    const denied = mount({role: "viewer"}); assert.equal(denied.querySelector(".gis-save-command").disabled, true);
    assert.equal(send(denied).defaultPrevented, false); assert.equal(saves, completedSaves);
    const print = mount({printFrame: {id: "print-preview"}}); assert.equal(send(print).defaultPrevented, false); assert.equal(saves, completedSaves);
    const personal = mount({publicDemo: true, role: "local"}); let personalClicks = 0;
    personal.querySelector(".gis-save-command").addEventListener("click", () => personalClicks++);
    assert.equal(send(personal).defaultPrevented, true);
    assert.equal(personal.querySelector(".gis-save-command").disabled, true, "The existing personal save command disables while its title prompt is pending");
    assert.equal(send(personal).defaultPrevented, false); assert.equal(personalClicks, 1);
    const prompt = await waitFor(() => document.querySelector(".local-project-title"));
    [...prompt.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
    await waitFor(() => !personal.querySelector(".gis-save-command").disabled);
    const listenersBeforeDispose = keyListeners.size; shell.dispose(); assert.equal(keyListeners.size, listenersBeforeDispose - 1);
    assert.equal(send(shell).defaultPrevented, false); assert.equal(saves, completedSaves);
  } finally {for (const shell of shells) {shell.dispose?.(); shell.remove();} restore(); dom.window.close();}
});

it("invalid optional social baseline data does not prevent opening the Project", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window); let shell;
  try {
    shell = WorkbenchView({workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Recover optional configuration"},
      role: "owner", project: emptyMapDefinition({extensions: {opengeoSocialBaseline: {schemaVersion: "unknown", layerIds: "invalid"}, other: {keep: true}}}),
      layers: [], persistenceMode: "fixture", restoreBrowserDraft: false, initialPanel: "processing",
      loadSocialBaselineKnowledge: () => assert.fail("Invalid configuration must not read metadata")});
    document.body.append(shell); assert.match(shell.querySelector('.project-social-baseline').textContent, /saved social baseline selection is invalid/);
  } finally {shell?.dispose?.(); shell?.remove(); restore(); dom.window.close();}
});

it("Workbench coordinate search navigates only on Go or Enter, rejects invalid positions, and retains loaded feature search", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window), listeners = new Map(), flights = [], fits = [];
  const originalFetch = globalThis.fetch;
  let shell, camera = {center: [-71, 42], zoom: 2};
  const map = {
    on(type, callback) {listeners.set(type, callback);}, off(type) {listeners.delete(type);}, resize() {},
    isStyleLoaded: () => false, getZoom: () => camera.zoom, getBearing: () => 0, getPitch: () => 0,
    getCenter: () => ({lng: camera.center[0], lat: camera.center[1]}), getLayer: () => null,
    getStyle: () => ({version: 8, sources: {}, layers: []}),
    flyTo(options) {flights.push(options); camera = {center: options.center, zoom: options.zoom};},
    fitBounds: (...args) => fits.push(args), queryRenderedFeatures: () => []
  };
  const layer = {layerId: "local-trail", datasetId: "local-trail", title: "Trails", sourceType: "geojson-object",
    geometryType: "LineString", visible: true, opacity: 1, style: {}, labels: {enabled: false}};
  const geojson = {type: "FeatureCollection", features: [{type: "Feature", properties: {name: "River trail", location: "42.36, -71.06"},
    geometry: {type: "LineString", coordinates: [[-71.2, 42.1], [-71, 42.4]]}}]};
  try {
    globalThis.fetch = () => assert.fail("Search must not request a provider or geocoder");
    globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
    shell = WorkbenchView({workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Coordinate navigation"},
      role: "owner", project: emptyMapDefinition(), layers: [layer], geojsonByLayerId: new Map([[layer.layerId, geojson]]),
      persistenceMode: "fixture", restoreBrowserDraft: false,
      rendererAdapter: {id: "maplibre", initialize() {}, registerProtocol() {}, createMap: () => map, disposeMap() {}}});
    document.body.append(shell);
    await waitFor(() => listeners.has("click"));
    const input = () => shell.querySelector('.gis-search input');
    const go = () => [...shell.querySelectorAll('.gis-search button')].find(button => button.textContent === "Go to coordinate");
    const enter = () => {const event = new dom.window.KeyboardEvent("keydown", {key: "Enter", bubbles: true, cancelable: true}); input().dispatchEvent(event); return event;};
    const type = value => {
      input().focus(); input().value = value; input().setSelectionRange(value.length, value.length);
      input().dispatchEvent(new dom.window.Event("input"));
      assert.equal(document.activeElement, input()); assert.equal(input().selectionStart, value.length);
    };
    assert.match(shell.querySelector('.gis-search').textContent, /WGS84 latitude, longitude in decimal degrees/);
    type("42.36, -71.06");
    assert.equal(flights.length, 0); assert.equal(fits.length, 0);
    assert.equal([...shell.querySelectorAll('.gis-search button')].some(button => button.textContent === "River trail"), true);
    go().click();
    assert.deepEqual(flights, [{center: [-71.06, 42.36], zoom: 12, duration: 350}]);
    assert.deepEqual(shell.getPrintContext().project.mapViews[0].center, [-71.06, 42.36]);
    assert.match(shell.querySelector('[data-status-field="message"]').textContent, /Going to WGS84 42.36, -71.06/);
    camera.zoom = 15;
    type(" -33.86, +151.21 ");
    assert.equal(flights.length, 1); assert.equal(enter().defaultPrevented, true);
    assert.deepEqual(flights.at(-1), {center: [151.21, -33.86], zoom: 15, duration: 350});
    for (const invalid of ["", "42.36", "42.36,", "91, 0", "0, -181", "NaN, 0", "Infinity, 0", "0, 1e309", "0x10, 0", "0, 0, 0", "90, 0", "-85.05112879, 0"]) {
      type(invalid); enter();
      assert.equal(flights.length, 2, invalid); assert.equal(fits.length, 0, invalid);
      assert.equal(input().getAttribute("aria-invalid"), "true", invalid);
      assert.equal(document.activeElement, input(), invalid);
      assert.match(shell.querySelector('.gis-search [role="status"]').textContent, /Enter WGS84|This map supports latitude/, invalid);
    }
    type("0, 180");
    assert.equal(input().getAttribute("aria-invalid"), "false");
    go().click(); assert.deepEqual(flights.at(-1), {center: [180, 0], zoom: 15, duration: 350});
    type("-85.05112878, -180"); go().click();
    assert.deepEqual(flights.at(-1), {center: [-180, -85.05112878], zoom: 15, duration: 350});
    type("River trail"); assert.equal(fits.length, 0);
    [...shell.querySelectorAll('.gis-search button')].find(button => button.textContent === "River trail").click();
    assert.deepEqual(fits, [[[[-71.2, 42.1], [-71, 42.4]], {padding: 80, maxZoom: 15, duration: 350}]]);
    assert.equal(flights.length, 4); assert.deepEqual(shell.__opengeoData.get(layer.layerId), geojson);
  } finally {shell?.dispose?.(); shell?.remove(); globalThis.fetch = originalFetch; restore(); dom.window.close();}
});

it("coordinate navigation is discoverable on an empty map and waits for Earth map availability", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window), shells = [];
  try {
    for (const body of ["earth", "moon"]) {
      const definition = emptyMapDefinition();
      definition.spatialBody = spatialBodyDefinition(body);
      const shell = WorkbenchView({workspace: {workspaceId: `coordinate-${body}`, title: "Empty map"}, role: "owner",
        project: definition, layers: [], persistenceMode: "fixture", restoreBrowserDraft: false});
      document.body.append(shell); shells.push(shell);
      const search = shell.querySelector('.gis-search'); assert(search);
      assert.equal(search.querySelector("button").disabled, true);
      if (body === "earth") assert.match(search.querySelector("button").title, /Wait for the map/);
      else assert.match(search.textContent, /available for Earth maps/);
    }
  } finally {for (const shell of shells) {shell.dispose(); shell.remove();} restore(); dom.window.close();}
});

it("restores a social baseline browser draft selection without metadata reads", () => {
  const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"});
  const restore = installDomGlobals(dom.window); let shell;
  try {
    const workspace = {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Draft review"};
    const layer = {layerId: "reviewed-layer", datasetId: "local-data", title: "Reviewed source", sourceType: "geojson-object", geometryType: "Polygon", visible: true, opacity: 1, style: {}, labels: {enabled: false}};
    const selection = {schemaVersion: "opengeo.project-social-baseline-selection.1.0.0", question: "What evidence supports this saved baseline?", layerIds: [layer.layerId]};
    localStorage.setItem(`opengeo.project.${workspace.workspaceId}.social-reopen`, JSON.stringify(emptyMapDefinition({layers: [layer], extensions: {opengeoSocialBaseline: selection}})));
    shell = WorkbenchView({workspace, role: "owner", project: emptyMapDefinition({extensions: {other: {preserved: true}}}),
      layers: [layer], persistenceMode: "fixture", draftScopeId: "social-reopen", initialPanel: "processing",
      loadSocialBaselineKnowledge: () => assert.fail("Restoring the selection must not read metadata")});
    document.body.append(shell);
    assert.equal(shell.querySelector('[aria-label="Social baseline question"]').value, selection.question);
    assert.equal(shell.querySelector('[aria-label="Evidence Layer 1"]').value, layer.layerId);
    assert.equal(shell.querySelector('.project-social-baseline button:last-child')?.textContent, "Refresh selected evidence reviews");
    assert.equal(shell.querySelector('.project-social-baseline').textContent.includes("Not loaded"), true);
  } finally {shell?.dispose?.(); shell?.remove(); restore(); dom.window.close();}
});

describe("public workbench demo source boundary", () => {
  for (const demo of [false, true]) it(`keeps ${demo ? "Demo" : "Studio Home"} menus separate from quick tools and scopes Demo actions`, () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: demo ? "https://demo.studio.opengeo.tools/" : "https://studio.opengeo.tools/"});
    const restore = installDomGlobals(dom.window);let root;
    try {
      root = demo ? PublicDemoWorkbench({catalog:CATALOG,geojson:COMMUNITY_GEOJSON,massgis:MASSGIS,fetchImpl:async()=>{throw Error("No provider");}}) : StartPage({catalog:{workspaces:[]}});
      document.body.append(root);root.querySelector(".start-empty-map")?.click();
      const workbench=root.querySelector(".opengeo-workbench");
      assert.equal(workbench.querySelector('.gis-app-nav a[href="/credits"]')?.textContent,"Credits");
      const project=()=>workbench.querySelector('.gis-menubar [data-menu="project"]');
      assert.equal(workbench.querySelector(".gis-toolstrip").firstElementChild.className,"gis-menubar");
      assert.equal(project(),workbench.querySelector(".gis-menubar").firstElementChild);
      project().querySelector("button").click();const menu=project().querySelector('[role="menu"]');
      for (const label of ["Demo home","Sample datasets","New empty demo map","Reset public demo","About demo privacy"]) assert.equal([...menu.querySelectorAll("button")].some(b=>b.textContent.includes(label)),demo,label);
      for (const label of ["Save on this device","Projects on this device","Open Project file…","Open Print Studio"]) assert.ok(menu.textContent.includes(label),label);
      if (!demo) {assert.ok(menu.textContent.includes("Open application home"));assert.ok(menu.textContent.includes("Browse projects"));assert.equal(workbench.querySelector('.gis-app-nav a[href="/?view=examples"]'),null);}
      workbench.querySelector(".gis-quick-tools-toggle").click();
      assert.equal(workbench.querySelector(".gis-toolstrip").firstElementChild.className,"gis-menubar");
      assert.equal(workbench.querySelector(".gis-primary-toolbar").hidden,true);
      workbench.querySelector(".gis-quick-tools-toggle").click();assert.equal(workbench.querySelector(".gis-primary-toolbar").hidden,false);
      workbench.querySelector('.gis-mobile-toolbar [data-primary-command="more"]').click();
      const sheet=workbench.querySelector(".gis-mobile-command-sheet");assert.ok(sheet);
      assert.equal(sheet.querySelector('.gis-mobile-command-navigation a[href="/credits"]')?.textContent,"Credits");
      assert.equal(Boolean(sheet.querySelector('.gis-mobile-command-navigation a[href="https://demo.studio.opengeo.tools/?view=catalog"]')),demo);
      const category=sheet.querySelector('[data-mobile-command-category="project"]');
      for(const label of ["Demo home","Sample datasets","Reset public demo","About demo privacy"]) assert.equal(category.textContent.includes(label),demo,label);
      sheet.querySelector('button[aria-label="Close actions"]').click();
    } finally {root?.dispose?.();root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("opens the map at Demo Home and reserves the directory for explicit Catalog navigation", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/"});
    const restore = installDomGlobals(dom.window);let reads=0, root;
    try {
      root=PublicDemoWorkbench({catalog:CATALOG,geojson:COMMUNITY_GEOJSON,massgis:MASSGIS,fetchImpl:async()=>{reads++;throw Error("No provider on Home");}});
      document.body.append(root);
      const map=root.querySelector(".opengeo-workbench");assert.ok(map);assert.equal(root.querySelector("#example-catalog"),null);
      assert.equal(root.querySelector('a[href="https://studio.opengeo.tools/"]')?.textContent,"Open Studio ↗");
      assert.ok(root.querySelector('.public-demo-information a[href="/credits"]'));
      assert.ok(root.querySelector('a[href="/?view=catalog"]'));
      assert.equal(map.__opengeoLayers.length,1);
      dom.window.history.pushState(null,"","/?view=catalog");dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      assert.equal(root.querySelector(".opengeo-workbench"),null);assert.equal(root.querySelectorAll("[data-catalog-layer]").length,31);
      dom.window.history.pushState(null,"","/?view=examples");dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces?view=data"]'));
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces?view=publishing"]'));
      dom.window.history.pushState(null,"","/");dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
      assert.ok(root.querySelector(".opengeo-workbench"));assert.equal(reads,0);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("Print data getter reuses complete in-memory sources and rejects display-only inputs without provider reads", () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/"});
    const restore = installDomGlobals(dom.window);let root, requests = 0;
    try {
      root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
        fetchImpl: async () => {requests++;throw Error("Print data must already be loaded");}});
      document.body.append(root);
      const shell = root.querySelector(".opengeo-workbench"), layer = shell.__opengeoLayers[0];
      const getSource = shell.getPrintContext().getPrintDataSource, geojson = shell.__opengeoData.get(layer.layerId);
      assert.equal(getSource("missing-layer"), null);
      Object.assign(layer, {datasetId: "survey", datasetVersionId: "survey-v2", sourceVersion: "2026", featureGeneration: 3,
        sourceConfiguration: {checksumSha256: "a".repeat(64), privateConfiguration: "must-stay-private"}});
      for (const sourceType of ["geojson-object", "geojson-archive", "governed-dataset", "arcgis-feature-layer-snapshot"]) {
        layer.sourceType = sourceType;
        const source = getSource(layer.layerId);
        assert.equal(source.geojson, geojson);
        assert.deepEqual(source.inputPin, {layerId: layer.layerId, datasetId: "survey", datasetVersionId: "survey-v2",
          sourceVersion: "2026", featureGeneration: 3, checksumSha256: "a".repeat(64)});
        assert.deepEqual(Object.keys(source).sort(), ["geojson", "id", "inputPin", "title"]);
      }
      for (const sourceType of ["arcgis-feature-layer", "wms-layer", "pmtiles", "cog"]) {
        layer.sourceType = sourceType;assert.equal(getSource(layer.layerId), null);
      }
      layer.sourceType = "governed-dataset";layer.managedDisplayId = "display";
      assert.equal(getSource(layer.layerId), null);
      delete layer.managedDisplayId;shell.__opengeoData.delete(layer.layerId);
      assert.equal(getSource(layer.layerId), null);
      assert.equal(requests, 0);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  for (const governed of [false, true]) it(`opens Identify Results immediately for ${governed ? "governed" : "local"} Layers and reopens after hiding`, () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/?map=community-facilities"});
    const restore = installDomGlobals(dom.window);let root;
    try {
      root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
        fetchImpl: async () => {throw Error("Identify must not fetch a provider");}});
      document.body.append(root);
      const shell = root.querySelector(".opengeo-workbench");
      if (governed) shell.__opengeoLayers[0].sourceType = "governed-dataset";
      const identify = () => shell.querySelector('.gis-primary-toolbar [data-primary-command="identify"]');
      identify().click();
      assert.equal(shell.querySelector('.gis-panel-right .gis-panel-header h2')?.textContent, "Identify Results");
      assert.match(shell.querySelector('.gis-identify-panel').textContent, /Click the map to inspect/);
      assert.equal(identify().getAttribute("aria-pressed"), "true");
      assert.equal(document.activeElement, shell.querySelector(".gis-identify-panel"));
      shell.querySelector('button[aria-label="Collapse inspector"]').click();
      identify().click();
      assert.equal(shell.querySelector('.gis-panel-right .gis-panel-header h2')?.textContent, "Identify Results");
      shell.dispatchEvent(new dom.window.KeyboardEvent("keydown", {key: "Escape", bubbles: true}));
      assert.equal(shell.classList.contains("right-collapsed"), true);
      identify().click();
      assert.equal(shell.classList.contains("right-collapsed"), false);
      assert.equal(identify().getAttribute("aria-pressed"), "true");
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("focuses completed governed Identify results without stealing focus after hiding or switching panels", {timeout: 5000}, async () => {
    const dom = new JSDOM("<!doctype html><body><button id='continue'>Continue working</button></body>", {url: "https://studio.opengeo.tools/workspaces"});
    const restore = installDomGlobals(dom.window);
    const listeners = new Map(), requests = [], featureBounds = [], popupLocations = [];
    const map = {
      on(type, callback) {listeners.set(type, callback);},
      off(type) {listeners.delete(type);},
      resize() {},
      isStyleLoaded: () => false,
      getZoom: () => 2,
      getBearing: () => 0,
      getPitch: () => 0,
      getCenter: () => ({lng: -71, lat: 42}),
      getLayer: () => null,
      getStyle: () => ({version: 8, sources: {}, layers: []}),
      fitBounds: (bounds) => featureBounds.push(bounds),
      queryRenderedFeatures: () => []
    };
    const layer = {layerId: "governed-facilities", datasetId: "70000000-0000-4000-8000-000000000001",
      title: "Governed facilities", sourceType: "governed-dataset", geometryType: "Point",
      visible: true, opacity: 1, order: 0, style: {}, labels: {enabled: false}};
    let shell, observer;
    try {
      globalThis.__OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__ = false;
      shell = WorkbenchView({workspace: {workspaceId: "50000000-0000-4000-8000-000000000001", title: "Identify acceptance"},
        role: "owner", project: emptyMapDefinition(), layers: [layer], persistenceMode: "fixture", restoreBrowserDraft: false,
        rendererAdapter: {id: "maplibre", initialize() {}, registerProtocol() {}, createMap: () => map, disposeMap() {},
          createPopup: () => ({
            setLngLat(location) {popupLocations.push(location);return this;},
            setDOMContent() {return this;},
            addTo() {return this;}
          })},
        queryDatasetFeatures: (datasetId, query, options) => new Promise(resolve => requests.push({datasetId, query, options, resolve}))});
      document.body.append(shell);
      await waitFor(() => listeners.has("click"));
      for (const mode of ["results", "hidden", "switched"]) {
        shell.querySelector('.gis-primary-toolbar [data-primary-command="identify"]').click();
        listeners.get("click")({lngLat: {lng: -71, lat: 42}, point: {x: 100, y: 100}});
        assert.equal(requests.length, ["results", "hidden", "switched"].indexOf(mode) + 1);
        assert.equal(shell.querySelector(".gis-identify-panel").dataset.identifyState, "running");
        assert.equal(document.activeElement, shell.querySelector(".gis-identify-panel"), "pending results receive focus");
        const request = requests.at(-1);
        assert.equal(request.datasetId, layer.datasetId);
        assert.deepEqual(request.query.steps[0].geometry.coordinates, [-71, 42]);
        if (mode === "hidden") shell.querySelector('button[aria-label="Collapse inspector"]').click();
        if (mode === "switched") shell.querySelector('button[aria-label="Open attribute table"]').click();
        const continueButton = document.querySelector("#continue");
        if (mode !== "results") continueButton.focus();
        const completed = new Promise(resolve => {
          observer = new MutationObserver(() => {
            if (shell.querySelector('[data-status-field="message"]').textContent === "1 matches across 1 checked visible layers.") {
              observer.disconnect(); resolve();
            }
          });
          observer.observe(shell, {childList: true, subtree: true});
        });
        request.resolve({features: [{type: "Feature", id: "clinic", geometry: {type: "Point", coordinates: [-71, 42]},
          properties: {name: "Governed clinic", capacity: 12}}], numberMatched: 1, numberReturned: 1, generation: 7});
        await completed;
        assert.equal(request.options.signal.aborted, false, "panel choices do not cancel the governed result");
        if (mode === "results") {
          const panel = shell.querySelector(".gis-identify-panel");
          assert.equal(panel.dataset.identifyState, "ready");
          assert.equal(panel.querySelector("h3").textContent, layer.title);
          assert.match(panel.textContent, /Governed clinic/);
          assert.match(panel.querySelector("dl").textContent, /capacity12/);
          assert.equal(document.activeElement, panel, "completed results retain keyboard focus after rendering");
          panel.querySelector('button[aria-label="Open Governed clinic from Governed facilities"]').click();
          assert.equal(shell.querySelector('[data-status-field="message"]').textContent, "Governed clinic selected from Governed facilities.");
          assert.deepEqual(featureBounds, [[[-71, 42], [-71, 42]]]);
          assert.deepEqual(popupLocations, [[-71, 42]]);
        } else {
          assert.equal(document.activeElement, continueButton, mode);
          if (mode === "hidden") assert.equal(shell.classList.contains("right-collapsed"), true);
          else assert.equal(shell.querySelector(".gis-identify-panel"), null);
        }
      }
    } finally {observer?.disconnect();shell?.dispose();shell?.remove();restore();dom.window.close();}
  });

  it("starts in the shared Observable near-midnight workbench theme", () => {
    assert.equal(DEFAULT_WORKBENCH_COLOR_MODE, "dark");
  });

  it("uses an attributed key-free default instead of a stale anonymous CARTO endpoint", () => {
    assert.ok(BASEMAPS.some(({basemapId}) => basemapId === "openfreemap-positron"));
    assert.ok(BASEMAPS.every(({url}) => !url?.includes("cartocdn.com")));
    assert.ok(BASEMAPS.every(({url}) => !url?.includes("tile.openstreetmap.org")));
    for (const basemap of BASEMAPS.filter(({url}) => url)) {
      assert.match(basemap.attribution, /NASA|USGS/);
      assert.match(basemap.url, /^https:/);
      assert.doesNotMatch(basemap.url, /[?&](?:key|token|api_key)=/i);
    }
  });

  it("offers the six key-free OpenFreeMap styles indexed from GeoLibre 2.6.0", () => {
    const expected = new Map([
      ["Liberty", "https://tiles.openfreemap.org/styles/liberty"],
      ["Liberty 3D", "https://tiles.openfreemap.org/styles/liberty"],
      ["Positron", "https://tiles.openfreemap.org/styles/positron"],
      ["Bright", "https://tiles.openfreemap.org/styles/bright"],
      ["Dark", "https://tiles.openfreemap.org/styles/dark"],
      ["Fiord", "https://tiles.openfreemap.org/styles/fiord"]
    ]);
    const openFreeMap = BASEMAPS.filter(({section}) => section === "OpenFreeMap");
    assert.equal(openFreeMap.length, expected.size);
    for (const basemap of openFreeMap) {
      assert.equal(basemap.kind, "maplibre-style");
      assert.equal(basemap.styleUrl, expected.get(basemap.title));
      assert.match(basemap.attribution, /OpenFreeMap.*OpenMapTiles.*OpenStreetMap/);
      assert.doesNotMatch(basemap.styleUrl, /[?#]|@/);
    }
  });

  it("accepts a bounded public HTTPS tile source without persisting credentials", async () => {
    const source = await createPublicDemoSource({
      name: "Public tiles",
      source: {
        type: "xyz",
        url: "https://tiles.example.org/{z}/{x}/{y}.png",
        minZoom: 0,
        maxZoom: 18,
        tileSize: 256
      }
    });
    assert.equal(source.sourceType, "xyz");
    assert.equal(source.sourceUrl, "https://tiles.example.org/{z}/{x}/{y}.png");
    assert.equal(source.classification, "browser-only-demo");
    assert.equal(source.configuration.url, undefined);
  });

  for (const url of [
    "http://tiles.example.org/{z}/{x}/{y}.png",
    "https://localhost/tiles",
    "https://127.0.0.1/tiles",
    "https://10.2.3.4/tiles",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@tiles.example.org/tiles",
    "https://tiles.example.org/tiles?api_key=secret"
  ]) {
    it(`rejects unsafe demo URL ${url}`, async () => {
      await assert.rejects(
        createPublicDemoSource({name: "Unsafe", source: {type: "xyz", url}}),
        TypeError
      );
    });
  }

  it("rejects connector types that would imply private or server-side access", async () => {
    await assert.rejects(
      createPublicDemoSource({
        name: "Database",
        source: {type: "postgres", url: "https://db.example.org"}
      }),
      /supports XYZ, WMS, and PMTiles/
    );
  });

  it("aborts an in-flight statewide request when the public workbench is detached", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://demo.opengeo.tools/?map=massgis-pm25-concentration"
    });
    const restoreGlobals = installDomGlobals(dom.window);
    let requestSignal = null;
    try {
      const root = PublicDemoWorkbench({
        catalog: CATALOG,
        geojson: COMMUNITY_GEOJSON,
        massgis: MASSGIS,
        fetchImpl: async (_url, {signal}) => {
          requestSignal = signal;
          return new Promise(() => {});
        }
      });
      dom.window.document.body.append(root);
      await waitFor(() => requestSignal);
      assert.equal(requestSignal.aborted, false);

      root.remove();
      await waitFor(() => requestSignal.aborted);
      assert.equal(requestSignal.aborted, true);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("publishes a metadata-only directory with direct links to all MassGIS maps", async () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://demo.studio.opengeo.tools/?view=examples"
    });
    const restoreGlobals = installDomGlobals(dom.window);
    let requests = 0;
    try {
      const root = PublicDemoWorkbench({
        catalog: CATALOG,
        geojson: COMMUNITY_GEOJSON,
        massgis: MASSGIS,
        fetchImpl: async () => {
          requests += 1;
          throw new Error("the publication directory must not load the statewide archive");
        }
      });
      dom.window.document.body.append(root);

      assert.equal(root.dataset.surface, "published-examples");
      assert.equal(root.querySelector("h1")?.textContent, "Explore OpenGeo Studio");
      assert.equal(root.querySelector('a[href="/workspaces"]'), null);
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces"]'));
      assert.equal(root.querySelectorAll("#example-catalog [data-catalog-layer]").length, 31);
      assert.equal(root.querySelectorAll("#example-publications a").length, 4);
      assert.deepEqual([...root.querySelectorAll('#example-publications a')].map(link => link.getAttribute('href')),
        ['/?publication=framework', '/?publication=notebook', '/?publication=jupyter', '/?publication=html']);
      assert.equal(root.querySelectorAll('nav[aria-label="Map briefings"] a').length, 2);
      assert.equal(root.querySelectorAll('a[data-page-id^="massgis-"]').length, 31);
      assert.equal(
        root.querySelector('a[data-page-id="massgis-pm25-concentration"]')?.getAttribute("href"),
        "/?map=massgis-pm25-concentration"
      );
      assert.equal(requests, 0);
      assert.ok(root.querySelector("#satellite-scenes .platform-static-item-search"));
      assert.equal(root.querySelector("#satellite-scenes .platform-static-item-search").open, false);
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces?view=publishing"]'));
      assert.ok(root.querySelector('a[href="https://studio.opengeo.tools/workspaces?view=data"]'));
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("shows Catalog and Publications on explicit examples navigation without loading providers", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "https://demo.studio.opengeo.tools/?view=examples"});
    const restoreGlobals = installDomGlobals(dom.window);
    try {
      const root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
        fetchImpl: async () => { throw Error("provider reads are forbidden on the overview"); }});
      assert.ok(root.querySelector("#example-catalog"));
      assert.ok(root.querySelector("#example-publications"));
      assert.equal(root.querySelector('.public-demo-directory-actions a[href="/credits"]')?.textContent,"Open source & credits");
      const query = root.querySelector('input[type="search"]'); query.value = "Public community";
      query.dispatchEvent(new dom.window.Event("input"));
      assert.equal(root.querySelectorAll("[data-catalog-layer]").length, 1);
      assert.equal(root.querySelector("[data-catalog-layer] a").getAttribute("href"), "/?layer=community-facilities");
    } finally { restoreGlobals(); dom.window.close(); }
  });

  it("opens an authored Publication and computes its summary from the same Layer", () => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {url: "https://demo.studio.opengeo.tools/?publication=community-access"});
    const restoreGlobals = installDomGlobals(dom.window);
    try {
      const root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS});
      assert.equal(root.dataset.surface, "example-publication");
      assert.equal(root.querySelector("h1").textContent, "Community facilities: a spatial briefing");
      assert.equal([...root.querySelectorAll("tbody tr")].reduce((sum, row) => sum + Number(row.lastChild.textContent), 0), COMMUNITY_GEOJSON.features.length);
      assert.match(root.textContent, /invented facilities/);
      assert.equal(root.querySelector(".gis-workbench"), null);
    } finally { restoreGlobals(); dom.window.close(); }
  });

  it("lists all31 examples from the overview Catalog without fetching providers, then opens one Layer alone", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/?view=catalog"});
    const restoreGlobals = installDomGlobals(dom.window);let requests = 0;
    try {
      const root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
        fetchImpl: async () => {requests++;throw Error("Listing must remain metadata-only");}});
      dom.window.document.body.append(root);
      assert.equal(root.querySelectorAll("#example-catalog [data-catalog-layer]").length, 31);
      assert.match(root.querySelector("#example-catalog [role=status]").textContent, /31 of 31 Layers/);
      root.querySelector('[data-catalog-layer="community-facilities"] a').click();
      await waitFor(() => root.querySelector(".opengeo-workbench"));
      assert.equal(root.dataset.surface, "catalog-layer-preview");
      const workbench = root.querySelector(".opengeo-workbench");
      assert.equal(workbench.__opengeoLayers.length, 1);
      assert.equal(workbench.__opengeoData.get(workbench.__opengeoLayers[0].layerId).features.length, COMMUNITY_GEOJSON.features.length);
      assert.equal(requests, 0);root.remove();await Promise.resolve();
    } finally {restoreGlobals();dom.window.close();}
  });

  it("opens GPX from the normal file chooser on Demo and Studio local maps, with review before adding", async () => {
    const bytes=await readFile(new URL('../../fixtures/gps/source-survey.gpx',import.meta.url));
    for(const demo of [true,false]) {
      const dom=new JSDOM('<!doctype html><body></body>',{url:demo?'https://demo.studio.opengeo.tools/?map=community-facilities':'https://studio.opengeo.tools/'});
      const restore=installDomGlobals(dom.window);let root;
      try {
        root=demo?PublicDemoWorkbench({catalog:CATALOG,geojson:COMMUNITY_GEOJSON,massgis:MASSGIS,fetchImpl:()=>{throw Error('No provider');}}):StartPage({catalog:{workspaces:[]}});
        document.body.append(root);root.querySelector('.start-empty-map')?.click();
        const map=await waitFor(()=>root.querySelector('.opengeo-workbench')),before=map.__opengeoLayers.length;
        const open=()=>[...map.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open file').click();
        const choose=()=>{const input=document.querySelector('.opengeo-project-file-input');assert(input.accept.includes('.gpx'));Object.defineProperty(input,'files',{value:[new File([bytes],'survey.gpx',{type:'application/gpx+xml'})]});input.dispatchEvent(new dom.window.Event('change'));};
        open();choose();let dialog=await waitFor(()=>document.querySelector('.browser-layer-registration'));
        assert.equal(map.__opengeoLayers.length,before);assert(dialog.textContent.includes('1 waypoints · 1 routes · 1 tracks · 4 segments'));
        assert(dialog.textContent.includes('Download original GPX'));if(!demo)assert(!/demo/i.test(dialog.textContent));
        [...dialog.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click();assert.equal(map.__opengeoLayers.length,before);
        open();choose();dialog=await waitFor(()=>document.querySelector('.browser-layer-registration'));
        dialog.querySelector('[aria-label="Layer title"]').value='Reviewed GPS';dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));
        await waitFor(()=>map.__opengeoLayers.length===before+1);
        const layer=map.__opengeoLayers.find(l=>l.title==='Reviewed GPS');assert.equal(layer.sourceType,'geojson-object');assert.equal(layer.metadata.source.format,'gpx');assert.equal(layer.metadata.source.report.counts.positions,8);
        assert.equal(map.__opengeoData.get(layer.layerId).features.length,5);assert.equal(layer.metadata.curated.title,'Reviewed GPS');assert.equal(document.querySelector('dialog'),null);
      }finally{root?.querySelector('.opengeo-workbench')?.dispose();root?.remove();restore();dom.window.close();}
    }
  });

  it("account-map GPX opens as temporary data and a map Save cannot upload or retain it as a governed source", async()=>{
    const dom=new JSDOM('<!doctype html><body></body>',{url:'https://studio.opengeo.tools/workspaces'}),restore=installDomGlobals(dom.window);
    let map,saved,uploads=0;
    try {
      map=WorkbenchView({workspace:{workspaceId:'70000000-0000-4000-8000-000000000011',name:'Account map'},role:'owner',project:emptyMapDefinition(),layers:[],persistenceMode:'api',
        importLocalFile:async()=>{uploads++;throw Error('No managed upload');},saveProject:async definition=>{saved=definition;return{id:'70000000-0000-4000-8000-000000000012',version:1,definition};}});
      document.body.append(map);[...map.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open file').click();
      const input=document.querySelector('.opengeo-project-file-input'),bytes=await readFile(new URL('../../fixtures/gps/source-survey.gpx',import.meta.url));
      Object.defineProperty(input,'files',{value:[new File([bytes],'survey.gpx')]});input.dispatchEvent(new dom.window.Event('change'));
      const dialog=await waitFor(()=>document.querySelector('.browser-layer-registration'));assert(dialog.textContent.includes('excluded from account Save'));assert(!/demo/i.test(dialog.textContent));
      dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await waitFor(()=>map.__opengeoLayers.length===1);
      const layer=map.__opengeoLayers[0];assert.equal(layer.temporaryWork.authority,'none');assert.equal(layer.metadata.source.format,'gpx');
      [...map.querySelectorAll('button')].find(b=>b.textContent.trim()==='Save').click();await waitFor(()=>saved);
      assert.deepEqual(saved.layers,[]);assert.equal(uploads,0);
    }finally{map?.dispose();map?.remove();restore();dom.window.close();}
  });

  for (const demo of [true, false]) it(`delimited CSV chooser on ${demo ? "Demo" : "Studio Home"} rejects invalid records and requires mapping, omission and Layer review`, async () => {
    const bytes = await readFile(new URL("../../fixtures/gps/coordinate-survey.csv", import.meta.url));
    const dom = new JSDOM("<!doctype html><body></body>", {url: demo ? "https://demo.studio.opengeo.tools/" : "https://studio.opengeo.tools/"});
    const restore = installDomGlobals(dom.window);let root;
    try {
      root = demo ? PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS, fetchImpl: () => {throw Error("No provider");}}) : StartPage({catalog: {workspaces: []}});
      document.body.append(root);root.querySelector(".start-empty-map")?.click();
      const map = await waitFor(() => root.querySelector(".opengeo-workbench")), before = map.__opengeoLayers.length;
      const choose = () => chooseWorkbenchFile(map, dom, new File([bytes], "coordinate-survey.csv", {type: "text/csv"}));
      choose();let mapping = await waitFor(() => document.querySelector(".delimited-text-import"));
      assert.equal(mapping.querySelector('[aria-label="Source coordinate system"]').value, "");
      assert.equal(mapping.querySelector('[aria-label="Omit records that cannot be mapped"]').checked, false);
      assert.equal(mapping.querySelector('[aria-label="Source values preview"] tbody').rows.length, 3);
      assert(mapping.querySelector('[aria-label="Source values preview"]').textContent.includes('first line\nsecond "quoted" line'));
      assert(mapping.textContent.includes("00123"));assert(mapping.textContent.includes("9007199254740993"));
      assert.equal(map.__opengeoLayers.length, before);
      [...mapping.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
      assert.equal(document.querySelector("dialog"), null);assert.equal(map.__opengeoLayers.length, before);

      const configure = dialog => {
        for (const [label, value] of Object.entries({"Source coordinate system": "EPSG:4326", "Longitude / easting column": "east", "Latitude / northing column": "north", "Elevation column": "height_ft", "Elevation unit": "foot", "Vertical datum (optional)": "Survey datum supplied by operator", "Label column": "site"})) dialog.querySelector(`[aria-label="${label}"]`).value = value;
      };
      choose();mapping = await waitFor(() => document.querySelector(".delimited-text-import"));configure(mapping);
      mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      assert.match(mapping.querySelector('[role="status"]').textContent, /1 of 3 records cannot be mapped/);
      assert.equal(mapping.querySelector('[aria-label="Records that cannot be mapped"] li').textContent, "Record 4: Invalid or missing east");
      assert.equal(document.querySelectorAll(".browser-layer-registration").length, 1);assert.equal(map.__opengeoLayers.length, before);
      mapping.querySelector('[aria-label="Omit records that cannot be mapped"]').checked = true;
      mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      let review = await waitFor(() => document.querySelector(".browser-layer-registration:not(.delimited-text-import)"));
      assert(review.textContent.includes("2 of 3 mapped · 1 omitted by your choice · original retained"));
      assert(review.textContent.includes("east / north · EPSG:4326 → WGS 84"));
      assert(review.textContent.includes("height_ft · foot → metres · 1 supplied · 1 missing"));
      assert(review.textContent.includes("Record 4: Invalid or missing east"));
      assert(review.textContent.includes("Download original delimited file"));
      if (!demo) assert(!/demo/i.test(review.textContent));
      assert.equal(map.__opengeoLayers.length, before);
      [...review.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
      assert.equal(document.querySelector("dialog"), null);assert.equal(map.__opengeoLayers.length, before);

      choose();mapping = await waitFor(() => document.querySelector(".delimited-text-import"));configure(mapping);
      mapping.querySelector('[aria-label="Omit records that cannot be mapped"]').checked = true;
      mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      review = await waitFor(() => document.querySelector(".browser-layer-registration:not(.delimited-text-import)"));
      review.querySelector('[aria-label="Layer title"]').value = "Reviewed coordinate survey";
      review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      await waitFor(() => map.__opengeoLayers.length === before + 1);
      const layer = map.__opengeoLayers.find(layer => layer.title === "Reviewed coordinate survey"), data = map.__opengeoData.get(layer.layerId);
      assert.equal(layer.sourceType, "geojson-object");assert.deepEqual(layer.labels, {enabled: true, field: "site"});
      assert.deepEqual(data.features.map(feature => feature.geometry.coordinates), [[85.3, 27.7, 30.48], [85.31, 27.71]]);
      assert.equal(data.features[0].properties.identifier, "00123");assert.equal(data.features[1].properties.identifier, "9007199254740993");
      assert.equal(data.features[0].properties.notes, 'first line\nsecond "quoted" line');assert.equal(data.features[1].properties.notes, "=not a formula");
      assert.equal(layer.metadata.source.report.mapping.skipInvalid, true);assert.equal(layer.metadata.curated.title, layer.title);
      assert.deepEqual(Buffer.from(layer.metadata.source.originalFile.content, "base64"), bytes);assert.equal(document.querySelector("dialog"), null);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  for (const demo of [true, false]) it(`delimited TSV chooser on ${demo ? "Demo" : "Studio Home"} maps explicit projected coordinates, height and labels`, async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: demo ? "https://demo.studio.opengeo.tools/" : "https://studio.opengeo.tools/"});
    const restore = installDomGlobals(dom.window);let root;
    try {
      root = demo ? PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS, fetchImpl: () => {throw Error("No provider");}}) : StartPage({catalog: {workspaces: []}});
      document.body.append(root);root.querySelector(".start-empty-map")?.click();
      const map = await waitFor(() => root.querySelector(".opengeo-workbench")), before = map.__opengeoLayers.length;
      chooseWorkbenchFile(map, dom, new File(["e\tn\tz\tname\tid\r\n1113194.9079327357\t0\t100\tProjected point\t0007\r\n"], "projected-survey.tsv", {type: "text/tab-separated-values"}));
      const mapping = await waitFor(() => document.querySelector(".delimited-text-import"));
      assert.equal(mapping.querySelector('[aria-label="Separator"]').value, "\t");
      assert.equal(mapping.querySelector('[aria-label="Source values preview"] thead').rows[0].cells.length, 5);
      for (const [label, value] of Object.entries({"Source coordinate system": "EPSG:3857", "Longitude / easting column": "e", "Latitude / northing column": "n", "Elevation column": "z", "Elevation unit": "us-survey-foot", "Label column": "name"})) mapping.querySelector(`[aria-label="${label}"]`).value = value;
      mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      const review = await waitFor(() => document.querySelector(".browser-layer-registration:not(.delimited-text-import)"));
      assert(review.textContent.includes("e / n · EPSG:3857 → WGS 84"));assert(review.textContent.includes("1 of 1 mapped · 0 omitted"));
      assert.equal(map.__opengeoLayers.length, before);review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      await waitFor(() => map.__opengeoLayers.length === before + 1);
      const layer = map.__opengeoLayers.find(layer => layer.metadata?.source?.filename === "projected-survey.tsv"), feature = map.__opengeoData.get(layer.layerId).features[0];
      assert(Math.abs(feature.geometry.coordinates[0] - 10) < 1e-10);assert(Math.abs(feature.geometry.coordinates[1]) < 1e-10);
      assert(Math.abs(feature.geometry.coordinates[2] - 100 * (1200 / 3937)) < 1e-10);
      assert.equal(feature.properties.e, "1113194.9079327357");assert.equal(feature.properties.id, "0007");
      assert.deepEqual(layer.labels, {enabled: true, field: "name"});assert.equal(layer.metadata.source.delimiter, "\t");
      assert.equal(layer.metadata.source.report.mapping.verticalDatum, null);assert.equal(layer.metadata.source.report.mapping.skipInvalid, false);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("delimited account-map Open file keeps mapped points temporary and excludes their source from account Save", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspaces"}), restore = installDomGlobals(dom.window);
    let map, saved, uploads = 0;
    try {
      map = WorkbenchView({workspace: {workspaceId: "70000000-0000-4000-8000-000000000011", name: "Account map"}, role: "owner", project: emptyMapDefinition(), layers: [], persistenceMode: "api",
        importLocalFile: async () => {uploads++;throw Error("No managed upload");}, saveProject: async definition => {saved = definition;return {id: "70000000-0000-4000-8000-000000000012", version: 1, definition};}});
      document.body.append(map);chooseWorkbenchFile(map, dom, new File(["longitude,latitude,label\n85.3,27.7,Local survey\n"], "temporary-survey.csv"));
      const mapping = await waitFor(() => document.querySelector(".delimited-text-import"));
      assert.equal(mapping.querySelector('[aria-label="Longitude / easting column"]').value, "longitude");assert.equal(mapping.querySelector('[aria-label="Latitude / northing column"]').value, "latitude");
      mapping.querySelector('[aria-label="Source coordinate system"]').value = "EPSG:4326";mapping.querySelector('[aria-label="Label column"]').value = "label";
      mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      const review = await waitFor(() => document.querySelector(".browser-layer-registration:not(.delimited-text-import)"));
      assert(review.textContent.includes("excluded from account Save"));assert(!/demo/i.test(review.textContent));assert.equal(map.__opengeoLayers.length, 0);
      review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));await waitFor(() => map.__opengeoLayers.length === 1);
      const layer = map.__opengeoLayers[0];assert.equal(layer.temporaryWork.authority, "none");assert.equal(layer.metadata.source.format, "delimited-text");
      assert.deepEqual(layer.labels, {enabled: true, field: "label"});assert.deepEqual(map.__opengeoData.get(layer.layerId).features[0].geometry.coordinates, [85.3, 27.7]);
      [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Save").click();await waitFor(() => saved);
      assert.deepEqual(saved.layers, []);assert.doesNotMatch(JSON.stringify(saved), /temporary-survey|originalFile|delimited-text/);assert.equal(uploads, 0);
      assert.equal(map.__opengeoLayers.length, 1);
    } finally {map?.dispose();map?.remove();restore();dom.window.close();}
  });

  it("delimited changes preserve ordinary managed CSV table Add data through the existing upload callback", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspaces"}), restore = installDomGlobals(dom.window);
    let map;const uploads = [];
    try {
      map = WorkbenchView({workspace: {workspaceId: "70000000-0000-4000-8000-000000000011", name: "Account map"}, role: "owner", project: emptyMapDefinition(), layers: [], persistenceMode: "api",
        importLocalFile: async (file, report) => {uploads.push(file);report("verified", "Table verified.");return {dataset: {name: "Ordinary table"}, versionNumber: 3};}});
      document.body.append(map);[...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Add data").click();
      assert.notEqual(map.querySelector('[aria-label="Source type"]').value, "csv");
      const file = new File(["id,label\n0007,No coordinate columns\n"], "ordinary-table.csv", {type: "text/csv"}), input = map.querySelector('.gis-file-drop input[type="file"]');
      Object.defineProperty(input, "files", {value: [file]});input.dispatchEvent(new dom.window.Event("change"));
      await waitFor(() => map.dataset.importState === "queued");
      assert.equal(uploads.length, 1);assert.strictEqual(uploads[0], file);assert.equal(await uploads[0].text(), "id,label\n0007,No coordinate columns\n");
      assert.equal(document.querySelector(".delimited-text-import"), null);assert.equal(map.__opengeoLayers.length, 0);
      assert.match(map.querySelector(".gis-statusbar").textContent, /Ordinary table is now a governed dataset queued at version 3/);
    } finally {map?.dispose();map?.remove();restore();dom.window.close();}
  });

  it("delimited Point colors use an explicit uniform choice on Studio Home and retain style in a browser Project", async () => {
    const raw = "longitude,latitude,status,identifier\n85.3,27.7,active,0001\n85.31,27.71,planned,0002\n";
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"}), restore = installDomGlobals(dom.window);let root;
    try {
      root = StartPage({catalog: {workspaces: []}});document.body.append(root);root.querySelector(".start-empty-map").click();
      const map = await waitFor(() => root.querySelector(".opengeo-workbench"));
      chooseWorkbenchFile(map, dom, new File([raw], "status-points.csv", {type: "text/csv"}));
      const mapping = await waitFor(() => document.querySelector(".delimited-text-import"));
      const color = mapping.querySelector('[aria-label="Point color"]'), category = mapping.querySelector('[aria-label="Color category column"]'), palette = mapping.querySelector('[aria-label="Category palette"]');
      assert.equal(color.type, "color");assert.equal(color.value, "#06b6d4");assert.equal(category.value, "");
      assert.equal(category.selectedOptions[0].textContent, "One color");assert.equal(palette.value, "opengeo");assert.equal(palette.disabled, true);
      assert.deepEqual([...palette.options].map(option => option.value), STYLE_PALETTES.filter(([, , colors]) => colors.length).map(([id]) => id));
      assert([...category.options].some(option => option.value === "status"));
      color.value = "#123456";color.dispatchEvent(new dom.window.Event("input"));mapping.querySelector('[aria-label="Source coordinate system"]').value = "EPSG:4326";
      mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      const review = await waitFor(() => document.querySelector(".browser-layer-registration:not(.delimited-text-import)"));
      assert(review.textContent.includes("Point styling"));assert(review.textContent.includes("#123456"));assert.match(review.textContent, /one color|uniform/i);
      assert.equal(map.__opengeoLayers.length, 0);review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      await waitFor(() => map.__opengeoLayers.length === 1);
      const layer = map.__opengeoLayers[0], data = map.__opengeoData.get(layer.layerId);
      assert.deepEqual(layer.style, {renderer: "single", circleColor: "#123456", circleRadius: 6, stroke: "#123456", strokeWidth: 2});
      assert.deepEqual(layer.metadata.curated.pointPresentation, {mode: "single", color: "#123456", categoryField: null, paletteName: null});
      assert.deepEqual(data.features.map(feature => feature.properties.status), ["active", "planned"]);assert.equal(data.features[0].properties.identifier, "0001");
      assert.equal(Buffer.from(layer.metadata.source.originalFile.content, "base64").toString("utf8"), raw);
      assert.doesNotMatch(JSON.stringify(layer.metadata.source.report), /pointPresentation|paletteName|categoryField/);
      const reopened = readBrowserProjectFile(JSON.stringify({...map.getPrintContext().project, persistence: {mode: "browser-draft"}})).layers[0];
      assert.deepEqual(reopened.style, layer.style);assert.deepEqual(reopened.metadata, layer.metadata);assert.deepEqual(reopened.geojson, data);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("delimited Point colors preserve explicit Demo categories, review Cancel and managed temporary style without account Save", async () => {
    const raw = "longitude,latitude,risk class,identifier\n85.3,27.7,Low risk,0007\n85.31,27.71,High risk,0008\n";
    const expected = {renderer: "category", circleColor: "#654321", circleRadius: 6, stroke: "#654321", strokeWidth: 2, categoryField: "risk class", paletteName: "water", palette: STYLE_PALETTES.find(([id]) => id === "water")[2]};
    for (const managed of [false, true]) {
      const dom = new JSDOM("<!doctype html><body></body>", {url: managed ? "https://studio.opengeo.tools/workspaces" : "https://demo.studio.opengeo.tools/"}), restore = installDomGlobals(dom.window);
      let root, map, saved, uploads = 0;
      try {
        root = managed ? WorkbenchView({workspace: {workspaceId: "70000000-0000-4000-8000-000000000011", name: "Account map"}, role: "owner", project: emptyMapDefinition(), layers: [], persistenceMode: "api",
          importLocalFile: async () => {uploads++;throw Error("No managed upload");}, saveProject: async definition => {saved = definition;return {id: "70000000-0000-4000-8000-000000000012", version: 1, definition};}})
          : PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS, fetchImpl: () => {throw Error("No provider");}});
        document.body.append(root);map = managed ? root : await waitFor(() => root.querySelector(".opengeo-workbench"));
        const before = map.__opengeoLayers.length;
        const choose = async () => {
          chooseWorkbenchFile(map, dom, new File([raw], "category-points.csv", {type: "text/csv"}));
          const mapping = await waitFor(() => document.querySelector(".delimited-text-import"));
          const category = mapping.querySelector('[aria-label="Color category column"]'), palette = mapping.querySelector('[aria-label="Category palette"]');
          assert([...category.options].some(option => option.value === "risk class"));category.value = "risk class";category.dispatchEvent(new dom.window.Event("change"));
          assert.equal(palette.disabled, false);palette.value = "water";palette.dispatchEvent(new dom.window.Event("change"));
          const color = mapping.querySelector('[aria-label="Point color"]');color.value = "#654321";color.dispatchEvent(new dom.window.Event("input"));
          mapping.querySelector('[aria-label="Source coordinate system"]').value = "EPSG:4326";mapping.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
          return waitFor(() => document.querySelector(".browser-layer-registration:not(.delimited-text-import)"));
        };
        let review = await choose();assert(review.textContent.includes("Point styling"));assert(review.textContent.includes("risk class"));assert.match(review.textContent, /water/i);assert(review.textContent.includes("#654321"));
        assert.equal(map.__opengeoLayers.length, before);
        if (!managed) {
          [...review.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();assert.equal(document.querySelector("dialog"), null);assert.equal(map.__opengeoLayers.length, before);
          review = await choose();assert.equal(map.__opengeoLayers.length, before);
        } else assert(review.textContent.includes("excluded from account Save"));
        review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));await waitFor(() => map.__opengeoLayers.length === before + 1);
        const layer = map.__opengeoLayers.find(layer => layer.metadata?.source?.filename === "category-points.csv"), data = map.__opengeoData.get(layer.layerId);
        assert.deepEqual(layer.style, expected);assert.deepEqual(layer.metadata.curated.pointPresentation, {mode: "category", color: "#654321", categoryField: "risk class", paletteName: "water"});
        assert.deepEqual(data.features.map(feature => feature.properties["risk class"]), ["Low risk", "High risk"]);assert.equal(data.features[0].properties.identifier, "0007");
        assert.equal(Buffer.from(layer.metadata.source.originalFile.content, "base64").toString("utf8"), raw);assert.doesNotMatch(JSON.stringify(layer.metadata.source.report), /pointPresentation|paletteName|categoryField/);
        if (managed) {
          assert.equal(layer.temporaryWork.authority, "none");[...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Save").click();await waitFor(() => saved);
          assert.deepEqual(saved.layers, []);assert.doesNotMatch(JSON.stringify(saved), /category-points|pointPresentation|risk class/);assert.equal(uploads, 0);
        }
      } finally {map?.dispose();root?.remove();restore();dom.window.close();}
    }
  });

  for (const demo of [true, false]) it(`NMEA chooser on ${demo ? "Demo" : "Studio Home"} reviews omissions, cancels unchanged and requires explicit WGS 84 confirmation`, async () => {
    const bytes = await readFile(new URL("../../fixtures/gps/source-observations.nmea", import.meta.url));
    const dom = new JSDOM("<!doctype html><body></body>", {url: demo ? "https://demo.studio.opengeo.tools/" : "https://studio.opengeo.tools/"});
    const restore = installDomGlobals(dom.window);let root;
    try {
      root = demo ? PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS, fetchImpl: () => {throw Error("No provider");}}) : StartPage({catalog: {workspaces: []}});
      document.body.append(root);root.querySelector(".start-empty-map")?.click();
      const map = await waitFor(() => root.querySelector(".opengeo-workbench")), before = map.__opengeoLayers.length;
      [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Catalog").click();
      const catalogBefore = map.querySelectorAll("[data-browser-catalog-layer]").length;
      const choose = () => chooseWorkbenchFile(map, dom, new File([bytes], "source-observations.nmea", {type: "text/plain"}));
      choose();let review = await waitFor(() => document.querySelector(".browser-layer-registration"));
      assert.equal(review.querySelector("h2").textContent, "Review Layer source");assert(review.textContent.includes("NMEA observations"));
      assert(review.textContent.includes("3 mapped observations · 10 source records · 5 rejected · 2 other records preserved"));
      assert.equal(review.querySelectorAll("details li").length, 5);assert.match(review.querySelector("details").textContent, /checksum/i);
      assert(review.querySelector("details").textContent.includes("RMC observation has no active fix."));
      assert(review.querySelector("details").textContent.includes("Checksum does not match the sentence."));
      assert(review.textContent.includes("Working points are XY"));
      assert(review.textContent.includes("Download original NMEA"));if (!demo) assert(!/demo/i.test(review.textContent));
      assert.equal(map.__opengeoLayers.length, before);assert.equal(map.querySelectorAll("[data-browser-catalog-layer]").length, catalogBefore);
      [...review.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
      assert.equal(document.querySelector("dialog"), null);assert.equal(map.__opengeoLayers.length, before);
      assert.equal(map.querySelectorAll("[data-browser-catalog-layer]").length, catalogBefore);

      choose();review = await waitFor(() => document.querySelector(".browser-layer-registration"));
      const wgs84 = review.querySelector('input[aria-label="These positions use WGS 84 longitude/latitude."]');
      const omissions = review.querySelector('input[aria-label="Add the valid observations and retain rejected records in the original file."]');
      assert(wgs84 && omissions);assert(wgs84.required && omissions.required);assert(!wgs84.checked && !omissions.checked);
      const submit = () => review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      submit();assert.equal(map.__opengeoLayers.length, before);assert(review.isConnected);
      wgs84.checked = true;wgs84.dispatchEvent(new dom.window.Event("change"));submit();
      assert.equal(map.__opengeoLayers.length, before);assert(review.isConnected);assert.equal(map.querySelectorAll("[data-browser-catalog-layer]").length, catalogBefore);
      omissions.checked = true;omissions.dispatchEvent(new dom.window.Event("change"));
      review.querySelector('[aria-label="Layer title"]').value = "Reviewed NMEA observations";submit();
      await waitFor(() => map.__opengeoLayers.length === before + 1);
      const layer = map.__opengeoLayers.find(layer => layer.title === "Reviewed NMEA observations"), data = map.__opengeoData.get(layer.layerId);
      assert.equal(layer.sourceType, "geojson-object");assert.equal(layer.metadata.source.format, "nmea");
      assert.equal(data.features.length, 3);assert(data.features.every(feature => feature.geometry.type === "Point"));
      assert.deepEqual(data.features.map(feature => feature.geometry.coordinates), [[85.3, 27.7], [85.3, 27.7], [-151.21, -33.86]]);
      assert.equal(layer.metadata.source.report.rejectedRecords.length, 5);assert.equal(layer.metadata.source.report.preservedRecords.length, 2);
      assert.deepEqual(layer.metadata.source.report.rejectedRecords.map(record => record.code), ["invalid-fix", "invalid-fix", "checksum-invalid", "unsupported-mode", "checksum-missing"]);
      assert.equal(layer.metadata.curated.coordinateReferenceMethod, "user-confirmed");assert.equal(layer.metadata.curated.rejectedRecordPolicy, "explicit-omit-original-retained");
      assert.deepEqual(Buffer.from(layer.metadata.source.originalFile.content, "base64"), bytes);assert.equal(document.querySelector("dialog"), null);
      [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Catalog").click();
      assert.equal(map.querySelectorAll("[data-browser-catalog-layer]").length, catalogBefore + 1);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("NMEA account-map Add data keeps observations temporary and excludes their source from account Save", async () => {
    const bytes = await readFile(new URL("../../fixtures/gps/source-observations.nmea", import.meta.url));
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/workspaces"}), restore = installDomGlobals(dom.window);
    let map, saved, uploads = 0;
    try {
      map = WorkbenchView({workspace: {workspaceId: "70000000-0000-4000-8000-000000000011", name: "Account map"}, role: "owner", project: emptyMapDefinition(), layers: [], persistenceMode: "api",
        importLocalFile: async () => {uploads++;throw Error("No managed upload");}, saveProject: async definition => {saved = definition;return {id: "70000000-0000-4000-8000-000000000012", version: 1, definition};}});
      document.body.append(map);[...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Add data").click();
      const input = map.querySelector('.gis-file-drop input[type="file"]');assert(input.accept.includes(".nmea"));assert(input.accept.includes(".nme"));
      Object.defineProperty(input, "files", {value: [new File([bytes], "source-observations.nme", {type: "text/plain"})]});input.dispatchEvent(new dom.window.Event("change"));
      const review = await waitFor(() => document.querySelector(".browser-layer-registration"));
      assert(review.textContent.includes("excluded from account Save"));assert(!/demo/i.test(review.textContent));assert.equal(map.__opengeoLayers.length, 0);
      for (const label of ["These positions use WGS 84 longitude/latitude.", "Add the valid observations and retain rejected records in the original file."]) {
        const checkbox = review.querySelector(`input[aria-label="${label}"]`);assert(checkbox?.required);checkbox.checked = true;checkbox.dispatchEvent(new dom.window.Event("change"));
      }
      review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));await waitFor(() => map.__opengeoLayers.length === 1);
      const layer = map.__opengeoLayers[0];assert.equal(layer.temporaryWork.authority, "none");assert.equal(layer.metadata.source.format, "nmea");
      assert.deepEqual(Buffer.from(layer.metadata.source.originalFile.content, "base64"), bytes);assert(map.__opengeoData.get(layer.layerId).features.length > 0);
      [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Save").click();await waitFor(() => saved);
      assert.deepEqual(saved.layers, []);assert.doesNotMatch(JSON.stringify(saved), /source-observations|originalFile|nmea/);assert.equal(uploads, 0);
      assert.equal(map.__opengeoLayers.length, 1);
    } finally {map?.dispose();map?.remove();restore();dom.window.close();}
  });

  it("OziExplorer browser import on Studio Home reviews WPT omissions, cancels unchanged and retains the original in Project files", async () => {
    const bytes = await readFile(new URL("../../fixtures/gps/source-waypoints.wpt", import.meta.url));
    const {createHash} = await import("node:crypto"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://studio.opengeo.tools/"}), restore = installDomGlobals(dom.window);let root;
    try {
      root = StartPage({catalog: {workspaces: []}});document.body.append(root);root.querySelector(".start-empty-map").click();
      const map = await waitFor(() => root.querySelector(".opengeo-workbench"));
      [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Catalog").click();
      const beforeLayers = structuredClone(map.__opengeoLayers), beforeData = structuredClone([...map.__opengeoData]);
      const catalogBefore = map.querySelectorAll("[data-browser-catalog-layer]").length;
      const choose = () => chooseWorkbenchFile(map, dom, new File([bytes], "source-waypoints.wpt", {type: "text/plain"}));
      choose();let review = await waitFor(() => document.querySelector(".browser-layer-registration"));
      assert.equal(review.querySelector("h2").textContent, "Review Layer source");assert(review.textContent.includes("OziExplorer records"));
      assert(review.textContent.includes(sha256));assert(review.textContent.includes("ASCII"));assert.match(review.textContent, /WGS\s?84/);
      assert.match(review.textContent, /XY/);assert.match(review.textContent, /feet/i);assert.match(review.textContent, /style/i);assert.match(review.textContent, /attachment/i);
      assert([...review.querySelectorAll("button")].some(button => button.textContent === "Download original OziExplorer file"));assert(!/demo/i.test(review.textContent));
      assert.deepEqual(map.__opengeoLayers, beforeLayers);assert.deepEqual([...map.__opengeoData], beforeData);
      [...review.querySelectorAll("button")].find(button => button.textContent === "Cancel").click();
      assert.equal(document.querySelector("dialog"), null);assert.deepEqual(map.__opengeoLayers, beforeLayers);assert.deepEqual([...map.__opengeoData], beforeData);
      assert.equal(map.querySelectorAll("[data-browser-catalog-layer]").length, catalogBefore);

      choose();review = await waitFor(() => document.querySelector(".browser-layer-registration"));
      assert.equal(review.querySelector('input[aria-label="These positions use WGS 84 longitude/latitude."]'), null);
      const omissions = review.querySelector('input[aria-label="Add the valid positions and retain rejected records in the original file."]');
      assert(omissions?.required);assert.equal(omissions.checked, false);
      const submit = () => review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));
      submit();assert.deepEqual(map.__opengeoLayers, beforeLayers);assert(review.isConnected);
      omissions.checked = true;omissions.dispatchEvent(new dom.window.Event("change"));
      review.querySelector('[aria-label="Layer title"]').value = "Reviewed Ozi waypoints";
      review.querySelector('[aria-label="Description"]').value = "Reviewed locally";submit();
      await waitFor(() => map.__opengeoLayers.length === beforeLayers.length + 1);
      const layer = map.__opengeoLayers.find(layer => layer.title === "Reviewed Ozi waypoints"), data = map.__opengeoData.get(layer.layerId), source = layer.metadata.source;
      assert.equal(layer.sourceType, "geojson-object");assert.equal(layer.geometryType, "Point");assert.equal(source.format, "ozi");assert.equal(source.variant, "wpt");
      assert.equal(source.sha256, sha256);assert.deepEqual(Buffer.from(source.originalFile.content, "base64"), bytes);
      assert.equal(source.report.counts.waypoints, data.features.length);assert.equal(source.report.counts.positions, data.features.length);
      assert(source.report.rejectedRecords.length > 0);assert.equal(source.report.counts.records, data.features.length + source.report.rejectedRecords.length);
      assert.equal(source.report.headerRecords.length, 4);assert(data.features.every(feature => feature.geometry.type === "Point" && feature.geometry.coordinates.length === 2));
      assert.deepEqual(data.features.map(feature => feature.geometry.coordinates), [[85.3, 27.7], [-151.21, -33.86]]);
      assert(data.features.every(feature => typeof feature.properties.name === "string" && Array.isArray(feature.properties.ozi.fields)));
      assert.equal(layer.metadata.normalized.crs, "OGC:CRS84");assert.equal(layer.metadata.curated.description, "Reviewed locally");assert.equal(document.querySelector("dialog"), null);
      const reopened = readBrowserProjectFile(JSON.stringify({...map.getPrintContext().project, persistence: {mode: "browser-draft"}})).layers.find(value => value.layerId === layer.layerId);
      assert.deepEqual(reopened.metadata, layer.metadata);assert.deepEqual(reopened.geojson, data);assert.deepEqual(reopened.style, layer.style);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restore();dom.window.close();}
  });

  it("OziExplorer browser import preserves PLT gaps and singleton runs on Demo and keeps account Add data temporary", async () => {
    const bytes = await readFile(new URL("../../fixtures/gps/source-track.plt", import.meta.url));
    for (const managed of [false, true]) {
      const dom = new JSDOM("<!doctype html><body></body>", {url: managed ? "https://studio.opengeo.tools/workspaces" : "https://demo.studio.opengeo.tools/"}), restore = installDomGlobals(dom.window);
      let root, map, saved, uploads = 0;
      try {
        root = managed ? WorkbenchView({workspace: {workspaceId: "70000000-0000-4000-8000-000000000011", name: "Account map"}, role: "owner", project: emptyMapDefinition(), layers: [], persistenceMode: "api",
          importLocalFile: async () => {uploads++;throw Error("No managed upload");}, saveProject: async definition => {saved = definition;return {id: "70000000-0000-4000-8000-000000000012", version: 1, definition};}})
          : PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS, fetchImpl: () => {throw Error("No provider");}});
        document.body.append(root);map = managed ? root : await waitFor(() => root.querySelector(".opengeo-workbench"));
        const before = map.__opengeoLayers.length, file = new File([bytes], "source-track.plt", {type: "text/plain"});
        if (managed) {
          [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Add data").click();
          const input = map.querySelector('.gis-file-drop input[type="file"]');assert(input.accept.includes(".wpt"));assert(input.accept.includes(".plt"));
          Object.defineProperty(input, "files", {value: [file]});input.dispatchEvent(new dom.window.Event("change"));
        } else chooseWorkbenchFile(map, dom, file);
        const review = await waitFor(() => document.querySelector(".browser-layer-registration"));assert(review.textContent.includes("OziExplorer records"));assert.equal(map.__opengeoLayers.length, before);
        assert.equal(review.querySelector('input[aria-label="These positions use WGS 84 longitude/latitude."]'), null);
        const omissions = review.querySelector('input[aria-label="Add the valid positions and retain rejected records in the original file."]');
        assert(omissions?.required);omissions.checked = true;omissions.dispatchEvent(new dom.window.Event("change"));
        if (managed) {assert(review.textContent.includes("excluded from account Save"));assert(!/demo/i.test(review.textContent));}
        review.querySelector("form").dispatchEvent(new dom.window.Event("submit", {cancelable: true}));await waitFor(() => map.__opengeoLayers.length === before + 1);
        const layer = map.__opengeoLayers.find(layer => layer.metadata?.source?.filename === "source-track.plt"), data = map.__opengeoData.get(layer.layerId), source = layer.metadata.source;
        assert.equal(layer.sourceType, "geojson-object");assert.equal(layer.geometryType, "GeometryCollection");assert.equal(source.format, "ozi");assert.equal(source.variant, "plt");
        assert.deepEqual(Buffer.from(source.originalFile.content, "base64"), bytes);assert(source.report.rejectedRecords.length > 0);
        assert(data.features.some(feature => feature.geometry.type === "Point"));assert(data.features.some(feature => feature.geometry.type === "LineString"));
        assert.deepEqual(data.features.map(feature => feature.geometry), [
          {type: "LineString", coordinates: [[85.3, 27.7], [85.31, 27.71]]},
          {type: "Point", coordinates: [85.33, 27.73]},
          {type: "LineString", coordinates: [[85.34, 27.74], [85.35, 27.75]]}
        ]);
        assert.equal(source.report.counts.segments, data.features.length);
        for (const feature of data.features) {
          const positions = feature.geometry.type === "Point" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
          assert(positions.every(position => position.length === 2));assert.equal(feature.properties.ozi.points.length, positions.length);
        }
        if (managed) {
          assert.equal(layer.temporaryWork.authority, "none");assert.equal(layer.temporaryWork.format, "ozi");
          const key = Object.keys(localStorage).find(key => key.startsWith("opengeo.temporary-work."));assert(key);
          const entry = JSON.parse(localStorage.getItem(key)).entries.find(entry => entry.layer.layerId === layer.layerId);
          assert.equal(entry.layer.geometryType, "GeometryCollection");assert.deepEqual(entry.layer.metadata, layer.metadata);assert.deepEqual(entry.geojson, data);
          [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Save").click();await waitFor(() => saved);
          assert.deepEqual(saved.layers, []);assert.doesNotMatch(JSON.stringify(saved), /source-track|originalFile|"ozi"/);assert.equal(uploads, 0);assert.equal(map.__opengeoLayers.length, 1);
        }
      } finally {map?.dispose();root?.remove();restore();dom.window.close();}
    }
  });

  it("imports native1.6 saved snapshots through the normal creation review without losing3D records or granting old identity", async()=>{
    const dom=new JSDOM('<!doctype html><body></body>',{url:'https://studio.opengeo.tools/workspaces'}),restore=installDomGlobals(dom.window);let map,created;
    try {
      const fixture=JSON.parse(await readFile(new URL('../../fixtures/map-measurements/polygon-3d.json',import.meta.url))),definition={...emptyMapDefinition(),schemaVersion:'opengeo.map-definition.1.6.0',measurements:[fixture.records[0]]};
      map=WorkbenchView({workspace:{workspaceId:'70000000-0000-4000-8000-000000000011',name:'Current access context'},role:'owner',project:emptyMapDefinition(),layers:[],persistenceMode:'api',
        saveProjectAs:async value=>{created=value;return{id:'70000000-0000-4000-8000-000000000012',name:value.name,version:1,definition:value.definition};}});
      document.body.append(map);[...map.querySelectorAll('button')].find(b=>b.textContent.trim()==='Open file').click();
      const input=document.querySelector('.opengeo-project-file-input'),source=savedProjectVersionFile('old-id-is-not-authority',{version:42,definition});
      Object.defineProperty(input,'files',{value:[new File([source],'face.opengeo-project.json')]});input.dispatchEvent(new dom.window.Event('change'));
      const dialog=await waitFor(()=>document.querySelector('.browser-project-open-dialog'));
      const open=[...dialog.querySelectorAll('button')].find(b=>b.textContent==='Create a new map…');assert(open&&!open.disabled);open.click();
      const form=await waitFor(()=>map.querySelector('.gis-save-as-dialog form'));form.dispatchEvent(new dom.window.Event('submit',{cancelable:true}));await waitFor(()=>created);
      assert.deepEqual(created.definition,definition);assert.equal(typeof created.creationKey,'string');assert.equal(created.projectId,undefined);
      assert.equal(document.querySelector('.browser-project-open-dialog'),null);
    }finally{map?.dispose();map?.remove();restore();dom.window.close();}
  });

  it("opens a populated toolbar Catalog, clears an empty search, and reviews/adds existing data in the same browser map", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/?map=community-facilities"});
    const restoreGlobals = installDomGlobals(dom.window);let requests = 0;
    try {
      const root = PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
        fetchImpl: async () => {requests++;throw Error("Listing must not fetch MassGIS");}});
      dom.window.document.body.append(root);await waitFor(() => root.querySelector(".opengeo-workbench"));
      const workbench = root.querySelector(".opengeo-workbench"), before = workbench.__opengeoLayers.length;
      [...workbench.querySelectorAll("button")].find(button => button.textContent.trim() === "Catalog").click();
      assert.equal(workbench.querySelectorAll("[data-browser-catalog-layer]").length, 31);
      assert.match(workbench.textContent, /31 of 31 Layers/);
      const search = workbench.querySelector('input[aria-label="Search Layers"]');
      search.value = "unmatched example";search.dispatchEvent(new dom.window.Event("input"));
      assert.equal(workbench.querySelectorAll("[data-browser-catalog-layer]").length, 0);
      [...workbench.querySelectorAll("button")].find(button => button.textContent === "Clear search").click();
      assert.equal(workbench.querySelectorAll("[data-browser-catalog-layer]").length, 31);
      workbench.querySelector('[data-browser-catalog-layer="community-facilities"] button').click();
      const dialog = await waitFor(() => dom.window.document.querySelector(".browser-layer-registration"));
      assert.match(dialog.querySelector('input[aria-label="License"]').value, /CC0/);
      assert.equal(workbench.__opengeoLayers.length, before);
      dialog.querySelector("form").dispatchEvent(new dom.window.Event("submit", {bubbles: true, cancelable: true}));
      await waitFor(() => workbench.__opengeoLayers.length === before + 1);
      assert.strictEqual(root.querySelector(".opengeo-workbench"), workbench);
      const added = workbench.__opengeoLayers.find(layer => layer.browserCatalogId === "community-facilities");
      assert(added);
      assert.equal(workbench.__opengeoData.get(added.layerId).features.length, COMMUNITY_GEOJSON.features.length);
      assert.equal(requests, 0);root.remove();await Promise.resolve();
    } finally {restoreGlobals();dom.window.close();}
  });

  it("opens local Print Studio, saves/reopens layout settings and preserves the original local data and styles", async () => {
    const dom = new JSDOM("<!doctype html><body></body>", {url: "https://demo.studio.opengeo.tools/?map=community-facilities"});
    const restoreGlobals = installDomGlobals(dom.window);let requests = 0, root;
    const make = () => PublicDemoWorkbench({catalog: CATALOG, geojson: COMMUNITY_GEOJSON, massgis: MASSGIS,
      fetchImpl: async () => {requests++;throw Error("No provider read is allowed");}});
    const button = (scope, label) => {const found = [...scope.querySelectorAll("button")].find(item => item.textContent.trim() === label || item.getAttribute("aria-label") === label);assert.ok(found, label);return found;};
    const openPrint = async workbench => {
      button(workbench, "Project").click();button(workbench, "Open Print Studio").click();
      return waitFor(() => document.querySelector("dialog.browser-print-studio"));
    };
    try {
      root = make();document.body.append(root);
      const workbench = root.querySelector(".opengeo-workbench");
      const originalLayers = structuredClone(workbench.__opengeoLayers), originalData = structuredClone(workbench.__opengeoData);
      const before = localStorage.length;
      let dialog = await openPrint(workbench);
      assert.equal(localStorage.length, before, "opening Print must not save a draft");
      assert.equal(dialog.querySelector("h2").textContent, "Print Studio");
      assert.doesNotMatch(dialog.textContent, /Open Publishing|Project edit access is required/);
      const printMap = dialog.querySelector(".opengeo-workbench");
      assert.deepEqual(printMap.__opengeoData, originalData);
      assert.notEqual(printMap.__opengeoData.values().next().value, workbench.__opengeoData.values().next().value);
      assert.equal(button(printMap, "Save locally").disabled, true, "frame controls must not save a separate map draft");
      const title = dialog.querySelector('[aria-label="Layout title"]');title.value = "Local clinic map";title.dispatchEvent(new dom.window.Event("change"));
      button(dialog, "Back to map").click();assert.ok(dialog.isConnected, "unsaved layout blocks closing");
      await button(dialog, "Save layout").onclick();
      assert.match(dialog.textContent, /Layout saved with this browser draft/);
      assert.deepEqual(workbench.__opengeoLayers, originalLayers);assert.deepEqual(workbench.__opengeoData, originalData);
      const key = Object.keys(localStorage).find(key => key.startsWith("opengeo.public-demo.") && key !== "opengeo.public-demo.layer-catalog.v1");
      const saved = JSON.parse(localStorage.getItem(key));
      assert.equal(saved.extensions.opengeoPrintLayouts.layouts[0].title, "Local clinic map");
      assert.deepEqual(saved.layers[0].geojson, originalData.get(saved.layers[0].layerId));
      assert.doesNotMatch(JSON.stringify(saved.extensions.opengeoPrintLayouts), /data:image|base64/);
      button(dialog, "Back to map").click();assert.equal(dialog.isConnected, false);
      workbench.dispose();root.remove();root = make();document.body.append(root);
      dialog = await openPrint(root.querySelector(".opengeo-workbench"));
      assert.equal(dialog.querySelector('[aria-label="Layout title"]').value, "Local clinic map");
      const beforeFailure = localStorage.getItem(key);
      const caption = dialog.querySelector('[aria-label="Caption"]');caption.value = "Keep this unsaved draft";caption.dispatchEvent(new dom.window.Event("change"));
      const setItem = dom.window.Storage.prototype.setItem;
      dom.window.Storage.prototype.setItem = () => {throw Error("quota");};
      try {await button(dialog, "Save layout").onclick();}
      finally {dom.window.Storage.prototype.setItem = setItem;}
      assert.match(dialog.textContent, /browser could not save the layout/);
      assert.equal(localStorage.getItem(key), beforeFailure, "a quota failure preserves the saved draft");
      assert.equal(button(dialog, "Save layout").disabled, false, "local failures can be recovered without a reload");
      button(dialog, "Back to map").click();assert.ok(dialog.isConnected);
      await button(dialog, "Discard layout changes").onclick();
      button(dialog, "Back to map").click();assert.equal(dialog.isConnected, false);
      dialog = await openPrint(root.querySelector(".opengeo-workbench"));
      assert.equal(dialog.querySelector('[aria-label="Caption"]').value, "");
      assert.equal(requests, 0);
      root.querySelector(".opengeo-workbench").dispose();assert.equal(dialog.isConnected, false);
    } finally {root?.querySelector(".opengeo-workbench")?.dispose();root?.remove();restoreGlobals();dom.window.close();}
  });
});

function installDomGlobals(window) {
  const replacements = {
    document: window.document,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    DOMParser: window.DOMParser,
    Node: window.Node,
    localStorage: window.localStorage,
    matchMedia: () => ({matches: false, addEventListener() {}, removeEventListener() {}}),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    __OPEN_GEO_DISABLE_INTERACTIVE_MAP_FOR_LAYOUT_TESTS__: true,
    location: window.location,
    history: window.history,
    MutationObserver: window.MutationObserver,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window)
  };
  window.HTMLDialogElement.prototype.showModal = function () {this.open = true;};
  window.HTMLDialogElement.prototype.close = function () {this.open = false;};
  const previous = new Map();
  for (const [name, value] of Object.entries(replacements)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {configurable: true, writable: true, value});
  }
  return () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("timed out waiting for public workbench lifecycle state");
}

function chooseWorkbenchFile(map, dom, file) {
  [...map.querySelectorAll("button")].find(button => button.textContent.trim() === "Open file").click();
  const input = document.querySelector(".opengeo-project-file-input");assert(input.accept.split(",").includes(file.name.slice(file.name.lastIndexOf("."))));
  Object.defineProperty(input, "files", {value: [file]});input.dispatchEvent(new dom.window.Event("change"));
}

async function checkGpxBrowser() {
  const {chromium}=await import('playwright'),{resolve,dirname,extname}=await import('node:path');
  const {writeFile,mkdir,rename}=await import('node:fs/promises'),{createHash}=await import('node:crypto');
  const dist=resolve(process.env.OPEN_GEO_GPX_DIST),area=dirname(dirname(dist)),output=resolve(area,'../compiled-browser');await mkdir(output,{recursive:true});
  const manifest=JSON.parse(await readFile(resolve(area,'dist/opengeo-studio-build.json'))),files=new Map(manifest.artifactTree.files.map(f=>[f.path,f]));
  const module=name=>'/'+manifest.artifactTree.files.find(f=>f.path.startsWith('_import/'+name+'.')&&f.path.endsWith('.js')).path;
  const entry=await readFile(resolve(dist,'index.html'),'utf8'),styles=[...entry.matchAll(/<link[^>]*href="([^"]+\.css)"[^>]*>/g)].map(m=>`<link rel="stylesheet" href="${m[1]}">`).join('');
  const html=`<!doctype html><meta charset="utf-8">${styles}<style>html,body,#root{height:100%;margin:0}</style><main id="root"></main><script type="module">import {StartPage} from '${module('components/StartPage')}';document.querySelector('#root').append(StartPage({catalog:{workspaces:[]}}));</script>`;
  const original=await readFile(new URL('../../fixtures/gps/source-survey.gpx',import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex');
  const receipt={status:'started',limits:{GETs:600,bytes:18874368,seconds:75,personalSaves:1,originalDownloads:2,projectDownloads:1,workingDownloads:1},GETs:0,bytes:0,AWS:0,API:0,provider:0,personalSaves:0,originalDownloads:0,projectDownloads:0,workingDownloads:0,errors:[],buildTree:manifest.artifactTree.digest};
  let chain=Promise.resolve();const persist=()=>chain=chain.then(async()=>{await writeFile(resolve(output,'receipt.pending'),JSON.stringify(receipt,null,2)+'\n');await rename(resolve(output,'receipt.pending'),resolve(output,'receipt.json'));});
  const prior=JSON.parse(await readFile(resolve(output,'attempt-1.json'))),previous=JSON.parse(await readFile(resolve(output,'attempt-2.json')));receipt.priorAttempt=prior;receipt.priorCorrection={GETs:previous.GETs,bytes:previous.bytes,elapsedMilliseconds:previous.elapsedMilliseconds,browserClosed:previous.browserClosed};receipt.limits.GETs=600-previous.GETs;receipt.limits.bytes=18874368-previous.bytes;receipt.limits.seconds=(75000-previous.elapsedMilliseconds)/1000;receipt.originalDownloads=1;await persist();
  const started=Date.now(),server=await chromium.launchServer({headless:true,executablePath:'/usr/bin/chromium-browser',args:['--no-sandbox','--enable-unsafe-swiftshader','--opengeo-gpx-acceptance']}),browser=await chromium.connect(server.wsEndpoint());receipt.browserPID=server.process().pid;await persist();let page,guardFailure;
  const within=()=>assert(Date.now()-started<receipt.limits.seconds*1000,'Remaining cumulative local-browser time bound');
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',acceptDownloads:true});
    await context.route('**/*',async route=>{try{
      within();const u=new URL(route.request().url());if(['blob:','data:'].includes(u.protocol))return route.continue();
      if(u.hostname==='fonts.googleapis.com'){receipt.optionalFontsAborted=(receipt.optionalFontsAborted??0)+1;return route.abort();}
      if(u.href==='https://tiles.openfreemap.org/styles/positron'){receipt.blankBasemapSubstitutes=(receipt.blankBasemapSubstitutes??0)+1;return route.fulfill({contentType:'application/json',body:JSON.stringify({version:8,sources:{},layers:[{id:'background',type:'background',paint:{'background-color':'#eef2f4'}}]})});}
      assert.equal(u.origin,'https://compiled-gpx.test');assert.equal(route.request().method(),'GET');assert(!u.pathname.startsWith('/api/'));
      if(u.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
      const file=files.get(decodeURIComponent(u.pathname).slice(1));assert(file,'Unexpected software '+u.pathname);assert(++receipt.GETs<=receipt.limits.GETs);receipt.bytes+=file.bytes;assert(receipt.bytes<=receipt.limits.bytes);await persist();
      const bytes=await readFile(resolve(dist,file.path));assert.equal(hash(bytes),file.sha256);
      return route.fulfill({body:bytes,contentType:({'.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.woff2':'font/woff2','.png':'image/png','.svg':'image/svg+xml','.wasm':'application/wasm'})[extname(file.path)]??'application/octet-stream'});
    }catch(error){guardFailure??=error;receipt.guardFailure={path:new URL(route.request().url()).pathname,error:error.message};await route.abort().catch(()=>{});}});
    const makePage=async url=>{const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>receipt.errors.push(e.message));await p.goto(url);return p;};
    page=await makePage('https://compiled-gpx.test/');
    await page.locator('.start-empty-map').click();await page.locator('.opengeo-workbench').waitFor();
    await page.waitForFunction(()=>document.querySelector('.opengeo-workbench')?.getPrintContext?.()?.map?.isStyleLoaded?.());
    if(await page.getByRole('button',{name:'Light',exact:true}).count())await page.getByRole('button',{name:'Light',exact:true}).first().click();
    receipt.stage='Normal Open file and source review, exact original download';
    const [choice]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'Open file',exact:true}).click()]);await choice.setFiles({name:'source-survey.gpx',mimeType:'application/gpx+xml',buffer:original});
    let dialog=page.locator('.browser-layer-registration');await dialog.waitFor();assert(!/demo/i.test(await dialog.innerText()));
    await dialog.getByLabel('Layer title',{exact:true}).fill('Reviewed GPS');
    // Reuse the first run's completed original download rather than downloading it again.
    let download;assert.equal(prior.originalDownloadSHA256,hash(original));
    assert.equal(hash(await readFile(resolve(output,'original.gpx'))),hash(original));
    await dialog.getByRole('button',{name:'Add Layer to Project',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await page.waitForFunction(()=>{const c=document.querySelector('.opengeo-workbench')?.getPrintContext?.();return c?.ready&&c.layers.some(l=>l.metadata?.source?.format==='gpx')&&c.map.areTilesLoaded();});
    const before=await page.evaluate(()=>{const c=document.querySelector('.opengeo-workbench').getPrintContext(),layer=c.layers.find(l=>l.metadata?.source?.format==='gpx');return{layer,geojson:c.dataByLayerId?.get(layer.layerId)??c.handles.get(layer.layerId)?.geojson,rendered:c.map.queryRenderedFeatures().filter(f=>f.source===layer.layerId||String(f.layer?.id).startsWith(layer.layerId)).map(f=>f.geometry.type)};});
    assert(before.rendered.includes('Point')&&before.rendered.includes('LineString'),'Both GPX waypoint and path passes must render');assert.equal(before.layer.metadata.source.sha256,hash(original));
    receipt.renderedGeometryTypes=[...new Set(before.rendered)];receipt.layerId=before.layer.layerId;receipt.sourceSHA256=hash(original);
    receipt.stage='Working GeoJSON export and actual IndexedDB personal Save';
    await persist();await page.getByLabel('Layer actions for Reviewed GPS',{exact:true}).click();await page.locator('.gis-layer-more[open]').getByRole('button',{name:'Style layer',exact:true}).click();
    [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Download layer',exact:true}).click()]);await download.saveAs(resolve(output,'working.geojson'));receipt.workingDownloads++;
    const working=JSON.parse(await readFile(resolve(output,'working.geojson')));assert.equal(working.features.length,5);assert.deepEqual(working.features[0].geometry.coordinates,[85.3,27.7,1450.25]);assert.equal(working.features[0].properties.gpx.points[0].time,'2026-10-16T01:02:03.123400+05:45');
    await page.getByRole('button',{name:'Save in browser',exact:true}).click();const title=page.getByRole('dialog',{name:'Save personal Project',exact:true});await title.getByLabel('Personal Project title',{exact:true}).fill('GPS field survey');await title.getByRole('button',{name:'Save Project',exact:true}).click();
    await page.waitForFunction(()=>new URL(location.href).searchParams.has('localProject'));receipt.personalSaves++;
    const url=page.url();receipt.localProjectId=new URL(url).searchParams.get('localProject');
    await page.getByRole('button',{name:'Save as',exact:true}).click();const exportDialog=page.getByRole('dialog').filter({has:page.getByLabel('Project export format',{exact:true})});
    await exportDialog.getByLabel('Project export format',{exact:true}).selectOption('opengeo');[download]=await Promise.all([page.waitForEvent('download'),exportDialog.getByRole('button',{name:'Export file',exact:true}).click()]);await download.saveAs(resolve(output,'project.opengeo-project.json'));receipt.projectDownloads++;
    const saved=readBrowserProjectFile(await readFile(resolve(output,'project.opengeo-project.json'),'utf8'));assert.equal(saved.layers.length,1);assert.deepEqual(saved.layers[0].geojson.features,working.features);assert.equal(saved.layers[0].metadata.source.sha256,hash(original));
    receipt.stage='New document reopens exact GPX data and metadata from IndexedDB';
    await page.close();page=await makePage(url);await page.waitForFunction(()=>{const c=document.querySelector('.opengeo-workbench')?.getPrintContext?.();return c?.ready&&c.layers.length===1&&c.map.areTilesLoaded();});
    const restored=await page.evaluate(()=>{const c=document.querySelector('.opengeo-workbench').getPrintContext();return{layer:c.layers[0],data:c.project.layers[0].geojson};});const reopened=restored.layer;assert.deepEqual(restored.data.features,working.features);
    assert.equal(reopened.layerId,receipt.layerId);assert.deepEqual(reopened.metadata,saved.layers[0].metadata);receipt.IndexedDBReopen=true;
    receipt.stage='Reused Catalog source, exact second original download, light/dark390px review';
    for(const theme of ['light','dark']) {
      const switchTo=theme==='light'?'Light':'Dark';if(await page.getByRole('button',{name:switchTo,exact:true}).count())await page.getByRole('button',{name:switchTo,exact:true}).first().click();
      await page.getByRole('button',{name:'Catalog',exact:true}).click();await page.locator(`[data-browser-catalog-layer="${reopened.datasetId}"]`).getByRole('button').first().click();
      dialog=page.locator('.browser-layer-registration');await dialog.waitFor();await page.setViewportSize({width:390,height:844});assert(!/demo/i.test(await dialog.innerText()));assert((await dialog.innerText()).includes('Saved on this device'));
      assert(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth+1));
      const samples=await dialog.evaluate(root=>{
        const rgb=s=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.fillStyle=s;x.fillRect(0,0,1,1);return [...x.getImageData(0,0,1,1).data];};
        const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
        return [root,...['input','label','h2','p','dt','button'].map(s=>root.querySelector(s))].map(n=>{let parent=n,bg=rgb(getComputedStyle(parent).backgroundColor);while(bg[3]<255&&parent.parentElement){parent=parent.parentElement;bg=rgb(getComputedStyle(parent).backgroundColor);}const a=lum(rgb(getComputedStyle(n).color)),b=lum(bg);return{element:n.tagName,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),alpha:bg[3]};});
      });assert(samples.every(s=>s.alpha===255&&s.ratio>=4.5));(receipt.themes??=[]).push({theme,samples});await page.screenshot({path:resolve(output,`gpx-review-${theme}.png`)});
      if(theme==='light'){[download]=await Promise.all([page.waitForEvent('download'),dialog.getByRole('button',{name:'Download original GPX',exact:true}).click()]);await download.saveAs(resolve(output,'reopened-original.gpx'));receipt.originalDownloads++;assert.equal(hash(await readFile(resolve(output,'reopened-original.gpx'))),hash(original));}
      await dialog.getByRole('button',{name:'Cancel',exact:true}).click();await page.setViewportSize({width:1440,height:1000});
    }
    within();assert(!guardFailure);assert.deepEqual(receipt.errors,[]);receipt.status='passed-compiled-GPX-render-original-working-export-IndexedDB-save-fresh-reopen-and-theme-review';
  }catch(error){receipt.status='stopped';receipt.failure=error.message;if(page&&!page.isClosed()){receipt.visibleText=(await page.locator('body').innerText()).slice(-5000);await page.screenshot({path:resolve(output,'stopped.png')});}throw error;}
  finally{await browser.close();await server.close();receipt.browserClosed=true;receipt.elapsedMilliseconds=Date.now()-started;await persist();}
}
