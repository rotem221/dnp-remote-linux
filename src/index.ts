// Public entry point — re-exports the few symbols downstream callers
// (e.g., a future `dnp-remote-cli` wrapper or a web-hosted variant)
// might want to embed without going through the CLI.

export { main } from "./cli.js";
export { startDaemon, DaemonOptions, DaemonHandle } from "./daemon.js";
export type {
  BridgeEnvelope,
  BridgeMessageType,
  HelloPayload,
  PairingRequestPayload,
  PairingResponsePayload,
  Session,
  SessionEvent,
  SessionStatus,
} from "./protocol.js";
