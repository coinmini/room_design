#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/Users/bolin/Documents/AI/room_design"

if [[ "${CONDA_DEFAULT_ENV:-}" != "llf_v1" ]]; then
  echo "请先运行：conda activate llf_v1"
  exit 1
fi

cd "$PROJECT_ROOT/apps/api"
python -m ruff check .
python -m pytest

cd "$PROJECT_ROOT/apps/web"
npm run lint
npm run build
