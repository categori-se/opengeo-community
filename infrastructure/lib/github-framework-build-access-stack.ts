import {CfnOutput, Stack, type StackProps, aws_iam as iam} from "aws-cdk-lib";
import type {Construct} from "constructs";

export const GITHUB_BUILD_SUBJECT = "repo:categorise@244207254/opengeo@1346674875:environment:studio-framework-build";
const MANAGED_REPOSITORY = {fullName: "categorise/opengeo", id: 1346674875, ownerId: 244207254, private: true};
const MANAGED_STORAGE = {
  applicationBucketName: "source.opengeo.tools",
  kmsKeyArn: "arn:aws:kms:us-east-1:111111111111:key/433aed9d-8ae9-4e03-b75f-630668857b8e"
};

export interface GitHubBuildRepository {
  readonly fullName: string;
  readonly id: number;
  readonly ownerId: number;
  readonly private: boolean;
}

export interface GitHubBuildStorageBoundary {
  readonly applicationBucketName: string;
  readonly kmsKeyArn: string;
}

export interface IndependentGitHubBuildDeployment extends GitHubBuildStorageBoundary {
  readonly resourceNamePrefix: string;
  readonly archiveBucketName: string;
  readonly databaseClusterArn: string;
  readonly repository: GitHubBuildRepository;
}

function closedObject(value: unknown, keys: readonly string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function independentBucket(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 63 &&
    !/[\u0000-\u0020\u007f]/.test(value) &&
    /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(value) && !/\.\.|\.-|-\./.test(value) &&
    !/^\d+\.\d+\.\d+\.\d+$/.test(value) &&
    !/^(?:xn--|sthree-|amzn-s3-demo-)/.test(value) && !/(?:-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(value) &&
    value !== "opengeo.tools" && !value.endsWith(".opengeo.tools");
}

function validateStorageBoundary(storage: GitHubBuildStorageBoundary): void {
  if (!closedObject(storage, ["applicationBucketName", "kmsKeyArn"]) ||
      !independentBucket(storage.applicationBucketName) ||
      typeof storage.kmsKeyArn !== "string" || /[\u0000-\u0020\u007f]/.test(storage.kmsKeyArn) ||
      !/^arn:aws:kms:us-east-1:[0-9]{12}:key\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(storage.kmsKeyArn)) {
    throw new Error("Invalid independent GitHub build storage boundary");
  }
}

/** Exact immutable repository identity; names alone cannot authorize a renamed repository. */
export function githubBuildSubject(repository: GitHubBuildRepository = MANAGED_REPOSITORY): string {
  if (!closedObject(repository, ["fullName", "id", "ownerId", "private"]) ||
      typeof repository.fullName !== "string" ||
      /[\u0000-\u0020\u007f]/.test(repository.fullName) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/.test(repository.fullName) ||
      !Number.isSafeInteger(repository.id) || repository.id < 1 ||
      !Number.isSafeInteger(repository.ownerId) || repository.ownerId < 1 || typeof repository.private !== "boolean") {
    throw new Error("Invalid GitHub build repository identity");
  }
  const [owner, name] = repository.fullName.split("/");
  return `repo:${owner}@${repository.ownerId}/${name}@${repository.id}:environment:studio-framework-build`;
}

function validateIndependentDeployment(deployment: IndependentGitHubBuildDeployment, account: string, region: string): void {
  if (!closedObject(deployment, ["resourceNamePrefix", "applicationBucketName", "archiveBucketName", "databaseClusterArn", "kmsKeyArn", "repository"]) ||
      !/^[0-9]{12}$/.test(account) || region !== "us-east-1" ||
      typeof deployment.resourceNamePrefix !== "string" ||
      /[\u0000-\u0020\u007f]/.test(deployment.resourceNamePrefix) ||
      !/^[a-z](?:[a-z0-9-]{0,39}[a-z0-9])?$/.test(deployment.resourceNamePrefix) ||
      !independentBucket(deployment.archiveBucketName) || deployment.archiveBucketName === deployment.applicationBucketName ||
      typeof deployment.databaseClusterArn !== "string" || /[\u0000-\u0020\u007f]/.test(deployment.databaseClusterArn) ||
      !new RegExp(`^arn:aws:rds:us-east-1:${account}:cluster:[A-Za-z][A-Za-z0-9-]{0,62}$`).test(deployment.databaseClusterArn) ||
      typeof deployment.kmsKeyArn !== "string" || !deployment.kmsKeyArn.startsWith(`arn:aws:kms:us-east-1:${account}:key/`)) {
    throw new Error("Invalid independent GitHub build deployment");
  }
  validateStorageBoundary({applicationBucketName: deployment.applicationBucketName, kmsKeyArn: deployment.kmsKeyArn});
  githubBuildSubject(deployment.repository);
}

export interface PageCacheAccountGrant {
  readonly organizationId: string;
  readonly compilerImageDigests: readonly string[];
}

/** Trusted-host ceiling, not admission: DB quota and exact claim checks still apply. */
export function accountPageCachePolicy(accounts: readonly PageCacheAccountGrant[], storage?: GitHubBuildStorageBoundary) {
  if (storage !== undefined) validateStorageBoundary(storage);
  const boundary = storage ?? MANAGED_STORAGE;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (!Array.isArray(accounts) || accounts.length < 1 || accounts.length > 12 ||
      new Set(accounts.map(account => account.organizationId)).size !== accounts.length) {
    throw new Error("Invalid account cache grants");
  }
  const resources = accounts.flatMap(account => {
    if (!uuid.test(account.organizationId) || !Array.isArray(account.compilerImageDigests) ||
        account.compilerImageDigests.length < 1 || account.compilerImageDigests.length > 2 ||
        new Set(account.compilerImageDigests).size !== account.compilerImageDigests.length ||
        account.compilerImageDigests.some((digest: unknown) => typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(digest))) {
      throw new Error("Invalid account cache grants");
    }
    return account.compilerImageDigests.map((digest: string) =>
      `arn:aws:s3:::${boundary.applicationBucketName}/compiler-cache/pages/v1/organizations/${account.organizationId}/` +
      `projects/*/source-projects/*/${digest.slice(7)}/pages.json`);
  }).sort();
  const policy = {Version: "2012-10-17", Statement: [
    {Effect: "Allow", Action: ["s3:GetObject"], Resource: resources},
    {Effect: "Allow", Action: ["s3:PutObject"], Resource: resources, Condition: {StringEquals: {
      "s3:x-amz-server-side-encryption": "aws:kms",
      "s3:x-amz-server-side-encryption-aws-kms-key-id": boundary.kmsKeyArn
    }}}
  ]};
  if (JSON.stringify(policy).length > 4096) throw new Error("Account cache policy exceeds reviewed size bound");
  return policy;
}

/** Account-bounded retained input reads; the live lease API still authorizes every pin. */
export function artifactInputReadPolicy(organizationIds: readonly string[], storage?: GitHubBuildStorageBoundary) {
  if (storage !== undefined) validateStorageBoundary(storage);
  const boundary = storage ?? MANAGED_STORAGE;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  if (!Array.isArray(organizationIds) || organizationIds.length < 1 || organizationIds.length > 12 ||
      new Set(organizationIds).size !== organizationIds.length ||
      organizationIds.some(id => typeof id !== "string" || !uuid.test(id))) {
    throw new Error("Invalid Artifact input account grants");
  }
  return {Version: "2012-10-17", Statement: [{Effect: "Allow", Action: ["s3:GetObjectVersion"],
    Resource: [...organizationIds].sort().map(id =>
      `arn:aws:s3:::${boundary.applicationBucketName}/organizations/${id}/projects/*/artifacts/*/uploads/*/map.html`)
  }]};
}

/** Read-only GitHub evidence required before enabling the environment-based trust. */
export function verifyGitHubBuildTrust(evidence: {
  repository: any; oidc: any; environment: any; policies: any; ref: any;
}, runtimeSha: string, repository: GitHubBuildRepository = MANAGED_REPOSITORY): void {
  const subject = githubBuildSubject(repository);
  if (typeof runtimeSha !== "string" || runtimeSha.length !== 40 || !/^[0-9a-f]{40}$/.test(runtimeSha) ||
      evidence.repository?.id !== repository.id || evidence.repository?.owner?.id !== repository.ownerId ||
      evidence.repository?.full_name !== repository.fullName || evidence.repository?.private !== repository.private ||
      evidence.repository?.archived !== false || evidence.repository?.disabled !== false ||
      evidence.oidc?.use_default !== true || evidence.oidc?.use_immutable_subject !== true ||
      evidence.oidc?.sub_claim_prefix !== subject.slice(0, -":environment:studio-framework-build".length) ||
      evidence.environment?.name !== "studio-framework-build" ||
      evidence.environment?.deployment_branch_policy?.protected_branches !== false ||
      evidence.environment?.deployment_branch_policy?.custom_branch_policies !== true ||
      evidence.policies?.total_count !== 1 || evidence.policies?.branch_policies?.length !== 1 ||
      evidence.policies.branch_policies[0]?.type !== "branch" ||
      evidence.policies.branch_policies[0]?.name !== `studio-runtime-${runtimeSha}` ||
      evidence.ref?.ref !== `refs/heads/studio-runtime-${runtimeSha}` ||
      evidence.ref?.object?.type !== "commit" || evidence.ref?.object?.sha !== runtimeSha) {
    throw new Error("GitHub build trust requires the configured numeric repository, immutable subject and one exact runtime branch");
  }
}

export interface GitHubFrameworkBuildAccessStackProps extends StackProps {
  readonly coordinatorSecretArn: string;
  readonly compilerRepositoryArn: string;
  readonly enabled?: boolean;
  readonly runtimeSha?: string;
  readonly githubEvidence?: Parameters<typeof verifyGitHubBuildTrust>[0];
  readonly pageCacheAccounts?: readonly PageCacheAccountGrant[];
  readonly artifactInputOrganizations?: readonly string[];
  readonly independentDeployment?: IndependentGitHubBuildDeployment;
}

/** IAM only. Existing resources are referenced, never reconstructed. */
export class GitHubFrameworkBuildAccessStack extends Stack {
  constructor(scope: Construct, id: string, props: GitHubFrameworkBuildAccessStackProps) {
    super(scope, id, props);
    const independent = props.independentDeployment;
    if (independent !== undefined) {
      validateIndependentDeployment(independent, this.account, this.region);
      const repositoryPrefix = `arn:aws:ecr:us-east-1:${this.account}:repository/`;
      const repositoryName = typeof props.compilerRepositoryArn === "string" && props.compilerRepositoryArn.startsWith(repositoryPrefix)
        ? props.compilerRepositoryArn.slice(repositoryPrefix.length) : "";
      if (typeof props.coordinatorSecretArn !== "string" || /[\u0000-\u0020\u007f]/.test(props.coordinatorSecretArn) ||
          !new RegExp(`^arn:aws:secretsmanager:us-east-1:${this.account}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$`).test(props.coordinatorSecretArn) ||
          /[\u0000-\u0020\u007f]/.test(repositoryName) || repositoryName.length < 2 || repositoryName.length > 256 ||
          !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(repositoryName)) {
        throw new Error("Use a complete same-account dedicated build database secret and compiler repository");
      }
    } else if (this.account !== "111111111111" || this.region !== "us-east-1" ||
        !/^arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo\/production\/github-build-database-[A-Za-z0-9]{6}$/.test(props.coordinatorSecretArn) ||
        props.compilerRepositoryArn !== "arn:aws:ecr:us-east-1:111111111111:repository/opengeo/production/observable-builder") {
      throw new Error("Use the dedicated production build database secret and compiler repository");
    }
    if (props.enabled) {
      if (!props.githubEvidence || !props.runtimeSha) throw new Error("Live GitHub trust evidence required");
      verifyGitHubBuildTrust(props.githubEvidence, props.runtimeSha, independent?.repository);
    }
    if (props.artifactInputOrganizations !== undefined && !Array.isArray(props.artifactInputOrganizations)) {
      throw new Error("Invalid Artifact input account grants");
    }
    const source = `arn:aws:s3:::${independent?.applicationBucketName ?? MANAGED_STORAGE.applicationBucketName}`;
    const archive = `arn:aws:s3:::${independent?.archiveBucketName ?? "storage.opengeo.tools"}`;
    const key = independent?.kmsKeyArn ?? MANAGED_STORAGE.kmsKeyArn;
    const storage = independent === undefined ? undefined : {applicationBucketName: independent.applicationBucketName, kmsKeyArn: key};
    const cluster = independent?.databaseClusterArn ?? "arn:aws:rds:us-east-1:111111111111:cluster:opengeo-production-foundation-databaseb269d8bb-fdwblaqwxbv0";
    const allow = (Action: string[], Resource: string | string[], Condition?: object) => ({
      Effect: "Allow", Action, Resource, ...(Condition ? {Condition} : {})
    });
    const role = new iam.CfnRole(this, "BuildRole", {
      roleName: independent ? `${independent.resourceNamePrefix}-github-framework-build` : "opengeo-production-github-framework-build",
      description: "Ephemeral GitHub Framework builds; no public deployment or App credential access",
      maxSessionDuration: 3600,
      assumeRolePolicyDocument: {Version: "2012-10-17", Statement: [{
        Effect: props.enabled ? "Allow" : "Deny",
        Principal: {Federated: `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`},
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {StringEquals: {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": githubBuildSubject(independent?.repository)
        }}
      }]},
      policies: [{policyName: "ExactFrameworkBuildInputsAndOutputs", policyDocument: {
        Version: "2012-10-17", Statement: [
          allow(["rds-data:ExecuteStatement"], cluster),
          allow(["secretsmanager:GetSecretValue"], props.coordinatorSecretArn),
          allow(["kms:Decrypt"], key, {StringEquals: {"kms:ViaService": "secretsmanager.us-east-1.amazonaws.com", "kms:EncryptionContext:SecretARN": props.coordinatorSecretArn}}),
          allow(["s3:GetObjectVersion"], `${source}/organizations/*/projects/*/source-projects/*/uploads/*/files/*`),
          allow(["s3:GetObject", "s3:PutObject"], `${source}/organizations/*/projects/*/source-projects/*/builds/*/output/*`),
          allow(["s3:GetObjectVersion"], [
            `${archive}/organizations/*/projects/*/datasets/*/uploads/*/original/*`,
            `${archive}/organizations/*/projects/*/datasets/*/versions/*/derivatives/*`
          ]),
          allow(["kms:Decrypt"], key, {StringEquals: {"kms:ViaService": "s3.us-east-1.amazonaws.com", "kms:EncryptionContext:aws:s3:arn": archive}}),
          allow(["kms:Decrypt", "kms:GenerateDataKey"], key, {StringEquals: {"kms:ViaService": "s3.us-east-1.amazonaws.com", "kms:EncryptionContext:aws:s3:arn": source}}),
          allow(["ecr:GetAuthorizationToken"], "*"),
          allow(["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], props.compilerRepositoryArn)
        ]
      }}, ...(props.pageCacheAccounts?.length ? [{policyName: "AccountAdmittedPageCaches",
        policyDocument: accountPageCachePolicy(props.pageCacheAccounts, storage)}] : []),
        ...(props.artifactInputOrganizations?.length ? [{policyName: "AccountArtifactInputs",
          policyDocument: artifactInputReadPolicy(props.artifactInputOrganizations, storage)}] : [])]
    });
    new CfnOutput(this, "BuildRoleArn", {value: role.attrArn});
    new CfnOutput(this, "TrustEnabled", {value: props.enabled ? "true" : "false"});
  }
}
