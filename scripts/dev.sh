#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$PROJECT_ROOT/apps/enhancer/.env" ]]; then
  set -a
  source "$PROJECT_ROOT/apps/enhancer/.env"
  set +a
fi

if [[ "${CONDA_DEFAULT_ENV:-}" != "llf_v1" ]]; then
  echo "请先运行：conda activate llf_v1"
  exit 1
fi

cleanup() {
  jobs -pr | while read -r job_pid; do
    kill "$job_pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

if [[ "${ROOM_DESIGN_START_COMFYUI:-0}" == "1" ]]; then
  "$PROJECT_ROOT/scripts/start-comfyui.sh" &
fi

(
  cd "$PROJECT_ROOT/apps/enhancer"
  uvicorn app.main:app --reload --host 127.0.0.1 --port 8189
) &

(
  cd "$PROJECT_ROOT/apps/api"
  FLOORPLAN_AI_ENDPOINT="${FLOORPLAN_AI_ENDPOINT:-http://127.0.0.1:8189/v1/enhance}" \
    FLOORPLAN_AI_HEALTH_ENDPOINT="${FLOORPLAN_AI_HEALTH_ENDPOINT:-http://127.0.0.1:8189/health}" \
    FLOORPLAN_AI_TIMEOUT_SECONDS="${FLOORPLAN_AI_TIMEOUT_SECONDS:-900}" \
    uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
) &

(
  cd "$PROJECT_ROOT/apps/web"
  npm run dev -- --host 127.0.0.1
) &

echo "Web:      http://127.0.0.1:5173"
echo "API Docs: http://127.0.0.1:8000/docs"
echo "Enhancer: http://127.0.0.1:8189/health"
if [[ "${ROOM_DESIGN_START_COMFYUI:-0}" == "1" ]]; then
  echo "ComfyUI:  http://127.0.0.1:8188"
else
  echo "ComfyUI 未自动启动；需要时另开终端运行 ./scripts/start-comfyui.sh"
fi
echo "按 Ctrl+C 停止全部服务"

wait
