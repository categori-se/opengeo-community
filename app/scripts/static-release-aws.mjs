import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";

import {
  assertPublicArtifactBoundary,
  contentType,
  digestFileRecords,
  readJson,
  safeJoin,
  sealManifest,
  sha256,
  snapshotTree,
  verifyManifestSeal,
  writeJson
} from "./release-utils.mjs";
import {
  canonicalStudioRoutes,
  PRE_CREDITS_ROUTE_CONTRACT_VERSION,
  preCreditsStudioRoutes,
  PRE_LAYER_ROUTE_CONTRACT_VERSION,
  preLayerStudioRoutes,
  LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION,
  legacyStudioRoutes
} from "./application-route-inventory.mjs";

import {communityDeploymentEnabled, reviewedStudioOrigin} from "./studio-release-config.mjs";

const PRODUCTION_ACCOUNT = "111111111111";
const RELEASE_OBJECT_LIMIT = 1000;
const STUDIO_RELEASE_OBJECT_LIMIT = 2000;

function releaseObjectLimit(surface) {
  return surface === "studio" ? STUDIO_RELEASE_OBJECT_LIMIT : RELEASE_OBJECT_LIMIT;
}

function releaseArtifactLimit(surface) {
  // Reserve one object per Studio route: non-root aliases plus the manifest.
  // Public and demo releases retain their existing artifact ceiling.
  return surface === "studio" ? releaseObjectLimit(surface) - canonicalStudioRoutes.length : 900;
}

export async function deployStaticRelease(options) {
  const {
    surface,
    root,
    manifestPath,
    expectedBucket,
    expectedAlias,
    expectedOriginDomain,
    aliasMode = "required",
    expectedDistributionDomain,
    distributionId,
    releaseStem,
    confirmationName,
    confirmationValue,
    aliases,
    noStorePaths = [],
    allowedPreviousOrigin,
    validateOrigin = () => {},
    validateDistribution = () => {},
    preMutationCheck = async () => {},
    beforeEdgeCheck = async () => {},
    afterEdgeCommit = async () => {},
    originPathOwner,
    deploymentRecordPath,
    expectedAccount = PRODUCTION_ACCOUNT,
    profile = process.env.OPEN_GEO_AWS_PROFILE ?? "categorise",
    localCheck = process.argv.includes("--local-check")
  } = options;
  if (!distributionId && !localCheck) {
    throw new Error(`${surface} CloudFront distribution id is required`);
  }
  if (typeof preMutationCheck !== "function") {
    throw new Error(`${surface} pre-mutation check must be a function`);
  }
  if (typeof validateDistribution !== "function") {
    throw new Error(`${surface} distribution validator must be a function`);
  }
  validateExpectedAccount(expectedAccount);
  validateViewerMode({surface, aliasMode, expectedAlias, expectedDistributionDomain});

  const manifest = verifyManifestSeal(await readJson(manifestPath), `${surface} manifest`);
  const artifactTree = await snapshotTree(root);
  if (manifest.artifactTree?.digest !== artifactTree.digest
    || JSON.stringify(manifest.artifactTree?.files) !== JSON.stringify(artifactTree.files)) {
    throw new Error(`${surface} artifacts no longer match the release manifest`);
  }
  if (artifactTree.files.length > releaseArtifactLimit(surface)) throw new Error(`${surface} release contains too many files`);
  const artifactPaths = new Set(artifactTree.files.map(({path}) => path));
  const occupied = new Set(artifactPaths);
  if (!Array.isArray(aliases)) throw new Error(`${surface} alias manifest is missing`);
  for (const alias of aliases) {
    safeJoin(root, alias.key);
    const source = artifactTree.files.find(({path}) => path === alias.sourcePath);
    if (!source || source.bytes !== alias.bytes || source.sha256 !== alias.sha256) {
      throw new Error(`${surface} alias source no longer matches its seal: ${alias.key}`);
    }
    if (alias.contentType !== "text/html; charset=utf-8") {
      throw new Error(`${surface} route alias has an unexpected content type: ${alias.key}`);
    }
    if (occupied.has(alias.key)) throw new Error(`${surface} alias collides with an artifact: ${alias.key}`);
    occupied.add(alias.key);
  }
  for (const path of noStorePaths) {
    safeJoin(root, path);
    if (!artifactPaths.has(path)) throw new Error(`${surface} no-store artifact is missing: ${path}`);
  }
  const manifestBytes = await readFile(manifestPath);
  const releaseDigest = sha256(JSON.stringify({
    artifactTree,
    aliases,
    manifestSha256: sha256(manifestBytes)
  }));
  const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
  const resumeRelease = process.env.OPEN_GEO_STATIC_RESUME_RELEASE;
  if (resumeRelease && (surface !== "public" || !manifest.retention
    || !new RegExp(`^${releaseStem}-[0-9]{14}-${releaseDigest.slice(0, 12)}$`).test(resumeRelease))) throw new Error("Resume requires this exact public retention bundle");
  const releaseName = resumeRelease ?? `${releaseStem}-${stamp}-${releaseDigest.slice(0, 12)}`;
  const releasePrefix = `releases/${releaseName}`;
  const retention = manifest.retention;
  const retainedObjects = retention?.objects ?? [];
  if (retention && (surface !== "public" || !/^releases\/(?:framework-[0-9a-f-]{36}|opengeo-public-[0-9]{14}-[0-9a-f]{12})$/.test(retention.sourcePrefix)
    || !Array.isArray(retainedObjects) || retainedObjects.length > 1000)) throw new Error("Invalid public retention plan");
  for (const object of retainedObjects) {
    safeJoin(root, object.path);
    if (occupied.has(object.path) || !Number.isSafeInteger(object.bytes) || object.bytes < 0
      || !/^"[0-9a-f]{32}(?:-[0-9]+)?"$/.test(object.etag)) throw new Error("Invalid retained object identity");
    occupied.add(object.path);
  }
  assertPublicArtifactBoundary(retainedObjects.map(object => object.path), "Retained public outputs", {allowWorkbenchDemo: true});
  const expectedObjects = artifactTree.files.length + aliases.length + retainedObjects.length + 1;
  if (expectedObjects > releaseObjectLimit(surface)) throw new Error(`${surface} release exceeds the verified object-count bound`);
  const localSummary = {
    mode: localCheck ? "local-check" : process.env[confirmationName] === confirmationValue ? "deploy" : "dry-run",
    surface,
    alias: expectedAlias,
    aliasMode,
    bucket: expectedBucket,
    distributionId: distributionId ?? null,
    releaseName,
    releaseOriginPath: `/${releasePrefix}`,
    files: artifactTree.files.length,
    aliases: aliases.length,
    expectedObjects,
    releaseDigest,
    manifestSha256: manifest.manifestSha256
  };
  if (localCheck) {
    console.log(JSON.stringify(localSummary, null, 2));
    return localSummary;
  }

  const identity = awsJson(["sts", "get-caller-identity"], profile);
  if (identity.Account !== expectedAccount) {
    throw new Error(`Refusing ${surface} deployment from AWS account ${identity.Account ?? "unknown"}`);
  }
  const distribution = awsJson(
    ["cloudfront", "get-distribution-config", "--id", distributionId],
    profile
  );
  const config = distribution.DistributionConfig;
  assertDistributionViewer({
    surface,
    config,
    aliasMode,
    expectedAlias,
    expectedDistributionDomain,
    distributionId,
    profile
  });
  const matchingOrigins = (config?.Origins?.Items ?? [])
    .filter(({DomainName}) => DomainName === expectedOriginDomain);
  if (matchingOrigins.length !== 1) {
    throw new Error(`${surface} distribution does not have exactly one reviewed S3 origin`);
  }
  const origin = matchingOrigins[0];
  validateOrigin(origin);
  assertDefaultBehaviorTarget({surface, config, originId: origin.Id});
  validateDistribution({config, staticOrigin: origin});
  if (!allowedPreviousOrigin.test(origin.OriginPath ?? "")) {
    throw new Error(`${surface} distribution origin path is outside the reviewed release boundary`);
  }
  const previousOriginPath = origin.OriginPath ?? "";
  if (retention && previousOriginPath !== `/${retention.sourcePrefix}`) throw new Error("Public retention baseline changed; stop before writes");
  const originOwnerState = originPathOwner
    ? assertCloudFormationOriginOwnership({
        owner: originPathOwner,
        distributionId,
        currentOriginPath: previousOriginPath,
        config,
        originId: origin.Id,
        profile
      })
    : null;
  const existing = awsJson([
    "s3api", "list-objects-v2", "--bucket", expectedBucket,
    "--prefix", `${releasePrefix}/`, "--max-keys", resumeRelease ? "1000" : "1"
  ], profile);
  const resumed = resumeRelease ? await assertPublicResumeListing({
    listing: existing, releasePrefix, retainedObjects, artifactTree, aliases,
    root, manifestBytes, phase: process.env.OPEN_GEO_STATIC_RESUME_PHASE ?? "retention"
  }) : {completedCopies: new Set(), completedAliases: new Set(), artifactsComplete: false, manifestComplete: false};
  const {completedCopies, completedAliases} = resumed;
  if (!resumeRelease && (existing.KeyCount ?? 0) !== 0) throw new Error(`Release prefix already exists: ${releasePrefix}`);

  console.log(JSON.stringify({...localSummary, account: identity.Account, previousOriginPath}, null, 2));
  if (process.env[confirmationName] !== confirmationValue) {
    console.log(`Dry run only. Set ${confirmationName}=${confirmationValue} to upload and cut over.`);
    return localSummary;
  }

  // Re-run caller-owned cutover gates after all read-only AWS preflight and
  // immediately before the first upload. This prevents an expired or replaced
  // acceptance receipt from being accepted merely because preflight was slow.
  await preMutationCheck();

  for (const object of retainedObjects) {
    if (completedCopies.has(object.path)) continue;
    aws(["s3api", "copy-object", "--bucket", expectedBucket,
      "--key", `${releasePrefix}/${object.path}`,
      // The AWS CLI's S3 parameter handler encodes this header itself.
      "--copy-source", `${expectedBucket}/${retention.sourcePrefix}/${object.path}`,
      "--copy-source-if-match", object.etag, "--metadata-directive", "COPY"], profile);
  }

  if (!resumed.artifactsComplete) {
    aws([
      "s3", "sync", root, `s3://${expectedBucket}/${releasePrefix}/`,
      "--cache-control", "public,max-age=31536000,immutable", "--no-progress"
    ], profile);
    aws([
      "s3", "cp", root, `s3://${expectedBucket}/${releasePrefix}/`, "--recursive",
      "--exclude", "*", "--include", "*.html",
      "--cache-control", "public,max-age=60,must-revalidate",
      "--content-type", "text/html; charset=utf-8", "--metadata-directive", "REPLACE",
      "--no-progress"
    ], profile);
    if (artifactPaths.has("manifest.webmanifest")) {
      aws([
        "s3", "cp", safeJoin(root, "manifest.webmanifest"),
        `s3://${expectedBucket}/${releasePrefix}/manifest.webmanifest`,
        "--cache-control", "public,max-age=60,must-revalidate",
        "--content-type", "application/manifest+json; charset=utf-8",
        "--metadata-directive", "REPLACE", "--no-progress"
      ], profile);
    }
    if (artifactPaths.has("service-worker.js")) {
      aws([
        "s3", "cp", safeJoin(root, "service-worker.js"),
        `s3://${expectedBucket}/${releasePrefix}/service-worker.js`,
        "--cache-control", "public,max-age=0,must-revalidate",
        "--content-type", "text/javascript; charset=utf-8",
        "--metadata-directive", "REPLACE", "--no-progress"
      ], profile);
    }
    aws([
      "s3", "cp", root, `s3://${expectedBucket}/${releasePrefix}/`, "--recursive",
      "--exclude", "*", "--include", "*.gz",
      "--cache-control", "public,max-age=31536000,immutable",
      "--content-type", "application/gzip", "--metadata-directive", "REPLACE",
      "--no-progress"
    ], profile);
    for (const path of noStorePaths) {
      aws([
        "s3", "cp", safeJoin(root, path), `s3://${expectedBucket}/${releasePrefix}/${path}`,
        "--cache-control", "no-store", "--content-type", contentType(path),
        "--metadata-directive", "REPLACE", "--no-progress"
      ], profile);
    }
  }
  for (const alias of aliases) {
    if (completedAliases.has(alias.key)) continue;
    aws([
      "s3api", "put-object", "--bucket", expectedBucket,
      "--key", `${releasePrefix}/${alias.key}`,
      "--body", safeJoin(root, alias.sourcePath),
      "--content-type", alias.contentType,
      "--cache-control", "public,max-age=60,must-revalidate"
    ], profile);
  }
  const releaseManifestKey = `${releasePrefix}/opengeo-${surface}-release-manifest.json`;
  if (!resumed.manifestComplete) aws([
    "s3api", "put-object", "--bucket", expectedBucket, "--key", releaseManifestKey,
    "--body", manifestPath, "--content-type", "application/json; charset=utf-8",
    "--cache-control", "public,max-age=31536000,immutable"
  ], profile);

  const uploaded = surface === "studio" ? listStaticReleaseObjects({
    surface, bucket: expectedBucket, prefix: releasePrefix, profile,
    expected: expectedRemoteReleaseObjects(manifest, {manifestObject: {
      path: `opengeo-${surface}-release-manifest.json`, bytes: manifestBytes.length,
      sha256: sha256(manifestBytes)
    }})
  }) : awsJson([
    "s3api", "list-objects-v2", "--bucket", expectedBucket,
    "--prefix", `${releasePrefix}/`, "--max-keys", "1000"
  ], profile);
  if (uploaded.IsTruncated || uploaded.KeyCount !== expectedObjects) {
    throw new Error(
      `${surface} release upload is incomplete: ${uploaded.KeyCount ?? 0} objects; expected ${expectedObjects}`
    );
  }

  await beforeEdgeCheck({previousOriginPath, releasePrefix, releaseDigest});
  if (originPathOwner) {
    updateCloudFormationOriginPath({
      owner: originPathOwner,
      ownerState: originOwnerState,
      target: `/${releasePrefix}`,
      distributionId,
      expectedOriginDomain,
      profile
    });
  } else {
    origin.OriginPath = `/${releasePrefix}`;
    const temporary = await mkdtemp(join(tmpdir(), `opengeo-${surface}-edge-`));
    const configPath = resolve(temporary, "distribution-config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
    aws([
      "cloudfront", "update-distribution", "--id", distributionId,
      "--if-match", distribution.ETag, "--distribution-config", `file://${configPath}`
    ], profile);
    aws(["cloudfront", "wait", "distribution-deployed", "--id", distributionId], profile);
    assertDeployedOriginPath({
      surface,
      distributionId,
      expectedOriginDomain,
      target: `/${releasePrefix}`,
      profile
    });
  }
  await afterEdgeCommit({previousOriginPath, releasePrefix, releaseDigest});
  const invalidationId = await createAndWaitForInvalidation(distributionId, profile, async id => {
    await writeJson(`${deploymentRecordPath}.invalidation.json`, {
      distributionId, invalidationId: id, releasePrefix, previousOriginPath,
      releaseDigest, manifestSha256: manifest.manifestSha256
    });
  });

  const rollback = options.rollbackCommand(previousOriginPath);
  if (rollback !== null && (typeof rollback !== "string" || !rollback)) {
    throw new Error(`${surface} rollback command must be a non-empty string or null`);
  }
  const record = sealManifest({
    schemaVersion: `opengeo.${surface}-deployment.1.0.0`,
    deployedAt: new Date().toISOString(),
    accountId: expectedAccount,
    alias: expectedAlias,
    bucket: expectedBucket,
    distributionId,
    previousOriginPath,
    releaseOriginPath: `/${releasePrefix}`,
    releaseName,
    releaseDigest,
    fileCount: artifactTree.files.length,
    aliasCount: aliases.length,
    objectCount: uploaded.KeyCount,
    invalidationId,
    originPathOwner: originPathOwner?.stackName ?? "cloudfront-direct",
    rollback,
    ...(rollback === null
      ? {rollbackUnavailableReason: "No prior immutable release exists for this surface."}
      : {})
  });
  await writeJson(deploymentRecordPath, record);
  console.log(JSON.stringify(record, null, 2));
  return record;
}

// The aliases phase follows all artifact uploads and cache-metadata writes in
// this sequential publisher. Operators select it only after reviewing the
// interrupted log. Refuse partial artifacts, foreign bytes and unknown objects.
export async function assertPublicResumeListing({listing, releasePrefix, retainedObjects, artifactTree, aliases, root, manifestBytes, phase = "retention"}) {
  if (listing.IsTruncated || !["retention", "aliases"].includes(phase)) throw new Error("Invalid public resume inventory or phase");
  const completedCopies = new Set(), completedAliases = new Set(), completedArtifacts = new Set();
  let manifestComplete = false;
  for (const object of listing.Contents ?? []) {
    if (!object.Key.startsWith(`${releasePrefix}/`)) throw new Error("Resume object is outside the release prefix");
    const path = object.Key.slice(releasePrefix.length + 1);
    const retained = retainedObjects.find(item => item.path === path);
    if (retained) {
      if (object.Size !== retained.bytes || object.ETag !== retained.etag) throw new Error("Resume retention identity changed");
      completedCopies.add(path); continue;
    }
    if (phase !== "aliases") throw new Error("Only exact completed retention copies can resume this early release phase");
    const artifact = artifactTree.files.find(item => item.path === path);
    const alias = aliases.find(item => item.key === path);
    const manifest = path === "opengeo-public-release-manifest.json";
    if (!artifact && !alias && !manifest) throw new Error("Unknown object in public resume inventory");
    const body = manifest ? manifestBytes : await readFile(safeJoin(root, alias?.sourcePath ?? path));
    const planned = artifact ?? alias;
    if (object.Size !== body.length || (planned && (planned.bytes !== body.length || sha256(body) !== planned.sha256))
      || object.ETag !== `"${createHash("md5").update(body).digest("hex")}"`) throw new Error("Resume upload identity changed");
    if (artifact) completedArtifacts.add(path);
    if (alias) completedAliases.add(path);
    if (manifest) manifestComplete = true;
  }
  if (phase === "aliases" && (completedCopies.size !== retainedObjects.length
    || completedArtifacts.size !== artifactTree.files.length || completedAliases.size === 0
    || (manifestComplete && completedAliases.size !== aliases.length))) throw new Error("Resume aliases phase lacks its completed upload predecessors");
  return {completedCopies, completedAliases, artifactsComplete: phase === "aliases", manifestComplete};
}

export async function rollbackStaticRelease(options) {
  const {
    surface,
    expectedAlias,
    expectedBucket,
    expectedOriginDomain,
    aliasMode = "required",
    expectedDistributionDomain,
    distributionId,
    target,
    confirmationName,
    confirmationValue,
    allowedTarget,
    validateOrigin = () => {},
    validateDistribution = () => {},
    validateManifest = () => {},
    originPathOwner,
    legacyManifestPath,
    legacySupplementPath,
    expectedManifestOrigin,
    expectedAccount = PRODUCTION_ACCOUNT,
    profile = process.env.OPEN_GEO_AWS_PROFILE ?? "categorise",
    verifyOnly = process.argv.includes("--verify-target-only")
  } = options;
  if (!distributionId) throw new Error(`${surface} CloudFront distribution id is required`);
  if (!expectedBucket) throw new Error(`${surface} rollback bucket is required`);
  validateExpectedAccount(expectedAccount);
  validateViewerMode({surface, aliasMode, expectedAlias, expectedDistributionDomain});
  if (!verifyOnly && process.env[confirmationName] !== confirmationValue) {
    throw new Error(`Rollback requires ${confirmationName}=${confirmationValue}`);
  }
  if (!allowedTarget.test(target ?? "")) {
    throw new Error(`${surface} rollback target is outside its immutable release boundary`);
  }
  const identity = awsJson(["sts", "get-caller-identity"], profile);
  if (identity.Account !== expectedAccount) {
    throw new Error(`Refusing ${surface} rollback from an unexpected AWS account`);
  }
  const distribution = awsJson(
    ["cloudfront", "get-distribution-config", "--id", distributionId],
    profile
  );
  const config = distribution.DistributionConfig;
  assertDistributionViewer({
    surface,
    config,
    aliasMode,
    expectedAlias,
    expectedDistributionDomain,
    distributionId,
    profile
  });
  const matchingOrigins = (config?.Origins?.Items ?? [])
    .filter(({DomainName}) => DomainName === expectedOriginDomain);
  if (matchingOrigins.length !== 1) {
    throw new Error(`${surface} distribution origin is outside the reviewed boundary`);
  }
  const origin = matchingOrigins[0];
  validateOrigin(origin);
  assertDefaultBehaviorTarget({surface, config, originId: origin.Id});
  validateDistribution({config, staticOrigin: origin});
  const currentOriginPath = origin.OriginPath ?? "";
  await verifyRemoteRollbackTarget({
    surface,
    bucket: expectedBucket,
    target,
    legacyManifestPath,
    legacySupplementPath,
    expectedManifestOrigin,
    validateManifest,
    profile
  });
  if (verifyOnly) {
    console.log(JSON.stringify({
      status: "verified",
      surface,
      alias: expectedAlias,
      bucket: expectedBucket,
      target,
      currentOriginPath,
      mutationAttempted: false
    }, null, 2));
    return;
  }
  if (originPathOwner) {
    const ownerState = assertCloudFormationOriginOwnership({
      owner: originPathOwner,
      distributionId,
      currentOriginPath,
      config,
      originId: origin.Id,
      profile
    });
    updateCloudFormationOriginPath({
      owner: originPathOwner,
      ownerState,
      target,
      distributionId,
      expectedOriginDomain,
      profile
    });
  } else {
    origin.OriginPath = target;
    const temporary = await mkdtemp(join(tmpdir(), `opengeo-${surface}-rollback-`));
    const configPath = resolve(temporary, "distribution-config.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {encoding: "utf8", mode: 0o600});
    aws([
      "cloudfront", "update-distribution", "--id", distributionId,
      "--if-match", distribution.ETag, "--distribution-config", `file://${configPath}`
    ], profile);
    aws(["cloudfront", "wait", "distribution-deployed", "--id", distributionId], profile);
    assertDeployedOriginPath({
      surface,
      distributionId,
      expectedOriginDomain,
      target,
      profile
    });
  }
  const invalidationId = await createAndWaitForInvalidation(distributionId, profile);
  console.log(
    `${expectedAlias} rolled back to ${target}; invalidation ${invalidationId} completed. No release objects were deleted.`
  );
}

function validateExpectedAccount(value) {
  if (!/^[0-9]{12}$/.test(value ?? "")) {
    throw new Error("Static release expected account must be an exact 12-digit account id");
  }
}

async function verifyRemoteRollbackTarget({
  surface,
  bucket,
  target,
  legacyManifestPath,
  legacySupplementPath,
  expectedManifestOrigin,
  validateManifest,
  profile
}) {
  const prefix = target.slice(1);
  const immutable = target.startsWith("/releases/");
  if (!immutable && (
    surface !== "public"
      || target !== "/dist"
      || !legacyManifestPath
      || !legacySupplementPath
  )) {
    throw new Error(`${surface} rollback has no sealed contract for ${target}`);
  }

  const temporary = await mkdtemp(join(tmpdir(), `opengeo-${surface}-rollback-verify-`));
  try {
    const manifestObject = `opengeo-${surface}-release-manifest.json`;
    let manifestBytes;
    let remoteManifestMetadata;
    if (immutable) {
      const manifestDownload = resolve(temporary, "release-manifest.json");
      remoteManifestMetadata = awsJson([
        "s3api", "get-object", "--bucket", bucket,
        "--key", `${prefix}/${manifestObject}`, manifestDownload
      ], profile);
      manifestBytes = await readFile(manifestDownload);
    } else {
      manifestBytes = await readFile(legacyManifestPath);
    }
    const manifest = assertSurfaceReleaseManifest(
      JSON.parse(manifestBytes.toString("utf8")),
      surface,
      {
        allowLegacyPublic: !immutable,
        legacyApplicationRouteContractVersion:
          immutable && ["studio", "demo"].includes(surface)
            ? LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION
            : null,
        preLayerRouteContractVersion: immutable && ["studio", "demo"].includes(surface)
          ? PRE_LAYER_ROUTE_CONTRACT_VERSION : null,
        preCreditsRouteContractVersion: immutable && ["studio", "demo"].includes(surface)
          ? PRE_CREDITS_ROUTE_CONTRACT_VERSION : null,
        expectedStudioOrigin: expectedManifestOrigin
      }
    );
    validateManifest(manifest);
    const legacySupplement = immutable
      ? null
      : assertLegacyPublicRollbackSupplement(await readJson(legacySupplementPath));
    if (legacySupplement
      && (manifest.artifactTree.files.length !== legacySupplement.expectedBaseArtifactCount
        || manifest.aliases.length !== legacySupplement.expectedBaseAliasCount)) {
      throw new Error("Legacy public rollback base manifest does not match its supplement");
    }
    const expected = expectedRemoteReleaseObjects(manifest, {
      includeAliases: true,
      ...(immutable
        ? {
            manifestObject: {
              path: manifestObject,
              bytes: manifestBytes.length,
              sha256: sha256(manifestBytes)
            }
          }
        : {}),
      extraObjects: legacySupplement?.objects ?? []
    });
    const listing = surface === "studio" ? listStaticReleaseObjects({
      surface, bucket, prefix, expected, profile
    }) : awsJson([
      "s3api", "list-objects-v2", "--bucket", bucket,
      "--prefix", `${prefix}/`, "--max-keys", "1000"
    ], profile);
    assertRemoteReleaseListing({listing, prefix, expected, surface});

    for (const [index, object] of expected.entries()) {
      let metadata;
      let body;
      if (immutable && object.path === manifestObject) {
        metadata = remoteManifestMetadata;
        body = manifestBytes;
      } else {
        const destination = resolve(temporary, `object-${String(index).padStart(4, "0")}`);
        metadata = awsJson([
          "s3api", "get-object", "--bucket", bucket,
          "--key", `${prefix}/${object.path}`, destination
        ], profile);
        body = await readFile(destination);
      }
      if (metadata?.ContentLength !== object.bytes
        || body.length !== object.bytes
        || sha256(body) !== object.sha256) {
        throw new Error(
          `${surface} rollback target does not match its seal: ${target}/${object.path}`
        );
      }
      if (surface === "studio" && object.path === manifest.authConfig.path) {
        if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(metadata?.CacheControl ?? "")) {
          throw new Error("Studio rollback auth-config.json is not stored with Cache-Control: no-store");
        }
      }
    }
  } finally {
    await rm(temporary, {recursive: true, force: true});
  }
}

export function assertSurfaceReleaseManifest(
  value,
  surface,
  {
    allowLegacyPublic = false,
    legacyApplicationRouteContractVersion = null,
    preLayerRouteContractVersion = null,
    preCreditsRouteContractVersion = null,
    expectedStudioOrigin = "https://studio.opengeo.tools"
  } = {}
) {
  if (legacyApplicationRouteContractVersion !== null
    && legacyApplicationRouteContractVersion !== LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION) {
    throw new Error("Rollback application-route compatibility version is not reviewed");
  }
  if (preLayerRouteContractVersion !== null && preLayerRouteContractVersion !== PRE_LAYER_ROUTE_CONTRACT_VERSION) {
    throw new Error("Rollback pre-layer route compatibility version is not reviewed");
  }
  if (preCreditsRouteContractVersion !== null && preCreditsRouteContractVersion !== PRE_CREDITS_ROUTE_CONTRACT_VERSION) {
    throw new Error("Rollback pre-credits route compatibility version is not reviewed");
  }
  if (surface === "studio" && !isReviewedStudioOrigin(expectedStudioOrigin)) {
    throw new Error("Studio rollback expected origin is outside the reviewed boundary");
  }
  const manifest = verifyManifestSeal(value, `${surface} rollback release manifest`);
  const managedDemo = surface === "demo"
    && value?.schemaVersion === "opengeo.managed-demo-release.1.0.0";
  const legacyApplicationRoutes = legacyApplicationRouteContractVersion
    === LEGACY_APPLICATION_ROUTE_CONTRACT_VERSION
    && (surface === "studio" || managedDemo)
    && matchesApplicationRouteContract(manifest, legacyStudioRoutes);
  const preLayerRoutes = preLayerRouteContractVersion === PRE_LAYER_ROUTE_CONTRACT_VERSION
    && (surface === "studio" || managedDemo) && matchesApplicationRouteContract(manifest, preLayerStudioRoutes);
  const applicationRoutes = legacyApplicationRoutes
    ? legacyStudioRoutes
    : preLayerRoutes ? preLayerStudioRoutes
      : preCreditsRouteContractVersion === PRE_CREDITS_ROUTE_CONTRACT_VERSION
        && (surface === "studio" || managedDemo)
        && matchesApplicationRouteContract(manifest, preCreditsStudioRoutes)
        ? preCreditsStudioRoutes : canonicalStudioRoutes;
  // Browser Demo releases before public credits retain their exact one-page
  // contract. New builds seal both pages; no authenticated route is admitted.
  const browserDemoRouteCount = manifest.routes?.length === 2
    && manifest.routes[0]?.path === "/"
    && manifest.routes[1]?.path === "/credits"
    && manifest.routes[1]?.htmlPath === "credits.html"
    ? 2 : 1;
  const contracts = {
    public: {
      schemaVersion: allowLegacyPublic
        ? "opengeo.public-bundle.1.0.0"
        : "opengeo.public-bundle.2.0.0",
      originKey: "publicOrigin",
      origin: "https://opengeo.tools",
      routes: allowLegacyPublic ? 27 : 28,
      aliases: allowLegacyPublic ? 34 : 35
    },
    studio: {
      schemaVersion: "opengeo.studio-release.1.0.0",
      originKey: "studioOrigin",
      origin: expectedStudioOrigin,
      routes: applicationRoutes.length,
      aliases: applicationRoutes.length - 1
    },
    demo: {
      schemaVersion: managedDemo
        ? "opengeo.managed-demo-release.1.0.0"
        : "opengeo.demo-build.1.0.0",
      originKey: "demoOrigin",
      origin: "https://demo.studio.opengeo.tools",
      routes: managedDemo ? applicationRoutes.length : browserDemoRouteCount,
      aliases: managedDemo ? applicationRoutes.length - 1 : browserDemoRouteCount - 1
    }
  };
  const contract = contracts[surface];
  if (!contract
    || manifest.schemaVersion !== contract.schemaVersion
    || manifest[contract.originKey] !== contract.origin
    || manifest.routes?.length !== contract.routes
    || manifest.aliases?.length !== contract.aliases
    || manifest.artifactTree?.algorithm !== "sha256"
    || !Array.isArray(manifest.artifactTree?.files)
    || manifest.artifactTree.files.length === 0
    || manifest.artifactTree.files.length > releaseArtifactLimit(surface)) {
    throw new Error(`${surface} rollback release manifest contract is invalid`);
  }

  const files = new Map();
  for (const file of manifest.artifactTree.files) {
    safeJoin("/tmp/opengeo-release-contract", file?.path);
    if (!Number.isSafeInteger(file?.bytes) || file.bytes < 0
      || !/^[0-9a-f]{64}$/.test(file?.sha256 ?? "")
      || files.has(file.path)) {
      throw new Error(`${surface} rollback artifact seal is invalid`);
    }
    files.set(file.path, file);
  }
  if (!files.has("index.html")) {
    throw new Error(`${surface} rollback release lacks its sealed index.html`);
  }
  const sortedPaths = [...files.keys()].sort();
  if (JSON.stringify([...files.keys()]) !== JSON.stringify(sortedPaths)
    || digestFileRecords(manifest.artifactTree.files) !== manifest.artifactTree.digest) {
    throw new Error(`${surface} rollback artifact tree digest is invalid`);
  }

  const occupied = new Set(files.keys());
  for (const alias of manifest.aliases) {
    safeJoin("/tmp/opengeo-release-contract", alias?.key);
    const source = files.get(alias?.sourcePath);
    if (!source
      || source.bytes !== alias.bytes
      || source.sha256 !== alias.sha256
      || alias.contentType !== "text/html; charset=utf-8"
      || occupied.has(alias.key)) {
      throw new Error(`${surface} rollback alias seal is invalid`);
    }
    occupied.add(alias.key);
  }
  if (surface === "public") {
    assertPublicArtifactBoundary(
      [...occupied],
      "Public rollback release",
      {allowWorkbenchDemo: !allowLegacyPublic}
    );
  } else if (surface === "studio") {
    if (manifest.authConfig?.path !== "auth-config.json"
      || manifest.authConfig?.cacheControl !== "no-store"
      || !files.has(manifest.authConfig.path)) {
      throw new Error("Studio rollback release lacks its sealed no-store auth configuration");
    }
  } else if (!managedDemo) {
    assertPublicArtifactBoundary([...occupied], "Demo rollback release", {allowWorkbenchDemo: true});
    if (files.has("auth-config.json")) {
      throw new Error("Demo rollback release contains Studio authentication configuration");
    }
  } else if (manifest.authConfig?.path !== "auth-config.json"
    || manifest.authConfig?.cacheControl !== "no-store"
    || !files.has(manifest.authConfig.path)) {
    throw new Error("Managed demo rollback release lacks its sealed no-store auth configuration");
  }
  return manifest;
}

function matchesApplicationRouteContract(manifest, routes) {
  if (manifest.routes?.length !== routes.length
    || manifest.aliases?.length !== routes.length - 1) return false;
  const expectedAliases = [];
  for (const [index, [path, htmlPath]] of routes.entries()) {
    const route = manifest.routes[index];
    const aliases = path === "/" ? [] : [path.slice(1)];
    if (route?.path !== path
      || route?.htmlPath !== htmlPath
      || JSON.stringify(route?.aliases) !== JSON.stringify(aliases)) return false;
    if (aliases.length) expectedAliases.push({key: aliases[0], sourcePath: htmlPath});
  }
  return expectedAliases.every(({key, sourcePath}, index) => (
    manifest.aliases[index]?.key === key
    && manifest.aliases[index]?.sourcePath === sourcePath
  ));
}

function isReviewedStudioOrigin(value) {
  if (!communityDeploymentEnabled()) {
    return value === "https://studio.opengeo.tools"
      || value === "https://dev.studio.opengeo.tools"
      || /^https:\/\/d[a-z0-9]{5,30}\.cloudfront\.net$/.test(value ?? "");
  }
  try {
    return reviewedStudioOrigin(value) === value;
  } catch {
    return false;
  }
}

export function assertLegacyPublicRollbackSupplement(value) {
  const supplement = verifyManifestSeal(value, "legacy public rollback supplement");
  if (supplement.schemaVersion !== "opengeo.public-legacy-rollback-supplement.1.0.0"
    || supplement.bucket !== "opengeo.tools"
    || supplement.originPath !== "/dist"
    || supplement.baseManifestPath !== "dist/opengeo-public-bundle.json"
    || supplement.expectedBaseArtifactCount !== 106
    || supplement.expectedBaseAliasCount !== 34
    || !Array.isArray(supplement.objects)
    || supplement.objects.length !== 2) {
    throw new Error("Legacy public rollback supplement contract is invalid");
  }
  const expectedObjects = [
    {
      path: "_observablehq/minisearch.d4811155.json",
      bytes: 71067,
      sha256: "d48111555a8e6dd7d38cbcd2a9399542f4d6acd089ac24b679444b9e2af7a98c"
    },
    {
      path: "_observablehq/search.9890d3ec.js",
      bytes: 32664,
      sha256: "26388a850f5c42ee907dc30cf2aad4d57b4945f650bb70f32fef3011570facb7"
    }
  ];
  if (JSON.stringify(supplement.objects) !== JSON.stringify(expectedObjects)) {
    throw new Error("Legacy public rollback supplement object seal is invalid");
  }
  for (const [index, object] of supplement.objects.entries()) {
    safeJoin("/tmp/opengeo-legacy-public-contract", object?.path);
    if (object.path !== expectedObjects[index].path
      || !Number.isSafeInteger(object.bytes)
      || object.bytes < 0
      || !/^[0-9a-f]{64}$/.test(object.sha256 ?? "")) {
      throw new Error("Legacy public rollback supplement object seal is invalid");
    }
  }
  return supplement;
}

export function expectedRemoteReleaseObjects(
  manifest,
  {includeAliases = true, manifestObject, extraObjects = []} = {}
) {
  const expected = manifest.artifactTree.files.map((file) => ({...file}));
  if (includeAliases) {
    expected.push(...manifest.aliases.map(({key, bytes, sha256: digest}) => ({
      path: key,
      bytes,
      sha256: digest
    })));
  }
  if (manifestObject) expected.push({...manifestObject});
  expected.push(...extraObjects.map((object) => ({...object})));
  return expected.sort((left, right) => left.path.localeCompare(right.path));
}

export function assertRemoteReleaseListing({listing, prefix, expected, surface}) {
  if (listing?.IsTruncated || !Array.isArray(listing?.Contents)) {
    throw new Error(`${surface} rollback target listing is incomplete`);
  }
  const actual = listing.Contents.map(({Key, Size}) => ({
    path: typeof Key === "string" && Key.startsWith(`${prefix}/`)
      ? Key.slice(prefix.length + 1)
      : null,
    bytes: Size
  })).sort((left, right) => String(left.path).localeCompare(String(right.path)));
  const wanted = expected.map(({path, bytes}) => ({path, bytes}));
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${surface} rollback target object inventory does not match its seal`);
  }
}

// Read explicit S3 pages: --max-keys disables CLI automatic pagination. Keep
// Studio upload and rollback inventories within the same finite object budget.
export function listStaticReleaseObjects({surface, bucket, prefix, expected, profile, read = awsJson}) {
  const limit = releaseObjectLimit(surface);
  if (!Array.isArray(expected) || expected.length === 0 || expected.length > limit) {
    throw new Error(`${surface} release exceeds the verified object-count bound`);
  }
  const wanted = new Map(expected.map(object => [`${prefix}/${object.path}`, object.bytes]));
  if (wanted.size !== expected.length) throw new Error(`${surface} release has duplicate expected objects`);
  const Contents = [], seenKeys = new Set(), seenTokens = new Set();
  let token;
  for (let pageIndex = 0; pageIndex < Math.ceil(limit / 1000); pageIndex++) {
    const page = read([
      "s3api", "list-objects-v2", "--bucket", bucket,
      "--prefix", `${prefix}/`, "--max-keys", "1000", "--no-paginate",
      ...(token ? ["--continuation-token", token] : [])
    ], profile);
    const objects = page?.Contents ?? [];
    if (typeof page?.IsTruncated !== "boolean" || !Array.isArray(objects)
      || page.KeyCount !== objects.length || objects.length > 1000
      || (page.CommonPrefixes?.length ?? 0) !== 0) {
      throw new Error(`${surface} release listing has an invalid page`);
    }
    for (const object of objects) {
      if (typeof object.Key !== "string" || !object.Key.startsWith(`${prefix}/`)
        || !wanted.has(object.Key) || wanted.get(object.Key) !== object.Size
        || seenKeys.has(object.Key)) {
        throw new Error(`${surface} release listing has an unexpected or duplicate object`);
      }
      seenKeys.add(object.Key);
      Contents.push(object);
    }
    if (!page.IsTruncated) {
      if (page.NextContinuationToken) throw new Error(`${surface} release listing has an unexpected continuation token`);
      const listing = {Contents, KeyCount: Contents.length, IsTruncated: false};
      assertRemoteReleaseListing({listing, prefix, expected, surface});
      return listing;
    }
    const next = page.NextContinuationToken;
    if (typeof next !== "string" || next.length === 0 || seenTokens.has(next)) {
      throw new Error(`${surface} release listing has a missing or repeated continuation token`);
    }
    seenTokens.add(next);
    token = next;
  }
  throw new Error(`${surface} release listing exceeds the verified object-count bound`);
}

function assertCloudFormationOriginOwnership({
  owner,
  distributionId,
  currentOriginPath,
  config,
  originId,
  profile
}) {
  if (!owner?.stackName || !owner?.parameterName) {
    throw new Error("CloudFormation origin-path ownership is incomplete");
  }
  const templateResponse = awsJson([
    "cloudformation", "get-template", "--stack-name", owner.stackName,
    "--template-stage", "Processed"
  ], profile);
  const template = typeof templateResponse.TemplateBody === "string"
    ? JSON.parse(templateResponse.TemplateBody)
    : templateResponse.TemplateBody;
  if (!template?.Parameters?.[owner.parameterName]) {
    throw new Error(
      `${owner.stackName} does not own OriginPath through ${owner.parameterName}; deploy the reviewed Studio edge template first`
    );
  }
  const described = awsJson([
    "cloudformation", "describe-stacks", "--stack-name", owner.stackName
  ], profile);
  const stack = described.Stacks?.[0];
  if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus)) {
    throw new Error(`${owner.stackName} is not in a stable deployable state`);
  }
  const parameter = (stack.Parameters ?? [])
    .find(({ParameterKey}) => ParameterKey === owner.parameterName);
  if (parameter?.ParameterValue !== currentOriginPath) {
    throw new Error(
      `${owner.stackName} ${owner.parameterName} does not match the live CloudFront OriginPath`
    );
  }
  const distributionOutputKey = owner.distributionOutputKey ?? "StudioDistributionId";
  const stackDistributionId = (stack.Outputs ?? [])
    .find(({OutputKey}) => OutputKey === distributionOutputKey)?.OutputValue;
  if (stackDistributionId !== distributionId) {
    throw new Error(`${owner.stackName} output does not identify the reviewed ${owner.surfaceLabel ?? "Studio"} distribution`);
  }
  const allowedNonStaticBehaviors = new Set(owner.allowedNonStaticBehaviorPaths ?? []);
  if (!originId || config?.DefaultCacheBehavior?.TargetOriginId !== originId) {
    throw new Error(`${owner.surfaceLabel ?? "Studio"} default CloudFront behavior does not target the reviewed private S3 origin`);
  }
  for (const behavior of config?.CacheBehaviors?.Items ?? []) {
    if (behavior.TargetOriginId !== originId
      && !allowedNonStaticBehaviors.has(behavior.PathPattern)) {
      throw new Error(
        `${owner.surfaceLabel ?? "Studio"} CloudFront behavior ${behavior.PathPattern ?? "unknown"} targets an unreviewed origin`
      );
    }
  }
  const resources = awsJson([
    "cloudformation", "list-stack-resources", "--stack-name", owner.stackName
  ], profile);
  const ownsDistribution = (resources.StackResourceSummaries ?? []).some((resource) => (
    resource.ResourceType === "AWS::CloudFront::Distribution"
      && resource.PhysicalResourceId === distributionId
  ));
  if (!ownsDistribution) {
    throw new Error(`${owner.stackName} does not own the reviewed ${owner.surfaceLabel ?? "Studio"} distribution`);
  }
  return stack;
}

function updateCloudFormationOriginPath({
  owner,
  ownerState,
  target,
  distributionId,
  expectedOriginDomain,
  profile
}) {
  const parameters = (ownerState.Parameters ?? []).map(({ParameterKey}) => (
    ParameterKey === owner.parameterName
      ? `ParameterKey=${ParameterKey},ParameterValue=${target}`
      : `ParameterKey=${ParameterKey},UsePreviousValue=true`
  ));
  if (!parameters.some((value) => value.startsWith(`ParameterKey=${owner.parameterName},`))) {
    throw new Error(`${owner.stackName} is missing its OriginPath parameter value`);
  }
  const updateArgs = [
    "cloudformation", "update-stack", "--stack-name", owner.stackName,
    "--use-previous-template", "--parameters", ...parameters
  ];
  if ((ownerState.Capabilities ?? []).length > 0) {
    updateArgs.push("--capabilities", ...ownerState.Capabilities);
  }
  aws(updateArgs, profile);
  aws([
    "cloudformation", "wait", "stack-update-complete", "--stack-name", owner.stackName
  ], profile);
  assertDeployedOriginPath({
    surface: owner.surfaceLabel?.toLowerCase() ?? "studio",
    distributionId,
    expectedOriginDomain,
    target,
    profile
  });
}

function assertDefaultBehaviorTarget({surface, config, originId}) {
  if (!originId || config?.DefaultCacheBehavior?.TargetOriginId !== originId) {
    throw new Error(`${surface} default CloudFront behavior does not target the reviewed S3 origin`);
  }
}

function assertDeployedOriginPath({
  surface,
  distributionId,
  expectedOriginDomain,
  target,
  profile
}) {
  const deployed = awsJson([
    "cloudfront", "get-distribution", "--id", distributionId
  ], profile)?.Distribution;
  const origins = (deployed?.DistributionConfig?.Origins?.Items ?? [])
    .filter(({DomainName}) => DomainName === expectedOriginDomain);
  if (deployed?.Status !== "Deployed"
    || origins.length !== 1
    || origins[0].OriginPath !== target) {
    throw new Error(
      `${surface} edge completed without activating the requested release origin`
    );
  }
}

async function createAndWaitForInvalidation(distributionId, profile, onCreated = async () => {}) {
  const invalidation = awsJson([
    "cloudfront", "create-invalidation", "--distribution-id", distributionId, "--paths", "/*"
  ], profile);
  const invalidationId = invalidation?.Invalidation?.Id;
  if (!invalidationId) throw new Error("CloudFront did not return an invalidation id");
  await onCreated(invalidationId);
  aws([
    "cloudfront", "wait", "invalidation-completed",
    "--distribution-id", distributionId, "--id", invalidationId
  ], profile);
  return invalidationId;
}

function aws(args, profile) {
  execFileSync("aws", [...args, "--profile", profile,
    ...(communityDeploymentEnabled() ? ["--region", "us-east-1"] : [])
  ], {stdio: "inherit"});
}

function awsJson(args, profile) {
  const output = execFileSync("aws", [...args, "--profile", profile, "--output", "json",
    ...(communityDeploymentEnabled() ? ["--region", "us-east-1"] : [])
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"]
  });
  return JSON.parse(output || "{}");
}

function validateViewerMode({surface, aliasMode, expectedAlias, expectedDistributionDomain}) {
  if (!expectedAlias || !["required", "absent"].includes(aliasMode)) {
    throw new Error(`${surface} release has an invalid CloudFront viewer policy`);
  }
  if (aliasMode === "absent" && expectedDistributionDomain !== expectedAlias) {
    throw new Error(`${surface} bootstrap must be keyed to its exact CloudFront domain`);
  }
}

function assertDistributionViewer({
  surface,
  config,
  aliasMode,
  expectedAlias,
  expectedDistributionDomain,
  distributionId,
  profile
}) {
  const aliases = config?.Aliases?.Items ?? [];
  if (aliasMode === "required") {
    if (aliases.length !== 1 || aliases[0] !== expectedAlias) {
      throw new Error(`${surface} CloudFront distribution must have only the reviewed alias`);
    }
    return;
  }
  if (aliases.length !== 0 || (config?.Aliases?.Quantity ?? 0) !== 0) {
    throw new Error(`${surface} bootstrap distribution must not have a custom-domain alias`);
  }
  const distribution = awsJson(["cloudfront", "get-distribution", "--id", distributionId], profile);
  if (distribution?.Distribution?.DomainName !== expectedDistributionDomain) {
    throw new Error(`${surface} bootstrap CloudFront domain is outside the reviewed boundary`);
  }
}
