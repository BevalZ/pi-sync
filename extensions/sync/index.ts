import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { timestampForBackup, ensureDir, writeJsonAtomic, readJsonSafe } from "../_shared/json-io";
import { enhancedSelect } from "../_shared/enhanced-select";
import { runCommand } from "../_shared/spawn";
import { fetchWithTimeout } from "../_shared/fetch-utils";

// 让出事件循环，让 TUI 有机会渲染之前的 notify/setStatus
// 同步 fs 操作 (copyRecursiveSync 等) 会阻塞事件循环，导致提示延迟显示
function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Default settings file to store user configuration
const SYNC_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "sync_config.json");
const TAR_TIMEOUT_MS = 300_000;
const WEBDAV_FETCH_TIMEOUT_MS = 120_000;

interface SyncConfig {
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string; // Environment variable or plaintext
  backupProviders: boolean;
  backupSkills: boolean;
  backupExtensions: boolean;
}

export default function (pi: ExtensionAPI) {
  // Read and write config helpers
  function loadConfig(): SyncConfig {
    const data = readJsonSafe<Partial<SyncConfig>>(SYNC_CONFIG_PATH, {});
    return {
      webdavUrl: data.webdavUrl || "",
      webdavUser: data.webdavUser || "",
      webdavPass: data.webdavPass || "",
      backupProviders: data.backupProviders !== false,
      backupSkills: data.backupSkills !== false,
      backupExtensions: data.backupExtensions !== false,
    };
  }

  function saveConfig(config: SyncConfig) {
    ensureDir(path.dirname(SYNC_CONFIG_PATH));
    writeJsonAtomic(SYNC_CONFIG_PATH, config, { backup: true });
  }

  // Resolve password / token (supports environment variables starting with $)
  function resolvePassword(pass: string): string {
    if (pass.startsWith("$")) {
      const envVar = pass.slice(1);
      return process.env[envVar] ?? pass;
    }
    return pass;
  }

  // Thin wrapper: run tar via shared runCommand, preserving throw-on-error semantics
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

  // ── File I/O — delegated to _shared/json-io ─────────────────────────

  // Fetch list of files from WebDAV using propfind
  async function listCloudBackups(config: SyncConfig, ctx: ExtensionCommandContext): Promise<string[]> {
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");
    
    // Ensure URL ends with /
    let url = config.webdavUrl;
    if (!url.endsWith("/")) {
      url += "/";
    }

    try {
      const response = await fetchWithTimeout(url, {
        method: "PROPFIND",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Depth": "1",
          "Content-Type": "application/xml",
        },
      }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);

      if (!response.ok) {
        throw new Error(`WebDAV returns HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      
      // Super lightweight XML parsing for file names containing "pi_sync_backup_"
      // Looking for <d:displayname> or <displayname> elements
      const backups: string[] = [];
      const regex = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const name = match[1].trim();
        if (name.startsWith("pi_sync_backup_") && name.endsWith(".zip")) {
          backups.push(name);
        }
      }

      // Fallback: search URLs inside <d:href>
      if (backups.length === 0) {
        const hrefRegex = /<[a-zA-Z0-9:-]*href>([^<]+)<\/[a-zA-Z0-9:-]*href>/g;
        while ((match = hrefRegex.exec(text)) !== null) {
          const href = match[1].trim();
          const decodedHref = decodeURIComponent(href);
          const filename = path.basename(decodedHref);
          if (filename.startsWith("pi_sync_backup_") && filename.endsWith(".zip")) {
            if (!backups.includes(filename)) {
              backups.push(filename);
            }
          }
        }
      }

      return backups.sort().reverse(); // Show latest first
    } catch (e) {
      throw new Error(`Failed to query cloud backups: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Upload file to WebDAV
  async function uploadToWebdav(filePath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const filename = path.basename(filePath);
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) {
      url += "/";
    }
    url += encodeURIComponent(filename);

    const fileBuffer = fs.readFileSync(filePath);

    const response = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV PUT returns HTTP ${response.status}: ${response.statusText}`);
    }
  }

  // Download file from WebDAV
  async function downloadFromWebdav(filename: string, destPath: string, config: SyncConfig, ctx: ExtensionCommandContext) {
    const pass = resolvePassword(config.webdavPass);
    const auth = Buffer.from(`${config.webdavUser}:${pass}`).toString("base64");

    let url = config.webdavUrl;
    if (!url.endsWith("/")) {
      url += "/";
    }
    url += encodeURIComponent(filename);

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        "Authorization": `Basic ${auth}`,
      },
    }, WEBDAV_FETCH_TIMEOUT_MS, ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV GET returns HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }

  // Create Zip Archive
  async function createZip(config: SyncConfig, tempZipPath: string): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_sync_temp_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const contents: string[] = [];

    try {
      // 1. Providers / Configuration (models.json, settings.json, auth.json)
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

      // 2. Skills (copy entire folder except backups if any)
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

      // 3. Extensions (copy entire folder, ignoring specific ones if we want, but let's copy all user extensions except sync itself to prevent self-conflict)
      if (config.backupExtensions) {
        const extSrc = path.join(agentDir, "extensions");
        if (fs.existsSync(extSrc)) {
          const extDest = path.join(tempDir, "extensions");
          fs.mkdirSync(extDest, { recursive: true });
          copyRecursiveSync(extSrc, extDest);
          await yieldToUI();
          
          // Delete sync plugin from the backup directory to avoid overwriting current running files directly in nasty ways
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

      // Zip the temp directory using tar (since Node doesn't bundle zip but tar is universally available in modern systems)
      // On Windows/Linux/macOS, modern tar handles zip extraction if given .zip format or can create gzip/zip.
      // Wait, let's use standard zip format or tar with gzip! Since zip is requested, let's use `tar -a -cf` which auto-detects by extension on Windows and Linux!
      // 'tar -a -cf archive.zip -C <dir> .'
      // Let's verify and execute:
      await yieldToUI();
      await runTar(["-a", "-c", "-f", tempZipPath, "-C", tempDir, "."]);

      return contents;
    } finally {
      // Clean up temp directory
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // Extract Zip Archive and Overwrite
  async function extractZip(zipPath: string, config: SyncConfig): Promise<string[]> {
    const agentDir = path.join(os.homedir(), ".pi", "agent");
    const tempDir = path.join(os.tmpdir(), `pi_sync_extract_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    const restored: string[] = [];

    try {
      // Inspect and safety-check before extracting to a temporary folder.
      const entries = await listArchiveEntries(zipPath);
      validateArchiveEntries(entries);
      await runTar(["-x", "-f", zipPath, "-C", tempDir]);

      // 1. Restore Config
      const configSrc = path.join(tempDir, "config");
      if (fs.existsSync(configSrc) && config.backupProviders) {
        const files = fs.readdirSync(configSrc);
        for (const file of files) {
          const srcFile = path.join(configSrc, file);
          const destFile = path.join(agentDir, file);
          
          // Backup existing local file before overwriting.
          if (fs.existsSync(destFile)) {
            fs.copyFileSync(destFile, `${destFile}.bak-${timestampForBackup()}`);
          }
          fs.copyFileSync(srcFile, destFile);
          restored.push(`Config: ${file} (restored, old file saved as timestamped .bak)`);
        }
      }

      // 2. Restore Skills
      const skillsSrc = path.join(tempDir, "skills");
      if (fs.existsSync(skillsSrc) && config.backupSkills) {
        const skillsDest = path.join(agentDir, "skills");
        
        // Safety: Backup existing skills directory without deleting previous backups.
        const skillsBackup = path.join(agentDir, `skills-backup-${timestampForBackup()}`);
        if (fs.existsSync(skillsDest)) {
          fs.renameSync(skillsDest, skillsBackup);
        }
        
        fs.mkdirSync(skillsDest, { recursive: true });
        copyRecursiveSync(skillsSrc, skillsDest);
        await yieldToUI();
        restored.push(`Skills (restored, old skills backed up to ${path.basename(skillsBackup)})`);
      }

      // 3. Restore Extensions
      const extSrc = path.join(tempDir, "extensions");
      if (fs.existsSync(extSrc) && config.backupExtensions) {
        const extDest = path.join(agentDir, "extensions");

        // Backup existing extensions folder without deleting previous backups.
        const extBackup = path.join(agentDir, `extensions-backup-${timestampForBackup()}`);
        if (fs.existsSync(extDest)) {
          // Instead of renaming the whole folder which would destroy the currently running sync plugin itself,
          // we merge/overwrite files but backup existing files.
          // Create a timestamped extensions-backup folder, copy existing to it, then overwrite.
          fs.mkdirSync(extBackup, { recursive: true });
          copyRecursiveSync(extDest, extBackup);
        }

        // Copy new extensions over.
        // We do recursive merge. The currently running sync plugin is NOT in the temp extracted folder because we filtered it during backup.
        // So the sync plugin itself is safe!
        copyRecursiveSync(extSrc, extDest);
        await yieldToUI();
        restored.push(`Extensions (restored, old extensions backed up to ${path.basename(extBackup)})`);
      }

      return restored;
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // Recursive copy helper
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

  /** Run the initial WebDAV setup wizard (prompts for URL/user/pass). Returns true if config was saved. */
  async function showSetupWizard(ctx: ExtensionCommandContext): Promise<boolean> {
    const wizConfig = loadConfig();
    ctx.ui.notify("WebDAV is not configured! Please set it up now.", "warning");

    const url = await ctx.ui.input("Enter WebDAV server URL (e.g. https://dav.jianguoyun.com/dav/):", wizConfig.webdavUrl);
    if (!url) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const user = await ctx.ui.input("Enter WebDAV username/email:", wizConfig.webdavUser);
    if (!user) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    const pass = await ctx.ui.input("Enter WebDAV password/application-token (recommended: store it in an environment variable and enter $ENV_VAR, e.g. $PI_WEBDAV_TOKEN):", wizConfig.webdavPass);
    if (!pass) { ctx.ui.notify("Sync setup cancelled.", "info"); return false; }

    wizConfig.webdavUrl = url.trim();
    wizConfig.webdavUser = user.trim();
    wizConfig.webdavPass = pass.trim();
    saveConfig(wizConfig);
    ctx.ui.notify("WebDAV configuration saved!", "info");
    return true;
  }

  /** Interactive configure-settings menu (while-loop with Save/Back). */
  async function showConfigureSettings(ctx: ExtensionCommandContext): Promise<void> {
    const cfgConfig = loadConfig();
    while (true) {
      const selected = await enhancedSelect(ctx, "Configure Sync Settings", [
        `WebDAV URL: ${cfgConfig.webdavUrl || "(not set)"}`,
        `WebDAV Username: ${cfgConfig.webdavUser || "(not set)"}`,
        `WebDAV Password/Token: ${cfgConfig.webdavPass ? "(set)" : "(not set)"}`,
        `Backup Providers & Config: ${cfgConfig.backupProviders ? "ON" : "OFF"}`,
        `Backup Skills: ${cfgConfig.backupSkills ? "ON" : "OFF"}`,
        `Backup Extensions: ${cfgConfig.backupExtensions ? "ON" : "OFF"}`,
        "───────────────",
        "s Save",
        "x Back",
      ]);
      if (!selected || selected === "x Back") return;
      if (selected === "s Save") {
        saveConfig(cfgConfig);
        ctx.ui.notify("Sync configuration updated successfully!", "info");
        return;
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
        const val = await ctx.ui.input("WebDAV Password/Token (recommended: $ENV_VAR such as $PI_WEBDAV_TOKEN; plaintext is stored in sync_config.json):", cfgConfig.webdavPass);
        if (val) cfgConfig.webdavPass = val.trim();
        continue;
      }
      if (selected.startsWith("Backup Providers & Config:")) { cfgConfig.backupProviders = !cfgConfig.backupProviders; continue; }
      if (selected.startsWith("Backup Skills:")) { cfgConfig.backupSkills = !cfgConfig.backupSkills; continue; }
      if (selected.startsWith("Backup Extensions:")) { cfgConfig.backupExtensions = !cfgConfig.backupExtensions; }
    }
  }

  /** Upload backup to WebDAV. */
  async function showUploadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const ulConfig = loadConfig();
    ctx.ui.notify("Preparing local files to pack...", "info");
    await yieldToUI();
    const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const dateStr = new Date().toLocaleDateString("zh-CN").replace(/\//g, "-");
    const zipFilename = `pi_sync_backup_${dateStr}_${timestamp}.zip`;
    const tempZipPath = path.join(os.tmpdir(), zipFilename);

    try {
      const packedContents = await createZip(ulConfig, tempZipPath);
      await yieldToUI();
      ctx.ui.notify(`Packed items:\n${packedContents.join("\n")}`, "info");
      ctx.ui.notify("Uploading backup archive to WebDAV server...", "info");
      await yieldToUI();
      await uploadToWebdav(tempZipPath, ulConfig, ctx);
      ctx.ui.notify(`🎉 Backup uploaded successfully as:\n${zipFilename}`, "info");
    } catch (e) {
      ctx.ui.notify(`❌ Backup upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      if (fs.existsSync(tempZipPath)) {
        try { fs.unlinkSync(tempZipPath); } catch { /* ignore */ }
      }
    }
  }

  /** Download and restore a backup from WebDAV. */
  async function showDownloadBackup(ctx: ExtensionCommandContext): Promise<void> {
    const dlConfig = loadConfig();
    ctx.ui.notify("Fetching backups list from cloud...", "info");
    try {
      const backups = await listCloudBackups(dlConfig, ctx);
      if (backups.length === 0) {
        ctx.ui.notify("No cloud backups found on WebDAV server starting with 'pi_sync_backup_'.", "warning");
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
        await downloadFromWebdav(backupChoice, tempDownloadZip, dlConfig, ctx);

        const archiveEntries = await listArchiveEntries(tempDownloadZip);
        validateArchiveEntries(archiveEntries);
        const restorePlan = getRestorePlan(archiveEntries, dlConfig);
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
        const restoredItems = await extractZip(tempDownloadZip, dlConfig);
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

  // Register command `/sync`
  pi.registerCommand("sync", {
    description: "Sync configurations, skills, and extensions via WebDAV",
    getArgumentCompletions: (prefix) => {
      // /sync takes no sub-actions; interactive menu handles everything.
      return null;
    },
    handler: async (args, ctx) => {
      let config = loadConfig();

      // Setup wizard
      if (!config.webdavUrl || !config.webdavUser || !config.webdavPass) {
        if (!await showSetupWizard(ctx)) return;
        config = loadConfig();
      }

      // Interactive menu
      const menuOptions = [
        "☁️  Upload Backup (Backup to cloud)",
        "📥  Download Backup (Restore from cloud)",
        "⚙️  Configure Sync Settings",
        "❌  Cancel",
      ];
      const choice = await enhancedSelect(ctx, "Pi WebDAV Synchronization", menuOptions);
      if (!choice || choice.includes("Cancel")) return;

      if (choice.includes("Configure Sync Settings")) return showConfigureSettings(ctx);
      if (choice.includes("Upload Backup")) return showUploadBackup(ctx);
      if (choice.includes("Download Backup")) return showDownloadBackup(ctx);
    },
  });
}
