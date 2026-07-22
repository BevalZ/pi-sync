/**
 * WebDAV storage backend for pi-sync.
 *
 * Implements StorageBackend using standard WebDAV PROPFIND / GET / PUT.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { fetchWithTimeout } from "../_shared/fetch-utils";
import type { StorageBackend, SyncConfig } from "./storage";

const WEBDAV_FETCH_TIMEOUT_MS = 120_000;

export class WebdavStorage implements StorageBackend {
  constructor(
    private config: SyncConfig,
    private ctx: ExtensionCommandContext,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────

  private resolvePassword(pass: string): string {
    if (pass.startsWith("$")) {
      const envVar = pass.slice(1);
      return process.env[envVar] ?? pass;
    }
    return pass;
  }

  private get authHeader(): string {
    const pass = this.resolvePassword(this.config.webdavPass);
    return "Basic " + Buffer.from(`${this.config.webdavUser}:${pass}`).toString("base64");
  }

  private get baseUrl(): string {
    let url = this.config.webdavUrl;
    if (!url.endsWith("/")) url += "/";
    return url;
  }

  // ── StorageBackend implementation ─────────────────────────────────

  async listBackups(): Promise<string[]> {
    try {
      const response = await fetchWithTimeout(this.baseUrl, {
        method: "PROPFIND",
        headers: {
          Authorization: this.authHeader,
          Depth: "1",
          "Content-Type": "application/xml",
        },
      }, WEBDAV_FETCH_TIMEOUT_MS, this.ctx.signal);

      if (!response.ok) {
        throw new Error(`WebDAV returns HTTP ${response.status}: ${response.statusText}`);
      }

      const text = await response.text();
      const backups: string[] = [];

      // Parse <d:displayname> or <displayname>
      const displayRegex = /<[a-zA-Z0-9:-]*displayname>([^<]+)<\/[a-zA-Z0-9:-]*displayname>/g;
      let match;
      while ((match = displayRegex.exec(text)) !== null) {
        const name = match[1].trim();
        if (name.startsWith("pi_sync_backup_") && name.endsWith(".zip")) {
          backups.push(name);
        }
      }

      // Fallback: <d:href>
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

  async upload(filePath: string, fileName: string): Promise<void> {
    const fs = await import("node:fs");
    const fileBuffer = fs.readFileSync(filePath);
    const url = this.baseUrl + encodeURIComponent(fileName);

    const response = await fetchWithTimeout(url, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/octet-stream",
      },
      body: fileBuffer,
    }, WEBDAV_FETCH_TIMEOUT_MS, this.ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV PUT returns HTTP ${response.status}: ${response.statusText}`);
    }
  }

  async download(fileName: string, destPath: string): Promise<void> {
    const fs = await import("node:fs");
    const url = this.baseUrl + encodeURIComponent(fileName);

    const response = await fetchWithTimeout(url, {
      method: "GET",
      headers: {
        Authorization: this.authHeader,
      },
    }, WEBDAV_FETCH_TIMEOUT_MS, this.ctx.signal);

    if (!response.ok) {
      throw new Error(`WebDAV GET returns HTTP ${response.status}: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
  }
}
