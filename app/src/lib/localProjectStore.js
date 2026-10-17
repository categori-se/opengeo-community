import {zipSync, unzipSync, strToU8, strFromU8} from "fflate";
import {readBrowserProjectFile} from "./browserProjectFile.js";

export const LOCAL_PROJECT_LIMITS = Object.freeze({projects: 10, bytes: 250 * 1024 * 1024, projectBytes: 32 * 1024 * 1024});
const DATABASE = "opengeo-personal-projects-v1";
const SCHEMA = "opengeo.local-project-bundle.1.0.0";
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const size = value => encoder.encode(JSON.stringify(value)).byteLength;
const conflict = () => Object.assign(Error("This Project changed in another tab. Reopen its saved revision before saving."), {code: "local_project_conflict"});
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");

// Deliberate device storage only: no credentials, account calls, source reads or expiry.
export class LocalProjectStore {
  constructor({indexedDB = globalThis.indexedDB, catalog = [], limits = LOCAL_PROJECT_LIMITS, now = () => new Date()} = {}) {
    this.indexedDB = indexedDB;this.catalog = catalog;this.limits = limits;this.now = now;
  }
  async transaction(mode, apply) {
    if (!this.indexedDB) throw Error("Device storage is unavailable. Download a Project backup before leaving.");
    const database = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("projects", {keyPath: "id"});
        request.result.createObjectStore("assets", {keyPath: "checksum"});
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error("Close older OpenGeo tabs, then retry device storage."));
    });
    return new Promise((resolve, reject) => {
      const tx = database.transaction(["projects", "assets"], mode);
      const projects = tx.objectStore("projects"), assets = tx.objectStore("assets");
      const a = projects.getAll(), b = assets.getAll();let loaded = 0, result, failure;
      const ready = () => {
        if (++loaded !== 2) return;
        try {result = apply({projects, assets}, a.result, b.result);}
        catch (error) {failure = error;tx.abort();}
      };
      a.onsuccess = ready;b.onsuccess = ready;
      tx.oncomplete = () => {database.close();resolve(result);};
      tx.onabort = tx.onerror = () => {database.close();reject(failure ?? tx.error ?? Error("Device storage could not finish. Your previous save is retained."));};
    });
  }
  async prepare(definition, geojsonByLayerId = new Map()) {
    const value = structuredClone(definition), assets = new Map(), references = [], seen = new WeakMap();
    for (const layer of value.layers ?? []) {
      const geojson = geojsonByLayerId.get(layer.layerId) ?? layer.geojson;
      delete layer.geojson;
      if (!geojson || layer.sourceType === "kml-places") continue;
      if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features) || geojson.features.length > 100_000) throw Error(`${layer.title}: unsupported local feature collection.`);
      let asset = seen.get(geojson);
      if (!asset) {
        const bytes = encoder.encode(JSON.stringify(geojson));
        if (bytes.byteLength > this.limits.projectBytes) throw Error("This Project exceeds the 32 MiB device save limit. Export a smaller selection.");
        asset = {checksum: await digest(bytes), bytes: bytes.byteLength, blob: new Blob([bytes], {type: "application/geo+json"})};
        seen.set(geojson, asset);assets.set(asset.checksum, asset);
      }
      references.push({layerId: layer.layerId, checksum: asset.checksum});
    }
    delete value.demoDate;value.persistence = {mode: "browser-personal", uploaded: false, published: false};
    const checked = this.validate(value, references);
    const metadataBytes = size(checked) + size(references);
    if (metadataBytes + [...assets.values()].reduce((sum, asset) => sum + asset.bytes, 0) > this.limits.projectBytes) throw Error("This Project exceeds the 32 MiB device save limit.");
    return {definition: checked, references, assets, metadataBytes};
  }
  validate(definition, references) {
    const check = structuredClone(definition), local = new Set(references.map(item => item.layerId));
    if (references.some(item => !SHA.test(item.checksum)) || local.size !== references.length) throw Error("Local Project asset references are invalid.");
    for (const layer of check.layers ?? []) {
      if (local.has(layer.layerId)) layer.geojson = {type: "FeatureCollection", features: []};
      for (const source of [layer.sourceUrl, layer.tileUrl].filter(Boolean)) {
        const url = new URL(source);
        if (url.protocol !== "https:" || url.username || url.password || [...url.searchParams.keys()].some(key => /token|secret|password|signature|credential|api.?key/i.test(key))) throw Error("Local source references must use credential-free HTTPS.");
      }
      const configuration = [layer.sourceConfiguration], seen = new Set();let entries = 0;
      while (configuration.length) {
        const next = configuration.pop();
        if (++entries > 4096) throw Error("Source configuration exceeds its portable Project limit.");
        if (next && typeof next === "object" && seen.has(next)) throw Error("Source configuration contains a circular reference.");
        if (next && typeof next === "object") seen.add(next);
        if (next && typeof next === "object") for (const [key, child] of Object.entries(next)) {
          if (/^(?:authorization|cookie|password|secret|credentials|access[-_]?token|(?:x[-_])?api[-_]?key)$/i.test(key)) throw Error("Remove private source credentials before saving a portable local Project.");
          if (typeof child === "string" && /^blob:/i.test(child)) throw Error("Replace temporary Blob source references before saving a portable Project.");
          if (typeof child === "string" && /^https?:/i.test(child)) {
            const url = new URL(child);
            if (url.username || url.password || [...url.searchParams.keys()].some(name => /token|secret|password|signature|credential|api.?key/i.test(name))) throw Error("Remove private source credentials before saving a portable local Project.");
          }
          configuration.push(child);
        }
      }
    }
    if (references.some(item => !check.layers.some(layer => layer.layerId === item.layerId))) throw Error("A local asset refers to an absent Layer.");
    const validated = readBrowserProjectFile(JSON.stringify(check), {catalog: this.catalog});
    for (const layer of validated.layers) delete layer.geojson;
    return validated;
  }
  async save({id = crypto.randomUUID(), expectedRevision = 0, title, definition, geojsonByLayerId}) {
    if (!ID.test(id) || typeof title !== "string" || !title.trim() || title.length > 200) throw Error("Choose a Project title of at most 200 characters.");
    const prepared = await this.prepare(definition, geojsonByLayerId);
    return this.transaction("readwrite", (stores, projects, savedAssets) => {
      const previous = projects.find(record => record.id === id);
      if ((previous?.revision ?? 0) !== expectedRevision) throw conflict();
      if (!previous && projects.length >= this.limits.projects) throw Error("The ten-Project device library is full. Download a backup before removing a Project.");
      const record = {id, revision: expectedRevision + 1, title: title.trim(), definition: prepared.definition,
        references: prepared.references, metadataBytes: prepared.metadataBytes, updatedAt: this.now().toISOString()};
      const retained = [...projects.filter(item => item.id !== id), record];
      this.reconcile(stores, retained, savedAssets, prepared.assets);
      stores.projects.put(record);return structuredClone(record);
    });
  }
  reconcile(stores, projects, existing, added = new Map()) {
    const required = new Set(projects.flatMap(record => record.references.map(item => item.checksum)));
    const assets = new Map(existing.map(asset => [asset.checksum, asset]));
    for (const [checksum, asset] of added) if (!assets.has(checksum)) assets.set(checksum, asset);
    let bytes = projects.reduce((sum, record) => sum + record.metadataBytes, 0);
    for (const checksum of required) {
      const asset = assets.get(checksum);if (!asset) throw Error("A saved data asset is missing. Restore this Project from a backup.");bytes += asset.bytes;
    }
    if (bytes > this.limits.bytes) throw Error("The device library reached its storage limit. Your previous Projects are retained; download a backup before freeing space.");
    for (const asset of existing) if (!required.has(asset.checksum)) stores.assets.delete(asset.checksum);
    const known = new Set(existing.map(asset => asset.checksum));
    for (const [checksum, asset] of added) if (required.has(checksum) && !known.has(checksum)) stores.assets.put(asset);
  }
  async list() {
    return this.transaction("readonly", (_, projects, assets) => ({
      projects: projects.map(({id, revision, title, updatedAt}) => ({id, revision, title, updatedAt})).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      bytes: projects.reduce((sum, record) => sum + record.metadataBytes, 0) + assets.reduce((sum, asset) => sum + asset.bytes, 0),
      assets: assets.length
    }));
  }
  async load(id) {
    const {record, assets} = await this.transaction("readonly", (_, projects, assets) => {
      const record = projects.find(item => item.id === id);if (!record) throw Error("This Project is no longer on this device.");
      return {record, assets: assets.filter(asset => record.references.some(item => item.checksum === asset.checksum))};
    });
    return this.hydrate(record, assets);
  }
  async hydrate(record, assets) {
    const definition = this.validate(record.definition, record.references), data = new Map();
    for (const asset of assets) {
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());
      if (bytes.byteLength !== asset.bytes || await digest(bytes) !== asset.checksum) throw Error("Saved local data changed or is damaged. Restore a downloaded backup.");
      const geojson = JSON.parse(strFromU8(bytes));
      if (geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) throw Error("Saved local data is not a feature collection.");
      data.set(asset.checksum, geojson);
    }
    const geojsonByLayerId = new Map(record.references.map(item => {
      if (!data.has(item.checksum)) throw Error("Saved local data is missing. Restore a downloaded backup.");
      return [item.layerId, data.get(item.checksum)];
    }));
    return {...record, definition, geojsonByLayerId};
  }
  async remove(id, expectedRevision) {
    return this.transaction("readwrite", (stores, projects, assets) => {
      if (projects.find(item => item.id === id)?.revision !== expectedRevision) throw conflict();
      this.reconcile(stores, projects.filter(item => item.id !== id), assets);stores.projects.delete(id);
    });
  }
  async backup(id) {
    const {record, assets} = await this.transaction("readonly", (_, projects, assets) => {
      const record = projects.find(item => item.id === id);if (!record) throw Error("This Project is no longer on this device.");
      return {record, assets: assets.filter(asset => record.references.some(item => item.checksum === asset.checksum))};
    });
    await this.hydrate(record, assets);
    const files = {"project.json": strToU8(JSON.stringify(record.definition))};
    for (const asset of assets) files[`assets/${asset.checksum}.geojson`] = new Uint8Array(await asset.blob.arrayBuffer());
    files["manifest.json"] = strToU8(JSON.stringify({schemaVersion: SCHEMA, title: record.title, originalProjectId: record.id,
      revision: record.revision, updatedAt: record.updatedAt, references: record.references,
      dependencies: [...record.definition.layers.map(layer => ({layerId: layer.layerId,
        mode: record.references.some(item => item.layerId === layer.layerId) || layer.kmlDocument ? "included" : "live",
        sourceUrl: layer.sourceUrl ?? layer.tileUrl ?? null, attribution: layer.attribution ?? null,
        curatedAttribution: layer.metadata?.curated?.attribution ?? null, license: layer.metadata?.curated?.license ?? null})),
        ...(record.definition.basemaps ?? []).map(item => ({kind: "basemap", id: item.basemapId, mode: "live"})),
        {kind: "viewer-software", mode: "excluded"}],
      completeness: "editable-project; live sources and viewer software are not bundled"}));
    const bytes = zipSync(files, {level: 6});
    if (bytes.byteLength > this.limits.projectBytes) throw Error("This backup exceeds the 32 MiB package limit.");
    return new Blob([bytes], {type: "application/zip"});
  }
  async inspectBackup(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.limits.projectBytes) throw Error("Choose a Project backup ZIP up to 32 MiB.");
    let expanded = 0, count = 0;
    const files = unzipSync(bytes, {filter: file => {
      if (++count > 67 || !/^(?:manifest\.json|project\.json|assets\/[a-f0-9]{64}\.geojson)$/.test(file.name)
        || !Number.isSafeInteger(file.originalSize) || (expanded += file.originalSize) > this.limits.projectBytes) throw Error("This backup has unsupported files or exceeds its size limit.");
      return true;
    }});
    const manifest = JSON.parse(strFromU8(files["manifest.json"] ?? new Uint8Array()));
    if (manifest.schemaVersion !== SCHEMA || typeof manifest.title !== "string" || !Array.isArray(manifest.references) || manifest.references.length > 64) throw Error("This Project backup format is unsupported.");
    const definition = JSON.parse(strFromU8(files["project.json"] ?? new Uint8Array()));
    const assets = Object.entries(files).filter(([path]) => path.startsWith("assets/")).map(([path, bytes]) => ({checksum: path.slice(7, -8), bytes: bytes.byteLength, blob: new Blob([bytes])}));
    const restored = await this.hydrate({title: manifest.title, definition, references: manifest.references}, assets);
    return {title: restored.title, definition: restored.definition, geojsonByLayerId: restored.geojsonByLayerId};
  }
}
