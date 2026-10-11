import {createHash, createHmac} from "node:crypto";

const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const ACCESS_KEY = /^[A-Z0-9]{16,128}$/;
const LOOPBACK_CREDENTIAL_HOSTS = new Set([
  "169.254.169.254",
  "169.254.170.2",
  "127.0.0.1",
  "localhost"
]);

export class AwsDependencyError extends Error {
  constructor(code) {
    super(code);
    this.name = "AwsDependencyError";
    this.code = code;
    this.retryable = true;
  }
}

export class AwsCredentialProvider {
  constructor({fetchImplementation = globalThis.fetch, environment = process.env, now = Date.now} = {}) {
    if (typeof fetchImplementation !== "function" || typeof now !== "function") {
      throw new AwsDependencyError("aws_configuration_invalid");
    }
    this.fetch = fetchImplementation;
    this.environment = environment;
    this.now = now;
    this.cached = null;
  }

  async load() {
    if (this.cached !== null && this.cached.expiresAt - this.now() > 300_000) {
      return {...this.cached.credentials};
    }
    const credentials = this.#environmentCredentials() ?? await this.#metadataCredentials();
    this.cached = {credentials, expiresAt: credentials.expiration ?? this.now() + 15 * 60_000};
    return {...credentials};
  }

  #environmentCredentials() {
    const accessKeyId = this.environment.AWS_ACCESS_KEY_ID;
    const secretAccessKey = this.environment.AWS_SECRET_ACCESS_KEY;
    const sessionToken = this.environment.AWS_SESSION_TOKEN;
    if (accessKeyId === undefined && secretAccessKey === undefined && sessionToken === undefined) {
      return null;
    }
    return validateCredentials({accessKeyId, secretAccessKey, sessionToken});
  }

  async #metadataCredentials() {
    const relative = this.environment.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    const full = this.environment.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    if (relative !== undefined || full !== undefined) {
      let url;
      if (relative !== undefined) {
        if (!/^\/[A-Za-z0-9/_+=.@-]{1,1024}$/.test(relative)) {
          throw new AwsDependencyError("aws_credentials_unavailable");
        }
        url = new URL(`http://169.254.170.2${relative}`);
      } else {
        try {
          url = new URL(full);
        } catch {
          throw new AwsDependencyError("aws_credentials_unavailable");
        }
        if (url.protocol !== "http:" || !LOOPBACK_CREDENTIAL_HOSTS.has(url.hostname)) {
          throw new AwsDependencyError("aws_credentials_unavailable");
        }
      }
      const token = this.environment.AWS_CONTAINER_AUTHORIZATION_TOKEN;
      return this.#readCredentialDocument(url, token === undefined ? {} : {Authorization: token});
    }
    return this.#instanceCredentials();
  }

  async #instanceCredentials() {
    const origin = "http://169.254.169.254";
    const token = await boundedFetch(this.fetch, `${origin}/latest/api/token`, {
      method: "PUT",
      headers: {"x-aws-ec2-metadata-token-ttl-seconds": "21600"}
    }, 4096);
    const metadataToken = (await boundedResponseBytes(token, 4096)).toString("utf8");
    if (!token.ok || !metadataToken || metadataToken.length > 4096) {
      throw new AwsDependencyError("aws_credentials_unavailable");
    }
    const headers = {"x-aws-ec2-metadata-token": metadataToken};
    const roleResponse = await boundedFetch(
      this.fetch,
      `${origin}/latest/meta-data/iam/security-credentials/`,
      {headers},
      4096
    );
    const role = (await boundedResponseBytes(roleResponse, 4096)).toString("utf8").trim();
    if (!roleResponse.ok || !/^[A-Za-z0-9+=,.@_-]{1,128}$/.test(role)) {
      throw new AwsDependencyError("aws_credentials_unavailable");
    }
    return this.#readCredentialDocument(
      new URL(`${origin}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`),
      headers
    );
  }

  async #readCredentialDocument(url, headers) {
    const response = await boundedFetch(this.fetch, url, {headers}, 65_536);
    if (!response.ok) throw new AwsDependencyError("aws_credentials_unavailable");
    let value;
    try {
      value = JSON.parse((await boundedResponseBytes(response, 65_536)).toString("utf8"));
    } catch {
      throw new AwsDependencyError("aws_credentials_unavailable");
    }
    const expiration = Date.parse(value.Expiration ?? "");
    return validateCredentials({
      accessKeyId: value.AccessKeyId,
      secretAccessKey: value.SecretAccessKey,
      sessionToken: value.Token,
      expiration: Number.isFinite(expiration) ? expiration : undefined
    });
  }
}

export class AwsSigV4Client {
  constructor({region, credentials, fetchImplementation = globalThis.fetch, now = () => new Date()} = {}) {
    if (!REGION.test(region ?? "") || typeof fetchImplementation !== "function") {
      throw new AwsDependencyError("aws_configuration_invalid");
    }
    this.region = region;
    this.credentials = credentials ?? new AwsCredentialProvider({fetchImplementation});
    this.fetch = fetchImplementation;
    this.now = now;
  }

  async request({service, method, host, path, query = [], headers = {}, body = Buffer.alloc(0), maximumResponseBytes}) {
    if (
      !/^[a-z0-9-]{1,64}$/.test(service) ||
      !["GET", "HEAD", "POST", "PUT"].includes(method) ||
      !/^[A-Za-z0-9.-]{1,253}$/.test(host) ||
      typeof path !== "string" || !path.startsWith("/") || path.includes("?") ||
      !Buffer.isBuffer(body) || body.length > 33_554_432 ||
      !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 0
    ) {
      throw new AwsDependencyError("aws_request_invalid");
    }
    const credential = validateCredentials(await this.credentials.load());
    const timestamp = this.now();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
      throw new AwsDependencyError("aws_configuration_invalid");
    }
    const amzDate = timestamp.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const canonicalHeaders = new Map([
      ["host", host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", amzDate]
    ]);
    for (const [name, value] of Object.entries(headers)) {
      const normalizedName = name.toLowerCase();
      if (!/^[a-z0-9-]{1,64}$/.test(normalizedName) || typeof value !== "string") {
        throw new AwsDependencyError("aws_request_invalid");
      }
      canonicalHeaders.set(normalizedName, value.trim().replace(/\s+/g, " "));
    }
    if (credential.sessionToken !== undefined) {
      canonicalHeaders.set("x-amz-security-token", credential.sessionToken);
    }
    const signedNames = [...canonicalHeaders.keys()].sort();
    const canonicalHeaderText = signedNames
      .map((name) => `${name}:${canonicalHeaders.get(name)}\n`)
      .join("");
    const canonicalQuery = canonicalizeQuery(query);
    const canonicalRequest = [
      method,
      path,
      canonicalQuery,
      canonicalHeaderText,
      signedNames.join(";"),
      payloadHash
    ].join("\n");
    const scope = `${date}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256(Buffer.from(canonicalRequest))
    ].join("\n");
    const signature = createHmac("sha256", signingKey(credential.secretAccessKey, date, this.region, service))
      .update(stringToSign)
      .digest("hex");
    canonicalHeaders.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`
    );
    const url = `https://${host}${path}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    const response = await boundedFetch(
      this.fetch,
      url,
      {method, headers: Object.fromEntries(canonicalHeaders), body: body.length === 0 ? undefined : body},
      maximumResponseBytes
    );
    return response;
  }
}

export async function boundedResponseBytes(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new AwsDependencyError("aws_response_too_large");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new AwsDependencyError("aws_response_too_large");
  return bytes;
}

function validateCredentials(value) {
  if (
    value === null || typeof value !== "object" ||
    !ACCESS_KEY.test(value.accessKeyId ?? "") ||
    typeof value.secretAccessKey !== "string" ||
    value.secretAccessKey.length < 16 || value.secretAccessKey.length > 256 ||
    (value.sessionToken !== undefined &&
      (typeof value.sessionToken !== "string" || value.sessionToken.length < 1 || value.sessionToken.length > 8192))
  ) {
    throw new AwsDependencyError("aws_credentials_unavailable");
  }
  return {
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
    ...(value.sessionToken === undefined ? {} : {sessionToken: value.sessionToken}),
    ...(value.expiration === undefined ? {} : {expiration: value.expiration})
  };
}

function canonicalizeQuery(query) {
  if (!Array.isArray(query) || query.length > 16) throw new AwsDependencyError("aws_request_invalid");
  return query
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue)
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export function awsEncode(value) {
  if (typeof value !== "string") throw new AwsDependencyError("aws_request_invalid");
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function signingKey(secret, date, region, service) {
  const dateKey = createHmac("sha256", `AWS4${secret}`).update(date).digest();
  const regionKey = createHmac("sha256", dateKey).update(region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(service).digest();
  return createHmac("sha256", serviceKey).update("aws4_request").digest();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function boundedFetch(fetchImplementation, url, options, maximumBytes) {
  let response;
  try {
    response = await fetchImplementation(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    throw new AwsDependencyError("aws_transport_unavailable");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new AwsDependencyError("aws_response_too_large");
  }
  return response;
}
