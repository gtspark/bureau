#!/bin/bash
# Bureau - Quick Start Script
# Run this to try Bureau without installing systemd services

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required but not installed."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "Error: pnpm is required. Install with: npm install -g pnpm"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: Claude Code CLI is required. Install with: npm install -g @anthropic-ai/claude-code"; exit 1; }

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# Build if needed
if [ ! -d "packages/server/dist" ] || [ ! -d "packages/web/dist" ]; then
  echo "Building..."
  pnpm build
fi

# Set default project root to current directory
export PROJECT_ROOT="${PROJECT_ROOT:-$SCRIPT_DIR}"

echo ""
echo "Starting Bureau..."
echo "  Web UI: http://localhost:5175"
echo "  API:    http://localhost:3006"
echo "  Project: $PROJECT_ROOT"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Run both servers (server in background, web in foreground)
cleanup() {
  echo ""
  echo "Shutting down..."
  kill $SERVER_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start server
cd packages/server
node dist/index.js &
SERVER_PID=$!
cd ../..

# Give server a moment to start
sleep 1

# Start web (foreground)
cd packages/web
pnpm preview --port 5175 --host
