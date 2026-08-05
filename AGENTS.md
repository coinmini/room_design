# Agent instructions — room_design

## UI 修改后必须浏览器验收（强制）

**任何网页 / 前端 UI 修改完成后，必须用真实浏览器（Playwright 或等效）打开页面检查，不得只靠 typecheck / 代码阅读就宣称完成。**

### 何时执行

- 改了 `apps/web` 下的 React/CSS/布局/交互
- 改了影响页面展示的 API 且前端会立刻用到
- 修了「遮挡、重叠、裁切、弹层、滚动、导航」类问题

### 检查清单

1. **目标路径**：打开实际 URL（如 `http://127.0.0.1:5173/`、`/projects`、画布页）
2. **改动点**：点一遍相关按钮 / 菜单 / 弹窗 / 链接
3. **视觉**：截图或测量 bounding box，确认无重叠、无裁切、层级正确
4. **回归**：附近相关交互是否被带坏（例如菜单、删除确认、顶栏）
5. **向用户汇报**：说明检查了哪些页面/操作，通过或失败

### 推荐做法

```bash
# 服务已在跑时直接 Playwright
python3 - <<'PY'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.goto("http://127.0.0.1:5173/...", wait_until="networkidle")
    # 操作 + 断言 + screenshot
    page.screenshot(path="/tmp/ui_check.png")
    browser.close()
PY
```

### 未完成定义

- 只跑了 `tsc` / 单元测试 → **不算完成**
- 未打开浏览器验证交互与布局 → **不算完成**
