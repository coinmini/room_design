# AI 室内设计 · 本地工作台（V0.6 画布主路径）

本机可运行的室内设计验证闭环：**首页 → 项目 → 无限画布**，在画布上完成 **01～08** 全阶段：

```text
01 户型结构确认
→ 02 AI 平面布局（多方案 · 批准）
→ 03 彩平（多风格 · 批准）
→ 04 轴侧 / 05 分空间（可从 03 拖把线二选一）
→ 06 风格方案（可勾选）
→ 07 色调方案（可勾选）
→ 08 局部修改
```

默认生产链路**不依赖 Blender**，以已批准布局 / 彩平 / 语义为约束，通过 `gpt-image-2`（Kuyao）做图像编辑生成。

## 推荐入口（当前主路径）

| 路由 | 说明 |
|------|------|
| `/` | 风暴式首页：生图提示、项目预览、学堂 |
| `/projects` | 项目库 |
| `/projects/:projectId/canvas` | **无限画布（01–08 执行中枢）** |
| `/assets` | 我的资产 |

画布能力摘要：

- **拖把线**：从节点拖出生成下一阶段；03 可弹「轴侧 / 分空间」菜单
- **批准 / 取消批准**：variant 级门控，派生前需批准
- **05/06/07 多选**：房间 / 风格 / 色调按需勾选
- **任务恢复**：离开再进可恢复进行中的生成骨架与轮询
- **堆叠图库**：多方案折叠为一列，全屏一览

### 已废弃 / 兼容

- `/workspace/*`：默认重定向到首页；仅当环境变量 `VITE_SHOW_LEGACY_TOOLS=true` 时打开旧侧栏
- 旧「AI 设计工作流」8 阶段向导代码在 `apps/web/src/legacy/`，默认**不展示**；需 `VITE_SHOW_LEGACY_TOOLS=true` 才出现在「历史实验能力」

### 画布模块（前端）

主组件 `ProjectCanvas` 已拆为纯函数 / hooks，便于单测与演进：

| 模块 | 职责 |
|------|------|
| `buildCanvasFlow` | 图谱 + 骨架 → React Flow 节点/边 |
| `useCanvasSkeletons` | 骨架 spawn / 进度 / 重试 / 恢复合并 |
| `useResumeActiveJobs` | 离开再进：恢复进行中任务并 poll |
| `useCanvasRunAction` | 节点动作（派生生成、详情、重试丢弃） |
| `spawnDerive` / `canRunAction` / `skeletonMath` | 派生门控、动作可用性、占位槽位 |

## 本地启动

```bash
# API（推荐项目 venv）
cd apps/api
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Web
cd apps/web
npm run dev -- --host 127.0.0.1 --port 5173
```

浏览器打开：http://127.0.0.1:5173/

配置 API / Kuyao 密钥等见 `apps/api/README.md` 与 `apps/api/app/config.py`。

## 回归脚本（可选）

```bash
# 需 web:5173 + api:8000
cd apps/web
node scripts/check_canvas_mvp_paths.mjs [projectId]
```

覆盖：打开画布 → 详情/堆叠 → 拖把线生成 UI。

## 测试

```bash
# API
cd apps/api && .venv/bin/python -m pytest -q

# Web 单元
cd apps/web && npx vitest run
```

## 技术文档

- [V0.6 纯 AI 工作流技术方案](AI室内设计V0.6纯AI工作流技术方案.md)
- [无限画布改造方案](无限画布改造方案.md)
- [画布执行手册](画布执行手册.md)

## 流程示意

```text
任意平面图
→ 多模态识别 + 结构编辑确认（01）
→ AI 平面布局并人工批准（02）
→ 彩平 / 轴侧 / 分空间 / 风格 / 色调 / 局部修改（03–08）
→ 资产归档与项目画布图谱
```
