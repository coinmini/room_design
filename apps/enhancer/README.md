# Room Design ComfyUI Enhancer

本服务是 `room_design` API 与本机 ComfyUI 之间的轻量桥接层。它不会下载模型，也不会修改 ComfyUI 目录。当前工作流以 Blender 基础渲染为结构锚点，组合 ArchViz SDXL checkpoint、Depth ControlNet、IP-Adapter Plus 风格参考和可选 SDXL Refiner。

## 接口

- `GET /health`：探测 ComfyUI 的 `/system_stats`、`/object_info`，报告 checkpoint、ControlNet、IP-Adapter、CLIP Vision 与 Refiner 能力。缺少服务、模型或节点时返回 `status: degraded`。
- `POST /v1/enhance`：接收现有 API 的 data URL 契约，上传 `images.base`，依次调用 ComfyUI `/upload/image`、`/prompt`、`/history/{prompt_id}` 与 `/view`，返回 `imageBase64`。

默认工作流消费 `images.base`。安装兼容的 SDXL ControlNet 权重并配置
`COMFYUI_CONTROLNET_MODEL` 后，桥会自动从 `depth/edge/normal/semantic`
中选择控制图，切换到 `ControlNetApplyAdvanced` 工作流。配置 IP-Adapter 后可通过
`images.reference` 覆盖本地默认参考图；非正方形参考图会自动留白为正方形，避免
CLIP Vision 中心裁切。上游不传参考图时使用操作方配置的本地文件。

## 启动

先确保 ComfyUI 已在 `127.0.0.1:8188` 启动，并在 ComfyUI 的模型列表中确认 SDXL checkpoint 的完整文件名。

```bash
conda activate llf_v1
cd apps/enhancer
cp .env.example .env
set -a
source .env
set +a
uvicorn app.main:app --host 127.0.0.1 --port 8189
```

然后在主 API 的 `.env` 中配置：

```dotenv
FLOORPLAN_AI_ENDPOINT=http://127.0.0.1:8189/v1/enhance
FLOORPLAN_AI_TIMEOUT_SECONDS=360
```

检查状态：

```bash
curl http://127.0.0.1:8189/health
```

项目根目录的 `scripts/dev.sh` 会自动加载 `apps/enhancer/.env`。当前本机默认配置为：

```dotenv
COMFYUI_CONTROLNET_MODEL=control-lora-depth-rank256.safetensors
COMFYUI_CONTROL_IMAGE=depth
COMFYUI_CONTROL_STRENGTH=0.88
COMFYUI_CONTROL_END_PERCENT=1.0
COMFYUI_STEPS=28
COMFYUI_CFG=5.5
COMFYUI_MAX_GENERATION_SIDE=1280
COMFYUI_REFINER_CHECKPOINT=sd_xl_refiner_1.0.safetensors
COMFYUI_REFINER_STEPS=20
COMFYUI_REFINER_DENOISE=0.20
COMFYUI_IPADAPTER_MODEL=ip-adapter-plus_sdxl_vit-h.safetensors
COMFYUI_IPADAPTER_CLIP_VISION=CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors
COMFYUI_IPADAPTER_REFERENCE_IMAGE=/absolute/path/to/reference.png
COMFYUI_IPADAPTER_WEIGHT=0.60
```

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COMFYUI_URL` | `http://127.0.0.1:8188` | 本机 ComfyUI 地址 |
| `COMFYUI_CHECKPOINT` | `sd_xl_base_1.0.safetensors` | `CheckpointLoaderSimple` 可见的文件名 |
| `COMFYUI_REFINER_CHECKPOINT` | 空 | 可选 SDXL Refiner checkpoint |
| `COMFYUI_REFINER_STEPS` | `20` | Refiner 采样步数 |
| `COMFYUI_REFINER_CFG` | `5.0` | Refiner CFG |
| `COMFYUI_REFINER_DENOISE` | `0.20` | Refiner 低强度细节重绘 |
| `COMFYUI_IPADAPTER_MODEL` | 空 | IP-Adapter Plus SDXL 模型文件名 |
| `COMFYUI_IPADAPTER_CLIP_VISION` | 空 | 匹配的 ViT-H CLIP Vision 文件名 |
| `COMFYUI_IPADAPTER_REFERENCE_IMAGE` | 空 | 本地默认参考 PNG 的绝对路径 |
| `COMFYUI_IPADAPTER_WEIGHT` | `0.60` | 风格参考权重 |
| `COMFYUI_IPADAPTER_STYLE_BOOST` | `1.10` | 精确风格迁移增益 |
| `COMFYUI_IPADAPTER_END_PERCENT` | `0.85` | IP-Adapter 影响结束比例 |
| `COMFYUI_CONTROLNET_MODEL` | 空 | 可选；配置后启用 SDXL ControlNet 工作流 |
| `COMFYUI_CONTROL_IMAGE` | `auto` | `auto/depth/edge/normal/semantic` |
| `COMFYUI_CONTROL_STRENGTH` | `0.88` | 高强度写实重绘时的结构控制强度 |
| `COMFYUI_CONTROL_END_PERCENT` | `1.0` | 控制结束比例；低去噪 img2img 应覆盖完整采样区间 |
| `COMFYUI_STEPS` | `28` | 默认采样步数，请求可覆盖 |
| `COMFYUI_CFG` | `5.5` | 默认 CFG，请求可覆盖；较低 CFG 可减少墙面伪影 |
| `COMFYUI_SAMPLER` | `dpmpp_2m_sde` | KSampler 采样器 |
| `COMFYUI_SCHEDULER` | `karras` | KSampler 调度器 |
| `COMFYUI_GENERATION_TIMEOUT_SECONDS` | `900` | 任务轮询总超时；Apple MPS 首次载入较慢 |
| `COMFYUI_MAX_GENERATION_SIDE` | `1280` | 推理最大边；返回前恢复到基础图尺寸 |
| `ENHANCER_MAX_IMAGE_BYTES` | `26214400` | 单张 base／control／reference PNG 的上限 |

## 测试

```bash
cd apps/enhancer
pytest -q
```

测试使用 mock 客户端，不要求本机 ComfyUI 或模型在线。
