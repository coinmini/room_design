#!/usr/bin/env bash
set -euo pipefail

# 部署到单机 nginx 同源反代环境。
#
#   ./scripts/deploy.sh            前端 + 后端（默认）
#   ./scripts/deploy.sh web        只发前端
#   ./scripts/deploy.sh api        只发后端
#   ./scripts/deploy.sh check      只跑线上健康检查
#
# 为什么前端要在本地构建：服务器上没有装 Node，只放构建产物 dist/。
# 因此「git push 不会更新线上前端」，必须走本调用。
#
# 可用环境变量覆盖：
#   DEPLOY_HOST     默认 root@49.232.215.13
#   DEPLOY_PATH     默认 /opt/room_design
#   DEPLOY_URL      默认 http://49.232.215.13
#   DEPLOY_BRANCH   默认 main
#   SKIP_TESTS=1    跳过本地测试（不推荐）

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DEPLOY_HOST:-root@49.232.215.13}"
REMOTE_PATH="${DEPLOY_PATH:-/opt/room_design}"
BASE_URL="${DEPLOY_URL:-http://49.232.215.13}"
BRANCH="${DEPLOY_BRANCH:-main}"
SERVICE="room-design-api"
SSH_OPTS=(-o ConnectTimeout=20 -o BatchMode=yes)

TARGET="${1:-all}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

remote() { ssh "${SSH_OPTS[@]}" "$HOST" "$@"; }

preflight() {
  log "预检"
  command -v node >/dev/null || die "本地未安装 Node，无法构建前端"
  remote true 2>/dev/null || die "无法 SSH 到 $HOST"
  ok "SSH 可达：$HOST"
  ok "Node $(node --version)"

  # 未提交的改动会导致线上产物与 git 记录不一致，值得提醒但不阻断
  if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
    warn "工作区有未提交改动——构建产物将包含它们，但 git 里查不到"
  fi
}

deploy_web() {
  log "构建前端（VITE_API_URL 留空 → 相对路径，与 API 同源）"
  cd "$PROJECT_ROOT/apps/web"

  if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
    npx vitest run >/dev/null 2>&1 || die "前端测试未通过，已中止部署（SKIP_TESTS=1 可跳过）"
    ok "前端测试通过"
  fi

  VITE_API_URL= VITE_JOB_TIMEOUT_MS="${VITE_JOB_TIMEOUT_MS:-1800000}" \
    npm run build >/dev/null || die "前端构建失败"
  local bundle
  bundle="$(basename "$(ls -t dist/assets/index-*.js | head -1)")"
  ok "构建完成：$bundle ($(du -sh dist | cut -f1))"

  log "上传并原子切换 dist/"
  # 先解到 dist.new 再整体 mv，避免出现「dist 已删、新的还没到」的空窗期
  tar czf - dist 2>/dev/null | remote "
    set -e
    cd '$REMOTE_PATH/apps/web'
    rm -rf dist.new dist.old
    mkdir dist.new
    tar xzf - -C dist.new --strip-components=1 2>/dev/null
    [ -f dist.new/index.html ] || { echo '上传的产物缺少 index.html'; exit 1; }
    [ -d dist ] && mv dist dist.old
    mv dist.new dist
    rm -rf dist.old
  " || die "前端上传失败"
  ok "已切换到新产物"
}

# 重启会杀掉在途生成任务（C1 的 reclaim_stale_jobs 会把它们标成 WORKER_LOST），
# 用户已付费的这一批就白跑了。默认拒绝，除非显式 --force。
assert_no_running_jobs() {
  local running
  running="$(remote "
    cd '$REMOTE_PATH' 2>/dev/null || exit 0
    ./apps/api/.venv/bin/python - <<'PY' 2>/dev/null || echo 0
import sqlite3, os, re
url = ''
try:
    for line in open('apps/api/.env'):
        if line.startswith('DATABASE_URL='):
            url = line.split('=', 1)[1].strip()
except OSError:
    pass
m = re.match(r'sqlite:/+(/.*)', url)
if not m:
    print(0); raise SystemExit
try:
    c = sqlite3.connect(m.group(1))
    print(c.execute(\"select count(*) from jobs where status in ('RUNNING','QUEUED')\").fetchone()[0])
except Exception:
    print(0)
PY
  " | tail -1)"
  running="${running//[^0-9]/}"
  [[ -z "$running" ]] && running=0

  if [[ "$running" -gt 0 ]]; then
    if [[ "${FORCE:-0}" == "1" ]]; then
      warn "有 $running 个任务在跑，FORCE=1 仍继续——它们会被标记 WORKER_LOST"
    else
      die "有 $running 个生成任务正在运行，重启会让它们失败。
    等任务结束后重试，或 FORCE=1 ./scripts/deploy.sh api 强制部署。
    查看：ssh $HOST \"journalctl -u $SERVICE -f\""
    fi
  else
    ok "无在途任务，可安全重启"
  fi
}

deploy_api() {
  assert_no_running_jobs
  log "同步后端源码并重启服务"
  remote "
    set -e
    cd '$REMOTE_PATH'
    git fetch --quiet origin '$BRANCH'
    git checkout --quiet '$BRANCH'
    git pull --quiet --ff-only origin '$BRANCH'
    echo \"    HEAD: \$(git log --oneline -1)\"
    # 依赖有变动时才重装，省掉常见情况下的几十秒
    if ! git diff --quiet HEAD@{1} HEAD -- apps/api/pyproject.toml 2>/dev/null; then
      echo '    pyproject.toml 有变动，重装依赖…'
      ./apps/api/.venv/bin/pip install -q -e ./apps/api
    fi
    systemctl restart '$SERVICE'
  " || die "后端部署失败"
  ok "$SERVICE 已重启"
}

health_check() {
  log "线上校验"
  local code
  for _ in $(seq 1 15); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/health" || true)"
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  [[ "$code" == "200" ]] || die "/health 未在 30 秒内就绪（HTTP $code）"

  curl -s --max-time 10 "$BASE_URL/health" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(f\"    健康:      {d['status']}  authEnabled={d['authEnabled']}\")"

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/")"
  [[ "$code" == "200" ]] || die "首页返回 HTTP $code"
  ok "首页 200"

  # 鉴权已启用时，未带 token 的业务接口必须 401——防止改配置后意外裸奔
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/v1/projects")"
  if [[ "$code" == "401" ]]; then
    ok "未登录访问 /v1/projects → 401"
  else
    warn "未登录访问 /v1/projects → HTTP $code（预期 401，请确认 AUTH_* 已配置）"
  fi

  local live
  live="$(curl -s --max-time 10 "$BASE_URL/" | grep -o 'assets/index-[^"]*\.js' || true)"
  ok "线上产物：${live:-未识别}"

  printf '\n\033[1;32m部署完成 → %s\033[0m\n\n' "$BASE_URL"
}

case "$TARGET" in
  web)   preflight; deploy_web; health_check ;;
  api)   preflight; deploy_api; health_check ;;
  all)   preflight; deploy_web; deploy_api; health_check ;;
  check) health_check ;;
  *)     die "未知目标：$TARGET（可用：all / web / api / check）" ;;
esac
