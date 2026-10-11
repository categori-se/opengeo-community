import {assertCollectionDefinition} from "@categori/workspace-contracts/collections";

/** Export a saved authoring definition; this metadata supplies no resource grants. */
export function serializeSavedCollection(record) {
  const definition = assertCollectionDefinition(record?.definition);
  if (definition.reference.resource_id !== record.id || definition.record_revision !== record.revision ||
      definition.title !== record.title || definition.description !== record.description) {
    throw new TypeError("Collection metadata does not match the saved record");
  }
  const text = JSON.stringify(definition);
  // Keep the wire bytes within the unchanged portable contract, including UTF-8.
  if (new TextEncoder().encode(text).byteLength > 65536) throw new TypeError("Collection metadata exceeds 64 KiB");
  return Object.freeze({definition, text, filename: `opengeo-collection-${record.id}.json`});
}
