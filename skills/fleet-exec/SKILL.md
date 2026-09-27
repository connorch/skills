---
name: fleet-exec
description: Run commands on another of the user's machines (the macOS and linux machines on their tailnet) over Tailscale SSH. Use when the user asks to check, run, or change something on a different machine, such as "make sure main is pulled on my MacBook Pro" or "how much disk is free on the Studio".
metadata:
  requires: "tailscale on PATH"
---

# Fleet exec

The user's macOS and linux machines are on a tailnet and accept Tailscale SSH.
Reach them with `tailscale ssh`, not plain `ssh`.

- **Find the machine.** `tailscale status` lists each machine's name
  (`connors-mac-studio`, `connors-macbook-pro`) and whether it is offline. Map
  the user's words onto a name, and ask if more than one fits. If the target is
  the machine you are on, run commands locally. An offline machine is probably
  asleep; tell the user rather than retrying.
- **Run commands** with `tailscale ssh <name> '<script>'`. The script runs in
  the remote login shell (zsh on macOS, bash on linux) from `$HOME`, with the
  user's usual `PATH`. Pass multi-line scripts as one single-quoted argument.
- **Exit codes lie.** Tailscale SSH on macOS reports 0 even when the command
  fails. End scripts with `; echo "exit=$?"` and judge success from the output,
  never from the ssh exit code.
- **No TTY, and the macOS keychain is locked.** Anything that prompts fails, so
  use `sudo -n` or give the user the command to run. HTTPS git to private repos
  and `gh` fail with credential errors (`could not read Username`, `token is
  invalid`). Report that; do not copy tokens between machines or unlock the
  keychain.
- **Paths differ between machines.** Find a repo by its `origin` URL
  (`git -C <dir> remote get-url origin`), not by path. When the user names no
  repo, they mean the one you are working in. Act on the primary clone, not an
  agent worktree (where `.git` is a file), and leave the Ship's Managed Clone
  under `~/.local/share/` alone.
- **Never lose work over the wire.** "Pull main" means fast-forward only:
  `git merge --ff-only origin/main` when `main` is checked out, otherwise
  `git fetch origin main:main`. If git refuses, report why and ask. Do not
  stash, reset, or switch branches, and ask before anything else destructive.
