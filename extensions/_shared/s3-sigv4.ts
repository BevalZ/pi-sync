/**
 * Minimal AWS Signature Version 4 helpers for S3-compatible APIs.
 * No AWS SDK dependency — pure Node crypto + fetch-friendly headers.
 *
 * Supports Amazon S3, MinIO, Cloudflare R2, and other SigV4 gateways.
 */

import { createHash, createHmac } from "node:crypto";

export function sha256Hex(data: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

export function amzDate(date = new Date()): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

/** Encode a path for S3: encode each segment, keep `/`. */
export function encodeS3Path(objectKey: string): string {
  return objectKey
    .split("/")
    .filter((seg, i, arr) => !(seg === "" && (i === 0 || i === arr.length - 1)))
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function buildCanonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k] ?? "")}`)
    .join("&");
}

export interface SigV4Request {
  method: string;
  /** Path starting with `/`, URI-encoded (slashes preserved). */
  canonicalUri: string;
  /** Sorted canonical query string (no leading `?`). */
  canonicalQuerystring: string;
  /** Header map (host required). Values are trimmed for signing. */
  headers: Record<string, string>;
  /** Hex payload hash, or UNSIGNED-PAYLOAD. */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service?: string;
  date?: Date;
}

export interface SignedRequest {
  amzDate: string;
  authorization: string;
  headers: Record<string, string>;
}

export function signAwsV4(req: SigV4Request): SignedRequest {
  const service = req.service ?? "s3";
  const { amzDate: amz, dateStamp } = amzDate(req.date);
  const headers: Record<string, string> = { ...req.headers };

  headers["x-amz-date"] = amz;
  headers["x-amz-content-sha256"] = req.payloadHash;
  if (req.sessionToken) {
    headers["x-amz-security-token"] = req.sessionToken;
  }

  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }

  const signedHeaderKeys = Object.keys(normalized).sort();
  const signedHeaders = signedHeaderKeys.join(";");
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${normalized[k]}\n`).join("");

  const canonicalRequest = [
    req.method.toUpperCase(),
    req.canonicalUri || "/",
    req.canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    req.payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${req.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amz,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = getSignatureKey(req.secretAccessKey, dateStamp, req.region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    amzDate: amz,
    authorization,
    headers: {
      ...headers,
      Authorization: authorization,
    },
  };
}

function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/**
 * Build S3 request URL parts.
 * - AWS default: virtual-hosted (`bucket.s3.region.amazonaws.com/key`)
 * - Custom endpoint (MinIO/R2): path-style by default (`endpoint/bucket/key`)
 */
export function buildS3Url(opts: {
  bucket: string;
  region: string;
  /** Object key without leading slash; empty for bucket root. */
  key: string;
  endpoint?: string;
  /** Default true when endpoint is set; false for AWS virtual-hosted. */
  forcePathStyle?: boolean;
  query?: Record<string, string>;
}): { url: string; host: string; canonicalUri: string; canonicalQuerystring: string } {
  const keyEnc = opts.key ? encodeS3Path(opts.key.replace(/^\//, "")) : "";
  const query = opts.query ?? {};
  const canonicalQuerystring = buildCanonicalQuery(query);
  const qs = canonicalQuerystring ? `?${canonicalQuerystring}` : "";
  const pathStyle = opts.endpoint ? opts.forcePathStyle !== false : opts.forcePathStyle === true;

  if (opts.endpoint) {
    const base = opts.endpoint.replace(/\/$/, "");
    const baseUrl = new URL(base);
    if (pathStyle) {
      const canonicalUri = `/${encodeS3Path(opts.bucket)}${keyEnc ? `/${keyEnc}` : ""}`;
      return {
        url: `${base}${canonicalUri}${qs}`,
        host: baseUrl.host,
        canonicalUri,
        canonicalQuerystring,
      };
    }
    const vhHost = `${opts.bucket}.${baseUrl.host}`;
    const canonicalUri = keyEnc ? `/${keyEnc}` : "/";
    return {
      url: `${baseUrl.protocol}//${vhHost}${canonicalUri}${qs}`,
      host: vhHost,
      canonicalUri,
      canonicalQuerystring,
    };
  }

  if (pathStyle) {
    const host = opts.region === "us-east-1" ? "s3.amazonaws.com" : `s3.${opts.region}.amazonaws.com`;
    const canonicalUri = `/${encodeS3Path(opts.bucket)}${keyEnc ? `/${keyEnc}` : ""}`;
    return {
      url: `https://${host}${canonicalUri}${qs}`,
      host,
      canonicalUri,
      canonicalQuerystring,
    };
  }

  const host =
    opts.region === "us-east-1"
      ? `${opts.bucket}.s3.amazonaws.com`
      : `${opts.bucket}.s3.${opts.region}.amazonaws.com`;
  const canonicalUri = keyEnc ? `/${keyEnc}` : "/";
  return {
    url: `https://${host}${canonicalUri}${qs}`,
    host,
    canonicalUri,
    canonicalQuerystring,
  };
}

/** Parse ListObjectsV2 XML for object keys (lightweight). */
export function parseListObjectsV2Keys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([^<]*)<\/Key>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const key = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
    keys.push(key);
  }
  return keys;
}
