#!/bin/bash
# Bureau IDE Service Installation Script

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Installing Bureau IDE services..."

# Build the project
echo "Building project..."
cd "$PROJECT_DIR"
pnpm install
pnpm build

# Copy service files
echo "Copying service files..."
sudo cp "$SCRIPT_DIR/bureau-server.service" /etc/systemd/system/
sudo cp "$SCRIPT_DIR/bureau-web.service" /etc/systemd/system/

# Update PROJECT_ROOT in service file if needed
read -p "Enter PROJECT_ROOT path [$PROJECT_DIR]: " PROJECT_ROOT
PROJECT_ROOT=${PROJECT_ROOT:-$PROJECT_DIR}
sudo sed -i "s|Environment=PROJECT_ROOT=.*|Environment=PROJECT_ROOT=$PROJECT_ROOT|" /etc/systemd/system/bureau-server.service

# Reload systemd
echo "Reloading systemd..."
sudo systemctl daemon-reload

# Enable and start services
echo "Enabling and starting services..."
sudo systemctl enable bureau-server bureau-web
sudo systemctl start bureau-server bureau-web

echo "Done! Check status with:"
echo "  sudo systemctl status bureau-server"
echo "  sudo systemctl status bureau-web"
echo ""
echo "View logs with:"
echo "  sudo journalctl -u bureau-server -f"
echo "  sudo journalctl -u bureau-web -f"
