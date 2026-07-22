/**
 * Storage backend abstraction for pi-sync.
 *
 * Each backend implements list / upload / download for backup archives.
 * The factory createStorageBackend() returns the right backend based on config.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

// ── Storage interface ─────────────────────────────────────────────────

export interface StorageBackend {
  /** List backup zip file names (e.g. ["pi_sync_backup_2026-7-14_..._linux.zip", ...]) */
  listBackups(): Promise<string[]>;

  /** Upload a local file to remote storage */
  upload(filePath: string, fileName: string): Promise<void>;

  /** Download a remote file to a local path */
  download(fileName: string, destPath: string): Promise<void>;
}

// ── Config types ──────────────────────────────────────────────────────

export type StorageType = "webdav" | "s3";

export interface SyncConfig {
  // Storage type selector
  storageType: StorageType;

  // WebDAV
  webdavUrl: string;
  webdavUser: string;
  webdavPass: string;

  // S3-compatible
  s3Endpoint: string;
  s3Bucket: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Path: string; // e.g. "xxx/pi" → files stored under backup/xxx/pi/

  // What to sync
  backupProviders: boolean;
  backupSkills: boolean;
  backupExtensions: boolean;
}

// ── Factory ───────────────────────────────────────────────────────────

export async function createStorageBackend(
  config: SyncConfig,
  ctx: ExtensionCommandContext,
): Promise<StorageBackend> {
  if (config.storageType === "s3") {
    const { S3Storage } = await import("./storage-s3");
    return new S3Storage(config, ctx);
  }
  // default: webdav
  const { WebdavStorage } = await import("./storage-webdav");
  return new WebdavStorage(config, ctx);
}
