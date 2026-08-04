# AI 室内设计 V0.6 纯 AI 工作流技术方案

## 1. 目标

V0.6 将客户提出的设计流程组织为同一项目内连续派生的八个阶段。当前版本暂不使用
Blender 参与生产，阶段 3～5 全部由图像模型生成。历史 Blender 代码保留用于后续实验，
但不出现在默认产品入口，也不承诺 `.blend`、`.glb`、毫米级多机位或可编辑三维模型交付。

本次可执行范围是阶段 1～5，并统一收口到“AI 设计工作流”页面。阶段 6～8 只定义资产派生
方向和产品占位，尚未实现为完整的连续工作流；现有多材质蒙版编辑也不能被描述为阶段 8
已完成。

```text
01 草图与功能区标注
→ 02 AI 平面布局
→ 03 AI 彩平图
→ 04 AI 轴侧概念图
→ 05 AI 分空间效果图
→ 06 同空间风格版本
→ 07 同空间色调版本
→ 08 局部修改
```

## 2. 结构权威与生成基线

纯 AI 不等于只把上一张图片反复传给模型。每次生成都要重新携带以下权威输入：

1. 原始或已批准的平面布局图；
2. 人工确认后的 `semanticLayout`；
3. 阶段 4、5 必填的已批准彩平视觉基准图；
4. 可选风格参考图；
5. 当前变体的明确限制，例如只改变画法、相机、风格或色调。

`semanticLayout` 是结构事实，已批准布局图是二维几何与家具位置的视觉事实，已批准彩平图
是材质和设计语言基准。任何下游图片都不能仅依赖上一张 AI 图片重新推断结构。

### 2.1 阶段 1：功能区标注与结构确认

用户只需在工作流上传一次原始平面图。系统调用多模态视觉识别生成 `semanticLayout`，网页
继续提供房间、墙体、门窗、家具和尺寸的人工校正能力。只有完成语义核对并显式批准后，才
会把原图、功能区标注、总宽、总深和结构语义交给阶段 2；服务端将这些信息合成为类似
`流程/帧_47s19f.png` 的 Stage 01 控制图。阶段 1 获批后的任意上游修改都会使阶段 2～5
当前批准状态失效，但历史资产继续保留。
阶段 2 创建任务时校验原图 SHA-256、SemanticLayout 来源摘要、Stage 01 分析结果摘要与检测
边界，并把 Stage 01 分析任务登记为父任务，防止跨图片或跨分析版本拼接输入。

### 2.2 阶段 2：AI 平面布局

阶段 2 自动继承阶段 1 的原图、功能区标注、尺寸和 `semanticLayout`，无需重复上传。模型以
`plan/rooms/walls/openings` 为结构锁，阶段 1 的家具只作为现状参考，在同一户型上补充家具、
洁具、柜体、绿化和铺装，输出类似 `流程/帧_56s26f.png` 的专业黑白平面布局图。阶段 2 不会
读取或发送其他项目的完整户型范例；`referencePolicy=stage01_only` 且
`referenceImageCount=0`。用户批准的图片成为下游家具位置与视觉权威，审批结果持久化到
`layout` 资产，阶段 3 必须引用该已批准父资产。

## 3. 阶段 3：AI 彩平图

输入为已批准布局图、包含非空 `rooms` 的 `semanticLayout` 和可选参考图。一次任务可以生成
以下并行变体：

- `simple_2d`：简洁技术彩平；
- `topdown_3d`：照片级正交 3D 俯视；
- `watercolor`：水彩手绘彩平；
- `material_realistic`：写实材质彩平。

四种结果必须锁定房间数量、墙体拓扑、门窗位置、家具类别与主要家具占位。它们属于同一
`variantGroupId`，而不是四个独立项目。

## 4. 阶段 4：AI 轴侧概念图

输入为已批准布局图、非空 `semanticLayout.rooms`、必填的已批准彩平图，以及可选风格参考图。
MVP 提供：

- `isometric_day`：日景等轴测剖切；
- `isometric_night`：夜景等轴测剖切；
- `alternate_angle`：替代方向的轴侧视图。

这些图片用于概念沟通。AI 会尽量保持房间、家具和庭院关系一致，但不标记为真实三维相机
输出，也不宣称不同角度之间具备毫米级一致性。

## 5. 阶段 5：AI 分空间效果图

系统优先从 `semanticLayout.rooms` 读取稳定的空间 ID，用户可以多选客厅、卧室、厨房、
卫生间、阳台、庭院等空间。每个空间的生成请求同时携带全屋布局、对应房间语义、已批准
彩平图和统一风格参考，输出同一批次下的空间效果图。

已批准彩平图是阶段 5 的必填输入；不能只传轴侧图或上一张空间图替代。`rooms` 为空时服务端
直接拒绝任务，避免生成无法建立空间归属的图片。

空间图共享设计基线，但各自记录 `spaceId`。规划中的风格、色调和局部修改阶段将从具体
空间资产继续派生。

## 6. 资产谱系

```text
Project
└─ LayoutVersion
   └─ ColorPlanVariantGroup
      └─ VisualBaseline
         ├─ AxonometricViewGroup
         └─ SpaceRenderGroup
            └─ （规划中）StyleVariant
               └─ （规划中）ToneVariant
                  └─ （规划中）LocalEditRevision
```

阶段 3～5 的资产统一归入 `ai_workflow` 模块，并至少记录：

- `workflowStage`；
- `variantGroupId`；
- `projectId`；
- `parentAssetId`；
- `spaceId`；
- 变体 ID、Provider、模型、提示词版本和输入摘要；
- 人工确认状态及结构审计结果。

## 7. API

三个接口均使用 `multipart/form-data`，返回后台 `Job`，前端通过现有任务轮询接口等待结果。

```text
POST /v1/layouts/ai
POST /v1/ai-workflow/color-plans
POST /v1/ai-workflow/axonometric-views
POST /v1/ai-workflow/space-renders
POST /v1/assets/{asset_id}/approve
```

阶段 2 的 `/v1/layouts/ai` 必须接收 Stage 01 原图、人工批准的 `semantic_layout`、
`stage01_analysis_job_id`、`stage01_approved_version_id` 和 `stage01_detected_bounds`。服务端
会校验批准状态与任务谱系，将 `plan/rooms/walls/openings` 规范化为结构锁，并生成带功能区
覆盖层的单张控制图；不得携带其他完整户型参考图。布局方案经
`POST /v1/assets/{asset_id}/approve` 批准后，才可作为阶段 3 的 `asset_parent_id`。

统一上传字段包括 `approved_layout_image`、`semantic_layout`、`layout_approved`、可选
`project_id`、`asset_parent_id`、`approved_layout_version_id` 和重复上传的
`style_references`。彩平和轴侧通过 `variants` 选择并行变体；轴侧和空间效果必须上传
`approved_color_plan_image`；空间效果通过 `selected_space_ids` 选择要生成的空间。

其中 `layout_approved` 必须由客户端显式提交为 `true`，`semantic_layout.rooms` 必须为非空
数组。`approved_color_plan_image` 对阶段 4、5 均为必填，而不是可选参考图。若
`asset_parent_id` 指向 `ai_workflow` 资产，父资产还必须已经通过审批接口批准一个成功变体。

生成资产初始为 `review_required`。用户选中某个成功变体后，通过审批接口持久化
`approvedVariantId`、审批时间与 `approvedOutputUrl`；阶段 4～5 引用 AI 工作流父资产时，
后端会校验父资产已经批准。批次允许记录部分成功，前端会展示失败项并可仅重试失败变体。
任务在外部模型返回后会再次检查取消状态，被用户取消的任务不会转为成功或写入资产。

## 8. 产品文案边界

当前已实现的产品使用以下名称：

- AI 彩平图；
- AI 轴侧概念图；
- AI 分空间效果图。

阶段 6～8 实现后再使用以下预留名称：

- AI 风格版本；
- AI 色调版本；
- AI 局部编辑。

暂时不使用“精确三维”“真实三维相机”“可编辑模型”“多机位精确渲染”以及
“Blender/GLB 交付”等表述。AI 结果用于概念设计、客户沟通与效果预览，不作为施工尺寸、
材料色差或工程交付依据。
