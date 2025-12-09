#!/bin/bash

# Development installation script for dev-browser plugin
# This script removes any existing installation and reinstalls from the current directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE_NAME="dev-browser-marketplace"
PLUGIN_NAME="dev-browser"

echo "Dev Browser - Development Installation"
echo "======================================="
echo ""

# Step 1: Remove existing plugin if installed
echo "Checking for existing plugin installation..."
if claude plugin uninstall "${PLUGIN_NAME}@${MARKETPLACE_NAME}" 2>/dev/null; then
    echo "  Removed existing plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
else
    echo "  No existing plugin found (skipping)"
fi

# Also try to remove from the GitHub marketplace if it exists
if claude plugin uninstall "${PLUGIN_NAME}@sawyerhood/dev-browser" 2>/dev/null; then
    echo "  Removed plugin from GitHub marketplace: ${PLUGIN_NAME}@sawyerhood/dev-browser"
else
    echo "  No GitHub marketplace plugin found (skipping)"
fi

echo ""

# Step 2: Remove existing marketplaces
echo "Checking for existing marketplace..."
if claude plugin marketplace remove "${MARKETPLACE_NAME}" 2>/dev/null; then
    echo "  Removed marketplace: ${MARKETPLACE_NAME}"
else
    echo "  Local marketplace not found (skipping)"
fi

if claude plugin marketplace remove "sawyerhood/dev-browser" 2>/dev/null; then
    echo "  Removed GitHub marketplace: sawyerhood/dev-browser"
else
    echo "  GitHub marketplace not found (skipping)"
fi

echo ""

# Step 3: Add the local marketplace
echo "Adding local marketplace from: ${SCRIPT_DIR}"
claude plugin marketplace add "${SCRIPT_DIR}"
echo "  Added marketplace: ${MARKETPLACE_NAME}"

echo ""

# Step 4: Install the plugin
echo "Installing plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}"
claude plugin install "${PLUGIN_NAME}@${MARKETPLACE_NAME}"
echo "  Installed plugin successfully"

echo ""
echo "======================================="
echo "Installation complete!"
echo ""
echo "Restart Claude Code to activate the plugin."
