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
    const env = { ...process.env, TERM: "xterm-256color" };
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
