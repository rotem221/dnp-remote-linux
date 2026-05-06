// CLI entry point. `bin/dnp-remote.cjs` calls into `main(argv)` here.
// Defaults are tuned so a fresh `npm install -g dnp-remote-linux` user
// can just run `dnp-remote` and immediately pair their iPhone.

import { Command } from "commander";
import { startDaemon, DaemonHandle } from "./daemon.js";

// `open` is an ESM-only package and we compile to CommonJS, so we
// can't use a top-level static import. Dynamic import works in both
// module systems and only loads the package when the user actually
// asked for the browser to open.
const openInBrowser = (url: string) =>
  import("open").then((m) => m.default(url));

export async function main(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("dnp-remote")
    .description(
      "DNP Remote — Linux daemon. Pair your iPhone with this box and " +
      "drive Claude Code (or any PTY-driven shell) from the iOS " +
      "companion app.",
    )
    .version("0.1.0");

  program
    .command("start", { isDefault: true })
    .description("Start the daemon (default).")
    .option("--bridge-port <port>", "WebSocket bridge port iPhones connect to.", "18733")
    .option("--ui-port <port>", "Local web UI port.", "17834")
    .option("--shell <command>", "Command to launch in each new session.", "claude")
    .option("--cwd <path>", "Working directory for new sessions.", process.cwd())
    .option("--host <host>", "Override the LAN host the iPhone reaches.", "")
    .option("--no-open", "Don't auto-open the browser.")
    .action(async (opts: {
      bridgePort: string;
      uiPort: string;
      shell: string;
      cwd: string;
      host: string;
      open: boolean;
    }) => {
      const handle = await startDaemon({
        bridgePort: Number.parseInt(opts.bridgePort, 10),
        uiPort: Number.parseInt(opts.uiPort, 10),
        defaultCommand: opts.shell,
        projectRoot: opts.cwd,
        externalHost: opts.host || undefined,
      });

      printBanner(handle);

      if (opts.open !== false) {
        try { await openInBrowser(handle.uiURL); } catch { /* headless box, ignore */ }
      }

      const shutdown = async (signal: string) => {
        process.stdout.write(`\nReceived ${signal} — shutting down…\n`);
        await handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));
    });

  await program.parseAsync(argv, { from: "user" });
}

function printBanner(handle: DaemonHandle): void {
  const peers = handle.identity.trustedPeers.length;
  const lines = [
    "",
    "  ┌─────────────────────────────────────────────────────┐",
    "  │  DNP Remote · Linux daemon                           │",
    "  └─────────────────────────────────────────────────────┘",
    "",
    `  Device:        ${handle.identity.deviceName}`,
    `  Identity:      ${handle.identityPath}`,
    `  Paired peers:  ${peers}`,
    "",
    `  Bridge:        ${handle.bridgeEndpoint}`,
    `  Pairing UI:    ${handle.uiURL}`,
    "",
    "  Open the UI in a browser, scan the QR with the DNP Remote IDE",
    "  iPhone app, and you're paired. Press Ctrl-C here to stop.",
    "",
  ];
  process.stdout.write(lines.join("\n"));
}
