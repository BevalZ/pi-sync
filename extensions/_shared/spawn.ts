/**
 * Shared spawn wrapper for Pi extensions.
 *
 * Single unified async spawn with timeout, Windows process-tree kill,
 * and consistent { ok, stdout, stderr, status } result.
 *
 * Usage:
 *   import { runCommand, type SpawnResult } from "../_shared/spawn";
 *   const r = await runCommand("git", ["status"], { cwd: repoDir, timeoutMs: 30000 });
 *   if (!r.ok) throw new Error(r.stderr);
 */

import { spawn } from "node:child_process";

export interface SpawnResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  timeoutMs?: number;
  windowsHide?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function runCommand(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: opts.windowsHide ?? true,
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));

    const ms = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } else {
          child.kill();
        }
      } catch (_error) {
        // Ignore process cleanup failure.
      }
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}\nTimeout ${ms}ms`,
        status: null,
      });
    }, ms);

    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || err.message, status: null });
    });

    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, status: code });
    });
  });
}
