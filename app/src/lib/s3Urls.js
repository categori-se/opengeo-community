export function objectReference(object) {
  return {
    refType: "s3-object",
    bucket: object.bucket,
    key: object.key
  };
}

export function signedObjectPath(object) {
  return `/objects/${object.objectId}/signed-url`;
}

export function publicDatasetPath({tenantId, workspaceId, datasetId, version = "v1"}) {
  return `/public/tenants/${tenantId}/workspaces/${workspaceId}/datasets/${datasetId}/${version}/`;
}
