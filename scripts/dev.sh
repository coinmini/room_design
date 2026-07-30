#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="/Users/bolin/Documents/AI/room_design"

if [[ "${CONDA_DEFAULT_ENV:-}" != "llf_v1" ]]; then
  echo "请先运行：conda activate llf_v1"
  exit 1
fi

cleanup() {
  jobs -pr | while read -r job_pid; do
    kill "$job_pid"
  done
}
trap cleanup EXIT INT TERM

(
  cd "$PROJECT_ROOT/apps/api"
  uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
) &

(
  cd "$PROJECT_ROOT/apps/web"
  npm run dev -- --host 127.0.0.1
) &

echo "Web:      http://127.0.0.1:5173"
echo "API Docs: http://127.0.0.1:8000/docs"
echo "按 Ctrl+C 停止全部服务"

wait
