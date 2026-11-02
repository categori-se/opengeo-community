const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const IDENTITY = new RegExp(`^urn:opengeo:dataset:(${UUID}):version:(${UUID}):(original|working:(${UUID}))$`, "i");

// An original is pinned by dataset/version. A normalized working COG also names
// its immutable object. These logical identities never contain a read ticket.
export function isManagedCogIdentity(value, {datasetId, datasetVersionId, objectId} = {}) {
  const match = typeof value === "string" && IDENTITY.exec(value);
  return Boolean(match && (datasetId === undefined || match[1] === datasetId)
    && (datasetVersionId === undefined || match[2] === datasetVersionId)
    && (match[3] === "original" || objectId === undefined || match[4] === objectId));
}
