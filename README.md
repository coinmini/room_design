# AI 室内设计 V0.5

这是一个可在本机运行的室内设计验证闭环。V0.5 支持把新上传的清晰住宅平面图发送给
外部多模态视觉模型，生成当前图专属的 `semanticLayout` 草稿。坐标先使用分辨率无关的
`q10000` 表示；总宽、总深可由用户填写，也可从清晰的总体尺寸或外部尺寸链自动读取，
回填后仍须用户核对。人工校正和拓扑校验通过后，可选择“AI 直出”快速生成最终鸟瞰图，
也可选择“精确三维”先创建 Blender 基础场景，再进入可替换的写实增强。

1. 户型识别与效果图：上传清晰正交户型图；多模态视觉模型识别房间、墙体、门窗、家具和尺寸标注，网页完成校正后输出 Cycles 基础渲染、Depth／Normal／Semantic／Edge 控制图和可替换的最终增强图。
2. AI 家装平面布局：结合可选结构图、房间尺寸、设计要求和三套参考范例，由图像模型生成家具平面概念方案。
3. AI 白模渲染：上传白模截图，输出结构控制图和两张风格候选图。
4. AI 多材质替换：上传室内图并绘制墙面／地面蒙版，由 `gpt-image-2` 在选区内重绘真实材质；蒙版外像素强制恢复原图，服务不可用时明确回退到本地预览。
5. 我的资产：各模块生成成功后自动保存到本地个人资产库，可浏览历史、打开详情并继续生成版本。

旧版“参数化效果图”不再作为独立前端模块展示，其能力已并入“户型识别与效果图”的
“精确三维”路径。后端兼容接口和历史生成记录继续保留，历史资产统一归类为
“历史快速房间渲染”。

AI 多材质替换保留原有墙漆、木地板和石材预设，并新增奶油微水泥、米黄洞石、
浅色水磨石。AI 使用原图作为几何和相机权威、蓝墙／橙地控制图作为编辑区域约束；
结果会记录实际 Provider、模型、结构审计及是否发生本地回退。

当前全屋鸟瞰保留两种生成模式。AI 直出把原始平面图、人工确认的语义约束图和可选风格图
交给 `gpt-image-2`；精确三维先由本地 Blender 按毫米语义布局编译可编辑场景，再执行
`gpt-image-2` 或 ComfyUI 增强。两种模式均不再根据户型宽度选择硬编码模板；家具不代表
识别出原图中的精确品牌资产。未配置外部服务或识别失败时，
界面会明确提示并允许人工校正，不会把固定样例布局冒充新图的识别结果。

详细实现边界见：

- [V0.5 任意平面图语义重建技术方案](AI室内设计V0.5任意平面图语义重建技术方案.md)
- [V0.4 语义户型重建技术方案](AI室内设计V0.4语义户型重建技术方案.md)
- [V0.3 受控写实增强技术方案](AI室内设计V0.3受控写实增强技术方案.md)

## V0.5 任意平面图流程

```text
任意平面图
→ Kuyao chat/completions 多模态视觉识别
→ q10000 semanticLayout 草稿
→ 自动读取总宽／总深（不可读时提示手动填写）
→ q10000 按总宽／总深分别换算为毫米
→ 网页人工校正
→ 拓扑、尺寸、引用与碰撞校验
→ 选择生成模式
  ├─ AI 直出：原图 + Semantic 约束图 + 风格图 → gpt-image-2
  └─ 精确三维：semanticLayout → Blender → gpt-image-2／本地 ComfyUI
→ 最终结构审计与人工确认
```

视觉识别与最终增强是两条独立链路：`chat/completions` 的视觉模型负责产生可编辑的
结构数据；`images/edits` 的 `gpt-image-2` 负责最终像素表现，可以消费 Blender 基础图，
也可以直接消费原始平面图与 Semantic 约束图，但不能替代 `semanticLayout` 的识别、人工
校正和拓扑校验。

V0.4 为字节完全一致的 `example/平面图.jpeg` 准备的 SHA fixture 继续保留，但只用于
离线测试、识别精度对比和 Blender 回归。生产识别不会按 SHA 返回 fixture，也不会把
它套到其他户型图上。

## 个人资产与精确三维交付

每个成功的 `FLOORPLAN_SCENE` 任务都会自动登记为本地账户 `local-user` 的资产，历史成功
任务也会在首次打开“我的资产”时补建索引。AI 直出资产保存原图、Semantic 约束图、最终图、
Manifest 和生成参数；精确三维资产额外保存 Blender 场景与 GLB 交付文件。

精确三维资产详情提供三类后续操作：

- 选择 `corner_01`、`corner_02`、`eye_level_01` 等机位并生成派生版本；
- 切换现代暖调、现代极简、自然原木等三维材质预设并重新渲染；
- 下载 `.blend` 进行完整对象编辑，或下载 `.glb` 交付给三维查看器和下游系统。

`gpt-image-2` 生成的写实材质和家具细节属于最终像素图，不会反向写回 `.blend`。三维工作台
编辑的是由 `semanticLayout` 编译出的参数化墙体、开口、代理家具和材质；需要模型级精修时，
应下载 `.blend` 后在 Blender 中继续编辑。

## 本地启动

环境和依赖已安装后，在项目根目录运行：

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/dev.sh
```

该命令会启动 Web、主 API 和轻量增强桥（8189）。增强桥连接不到 ComfyUI
时不会影响基础功能，最终图会自动回退到像素配准的本地增强。

需要启用本机已有的 ComfyUI + SDXL 时，可一次启动全部服务：

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
- 增强桥健康检查：http://127.0.0.1:8189/health
- ComfyUI（启用时）：http://127.0.0.1:8188

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

如果“户型识别与效果图”提示后端版本低于 V0.5，或
`POST /v1/floorplans/analyze` 返回 404，说明 8000 端口仍运行着旧进程。
停止旧服务后重新执行 `./scripts/dev.sh`，并确认
`http://127.0.0.1:8000/health` 返回 `"version": "0.5.0"`。

## 本地验证

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/check.sh
```

验证项包括后端 Ruff、后端 API 测试、前端 ESLint 和前端生产构建。
同时会验证 8189 增强桥的 Ruff 与 mock API 测试，不要求 ComfyUI 在线。

`example/平面图.jpeg` 及其已审核 fixture 是离线回归样例，不是生产识别入口。通用性
验证还应上传多张未注册 SHA、不同布局的清晰住宅平面图，确认每张图都生成独立的
`semanticLayout`，并在网页校正后通过拓扑与尺寸质量门。

## 数据与生成物

- 业务数据库：本机 PostgreSQL `room_design`
- 生成文件：`.local/artifacts/`
- API 配置：`apps/api/.env`
- 前端 API 地址：默认 `http://127.0.0.1:8000`

如暂时不使用 PostgreSQL，删除或重命名 `apps/api/.env` 后会自动使用 `.local/room_design.db`。

## V0.5 外部视觉识别配置

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
- 最终增强：`POST /v1/images/edits`，`multipart/form-data`，模型为 `gpt-image-2`，
  同时兼容响应中的 `data[0].b64_json` 和 `data[0].url`。

`FLOORPLAN_FINAL_IMAGE_PROVIDER=auto` 表示：配置了 Kuyao Key 时优先使用
`gpt-image-2`，失败后再尝试本地 ComfyUI，最后才使用像素配准的保守回退。
`KUYAO_STYLE_REFERENCE_IMAGE` 可指向期望的室内鸟瞰风格参考图。AI 直出会发送原始平面图、
Semantic 约束图和该风格图；精确三维则发送 Blender 基础图、控制图和该风格图。供应方
返回结果后，两种模式都会执行结构审计；精确三维未通过会强制回退，AI 直出未通过会保留
候选但标记为必须人工确认，因为该模式没有可替代的 Blender 最终图。

上传图会发送给配置的外部多模态服务。前端不持有 API Key，服务端日志和生成 Manifest
也不得记录 Authorization Header。

可选的生成式增强服务通过以下环境变量配置：

```bash
FLOORPLAN_AI_ENDPOINT=http://127.0.0.1:8189/v1/enhance
FLOORPLAN_AI_HEALTH_ENDPOINT=http://127.0.0.1:8189/health
FLOORPLAN_AI_TOKEN=
FLOORPLAN_AI_TIMEOUT_SECONDS=900
```

Endpoint 由服务端配置，前端请求不能覆盖，避免把任意 URL 带入后端。服务可以返回
`image/png`，或返回包含 `imageBase64`、`provider`、`modelRevision` 的 JSON。

本机增强桥使用 `sd_xl_base_1.0.safetensors`，已经安装 SDXL Depth 与 Canny
Control-LoRA，默认使用 `control-lora-depth-rank256.safetensors` 和 Blender Depth
控制图。持久化配置位于被 Git 忽略的 `apps/enhancer/.env`，`scripts/dev.sh` 会自动
加载。结果仍会经过主 API 的结构边缘质量门：无论 Kuyao 还是 ComfyUI，只要结果未通过
结构一致性检查，就不会作为 `finalRenderUrl` 发布，而会回退到已配准的本地保守图，并在
结果中记录 `rejectedProvider`。桥接实现和配置项见
[apps/enhancer/README.md](apps/enhancer/README.md)。

V0.5 网页会强制执行“视觉识别已配置 → 语义草稿人工校正 → 明确勾选已核对 → 后端质量门
→ 选择 AI 直出或精确三维”的顺序。房间多边形顶点、门窗、家具位置／尺寸／旋转都可用毫米
数值校正；任一编辑都会撤销确认状态并清空旧场景。当前 MVP 面向清晰、正交、单层住宅平面图，复杂斜墙、
弧墙、复式与楼梯仍会提示风险，不能把“可上传任意图片”理解为所有建筑几何都已精确支持。

> AI 结果用于概念设计与效果预览，不作为尺寸、材料色差或施工依据。
