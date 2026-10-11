// Convert data and a bounded subset of Observable's compiled export by parsing
// only. Submitted modules, factories, cells and attachment URLs never execute.
import {inspectObservableNotebookImport, notebookAttachmentPath} from './observable-notebook.mjs';
import {resolveLegacyLibrary} from './legacy-notebook-runtime.mjs';

const MODES = new Set(['js', 'ojs', 'md', 'html', 'tex', 'dot', 'sql', 'sql.view', 'node', 'python', 'r']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SPECIAL_NAME = /^(viewof|mutable|initial) ([A-Za-z_$][\w$]*)$/;
const RESERVED_FACTORY_BINDINGS = new Set(['define', 'runtime', 'observer', 'main', 'fileAttachments', 'modules', 'readAttachment', 'legacyMutable']);
const BUNDLED_BUILTINS = new Set(['FileAttachment', 'Generators', 'Mutable', 'Promises', 'DOM', 'Files', 'dark', 'now', 'width', 'invalidation', 'visibility', 'html', 'svg', 'htl', 'Inputs', 'Plot', 'd3', 'md', 'require']);
const fail = message => {throw Error(`Legacy Notebook conversion: ${message}`);};
const isId = (node, name) => node?.type === 'Identifier' && (name === undefined || node.name === name);
const isMember = (node, object, property) => node?.type === 'MemberExpression' && !node.computed && !node.optional
  && (typeof object === 'string' ? isId(node.object, object) : node.object === object) && isId(node.property, property);
const isCall = (node, object, method, length) => node?.type === 'CallExpression' && !node.optional
  && isMember(node.callee, object, method) && (length === undefined || node.arguments.length === length);
const literal = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;

export function convertLegacyObservable(source, {kit, document, title = 'Imported notebook', path = 'notebook.js', availablePaths = [], moduleSources = []} = {}) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 4_194_304) fail('Choose a source file at most 4 MiB.');
  if (!Array.isArray(availablePaths) || availablePaths.length > 128 || availablePaths.some(value => typeof value !== 'string')) fail('Review at most 128 attachment paths.');
  if (typeof path !== 'string' || !path || typeof title !== 'string') fail('A source path and notebook title are required.');
  const json = /^\s*\{/.test(source.replace(/^\uFEFF/, ''));
  const selectedModules = moduleSourceMap(moduleSources);
  const converted = json ? fromJson(source, kit, path) : fromModule(source, kit, path, new Set(selectedModules.keys()));
  const modules = [], visited = new Set(), visiting = new Set([path]);
  function collect(modulePath) {
    if (visiting.has(modulePath)) fail('Cyclic local notebook imports require manual conversion.');
    if (visited.has(modulePath)) return;
    const moduleSource = selectedModules.get(modulePath);
    if (moduleSource === undefined) fail(`Missing selected notebook module: ${modulePath}.`);
    visiting.add(modulePath);
    const child = fromModule(moduleSource, kit, modulePath, new Set(selectedModules.keys()));
    for (const dependency of child.modulePaths) collect(dependency);
    visiting.delete(modulePath); visited.add(modulePath);
    modules.push({path: modulePath, source: moduleSource});
  }
  for (const modulePath of converted.modulePaths ?? []) collect(modulePath);
  const descriptorModules = converted.lexicalScope ? [...modules, {path, source}] : modules;
  const descriptor = {version: 1, modules: descriptorModules, ...(converted.lexicalScope ? {lexicalRoot: path} : {})};
  const bundle = compileLegacyModuleBundle(descriptor, {kit});
  for (const entry of converted.imports ?? []) {
    if (!bundle.modules.find(module => module.path === entry.modulePath)?.exports.includes(entry.imported)) fail(`Imported name ${entry.imported} is missing from ${entry.modulePath}.`);
  }
  validateInjectionTargets(converted.derivations ?? [], bundle.modules);
  const attachments = [...converted.attachments, ...bundle.attachments.filter(file => !converted.lexicalScope || file.modulePath !== path)];
  if (new Set(attachments.map(file => file.name.toLowerCase())).size !== attachments.length) fail('Root and child attachment names collide.');
  if (attachments.length > 128) fail('The export exceeds 128 attachments.');
  if (converted.cells.length + bundle.cellCount > 1000) fail('The export exceeds 1,000 combined cells.');
  if (converted.lexicalScope) converted.cells.unshift({id: 0, mode: 'ojs', value: `import {${converted.lexicalScope.exported} as ${converted.lexicalScope.binding}} from ${JSON.stringify('observable:opengeo-legacy/' + encodeURIComponent(path))}`});
  if (converted.lexicalScope) converted.cells.forEach((cell, index) => {cell.id = index + 1;});
  let html = kit.serialize(kit.toNotebook({title: converted.title ?? title, cells: converted.cells}), {document});
  if (descriptorModules.length) html += `<script type="application/json" id="opengeo-legacy-modules">${JSON.stringify(descriptor).replace(/</g, '\\u003c')}</script>\n`;
  if (new TextEncoder().encode(html).length > 4_194_304) fail('The converted Notebook exceeds 4 MiB.');
  const inspection = inspectObservableNotebookImport(html, {kit, path, availablePaths, parser: {parseFromString(value) {
    const template = document.createElement('template'); template.innerHTML = value; return template.content;
  }}});
  if (!json && inspection.attachments.some(item => !attachments.some(mapping => mapping.name === item.name))) fail('A FileAttachment reference is missing from the exported attachment map.');
  const report = {
    kind: json ? 'legacy-observable-json' : 'legacy-observable-module',
    title: converted.title ?? title, cellCount: converted.cells.length, convertedCells: converted.cells.length,
    cells: converted.cells.map(({id, mode}, index) => ({id, mode, ...(converted.names?.[index] ? {name: converted.names[index]} : {})})),
    attachments: attachments.map(item => ({...item, available: availablePaths.includes(item.path)})),
    modules: inspection.modules, externalReferences: inspection.externalReferences, unsupported: inspection.unsupported,
    reactiveGroups: converted.reactiveGroups ?? [],
    libraryRequests: converted.libraryRequests ?? inspection.modules.filter(module => module.kind === 'legacy-require'),
    libraryRequestsTruncated: converted.libraryRequestsTruncated ?? false,
    localModules: modules.map(({path}) => ({path})), importedCellCount: bundle.cellCount,
    lexicalBindings: bundle.modules.filter(module => module.lexicalBindings?.length).map(module => ({modulePath: module.path, names: module.lexicalBindings})),
    ...(converted.lexicalScope ? {rootLexicalScope: {modulePath: path, ...converted.lexicalScope}} : {}),
    childFindings: bundle.findings,
    childFindingsTruncated: bundle.findingsTruncated,
    truncated: inspection.truncated,
    provenance: {sourcePath: path, ...converted.provenance, grantsPermission: false},
    losses: [...converted.losses,
      'Converted HTML normalizes line endings and blank-line whitespace. Retain the exact original source bytes and this report.',
      'Runtime outputs, notebook history, comments, ownership and publication rights are not transferred. Source provenance does not grant permission.',
      'No attachment bytes or remote dependencies are fetched. Missing attachments and unsupported dependencies require separate review.'],
    manualWork: ['Retain the original export, conversion report and supplied attachments alongside the converted Notebook.',
      'Review attachment mappings and provide the missing local files under their FileAttachment names.',
      'Run Notebook import review, inspect the isolated preview, and review publication rights before saving or publishing.',
      ...(converted.libraryRequests ?? []).filter(request => !request.bundled).map(request => request.message),
      ...inspection.manualWork.filter(value => !value.startsWith('Include the missing'))],
    limitations: ['Conversion parses source without running cells, importing modules or resolving external URLs.',
      'Library version resolutions describe the standard offline require loader. User-defined or injected loaders retain their own behavior and need separate review.',
      'Static references may omit computed requests and dependencies, including attachments in cells that fail compilation. Conversion does not establish rendering compatibility.',
      'Compiled mutable dependencies support value reads, assignments and updates only; mutable-object identity, generator access, deletion and receiver-dependent calls require manual conversion.',
      'Module, external-reference and unsupported-cell findings show at most 100 entries per list.']
  };
  return {html, report, attachments, modules: descriptorModules};
}

function moduleSourceMap(values) {
  if (!Array.isArray(values) || values.length > 32) fail('Choose at most 32 local notebook modules.');
  const modules = new Map(), keys = new Set(); let bytes = 0;
  for (const value of values) {
    const path = value?.path;
    if (typeof path !== 'string' || !/\.(?:js|mjs)$/i.test(path) || path.length > 1024
      || /[\\\x00-\x1f\x7f?#:%]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) fail('Notebook modules require safe relative JavaScript paths.');
    const size = typeof value.source === 'string' ? new TextEncoder().encode(value.source).length : Infinity;
    if (!size || size > 4_194_304 || (bytes += size) > 16_777_216) fail('Local modules exceed the 4 MiB file or 16 MiB total limit.');
    if (keys.has(path.toLowerCase())) fail('Notebook module paths must be case-insensitively unique.');
    keys.add(path.toLowerCase()); modules.set(path, value.source);
  }
  return modules;
}

function resolveModulePath(path, specifier, available) {
  if (typeof specifier !== 'string' || !/^\.\.?\//.test(specifier)) fail('Notebook imports must name selected relative JavaScript modules.');
  const resolved = localPath(path, specifier);
  if (!available.has(resolved)) fail(`Missing selected notebook module: ${resolved}.`);
  return resolved;
}

/** Revalidate the editable descriptor before compiler/runtime use. No submitted
 * function executes; factory bodies capture only the isolated runtime registry. */
export function compileLegacyModuleBundle(descriptor, {kit} = {}) {
  if (!descriptor || descriptor.version !== 1 || !['modules,version', 'lexicalRoot,modules,version'].includes(Object.keys(descriptor).sort().join(','))) fail('Invalid local module descriptor.');
  const sources = moduleSourceMap(descriptor.modules), available = new Set(sources.keys());
  if (Object.hasOwn(descriptor, 'lexicalRoot') && (typeof descriptor.lexicalRoot !== 'string' || !available.has(descriptor.lexicalRoot))) fail('Invalid root lexical module.');
  const plans = new Map(), modules = [], attachments = [], findings = []; let cellCount = 0, findingsTruncated = false;
  for (const [path, source] of sources) {
    const plan = fromModule(source, kit, path, available);
    const lexicalRoot = path === descriptor.lexicalRoot;
    if (lexicalRoot && !plan.lexicalScope) fail('The root module has no validated lexical scope.');
    if ((cellCount += lexicalRoot ? 0 : plan.cells.length) > 1000) fail('The local module graph exceeds 1,000 cells.');
    plans.set(path, plan); modules.push({path, body: lexicalRoot ? plan.lexicalFactoryBody : plan.factoryBody,
      exports: lexicalRoot ? [plan.lexicalScope.exported] : [...plan.definitions.map(cell => cell.name).filter(name => name !== null), ...plan.imports.map(value => value.local)],
      injectableNames: lexicalRoot ? [] : [...new Set([...plan.definitions.flatMap(cell => [cell.name, ...cell.deps]).filter(name => name !== null), ...plan.imports.map(value => value.local)])],
      ...(plan.lexicalBindings.length ? {lexicalBindings: plan.lexicalBindings} : {})});
    const prefix = `legacy-modules/${modules.length - 1}/`;
    const referencedFiles = new Set();
    const declared = new Set([...plan.definitions.map(cell => cell.name), ...plan.imports.map(value => value.local)]);
    const addFinding = finding => {if (findings.length < 100) findings.push({modulePath: path, ...finding}); else findingsTruncated = true;};
    for (const cell of plan.definitions) {
      for (const request of legacyLibraryRequests(cell, declared.has('require'))) addFinding({kind: request.bundled ? 'bundled-library' : 'runtime-dependency',
        cell: cell.name, name: 'require', ...request});
      for (const name of cell.deps) if (!declared.has(name) && !BUNDLED_BUILTINS.has(name)) addFinding({kind: 'runtime-dependency', cell: cell.name, name,
        message: `Imported cell depends on ${name}; availability and offline compatibility require review.`});
      walk(cell.fn, node => {
        if (['CallExpression', 'NewExpression'].includes(node.type)) {
          const name = node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name;
          if (['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'sendBeacon'].includes(name)) addFinding({kind: 'request-expression', cell: cell.name, name,
            message: `Imported cell contains ${name}(…); no request was made and computed destinations require manual review.`});
        }
      });
    }
    for (const declaration of plan.helperDeclarations) {
      addFinding({kind: 'module-helper', name: declaration.id?.name ?? null,
        message: 'Retained module helper bodies run only in the isolated runtime; review their calls and external dependencies.'});
      walk(declaration, node => {
        if (!['CallExpression', 'NewExpression'].includes(node.type)) return;
        const name = node.callee?.type === 'Identifier' ? node.callee.name : node.callee?.property?.name;
        if (['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'sendBeacon'].includes(name)) addFinding({kind: 'request-expression', name,
          message: `Module helper contains ${name}(…); no request was made and computed destinations require manual review.`});
        if (isId(node.callee) && declaration.params?.some(parameter => isId(parameter, node.callee.name))) addFinding({kind: 'helper-call', name,
          request: node.arguments.length === 1 ? literal(node.arguments[0]) : null,
          message: 'Module helper calls a supplied function; loader identity and compatibility require review.'});
      });
      for (const match of source.slice(declaration.start, declaration.end).matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
        let value = '[external reference]';
        try {const url = new URL(match[0]); value = url.origin + url.pathname;} catch {}
        addFinding({kind: 'external-reference', value: value.slice(0, 512), message: 'Literal module-helper external reference; no request was made.'});
      }
    }
    for (const cell of plan.cells) {
      try {
        const compiled = kit.transpile(cell, {resolveImport: name => name});
        for (const name of compiled.files ?? []) {
          if (!plan.attachments.some(file => file.name === name)) fail(`Imported Notebook ${path} is missing its attachment mapping for ${name}.`);
          referencedFiles.add(name);
        }
        if (compiled.databases?.size || compiled.secrets?.size) fail('Imported notebooks cannot request databases or account secrets.');
      } catch (error) {
        if (String(error.message).startsWith('Legacy Notebook conversion:')) throw error;
        addFinding({kind: 'unsupported', cell: cell.id, message: error.message});
      }
      for (const match of cell.value.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
        let value = '[external reference]';
        try {const url = new URL(match[0]); value = url.origin + url.pathname;} catch {}
        addFinding({kind: 'external-reference', cell: cell.id, value: value.slice(0, 512), message: 'Literal external reference; no request was made.'});
      }
    }
    for (const attachment of plan.attachments.filter(file => lexicalRoot || referencedFiles.has(file.name))) attachments.push({...attachment, modulePath: path, originalName: attachment.name, name: lexicalRoot ? attachment.name : prefix + localPath('index.html', attachment.name)});
    if (attachments.length > 128) fail('The local module graph exceeds 128 attachments.');
  }
  for (const plan of plans.values()) for (const entry of plan.imports) {
    if (!modules.find(module => module.path === entry.modulePath)?.exports.includes(entry.imported)) fail(`Imported name ${entry.imported} is missing from ${entry.modulePath}.`);
  }
  for (const plan of plans.values()) validateInjectionTargets(plan.derivations, modules);
  const complete = new Set(), active = new Set();
  function visit(path) {
    if (active.has(path)) fail('Cyclic local notebook imports require manual conversion.');
    if (complete.has(path)) return;
    active.add(path);
    for (const child of plans.get(path).modulePaths) visit(child);
    active.delete(path); complete.add(path);
  }
  for (const path of plans.keys()) visit(path);
  if (new Set(attachments.map(file => file.name.toLowerCase())).size !== attachments.length) fail('Child attachment names collide after path normalization.');
  return {modules, attachments, cellCount, findings, findingsTruncated};
}

function fromJson(source, kit, path) {
  let value;
  try {value = JSON.parse(source.replace(/^\uFEFF/, ''));} catch {fail('Invalid hosted Notebook JSON.');}
  if (!value || Array.isArray(value) || !Array.isArray(value.nodes) || value.nodes.length > 1000 || (value.title !== undefined && typeof value.title !== 'string')) fail('Hosted JSON must contain title and an array of at most 1,000 nodes.');
  const ids = new Set(), attachments = new Map();
  const cells = value.nodes.map(node => {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !Number.isSafeInteger(node.id) || node.id <= 0 || ids.has(node.id)) fail('Hosted cells need unique positive integer IDs.');
    if (typeof node.value !== 'string' || !MODES.has(node.mode)) fail(`Cell ${node.id} has an unsupported mode or missing source.`);
    for (const key of ['pinned', 'hidden']) if (node[key] !== undefined && typeof node[key] !== 'boolean') fail(`Cell ${node.id} has invalid ${key} metadata.`);
    for (const key of ['output', 'format', 'database']) if (node[key] !== undefined && typeof node[key] !== 'string') fail(`Cell ${node.id} has invalid ${key} metadata.`);
    ids.add(node.id);
    const cell = {id: node.id, value: node.value, mode: node.mode === 'js' ? 'ojs' : node.mode,
      ...Object.fromEntries(['pinned', 'hidden', 'output', 'format', 'database'].filter(key => node[key] !== undefined).map(key => [key, node[key]]))};
    let files = [];
    try {files = kit.transpile(cell, {resolveImport: name => name}).files ?? [];}
    catch { /* Native import review reports unsupported cells; their source is retained. */ }
    for (const name of files) attachments.set(name, {name, path: localPath(path, name)});
    return cell;
  });
  const provenance = {};
  for (const key of ['id', 'slug', 'version', 'url']) {
    if (typeof value[key] === 'string' || typeof value[key] === 'number') provenance[key] = value[key];
  }
  return {title: value.title, cells, attachments: [...attachments.values()], provenance,
    losses: ['Hosted JSON conversion follows Notebook Kit 2.5.6: legacy js cells become ojs. Unknown notebook and cell metadata, including attachment URL metadata, stays in the retained original JSON.']};
}

function fromModule(source, kit, path, availableModules = new Set()) {
  let parsed;
  try {parsed = kit.parseJavaScript(source).body;} catch (error) {fail(`The JavaScript export cannot be parsed: ${error.message}`);}
  if (parsed.type !== 'Program') fail('Choose a compiled Observable module with export default function define(runtime, observer).');
  let factory;
  const functions = new Map(), importedFactories = new Map(), constants = new Map(), lexicalStatements = [];
  const bind = name => {
    if (!IDENTIFIER.test(name) || RESERVED_FACTORY_BINDINGS.has(name) || kit.defaultGlobals.has(name)
      || functions.has(name) || importedFactories.has(name) || constants.has(name)) fail('Ambiguous module lexical binding.');
  };
  for (const statement of parsed.body) {
    if (statement.type === 'FunctionDeclaration' && statement.id && !functions.has(statement.id.name)) {
      bind(statement.id.name);
      functions.set(statement.id.name, statement);
      lexicalStatements.push(statement);
    } else if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length) {
      for (const declaration of statement.declarations) {
        if (!isId(declaration.id) || !declaration.init) fail('Module constants require initialized identifier bindings.');
        bind(declaration.id.name);
        constants.set(declaration.id.name, declaration);
      }
      lexicalStatements.push(statement);
    } else if (statement.type === 'ImportDeclaration' && statement.specifiers.length === 1
      && statement.specifiers[0].type === 'ImportDefaultSpecifier' && !statement.attributes?.length) {
      const binding = statement.specifiers[0].local.name;
      bind(binding);
      importedFactories.set(binding, resolveModulePath(path, literal(statement.source), availableModules));
    } else if (statement.type === 'ExportDefaultDeclaration' && !factory) {
      factory = statement.declaration;
    } else fail('Unsupported top-level statement or imported module; nothing was converted.');
  }
  const lexicalNames = new Set([...functions.keys(), ...constants.keys()]);
  const referencesOf = node => {
    let references;
    try {references = kit.parseJavaScript(node.type === 'FunctionDeclaration' ? source.slice(node.start, node.end) : `(${source.slice(node.start, node.end)})`).references;}
    catch (error) {fail(`Module lexical declaration cannot be represented: ${error.message}`);}
    if (references.some(reference => !lexicalNames.has(reference.name))) fail('A module helper closes over an unavailable binding.');
    return references.map(reference => reference.name);
  };
  const functionReferences = new Map([...functions].map(([name, fn]) => {
    rejectLexicalModuleContext(fn);
    return [name, referencesOf(fn)];
  }));
  const initializedConstants = new Set();
  for (const statement of lexicalStatements) if (statement.type === 'VariableDeclaration') {
    for (const declaration of statement.declarations) {
      validateLexicalInitializer(declaration.init, new Set([...functions.keys(), ...initializedConstants]));
      initializedConstants.add(declaration.id.name);
    }
  }
  if (factory?.type !== 'FunctionDeclaration' || !isId(factory.id, 'define') || factory.async || factory.generator
    || factory.params.length !== 2 || !isId(factory.params[0], 'runtime') || !isId(factory.params[1], 'observer')) fail('Expected export default function define(runtime, observer).');
  const statements = factory.body.body;
  const first = statements[0];
  if (first?.type !== 'VariableDeclaration' || first.kind !== 'const' || first.declarations.length !== 1
    || !isId(first.declarations[0].id, 'main') || !isCall(first.declarations[0].init, 'runtime', 'module', 0)) fail('Expected one main module from runtime.module().');
  const last = statements.at(-1);
  if (last?.type !== 'ReturnStatement' || !isId(last.argument, 'main')) fail('Expected the factory to return main without additional statements.');
  const definitions = [], used = new Set(), outputNames = new Set(), children = new Map(), imports = [], edits = [];
  let attachments = null, wired = false, sawCell = false, attachmentToString = false;
  for (const statement of statements.slice(1, -1)) {
    if (statement.type === 'FunctionDeclaration' && isId(statement.id, 'toString')
      && !statement.async && !statement.generator && statement.params.length === 0
      && statement.body.body.length === 1 && statement.body.body[0].type === 'ReturnStatement'
      && isMember(statement.body.body[0].argument, statement.body.body[0].argument?.object, 'url')
      && statement.body.body[0].argument.object.type === 'ThisExpression'
      && !attachmentToString && attachments === null && !sawCell
      && !functions.has('toString') && !importedFactories.has('toString')) {
      // Generated metadata coercion is inspected, never invoked or retained as
      // executable factory setup. Attachment bytes use the existing local path.
      attachmentToString = true;
      edits.push({start: statement.start, end: statement.end, text: ''});
      continue;
    }
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length === 1
      && isId(statement.declarations[0].id, 'fileAttachments') && attachments === null && !sawCell) {
      attachments = readAttachments(statement.declarations[0].init, path, attachmentToString);
      edits.push({start: statement.start, end: statement.end, text: ''});
      continue;
    }
    const call = statement.type === 'ExpressionStatement' ? statement.expression : null;
    if (isCall(call, 'main', 'builtin', 2) && !wired && !sawCell && attachments !== null) {
      if (literal(call.arguments[0]) !== 'FileAttachment' || !attachmentWiring(call.arguments[1])) fail('Unsupported FileAttachment wiring.');
      wired = true;
      edits.push({start: call.arguments[1].start, end: call.arguments[1].end, text: `(name) => readAttachment(${JSON.stringify(path)}, name)`});
      continue;
    }
    if (statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declarations.length === 1) {
      const declaration = statement.declarations[0];
      let initialization = declaration.init, injections = null;
      if (initialization?.type === 'CallExpression' && isMember(initialization.callee, initialization.callee.object, 'derive')) {
        if (initialization.optional || initialization.arguments.length !== 2 || !isId(initialization.arguments[1], 'main')) fail('Notebook derivation must inject from the current main module.');
        injections = readInjections(initialization.arguments[0]);
        initialization = initialization.callee.object;
      }
      if (!isId(declaration.id) || !isCall(initialization, 'runtime', 'module', 1) || !isId(initialization.arguments[0])
        || !importedFactories.has(initialization.arguments[0].name) || children.has(declaration.id.name)
        || RESERVED_FACTORY_BINDINGS.has(declaration.id.name) || kit.defaultGlobals.has(declaration.id.name)
        || functions.has(declaration.id.name) || importedFactories.has(declaration.id.name) || constants.has(declaration.id.name)) fail('Unsupported child notebook module or derivation.');
      children.set(declaration.id.name, {modulePath: importedFactories.get(initialization.arguments[0].name), injections});
      continue;
    }
    if (isCall(call, 'main', 'import') && [2, 3].includes(call.arguments.length)) {
      const imported = literal(call.arguments[0]), local = call.arguments.length === 3 ? literal(call.arguments[1]) : imported;
      const child = call.arguments.at(-1);
      if (!imported || !local || !isId(child) || !children.has(child.name)) fail('Unsupported notebook import binding.');
      imports.push({imported, local, instance: child.name, ...children.get(child.name)});
      continue;
    }
    sawCell = true;
    if (!call || call.type !== 'CallExpression' || call.optional || !isMember(call.callee, call.callee.object, 'define')) fail('Unsupported factory statement, import or side effect; nothing was converted.');
    const unobserved = isId(call.callee.object, 'main');
    let observer;
    if (!unobserved) {
      const variable = call.callee.object;
      if (!isCall(variable, 'main', 'variable', 1)) fail('Only ordinary observed cells and generated initial values can be converted.');
      observer = variable.arguments[0];
      if (observer?.type !== 'CallExpression' || observer.optional || !isId(observer.callee, 'observer') || observer.arguments.length > 1
        || observer.arguments.length === 1 && literal(observer.arguments[0]) === null) fail('Unsupported observer definition.');
    }
    const args = [...call.arguments];
    const fnRef = args.pop();
    const name = literal(args[0]);
    if (name !== null) args.shift();
    const deps = args.length ? readStrings(args.shift()) : [];
    const inline = ['FunctionExpression', 'ArrowFunctionExpression'].includes(fnRef?.type);
    if (args.length || deps === null || !inline && (!isId(fnRef) || !functions.has(fnRef.name) || used.has(fnRef.name))) fail('Ambiguous or unsupported cell definition.');
    if (name !== null && ((!IDENTIFIER.test(name) && !SPECIAL_NAME.test(name)) || outputNames.has(name))) fail('Duplicate or unsupported cell names require manual conversion.');
    if (deps.some(name => !IDENTIFIER.test(name) && !SPECIAL_NAME.test(name)) || new Set(deps).size !== deps.length) fail('Special or duplicate cell dependencies require manual conversion.');
    if (unobserved ? !name?.startsWith('initial ') : (observer.arguments.length ? literal(observer.arguments[0]) : null) !== name) fail('The observed cell name differs from its definition.');
    const fn = inline ? fnRef : functions.get(fnRef.name);
    if (!inline) used.add(fnRef.name);
    if (name !== null) outputNames.add(name);
    definitions.push({name, deps, fn, inline, unobserved});
    if (definitions.length > 3000) fail('The export exceeds 1,000 cells and their generated bridges.');
  }
  const reachable = new Set(used);
  const visitLexical = name => {
    for (const reference of functionReferences.get(name) ?? []) if (!reachable.has(reference)) {
      reachable.add(reference); visitLexical(reference);
    }
  };
  for (const name of used) visitLexical(name);
  // Constants may retain function values, including callbacks nested in objects.
  for (const declaration of constants.values()) for (const reference of referencesOf(declaration.init)) {
    if (!reachable.has(reference)) {reachable.add(reference); visitLexical(reference);}
  }
  if ([...functions.keys()].some(name => !reachable.has(name))) fail('The module contains unused helper functions or unconverted cells.');
  if (attachments !== null && !wired) fail('The attachment map is not wired to FileAttachment.');
  if ([...importedFactories.values()].some(modulePath => ![...children.values()].some(child => child.modulePath === modulePath))) fail('An imported factory is not registered as a child notebook module.');
  const derivations = [...children.values()].filter(child => child.injections !== null);
  const parentNames = new Set([...definitions.flatMap(cell => [cell.name, ...cell.deps]), ...imports.map(value => value.local), ...BUNDLED_BUILTINS]);
  for (const child of derivations) for (const injection of child.injections) {
    const name = typeof injection === 'string' ? injection : injection.name;
    if (!parentNames.has(name)) fail(`Injection source ${name} is not present in the parent module.`);
  }
  const importCells = recoverImports(imports, outputNames);
  const occupied = new Set([...lexicalNames, ...outputNames, ...definitions.flatMap(cell => cell.deps), ...imports.map(value => value.local)]);
  const unique = base => {while (occupied.has(base)) base += '_'; occupied.add(base); return base;};
  const scope = {exported: unique('__opengeoLexicalScope'), binding: unique('__opengeoRootScope')};
  const {cells, names, reactiveGroups, hasClosures} = recoverDefinitions(definitions, source, kit, new Map(imports.map(value => [value.local, value])), lexicalNames, scope.binding);
  const lexicalScope = hasClosures ? scope : null;
  cells.unshift(...importCells); names.unshift(...importCells.map(() => null)); cells.forEach((cell, index) => {cell.id = index + 1;});
  let factoryBody = source.slice(factory.body.start + 1, factory.body.end - 1);
  edits.push({start: first.end, end: first.end, text: '\nmain.builtin("Mutable", legacyMutable);'});
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    const start = edit.start - factory.body.start - 1, end = edit.end - factory.body.start - 1;
    factoryBody = factoryBody.slice(0, start) + edit.text + factoryBody.slice(end);
  }
  const lexicalPrelude = lexicalStatements.map(statement => source.slice(statement.start, statement.end)).join('\n');
  const lexicalBindings = [...constants.keys(), ...[...functions.keys()].filter(name => !used.has(name))];
  const sharedScope = lexicalBindings.length > 0 || hasClosures;
  const prelude = [...importedFactories].map(([binding, modulePath]) => `const ${binding} = modules[${JSON.stringify(modulePath)}].default;`).join('\n')
    + (sharedScope ? '' : '\n' + lexicalPrelude);
  factoryBody = `function define(runtime, observer) {\n"use strict";\n${prelude}\n${factoryBody}\n}`;
  if (sharedScope) factoryBody = `(() => {\n${lexicalPrelude}\nreturn ${factoryBody};\n})()`;
  const lexicalFactoryBody = lexicalScope ? `(() => {\n${lexicalPrelude}\nconst ${scope.binding} = {${[...lexicalNames].map(name => `[${JSON.stringify(name)}]: ${name}`).join(', ')}};\nreturn function define(runtime, observer) { const main = runtime.module(); main.define(${JSON.stringify(scope.exported)}, [], () => ${scope.binding}); return main; };\n})()` : null;
  const customRequire = names.includes('require') || imports.some(item => item.local === 'require');
  const libraryRequests = definitions.flatMap(cell => legacyLibraryRequests(cell, customRequire));
  return {cells, names, reactiveGroups, definitions, imports, derivations, libraryRequests: libraryRequests.slice(0, 100),
    libraryRequestsTruncated: libraryRequests.length > 100, modulePaths: [...new Set([...children.values()].map(child => child.modulePath))], factoryBody, lexicalFactoryBody, lexicalScope, lexicalBindings,
    helperDeclarations: [...[...functions].filter(([name]) => !used.has(name)).map(([, fn]) => fn), ...constants.values()].map(declaration => declaration.type === 'VariableDeclarator' ? declaration.init : declaration),
    attachments: attachments ?? [], provenance: {}, losses: [
    'Compiled JavaScript does not contain the original editor metadata. Cell IDs are regenerated and the supplied title replaces any missing notebook title.',
    'Ordinary cell definitions are reconstructed as Observable JavaScript; dependency aliases and function context use a source-preserving invocation wrapper when necessary.',
    'Canonical viewof pairs and mutable triples become native reactive declarations; generated bridge definitions are folded into their original logical cell.',
    'Selected local notebook imports retain validated child factories, instance-scoped derivations and attachment identities. Remote modules, cycles and noncanonical factory statements are rejected.']};
}

function readInjections(node) {
  if (node?.type !== 'ArrayExpression' || node.elements.length > 128) fail('Notebook injections require a literal array of at most 128 bindings.');
  const targets = new Set();
  const injections = node.elements.map(item => {
    let name = literal(item), alias = name, value = name;
    if (name === null) {
      if (item?.type !== 'ObjectExpression' || item.properties.length !== 2) fail('An injection requires a name or an exact name/alias object.');
      const fields = new Map();
      for (const property of item.properties) {
        const key = property.key?.name ?? literal(property.key), content = literal(property.value);
        if (property.type !== 'Property' || property.kind !== 'init' || property.method || property.computed
          || !['name', 'alias'].includes(key) || content === null || fields.has(key)) fail('Injection bindings must be literal name/alias pairs.');
        fields.set(key, content);
      }
      name = fields.get('name'); alias = fields.get('alias'); value = {name, alias};
    }
    const sourceSpecial = SPECIAL_NAME.exec(name ?? ''), targetSpecial = SPECIAL_NAME.exec(alias ?? '');
    if ((!IDENTIFIER.test(name) && (!sourceSpecial || sourceSpecial[1] === 'initial'))
      || (!IDENTIFIER.test(alias) && (!targetSpecial || targetSpecial[1] === 'initial'))
      || sourceSpecial?.[1] !== targetSpecial?.[1] || targets.has(alias)) fail('Duplicate, conflicting or unsupported injection aliases.');
    targets.add(alias); return value;
  });
  // Validate that reactive injections can be expressed in native Observable
  // syntax without adding or removing a companion value injection.
  injectionSpecifiers(injections);
  return injections;
}

function injectionSpecifiers(injections) {
  const bindings = injections.map(value => typeof value === 'string' ? {name: value, alias: value} : value);
  const byAlias = new Map(bindings.map(value => [value.alias, value])), folded = new Set();
  for (const binding of bindings) {
    const source = SPECIAL_NAME.exec(binding.name), target = SPECIAL_NAME.exec(binding.alias);
    if (!source) continue;
    const companion = byAlias.get(target[2]);
    if (!companion || companion.name !== source[2]) fail('A reactive injection requires its matching value binding.');
    folded.add(companion);
  }
  return bindings.filter(binding => !folded.has(binding)).map(({name, alias}) => {
    const source = SPECIAL_NAME.exec(name), target = SPECIAL_NAME.exec(alias);
    const first = source ? source[2] : name, second = target ? target[2] : alias;
    return `${source ? source[1] + ' ' : ''}${first}${first === second ? '' : ' as ' + second}`;
  });
}

function validateInjectionTargets(derivations, modules) {
  for (const {modulePath, injections} of derivations) {
    const child = modules.find(module => module.path === modulePath);
    for (const injection of injections) {
      const alias = typeof injection === 'string' ? injection : injection.alias;
      if (!child?.injectableNames.includes(alias)) fail(`Injection target ${alias} is missing from ${modulePath}.`);
    }
  }
}

function recoverImports(imports, localNames) {
  const byLocal = new Map(), folded = new Set(), cells = [], instances = new Map();
  for (const entry of imports) {
    if (byLocal.has(entry.local) || localNames.has(entry.local)) fail('Notebook import bindings conflict with local cell names.');
    const imported = SPECIAL_NAME.exec(entry.imported), local = SPECIAL_NAME.exec(entry.local);
    if (!IDENTIFIER.test(entry.imported) && (!imported || imported[1] === 'initial')
      || !IDENTIFIER.test(entry.local) && (!local || local[1] === 'initial')
      || imported?.[1] !== local?.[1]) fail('Unsupported special notebook import alias.');
    byLocal.set(entry.local, entry);
  }
  for (const entry of imports) {
    const special = SPECIAL_NAME.exec(entry.local);
    if (!special) continue;
    const source = SPECIAL_NAME.exec(entry.imported), base = byLocal.get(special[2]);
    if (!base || base.instance !== entry.instance || base.imported !== source[2]) fail('A viewof or mutable import requires its matching value import from the same child instance.');
    const generated = `${special[1]}$${special[2]}`;
    if (localNames.has(generated) || byLocal.has(generated)) fail('An import conflicts with a generated reactive binding.');
    folded.add(base);
  }
  for (const entry of imports) {
    if (folded.has(entry)) continue;
    const special = SPECIAL_NAME.exec(entry.local), imported = SPECIAL_NAME.exec(entry.imported);
    const original = imported ? imported[2] : entry.imported, local = special ? special[2] : entry.local;
    const specifier = `${special ? special[1] + ' ' : ''}${original}${original === local ? '' : ' as ' + local}`;
    if (!instances.has(entry.instance)) instances.set(entry.instance, {...entry, specifiers: []});
    instances.get(entry.instance).specifiers.push(specifier);
  }
  for (const instance of instances.values()) {
    const injections = instance.injections === null ? '' : ` with {${injectionSpecifiers(instance.injections).join(', ')}}`;
    cells.push({id: 0, mode: 'ojs', value: `import {${instance.specifiers.join(', ')}}${injections} from ${JSON.stringify('observable:opengeo-legacy/' + encodeURIComponent(instance.modulePath))}`});
  }
  return cells;
}

function recoverDefinitions(definitions, source, kit, importedBindings = new Map(), lexicalNames = new Set(), scopeBinding) {
  const named = new Map(definitions.filter(cell => cell.name !== null).map(cell => [cell.name, cell]));
  const groups = new Map(), removed = new Set(), declarations = new Map();
  const requireBridge = (cell, deps, kind) => {
    if (!cell || cell.unobserved || JSON.stringify(cell.deps) !== JSON.stringify(deps) || !matchesBridge(cell.fn, kind) || !cell.inline) fail(`Incomplete or noncanonical ${kind} reactive wiring.`);
    removed.add(cell);
  };
  for (const cell of definitions) {
    const match = SPECIAL_NAME.exec(cell.name ?? '');
    if (!match || match[1] === 'mutable') continue;
    const [, kind, name] = match;
    if (groups.has(name)) fail('Reactive declarations have conflicting names.');
    if (kind === 'viewof') {
      if (cell.unobserved || named.has('Generators') || importedBindings.has('Generators')) fail('A viewof bridge requires the standard Generators input behavior.');
      requireBridge(named.get(name), ['Generators', `viewof ${name}`], 'viewof');
      groups.set(name, 'viewof'); declarations.set(cell, cell.name);
    } else {
      if (!cell.unobserved || named.has('Mutable') || importedBindings.has('Mutable')) fail('A mutable bridge requires an unobserved initializer and the standard Mutable behavior.');
      requireBridge(named.get(`mutable ${name}`), ['Mutable', `initial ${name}`], 'mutable');
      requireBridge(named.get(name), [`mutable ${name}`], 'generator');
      groups.set(name, 'mutable'); declarations.set(cell, `mutable ${name}`);
    }
  }
  const runtimeNames = new Set([...groups].map(([name, kind]) => `${kind}$${name}`));
  for (const cell of definitions) {
    if (runtimeNames.has(cell.name)) fail('A cell name conflicts with a generated reactive binding.');
    if (cell.name?.startsWith('mutable ') && !removed.has(cell)) fail('A mutable declaration has no complete initializer and value bridge.');
    if (removed.has(cell)) continue;
    for (const dep of cell.deps) {
      const special = SPECIAL_NAME.exec(dep);
      if (runtimeNames.has(dep) || special && (special[1] === 'initial' || groups.get(special[2]) !== special[1] && !importedBindings.has(dep))) fail('A reactive dependency has no matching native declaration.');
    }
  }
  const cells = [], names = []; let hasClosures = false;
  for (const cell of definitions) {
    if (removed.has(cell)) continue;
    if (cell.inline) fail('Inline functions are supported only for exact generated reactive bridges.');
    const {fn, deps} = cell, name = declarations.get(cell) ?? cell.name;
    if (fn.params.length !== deps.length || fn.params.some(param => !isId(param))) fail('Cell parameters must match their explicit dependency list.');
    if (deps.some((dep, index) => dep === 'FileAttachment' && fn.params[index].name !== dep)) fail('FileAttachment aliases require manual conversion to literal FileAttachment calls.');
    let references;
    try {references = kit.parseJavaScript(source.slice(fn.start, fn.end)).references;}
    catch (error) {fail(`Cell ${name ?? fn.id.name}: ${error.message}`);}
    if (references.some(reference => !lexicalNames.has(reference.name))) fail(`Cell ${name ?? fn.id.name} closes over unavailable module variables; manual conversion is required.`);
    const closure = references.length > 0;
    hasClosures ||= closure;
    rejectModuleContext(fn.body);
    for (const [index, dep] of deps.entries()) if (dep.startsWith('mutable ')) validateMutableUses(fn.body, fn.params[index].name);
    const value = recoverCell(fn, source, name, deps, kit, closure ? scopeBinding : undefined);
    cells.push({id: cells.length + 1, mode: 'ojs', value}); names.push(name);
  }
  return {cells, names, hasClosures, reactiveGroups: [...groups].map(([name, kind]) => ({name, kind, foldedDefinitions: kind === 'viewof' ? 2 : 3}))};
}

function matchesBridge(fn, kind) {
  if (!fn || fn.async || fn.generator || fn.id || fn.params.some(param => !isId(param))) return false;
  const expectedLength = kind === 'generator' ? 1 : 2;
  if (fn.params.length !== expectedLength || new Set(fn.params.map(param => param.name)).size !== expectedLength) return false;
  const body = fn.body.type === 'BlockStatement'
    ? fn.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement' && fn.body.body[0].argument : fn.body;
  if (!body) return false;
  const first = fn.params[0].name, second = fn.params[1]?.name;
  if (kind === 'viewof') return isCall(body, first, 'input', 1) && isId(body.arguments[0], second);
  if (kind === 'mutable') return body.type === 'NewExpression' && isId(body.callee, first) && body.arguments.length === 1 && isId(body.arguments[0], second);
  return isMember(body, first, 'generator');
}

function validateMutableUses(body, alias) {
  function visit(node, parent, grandparent) {
    if (!node || typeof node !== 'object') return;
    if (isId(node, alias)) {
      const propertyKey = parent?.type === 'MemberExpression' && parent.property === node && !parent.computed
        || parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      const valueAccess = parent?.type === 'MemberExpression' && !parent.optional && parent.object === node
        && (parent.computed ? literal(parent.property) === 'value' : isId(parent.property, 'value'));
      if (!propertyKey && !(valueAccess
        && !(grandparent?.type === 'UnaryExpression' && grandparent.operator === 'delete')
        && !(['CallExpression', 'NewExpression'].includes(grandparent?.type) && grandparent.callee === parent)
        && !(grandparent?.type === 'TaggedTemplateExpression' && grandparent.tag === parent))) fail('Mutable dependencies support value reads, assignments and updates only.');
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, node, parent));
      else if (value && typeof value === 'object') visit(value, node, parent);
    }
  }
  visit(body);
}

function recoverCell(fn, source, name, deps, kit, scopeBinding) {
  const prefix = name === null ? '' : `${name} = `;
  const body = fn.body.body;
  const expression = body.length === 1 && body[0].type === 'ReturnStatement' && body[0].argument;
  let value = prefix + (expression ? source.slice(expression.start, expression.end) : source.slice(fn.body.start, fn.body.end));
  const expectedInputs = deps.map(dep => dep.replace(/^(viewof|mutable) /, '$1$'));
  if (scopeBinding) expectedInputs.push(scopeBinding);
  const argumentsSource = deps.map(dep => {
    if (!dep.startsWith('mutable ')) return dep;
    let setter = '__opengeoNextValue';
    while (deps.some(name => name === setter || name.endsWith(' ' + setter))) setter += '_';
    return `{get value() {return ${dep};}, set value(${setter}) {${dep} = ${setter};}}`;
  });
  // Retain unused dependency edges, aliases, arguments, recursion and function
  // context when a direct source body would change the exported definition.
  let direct = !scopeBinding && fn.params.every((param, index) => param.name === deps[index]);
  walk(fn.body, node => {if (isId(node, 'arguments') || isId(node, fn.id.name)) direct = false;});
  if (direct) {
    try {
      const inputs = kit.transpile({id: 1, mode: 'ojs', value}).inputs;
      direct = inputs.length === expectedInputs.length && expectedInputs.every(dep => inputs.includes(dep));
    } catch {direct = false;}
  }
  if (!direct) {
    // ES module exports are strict. Retain strict arguments/parameter behavior
    // when the function becomes an expression in the native cell runtime.
    const strictFunction = source.slice(fn.start, fn.body.start + 1) + '\n"use strict";\n' + source.slice(fn.body.start + 1, fn.end);
    const callable = scopeBinding ? `${scopeBinding}[${JSON.stringify(fn.id.name)}]` : `(${strictFunction})`;
    const invocation = `${callable}.call(undefined${deps.length ? ', ' + argumentsSource.join(', ') : ''})`;
    value = prefix + (fn.generator ? `{ yield* ${fn.async ? 'await ' : ''}${invocation}; }` : `${fn.async ? 'await ' : ''}${invocation}`);
  }
  try {
    const inputs = kit.transpile({id: 1, mode: 'ojs', value}, {resolveImport: name => name}).inputs;
    if (inputs.length !== expectedInputs.length || expectedInputs.some(dep => !inputs.includes(dep))) fail('The recovered cell cannot retain its original dependency graph.');
  }
  catch (error) {fail(`Cell ${name ?? fn.id.name} cannot be represented as Observable JavaScript: ${error.message}`);}
  return value;
}

function legacyLibraryRequests(cell, customRequire = false) {
  const index = cell.deps.indexOf('require');
  if (index < 0) return [];
  const alias = cell.fn.params[index].name, requests = [];
  walk(cell.fn.body, node => {
    if (requests.length >= 101 || node.type !== 'CallExpression'
      || !(isId(node.callee, alias) || node.callee?.type === 'MemberExpression' && isId(node.callee.object, alias))) return;
    const request = isId(node.callee, alias) && node.arguments.length === 1 ? literal(node.arguments[0]) : null;
    const resolved = customRequire || request === null ? null : resolveLegacyLibrary(request);
    requests.push({request, bundled: Boolean(resolved), ...(resolved ? {moduleName: resolved.name, version: resolved.version} : {}),
      message: customRequire ? 'The notebook defines its own require loader; review its dependencies and behavior separately.'
        : resolved ? `${request} resolves to bundled ${resolved.name} ${resolved.version}; no network loader is used.`
        : 'This require request is not supported by the pinned offline libraries; review it in its original environment.'});
  });
  return requests;
}

function readStrings(node) {
  if (node?.type !== 'ArrayExpression' || node.elements.some(node => literal(node) === null)) return null;
  return node.elements.map(literal);
}

function attachmentWiring(node) {
  if (!isCall(node, 'runtime', 'fileAttachments', 1)) return false;
  const callback = node.arguments[0];
  if (callback?.type !== 'ArrowFunctionExpression' || callback.async || callback.params.length !== 1 || !isId(callback.params[0])) return false;
  return isCall(callback.body, 'fileAttachments', 'get', 1) && isId(callback.body.arguments[0], callback.params[0].name);
}

function readAttachments(node, path, attachmentToString = false) {
  if (node?.type !== 'NewExpression' || !isId(node.callee, 'Map') || node.arguments.length !== 1 || node.arguments[0]?.type !== 'ArrayExpression') fail('Attachments must be a literal Map.');
  const rows = node.arguments[0].elements;
  if (rows.length > 128) fail('The export exceeds 128 attachments.');
  const names = new Set();
  return rows.map(row => {
    if (row?.type !== 'ArrayExpression' || row.elements.length !== 2 || literal(row.elements[0]) === null) fail('Invalid attachment map entry.');
    const name = literal(row.elements[0]);
    if (names.has(name)) fail('Duplicate attachment names are ambiguous.');
    localPath('index.html', name); names.add(name);
    let target = row.elements[1], mimeType;
    if (target?.type === 'ObjectExpression') {
      const properties = new Map();
      for (const property of target.properties) {
        const key = property.key?.name ?? literal(property.key);
        if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init' || !['url', 'mimeType', 'toString'].includes(key) || properties.has(key)) fail('Unsupported attachment metadata or accessor.');
        if (key === 'toString' && (!attachmentToString || !isId(property.value, 'toString'))) fail('Unsupported attachment coercion helper.');
        properties.set(key, property.value);
      }
      target = properties.get('url');
      if (properties.has('mimeType')) {
        mimeType = literal(properties.get('mimeType'));
        if (mimeType === null || /[\r\n]/.test(mimeType)) fail('Invalid attachment MIME type.');
      }
    }
    if (target?.type === 'NewExpression' && isId(target.callee, 'URL') && target.arguments.length === 2
      && target.arguments[1]?.type === 'MemberExpression' && !target.arguments[1].computed && isId(target.arguments[1].property, 'url')
      && target.arguments[1].object?.type === 'MetaProperty' && isId(target.arguments[1].object.meta, 'import') && isId(target.arguments[1].object.property, 'meta')) target = target.arguments[0];
    const targetPath = literal(target);
    if (targetPath === null) fail('Attachment URLs must be static strings or new URL(relativePath, import.meta.url).');
    return {name, path: localPath(path, targetPath), ...(mimeType === undefined ? {} : {mimeType})};
  });
}

function localPath(path, name) {
  try {return notebookAttachmentPath(path, name);} catch {fail('Attachment paths must be local, project-relative paths; use a local export and supply its files.');}
}

function walk(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visitor));
    else if (value && typeof value === 'object') walk(value, visitor);
  }
}

function rejectModuleContext(body) {
  walk(body, node => {
    if (['ImportExpression', 'MetaProperty'].includes(node.type)) fail('Cell module imports and import.meta require manual conversion.');
    if (node.type === 'ThisExpression') fail('Cells using this require manual review of runtime context.');
  });
}

function rejectLexicalModuleContext(node) {
  walk(node, item => {
    if (['ImportExpression', 'MetaProperty'].includes(item.type)) fail('Module helpers cannot import modules or use import.meta.');
  });
}

// Only allocation and declaration are allowed at module initialization. Helper
// bodies remain inert here and run only when called in the isolated runtime.
function validateLexicalInitializer(node, available) {
  if (!node) fail('Module constants require inert initializers.');
  if (node.type === 'Literal') return;
  if (isId(node) && available.has(node.name)) return;
  if (['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {rejectLexicalModuleContext(node); return;}
  if (node.type === 'ArrayExpression') {
    for (const element of node.elements) if (element) validateLexicalInitializer(element, available);
    return;
  }
  if (node.type === 'ObjectExpression') {
    for (const property of node.properties) {
      if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') fail('Module constant objects cannot use computed properties, methods, spreads or accessors.');
      validateLexicalInitializer(property.value, available);
    }
    return;
  }
  const primitive = value => value?.type === 'Literal' && !value.regex
    || value?.type === 'UnaryExpression' && ['+', '-', '!', '~', 'void'].includes(value.operator) && primitive(value.argument)
    || value?.type === 'BinaryExpression' && primitive(value.left) && primitive(value.right)
    || value?.type === 'TemplateLiteral' && value.expressions.every(primitive);
  if (primitive(node)) return;
  fail('Module constants require inert literal, object, array or function initializers; calls and side effects require manual conversion.');
}
