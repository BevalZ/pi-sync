import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { timestampForBackup, ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { enhancedSelect } from "../_shared/enhanced-select";
import { runCommand } from "../_shared/spawn";
import {
  createStorageBackend,
  type SyncConfig,
  type StorageBackend,
  type StorageType,
} from "./storage";

// ── Platform tag ─────────────────────────────────────────────────────

function platformTag(): string {
  const p = os.platform();
  if (p === "win32") {
    const build = parseInt((os.release().split(".")[2] ?? "0"), 10);
    return build >= 22000 ? "windows11" : "windows10";
  }
  if (p === "darwin") return "macos";
  if (p === "linux") return "linux";
  return p;
}

// ── Yield to UI ──────────────────────────────────────────────────────

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Default config path ──────────────────────────────────────────────

const SYNC_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "sync_config.json");
const TAR_TIMEOUT_MS = 300_000;

// ── Config persistence ───────────────────────────────────────────────

function loadConfig(): SyncConfig {
  const data = readJsonSafe<Partial<SyncConfig>>(SYNC_CONFIG_PATH, {});
  return {
    storageType: (data.storageType as StorageType) || "webdav",
    webdavUrl: data.webdavUrl || "",
    webdavUser: data.webdavUser || "",
    webdavPass: data.webdavPass || "",
    s3Endpoint: data.s3Endpoint || "",
    s3Bucket: data.s3Bucket || "",
    s3Region: data.s3Region || "auto",
    s3AccessKey: data.s3AccessKey || "",
    s3SecretKey: data.s3SecretKey || "",
    s3Path: data.s3Path || "",
    backupProviders: data.backupProviders !== false,
    backupSkills: data.backupSkills !== false,
    backupExtensions: data.backupExtensions !== false,
  };
}

function saveConfig(config: SyncConfig) {
  ensureDir(path.dirname(SYNC_CONFIG_PATH));
  writeJsonAtomic(SYNC_CONFIG_PATH, config, { backup: true });
}

// ── Tar helpers ──────────────────────────────────────────────────────

async function runTar(args: string[], options: { capture?: boolean; timeoutMs?: number } = {}): Promise<string> {
  const r = await runCommand("tar", args, { timeoutMs: options.timeoutMs ?? TAR_TIMEOUT_MS });
  if (!r.ok) throw new Error(r.stderr || `tar ${args[0]} failed with status ${r.status}`);
  return options.capture ? r.stdout : "";
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

// ── Validation helpers ───────────────────────────────────────────────

function isWebdavConfigured(config: SyncConfig): boolean {
  return !!(config.webdavUrl && config.webdavUser && config.webdavPass);
}

function isS3Configured(config: SyncConfig): boolean {
  return !!(config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey);
}

function isStorageConfigured(config: SyncConfig): boolean {
  return config.storageType === "s3" ? isS3Configured(config) : isWebdavConfigured(config);
}

// ── Create ZIP ───────────────────────────────────────────────────────

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
        contents.push("Skills Directory");
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
        contents.push("Extensions Directory");
      }
    }

    if (contents.length === 0) {
      throw new Error("No components selected or found to backup!");
    }

    await yieldToUI();
    await runTar(["-a", "-c", "-f", tempZipPath, "-C", tempDir, "."]);

    return contents;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Extract ZIP ─────────────────────────────────────────────────────

async function extractZip(zipPath: string, config: SyncConfig): Promise<string[]> {
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const tempDir = path.join(os.tmpdir(), `pi_sync_extract_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const restored: string[] = [];

  try {
    const entries = await listArchiveEntries(zipPath);
    validateArchiveEntries(entries);
    await runTar(["-x", "-f", zipPath, "-C", tempDir]);

    // 1. Config
    const configSrc = path.join(tempDir, "config");
    if (fs.existsSync(configSrc) && config.backupProviders) {
      const files = fs.readdirSync(configSrc);
      for (const file of files) {
        const srcFile = path.join(configSrc, file);
        const destFile = path.join(agentDir, file);
        if (fs.existsSync(destFile)) {
          fs.copyFileSync(destFile, `${destFile}.bak-${timestampForBackup()}`);
        }
        fs.copyFileSync(srcFile, destFile);
        restored.push(`Config: ${file} (restored, old file saved as timestamped .bak)`);
      }
    }

    // 2. Skills
    const skillsSrc = path.join(tempDir, "skills");
    if (fs.existsSync(skillsSrc) && config.backupSkills) {
      const skillsDest = path.join(agentDir, "skills");
      const skillsBackup = path.join(agentDir, `skills-backup-${timestampForBackup()}`);
      if (fs.existsSync(skillsDest)) {
        fs.renameSync(skillsDest, skillsBackup);
      }
      fs.mkdirSync(skillsDest, { recursive: true });
      copyRecursiveSync(skillsSrc, skillsDest);
      await yieldToUI();
      restored.push(`Skills (restored, old skills backed up to ${path.basename(skillsBackup)})`);
    }

    // 3. Extensions
    const extSrc = path.join(tempDir, "extensions");
    if (fs.existsSync(extSrc) && config.backupExtensions) {
      const extDest = path.join(agentDir, "extensions");
      const extBackup = path.join(agentDir, `extensions-backup-${timestampForBackup()}`);
      if (fs.existsSync(extDest)) {
        fs.mkdirSync(extBackup, { recursive: true });
        copyRecursiveSync(extDest, extBackup);
      }
      copyRecursiveSync(extSrc, extDest);
      await yieldToUI();
      restored.push(`Extensions (restored, old extensions backed up to ${path.basename(extBackup)})`);
    }

    return restored;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Recursive copy ──────────────────────────────────────────────────

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

// ── Setup wizard ─────────────────────────────────────────────────────

async function showSetupWizard(
  ctx: ExtensionCommandContext,
  config: SyncConfig,
): Promise<boolean> {
  ctx.ui.notify("Storage is not configured! Please set it up now.", "warning");

  // Step 1: choose storage type
  const storageType = await enhancedSelect(ctx, "Select storage backend:", [
    "WebDAV  (Nextcloud, 坚果云, TeraCLOUD, ownCloud, …)",
    "S3  (AWS S3, Cloudflare R2, Alibaba OSS, MinIO, …)",
  ]);
  if (!storageType) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

  const isS3 = storageType.includes("S3");
  config.storageType = isS3 ? "s3" : "webdav";

  if (isS3) {
    const endpoint = await ctx.ui.input("S3 Endpoint URL (e.g. https://<account>.r2.cloudflarestorage.com):", config.s3Endpoint);
    if (!endpoint) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const bucket = await ctx.ui.input("Bucket name:", config.s3Bucket);
    if (!bucket) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const region = await ctx.ui.input("Region (use 'auto' for R2, 'us-east-1' for S3, …):", config.s3Region || "auto");
    if (!region) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const accessKey = await ctx.ui.input("Access Key ID:", config.s3AccessKey);
    if (!accessKey) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const secretKey = await ctx.ui.input("Secret Access Key (recommended: $ENV_VAR such as $PI_S3_SECRET_KEY):", config.s3SecretKey);
    if (!secretKey) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const s3Path = await ctx.ui.input("S3 path prefix (e.g. 'xxx/pi' for backup/xxx/pi/; leave empty for bucket root):", config.s3Path);

    config.s3Endpoint = endpoint.trim();
    config.s3Bucket = bucket.trim();
    config.s3Region = region.trim();
    config.s3AccessKey = accessKey.trim();
    config.s3SecretKey = secretKey.trim();
    config.s3Path = (s3Path ?? "").trim().replace(/^\/+/, "");
  } else {
    const url = await ctx.ui.input("Enter WebDAV server URL (e.g. https://dav.jianguoyun.com/dav/):", config.webdavUrl);
    if (!url) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const user = await ctx.ui.input("Enter WebDAV username/email:", config.webdavUser);
    if (!user) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const pass = await ctx.ui.input("Enter WebDAV password/application-token (recommended: $ENV_VAR, e.g. $PI_WEBDAV_PASS):", config.webdavPass);
    if (!pass) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    config.webdavUrl = url.trim();
    config.webdavUser = user.trim();
    config.webdavPass = pass.trim();
  }

  saveConfig(config);
  ctx.ui.notify(`${isS3 ? "S3" : "WebDAV"} configuration saved!`, "info");
  return true;
}

// ── Configure settings ───────────────────────────────────────────────

async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
  const config = loadConfig();

  while (true) {
    const storageLabel = config.storageType === "s3" ? "S3" : "WebDAV";
    const menuItems: string[] = [];

    // Common
    menuItems.push(`Storage Type: ${storageLabel}`);

    if (config.storageType === "s3") {
      menuItems.push(
        `S3 Endpoint: ${config.s3Endpoint || "(not set)"}`,
        `S3 Bucket: ${config.s3Bucket || "(not set)"}`,
        `S3 Region: ${config.s3Region || "(not set)"}`,
        `S3 Access Key: ${config.s3AccessKey ? "(set)" : "(not set)"}`,
        `S3 Secret Key: ${config.s3SecretKey ? "(set)" : "(not set)"}`,
        `S3 Path: ${config.s3Path || "(bucket root)"}`,
      );
    } else {
      menuItems.push(
        `WebDAV URL: ${config.webdavUrl || "(not set)"}`,
        `WebDAV Username: ${config.webdavUser || "(not set)"}`,
        `WebDAV Password/Token: ${config.webdavPass ? "(set)" : "(not set)"}`,
      );
    }

    menuItems.push(
      `Backup Providers & Config: ${config.backupProviders ? "ON" : "OFF"}`,
      `Backup Skills: ${config.backupSkills ? "ON" : "OFF"}`,
      `Backup Extensions: ${config.backupExtensions ? "ON" : "OFF"}`,
      "───────────────",
      "s Save",
      "x Back",
    );

    const selected = await enhancedSelect(ctx, "Configure Sync Settings", menuItems);
    if (!selected || selected === "x Back") return;

    if (selected === "s Save") {
      saveConfig(config);
      ctx.ui.notify("Sync configuration updated successfully!", "info");
      return;
    }

    // ── Dispatch ──
    if (selected.startsWith("Storage Type:")) {
      const choice = await enhancedSelect(ctx, "Select storage backend:", [
        "WebDAV  (Nextcloud, 坚果云, TeraCLOUD, ownCloud, …)",
        "S3  (AWS S3, Cloudflare R2, Alibaba OSS, MinIO, …)",
      ]);
      if (choice?.includes("S3")) config.storageType = "s3";
      else if (choice?.includes("WebDAV")) config.storageType = "webdav";
      continue;
    }

    if (selected.startsWith("S3 Endpoint:")) {
      const val = await ctx.ui.input("S3 Endpoint URL:", config.s3Endpoint);
      if (val) config.s3Endpoint = val.trim();
      continue;
    }
    if (selected.startsWith("S3 Bucket:")) {
      const val = await ctx.ui.input("S3 Bucket:", config.s3Bucket);
      if (val) config.s3Bucket = val.trim();
      continue;
    }
    if (selected.startsWith("S3 Region:")) {
      const val = await ctx.ui.input("S3 Region:", config.s3Region);
      if (val) config.s3Region = val.trim();
      continue;
    }
    if (selected.startsWith("S3 Access Key:")) {
      const val = await ctx.ui.input("S3 Access Key ID:", config.s3AccessKey);
      if (val) config.s3AccessKey = val.trim();
      continue;
    }
    if (selected.startsWith("S3 Secret Key:")) {
      const val = await ctx.ui.input("S3 Secret Access Key (recommended: $ENV_VAR):", config.s3SecretKey);
      if (val) config.s3SecretKey = val.trim();
      continue;
    }
    if (selected.startsWith("S3 Path:")) {
      const val = await ctx.ui.input("S3 Path (e.g. 'xxx/pi'; empty = bucket root):", config.s3Path);
      if (val !== undefined) config.s3Path = val.trim().replace(/^\/+/, "");
      continue;
    }

    if (selected.startsWith("WebDAV URL:")) {
      const val = await ctx.ui.input("WebDAV URL:", config.webdavUrl);
      if (val) config.webdavUrl = val.trim();
      continue;
    }
    if (selected.startsWith("WebDAV Username:")) {
      const val = await ctx.ui.input("WebDAV Username:", config.webdavUser);
      if (val) config.webdavUser = val.trim();
      continue;
    }
    if (selected.startsWith("WebDAV Password/Token:")) {
      const val = await ctx.ui.input("WebDAV Password/Token (recommended: $ENV_VAR):", config.webdavPass);
      if (val) config.webdavPass = val.trim();
      continue;
    }

    if (selected.startsWith("Backup Providers & Config:")) { config.backupProviders = !config.backupProviders; continue; }
    if (selected.startsWith("Backup Skills:")) { config.backupSkills = !config.backupSkills; continue; }
    if (selected.startsWith("Backup Extensions:")) { config.backupExtensions = !config.backupExtensions; }
  }
}

// ── Upload backup ────────────────────────────────────────────────────

async function showUploadBackup(
  ctx: ExtensionCommandContext,
  storage: StorageBackend,
  config: SyncConfig,
): Promise<void> {
  ctx.ui.notify("Preparing local files to pack...", "info");
  await yieldToUI();

  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
  const zipFilename = `pi_sync_backup_${dateStr}_${timestamp}_${platformTag()}.zip`;
  const tempZipPath = path.join(os.tmpdir(), zipFilename);

  try {
    const packedContents = await createZip(config, tempZipPath);
    await yieldToUI();
    ctx.ui.notify(`Packed items:\n${packedContents.join("\n")}`, "info");
    ctx.ui.notify("Uploading backup archive...", "info");
    await yieldToUI();
    await storage.upload(tempZipPath, zipFilename);
    ctx.ui.notify(`🎉 Backup uploaded successfully as:\n${zipFilename}`, "info");
  } catch (e) {
    ctx.ui.notify(`❌ Backup upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    if (fs.existsSync(tempZipPath)) {
      try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
    }
  }
}

// ── Download & restore backup ────────────────────────────────────────

async function showDownloadBackup(
  ctx: ExtensionCommandContext,
  storage: StorageBackend,
  config: SyncConfig,
): Promise<void> {
  ctx.ui.notify("Fetching backups list...", "info");
  try {
    const backups = await storage.listBackups();
    if (backups.length === 0) {
      ctx.ui.notify("No cloud backups found.", "warning");
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
      await storage.download(backupChoice, tempDownloadZip);

      const archiveEntries = await listArchiveEntries(tempDownloadZip);
      validateArchiveEntries(archiveEntries);
      const restorePlan = getRestorePlan(archiveEntries, config);
      const confirmed = await ctx.ui.confirm(
        "Confirm Restore After Inspection?",
        [
          `Backup: ${backupChoice}`,
          `Archive entries inspected: ${archiveEntries.length}`,
          ...restorePlan,
          "This can overwrite local configuration/skills/extensions, but existing local files/directories will receive timestamped backups first.",
        ].join("\n")
      );

      if (!confirmed) {
        ctx.ui.notify("Restore cancelled after archive inspection.", "info");
        return;
      }

      ctx.ui.notify("Extracting and restoring backup contents...", "info");
      await yieldToUI();
      const restoredItems = await extractZip(tempDownloadZip, config);
      ctx.ui.notify(`🎉 Restored successfully:\n${restoredItems.join("\n")}`, "info");

      const doReload = await ctx.ui.confirm("Reload Runtime?", "Would you like to reload the agent runtime now to apply restored skills and extensions?");
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

// ── Command registration ─────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sync", {
    description: "Sync configurations, skills, and extensions via WebDAV / S3",
    getArgumentCompletions: (_prefix) => null,
    handler: async (args, ctx) => {
      let config = loadConfig();

      // Setup wizard if not configured
      if (!isStorageConfigured(config)) {
        if (!await showSetupWizard(ctx, config)) return;
        config = loadConfig();
      }

      // Create storage backend
      const storage = await createStorageBackend(config, ctx);

      // Interactive menu
      const menuOptions = [
        "☁️  Upload Backup (Backup to cloud)",
        "📥  Download Backup (Restore from cloud)",
        "⚙️  Configure Sync Settings",
        "❌  Cancel",
      ];
      const choice = await enhancedSelect(ctx, "Pi Synchronization", menuOptions);
      if (!choice || choice.includes("Cancel")) return;

      if (choice.includes("Configure Sync Settings")) return showConfigureSettings(ctx);
      if (choice.includes("Upload Backup")) return showUploadBackup(ctx, storage, config);
      if (choice.includes("Download Backup")) return showDownloadBackup(ctx, storage, config);
    },
  });
}
