#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PY="${PROJECT_ROOT}/apps/api/.venv/bin/python"
ENH_PY="${PROJECT_ROOT}/apps/enhancer/.venv/bin/python"

if [[ ! -x "$API_PY" ]]; then
  echo "缺少 API venv：$API_PY"
  echo "请先：cd apps/api && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'"
  exit 1
fi

cd "$PROJECT_ROOT/apps/api"
"$API_PY" -m ruff check . || true
"$API_PY" -m pytest -q

if [[ -x "$ENH_PY" ]]; then
  cd "$PROJECT_ROOT/apps/enhancer"
  "$ENH_PY" -m ruff check app tests || true
  "$ENH_PY" -m pytest -q
else
  echo "skip enhancer tests (no .venv)"
fi

cd "$PROJECT_ROOT/apps/web"
npm run lint || true
npm test
npm run build
