// Probes the local `claude` CLI to figure out whether sessions launched
// by this daemon will actually receive responses. Driven from the web
// UI's status card so a user who's set up the daemon under a fresh
// system account (the recommended "dedicated user" install) doesn't
// stare at a hung iPhone session for ten seconds wondering whether
// the daemon is broken — they see a clear "Run `claude /login` first"
// hint right in the browser.
//
// The probe is intentionally cheap: a 4-second `claude --version`
// + a `claude -p` round-trip with a tiny prompt and a hard timeout.
// We don't actually want a Claude response — we just want to see
// whether claude exits with the "Not logged in" banner or starts to
// stream tokens.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ClaudeAuthState = "ok" | "not-logged-in" | "missing" | "unknown";

/** Returns true ONLY when `~/.claude/.credentials.json` carries a complete
 *  OAuth record — accessToken plus a refreshToken — which is what claude's
 *  interactive TUI requires to forward prompts. An env-var-only token works
 *  for `claude -p` but the TUI flags it as "Not logged in · Run /login" and
 *  drops user input on the floor.
 *
 *  Returning `false` when the file is missing or has only `accessToken`
 *  (no refreshToken) is the trigger that flips the daemon UI to
 *  "Login required" so the user gets a Sign-In button instead of a
 *  silently broken session. */
function hasInteractiveCredentials(): boolean {
  const home = process.env.HOME;
  if (!home) return false;
  const p = path.join(home, ".claude", ".credentials.json");
  try {
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string | null } };
    const oauth = j.claudeAiOauth;
    return !!(oauth?.accessToken && oauth.refreshToken);
  } catch {
    return false;
  }
}

export interface ClaudeStatus {
  binary: string | null;
  version: string | null;
  authState: ClaudeAuthState;
  detail?: string;
}

/** Resolve the path the `claude` CLI lives at. Returns null if it's
 *  not on `$PATH` for the current user. */
export function locateClaudeBinary(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-lc", "command -v claude || true"], {
      timeout: 1500,
      encoding: "utf8",
    }, (_err, stdout) => {
      const path = (stdout ?? "").trim();
      resolve(path.length > 0 ? path : null);
    });
  });
}

/** Read the version line. Doesn't require auth. */
export function claudeVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("claude", ["--version"], {
      timeout: 3000,
      encoding: "utf8",
    }, (_err, stdout) => {
      const line = (stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
      resolve(line.length > 0 ? line : null);
    });
  });
}

/** Send a tiny prompt with a hard timeout. We give up after `timeoutMs`
 *  whether claude has answered or not — the goal is detection of the
 *  "Not logged in" banner, not getting a real response. */
export function probeClaudeAuth(timeoutMs = 4000): Promise<{
  authState: ClaudeAuthState;
  detail?: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("claude", ["-p", "ok"], {
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (state: ClaudeAuthState, detail?: string) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve({ authState: state, detail });
    };
    const killer = setTimeout(() => finish("ok", "responded within timeout"), timeoutMs);
    // The "Not logged in" banner can land on EITHER stdout or stderr
    // depending on the claude version (2.1.x writes it to stdout). We
    // therefore check BOTH streams for the banner before declaring
    // success on size — a 33-byte stdout chunk that says
    // "Not logged in · Please run /login" must not be misread as a
    // streaming response.
    const NOT_LOGGED_IN = /not logged in|please run \/login/i;
    const onChunk = (which: "stdout" | "stderr", b: Buffer) => {
      const text = b.toString("utf8");
      if (which === "stdout") stdout += text; else stderr += text;
      const combined = stdout + stderr;
      if (NOT_LOGGED_IN.test(combined)) {
        clearTimeout(killer);
        finish("not-logged-in", "claude printed the login banner");
        return;
      }
      // 32-byte threshold + banner-cleared content means real streaming
      // (claude's first response chunk is comfortably larger than the
      // 33-byte login banner, so this only triggers on actual output).
      if (stdout.length > 32 && !NOT_LOGGED_IN.test(stdout)) {
        clearTimeout(killer);
        finish("ok", "streaming");
      }
    };
    child.stdout?.on("data", (b: Buffer) => onChunk("stdout", b));
    child.stderr?.on("data", (b: Buffer) => onChunk("stderr", b));
    child.on("error", (err) => {
      clearTimeout(killer);
      finish("missing", err.message);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      if (settled) return;
      // Combined stdout/stderr inspection — sometimes the banner is on
      // stdout in certain shells.
      const combined = (stdout + " " + stderr).toLowerCase();
      if (combined.includes("not logged in") || combined.includes("please run /login")) {
        finish("not-logged-in");
      } else if (code === 0 && stdout.trim().length > 0) {
        finish("ok");
      } else {
        finish("unknown", `exit ${code}`);
      }
    });
  });
}

/** Combined snapshot used by `/api/state`. Cached for `cacheMs` so the
 *  2-second poll loop doesn't spawn a `claude` child every tick. */
let cached: { at: number; status: ClaudeStatus } | null = null;
const CACHE_MS = 30_000;

export async function getClaudeStatus(): Promise<ClaudeStatus> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.status;
  const binary = await locateClaudeBinary();
  if (!binary) {
    const status: ClaudeStatus = { binary: null, version: null, authState: "missing", detail: "`claude` not found on PATH" };
    cached = { at: Date.now(), status };
    return status;
  }
  const [version, probe] = await Promise.all([
    claudeVersion(),
    probeClaudeAuth(),
  ]);
  // The `-p` probe says "ok" when an env-var-only token is present —
  // but iPhone sessions run claude in interactive TUI mode, which needs
  // a full credentials.json. Override the probe result if the file is
  // missing/incomplete so the UI prompts the user to re-run Sign-In.
  let authState = probe.authState;
  let detail = probe.detail;
  if (authState === "ok" && !hasInteractiveCredentials()) {
    authState = "not-logged-in";
    detail = "Token works for `claude -p` but interactive sessions need a full ~/.claude/.credentials.json. One more Sign-in writes it.";
  }
  const status: ClaudeStatus = { binary, version, authState, detail };
  cached = { at: Date.now(), status };
  return status;
}

/** Clear the cache — used when something likely changed (peer revoked,
 *  daemon just started). The next `/api/state` re-probes. */
export function invalidateClaudeStatusCache(): void {
  cached = null;
}
