import assert from "node:assert/strict";
import {test} from "node:test";
import {App} from "aws-cdk-lib";
import {Template} from "aws-cdk-lib/assertions";
import {GitHubFrameworkBuildAccessStack, GITHUB_BUILD_SUBJECT, githubBuildSubject, verifyGitHubBuildTrust, accountPageCachePolicy, artifactInputReadPolicy, type IndependentGitHubBuildDeployment} from "../lib/github-framework-build-access-stack.js";

const sha = "a".repeat(40);
test('account cache grants pin organizations, compiler digests, leaf names and encryption', () => {
  const organizationId='10000000-0000-4000-8000-000000000001';
  const digest=`sha256:${'a'.repeat(64)}`;
  const grants=[{organizationId,compilerImageDigests:[digest]}];
  const policy=accountPageCachePolicy(grants);
  assert.deepEqual(policy.Statement.flatMap(s=>s.Action),['s3:GetObject','s3:PutObject']);
  for(const statement of policy.Statement) assert.deepEqual(statement.Resource,[
    `arn:aws:s3:::source.opengeo.tools/compiler-cache/pages/v1/organizations/${organizationId}/projects/*/source-projects/*/${'a'.repeat(64)}/pages.json`
  ]);
  assert.equal(policy.Statement[1]!.Condition?.StringEquals['s3:x-amz-server-side-encryption'],'aws:kms');
  for(const invalid of [[],[...grants,...grants],[{...grants[0]!,organizationId:'*'}],
    [{...grants[0]!,compilerImageDigests:['*']}],[{...grants[0]!,compilerImageDigests:[digest,digest]}],
    [{...grants[0]!,organizationId:'../other'}]]) assert.throws(()=>accountPageCachePolicy(invalid),/cache grants/);
  assert.doesNotMatch(JSON.stringify(policy),/DeleteObject|ListBucket|GetObjectVersion|organizations\/\*/);
});
const evidence = {
  repository: {id: 1346674875, owner: {id: 244207254}, full_name: "categorise/opengeo", private: true, archived: false, disabled: false},
  oidc: {use_default: true, use_immutable_subject: true, sub_claim_prefix: "repo:categorise@244207254/opengeo@1346674875"},
  environment: {name: "studio-framework-build", deployment_branch_policy: {protected_branches: false, custom_branch_policies: true}},
  policies: {total_count: 1, branch_policies: [{type: "branch", name: `studio-runtime-${sha}`}]},
  ref: {ref: `refs/heads/studio-runtime-${sha}`, object: {type: "commit", sha}}
};

test("build role is IAM-only, denies assumption by default and excludes publication authority", () => {
  for (const enabled of [false, true]) {
    const stack = new GitHubFrameworkBuildAccessStack(new App(), "BuildAccess", {
      env: {account: "111111111111", region: "us-east-1"}, enabled, runtimeSha: sha, githubEvidence: evidence,
      coordinatorSecretArn: "arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/production/github-build-database-AbCd12",
      compilerRepositoryArn: "arn:aws:ecr:us-east-1:111111111111:repository/opengeo/production/observable-builder"
    });
    const resources = Template.fromStack(stack).toJSON().Resources;
    assert.equal(Object.keys(resources).length, 1);
    const role = Object.values(resources)[0] as any;
    assert.equal(role.Type, "AWS::IAM::Role");
    const trust = role.Properties.AssumeRolePolicyDocument.Statement[0];
    assert.equal(trust.Effect, enabled ? "Allow" : "Deny");
    assert.equal(trust.Condition.StringEquals["token.actions.githubusercontent.com:sub"], GITHUB_BUILD_SUBJECT);
    assert.doesNotMatch(JSON.stringify(role.Properties.Policies), /cloudfront:|s3:Delete|iam:PassRole|github-publication-app|RuntimeDatabaseSecret|arn:aws:s3:::opengeo.tools/);
  }
});

test("trust refuses wildcard branches, tags, mutable subjects and mismatched runtime commits", () => {
  verifyGitHubBuildTrust(evidence, sha);
  for (const patch of [
    {policies: {total_count: 1, branch_policies: [{type: "branch", name: "studio-runtime-*"}]}},
    {policies: {total_count: 1, branch_policies: [{type: "tag", name: `studio-runtime-${sha}`}]}},
    {oidc: {...evidence.oidc, use_immutable_subject: false}},
    {ref: {...evidence.ref, object: {type: "commit", sha: "b".repeat(40)}}}
  ]) assert.throws(() => verifyGitHubBuildTrust({...evidence, ...patch}, sha), /GitHub build trust/);
});

test('account caching is opt-in and adds no service, trust or publication permission', () => {
  const props={env:{account:'111111111111',region:'us-east-1'},enabled:true,runtimeSha:sha,githubEvidence:evidence,
    coordinatorSecretArn:'arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/production/github-build-database-AbCd12',
    compilerRepositoryArn:'arn:aws:ecr:us-east-1:111111111111:repository/opengeo/production/observable-builder'};
  const baseline=Template.fromStack(new GitHubFrameworkBuildAccessStack(new App(),'Baseline',props)).toJSON();
  const account={organizationId:'10000000-0000-4000-8000-000000000001',compilerImageDigests:[`sha256:${'a'.repeat(64)}`]};
  const enabled=Template.fromStack(new GitHubFrameworkBuildAccessStack(new App(),'Enabled',{...props,pageCacheAccounts:[account]})).toJSON();
  assert.deepEqual(Object.keys(enabled.Resources),Object.keys(baseline.Resources));
  const before=(Object.values(baseline.Resources)[0] as any).Properties;
  const after=(Object.values(enabled.Resources)[0] as any).Properties;
  assert.equal(after.Policies.length,before.Policies.length+1);
  assert.deepEqual(after.Policies.at(-1),{PolicyName:'AccountAdmittedPageCaches',PolicyDocument:accountPageCachePolicy([account])});
  after.Policies.pop();
  assert.deepEqual(after,before);
});


test('Artifact reads are opt-in, account-scoped and immutable-version only', () => {
  const organizationId = '10000000-0000-4000-8000-000000000001';
  const props = {env:{account:'111111111111',region:'us-east-1'},
    coordinatorSecretArn:'arn:aws:secretsmanager:us-east-1:111111111111:secret:opengeo/production/github-build-database-AbCd12',
    compilerRepositoryArn:'arn:aws:ecr:us-east-1:111111111111:repository/opengeo/production/observable-builder'};
  for (const enabled of [false,true]) {
    const stack = new GitHubFrameworkBuildAccessStack(new App(), 'ArtifactInputs', {
      ...props, ...(enabled ? {artifactInputOrganizations:[organizationId]} : {})
    });
    const resources = Template.fromStack(stack).toJSON().Resources;
    assert.equal(Object.keys(resources).length,1);
    const role = Object.values(resources)[0] as any;
    const policy = role.Properties.Policies.find((item:any)=>item.PolicyName==='AccountArtifactInputs');
    assert.equal(Boolean(policy),enabled);
    if (policy) assert.deepEqual(policy.PolicyDocument, artifactInputReadPolicy([organizationId]));
    assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Effect,'Deny');
  }
  const policy = artifactInputReadPolicy([organizationId]);
  assert.deepEqual(policy.Statement[0]!.Action,['s3:GetObjectVersion']);
  assert.deepEqual(policy.Statement[0]!.Resource,[`arn:aws:s3:::source.opengeo.tools/organizations/${organizationId}/projects/*/artifacts/*/uploads/*/map.html`]);
  for (const invalid of [[],['*'],['../other'],[organizationId,organizationId],Array(13).fill(organizationId)]) {
    assert.throws(()=>artifactInputReadPolicy(invalid),/Artifact input account grants/);
  }
});

const independent = {
  resourceNamePrefix: "og-independent",
  applicationBucketName: "independent-333333333333-app",
  archiveBucketName: "independent-333333333333-data",
  databaseClusterArn: "arn:aws:rds:us-east-1:333333333333:cluster:independent-database",
  kmsKeyArn: "arn:aws:kms:us-east-1:333333333333:key/11111111-2222-4333-8444-555555555555",
  repository: {fullName: "independent-owner/runtime", id: 12345, ownerId: 67890, private: false}
};
const independentProps = {
  env: {account: "333333333333", region: "us-east-1"},
  coordinatorSecretArn: "arn:aws:secretsmanager:us-east-1:333333333333:secret:independent/build-database-AbCd12",
  compilerRepositoryArn: "arn:aws:ecr:us-east-1:333333333333:repository/opengeo/dev/observable-builder",
  independentDeployment: independent
};
const independentEvidence = {
  ...evidence,
  repository: {id: independent.repository.id, owner: {id: independent.repository.ownerId},
    full_name: independent.repository.fullName, private: false, archived: false, disabled: false},
  oidc: {...evidence.oidc, sub_claim_prefix: "repo:independent-owner@67890/runtime@12345"}
};

test("independent IAM binds only its own storage, database, images and immutable repository", () => {
  assert.equal(githubBuildSubject(), GITHUB_BUILD_SUBJECT);
  assert.equal(githubBuildSubject(independent.repository), "repo:independent-owner@67890/runtime@12345:environment:studio-framework-build");
  assert.equal(githubBuildSubject({...independent.repository, fullName: "independent-owner/.github"}),
    "repo:independent-owner@67890/.github@12345:environment:studio-framework-build");
  assert.equal(githubBuildSubject({...independent.repository, fullName: "independent-owner/_runtime"}),
    "repo:independent-owner@67890/_runtime@12345:environment:studio-framework-build");
  for (const enabled of [false, true]) {
    const template = Template.fromStack(new GitHubFrameworkBuildAccessStack(new App(), "Independent", {
      ...independentProps, enabled, runtimeSha: sha, githubEvidence: independentEvidence
    })).toJSON();
    assert.equal(Object.keys(template.Resources).length, 1, "References create only the build IAM role");
    const role = Object.values(template.Resources)[0] as any;
    assert.equal(role.Type, "AWS::IAM::Role");
    assert.equal(role.Properties.RoleName, "og-independent-github-framework-build");
    assert.equal(role.Properties.MaxSessionDuration, 3600);
    const trust = role.Properties.AssumeRolePolicyDocument.Statement[0];
    assert.equal(trust.Effect, enabled ? "Allow" : "Deny");
    assert.equal(trust.Principal.Federated, "arn:aws:iam::333333333333:oidc-provider/token.actions.githubusercontent.com");
    assert.deepEqual(trust.Condition.StringEquals, {
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
      "token.actions.githubusercontent.com:sub": githubBuildSubject(independent.repository)
    });
    assert.equal(role.Properties.Policies.length, 1, "Cache and Artifact permissions remain opt-in");
    const statements = role.Properties.Policies[0].PolicyDocument.Statement;
    assert.deepEqual(statements.find((item: any) => item.Action.includes("rds-data:ExecuteStatement")).Resource,
      independent.databaseClusterArn);
    assert.deepEqual(statements.find((item: any) => item.Action.includes("secretsmanager:GetSecretValue")).Resource,
      independentProps.coordinatorSecretArn);
    assert.deepEqual(statements.find((item: any) => item.Action.includes("ecr:BatchGetImage")).Resource,
      independentProps.compilerRepositoryArn);
    const sourceArn = `arn:aws:s3:::${independent.applicationBucketName}`;
    const archiveArn = `arn:aws:s3:::${independent.archiveBucketName}`;
    assert.deepEqual(statements.filter((item: any) => item.Action.includes("kms:Decrypt")).map((item: any) => [item.Resource, item.Condition]), [
      [independent.kmsKeyArn, {StringEquals: {"kms:ViaService": "secretsmanager.us-east-1.amazonaws.com",
        "kms:EncryptionContext:SecretARN": independentProps.coordinatorSecretArn}}],
      [independent.kmsKeyArn, {StringEquals: {"kms:ViaService": "s3.us-east-1.amazonaws.com", "kms:EncryptionContext:aws:s3:arn": archiveArn}}],
      [independent.kmsKeyArn, {StringEquals: {"kms:ViaService": "s3.us-east-1.amazonaws.com", "kms:EncryptionContext:aws:s3:arn": sourceArn}}]
    ]);
    assert.deepEqual(statements.filter((item: any) => item.Action.some((action: string) => action.startsWith("s3:"))).map((item: any) => item.Resource), [
      `${sourceArn}/organizations/*/projects/*/source-projects/*/uploads/*/files/*`,
      `${sourceArn}/organizations/*/projects/*/source-projects/*/builds/*/output/*`,
      [`${archiveArn}/organizations/*/projects/*/datasets/*/uploads/*/original/*`,
        `${archiveArn}/organizations/*/projects/*/datasets/*/versions/*/derivatives/*`]
    ]);
    assert.doesNotMatch(JSON.stringify(role.Properties.Policies), /111111111111|opengeo\.tools|cloudfront:|s3:Delete|s3:List|iam:PassRole|github-publication-app|RuntimeDatabaseSecret/);
  }
});

test("independent trust rejects renamed repositories, changed numeric identity and widened branch authority", () => {
  verifyGitHubBuildTrust(independentEvidence, sha, independent.repository);
  assert.throws(() => verifyGitHubBuildTrust(independentEvidence, sha), /GitHub build trust/);
  assert.throws(() => verifyGitHubBuildTrust(independentEvidence, `${sha}\n`, independent.repository), /GitHub build trust/);
  assert.throws(() => new GitHubFrameworkBuildAccessStack(new App(), "NoEvidence", {
    ...independentProps, enabled: true, runtimeSha: sha
  }), /Live GitHub trust evidence required/);
  for (const patch of [
    {repository: {...independentEvidence.repository, id: 54321}},
    {repository: {...independentEvidence.repository, owner: {id: 9876}}},
    {repository: {...independentEvidence.repository, full_name: "independent-owner/renamed"}},
    {repository: {...independentEvidence.repository, private: true}},
    {oidc: {...independentEvidence.oidc, sub_claim_prefix: "repo:independent-owner/runtime"}},
    {oidc: {...independentEvidence.oidc, use_immutable_subject: false}},
    {environment: {...evidence.environment, name: "another-environment"}},
    {policies: {total_count: 1, branch_policies: [{type: "branch", name: "studio-runtime-*"}]}},
    {policies: {total_count: 1, branch_policies: [{type: "tag", name: `studio-runtime-${sha}`}]}},
    {ref: {...evidence.ref, object: {type: "commit", sha: "b".repeat(40)}}}
  ]) assert.throws(() => new GitHubFrameworkBuildAccessStack(new App(), "BadEvidence", {
    ...independentProps, enabled: true, runtimeSha: sha, githubEvidence: {...independentEvidence, ...patch}
  }), /GitHub build trust/);
});

test("independent inputs fail closed for foreign resources, managed custody and open configuration", () => {
  for (const patch of [
    {env: {...independentProps.env, account: "222222222222"}},
    {env: {...independentProps.env, region: "us-west-2"}},
    {coordinatorSecretArn: independentProps.coordinatorSecretArn.replace("333333333333", "222222222222")},
    {coordinatorSecretArn: independentProps.coordinatorSecretArn.replace("-AbCd12", "")},
    {coordinatorSecretArn: `${independentProps.coordinatorSecretArn}\n`},
    {compilerRepositoryArn: independentProps.compilerRepositoryArn.replace("333333333333", "222222222222")},
    {compilerRepositoryArn: `${independentProps.compilerRepositoryArn}:latest`},
    {compilerRepositoryArn: `${independentProps.compilerRepositoryArn}/*`},
    {compilerRepositoryArn: "arn:aws:ecr:us-east-1:333333333333:repository/a"}
  ]) assert.throws(() => new GitHubFrameworkBuildAccessStack(new App(), "InvalidResources", {...independentProps, ...patch}));
  for (const patch of [
    {extra: true},
    {resourceNamePrefix: "x".repeat(42)},
    {resourceNamePrefix: "unbounded*"},
    {resourceNamePrefix: "og-independent\n"},
    {applicationBucketName: "opengeo.tools"},
    {applicationBucketName: "source.opengeo.tools"},
    {archiveBucketName: "storage.opengeo.tools"},
    {archiveBucketName: independent.applicationBucketName},
    {applicationBucketName: "111.222.333.444"},
    {applicationBucketName: "bucket/*"},
    {applicationBucketName: "source.opengeo.tools\n"},
    ...["xn--private", "sthree-private", "amzn-s3-demo-private", "private-s3alias", "private--ol-s3", "private.mrap", "private--x-s3", "private--table-s3"]
      .map(applicationBucketName => ({applicationBucketName})),
    {databaseClusterArn: independent.databaseClusterArn.replace("333333333333", "222222222222")},
    {databaseClusterArn: `${independent.databaseClusterArn}*`},
    {databaseClusterArn: `${independent.databaseClusterArn}\n`},
    {kmsKeyArn: independent.kmsKeyArn.replace("333333333333:key", "222222222222:key")},
    {kmsKeyArn: independent.kmsKeyArn.replace(":key/11111111-2222-4333-8444-555555555555", ":alias/current")},
    {kmsKeyArn: independent.kmsKeyArn.replace("4333-8444", "0333-0444")},
    {repository: {...independent.repository, extra: true}},
    {repository: {...independent.repository, fullName: "owner/*"}},
    ...["owner.name/runtime", "owner_name/runtime", "-owner/runtime", `${"o".repeat(40)}/runtime`, "owner/.", "owner/..", "owner/runtime\n"]
      .map(fullName => ({repository: {...independent.repository, fullName}})),
    {repository: {...independent.repository, id: 0}},
    {repository: {...independent.repository, ownerId: Number.MAX_SAFE_INTEGER + 1}},
    {repository: {...independent.repository, private: undefined}}
  ]) assert.throws(() => new GitHubFrameworkBuildAccessStack(new App(), "InvalidDeployment", {
    ...independentProps, independentDeployment: {...independent, ...patch} as unknown as IndependentGitHubBuildDeployment
  }));
  assert.throws(() => new GitHubFrameworkBuildAccessStack(new App(), "NoIndependentConfiguration", {
    env: independentProps.env, coordinatorSecretArn: independentProps.coordinatorSecretArn,
    compilerRepositoryArn: independentProps.compilerRepositoryArn
  }), /dedicated production/);
});

test("independent optional cache and Artifact grants use only configured private custody", () => {
  const storage = {applicationBucketName: independent.applicationBucketName, kmsKeyArn: independent.kmsKeyArn};
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const digest = `sha256:${"b".repeat(64)}`;
  const grants = [{organizationId, compilerImageDigests: [digest]}];
  const template = Template.fromStack(new GitHubFrameworkBuildAccessStack(new App(), "IndependentOptional", {
    ...independentProps, pageCacheAccounts: grants, artifactInputOrganizations: [organizationId]
  })).toJSON();
  assert.equal(Object.keys(template.Resources).length, 1);
  const role = Object.values(template.Resources)[0] as any;
  assert.equal(role.Properties.AssumeRolePolicyDocument.Statement[0].Effect, "Deny");
  const cache = role.Properties.Policies.find((policy: any) => policy.PolicyName === "AccountAdmittedPageCaches");
  assert.deepEqual(cache.PolicyDocument, accountPageCachePolicy(grants, storage));
  assert.deepEqual(cache.PolicyDocument.Statement[0].Resource,
    [`arn:aws:s3:::${independent.applicationBucketName}/compiler-cache/pages/v1/organizations/${organizationId}/projects/*/source-projects/*/${digest.slice(7)}/pages.json`]);
  assert.equal(cache.PolicyDocument.Statement[1].Condition.StringEquals["s3:x-amz-server-side-encryption-aws-kms-key-id"], independent.kmsKeyArn);
  const artifacts = role.Properties.Policies.find((policy: any) => policy.PolicyName === "AccountArtifactInputs");
  assert.deepEqual(artifacts.PolicyDocument, artifactInputReadPolicy([organizationId], storage));
  assert.deepEqual(artifacts.PolicyDocument.Statement[0], {Effect: "Allow", Action: ["s3:GetObjectVersion"],
    Resource: [`arn:aws:s3:::${independent.applicationBucketName}/organizations/${organizationId}/projects/*/artifacts/*/uploads/*/map.html`]});
  assert.doesNotMatch(JSON.stringify([cache, artifacts]), /111111111111|opengeo\.tools|DeleteObject|ListBucket/);
  for (const invalid of [
    {...storage, applicationBucketName: "source.opengeo.tools"},
    {...storage, applicationBucketName: "private/*"},
    {...storage, kmsKeyArn: "arn:aws:kms:us-east-1:333333333333:alias/current"},
    {...storage, extra: true}
  ]) {
    assert.throws(() => accountPageCachePolicy(grants, invalid), /storage boundary/);
    assert.throws(() => artifactInputReadPolicy([organizationId], invalid), /storage boundary/);
  }
});
