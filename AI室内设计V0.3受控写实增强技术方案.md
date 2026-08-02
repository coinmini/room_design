# AI 室内设计 V0.3：受控写实增强技术方案

> 文档版本：V0.3
>
> 更新日期：2026 年 8 月 1 日
>
> 状态：已实现的本地开发版本

## 1. 版本目标

V0.3 将“结构化平面图生效果图”拆成两个明确阶段：

```text
确认后的结构 JSON
→ Blender 高质量基础渲染与控制图
→ 可替换的生成式增强服务
→ 结构一致性质量门
→ 最终效果图
```

Blender 是结构真值，生成模型只负责增加材质、软装细节和光照表现。任何未通过结构质量门的生成结果都不能成为最终交付图。

## 2. MVP 范围

### 2.1 已实现

- `0.2` 与 `0.3` 场景请求向后兼容；
- 快速结构、基础渲染和最终增强三档输出；
- Blender Cycles + Metal GPU；
- 1536 × 1152 基础鸟瞰图；
- 96／160 samples 与 Cycles 降噪；
- 程序化木材、织物、墙面和石材表面细节；
- Studio、一室一厅和两室一厅软装模板入口；
- 同相机 Depth、Normal、Semantic 和 Edge 控制图；
- 本地确定性结构保真增强；
- 操作方配置的 HTTP 生成服务适配器；
- 本机 Juggernaut XL ArchViz checkpoint；
- Depth Control-LoRA 结构约束；
- IP-Adapter Plus + ViT-H 参考图精确风格迁移；
- SDXL Refiner 低强度二次细化；
- 输出尺寸和结构边缘一致性检查；
- 外部增强失败时自动回退；保守模式结构漂移时回退，写实模式保留候选并提示人工确认；
- 场景摘要 SHA-256 与不可变渲染 Manifest；
- 前端基础图／最终图并排比较；
- 前端控制图、供应方和真实质量指标展示。

### 2.2 当前限制

- 程序化家具仍是模板，不是从原图识别的真实资产；
- 房间闭合拓扑、门洞和窗户识别尚未完成；
- 当前仓库不内置扩散模型或 ComfyUI；
- 未配置 `FLOORPLAN_AI_ENDPOINT` 时不会伪装成 AI 写实增强；
- 通用图像生成模型可能改变墙体，必须通过质量门；
- 当前边缘指标是图像空间近似，不是施工级几何证明。
- 当前 IP-Adapter 默认参考图由操作方配置，前端参考图库与用户上传尚未实现。

## 3. 请求契约

`POST /v1/floorplan-scenes`

新增字段：

```json
{
  "schemaVersion": "0.3",
  "layoutPresetId": "two_bedroom",
  "renderQuality": "final",
  "enableEnhancement": true,
  "enhancementStrength": 0.62,
  "designPrompt": "浅橡木、米白布艺、柔和自然光",
  "useBlender": true
}
```

质量档位：

| 档位 | Blender | 控制图 | 增强 |
|---|---:|---:|---:|
| `preview` | 否 | Edge | 本地轻量 |
| `base` | 是 | Edge | 本地结构保真 |
| `final` | 是 | Depth／Normal／Semantic／Edge | 外部服务或本地回退 |

## 4. Blender 基础渲染

### 4.1 主图

- 等距正交相机；
- 相机侧墙体剖切；
- 背景侧墙体保留完整高度；
- Cycles 渲染；
- Metal GPU 可用时自动启用；
- `base` 使用 96 samples；
- `final` 使用 160 samples；
- AgX 中高对比度色彩管理；
- 输出 1536 × 1152 PNG；
- 同时保留 `.blend` 调试文件。

### 4.2 材质

程序化材质通过 Blender 节点生成：

- 木材：Noise + ColorRamp + Bump；
- 织物：高频 Noise + 微弱 Bump；
- 石材：中频 Noise + Bump；
- 墙面：高频低强度表面变化。

这只能提升基础渲染质量，不能替代真实家具资产和高分辨率 PBR 贴图。

## 5. 控制图

### 5.1 Depth

从 Blender Z Pass 输出，按相机距离归一化为灰度图。近处更亮，远处更暗，用于约束生成模型的空间层次。

### 5.2 Normal

从 Blender Normal Pass 输出，将 `[-1, 1]` 映射到 `[0, 1]` RGB，用于保持墙面、地面和家具表面朝向。

### 5.3 Semantic

场景对象按名称映射为稳定颜色：

| 类别 | 颜色用途 |
|---|---|
| 墙体 | 蓝 |
| 地板／地毯 | 灰 |
| 床具 | 绿 |
| 沙发／椅子 | 橙 |
| 桌柜 | 黄 |
| 厨房电器 | 紫 |
| 卫浴 | 青 |
| 绿植 | 深绿 |
| 门窗／窗帘 | 浅青 |

### 5.4 Edge

当前 Edge 由基础 RGB 执行固定参数 Canny 获得。后续版本应升级为：

```text
Depth 不连续边缘
∪ 墙体 Semantic 边界
∪ 门窗边界
```

避免把木纹和织物纹理误认为结构线。

## 6. 增强 Provider

### 6.1 本地 Provider

`local-structure-preserving-v2`

- CLAHE 局部对比度；
- 双边滤波；
- 注册式锐化；
- 轻量 HSV 调整；
- 不改变分辨率和像素位置；
- 无需 API Key；
- 明确标记为本地增强，不宣称生成式写实。

### 6.2 HTTP Provider

由服务端环境变量配置：

```bash
FLOORPLAN_AI_ENDPOINT=http://127.0.0.1:8189/v1/enhance
FLOORPLAN_AI_TOKEN=
FLOORPLAN_AI_TIMEOUT_SECONDS=900
```

前端不能提交或覆盖 Endpoint，避免任意 URL 和 SSRF 风险。

请求：

```json
{
  "version": "1.0",
  "prompt": "写实轴测剖切住宅；保持墙体拓扑和相机，用真实家具替换白模代理……",
  "negativePrompt": "white clay render, low-poly, blockout, changed floor plan……",
  "strength": 0.62,
  "images": {
    "base": "data:image/png;base64,...",
    "edge": "data:image/png;base64,...",
    "depth": "data:image/png;base64,...",
    "normal": "data:image/png;base64,...",
    "semantic": "data:image/png;base64,..."
  }
}
```

响应可以直接返回 `image/png`，也可以返回：

```json
{
  "imageBase64": "...",
  "provider": "provider-name",
  "modelRevision": "model-version"
}
```

响应上限为 25 MB。超时、非法 MIME 和解码失败会触发本地回退；结构漂移按重绘强度
执行“自动回退”或“保留并人工确认”。

## 7. 结构质量门

基础图和候选结果使用固定 Canny 参数提取边缘。系统计算基础结构边缘到候选边缘的距离：

```text
edgeRetention = 容差内被候选结果保留的基础边缘比例
layoutDriftScore = 1 - edgeRetention
```

当前 MVP 门槛：

```text
保守增强：4px 容差，edgeRetention >= 0.72
写实重绘：6px 容差，edgeRetention >= 0.72
```

保守模式未通过时：

```text
外部结果拒绝
→ 本地结构保真增强
→ 重新质量检查
→ 最终交付
```

质量指标会进入 API 结果与 Manifest，前端不再硬编码“结构已保持”。
写实重绘强度大于等于 `0.55` 时，家具和材质边缘必然发生变化；若仍未通过，系统保留
候选结果、标记 `wallsPreserved=false` 并要求人工确认，不再静默替换成白模增强图。

## 8. 响应契约

```json
{
  "schemaVersion": "0.3",
  "sceneDigest": "sha256:...",
  "renderProvider": "blender-floorplan-headless",
  "renderType": "controlled-dollhouse-v3",
  "baseRenderUrl": "/artifacts/base.png",
  "finalRenderUrl": "/artifacts/final.png",
  "controlImages": {
    "edgeUrl": "/artifacts/edge.png",
    "depthUrl": "/artifacts/depth.png",
    "normalUrl": "/artifacts/normal.png",
    "semanticUrl": "/artifacts/semantic.png"
  },
  "enhancement": {
    "provider": "local-structure-preserving-v2",
    "modelRevision": "opencv-registered-grade-v2",
    "requested": true,
    "seed": 17,
    "rejectedProvider": null,
    "notice": "..."
  },
  "renderInfo": {
    "quality": "final",
    "width": 1536,
    "height": 1152,
    "samples": 160,
    "durationMs": 14999
  },
  "structureCheck": {
    "edgeRetention": 0.9967,
    "layoutDriftScore": 0.0033,
    "wallsPreserved": true,
    "requiresUserConfirmation": true
  },
  "manifestUrl": "/artifacts/manifest.json"
}
```

## 9. 实际验证

固定样例 `example/平面图.jpeg` 的本机验证结果：

- Blender 5.1.0；
- 1536 × 1152；
- 160 samples；
- 四类控制图全部成功；
- 总耗时约 15 秒；
- 本地增强边缘保留率 `0.9967`；
- Manifest 成功写入；
- API、Ruff、Pytest、ESLint、TypeScript 和 Vite 构建通过。

使用通用图像生成能力制作的高写实基准图虽然视觉质量显著提高，但边缘保留率不足时质量门会正确拒绝。当前版本已经接入 Depth ControlNet；下一步继续增加门窗语义和多控制图，而不是放宽结构检查。

## 10. 下一步

1. 闭合房间多边形与房间语义；
2. 门洞、窗户和重复墙线处理；
3. 真实家具 GLB 资产库；
4. Depth + Edge 多 ControlNet 与门窗语义控制；
5. 只对墙体主边界计算结构质量指标；
6. 输出结果的反向深度估计与 Semantic IoU；
7. Blender 单进程多 Pass 输出，减少重复启动开销；
8. 场景版本、资产版本和人工修改历史。

## 11. 本机 ComfyUI 接入（已实现）

本机现有 ComfyUI Desktop 与 SDXL checkpoint 不直接提供本项目需要的同步 HTTP
契约，因此增加独立桥接服务：

```text
room_design API :8000
  → POST /v1/enhance :8189
  → /upload/image + /prompt + /history + /view :8188
  → SDXL img2img
  → 结构质量门
```

桥接服务位于 `apps/enhancer`，基础采样、ControlNet 与 Refiner 使用 ComfyUI 核心
节点；参考图风格迁移使用 `ComfyUI_IPAdapter_plus`，启动脚本通过白名单只放行该
自定义节点。服务不会下载或移动模型。健康检查会报告 ComfyUI 可达性、checkpoint、
ControlNet、IP-Adapter、CLIP Vision、参考图与 Refiner 状态。启动脚本固定把
ComfyUI 放在 8188，避免与主 API 的 8000 端口冲突。

本机当前已具备 `sd_xl_base_1.0.safetensors`、Depth 与 Canny Control-LoRA，默认
使用 Depth 控制：

```text
默认：Blender RGB + Depth → SDXL ControlNet（结构强约束）
可切换：Blender RGB + Edge → SDXL ControlNet
```

当前桥会把最长边限制为 1280 像素执行生成，再恢复到基础图尺寸；默认 28 steps、
CFG 5.5、Depth 控制强度 0.88、seed 17、超时 900 秒。主 API 不会因为桥接服务或
ComfyUI 离线而失败，而是自动回退到本地结构保真增强。

桥接层已经包含可自动切换的 `ControlNetLoader + ControlNetApplyAdvanced`
工作流。安装兼容权重后，只需设置 `COMFYUI_CONTROLNET_MODEL`，并可用
`COMFYUI_CONTROL_IMAGE` 选择 Depth 或 Edge；主 API、前端和数据契约均无需再改。

对于当前默认 `denoise=0.62` 的 img2img 链路，ControlNet 必须覆盖到采样结束，因此
`COMFYUI_CONTROL_END_PERCENT` 固定为 `1.0`。使用 `0.86` 时只有极短的有效区间，
实测可能退化为与纯 img2img 完全相同的结果。

2026-08-01 本机端到端回归结果：Blender 与四张控制图成功输出，SDXL Base 在
Apple MPS 上完成 16 步、1024 × 768 推理并恢复到 1536 × 1152；全任务约 66 秒，
其中 ComfyUI prompt 约 50 秒，结构边缘保留率 `0.9409`，质量门通过。

安装 `control-lora-depth-rank256.safetensors` 后的回归：ControlNet prompt 约
53 秒，全任务约 68 秒，结构边缘保留率 `0.9375`；相对纯 img2img 输出有
`82.5%` 的像素发生变化，证明 Depth ControlNet 已真实参与采样，而非仅被模型列表识别。

针对“白模变化过小”的写实重绘回归：将 denoise 提升至 `0.62`、采样提升至 28 步、
最长边提升至 1280，并增加白模／低模负面词后，床、沙发、餐椅、橱柜、木地板、绿植和
卫浴均由 SDXL 重建为写实对象。Apple MPS 上 ComfyUI prompt 约 140 秒，全任务约
155 秒；4px 原始边缘保留率 `0.6963`，使用写实模式 6px 容差后为 `0.7628`，质量门通过。

## 12. ArchViz + IP-Adapter + Refiner 回归（已实现）

本机最终链路：

```text
Blender RGB latent
  + Depth Control-LoRA 0.88
  + Juggernaut XL v9
  + IP-Adapter Plus SDXL ViT-H 精确风格迁移 0.60
→ 28 步基础采样
→ SDXL Refiner 20 步、denoise 0.20
→ 恢复 1536 × 1152
→ 结构质量门
```

参考图使用 `output/imagegen/interior-3d-one-bedroom.png`。桥接层会把非正方形参考图
等比放置到白色正方形画布，不执行中心裁切，因此不会丢失画面两侧的室内材质与光照
信息。IP-Adapter 使用 `IPAdapterPreciseStyleTransfer`，不使用构图迁移节点，降低参考
户型污染当前结构的风险。

2026-08-01 同一白模与 Depth 图的实机结果：

- provider：`comfyui-sdxl-controlnet-ipadapter-refiner`；
- 基础推理尺寸：1280 × 960，输出恢复为 1536 × 1152；
- ComfyUI prompt：约 244 秒；
- 6px 结构边缘保留率：`0.8648`；
- 布局漂移分：`0.1352`，质量门通过；
- 超过 8 灰度级的有效变化像素：`73.05%`；
- 平均绝对像素差：`17.9593`。

相较只使用 SDXL Base + Depth 的上一轮，边缘保留率由 `0.7628` 提高到 `0.8648`，
同时产生更完整的木地板、布艺、橱柜、家电、玻璃与接触阴影，证明风格参考与 Refiner
真实参与工作流，而不是只被健康检查识别。
