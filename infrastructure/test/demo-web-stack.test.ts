import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {
  DEMO_BUCKET_NAME,
  DEMO_DOMAIN_NAME,
  DEMO_RELEASE_ORIGIN_PARAMETER,
  DEV_DEMO_ACCOUNT_ID,
  DemoWebStack,
  demoWebBucketName,
  demoWebStackName
} from "../lib/demo-web-stack.js";

const ACCOUNT = "111111111111";
const CERT = `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`;
const RELEASE = "/releases/opengeo-demo-20260821235959-0123456789ab";
const API_ORIGIN = "kbqcyelp3h.execute-api.us-east-1.amazonaws.com";

function templateFor(props = {}) {
  return Template.fromStack(new DemoWebStack(new App(), "Test-DemoWeb", {
    ...props,
    env: {account: ACCOUNT, region: "us-east-1"}
  }));
}

describe("OpenGeo anonymous demo web edge", () => {
  it("creates a retained private dotted bucket, OAC, and bootstrap distribution", () => {
    const template = templateFor();
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        BucketName: DEMO_BUCKET_NAME,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true
        },
        VersioningConfiguration: {Status: "Enabled"}
      })
    });
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        Name: "opengeo-demo-web",
        SigningBehavior: "always",
        SigningProtocol: "sigv4"
      })
    });
    template.hasParameter(DEMO_RELEASE_ORIGIN_PARAMETER, {
      Default: "",
      AllowedPattern: "^$|^/releases/opengeo-demo-[0-9]{14}-[0-9a-f]{12}$"
    });
    template.hasOutput("DemoDnsActivationReady", {Value: "false"});
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  it("keeps the anonymous workbench static when no managed API is configured", () => {
    const template = templateFor();
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: DEMO_DOMAIN_NAME,
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({ViewerProtocolPolicy: "redirect-to-https"}),
        Origins: Match.arrayWith([Match.objectLike({
          OriginPath: {Ref: DEMO_RELEASE_ORIGIN_PARAMETER},
          OriginAccessControlId: Match.anyValue()
        })])
      })
    });
    const body = JSON.stringify(template.toJSON());
    assert.doesNotMatch(body, /Cognito|execute-api|api\/\*/i);
  });

  it("adds only no-store auth configuration and the exact demo API path", () => {
    const template = templateFor({apiOriginDomain: API_ORIGIN});
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({DomainName: API_ORIGIN})
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({PathPattern: "auth-config.json"}),
          Match.objectLike({PathPattern: "api/*"})
        ])
      })
    });
    const body = JSON.stringify(template.toJSON());
    assert.match(body, /no-store, max-age=0/);
    assert.match(body, /substring\(4\)/);
    assert.doesNotMatch(body, /AWS::Cognito/);
  });

  it("activates only with an exact certificate and immutable demo release", () => {
    const template = templateFor({certificateArn: CERT, releaseOriginPath: RELEASE});
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [DEMO_DOMAIN_NAME],
        ViewerCertificate: {
          AcmCertificateArn: CERT,
          MinimumProtocolVersion: "TLSv1.3_2025",
          SslSupportMethod: "sni-only"
        }
      })
    });
    template.hasParameter(DEMO_RELEASE_ORIGIN_PARAMETER, {
      Default: RELEASE,
      AllowedPattern: "^/releases/opengeo-demo-[0-9]{14}-[0-9a-f]{12}$"
    });
    template.hasOutput("DemoDnsActivationReady", {Value: "true"});
  });

  it("rejects invalid certificate, release, and region inputs", () => {
    assert.throws(() => templateFor({certificateArn: CERT}), /requires the active immutable/);
    assert.throws(() => templateFor({releaseOriginPath: "/dist"}), /immutable/);
    assert.throws(
      () => templateFor({apiOriginDomain: "api.example.com"}),
      /exact us-east-1 API Gateway/
    );
    assert.throws(() => templateFor({
      certificateArn: CERT.replace("us-east-1", "us-west-2"),
      releaseOriginPath: RELEASE
    }), /literal us-east-1/);
    assert.throws(() => new DemoWebStack(new App(), "BadRegion", {
      env: {account: ACCOUNT, region: "us-west-2"}
    }), /must be deployed in us-east-1/);
  });

  it("creates a DNS-free development edge with account-scoped names", () => {
    const template = Template.fromStack(new DemoWebStack(new App(), demoWebStackName("dev"), {
      stage: "dev",
      env: {account: DEV_DEMO_ACCOUNT_ID, region: "us-east-1"}
    }));
    const bucket = demoWebBucketName("dev", DEV_DEMO_ACCOUNT_ID, "us-east-1");
    template.hasResourceProperties("AWS::S3::Bucket", {BucketName: bucket});
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        Name: `opengeo-demo-web-dev-${DEV_DEMO_ACCOUNT_ID}`
      })
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: "OpenGeo development demo bootstrap"
      })
    });
    template.hasOutput("DemoDnsActivationReady", {Value: "false"});
    template.hasOutput("DemoDnsHandoff", {
      Value: "Development bootstrap has no custom-domain or DNS handoff."
    });
    const body = JSON.stringify(template.toJSON());
    assert.doesNotMatch(body, /Aliases|AcmCertificateArn|AWS::Route53/);
  });

  it("rejects dev certificates and the wrong development account", () => {
    assert.throws(() => new DemoWebStack(new App(), "BadDevCertificate", {
      stage: "dev",
      certificateArn: CERT,
      releaseOriginPath: RELEASE,
      env: {account: DEV_DEMO_ACCOUNT_ID, region: "us-east-1"}
    }), /must not activate a custom domain/);
    assert.throws(() => new DemoWebStack(new App(), "BadDevAccount", {
      stage: "dev",
      env: {account: ACCOUNT, region: "us-east-1"}
    }), /must use account/);
  });
});
