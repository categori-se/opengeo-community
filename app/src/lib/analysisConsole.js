import {BROWSER_PROCESSING_LIMITS} from './processingRegistry.js';

export const ANALYSIS_CONSOLE_LIMITS = Object.freeze({sourceBytes: 64 * 1024, inputBytes: 16 * 1024 ** 2,
  outputBytes: 128 * 1024, resultBytes: 8 * 1024 ** 2, layers: 16,
  features: BROWSER_PROCESSING_LIMITS.maximumFeatures, coordinates: BROWSER_PROCESSING_LIMITS.maximumCoordinates,
  milliseconds: 10_000});
const bytes = value => new TextEncoder().encode(value).byteLength;
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = message => {throw Error(message);};
const freezeJSON = value => {
  if (value && typeof value === 'object') {Object.values(value).forEach(freezeJSON);Object.freeze(value);}return value;
};
function jsonValue(value, depth = 0, budget = {nodes: 0}) {
  if (++budget.nodes > 2_000_000 || depth > 16) fail('Data nesting exceeds the console limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {if (bytes(value) > ANALYSIS_CONSOLE_LIMITS.inputBytes) fail('A data value is too large.');return value;}
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1, budget));
  if (!plain(value)) fail('Data must contain JSON values only.');
  const result = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get || descriptor.set) fail('Data accessors are unavailable in console inputs.');
    result[key] = jsonValue(descriptor.value, depth + 1, budget);
  }
  return result;
}

/** Keep feature content, never Layer URLs, account objects or source credentials. */
export function validateAnalysisGeoJSON(value, maximumBytes = ANALYSIS_CONSOLE_LIMITS.resultBytes) {
  if (!plain(value)) fail('Return GeoJSON geometry, a Feature or a FeatureCollection.');
  const collection = value.type === 'FeatureCollection' ? value
    : value.type === 'Feature' ? {type: 'FeatureCollection', features: [value]}
      : {type: 'FeatureCollection', features: [{type: 'Feature', properties: {}, geometry: value}]};
  if (!Array.isArray(collection.features) || collection.features.length > ANALYSIS_CONSOLE_LIMITS.features) fail('GeoJSON exceeds the feature limit.');
  let positions = 0;
  function position(p) {
    if (!Array.isArray(p) || p.length < 2 || p.length > 4 || !p.every(Number.isFinite)
      || p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) fail('Coordinates must be finite WGS 84 positions.');
    if (++positions > ANALYSIS_CONSOLE_LIMITS.coordinates) fail('GeoJSON exceeds the coordinate limit.');
    return [...p];
  }
  function line(p, ring = false) {
    if (!Array.isArray(p) || p.length < (ring ? 4 : 2)) fail('GeoJSON has an invalid line or polygon ring.');
    const result = p.map(position);
    if (ring && (p[0][0] !== p.at(-1)[0] || p[0][1] !== p.at(-1)[1])) fail('Polygon rings must be closed.');
    return result;
  }
  function list(value, visit) {if (!Array.isArray(value)) fail('GeoJSON coordinates must be arrays.');return value.map(visit);}
  function geometry(g, depth = 0) {
    if (g === null) return null;
    if (!plain(g) || depth > 16) fail('GeoJSON geometry is invalid.');
    if (g.type === 'GeometryCollection') return {type: g.type, geometries: list(g.geometries, item => geometry(item, depth + 1))};
    const handlers = {Point: position, MultiPoint: p => list(p, position), LineString: line,
      MultiLineString: p => list(p, item => line(item)), Polygon: p => list(p, item => line(item, true)),
      MultiPolygon: p => list(p, polygon => list(polygon, item => line(item, true)))};
    if (!Object.hasOwn(handlers, g.type)) fail('GeoJSON geometry type is unsupported.');
    return {type: g.type, coordinates: handlers[g.type](g.coordinates)};
  }
  const result = {type: 'FeatureCollection', features: collection.features.map(f => {
    if (!plain(f) || f.type !== 'Feature' || !(f.properties === null || plain(f.properties))) fail('GeoJSON features are invalid.');
    const feature = {type: 'Feature', properties: jsonValue(f.properties), geometry: geometry(f.geometry)};
    if (Object.hasOwn(f, 'id')) {
      if (!(typeof f.id === 'string' || typeof f.id === 'number' && Number.isFinite(f.id))) fail('Feature IDs must be strings or finite numbers.');
      feature.id = f.id;
    }
    return feature;
  })};
  if (bytes(JSON.stringify(result)) > maximumBytes) fail('GeoJSON exceeds the console byte limit.');
  return result;
}

export function snapshotAnalysisLayers(rows) {
  if (!Array.isArray(rows) || rows.length > ANALYSIS_CONSOLE_LIMITS.layers) fail('Select at most 16 loaded Layers.');
  let features = 0;
  const ids = new Set(), inputPins = [], layers = rows.map(row => {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 160 || ids.has(row.id)) fail('Layer identities must be unique.');
    ids.add(row.id);
    if (row.geojson?.type !== 'FeatureCollection') fail('Select loaded vector Layers to provide inputs.');
    const geojson = validateAnalysisGeoJSON(row.geojson, ANALYSIS_CONSOLE_LIMITS.inputBytes);
    features += geojson.features.length;
    inputPins.push({id: row.id, inputPin: row.inputPin == null ? null : jsonValue(row.inputPin)});
    return {id: row.id, title: String(row.title ?? row.id).slice(0, 240), geojson};
  });
  if (features > ANALYSIS_CONSOLE_LIMITS.features || bytes(JSON.stringify(layers)) > ANALYSIS_CONSOLE_LIMITS.inputBytes) fail('Selected inputs exceed the console limit.');
  // Validate the shared coordinate budget as well as each individual Layer.
  validateAnalysisGeoJSON({type: 'FeatureCollection', features: layers.flatMap(layer => layer.geojson.features)}, ANALYSIS_CONSOLE_LIMITS.inputBytes);
  return {layers, inputPins: freezeJSON(structuredClone(inputPins))};
}
export function validateAnalysisSource(code) {
  if (typeof code !== 'string' || !code.trim() || bytes(code) > ANALYSIS_CONSOLE_LIMITS.sourceBytes) fail('Enter a script of at most 64 KiB.');
  return code;
}
export function normalizeAnalysisResult(value = {}) {
  if (!plain(value) || (value.stdout != null && typeof value.stdout !== 'string') || (value.stderr != null && typeof value.stderr !== 'string')) fail('Invalid execution response.');
  const stdout = value.stdout ?? '', stderr = value.stderr ?? '';
  if (bytes(stdout) + bytes(stderr) > ANALYSIS_CONSOLE_LIMITS.outputBytes) fail('Script output exceeds 128 KiB.');
  const exitCode = value.exitCode ?? value.execution?.exitCode ?? 0;
  if (!Number.isInteger(exitCode)) fail('Invalid execution exit code.');
  return {stdout, stderr, geojson: value.geojson == null ? null : validateAnalysisGeoJSON(value.geojson),
    exitCode, execution: value.execution == null ? null : jsonValue(value.execution)};
}

export const ANALYSIS_EXAMPLES = Object.freeze({
  javascript: 'for (const layer of opengeo.layers) {\n  console.log(layer.title + ": " + layer.geojson.features.length + " features");\n}\n// Return a separate result without changing an input Layer.\nif (opengeo.layers.length) opengeo.emit(opengeo.layers[0].geojson);\n',
  python: 'import json\nfrom pathlib import Path\nlayers = json.loads(Path("/input/layers.json").read_text())\nfor layer in layers:\n    data = json.loads(Path(layer["path"]).read_text())\n    print(f"{layer[\'title\']}: {len(data[\'features\'])} features")\n# Emit one separate GeoJSON result for review.\nif layers:\n    data = json.loads(Path(layers[0]["path"]).read_text())\n    print("OPEN_GEO_GEOJSON:" + json.dumps(data, separators=(",", ":")))\n',
  bash: '# This example needs Node.js in the selected execution profile.\nnode - <<\'JS\'\nconst fs = require("node:fs");\nconst layers = JSON.parse(fs.readFileSync("/input/layers.json", "utf8"));\nfor (const layer of layers) {\n  const data = JSON.parse(fs.readFileSync(layer.path, "utf8"));\n  console.log(layer.title + ": " + data.features.length + " features");\n}\nJS\n'
});

// Serialized into an opaque iframe worker. User source is delivered as data,
// never interpolated into the HTML or a host-origin script/module.
export function analysisWorkerMain() {
  const send = self.postMessage.bind(self), maximumOutput = 128 * 1024, maximumResult = 8 * 1024 ** 2;
  let output = 0, emitted = 0;
  const size = text => new TextEncoder().encode(text).byteLength;
  const log = (...args) => {
    const text = args.map(value => {try {return typeof value === 'string' ? value : JSON.stringify(value);} catch {return String(value);}}).join(' ') + '\n';
    output += size(text);if (output > maximumOutput) throw Error('Script output exceeds 128 KiB.');
    send({kind: 'log', text});
  };
  self.onmessage = async event => {
    self.onmessage = null;
    try {
      const opengeo = Object.freeze({layers: event.data.layers, emit(value) {
        const text = JSON.stringify(value);emitted += size(text);
        if (emitted > maximumResult) throw Error('GeoJSON result exceeds 8 MiB.');
        send({kind: 'result', geojson: JSON.parse(text)});
      }});
      const runtimeConsole = Object.freeze({log, info: log, warn: log, error: log, debug: log});
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      await new AsyncFunction('opengeo', 'print', 'console', '"use strict";\n' + event.data.code)(opengeo, log, runtimeConsole);
      send({kind: 'done'});
    } catch (error) {send({kind: 'error', message: String(error?.message ?? 'Script failed.').slice(0, 2000)});}
  };
}

function sandboxMain(workerSource) {
  let connected = false;
  addEventListener('message', event => {
    if (connected || event.source !== parent || event.ports.length !== 1) return;
    connected = true;
    const port = event.ports[0];let worker, url;
    const stop = () => {worker?.terminate();if (url) URL.revokeObjectURL(url);worker = null;};
    port.onmessage = message => {
      if (message.data?.kind === 'stop') {stop();return;}
      if (message.data?.kind !== 'run' || worker) return;
      try {
        url = URL.createObjectURL(new Blob([workerSource], {type: 'text/javascript'}));worker = new Worker(url);
        worker.onmessage = result => {
          const data = result.data;
          if (!data || !['log', 'result', 'done', 'error'].includes(data.kind)) return;
          port.postMessage(data);if (data.kind === 'done' || data.kind === 'error') stop();
        };
        worker.onerror = () => {port.postMessage({kind: 'error', message: 'Browser worker unavailable.'});stop();};
        worker.postMessage(message.data.payload);
      } catch {stop();port.postMessage({kind: 'error', message: 'Browser worker unavailable.'});}
    };
    port.start();port.postMessage({kind: 'ready'});
  });
}
export function analysisSandboxDocument() {
  const worker = '(' + analysisWorkerMain.toString() + ')();';
  const script = '(' + sandboxMain.toString() + ')(' + JSON.stringify(worker) + ');';
  return '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src \'none\'; script-src \'unsafe-inline\' \'unsafe-eval\' blob:; worker-src blob:; base-uri \'none\'; form-action \'none\'; frame-src \'none\'"><script>' + script.replace(/<\/script/gi, '<\\/script') + '</script>';
}

export async function runBrowserAnalysis({code, layers, signal, onLog = () => {}, document = globalThis.document}) {
  validateAnalysisSource(code);signal?.throwIfAborted();
  const inputs = snapshotAnalysisLayers(layers).layers;
  let scriptSha256;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
    scriptSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');frame.hidden = true;frame.title = 'Isolated analysis runtime';
    frame.setAttribute('sandbox', 'allow-scripts');frame.referrerPolicy = 'no-referrer';
    const channel = new MessageChannel();let settled = false, stdout = '', geojson = null, resultBytes = 0;
    const started = Date.now();
    const finish = (error, result) => {
      if (settled) return;settled = true;clearTimeout(timer);signal?.removeEventListener('abort', abort);
      try {channel.port1.postMessage({kind: 'stop'});} catch { /* Frame may already be gone. */ }
      channel.port1.close();channel.port2.close();frame.remove();error ? reject(error) : resolve(result);
    };
    const abort = () => finish(signal.reason ?? new DOMException('Script stopped.', 'AbortError'));
    const timer = setTimeout(() => finish(Error('Browser script reached the 10-second limit.')), ANALYSIS_CONSOLE_LIMITS.milliseconds);
    signal?.addEventListener('abort', abort, {once: true});
    channel.port1.onmessage = event => {
      if (settled) return;
      try {
        const data = event.data;
        if (data?.kind === 'ready') channel.port1.postMessage({kind: 'run', payload: {code, layers: inputs}});
        else if (data?.kind === 'log') {
          if (typeof data.text !== 'string') throw Error('Invalid script output.');
          stdout += data.text;if (bytes(stdout) > ANALYSIS_CONSOLE_LIMITS.outputBytes) throw Error('Script output exceeds 128 KiB.');onLog(data.text);
        } else if (data?.kind === 'result') {
          resultBytes += bytes(JSON.stringify(data.geojson));
          if (resultBytes > ANALYSIS_CONSOLE_LIMITS.resultBytes) throw Error('GeoJSON result exceeds 8 MiB.');
          geojson = validateAnalysisGeoJSON(data.geojson);
        }
        else if (data?.kind === 'error') throw Error(String(data.message ?? 'Script failed.').slice(0, 2000));
        else if (data?.kind === 'done') finish(null, {stdout, stderr: '', geojson, exitCode: 0,
          execution: {profile: 'browser', language: 'javascript', elapsedMilliseconds: Date.now() - started,
            ...(scriptSha256 ? {scriptSha256} : {})}});
      } catch (error) {finish(error);}
    };
    channel.port1.start();
    frame.onload = () => {if (!settled) frame.contentWindow.postMessage({kind: 'analysis-connect'}, '*', [channel.port2]);};
    try {
      frame.srcdoc = analysisSandboxDocument();document.body.append(frame);
      if (signal?.aborted) abort();
    } catch (error) {finish(error);}
  });
}
