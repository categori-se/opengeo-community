export const DEFAULT_STORAGE = {
  provider: "aws-s3",
  bucket: "dev.storage.opengeo.tools",
  prefix: "dev/",
  projectPrefix: "dev/workspaces/",
  uploadPrefix: "dev/uploads/"
};

export function normalizeStorage(storage = {}) {
  const merged = {...DEFAULT_STORAGE, ...storage};
  const prefix = ensureTrailingSlash(stripLeadingSlash(merged.prefix ?? ""));
  return {
    ...merged,
    prefix,
    projectPrefix: ensureTrailingSlash(stripLeadingSlash(merged.projectPrefix ?? `${prefix}workspaces/`)),
    uploadPrefix: ensureTrailingSlash(stripLeadingSlash(merged.uploadPrefix ?? `${prefix}uploads/`))
  };
}

export function projectObjectKey(context) {
  const workspaceId = context.workspace?.workspaceId ?? "{workspaceId}";
  return `${context.storage.projectPrefix}${workspaceId}/project.json`;
}

export function workspaceUploadPrefix(context) {
  const workspaceId = context.workspace?.workspaceId ?? "{workspaceId}";
  return `${context.storage.uploadPrefix}${workspaceId}/`;
}

export function projectS3Uri(context) {
  return `s3://${context.storage.bucket}/${projectObjectKey(context)}`;
}

export function uploadS3Uri(context) {
  return `s3://${context.storage.bucket}/${workspaceUploadPrefix(context)}`;
}

function stripLeadingSlash(value) {
  return String(value).replace(/^\/+/, "");
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}
