// Direct OAuth handshake against Anthropic's `platform.claude.com` —
// the same flow `claude setup-token` does internally, but driven from
// the daemon's web UI without ever spawning the claude CLI.
//
// Why we ditched the PTY approach: spawning `claude setup-token` and
// scraping its Ink TUI worked for the URL+invalid-error path, but the
// success path was unreliable. claude's TUI re-renders the screen with
// cursor controls when the OAuth round-trip completes; the token text
// can land split across redraws, behind ANSI sequences our stripper
// didn't quite cover, or simply after our timeout fired. End-to-end
// tests showed: invalid codes returned in 0 s with the right error,
// valid codes (real ones) timed out at 30/60/120 s with the buffer
// quietly empty after a single 111-byte echo. The fix isn't a longer
// timeout — it's not depending on TUI scraping at all.
//
// What this file does instead:
//   1. Generates a PKCE code_verifier + S256 code_challenge in-process.
//   2. Builds the authorize URL with the same params claude does
//      (extracted from `cli.js`'s `OZ8`/`buildAuthUrl` function).
//   3. Returns the URL to the UI; user opens it, completes OAuth, the
//      Anthropic callback page shows them a `code#state` string.
//   4. User pastes back, we split on `#`, verify state matches what we
//      sent, then POST `{grant_type: "authorization_code", code, state,
//      code_verifier, client_id, redirect_uri}` to
//      `https://platform.claude.com/v1/oauth/token`. Same body
//      `exchangeCodeForTokens` (`Uf1`) sends.
//   5. Server replies with `{access_token: "sk-ant-oat..."}`. Persist.
//
// All endpoint constants below match the `Ju7` (prod) config in
// claude-code's bundled cli — verified by `grep TOKEN_URL` on the
// installed binary.

import { randomBytes, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { saveClaudeOAuthToken, ensureClaudeOnboardingComplete, writeClaudeCredentials } from "./keys.js";
import { invalidateClaudeStatusCache } from "./claudeStatus.js";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
// Full-scope login — these are the same scopes `claude /login` requests
// (extracted verbatim from the bundled cli.js's scope constants:
// `[fA6, dC, "user:sessions:claude_code", "user:mcp_servers",
// "user:file_upload"]` where `fA6 = "user:profile"` and `dC =
// "user:inference"`). Requesting only `user:inference` produced an
// "inference-only" token claude treats as not-logged-in for interactive
// sessions — confirmed in the cli's own error text:
// "tokens from 'claude setup-token' do not include this scope".
const SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

interface AuthSession {
  id: string;
  state: string;
  codeVerifier: string;
  url: string;
  createdAt: number;
  expiry: NodeJS.Timeout;
  // Result tracking for the GET /status endpoint.
  status: "awaitingCode" | "exchanging" | "complete" | "failed";
  error?: string;
  tail?: string;  // last response chunk (for diagnostic display)
}

const sessions = new Map<string, AuthSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

// Persist in-flight OAuth sessions to disk so a daemon restart (deploy,
// crash, systemd reload) doesn't strand the user mid-flow with the
// "Couldn't find the sign-in session this code belongs to" error. The
// data is short-lived and per-machine — losing it just means the user
// has to start a new sign-in, never a security risk on its own.
const AUTH_SESSIONS_PATH = path.join(
  process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config"),
  "dnp-remote",
  "auth-sessions.json",
);

interface PersistedAuthSession {
  id: string;
  state: string;
  codeVerifier: string;
  url: string;
  createdAt: number;
}

function persistSessions(): void {
  try {
    const list: PersistedAuthSession[] = [];
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.status === "complete") continue; // no point persisting completed
      if (now - s.createdAt > SESSION_TTL_MS) continue;
      list.push({
        id: s.id, state: s.state, codeVerifier: s.codeVerifier,
        url: s.url, createdAt: s.createdAt,
      });
    }
    fs.mkdirSync(path.dirname(AUTH_SESSIONS_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTH_SESSIONS_PATH, JSON.stringify(list), { mode: 0o600 });
  } catch { /* non-fatal */ }
}

function rehydrateSessions(): void {
  try {
    if (!fs.existsSync(AUTH_SESSIONS_PATH)) return;
    const raw = fs.readFileSync(AUTH_SESSIONS_PATH, "utf8");
    const list = JSON.parse(raw) as PersistedAuthSession[];
    const now = Date.now();
    let restored = 0;
    for (const p of list) {
      if (now - p.createdAt > SESSION_TTL_MS) continue;
      const remaining = SESSION_TTL_MS - (now - p.createdAt);
      const session: AuthSession = {
        id: p.id, state: p.state, codeVerifier: p.codeVerifier,
        url: p.url, createdAt: p.createdAt,
        status: "awaitingCode",
        expiry: setTimeout(() => destroySession(p.id), remaining),
      };
      sessions.set(p.id, session);
      restored++;
    }
    if (restored > 0) console.log(`[claudeAuth] rehydrated ${restored} in-flight session(s) from disk`);
  } catch { /* malformed → ignore */ }
}

// Run rehydrate at module load — happens once on daemon startup.
rehydrateSessions();

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function destroySession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  clearTimeout(s.expiry);
  sessions.delete(id);
  persistSessions();
}

export interface StartResult {
  sessionId: string;
  url: string;
}

export async function startAuth(): Promise<StartResult> {
  // PKCE: 64 random bytes → URL-safe base64 (88 chars). Spec allows
  // 43–128 chars — well within bounds. SHA-256 of the verifier is the
  // challenge the auth server stores; the server later compares it
  // against the verifier we send during exchange.
  const codeVerifier = base64UrlEncode(randomBytes(64));
  const codeChallenge = base64UrlEncode(
    createHash("sha256").update(codeVerifier).digest(),
  );
  // Random opaque state. The auth server echoes it on the callback
  // (`code#state`) and we re-send it on exchange — guards against
  // someone trying to swap codes between concurrent flows.
  const state = base64UrlEncode(randomBytes(32));

  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("code", "true");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("code_challenge", codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);

  const id = base64UrlEncode(randomBytes(16));
  const session: AuthSession = {
    id,
    state,
    codeVerifier,
    url: u.toString(),
    createdAt: Date.now(),
    status: "awaitingCode",
    expiry: setTimeout(() => destroySession(id), SESSION_TTL_MS),
  };
  sessions.set(id, session);
  persistSessions();
  console.log(`[claudeAuth ${id.slice(0,8)}] startAuth — issued state=${state.slice(0,8)}…`);
  return { sessionId: id, url: session.url };
}

export interface SubmitResult {
  ok: boolean;
  error?: string;
}

export async function submitCode(sessionId: string, raw: string): Promise<SubmitResult> {
  // Robust paste handling — tolerate three shapes the user might copy:
  //   1. `code#state` (the canonical Anthropic callback display).
  //   2. Just `code` (if Anthropic's page is reformatted in a future rev).
  //   3. The full callback URL pasted verbatim, e.g.
  //      `https://platform.claude.com/oauth/code/callback?code=…&state=…`
  //      or with `#` instead of `&` between code and state. This was the
  //      most common failure path — users select the address bar by mistake
  //      and paste that, getting "Invalid code".
  let trimmed = raw.replace(/\s+/g, "");
  // URL form? Pull `code` and `state` out of query-string OR fragment.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const c = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      const hashParams = new URLSearchParams(u.hash.replace(/^#/, ""));
      const finalCode = c ?? hashParams.get("code");
      const finalState = st ?? hashParams.get("state");
      if (finalCode) {
        trimmed = finalState ? `${finalCode}#${finalState}` : finalCode;
      }
    } catch { /* fall through with raw paste */ }
  }
  const hashAt = trimmed.indexOf("#");
  let code: string;
  let returnedState: string | null = null;
  if (hashAt > 0) {
    code = trimmed.substring(0, hashAt);
    returnedState = trimmed.substring(hashAt + 1);
  } else {
    code = trimmed;
  }
  if (!code) return { ok: false, error: "Empty code" };
  // Sanity-check the code shape. URL-safe base64 only uses A-Z a-z 0-9
  // - and _; an `@` or `.` or `,` slipping in is a clear copy/paste
  // mistake (selected too much, picked up an email-style suffix, etc.).
  // Reject early with a helpful message instead of round-tripping to
  // Anthropic for a generic "Invalid 'code' in request.".
  if (!/^[A-Za-z0-9_-]+$/.test(code)) {
    const bad = (code.match(/[^A-Za-z0-9_-]/g) ?? []).slice(0, 5).join(" ");
    return {
      ok: false,
      error: `The code contains characters that aren't valid in an OAuth code (${bad}). Click Sign in again, click "Open ↗", complete the Anthropic page, then use the COPY button on that page (don't select-all manually).`,
    };
  }
  console.log(`[claudeAuth] sanitized code: ${code.length} chars, head=${code.slice(0,6)} tail=${code.slice(-6)}`);

  // Multi-session fallback. A user who closed and reopened the modal
  // between fetching the URL (in their browser tab) and pasting the
  // returned code will see the modal create a fresh session with a new
  // state — and a state mismatch when they paste. Resolve it by
  // searching every live session for a matching state. We trust
  // `returnedState` only when it's present; codes without `#state`
  // tail fall back to the session id the caller passed.
  let s: AuthSession | undefined;
  if (returnedState) {
    for (const candidate of sessions.values()) {
      if (candidate.state === returnedState
          && (candidate.status === "awaitingCode" || candidate.status === "failed")) {
        s = candidate;
        break;
      }
    }
    if (!s) {
      console.log(`[claudeAuth] state ${returnedState.slice(0,8)}… not found in ${sessions.size} active sessions`);
      return {
        ok: false,
        error: "Couldn't find the sign-in session this code belongs to. The session expires after 10 minutes — click Sign in again to start fresh and complete the flow without closing the modal in between.",
      };
    }
    if (s.id !== sessionId) {
      console.log(`[claudeAuth] code state matched a sibling session (${s.id.slice(0,8)}…), not the caller's (${s.id.slice(0,8)}…) — using sibling`);
    }
  } else {
    s = sessions.get(sessionId);
    if (!s) return { ok: false, error: "Unknown auth session — it may have expired. Click Sign in again." };
    if (s.status !== "awaitingCode" && s.status !== "failed") {
      return { ok: false, error: `Session is in unexpected state: ${s.status}` };
    }
  }

  s.status = "exchanging";
  s.error = undefined;
  s.tail = undefined;

  console.log(`[claudeAuth ${s.id.slice(0,8)}] exchanging code (${code.length} chars) for token at ${TOKEN_URL}`);
  const t0 = Date.now();
  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: s.codeVerifier,
        state: s.state,
      }),
      // 30 s is plenty: the upstream's own timeout in the cli is 15 s.
      signal: AbortSignal.timeout(30_000),
    });
    const elapsed = Date.now() - t0;
    const text = await resp.text();
    s.tail = text.slice(0, 600);
    console.log(`[claudeAuth ${s.id.slice(0,8)}] exchange returned ${resp.status} in ${elapsed}ms`);
    if (resp.status !== 200) {
      s.status = "failed";
      // Try to parse the error JSON; fall back to status text.
      let detail = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(text);
        detail = j.error_description || j.error || j.message || detail;
      } catch { /* not JSON — leave the status code */ }
      s.error = resp.status === 401
        ? `Invalid or expired code. Click Sign in again for a fresh URL — codes are one-shot and expire after a few minutes.`
        : `Token exchange failed (${detail}). Try a fresh code.`;
      return { ok: false, error: s.error };
    }
    const json = JSON.parse(text) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (!json.access_token) {
      s.status = "failed";
      s.error = "Anthropic returned 200 but no access_token in the response.";
      return { ok: false, error: s.error };
    }
    saveClaudeOAuthToken(json.access_token);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = json.access_token;
    // Write the FULL credential set claude expects in interactive mode —
    // env-var-only tokens are treated as "inference_only" by claude and
    // the TUI shows "Not logged in · Run /login" while still answering
    // `claude -p` calls. Persist refreshToken + expiresAt so the
    // interactive prompt forwards messages to the API like a real
    // logged-in session.
    try {
      const expiresAt = json.expires_in
        ? Date.now() + json.expires_in * 1000
        : null;
      const scopes = (json.scope ?? SCOPES.join(" ")).split(/\s+/).filter(Boolean);
      writeClaudeCredentials({
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresAt,
        scopes,
      });
      console.log(`[claudeAuth ${s.id.slice(0,8)}] wrote ~/.claude/.credentials.json (expiresAt=${expiresAt}, scopes=${scopes.join(",")})`);
    } catch (e) {
      console.log(`[claudeAuth ${s.id.slice(0,8)}] failed to write credentials.json: ${(e as Error).message}`);
      // Non-fatal — env var is still set, `claude -p` works.
    }
    ensureClaudeOnboardingComplete();
    invalidateClaudeStatusCache();
    s.status = "complete";
    console.log(`[claudeAuth ${s.id.slice(0,8)}] TOKEN SAVED: ${json.access_token.slice(0, 12)}…`);
    setTimeout(() => destroySession(s!.id), 5_000);
    return { ok: true };
  } catch (e) {
    s.status = "failed";
    s.error = `Token exchange failed: ${(e as Error).message}`;
    console.log(`[claudeAuth ${s.id.slice(0,8)}] EXCHANGE THREW: ${s.error}`);
    return { ok: false, error: s.error };
  }
}

export function cancelAuth(sessionId: string): void {
  destroySession(sessionId);
}

export interface AuthStatus {
  state: string;
  url: string | null;
  error?: string;
  tail?: string;
}

export function getAuthStatus(sessionId: string): AuthStatus | null {
  const s = sessions.get(sessionId);
  if (!s) return null;
  return { state: s.status, url: s.url, error: s.error, tail: s.tail };
}
