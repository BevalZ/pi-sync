/**
 * Short-lived mock S3 server + client checks.
 * Spawned by s3-test.mjs so Windows libuv close crashes stay in the child.
 */
const { createServer } = require("node:http");
const { createHash, createHmac } = require("node:crypto");

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}
function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
function encodeS3Path(objectKey) {
  return objectKey
    .split("/")
    .filter((seg, i, arr) => !(seg === "" && (i === 0 || i === arr.length - 1)))
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
    )
    .join("/");
}
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}
function buildCanonicalQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k] ?? "")}`)
    .join("&");
}
function amzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}
function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${secret}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}
function signAwsV4(req) {
  const service = req.service ?? "s3";
  const { amzDate: amz, dateStamp } = amzDate(req.date);
  const headers = { ...req.headers };
  headers["x-amz-date"] = amz;
  headers["x-amz-content-sha256"] = req.payloadHash;
  if (req.sessionToken) headers["x-amz-security-token"] = req.sessionToken;
  const normalized = {};
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
  const stringToSign = ["AWS4-HMAC-SHA256", amz, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = getSignatureKey(req.secretAccessKey, dateStamp, req.region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${req.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { amzDate: amz, authorization, headers: { ...headers, Authorization: authorization } };
}
function buildS3Url(opts) {
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
      return { url: `${base}${canonicalUri}${qs}`, host: baseUrl.host, canonicalUri, canonicalQuerystring };
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
  const host =
    opts.region === "us-east-1"
      ? `${opts.bucket}.s3.amazonaws.com`
      : `${opts.bucket}.s3.${opts.region}.amazonaws.com`;
  const canonicalUri = keyEnc ? `/${keyEnc}` : "/";
  return { url: `https://${host}${canonicalUri}${qs}`, host, canonicalUri, canonicalQuerystring };
}
function parseListObjectsV2Keys(xml) {
  const keys = [];
  const re = /<Key>([^<]*)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(m[1]);
  return keys;
}

const store = new Map();
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!req.headers.authorization || !String(req.headers.authorization).includes("AWS4-HMAC-SHA256")) {
    res.writeHead(403);
    res.end("missing sigv4");
    return;
  }
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      store.set(url.pathname, Buffer.concat(chunks));
      res.writeHead(200);
      res.end();
    });
    return;
  }
  if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const objectKeys = [];
    for (const p of store.keys()) {
      const parts = p.split("/").filter(Boolean);
      if (parts.length >= 2) objectKeys.push(parts.slice(1).join("/"));
    }
    const filtered = objectKeys.filter((k) => !prefix || k.startsWith(prefix));
    const xml =
      `<?xml version="1.0"?><ListBucketResult>` +
      filtered.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
      `</ListBucketResult>`;
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(xml);
    return;
  }
  if (req.method === "GET") {
    const body = store.get(url.pathname);
    if (!body) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200);
    res.end(body);
    return;
  }
  res.writeHead(405);
  res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}`;
  const accessKeyId = "test";
  const secretAccessKey = "testsecret";
  const bucket = "mybucket";
  const key = "pi-backups/pi_sync_backup_test.zip";
  const payload = Buffer.from("hello-zip-content");
  let ok = true;

  {
    const built = buildS3Url({ bucket, region: "us-east-1", key, endpoint, forcePathStyle: true });
    const signed = signAwsV4({
      method: "PUT",
      canonicalUri: built.canonicalUri,
      canonicalQuerystring: built.canonicalQuerystring,
      headers: {
        host: built.host,
        "content-type": "application/zip",
        "content-length": String(payload.byteLength),
      },
      payloadHash: sha256Hex(payload),
      accessKeyId,
      secretAccessKey,
      region: "us-east-1",
    });
    const resp = await fetch(built.url, { method: "PUT", headers: signed.headers, body: payload });
    if (!resp.ok) {
      console.error("PUT", resp.status);
      ok = false;
    }
  }
  {
    const built = buildS3Url({ bucket, region: "us-east-1", key, endpoint, forcePathStyle: true });
    const signed = signAwsV4({
      method: "GET",
      canonicalUri: built.canonicalUri,
      canonicalQuerystring: built.canonicalQuerystring,
      headers: { host: built.host },
      payloadHash: sha256Hex(""),
      accessKeyId,
      secretAccessKey,
      region: "us-east-1",
    });
    const resp = await fetch(built.url, { method: "GET", headers: signed.headers });
    const text = await resp.text();
    if (!(resp.ok && text === "hello-zip-content")) {
      console.error("GET", resp.status, text);
      ok = false;
    }
  }
  {
    const built = buildS3Url({
      bucket,
      region: "us-east-1",
      key: "",
      endpoint,
      forcePathStyle: true,
      query: { "list-type": "2", prefix: "pi-backups/" },
    });
    const signed = signAwsV4({
      method: "GET",
      canonicalUri: built.canonicalUri,
      canonicalQuerystring: built.canonicalQuerystring,
      headers: { host: built.host },
      payloadHash: sha256Hex(""),
      accessKeyId,
      secretAccessKey,
      region: "us-east-1",
    });
    const resp = await fetch(built.url, { method: "GET", headers: signed.headers });
    const xml = await resp.text();
    const keys = parseListObjectsV2Keys(xml);
    if (!(resp.ok && keys.includes(key))) {
      console.error("LIST", keys);
      ok = false;
    }
  }
  {
    const built = buildS3Url({ bucket, region: "us-east-1", key, endpoint, forcePathStyle: true });
    const resp = await fetch(built.url, { method: "GET" });
    if (resp.status !== 403) {
      console.error("unsigned", resp.status);
      ok = false;
    }
  }

  if (ok) {
    console.log("MOCK_OK");
  } else {
    console.log("MOCK_FAIL");
  }
  // Force-exit without closing the server (Windows libuv can abort on close).
  // Parent treats stdout marker as the source of truth.
  process.exitCode = ok ? 0 : 1;
  setImmediate(() => {
    // eslint-disable-next-line n/no-process-exit
    process.kill(process.pid);
  });
})().catch((e) => {
  console.error(e);
  console.log("MOCK_FAIL");
  process.exit(1);
});
