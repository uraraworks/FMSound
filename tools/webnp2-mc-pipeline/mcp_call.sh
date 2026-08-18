#!/usr/bin/env bash
# WebNP2 MCP bridge をJSON-RPC/HTTP経由で叩くための薄いヘルパー。
# 前提: mcp_http_bridge.mjs が起動していて、http://127.0.0.1:8765 で待ち受けていること。
#
# 使い方:
#   ./mcp_call.sh '{"name":"screen_text","arguments":{}}'
#   ./mcp_call.sh '{"name":"type_text","arguments":{"text":"dir\r\n"}}'
set -euo pipefail
BRIDGE_HTTP_PORT="${BRIDGE_HTTP_PORT:-8765}"
curl -s -X POST "http://127.0.0.1:${BRIDGE_HTTP_PORT}/call" \
  -H 'Content-Type: application/json' \
  --data "$1"
