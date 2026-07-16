#!/bin/bash
set -euo pipefail

REPO="eli0shin/tickets"
INSTALL_DIR="${HOME}/.local/bin"
BINARY_NAME="tickets"

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin) OS="darwin" ;;
  linux) OS="linux" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

ARTIFACT="tickets-${OS}-${ARCH}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ARTIFACT}"

mkdir -p "$INSTALL_DIR"
TEMP_FILE="$(mktemp "${INSTALL_DIR}/.${BINARY_NAME}.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT
curl -fsSL "$DOWNLOAD_URL" -o "$TEMP_FILE"
chmod +x "$TEMP_FILE"
mv -f "$TEMP_FILE" "${INSTALL_DIR}/${BINARY_NAME}"
trap - EXIT

echo "Installed ${BINARY_NAME} to ${INSTALL_DIR}/${BINARY_NAME}"

if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
  echo ""
  echo "Add this to your shell profile to use tickets:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
