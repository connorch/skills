---
name: mac-vm
description: Use when a task needs a GUI app on a Mac whose desktop is locked, or when the user asks to start, stop, or set up the agent macOS VM. Boots an on-demand Tart VM with its own always-unlocked desktop, then shuts it down.
metadata:
  machines: [connors-mac-studio]
  requires: "tart and the mac-vm CLI on PATH"
---

# Mac VM

macOS blocks screen capture and input while the Mac is locked. The agent VM is
a separate macOS guest with auto-login, so its desktop is usable no matter
what the host is doing. It is **off by default**: boot it for a task, shut it
down after.

```sh
mac-vm status                 # stopped | running at <ip>, guest agent, VNC, tunnels
mac-vm up                     # boot headless, wait for the guest; safe to re-run
mac-vm up --forward 18789     # also reverse-tunnel host 127.0.0.1:18789 into the guest
mac-vm down                   # close tunnels, shut down (forced after 60s)
mac-vm shot [out.png]         # the guest screen as a PNG (default /tmp/mac-vm.png)
mac-vm click <x> <y>          # at the PNG's pixel coordinates; --double, --right
mac-vm type "<text>"          # type into whatever has focus
mac-vm key cmd+shift+a        # enter, tab, escape, backspace, arrows, f1-f12, cmd/alt/ctrl/shift
```

The VM is `agent-vm` unless `--vm` or `MAC_VM` says otherwise.

## Rules

- **Always `mac-vm down` when the task ends**, including when it failed. Check
  `mac-vm status` at the start of a task; if the VM is already running and you
  did not start it, leave it running and do not shut it down.
- **Only apps the user approved** belong in the guest. Never put personal data
  or credentials into it yourself; the user signs in to accounts there. The one
  exception is the OpenClaw Gateway token below, and only after the user has
  approved provisioning it.
- `up` blocks until the guest has logged in (up to 4 minutes on a cold boot).

## Working inside the guest

Run commands through Tart's guest agent, no SSH needed:

```sh
tart exec agent-vm open -a "Some App"
tart exec agent-vm sh -c 'ls ~/Downloads'
tart exec -i agent-vm sh -c 'cat > ~/Downloads/file.3mf' < file.3mf   # copy a file in
```

`tart exec` runs as the guest's `admin` user (passwordless `sudo -n` works).

### Driving the screen

`shot`, `click`, `type`, and `key` go through Tart's VNC server, so they work
from any agent with a shell and need nothing inside the guest. Take a `shot`
and look at it before the first click, and again after anything that changes
the screen; click coordinates are pixels of that PNG (the guest is Retina, so
a 1024x768 desktop is a 2048x1536 image). Each command opens its own
connection and paces itself; run them one at a time, not in parallel.

### With OpenClaw (optional)

An OpenClaw agent can also use its own computer tool: the guest runs the
OpenClaw Mac app as a node named **Agent VM**, reaching a loopback-only Gateway
through `mac-vm up --forward <gateway port>`, and reconnects on its own after
boot (a LaunchAgent opens the app at login). To set it up in a new guest, copy
`/Applications/OpenClaw.app` in, get the user's go-ahead to put the Gateway
token in the guest, then pipe it (never echo it) into
`openclaw-mac primary set --direct-url ws://127.0.0.1:<port> --token-stdin`
through `tart exec -i`, and have the user approve the pairing request.

## Setup (one-time, per machine)

```sh
brew install openai/tools/tart     # may first need: brew trust --formula openai/tools/softnet
mac-vm init                        # clones ghcr.io/cirruslabs/macos-tahoe-base (~25 GB), 4 CPU / 8 GB, SSH key
```

Copy apps in from the host rather than downloading them in the guest:
`tar -C /Applications -cf - Some.app | tart exec -i agent-vm sudo -n tar -C /Applications -xf -`.
Then let the user sign in to them in a visible window: `mac-vm down`, then
`tart run agent-vm` in the background. That window has no Gateway tunnel, so
the Agent VM node is offline until you `mac-vm down` and `mac-vm up` again;
sign-ins persist across the restart. Tell the user not to save passwords in the
guest's browser. The Cirrus image logs in as `admin`/`admin`. Tart's
default network is NAT and only reachable from the host, so this is no more exposed than the host itself.
Grant Accessibility and Screen Recording to whatever drives the UI in the guest.

## Troubleshooting

- `timed out ... waiting for the guest desktop login`: see `~/.local/state/mac-vm/<vm>.log`.
  Boot once with a window (`tart run agent-vm`) to see what the guest is stuck on.
- `reverse tunnel ... exited` or `... never became reachable in the guest`: the
  port is already bound in the guest, or `mac-vm init` never authorized the key.
  Re-run `mac-vm init` (it skips the clone).
- `mac-vm shot` is black: the guest is still booting; `up` waits for the login.
- `vnc: not available (booted outside mac-vm?)`: the VM was started with
  `tart run` by hand, so mac-vm has no VNC address. `mac-vm down`, then `up`.
- `VNC: the server closed the connection` and `status` says stopped: Tart's
  VNC server crashed, which it does when a new client connects while the last
  one is being torn down. mac-vm paces its own commands; do not run two at once.
- `open -a "Some App"` cannot find an app copied in: open it by path,
  `open "/Applications/Some App.app"`.
- The guest renders OpenGL in software, so GL-heavy apps (Bambu Studio's 3D
  view) crash. Prefer a lighter companion app.
- The guest sits behind NAT, so LAN discovery (SSDP, mDNS) of devices on the
  home network does not work. Use the app's cloud login or a direct IP.
