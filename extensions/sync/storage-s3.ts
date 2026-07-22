/**
 * S3-compatible storage backend for pi-sync.
 *
 * Supports AWS S3, Cloudflare R2, Alibaba OSS, MinIO, and any S3-compatible
 * service. Uses raw HTTP + AWS Signature V4 — zero npm dependencies beyond
 * Node.js built-in crypto.
 *
 * Tested against Cloudflare R2 (bucket: backup, prefix: pi/).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as crypto from "node:crypto";
import { fetchWithTimeout } from "../_shared/fetch-utils";
import type { StorageBackend, SyncConfig } from "./storage";

const S3_FETCH_TIMEOUT_MS = 120_000;

// ── AWS Signature V4 ─────────────────────────────────────────────────

function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data).digest();
}

/** Build the signing key for AWS Signature V4 */
function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256("AWS4" + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

/** Encode an S3 object key for the URI path (segment-by-segment). */
function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

interface S3Request {
  method: string;
  bucket: string;
  key: string;
  queryString?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

/** Sign an S3 request with AWS Signature V4 */
function signRequest(
  req: S3Request,
  endpoint: string,
  region: string,
  accessKey: string,
  secretKey: string,
): { url: string; signedHeaders: Record<string, string> } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";

  const host = new URL(endpoint).host;
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const payloadHash = sha256(req.body ?? "");

  // All request headers that participate in signing
  const signedHeadersMap: Record<string, string> = {
    "host": host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (req.headers) {
    for (const [k, v] of Object.entries(req.headers)) {
      signedHeadersMap[k.toLowerCase()] = v;
    }
  }

  // Canonical URI (path-style): /{bucket}/{key} with segment encoding
  const encodedKey = req.key ? encodeS3Key(req.key) : "";
  const canonicalUri = req.key ? `/${req.bucket}/${encodedKey}` : `/${req.bucket}/`;
  const requestUri = canonicalUri; // same encoding for S3

  const sortedKeys = Object.keys(signedHeadersMap).sort();
  const canonicalHeaders = sortedKeys
    .map((k) => `${k}:${signedHeadersMap[k]}`)
    .join("\n");
  const signedHeaders = sortedKeys.join(";");

  // Canonical query string: params must be sorted by name (SigV4 requirement)
  let canonicalQuery = "";
  if (req.queryString) {
    const params = req.queryString.split("&").map((p) => {
      const eq = p.indexOf("=");
      return eq === -1
        ? { key: p, val: "" }
        : { key: p.slice(0, eq), val: p.slice(eq + 1) };
    });
    params.sort((a, b) => a.key.localeCompare(b.key));
    canonicalQuery = params.map((p) => `${p.key}=${p.val}`).join("&");
  }

  const canonicalRequest = [
    req.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders + "\n",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = getSigningKey(secretKey, dateStamp, region, service);
  const signature = hmacSha256(signingKey, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`;

  // Build the full URL (use sorted canonical query for consistency with the signature)
  let url = `${endpoint.replace(/\/+$/, "")}${requestUri}`;
  if (canonicalQuery) url += "?" + canonicalQuery;

  return {
    url,
    signedHeaders: {
      ...signedHeadersMap,
      authorization,
    },
  };
}

// ── Minimal XML helpers ──────────────────────────────────────────────

/** Extract all <Key> values from an S3 ListObjectsV2 XML response */
function parseListObjectsXml(xml: string): { keys: string[]; isTruncated: boolean; nextContinuationToken?: string } {
  const keys: string[] = [];
  const keyRegex = /<Key>([^<]+)<\/Key>/g;
  let m;
  while ((m = keyRegex.exec(xml)) !== null) {
    keys.push(m[1]);
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const tokenMatch = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
  return { keys, isTruncated: truncated, nextContinuationToken: tokenMatch?.[1] };
}

// ── S3 Storage Backend ───────────────────────────────────────────────

export class S3Storage implements StorageBackend {
  private endpoint: string; // normalized, no trailing slash

  constructor(
    private config: SyncConfig,
    private ctx: ExtensionCommandContext,
  ) {
    this.endpoint = config.s3Endpoint.replace(/\/+$/, "");
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private resolveSecret(s: string): string {
    if (s.startsWith("$")) {
      return process.env[s.slice(1)] ?? s;
    }
    return s;
  }

  /** Full S3 key for a backup filename (includes path prefix) */
  private objectKey(fileName: string): string {
    const prefix = this.config.s3Path.replace(/^\/+|\/+$/g, "");
    return prefix ? `${prefix}/${fileName}` : fileName;
  }

  /** Build signed headers and execute an S3 request */
  private async s3Request(req: Omit<S3Request, "bucket">): Promise<Response> {
    const accessKey = this.resolveSecret(this.config.s3AccessKey);
    const secretKey = this.resolveSecret(this.config.s3SecretKey);

    const { url, signedHeaders } = signRequest(
      { ...req, bucket: this.config.s3Bucket },
      this.endpoint,
      this.config.s3Region,
      accessKey,
      secretKey,
    );

    // Map lowercased signed headers to canonical HTTP header casing
    const httpHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(signedHeaders)) {
      // authorization stays lowercase for fetch (case-insensitive anyway)
      if (k === "authorization") httpHeaders[k] = v;
      else if (k === "host") httpHeaders["Host"] = v;
      else if (k === "x-amz-content-sha256") httpHeaders["X-Amz-Content-SHA256"] = v;
      else if (k === "x-amz-date") httpHeaders["X-Amz-Date"] = v;
      else httpHeaders[k] = v;
    }

    return fetchWithTimeout(url, {
      method: req.method,
      headers: httpHeaders,
      body: req.body,
    }, S3_FETCH_TIMEOUT_MS, this.ctx.signal);
  }

  // ── StorageBackend implementation ─────────────────────────────────

  async listBackups(): Promise<string[]> {
    const prefix = this.config.s3Path.replace(/^\/+|\/+$/g, "");
    const searchPrefix = prefix ? `${prefix}/pi_sync_backup_` : "pi_sync_backup_";

    const allKeys: string[] = [];
    let continuationToken: string | undefined;

    do {
      let query = `list-type=2&prefix=${encodeURIComponent(searchPrefix)}`;
      if (continuationToken) query += `&continuation-token=${encodeURIComponent(continuationToken)}`;

      const response = await this.s3Request({
        method: "GET",
        key: "",
        queryString: query,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`S3 list failed: HTTP ${response.status} — ${text.slice(0, 300)}`);
      }

      const xml = await response.text();
      const parsed = parseListObjectsXml(xml);
      allKeys.push(...parsed.keys);
      continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
    } while (continuationToken);

    // Extract just the filename from full keys
    const backups = allKeys
      .map((k) => k.split("/").pop()!)
      .filter((name) => name.startsWith("pi_sync_backup_") && name.endsWith(".zip"));

    return backups.sort().reverse();
  }

  async upload(filePath: string, fileName: string): Promise<void> {
    const fs = await import("node:fs");
    const body = fs.readFileSync(filePath);
    const key = this.objectKey(fileName);

    const response = await this.s3Request({
      method: "PUT",
      key,
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`S3 PUT failed: HTTP ${response.status} — ${text.slice(0, 300)}`);
    }
  }

  async download(fileName: string, destPath: string): Promise<void> {
    const fs = await import("node:fs");
    const key = this.objectKey(fileName);

    const response = await this.s3Request({
      method: "GET",
      key,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`S3 GET failed: HTTP ${response.status} — ${text.slice(0, 300)}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }
}
