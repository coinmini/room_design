#!/usr/bin/env bash
set -euo pipefail

COMFYUI_DATA_ROOT="${COMFYUI_DATA_ROOT:-${HOME}/Documents/ComfyUI}"
COMFYUI_CORE_ROOT="${COMFYUI_CORE_ROOT:-/Applications/ComfyUI.app/Contents/Resources/ComfyUI}"
COMFYUI_PYTHON="${COMFYUI_PYTHON:-$COMFYUI_DATA_ROOT/.venv/bin/python}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"

if [[ ! -x "$COMFYUI_PYTHON" ]]; then
  echo "未找到 ComfyUI Python：$COMFYUI_PYTHON"
  exit 1
fi

if [[ ! -f "$COMFYUI_CORE_ROOT/main.py" ]]; then
  echo "未找到 ComfyUI Core：$COMFYUI_CORE_ROOT/main.py"
  exit 1
fi

exec "$COMFYUI_PYTHON" "$COMFYUI_CORE_ROOT/main.py" \
  --listen 127.0.0.1 \
  --port "$COMFYUI_PORT" \
  --base-directory "$COMFYUI_DATA_ROOT" \
  --user-directory "$COMFYUI_DATA_ROOT/user" \
  --front-end-root "$COMFYUI_CORE_ROOT/web_custom_versions/desktop_app" \
  --disable-auto-launch \
  --disable-all-custom-nodes \
  --whitelist-custom-nodes ComfyUI_IPAdapter_plus \
  --disable-api-nodes \
  --preview-method none \
  --log-stdout
