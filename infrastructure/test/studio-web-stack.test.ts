import {RENDERER_FRAME_CSP} from "../lib/renderer-frame.js";
import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {runInNewContext} from "node:vm";
import {App} from "aws-cdk-lib";
import {Match, Template} from "aws-cdk-lib/assertions";
import {
  STUDIO_BUCKET_NAME,
  STUDIO_CONTENT_SECURITY_POLICY,
  STUDIO_AUTH_CONFIG_CONTENT_SECURITY_POLICY,
  STUDIO_ARTIFACT_VIEWER_FALLBACK_CONTENT_SECURITY_POLICY,
  STUDIO_DOMAIN_NAME,
  STUDIO_RELEASE_ORIGIN_PARAMETER,
  StudioWebStack,
  type StudioWebStackProps
} from "../lib/studio-web-stack.js";

const ACCOUNT = "111111111111";
const CERTIFICATE_ARN =
  `arn:aws:acm:us-east-1:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`;
const WEB_ACL_ARN =
  `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/webacl/OpenGeoStudio/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
const RELEASE_ORIGIN = "/releases/opengeo-studio-20260821134142-84bfadbbd59e";
const API_ORIGIN = "abcdefghij.execute-api.us-east-1.amazonaws.com";

function stackFor(
  props: Omit<StudioWebStackProps, "env"> = {},
  region = "us-east-1",
  account = ACCOUNT
): StudioWebStack {
  return new StudioWebStack(new App(), "Test-StudioWeb", {
    ...props,
    env: {account, region}
  });
}

function templateFor(props: Omit<StudioWebStackProps, "env"> = {}): Template {
  return Template.fromStack(stackFor(props));
}

describe("OpenGeo Studio web edge", () => {
  it("preserves the existing production bucket without allowing new dotted names", () => {
    const template = Template.fromStack(stackFor(
      {bucketName: STUDIO_DOMAIN_NAME}, "us-east-1", "111111111111"
    ));
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({BucketName: "studio.opengeo.tools"})
    });
    assert.throws(() => stackFor(
      {bucketName: STUDIO_DOMAIN_NAME}, "us-east-1", "333333333333"
    ), /non-dotted/);
    assert.throws(() => stackFor(
      {bucketName: "other.studio.opengeo.tools"}, "us-east-1", "111111111111"
    ), /non-dotted/);
  });
  it("allows isolated previews and same-origin renderer hosts while denying embedding", () => {
    const directives = new Map(STUDIO_CONTENT_SECURITY_POLICY.split(";").map(value => {
      const [name, ...sources] = value.trim().split(/\s+/);
      return [name, sources];
    }));
    assert.deepEqual(directives.get("frame-src"), ["'self'", "https://preview.studio.opengeo.tools", "https://maps-preview.studio.opengeo.tools"]);
    assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
    assert.equal(STUDIO_AUTH_CONFIG_CONTENT_SECURITY_POLICY,
      STUDIO_CONTENT_SECURITY_POLICY.replace("frame-src 'self' https://preview.studio.opengeo.tools https://maps-preview.studio.opengeo.tools", "frame-src 'none'"));
  });
  it("creates a retained private dotted bucket and a read-only native S3 OAC", () => {
    const template = templateFor();

    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        BucketName: STUDIO_BUCKET_NAME,
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: {SSEAlgorithm: "AES256"}
            }
          ]
        },
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7},
              Status: "Enabled"
            })
          ])
        },
        OwnershipControls: {
          Rules: [{ObjectOwnership: "BucketOwnerEnforced"}]
        },
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
      OriginAccessControlConfig: {
        Description: `Read-only CloudFront access to the private ${STUDIO_DOMAIN_NAME} bucket`,
        Name: "opengeo-studio-web",
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
        SigningProtocol: "sigv4"
      }
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            OriginPath: {Ref: STUDIO_RELEASE_ORIGIN_PARAMETER},
            OriginAccessControlId: Match.anyValue(),
            S3OriginConfig: {OriginAccessIdentity: ""}
          })
        ])
      })
    });
    template.hasParameter(STUDIO_RELEASE_ORIGIN_PARAMETER, {
      Type: "String",
      Default: "",
      AllowedPattern: "^$|^/releases/opengeo-studio-[0-9]{14}-[0-9a-f]{12}$"
    });
    template.hasOutput("StudioReleaseOriginPath", {
      Value: {Ref: STUDIO_RELEASE_ORIGIN_PARAMETER}
    });
    template.hasResourceProperties("AWS::S3::BucketPolicy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
            Effect: "Allow",
            Principal: {Service: "cloudfront.amazonaws.com"}
          })
        ])
      }
    });

    const body = JSON.stringify(template.toJSON());
    assert.doesNotMatch(body, /AWS::CloudFront::CloudFrontOriginAccessIdentity/);
    assert.doesNotMatch(body, /WebsiteConfiguration/);
  });

  it("supports a safe bootstrap distribution before certificate and DNS activation", () => {
    const template = templateFor();

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: STUDIO_DOMAIN_NAME,
        DefaultRootObject: "index.html",
        Enabled: true,
        HttpVersion: "http2and3",
        IPV6Enabled: true
      })
    });
    template.hasOutput("StudioDnsActivationReady", {Value: "false"});
    template.hasOutput("StudioDnsZone", {Value: "opengeo.tools"});
    template.hasOutput("StudioDnsRecordHost", {Value: "studio"});
    template.hasOutput("StudioDnsRecordName", {Value: STUDIO_DOMAIN_NAME});
    template.hasOutput("StudioDnsRecordType", {Value: "CNAME"});
    template.hasOutput("StudioDnsRecordValue", {Value: Match.anyValue()});
    template.hasOutput("StudioPreviewUrl", {Value: Match.anyValue()});
    template.hasOutput("StudioDnsHandoff", {
      Value: Match.stringLikeRegexp("Do not create.*validated us-east-1 certificate")
    });

    const distribution = resourcesOfType(template, "AWS::CloudFront::Distribution")[0];
    const config = distribution?.Properties.DistributionConfig as Record<string, unknown>;
    assert.equal("Aliases" in config, false);
    assert.equal("ViewerCertificate" in config, false);
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
    template.resourceCountIs("AWS::Route53::HostedZone", 0);
  });

  it("activates the Studio alias only with the supplied us-east-1 certificate", () => {
    const template = templateFor({
      certificateArn: CERTIFICATE_ARN,
      releaseOriginPath: RELEASE_ORIGIN
    });

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Aliases: [STUDIO_DOMAIN_NAME],
        DefaultCacheBehavior: Match.objectLike({
          AllowedMethods: Match.arrayWith(["GET", "HEAD"]),
          CachedMethods: Match.arrayWith(["GET", "HEAD"]),
          Compress: true,
          ViewerProtocolPolicy: "redirect-to-https"
        }),
        ViewerCertificate: {
          AcmCertificateArn: CERTIFICATE_ARN,
          MinimumProtocolVersion: "TLSv1.3_2025",
          SslSupportMethod: "sni-only"
        }
      })
    });
    template.hasOutput("StudioDnsActivationReady", {Value: "true"});
    template.hasOutput("StudioUrl", {Value: `https://${STUDIO_DOMAIN_NAME}`});
    template.hasParameter(STUDIO_RELEASE_ORIGIN_PARAMETER, {
      Default: RELEASE_ORIGIN,
      AllowedPattern: "^/releases/opengeo-studio-[0-9]{14}-[0-9a-f]{12}$"
    });
    template.hasOutput("StudioDnsHandoff", {
      Value: Match.objectLike({"Fn::Join": Match.anyValue()})
    });
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  it("does not cache browser auth configuration and applies browser security headers", () => {
    const template = templateFor();

    template.resourceCountIs("AWS::CloudFront::ResponseHeadersPolicy", 3);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            Compress: true,
            PathPattern: "auth-config.json",
            ViewerProtocolPolicy: "redirect-to-https"
          })
        ])
      })
    });
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: "opengeo-studio-auth-config",
        CustomHeadersConfig: {
          Items: Match.arrayWith([
            {Header: "Cache-Control", Override: true, Value: "no-store, max-age=0"},
            {Header: "Pragma", Override: true, Value: "no-cache"},
            {Header: "Expires", Override: true, Value: "0"}
          ])
        },
        SecurityHeadersConfig: Match.objectLike({
          ContentSecurityPolicy: {
            ContentSecurityPolicy: STUDIO_AUTH_CONFIG_CONTENT_SECURITY_POLICY,
            Override: true
          },
          ContentTypeOptions: {Override: true},
          FrameOptions: {FrameOption: "DENY", Override: true},
          ReferrerPolicy: {
            Override: true,
            ReferrerPolicy: "no-referrer"
          },
          StrictTransportSecurity: Match.objectLike({
            AccessControlMaxAgeSec: 31536000,
            IncludeSubdomains: true,
            Override: true
          })
        })
      })
    });

    for (const policy of resourcesOfType(template, "AWS::CloudFront::ResponseHeadersPolicy")) {
      const config = policy.Properties.ResponseHeadersPolicyConfig as Record<string, unknown>;
      assert.deepEqual(
        (config.SecurityHeadersConfig as Record<string, unknown>).ContentSecurityPolicy,
        {ContentSecurityPolicy: config.Name === "opengeo-studio-auth-config"
          ? STUDIO_AUTH_CONFIG_CONTENT_SECURITY_POLICY : config.Name === "opengeo-studio-renderer-frame" ? RENDERER_FRAME_CSP : STUDIO_CONTENT_SECURITY_POLICY, Override: true}
      );
      assert.deepEqual(
        (config.SecurityHeadersConfig as Record<string, unknown>).ReferrerPolicy,
        {Override: true, ReferrerPolicy: "no-referrer"}
      );
    }
  });

  it("optionally forwards only /api/* to an exact regional API Gateway origin", () => {
    const template = templateFor({apiOriginDomain: API_ORIGIN});

    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Origins: Match.arrayWith([
          Match.objectLike({
            DomainName: API_ORIGIN,
            CustomOriginConfig: Match.objectLike({
              OriginProtocolPolicy: "https-only",
              OriginSSLProtocols: ["TLSv1.2"]
            })
          })
        ]),
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            AllowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"],
            CachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
            CachedMethods: ["GET", "HEAD", "OPTIONS"],
            Compress: true,
            OriginRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
            PathPattern: "api/*",
            FunctionAssociations: [
              Match.objectLike({EventType: "viewer-request"})
            ],
            ViewerProtocolPolicy: "redirect-to-https"
          })
        ])
      })
    });
    template.hasResourceProperties("AWS::CloudFront::Function", {
      Name: "opengeo-studio-api-prefix",
      AutoPublish: true,
      FunctionConfig: Match.objectLike({Runtime: "cloudfront-js-2.0"}),
      FunctionCode: Match.stringLikeRegexp(
        "request\\.uri = request\\.uri\\.substring\\(4\\)"
      )
    });
  });

  it("isolates public module imports from private API credentials and normalized-path tricks", () => {
    const template = templateFor({apiOriginDomain: API_ORIGIN});
    const distribution = resourcesOfType(template, "AWS::CloudFront::Distribution")[0];
    assert.ok(distribution);
    const config = distribution.Properties.DistributionConfig as {
      CacheBehaviors: Array<{PathPattern: string; AllowedMethods: string[]; CachePolicyId: string}>
    };
    const behaviors = config.CacheBehaviors;
    const module = behaviors.find((item: {PathPattern: string}) => item.PathPattern.endsWith("/module.mjs"));
    assert.ok(module);
    assert.ok(behaviors.indexOf(module) < behaviors.findIndex((item: {PathPattern: string}) => item.PathPattern === "api/*"));
    assert.deepEqual(module!.AllowedMethods, ["GET", "HEAD"]);
    assert.equal(module!.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: "opengeo-studio-public-module",
        CorsConfig: {
          AccessControlAllowCredentials: false, AccessControlAllowOrigins: {Items: ["*"]},
          AccessControlAllowHeaders: {Items: ["Content-Type"]},
          AccessControlAllowMethods: {Items: ["GET", "HEAD"]}, OriginOverride: true
        },
        CustomHeadersConfig: {Items: [{Header: "Cache-Control", Value: "no-store", Override: true}]},
        SecurityHeadersConfig: {
          ContentTypeOptions: {Override: true},
          ReferrerPolicy: {ReferrerPolicy: "no-referrer", Override: true}
        }
      })
    });
    const fn = resourcesOfType(template, "AWS::CloudFront::Function")
      .find(item => item.Properties.Name === "opengeo-studio-public-module");
    const handler = runInNewContext(`${fn!.Properties.FunctionCode}; handler`);
    const id = "11111111-2222-4333-8444-555555555555";
    const uri = `/api/public/organizations/${id}/artifact-releases/${id}/module.mjs`;
    const accepted = handler({request: {method: "GET", uri, headers: {
      authorization: {value: "fixture"}, cookie: {value: "fixture"},
      "x-opengeo-organization": {value: id}, origin: {value: "https://notebook.example"}
    }, cookies: {session: {value: "fixture"}}}});
    assert.equal(accepted.uri, uri.substring(4));
    assert.equal(accepted.headers.authorization, undefined);
    assert.equal(accepted.headers.cookie, undefined);
    assert.equal(accepted.headers["x-opengeo-organization"], undefined);
    assert.equal(Object.keys(accepted.cookies).length, 0);
    assert.equal(accepted.headers.origin.value, "https://notebook.example");
    for (const [method, path] of [
      ["POST", uri], ["OPTIONS", uri], ["GET", uri + "/../private"],
      ["GET", uri.replace("/artifact-releases/", "/%2e%2e/artifact-releases/")],
      ["GET", uri.replace("/public/", "/private/")],
      ["GET", uri.replace("module.mjs", "map")], ["GET", uri.replace(id, "invalid")]
    ]) {
      const denied = handler({request: {method, uri: path, headers: {}, cookies: {}}});
      assert.equal(denied.statusCode, 404);
      assert.equal(denied.headers["cache-control"].value, "no-store");
    }
    const withoutApi = templateFor();
    assert.equal(resourcesOfType(withoutApi, "AWS::CloudFront::Function").length, 0);
  });

  it("preserves exact-object API CSP only on uncached static and password viewers", () => {
    const template = templateFor({apiOriginDomain: API_ORIGIN});
    const distribution = resourcesOfType(template, "AWS::CloudFront::Distribution")[0];
    assert.ok(distribution);
    const {CacheBehaviors: behaviors} = distribution.Properties.DistributionConfig as {
      CacheBehaviors: Array<{
        PathPattern: string; AllowedMethods: string[]; CachedMethods: string[];
        CachePolicyId: string; OriginRequestPolicyId: string;
        TargetOriginId: unknown; ResponseHeadersPolicyId: unknown;
        FunctionAssociations: unknown; ViewerProtocolPolicy: string;
      }>
    };
    const api = behaviors.find(item => item.PathPattern === "api/*");
    const password = behaviors.find(item => item.PathPattern === "api/shared/organizations/*/artifact-shares/*/view");
    const staticViewer = behaviors.find(item => item.PathPattern === "api/public/organizations/*/artifact-releases/*/static");
    assert.ok(api && password && staticViewer);
    assert.deepEqual(password.AllowedMethods, ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "POST", "DELETE"]);
    assert.deepEqual(staticViewer.AllowedMethods, ["GET", "HEAD"]);
    for (const viewer of [password, staticViewer]) {
      assert.ok(behaviors.indexOf(viewer) < behaviors.indexOf(api));
      assert.deepEqual(viewer.CachedMethods, ["GET", "HEAD"]);
      assert.equal(viewer.CachePolicyId, "4135ea2d-6df8-44a3-9df3-4b5a84be39ad");
      assert.equal(viewer.OriginRequestPolicyId, "b689b0a8-53d0-40ab-baf2-68738e2966ac");
      assert.deepEqual(viewer.TargetOriginId, api.TargetOriginId);
      assert.deepEqual(viewer.FunctionAssociations, api.FunctionAssociations);
      assert.equal(viewer.ViewerProtocolPolicy, "redirect-to-https");
      assert.notDeepEqual(viewer.ResponseHeadersPolicyId, api.ResponseHeadersPolicyId);
    }
    assert.deepEqual(password.ResponseHeadersPolicyId, staticViewer.ResponseHeadersPolicyId);
    const viewerPolicy = resourcesOfType(template, "AWS::CloudFront::ResponseHeadersPolicy")
      .map(item => item.Properties.ResponseHeadersPolicyConfig as Record<string, unknown>)
      .find(item => item.Name === "opengeo-studio-artifact-viewer");
    assert.ok(viewerPolicy);
    assert.equal("CorsConfig" in viewerPolicy, false);
    const security = viewerPolicy.SecurityHeadersConfig as Record<string, unknown>;
    assert.deepEqual(security.ContentSecurityPolicy, {
      ContentSecurityPolicy: STUDIO_ARTIFACT_VIEWER_FALLBACK_CONTENT_SECURITY_POLICY,
      Override: false
    });
    for (const directive of ["default-src", "frame-src", "frame-ancestors", "form-action"]) {
      assert.ok(STUDIO_ARTIFACT_VIEWER_FALLBACK_CONTENT_SECURITY_POLICY.split("; ").includes(`${directive} 'none'`));
    }
    assert.deepEqual(security.ContentTypeOptions, {Override: true});
    assert.deepEqual(security.FrameOptions, {FrameOption: "DENY", Override: true});
    assert.deepEqual(security.ReferrerPolicy, {ReferrerPolicy: "no-referrer", Override: true});
    assert.deepEqual(security.StrictTransportSecurity, {
      AccessControlMaxAgeSec: 31536000, IncludeSubdomains: true, Preload: false, Override: true
    });
    const headers = (viewerPolicy.CustomHeadersConfig as {Items: Array<{Header: string; Value: string; Override: boolean}>}).Items;
    for (const [Header, Value] of [["Cache-Control", "private, no-store, max-age=0"], ["Pragma", "no-cache"], ["Expires", "0"]]) {
      assert.ok(headers.some(item => item.Header === Header && item.Value === Value && item.Override));
    }
    assert.equal(resourcesOfType(templateFor(), "AWS::CloudFront::ResponseHeadersPolicy")
      .some(item => (item.Properties.ResponseHeadersPolicyConfig as {Name: string}).Name === "opengeo-studio-artifact-viewer"), false);
  });

  it("isolates the development Studio names, bucket, and DNS handoff", () => {
    const template = templateFor({
      domainName: "dev.studio.opengeo.tools",
      bucketName: "opengeo-dev-studio-222222222222-us-east-1",
      resourceNamePrefix: "opengeo-dev-studio",
      dnsZone: "opengeo.tools",
      dnsRecordHost: "dev.studio",
      apiOriginDomain: API_ORIGIN
    });

    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: "opengeo-dev-studio-222222222222-us-east-1"
    });
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        Description:
          "Read-only CloudFront access to the private dev.studio.opengeo.tools bucket",
        Name: "opengeo-dev-studio-web"
      })
    });
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        Name: "opengeo-dev-studio-auth-config"
      })
    });
    template.hasResourceProperties("AWS::CloudFront::Function", {
      Name: "opengeo-dev-studio-api-prefix"
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        Comment: "dev.studio.opengeo.tools"
      })
    });
    template.hasOutput("StudioDnsZone", {Value: "opengeo.tools"});
    template.hasOutput("StudioDnsRecordHost", {Value: "dev.studio"});
    template.hasOutput("StudioDnsRecordName", {Value: "dev.studio.opengeo.tools"});
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /OpenGeo-production/);
  });

  it("associates an optional global WAFv2 web ACL", () => {
    const template = templateFor({webAclArn: WEB_ACL_ARN});

    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({WebACLId: WEB_ACL_ARN})
    });
  });

  it("rejects certificates, WAFs, regions, and accounts outside the edge boundary", () => {
    for (const invalidProps of [
      {domainName: "studio.example.com"},
      {bucketName: "Invalid_Bucket"},
      {bucketName: "dev.studio.opengeo.tools"},
      {resourceNamePrefix: "OpenGeo Dev"},
      {dnsRecordHost: "other"}
    ]) {
      assert.throws(() => stackFor(invalidProps));
    }
    assert.throws(
      () => stackFor({certificateArn: CERTIFICATE_ARN}),
      /custom-domain activation requires the currently active immutable release origin/
    );
    assert.throws(
      () => stackFor({releaseOriginPath: "/dist"}),
      /must identify one immutable/
    );
    for (const apiOriginDomain of [
      "https://abcdefghij.execute-api.us-east-1.amazonaws.com",
      "abcdefghij.execute-api.us-west-2.amazonaws.com",
      "abcdefghij.execute-api.us-east-1.amazonaws.com/production",
      "studio.opengeo.tools"
    ]) {
      assert.throws(
        () => stackFor({apiOriginDomain}),
        /exact us-east-1 API Gateway execute-api domain/
      );
    }
    assert.throws(
      () => stackFor({
        certificateArn:
          `arn:aws:acm:us-west-2:${ACCOUNT}:certificate/11111111-2222-3333-4444-555555555555`
      }),
      /literal us-east-1 ACM certificate ARN/
    );
    assert.throws(
      () => stackFor({webAclArn: WEB_ACL_ARN.replace(":global/", ":regional/")}),
      /us-east-1 WAFv2 global web ACL ARN/
    );
    assert.throws(
      () => stackFor({}, "us-west-2"),
      /must be deployed in us-east-1/
    );
    assert.throws(
      () => stackFor({certificateArn: CERTIFICATE_ARN}, "us-east-1", "222222222222"),
      /ACM certificate must belong to the same AWS account/
    );
  });
});

function resourcesOfType(
  template: Template,
  type: string
): Array<{Properties: Record<string, unknown>}> {
  return Object.values(
    template.toJSON().Resources as Record<
      string,
      {Type: string; Properties: Record<string, unknown>}
    >
  ).filter((resource) => resource.Type === type);
}
