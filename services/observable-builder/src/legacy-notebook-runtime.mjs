// These exact pins are shared by import review and the offline runtime. A major
// or minor request may resolve to its matching bundled patch, never another API.
export const LEGACY_LIBRARY_PINS = Object.freeze({d3: '7.9.0', '@observablehq/plot': '0.6.17', '@observablehq/inputs': '0.12.0', htl: '0.3.1'});
export function resolveLegacyLibrary(specifier) {
  if (typeof specifier !== 'string') return null;
  for (const [name, version] of Object.entries(LEGACY_LIBRARY_PINS)) {
    if (specifier === name) return {name, version};
    if (!specifier.startsWith(name + '@')) continue;
    const requested = specifier.slice(name.length + 1);
    if (!/^\d+(?:\.\d+){0,2}$/.test(requested)) return null;
    const parts = version.split('.');
    if (requested.split('.').every((part, index) => part === parts[index])) return {name, version};
  }
  return null;
}
export function createOfflineLegacyRequire(modules) {
  return (...requests) => {
    const resolved = requests.length === 1 && resolveLegacyLibrary(requests[0]);
    return resolved && Object.hasOwn(modules, resolved.name)
      ? Promise.resolve(modules[resolved.name])
      : Promise.reject(Error('Library request is unavailable offline. Choose a matching pinned bundled library or review the original environment.'));
  };
}

// Called only inside the isolated Notebook runtime, after source compilation has
// validated the local graph. Construct factories without evaluating their cells.
export function createLegacyModuleRegistry(bundle, {readAttachment, mutable}) {
  const registry = Object.create(null);
  const attachments = new Map((bundle?.attachments ?? []).map(file =>
    [JSON.stringify([file.modulePath, file.originalName]), file.name]));
  function LegacyMutable(value) {
    const generator = mutable(value);
    Object.defineProperties(this, {
      generator: {value: generator},
      value: {get: () => generator.value, set: next => {generator.value = next;}}
    });
  }
  const file = (modulePath, name) => {
    const mapped = attachments.get(JSON.stringify([modulePath, name]));
    if (mapped === undefined) throw Error(`Unknown attachment in imported notebook: ${String(name)}`);
    return readAttachment(mapped);
  };
  for (const module of bundle?.modules ?? []) {
    registry[module.path] = Object.freeze({default: new Function('modules', 'readAttachment', 'legacyMutable',
      `"use strict"; return (${module.body});`)(registry, file, LegacyMutable)});
  }
  return Object.freeze(registry);
}
