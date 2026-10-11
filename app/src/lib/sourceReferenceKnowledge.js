const RELATION = "http://purl.org/dc/terms/relation";
const PROVENANCE = "http://purl.org/dc/terms/provenance";
const MAX_BYTES = 49_152;
export const BACKUP_REFERENCE_METHOD = "User-supplied backup pointer; equivalence and access not verified";
export const SOURCE_EDITION_METHOD = "User-supplied source edition; dataset identity unverified; snapshot dates are separate from release, modification and acquisition dates";

// The existing knowledge schema keeps S3 pointers inside structured claims. Its
// distribution identities and endpoints accept HTTP(S) or URNs, not s3:// URLs.
export function appendBackupReference(document, {uri, objectVersion = "", edition = "", note = "", distributionId}) {
  const pointer = referenceUri(uri, {allowS3:true, allowQuery:false});
  const version = optionalText(objectVersion, 1024, "object version", true);
  const label = optionalText(edition, 200, "edition or snapshot label");
  const description = optionalText(note, 2000, "note");
  if (document.metadata.curated.some(claim => claim.property === RELATION && claim.value?.role === "backup" &&
      sameUri(claim.value.uri, pointer) && (claim.value.objectVersion ?? "") === version)) throw Error("That backup URI and object version are already recorded.");
  if (document.distributions.length >= 32) throw Error("The distribution limit has been reached.");
  if (document.metadata.curated.length >= 64) throw Error("The curated assertion limit has been reached.");
  const id = distributionId ?? `urn:distribution:${crypto.randomUUID()}`;
  if (typeof id !== "string" || !/^urn:\S+$/.test(id) || id.length > 2048 || document.distributions.some(item => item.id === id)) throw Error("Use a distinct distribution URN.");
  const draft = structuredClone(document);
  draft.distributions.push({id, custody:"referenced", ...(new URL(pointer).protocol === "https:" ? {accessUrl:pointer} : {})});
  draft.metadata.curated.push({subject:id, property:RELATION,
    value:{uri:pointer, role:"backup", equivalence:"unknown", access:"unverified",
      ...(version ? {objectVersion:version} : {}), ...(label ? {edition:label} : {}), ...(description ? {note:description} : {})},
    provenance:"curator_asserted", method:BACKUP_REFERENCE_METHOD, timestamp:new Date().toISOString()});
  assertKnowledgeSize(draft);
  return draft;
}

export function appendSourceEdition(document, {label, sourceUri, snapshotAt = "", note = "", seriesUri = ""}) {
  const title = optionalText(label, 200, "source edition label");
  if (!title) throw Error("Enter a source edition label.");
  const source = referenceUri(sourceUri);
  const snapshot = optionalText(snapshotAt, 100, "snapshot date or time");
  if (snapshot && !validSnapshotTime(snapshot)) throw Error("Enter a snapshot date (YYYY-MM-DD) or timestamp with a timezone.");
  const description = optionalText(note, 2000, "note");
  const seriesText = optionalText(seriesUri, 2048, "series URI");
  const series = seriesText ? referenceUri(seriesText) : "";
  if (document.metadata.curated.some(claim => claim.property === PROVENANCE && claim.value?.role === "source_edition" &&
      claim.value.label === title && sameUri(claim.value.sourceUri, source) && (claim.value.snapshotAt ?? "") === snapshot)) throw Error("That source edition is already recorded.");
  if (document.metadata.curated.length >= 64) throw Error("The curated assertion limit has been reached.");
  const draft = structuredClone(document);
  draft.metadata.curated.push({subject:"resource", property:PROVENANCE,
    value:{role:"source_edition", label:title, sourceUri:source, identity:"unverified",
      ...(snapshot ? {snapshotAt:snapshot} : {}), ...(series ? {seriesUri:series} : {}), ...(description ? {note:description} : {})},
    provenance:"curator_asserted", method:SOURCE_EDITION_METHOD, evidence:[source], timestamp:new Date().toISOString()});
  assertKnowledgeSize(draft);
  return draft;
}

export function assertKnowledgeSize(document) {
  const serialized = JSON.stringify(document, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw Error("JSON numbers must be finite.");
    return value;
  });
  if (new TextEncoder().encode(serialized).length > MAX_BYTES) throw Error("The metadata record exceeds 48 KiB. Keep the draft and use a smaller source or a governed metadata record; text is never truncated.");
}

function optionalText(value, maximum, label, preserve = false) {
  if (typeof value !== "string") throw Error(`Enter a text ${label}.`);
  const text = preserve ? value : value.trim();
  if (text.length > maximum) throw Error(`Use a ${label} of up to ${maximum} characters.`);
  return text;
}
function referenceUri(value, {allowS3 = false, allowQuery = true} = {}) {
  const text = optionalText(value, 2048, "URI");
  let url;
  try {url = new URL(text);} catch {throw Error(allowS3 ? "Enter an HTTPS URI or s3://bucket/key backup URI." : "Enter an absolute HTTP(S) source URI or URN.");}
  if (url.username || url.password || url.hash || /\s/.test(text) || sensitiveQuery(url) || (!allowQuery && url.search)) throw Error("Use a URI without credentials, tokens, signed query parameters or fragments. Record an object version separately.");
  if (url.protocol === "https:" && url.hostname) return text;
  if (!allowS3 && (url.protocol === "http:" && url.hostname || url.protocol === "urn:" && text.length > 4)) return text;
  if (allowS3 && url.protocol === "s3:" && !url.port && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(url.hostname) &&
      !/\.\.|\.-|-\./.test(url.hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) && url.pathname.length > 1) return text;
  throw Error(allowS3 ? "Enter an HTTPS URI or s3://bucket/key backup URI." : "Enter an absolute HTTP(S) source URI or URN.");
}
function sensitiveQuery(url) {
  return [...url.searchParams.keys()].some(key => /(?:token|credential|signature|password|secret|authorization|api[-_]?key|access[-_]?key|^key$|^sig$|^auth$|^jwt$|^x-amz-|^x-goog-)/i.test(key));
}
function sameUri(left, right) {
  try {return new URL(left).href === new URL(right).href;} catch {return false;}
}
function validSnapshotTime(value) {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  if (!day || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0,10) !== day) return false;
  return value === day || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
}
