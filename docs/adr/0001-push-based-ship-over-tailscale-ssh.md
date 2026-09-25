# Push-based Ship over Tailscale SSH

Skills and CLIs reach the Fleet through a manual, push-based Ship: `pnpm ship:fleet`
opens `tailscale ssh` to every reachable Machine and runs the same `pnpm ship:machine`
there against a Managed Clone reset to `origin/main`. We chose this over the earlier
plan, where each Mac ran a LaunchAgent that polled `origin/main` every five minutes
and published status reports to Wovn. A manual push is simpler (no daemon, lock,
report outbox, or heartbeat questions), and the person shipping sees every Machine's
result in one terminal.

## Considered Options

- **LaunchAgent pull (rejected).** Always converges without anyone running a command,
  but needs per-Machine scheduling, a report channel to learn whether it worked, and
  retry machinery for both installs and reports.
- **Remote Login (plain `sshd`) on the Macs (rejected).** macOS starts `sshd` on every
  interface and ignores `ListenAddress`, so a laptop on public wifi exposes port 22.
  Restricting it needs `pf` rules that macOS updates can reset.
- **Taildrop or a listener behind `tailscale serve` (rejected).** Both need a resident
  process on each Machine to act on what arrives, which brings back the daemon.

## Consequences

- Every Mac must run the open-source `tailscaled` (Homebrew, as a system daemon, with
  `--ssh`) instead of Tailscale.app. The App Store and Standalone app variants cannot
  be Tailscale SSH servers.
- The tailnet policy's `ssh` rule uses `accept`, not `check`, because a browser
  re-authentication prompt would stall a scripted Ship. Agent hosts such as
  `hermes-agent` are tagged so they fall outside `autogroup:member` and cannot SSH
  into the Macs.
- Tailscale SSH on macOS reports exit code 0 even when the remote command fails. A
  Ship counts a Machine as successful only when it sends back its report line, never
  by exit code.
- A Machine that is asleep or offline misses the Ship and stays behind until the next
  one. There is no background catch-up.
- Every Machine needs `git`, `node`, and `pnpm`, and network access to GitHub and npm.
