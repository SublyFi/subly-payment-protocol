#!/usr/bin/env bash
# Launches the Subly MCP server with the mainnet buyer env when present
# (falls back to the detached env). stdout is the MCP transport.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV="${NODE_ENV:-development}"
if [ -f demo/env/buyer.mainnet.env ]; then
  source demo/env/buyer.mainnet.env
else
  source demo/env/buyer.detached.env
fi
exec npx tsx demo/mcp-server.ts
