import {createPublicKey} from "node:crypto";
import {fileURLToPath} from "node:url";
import {
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_kms as kms,
  aws_s3 as s3,
  aws_s3_deployment as deployment
} from "aws-cdk-lib";
import {Construct} from "constructs";

export const OBSERVABLE_PREVIEW_DOMAIN_NAME = "preview.studio.opengeo.tools";
export const OBSERVABLE_PREVIEW_ORIGIN = `https://${OBSERVABLE_PREVIEW_DOMAIN_NAME}`;
export const OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME = "maps-preview.studio.opengeo.tools";
export const OBSERVABLE_PUBLIC_MAPS_PREVIEW_ORIGIN = `https://${OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME}`;
export const OBSERVABLE_PREVIEW_SHELL_BUCKET_NAME = "preview-shell.studio.opengeo.tools";

// Exact browser-only draft bootstrap. Auth shell, signed builds and Studio keep
// their existing policies. The nested srcdoc also supplies its stricter CSP.
export const OBSERVABLE_PREVIEW_DRAFT_CSP = [
  "default-src 'none'", "base-uri 'none'", "object-src 'none'",
  "frame-ancestors https://studio.opengeo.tools https://demo.studio.opengeo.tools", "frame-src 'none'",
  "form-action 'none'", "script-src 'unsafe-inline' data:",
  "script-src-attr 'none'", "style-src 'unsafe-inline' data:",
  "font-src data:", "img-src data: blob:", "connect-src data: blob:",
  "worker-src blob:"
].join("; ");

export const OBSERVABLE_PREVIEW_BUILD_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  // Retained map HTML is an output asset of this signed build. Every nested
  // request still passes CloudFront's path-scoped signed-cookie authorization.
  "frame-ancestors 'self' https://studio.opengeo.tools",
  "frame-src 'self'",
  "form-action 'none'",
  // Native single-HTML output carries its verified module graph as data: URLs
  // and FileAttachment/font bytes as document-created Blob URLs. These local
  // URI schemes add no network origin; saved code already permits inline/eval.
  // Signed-cookie output authorization and shell/draft policies stay separate.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data:",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "manifest-src 'self'"
].join("; ");

export const OBSERVABLE_PREVIEW_SHELL_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors https://studio.opengeo.tools",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "connect-src 'self'"
].join("; ");

const CERTIFICATE_ARN =
  /^arn:aws:acm:us-east-1:([0-9]{12}):certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const API_ORIGIN_DOMAIN = /^[a-z0-9]{10}\.execute-api\.us-east-1\.amazonaws\.com$/;
const WEB_ACL_ARN =
  /^arn:aws:wafv2:us-east-1:([0-9]{12}):global\/webacl\/[A-Za-z0-9_-]{1,128}\/[0-9a-f-]{36}$/;
const OUTPUT_OBJECTS =
  "organizations/*/projects/*/source-projects/*/builds/*/output/*";
const INDEPENDENT_FQDN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const INDEPENDENT_BUCKET = /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export interface ObservablePreviewIndependentDeployment {
  readonly previewDomainName: string;
  readonly studioOrigin: string;
  readonly shellBucketName: string;
  readonly resourceNamePrefix: string;
  readonly publicMapsPreviewDomainName?: string;
}

function managedName(value: string): boolean {
  return value === "opengeo.tools" || value.endsWith(".opengeo.tools") ||
    value === "opengeo-studio-111111111111-us-east-1";
}

function independentBucketName(value: string): boolean {
  return INDEPENDENT_BUCKET.test(value) && !managedName(value) &&
    !["xn--", "sthree-", "amzn-s3-demo-"].some(prefix => value.startsWith(prefix)) &&
    !["-s3alias", "--ol-s3", ".mrap", "--x-s3", "--table-s3"].some(suffix => value.endsWith(suffix));
}

function exactLiteralBucket(bucket: s3.IBucket, expected: string): boolean {
  if (!Token.isUnresolved(bucket.bucketName)) return bucket.bucketName === expected;
  const resource = bucket.node.defaultChild;
  return resource instanceof s3.CfnBucket && typeof resource.bucketName === "string" &&
    !Token.isUnresolved(resource.bucketName) && resource.bucketName === expected;
}

function validateIndependentDeployment(props: ObservablePreviewEdgeProps): ObservablePreviewIndependentDeployment | undefined {
  const value = props.independentDeployment;
  if (value === undefined) return undefined;
  const invalid = (): never => { throw new Error("Invalid independent Observable preview deployment"); };
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !["previewDomainName,resourceNamePrefix,shellBucketName,studioOrigin",
        "previewDomainName,publicMapsPreviewDomainName,resourceNamePrefix,shellBucketName,studioOrigin"]
        .includes(Object.keys(value).sort().join(",")) ||
      Object.values(value).some(item => typeof item !== "string")) invalid();
  let studio: URL;
  try { studio = new URL(value.studioOrigin); }
  catch { return invalid(); }
  if (studio.protocol !== "https:" || studio.origin !== value.studioOrigin || studio.port ||
      studio.username || studio.password || !INDEPENDENT_FQDN.test(studio.hostname) ||
      managedName(studio.hostname) || !INDEPENDENT_FQDN.test(value.previewDomainName) ||
      managedName(value.previewDomainName) || value.previewDomainName === studio.hostname ||
      value.previewDomainName === props.apiOriginDomain ||
      !/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(value.resourceNamePrefix) ||
      value.resourceNamePrefix === "opengeo-observable-preview" ||
      !independentBucketName(value.shellBucketName) || !independentBucketName(props.applicationBucketName) ||
      value.shellBucketName === props.applicationBucketName ||
      !exactLiteralBucket(props.applicationBucket, props.applicationBucketName)) invalid();
  if (props.enablePublicMapsPreview === true) {
    const maps = value.publicMapsPreviewDomainName;
    if (typeof maps !== "string" || !INDEPENDENT_FQDN.test(maps) || managedName(maps) ||
        [value.previewDomainName, studio.hostname, props.apiOriginDomain].includes(maps)) invalid();
  } else if (value.publicMapsPreviewDomainName !== undefined) invalid();
  return value;
}

export function observablePreviewBuildCsp(apiOriginDomain: string): string {
  if (!API_ORIGIN_DOMAIN.test(apiOriginDomain)) throw new Error("Invalid preview public API origin");
  return OBSERVABLE_PREVIEW_BUILD_CSP.replace("frame-src 'self'",
    `frame-src 'self' https://${apiOriginDomain}/public/organizations/`);
}

/** Browser delivery only: the compiler and default private preview keep their policies. */
export function observablePublicMapsPreviewBuildCsp(apiOriginDomain: string): string {
  const scripts = [
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet-src.js",
    "https://cdn.jsdelivr.net/npm/esri-leaflet@3.0.12/dist/esri-leaflet-debug.js"
  ];
  // d3-require resolves the two package mains and Esri's AMD Leaflet peer.
  // Only the peer metadata accepts a range; executable scripts stay pinned.
  const metadata = [
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/package.json",
    "https://cdn.jsdelivr.net/npm/esri-leaflet@3.0.12/package.json",
    "https://cdn.jsdelivr.net/npm/leaflet@%5E1.0.0/package.json"
  ];
  const images = [
    "https://unpkg.com/leaflet@1.9.4/dist/images/",
    ...["slr", "conf"].flatMap(kind => Array.from({length: 11}, (_, feet) =>
      `https://coast.noaa.gov/arcgis/rest/services/dc_slr/${kind}_${feet}ft/MapServer/tile/`)),
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/",
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/",
    "https://a.tile.openstreetmap.org/",
    "https://b.tile.openstreetmap.org/",
    "https://c.tile.openstreetmap.org/"
  ];
  return observablePreviewBuildCsp(apiOriginDomain)
    .replace("script-src 'self' 'unsafe-inline' 'unsafe-eval' data:",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' data: ${scripts.join(" ")}`)
    .replace("style-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://unpkg.com/leaflet@1.9.4/dist/leaflet.css")
    .replace("img-src 'self' data: blob:", `img-src 'self' data: blob: ${images.join(" ")}`)
    .replace("connect-src 'self' data: blob:", `connect-src 'self' data: blob: ${metadata.join(" ")}`);
}

export interface ObservablePreviewEdgeProps {
  readonly applicationBucket: s3.IBucket;
  /** Literal bucket name avoids a KMS-key/bucket CloudFormation policy cycle. */
  readonly applicationBucketName: string;
  readonly dataKey: kms.IKey;
  readonly apiOriginDomain: string;
  /** When public maps preview is enabled, the same certificate must cover both preview aliases. */
  readonly certificateArn: string;
  readonly publicKeyPem: string;
  readonly webAclArn?: string;
  /** Explicit operator opt-in for public_maps_v1 delivery on the separate maps-preview alias. */
  readonly enablePublicMapsPreview?: boolean;
  /** Operator can upload these three static shell files separately without a deployment Lambda. */
  readonly deployShell?: boolean;
  /** Explicit account-local names and Studio framing authority; managed defaults stay fixed. */
  readonly independentDeployment?: ObservablePreviewIndependentDeployment;
}

/**
 * A separate-origin preview edge. Only the authorization shell and one exact
 * API exchange route are public; all compiler output requires signed cookies.
 */
export class ObservablePreviewEdge extends Construct {
  readonly distribution: cloudfront.Distribution;
  readonly publicKey: cloudfront.PublicKey;
  readonly keyGroup: cloudfront.KeyGroup;
  readonly shellBucket: s3.Bucket;
  readonly previewOrigin: string;
  readonly publicMapsPreviewOrigin?: string;

  constructor(scope: Construct, id: string, props: ObservablePreviewEdgeProps) {
    super(scope, id);
    const stack = Stack.of(this);
    if (!Token.isUnresolved(stack.region) && stack.region !== "us-east-1") {
      throw new Error("Observable preview edge must be deployed in us-east-1");
    }
    const certificateAccount = validateCertificateArn(props.certificateArn);
    if (!Token.isUnresolved(stack.account) && certificateAccount !== stack.account) {
      throw new Error("Observable preview certificate must belong to the deployment account");
    }
    if (!API_ORIGIN_DOMAIN.test(props.apiOriginDomain)) {
      throw new Error("Observable preview API origin must be an exact us-east-1 API Gateway domain");
    }
    if (props.enablePublicMapsPreview !== undefined && typeof props.enablePublicMapsPreview !== "boolean") {
      throw new Error("Observable public maps preview must be an explicit boolean opt-in");
    }
    const publicMapsPreviewEnabled = props.enablePublicMapsPreview === true;
    const independent = validateIndependentDeployment(props);
    const previewDomainName = independent?.previewDomainName ?? OBSERVABLE_PREVIEW_DOMAIN_NAME;
    const mapsDomainName = independent?.publicMapsPreviewDomainName ?? OBSERVABLE_PUBLIC_MAPS_PREVIEW_DOMAIN_NAME;
    const namePrefix = independent?.resourceNamePrefix ?? "opengeo-observable-preview";
    this.previewOrigin = `https://${previewDomainName}`;
    const frameAncestors = (csp: string) => independent === undefined ? csp : csp.replace(
      /frame-ancestors [^;]+/,
      directive => `frame-ancestors ${directive.includes("'self'") ? "'self' " : ""}${independent.studioOrigin}`
    );
    if (independent === undefined && props.applicationBucketName !== "source.opengeo.tools") {
      throw new Error("Observable preview must read the exact production application bucket");
    }
    if (props.webAclArn !== undefined) {
      const webAclAccount = WEB_ACL_ARN.exec(props.webAclArn)?.[1];
      if (webAclAccount === undefined
        || (!Token.isUnresolved(stack.account) && webAclAccount !== stack.account)) {
        throw new Error("Observable preview WAF must be an exact same-account global web ACL");
      }
    }
    validatePublicKey(props.publicKeyPem);

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      "Certificate",
      props.certificateArn
    );
    this.publicKey = new cloudfront.PublicKey(this, "SigningPublicKey", {
      publicKeyName: namePrefix,
      comment: "Verifies short-lived path-scoped OpenGeo private preview cookies",
      encodedKey: props.publicKeyPem
    });
    this.keyGroup = new cloudfront.KeyGroup(this, "SigningKeyGroup", {
      keyGroupName: namePrefix,
      comment: "Only the OpenGeo API holds the matching private signing key",
      items: [this.publicKey]
    });

    this.shellBucket = new s3.Bucket(this, "ShellBucket", {
      bucketName: independent?.shellBucketName ?? OBSERVABLE_PREVIEW_SHELL_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      autoDeleteObjects: false,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{abortIncompleteMultipartUploadAfter: Duration.days(7)}]
    });

    const applicationOac = new cloudfront.S3OriginAccessControl(this, "OutputOac", {
      originAccessControlName: `${namePrefix}-output`,
      description: "Read only exact private Observable build outputs",
      signing: cloudfront.Signing.SIGV4_ALWAYS
    });
    const shellOac = new cloudfront.S3OriginAccessControl(this, "ShellOac", {
      originAccessControlName: `${namePrefix}-shell`,
      description: "Read only the public capability exchange shell",
      signing: cloudfront.Signing.SIGV4_ALWAYS
    });
    const applicationOrigin = new RestrictedS3Origin(
      props.applicationBucket,
      applicationOac
    );
    const shellOrigin = new RestrictedS3Origin(this.shellBucket, shellOac);
    const apiOrigin = new origins.HttpOrigin(props.apiOriginDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2]
    });
    const authorizeRewrite = new cloudfront.Function(this, "AuthorizeRewrite", {
      functionName: `${namePrefix}-authorize`,
      comment: "Resolve only the canonical /authorize/ bootstrap document",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri === '/authorize/') request.uri = '/authorize/index.html';
  return request;
}
`)
    });

    const buildHeaders = securityHeaders(
      this,
      "BuildHeaders",
      `${namePrefix}-build`,
      frameAncestors(observablePreviewBuildCsp(props.apiOriginDomain)),
      false
    );
    const shellHeaders = securityHeaders(
      this,
      "ShellHeaders",
      `${namePrefix}-shell`,
      frameAncestors(OBSERVABLE_PREVIEW_SHELL_CSP),
      true
    );
    const exchangeHeaders = securityHeaders(
      this,
      "ExchangeHeaders",
      `${namePrefix}-exchange`,
      "default-src 'none'; frame-ancestors 'none'",
      true
    );
    const draftHeaders = securityHeaders(this, "DraftHeaders",
      `${namePrefix}-draft`, frameAncestors(OBSERVABLE_PREVIEW_DRAFT_CSP), true);
    // Response headers policies run before viewer-response Functions. The
    // strict BuildHeaders policy therefore remains the fallback for every
    // other host, including the CloudFront domain and an absent Host header.
    // Only output uses this function; shell/draft/exchange policies stay intact.
    const publicMapsHeaders = publicMapsPreviewEnabled
      ? new cloudfront.Function(this, "PublicMapsBuildHeaders", {
        functionName: `${namePrefix}-public-maps-v1`,
        comment: "Select public_maps_v1 CSP only for the opted-in maps-preview alias",
        runtime: cloudfront.FunctionRuntime.JS_2_0,
        code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var host = event.request.headers.host;
  if (host && host.value === ${JSON.stringify(mapsDomainName)}) {
    event.response.headers['content-security-policy'] = {
      value: ${JSON.stringify(frameAncestors(observablePublicMapsPreviewBuildCsp(props.apiOriginDomain)))}
    };
  }
  return event.response;
}
`)
      })
      : undefined;

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: previewDomainName,
      certificate,
      domainNames: [previewDomainName,
        ...(publicMapsPreviewEnabled ? [mapsDomainName] : [])],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_3_2025,
      sslSupportMethod: cloudfront.SSLMethod.SNI,
      enableIpv6: true,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      ...(props.webAclArn ? {webAclId: props.webAclArn} : {}),
      defaultBehavior: {
        origin: applicationOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: buildHeaders,
        ...(publicMapsHeaders ? {functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE,
          function: publicMapsHeaders
        }]} : {}),
        trustedKeyGroups: [this.keyGroup],
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
      },
      additionalBehaviors: {
        "authorize/draft.html": {
          origin: shellOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          responseHeadersPolicy: draftHeaders,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        },
        "authorize/*": {
          origin: shellOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          responseHeadersPolicy: shellHeaders,
          functionAssociations: [{
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            function: authorizeRewrite
          }],
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        },
        "observable-preview/exchange": {
          origin: apiOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: false,
          responseHeadersPolicy: exchangeHeaders,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        }
      }
    });

    const sourceArn = `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/${this.distribution.distributionId}`;
    props.applicationBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: "AllowExactObservablePreviewOutputRead",
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      actions: ["s3:GetObject"],
      resources: [props.applicationBucket.arnForObjects(OUTPUT_OBJECTS)],
      conditions: {StringEquals: {"AWS:SourceArn": sourceArn}}
    }));
    this.shellBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: "AllowObservablePreviewShellRead",
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      actions: ["s3:GetObject"],
      resources: [this.shellBucket.arnForObjects("authorize/*")],
      conditions: {StringEquals: {"AWS:SourceArn": sourceArn}}
    }));
    props.dataKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: "AllowObservablePreviewOutputDecrypt",
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      actions: ["kms:Decrypt"],
      resources: ["*"],
      conditions: {
        ArnLike: {
          "AWS:SourceArn":
            `arn:${Aws.PARTITION}:cloudfront::${Aws.ACCOUNT_ID}:distribution/*`
        },
        StringEquals: {
          "kms:ViaService": `s3.${stack.region}.${Aws.URL_SUFFIX}`,
          // S3 Bucket Keys deliberately use the bucket ARN, not an object ARN,
          // as their encryption context. The S3 policy above is what narrows
          // object reads to the build-output prefix.
          "kms:EncryptionContext:aws:s3:arn":
            `arn:${Aws.PARTITION}:s3:::${props.applicationBucketName}`
        }
      }
    }));

    if (props.deployShell !== false) new deployment.BucketDeployment(this, "ShellDeployment", {
      sources: [deployment.Source.asset(
        fileURLToPath(new URL("../../services/observable-preview/authorize", import.meta.url))
      )],
      destinationBucket: this.shellBucket,
      destinationKeyPrefix: "authorize",
      prune: true,
      retainOnDelete: true,
      distribution: this.distribution,
      distributionPaths: ["/authorize/*"]
    });

    new CfnOutput(stack, "ObservablePreviewDistributionId", {
      value: this.distribution.distributionId
    });
    new CfnOutput(stack, "ObservablePreviewDistributionDomainName", {
      value: this.distribution.distributionDomainName
    });
    new CfnOutput(stack, "ObservablePreviewCloudFrontKeyPairId", {
      value: this.publicKey.publicKeyId,
      description: "Configure the API with this public-key id and its separately held private key"
    });
    if (publicMapsPreviewEnabled) {
      this.publicMapsPreviewOrigin = `https://${mapsDomainName}`;
      new CfnOutput(stack, "ObservablePublicMapsPreviewOrigin", {
        value: this.publicMapsPreviewOrigin,
        description: "Requires the shared certificate to cover both aliases and a separate DNS handoff"
      });
    }
    new CfnOutput(stack, "ObservablePreviewDnsHandoff", {
      value: stack.toJsonString(independent === undefined ? {
        provider: "DNS Made Easy",
        type: "CNAME",
        zone: "opengeo.tools",
        name: "preview.studio",
        fqdn: OBSERVABLE_PREVIEW_DOMAIN_NAME,
        value: this.distribution.distributionDomainName,
        ttlSeconds: 300
      } : {
        type: "CNAME",
        fqdn: previewDomainName,
        value: this.distribution.distributionDomainName,
        ttlSeconds: 300
      })
    });
  }
}

class RestrictedS3Origin extends cloudfront.OriginBase {
  constructor(bucket: s3.IBucket, oac: cloudfront.IOriginAccessControl) {
    super(bucket.bucketRegionalDomainName, {
      originAccessControlId: oac.originAccessControlId
    });
  }

  protected override renderS3OriginConfig(): cloudfront.CfnDistribution.S3OriginConfigProperty {
    return {originAccessIdentity: ""};
  }
}

function securityHeaders(
  scope: Construct,
  id: string,
  name: string,
  contentSecurityPolicy: string,
  noStore: boolean
): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    responseHeadersPolicyName: name,
    securityHeadersBehavior: {
      contentSecurityPolicy: {contentSecurityPolicy, override: true},
      contentTypeOptions: {override: true},
      referrerPolicy: {
        referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
        override: true
      },
      strictTransportSecurity: {
        accessControlMaxAge: Duration.days(365),
        includeSubdomains: true,
        preload: false,
        override: true
      }
    },
    customHeadersBehavior: {
      customHeaders: [
        {
          header: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          override: true
        },
        {header: "Cross-Origin-Opener-Policy", value: "same-origin", override: true},
        {header: "Cross-Origin-Resource-Policy", value: "same-origin", override: true},
        {header: "X-Permitted-Cross-Domain-Policies", value: "none", override: true},
        ...(noStore
          ? [{header: "Cache-Control", value: "no-store, max-age=0", override: true}]
          : [])
      ]
    }
  });
}

function validateCertificateArn(value: string): string {
  const match = CERTIFICATE_ARN.exec(value);
  if (!match?.[1]) {
    throw new Error(
      "Observable preview certificate must be an exact us-east-1 ACM certificate ARN"
    );
  }
  return match[1];
}

function validatePublicKey(value: string): void {
  if (value.length > 8192 || !value.endsWith("\n")) {
    throw new Error("Observable preview public key PEM is invalid");
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "rsa"
      || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error("invalid RSA key");
    }
  } catch (error) {
    throw new Error("Observable preview public key must be RSA with at least 2048 bits", {
      cause: error
    });
  }
}
