const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ["queued", "running", "completed", "failed", "cancelled"];
const fail = () => {const error = new Error("Invalid external database response"); error.code = "invalid_api_response"; throw error;};
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : fail();
const string = (value, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail();
const id = value => UUID.test(string(value, 36)) ? value.toLowerCase() : fail();
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fail();
const bool = value => typeof value === "boolean" ? value : fail();
const member = (value, values) => values.includes(value) ? value : fail();
const nullable = (value, parse) => value === null ? null : parse(value);
const array = (value, parse, max = 100) => Array.isArray(value) && value.length <= max ? value.map(parse) : fail();
const code = value => nullable(value, item => /^[a-z][a-z0-9_]{0,99}$/.test(string(item, 100)) ? item : fail());
const sha = value => /^[a-f0-9]{64}$/.test(string(value, 64)) ? value : fail();
const time = value => nullable(value, item => Number.isFinite(Date.parse(string(item, 50))) ? item : fail());
const identifier = value => new TextEncoder().encode(string(value, 63)).length <= 63 ? value : fail();
const scopeMatch = (actual, expected) => expected == null || actual === expected ? actual : fail();

export function parseExternalDatabaseConnection(value, projectId, connectionId = null) {
  const row = object(value);
  if (row.provider !== "postgresql" || row.read_only !== true || row.tls_mode !== "verify_full" || row.network_mode !== "public_internet"
    || ["credentials", "password", "username", "secret_reference", "secret_arn"].some(key => Object.hasOwn(row, key))) fail();
  return {
    id: scopeMatch(id(row.connection_id), connectionId), projectId: scopeMatch(id(row.project_id), projectId),
    name: string(row.display_name), host: string(row.endpoint_host, 253), port: integer(row.endpoint_port, 1, 65535),
    database: identifier(row.database_name), schemas: array(row.allowed_schemas, identifier, 16),
    revision: integer(row.current_revision_number, 1),
    status: member(row.status, ["configuration_valid", "network_reachable", "credentials_verified", "catalog_verified", "degraded", "disabled", "revoked"]),
    verificationAvailable: bool(row.verification_available), manage: bool(object(row.capabilities).manage),
    lastVerifiedAt: time(row.last_verified_at), errorCode: code(row.sanitized_error_code)
  };
}

function parseJob(value, connectionId, verification = false) {
  const row = object(value);
  return {id: id(row[verification ? "verification_id" : "discovery_id"]),
    connectionId: scopeMatch(id(row.connection_id), connectionId), revision: integer(row.connection_revision_number, 1),
    state: member(row.state, verification ? ["queued", "running", "succeeded", "failed", "cancelled"] : STATES),
    attempts: integer(row.attempt_count), errorCode: code(row.sanitized_error_code),
    requestedBy: id(row.requested_by), createdAt: time(row.created_at), startedAt: time(row.started_at), finishedAt: time(row.finished_at),
    ...(verification ? {networkReachable: bool(row.network_reachable), tlsVerified: bool(row.tls_verified),
      credentialsVerified: bool(row.credentials_verified), postgisVerified: bool(row.postgis_verified)}
      : {relationCount: integer(row.relation_count, 0, 100), truncated: bool(row.truncated)})};
}

export const parseExternalDatabaseDiscovery = (value, connectionId) => parseJob(value, connectionId);
export const parseExternalDatabaseVerification = (value, connectionId) => parseJob(value, connectionId, true);

function unique(items, key = "id") {if (new Set(items.map(item => item[key])).size !== items.length) fail(); return items;}

export function parseExternalDatabaseRelations(value, after = 0) {
  const row = object(value); let previous = integer(after, 0, 100);
  const items = array(row.items, raw => {
    const entry = object(raw), ordinal = integer(entry.ordinal, previous + 1, 100); previous = ordinal;
    const descriptor = object(entry.descriptor);
    const columns = unique(array(descriptor.columns, rawColumn => {
      const column = object(rawColumn), geometry = column.geometry === null ? null : object(column.geometry);
      return {name: identifier(column.name), typeSchema: identifier(column.type_schema), typeName: identifier(column.type_name),
        notNull: bool(column.not_null), uniqueKey: bool(column.unique_key), primaryKey: bool(column.primary_key),
        geometry: geometry === null ? null : {type: nullable(geometry.geometry_type, item => string(item, 40)),
          srid: nullable(geometry.srid, item => integer(item, 0, 998999)), postgisSchema: identifier(geometry.postgis_schema)}};
    }, 256), "name");
    const stableKey = nullable(descriptor.stable_key, identifier);
    if (stableKey !== null && !columns.some(column => column.name === stableKey && column.uniqueKey && column.notNull)) fail();
    return {ordinal, schema: identifier(descriptor.schema), name: identifier(descriptor.name),
      kind: member(descriptor.kind, ["r", "v", "m", "p", "f"]), columns, stableKey,
      unsupportedReasons: array(descriptor.unsupported_reasons, code, 20), fingerprint: sha(descriptor.schema_fingerprint_sha256)};
  }, 10);
  const nextOrdinal = nullable(row.next_ordinal, item => integer(item, after + 1, 100));
  if (nextOrdinal !== null && (!items.length || nextOrdinal !== previous)) fail();
  return {items, nextOrdinal};
}

// Reuse the adapter's account/sign-in snapshot and its final dispatch checks.
export async function captureExternalDatabaseScope(client, accountId = null) {
  if (typeof client.tokenProvider !== "function" || typeof client.organizationProvider !== "function"
    || typeof client.assertCollectionContext !== "function") throw new Error("account_context_unavailable");
  const context = Object.freeze({tokenProvider: client.tokenProvider, organizationProvider: client.organizationProvider,
    baseUrl: client.baseUrl, token: await client.tokenProvider(), organization: id(await client.organizationProvider())});
  if (accountId !== null && context.organization !== id(accountId)) throw new Error("account_context_changed");
  await client.assertCollectionContext(context);
  return context;
}

export function externalDatabaseCatalogApi(client, projectId) {
  const project = id(projectId), base = `/projects/${project}/connections`;
  const connection = connectionId => `${base}/${id(connectionId)}`;
  const discoveries = connectionId => `${connection(connectionId)}/catalog-discoveries`;
  async function request(path, {context, signal, ...options} = {}) {
    const scope = context ?? await captureExternalDatabaseScope(client);
    await client.assertCollectionContext(scope);
    const value = await client.request(path, {...options, signal, ...client.collectionRequestOptions(scope.organization, scope)});
    await client.assertCollectionContext(scope);
    return value;
  }
  return {
    connections: async options => unique(array(await request(base, options), value => parseExternalDatabaseConnection(value, project), 100)),
    connection: async (connectionId, options) => parseExternalDatabaseConnection(await request(connection(connectionId), options), project, id(connectionId)),
    create: async (draft, options) => parseExternalDatabaseConnection(await request(base, {...options, method: "POST", body: {
      provider: "postgresql", display_name: draft.name, endpoint_host: draft.host, endpoint_port: draft.port,
      database_name: draft.database, allowed_schemas: draft.schemas, read_only: true, tls_mode: "verify_full", network_mode: "public_internet",
      credentials: {username: draft.username, password: draft.password}
    }}), project),
    verifications: async (connectionId, options) => unique(array(await request(`${connection(connectionId)}/verifications`, options), value => parseExternalDatabaseVerification(value, id(connectionId)))),
    verify: async (connectionId, options) => parseExternalDatabaseVerification(object(await request(`${connection(connectionId)}/verifications`, {...options, method: "POST"})).verification, id(connectionId)),
    cancelVerification: async (connectionId, jobId, options) => {const row = parseExternalDatabaseVerification(await request(`${connection(connectionId)}/verifications/${id(jobId)}`, {...options, method: "DELETE"}), id(connectionId)); scopeMatch(row.id, id(jobId)); return row;},
    discoveries: async (connectionId, options) => {const row = object(await request(discoveries(connectionId), options)); return {
      available: bool(row.available), items: unique(array(row.items, value => parseExternalDatabaseDiscovery(value, id(connectionId))))};},
    discover: async (connectionId, revision, requestKey, options) => parseExternalDatabaseDiscovery(await request(discoveries(connectionId), {
      ...options, method: "POST", body: {expected_revision: integer(revision, 1), request_key: id(requestKey)}
    }), id(connectionId)),
    discovery: async (connectionId, jobId, options) => {const row = parseExternalDatabaseDiscovery(await request(`${discoveries(connectionId)}/${id(jobId)}`, options), id(connectionId)); scopeMatch(row.id, id(jobId)); return row;},
    cancelDiscovery: async (connectionId, jobId, options) => {const row = parseExternalDatabaseDiscovery(await request(`${discoveries(connectionId)}/${id(jobId)}`, {...options, method: "DELETE"}), id(connectionId)); scopeMatch(row.id, id(jobId)); return row;},
    relations: async (connectionId, jobId, after = 0, options) => parseExternalDatabaseRelations(await request(`${discoveries(connectionId)}/${id(jobId)}/relations?after=${integer(after, 0, 100)}`, options), after)
  };
}
