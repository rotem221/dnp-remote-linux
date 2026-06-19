// Session manager — owns the PTY children that run `claude` (or any
// shell) on the Linux host. The iPhone calls `newSessionRequest` to
// spawn a session; we forkpty + exec the configured command, fan the
// stdout into `liveEvent` / `eventBatch` envelopes, and let the
// iPhone drive prompts back through `userPrompt`.
//
// Phase 1 ships *raw* PTY bytes as `.raw` SessionEvents — the iPhone
// renders them as a terminal-style log. Semantic event extraction
// (commands, file edits, tool calls as cards) is a Phase-2 add-on
// once we mirror the Mac's `EventNormalizerService`.

import * as nodePty from "node-pty";
import path from "node:path";
import os from "node:os";
import {
  newUUID,
  formatDate,
  Session,
  SessionEvent,
  SessionStatus,
} from "./protocol.js";
import { loadClaudeOAuthToken } from "./keys.js";

export interface SessionsOptions {
  /** Command to launch in each new session. Defaults to `claude` so
   *  out-of-the-box the iPhone immediately drops into Claude Code;
   *  override with `--shell` to get a plain bash. */
  defaultCommand: string;
  /** Project root. PTY's working directory + the `projectPath` we
   *  stamp on each Session. Defaults to `process.cwd()`. */
  projectRoot: string;
  /** Notified on every session-list change so the daemon can
   *  broadcast `sessionListResponse` to all paired iPhones. */
  onSessionsChanged: () => void;
  /** Notified for every fresh PTY chunk so the daemon can wrap it as
   *  a `liveEvent` and broadcast. */
  onLiveEvent: (event: SessionEvent) => void;
}

interface SessionRecord {
  session: Session;
  pty: nodePty.IPty;
  /** Recent event ring — replayed to a freshly-connected iPhone via
   *  `eventBatch` so the user doesn't lose context after reconnect. */
  feed: SessionEvent[];
  sequence: number;
  /** Coalesces consecutive PTY bytes into a single event so we don't
   *  swamp the iPhone with one envelope per character. */
  bufferedRaw: { text: string; firstAt: Date } | null;
  flushTimer: NodeJS.Timeout | null;
  /** Latched once we've already surfaced the "claude not logged in"
   *  warning to the iPhone so we don't spam the feed with the same
   *  banner every time it repaints. */
  claudeNotLoggedInSurfaced: boolean;
}

const FEED_RING = 500;
const FLUSH_MS = 60;

export class Sessions {
  private records = new Map<string, SessionRecord>();
  constructor(private readonly opts: SessionsOptions) {}

  list(): Session[] {
    return [...this.records.values()].map((r) => r.session);
  }

  feedFor(sessionId: string): SessionEvent[] {
    return this.records.get(sessionId)?.feed ?? [];
  }

  /** Spawn a new session. Returns the session id. */
  create(args?: { projectPath?: string }): string {
    const projectPath = args?.projectPath ?? this.opts.projectRoot;
    const [cmd, ...cmdArgs] = parseCommand(this.opts.defaultCommand);
    const cols = 120;
    const rows = 36;
    // Inject the persisted OAuth token (set via the daemon's web UI sign-in
    // flow) so a freshly-installed `dnpremote` user can drive `claude`
    // without ever logging in via SSH. Per docs auth precedence #5, this
    // takes effect when nothing higher is configured (no
    // ANTHROPIC_API_KEY, no apiKeyHelper). If `process.env` already
    // carries `CLAUDE_CODE_OAUTH_TOKEN` (set by the auth completion path
    // mid-process), the disk read is a no-op fallback.
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
      ?? loadClaudeOAuthToken()
      ?? undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: "xterm-256color",
      ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: oauth } : {}),
    };
    const pty = nodePty.spawn(cmd, cmdArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: projectPath,
      env,
    });
    const id = newUUID();
    const now = formatDate();
    const session: Session = {
      id,
      title: makeTitle(this.records.size),
      projectPath,
      projectName: path.basename(projectPath) || "linux",
      createdAt: now,
      updatedAt: now,
      status: "running",
      lastActivityAt: now,
      pendingApprovalCount: 0,
      contextHealth: "healthy",
      claudeSessionId: null,
    };
    const record: SessionRecord = {
      session,
      pty,
      feed: [],
      sequence: 0,
      bufferedRaw: null,
      flushTimer: null,
      claudeNotLoggedInSurfaced: false,
    };
    this.records.set(id, record);

    pty.onData((chunk) => this.bufferRaw(record, chunk));
    pty.onExit(({ exitCode }) => {
      this.flushRaw(record); // emit anything still buffered
      this.appendSyntheticEvent(record, "sessionEnded",
        `Session exited (code ${exitCode})`);
      record.session.status = "ended";
      record.session.updatedAt = formatDate();
      this.opts.onSessionsChanged();
    });
    this.appendSyntheticEvent(record, "sessionStarted",
      `Session started · ${cmd}${cmdArgs.length ? " " + cmdArgs.join(" ") : ""}`);
    this.opts.onSessionsChanged();
    return id;
  }

  /** Send a user prompt + Return into the named session's PTY.
   *  Mirrors the Mac flow where the iPhone never types directly into
   *  Claude — it always goes through the host. */
  sendPrompt(sessionId: string, text: string): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    // Append a Return so claude/bash treats this as a complete line.
    r.pty.write(text);
    r.pty.write("\r");
    r.session.lastActivityAt = formatDate();
    r.session.updatedAt = r.session.lastActivityAt!;
    this.opts.onSessionsChanged();
  }

  close(sessionId: string): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    try { r.pty.kill(); } catch { /* ignore */ }
    if (r.flushTimer) clearTimeout(r.flushTimer);
    r.session.status = "ended";
    r.session.updatedAt = formatDate();
    this.records.delete(sessionId);
    this.opts.onSessionsChanged();
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const r = this.records.get(sessionId);
    if (!r) return;
    try { r.pty.resize(cols, rows); } catch { /* ignore */ }
  }

  /** Buffer raw PTY bytes for ~60ms, then emit a single `.raw`
   *  SessionEvent. Aggressive flushing avoids per-character envelope
   *  spam during fast TUI repaints. */
  private bufferRaw(record: SessionRecord, chunk: string): void {
    if (record.bufferedRaw) {
      record.bufferedRaw.text += chunk;
    } else {
      record.bufferedRaw = { text: chunk, firstAt: new Date() };
    }
    if (record.flushTimer) return;
    record.flushTimer = setTimeout(() => this.flushRaw(record), FLUSH_MS);
    // Sniff once per session for the Claude "Not logged in" banner. The
    // raw chunk is a great place to do this — claude prints the banner
    // straight to stdout on first run when no creds are stored, and the
    // iPhone otherwise just sees an empty TUI with no actionable
    // explanation. Emitting a structured `warning` SessionEvent makes the
    // iOS feed render an actual error card instead of leaving the user
    // staring at a hung session.
    if (!record.claudeNotLoggedInSurfaced) {
      const text = (record.bufferedRaw?.text ?? "") + chunk;
      if (/not logged in|please run \/login/i.test(text)) {
        record.claudeNotLoggedInSurfaced = true;
        this.appendSyntheticWarning(record,
          "Claude is not logged in on this Linux box",
          "SSH in and run `sudo -u dnpremote -H claude /login` once. Tokens are stored per system user, so a fresh user has to authenticate before sessions will respond.");
      }
    }
  }

  private flushRaw(record: SessionRecord): void {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer);
      record.flushTimer = null;
    }
    const buf = record.bufferedRaw;
    if (!buf) return;
    record.bufferedRaw = null;
    record.sequence += 1;
    const eventId = newUUID();
    const event: SessionEvent = {
      id: eventId,
      sessionId: record.session.id,
      type: "raw",
      severity: "info",
      title: "raw",
      createdAt: formatDate(buf.firstAt),
      sequence: record.sequence,
      payload: { kind: "raw", value: { bytes: buf.text } },
    };
    pushFeed(record, event);
    record.session.lastActivityAt = event.createdAt;
    record.session.updatedAt = event.createdAt;
    this.opts.onLiveEvent(event);
  }

  private appendSyntheticEvent(
    record: SessionRecord,
    type: SessionEvent["type"],
    title: string,
  ): void {
    record.sequence += 1;
    const ev: SessionEvent = {
      id: newUUID(),
      sessionId: record.session.id,
      type,
      severity: "info",
      title,
      createdAt: formatDate(),
      sequence: record.sequence,
    };
    pushFeed(record, ev);
    this.opts.onLiveEvent(ev);
  }

  /** Emit a `warning`-severity event with a `message`-shaped payload —
   *  what the iOS feed renders as a yellow card with title + body. The
   *  raw event type stays `"warning"` so the Mac normaliser path on
   *  iPhone treats it identically whether the warning came from the
   *  Mac or this Linux daemon. */
  private appendSyntheticWarning(
    record: SessionRecord,
    title: string,
    body: string,
  ): void {
    record.sequence += 1;
    const ev: SessionEvent = {
      id: newUUID(),
      sessionId: record.session.id,
      type: "warning",
      severity: "warning",
      title,
      createdAt: formatDate(),
      sequence: record.sequence,
      payload: { kind: "message", value: { text: body } },
    };
    pushFeed(record, ev);
    this.opts.onLiveEvent(ev);
  }

  shutdownAll(): void {
    for (const id of [...this.records.keys()]) this.close(id);
  }
}

function pushFeed(record: SessionRecord, event: SessionEvent): void {
  record.feed.push(event);
  if (record.feed.length > FEED_RING) record.feed.shift();
}

function makeTitle(existingCount: number): string {
  const host = os.hostname() || "linux";
  return `${host} · session ${existingCount + 1}`;
}

function parseCommand(s: string): string[] {
  // Naive split — good enough for `claude` / `bash -l` / `zsh -i`.
  // For full shell-style quoting users can wrap their command in a
  // helper script.
  return s.trim().split(/\s+/);
}

function maybeUnused(_: SessionStatus) { /* keep enum import alive */ }
