import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { timestampForBackup, ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { enhancedSelect } from "../_shared/enhanced-select";
import { runCommand } from "../_shared/spawn";
import { fetchWithTimeout } from "../_shared/fetch-utils";
import {
  buildS3Url,
  parseListObjectsV2Keys,
  sha256Hex,
  signAwsV4,
} from "../_shared/s3-sigv4";

/**
 * Platform tag for backup filenames, e.g. "windows11", "windows10", "macos", "linux".
 * Cross-platform: derives from os.platform()/os.release() so the archive name
 * identifies the machine that produced it regardless of host OS.
 */
function platformTag(): string {
  const p = os.platform();
  if (p === "win32") {
    // Windows 11 is build >= 22000; earlier builds report as Windows 10.
    const build = parseInt((os.release().split(".")[2] ?? "0"), 10);
    return build >= 22000 ? "windows11" : "windows10";
  }
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return p; // fallback: raw platform id (e.g. "freebsd")
}

// Yield the event loop so the TUI can paint previous notify/setStatus calls.
// Sync fs work (copyRecursiveSync, etc.) otherwise blocks rendering.
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Default settings file to store user configuration
const SYNC_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "sync_config.json");
const TAR_TIMEOUT_MS = 300_000;
const CLOUD_FETCH_TIMEOUT_MS = 120_000;

type SyncBackend = "webdav" | "s3";

interface SyncConfig {
  /** Storage backend. Defaults to webdav when omitted (backward compatible). */
  backend: SyncBackend;
  // ── WebDAV ──
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string; // Environment variable or plaintext
  // ── S3-compatible ──
  s3Bucket: string;
  s3Region: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** Optional session token (temporary credentials). */
  s3SessionToken: string;
  /** Optional custom endpoint (MinIO / R2 / OSS). Empty = AWS. */
  s3Endpoint: string;
  /** Object key prefix inside the bucket, e.g. "pi-backups/". */
  s3Prefix: string;
  /** Force path-style URLs. Default true when s3Endpoint is set. */
  s3ForcePathStyle: boolean;
  // ── What to include ──
  backupProviders: boolean;
  backupSkills: boolean;
  backupExtensions: boolean;
}

function defaultConfig(): SyncConfig {
  return {
    backend: "webdav",
    webdavUrl: "",
    webdavUser: "",
    webdavPass: "",
    s3Bucket: "",
    s3Region: "us-east-1",
    s3AccessKeyId: "",
    s3SecretAccessKey: "",
    s3SessionToken: "",
    s3Endpoint: "",
    s3Prefix: "pi-backups/",
    s3ForcePathStyle: true,
    backupProviders: true,
    backupSkills: true,
    backupExtensions: true,
  };
}

export default function (pi: ExtensionAPI) {
  function loadConfig(): SyncConfig {
    const data = readJsonSafe<Partial<SyncConfig>>(SYNC_CONFIG_PATH, {});
    const defaults = defaultConfig();
    const backend: SyncBackend =
      data.backend === "s3" || data.backend === "webdav"
        ? data.backend
        : data.webdavUrl
          ? "webdav"
          : data.s3Bucket
            ? "s3"
            : "webdav";

    return {
      backend,
      webdavUrl: data.webdavUrl || "",
      webdavUser: data.webdavUser || "",
      webdavPass: data.webdavPass || "",
      s3Bucket: data.s3Bucket || "",
      s3Region: data.s3Region || defaults.s3Region,
      s3AccessKeyId: data.s3AccessKeyId || "",
      s3SecretAccessKey: data.s3SecretAccessKey || "",
      s3SessionToken: data.s3SessionToken || "",
      s3Endpoint: data.s3Endpoint || "",
      s3Prefix: normalizePrefix(data.s3Prefix ?? defaults.s3Prefix),
      s3ForcePathStyle:
        typeof data.s3ForcePathStyle === "boolean"
          ? data.s3ForcePathStyle
          : data.s3Endpoint
            ? true
            : false,
      backupProviders: data.backupProviders !== false,
      backupSkills: data.backupSkills !== false,
      backupExtensions: data.backupExtensions !== false,
    };
  }

  function saveConfig(config: SyncConfig) {
    ensureDir(path.dirname(SYNC_CONFIG_PATH));
    writeJsonAtomic(SYNC_CONFIG_PATH, config, { backup: true });
  }

  function normalizePrefix(prefix: string): string {
    let p = (prefix || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (p && !p.endsWith("/")) p += "/";
    return p;
  }

  // Resolve secret (supports environment variables starting with $)
  function resolveSecret(value: string): string {
    if (value.startsWith("$")) {
      const envVar = value.slice(1);
      return process.env[envVar] ?? value;
    }
    return value;
  }

  function isBackendConfigured(config: SyncConfig): boolean {
    if (config.backend === "s3") {
      return Boolean(config.s3Bucket && config.s3AccessKeyId && config.s3SecretAccessKey);
    }
    return Boolean(config.webdavUrl && config.webdavUser && config.webdavPass);
  }

  function backendLabel(config: SyncConfig): string {
    if (config.backend === "s3") {
      const ep = config.s3Endpoint ? ` @ ${config.s3Endpoint}` : "";
      return `S3 s3://${config.s3Bucket}/${config.s3Prefix}${ep}`;
    }
    return `WebDAV ${config.webdavUrl || "(not set)"}`;
  }

  // Thin wrapper: run tar via shared runCommand, preserving throw-on-error semantics
  async function runTar(args: string[], options: { capture?: boolean; timeoutMs?: number } = {}): Promise<string> {
    const r = await runCommand("tar", args, { timeoutMs: options.timeoutMs ?? TAR_TIMEOUT_MS });
    if (!r.ok) throw new Error(r.stderr || `tar ${args[0]} failed with status ${r.status}`);
    return options.capture ? r.stdout : "";
  }

  /**
   * Fail fast if `tar` is missing or cannot create zip archives (`tar -a`).
   * Modern Windows 10+, macOS, and most Linux distros ship a capable tar.
   */
  async function ensureTarAvailable(): Promise<void> {
    const version = await runCommand("tar", ["--version"], { timeoutMs: 10_000 });
    if (!version.ok) {
      throw new Error(
        "tar is not available on PATH. Install system tar (Windows 10+ built-in, Git for Windows, or WSL) and retry.",
      );
    }

    const probeDir = path.join(os.tmpdir(), `pi_sync_tar_probe_${Date.now()}`);
    const probeZip = path.join(os.tmpdir(), `pi_sync_tar_probe_${Date.now()}.zip`);
    try {
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(path.join(probeDir, "probe.txt"), "ok", "utf-8");
      const created = await runCommand(
        "tar",
        ["-a", "-c", "-f", probeZip, "-C", probeDir, "."],
        { timeoutMs: 30_000 },
      );
      if (!created.ok || !fs.existsSync(probeZip)) {
        throw new Error(
          "tar is present but cannot create zip archives (`tar -a -c -f …zip`). " +
            "On Windows use the built-in tar (not busybox). On Linux install GNU tar. " +
            (created.stderr || ""),
        );
      }
    } finally {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { if (fs.existsSync(probeZip)) fs.unlinkSync(probeZip); } catch { /* ignore */ }
    }
  }

  function readSettingsPackages(): string[] {
    const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
    const data = readJsonSafe<{ packages?: string[] }>(settingsPath, {});
    return Array.isArray(data.packages) ? data.packages.map(String) : [];
  }

  function diffStringLists(before: string[], after: string[]): { added: string[]; removed: string[] } {
    const b = new Set(before);
    return {
      added: after.filter((x) => !b.has(x)),
      removed: before.filter((x) => !new Set(after).has(x)),
    };
  }

  function formatRestoreReport(opts: {
    backupName: string;
    restored: string[];
    safetyBackups: string[];
    packagesBefore: string[];
    packagesAfter: string[];
  }): string {
    const lines: string[] = [];
    lines.push(`Backup: ${opts.backupName}`);
    lines.push("── Restored ──");
    if (opts.restored.length === 0) lines.push("  (nothing restored — check sync include toggles)");
    else for (const r of opts.restored) lines.push(`  • ${r}`);

    lines.push("── Local safety backups ──");
    if (opts.safetyBackups.length === 0) lines.push("  (none created)");
    else for (const p of opts.safetyBackups) lines.push(`  • ${p}`);

    const pkgDiff = diffStringLists(opts.packagesBefore, opts.packagesAfter);
    lines.push("── settings.packages ──");
    if (pkgDiff.added.length === 0 && pkgDiff.removed.length === 0) {
      lines.push("  (unchanged)");
    } else {
      for (const x of pkgDiff.added) lines.push(`  + ${x}`);
      for (const x of pkgDiff.removed) lines.push(`  - ${x}`);
    }
    lines.push("── Next ──");
    lines.push("  Reload runtime (or restart Pi) to apply skills/extensions/packages.");
    lines.push("  Device-local providers (127.0.0.1) and provider-proxy ports may need this machine.");
    return lines.join("\n");
  }

  function normalizeArchiveEntry(entry: string): string {
    return entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  }

  async function listArchiveEntries(zipPath: string): Promise<string[]> {
    return (await runTar(["-t", "-f", zipPath], { capture: true }))
      .split(/\r?\n/)
      .map((line) => normalizeArchiveEntry(line.trim()))
      .filter((entry) => entry && entry !== ".");
  }

  function validateArchiveEntries(entries: string[]): void {
    const allowedTopLevel = new Set(["config", "skills", "extensions"]);
    const allowedConfigFiles = new Set(["models.json", "settings.json", "auth.json"]);

    if (entries.length === 0) {
      throw new Error("Backup archive is empty or unreadable");
    }

    for (const entry of entries) {
      const pathParts = entry.split("/");
      if (entry.startsWith("/") || /^[a-zA-Z]:\//.test(entry) || pathParts.includes("..")) {
        throw new Error(`Unsafe archive path rejected: ${entry}`);
      }

      const [topLevel, secondPart] = pathParts;
      if (!topLevel || !allowedTopLevel.has(topLevel)) {
        throw new Error(`Unexpected top-level archive entry rejected: ${entry}`);
      }

      if (topLevel === "config" && secondPart && !allowedConfigFiles.has(secondPart)) {
        throw new Error(`Unexpected config file rejected: ${entry}`);
      }
    }
  }

  function getRestorePlan(entries: string[], config: SyncConfig): string[] {
    const hasConfig = entries.some((entry) => entry === "config" || entry.startsWith("config/"));
    const hasSkills = entries.some((entry) => entry === "skills" || entry.startsWith("skills/"));
    const hasExtensions = entries.some((entry) => entry === "extensions" || entry.startsWith("extensions/"));
    const plan: string[] = [];

    if (hasConfig) {
      plan.push(config.backupProviders ? "Config files will be overwritten; current files get timestamped .bak copies." : "Config files are present but skipped by current settings.");
    }
    if (hasSkills) {
      plan.push(config.backupSkills ? "Skills directory will be replaced; current skills get a timestamped backup folder." : "Skills are present but skipped by current settings.");
    }
    if (hasExtensions) {
      plan.push(config.backupExtensions ? "Extensions will be merged/overwritten; current extensions get a timestamped backup folder." : "Extensions are present but skipped by current settings.");
    }

    if (plan.length === 0) {
      plan.push("No restorable config, skills, or extensions found in this archive.");
    }

    return plan;
  }

  // ── Cloud backends ──────────────────────────────────────────────────

  async function listCloudBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    if (config.backend === "s3") return listS3Backups(config, ctx);
    return listWebdavBackups(config, ctx);
  }

  async function uploadToCloud(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext): Promise<void> {
    if (config.backend === "s3") return uploadToS3(filePath, config, ctx);
    return uploadToWebdav(filePath, config, ctx);
  }

  async function downloadFromCloud(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext): Promise<void> {
    if (config.backend === "s3") return downloadFromS3(filename, destPath, config, ctx);
    return downloadFromWebdav(filename, destPath, config, ctx);
  }

  // ── WebDAV ──────────────────────────────────────────────────────────

  async function listWebdavBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    const pass = resolveSecret(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) url += "/";

    try {
      const response = await fetchWithTimeout(url, {
        method: "PROPFIND",
        headers: {
          Authorization: `Basic ${auth}`,
          Depth: "1",
          "Content-Type": "application/xml",
        },
      }, CLOUD_FETCH_TIMEOUT_MS, ctx.signal);

      if (!response.ok) {
        throw new Error(`WebDAV returns HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      const backups: string[] = [];
      const regex = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const name = match[1].trim();
        if (name.startsWith("pi_sync_backup_") && name.endsWith(".zip")) {
          backups.push(name);
        }
      }

      if (backups.length === 0) {
        const hrefRegex = /<[a-zA-Z0-9:-]*href>([^<]+)<\/[a-zA-Z0-9:-]*href>/g;
        while ((match = hrefRegex.exec(text)) !== null) {
          const href = match[1].trim();
          const decodedHref = decodeURIComponent(href);
          const filename = path.basename(decodedHref);
          if (filename.startsWith("pi_sync_backup_") && filename.endsWith(".zip")) {
            if (!backups.includes(filename)) backups.push(filename);
          }
        }
      }

      return backups.sort().reverse();
    } catch (e) {
      throw new Error(`Failed to query cloud backups: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function uploadToWebdav(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const filename = path.basename(filePath);
    const pass = resolveSecret(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) url += "/";
    url += encodeURIComponent(filename);

    const fileBuffer = fs.readFileSync(filePath);
    const response = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    }, CLOUD_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV PUT returns HTTP ${response.status}: ${response.statusText}`);
    }
  }

  async function downloadFromWebdav(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const pass = resolveSecret(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) url += "/";
    url += encodeURIComponent(filename);

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Basic ${auth}` },
    }, CLOUD_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV GET returns HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }

  // ── S3 ──────────────────────────────────────────────────────────────

  function s3Creds(config: SyncConfig) {
    return {
      accessKeyId: resolveSecret(config.s3AccessKeyId),
      secretAccessKey: resolveSecret(config.s3SecretAccessKey),
      sessionToken: config.s3SessionToken ? resolveSecret(config.s3SessionToken) : undefined,
      region: config.s3Region || "us-east-1",
      bucket: config.s3Bucket,
      endpoint: config.s3Endpoint || undefined,
      forcePathStyle: config.s3Endpoint ? config.s3ForcePathStyle !== false : config.s3ForcePathStyle === true,
      prefix: normalizePrefix(config.s3Prefix),
    };
  }

  function objectKeyForBackup(config: SyncConfig, filename: string): string {
    const prefix = normalizePrefix(config.s3Prefix);
    const base = path.basename(filename);
    return `${prefix}${base}`;
  }

  /**
   * Clock skew correction for SigV4.
   * Some hosts run minutes/hours off UTC; S3/R2 reject with RequestTimeTooSkewed.
   * We learn skew from the server Date header and re-sign once if needed.
   */
  let s3ClockSkewMs = 0;
  let s3ClockSkewProbed = false;

  function s3Now(): Date {
    return new Date(Date.now() + s3ClockSkewMs);
  }

  function learnSkewFromResponse(resp: Response): void {
    const dateHdr = resp.headers.get("date");
    if (!dateHdr) return;
    const serverMs = Date.parse(dateHdr);
    if (!Number.isFinite(serverMs)) return;
    s3ClockSkewMs = serverMs - Date.now();
    s3ClockSkewProbed = true;
  }

  function isRequestTimeTooSkewed(status: number, body: string): boolean {
    if (status !== 403 && status !== 400) return false;
    return /RequestTimeTooSkewed|request time/i.test(body);
  }

  async function ensureS3ClockSkew(config: SyncConfig, signal?: AbortSignal): Promise<void> {
    if (s3ClockSkewProbed) return;
    const creds = s3Creds(config);
    // Cheap unauthenticated probe against the endpoint (or AWS regional host).
    const probeUrl = creds.endpoint
      ? creds.endpoint.replace(/\/$/, "") + "/"
      : `https://s3.${creds.region}.amazonaws.com/`;
    try {
      const resp = await fetchWithTimeout(probeUrl, { method: "GET" }, 15_000, signal);
      learnSkewFromResponse(resp);
    } catch {
      // ignore — will still try signed requests with local clock
    } finally {
      s3ClockSkewProbed = true;
    }
  }

  async function s3SignedFetch(
    config: SyncConfig,
    opts: {
      method: string;
      key: string;
      query?: Record<string, string>;
      body?: Buffer;
      contentType?: string;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    await ensureS3ClockSkew(config, opts.signal);

    const creds = s3Creds(config);
    const payloadHash = opts.body ? sha256Hex(opts.body) : sha256Hex("");
    const built = buildS3Url({
      bucket: creds.bucket,
      region: creds.region,
      key: opts.key,
      endpoint: creds.endpoint,
      forcePathStyle: creds.forcePathStyle,
      query: opts.query,
    });

    const buildHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = { host: built.host };
      if (opts.contentType) headers["content-type"] = opts.contentType;
      if (opts.body) headers["content-length"] = String(opts.body.byteLength);
      return headers;
    };

    const doSigned = async (): Promise<Response> => {
      const signed = signAwsV4({
        method: opts.method,
        canonicalUri: built.canonicalUri,
        canonicalQuerystring: built.canonicalQuerystring,
        headers: buildHeaders(),
        payloadHash,
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken,
        region: creds.region,
        service: "s3",
        date: s3Now(),
      });
      return fetchWithTimeout(built.url, {
        method: opts.method,
        headers: signed.headers,
        body: opts.body,
      }, CLOUD_FETCH_TIMEOUT_MS, opts.signal);
    };

    let response = await doSigned();
    learnSkewFromResponse(response);

    if (!response.ok) {
      // Clone body for skew detection without consuming the returned body stream.
      const errText = await response.clone().text().catch(() => "");
      if (isRequestTimeTooSkewed(response.status, errText)) {
        // Force re-learn from this response and retry once with corrected clock.
        s3ClockSkewProbed = true;
        response = await doSigned();
        learnSkewFromResponse(response);
      }
    }

    return response;
  }

  async function listS3Backups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    const creds = s3Creds(config);
    const prefix = creds.prefix;
    try {
      const response = await s3SignedFetch(config, {
        method: "GET",
        key: "",
        query: {
          "list-type": "2",
          prefix,
          "max-keys": "1000",
        },
        signal: ctx.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`S3 ListObjectsV2 HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
      }

      const xml = await response.text();
      const keys = parseListObjectsV2Keys(xml);
      const names = keys
        .map((k) => {
          if (prefix && k.startsWith(prefix)) return k.slice(prefix.length);
          return path.posix.basename(k);
        })
        .filter((name) => name.startsWith("pi_sync_backup_") && name.endsWith(".zip") && !name.includes("/"));

      return Array.from(new Set(names)).sort().reverse();
    } catch (e) {
      throw new Error(`Failed to list S3 backups: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function uploadToS3(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const filename = path.basename(filePath);
    const key = objectKeyForBackup(config, filename);
    const fileBuffer = fs.readFileSync(filePath);

    const response = await s3SignedFetch(config, {
      method: "PUT",
      key,
      body: fileBuffer,
      contentType: "application/zip",
      signal: ctx.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`S3 PUT HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
  }

  async function downloadFromS3(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const key = objectKeyForBackup(config, filename);
    const response = await s3SignedFetch(config, {
      method: "GET",
      key,
      signal: ctx.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`S3 GET HTTP ${response.status}: ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }

  // ── Zip create / extract ────────────────────────────────────────────

  async function createZip(config: SyncConfig, tempZipPath: string): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_sync_temp_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const contents: string[] = [];

    try {
      if (config.backupProviders) {
        const filesToBackup = ["models.json", "settings.json", "auth.json"];
        const confDir = path.join(tempDir, "config");
        fs.mkdirSync(confDir, { recursive: true });
        for (const file of filesToBackup) {
          const src = path.join(agentDir, file);
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(confDir, file));
            contents.push(`Config: ${file}`);
          }
        }
      }

      if (config.backupSkills) {
        const skillsSrc = path.join(agentDir, "skills");
        if (fs.existsSync(skillsSrc)) {
          const skillsDest = path.join(tempDir, "skills");
          fs.mkdirSync(skillsDest, { recursive: true });
          copyRecursiveSync(skillsSrc, skillsDest);
          await yieldToUI();
          contents.push(`Skills Directory`);
        }
      }

      if (config.backupExtensions) {
        const extSrc = path.join(agentDir, "extensions");
        if (fs.existsSync(extSrc)) {
          const extDest = path.join(tempDir, "extensions");
          fs.mkdirSync(extDest, { recursive: true });
          copyRecursiveSync(extSrc, extDest);
          await yieldToUI();

          const syncInBackup = path.join(extDest, "sync");
          if (fs.existsSync(syncInBackup)) {
            fs.rmSync(syncInBackup, { recursive: true, force: true });
          }
          contents.push(`Extensions Directory`);
        }
      }

      if (contents.length === 0) {
        throw new Error("No components selected or found to backup!");
      }

      await yieldToUI();
      await runTar(["-a", "-c", "-f", tempZipPath, "-C", tempDir, "."]);
      return contents;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  async function extractZip(zipPath: string, config: SyncConfig): Promise<{ restored: string[]; safetyBackups: string[] }> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_sync_extract_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const restored: string[] = [];
    const safetyBackups: string[] = [];

    try {
      const entries = await listArchiveEntries(zipPath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", zipPath, "-C", tempDir]);

      const configSrc = path.join(tempDir, "config");
      if (fs.existsSync(configSrc) && config.backupProviders) {
        const files = fs.readdirSync(configSrc);
        for (const file of files) {
          const srcFile = path.join(configSrc, file);
          const destFile = path.join(agentDir, file);

          if (fs.existsSync(destFile)) {
            const bakPath = `${destFile}.bak-${timestampForBackup()}`;
            fs.copyFileSync(destFile, bakPath);
            safetyBackups.push(bakPath);
          }
          fs.copyFileSync(srcFile, destFile);
          restored.push(`Config: ${file}`);
        }
      }

      const skillsSrc = path.join(tempDir, "skills");
      if (fs.existsSync(skillsSrc) && config.backupSkills) {
        const skillsDest = path.join(agentDir, "skills");
        const skillsBackup = path.join(agentDir, `skills-backup-${timestampForBackup()}`);
        if (fs.existsSync(skillsDest)) {
          fs.renameSync(skillsDest, skillsBackup);
          safetyBackups.push(skillsBackup);
        }

        fs.mkdirSync(skillsDest, { recursive: true });
        copyRecursiveSync(skillsSrc, skillsDest);
        await yieldToUI();
        restored.push(`Skills directory`);
      }

      const extSrc = path.join(tempDir, "extensions");
      if (fs.existsSync(extSrc) && config.backupExtensions) {
        const extDest = path.join(agentDir, "extensions");
        const extBackup = path.join(agentDir, `extensions-backup-${timestampForBackup()}`);
        if (fs.existsSync(extDest)) {
          fs.mkdirSync(extBackup, { recursive: true });
          copyRecursiveSync(extDest, extBackup);
          safetyBackups.push(extBackup);
        }

        copyRecursiveSync(extSrc, extDest);
        await yieldToUI();
        restored.push(`Extensions directory (merged)`);
      }

      return { restored, safetyBackups };
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  function copyRecursiveSync(src: string, dest: string) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats && stats.isDirectory();
    if (isDirectory) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }
      fs.readdirSync(src).forEach((childItemName) => {
        copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
      });
    } else {
      fs.copyFileSync(src, dest);
    }
  }

  // ── UI: setup / configure ───────────────────────────────────────────

  async function configureWebdavFields(ctx: ExtensionCommandContext, cfg: SyncConfig): Promise<boolean> {
    const url = await ctx.ui.input(
      "WebDAV server URL (e.g. https://dav.jianguoyun.com/dav/):",
      cfg.webdavUrl,
    );
    if (!url) return false;
    const user = await ctx.ui.input("WebDAV username/email:", cfg.webdavUser);
    if (!user) return false;
    const pass = await ctx.ui.input(
      "WebDAV password/token (prefer $ENV_VAR, e.g. $PI_WEBDAV_TOKEN):",
      cfg.webdavPass,
    );
    if (!pass) return false;
    cfg.webdavUrl = url.trim();
    cfg.webdavUser = user.trim();
    cfg.webdavPass = pass.trim();
    return true;
  }

  async function configureS3Fields(ctx: ExtensionCommandContext, cfg: SyncConfig): Promise<boolean> {
    const bucket = await ctx.ui.input("S3 bucket name:", cfg.s3Bucket);
    if (!bucket) return false;
    const region = await ctx.ui.input("S3 region (e.g. us-east-1, ap-northeast-1):", cfg.s3Region || "us-east-1");
    if (!region) return false;
    const accessKey = await ctx.ui.input("S3 access key id (prefer $ENV_VAR):", cfg.s3AccessKeyId);
    if (!accessKey) return false;
    const secretKey = await ctx.ui.input("S3 secret access key (prefer $ENV_VAR):", cfg.s3SecretAccessKey);
    if (!secretKey) return false;
    const endpoint = await ctx.ui.input(
      "Custom endpoint (optional — MinIO/R2/OSS; leave empty for AWS):",
      cfg.s3Endpoint,
    );
    const prefix = await ctx.ui.input("Object key prefix (e.g. pi-backups/):", cfg.s3Prefix || "pi-backups/");
    const session = await ctx.ui.input(
      "Session token (optional; temporary creds / $ENV_VAR):",
      cfg.s3SessionToken,
    );

    cfg.s3Bucket = bucket.trim();
    cfg.s3Region = region.trim();
    cfg.s3AccessKeyId = accessKey.trim();
    cfg.s3SecretAccessKey = secretKey.trim();
    cfg.s3Endpoint = (endpoint || "").trim();
    cfg.s3Prefix = normalizePrefix(prefix || "pi-backups/");
    cfg.s3SessionToken = (session || "").trim();
    // Path-style is the safer default for custom endpoints.
    cfg.s3ForcePathStyle = Boolean(cfg.s3Endpoint) || cfg.s3ForcePathStyle;
    return true;
  }

  async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
    const wizConfig = loadConfig();
    ctx.ui.notify("Cloud storage is not configured. Choose a backend.", "warning");

    const backendChoice = await enhancedSelect(ctx, "Sync backend", [
      "WebDAV  — TeraCLOUD / 坚果云 / Nextcloud / ownCloud",
      "S3      — Amazon S3 / MinIO / Cloudflare R2 / compatible",
      "❌ Cancel",
    ]);
    if (!backendChoice || backendChoice.includes("Cancel")) {
      ctx.ui.notify("Sync setup cancelled.", "info");
      return false;
    }

    if (backendChoice.startsWith("S3")) {
      wizConfig.backend = "s3";
      if (!await configureS3Fields(ctx, wizConfig)) {
        ctx.ui.notify("Sync setup cancelled.", "info");
        return false;
      }
    } else {
      wizConfig.backend = "webdav";
      if (!await configureWebdavFields(ctx, wizConfig)) {
        ctx.ui.notify("Sync setup cancelled.", "info");
        return false;
      }
    }

    saveConfig(wizConfig);
    ctx.ui.notify(`Sync configuration saved (${wizConfig.backend}).`, "info");
    return true;
  }

  async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
    const cfgConfig = loadConfig();
    while (true) {
      const items: string[] = [
        `Backend: ${cfgConfig.backend === "s3" ? "S3-compatible" : "WebDAV"}`,
      ];

      if (cfgConfig.backend === "webdav") {
        items.push(
          `WebDAV URL: ${cfgConfig.webdavUrl || "(not set)"}`,
          `WebDAV Username: ${cfgConfig.webdavUser || "(not set)"}`,
          `WebDAV Password/Token: ${cfgConfig.webdavPass ? "(set)" : "(not set)"}`,
        );
      } else {
        items.push(
          `S3 Bucket: ${cfgConfig.s3Bucket || "(not set)"}`,
          `S3 Region: ${cfgConfig.s3Region || "(not set)"}`,
          `S3 Access Key: ${cfgConfig.s3AccessKeyId ? "(set)" : "(not set)"}`,
          `S3 Secret Key: ${cfgConfig.s3SecretAccessKey ? "(set)" : "(not set)"}`,
          `S3 Session Token: ${cfgConfig.s3SessionToken ? "(set)" : "(not set)"}`,
          `S3 Endpoint: ${cfgConfig.s3Endpoint || "(AWS default)"}`,
          `S3 Prefix: ${cfgConfig.s3Prefix || "(none)"}`,
          `S3 Path-style: ${cfgConfig.s3ForcePathStyle ? "ON" : "OFF"}`,
        );
      }

      items.push(
        `Backup Providers & Config: ${cfgConfig.backupProviders ? "ON" : "OFF"}`,
        `Backup Skills: ${cfgConfig.backupSkills ? "ON" : "OFF"}`,
        `Backup Extensions: ${cfgConfig.backupExtensions ? "ON" : "OFF"}`,
        "───────────────",
        "s Save",
        "x Back",
      );

      const selected = await enhancedSelect(ctx, "Configure Sync Settings", items);
      if (!selected || selected === "x Back") return;
      if (selected === "s Save") {
        saveConfig(cfgConfig);
        ctx.ui.notify("Sync configuration updated successfully!", "info");
        return;
      }

      if (selected.startsWith("Backend:")) {
        const pick = await enhancedSelect(ctx, "Select backend", [
          "WebDAV",
          "S3-compatible",
        ]);
        if (pick?.startsWith("S3")) cfgConfig.backend = "s3";
        else if (pick) cfgConfig.backend = "webdav";
        continue;
      }

      if (selected.startsWith("WebDAV URL:")) {
        const val = await ctx.ui.input("WebDAV URL:", cfgConfig.webdavUrl);
        if (val) cfgConfig.webdavUrl = val.trim();
        continue;
      }
      if (selected.startsWith("WebDAV Username:")) {
        const val = await ctx.ui.input("WebDAV Username:", cfgConfig.webdavUser);
        if (val) cfgConfig.webdavUser = val.trim();
        continue;
      }
      if (selected.startsWith("WebDAV Password/Token:")) {
        const val = await ctx.ui.input(
          "WebDAV Password/Token (prefer $ENV_VAR; plaintext is stored in sync_config.json):",
          cfgConfig.webdavPass,
        );
        if (val) cfgConfig.webdavPass = val.trim();
        continue;
      }

      if (selected.startsWith("S3 Bucket:")) {
        const val = await ctx.ui.input("S3 bucket:", cfgConfig.s3Bucket);
        if (val) cfgConfig.s3Bucket = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Region:")) {
        const val = await ctx.ui.input("S3 region:", cfgConfig.s3Region);
        if (val) cfgConfig.s3Region = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Access Key:")) {
        const val = await ctx.ui.input("S3 access key id ($ENV_VAR ok):", cfgConfig.s3AccessKeyId);
        if (val) cfgConfig.s3AccessKeyId = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Secret Key:")) {
        const val = await ctx.ui.input("S3 secret access key ($ENV_VAR ok):", cfgConfig.s3SecretAccessKey);
        if (val) cfgConfig.s3SecretAccessKey = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Session Token:")) {
        const val = await ctx.ui.input("S3 session token (optional, $ENV_VAR ok):", cfgConfig.s3SessionToken);
        if (val !== undefined && val !== null) cfgConfig.s3SessionToken = val.trim();
        continue;
      }
      if (selected.startsWith("S3 Endpoint:")) {
        const val = await ctx.ui.input("Custom endpoint (empty = AWS):", cfgConfig.s3Endpoint);
        if (val !== undefined && val !== null) {
          cfgConfig.s3Endpoint = val.trim();
          if (cfgConfig.s3Endpoint) cfgConfig.s3ForcePathStyle = true;
        }
        continue;
      }
      if (selected.startsWith("S3 Prefix:")) {
        const val = await ctx.ui.input("Object key prefix:", cfgConfig.s3Prefix);
        if (val !== undefined && val !== null) cfgConfig.s3Prefix = normalizePrefix(val);
        continue;
      }
      if (selected.startsWith("S3 Path-style:")) {
        cfgConfig.s3ForcePathStyle = !cfgConfig.s3ForcePathStyle;
        continue;
      }

      if (selected.startsWith("Backup Providers & Config:")) { cfgConfig.backupProviders = !cfgConfig.backupProviders; continue; }
      if (selected.startsWith("Backup Skills:")) { cfgConfig.backupSkills = !cfgConfig.backupSkills; continue; }
      if (selected.startsWith("Backup Extensions:")) { cfgConfig.backupExtensions = !cfgConfig.backupExtensions; }
    }
  }

  // ── Upload / Download ───────────────────────────────────────────────

  async function showUploadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const ulConfig = loadConfig();
    if (!isBackendConfigured(ulConfig)) {
      ctx.ui.notify("Cloud backend is not fully configured. Open Configure Sync Settings.", "error");
      return;
    }
    try {
      await ensureTarAvailable();
    } catch (e) {
      ctx.ui.notify(`❌ ${e instanceof Error ? e.message : String(e)}`, "error");
      return;
    }
    ctx.ui.notify("Preparing local files to pack...", "info");
    await yieldToUI();
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
    const zipFilename = `pi_sync_backup_${dateStr}_${timestamp}_${platformTag()}.zip`;
    const tempZipPath = path.join(os.tmpdir(), zipFilename);

    try {
      const packedContents = await createZip(ulConfig, tempZipPath);
      await yieldToUI();
      ctx.ui.notify(`Packed items:\n${packedContents.join("\n")}`, "info");
      ctx.ui.notify(`Uploading to ${backendLabel(ulConfig)}...`, "info");
      await yieldToUI();
      await uploadToCloud(tempZipPath, ulConfig, ctx);
      ctx.ui.notify(`🎉 Backup uploaded successfully as:\n${zipFilename}`, "info");
    } catch (e) {
      ctx.ui.notify(`❌ Backup upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      if (fs.existsSync(tempZipPath)) {
        try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
      }
    }
  }

  async function showDownloadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const dlConfig = loadConfig();
    if (!isBackendConfigured(dlConfig)) {
      ctx.ui.notify("Cloud backend is not fully configured. Open Configure Sync Settings.", "error");
      return;
    }
    try {
      await ensureTarAvailable();
    } catch (e) {
      ctx.ui.notify(`❌ ${e instanceof Error ? e.message : String(e)}`, "error");
      return;
    }
    ctx.ui.notify(`Fetching backups from ${backendLabel(dlConfig)}...`, "info");
    try {
      const backups = await listCloudBackups(dlConfig, ctx);
      if (backups.length === 0) {
        ctx.ui.notify("No cloud backups found starting with 'pi_sync_backup_'.", "warning");
        return;
      }

      const backupChoice = await enhancedSelect(ctx, "Select cloud backup to restore:", [
        ...backups,
        "❌ Cancel",
      ], { fuzzy: true });

      if (!backupChoice || backupChoice.includes("Cancel")) return;

      const tempDownloadZip = path.join(os.tmpdir(), path.basename(backupChoice));
      try {
        ctx.ui.notify(`Downloading ${backupChoice}...`, "info");
        await yieldToUI();
        await downloadFromCloud(backupChoice, tempDownloadZip, dlConfig, ctx);

        const archiveEntries = await listArchiveEntries(tempDownloadZip);
        validateArchiveEntries(archiveEntries);
        const restorePlan = getRestorePlan(archiveEntries, dlConfig);
        const confirmed = await ctx.ui.confirm(
          "Confirm Restore After Inspection?",
          [
            `Backup: ${backupChoice}`,
            `Backend: ${dlConfig.backend}`,
            `Archive entries inspected: ${archiveEntries.length}`,
            ...restorePlan,
            "This can overwrite local configuration/skills/extensions, but existing local files/directories will receive timestamped backups first.",
          ].join("\n"),
        );

        if (!confirmed) {
          ctx.ui.notify("Restore cancelled after archive inspection.", "info");
          return;
        }

        const packagesBefore = readSettingsPackages();
        ctx.ui.notify("Extracting and restoring backup contents...", "info");
        await yieldToUI();
        const { restored, safetyBackups } = await extractZip(tempDownloadZip, dlConfig);
        const packagesAfter = readSettingsPackages();
        const report = formatRestoreReport({
          backupName: backupChoice,
          restored,
          safetyBackups,
          packagesBefore,
          packagesAfter,
        });
        ctx.ui.notify(`🎉 Restore finished\n${report}`, "info");

        const doReload = await ctx.ui.confirm(
          "Reload Runtime?",
          "Reload the agent runtime now to apply restored skills, extensions, and packages?",
        );
        if (doReload) await ctx.reload();
      } finally {
        if (fs.existsSync(tempDownloadZip)) {
          try { fs.unlinkSync(tempDownloadZip); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      ctx.ui.notify(`❌ Restore failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  // Register command `/sync`
  pi.registerCommand("sync", {
    description: "Sync configurations, skills, and extensions via WebDAV or S3",
    getArgumentCompletions: () => null,
    handler: async (_args, ctx) => {
      let config = loadConfig();

      if (!isBackendConfigured(config)) {
        if (!await showSetupWizard(ctx)) return;
        config = loadConfig();
      }

      const menuOptions = [
        "☁️  Upload Backup (Backup to cloud)",
        "📥  Download Backup (Restore from cloud)",
        "⚙️  Configure Sync Settings",
        "❌  Cancel",
      ];
      const choice = await enhancedSelect(
        ctx,
        `Pi Cloud Sync (${config.backend === "s3" ? "S3" : "WebDAV"})`,
        menuOptions,
      );
      if (!choice || choice.includes("Cancel")) return;

      if (choice.includes("Configure Sync Settings")) return showConfigureSettings(ctx);
      if (choice.includes("Upload Backup")) return showUploadBackup(ctx);
      if (choice.includes("Download Backup")) return showDownloadBackup(ctx);
    },
  });
}
