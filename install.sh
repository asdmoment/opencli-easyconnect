#!/usr/bin/env bash
# install.sh — install opencli-easyconnect adapter
# Copies adapter files to ~/.opencli/clis/easyconnect/ and installs Playwright.

set -euo pipefail

DEST="$HOME/.opencli/clis/easyconnect"
CONFIG_DIR="$HOME/.config/easyconnect"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing opencli-easyconnect to $DEST"
mkdir -p "$DEST"

# Copy adapter files
for f in browser.js config.js doctor.js login.js logs.js status.js stop.js utils.js package.json; do
  cp "$SCRIPT_DIR/$f" "$DEST/$f"
done

# Install Playwright into the adapter directory
echo "Installing Playwright..."
(cd "$DEST" && npm install --silent)
npx --prefix "$DEST" playwright install chromium --with-deps 2>/dev/null || \
  node "$DEST/node_modules/.bin/playwright" install chromium 2>/dev/null || \
  echo "  Note: run 'npx playwright install chromium' in $DEST if browser automation fails."

# Create config directory and example if not present
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/config.toml" ]; then
  cp "$SCRIPT_DIR/config.example.toml" "$CONFIG_DIR/config.toml"
  echo ""
  echo "Config created at $CONFIG_DIR/config.toml"
  echo "Edit it and set your VPN URL and username before running 'opencli easyconnect login'."
else
  echo "Config already exists at $CONFIG_DIR/config.toml — skipped."
fi

echo ""
echo "Done. Try: opencli easyconnect doctor"
