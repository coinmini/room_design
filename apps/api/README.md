# Room Design V0.6 API

主 API 提供户型语义识别、AI 平面布局、阶段 3～5 纯 AI 设计工作流、任务状态和本地资产
归档。V0.6 的生产生成链路是 Kuyao `gpt-image-2` 图像编辑，不调用 Blender、ComfyUI 或
8189 增强桥。

## 启动

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1

cp apps/api/.env.example apps/api/.env

cd apps/api
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

默认也支持不创建 `.env`，此时使用工作区 `.local/room_design.db` SQLite 数据库。

## 阶段 2：Stage 01 标注转专业平面布局

`POST /v1/layouts/ai` 只接受已经人工批准的 Stage 01 输入：当前项目原图、
`semantic_layout`、分析任务 ID、批准版本 ID 与图纸检测边界。服务端会把原图和确认后的功能区
合成为控制图，再以单图方式提交给 `gpt-image-2`，生成同一户型的专业黑白平面布局。
原图 SHA-256、SemanticLayout 来源摘要和分析任务摘要必须一致，检测边界也必须来自该分析
任务；Stage 02 任务会把 Stage 01 分析任务记录为父任务。

该接口不会读取或发送 `example/平面图.jpeg`、`平面图2.jpeg`、`平面图3.jpeg`，也不接受
其他完整户型充当模板。结果记录 `referencePolicy=stage01_only`、
`referenceImageCount=0` 和 Stage 01 版本谱系。

接口文档：

- Swagger: http://127.0.0.1:8000/docs
- 健康检查: http://127.0.0.1:8000/health

## 测试

```bash
cd /Users/bolin/Documents/AI/room_design/apps/api
conda activate llf_v1
pytest
```

## 阶段 3～5 纯 AI 工作流

三个生成接口均使用 `multipart/form-data`，返回可通过 `/v1/jobs/{job_id}` 查询的后台任务：

```text
POST /v1/ai-workflow/color-plans
POST /v1/ai-workflow/axonometric-views
POST /v1/ai-workflow/space-renders
```

共同约束：

- 必须上传 `approved_layout_image`；
- 必须显式提交 `layout_approved=true`；
- `semantic_layout` 必须是 JSON 对象，且 `rooms` 为非空数组；
- 阶段 4、5 必须上传 `approved_color_plan_image`；
- 引用 `ai_workflow` 父资产前，必须通过审批接口批准一个成功变体；
- 生成结果初始为 `review_required`，AI 结构一致性仍需人工复核。

`variants` 和 `selected_space_ids` 支持逗号分隔文本或 JSON 字符串数组。批次结果记录每项的
`succeeded/failed` 状态；全部失败时任务仍保留逐项错误，取消中的任务不会被迟到的 Provider
结果改回成功，也不会创建资产。

成功视觉任务会归档为 `local-user` 资产，并把 `assetId` 写入任务结果。阶段 3～5 的资产统一
使用 `moduleKey=ai_workflow`，分别标记 `ai_color_plan`、`ai_axonometric` 和
`ai_space_render`。审批接口为：

```text
POST /v1/assets/{asset_id}/approve
JSON: {"variantId": "...", "comment": "可选"}
```

审批只接受该资产 `outputs` 中状态为成功的变体，并持久化 `approvedVariantId`、
`approvedOutputUrl` 和审批时间。

## 历史兼容边界

代码库仍保留旧版 `FLOORPLAN_SCENE`、Blender 场景、白模、本地效果图和 8189 增强桥适配，
用于读取历史任务及回归实验。它们不参与 V0.6 阶段 3～5，也不代表当前产品提供 `.blend`、
`.glb`、真实三维相机或毫米级多角度交付。健康检查中的 `legacyBlenderAvailable` 仅说明本机
历史能力是否可用；生产链路以 `productionGeneration=ai_workflow` 和
`blenderWorkflowEnabled=false` 为准。
