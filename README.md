# AI 室内设计 V0.6

这是一个可在本机运行的室内设计验证闭环。V0.6 延续 V0.5 的任意平面图语义识别能力：把
新上传的清晰住宅平面图发送给
外部多模态视觉模型，生成当前图专属的 `semanticLayout` 草稿。坐标先使用分辨率无关的
`q10000` 表示；总宽、总深可由用户填写，也可从清晰的总体尺寸或外部尺寸链自动读取，
回填后仍须用户核对。人工校正和拓扑校验通过后，系统以已批准布局图、
`semanticLayout` 和视觉基准图为共同约束，通过 `gpt-image-2` 依次生成彩平图、轴侧概念图
和分空间效果图。V0.6 默认生产链路不启动 Blender，也不提供可编辑三维模型交付。

1. 户型识别与标注：在“AI 设计工作流”的阶段 01 上传住宅草图或平面图；多模态视觉模型识别房间、墙体、门窗、家具和尺寸标注，网页完成校正并批准 `semanticLayout`。
2. AI 家装平面布局：阶段 02 只继承当前项目在阶段 01 已批准的原图、功能区标注、尺寸和结构语义，将同一户型整理为专业黑白平面布局并补充家具、洁具、柜体、绿化与铺装；不会发送或套用其他完整户型范例。
3. AI 设计工作流：默认入口在同一页面连续执行阶段 01～05，包括功能区标注、AI 平面布局、四类彩平、多角度轴侧概念图和各空间效果图，全程不调用 Blender。
4. AI 风格、色调与局部编辑（阶段 6～8，规划中）：后续将从已批准空间图继续派生风格、色调和局部修改版本。现有“AI 多材质替换”是独立的蒙版编辑能力，不等同于完整阶段 6～8。
5. 我的资产：结果按项目、工作流阶段、空间和变体组归档，可浏览历史、批准成功变体，并在阶段 3～5 内建立受控的父子版本关系。

旧版独立“AI 平面布局”页面已删除；“参数化效果图”、白模实验入口和 Blender 精确三维路径不再作为默认业务模块展示。
后端兼容实现与历史生成记录继续保留，但不参与阶段 3～5 的生产任务。

AI 多材质替换保留原有墙漆、木地板和石材预设，并新增奶油微水泥、米黄洞石、
浅色水磨石。AI 使用原图作为几何和相机权威、蓝墙／橙地控制图作为编辑区域约束；
结果会记录实际 Provider、模型、结构审计及是否发生本地回退。

阶段 3～5 全部使用 AI 图像编辑：阶段 3 提交已批准布局图与人工确认的语义约束，阶段 4、5
还必须提交已批准彩平图；各阶段均可附加风格参考。所有阶段始终重新引用结构权威输入，
不把上一张生成图当作唯一依据。家具不代表识别出原图中的精确品牌资产；未配置外部服务
或识别失败时，界面会明确提示，不会把固定样例或本地占位图冒充 AI 结果。

详细实现边界见：

- [V0.5 任意平面图语义重建技术方案](AI室内设计V0.5任意平面图语义重建技术方案.md)
- [V0.4 语义户型重建技术方案](AI室内设计V0.4语义户型重建技术方案.md)
- [V0.3 受控写实增强技术方案](AI室内设计V0.3受控写实增强技术方案.md)

## V0.6 纯 AI 项目流程

```text
任意平面图
→ Kuyao chat/completions 多模态视觉识别
→ q10000 semanticLayout 草稿
→ 自动读取总宽／总深（不可读时提示手动填写）
→ q10000 按总宽／总深分别换算为毫米
→ 网页人工校正
→ 拓扑、尺寸、引用与碰撞校验
→ AI 平面布局并人工批准
→ AI 彩平图：简单彩平／3D 俯视／水彩／写实材质
→ AI 轴侧概念图：日景／夜景／替代角度
→ AI 分空间效果图：按 semantic room ID 批量生成
→ （规划中）风格／色调／局部修改版本
→ 各阶段结构审计与人工确认
```

视觉识别与视觉生成是两条独立链路：`chat/completions` 的视觉模型负责产生可编辑结构数据；
`images/edits` 的 `gpt-image-2` 负责彩平、轴侧和空间效果的最终像素表现，但不能替代
`semanticLayout` 的识别、人工校正、审批和拓扑校验。

V0.4 为字节完全一致的 `example/平面图.jpeg` 准备的 SHA fixture 继续保留，但只用于
离线测试、识别精度对比和 Blender 回归。生产识别不会按 SHA 返回 fixture，也不会把
它套到其他户型图上。

## 个人资产与 AI 版本交付

每个成功的视觉任务都会自动登记为本地账户 `local-user` 的资产。阶段 3～5 统一归入
`ai_workflow`，并记录 `workflowStage`、`variantGroupId`、空间 ID、输入摘要、Provider、模型
和父资产关系。当前交付内容为输入图、语义输入摘要、生成图片、任务参数与资产元数据，
不包含 `.blend` 或 `.glb`。

阶段 02 的 AI 布局结果归入 `layout` 模块；在工作流中选中的方案会通过资产审批接口记录
`approvedVariantId` 与 `approvedOutputUrl`。阶段 03 只接受该已批准布局资产作为新链路的父资产，
同时继承阶段 01 的房间、墙体和门窗结构锁；家具视觉以阶段 02 的批准图片为准。

阶段 3 必须显式确认 `layout_approved=true`，且 `semanticLayout.rooms` 不能为空。阶段 4、5
必须上传已批准彩平图；当父资产属于 `ai_workflow` 时，还必须先通过资产审批接口选定一个
成功变体。新生成资产初始状态为 `review_required`，不会自动成为下一阶段的批准基线。

详细的阶段约束、接口和资产谱系见
[V0.6 纯 AI 工作流技术方案](AI室内设计V0.6纯AI工作流技术方案.md)。

## 本地启动

环境和依赖已安装后，在项目根目录运行：

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/dev.sh
```

该命令会启动 Web、主 API，并为历史兼容同时启动轻量增强桥（8189）。V0.6 阶段 3～5
只依赖主 API 配置的 Kuyao `gpt-image-2`，不调用 8189、ComfyUI 或 Blender；增强桥或
ComfyUI 离线不会影响纯 AI 工作流。阶段 3～5 生成失败时任务会明确失败，不会自动回退到
本地增强或占位图片。

只有复现历史增强实验时，才需要启用本机已有的 ComfyUI + SDXL。可一次启动全部服务：

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
ROOM_DESIGN_START_COMFYUI=1 ./scripts/dev.sh
```

也可以先在独立终端运行 `./scripts/start-comfyui.sh`，再运行
`./scripts/dev.sh`。ComfyUI 固定使用 `127.0.0.1:8188`，避免和主 API 的
8000 端口冲突；它使用自身的 `.venv`，不经过当前损坏的 `llf_v1`
Diffusers/Pillow 链路。

启动完成后访问：

- Web：http://127.0.0.1:5173
- API 文档：http://127.0.0.1:8000/docs
- 健康检查：http://127.0.0.1:8000/health
- 历史增强桥健康检查：http://127.0.0.1:8189/health
- 历史 ComfyUI 实验界面（启用时）：http://127.0.0.1:8188

停止服务时在当前终端按 `Ctrl+C`。

也可以分别启动：

```bash
# 终端一
cd /Users/bolin/Documents/AI/room_design/apps/api
conda activate llf_v1
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# 终端二
cd /Users/bolin/Documents/AI/room_design/apps/web
npm run dev -- --host 127.0.0.1
```

如果网页提示后端版本低于 V0.6，或
`POST /v1/floorplans/analyze` 返回 404，说明 8000 端口仍运行着旧进程。
停止旧服务后重新执行 `./scripts/dev.sh`，并确认
`http://127.0.0.1:8000/health` 返回 `"version": "0.6.0"`、
`"productionGeneration": "ai_workflow"` 和 `"blenderWorkflowEnabled": false`。

## 本地验证

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/check.sh
```

验证项包括后端 Ruff、后端 API 测试、前端 ESLint 和前端生产构建。
同时会验证历史 8189 增强桥的 Ruff 与 mock API 测试；这是兼容性回归，不表示它参与
V0.6 生产链路，也不要求 ComfyUI 在线。

`example/平面图.jpeg` 及其已审核 fixture 是离线回归样例，不是生产识别入口。通用性
验证还应上传多张未注册 SHA、不同布局的清晰住宅平面图，确认每张图都生成独立的
`semanticLayout`，并在网页校正后通过拓扑与尺寸质量门。

## 数据与生成物

- 业务数据库：本机 PostgreSQL `room_design`
- 生成文件：`.local/artifacts/`
- API 配置：`apps/api/.env`
- 前端 API 地址：默认 `http://127.0.0.1:8000`

如暂时不使用 PostgreSQL，删除或重命名 `apps/api/.env` 后会自动使用 `.local/room_design.db`。

## V0.6 外部视觉识别与生成配置

复制 `apps/api/.env.example` 为被 Git 忽略的 `apps/api/.env`，再填写真实 Key：

```bash
FLOORPLAN_VISION_PROVIDER=kuyao
KUYAO_API_KEY=
KUYAO_BASE_URL=https://www.kuyaoapi.com/v1
KUYAO_VISION_MODEL=gpt-5.6-sol
KUYAO_VISION_TIMEOUT_SECONDS=180
FLOORPLAN_FINAL_IMAGE_PROVIDER=auto
KUYAO_IMAGE_MODEL=gpt-image-2
KUYAO_IMAGE_QUALITY=high
KUYAO_IMAGE_TIMEOUT_SECONDS=900
KUYAO_STYLE_REFERENCE_IMAGE=/绝对路径/到/风格参考图.png
```

`KUYAO_VISION_MODEL` 必须是供应方 `/v1/models` 实际返回且支持图片输入的
chat/completions 模型；源码默认 `gpt-5.6-sol`，可在本地 `.env` 覆盖。不要把
`gpt-image-2` 配成视觉语义模型，它只用于最终的 `images/edits` 写实增强。

真实 Key 只保存在本地环境中，不要写入 README、`.env.example`、源码或 Git。如果 Key
曾出现在聊天、截图或共享记录中，应在供应方后台轮换，并同步更新本地 `.env`。

双链路使用同一服务端鉴权，但请求格式不同：

- 语义识别：`POST /v1/chat/completions`，JSON 多模态请求，输出 `semanticLayout`；
- 视觉生成：`POST /v1/images/edits`，`multipart/form-data`，模型为 `gpt-image-2`，
  同时兼容响应中的 `data[0].b64_json` 和 `data[0].url`。

阶段 3～5 要求配置 Kuyao 图片服务，失败时任务会明确标记失败，不会用本地占位图冒充 AI
结果。每个任务可以上传独立风格参考图。阶段 3 发送已批准布局和 Semantic 约束；阶段 4、
5 还必须发送已批准彩平图。结果会记录实际 Provider、模型、变体分组、逐项状态和人工审批
状态。

上传图会发送给配置的外部多模态服务。前端不持有 API Key，服务端日志和生成 Manifest
也不得记录 Authorization Header。

以下本地增强桥配置仅供历史实验路径使用，不参与 V0.6 阶段 3～5 默认生产：

```bash
FLOORPLAN_AI_ENDPOINT=http://127.0.0.1:8189/v1/enhance
FLOORPLAN_AI_HEALTH_ENDPOINT=http://127.0.0.1:8189/health
FLOORPLAN_AI_TOKEN=
FLOORPLAN_AI_TIMEOUT_SECONDS=900
```

Endpoint 由服务端配置，前端请求不能覆盖，避免把任意 URL 带入后端。服务可以返回
`image/png`，或返回包含 `imageBase64`、`provider`、`modelRevision` 的 JSON。

增强桥及 ComfyUI 配置继续保留，便于历史结果回归和后续受控生成研究。桥接实现和配置项见
[apps/enhancer/README.md](apps/enhancer/README.md)。

V0.6 网页按“视觉识别 → 语义草稿人工校正 → AI 平面布局批准 → AI 彩平 → AI 轴侧概念图
→ AI 分空间效果图”的顺序推进。房间多边形顶点、门窗、家具位置／尺寸／旋转都可用毫米
数值校正；任一上游编辑都会使下游批准状态失效。当前 MVP 面向清晰、正交、单层住宅平面图，复杂斜墙、
弧墙、复式与楼梯仍会提示风险，不能把“可上传任意图片”理解为所有建筑几何都已精确支持。

纯 AI 图片不提供几何一致性的自动证明。当前 `structureAudit` 会明确要求人工复核；所谓
“轴侧角度”是概念视角变体，不是真实三维相机。阶段 6～8 尚在规划中，现阶段不能承诺
跨图片对象身份完全一致、任意视角旋转、可编辑三维模型或施工级尺寸。

> AI 结果用于概念设计与效果预览，不作为尺寸、材料色差或施工依据。
