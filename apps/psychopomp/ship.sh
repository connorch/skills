#!/bin/sh
# Installs Kit Langton's psychopomp motion graphics engine
# (github.com/kitlangton/psychopomp) at ~/.local/share/psychopomp, pinned to
# REV, and builds its renderer. The motion-explainer skill renders from that
# checkout, which the skill treats as read-only. Bump REV to update.
set -eu

REV=b517dd423fd19282898c33e43acb8eb67546ebab
DIR="$HOME/.local/share/psychopomp"
PATH="$HOME/.cargo/bin:$PATH"

command -v cargo >/dev/null || { echo "psychopomp: cargo not found; install Rust from rustup.rs" >&2; exit 1; }

[ -d "$DIR/.git" ] || git clone --quiet https://github.com/kitlangton/psychopomp "$DIR"
if [ "$(git -C "$DIR" rev-parse HEAD)" != "$REV" ]; then
  git -C "$DIR" fetch --quiet origin
  git -C "$DIR" checkout --quiet --detach "$REV"
fi
cargo build --release --quiet --manifest-path "$DIR/Cargo.toml"
