import {RENDERER_FRAME_PATH, rendererFrameBehavior} from "./renderer-frame.js";
import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3 as s3
} from "aws-cdk-lib";
import type {Construct} from "constructs";
import {STUDIO_CONTENT_SECURITY_POLICY} from "./studio-web-stack.js";

export const DEMO_DOMAIN_NAME = "demo.studio.opengeo.tools";
export const DEMO_BUCKET_NAME = "demo.studio.opengeo.tools";
export const DEMO_RELEASE_ORIGIN_PARAMETER = "DemoReleaseOriginPath";
export const DEV_DEMO_ACCOUNT_ID = "222222222222";
export const DEV_DEMO_REGION = "us-east-1";

export type DemoWebStage = "dev" | "production";

export function demoWebStackName(stage: DemoWebStage): string {
  return `OpenGeo-${stage}-DemoWeb`;
}

export function demoWebBucketName(
  stage: DemoWebStage,
  account: string,
  region: string
): string {
  return stage === "production"
    ? DEMO_BUCKET_NAME
    : `opengeo-dev-demo-${account}-${region}`;
}

const RELEASE_ORIGIN_PATH = /^\/releases\/opengeo-demo-[0-9]{14}-[0-9a-f]{12}$/;
const CERTIFICATE_ARN =
  /^arn:aws:acm:us-east-1:([0-9]{12}):certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API_ORIGIN_DOMAIN =
  /^[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com$/;

export interface DemoWebStackProps extends StackProps {
  readonly certificateArn?: string;
  readonly releaseOriginPath?: string;
  readonly stage?: DemoWebStage;
  /** Exact demo API Gateway origin. When set, only /api/* is forwarded. */
  readonly apiOriginDomain?: string;
}

/**
 * Managed demo edge. The root remains the bounded anonymous workbench; a
 * sealed release may also contain authenticated Studio routes. Only /api/*
 * can reach the independently deployed demo API.
 */
export class DemoWebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: DemoWebStackProps) {
    super(scope, id, props);
    const stage = props.stage ?? "production";
    this.validateRegion();
    if (stage === "dev" && props.certificateArn !== undefined) {
      throw new Error("Development demo bootstrap must not activate a custom domain");
    }
    if (stage === "dev" && !Token.isUnresolved(this.account) && this.account !== DEV_DEMO_ACCOUNT_ID) {
      throw new Error(`Development demo edge must use account ${DEV_DEMO_ACCOUNT_ID}`);
    }
    if (props.releaseOriginPath !== undefined && !RELEASE_ORIGIN_PATH.test(props.releaseOriginPath)) {
      throw new Error("Demo release origin must identify one immutable /releases/opengeo-demo-* prefix");
    }
    if (props.certificateArn !== undefined && props.releaseOriginPath === undefined) {
      throw new Error("Demo custom-domain activation requires the active immutable release origin");
    }
    if (props.apiOriginDomain !== undefined
      && !API_ORIGIN_DOMAIN.test(props.apiOriginDomain)) {
      throw new Error(
        "Demo API origin must be an exact us-east-1 API Gateway execute-api domain"
      );
    }
    const certificateAccount = props.certificateArn === undefined
      ? undefined
      : this.validateCertificate(props.certificateArn);
    if (certificateAccount && !Token.isUnresolved(this.account) && certificateAccount !== this.account) {
      throw new Error("Demo ACM certificate must belong to the OpenGeo AWS account");
    }

    const releaseOriginPath = new CfnParameter(this, DEMO_RELEASE_ORIGIN_PARAMETER, {
      type: "String",
      default: props.releaseOriginPath ?? "",
      allowedPattern: props.certificateArn === undefined
        ? "^$|^/releases/opengeo-demo-[0-9]{14}-[0-9a-f]{12}$"
        : "^/releases/opengeo-demo-[0-9]{14}-[0-9a-f]{12}$",
      description: "Active immutable anonymous-demo release"
    });

    const bucketName = demoWebBucketName(stage, this.account, this.region);
    const resourceSuffix = stage === "production" ? "" : `-${stage}-${this.account}`;
    this.bucket = new s3.Bucket(this, "DemoBucket", {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      autoDeleteObjects: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{abortIncompleteMultipartUploadAfter: Duration.days(7)}]
    });
    const originAccessControl = new cloudfront.S3OriginAccessControl(
      this,
      "DemoOriginAccessControl",
      {
        originAccessControlName: `opengeo-demo-web${resourceSuffix}`,
        description: "Read-only CloudFront access to the private OpenGeo demo bucket",
        signing: cloudfront.Signing.SIGV4_ALWAYS
      }
    );
    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originAccessControl,
      originAccessLevels: [cloudfront.AccessLevel.READ],
      originPath: releaseOriginPath.valueAsString
    });
    const certificate = props.certificateArn === undefined
      ? undefined
      : acm.Certificate.fromCertificateArn(this, "DemoCertificate", props.certificateArn);
    const headers = new cloudfront.ResponseHeadersPolicy(this, "DemoSecurityHeaders", {
      responseHeadersPolicyName: `opengeo-demo-security${resourceSuffix}`,
      comment: stage === "production"
        ? `${DEMO_DOMAIN_NAME} browser security headers`
        : "OpenGeo development demo bootstrap security headers",
      securityHeadersBehavior: {
        contentSecurityPolicy: {contentSecurityPolicy: STUDIO_CONTENT_SECURITY_POLICY, override: true},
        contentTypeOptions: {override: true},
        frameOptions: {frameOption: cloudfront.HeadersFrameOption.DENY, override: true},
        referrerPolicy: {referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true},
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: false,
          override: true
        },
        xssProtection: {protection: true, modeBlock: true, override: true}
      },
      customHeadersBehavior: {
        customHeaders: [
          {header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)", override: true},
          {header: "X-Permitted-Cross-Domain-Policies", value: "none", override: true}
        ]
      }
    });
    const authConfigHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "DemoAuthConfigHeaders",
      {
        responseHeadersPolicyName: `opengeo-demo-auth-config${resourceSuffix}`,
        comment: stage === "production"
          ? `${DEMO_DOMAIN_NAME} authentication configuration headers`
          : "OpenGeo development demo authentication configuration headers",
        securityHeadersBehavior: {
          contentSecurityPolicy: {
            contentSecurityPolicy: STUDIO_CONTENT_SECURITY_POLICY,
            override: true
          },
          contentTypeOptions: {override: true},
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
            override: true
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            preload: false,
            override: true
          },
          xssProtection: {protection: true, modeBlock: true, override: true}
        },
        customHeadersBehavior: {
          customHeaders: [
            {header: "Cache-Control", value: "no-store, max-age=0", override: true},
            {header: "Pragma", value: "no-cache", override: true},
            {header: "Expires", value: "0", override: true},
            {header: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)", override: true},
            {header: "X-Permitted-Cross-Domain-Policies", value: "none", override: true}
          ]
        }
      }
    );
    const apiOrigin = props.apiOriginDomain === undefined
      ? undefined
      : new origins.HttpOrigin(props.apiOriginDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2]
        });
    const apiPathRewrite = apiOrigin === undefined
      ? undefined
      : new cloudfront.Function(this, "DemoApiPathRewrite", {
          functionName: `opengeo-demo-api-prefix${resourceSuffix}`,
          comment: `Remove ${DEMO_DOMAIN_NAME}'s external /api namespace before API Gateway forwarding`,
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('/api/') === 0) {
    request.uri = request.uri.substring(4);
  }
  return request;
}
`)
        });

    this.distribution = new cloudfront.Distribution(this, "DemoDistribution", {
      comment: stage === "production" ? DEMO_DOMAIN_NAME : "OpenGeo development demo bootstrap",
      defaultRootObject: "index.html",
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(certificate ? {
        certificate,
        domainNames: [DEMO_DOMAIN_NAME],
        minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
        sslSupportMethod: cloudfront.SSLMethod.SNI
      } : {}),
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: headers,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      additionalBehaviors: {
        [RENDERER_FRAME_PATH]: rendererFrameBehavior(this, origin, `opengeo-demo${resourceSuffix}`),
        "auth-config.json": {
          origin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          responseHeadersPolicy: authConfigHeaders,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        },
        ...(apiOrigin
          ? {
              "api/*": {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: true,
                responseHeadersPolicy: headers,
                functionAssociations: [{
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                  function: apiPathRewrite!
                }],
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
              }
            }
          : {})
      }
    });

    const ready = certificate !== undefined;
    new CfnOutput(this, "DemoBucketName", {value: this.bucket.bucketName});
    new CfnOutput(this, "DemoDistributionId", {value: this.distribution.distributionId});
    new CfnOutput(this, "DemoDistributionDomainName", {value: this.distribution.distributionDomainName});
    new CfnOutput(this, "DemoPreviewUrl", {value: `https://${this.distribution.distributionDomainName}`});
    const releaseOutput = new CfnOutput(this, "DemoActiveReleaseOriginPath", {
      value: releaseOriginPath.valueAsString
    });
    releaseOutput.overrideLogicalId("DemoReleaseOriginPath");
    new CfnOutput(this, "DemoUrl", {
      value: ready ? `https://${DEMO_DOMAIN_NAME}` : `https://${this.distribution.distributionDomainName}`
    });
    new CfnOutput(this, "DemoDnsActivationReady", {value: String(ready)});
    new CfnOutput(this, "DemoDnsRecordName", {value: DEMO_DOMAIN_NAME});
    new CfnOutput(this, "DemoDnsRecordType", {value: "CNAME"});
    new CfnOutput(this, "DemoDnsRecordValue", {value: this.distribution.distributionDomainName});
    new CfnOutput(this, "DemoDnsHandoff", {
      value: stage === "dev"
        ? "Development bootstrap has no custom-domain or DNS handoff."
        : ready
          ? this.toJsonString({
            provider: "DNS Made Easy",
            type: "CNAME",
            zone: "opengeo.tools",
            name: "demo.studio",
            fqdn: DEMO_DOMAIN_NAME,
            value: this.distribution.distributionDomainName,
            ttlSeconds: 300
          })
          : "Do not create the demo.studio.opengeo.tools CNAME until its us-east-1 certificate is issued."
    });
  }

  private validateRegion(): void {
    if (!Token.isUnresolved(this.region) && this.region !== "us-east-1") {
      throw new Error("OpenGeo demo web edge must be deployed in us-east-1");
    }
  }

  private validateCertificate(value: string): string {
    const match = CERTIFICATE_ARN.exec(value);
    if (!match?.[1]) {
      throw new Error("Demo certificate ARN must be a literal us-east-1 ACM certificate ARN");
    }
    return match[1];
  }
}
