import {createCollectionDefinition, collectionEntryLimit} from "@categori/workspace-contracts/collections";
import {createResourceReference} from "@categori/workspace-contracts/interoperability";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)));
function uuid(value, label) {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value.toLowerCase();
}

/** A typed owner is independent of creator, audience and member permissions. */
export function collectionOwnerFromApi(record, {organizationId = null} = {}) {
  if (!plain(record)) throw new TypeError("Expected Collection owner metadata");
  const account = organizationId == null ? null : uuid(organizationId, "Collection account");
  if (!Object.hasOwn(record, "owner")) {
    return Object.hasOwn(record, "owner_user_id")
      ? {principal_type: "user", principal_id: uuid(record.owner_user_id, "Collection owner")}
      : undefined;
  }
  const owner = record.owner;
  if (!plain(owner) || Object.keys(owner).length !== 2 ||
      !Object.hasOwn(owner, "principal_type") || !Object.hasOwn(owner, "principal_id") ||
      !["user", "team", "organization"].includes(owner.principal_type)) {
    throw new TypeError("Invalid typed Collection owner");
  }
  const identity = uuid(owner.principal_id, "Collection owner");
  if (Object.hasOwn(record, "owner_user_id")) {
    if (owner.principal_type === "user") {
      if (uuid(record.owner_user_id, "Collection owner") !== identity) throw new TypeError("Collection owner identities disagree");
    } else if (record.owner_user_id !== null) throw new TypeError("Collection owner identities disagree");
  }
  if (owner.principal_type === "organization" && account !== null && identity !== account) {
    throw new TypeError("Collection Organization owner must match its account");
  }
  return {principal_type: owner.principal_type, principal_id: identity};
}

function authorityFor(baseUrl, locationHref) {
  const authority = new URL(baseUrl, locationHref);
  if (!["https:", "http:"].includes(authority.protocol) || authority.username || authority.password ||
      authority.search || authority.hash || /\s/.test(baseUrl)) {
    throw new TypeError("Collection authority requires a credential-free API URL");
  }
  return authority.href.replace(/\/$/, "");
}

/** Adapt saved metadata only; neither its audience nor its references grant access. */
export function collectionDefinitionFromApi(record, {baseUrl, organizationId, locationHref = globalThis.location?.href} = {}) {
  if (!plain(record) || !Array.isArray(record.members) || record.members.length > collectionEntryLimit) {
    throw new TypeError("Expected bounded Collection authoring metadata");
  }
  uuid(record.id, "Collection identity");
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new TypeError("Invalid Collection revision");
  const visibility = record.visibility ?? "private";
  if (!["private", "account", "public"].includes(visibility)) throw new TypeError("Unsupported Collection visibility");
  const audienceKind = {private: "restricted", account: "scope", public: "public"}[visibility];
  // Historical responses may omit these fields. Validate supplied identities even
  // when another omission prevents construction; never invent an owner or scope.
  const selectedOrganization = organizationId == null ? null : uuid(organizationId, "Collection account");
  const owner = collectionOwnerFromApi(record, {organizationId: selectedOrganization});
  let complete = owner !== undefined && selectedOrganization !== null;
  for (const member of record.members) {
    if (!plain(member) || ![true, false].includes(member.available)) throw new TypeError("Invalid Collection member availability");
    uuid(member.entry_id, "Collection entry");
    if ((member.available || Object.hasOwn(member, "kind")) && !["project", "publication"].includes(member.kind)) {
      throw new TypeError("Invalid Collection member kind");
    }
    if (Object.hasOwn(member, "workspace_id")) uuid(member.workspace_id, "Collection member workspace");
    if (member.available) uuid(member.target_id, "Collection member");
    if (member.available && !Object.hasOwn(member, "workspace_id")) complete = false;
  }
  if (!complete) return undefined;

  const authority = authorityFor(baseUrl, locationHref);
  const workspaceId = `account:${selectedOrganization}`;
  const reference = (resourceId, resourceType, scope = workspaceId) =>
    createResourceReference({authority, resourceId, resourceType, workspaceId: scope});
  return createCollectionDefinition({
    reference: reference(uuid(record.id, "Collection identity"), "collection"),
    recordRevision: record.revision,
    owner: {authority, ...owner},
    contexts: [],
    title: record.title,
    description: record.description,
    audience: {kind: audienceKind, scope: audienceKind === "scope" ? reference(workspaceId, "workspace") : null},
    entries: record.members.map(member => ({
      entry_id: uuid(member.entry_id, "Collection entry"),
      reference: member.available === false ? null : reference(uuid(member.target_id, "Collection member"),
        member.kind, `project:${uuid(member.workspace_id, "Collection member workspace")}`)
    }))
  });
}
