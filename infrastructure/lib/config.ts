export const STAGES = ["dev", "staging", "demo", "production"] as const;
export const PRODUCTION_STUDIO_ORIGIN = "https://studio.opengeo.tools";
export const DEMO_STUDIO_ORIGIN = "https://demo.studio.opengeo.tools";
export const SHARED_AUTH_ACCOUNT_ID = "111111111111";

export type Stage = (typeof STAGES)[number];

export interface GoogleFederationConfig {
  readonly clientId: string;
  readonly clientSecretArn: string;
}

export interface EntraFederationConfig {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecretArn: string;
}

export interface FederationConfig {
  readonly google?: GoogleFederationConfig;
  readonly entra?: EntraFederationConfig;
}

export interface SharedAuthConfig {
  readonly accountId: typeof SHARED_AUTH_ACCOUNT_ID;
  readonly region: "us-east-1";
  readonly userPoolId: "us-east-1_KXUwaZnuQ";
  readonly hostedUiBaseUrl: "https://auth.categori.se";
}

export interface StorageBucketConfig {
  readonly application: string;
  readonly data: string;
}

export interface EnvironmentConfig {
  readonly stage: Stage;
  readonly production: boolean;
  readonly deletionProtection: boolean;
  readonly databaseBackupDays: number;
  readonly databaseMaxAcu: number;
  readonly databaseReaderCount: 0 | 1;
  readonly databaseAutoPauseMinutes: number;
  readonly workerMaxTasks: number;
  readonly containerInsights: boolean;
  readonly monthlyBudgetUsd: number;
  readonly auroraPostgresVersion: string;
  readonly logRetentionDays: 30 | 90 | 365;
  readonly allowedWebOrigins: readonly string[];
  readonly webOrigin: string;
  readonly federation: FederationConfig;
  readonly sharedAuth: SharedAuthConfig;
  readonly storageBuckets: StorageBucketConfig;
}

export function parseStage(value: unknown): Stage {
  if (typeof value !== "string" || !STAGES.includes(value as Stage)) {
    throw new Error(
      `Invalid stage ${JSON.stringify(value)}; expected one of ${STAGES.join(", ")}`
    );
  }

  return value as Stage;
}

export function environmentConfig(
  stage: Stage,
  webOrigin: string,
  federation: FederationConfig = {},
  storageBuckets: StorageBucketConfig = storageBucketNames(stage)
): EnvironmentConfig {
  const demo = stage === "demo";
  const production = stage === "production" || demo;
  const staging = stage === "staging";

  return {
    stage,
    production,
    deletionProtection: production,
    databaseBackupDays: stage === "production" ? 30 : staging || demo ? 14 : 7,
    databaseMaxAcu: stage === "production" ? 16 : staging ? 4 : 2,
    databaseReaderCount: stage === "production" ? 1 : 0,
    databaseAutoPauseMinutes: 5,
    // Demo shares production's data protections, not its processing capacity.
    workerMaxTasks: stage === "production" ? 20 : 2,
    containerInsights: stage !== "dev",
    monthlyBudgetUsd: stage === "production" || demo ? 100 : staging ? 250 : 125,
    auroraPostgresVersion: "16.13",
    logRetentionDays: stage === "production" ? 365 : staging || demo ? 90 : 30,
    webOrigin,
    federation,
    sharedAuth: {
      accountId: SHARED_AUTH_ACCOUNT_ID,
      region: "us-east-1",
      userPoolId: "us-east-1_KXUwaZnuQ",
      hostedUiBaseUrl: "https://auth.categori.se"
    },
    storageBuckets,
    allowedWebOrigins:
      stage === "dev"
        ? [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
            "http://127.0.0.1:5173"
          ]
        : [webOrigin]
  };
}

/** A bounded processing window may lower, but never raise, the stage ceiling. */
export function parseWorkerMaxTasks(value: unknown, stageMaximum: number): number {
  if (value === undefined) return stageMaximum;
  const maximum = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > stageMaximum) {
    throw new Error(`workerMaxTasks must be an integer from 1 to ${stageMaximum}`);
  }
  return maximum;
}

export function storageBucketNames(stage: Stage): StorageBucketConfig {
  const qualifier = stage === "production" ? "" : `${stage}.`;
  return {
    application: `${qualifier}source.opengeo.tools`,
    data: `${qualifier}storage.opengeo.tools`
  };
}

export function parseStorageBucketConfig(
  applicationValue: unknown,
  dataValue: unknown,
  stage: Stage
): StorageBucketConfig {
  if (applicationValue === undefined && dataValue === undefined) {
    return storageBucketNames(stage);
  }
  if (applicationValue === undefined || dataValue === undefined) {
    throw new Error("application and managed-data bucket names must be supplied together");
  }
  const application = bucketName(applicationValue, "application bucket");
  const data = bucketName(dataValue, "managed-data bucket");
  if (application === data) {
    throw new Error("application and managed-data buckets must be different");
  }
  return {application, data};
}

function bucketName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 63) {
    throw new Error(`${label} must be a 3-63 character S3 bucket name`);
  }
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value)
    || value.includes("..") || value.includes(".-") || value.includes("-.")) {
    throw new Error(`${label} is not a valid DNS-compatible S3 bucket name`);
  }
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value)) {
    throw new Error(`${label} must not be formatted as an IP address`);
  }
  return value;
}

export function parseFederationConfig(values: Record<string, string | undefined>): FederationConfig {
  const googleValues = [values.OPEN_GEO_GOOGLE_CLIENT_ID, values.OPEN_GEO_GOOGLE_CLIENT_SECRET_ARN];
  const entraValues = [
    values.OPEN_GEO_ENTRA_TENANT_ID,
    values.OPEN_GEO_ENTRA_CLIENT_ID,
    values.OPEN_GEO_ENTRA_CLIENT_SECRET_ARN
  ];
  requireCompleteGroup("Google federation", googleValues);
  requireCompleteGroup("Microsoft Entra federation", entraValues);

  const google = googleValues.every(Boolean) ? {
    clientId: googleClientId(googleValues[0]),
    clientSecretArn: secretArn(googleValues[1], "Google client secret ARN")
  } : undefined;
  const entra = entraValues.every(Boolean) ? {
    tenantId: uuid(entraValues[0], "Microsoft Entra tenant id"),
    clientId: uuid(entraValues[1], "Microsoft Entra client id"),
    clientSecretArn: secretArn(entraValues[2], "Microsoft Entra client secret ARN")
  } : undefined;
  return {...(google ? {google} : {}), ...(entra ? {entra} : {})};
}

export function parseWebOrigin(value: unknown, stage: Stage): string {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n]/.test(value)) {
    throw new Error("application web origin is required");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("application web origin must be an absolute URL");
  }

  const loopbackDev = stage === "dev" && url.protocol === "http:" && url.hostname === "localhost";
  if (url.protocol !== "https:" && !loopbackDev) {
    throw new Error("application web origin must use HTTPS except localhost in dev");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("application web origin must not contain credentials, a path, query, or fragment");
  }
  const origin = url.origin;
  if (stage === "production" && origin !== PRODUCTION_STUDIO_ORIGIN) {
    throw new Error(`production application web origin must be ${PRODUCTION_STUDIO_ORIGIN}`);
  }
  if (stage === "demo" && origin !== DEMO_STUDIO_ORIGIN) {
    throw new Error(`demo application web origin must be ${DEMO_STUDIO_ORIGIN}`);
  }
  return origin;
}

function requireCompleteGroup(label: string, values: readonly (string | undefined)[]): void {
  const supplied = values.filter(Boolean).length;
  if (supplied !== 0 && supplied !== values.length) throw new Error(`${label} configuration must be supplied together`);
}

function googleClientId(value: string | undefined): string {
  if (!value || value.length > 512 || !/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(value)) {
    throw new Error("Google client id is invalid");
  }
  return value;
}

function uuid(value: string | undefined, label: string): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function secretArn(value: string | undefined, label: string): string {
  if (!value || value.length > 2048
    || !/^arn:(?:aws|aws-us-gov|aws-cn):secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function parseImageTagOrDigest(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("API image must be an immutable sha256 digest");
  }

  const digest = /^sha256:[a-f0-9]{64}$/;
  if (!digest.test(value)) {
    throw new Error("API image must be an immutable sha256 digest");
  }

  return value;
}

export function parseObservableBuilderImageDigest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("Observable builder image must be an immutable sha256 digest");
  }
  return value;
}

export function parseUserPoolClientId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9]{1,128}$/.test(value)) {
    throw new Error("Cognito user-pool client id is invalid");
  }

  return value;
}

export function parseAdditionalUserPoolClientIds(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("additional Cognito user-pool client ids are invalid");
  }
  const clientIds = value.split(",");
  if (clientIds.length < 1
    || clientIds.length > 3
    || clientIds.some((clientId) => !/^[a-z0-9]{1,128}$/.test(clientId))
    || new Set(clientIds).size !== clientIds.length) {
    throw new Error(
      "additional Cognito user-pool client ids must be 1 to 3 unique exact ids"
    );
  }
  return clientIds.join(",");
}

export function parseBudgetAlertEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254) {
    throw new Error("budget alert email is required");
  }

  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email.test(value) || /[\r\n]/.test(value)) {
    throw new Error("budget alert email must be a valid email address");
  }

  return value;
}
