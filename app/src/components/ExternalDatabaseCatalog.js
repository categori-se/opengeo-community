import {captureExternalDatabaseScope} from "../lib/externalDatabaseCatalog.js";
import {layerHref} from "../lib/applicationRoutes.js";

const active = job => job && ["queued", "running"].includes(job.state);
const usable = connection => connection && !["disabled", "revoked"].includes(connection.status);
const verified = connection => connection?.status === "credentials_verified" && connection.lastVerifiedAt !== null;

export function ExternalDatabaseCatalog({state}) {
  const {adapter} = state, projectId = state.project.id, accountId = state.organization.id;
  const api = adapter.externalDatabaseCatalog(projectId);
  const root = node("details", "", "project-service-disclosure external-database-catalog");
  const feedback = node("p", "Load connections to inspect this workspace’s database references.", "project-resource-feedback");
  feedback.setAttribute("role", "status");
  const load = button("Load database connections", () => void loadConnections());
  const selection = node("select"); selection.setAttribute("aria-label", "Database connection");
  const inspect = button("Check connection status", () => void inspectConnection());
  const facts = node("div"), operations = node("div"), results = node("div");
  const owner = state.project.callerRole === "owner" || state.organization.callerRole === "admin";
  let disposed = false, busy = false, generation = 0, scope = null, reader = null, selectedId = "", loaded = false, pendingCreation = false;
  let records = [], selected = null, verification = null, catalog = null, job = null, nextOrdinal = null;
  const requestKeys = new Map();
  let connected = false;
  const Observer = root.ownerDocument.defaultView?.MutationObserver;
  const observer = Observer ? new Observer(() => {
    if (root.isConnected) connected = true;
    else if (connected) root.dispose();
  }) : null;
  observer?.observe(root.ownerDocument.body, {childList: true, subtree: true});
  root.append(node("summary", "External PostgreSQL / PostGIS"),
    node("p", "Connect a read-only database, verify access and deliberately discover its tables and views. Verified TLS is required. Discovery reads bounded metadata; source data stays in its database."),
    load, label("Database connection", selection), inspect, facts, operations, results, feedback);
  let creation = null;
  if (owner) {creation = connectionForm(); root.append(creation.form);}
  root.dispose = () => {
    disposed = true; generation++; reader?.abort(); observer?.disconnect();
    if (creation) {creation.username.value = ""; creation.password.value = "";}
    records = []; selected = verification = catalog = job = scope = null; requestKeys.clear();
    facts.replaceChildren(); operations.replaceChildren(); results.replaceChildren(); lock();
  };
  selection.addEventListener("change", () => {
    if (busy) {selection.value = selectedId; return;}
    reader?.abort(); generation++; selectedId = selection.value;
    selected = verification = catalog = job = null; nextOrdinal = null;
    facts.replaceChildren(); operations.replaceChildren(); results.replaceChildren();
    feedback.textContent = "Check the selected connection’s status before requesting verification or discovery."; lock();
  });
  lock();
  return root;

  function lock() {
    for (const control of root.querySelectorAll("button,input,select")) control.disabled = disposed || busy;
    selection.disabled ||= !loaded || !records.length;
    inspect.disabled ||= !selectedId;
    if (creation) for (const control of creation.form.elements) control.disabled ||= !loaded || pendingCreation;
  }
  async function guard(ticket) {
    if (disposed || !root.isConnected || ticket !== generation || state.project.id !== projectId || state.organization.id !== accountId) throw Error("database_scope_changed");
    if (scope) await adapter.assertCollectionContext(scope);
    if (disposed || !root.isConnected || ticket !== generation) throw Error("database_scope_changed");
  }
  async function run(message, operation) {
    if (disposed || busy) return;
    busy = true; lock(); reader?.abort(); reader = new AbortController();
    const ticket = ++generation, options = {signal: reader.signal};
    feedback.textContent = message;
    try {
      scope ??= await captureExternalDatabaseScope(adapter, accountId);
      options.context = scope; await guard(ticket);
      await operation(options, async () => guard(ticket));
    } catch (error) {
      if (!disposed && ticket === generation) feedback.textContent = pendingCreation
        ? "The connection creation outcome is unknown. Reload database connections to check the inventory before creating another connection."
        : error?.status === 409
          ? "The connection or selected account changed. Reload connections before continuing."
          : "The operation could not be confirmed. Check connection status before retrying. Retries retain the same request identity.";
    } finally {
      busy = false; if (!disposed && ticket === generation) {lock(); lockActions();}
    }
  }
  function options() {
    selection.replaceChildren(option("", "Choose a database connection"));
    for (const record of records) selection.append(option(record.id, record.name));
    selection.value = selectedId;
  }
  function showFacts() {
    facts.replaceChildren(node("h3", selected.name),
      node("p", `${selected.host}:${selected.port} / ${selected.database} · Schemas: ${selected.schemas.join(", ")}`),
      node("p", `${selected.status.replaceAll("_", " ")} · Connection revision ${selected.revision} · Read-only · TLS certificate verification required`));
    if (selected.lastVerifiedAt) facts.append(node("p", `Last verification: ${selected.lastVerifiedAt}`));
    if (selected.errorCode) facts.append(node("p", `Connection status: ${selected.errorCode.replaceAll("_", " ")}`));
  }
  function showOperations() {
    operations.replaceChildren();
    if (verification) operations.append(node("p", `Verification: ${verification.state} · revision ${verification.revision}${verification.errorCode ? ` · ${verification.errorCode.replaceAll("_", " ")}` : ""}`));
    if (selected.manage && usable(selected)) {
      const verify = button("Verify database connection", () => void verifyConnection()); verify.dataset.operation = "verify";
      operations.append(verify);
      if (!selected.verificationAvailable) operations.append(node("p", "Connection verification is unavailable in this environment."));
      if (active(verification)) {const cancel = button("Cancel verification", () => void cancelVerification()); cancel.dataset.operation = "cancel-verification"; operations.append(cancel);}
      const discover = button("Discover database catalog", () => void discoverCatalog()); discover.dataset.operation = "discover"; operations.append(discover);
    }
    if (!verified(selected)) operations.append(node("p", `Verify the database connection first. Current verification status: ${selected.status.replaceAll("_", " ")}${selected.lastVerifiedAt === null ? "; no completed credential verification is recorded" : ""}.`));
    if (!catalog.available) operations.append(node("p", "Catalog discovery is unavailable in this environment. Saved discovery history remains readable."));
    if (catalog.items.length) {
      const jobs = node("select"); jobs.setAttribute("aria-label", "Catalog discovery");
      jobs.append(option("", "Choose a discovery"));
      for (const item of catalog.items) jobs.append(option(item.id, `${item.createdAt} · ${item.state} · revision ${item.revision}`));
      jobs.value = job?.id ?? "";
      jobs.addEventListener("change", () => {
        if (busy) {jobs.value = job?.id ?? ""; return;}
        job = catalog.items.find(item => item.id === jobs.value) ?? null;
        results.replaceChildren(); nextOrdinal = null; showOperations(); showJob(); lockActions();
      });
      operations.append(label("Catalog discovery", jobs));
    }
    const check = button("Check selected discovery", () => void checkDiscovery()); check.dataset.operation = "check-discovery"; operations.append(check);
    if (selected.manage && active(job)) {const cancel = button("Cancel catalog discovery", () => void cancelDiscovery()); cancel.dataset.operation = "cancel-discovery"; operations.append(cancel);}
    lockActions();
  }
  function lockActions() {
    for (const control of operations.querySelectorAll("button")) {
      const operation = control.dataset.operation;
      control.disabled = disposed || busy || (operation === "verify" && (!selected?.verificationAvailable || active(verification)))
        || (operation === "discover" && (!verified(selected) || !catalog?.available || catalog.items.some(item => active(item) && item.revision === selected.revision)))
        || (operation === "check-discovery" && !job);
    }
    const more = results.querySelector('[data-operation="next-relations"]'); if (more) more.disabled = disposed || busy || nextOrdinal === null;
    for (const control of results.querySelectorAll('[data-registration-control]')) control.disabled = disposed || busy || !selected?.manage || job?.revision !== selected?.revision;
  }
  async function currentConnection(requestOptions, current) {
    const record = await api.connection(selectedId, requestOptions); await current();
    if (!selected || record.revision !== selected.revision || !record.manage || !usable(record)) {
      throw Object.assign(Error("connection_changed"), {status: 409});
    }
    selected = record; return record;
  }
  function loadConnections() {
    return run("Loading database connections…", async (requestOptions, current) => {
      const value = await api.connections(requestOptions); await current();
      records = value; selectedId = ""; selected = verification = catalog = job = null;
      if (pendingCreation && creation) {creation.username.value = ""; creation.password.value = "";}
      pendingCreation = false;
      loaded = true; options(); facts.replaceChildren(); operations.replaceChildren(); results.replaceChildren();
      load.textContent = "Reload database connections";
      feedback.textContent = `${records.length} database connections loaded. Choose one to check its status.`;
    });
  }
  function inspectConnection() {
    if (!selectedId) return;
    return run("Checking connection and saved job status…", async (requestOptions, current) => {
      const [record, attempts, history] = await Promise.all([api.connection(selectedId, requestOptions), api.verifications(selectedId, requestOptions), api.discoveries(selectedId, requestOptions)]);
      await current();
      selected = record; verification = attempts[0] ?? null; catalog = history;
      job = history.items.find(item => item.id === job?.id) ?? history.items[0] ?? null;
      results.replaceChildren(); nextOrdinal = null; showFacts(); showOperations(); showJob();
      feedback.textContent = "Saved status loaded. Verification and discovery run only when explicitly requested.";
    });
  }
  function verifyConnection() {
    if (!selected?.manage || !selected.verificationAvailable || active(verification)) return;
    return run("Requesting database verification…", async (requestOptions, current) => {
      await currentConnection(requestOptions, current);
      const value = await api.verify(selectedId, requestOptions); await current();
      if (value.revision !== selected.revision) throw Error("verification_revision_changed");
      verification = value; showOperations(); feedback.textContent = "Verification requested. Check connection status for its outcome.";
    });
  }
  function cancelVerification() {
    if (!selected?.manage || !active(verification)) return;
    return run("Cancelling database verification…", async (requestOptions, current) => {
      await currentConnection(requestOptions, current);
      const value = await api.cancelVerification(selectedId, verification.id, requestOptions); await current();
      verification = value; showOperations(); feedback.textContent = "Verification cancellation recorded.";
    });
  }
  function retainJob(value) {
    job = value; catalog.items = [value, ...catalog.items.filter(item => item.id !== value.id)];
    results.replaceChildren(); nextOrdinal = null; showOperations(); showJob();
  }
  function discoverCatalog() {
    if (!selected?.manage || !verified(selected) || !catalog?.available || catalog.items.some(item => active(item) && item.revision === selected.revision)) return;
    return run("Requesting bounded database catalog discovery…", async (requestOptions, current) => {
      await currentConnection(requestOptions, current);
      if (!verified(selected)) throw Object.assign(Error("connection_verification_required"), {status: 409});
      const key = `${selectedId}:${selected.revision}`;
      if (!requestKeys.has(key)) requestKeys.set(key, globalThis.crypto.randomUUID());
      const value = await api.discover(selectedId, selected.revision, requestKeys.get(key), requestOptions); await current();
      if (value.revision !== selected.revision) throw Error("discovery_revision_changed");
      retainJob(value); requestKeys.delete(key);
      feedback.textContent = "Catalog discovery requested. Check the selected discovery for its result.";
    });
  }
  function showJob() {
    results.replaceChildren(); nextOrdinal = null;
    if (!job) return;
    results.append(node("p", `Discovery: ${job.state} · revision ${job.revision} · ${job.relationCount} relations${job.truncated ? " · Catalog limit reached; additional relations were omitted" : ""}${job.errorCode ? ` · ${job.errorCode.replaceAll("_", " ")}` : ""}`));
    if (job.revision !== selected.revision) results.append(node("p", "This discovery describes an earlier connection revision. Request a new discovery for the current configuration."));
    if (job.state === "completed") results.append(node("p", "Check selected discovery to load its first ten relation descriptions. Register a supported relation as a Catalog Layer, then open its temporary map from the Layer record."));
  }
  function checkDiscovery() {
    if (!job) return;
    return run("Checking saved discovery status…", async (requestOptions, current) => {
      const value = await api.discovery(selectedId, job.id, requestOptions); await current();
      job = value; catalog.items = catalog.items.map(item => item.id === value.id ? value : item); showOperations(); showJob();
      if (job.state === "completed") await loadRelations(0, requestOptions, current);
      feedback.textContent = job.state === "completed" ? "Catalog metadata loaded. No feature rows were read or Layers created." : "Saved discovery status loaded. Check again when ready.";
    });
  }
  function cancelDiscovery() {
    if (!selected?.manage || !active(job)) return;
    return run("Cancelling catalog discovery…", async (requestOptions, current) => {
      await currentConnection(requestOptions, current);
      const value = await api.cancelDiscovery(selectedId, job.id, requestOptions); await current();
      retainJob(value); feedback.textContent = "Catalog discovery cancellation recorded.";
    });
  }
  async function loadRelations(after, requestOptions, current) {
    const value = await api.relations(selectedId, job.id, after, requestOptions); await current();
    const previous = results.querySelector(".database-relation-page");
    const page = relationTable(value.items, registrationControls); page.className = "database-relation-page";
    const more = button("Next ten relations", () => void run("Loading the next relation descriptions…", async (nextOptions, stillCurrent) => {
      await loadRelations(nextOrdinal, nextOptions, stillCurrent); feedback.textContent = "Next catalog page loaded. No feature rows were read.";
    }));
    more.dataset.operation = "next-relations";
    nextOrdinal = value.nextOrdinal; more.hidden = nextOrdinal === null; more.disabled = busy;
    page.append(node("p", value.items.length ? `Showing relations ${value.items[0].ordinal}–${value.items.at(-1).ordinal} of ${job.relationCount}.` : "No visible relations were returned."), more);
    if (previous) previous.replaceWith(page); else results.append(page);
  }
  function registrationControls(item) {
    if (!selected?.manage || job?.revision !== selected.revision || typeof adapter.postgisLayers !== "function") return null;
    const geometries = item.columns.filter(column => column.geometry);
    const eligible = item.kind === "r" && item.columns.length <= 64 && item.stableKey && !item.unsupportedReasons.length
      && geometries.length === 1 && geometries[0].geometry.srid === 4326
      && /^(?:POINT|MULTIPOINT|LINESTRING|MULTILINESTRING|POLYGON|MULTIPOLYGON)$/i.test(geometries[0].geometry.type ?? "")
      && item.columns.filter(column => !column.geometry).every(column => column.typeSchema === "pg_catalog"
        && ["bool", "int2", "int4", "int8", "numeric", "float4", "float8", "text", "varchar", "bpchar", "uuid", "date", "timestamp", "timestamptz"].includes(column.typeName));
    if (!eligible) return node("p", "Live preview requires a supported table, one 2D WGS 84 geometry and a stable unique key.");
    const form = node("form"), name = input("text", 200), geometry = node("select"), submit = button("Register Catalog Layer");
    name.value = `${item.schema}.${item.name}`; submit.type = "submit";
    geometry.append(option(geometries[0].name, geometries[0].name));
    for (const control of [name, geometry, submit]) control.dataset.registrationControl = "true";
    form.append(label(`Layer name for ${item.schema}.${item.name}`, name), label(`Geometry for ${item.schema}.${item.name}`, geometry), submit);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (busy || !form.reportValidity()) return;
      const discoveryId = job.id, connectionId = selectedId, revision = selected.revision;
      const draft = {name: name.value.trim(), geometryColumn: geometry.value, connectionRevision: revision, fingerprint: item.fingerprint};
      const key = JSON.stringify(["register", connectionId, discoveryId, item.ordinal, draft]);
      if (!requestKeys.has(key)) requestKeys.set(key, globalThis.crypto.randomUUID());
      void run("Registering the selected relation…", async (requestOptions, current) => {
        await currentConnection(requestOptions, current);
        if (job.id !== discoveryId || selected.revision !== revision) throw Object.assign(Error("connection_changed"), {status: 409});
        const saved = await adapter.postgisLayers().register(projectId, connectionId, discoveryId, item.ordinal, draft,
          {...requestOptions, requestKey: requestKeys.get(key)});
        await current(); requestKeys.delete(key);
        const open = node("a", "Open Catalog Layer", "platform-button secondary");
        open.href = layerHref(saved.datasetId, {adapterKind: adapter.kind});
        form.replaceChildren(node("p", `Catalog Layer ${saved.created ? "registered" : "reused"} · source revision ${saved.sourceVersion}. Data remains in its database.`), open);
        feedback.textContent = "Catalog Layer saved. Open its record to preview a bounded area; registration did not copy source features.";
      });
    });
    return form;
  }
  function connectionForm() {
    const form = node("form", "", "project-resource-editor-panel");
    const name = input("text", 200), host = input("text", 253), port = input("number"), database = input("text", 63), schemas = input("text", 1024);
    const username = input("text", 128), password = input("password", 1024);
    username.autocomplete = "off"; password.autocomplete = "new-password";
    port.value = "5432"; port.min = "1"; port.max = "65535"; schemas.value = "public";
    host.placeholder = "database.example.org"; database.pattern = "[A-Za-z_][A-Za-z0-9_$]{0,62}";
    const submit = button("Create read-only database connection"); submit.type = "submit";
    form.append(node("h3", "Create database connection"),
      label("Connection name", name), label("Database host", host), label("Database port", port), label("Database name", database),
      label("Allowed schemas (comma-separated)", schemas), label("Database username", username), label("Database password", password),
      node("p", "Use dedicated read-only credentials for a public DNS host. Credentials are sent only to the authenticated connection service and are never included in saved connection records. This action does not verify or discover the database."), submit);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (busy || !loaded || pendingCreation || !form.reportValidity()) return;
      const allowedSchemas = schemas.value.split(",").map(value => value.trim());
      if (!allowedSchemas.length || allowedSchemas.length > 16 || new Set(allowedSchemas).size !== allowedSchemas.length
        || allowedSchemas.some(value => !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value) || value.startsWith("pg_") || value === "information_schema")) {
        feedback.textContent = "Enter one to sixteen distinct schema names. System schemas cannot be discovered."; return;
      }
      void run("Creating read-only database connection…", async (requestOptions, current) => {
        pendingCreation = true;
        const value = await api.create({name: name.value.trim(), host: host.value.trim(), port: Number(port.value),
          database: database.value.trim(), schemas: allowedSchemas, username: username.value, password: password.value}, requestOptions);
        pendingCreation = false; password.value = ""; username.value = ""; await current();
        records.push(value); selectedId = value.id; options(); selected = verification = catalog = job = null;
        facts.replaceChildren(); operations.replaceChildren(); results.replaceChildren();
        feedback.textContent = "Database connection created. Credentials cleared. Check its status before requesting verification or discovery.";
      });
    });
    return {form, username, password};
  }
}

function relationTable(items, controls = () => null) {
  const container = node("div"); container.style.overflowX = "auto"; container.tabIndex = 0;
  container.setAttribute("aria-label", "Discovered relation metadata");
  const table = node("table"), head = node("thead"), row = node("tr"), body = node("tbody");
  for (const title of ["Record", "Schema", "Relation", "Kind / columns", "Geometry / SRID", "Stable key", "Limitations"]) {const cell = node("th", title); cell.scope = "col"; row.append(cell);}
  head.append(row); table.append(head, body);
  for (const item of items) {
    const row = node("tr"), geometries = item.columns.filter(column => column.geometry).map(column => `${column.name}: ${column.geometry.type ?? "untyped geometry"} / ${column.geometry.srid ?? "unknown SRID"}`);
    for (const value of [item.ordinal, item.schema, item.name, `${({r: "Table", v: "View", m: "Materialized view", p: "Partitioned table", f: "Foreign table"})[item.kind]} / ${item.columns.length}`,
      geometries.join("; ") || "No geometry", item.stableKey ?? "Unavailable", item.unsupportedReasons.map(value => value.replaceAll("_", " ")).join("; ") || "No metadata limitations reported"]) row.append(node("td", String(value)));
    body.append(row);
  }
  table.append(node("caption", "Discovered relation metadata; no source records have been copied.")); container.append(table);
  for (const item of items) {const control = controls(item); if (control) container.append(control);}
  return container;
}
function node(tag, value = "", className = "") {const element = document.createElement(tag); element.textContent = value; element.className = className; return element;}
function button(value, action) {const element = node("button", value, "platform-button secondary"); element.type = "button"; if (action) element.addEventListener("click", action); return element;}
function option(value, title) {const element = node("option", title); element.value = value; return element;}
function label(value, control) {const element = node("label", value); control.setAttribute("aria-label", value); element.append(control); return element;}
function input(type, maxLength) {const element = node("input"); element.type = type; element.required = true; if (maxLength) element.maxLength = maxLength; return element;}
