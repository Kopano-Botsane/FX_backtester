#!/bin/bash
# Fix the Chromium sandbox helper so the packaged app keeps its renderer
# sandbox when run outside a mount namespace. The archive ships the helper as
# 0755, but Chromium requires 4755 root:root or it refuses to start.
set -euo pipefail

BIN_DIR="/opt/Backtester"
if [ -x "$BIN_DIR/chrome-sandbox" ]; then
    chown root:root "$BIN_DIR/chrome-sandbox" 2>/dev/null || true
    chmod 4755 "$BIN_DIR/chrome-sandbox"
fi
