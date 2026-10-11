import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import * as kit from '@observablehq/notebook-kit';
import {Runtime} from '@observablehq/runtime';
import {define as defineNativeCell} from '../node_modules/@observablehq/notebook-kit/dist/src/runtime/define.js';
import {compileLegacyModuleBundle, convertLegacyObservable} from '../../services/observable-builder/src/legacy-observable.mjs';
import {compileObservableNotebook} from '../../services/observable-builder/src/observable-notebook.mjs';
import {createLegacyModuleRegistry, createOfflineLegacyRequire, resolveLegacyLibrary, LEGACY_LIBRARY_PINS} from '../../services/observable-builder/src/legacy-notebook-runtime.mjs';
import {Mutable} from '../node_modules/@observablehq/notebook-kit/dist/src/runtime/stdlib/mutable.js';

function convert(source, options = {}) {
  const dom = new JSDOM('');
  try {
    const result = convertLegacyObservable(source, {kit, document: dom.window.document, ...options});
    return {...result, notebook: kit.deserialize(result.html, {parser: new dom.window.DOMParser()}),
      compiled: () => {
        const compilerDom = new JSDOM('');
        try {return compileObservableNotebook(result.html, {kit, parser: new compilerDom.window.DOMParser()});}
        finally {compilerDom.window.close();}
      }};
  } finally {dom.window.close();}
}
const exported = (functions, definitions, setup = '') => `${functions}\nexport default function define(runtime, observer) {
  const main = runtime.module();
  ${setup}
  ${definitions}
  return main;
}`;

// Execute only the owned deterministic fixtures below, never an imported file.
// This is the exact native define helper used by NotebookRuntime, with a test
// observer so reactive assertions do not need a rendered page or a build.
function fixtureRuntime(result, builtins = {}) {
  const runtime = new Runtime(builtins), main = runtime.module(), errors = [];
  const compiled = result.compiled();
  const registry = createLegacyModuleRegistry(compiled.legacyModules, {readAttachment: () => {throw Error('Unexpected attachment read');}, mutable: Mutable});
  for (const cell of compiled.cells) {
    if (cell.legacyImports) {
      let child = runtime.module(registry[cell.legacyImports[0].path].default);
      if (cell.legacyDerivations) child = child.derive(cell.legacyDerivations, main);
      for (const binding of cell.legacyImports) main.import(binding.imported, binding.local, child);
      continue;
    }
    defineNativeCell(main, {variables: []}, {...cell, display: false,
      body: new Function(`return (${cell.body});`)()}, () => ({rejected: error => errors.push(error)}));
  }
  return {runtime, main, errors};
}

const mutableDefinitions = `main.define("initial count", ["seed"], _count);
main.variable(observer("mutable count")).define("mutable count", ["Mutable", "initial count"], (M, value) => new M(value));
main.variable(observer("count")).define("count", ["mutable count"], value => value.generator);`;

const localRoot = `import define1 from "./child.js";
function _twice(value) { return value * 2; }
export default function define(runtime, observer) {
const main = runtime.module();
const child1 = runtime.module(define1);
main.import("value", "localValue", child1);
main.variable(observer("twice")).define("twice", ["localValue"], _twice);
return main;
}`;

it('shares root and child lexical helpers and constants across cells and derived instances', async () => {
  const child = exported(`const config = {offset: 3};
function shift(value) { return value + config.offset; }
function _config() { return config; }
function _helper() { return shift; }
function _value(seed) { return shift(seed); }`, `main.variable(observer("config")).define("config", _config);
main.variable(observer("helper")).define("helper", _helper);
main.variable(observer("value")).define("value", ["seed"], _value);`);
  const root = `import define1 from "./child.js";\n` + exported(`const config = {multiplier: 2};
function scale(value) { return value * config.multiplier; }
function _first() { return config; }
function _second() { return config; }
function _helper() { return scale; }
function _total(value) { return scale(value); }`, `const child = runtime.module(define1);
main.import("value", child);
main.variable(observer("first")).define("first", _first);
main.variable(observer("second")).define("second", _second);
main.variable(observer("helper")).define("helper", _helper);
main.variable(observer("total")).define("total", ["value"], _total);`);
  const result = convert(root, {path: 'root.js', moduleSources: [{path: 'child.js', source: child}]});
  assert.deepEqual(result.modules, [{path: 'child.js', source: child}, {path: 'root.js', source: root}]);
  assert.deepEqual(result.report.localModules, [{path: 'child.js'}]);
  assert.equal(result.report.importedCellCount, 3);
  assert.equal(result.report.rootLexicalScope.modulePath, 'root.js');
  assert(result.report.lexicalBindings.some(module => module.names.includes('scale')));
  assert.match(result.notebook.cells[0].value, /import \{__opengeoLexicalScope as __opengeoRootScope\}/);
  assert.doesNotMatch(result.notebook.cells.at(-1).value, /function scale|function _total/);
  const fixture = fixtureRuntime(result, {seed: () => 4});
  try {
    assert.equal(await fixture.main.value('total'), 14);
    assert.equal(await fixture.main.value('first'), await fixture.main.value('second'));
    assert.equal((await fixture.main.value('helper'))(5), 10);
    const compiled = result.compiled();
    // Editable descriptor ordering does not change deferred notebook imports.
    const reversed = compileLegacyModuleBundle({version: 1, modules: [...result.modules].reverse()}, {kit});
    const registry = createLegacyModuleRegistry(reversed, {readAttachment: () => {}, mutable: Mutable});
    const left = fixture.runtime.module(registry['child.js'].default).derive([], fixture.main);
    const right = fixture.runtime.module(registry['child.js'].default).derive([], fixture.main);
    assert.equal(await left.value('config'), await right.value('config'));
    assert.equal(await left.value('helper'), await right.value('helper'));
    assert.equal((await left.value('helper'))(2), 5);
    assert.equal(await fixture.runtime.module(registry['root.js'].default).value('total'), 14);
    assert(compiled.legacyModules.modules.find(module => module.path === 'root.js').exports.length === 1);
  } finally {fixture.runtime.dispose();}
});

it('revalidates edited lexical descriptors without executing initializers or unavailable bindings', () => {
  const root = exported('const shared = {value: 2};\nfunction _value() { return shared; }', 'main.variable(observer("value")).define("value", _value);');
  globalThis.__legacyLexicalExecuted = false;
  try {
    const result = convert(root, {path: 'root.js'});
    assert.equal(globalThis.__legacyLexicalExecuted, false);
    for (const edited of [root.replace('{value: 2}', '(globalThis.__legacyLexicalExecuted = true)'),
      root.replace('{value: 2}', '(() => { globalThis.__legacyLexicalExecuted = true; return 2; })()'),
      root.replace('{value: 2}', '{get value() { globalThis.__legacyLexicalExecuted = true; return 2; }}'),
      root.replace('return shared;', 'return unavailableBinding;'),
      root.replace('const shared', 'let shared')]) {
      const descriptor = {version: 1, lexicalRoot: 'root.js', modules: [{path: 'root.js', source: edited}]};
      assert.throws(() => compileLegacyModuleBundle(descriptor, {kit}), /Legacy Notebook conversion:/);
      assert.throws(() => result.compiled.call(null) && convert(edited, {path: 'root.js'}), /Legacy Notebook conversion:/);
    }
    assert.equal(globalThis.__legacyLexicalExecuted, false);
    assert.throws(() => compileLegacyModuleBundle({version: 1, lexicalRoot: 'missing.js', modules: result.modules}, {kit}), /root lexical module/);
  } finally {delete globalThis.__legacyLexicalExecuted;}
});

it('discloses helper requests and preserves prototype-like lexical names safely', async () => {
  const root = exported(`const __proto__ = {value: 4};
function constructor() { return __proto__; }
function request(url) { return fetch(url); }
function loader(require) { return require("d3@5"); }
function _value() { return constructor(); }
function _request() { return request; }
function _loader() { return loader; }`, `main.variable(observer("value")).define("value", _value);
main.variable(observer("request")).define("request", _request);
main.variable(observer("loader")).define("loader", _loader);`);
  const result = convert(root, {path: 'root.js'});
  assert(result.report.childFindings.some(finding => finding.kind === 'request-expression' && finding.name === 'fetch'));
  assert(result.report.childFindings.some(finding => finding.kind === 'helper-call' && finding.request === 'd3@5'));
  const fixture = fixtureRuntime(result);
  try {assert.equal((await fixture.main.value('value')).value, 4);}
  finally {fixture.runtime.dispose();}
});

it('converts reviewed local imports and retains reachable originals with escaped descriptors', () => {
  const child = exported('function _value() { return "</script>"; }', 'main.variable(observer("value")).define("value", _value);');
  const result = convert(localRoot, {path: 'root.js', moduleSources: [{path: 'root.js', source: localRoot},
    {path: 'child.js', source: child}, {path: 'unused.js', source: 'throw Error("never inspected as a dependency");'}]});
  assert.deepEqual(result.modules, [{path: 'child.js', source: child}]);
  assert.equal(result.notebook.cells[0].value, 'import {value as localValue} from "observable:opengeo-legacy/child.js"');
  assert.match(result.html, /id="opengeo-legacy-modules"/);
  assert.match(result.html, /\\u003c\/script>/);
  assert.equal(result.compiled().legacyModules.modules[0].path, 'child.js');
});

it('preserves child module laziness, aliases, isolation and shared factory identity', async () => {
  const leaf = exported('function _value(mark) { mark("value"); return {count: 7}; }\nfunction _unused(mark) { mark("unused"); throw Error("unused cell executed"); }',
    'main.variable(observer("value")).define("value", ["mark"], _value);\nmain.variable(observer("unused")).define("unused", ["mark"], _unused);');
  const alias = path => `import define1 from "./leaf.js";\nexport default function define(runtime, observer) { const main = runtime.module(); const child = runtime.module(define1); main.import("value", "${path}", child); return main; }`;
  const descriptor = {version: 1, modules: [{path: 'leaf.js', source: leaf}, {path: 'left.js', source: alias('left')}, {path: 'right.js', source: alias('right')}]};
  const bundle = compileLegacyModuleBundle(descriptor, {kit}), calls = [];
  const registry = createLegacyModuleRegistry(bundle, {readAttachment: () => {throw Error('Unexpected attachment read');}, mutable: Mutable});
  assert.deepEqual(calls, []);
  const runtime = new Runtime({mark: () => value => calls.push(value)}), main = runtime.module();
  try {
    const left = runtime.module(registry['left.js'].default), right = runtime.module(registry['right.js'].default);
    assert.deepEqual(calls, []);
    main.import('left', 'a', left); main.import('right', 'b', right);
    assert.deepEqual(calls, []);
    const a = await main.value('a'), b = await main.value('b');
    assert.equal(a, b); assert.equal(a.count, 7);
    assert.deepEqual(calls, ['value']);
    assert.equal(runtime.module(registry['leaf.js'].default), runtime.module(registry['leaf.js'].default));
    assert.equal(main._scope.has('value'), false);
  } finally {runtime.dispose();}
});

it('preserves legacy mutable exports for local special import pairs and rejects imported builtin overrides', async () => {
  const child = exported('function _count(seed) { return seed; }', mutableDefinitions);
  const root = `import define1 from "./child.js";\nfunction _increment(alias) { return () => ++alias.value; }
export default function define(runtime, observer) { const main = runtime.module(); const child = runtime.module(define1);
main.import("mutable count", "mutable tally", child); main.import("count", "tally", child);
main.variable(observer("increment")).define("increment", ["mutable tally"], _increment); return main; }`;
  const result = convert(root, {moduleSources: [{path: 'child.js', source: child}]});
  assert.equal(result.notebook.cells[0].value, 'import {mutable count as tally} from "observable:opengeo-legacy/child.js"');
  const bundle = compileLegacyModuleBundle({version: 1, modules: result.modules}, {kit});
  const registry = createLegacyModuleRegistry(bundle, {readAttachment: () => {}, mutable: Mutable});
  const runtime = new Runtime({seed: () => 2});
  try {
    const childModule = runtime.module(registry['child.js'].default);
    assert.equal(await childModule.value('count'), 2);
    const mutable = await childModule.value('mutable count'); mutable.value = 8;
    assert.equal(await childModule.value('count'), 8);
  } finally {runtime.dispose();}
  const overridden = 'import define1 from "./child.js";\n' + exported('function _count(seed) { return seed; }',
    'const child = runtime.module(define1);\nmain.import("count", "Mutable", child);\n' + mutableDefinitions);
  assert.throws(() => convert(overridden, {moduleSources: [{path: 'child.js', source: child}]}), /standard Mutable/);
});

it('scopes child attachment names, keeps unused maps private and reports unbundled dependencies', () => {
  const child = exported('function _data(FileAttachment) { return FileAttachment("data.json"); }\nfunction _markdown(md) { return md`# Note`; }\nfunction _dependency(require) { return require("unbundled-package"); }',
    'main.variable(observer("data")).define("data", ["FileAttachment"], _data);\nmain.variable(observer("markdown")).define("markdown", ["md"], _markdown);\nmain.variable(observer("dependency")).define("dependency", ["require"], _dependency);',
    'const fileAttachments = new Map([["data.json", "./files/data"], ["unused.json", "./files/private"]]);\nmain.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));');
  const bundle = compileLegacyModuleBundle({version: 1, modules: [{path: 'a/child.js', source: child}, {path: 'b/child.js', source: child}]}, {kit});
  assert.deepEqual(bundle.attachments.map(({name, path, modulePath, originalName}) => ({name, path, modulePath, originalName})), [
    {name: 'legacy-modules/0/data.json', path: 'a/files/data', modulePath: 'a/child.js', originalName: 'data.json'},
    {name: 'legacy-modules/1/data.json', path: 'b/files/data', modulePath: 'b/child.js', originalName: 'data.json'}]);
  assert(!bundle.findings.some(value => value.name === 'md'));
  assert(bundle.findings.some(value => value.modulePath === 'a/child.js' && value.name === 'require'));
  assert.doesNotMatch(bundle.modules[0].body, /new Map|runtime\.fileAttachments|import\.meta/);
  assert.match(bundle.modules[0].body, /readAttachment\("a\/child.js", name\)/);
});

it('revalidates descriptors and rejects missing, cyclic, noncanonical and captured-binding modules', () => {
  const child = exported('function _value() { return 1; }', 'main.variable(observer("value")).define("value", _value);');
  for (const descriptor of [{version: 2, modules: []}, {version: 1, modules: [{path: '../child.js', source: child}]},
    {version: 1, modules: [{path: 'child.js', source: child}, {path: 'CHILD.js', source: child}]},
    {version: 1, modules: [{path: 'root.js', source: localRoot}]},
    {version: 1, modules: [{path: 'child.js', source: 'throw Error("never execute");'}]},
    {version: 1, modules: [{path: 'child.js', source: child.replace('_value', 'readAttachment')}]},
    {version: 1, modules: [{path: 'root.js', source: localRoot.replace('const child1', 'const legacyMutable').replaceAll(', child1)', ', legacyMutable)')}, {path: 'child.js', source: child}]},
    {version: 1, modules: [{path: 'root.js', source: localRoot.replace('runtime.module(define1)', 'runtime.module(define1).derive(["value"], main)')}, {path: 'child.js', source: child}]},
    {version: 1, modules: [{path: 'child.js', source: localRoot}]}]) {
    assert.throws(() => compileLegacyModuleBundle(descriptor, {kit}), /Legacy Notebook conversion:/);
  }
  assert.throws(() => convert(localRoot), /Missing selected notebook module/);
});

it('groups derived imports by child instance and preserves live substitutions, sharing and namespaces', async () => {
  const child = exported(`function _object(seed) { return {seed}; }
function _echo(object) { return object; }
function _unused() { throw Error("Unimported derived cell executed"); }`,
  `main.variable(observer("object")).define("object", ["seed"], _object);
main.variable(observer("echo")).define("echo", ["object"], _echo);
main.variable(observer("unused")).define("unused", _unused);`);
  const root = `import define1 from "./child.js";
function _left() { return 2; }
function _right() { return 9; }
export default function define(runtime, observer) {
const main = runtime.module();
const first = runtime.module(define1).derive([{name: "leftSeed", alias: "seed"}], main);
const second = runtime.module(define1).derive([{name: "rightSeed", alias: "seed"}], main);
const third = runtime.module(define1).derive([{name: "leftSeed", alias: "seed"}], main);
main.import("object", "firstObject", first);
main.import("echo", "firstEcho", first);
main.import("object", "secondObject", second);
main.import("object", "thirdObject", third);
main.variable(observer("leftSeed")).define("leftSeed", _left);
main.variable(observer("rightSeed")).define("rightSeed", _right);
return main;
}`;
  const result = convert(root, {path: 'root.js', moduleSources: [{path: 'child.js', source: child}]});
  assert.deepEqual(result.notebook.cells.slice(0, 3).map(cell => cell.value), [
    'import {object as firstObject, echo as firstEcho} with {leftSeed as seed} from "observable:opengeo-legacy/child.js"',
    'import {object as secondObject} with {rightSeed as seed} from "observable:opengeo-legacy/child.js"',
    'import {object as thirdObject} with {leftSeed as seed} from "observable:opengeo-legacy/child.js"']);
  const bundle = compileLegacyModuleBundle({version: 1, modules: [{path: 'root.js', source: root}, ...result.modules]}, {kit});
  assert(bundle.modules.find(module => module.path === 'child.js').injectableNames.includes('seed'));
  assert.match(bundle.modules[0].body, /\.derive\(\[\{name: "leftSeed", alias: "seed"\}\], main\)/);
  const registry = createLegacyModuleRegistry(bundle, {readAttachment: () => {}, mutable: Mutable});
  const runtime = new Runtime();
  try {
    const main = runtime.module(registry['root.js'].default);
    const first = await main.value('firstObject'), echo = await main.value('firstEcho');
    assert.equal(first, echo);
    assert.equal(first.seed, 2);
    assert.notEqual(first, await main.value('thirdObject'));
    assert.equal((await main.value('secondObject')).seed, 9);
    main.redefine('leftSeed', [], () => 5);
    assert.equal((await main.value('firstObject')).seed, 5);
    assert.equal(await main.value('firstObject'), await main.value('firstEcho'));
    assert.equal((await main.value('thirdObject')).seed, 5);
    assert.equal((await main.value('secondObject')).seed, 9);
    assert.equal(main._scope.has('object'), false);
    assert.equal(main._scope.has('seed'), false);
    assert.equal(main._scope.has('unused'), false);
  } finally {runtime.dispose();}
});

it('retains paired mutable injections and their live value and mutable handle identity', async () => {
  const child = exported(`function _count(seed) { return seed; }
function _current(alias) { return () => alias['value']; }`, `${mutableDefinitions}
main.variable(observer("current")).define("current", ["mutable count"], _current);`);
  const root = `import define1 from "./child.js";
function _initial() { return 3; }
function _increment(alias) { return () => ++alias["value"]; }
function _current(alias) { return () => alias['value']; }
export default function define(runtime, observer) {
const main = runtime.module();
const child = runtime.module(define1).derive([{name: "parentCount", alias: "count"}, {name: "mutable parentCount", alias: "mutable count"}], main);
main.import("count", "derivedCount", child);
main.import("mutable count", "mutable derivedCount", child);
main.define("initial parentCount", _initial);
main.variable(observer("mutable parentCount")).define("mutable parentCount", ["Mutable", "initial parentCount"], (M, value) => new M(value));
main.variable(observer("parentCount")).define("parentCount", ["mutable parentCount"], value => value.generator);
main.variable(observer("increment")).define("increment", ["mutable derivedCount"], _increment);
main.variable(observer("current")).define("current", ["mutable derivedCount"], _current);
return main;
}`;
  const result = convert(root, {path: 'root.js', moduleSources: [{path: 'child.js', source: child}]});
  assert.equal(result.notebook.cells[0].value, 'import {mutable count as derivedCount} with {mutable parentCount as count} from "observable:opengeo-legacy/child.js"');
  const bundle = compileLegacyModuleBundle({version: 1, modules: [{path: 'root.js', source: root}, ...result.modules]}, {kit});
  const registry = createLegacyModuleRegistry(bundle, {readAttachment: () => {}, mutable: Mutable});
  const runtime = new Runtime({seed: () => 90});
  try {
    const main = runtime.module(registry['root.js'].default);
    assert.equal(await main.value('derivedCount'), 3);
    const mutable = await main.value('mutable parentCount');
    assert.equal(await main.value('mutable derivedCount'), mutable);
    const increment = await main.value('increment'), current = await main.value('current');
    assert.equal(increment(), 4);
    assert.equal(await main.value('parentCount'), 4);
    assert.equal(await main.value('derivedCount'), 4);
    assert.equal(current(), 4);
    mutable.value = 7;
    assert.equal(await main.value('parentCount'), 7);
    assert.equal(await main.value('derivedCount'), 7);
    assert.equal(current(), 7);
    const isolatedChild = runtime.module(registry['child.js'].default);
    assert.equal(await isolatedChild.value('count'), 90);
    assert.equal((await isolatedChild.value('current'))(), 90);
  } finally {runtime.dispose();}
});

it('admits canonical string and builtin injections and rejects ambiguous derivations without execution', () => {
  const child = exported('function _value(seed, width) { return seed + width; }', 'main.variable(observer("value")).define("value", ["seed", "width"], _value);');
  const root = `import define1 from "./child.js";\n` + exported('function _seed() { return 2; }',
    'const child = runtime.module(define1).derive(["seed", "width"], main);\nmain.import("value", child);\nmain.variable(observer("seed")).define("seed", _seed);');
  const options = {path: 'root.js', moduleSources: [{path: 'child.js', source: child}]};
  assert.equal(convert(root, options).notebook.cells[0].value, 'import {value} with {seed, width} from "observable:opengeo-legacy/child.js"');
  assert.equal(convert(root.replace('["seed", "width"]', '[]'), options).notebook.cells[0].value,
    'import {value} with {} from "observable:opengeo-legacy/child.js"');
  globalThis.__legacyInjectionExecuted = false;
  try {
    for (const injections of ['injections', '[...injections]', '["seed", "seed"]', '[{name:"seed", alias:"missing"}]',
      '[{name:"absent", alias:"seed"}]', '[{name:"seed", alias:"width"}, {name:"width", alias:"width"}]',
      '[{name:"seed", alias:"seed", extra:true}]', '[{get name(){globalThis.__legacyInjectionExecuted=true; return "seed"}, alias:"seed"}]',
      '[{name:"mutable seed", alias:"mutable seed"}]', '[{name:"viewof seed", alias:"mutable seed"}]']) {
      assert.throws(() => convert(root.replace('["seed", "width"]', injections), options), /Legacy Notebook conversion:/, injections);
    }
    assert.throws(() => convert(root.replace('], main)', '], runtime.module())'), options), /current main module/);
    assert.equal(globalThis.__legacyInjectionExecuted, false);
  } finally {delete globalThis.__legacyInjectionExecuted;}
});

it('folds an exact viewof pair and retains input-change reactivity and view dependencies', async () => {
  const source = exported(`function _amount(makeInput) { return makeInput(); }
function _double(amount) { return amount * 2; }
function _control(alias) { return alias; }`,
  `main.variable(observer("viewof amount")).define("viewof amount", ["makeInput"], _amount);
main.variable(observer("amount")).define("amount", ["Generators", "viewof amount"], (G, control) => G.input(control));
main.variable(observer("double")).define("double", ["amount"], _double);
main.variable(observer("control")).define("control", ["viewof amount"], _control);`);
  const result = convert(source);
  assert.equal(result.notebook.cells.length, 3);
  assert.equal(result.notebook.cells[0].value, 'viewof amount = makeInput()');
  assert.deepEqual(result.report.reactiveGroups, [{name: 'amount', kind: 'viewof', foldedDefinitions: 2}]);
  assert.equal(result.compiled().cells[0].autoview, true);
  assert.deepEqual(result.compiled().cells[2].inputs, ['viewof$amount']);
  const input = new EventTarget(); input.value = 3;
  const {runtime, main, errors} = fixtureRuntime(result, {makeInput: () => () => input});
  try {
    assert.equal(await main.value('double'), 6);
    assert.equal(await main.value('control'), input);
    input.value = 8; input.dispatchEvent(new Event('input'));
    assert.equal(await main.value('double'), 16);
    assert.deepEqual(errors, []);
  } finally {runtime.dispose();}
});

for (const access of ['.value', '["value"]', "['value']"]) it(`folds an exact mutable triple and retains ${access} reads, assignments, updates and initializer dependencies`, async () => {
  const source = exported(`function _count(seed) { return seed; }
function _increment(alias) { return () => ++alias${access}; }
function _assign(alias) { return value => (alias${access} = value); }
function _current(alias) { return () => alias${access}; }
function _double(count) { return count * 2; }`, `${mutableDefinitions}
main.variable(observer("increment")).define("increment", ["mutable count"], _increment);
main.variable(observer("assign")).define("assign", ["mutable count"], _assign);
main.variable(observer("current")).define("current", ["mutable count"], _current);
main.variable(observer("double")).define("double", ["count"], _double);`);
  const result = convert(source);
  assert.equal(result.notebook.cells.length, 5);
  assert.equal(result.notebook.cells[0].value, 'mutable count = seed');
  assert.deepEqual(result.report.reactiveGroups, [{name: 'count', kind: 'mutable', foldedDefinitions: 3}]);
  assert.equal(result.compiled().cells[0].automutable, true);
  assert.deepEqual(result.compiled().cells[1].inputs, ['mutable$count']);
  const {runtime, main, errors} = fixtureRuntime(result, {seed: () => 4});
  try {
    assert.equal(await main.value('double'), 8);
    const increment = await main.value('increment'), assign = await main.value('assign'), current = await main.value('current');
    assert.equal(increment(), 5);
    assert.equal(await main.value('double'), 10);
    assert.equal(current(), 5);
    assert.equal(assign(9), 9);
    assert.equal(await main.value('double'), 18);
    assert.equal(current(), 9);
    main.redefine('seed', [], () => 20);
    assert.equal(await main.value('count'), 20);
    assert.equal(await main.value('double'), 40);
    assert.deepEqual(errors, []);
  } finally {runtime.dispose();}
});

it('rejects altered, partial or shadowed reactive bridges without executing their code', () => {
  const functions = 'function _count(seed) { return seed; }';
  const cases = [
    mutableDefinitions.replace('value => value.generator', 'value => value.value'),
    mutableDefinitions.replace('(M, value) => new M(value)', '(M, value) => { throw Error("bridge executed"); return new M(value); }'),
    mutableDefinitions.replace('["Mutable", "initial count"]', '["Mutable", "seed"]'),
    mutableDefinitions.split('\n').slice(0, 2).join('\n'),
    mutableDefinitions.replace('main.define("initial count", ["seed"], _count);', 'main.variable(observer("initial count")).define("initial count", ["seed"], _count);'),
    `${mutableDefinitions}\nmain.variable(observer("mutable$count")).define("mutable$count", _collision);`,
    `${mutableDefinitions}\nmain.variable(observer("Mutable")).define("Mutable", _collision);`
  ];
  for (const definitions of cases) {
    const declarations = functions + (definitions.includes('_collision') ? '\nfunction _collision() { return 1; }' : '');
    assert.throws(() => convert(exported(declarations, definitions)), /Legacy Notebook conversion:/);
  }
  const view = `main.variable(observer("viewof amount")).define("viewof amount", _amount);
main.variable(observer("amount")).define("amount", ["Generators", "viewof amount"], (G, control) => G.input(control));`;
  for (const bridge of [view.replace('G.input(control)', 'G.custom(control)'),
    view.replace('G.input(control)', '(console.log("bridge executed"), G.input(control))'),
    `${view}\nmain.variable(observer("Generators")).define("Generators", _collision);`]) {
    assert.throws(() => convert(exported('function _amount() { throw Error("cell executed"); }'
      + (bridge.includes('_collision') ? '\nfunction _collision() { return 1; }' : ''), bridge)), /Legacy Notebook conversion:/);
  }
});

it('rejects mutable-object operations beyond value reads and writes, and removed initial dependencies', () => {
  for (const body of ['return alias;', 'return alias.generator;', 'delete alias.value;', 'return alias.value();',
    'return alias.value`template`;', 'const key = "value"; return alias[key];', 'return alias[`value`];',
    'return alias["va" + "lue"];', 'return alias["generator"];', 'return alias?.["value"];',
    'delete alias["value"];', 'return alias["value"]();', 'return new alias["value"]();',
    'return alias["value"]`template`;']) {
    const source = exported(`function _count(seed) { return seed; }\nfunction _consumer(alias) { ${body} }`,
      `${mutableDefinitions}\nmain.variable(observer("consumer")).define("consumer", ["mutable count"], _consumer);`);
    assert.throws(() => convert(source), /value reads, assignments and updates only/);
  }
  assert.throws(() => convert(exported('function _count(seed) { return seed; }\nfunction _consumer(initial) { return initial; }',
    `${mutableDefinitions}\nmain.variable(observer("consumer")).define("consumer", ["initial count"], _consumer);`)), /no matching native declaration/);
});

it('converts named and anonymous cells without executing module code or cells', () => {
  const source = exported('function _x() { return 3; }\nfunction _1(x) { if (x) throw Error("cell executed"); return x * 2; }',
    'main.variable(observer("x")).define("x", _x);\nmain.variable(observer()).define(["x"], _1);');
  const result = convert(source, {title: 'Original <title>'});
  assert.equal(globalThis.legacyNotebookExecuted, undefined);
  assert.equal(result.notebook.title, 'Original <title>');
  assert.equal(result.notebook.cells[0].value, 'x = 3');
  assert.match(result.notebook.cells[1].value, /throw Error\("cell executed"\)/);
  assert.deepEqual(result.compiled().cells.map(cell => cell.output), ['x', undefined]);
  assert.equal(result.report.cellCount, 2);
  assert.equal(result.report.provenance.grantsPermission, false);
  assert.match(result.report.losses.join(' '), /original source bytes/);
});

it('preserves asynchronous and generator cell source and dependency aliases', () => {
  const result = convert(exported(`async function _a(value) { return await Promise.resolve(value); }
function* _b(a) { yield a; yield a + 1; }
async function* _c(alias) { yield await Promise.resolve(alias); }`,
    'main.variable(observer("a")).define("a", ["input"], _a);\nmain.variable(observer("b")).define("b", ["a"], _b);\nmain.variable(observer("c")).define("c", ["b"], _c);'));
  assert.match(result.notebook.cells[0].value, /async function _a\(value\)/);
  assert.match(result.notebook.cells[0].value, /\.call\(undefined, input\)/);
  assert.match(result.notebook.cells[1].value, /^b = \{ yield a;/);
  assert.match(result.notebook.cells[2].value, /yield\* await/);
  assert.deepEqual(result.compiled().cells.map(cell => cell.inputs), [['input'], ['a'], ['b']]);
});

it('keeps unused dependencies, arguments and recursion in a function wrapper', () => {
  const result = convert(exported('function _x(ignored) { return arguments.length; }\nfunction _y(n) { return n ? _y(n - 1) : 0; }',
    'main.variable(observer("x")).define("x", ["input"], _x);\nmain.variable(observer("y")).define("y", ["n"], _y);'));
  assert.match(result.notebook.cells[0].value, /arguments.length/);
  assert.match(result.notebook.cells[0].value, /\.call\(undefined, input\)/);
  assert.match(result.notebook.cells[0].value, /"use strict"/);
  assert.match(result.notebook.cells[1].value, /function _y/);
  assert.deepEqual(result.compiled().cells.map(cell => cell.inputs), [['input'], ['n']]);
});

it('reports local attachment mappings without reading or fetching their bytes', () => {
  const result = convert(exported('function _data(FileAttachment) { return FileAttachment("rows.csv").csv(); }',
    'main.variable(observer("data")).define("data", ["FileAttachment"], _data);',
    `const fileAttachments = new Map([["rows.csv", {url: new URL("./files/hash.csv", import.meta.url), mimeType: "text/csv"}], ["plain.json", "./files/plain"]]);
main.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));`),
  {path: 'notebook/main.js', availablePaths: ['notebook/files/hash.csv']});
  assert.deepEqual(result.attachments, [{name: 'rows.csv', path: 'notebook/files/hash.csv', mimeType: 'text/csv'}, {name: 'plain.json', path: 'notebook/files/plain'}]);
  assert.deepEqual(result.report.attachments.map(item => item.available), [true, false]);
  assert.deepEqual(result.compiled().files, ['rows.csv']);
});

it('accepts the generated attachment coercion helper without executing or retaining it', () => {
  const result = convert(exported('function _data(FileAttachment) { return FileAttachment("rows.csv").csv(); }',
    'main.variable(observer("data")).define("data", ["FileAttachment"], _data);',
    'function toString() { return this.url; }\nconst fileAttachments = new Map([["rows.csv", {url: new URL("./files/hash.csv", import.meta.url), mimeType: "text/csv", toString}]]);\nmain.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));'),
  {availablePaths: ['files/hash.csv']});
  assert.deepEqual(result.attachments, [{name: 'rows.csv', path: 'files/hash.csv', mimeType: 'text/csv'}]);
  assert.deepEqual(result.compiled().files, ['rows.csv']);
  assert.doesNotMatch(result.html, /function toString|this\.url/);
});

it('refuses changed attachment helpers and executable coercion metadata', () => {
  const fixture = (helper, metadata = 'toString') => exported(
    'function _data(FileAttachment) { return FileAttachment("rows.csv").csv(); }',
    'main.variable(observer("data")).define("data", ["FileAttachment"], _data);',
    `${helper}\nconst fileAttachments = new Map([["rows.csv", {url: "./files/hash.csv", ${metadata}}]]);\nmain.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));`);
  for (const helper of ['', 'function toString() { globalThis.attachmentExecuted = true; return this.url; }',
    'async function toString() { return this.url; }', 'function toString(value) { return this.url; }',
    'function toString() { return this["url"]; }']) assert.throws(() => convert(fixture(helper)), /Legacy Notebook conversion:/);
  for (const metadata of ['toString: () => "changed"', 'get toString() { return this.url; }']) {
    assert.throws(() => convert(fixture('function toString() { return this.url; }', metadata)), /metadata|coercion/);
  }
  assert.equal(globalThis.attachmentExecuted, undefined);
});

it('uses maintained hosted JSON conversion and discloses metadata and attachment limits', () => {
  const source = JSON.stringify({id: 'notebook-id', title: 'Hosted', version: 7, owner: {login: 'original'}, files: [{name: 'data.csv', url: 'https://example.test/data.csv'}],
    nodes: [{id: 71, mode: 'js', value: 'value = FileAttachment("data.csv")', pinned: true, custom: {retainedInOriginal: true}},
      {id: 73, mode: 'md', value: '# Heading', hidden: false}]});
  const result = convert(source, {path: 'original.json', availablePaths: ['data.csv']});
  assert.deepEqual(result.notebook.cells.map(({id, mode}) => ({id, mode})), [{id: 71, mode: 'ojs'}, {id: 73, mode: 'md'}]);
  assert.equal(result.report.provenance.id, 'notebook-id');
  assert.deepEqual(result.attachments, [{name: 'data.csv', path: 'data.csv'}]);
  assert.match(result.report.losses.join(' '), /Unknown notebook and cell metadata/);
  assert.equal(JSON.parse(source).nodes[0].custom.retainedInOriginal, true);
});

it('rejects unknown top-level and factory logic, imports and ambiguous cells atomically', () => {
  const functions = 'function _x() { return 1; }';
  const definition = 'main.variable(observer("x")).define("x", _x);';
  const cases = [
    `globalThis.legacyNotebookExecuted = true;\n${exported(functions, definition)}`,
    exported(functions, `${definition}\nmain.value("x");`),
    `import child from "./child.js";\n${exported(functions, definition)}`,
    exported(`${functions}\nfunction unused() { return 4; }`, definition),
    exported(functions, 'main.variable(observer("viewof x")).define("viewof x", _x);'),
    exported(functions, 'main.variable(observer("x")).define("x", ["mutable input"], _x);'),
    exported(functions, 'main.variable(observer("other")).define("x", _x);'),
    exported(functions, `${definition}\n${definition}`),
    exported('function _x() { return import("./module.js"); }', definition),
    exported('function _x() { return helper; }', definition),
    exported('function _x() { return import.meta.url; }', definition),
    exported('function _x() { return this; }', definition),
    exported('function _x(FileAttachment) { return FileAttachment("rows.csv"); }', 'main.variable(observer("x")).define("x", ["FileAttachment"], _x);'),
    exported('function main() { return 4; }', 'main.variable(observer("x")).define("x", main);'),
    exported('function _x(file) { return file("rows.csv"); }', 'main.variable(observer("x")).define("x", ["FileAttachment"], _x);')
  ];
  for (const source of cases) assert.throws(() => convert(source), /Legacy Notebook conversion:/);
  assert.equal(globalThis.legacyNotebookExecuted, undefined);
});

it('rejects remote, duplicate or executable attachment metadata and incomplete wiring', () => {
  const functions = 'function _x() { return 1; }';
  const definition = 'main.variable(observer("x")).define("x", _x);';
  for (const map of ['[["data", "https://example.test/data"]]', '[["data", "./a"], ["data", "./b"]]',
    '[["data", {get url() { globalThis.legacyNotebookExecuted = true; }}]]', '[["data", fetch("./a")]]']) {
    assert.throws(() => convert(exported(functions, definition, `const fileAttachments = new Map(${map});\nmain.builtin("FileAttachment", runtime.fileAttachments(name => fileAttachments.get(name)));`)), /Legacy Notebook conversion:/);
  }
  assert.throws(() => convert(exported(functions, definition, 'const fileAttachments = new Map([]);')), /not wired/);
  assert.equal(globalThis.legacyNotebookExecuted, undefined);
});

it('rejects invalid JSON IDs, modes, metadata and source bounds without changing input', () => {
  for (const nodes of [[{id: 1, mode: 'unknown', value: 'x'}], [{id: 0, mode: 'js', value: 'x'}],
    [{id: 1, mode: 'js', value: 'x'}, {id: 1, mode: 'md', value: 'y'}], [{id: 1, mode: 'js', value: 'x', hidden: 'false'}]]) {
    assert.throws(() => convert(JSON.stringify({nodes})), /Legacy Notebook conversion:/);
  }
  assert.throws(() => convert(' '.repeat(4_194_305)), /4 MiB/);
  assert.throws(() => convert(JSON.stringify({nodes: [{id: 1, mode: 'js', value: 'x = FileAttachment("https://example.test/a")'}]})), /Attachment paths/);
  assert.throws(() => convert('{"nodes":[]} ', {availablePaths: Array(129).fill('file')}), /128/);
});


it('resolves only matching pinned offline libraries and retains shared module identity', async () => {
 const modules = Object.fromEntries(Object.keys(LEGACY_LIBRARY_PINS).map(name => [name, Object.freeze({name})]));
 const require = createOfflineLegacyRequire(modules);
 for (const [name, version] of Object.entries(LEGACY_LIBRARY_PINS)) {
  const installed=JSON.parse(await readFile(new URL(`../node_modules/${name}/package.json`,import.meta.url)));
  assert.equal(installed.version,version,'Review and runtime pins must match actual bundled packages');
  for (const request of [name, `${name}@${version.split('.')[0]}`, `${name}@${version.split('.').slice(0,2).join('.')}`, `${name}@${version}`]) {
   assert.deepEqual(resolveLegacyLibrary(request), {name, version});
   assert.equal(await require(request), modules[name]);
  }
 }
 for (const request of ['d3@5', 'd3@7.8.5', 'd3@^7', 'd3@7.9.0/index.js', 'https://example.test/d3.js', 'unknown', null, {}]) {
  assert.equal(resolveLegacyLibrary(request), null);
  await assert.rejects(require(request), /unavailable offline/);
 }
 await assert.rejects(require('d3', 'htl'), /unavailable offline/);
});

it('reviews literal legacy library loaders and aliased child dependencies without running them', () => {
 const child = exported('function _Plot(loader) { return loader("@observablehq/plot@0.6"); }\nfunction _bad(require) { return require("d3@5"); }',
  'main.variable(observer("Plot")).define("Plot", ["require"], _Plot);\nmain.variable(observer("bad")).define("bad", ["require"], _bad);');
 const root = exported('function _d3(loader) { return loader("d3@7.9"); }', 'main.variable(observer("d3")).define("d3", ["require"], _d3);');
 const result = convert(root);
 assert.deepEqual(result.report.libraryRequests.map(({request,bundled,version})=>({request,bundled,version})),[{request:'d3@7.9',bundled:true,version:'7.9.0'}]);
 const bundle = compileLegacyModuleBundle({version:1,modules:[{path:'child.js',source:child}]},{kit});
 assert(bundle.findings.some(finding=>finding.kind==='bundled-library'&&finding.version==='0.6.17'));
 assert(bundle.findings.some(finding=>finding.kind==='runtime-dependency'&&finding.request==='d3@5'));
 assert.equal(result.compiled().cells.length,1);
});


it('preserves custom require loaders without reporting their requests as pinned offline libraries', () => {
 const root=exported('function _require() { return name => ({custom:name}); }\nfunction _d3(loader) { return loader("d3@7"); }',
  'main.variable(observer("require")).define("require",_require);\nmain.variable(observer("d3")).define("d3",["require"],_d3);');
 const result=convert(root);
 assert.equal(result.report.libraryRequests[0].bundled,false);
 assert.match(result.report.libraryRequests[0].message,/own require loader/);
 assert(result.report.manualWork.some(item=>/own require loader/.test(item)));
 assert(result.report.modules.every(module=>module.kind!=='legacy-require'||!module.bundled));
});
