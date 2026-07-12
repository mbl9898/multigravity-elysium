#!/bin/bash
# open-dashboard.sh
# Opens the Multigravity Elysium Quota Dashboard in your default browser.
# If the daemon is not running, attempts to start it via launchctl first.
#
# Usage:
#   bash open-dashboard.sh
#   # or, after setup-daemon.sh has added the alias:
#   quota

set -euo pipefail

PORT=39281
URL="http://localhost:${PORT}"
DAEMON_LABEL="com.multigravity.elysium"

# ── Check if the daemon is responding ────────────────────────────────────────
if curl -sf --max-time 2 "${URL}" > /dev/null 2>&1; then
  echo "✓ Dashboard is running — opening ${URL}"
  open "${URL}"
  exit 0
fi

# ── Daemon not responding — try to start it ──────────────────────────────────
echo "⚠  Dashboard is not running. Attempting to start the daemon..."

if launchctl list | grep -q "${DAEMON_LABEL}"; then
  # Service is registered — kick it
  launchctl start "${DAEMON_LABEL}" 2>/dev/null || true
else
  echo "   Daemon not registered. Run 'bash setup-daemon.sh' first."
  exit 1
fi

# ── Wait up to 8 seconds for it to come up ───────────────────────────────────
echo "   Waiting for daemon to start..."
for i in $(seq 1 8); do
  sleep 1
  if curl -sf --max-time 1 "${URL}" > /dev/null 2>&1; then
    echo "✓ Dashboard is up — opening ${URL}"
    open "${URL}"
    exit 0
  fi
  printf "   [%d/8]\r" "$i"
done

echo ""
echo "✗ Daemon did not respond within 8 seconds."
echo "  Check logs: tail -f ~/.multigravity-elysium/daemon-stderr.log"
echo "  Or run:     bash setup-daemon.sh"
exit 1
