#!/usr/bin/env bash
# Launches the published standard-x402 Subly MCP server with the configured
# relayer env. The detached env fallback is only for local legacy dev.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_ENV="${NODE_ENV:-development}"
if [ -f demo/env/buyer.mainnet.env ]; then
  source demo/env/buyer.mainnet.env
else
  source demo/env/buyer.detached.env
fi
exec npx -y @subly_fi/pay mcp
