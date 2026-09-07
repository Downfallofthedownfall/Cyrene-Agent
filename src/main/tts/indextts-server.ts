// IndexTTS server runner — auto-launch / keep-alive / restart / stop.
//
// Enhanced usability: when the IndexTTS engine is configured with modelDir +
// pythonPath (the user only fills those two, no PowerShell), the main process
// spawns the bundled thin server (`src/main/tts/server/indextts_server.py`)
// on 127.0.0.1:<port>, waits until it's ready, auto-restarts it if it crashes,
// and stops it on app exit. Users who run their own server can keep a manual
// `baseUrl` override instead (see resolveIndexttsBaseUrl()).
//
// Follows the mpv/LSP spawn precedent (spawn + keep-alive + dispose). Uses the
// `electron` `app` object only inside functions, so this module is safe to
// import in the node test environment as long as nothing here is invoked.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { loadGeneralSettings } from "../settings/settings-facade";
import type { GeneralSettings } from "../settings/general-settings";

export type IndexttsEngineVersion = "v2" | "v2_5";

export interface IndexttsServerOptions {
  /** IndexTTS model checkpoint directory (must contain config.yaml). */
  modelDir: string;
  /** Python interpreter with `index-tts` / `torch` installed. */
  pythonPath: string;
  /** Port to bind on 127.0.0.1 (default 9880). */
  port?: number;
  /** Engine version: v2 (IndexTTS 2.0, default) or v2_5 (best-effort). */
  engineVersion?: IndexttsEngineVersion;
  /** Host to bind (default 127.0.0.1). */
  host?: string;
}

const DEFAULT_PORT = 9880;
const DEFAULT_HOST = "127.0.0.1";
/** Model load can exceed 3 minutes on CPU; give it a generous window. */
const STARTUP_TIMEOUT_MS = 240_000;
const READY_POLL_INTERVAL_MS = 2000;
const READY_POLL_ATTEMPTS = Math.ceil(STARTUP_TIMEOUT_MS / READY_POLL_INTERVAL_MS);
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 3;

function buildBaseUrl(host: string, port: number): string {
  return `http://${host}:${port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve the bundled server script path for dev vs packaged builds. */
export function getIndexttsServerScriptPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "indextts", "indextts_server.py")
    : path.join(app.getAppPath(), "src", "main", "tts", "server", "indextts_server.py");
}

/**
 * Manages the single IndexTTS server child process.
 * `ensureStarted()` is idempotent — concurrent callers share one start promise.
 */
export class IndexttsServerRunner {
  private proc: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private startPromise: Promise<string> | null = null;
  private stopping = false;
  private ready = false;
  private lastSpawnError: string | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private restartCount = 0;

  async ensureStarted(opts: IndexttsServerOptions): Promise<string> {
    if (this.proc && this.baseUrl) return this.baseUrl; // already running
    if (this.startPromise) return this.startPromise;    // in flight — share it

    const host = opts.host ?? DEFAULT_HOST;
    const port = opts.port ?? DEFAULT_PORT;
    const url = buildBaseUrl(host, port);
    const script = getIndexttsServerScriptPath();

    if (!fs.existsSync(script)) {
      throw new Error(`IndexTTS server 脚本不存在: ${script}`);
    }
    if (!fs.existsSync(opts.modelDir)) {
      throw new Error(`IndexTTS 模型目录不存在: ${opts.modelDir}`);
    }
    if (this.restartCount >= MAX_RESTARTS) {
      throw new Error(`IndexTTS server 连续崩溃 ${this.restartCount} 次，已停止自动重启`);
    }

    this.stopping = false;
    this.ready = false;
    this.lastSpawnError = null;
    this.startPromise = this.spawnAndWait(script, opts, host, port, url)
      .then(() => {
        this.baseUrl = url;
        this.startPromise = null;
        this.ready = true;
        this.restartCount = 0; // survived to ready — reset the crash budget
        return url;
      })
      .catch((err: Error) => {
        this.startPromise = null;
        this.proc = null; // ensure a later call spawns afresh
        if (err.message.includes("ready")) {
          this.restartCount += 1;
          throw new Error(`IndexTTS server 启动超时（${STARTUP_TIMEOUT_MS}ms）：${err.message}`);
        }
        throw err;
      });
    return this.startPromise;
  }

  private async spawnAndWait(
    script: string,
    opts: IndexttsServerOptions,
    host: string,
    port: number,
    url: string,
  ): Promise<void> {
    const engine = opts.engineVersion ?? "v2";
    const args = [
      script,
      "--model-dir", opts.modelDir,
      "--host", host,
      "--port", String(port),
      "--engine", engine,
    ];

    const child = spawn(opts.pythonPath, args, {
      cwd: path.dirname(script),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = child;
    // Pipe output to the console for diagnostics (keep-alive logging like mpv).
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    child.on("error", (err) => {
      console.error("[IndexTTS] spawn failed:", err);
      this.lastSpawnError = err.message;
      this.onProcessGone(script, opts, host, port);
    });
    child.on("exit", (code, signal) => {
      console.warn(`[IndexTTS] server exited code=${code} signal=${signal}`);
      this.onProcessGone(script, opts, host, port);
    });

    console.log(`[IndexTTS] spawning server on ${url} (engine=${engine})`);
    await this.pollReady(host, port);
  }

  private async pollReady(host: string, port: number): Promise<void> {
    const url = `${buildBaseUrl(host, port)}/health`;
    for (let attempt = 0; attempt < READY_POLL_ATTEMPTS; attempt++) {
      if (this.stopping || !this.proc) {
        throw new Error(this.lastSpawnError ?? "IndexTTS server 在启动期间已停止");
      }
      try {
        const resp = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
        if (resp.ok) return;
        // 200 but body not ready yet — keep polling.
      } catch {
        // not listening yet — keep polling.
      }
      await sleep(READY_POLL_INTERVAL_MS);
    }
    throw new Error(`ready-timeout: ${url}`);
  }

  private onProcessGone(_script: string, opts: IndexttsServerOptions, host: string, port: number): void {
    if (this.stopping) return; // deliberate stop — no restart
    this.proc = null;
    this.baseUrl = null;
    this.startPromise = null;
    // During startup the pending pollReady() will throw and the start-promise will
    // reject; don't auto-restart a server that never became ready (config error).
    if (!this.ready) return;
    if (this.restartTimer) return; // restart already scheduled
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.ensureStarted(opts).catch((err) => {
        console.error("[IndexTTS] restart failed:", err);
      });
    }, RESTART_DELAY_MS);
  }

  isRunning(): boolean {
    return this.proc !== null && !this.stopping;
  }

  getBaseUrl(): string | null {
    return this.baseUrl;
  }

  dispose(): void {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.baseUrl = null;
    this.startPromise = null;
  }
}

// Module-level singleton.
let runner: IndexttsServerRunner | null = null;

export function getIndexttsServerRunner(): IndexttsServerRunner {
  runner ??= new IndexttsServerRunner();
  return runner;
}

/** Stop any running IndexTTS server (called on app will-quit). */
export function stopIndexttsServer(): void {
  getIndexttsServerRunner().dispose();
}

/**
 * Resolve the effective IndexTTS base URL:
 *  - auto-launch: when modelDir + pythonPath are configured, start (or reuse)
 *    the bundled server and return its 127.0.0.1:<port> URL;
 *  - override: otherwise return the manual `ttsIndexttsBaseUrl` for users who
 *    run their own server (default http://localhost:9880).
 */
export async function resolveIndexttsBaseUrl(settings?: GeneralSettings): Promise<string> {
  const s = settings ?? loadGeneralSettings();
  if (s.ttsIndexttsModelDir && s.ttsIndexttsPythonPath) {
    return getIndexttsServerRunner().ensureStarted({
      modelDir: s.ttsIndexttsModelDir,
      pythonPath: s.ttsIndexttsPythonPath,
      port: s.ttsIndexttsPort || DEFAULT_PORT,
      engineVersion: s.ttsIndexttsEngineVersion,
    });
  }
  return s.ttsIndexttsBaseUrl || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
}
