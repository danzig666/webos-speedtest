#!/bin/sh
# Build the static ptyrun helper for the TV CPUs (and the host, for tests).
# Needs: rustup targets armv7-unknown-linux-musleabihf aarch64-unknown-linux-musl
#        x86_64-unknown-linux-musl (linked with rust-lld, no cross gcc needed).
set -eu
cd "$(dirname "$0")/.."
mkdir -p service/bin
for pair in armv7-unknown-linux-musleabihf:armv7 aarch64-unknown-linux-musl:aarch64 x86_64-unknown-linux-musl:x86_64; do
  target=${pair%%:*}; name=${pair##*:}
  (cd native/ptyrun && cargo build --release --locked --target "$target")
  install -m 755 "native/ptyrun/target/$target/release/ptyrun" "service/bin/ptyrun-$name"
done
ls -l service/bin
