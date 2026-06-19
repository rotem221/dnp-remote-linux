// Per-host Ed25519 keypair plus the trusted-peer registry. Kept in a
// single JSON file under `$XDG_CONFIG_HOME/dnp-remote/identity.json`
// (defaults to `~/.config/dnp-remote/identity.json` on Linux). chmod
// 600 on first write so the secret key isn't world-readable.
//
// Format:
//   {
//     "deviceId": "<uuid>",
//     "deviceName": "<hostname>",
//     "secretKey": "<base64 of 64-byte tweetnacl secret>",
//     "publicKey": "<base64 of 32-byte ed25519 public>",
//     "trustedPeers": [
//       { "deviceId": "...", "deviceName": "...", "platform": "ios",
//         "publicKey": "...", "pairedAt": "...iso..." }
//     ]
//   }

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateKeyPair } from "./signer.js";
import { newUUID } from "./protocol.js";

export interface TrustedPeer {
  deviceId: string;
  deviceName: string;
  platform: string;
  publicKey: string; // base64
  pairedAt: string;
}

export interface Identity {
  deviceId: string;
  deviceName: string;
  secretKey: string; // base64 (64-byte tweetnacl secret)
  publicKey: string; // base64 (32-byte public)
  trustedPeers: TrustedPeer[];
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "dnp-remote");
}

function identityPath(): string {
  return path.join(configDir(), "identity.json");
}

function defaultDeviceName(): string {
  // Combine the hostname with a brand prefix so the iPhone's paired
  // devices list shows something meaningful without the user having
  // to set a name.
  const host = os.hostname() || "linux";
  return `DNP Remote · ${host}`;
}

/** Load identity from disk; create + persist if missing. */
export function loadOrCreateIdentity(): Identity {
  const filePath = identityPath();
  if (fs.existsSync(filePath)) {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Identity;
    // Defensive normalisation in case an older file is missing a field.
    if (!parsed.trustedPeers) parsed.trustedPeers = [];
    return parsed;
  }
  const kp = generateKeyPair();
  const id: Identity = {
    deviceId: newUUID(),
    deviceName: defaultDeviceName(),
    secretKey: Buffer.from(kp.secretKey).toString("base64"),
    publicKey: Buffer.from(kp.publicKey).toString("base64"),
    trustedPeers: [],
  };
  saveIdentity(id);
  return id;
}

export function saveIdentity(id: Identity): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = identityPath();
  fs.writeFileSync(filePath, JSON.stringify(id, null, 2), { mode: 0o600 });
}

/** Convenience accessors that return raw bytes. */
export function secretKeyBytes(id: Identity): Uint8Array {
  return Buffer.from(id.secretKey, "base64");
}

export function publicKeyBytes(id: Identity): Uint8Array {
  return Buffer.from(id.publicKey, "base64");
}

export function findTrustedPeer(
  id: Identity,
  deviceId: string,
): TrustedPeer | undefined {
  return id.trustedPeers.find((p) => p.deviceId === deviceId);
}

export function rememberPeer(id: Identity, peer: TrustedPeer): Identity {
  const without = id.trustedPeers.filter((p) => p.deviceId !== peer.deviceId);
  const next: Identity = { ...id, trustedPeers: [...without, peer] };
  saveIdentity(next);
  return next;
}

export function forgetPeer(id: Identity, deviceId: string): Identity {
  const next: Identity = {
    ...id,
    trustedPeers: id.trustedPeers.filter((p) => p.deviceId !== deviceId),
  };
  saveIdentity(next);
  return next;
}

export function configDirPath(): string {
  return configDir();
}

// ---------- Claude OAuth token storage ----------
// Stored separately from the device identity (`identity.json`) because the
// OAuth token is much more sensitive — it grants Claude API inference on the
// user's plan — and we want a tiny, single-purpose file that's easy to audit
// and easy to wipe (`rm`) without losing the device's signing keys. Mode 600
// is mandatory; we re-set it on every write so accidental `chmod g+r` from
// some other admin tool doesn't go unnoticed.

function claudeOAuthTokenPath(): string {
  return path.join(configDir(), "claude-oauth.json");
}

interface ClaudeOAuthRecord {
  token: string;
  savedAt: string;
}

export function saveClaudeOAuthToken(token: string): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = claudeOAuthTokenPath();
  const rec: ClaudeOAuthRecord = { token, savedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function loadClaudeOAuthToken(): string | null {
  try {
    const raw = fs.readFileSync(claudeOAuthTokenPath(), "utf8");
    const rec = JSON.parse(raw) as ClaudeOAuthRecord;
    return typeof rec.token === "string" && rec.token.length > 0 ? rec.token : null;
  } catch {
    return null;
  }
}

export function clearClaudeOAuthToken(): void {
  try { fs.unlinkSync(claudeOAuthTokenPath()); } catch { /* not present */ }
}

/** Write the full OAuth credential set into `~/.claude/.credentials.json`
 *  in the exact shape claude reads (the `claudeAiOauth` object — verified
 *  against the bundled cli.js, where the format is set by
 *  `z.claudeAiOauth = { accessToken, refreshToken, expiresAt, scopes,
 *  subscriptionType, rateLimitTier }` inside the OAuth-tokens-save path).
 *
 *  Why this matters: setting only `CLAUDE_CODE_OAUTH_TOKEN` makes claude
 *  treat the session as "inference only" — `claude -p` works, but the
 *  interactive TUI shows "Not logged in · Run /login" and refuses to
 *  forward prompts. Writing the full record (including refreshToken +
 *  expiresAt) is what `claude /login` does itself, and what the
 *  interactive auth path requires.
 *
 *  Mode 600 on the file. Caller is responsible for invalidating any
 *  status caches afterward.
 */
export function writeClaudeCredentials(args: {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  subscriptionType?: string | null;
}): void {
  const home = process.env.HOME;
  if (!home) throw new Error("HOME not set — can't locate ~/.claude/");
  const dir = path.join(home, ".claude");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, ".credentials.json");
  // Preserve any siblings claude already wrote (e.g. settings keys).
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(target)) {
      existing = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
    }
  } catch { /* malformed → overwrite */ }
  existing.claudeAiOauth = {
    accessToken: args.accessToken,
    refreshToken: args.refreshToken,
    expiresAt: args.expiresAt,
    scopes: args.scopes.length > 0 ? args.scopes : ["user:inference"],
    subscriptionType: args.subscriptionType ?? null,
    rateLimitTier: null,
  };
  fs.writeFileSync(target, JSON.stringify(existing), { mode: 0o600 });
  fs.chmodSync(target, 0o600);
}

/** Pre-populate `~/.claude.json` with onboarding-skipped flags so a freshly
 *  authenticated user doesn't get stuck on claude's theme picker /
 *  trust-this-folder wizard the moment a session opens. claude only writes
 *  these flags itself when the user goes through `claude /login` interactively
 *  (the keychain path); a `CLAUDE_CODE_OAUTH_TOKEN`-only user lands as if it's
 *  their first run, sees the onboarding TUI, and the iPhone's prompts get
 *  swallowed by Ink's option-picker waiting for arrow keys.
 *
 *  Idempotent — safe to call on every daemon start. Only writes when fields
 *  are missing, so it won't clobber a user who later customised their theme.
 */
export function ensureClaudeOnboardingComplete(): void {
  const home = process.env.HOME;
  if (!home) return;
  const cfgPath = path.join(home, ".claude.json");
  let cfg: Record<string, unknown> = {};
  try {
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    }
  } catch { /* malformed → start fresh */ }

  let mutated = false;
  if (cfg.hasCompletedOnboarding !== true) {
    cfg.hasCompletedOnboarding = true;
    mutated = true;
  }
  if (typeof cfg.theme !== "string") {
    cfg.theme = "dark";
    mutated = true;
  }
  if (!cfg.lastOnboardingVersion) {
    cfg.lastOnboardingVersion = {
      VERSION: "2.1.112",
      PACKAGE_URL: "@anthropic-ai/claude-code",
      README_URL: "https://code.claude.com/docs/en/overview",
      FEEDBACK_CHANNEL: "https://github.com/anthropics/claude-code/issues",
      ISSUES_EXPLAINER: "report the issue at https://github.com/anthropics/claude-code/issues",
      BUILD: "native",
    };
    mutated = true;
  }
  if (!mutated) return;
  try {
    // Preserve mode 600 — file may contain OAuth metadata.
    const opts = { mode: 0o600 } as const;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), opts);
    fs.chmodSync(cfgPath, 0o600);
  } catch (e) {
    // Non-fatal — the daemon can still run, the user just hits the picker.
    console.warn(`[keys] couldn't write claude onboarding flags: ${(e as Error).message}`);
  }
}
