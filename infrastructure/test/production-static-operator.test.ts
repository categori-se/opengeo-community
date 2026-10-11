import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {describe, it} from "node:test";

const bootstrap = new URL("../bootstrap/", import.meta.url);
const account = "111111111111";
const userArn = `arn:aws:iam::${account}:user/aaron-arch`;
const roleArn = `arn:aws:iam::${account}:role/opengeo/production/OpenGeoProductionOperatorRole`;

function json(name: string): Record<string, any> {
  return JSON.parse(readFileSync(new URL(name, bootstrap), "utf8"));
}

describe("production static Studio operator artifacts", () => {
  it("trusts only the exact aaron-arch principal", () => {
    const trust = json("opengeo-production-operator-trust.json");
    assert.equal(trust.Statement.length, 1);
    assert.equal(trust.Statement[0].Principal.AWS, userArn);
    assert.equal(trust.Statement[0].Condition.ArnEquals["aws:PrincipalArn"], userArn);
    assert.equal(trust.Statement[0].Action, "sts:AssumeRole");
  });

  it("gives the source user only the exact assume-role action", () => {
    const policy = json("opengeo-production-operator-principal-policy.json");
    assert.deepEqual(policy.Statement, [{
      Sid: "AssumeExactOpenGeoProductionOperatorRole",
      Effect: "Allow",
      Action: "sts:AssumeRole",
      Resource: roleArn
    }]);
  });

  it("bounds release authority to the retained bucket, distribution, and stack", () => {
    const policy = json("opengeo-production-operator-policy.json");
    assert.deepEqual(policy, {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "ReadCallerIdentity",
          Effect: "Allow",
          Action: "sts:GetCallerIdentity",
          Resource: "*"
        },
        {
          Sid: "ReadExactProductionBudget",
          Effect: "Allow",
          Action: "budgets:ViewBudget",
          Resource: "arn:aws:budgets::111111111111:budget/opengeo-production-monthly-account"
        },
        {
          Sid: "ReadProductionCost",
          Effect: "Allow",
          Action: ["ce:GetCostAndUsage", "ce:GetCostForecast"],
          Resource: "*"
        },
        {
          Sid: "ReadAndMoveExactStudioReleasePointer",
          Effect: "Allow",
          Action: [
            "cloudformation:DescribeStackEvents",
            "cloudformation:DescribeStacks",
            "cloudformation:GetTemplate",
            "cloudformation:ListStackResources",
            "cloudformation:UpdateStack"
          ],
          Resource: "arn:aws:cloudformation:us-east-1:111111111111:stack/OpenGeo-production-StudioWeb/*"
        },
        {
          Sid: "ReadAndInvalidateExactStudioDistribution",
          Effect: "Allow",
          Action: [
            "cloudfront:CreateInvalidation",
            "cloudfront:GetDistribution",
            "cloudfront:GetDistributionConfig",
            "cloudfront:GetInvalidation"
          ],
          Resource: "arn:aws:cloudfront::111111111111:distribution/E2GPOVS3D9R9NX"
        },
        {
          Sid: "ReadExactRetainedStudioBucketConfiguration",
          Effect: "Allow",
          Action: [
            "s3:GetBucketLocation",
            "s3:GetBucketOwnershipControls",
            "s3:GetBucketPolicy",
            "s3:GetBucketPolicyStatus",
            "s3:GetBucketPublicAccessBlock",
            "s3:GetBucketTagging",
            "s3:GetBucketVersioning",
            "s3:GetEncryptionConfiguration"
          ],
          Resource: "arn:aws:s3:::studio.opengeo.tools"
        },
        {
          Sid: "ListOnlyImmutableStudioReleases",
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: "arn:aws:s3:::studio.opengeo.tools",
          Condition: {
            StringLike: {
              "s3:prefix": [
                "releases/opengeo-studio-*",
                "releases/opengeo-studio-*/*"
              ]
            }
          }
        },
        {
          Sid: "ReadAndPublishOnlyImmutableStudioReleaseObjects",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: "arn:aws:s3:::studio.opengeo.tools/releases/opengeo-studio-*/*"
        }
      ]
    });
  });

  it("provides a no-secret exact assume-role profile", () => {
    const profile = readFileSync(
      new URL("opengeo-production-operator-profile.ini", bootstrap),
      "utf8"
    );
    assert.match(profile, /^\[profile opengeo-production-operator\]$/m);
    assert.match(profile, new RegExp(`^role_arn = ${roleArn}$`, "m"));
    assert.match(profile, /^source_profile = categorise$/m);
    assert.match(profile, /^region = us-east-1$/m);
    assert.doesNotMatch(profile, /(?:aws_access_key_id|aws_secret_access_key|aws_session_token)/);
  });
});
