#!/bin/bash
# setup-daemon.sh
# Automates the setup of the Antigravity Quota Dashboard as a macOS background service.
#
# Usage:
#   bash setup-daemon.sh              # Interactive — prompts before modifying ~/.zshrc
#   bash setup-daemon.sh --yes        # Non-interactive — accepts all prompts automatically
#   bash setup-daemon.sh --no-alias   # Skip the shell alias entirely

set -e

# ── Parse flags ──────────────────────────────────────────────────────────────────
OPT_YES=false
OPT_NO_ALIAS=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)       OPT_YES=true ;;
    --no-alias)     OPT_NO_ALIAS=true ;;
    --help|-h)
      echo "Usage: bash setup-daemon.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --yes, -y       Accept all prompts non-interactively"
      echo "  --no-alias      Skip adding the 'quota' shell alias to ~/.zshrc"
      echo "  --help, -h      Show this help message"
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

echo "=== Multigravity Elysium Daemon Setup ==="

# ── Resolve the repo root (the directory this script lives in) ────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR"

# ── Find Node.js ──────────────────────────────────────────────────────────────
# If you use nvm, activate it first: `nvm use` then run this script.
# The script attempts to locate node via nvm, then falls back to whatever is
# in PATH (Homebrew, system node, etc.).
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm use 2>/dev/null || true
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node not found. Install Node.js 22+ and ensure it is in PATH, then re-run."
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "Using node: $NODE_BIN  ($(node --version))"

# ── Target directory (home folder — not protected by macOS TCC) ───────────────
TARGET_DIR="$HOME/.multigravity-elysium"
echo "Creating target directory: $TARGET_DIR"
mkdir -p "$TARGET_DIR"

# ── Sync files (excluding build artifacts and local databases) ────────────────
echo "Copying source files to home directory..."
rsync -av \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='*.db' \
  --exclude='*.db-journal' \
  --exclude='scratch' \
  --exclude='.git' \
  "$SRC_DIR/" "$TARGET_DIR/"

# ── Copy/Preserve populated database ──────────────────────────────────────────
# Check if the database in TARGET_DIR already exists and is non-empty.
# If it is already populated, we do NOT overwrite it unless the source DB has data too.
SRC_DB="$SRC_DIR/prisma/dev.db"
NEW_DB="$TARGET_DIR/prisma/dev.db"
OLD_DB="$HOME/.antigravity-dashboard/prisma/dev.db"

SRC_SIZE=$(wc -c < "$SRC_DB" 2>/dev/null || echo 0)
NEW_SIZE=$(wc -c < "$NEW_DB" 2>/dev/null || echo 0)
OLD_SIZE=$(wc -c < "$OLD_DB" 2>/dev/null || echo 0)

mkdir -p "$TARGET_DIR/prisma"

if [ "$NEW_SIZE" -gt 0 ]; then
  echo "Target database already exists and is populated ($NEW_SIZE bytes). Keeping it."
  # Ensure the source directory has it too, so local dev matches
  if [ "$SRC_SIZE" -eq 0 ]; then
    echo "Syncing target database back to source directory..."
    cp "$NEW_DB" "$SRC_DB"
  fi
elif [ "$OLD_SIZE" -gt 0 ]; then
  echo "Found populated database in old daemon path ($OLD_SIZE bytes). Migrating it..."
  cp "$OLD_DB" "$NEW_DB"
  cp "$OLD_DB" "$SRC_DB"
elif [ "$SRC_SIZE" -gt 0 ]; then
  echo "Copying existing database from source directory ($SRC_SIZE bytes)..."
  cp "$SRC_DB" "$NEW_DB"
fi

# ── Install dependencies and build the production bundle ─────────────────────
echo "Navigating to $TARGET_DIR..."
cd "$TARGET_DIR"

export PATH="$NODE_DIR:$PATH"

echo "Installing npm dependencies..."
npm install

echo "Generating Prisma Client..."
npx prisma generate

echo "Deploying database migrations..."
npx prisma migrate deploy


echo "Building Next.js production build..."
npm run build

# ── Create start script inside target directory ───────────────────────────────
echo "Creating daemon start script..."
cat << EOF > "$TARGET_DIR/start.sh"
#!/bin/bash
# Resolve node from PATH at daemon start time
export PATH="$NODE_DIR:\$PATH"
cd "\$HOME/.multigravity-elysium"
exec node node_modules/next/dist/bin/next start -p 39281
EOF
chmod +x "$TARGET_DIR/start.sh"


# ── Write Launch Agent plist ──────────────────────────────────────────────────
PLIST_PATH="$HOME/Library/LaunchAgents/com.multigravity.elysium.plist"
echo "Writing Launch Agent configuration to $PLIST_PATH..."

cat << EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.multigravity.elysium</string>
    <key>ProgramArguments</key>
    <array>
        <string>$TARGET_DIR/start.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>$TARGET_DIR</string>
    <key>StandardOutPath</key>
    <string>$TARGET_DIR/daemon-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$TARGET_DIR/daemon-stderr.log</string>
</dict>
</plist>
EOF

# ── Unload old quota-dashboard Launch Agent if it exists ──────────────────────
OLD_PLIST="$HOME/Library/LaunchAgents/com.antigravity.quota-dashboard.plist"
if [ -f "$OLD_PLIST" ]; then
  echo "Unloading old quota-dashboard Launch Agent..."
  launchctl unload "$OLD_PLIST" 2>/dev/null || true
  # Rename to prevent auto-restart on boot
  mv "$OLD_PLIST" "${OLD_PLIST}.disabled" 2>/dev/null || true
fi

# ── Clean up existing processes on port 39281 to prevent port conflicts ───────
if lsof -t -i :39281 >/dev/null 2>&1; then
  echo "Port 39281 is in use. Terminating existing process(es)..."
  PIDS=$(lsof -t -i :39281)
  kill $PIDS 2>/dev/null || true
  sleep 1
  kill -9 $PIDS 2>/dev/null || true
fi

# ── Load the Launch Agent ─────────────────────────────────────────────────────
echo "Unloading any existing agent instances..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true

echo "Loading and starting the background service..."
launchctl load "$PLIST_PATH"

# ── Copy open-dashboard.sh to target directory ──────────────────────────────
if [ -f "$SRC_DIR/open-dashboard.sh" ]; then
  cp "$SRC_DIR/open-dashboard.sh" "$TARGET_DIR/open-dashboard.sh"
  chmod +x "$TARGET_DIR/open-dashboard.sh"
fi

# ── Shell alias ──────────────────────────────────────────────────────────────────
ALIAS_CMD="alias quota='bash $TARGET_DIR/open-dashboard.sh'"
ZSHRC="$HOME/.zshrc"
ALIAS_ADDED=false

if [ "$OPT_NO_ALIAS" = "true" ]; then
  # User explicitly opted out
  ADD_ALIAS=false
elif grep -qF "open-dashboard.sh" "$ZSHRC" 2>/dev/null; then
  # Already present — nothing to do
  ADD_ALIAS=false
  ALIAS_ADDED=already
elif [ "$OPT_YES" = "true" ]; then
  # Non-interactive mode: auto-accept
  ADD_ALIAS=true
else
  # Interactive prompt (default Y)
  echo ""
  printf "Add 'quota' shortcut to ~/.zshrc so you can open the dashboard with a single command? [Y/n] "
  read -r REPLY
  case "${REPLY:-Y}" in
    [Yy]*|"" ) ADD_ALIAS=true ;;
    *         ) ADD_ALIAS=false ;;
  esac
fi

if [ "$ADD_ALIAS" = "true" ]; then
  printf '\n# Multigravity Elysium — open the Quota Dashboard\n%s\n' "$ALIAS_CMD" >> "$ZSHRC"
  ALIAS_ADDED=true
fi


echo ""
echo "=== Daemon Setup Completed Successfully! ==="
echo "The dashboard is now running in the background."
echo "URL: http://localhost:39281"
echo ""
echo "Logs:"
echo "  stdout: tail -f $TARGET_DIR/daemon-stdout.log"
echo "  stderr: tail -f $TARGET_DIR/daemon-stderr.log"
echo ""
echo "The service will start automatically on login/reboot."
echo ""
echo "── Quick launch ───────────────────────────────────────────────────────"
if [ "$ALIAS_ADDED" = "true" ]; then
  echo "  ✓ 'quota' alias added to ~/.zshrc"
  echo "    Activate it now:  source ~/.zshrc"
  echo "    Then just run:    quota"
elif [ "$ALIAS_ADDED" = "already" ]; then
  echo "  ✓ 'quota' alias already in ~/.zshrc"
  echo "    Open the dashboard anytime with: quota"
else
  echo "  ○ 'quota' alias was not added."
  echo "    To add it manually, run:"
  echo "      echo \"# Multigravity Elysium\" >> ~/.zshrc"
  echo "      echo \"$ALIAS_CMD\" >> ~/.zshrc"
  echo "      source ~/.zshrc"
  echo "    Or open the dashboard directly:"
  echo "      bash $TARGET_DIR/open-dashboard.sh"
fi
echo "───────────────────────────────────────────────────────────────────"
