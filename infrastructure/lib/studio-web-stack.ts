import {RENDERER_FRAME_PATH, rendererFrameBehavior} from "./renderer-frame.js";
import {
  CfnParameter,
  CfnOutput,
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

export const STUDIO_DOMAIN_NAME = "studio.opengeo.tools";
export const STUDIO_BUCKET_NAME = "opengeo-studio-111111111111-us-east-1";
export const STUDIO_RELEASE_ORIGIN_PARAMETER = "StudioReleaseOriginPath";

/**
 * Observable emits inline module/sidebar scripts and styles, d3-dsv compiles
 * its CSV row converter, MapLibre creates a blob worker, and Studio accepts
 * user-selected HTTPS GIS sources. Keep those explicit exceptions while
 * denying plugin objects, other frames, embedding, base-tag changes, and script
 * attributes.
 */
export const STUDIO_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'self' https://preview.studio.opengeo.tools https://maps-preview.studio.opengeo.tools",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "upgrade-insecure-requests"
].join("; ");

export const STUDIO_AUTH_CONFIG_CONTENT_SECURITY_POLICY = STUDIO_CONTENT_SECURITY_POLICY.replace(
  "frame-src 'self' https://preview.studio.opengeo.tools https://maps-preview.studio.opengeo.tools", "frame-src 'none'"
);

export const STUDIO_ARTIFACT_VIEWER_FALLBACK_CONTENT_SECURITY_POLICY = [
  "default-src 'none'", "base-uri 'none'", "object-src 'none'",
  "frame-src 'none'", "frame-ancestors 'none'", "form-action 'none'"
].join("; ");

const RELEASE_ORIGIN_PATH = /^\/releases\/opengeo-studio-[0-9]{14}-[0-9a-f]{12}$/;

const CERTIFICATE_ARN =
  /^arn:aws:acm:us-east-1:([0-9]{12}):certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WEB_ACL_ARN =
  /^arn:aws:wafv2:us-east-1:([0-9]{12}):global\/webacl\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API_ORIGIN_DOMAIN =
  /^[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com$/;
const STUDIO_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*studio\.opengeo\.tools$/;
const S3_BUCKET_NAME = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/;
const RESOURCE_NAME_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const DNS_ZONE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DNS_RECORD_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface StudioWebStackProps extends StackProps {
  /** Intended custom-domain name. Defaults to the production Studio name. */
  readonly domainName?: string;

  /** Exact private origin bucket. Defaults to the production Studio bucket. */
  readonly bucketName?: string;

  /** Globally unique prefix for CloudFront named resources. */
  readonly resourceNamePrefix?: string;

  /** External DNS handoff metadata only; this stack never changes DNS. */
  readonly dnsZone?: string;
  readonly dnsRecordHost?: string;

  /**
   * An already-issued ACM certificate in us-east-1 that covers
   * studio.opengeo.tools. When omitted, the stack creates a bootstrap
   * CloudFront endpoint without the custom-domain alias so the edge can be
   * verified before the external DNS handoff.
   */
  readonly certificateArn?: string;

  /**
   * The currently active immutable Studio release. It becomes the default for
   * the CloudFormation parameter that owns CloudFront's OriginPath. A final
   * custom-domain deployment must supply it so a certificate update cannot
   * reset the already-deployed application to the empty bucket root.
   */
  readonly releaseOriginPath?: string;

  /** Optional us-east-1/global WAFv2 web ACL ARN for CloudFront. */
  readonly webAclArn?: string;

  /**
   * Optional request-driven API Gateway origin domain, without a scheme, path,
   * query, or trailing dot. When supplied, only /api/* is forwarded to it.
   */
  readonly apiOriginDomain?: string;
}

/**
 * Hosts the OpenGeo Studio shell separately from the public publication site.
 * DNS remains deliberately external: this stack emits the DNS Made Easy CNAME
 * handoff but never creates or imports a Route53 hosted zone.
 */
export class StudioWebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly originAccessControl: cloudfront.S3OriginAccessControl;

  constructor(scope: Construct, id: string, props: StudioWebStackProps) {
    super(scope, id, props);

    this.validateDeploymentRegion();
    const domainName = this.validateDomainName(props.domainName ?? STUDIO_DOMAIN_NAME);
    const bucketName = this.validateBucketName(props.bucketName ?? STUDIO_BUCKET_NAME);
    const resourceNamePrefix = this.validateResourceNamePrefix(
      props.resourceNamePrefix ?? "opengeo-studio"
    );
    const dnsZone = this.validateDnsZone(props.dnsZone ?? "opengeo.tools");
    const dnsRecordHost = this.validateDnsRecordHost(props.dnsRecordHost ?? "studio");
    if (`${dnsRecordHost}.${dnsZone}` !== domainName) {
      throw new Error("Studio DNS handoff host and zone must exactly compose the Studio domain");
    }
    const certificateAccount = props.certificateArn === undefined
      ? undefined
      : this.validateCertificateArn(props.certificateArn);
    const webAclAccount = props.webAclArn === undefined
      ? undefined
      : this.validateWebAclArn(props.webAclArn);
    this.validateSameAccount(certificateAccount, "ACM certificate");
    this.validateSameAccount(webAclAccount, "WAF web ACL");
    if (props.releaseOriginPath !== undefined
      && !RELEASE_ORIGIN_PATH.test(props.releaseOriginPath)) {
      throw new Error(
        "Studio release origin must identify one immutable /releases/opengeo-studio-* prefix"
      );
    }
    if (props.certificateArn !== undefined && props.releaseOriginPath === undefined) {
      throw new Error(
        "Studio custom-domain activation requires the currently active immutable release origin"
      );
    }
    if (props.apiOriginDomain !== undefined
      && !API_ORIGIN_DOMAIN.test(props.apiOriginDomain)) {
      throw new Error(
        "Studio API origin must be an exact us-east-1 API Gateway execute-api domain"
      );
    }

    const releaseOriginPath = new CfnParameter(this, STUDIO_RELEASE_ORIGIN_PARAMETER, {
      type: "String",
      default: props.releaseOriginPath ?? "",
      allowedPattern: props.certificateArn === undefined
        ? "^$|^/releases/opengeo-studio-[0-9]{14}-[0-9a-f]{12}$"
        : "^/releases/opengeo-studio-[0-9]{14}-[0-9a-f]{12}$",
      description:
        "Active immutable Studio release. Release and rollback commands update this parameter through CloudFormation."
    });

    this.bucket = new s3.Bucket(this, "StudioBucket", {
      bucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      autoDeleteObjects: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {abortIncompleteMultipartUploadAfter: Duration.days(7)}
      ]
    });

    this.originAccessControl = new cloudfront.S3OriginAccessControl(
      this,
      "StudioOriginAccessControl",
      {
        originAccessControlName: `${resourceNamePrefix}-web`,
        description: `Read-only CloudFront access to the private ${domainName} bucket`,
        signing: cloudfront.Signing.SIGV4_ALWAYS
      }
    );
    const origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originAccessControl: this.originAccessControl,
      originAccessLevels: [cloudfront.AccessLevel.READ],
      originPath: releaseOriginPath.valueAsString
    });

    const securityHeaders = this.securityHeadersPolicy(
      "StudioSecurityHeaders",
      `${resourceNamePrefix}-security`,
      domainName
    );
    const authConfigHeaders = this.securityHeadersPolicy(
      "StudioAuthConfigHeaders",
      `${resourceNamePrefix}-auth-config`,
      domainName,
      [
        {header: "Cache-Control", value: "no-store, max-age=0", override: true},
        {header: "Pragma", value: "no-cache", override: true},
        {header: "Expires", value: "0", override: true}
      ],
      STUDIO_AUTH_CONFIG_CONTENT_SECURITY_POLICY
    );

    const certificate = props.certificateArn === undefined
      ? undefined
      : acm.Certificate.fromCertificateArn(
          this,
          "StudioCertificate",
          props.certificateArn
        );
    const apiOrigin = props.apiOriginDomain === undefined
      ? undefined
      : new origins.HttpOrigin(props.apiOriginDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2]
        });
    const apiPathRewrite = apiOrigin === undefined
      ? undefined
      : new cloudfront.Function(this, "StudioApiPathRewrite", {
          functionName: `${resourceNamePrefix}-api-prefix`,
          comment: `Remove ${domainName}'s external /api namespace before API Gateway forwarding`,
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
    const publicModulePath = "api/public/organizations/*/artifact-releases/*/module.mjs";
    // The API authorizes one exact S3 object and supplies its frame policy.
    // Keep that policy on these isolated viewers; absent origin CSP fails closed.
    const artifactViewerHeaders = apiOrigin === undefined ? undefined
      : this.securityHeadersPolicy(
          "StudioArtifactViewerHeaders",
          `${resourceNamePrefix}-artifact-viewer`,
          domainName,
          [
            {header: "Cache-Control", value: "private, no-store, max-age=0", override: true},
            {header: "Pragma", value: "no-cache", override: true},
            {header: "Expires", value: "0", override: true}
          ],
          STUDIO_ARTIFACT_VIEWER_FALLBACK_CONTENT_SECURITY_POLICY,
          false
        );
    const publicModuleHeaders = apiOrigin === undefined ? undefined
      : new cloudfront.ResponseHeadersPolicy(this, "StudioPublicModuleHeaders", {
          responseHeadersPolicyName: `${resourceNamePrefix}-public-module`,
          comment: "Public Project module imports; no private API CORS change",
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowOrigins: ["*"],
            accessControlAllowHeaders: ["Content-Type"],
            accessControlAllowMethods: ["GET", "HEAD"],
            originOverride: true
          },
          customHeadersBehavior: {customHeaders: [
            {header: "Cache-Control", value: "no-store", override: true}
          ]},
          securityHeadersBehavior: {
            contentTypeOptions: {override: true},
            referrerPolicy: {referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true}
          }
        });
    const publicModuleRewrite = apiOrigin === undefined ? undefined
      : new cloudfront.Function(this, "StudioPublicModuleRewrite", {
          functionName: `${resourceNamePrefix}-public-module`,
          comment: "Only canonical public Artifact module GETs reach the API; strip caller credentials",
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var id = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  var path = new RegExp('^/api/public/organizations/' + id + '/artifact-releases/' + id + '/module[.]mjs$');
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !path.test(request.uri)) {
    return {statusCode: 404, headers: {'cache-control': {value: 'no-store'},
      'access-control-allow-origin': {value: '*'}, 'x-content-type-options': {value: 'nosniff'}}};
  }
  delete request.headers.authorization;
  delete request.headers.cookie;
  delete request.headers['x-opengeo-organization'];
  request.cookies = {};
  request.uri = request.uri.substring(4);
  return request;
}
`)
        });

    this.distribution = new cloudfront.Distribution(this, "StudioDistribution", {
      comment: domainName,
      defaultRootObject: "index.html",
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(certificate
        ? {
            certificate,
            domainNames: [domainName],
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
            sslSupportMethod: cloudfront.SSLMethod.SNI
          }
        : {}),
      ...(props.webAclArn ? {webAclId: props.webAclArn} : {}),
      defaultBehavior: {
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: securityHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      additionalBehaviors: {
        [RENDERER_FRAME_PATH]: rendererFrameBehavior(this, origin, resourceNamePrefix),
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
              [publicModulePath]: {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: true,
                responseHeadersPolicy: publicModuleHeaders,
                functionAssociations: [{eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: publicModuleRewrite!}],
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
              },
              "api/shared/organizations/*/artifact-shares/*/view": {
                origin: apiOrigin,
                // CloudFront has no GET/HEAD/POST-only method set. The API gate
                // accepts GET/POST and rejects all other unsupported methods.
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: true,
                responseHeadersPolicy: artifactViewerHeaders,
                functionAssociations: [{eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: apiPathRewrite!}],
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
              },
              "api/public/organizations/*/artifact-releases/*/static": {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: true,
                responseHeadersPolicy: artifactViewerHeaders,
                functionAssociations: [{eventType: cloudfront.FunctionEventType.VIEWER_REQUEST, function: apiPathRewrite!}],
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
              },
              "api/*": {
                origin: apiOrigin,
                allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
                cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
                cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
                originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                compress: true,
                responseHeadersPolicy: securityHeaders,
                functionAssociations: [
                  {
                    eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                    function: apiPathRewrite!
                  }
                ],
                viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
              }
            }
          : {})
      }
    });

    const customDomainReady = certificate !== undefined;
    new CfnOutput(this, "StudioBucketName", {
      value: this.bucket.bucketName,
      description: "Private S3 origin for compiled OpenGeo Studio releases"
    });
    new CfnOutput(this, "StudioDistributionId", {
      value: this.distribution.distributionId
    });
    new CfnOutput(this, "StudioDistributionDomainName", {
      value: this.distribution.distributionDomainName,
      description: "CloudFront hostname used for bootstrap verification and DNS"
    });
    new CfnOutput(this, "StudioPreviewUrl", {
      value: `https://${this.distribution.distributionDomainName}`
    });
    const releaseOriginOutput = new CfnOutput(this, "StudioActiveReleaseOriginPath", {
      value: releaseOriginPath.valueAsString,
      description: "CloudFormation-owned active immutable Studio release prefix"
    });
    releaseOriginOutput.overrideLogicalId("StudioReleaseOriginPath");
    new CfnOutput(this, "StudioUrl", {
      value: customDomainReady
        ? `https://${domainName}`
        : `https://${this.distribution.distributionDomainName}`
    });
    new CfnOutput(this, "StudioDnsActivationReady", {
      value: String(customDomainReady),
      description: "Create the external CNAME only when this value is true"
    });
    new CfnOutput(this, "StudioDnsZone", {value: dnsZone});
    new CfnOutput(this, "StudioDnsRecordHost", {value: dnsRecordHost});
    new CfnOutput(this, "StudioDnsRecordName", {value: domainName});
    new CfnOutput(this, "StudioDnsRecordType", {value: "CNAME"});
    new CfnOutput(this, "StudioDnsRecordValue", {
      value: this.distribution.distributionDomainName
    });
    new CfnOutput(this, "StudioDnsHandoff", {
      value: customDomainReady
        ? this.toJsonString({
            provider: "DNS Made Easy",
            type: "CNAME",
            zone: dnsZone,
            name: dnsRecordHost,
            fqdn: domainName,
            value: this.distribution.distributionDomainName,
            ttlSeconds: 300
          })
        : `Do not create the ${domainName} CNAME until a validated us-east-1 certificate ARN is supplied. Use StudioPreviewUrl for bootstrap verification.`,
      description: "Manual external-DNS handoff; this stack never changes Route53"
    });
  }

  private securityHeadersPolicy(
    id: string,
    name: string,
    domainName: string,
    extraHeaders: cloudfront.ResponseCustomHeader[] = [],
    contentSecurityPolicy = STUDIO_CONTENT_SECURITY_POLICY,
    contentSecurityPolicyOverride = true
  ): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, id, {
      responseHeadersPolicyName: name,
      comment: `${domainName} browser security headers`,
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy,
          override: contentSecurityPolicyOverride
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
        xssProtection: {
          protection: true,
          modeBlock: true,
          override: true
        }
      },
      customHeadersBehavior: {
        customHeaders: [
          {
            header: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self)",
            override: true
          },
          {
            header: "X-Permitted-Cross-Domain-Policies",
            value: "none",
            override: true
          },
          ...extraHeaders
        ]
      }
    });
  }

  private validateDeploymentRegion(): void {
    if (!Token.isUnresolved(this.region) && this.region !== "us-east-1") {
      throw new Error(
        "OpenGeo Studio web edge must be deployed in us-east-1 so its CloudFront certificate is regionalized correctly"
      );
    }
  }

  private validateCertificateArn(value: string): string {
    const match = CERTIFICATE_ARN.exec(value);
    if (!match?.[1]) {
      throw new Error(
        "Studio certificate ARN must be a literal us-east-1 ACM certificate ARN already validated for the configured Studio domain"
      );
    }
    return match[1];
  }

  private validateDomainName(value: string): string {
    if (!STUDIO_DOMAIN.test(value)) {
      throw new Error("Studio domain must be studio.opengeo.tools or a bounded subdomain of it");
    }
    return value;
  }

  private validateBucketName(value: string): string {
    // Production predates the non-dotted naming rule. Preserve that exact
    // retained bucket rather than proposing a replacement during an edge update.
    if (value === STUDIO_DOMAIN_NAME && this.account === "111111111111") {
      return value;
    }
    if (!S3_BUCKET_NAME.test(value)) {
      throw new Error("Studio bucket must be a literal non-dotted DNS-compatible S3 bucket name");
    }
    return value;
  }

  private validateResourceNamePrefix(value: string): string {
    if (!RESOURCE_NAME_PREFIX.test(value)) {
      throw new Error("Studio resource-name prefix must be a bounded lowercase hyphenated name");
    }
    return value;
  }

  private validateDnsZone(value: string): string {
    if (!DNS_ZONE.test(value)) {
      throw new Error("Studio DNS zone must be a literal DNS zone name");
    }
    return value;
  }

  private validateDnsRecordHost(value: string): string {
    if (!DNS_RECORD_HOST.test(value)) {
      throw new Error("Studio DNS record host must be a literal relative DNS name");
    }
    return value;
  }

  private validateWebAclArn(value: string): string {
    const match = WEB_ACL_ARN.exec(value);
    if (!match?.[1]) {
      throw new Error(
        "Studio WAF ARN must be a literal us-east-1 WAFv2 global web ACL ARN"
      );
    }
    return match[1];
  }

  private validateSameAccount(resourceAccount: string | undefined, label: string): void {
    if (
      resourceAccount &&
      !Token.isUnresolved(this.account) &&
      this.account !== resourceAccount
    ) {
      throw new Error(`${label} must belong to the same AWS account as OpenGeo Studio`);
    }
  }
}
