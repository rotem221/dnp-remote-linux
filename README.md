<h1 align="center">DNP Remote · Linux</h1>

<p align="center">
  Linux daemon + local web UI that pairs with the
  <a href="https://github.com/rotem221/DNPRemoteIDE"><strong>DNP Remote IDE</strong></a>
  iPhone companion. Drive Claude Code (or any PTY shell) on a Linux box
  straight from your phone — same signed envelopes the Mac IDE uses,
  same iPhone app, no extra account required.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dnp-remote-linux"><img alt="npm" src="https://img.shields.io/npm/v/dnp-remote-linux"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/rotem221/dnp-remote-linux"></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A520-black">
</p>

---

## Install + run (30 seconds)

```sh
# Global install
npm install -g dnp-remote-linux

# Start the daemon — opens the pairing UI in your browser
dnp-remote
```

That's it. The terminal prints a banner with the bridge endpoint
(`tcp://<lan-ip>:18733`) and the local UI URL (`http://localhost:17834`).
On the iPhone, open the **DNP Remote IDE** app, tap *Scan QR*, point
at the QR code in the browser — paired.

> Heads-up: `node-pty` builds against your Node ABI on first install,
> so the box needs `python3` + `make` + a C++ compiler available
> (already there on every mainstream distro: `apt install build-essential`,
> `dnf groupinstall "Development Tools"`, etc.).

## What you get

- ✅ **Real PTY sessions** — `node-pty` (forkpty) gives you a true tty.
  Vim, fzf, htop, and Claude Code's full TUI all render correctly on
  the iPhone, complete with raw-mode keystrokes routed through the
  bridge.
- ✅ **Pair from QR** — same handshake the Mac uses. Token rotates on
  every restart; the daemon stores the iPhone's Ed25519 public key in
  `~/.config/dnp-remote/identity.json` so reconnects don't need the QR
  again.
- ✅ **Signed envelopes** — every WebSocket frame carries a 64-byte
  Ed25519 signature over canonical JSON, plus a 16-byte nonce + ISO
  timestamp for replay protection. A network attacker on your LAN
  can't impersonate the iPhone.
- ✅ **Headless friendly** — pass `--no-open` to suppress the browser
  launch when the box has no display server (servers, SSH sessions).
  Visit the UI from your laptop on the same LAN, pair from there.
- ✅ **Same iPhone app, multiple targets** — once the iPhone is paired
  with this Linux box, it shows up alongside any Mac you've paired
  earlier. Switch between hosts from the iPhone's device list.

## Common flags

```sh
dnp-remote --shell "claude --model claude-opus-4-7"  # default command per session
dnp-remote --cwd /home/me/projects/myapp             # default working directory
dnp-remote --bridge-port 18733 --ui-port 17834       # ports (defaults shown)
dnp-remote --host my-server.tail-something.ts.net    # override LAN host (for Tailscale)
dnp-remote --no-open                                 # don't auto-open browser
dnp-remote --help
```

The bridge port defaults to `18733` — the same port the Mac IDE
listens on — so the iPhone doesn't need any per-host configuration.

## How it works

```
┌────────────────────────────────────────────────┐
│  Linux box                                      │
│                                                 │
│   $ dnp-remote                                  │
│        │  spawns                                │
│        ▼                                        │
│   ┌──────────────────────────────────────┐     │
│   │ Node 20 daemon                       │     │
│   │  • node-pty (claude / bash / ...)    │     │
│   │  • WebSocket bridge (port 18733)     │  ◄──┼─── iPhone over LAN / Tailscale
│   │  • HTTP UI server (localhost:17834)  │     │     (signed envelopes,
│   │  • Ed25519 envelope signing          │     │      length-prefixed JSON)
│   └──────────────────────────────────────┘     │
│        │  serves                                │
│        ▼                                        │
│   http://localhost:17834 → pair QR + status    │
└────────────────────────────────────────────────┘
```

**Wire compatibility**: identical to the Mac IDE's bridge protocol —
`BridgeEnvelope<P>` with sorted-keys canonical JSON, length-prefixed
frames over WebSocket. The same iPhone build talks to either daemon
with no flag, just by which paired device the user picks.

## Configuration files

The daemon writes a single file:

```
~/.config/dnp-remote/identity.json   # chmod 600 — Ed25519 secret + paired peers
```

Delete that file to revoke every paired iPhone in one shot. The next
`dnp-remote` start will mint a fresh keypair + token and you can
re-pair from scratch.

## Building from source

```sh
git clone https://github.com/rotem221/dnp-remote-linux.git
cd dnp-remote-linux
npm install
npm run build      # tsc → dist/
node bin/dnp-remote.cjs
```

Watch mode:

```sh
npm run watch      # in one terminal
node bin/dnp-remote.cjs   # in another, restart on each rebuild
```

## Roadmap

- [ ] **Phase 2** — semantic event extraction: parse Claude Code's TUI
      output into the same `command` / `codeEdit` / `toolActivity`
      / `approval` events the Mac normaliser emits, so the iPhone
      shows feature-parity cards instead of a plain raw-tty stream.
- [ ] **File explorer** — directory listings, file content read +
      write, search. Same bridge messages the Mac speaks
      (`directoryListingRequest`, etc.).
- [ ] **Permissions UI** — fine-grained allow/deny rules persisted
      under `~/.config/dnp-remote/permissions.json`, plus a UI
      surface in the local dashboard.
- [ ] **systemd unit** — first-class `dnp-remote.service` so the
      daemon launches on boot for headless servers.
- [ ] **`brew install` formula** — for macOS Linux-via-VM users
      who want the same CLI surface.

PRs welcome. Open one against `main` with a green CI run.

## License

[MIT](LICENSE) — © 2026 Rotem Dadon.
