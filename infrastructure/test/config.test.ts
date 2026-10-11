import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {
  environmentConfig,
  DEMO_STUDIO_ORIGIN,
  PRODUCTION_STUDIO_ORIGIN,
  parseAdditionalUserPoolClientIds,
  parseBudgetAlertEmail,
  parseFederationConfig,
  parseImageTagOrDigest,
  parseObservableBuilderImageDigest,
  parseStage,
  parseStorageBucketConfig,
  parseUserPoolClientId,
  storageBucketNames,
  parseWebOrigin
} from "../lib/config.js";

describe("environment configuration", () => {
  it("keeps dev inexpensive and disposable", () => {
    const config = environmentConfig("dev", "http://localhost:3000");

    assert.equal(config.production, false);
    assert.equal(config.workerMaxTasks, 2);
    assert.equal(config.deletionProtection, false);
    assert.equal(config.databaseBackupDays, 7);
    assert.equal(config.databaseMaxAcu, 2);
    assert.equal(config.databaseReaderCount, 0);
    assert.equal(config.databaseAutoPauseMinutes, 5);
    assert.equal(config.auroraPostgresVersion, "16.13");
    assert.equal(config.containerInsights, false);
    assert.equal(config.monthlyBudgetUsd, 125);
    assert.ok(config.allowedWebOrigins.includes("http://localhost:3000"));
    assert.deepEqual(config.sharedAuth, {
      accountId: "111111111111",
      region: "us-east-1",
      userPoolId: "us-east-1_KXUwaZnuQ",
      hostedUiBaseUrl: "https://auth.categori.se"
    });
    assert.deepEqual(config.storageBuckets, {
      application: "dev.source.opengeo.tools",
      data: "dev.storage.opengeo.tools"
    });
  });

  it("protects production data", () => {
    const config = environmentConfig("production", PRODUCTION_STUDIO_ORIGIN);

    assert.equal(config.production, true);
    assert.equal(config.workerMaxTasks, 20);
    assert.equal(config.deletionProtection, true);
    assert.equal(config.databaseBackupDays, 30);
    assert.equal(config.databaseMaxAcu, 16);
    assert.equal(config.databaseReaderCount, 1);
    assert.equal(config.databaseAutoPauseMinutes, 5);
    assert.equal(config.containerInsights, true);
    assert.equal(config.monthlyBudgetUsd, 100);
    assert.deepEqual(config.allowedWebOrigins, [PRODUCTION_STUDIO_ORIGIN]);
    assert.deepEqual(config.storageBuckets, {
      application: "source.opengeo.tools",
      data: "storage.opengeo.tools"
    });
  });

  it("keeps the managed demo durable but small and independently addressed", () => {
    const config = environmentConfig("demo", DEMO_STUDIO_ORIGIN);

    assert.equal(parseStage("demo"), "demo");
    assert.equal(config.workerMaxTasks, 2);
    assert.equal(config.production, true);
    assert.equal(config.deletionProtection, true);
    assert.equal(config.databaseBackupDays, 14);
    assert.equal(config.databaseMaxAcu, 2);
    assert.equal(config.databaseReaderCount, 0);
    assert.equal(config.databaseAutoPauseMinutes, 5);
    assert.equal(config.monthlyBudgetUsd, 100);
    assert.equal(config.logRetentionDays, 90);
    assert.deepEqual(config.allowedWebOrigins, [DEMO_STUDIO_ORIGIN]);
    assert.deepEqual(config.storageBuckets, {
      application: "demo.source.opengeo.tools",
      data: "demo.storage.opengeo.tools"
    });
    assert.equal(parseWebOrigin(DEMO_STUDIO_ORIGIN, "demo"), DEMO_STUDIO_ORIGIN);
    assert.throws(
      () => parseWebOrigin("https://studio.opengeo.tools", "demo"),
      /demo application web origin/
    );
  });

  it("uses readable dotted branded bucket names without account-number suffixes", () => {
    assert.deepEqual(storageBucketNames("staging"), {
      application: "staging.source.opengeo.tools",
      data: "staging.storage.opengeo.tools"
    });
    for (const name of Object.values(storageBucketNames("production"))) {
      assert.match(name, /^(?:source|storage)\.opengeo\.tools$/);
      assert.doesNotMatch(name, /[0-9]{4,}/);
      assert.match(name, /\./);
    }
  });

  it("accepts explicit readable managed bucket names as one pair", () => {
    const buckets = parseStorageBucketConfig(
      "example-opengeo-source",
      "example-opengeo-data",
      "dev"
    );
    assert.deepEqual(buckets, {
      application: "example-opengeo-source",
      data: "example-opengeo-data"
    });
    assert.deepEqual(
      environmentConfig("dev", "http://localhost:3000", {}, buckets).storageBuckets,
      buckets
    );
  });

  it("rejects partial, duplicate, and unsafe managed bucket choices", () => {
    assert.throws(
      () => parseStorageBucketConfig("example-source", undefined, "dev"),
      /supplied together/
    );
    assert.throws(
      () => parseStorageBucketConfig("same-bucket", "same-bucket", "dev"),
      /must be different/
    );
    assert.throws(
      () => parseStorageBucketConfig("Example_Bucket", "example-data", "dev"),
      /DNS-compatible/
    );
    assert.throws(
      () => parseStorageBucketConfig("192.168.0.1", "example-data", "dev"),
      /IP address/
    );
  });

  it("allows the configured staging Studio origin to upload managed data", () => {
    const origin = "https://staging.studio.opengeo.tools";
    assert.deepEqual(environmentConfig("staging", origin).allowedWebOrigins, [origin]);
  });

  it("rejects unknown stages", () => {
    assert.throws(() => parseStage("prod"), /Invalid stage/);
  });

  it("accepts only an immutable image digest", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    assert.equal(parseImageTagOrDigest(digest), digest);
    assert.throws(() => parseImageTagOrDigest("build-20260818.1"), /immutable/);
  });

  it("rejects unsafe image references", () => {
    assert.throws(() => parseImageTagOrDigest("latest; deploy"), /immutable/);
    assert.throws(() => parseImageTagOrDigest("sha256:abc"), /immutable/);
  });

  it("requires an exact Observable builder digest before source projects can be enabled", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    assert.equal(parseObservableBuilderImageDigest(digest), digest);
    assert.throws(() => parseObservableBuilderImageDigest("builder-latest"), /immutable/);
    assert.throws(() => parseObservableBuilderImageDigest(undefined), /Observable builder/);
  });

  it("accepts only a bounded Cognito user-pool client id", () => {
    assert.equal(parseUserPoolClientId("5l2abc123def456ghi789jklmn"), "5l2abc123def456ghi789jklmn");
    assert.throws(() => parseUserPoolClientId("client-id"), /client id is invalid/);
    assert.throws(() => parseUserPoolClientId(undefined), /client id is invalid/);
  });

  it("accepts only a bounded exact additional Cognito client allowlist", () => {
    assert.equal(parseAdditionalUserPoolClientIds(undefined), undefined);
    assert.equal(
      parseAdditionalUserPoolClientIds("client123,client456"),
      "client123,client456"
    );
    for (const value of [
      "",
      "client123, client456",
      "client123,client123",
      "one,two,three,four"
    ]) {
      assert.throws(() => parseAdditionalUserPoolClientIds(value), /additional Cognito/);
    }
  });

  it("requires a bounded budget notification email", () => {
    assert.equal(
      parseBudgetAlertEmail("platform@example.com"),
      "platform@example.com"
    );
    assert.throws(() => parseBudgetAlertEmail(undefined), /required/);
    assert.throws(() => parseBudgetAlertEmail("not-an-email"), /valid email/);
  });

  it("requires a safe stage-appropriate application origin", () => {
    assert.equal(
      parseWebOrigin("https://studio.opengeo.tools/", "production"),
      PRODUCTION_STUDIO_ORIGIN
    );
    assert.equal(parseWebOrigin("http://localhost:3000", "dev"), "http://localhost:3000");
    assert.throws(() => parseWebOrigin(undefined, "dev"), /required/);
    assert.throws(() => parseWebOrigin("http://maps.example.com", "dev"), /HTTPS/);
    assert.throws(() => parseWebOrigin("http://localhost:3000", "production"), /HTTPS/);
    assert.throws(() => parseWebOrigin("https://opengeo.tools", "production"), /studio\.opengeo\.tools/);
    assert.throws(() => parseWebOrigin("https://maps.example.com/callback", "production"), /path/);
    assert.throws(() => parseWebOrigin("https://user@maps.example.com", "production"), /credentials/);
  });

  it("accepts complete optional federation references and rejects partial or secret-like input", () => {
    const federation = parseFederationConfig({
      OPEN_GEO_GOOGLE_CLIENT_ID: "123456789-abc123.apps.googleusercontent.com",
      OPEN_GEO_GOOGLE_CLIENT_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/google-AbCd",
      OPEN_GEO_ENTRA_TENANT_ID: "10000000-0000-4000-8000-000000000001",
      OPEN_GEO_ENTRA_CLIENT_ID: "20000000-0000-4000-8000-000000000001",
      OPEN_GEO_ENTRA_CLIENT_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/entra-AbCd"
    });
    assert.equal(federation.google?.clientId, "123456789-abc123.apps.googleusercontent.com");
    assert.equal(federation.entra?.tenantId, "10000000-0000-4000-8000-000000000001");
    assert.throws(() => parseFederationConfig({OPEN_GEO_GOOGLE_CLIENT_ID: "partial"}), /supplied together/);
    assert.throws(() => parseFederationConfig({
      OPEN_GEO_GOOGLE_CLIENT_ID: "123456789-abc123.apps.googleusercontent.com",
      OPEN_GEO_GOOGLE_CLIENT_SECRET_ARN: "plaintext-client-secret"
    }), /secret ARN is invalid/);
  });
});
