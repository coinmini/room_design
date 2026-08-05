# MVP 完整代码评审报告

> 评审日期：2026-08-05
> 评审对象：AI 室内设计 MVP（FastAPI + React 19/Vite/TypeScript），分支 `agent/v0.2-floorplan-scene`
> 方法：6 个维度并行源码审计 → 每条发现由独立 agent 对抗性复核 → 综合
> 规模：13 个 agent，146 万 token，618 次工具调用，耗时 35 分钟
> 结果：**77 条发现通过验证，4 条被推翻**

---

## 实测基线

评审开始前实测确认的事实，作为全部结论的地基：

| 项 | 结果 |
|---|---|
| 后端测试 | ✅ **100 个全部通过**（`apps/api/.venv`） |
| 后端覆盖率 | 🟠 **68%**，低于自定的 80% 门槛；其中活的生成链路仅 **49%**，`_fanout_generate` **0%** |
| 后端 ruff | 🟡 12 项，多为 import 排序；B008 是 FastAPI 惯用写法的误报 |
| 前端 lint | 🔴 **35 项 / 33 error** |
| 前端测试 | 🟡 52 个 vitest（1.32 秒），但**从不进质量闸门** |
| `scripts/check.sh` | 🔴 **不可运行**——硬性要求 conda env `llf_v1`，而该环境 Pillow 9.5.0 的 `_imaging.so` 缺 `_jpeg_resync_to_restart` 符号 |
| CI | 🔴 不存在（无 `.github/`，无 `uv.lock`） |
| 鉴权 | 🔴 **完全没有**——`owner_id` 是硬编码常量 `LOCAL_OWNER_ID`，全应用唯一的 `Depends` 是数据库 session |
| `.local/artifacts` | 🟠 **962 MB / 1399 文件**，而两个 `.db` 均为 0 字节 → 957 MB 全是孤儿 |

前端 33 个 error 的分布（集中在新写的画布代码）：

```
11  react-hooks/set-state-in-effect
11  react-hooks/refs
 7  react-refresh/only-export-components
 3  react-hooks/exhaustive-deps      ← stale closure 温床
 1  react-hooks/immutability         ← 直接违反项目自定的不可变性规则
 1  typescript-eslint/no-unused-vars
 1  no-useless-assignment
```

---

## 评审维度分布

| 维度 | 发现数 | critical | high | medium | low |
|---|---|---|---|---|---|
| 安全与租户隔离 | 10 | 0 | 3 | 4 | 3 |
| 新画布代码正确性 | 14 | 0 | 5 | 6 | 3 |
| 架构与技术债 | 16 | 1 | 4 | 9 | 2 |
| 测试与质量闸门 | 11 | 2 | 7 | 1 | 1 |
| 数据模型与运维 | 13 | 0 | 5 | 6 | 2 |
| API 契约与前端质量 | 13 | 0 | 4 | 7 | 2 |
| **合计** | **77** | **3** | **28** | **33** | **13** |

> 另有 4 条初审发现被对抗性验证推翻，见附录 B。
> 上一轮延迟审计（[优化计划.md](优化计划.md)）的成果——并行扇出、增量发布、取消、重启回收、provider 信号量——已落地且工作正常，本报告不重复评审，只指出其中**未完成的部分**。

---

## 1. 总评

这是一个**功能上真的做完了**的 MVP：8 个生成阶段、批准血缘、增量发布、取消、重启回收、无限画布，100 个后端测试全绿，上一轮延迟审计的建议基本都落地了（`ai_workflow.py:29` 的并行扇出、`jobs.py` 的 `publish_progress`/`should_cancel`、`reclaim_stale_jobs`）。有几处是明确做得好的：03/06/07/08 阶段的批准闸门做了**逐字节 SHA 比对**（`main.py:852-866`），provider 侧有完整的 DNS 解析级 SSRF 防护（`kuyao_image_edit.py:417-452`）和上传魔数/像素炸弹校验（`storage.py:26-45`），`sanitize_provider_error_detail`（`processors/common.py:25`）对第三方错误做了白名单脱敏——这些都不是新手写法。

但这套代码的**验证结构是空心的**：五个核心生成阶段在测试里被 `_fake_workflow_processor` 整体替换（`tests/test_ai_workflow.py:57`），`ai_workflow.py` 覆盖率 49%，`_fanout_generate` 0%，前端 23k 行有效代码只有 12 个纯函数测试文件（约 7%），而项目自己的质量闸门 `scripts/check.sh` 因为绑定了一个 Pillow 已损坏的 conda 环境**根本跑不起来**。绿色的测试套件说明 API 守卫层是可靠的，但它对生成链路和整个前端一个字都没说。

**最重要的一件事**：`apps/api/app/assets.py:547-565` 的 `ensure_scene_asset` 在重新归档时只保留 5 个 approval 键，`variantApprovals` 不在其中，而 `main.py:96` 每次进程启动都会跑全量 `backfill_scene_assets()`——**每次重启都会静默、不可恢复地抹掉所有分叉变体的批准状态**，用户已经付费生成并批准的方案从此无法向下派生。一行修复，最高优先级。

**最大的风险**：这个系统只要离开 127.0.0.1 就是全裸的。没有任何认证、没有任何 principal 到请求的管线，`owner_id` 是个硬编码常量（`assets.py:16`），而 CSRF 今天在本地就已经可被利用——任何用户浏览的网页都能向本地 8000 端口提交 multipart 表单、无限消耗操作者的 gpt-image-2 额度。

---

## 2. 必须修

### P0-1 · 每次重启抹掉分叉变体的批准状态（数据丢失）
`apps/api/app/assets.py:547-565` 重建 metadata 时只回填 `approvalStatus / approvedVariantId / approvedVersionId / approvedAt / approvalComment`，`variantApprovals` 不在保留列表里，`_asset_metadata`（`assets.py:371-419`）也不产出它；`assets.py:575-577` 随后整体覆盖 `metadata_json`。触发点有两个：`main.py:96`（每次进程启动）和 `POST /v1/assets/backfill`（`main.py:1172`）。

后果链完整且不可逆：`canvas.py:56-63` 不再把这些变体标为已批准 → `canRunAction` 拒绝派生 → `_validate_parent_approved_space`（`main.py:896-920`）对任何引用该 version 的下游任务返回 409，用户看到的是一句无法理解的中文报错。`deliverables['variantApprovals']`（写于 `main.py:1428`）同样被抹掉，DB 里没有任何恢复源。

**修**：把 `"variantApprovals"` 加进 `assets.py:550-556` 和 `559-563` 两个保留元组。**同时补一个回归测试**——`test_ai_workflow_derivatives.py:344` 断言了分叉批准，但从未在其后跑 backfill，所以这个 bug 现在是零成本复现、零成本漏过。中期应把批准状态从 JSON blob 移出去（见 P1-5）。

### P0-2 · busy 标志有两个写入方 → 重复提交付费任务
`useResumeActiveJobs.ts:70-72` 设置 `busyRef.current = true`，并在**它自己的**任务结束时于 `:116-120` 清零；前台动作的重复提交守卫读的是同一个 ref（`useCanvasRunAction.ts:131-150`）。序列：用户启动一个 ~3 分钟的 `generate_space_render`，后台恢复轮询器捡到一个上个会话残留的 QUEUED 任务，20 秒后它终结 → `busyRef` 翻回 false、"执行中…"消失 → 用户再点一次生成 → **第二个完全相同的付费任务被提交**。

雪上加霜的是 `useResumeActiveJobs.ts:122-136` 把 `selectedId` 放进了 `useCallback` 依赖，而 `onNodeClick` 无条件 `setSelectedId`（`ProjectCanvas.tsx:772`），所以**用户每点一次节点，恢复轮询就中止并重启一次**：进度 toast 被"恢复 N 个进行中的生成任务…"覆盖、轮询请求翻倍，并且每一次中止都可能把 `busyRef` 卡在 true。

**修**：把 busy 改成引用计数（`busyCountRef++/--`），归零才清 UI 状态；把恢复 effect 只 key 在 `projectId` 上，`selectedId`/`loadGraph`/`applyGraph` 全部走 ref。两处都是小改动，一起做。

### P0-3 · 生成失败会删掉自己的占位节点，重试/丢弃 UI 因此永远不可达
`canvasRunner.ts:152-154` 在任务 FAILED 时 `throw`；`useCanvasRunAction.ts:636-639` 的 catch 第一件事就是 `clearSkeletonGroup(skeletonGroupId)`，且**不调用 `loadGraph`**。于是一次 4 图色彩方案或 11 图分空间渲染失败后，画布悄悄回到之前的状态，只留一个 toast；失败前已经成功生成、**已经付过钱**的图不会显示（后端 `canvas.py:388-396` 是会把它们作为 `isTemporary` 节点返回的，只是前端不去取）。

连带整片代码变成前台死代码：FAILED 骨架渲染（`CanvasNodeCard.tsx:54-58, 310-315, 345-353`）、重试（`useCanvasRunAction.ts:213-250`）、丢弃（`:189-211`）、`canRunAction.ts:131-146`。

同一个 catch 的另一半更糟：`useResumeActiveJobs.ts:105-112` 在轮询网络错误时**既不清骨架也不清 busy**，留下的 ≥2 个槽位被 `stackMath.ts:31-45` 折叠成堆叠卡，而堆叠卡不渲染操作页脚（`CanvasNodeCard.tsx:421`）、点击只会打开一个全是空图的画廊——一张永久"生成中"、无法重试也无法关闭的卡片，只能刷新页面。

**修**：catch 里不要清组，保留绑定到 FAILED 任务的槽位（`canvasRunner.ts:152` 已经打了 `jobStatus:'FAILED'`），并 `await loadGraph({fit:false})` 让部分产出显现；只在显式丢弃时清组。恢复轮询的 catch 里清组或标 FAILED。

### P0-4 · 所有 API 时间戳在 SQLite 上丢失时区 → 运行计时器永远显示 0分00秒
`models.py:34-42` 声明 `DateTime(timezone=True)` 并写入 `utc_now()` 的 aware 值，但 SQLite 方言静默丢弃 tzinfo，读回是 naive。实测 `POST /v1/projects` 返回 `"createdAt": "2026-08-05T14:29:13.206695"`——无 Z 无偏移。前端 `BatchProgress.tsx:23` 做 `new Date(since).getTime()`，UTC+8 机器上把它当本地时间解析 → 落在未来 8 小时 → `Math.max(0, ...)`（`:21`）钳成 0。

**每一次 1-5 分钟的付费生成，全程显示"0分00秒"**——整个产品最主要的进度反馈信号是死的。`ProjectsPage.tsx:38-47` 和 `HomePage.tsx:905` 的日期同样整体偏移。而且这个 bug 在 Postgres 上不复现，谁用 Postgres 调试都看不到。

**修**：在 `schemas.py` 的 `APIModel` 上加一个 datetime 序列化器（或 `Annotated[datetime, PlainSerializer(...)]`），naive 值统一补 UTC 后再 isoformat。加一条断言 `createdAt` 以 `+00:00`/`Z` 结尾的测试。

### P0-5 · 详情页"批准后派生"第一次点击必然失败
`ProjectCanvas.tsx:1290-1329`：`const target = layoutDetailLive` 在点击时捕获，`await runAction('approve', target)` 之后用**同一个陈旧对象**调派生，而所有派生入口都在传入的 node 上求值批准状态（`useCanvasRunAction.ts:277-280, 313-316, 349-352, 385-388, 431-437`）。用户看到"请先批准当前方案后再生成风格"——一句和刚刚发生的事情直接矛盾的报错；再点一次才成功。**每一条 03→08 的详情页派生路径都有这个额外点击**。

**修**：approve 之后从 `graphRef.current.nodes.find(n => n.id === target.id)` 重新取节点再派生。

### P0-6 · CSRF + 无上限请求体：本地今天就可被利用
两个缺陷共用一个攻击面，必须一起修：

- **CSRF**：`CORSMiddleware`（`main.py:115-121`）只管响应能否被读取，不阻止请求执行。跨源 `multipart/form-data` POST 是 CORS simple request，无预检直接进 handler。`create_white_model_job`（`main.py:2078-2111`）只强制 `source_image`，其余全有默认值（含 `generation_mode = "ai_quick"`，`:2085`），直通计费的 `edit_floorplan_image`（`image.py:355`）。没有 CSRF token、没有 Origin 校验、没有强制自定义头（`Idempotency-Key` 是可选的，`main.py:143`）、**全仓库没有任何限流**。8 个并发 worker、无界队列。用户浏览的任意页面（含广告 iframe）可循环烧光操作者的 kuyao 额度。
- **请求体无上限**：`storage.py:122` `data = await upload.read()` 先把整个上传读进一个 bytes，**之后**才在 `:125` 检查 20 MB。Starlette 对 >1 MB 的体会落盘暂存，所以 5 GB 上传先写满磁盘再整块进内存。没有 ASGI 层限制、没有反向代理。`create_ai_color_plan_job`（`main.py:1657-1665`）还接受 `list[UploadFile]`，7 个的上限（`main.py:964`）是在 FastAPI 解析完所有 part **之后**才检查的。

**修**：加中间件——拒绝 `Sec-Fetch-Site: cross-site` 的状态变更请求 / 校验 Origin 属于 `cors_origin_list`；把 `Idempotency-Key` 改成所有 POST 必填（自定义头强制预检，CORS 会正确拒绝）。`storage.py` 换成分块读取、超限即中止——同一个仓库的 `kuyao_image_edit.py:513-522` 已经把这件事做对了，抄过来即可。再加一个按 IP 的限流作为纵深防御。

### P0-7 · 用户看到的错误信息：三种坏形态
互为同一根因（错误在边界上没有被翻译），一起修：

1. **原始 Python 异常直出**：`jobs.py:295` `job.error_message = str(exc)`，经 `JobRead.error_message`（`schemas.py:63`）无过滤暴露，画布直接渲染（`CanvasNodeCard.tsx:351`、`:225`）。到这个分支的是 `OSError`/`cv2.error`/SQLAlchemy 异常，字符串里带绝对路径 `/Users/bolin/Documents/AI/room_design/.local/artifacts/...`、SQL 片段和库内部信息。**修**：`jobs.py:295` 换成固定文案（`error_code="GENERATION_FAILED"` 已经承载机器可读信号），`str(exc)` 只留在 `:288` 的 `logger.exception` 里。
2. **`[object Object]`**：`HomePage.tsx:486-489` 和 `ProjectsPage.tsx:194-198` 把 `detail` 当 `string` 用，FastAPI 422 返回的是数组 → `new Error([{...}]).message === "[object Object]"`。实测粘贴 >2000 字的设计描述即可触发（`schemas.py:25` 上限 2000，`HomePage.tsx:802-808` 的 textarea 无 `maxLength`）。**修**：两处都改用已有的 `apiError`（`workflow/media.ts:35`），textarea 加 `maxLength={2000}`。
3. **英文 Pydantic 原文**：所有 `Form(..., max_length=)` 校验失败返回 `"String should have at most 1000 characters"`，在全中文 UI 里出现且不指明字段（`media.ts:35` 丢弃了 `loc`）。**修**：前端给几个自由文本框加 `maxLength` 挡住；如果 Form 校验字段还会增加，再加 `RequestValidationError` handler 做中文映射。

### P0-8 · 局部编辑在元数据读取失败时静默回退到硬编码 `room_living`
`ProjectCanvas.tsx:543-551`：`let spaceId = 'room_living'`，只有 `resp.ok` 且拿到 `sid` 才覆盖。`GET /v1/assets/{id}` 失败或元数据无 `spaceId` 时，失败从不上报，这个猜测值直接流入付费任务的 payload。两种结局：要么把修改应用到恰好叫 `room_living` 的房间，要么用户收到一句关于自己从没选过的 spaceId 的 422（`schemas.py:328`），而真实原因（一次失败的 fetch）永远不显示。**修**：删掉字面量，查不到就 `setNotice` 并拒绝进入局部编辑。

### P0-9 · 无限画布不保存任何位置，而且生成完成会重排用户的布局
`layoutMath.ts:22-46` 纯按列/行索引算坐标，`ProjectCanvas.tsx:250-274` 每次 `applyGraph` 都用它重建全部节点位置，而 `applyGraph` 由 `useCanvasSkeletons.ts:159-163` 在**每一次任务轮询**（1 秒一次，`api.ts:283-292`）调度。节点是可拖的（`ProjectCanvas.tsx:271`），但拖动在生成期间**一秒内被复原**，任何时候刷新也一定丢失；新资产落地还会改变行索引，导致无关节点跳位。

后端持久化层完整存在却零调用者：`grep -rn "v1/canvases" apps/web/src` 返回 0 条。代价是 8 个端点（`main.py:2314-2497`）、2 张表（`models.py:135, 161`）、7 个 schema、80 行手写 DDL（`database.py:122-201`）、158 行测试全部无人使用——同时"空间化整理你的工作"这个无限画布的核心卖点不成立。

**修（二选一，不要两边都半成品）**：(a) 接上——挂载时读 `/v1/canvases?projectId=` 用存储坐标 seed，缺失的才 fallback 到 `layoutGraphByStage`，`onNodeDragStop` 防抖 flush 到 `PATCH /nodes/batch`；**接之前必须先修 P1-4 的 schema**，否则任何畸形坐标都是 500。(b) 砍掉——删掉 8 个端点、2 个模型、7 个 schema、DDL shim 和 `test_canvases.py`，只保留 `/canvas-graph`。最低限度的止血：`applyGraph` 里合并已有 `nodes` 的位置而不是覆盖。

### P0-10 · 04/05 阶段的批准闸门不校验字节，可把任意图片洗进已批准血缘
`create_ai_color_plan_job` 调 `_validate_parent_approved_layout`（`main.py:1691`），逐字节比对上传内容与父资产已批准输出的 SHA（`main.py:852-866`）；06/07/08 走 `_validate_parent_approved_space`（`main.py:1905, 1976, 2038`）同样严格。但 `create_ai_axonometric_job`（`main.py:1733-1786`）和 `create_ai_space_render_job`（`main.py:1798-1864`）接受两个上传，却只调 `_validate_parent_asset`（`:1749, :1819`）——只看父资产的 module/stage/approvalStatus，**从不碰上传的字节**。它们的 payload schema（`schemas.py:266, 272`）也缺少后续阶段强制的 `source_sha256` 字段。

结果：产品的核心不变式"只有已批准的产物能往下走"在第 4、5 阶段不成立，而画布上显示的批准溯源因此不可信；因为左右两个相邻阶段都做了校验，这个洞完全不可见。

**修**：两个端点补 `_validate_parent_approved_layout`，并新增形状相同的 `_validate_parent_approved_color_plan`；把 `source_sha256` 落进 payload。

### P0-11 · 运维两盲：日志全丢 + 产物永不回收
- **日志**：全仓库没有 `basicConfig`/`dictConfig`（grep 无结果），`scripts/dev.sh:37-41` 也没有 `--log-config`。uvicorn 的 LOGGING_CONFIG 不含 root，应用 logger 落到未配置的 root → `logging.lastResort`（level=WARNING）。**上一轮延迟审计加的所有 `logger.info` 计时全部被丢弃**（`jobs.py:255-260, :117` 等），幸存的 WARNING/ERROR 没有时间戳、级别和 logger 名。`main.py:98` 甚至直接用 `print` + `traceback.print_exc()`——而那正是 P0-1 静默毁数据的那段代码。**修**：加 `logging_config.py`（root=INFO，带 asctime/level/name），在 lifespan 第一行调用；`main.py:98-101` 换成 `logger.info` / `logger.exception`。
- **产物**：`grep unlink|rmtree|os.remove` 只命中两处 processor 临时文件清理。没有 TTL、没有孤儿清扫、没有用量上报；`delete_project`（`main.py:1071-1101`）明确"不物理删生成图"。当前工作区实测：`.local/artifacts` **962 MB / 1399 个文件，而两个 .db 都是 0 字节**——957 MB 全是无人引用的孤儿。真实部署会填满卷，之后每个任务在 `storage.py:131` 的 `write_bytes` 上抛未处理的 OSError。**修**：加 `maintenance.py`（孤儿文件集合差 + dangling row 检测），`POST /v1/maintenance/orphans?dryRun=true`，配置化保留期。

### P0-12 · 画布为每张卡下载 2-3 MB 原图
`canvas.py:80-81` `"thumbnailUrl": asset.thumbnail_url if url == full_url else None`——缩略图只对每个资产的代表图存在（`assets.py:538-543` 只对它调 `maybe_upgrade_thumbnail_url`），其余 3 张色彩方案、11 张分空间、所有风格/色调变体全是 `None`，前端于是回落到原图（`CanvasNodeCard.tsx:26`）。实测比例：`ai-local-edit-8fce1c221882.png` 2,736,152 B vs 其 webp 缩略图 9,270 B（**295×**）。ReactFlow 未开 `onlyRenderVisibleElements`（`ProjectCanvas.tsx:1110-1132`），11 个 `<img>` 全无 `loading="lazy"`，所以离屏节点也全量拉取——一个 16 变体项目开画布约 22 MB，就为了画 220×148 的卡片，且每次生成刷新重来。

**修**：归档多变体任务时对每个输出 URL 调 `ensure_thumbnails`，`canvas.py` 的 `make()` 按 `thumbnails.py` 的确定性命名解析各变体缩略图；同时加 `loading="lazy"` + 显式宽高 + `onlyRenderVisibleElements`。

---

## 3. 应该修

**P1-1 · 生成链路零测试（最大的质量缺口）**
`tests/test_ai_workflow.py:57` 用 `_fake_workflow_processor` 整体替换处理器（`monkeypatch.setitem(PROCESSORS, ...)` 于 `:214, 288, 328, 333, 338`），所以测试断言的是测试文件自己写的那个 dict。覆盖率证实：`run_ai_color_plan`(492-554)、`run_ai_axonometric`(562-643)、`run_ai_space_render`(663-776)、`run_ai_style_scheme`(878-949)、`run_ai_tone_scheme`(959-1023) 整段 MISSING；`_fanout_generate`(29-78) **0%**。从没跑过的关键分支包括：`ai_workflow.py:520-525` 的单变体失败转换（唯一挡住"一次 provider 超时炸掉整批"的东西）、`:496/:499` 的 ProcessorError 分支、扇出的输出重排序（`sorted(completed, key=...)`）、`should_cancel` 中途取消、`executor.shutdown(wait=not canceled)`。

正确的测试缝已经存在且已被证明可用：`test_ai_workflow_derivatives.py:398` 只 patch `_require_provider` + `_generate` 就跑通了真实的 `run_ai_local_edit`。照抄即可。`_fanout_generate` 单测约 60 行、无 HTTP 无 DB，价值最高——注意一个反直觉的契约：`generate_one` 抛出的异常会经 `future.result()` 重新抛出，随后 `finally` 的 `shutdown(wait=True)` 会**阻塞到所有在途 provider 调用结束**（每个最长 5 分钟），所以要测的是"非 ProcessorError 的意外异常不会挂住任务"。

**P1-2 · 质量闸门跑不起来 / 已写的测试不进闸门 / 没有 CI**
`scripts/check.sh:7-10` 硬性要求 conda env `llf_v1`，而该环境 Pillow 是 9.5.0（pyproject 要求 >=11）且 `_imaging.so` 缺符号——闸门不可运行。同时 `check.sh:20-22` 前端只跑 `lint` + `build`，**从不跑 `npm test`**，作者已经写好的 52 个 vitest（1.32 秒）完全不设防；`apps/web/scripts/` 里 6 个浏览器脚本（916 行）没有任何 npm script 或 shell 引用。仓库无 `.github/`，无 `uv.lock`。

**修（都很便宜）**：`check.sh`/`dev.sh` 改指 `apps/api/.venv/bin/python`（已验证可跑通全部后端与 enhancer 测试）；加一行 `npm test`；`uv lock`；`.coverage` 进 gitignore；加一个跑 ruff + pytest + `npm ci && lint && build && test` 的 GH Actions。

**P1-3 · JPEG / WEBP 上传解析器从未执行过一次，而假装覆盖它的 fixture 是个 PNG**
`storage.py` 覆盖率 46%，missing `50-65`（JPEG 分发 + 整个 WEBP VP8X/VP8/VP8L 分支）和 `69-108`（41 行手写 JPEG marker walker）。看起来像 JPEG 测试的 `tests/test_api.py:432-438` 读的 `example/平面图.jpeg` 实测前两字节是 `\x89P`——**是个改了扩展名的 PNG**，走的是 PNG 分支。仓库里 8 处 `cv2.imencode` 全用 `".png"`。四种允许格式里只有 PNG 被真正解析过。

这是产品的正门：手机拍的户型图和设计工具导出绝大多数是 JPEG。`_jpeg_dimensions` 遇到大 APP1/EXIF 段或渐进式 SOF2 返回 None → 用户拿到一句 415「无法解析上传图片」；返回错误尺寸则绕过 `:31-41` 的尺寸/像素上限直接进 OpenCV。**修**：用真实字节补单测（基线 JPEG、渐进式 JPEG、带大 EXIF 的 JPEG、截断 JPEG、三种 WEBP），与 Pillow 对拍；换掉那个说谎的 fixture；顺手拒绝扩展名与魔数不符的上传（`storage.py:116-131` 现在按文件名后缀决定白名单，再按同一后缀落盘）。

**P1-4 · 画布写入端点完全没有边界校验**
`CanvasNodeBatchPatch.nodes` 是 `list[dict[str, Any]]` 且无 `max_length`（`schemas.py:421`），`main.py:2465-2473` 直接 `float(item["x"])` / `int(item["z"])`。实测：`{"x": NaN}` 让 NaN 进入 UPDATE 并抛出 `IntegrityError` 到 handler 外（500 带栈），`"abc"` 抛 `ValueError`；未知 id 被 `continue` 静默跳过后仍返回 200。旁边就放着一个**从未被使用**的 `CanvasNodePatch`（`schemas.py:412`，在 `main.py:69` 被 import）。同一族问题：`create_canvas_node`（`main.py:2418-2442`）不校验 asset/job 是否存在（实测 `asset_DOES_NOT_EXIST` 返回 201 并落库），`create_canvas`（`:2319`）不校验 project 存在；`models.py` 声明了 7 个 ForeignKey，但 `database.py:15-25` 从不发 `PRAGMA foreign_keys=ON`（实测 `foreign_keys=0`），手写 DDL 也没有 REFERENCES 子句——**FK 全是装饰品**。

同一处还应一并处理 SQLite 的并发配置：实测 `journal_mode=delete`、`busy_timeout=5000`，而 `jobs.py:70` 跑 8 个 worker、每次增量发布都 commit，`database is locked` 是现实风险。**修**：typed batch item + 存在性校验 + `IntegrityError → 422`；加 `@event.listens_for(engine, "connect")` 发 `foreign_keys=ON` / `journal_mode=WAL` / `busy_timeout=30000`（开 FK 会暴露既有悬空行，配合 P0-11 的孤儿工具一起做）。**这是 P0-9 选择"接上持久化"分支的前置条件。**

**P1-5 · 批准状态是 JSON blob 上的读-改-写，并发批准会静默丢失**
`main.py:1260-1313` 读 `metadata_json` → 拷贝 `variantApprovals` → 插入 → 整体写回 commit；`:1348-1428` 的取消批准同形。没有版本列、没有 `SELECT ... FOR UPDATE`、没有唯一约束。画布上连点批准同一批的两个变体（很容易发生）会让后提交的覆盖前一个，早先那次批准**无错消失**；之后任何引用它的下游资产会被 `_workflow_approved_output`（`main.py:895-905`）以 409 拒绝，用户既看不懂也无法恢复。**修**：提升为真表 `asset_variant_approvals(asset_id, variant_id, ...)`，PK 在 `(asset_id, variant_id)`——顺带把 P0-1 的问题从根上消灭（重新归档再也碰不到批准状态），并把 `main.py:1267-1280` 手写的幂等检查变成约束。

**P1-6 · 没有迁移，schema 演进靠 4 个手写 ALTER shim**
`database.py:28-33` 是 `create_all` + 4 个 shim。`create_all` 只建缺失的表，**从不给既有表加列**。`scene_assets`——承载全部业务状态的表——一个 shim 都没有。`_ensure_canvas_tables` 还已经是死代码：它在 `create_all` 之后跑，`if not existing:` 永不成立，且其 DDL 与 `models.py` 已经分叉（JSONB vs JSON、无 FK 子句）。`conftest.py:10` 每次 unlink DB，所以测试只跑全新建表路径。下一个加到 `SceneAsset` 或 `Canvas` 上的字段会部署成功、100 个测试全绿，然后在任何既有数据库上第一次查询时抛 `no such column`。**修**：上 alembic（把现状 stamp 成初始 revision，4 个 shim 转成显式 revision）。最低限度：加一个 schema 一致性测试——`init_db()` 后反射实际列集与 `Base.metadata` 对拍，这在 sqlite 上今天就能拦住列漂移。

**P1-7 · 前端有状态代码零测试**
12 个 vitest 全是 `canvas/*.ts` 的纯函数。未覆盖：`canvasRunner.ts`（890 行，`runFloorplanAnalyze:158` + `executeCanvasAction:635`，整个提交/轮询/发布编排器）、`useCanvasRunAction.ts`（699）、`api.ts`（297）、`ProjectCanvas.tsx`（1578）及所有组件。`@testing-library/{react,jest-dom,user-event}` + `@playwright/test` 装了但零 import，`vite.config.ts` 甚至没有 `test` 块（`environment: 'jsdom'` 缺失，组件测试今天连挂载都做不到）。**修**：先补 `vi.mock('../api')` 下的 `executeCanvasAction` 单测（提交带 Idempotency-Key、SUCCEEDED/FAILED/CANCELED 都终止轮询、FAILED 产出用户可见 notice 而不是吞掉、cancel 真的调 `cancelJob`）——不需要 DOM，覆盖了本轮 P0-2/P0-3 的全部故障模式。

**P1-8 · E2E 有自我通过的断言，且绑死在某台机器的两个 project id 上**
`check_e2e_main.mjs:275-277` 的 `emptyNodes === 0 && (... || emptyNodes === 0)` 右析取项恒真；`:260` `step('spawn_ui', !hasApproved, ...)` **断言的是被测行为的否定**——spawn handle 不再渲染时，只要项目里没有已批准节点就判 PASS（本地常态）；`:213` 复述前一步结果；`:93` 断言 body 文本含"资产"，错误页也含。`report.ok = every(s => s.ok)` 把这些一起卷进退出码。同时 `:20-27` 把 `FULL`/`EMPTY` 默认成两个本地 project id，脚本无任何 seeding——而 `.local/` 是 gitignore 的，删库即全红。这就是这些脚本从没进闸门的真实原因。**修**：脚本开头自建项目并跑通 analyze→layout→approve 再断言；`:260` 改成硬失败并在 setup 里保证前置条件。

**P1-9 · 前端靠中文错误文案的子串做控制流**
`useCanvasRunAction.ts:640-646`：`message.includes('结构编辑器')` 重开结构编辑器，`message.includes('版本')` 把节点标记为 `upstreamChanged`。问题不止是脆——`版本` 分支**过宽**：`main.py` 至少有 4 处 409 含"版本"，其中 `:367`「资产缺少批准版本 ID」、`:405`「资产批准版本谱系不一致」、`:482`「SemanticLayout 版本不一致」都是内部一致性故障，与上游变更无关，却全被涂上"重新绑定基线"的引导，把用户带向错误的恢复路径。**修**：改成 `detail={"code": "APPROVED_VERSION_STALE", "message": ...}`（`ProcessorError.code` 已有此模式），前端按 code 分支。

**P1-10 · 前端用最多 24+ 次串行请求重建后端已有的血缘**
`canvasRunner.ts:239-352` 客户端走父链 `for (let i = 0; i < 12 && cursor; i++)`，每跳一次 `fetchAsset`，并嵌套调用 `resolveSemanticLayout`（`:94-116`，本身又是 fetchResume + fetchAsset + 向父递归）——**每一次 3-8 阶段生成在调用 provider 之前的串行往返数远超 24**。后端已经算好了完全一样的东西：`_workflow_resume_bundle`（`main.py:430`，234 行），暴露为 `GET /v1/assets/{id}/workflow-resume`，而 `canvasRunner.ts:77` 已经在为别的目的调它。更糟的是这是审批/血缘规则的第二份独立实现（另一种语言、零测试覆盖）。**修**：扩展 resume 响应带上已解析的 layout URL / version id / color-plan URL / semanticLayout，删掉 `canvasRunner.ts:90-118` 和 `:239-352`。

**P1-11 · 其余中等项**（同类合并，逐条都小）
- **前台动作不传 AbortSignal**：`executeCanvasAction` 支持 `signal`（`canvasRunner.ts:635-644`）但两个调用点（`useCanvasRunAction.ts:230-237, 531-590`）都不传，离开画布后仍以 1 req/s 轮询最长 30 分钟并向已卸载组件回调。
- **失败任务的残留节点删不掉且谎报成功**：`canvas.py:388-396` 对项目内**所有**终态且有 URL 的任务无时间/数量上限地发出临时节点；前端删除按钮对它们可用（`canRunAction.ts:136-146`）但 handler 只处理 `node.isSkeleton`，落到 `canvasRunner.ts:877-885` 返回 `{ok:true, message:'删除仅软删画布坐标节点（资产保留）'}`，随后 `loadGraph` 又把它取回来。
- **刷新后同一任务画两次**：`resumeActiveJobs.ts:70-99` 从 localStorage 恢复骨架，后端同时为同一 RUNNING 任务发临时节点，两者落进不同 stack key（`stackMath.ts:33-45`）不去重。
- **资产列表在 LIMIT 之后才用 Python 过滤**：`main.py:1148` 先 `.offset().limit()`，`:1151-1158` 再按 `module_key`/`workflowStage` 丢行。`limit` 上限 100 且前端无分页（`AssetLibrary.tsx:955`、`ProjectsPage.tsx:102`）。资产过百后，按 moduleKey 过滤可能返回空列表，用户无法从真实的已批准布局恢复工作流。把两个过滤下推 SQL 并返回总数。
- **jobs 表零索引**：`models.py:45-90` 没有一个 `index=True`，而 `canvas.py:388-398` 每次开画布/每次生成后刷新都跑 `project_id + type IN (13) + status IN (3) ORDER BY created_at` 全表扫描；对比 `SceneAsset`（`models.py:101-127`）索引齐全。加 `Index('ix_jobs_project_status', 'project_id', 'status')`——注意 `create_all` 不会给既有表建索引，要走迁移。
- **启动阻塞式全量 backfill**：`main.py:88-107` 在 `yield` 前跑无上限的 `backfill_scene_assets`，首次引入缩略图后还会同步 LANCZOS+WebP 编码所有历史图；此窗口内 `/health` 不响应。移到 readiness 之后或只保留 `POST /v1/assets/backfill`，并加 `WHERE NOT EXISTS` 限定为 O(新行)。
- **/health 不探任何依赖、启动无配置校验**：`main.py:969-1006` 只回静态布尔值，不查 DB、不 stat artifact_dir，且在 lifespan 完成前就能应答；`config.py:75-81` 在 import 期构造 Settings，`kuyao_api_key` 默认 `""`，未配置的部署照样报 `"status": "ok"`。拆 `/health/live` 与 `/health/ready`，加 Settings 的 `model_validator` 校验必需密钥。
- **CORS `allow_credentials=True` + 可配置 origin**：`main.py:115-121`，`cors_origin_list` 是无校验的逗号分割（`config.py:37, 45-47`）。已对照安装的 Starlette 1.3.1 确认：列表含 `*` 时会回显请求页自己的 Origin 并附 `Allow-Credentials: true`，**比字面 `*` 更糟**——一次为了调 CORS 而写下的 `CORS_ORIGINS=*` 就把 P0-6 的写入问题升级成全量跨源读取。当前没有任何东西用 cookie 或 Authorization 头，`allow_credentials=True` 一分钱好处都没有。设为 False，并在 `config.py` 里拒绝 `*`。
- **`cover_url` 无 scheme/host 校验**：`schemas.py:26, 35` 只限长度，`HomePage.tsx:675`/`ProjectsPage.tsx:88` 直接当图片源渲染。不是 XSS（React 拦 `javascript:`，全仓库无 `dangerouslySetInnerHTML`），但外部主机 cover 会让每次打开项目列表泄露访问者 IP/referrer。这是系统里唯一未校验的 URL 边界——`_artifact_path_from_public_url`（`main.py:732-743`）和 `_validate_download_url`（`kuyao_image_edit.py:417`）都做得很严。加 `pattern=r"^/artifacts/[A-Za-z0-9._-]+$"`。
- **`/examples` 静态挂载**：`main.py:139-142` 挂 `WORKSPACE_ROOT / "example"`，该目录不存在时 Starlette 直接 `RuntimeError` 导致**应用无法 import**（对比 `artifact_dir` 在 `config.py:74` 会 mkdir）。加 `is_dir()` 守卫，或把样例图挪进 `apps/web/public/`。
- **绝对宿主路径入库**：`main.py:1706, 1770, 1842` 把 `str(source)` 绝对路径存进 `Job.payload`，`retry_job`（`:2243-2251`）原样重放。`ARTIFACT_DIR` 是可配置的，改路径/容器化即让所有历史任务的重试失败于一句泛化的 GENERATION_FAILED。存 `/artifacts/<name>` 公共 URL，运行时再解析。
- **canvas-graph 无上限**：`canvas.py:312-318`（全部资产）、`:320-327`（`includeOrphans` 时并入**全库**孤儿资产）、`:388-398`（全部 partial job）三处都没有 LIMIT，每个资产还扇出到最多 12 个节点。
- **StrictMode 下的不纯 updater**：`useCanvasSkeletons.ts:35-46, 83-165, 171-201` 在 `setSkeletonSlots` 的 updater 内部写 ref、写 localStorage、`queueMicrotask(applyGraph)`。dev 下每次绑定双写。风险不是"两次重排结果不同"（结果相同），而是 React 丢弃某次渲染时 localStorage 已被写入，`useResumeActiveJobs` 读回一组从未提交的槽位。改成纯 updater + `useEffect` 同步。
- **局部编辑单击即标记"已标注"**：`LocalEditDock.tsx:362-366` 的 `onPointerDown` 走 `!drawing.current` 分支（只 `beginPath`/`moveTo` 不 `stroke`）却仍 `setHasMarks(true)`（`:180`）。不浪费钱（后端 `ai_workflow.py:1052-1057` 在调 provider **之前**提取掩码并给出明确中文报错），但客户端本该本地拦下。只在 `lineTo`/`stroke` 分支置位。
- **toast 与对话框的可用性**：`ProjectCanvas.tsx:1398-1400` 的两个 toast 无自动消失、无关闭按钮、无 `role="alert"`/`aria-live`；`GenerateLayoutDialog.tsx:172-178` 声明 `aria-modal` 却无 Esc、无 autoFocus、无焦点陷阱，而全局 Esc handler（`ProjectCanvas.tsx:908-937`）既不处理 `generateDialog` 又在 `:910` 对可编辑目标提前 return（对话框的 textarea 正是可编辑目标）。各约 10 行。
- **并发常量硬编码**：`jobs.py:70` `_JOB_EXECUTOR_MAX_WORKERS = 8`（全局生成并发上限，是唯一不在 config 里的并发旋钮，而隔壁 `provider_concurrency` 就在 `config.py:35`）、`ai_workflow.py:26` `_VARIANT_FANOUT_WORKERS = 4`。这两个直接决定吞吐与成本，提到 Settings。
- **三个端点声明了 `Idempotency-Key` 却从不读**：`main.py:1107`（GET）、`:1214`、`:1326`。功能风险为零，但 OpenAPI 在对生成的客户端撒谎——删掉这三个参数声明。
- **`french_luxury` 风格不可达**：`ai_workflow.py:92-97` 定义 4 个风格变体并在 `:156-161` 写好了完整 prompt，`workflow/constants.ts:24-28` 只有 3 个，画布按前端列表提交（`canvasRunner.ts:568-574`），后端默认值也写死 `[:3]`（`main.py:1878`）却校验 `maximum=4`（`:1901`）。这不算缺陷（可能是产品取舍），但暴露了 4 组变体枚举在两种语言里手工镜像且无漂移检测。加 `GET /v1/workflow/variants` 作为单一事实源，删掉手写列表。

---

## 4. 技术债地图

**规模现状**：15 个文件超过用户自定的 800 行硬上限，最大的 3827 行；前端 `src` 非测试代码 ~23,251 行，后端 6,216 statements。

### 4.1 可以直接删（约 10,000–11,000 行）

**A. V0.2 Blender/ComfyUI 管线 —— 约 5,950 行后端**
这条链路是闭环且无活调用者：`POST /v1/floorplan-scenes`（`main.py:1524`）只被 `FloorplanModule.tsx:2273` 调用，而它在 `!isWorkflowStage01` 块内，`isWorkflowStage01` 对画布使用的两种模式（`workflow-stage-01` / `canvas-focus`）都为真（`FloorplanModule.tsx:1034-1035`）；另一入口 `POST /v1/assets/{id}/renders` 要求 `generation_mode == 'structured_3d'`，只有携带 `use_blender` 的 FLOORPLAN_SCENE 任务会被赋予。`/health` 自己已经报 `"blenderWorkflowEnabled": False`（`main.py:983`）。

| 目标 | 行数 |
|---|---|
| `processors/blender_floorplan_scene.py` | 2,212（0% 覆盖，867 stmts，模块级 `import bpy` 决定它永不可在进程内 import） |
| `processors/floorplan_enhancement.py` | 951 |
| `floorplan.py:610-1370` + `run_floorplan_scene` | ~1,015 |
| `apps/enhancer/` | 1,524 |
| `processors/blender_scene.py` + `blender.py` | 243 |

**必须同步处理的引用点**：`jobs.py:43` PROCESSORS 条目、`floorplan.py:18-23` imports、`main.py:55, 971`（`/health` 的 enhancement_capability 换成静态 disabled）、`assets.py:337, 460`、`image.py:447-458`、`AssetLibrary.tsx:1149-1180` 和 `:1258`、`scripts/check.sh:15-17`、`scripts/dev.sh:24-30, 49-53`、`scripts/start-comfyui.sh`、以及 `test_model_delivery.py:78`、`test_api.py:1059, 1229-1260, 1406-1444`。副作用：后端覆盖率会从 68% 跳到 ~80%（那 946 条永不可执行的 statement 拉低了约 13 个百分点），质量闸门不再依赖第二个服务。

**B. 遗留向导与 V0.2 前端 —— 约 3,300 行**
`legacy/AiDesignWorkflow.tsx` 2,651 + `legacy/WorkflowAssetPicker.tsx` 等，加上 `FloorplanModule.tsx` 中 `!isWorkflowStage01` 的三段 JSX（`2423-2472`、`2791-2990`、`3588-3827`，约 490 行）及只服务它们的 7 个 state hook（`:1051-1071`）和提交 handler（`:2263-2320`）。**注意这是一次有意的功能下线，不是无操作清理**——这些区域在 `presentation='standalone'`（`App.tsx:1264`，`VITE_SHOW_LEGACY_TOOLS` 后面）时会渲染，必须与 A 同批次执行。

**C. 前端零散死代码 —— 约 200 行**
`SpikeCanvas.tsx` 及 `canvas/index.ts:2` 的导出、`workflow/actions.ts:193-210` 的 `runGeneration`（零调用者，且不像 `postAndPoll` 那样检查 FAILED）、`canRunAction.ts:192-204` 的空 if 块、`expandedStacks` 及其展开分支（`stackMath.ts:106-118`、`CanvasNodeCard.tsx:119-121, 151-163, 407-419`、`ProjectCanvas.tsx:229-236`，约 80 行——`setExpandedStacks` 只被 `collapseStack` 调用，永不可能非空）、`workflow/actions.ts:70` 重复的 `apiError`。

**D. 未使用的 npm 依赖 —— 7 个包**
`@tanstack/react-query`、`axios`、`konva`、`react-konva`、`react-hook-form`、`@hookform/resolvers`、`zustand` 在 `apps/web/src` 中零 import。**更正一个常见误判：它们不进 bundle**（Rollup 不打包未 import 的包），所以这不是性能问题，是安装/审计面和"这个项目用了状态库和表单库"的误导信号。`zod` 留下并真正用起来——29 处 `(await response.json()) as X` 是无校验断言，其中 `ProjectCanvas.tsx:351` 的 `as CanvasGraph` 是最值得先加 `safeParse` 的一个（后端形状变化目前表现为 React Flow 内部的 undefined 崩溃）。

**E. 画布持久化层 —— 约 900 行（仅在 P0-9 选"砍掉"分支时）**
`main.py:2314-2497`（8 端点）+ `models.py:135-201` + `schemas.py:365-421` + `database.py:122-201` + `test_canvases.py` 158 行。**先做 P0-9 的决策再动。**

### 4.2 必须拆（不能删的大文件）

| 文件 | 现状 | 拆法 |
|---|---|---|
| `main.py` | 2,497 | 按资源拆 APIRouter（路由分组已经天然成组）：`routers/{projects,assets,floorplans,ai_workflow,jobs,canvases}.py`；`:169-330` → `validation/forms.py`；`:666-960` → `validation/lineage.py`。**关键收益不是行数**：6 个 `create_ai_*_job` 端点（`:1556-2072`）结构完全相同（`_validate_parent_asset` → `_semantic_layout_form` → `_csv_values` → `save_upload` → `_validate_parent_approved_*` → `_validated_workflow_payload` → `create_job` → `dispatch_job`），只差 stage 名 / 变体元组 / payload model / job type 四个值——P0-10 那个安全缺口正是"给一个端点加了检查、另外五个没加"的产物。收敛成一个参数化 `_create_workflow_job` 才是真正的防御。 |
| `FloorplanModule.tsx` | 3,827 | 删 B 段 490 行后，抽 `floorplan/semanticGeometry.ts`（`:644-990` 的 12 个纯几何函数，已经无副作用且**目前零测试**——这是最高价值的一步且独立于任何删除决策）、`floorplan/FocusIcons.tsx`（`:142-235` 的 10 个内联 SVG）、`floorplan/useFloorplanResume.ts`（`:463, 537, 573`）。剩余约 2,000 行的编辑器壳仍需按画布层/工具栏/属性面板再拆一次才进 800。 |
| `ai_workflow.py` | 1,223 | `_base_result`（`:415-454`）与 `_derivative_result`（`:830-868`）是同一个 28 键 dict，只差 2 个键和 2 句文案；成功输出 dict 逐字重复 6 次；8 行校验前导重复 5 次（`:492, 562, 663, 878, 959`）。合并成 `_stage_result` + `_succeeded_output` + `_stage_preamble`，再拆 `ai_workflow/{prompts,fanout,local_edit}.py`。 |
| `ProjectCanvas.tsx` | 1,578 | 25 个 useState 喂给一个 30 字段的 hook（`useCanvasRunAction.ts:50-91`），同一批 27 个标识符在一个文件里**写了三遍**（对象字面量、解构、依赖数组）——约 90 行纯样板。**但不要为此做 useReducer 大重构**：这 27 个依赖全是稳定引用（setter 和 useCallback），依赖数组是惰性样板而**不是** stale-closure 隐患。先抽 overlay 组件（`structureEditor`/`layoutDetail`/`localEdit`/`stackGallery`/`panel`/`generateDialog` 本就互斥且已在手工互清，`:471-473`）。 |
| CSS 12,365 行 | `App.css` 5,721 + `home.css` 3,623 + `theme.css` 3,005 | 因为 `AppRouter` 静态 import 所有页面，Vite 输出单一 CSS bundle——**三个文件在每条路由都加载，类名冲突是全局的**。实测 App.css∩theme.css 52 个同名类、App.css∩home.css 46 个，`home.css:2031/:2076` 的注释直接写着"覆盖 App.css"。删掉 A/B 后 FloorplanModule 与资产库的双份样式自然消失一半。剩余部分再评估 CSS Modules。 |

### 4.3 跨语言重复（低优先，但会持续制造 bug）
工作流 DAG 被编码了 5 次：`main.py:150-157`、`canvas.py:185-195`、`web/src/canvas/activeJobs.ts:80-126`、`main.py:158-166` vs `canRunAction.ts:100-119`，外加 `_validate_parent_asset`（`main.py:693-715`）那条命令式 if 链——**命令式那条才是真正的权威，旁边的声明式 map 是装饰**。加第 09 阶段是一次五处协同修改。`_mapping` 在 `assets.py:74` 和 `canvas.py:20` 各一份（且行为不同：一个拷贝一个返回活引用），流式 SHA256 循环写了 4 遍（`main.py:420, 722`、`layout.py:210`、`ai_workflow.py:245`）。建 `app/workflow_graph.py` + `app/utils.py`。

---

## 5. 上线前检查清单

面向真实客户之前，下列每一项都必须为真。

**安全（离开 loopback 的硬前提）**
- [ ] 请求到 principal 的管线存在（哪怕先是一个 APIRouter 级的共享 bearer token 依赖）；`assets.py:662` 与 `main.py:1141` 的 `LOCAL_OWNER_ID` 字面量换成请求主体
- [ ] `Project` / `Job` / `Canvas` 加 `owner_id` 并在 `delete_project`（`main.py:1071`）、`approve_scene_asset_variant`（`:1210`）、`cancel_job`（`:2256`）、`delete_canvas`（`:2404`）上校验——**今天这些端点对任何调用方给出的任何 ID 都执行**
- [ ] 状态变更请求校验 Origin / `Sec-Fetch-Site`；或强制所有 POST 带自定义头
- [ ] ASGI 层请求体上限 + `storage.py` 分块读取；multipart part 数上限
- [ ] 生成类端点按 IP/按主体限流；**每日 provider 花费上限**（今天没有任何成本闸门）
- [ ] `allow_credentials=False`，`CORS_ORIGINS` 拒绝 `*`
- [ ] 启动时校验必需密钥（`kuyao_api_key` 现在默认 `""` 且照样报 ok）
- [ ] 用户可见错误不含 `str(exc)`（`jobs.py:295`）

**数据**
- [ ] P0-1 的 `variantApprovals` 修复已合并 **且有回归测试**
- [ ] alembic（或等价物）就位；`init_db` 不再靠 `create_all` + 手写 shim
- [ ] `.local/` 的 DB 与 artifacts 有备份策略（两者现在都在 gitignore 里，无任何备份叙述）
- [ ] SQLite 开启 WAL + `foreign_keys=ON` + `busy_timeout`；或迁移 Postgres（那条路径的手写 DDL **从未被任何数据库解析过**）
- [ ] `jobs` 表索引；`/v1/assets` 与 `/canvas-graph` 有分页/上限
- [ ] 产物保留策略 + 孤儿清扫（当前 962 MB 全孤儿）；磁盘用量告警

**运维**
- [ ] 日志配置存在（否则整个延迟审计的埋点是隐形的）
- [ ] `/health/live` 与 `/health/ready` 拆分；ready 真的查 DB 与磁盘
- [ ] 有部署产物（Dockerfile / systemd）：**必须单 uvicorn worker**（`jobs.py:150-151` 自述 `reclaim_stale_jobs` 仅支持单进程），带 `--timeout-graceful-shutdown`
- [ ] 启动 backfill 移出请求阻塞路径
- [ ] 明确记录：在此之前服务器**绝不允许**绑定非 loopback；`scripts/dev.sh` 已正确使用 `--host 127.0.0.1`，加断言固化

**质量闸门**
- [ ] `scripts/check.sh` 可运行（改指 `apps/api/.venv/bin/python`）且包含 `npm test`
- [ ] `uv lock` 提交，环境可在他机复现
- [ ] CI 存在
- [ ] 五个生成阶段 + `_fanout_generate` 有直调测试
- [ ] JPEG/WEBP 上传解析器有真实字节的单测；说谎的 fixture 已替换
- [ ] `--cov-fail-under=80`，并在 `[tool.coverage.run] omit` 里显式排除 Blender 模块（否则这个数字是假的）
- [ ] E2E 自建数据、不含自我通过的断言

---

## 6. 明确不做

- **ruff 的 B008「Do not perform function call File() in argument defaults」** —— FastAPI 的标准写法，是误报，不要改。
- **`/artifacts` 静态挂载的路径遍历** —— 已核对 Starlette 1.3.1 的 `lookup_path` 做了 realpath + commonpath 包含检查并拒绝绝对路径，且 `_artifact_path_from_public_url`、`maybe_upgrade_thumbnail_url`、`_resolve_source` 都把用户输入降到 `Path(x).name` 再拼接。这个面是干净的。同样地，`kuyao_image_edit.py:417-452` 的 SSRF 防护和 `storage.py:26-45` 的魔数/像素炸弹检查都做对了——不要动。
- **`ProjectCanvas` → `useCanvasRunAction` 的 30 参数依赖数组** —— 看着像 stale closure 灾难，其实 27 个依赖全部引用稳定（18 个 setter/ref + 若干 useCallback），只有 `projectId`/`designPrompt`/`selectedId` 是值依赖且都已列入。这是样板问题不是正确性问题，**不要以修 bug 的名义做 useReducer 大改**。
- **konva / react-konva 等未使用依赖的"打包体积"** —— 未 import 的包不进 bundle，运行时零成本。按依赖卫生清理可以，不要当性能优化排期。
- **68% 覆盖率这个数字本身** —— 其中 946 条 statement 来自永不可执行的 Blender 模块（模块级 `import bpy`）。删掉死代码后自然到 ~80%。**别为了抬数字去补 `blender_floorplan_scene.py` 的测试**；真正的数字是"活的生成链路只有 49%"。
- **Postgres 分支的手写 DDL 补测试** —— 默认是 sqlite（`config.py:15`），`.env.example:2` 的 Postgres URL 是注释掉的，而且 `create_all` 先跑使那些 DDL 在全新 Postgres 上恒为 no-op，所以 JSONB/TIMESTAMPTZ 的分叉从未到达任何服务器。要么上 alembic 让这四个函数整体消失，要么就留着——不要投入去覆盖注定要删的代码。
- **CSS Modules 全量迁移 / 响应式断点** —— 先删完 4.1 的 A/B 两段，冲突面会少一半，届时再评估。`App.css:59` 的 `body { min-width: 1120px }` 只需一行改成 `min-width: 0` 并把真正需要的最小宽度下放到依赖它的组件；这是桌面工具，不要为 `theme.css` 补移动端断点。
- **`_fanout_generate` 的架构本身** —— ThreadPoolExecutor + `as_completed` + 按输入序重排 + 中途取消检测，这个设计是对的。它需要的是测试，不是重写。
- **上一轮延迟审计的成果** —— 并行扇出、增量发布、取消、重启回收、provider 信号量都已落地且工作正常，不重复评审。本报告只指出其中**未完成的部分**（`_fanout_generate` 零覆盖、`logger.info` 因无日志配置而全部丢弃、失败路径吞掉部分产出）。
- **`WORKFLOW_NEXT_STAGES` 与 `_validate_parent_asset` 的 if 链"已经不一致"这一说法** —— 不成立：前者以 workflow stage 为键、只在 `main.py:655` 使用，而 `main.py:695` 的 `parent_module in {'layout','floorplan'}` 用的是 moduleKey，两套词表不同源。重复本身值得收敛（4.3），但没有现成的矛盾。
## 附录 A：77 条经验证发现

6 个维度并行审计，每条再由独立的对抗性验证 agent 逐条复核 file:line。证据与修法已节选。


### A.1 安全与租户隔离（10 条）

| 级别 | 工作量 | 问题 |
|---|---|---|
| 🟠 high | large | There is no authentication or authorization anywhere in the API; SceneAsset.owner_id is a hardcoded constant, not a request-derived principa … |
| 🟠 high | small | CSRF: any web page the user visits can trigger paid gpt-image-2 generations on the local server — exploitable today, no exposure required |
| 🟠 high | small | Upload size limit is enforced after the entire body is read into memory — unbounded request body is a trivial OOM |
| 🟡 medium | medium | Approval gate is enforced byte-for-byte for color plans but not for axonometric or space-render, so arbitrary images can be laundered into t … |
| 🟡 medium | small | Canvas batch-patch takes untyped dicts and coerces with bare float()/int(), producing unhandled 500s |
| 🟡 medium | small | Canvas nodes accept references to nonexistent assets and jobs; SQLite foreign keys are never enabled so the FK columns are decorative |
| 🟡 medium | trivial | Raw Python exception text is persisted as the job error and rendered verbatim in the UI |
| ⚪ low | trivial | CORS is configured with allow_credentials=True over an operator-settable origin list, so CORS_ORIGINS=* silently becomes 'any site can read … |
| ⚪ low | trivial | cover_url is stored and rendered as an image source with no scheme or host validation |
| ⚪ low | trivial | The /examples StaticFiles mount serves a repo directory unauthenticated and crashes startup if it is missing |

#### There is no authentication or authorization anywhere in the API; SceneAsset.owner_id is a hardcoded constant, not a request-derived principal

`🟠 high` ｜ 工作量 `large`

- **证据**：apps/api/app/main.py has ~45 routes and exactly one `Depends()` in the whole file — `SessionDep = Annotated[Session, Depends(get_session)]` (main.py:144). No HTTPBearer/APIKeyHeader/OAuth2/session/cookie code exists (`grep -rn "Depends(|HTTPBearer|APIKeyHeader|OAuth2|get_current_user" apps/api/app/*.py` returns only that one line), and apps/web/src/api.ts never sends an Authorization header. `SceneAsset.owner_id` (models.py:101) is written from a module-level constant `LOCAL_OWNER_ID = "local-user"` (assets.py:16) at assets.py:596, and is only ever read back as a literal filter: assets.py:662 (`get_local_scene_asset`) and main.py:1141 (`list_scene_assets`). It is never derived from a request, header, or session. Every asset row has the identical value, so the filter is a no-op. Projects, jobs, canvases and canvas nodes have no owner column at all: `delete_project` (main.py:1071), `approve_scene_asset_variant` (main.py:1210), `cancel_job` (main.py:2256), `delete_canvas` (main.py:2404) a …
- **影响**：Today, as a 127.0.0.1 single-user pilot, this is not exploitable by a remote party — but it is the single hard blocker to any exposure, and it is worse than 'auth not built yet': the owner_id column and the get_local_scene_asset helper create the appearance of tenancy that does not exist, so a future 'just add login' change would silently ship a system where user A reads, approves, and deletes user B's floor plans and renders. There is no request-to-principal plumbing to hang a check on. Anyone who can reach the port (LAN, --host 0.0.0.0, an ngrok/tailscale demo, a container port map) gets full read/write/delete of every project plus unlimite …
- **修法**：Before any non-loopback exposure: add a principal to the request (even a single shared bearer token as an APIRouter-level dependency is enough for the pilot), plumb it into owner_id at asset creation, add owner_id to Project/Job/Canvas, and replace the LOCAL_OWNER_ID literals at assets.py:662 and main.py:1141 with the request principal. Until then document that the server must never bind off-loopback and assert it in scripts/dev.sh (which today correctly passes --host 127.0.0.1).

#### CSRF: any web page the user visits can trigger paid gpt-image-2 generations on the local server — exploitable today, no exposure required

`🟠 high` ｜ 工作量 `small`

- **证据**：CORSMiddleware (main.py:115-121) restricts which origins may *read* responses; it does not block requests from executing. A cross-origin POST with Content-Type: multipart/form-data is a CORS 'simple request', sent with no preflight, so the handler runs regardless of Origin. `create_white_model_job` (main.py:2078-2111) requires only `source_image: UploadFile = File(...)`; every other field defaults, including `generation_mode: Literal[...] = Form("ai_quick")` (main.py:2085), which routes to `_run_ai_white_model` (processors/image.py:409 then 340) and calls the billed provider at image.py:355 `edit_floorplan_image(..., api_key=settings.floorplan_vision_api_key, model=settings.kuyao_image_model)`. There is no CSRF token, no Origin/Referer check, no required custom header (Idempotency-Key is optional, main.py:143), and no rate limiting anywhere in apps/api (grep for slowapi/limiter/rate_limit returns nothing). `/v1/floorplans/analyze` (main.py:1499) has the same shape.
- **影响**：This is the one issue fully exploitable in the current localhost single-user setup. While ./scripts/dev.sh is running, any site the user browses (or an ad iframe on it) can auto-submit a hidden multipart form to http://127.0.0.1:8000/v1/white-model-renders in a loop and burn the operator's kuyao credits — 8 concurrent job workers, unbounded queue, no rate limit. The attacker cannot read the responses and does not need to.
- **修法**：Add a middleware rejecting state-changing requests whose Origin / Sec-Fetch-Site is not in settings.cors_origin_list (reject Sec-Fetch-Site: cross-site outright). Alternatively require a custom header on all POSTs (e.g. make Idempotency-Key mandatory) — a custom header forces a preflight, which CORSMiddleware then correctly rejects. Add a per-IP rate limit on job-creating routes as defence in depth.

#### Upload size limit is enforced after the entire body is read into memory — unbounded request body is a trivial OOM

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/api/app/storage.py:122 `data = await upload.read()` reads the whole uploaded file into one bytes object; only afterwards, at storage.py:125, does it check `if len(data) > 20 * 1024 * 1024`. Starlette spools UploadFile bodies over 1 MB to a temp file, so a 5 GB upload lands on disk and is then loaded whole into RAM. There is no ASGI-level body limit (no size middleware in main.py, no proxy in scripts/dev.sh). Endpoints multiply this: create_ai_color_plan_job (main.py:1657-1665) accepts approved_layout_image plus `style_references: list[UploadFile]`, bounded only at 7 by _save_style_references (main.py:964) — and that bound is checked after FastAPI has already parsed every part.
- **影响**：One request kills the API process (OOM) and can fill the disk with spooled temp files. Combined with the CSRF finding, a malicious web page can do this from the user's own browser with no network access to the machine. Even benign: a user who drags in a 500 MB TIFF gets a hung server rather than a 413.
- **修法**：Reject early on Content-Length in a middleware, and replace the single .read() in storage.py with a chunked loop that aborts once the running total exceeds the cap — the codebase already does exactly this correctly for downloads, see _download_image in processors/kuyao_image_edit.py:513-522. Also cap the number of multipart parts before parsing.

#### Approval gate is enforced byte-for-byte for color plans but not for axonometric or space-render, so arbitrary images can be laundered into the approved lineage

`🟡 medium` ｜ 工作量 `medium`

- **证据**：create_ai_color_plan_job calls _validate_parent_approved_layout (main.py:1691), which hashes the uploaded file and rejects it unless byte-identical to the parent asset's approved output (main.py:852-866: `if approved_sha != upload_sha: raise HTTPException(409, ...)`). The derivative stages do the same via _validate_parent_approved_space (main.py:1905, 1976, 2038). But create_ai_axonometric_job (main.py:1733-1786) and create_ai_space_render_job (main.py:1798-1864) accept two uploads — approved_layout_image and approved_color_plan_image — and only call _validate_parent_asset (main.py:1749, 1819), which checks the parent's module/stage/approvalStatus but never touches the uploaded bytes. Their payload schemas AIAxonometricJobPayload and AISpaceRenderJobPayload (schemas.py:266, 272) also lack the source_sha256 field that AIWorkflowDerivativeJobBase (schemas.py:288) mandates for the later stages.
- **影响**：The product's core invariant — only an approved output moves downstream — is unenforced for stages 4 and 5. A client (or the CSRF vector above) can generate an axonometric or space render from any image while the resulting asset's lineage metadata asserts it descends from the approved color plan. Approval provenance shown in the canvas UI is therefore not trustworthy, and the gap is invisible because the two neighbouring stages do enforce it.
- **修法**：In both endpoints call _validate_parent_approved_layout for the layout upload, and add an equivalent _validate_parent_approved_color_plan (same shape: resolve the parent's approved output URL via _artifact_path_from_public_url, compare _sha256_file) for the color-plan upload; persist the resulting source_sha256 in the payload as the derivative stages already do.

#### Canvas batch-patch takes untyped dicts and coerces with bare float()/int(), producing unhandled 500s

`🟡 medium` ｜ 工作量 `small`

- **证据**：`CanvasNodeBatchPatch.nodes` is `list[dict[str, Any]]` with no max_length (schemas.py:421), and batch_patch_canvas_nodes coerces raw values directly: main.py:2465 `node.x = float(item["x"])`, likewise y/w/h at 2467/2469/2471 and `int(item["z"])` at 2473. A typed CanvasNodePatch model sits unused right above it (schemas.py:412). Verified by running the app against a temp DB: PATCH /v1/canvases/{id}/nodes/batch with `{"nodes":[{"id":"<real>","x":NaN,"y":2}]}` propagates NaN into the UPDATE and raises `sqlalchemy.exc.IntegrityError: NOT NULL constraint failed: canvas_nodes.x` out of the handler — a 500 with a stack trace, not a 422. float("abc") / int("x") behave the same. On PostgreSQL, double precision accepts NaN, so it would instead be stored and serialised as bare NaN in the JSON response, which the frontend's JSON.parse rejects — permanently breaking GET /v1/canvases/{id} for that canvas.
- **影响**：Low. A genuine boundary-validation gap — the only place in the API that bypasses pydantic — and a legitimate hit against the project's own 'validate at every system boundary' rule, but it sits on an endpoint with zero frontend consumers, so today it can only be hit by a hand-written request. Worth fixing because it is cheap (swap in a typed item model with allow_inf_nan=False and delete ten lines) and because it becomes user-reachable the moment the canvas UI starts persisting node positions.
- **修法**：Change CanvasNodeBatchPatch.nodes to list[CanvasNodeBatchItem] where the item model is CanvasNodePatch plus a required id: str, add max_length to the list, and constrain the floats with allow_inf_nan=False. Then delete the manual coercions at main.py:2464-2473.

#### Canvas nodes accept references to nonexistent assets and jobs; SQLite foreign keys are never enabled so the FK columns are decorative

`🟡 medium` ｜ 工作量 `small`

- **证据**：create_canvas_node (main.py:2418-2442) inserts asset_id and job_id with no existence lookup (it only checks the canvas). CanvasNode.asset_id/job_id are declared ForeignKey(...) (models.py:159, 167), but create_engine in database.py:19-23 never issues `PRAGMA foreign_keys=ON`, and the hand-rolled migration that actually creates the table (_ensure_canvas_tables, database.py:135-160) declares the columns as plain VARCHAR(40) with no REFERENCES clause. Verified empirically: POST /v1/canvases/{id}/nodes with `{"assetId":"asset_DOES_NOT_EXIST","jobId":"job_NOPE"}` returns 201 and persists the row. create_canvas (main.py:2319) likewise never checks that payload.project_id names a real project, and create_canvas_node ignores payload.canvas_id entirely in favour of the path parameter without checking they agree.
- **影响**：Dangling references accumulate silently and surface later as blank or broken cards in the infinite-canvas UI with no error path to explain them. It also means the DB cannot be trusted for referential repair after the delete_project unbind logic (main.py:1071-1103) detaches assets. Fails the project's own 'validate at every system boundary' rule.
- **修法**：Look up SceneAsset/Job in create_canvas_node and 422 on miss; look up Project in create_canvas; 409 when payload.canvas_id != canvas_id. Add an @event.listens_for(Engine, "connect") hook in database.py issuing PRAGMA foreign_keys=ON for SQLite, and add REFERENCES clauses to the _ensure_canvas_tables DDL.

#### Raw Python exception text is persisted as the job error and rendered verbatim in the UI

`🟡 medium` ｜ 工作量 `trivial`

- **证据**：apps/api/app/jobs.py:295, in the catch-all handler: `job.error_message = str(exc)`. Job.error_message is exposed unfiltered by JobRead.error_message (schemas.py:63) via GET /v1/jobs/{job_id} (main.py:2208) and GET /v1/jobs (main.py:2274), and the canvas renders it directly: apps/web/src/canvas/CanvasNodeCard.tsx:351 `{node.errorMessage?.slice(0, 48) || '请重试或检查上游'}` and CanvasNodeCard.tsx:225 `title={node.errorMessage || undefined}`. str(exc) on the exceptions that reach this branch — OSError, cv2.error, sqlalchemy errors — contains absolute filesystem paths (/Users/bolin/Documents/AI/room_design/.local/artifacts/...), SQL fragments, and library internals.
- **影响**：Users see untranslated Python internals instead of an actionable message, directly violating the project's 'user-friendly error messages in UI-facing code' rule. Once exposed it leaks the server's directory layout and OS username. Note the contrast with the provider adapters, which get this right — sanitize_provider_error_detail (processors/common.py:25) whitelists code/type/message and redacts the API key — so the pattern to copy already exists in the codebase.
- **修法**：At jobs.py:295 set a fixed user-facing message (error_code="GENERATION_FAILED" already carries the machine-readable signal) and keep str(exc) only in the logger.exception call at jobs.py:288, which already captures the full traceback server-side.

#### CORS is configured with allow_credentials=True over an operator-settable origin list, so CORS_ORIGINS=* silently becomes 'any site can read everything'

`⚪ low` ｜ 工作量 `trivial`

- **证据**：main.py:115-121 passes `allow_origins=settings.cors_origin_list, allow_credentials=True, allow_methods=["*"], allow_headers=["*"]`, where cors_origin_list is a plain comma-split of the CORS_ORIGINS env var (config.py:37, 45-47) with no validation. Confirmed against the installed Starlette 1.3.1: CORSMiddleware.send contains `if self.allow_all_origins and self.allow_credentials: self.allow_explicit_origin(headers, origin)` — with `*` in the list it echoes back the requesting page's own Origin plus Access-Control-Allow-Credentials: true, which is strictly worse than a literal `*`. Meanwhile nothing in the app sets or reads a cookie or Authorization header (apps/web/src/api.ts has no auth of any kind), so allow_credentials=True buys nothing today.
- **影响**：A single CORS_ORIGINS=* in a .env — the obvious thing to try when debugging a CORS error, and nothing warns against it — converts the CSRF-write problem above into full cross-origin *read* of every project, asset, and render for any website the user visits.
- **修法**：Set allow_credentials=False (nothing uses credentials), and reject `*` in cors_origin_list with a startup error in config.py. Narrow allow_methods to the verbs actually used.

#### cover_url is stored and rendered as an image source with no scheme or host validation

`⚪ low` ｜ 工作量 `trivial`

- **证据**：ProjectCreate.cover_url / ProjectUpdate.cover_url are `str | None = Field(default=None, max_length=500)` (schemas.py:26, 35) — length is the only constraint. create_project (main.py:1022) and update_project (main.py:1058) persist it verbatim, and it is rendered as an image source at apps/web/src/home/HomePage.tsx:675 and apps/web/src/home/ProjectsPage.tsx:88. Every other externally-supplied URL in the codebase is validated — _artifact_path_from_public_url (main.py:732-743) rejects any scheme or netloc, and _validate_download_url (kuyao_image_edit.py:417) does full DNS-resolution SSRF filtering — so this is the one unvalidated URL boundary.
- **影响**：Not XSS (React blocks javascript: in DOM attributes, and there is no dangerouslySetInnerHTML anywhere in apps/web/src). But a project cover pointing at an arbitrary external host turns every visit to the projects list into a beacon leaking the viewer's IP and referrer, and data: URIs let arbitrary content be stored in the project record. Low today; it becomes a stored cross-user vector the moment projects are shareable.
- **修法**：Constrain cover_url to a relative artifact path (pattern=r"^/artifacts/[A-Za-z0-9._-]+$" on the field matches how every other image URL in the system is shaped).

#### The /examples StaticFiles mount serves a repo directory unauthenticated and crashes startup if it is missing

`⚪ low` ｜ 工作量 `trivial`

- **证据**：main.py:139-142 mounts `StaticFiles(directory=WORKSPACE_ROOT / "example")` at /examples. Unlike settings.artifact_dir, which config.py:74 creates with mkdir(parents=True, exist_ok=True) at import time, nothing guarantees example/ exists — Starlette's StaticFiles.__init__ raises `RuntimeError: Directory ... does not exist` when check_dir=True (the default), so the app fails to import. The directory currently holds six sample images (example/平面图.jpeg etc.) but nothing scopes what is served from it.
- **影响**：Startup fragility on a fresh clone or a deployment that does not ship the sample assets, plus unauthenticated read of whatever a developer leaves in example/. Minor while it holds only sample floorplans. (The sibling /artifacts mount is NOT traversable — Starlette 1.3.1's lookup_path does a realpath + commonpath containment check and rejects absolute paths, and _artifact_path_from_public_url, maybe_upgrade_thumbnail_url and _resolve_source all reduce user input to Path(x).name before joining. That surface is clean, as is the provider SSRF defence in kuyao_image_edit.py:417-452 and the magic-byte/pixel-bomb checks in storage.py:26-45.)
- **修法**：Guard the mount with `if (WORKSPACE_ROOT / "example").is_dir():`, or drop the mount and copy the sample images into apps/web/public/ where they belong as frontend assets.


### A.2 新画布代码正确性（14 条）

| 级别 | 工作量 | 问题 |
|---|---|---|
| 🟠 high | small | A failed generation deletes its placeholders, so the entire retry/discard UI is unreachable and partial images stay invisible |
| 🟠 high | medium | Node positions are recomputed from scratch every poll tick; dragging a node is undone once per second and never persisted |
| 🟠 high | small | The busy flag has two independent writers: the background resume-poller clears it mid-generation, re-enabling duplicate paid submissions |
| 🟠 high | small | Clicking any node aborts and restarts active-job polling, duplicating requests and stomping the progress toast |
| 🟠 high | small | "Approve then derive" from the detail dock always fails on the first click because the derive re-checks a stale node object |
| 🟡 medium | medium | Partial-output nodes from failed/cancelled jobs are permanent: delete is a no-op that reports success |
| 🟡 medium | medium | Skeleton placeholders that survive a poll error are stacked, and stacks expose no actions and no matching slot — permanently stuck "生成中" car … |
| 🟡 medium | small | Foreground actions never pass an AbortSignal, so leaving the canvas keeps polling for up to 30 minutes |
| 🟡 medium | small | State updaters perform side effects and mutate refs, which React 18 StrictMode double-invokes |
| 🟡 medium | medium | The canvas downloads full-resolution PNGs for every card because thumbnails are only attached to one variant per asset |
| 🟡 medium | small | After a mid-generation reload the same running job is drawn twice: restored skeletons plus backend partial nodes |
| ⚪ low | trivial | batch_patch_canvas_nodes takes untyped dicts and casts them, turning bad input into a 500 |
| ⚪ low | trivial | A single click in the local-edit dock marks the image as annotated without drawing anything |
| ⚪ low | small | Stack expansion is dead code: expandedStacks can never become non-empty |

#### A failed generation deletes its placeholders, so the entire retry/discard UI is unreachable and partial images stay invisible

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/web/src/workflow/canvasRunner.ts:152-154 (`postAndPoll` calls `onJob(completed)` then `throw new Error(completed.errorMessage)` when the job ends FAILED). The throw lands in apps/web/src/canvas/useCanvasRunAction.ts:636-639, whose first act is `if (skeletonGroupId) clearSkeletonGroup(skeletonGroupId)` — every placeholder for that run is removed. The catch never calls `loadGraph`, so the backend's partial-output nodes (apps/api/app/canvas.py:388-396 returns FAILED jobs' already-written images as `isTemporary` nodes) are not fetched either. Net result: the FAILED-skeleton rendering (apps/web/src/canvas/CanvasNodeCard.tsx:54-58, 310-315, 345-353), the retry handler (useCanvasRunAction.ts:213-250), the discard handler (useCanvasRunAction.ts:189-211) and canRunAction.ts:131-146 are all dead code on the foreground path.
- **影响**：When a 4-image color-plan or 11-image space-render run fails (provider error, quota, timeout), the canvas silently reverts to its previous state with only a transient toast. Images that were successfully generated and paid for before the failure are not shown until the user reloads the page, and there is no way to retry the run from the failed node — the user must re-drive the whole flow from the parent.
- **修法**：In the catch at useCanvasRunAction.ts:636, do not clear the group: leave the slots bound to the FAILED job (bindSkeletonsToJob already stamped `jobStatus:'FAILED'` from canvasRunner.ts:152) and call `await loadGraph({fit:false})` so partial outputs appear. Only clear the group on explicit discard.

#### Node positions are recomputed from scratch every poll tick; dragging a node is undone once per second and never persisted

`🟠 high` ｜ 工作量 `medium`

- **证据**：apps/web/src/canvas/layoutMath.ts:22-46 assigns x/y purely from column index and row index. apps/web/src/canvas/ProjectCanvas.tsx:250-274 rebuilds every React Flow node with `position: {x: item.x, y: item.y}` on each `applyGraph`. `applyGraph` runs on every job poll: useCanvasSkeletons.ts:159-163 schedules it from `bindSkeletonsToJob`, which pollJob invokes every 1000 ms (apps/web/src/api.ts:274, 283-292). Backend persistence exists but is unused: `POST /v1/canvases`, `PATCH /v1/canvases/{id}/nodes/batch` (apps/api/app/main.py:2314-2478) — `grep -rn "canvases" apps/web/src` returns only the `canvas-graph` read at ProjectCanvas.tsx:346.
- **影响**：On an "infinite canvas" product, nodes are draggable (ProjectCanvas.tsx:271) but every drag is reverted within one second during generation, and always on the next refresh/visit. Row index also shifts when a new asset lands, so unrelated nodes jump. The whole W0-d canvas_nodes table plus five API endpoints are dead weight.
- **修法**：Load `/v1/canvases?projectId=` on mount, seed positions from `canvas_nodes`, fall back to `layoutGraphByStage` only for ids with no stored row, and flush `onNodesChange` position deltas (debounced) to `PATCH /v1/canvases/{id}/nodes/batch`. Until then, at minimum merge existing `nodes` positions in `applyGraph` instead of overwriting them.

#### The busy flag has two independent writers: the background resume-poller clears it mid-generation, re-enabling duplicate paid submissions

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/web/src/canvas/useResumeActiveJobs.ts:70-72 sets `busyRef.current = true; setBusy(true)` and 116-120 sets them back to false when *its* jobs finish. The foreground action guard reads the same ref: apps/web/src/canvas/useCanvasRunAction.ts:131-150 rejects a second `generate_*` only while `busyRef.current` is true. The resume hook is re-armed on every selection change (see next finding), so it runs concurrently with a foreground run.
- **影响**：Sequence: user starts `generate_space_render` (~3 min). A stale job from a previous session is still QUEUED/RUNNING server-side; the resume poller picks it up, and it terminates (reclaimed/failed) after 20 s. `busyRef` flips to false and the "执行中…" pill disappears while the real generation is still running. The user clicks 生成 again and a second, identical image-generation job is submitted — duplicated gpt-image-2 spend and duplicated skeleton groups.
- **修法**：Give the resume poller its own busy counter (or make busy a reference count, e.g. `busyCountRef++/--`), and only clear the UI busy state when the count reaches zero.

#### Clicking any node aborts and restarts active-job polling, duplicating requests and stomping the progress toast

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/web/src/canvas/useResumeActiveJobs.ts:122-136 lists `selectedId` (and `loadGraph`/`bindSkeletonsToJob`, which themselves close over `selectedId` — ProjectCanvas.tsx:365 and useCanvasSkeletons.ts:167) in the `useCallback` deps, and the effect at useResumeActiveJobs.ts:138-147 depends on `resumeActiveJobs`. `onNodeClick` calls `setSelectedId` unconditionally (ProjectCanvas.tsx:772).
- **影响**：MEDIUM. Directly visible: the 生成中 N/M progress toast is replaced by 恢复 N 个进行中的生成任务… every time the user inspects a node during a run, and job polling doubles. Its real severity comes from the coupling with [2]: each of these aborts can leave busyRef stuck true and lock out generation. Keying the effect on projectId only (refs for selectedId/loadGraph/applyGraph) fixes both.
- **修法**：Keep the resume effect keyed on `projectId` only: move `selectedId`/`applyGraph`/`loadGraph` behind refs (the file already receives `graphRef`), or store `resumeActiveJobs` in a ref and call `ref.current()` from an effect with `[projectId]`.

#### "Approve then derive" from the detail dock always fails on the first click because the derive re-checks a stale node object

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/web/src/canvas/ProjectCanvas.tsx:1290-1329: `const target = layoutDetailLive` is captured at click time, then `await runAction('approve', target)` followed by `await runAction(action, target)` with the *same* stale object (`target.approved === false`). The second call hits the approval gate on the pre-refresh copy: useCanvasRunAction.ts:313-316 (`generate_style_scheme`), 349-352 (tone), 385-388 (axonometric), 277-280 (space), 431-437 (dialog actions) — all evaluate `isVariantApproved(node) || nodeHasApprovedSpawnSource(node)` on the passed node, not on the refreshed graph.
- **影响**：User opens a 05 分空间 detail, clicks 生成风格方案 on an unapproved variant. The approve succeeds server-side, then the derive aborts with the misleading message 请先批准当前方案后再生成风格. The user must click the same button a second time (which then works, because `layoutDetailLive` has been re-resolved from the reloaded graph). Every 03→08 derive-from-detail path has this one-extra-click failure.
- **修法**：After `await runAction('approve', target)`, re-resolve the node from `graphRef.current.nodes.find(n => n.id === target.id)` and pass that (or pass `extras.spawnDialogConfirmed`/an `approvedVersionId` override) to the derive call.

#### Partial-output nodes from failed/cancelled jobs are permanent: delete is a no-op that reports success

`🟡 medium` ｜ 工作量 `medium`

- **证据**：apps/api/app/canvas.py:388-396 emits a temporary node for every FAILED/CANCELED/RUNNING job in the project that has any URL in its result — with no time or count bound. On the client, delete is enabled for those nodes (apps/web/src/canvas/canRunAction.ts:136-146, 258-262) but the handler in useCanvasRunAction.ts:189-193 only fires for `node.isSkeleton`; a temporary node falls through to executeCanvasAction, which returns `{ok:true, message:'删除仅软删画布坐标节点（资产保留）'}` (apps/web/src/workflow/canvasRunner.ts:877-885). The success path then calls `loadGraph` (useCanvasRunAction.ts:606) and the backend returns the node again.
- **影响**：MEDIUM. Clutter accumulates monotonically over a project's life and the UI actively lies about the deletion. Worth noting the button is only reachable for single-variant leftovers — a multi-image failed run folds into a stack (stackMath.ts:99, 122-137) whose footer is suppressed (CanvasNodeCard.tsx:421), so those cannot even be attempted. Minimum fix: return ok:false with a real message for delete on non-skeleton nodes, and bound the partial query (e.g. terminal jobs newer than N hours, or a dismissed flag).
- **修法**：Either persist a dismissal (e.g. `POST /v1/jobs/{id}/dismiss` setting a flag that `build_project_canvas_graph` filters on), or exclude terminal jobs older than N hours from the partial query; and make the client's `delete` return an explicit error instead of an `ok:true` message when nothing was deleted.

#### Skeleton placeholders that survive a poll error are stacked, and stacks expose no actions and no matching slot — permanently stuck "生成中" cards

`🟡 medium` ｜ 工作量 `medium`

- **证据**：apps/web/src/canvas/useResumeActiveJobs.ts:105-112: on a poll error (network blip, or the 30-minute timeout at apps/web/src/api.ts:294-296) the catch only calls `setNotice` — the group is never cleared and `busy` is never reset (the reset at line 116 is skipped only on abort, but `clearSkeletonGroup` is skipped in all error cases). Those leftover slots are ≥2 for every stage, so stackMath.ts:31-45 and :99 fold them into one `isStack` node; CanvasNodeCard.tsx:421 renders the action footer only `showFooter && !isStack`, and clicking the stack opens the gallery instead (ProjectCanvas.tsx:774-777). Even if a button were reachable, the discard/retry lookups `s.id === node.variantId || \`skeleton:${s.id}\` === node.id` (useCanvasRunAction.ts:194-197, 219-221) can never match a stack node, whose `variantId` is the literal `'stack'` (stackMath.ts:126) and whose id is the stack key.
- **影响**：After a transient network failure during a resumed generation, the canvas keeps a shimmering "布局 · 生成中 2 张" card that cannot be retried or dismissed by any interaction; clicking it opens a gallery of URL-less cells that answer 该节点没有可显示的图片. Only a full page reload clears it.
- **修法**：Clear (or mark FAILED) the skeleton group in the resume catch at useResumeActiveJobs.ts:105, and make the stack cover forward actions to its members — e.g. resolve the slot by `groupId` carried on the skeleton node rather than by `variantId`, and render the footer for stacks whose cover is a skeleton.

#### Foreground actions never pass an AbortSignal, so leaving the canvas keeps polling for up to 30 minutes

`🟡 medium` ｜ 工作量 `small`

- **证据**：`executeCanvasAction` accepts `signal` (apps/web/src/workflow/canvasRunner.ts:635-644, threaded into `postAndPoll`/`pollJob` at :150), but both call sites in apps/web/src/canvas/useCanvasRunAction.ts:230-237 and :531-590 omit it. `pollJob` therefore loops at 1 req/s until terminal status or the 30-minute cap (apps/web/src/api.ts:269-296), and its `onJob` callback keeps calling `bindSkeletonsToJob`/`setNotice`/`setBusy` and finally `loadGraph` on an unmounted component.
- **影响**：A user who starts a long space-render and navigates to /assets or another project leaves an untracked 1 Hz polling loop plus a graph reload firing into a dead component tree; several abandoned actions in a session compound it. The AbortController wiring already exists everywhere except at the call site.
- **修法**：Create an `AbortController` per run in `useCanvasRunAction`, pass `signal` into `executeCanvasAction`, store it in a ref, and abort it in a `useEffect` unmount cleanup in ProjectCanvas.

#### State updaters perform side effects and mutate refs, which React 18 StrictMode double-invokes

`🟡 medium` ｜ 工作量 `small`

- **证据**：apps/web/src/canvas/useCanvasSkeletons.ts:35-46 writes `skeletonSlotsRef.current = next` and calls `removeActiveCanvasJob` (localStorage write) *inside* the `setSkeletonSlots` updater; :83-165 does the same plus `upsertActiveCanvasJob` and `queueMicrotask(() => applyGraph(...))`; :171-201 also assign the ref inside updaters. apps/web/src/main.tsx:7 wraps the app in `<StrictMode>`, which invokes updaters twice in dev.
- **影响**：Violates the project's own purity/immutability rule and React's contract: in dev every skeleton bind writes localStorage twice and schedules two `applyGraph` passes, so what you debug is not what ships. If React ever bails out of a render, the ref and the state silently diverge — and `skeletonSlotsRef` is what `applyGraph` and the discard/retry lookups read.
- **修法**：Keep updaters pure (`return next` only), sync the ref in a `useEffect(() => { skeletonSlotsRef.current = skeletonSlots }, [skeletonSlots])`, and move `upsert/removeActiveCanvasJob` and the `applyGraph` scheduling into effects keyed on the resulting state.

#### The canvas downloads full-resolution PNGs for every card because thumbnails are only attached to one variant per asset

`🟡 medium` ｜ 工作量 `medium`

- **证据**：apps/api/app/canvas.py:80-81: `"thumbnailUrl": asset.thumbnail_url if url == full_url else None`. `fullUrl` is written once per asset, for the representative image only (apps/api/app/assets.py:538-543). Every other variant — the other 3 color plans, all 11 space renders, all style/tone variants — gets `thumbnailUrl: None`, and CanvasNodeCard.tsx:26 then falls back to `node.url` for a 220×148 card, while stack covers load up to three of them (CanvasNodeCard.tsx:29-32, 263-276).
- **影响**：Opening a mature project's canvas pulls tens of megabytes of full-size renders to draw thumbnail-sized cards, on every visit and after every generation refresh — slow first paint and heavy bandwidth on the exact screen that is supposed to feel instant.
- **修法**：Generate/lookup a webp thumbnail per variant URL (`maybe_upgrade_thumbnail_url` already does the work for a single path) and emit it in `expand_asset_variants`, instead of gating on `url == full_url`.

#### After a mid-generation reload the same running job is drawn twice: restored skeletons plus backend partial nodes

`🟡 medium` ｜ 工作量 `small`

- **证据**：On reload, `collectActiveJobsToResume` restores skeleton slots for RUNNING jobs from localStorage (apps/web/src/canvas/resumeActiveJobs.ts:70-99) while `build_project_canvas_graph` independently emits partial nodes for the same RUNNING job (apps/api/app/canvas.py:388-436). They land in different stack groups — `stack:skel:asset:{parentAssetId}:{stage}` vs `stack:job:{jobId}:{stage}` (apps/web/src/canvas/stackMath.ts:33-45) — so nothing dedupes them.
- **影响**：MEDIUM-LOW, small fix. Only bites when the user reloads mid-run after at least one image has landed (incremental publish), which is exactly the moment the incremental-preview feature was built for. Two cards claiming different counts for one job ('风格 · 生成中 3 张' next to '风格 · 2 张' partials) invites a wrong cancel or a duplicate re-run. Drop graph nodes whose jobId matches a live skeleton slot in buildCanvasFlow.
- **修法**：In `buildCanvasFlow`, drop graph nodes whose `jobId` matches a live skeleton slot's `jobId` (or key skeleton stacks by jobId so they merge with the partial stack).

#### batch_patch_canvas_nodes takes untyped dicts and casts them, turning bad input into a 500

`⚪ low` ｜ 工作量 `trivial`

- **证据**：apps/api/app/schemas.py:420-421 declares `nodes: list[dict[str, Any]]`; apps/api/app/main.py:2466-2477 then does `node.x = float(item["x"])`, `node.z = int(item["z"])` with no validation, so `{"id": "n1", "x": "abc"}` raises ValueError → 500. Unknown ids are silently skipped (:2461-2464) so a partially-applied batch reports success for the rows it happened to find, and the loop commits once at :2479 with no all-or-nothing guarantee.
- **影响**：LOW / trivial. No user impact today: grep confirms no frontend caller for /v1/canvases at all. Worth fixing as a two-line change (use the existing CanvasNodePatch plus an id field) and it becomes required the moment finding [1] is implemented and the frontend starts flushing drag deltas here.
- **修法**：Define a `CanvasNodePatch` model (`id: str`, optional floats/int) and use `list[CanvasNodePatch]`; return 404/422 listing ids that were not found instead of skipping them.

#### A single click in the local-edit dock marks the image as annotated without drawing anything

`⚪ low` ｜ 工作量 `trivial`

- **证据**：apps/web/src/canvas/LocalEditDock.tsx:362-366 `onPointerDown` sets `drawing.current = false` then calls `paintAt`, which takes the `!drawing.current` branch (`beginPath`/`moveTo`, no `stroke`) yet still calls `setHasMarks(true)` at :180. The submit button only checks `hasMarks` (:205-208, :287-292).
- **影响**：LOW / trivial — and materially milder than reported: no generation spend is wasted. The backend extracts the mask BEFORE calling the provider (ai_workflow.py:1162 then :1164) and _extract_mark_mask raises INPUT_REJECTED '未检测到红色标记区域，请先在浏览器中用画笔标出需要修改的部分' (:1052-1057) when no red pixels differ from the source, so the user gets a clear, fast, free failure. The defect is that the client should have blocked it locally instead of round-tripping a job. Fix: set hasMarks only in the lineTo/stroke branch.
- **修法**：Only set `hasMarks` once a stroke has actually been rendered (in the `lineTo`/`stroke` branch), or track drawn pixel count and require > 0.

#### Stack expansion is dead code: expandedStacks can never become non-empty

`⚪ low` ｜ 工作量 `small`

- **证据**：`setExpandedStacks` is only ever called from `collapseStack`, which deletes keys (apps/web/src/canvas/ProjectCanvas.tsx:229-236); `onExpandStack` is declared in `CanvasNodeData` (CanvasNodeCard.tsx:17) but never supplied, and clicking a stack always opens the gallery (ProjectCanvas.tsx:774-777). Consequently the expanded branch of `applyImageStacks` (stackMath.ts:106-118), the `stackExpanded` rendering (CanvasNodeCard.tsx:119-121, 151-163, 407-419) and `collapseStack` itself are unreachable.
- **影响**：LOW. No user-facing breakage — the stack gallery is a working alternative route to individual variants — so this is dead-code debt, not a defect: ~80 lines of UI plus a piece of state that reads as a live feature. It does cap the canvas's capability (a single stacked variant can never be positioned or acted on directly on the canvas), which matters if finding [1]'s manual positioning is ever implemented. Decide: wire an 展开 button, or delete expandedStacks/collapseStack/onExpandStack and the expanded branch.
- **修法**：Either wire an 展开 affordance on the stack card to `setExpandedStacks`, or delete `expandedStacks`, `collapseStack`, `onExpandStack/onCollapseStack` and the expanded branch of `applyImageStacks`.


### A.3 架构与技术债（16 条）

| 级别 | 工作量 | 问题 |
|---|---|---|
| 🔴 critical | trivial | Every API restart silently destroys forked per-variant approvals (variantApprovals) |
| 🟠 high | medium | Backend/frontend variant enums are duplicated by hand and have already diverged — the `french_luxury` style is unreachable |
| 🟠 high | large | The entire AI generation code path — including the recently-added parallel fan-out and cancellation — has zero test coverage |
| 🟠 high | medium | ~5,900 lines of the V0.2 Blender/ComfyUI pipeline and ~1,500 lines of apps/enhancer are unreachable from any production entry point |
| 🟠 high | large | FloorplanModule.tsx (3,827 lines) is live in the canvas and mixes the 01 structure editor with a dead standalone render page |
| 🟡 medium | large | ProjectCanvas.tsx: a 1,490-line component with 25 useState hooks drives a hook taking 30 props |
| 🟡 medium | large | main.py (2,497 lines) is one module holding 43 routes, 20 validation helpers and a 234-line lineage builder |
| 🟡 medium | medium | React state updaters in useCanvasSkeletons perform localStorage writes and schedule graph rebuilds — they are invoked twice under StrictMode |
| 🟡 medium | medium | Frontend control flow branches on substring matches of Chinese server error text |
| 🟡 medium | medium | The frontend re-derives asset lineage with up to 24 sequential HTTP calls, duplicating logic the backend already ships |
| 🟡 medium | medium | Six near-identical processors and two 95%-identical result builders in ai_workflow.py |
| 🟡 medium | small | Eight unused runtime npm dependencies ship in the bundle, including the Zod and testing tooling the project's own standards mandate |
| 🟡 medium | small | Load-bearing operational constants are hardcoded in module scope instead of Settings |
| 🟡 medium | large | 12,365 lines of unscoped global CSS across three files with 98 colliding class names and explicit override comments |
| ⚪ low | medium | Duplicated helpers and three parallel job-type→stage maps across the Python/TS boundary |
| ⚪ low | trivial | Dead no-op block in canRunAction and startup logging that bypasses the logger |

#### Every API restart silently destroys forked per-variant approvals (variantApprovals)

`🔴 critical` ｜ 工作量 `trivial`

- **证据**：`apps/api/app/main.py:96` runs `backfill_scene_assets()` on every startup, which loops all SUCCEEDED jobs into `ensure_scene_asset` (`apps/api/app/assets.py:505`). For an existing asset, `apps/api/app/assets.py:547-565` rebuilds metadata from scratch and re-hydrates only 5 keys (`approvalStatus`, `approvedVariantId`, `approvedVersionId`, `approvedAt`, `approvalComment`) plus 3 deliverables keys — `variantApprovals` is not in either list, and `_asset_metadata` (`apps/api/app/assets.py:371-419`) never produces it. Lines 575-577 then overwrite `existing.metadata_json`. Reproduced against the project venv: an asset with `variantApprovals = {style_modern_minimal: v1, style_natural_wood: v2}` came back as `None` after one `backfill_scene_assets` call, and `canvas.expand_asset_variants` then reported `[('style_modern_minimal', True), ('style_natural_wood', False)]`.
- **影响**：Confirmed data loss, and the trigger surface is wider than reported: besides main.py:96 (every process start), `POST /v1/assets/backfill` (main.py:1172-1175) reproduces it on demand. Scope is precisely the W0-X fork feature — the PRIMARY approval survives (its 5 keys are preserved), so the ordinary single-approval workflow is unaffected. What is lost is every non-primary approved variant: canvas.py:56-63 stops marking them approved, canRunAction blocks derivation from them, and _validate_parent_approved_space (main.py:896-920) 409s any downstream job whose source_space_version_id came from a forked variant. deliverables['variantApprovals'] (w …
- **修法**：Add `"variantApprovals"` to the preserved-key tuple at assets.py:550-556 and to the deliverables tuple at assets.py:559-563. Better: stop letting `ensure_scene_asset` own approval state at all — move approval fields into dedicated columns or a separate `asset_approvals` table so a re-archive pass can never clobber them, and add a regression test that runs `backfill_scene_assets` after a fork approval.

#### Backend/frontend variant enums are duplicated by hand and have already diverged — the `french_luxury` style is unreachable

`🟠 high` ｜ 工作量 `medium`

- **证据**：`apps/api/app/processors/ai_workflow.py:92-97` defines 4 style variants including `french_luxury`, with a fully authored prompt at `ai_workflow.py:156-161`. `apps/web/src/workflow/constants.ts:24-28` declares only 3. The canvas submits via `canvasRunner.ts:568-574`, which builds the request from the 3-element frontend list. The backend endpoint even defaults to `",".join(STYLE_SCHEME_VARIANTS[:3])` (`main.py:1878`) while validating `maximum=4` (`main.py:1901`). `french_luxury` survives only in `AssetLibrary.tsx:139` (a display label) and `legacy/AiDesignWorkflow.tsx:213` (the deprecated wizard). The same hand-mirrored duplication exists for COLOR_PLAN / AXONOMETRIC / TONE variants.
- **影响**：Downgrade from high to low/medium. No user-visible breakage and no data risk; one prompt-engineered style is simply not exposed in the production canvas (still exposed in the flag-gated legacy wizard). The durable point is the hand-mirrored enum duplication across four variant families (COLOR_PLAN/AXONOMETRIC/STYLE/TONE) in two languages with no drift detector — worth a single source of truth, but this instance is a product decision, not a defect.
- **修法**：Generate the frontend constants from the backend as the single source of truth: add a `GET /v1/workflow/variants` endpoint (or emit a `variants.ts` from a small codegen step over `ai_workflow.py`) and delete the hand-written lists in `workflow/constants.ts`. As an immediate stopgap, add `french_luxury` to constants.ts:24-28 plus a label at :34-38, and add a backend test asserting the endpoint's advertised variant set.

#### The entire AI generation code path — including the recently-added parallel fan-out and cancellation — has zero test coverage

`🟠 high` ｜ 工作量 `large`

- **证据**：`pytest --cov` over the full 100-test suite reports `app/processors/ai_workflow.py 424 stmts, 215 miss, 49%`, missing `48-78` (all of `_fanout_generate`: the ThreadPoolExecutor fan-out, progress publishing and the `should_cancel` branch), `492-554` (run_ai_color_plan), `562-643` (run_ai_axonometric), `663-776` (run_ai_space_render), `878-949` (run_ai_style_scheme), `959-1023` (run_ai_tone_scheme). The reason: `tests/test_ai_workflow.py:56` substitutes `_fake_workflow_processor` into `PROCESSORS`, and `tests/test_job_cancellation.py:26-35` cancels a fake WHITE_MODEL processor. Whole-backend coverage is 68% against the project's own 80% floor. On the frontend, all 12 vitest files are pure-function tests under `canvas/*.ts`; `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` and `@playwright/test` are installed (`apps/web/package.json:26-31`) with zero importing files, so ProjectCanvas, FloorplanModule, HomePage and canvasRunner have no automated coverage …
- **影响**：Confirmed as stated. Sharpening: _fanout_generate (ai_workflow.py:29-78) carries three non-obvious invariants that literally no test touches — output re-ordering via `sorted(completed, key=index)`, the forced `batchStatus='running'` on progress payloads, and `executor.shutdown(wait=not canceled)` on the cancel path. Those are exactly the semantics the latency audit added and the ones a future refactor is most likely to break. Whole-backend 68% vs the project's own 80% floor is real but partly an artifact of dead Blender code (see finding 3); excluding blender_floorplan_scene.py + blender_scene.py (946 never-executed stmts) coverage is ~80%, s …
- **修法**：Add unit tests for `_fanout_generate` directly with a fake `generate_one` covering: output ordering under out-of-order completion, `on_progress` publishing batchStatus=running, and `should_cancel` returning True mid-batch. Add per-stage tests that monkeypatch only `ai_workflow._generate` (the pattern already used at `tests/test_ai_workflow_derivatives.py:399-409`) rather than replacing the whole processor. On the frontend, add at least a Playwright spec for the 01→02→03 canvas path to replace the hand-rolled `apps/web/scripts/check_*.mjs` scripts.

#### ~5,900 lines of the V0.2 Blender/ComfyUI pipeline and ~1,500 lines of apps/enhancer are unreachable from any production entry point

`🟠 high` ｜ 工作量 `medium`

- **证据**：The V0.2 chain is a closed loop with no live caller. `POST /v1/floorplan-scenes` (`main.py:1524`) is called only from `FloorplanModule.tsx:2273`, which sits inside a `!isWorkflowStage01` block — and `isWorkflowStage01` is true for both `workflow-stage-01` and `canvas-focus` (`FloorplanModule.tsx:1034-1035`), the only two modes the live canvas uses. The other entry, `POST /v1/assets/{id}/renders` (`main.py:1442`), requires `generation_mode == 'structured_3d'` (main.py:1451), which `assets.py:460` only assigns to FLOORPLAN_SCENE jobs carrying `use_blender`. `apps/enhancer` is reached only via `FLOORPLAN_AI_ENDPOINT` from `floorplan_enhancement._http_enhance`, called only from `floorplan.py:1392,1458` inside `run_floorplan_scene`. `/health` already reports `"blenderWorkflowEnabled": False` (main.py:983). Line counts: blender_floorplan_scene.py 2212 (0% coverage, 867 stmts, imports `bpy` at module level so it can never be imported in-process), blender_scene.py 162, blender.py 81, floorplan …
- **影响**：Real and the largest single debt item, but reframe as 'flag-gated legacy surface' rather than 'unreachable dead code'. Concrete costs are confirmed: it contains the repo's single largest file (blender_floorplan_scene.py 2,212 lines, 0% executed), it is the sole reason backend coverage reads 68% instead of ~80%, and it makes the project's own quality gate depend on a second service (scripts/check.sh:15-17) — which matters given that gate is already unrunnable. Deletion is the right call, but it must be paired with removing the VITE_SHOW_LEGACY_TOOLS path rather than assuming nothing calls it. Severity medium-high as debt; zero user impact toda …
- **修法**：Delete `apps/enhancer/`, `blender_floorplan_scene.py`, `blender_scene.py`, `blender.py`, `floorplan_enhancement.py`, the `POST /v1/floorplan-scenes` and `POST /v1/assets/{id}/renders` endpoints, and `floorplan.py:602-1370` + `run_floorplan_scene`. What breaks and must be handled: `jobs.py:43` PROCESSORS entry, `floorplan.py:18-23` imports, `main.py:55,971` (`enhancement_capability` in /health — replace with a static disabled block), `assets.py:337,460` blender branches, `image.py:447-458` `_run_blender`, `AssetLibrary.tsx:1149-1180` `createVariant` + `assetFile(detail,'blendUrl',...)` at :1258, `scripts/check.sh:15-17`, `scripts/dev.sh:24-30, …

#### FloorplanModule.tsx (3,827 lines) is live in the canvas and mixes the 01 structure editor with a dead standalone render page

`🟠 high` ｜ 工作量 `large`

- **证据**：It is imported by `canvas/ProjectCanvas.tsx:26` and rendered at ProjectCanvas.tsx:1237 with `presentation="canvas-focus"` — so it is the production 01 editor, not legacy. The single default-export component runs from line 1024 to the end with 34 `useState` hooks (FloorplanModule.tsx:574-1085). Its scene/render half is gated off in every live mode: `!isWorkflowStage01` blocks at lines 2423-2472 (module header + upload form), 2791-2990 (generation-mode / render-quality / enhancement-strength controls), 3588-3827 (scene summary, structure check, enhancement provider display) ≈ 490 lines of JSX plus the state that feeds it (`generationMode`, `renderQuality`, `enhancementStrength`, `scene`, `style`, `camera`, `layoutPreset` at :1051-1071) and the submit handler at :2263-2320.
- **影响**：Confirmed, with one qualifier: the `!isWorkflowStage01` regions are not strictly dead — they render when presentation defaults to 'standalone' (App.tsx:1264, reachable behind VITE_SHOW_LEGACY_TOOLS). So step (1) of the fix is a deliberate feature removal, not a no-op cleanup, and must be sequenced with the finding-3 backend deletion. The maintainability cost is real and concrete: ~490 lines of JSX plus 7 state hooks that are inert in both shipping modes sit interleaved with the live 01 editor. Extraction step (2) — moving the six side-effect-free geometry helpers to a testable module — is the highest-value part and is independent of any delet …
- **修法**：Three concrete extractions, in order: (1) delete the `!isWorkflowStage01` regions (2423-2472, 2791-2990, 3588-3827) and the seven state hooks that only feed them — this removes the V0.2 UI along with the backend deletion above; (2) extract the pure geometry helpers already isolated at lines 644-990 (`roomFromBounds`, `cloneSemanticLayout`, `semanticRoomBounds`, `semanticPointToPixel`, `pixelPointToSemantic`, `semanticRoomPolygon`, `semanticRectFromPolygon`, `normalizeSemanticOpening`, `semanticWallToEditor`, `buildEditorWalls`, `editorWallsToSemantic`, `clampPoint`) into `floorplan/semanticGeometry.ts` and unit-test them — they are already si …

#### ProjectCanvas.tsx: a 1,490-line component with 25 useState hooks drives a hook taking 30 props

`🟡 medium` ｜ 工作量 `large`

- **证据**：`ProjectCanvasInner` runs from `canvas/ProjectCanvas.tsx:76` to :1566, with 25 `useState` calls at :87-135. It threads that state into `useCanvasRunAction` as a single object literal with 30 fields (`canvas/useCanvasRunAction.ts:50-91`), destructured again at :92-120, and re-listed a third time in the `useCallback` dependency array at :668-698 — the same 27 identifiers written out three times in one file.
- **影响**：Real as structural debt, but the stated failure mode is wrong and must not be quoted. All 27 dependencies are stable across renders — 18 are useState setters or refs (React guarantees setter identity), and the rest are useCallback results — so the dep array is inert boilerplate, not a live stale-closure hazard. Only projectId, designPrompt and selectedId are value deps, and all three are present. Corrected impact: ~90 lines of pure triple-maintained boilerplate and a 1,578-line component that is 2x the project's own hard limit; every new canvas interaction costs four coordinated edits. No correctness risk today. Downgrade to low/medium; the u …
- **修法**：Replace the 25 useState hooks with a single `useReducer` over a `CanvasUiState` ({overlay: 'none'|'structure'|'layoutDetail'|'localEdit'|'stack'|'panel', contextMenu, spawnMenu, notice, busy, ...}) — most of them are mutually exclusive overlays (`structureEditor`, `layoutDetail`, `localEdit`, `stackGallery`, `panel`, `generateDialog`, `spawnMenu`) that are already manually cleared against each other (e.g. ProjectCanvas.tsx:471-473). Then pass `dispatch` + `graphRef` to `useCanvasRunAction` instead of 30 setters, collapsing its signature to ~6 fields and its dep array to the same.

#### main.py (2,497 lines) is one module holding 43 routes, 20 validation helpers and a 234-line lineage builder

`🟡 medium` ｜ 工作量 `large`

- **证据**：`apps/api/app/main.py` mixes: app/lifespan setup (:88-147), form/payload validators (:169-330), the workflow resume bundle `_workflow_resume_bundle` at :430 spanning 234 lines, lineage/approval validators (:666-960), asset+approval routes (:1104-1492), floorplan routes (:1494-1554), six near-identical `create_ai_*_job` endpoints (:1556-2072), legacy render routes (:2073-2205), job routes (:2207-2291) and canvas persistence (:2296-2497). The six AI endpoints are structurally identical — compare `create_ai_style_scheme_job` (:1871-1938) and `create_ai_tone_scheme_job` (:1946-2007): same `_validate_parent_asset` → `_semantic_layout_form` → `_csv_values` → `save_upload` → `_validate_parent_approved_space` → `_validated_workflow_payload` → `create_job` → `dispatch_job` sequence, differing only in the stage name, variant tuple, payload model and job type.
- **影响**：Confirmed against the user's own explicit standards (800-line file max, 50-line function max), which this violates by 3x and 4-5x respectively. The concrete risk is the copy-paste endpoint family: the eight-step validation sequence is duplicated six times, so a security- or lineage-relevant check added to one endpoint is silently absent from the other five — and per finding 2, five of those six endpoints' happy paths are only exercised through fake processors. The APIRouter split is mechanical and low-risk; the parameterised _create_workflow_job helper is the part with real defect-prevention value. Note the reviewer's 'floorplan.py:_semantic_ …
- **修法**：Split into APIRouters by resource, which the route grouping already implies: `routers/projects.py`, `routers/assets.py` (list/detail/approve/unapprove/backfill, ~400 lines), `routers/floorplans.py`, `routers/ai_workflow.py` (the six create endpoints), `routers/jobs.py`, `routers/canvases.py`. Move :169-330 into `validation/forms.py` and :666-960 into `validation/lineage.py`. Then collapse the six AI endpoints onto one parameterised helper `_create_workflow_job(session, stage, payload_model, job_type, variants_tuple, lineage_fn, ...)` — the only genuine per-stage differences are the four values named above.

#### React state updaters in useCanvasSkeletons perform localStorage writes and schedule graph rebuilds — they are invoked twice under StrictMode

`🟡 medium` ｜ 工作量 `medium`

- **证据**：`main.tsx:7` wraps the app in `<StrictMode>`, which double-invokes state updater functions. `canvas/useCanvasSkeletons.ts:35-46` calls `removeActiveCanvasJob` (localStorage write) inside `setSkeletonSlots(current => ...)`. `:83-165` calls `upsertActiveCanvasJob` (localStorage write, :145) and `queueMicrotask(() => applyGraph(...))` (:160) inside the updater. `:65-75` also schedules `applyGraph` from within/around the updater, and `:38,67,137,185,199` assign `skeletonSlotsRef.current` from inside the updater. Line 31 additionally writes the ref during render.
- **影响**：Downgrade from medium/medium to low. The claim that 'the second rebuild races the first and can reorder node placement' is not supported — both rebuilds compute the same node/edge arrays from the same inputs. The real, narrower risk is the concurrent-rendering one: an updater invoked during a render that React later discards would still have written to localStorage, so the active-job record read back by useResumeActiveJobs could describe a slot set that never committed. That is a plausible but unobserved failure. Treat this as a correctness-hygiene refactor (make the updaters pure, move the writes to a useEffect keyed on skeletonSlots), not a …
- **修法**：Make the updaters pure. Compute the next slot array outside `setSkeletonSlots` (the inputs — `groupId`, `job`, `restored` — are all already in scope), then call `setSkeletonSlots(next)` with the plain value and perform `upsertActiveCanvasJob` / `removeActiveCanvasJob` / `applyGraph` / the ref assignment after it, or in a `useEffect` keyed on `skeletonSlots`. Drop the render-phase ref write at line 31 in favour of that effect.

#### Frontend control flow branches on substring matches of Chinese server error text

`🟡 medium` ｜ 工作量 `medium`

- **证据**：`canvas/useCanvasRunAction.ts:640-646`: `if (message.includes('结构编辑器') || message.includes('确认结构'))` reopens the structure editor, and `if (message.includes('下游') || message.includes('版本'))` marks the node `upstreamChanged`. `message` originates from `canvasRunner.ts:145` (`throw new Error(apiError(payload?.detail, ...))`), i.e. the raw FastAPI `HTTPException(detail=...)` string. The matched strings live in `main.py:837` ('提交的布局版本不是上游资产的已批准版本…'), `main.py:919`, `main.py:368,405,482` — plain prose with no stable contract.
- **影响**：Real, and the '版本' branch is worse than reported — it is over-broad, not just brittle. main.py raises at least four distinct 409s containing '版本': '资产缺少批准版本 ID' (:367), '资产批准版本谱系不一致' (:405), '资产链中的 SemanticLayout 版本不一致' (:482) and the intended '提交的空间图版本不是上游资产的已批准版本' (:919). Three of those are internal-consistency faults that have nothing to do with a changed upstream, yet all of them paint the node with the 'upstreamChanged / rebind baseline' badge, sending the user down a wrong recovery path. The reworded-message regression risk is real and untested in both suites. The structured-code fix is correct; it should also collapse the frontend-orig …
- **修法**：Return machine-readable codes: replace those `HTTPException(status_code=409, detail="…")` calls with `detail={"code": "APPROVED_VERSION_STALE", "message": "…"}` (the pattern already exists for processors via `ProcessorError.code`), have `apiError` surface `code` alongside `message`, and switch on the code in useCanvasRunAction.

#### The frontend re-derives asset lineage with up to 24 sequential HTTP calls, duplicating logic the backend already ships

`🟡 medium` ｜ 工作量 `medium`

- **证据**：`workflow/canvasRunner.ts:239-352` (`resolveLayoutLineage`) walks the parent chain client-side with `for (let i = 0; i < 12 && cursor; i += 1)`, issuing `fetchAsset(cursor)` per hop plus `resolveSemanticLayout(cursor)` until semantic JSON is found — up to 24 round-trips before a single generation is submitted. The backend already computes exactly this: `main.py:319` `_workflow_asset_chain`, `main.py:430` `_workflow_resume_bundle` (234 lines), exposed as `GET /v1/assets/{id}/workflow-resume` (`main.py:1193-1204`), which `canvasRunner.ts:77` already calls for a different purpose.
- **影响**：Confirmed, and the request count is understated. resolveSemanticLayout (canvasRunner.ts:94-116) is not one call — it does fetchResume(assetId), then fetchAsset(assetId), then recurses to the parent on miss, so it walks its own chain nested inside the outer 12-hop loop. Worst case is well over 24 serial round-trips before the provider call starts, on the critical path of every stage 3-8 generation. The duplicated-rules risk is the more serious half: two independent implementations of approval/lineage resolution in two languages, with the frontend copy having zero test coverage (all 12 vitest files are under canvas/, none touch canvasRunner). M …
- **修法**：Extend the `/v1/assets/{id}/workflow-resume` response to include the resolved layout URL, layout version ID, color-plan URL and semantic layout (it already assembles the chain), then replace `resolveLayoutLineage` and `resolveSemanticLayout` with one call to it. Delete canvasRunner.ts:239-352 and :90-118.

#### Six near-identical processors and two 95%-identical result builders in ai_workflow.py

`🟡 medium` ｜ 工作量 `medium`

- **证据**：`_base_result` (`ai_workflow.py:415-454`) and `_derivative_result` (`:830-868`) are the same 28-key dict differing only in `approvedLayout` vs `sourceSpace`+`spaceId` and two notice strings. The success dict inside `generate_one` — `{variantId, variantGroupId, status, url, provider, model, size, quality}` — is written out verbatim 6 times (`:526-535`, `:606-615`, in run_ai_space_render, `:919-930`, `:994-1005`, and in run_ai_local_edit). The 8-line validation preamble (`_require_provider()`, source resolution, empty-semantic check, variant membership check, `_target_size`, `_reference_paths`) repeats at `:492-501`, `:562-575`, `:663-685`, `:878-889`, `:959-969`. The file is 1,223 lines with `run_ai_space_render` at 119 lines and `run_ai_local_edit` at 99.
- **影响**：Real pure-debt finding, correctly scoped and not severity-inflated. Worth one sharpening on the stated failure mode: the claim that a field added to five of six 'will be silently dropped by canvas.expand_asset_variants' is not the real risk — expand_asset_variants reading only variantId/url/status means it is unaffected either way. The actual exposure is that the six stages' result dicts are the contract consumed by assets._asset_metadata, main.py's approval validators and the frontend's node builders, and there is nothing that asserts they share a shape; combined with finding 2 (all six stage functions at 0% coverage), a shape divergence shi …
- **修法**：Merge `_base_result`/`_derivative_result` into one `_stage_result(payload, *, stage, source_summary, semantic_layout, outputs, notice, audit_notice)`. Extract `_succeeded_output(variant_id, payload, generated, extra=None)` and use it in all six. Extract `_stage_preamble(payload, *, allowed_variants, source_resolver, label) -> StageContext` returning a frozen dataclass of (source, semantic_layout, variants, size, references). Then split the file: `ai_workflow/prompts.py` (the ~100 lines of VARIANTS + DESCRIPTIONS at :81-183), `ai_workflow/fanout.py` (`_fanout_generate`), `ai_workflow/local_edit.py` (`_extract_mark_mask`, `_restore_unmasked_pix …

#### Eight unused runtime npm dependencies ship in the bundle, including the Zod and testing tooling the project's own standards mandate

`🟡 medium` ｜ 工作量 `small`

- **证据**：Grepping `apps/web/src` for imports of each `dependencies` entry in `apps/web/package.json:13-25` returns 0 files for `@tanstack/react-query`, `axios`, `konva`, `react-konva`, `react-hook-form`, `@hookform/resolvers`, `zod`, and `zustand`. `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` and `@playwright/test` (`package.json:26-31`) likewise have zero importing files anywhere under `apps/web`.
- **影响**：Real, but the headline is factually wrong and must be corrected: unimported packages are never bundled by Vite/Rollup, so konva + react-konva are NOT '~350 KB in the bundle' and there is no runtime or load-time cost at all. The genuine cost is install/audit/lockfile surface and the misleading signal a reader gets about the app's architecture (a state library, a data-fetching library and a form library are all declared but unused). The substantive half stands on its own and is the reason to keep this: zod is installed while every API response crosses the boundary via a bare `as` cast at eight sites, directly violating the project's 'validate a …
- **修法**：`npm uninstall @tanstack/react-query axios konva react-konva react-hook-form @hookform/resolvers zustand`. Keep `zod` and actually use it: define schemas for `CanvasGraph`, `Job`, `SceneAssetDetail` in `api.ts` and replace the `as` casts with `.parse()`. Keep `@playwright/test` and port `check_canvas_mvp_paths.mjs` / `check_e2e_main.mjs` into real specs.

#### Load-bearing operational constants are hardcoded in module scope instead of Settings

`🟡 medium` ｜ 工作量 `small`

- **证据**：`apps/api/app/jobs.py:70` `_JOB_EXECUTOR_MAX_WORKERS = 8` — the global concurrency ceiling for all generation work, not overridable, while the adjacent `provider_concurrency` *is* in `config.py:35`. `ai_workflow.py:26` `_VARIANT_FANOUT_WORKERS = 4` and `:19` `MAX_PROMPT_CHARS = 28_000`. `ai_workflow.py:678` `if len(selected_ids) > 12` (max spaces per batch). `config.py:17-18` `blender_bin = "/Applications/Blender.app/Contents/MacOS/Blender"` with `blender_enabled: bool = True` — a macOS-only absolute path enabled by default in a product whose README says Blender is not the production path. `main.py:1466-1478` embeds Chinese camera/style display names inside the endpoint body. `home/HomePage.tsx:604-611` hardcodes `room_type='living_room'`, `style_preset_id='modern_minimal_v1'` and a default prompt for the homepage generate bar. `floorplan.py:632-633` (2% dimension tolerance), `:674` (`shape.area < 100_000`), `:675` (`plan_shape.buffer(5)`), `:689` (`min(600.0, max(60.0, thickness))`) e …
- **影响**：Real but low, and two of the impact claims are overstated. (a) 'blender_enabled=True means the API probes a macOS-only path on every FLOORPLAN_SCENE job on any other platform' — FLOORPLAN_SCENE is only reachable behind VITE_SHOW_LEGACY_TOOLS (finding 3) and /health already hardcodes blenderWorkflowEnabled: False, so on the shipping path this never executes; it is a stale default to delete with the dead code, not a live platform bug. (b) main.py:1466-1478 sits inside render_scene_asset_variant, part of the same legacy surface. What genuinely deserves promoting to Settings is the pair that shapes live throughput and cost: jobs.py:70 (global gen …
- **修法**：Move `_JOB_EXECUTOR_MAX_WORKERS`, `_VARIANT_FANOUT_WORKERS`, `MAX_PROMPT_CHARS` and the 12-space cap into `Settings` (they are already read at import time, so `settings.x` works directly). Hoist the floorplan literals into a named constants block at the top of `floorplan.py` (`PLAN_DIMENSION_TOLERANCE = 0.02`, `MIN_ROOM_AREA_MM2 = 100_000`, `PLAN_COVER_BUFFER_MM = 5`, `WALL_THICKNESS_RANGE_MM = (60.0, 600.0)`). Lift `camera_names`/`style_names` (main.py:1466-1478) to module constants next to the presets they mirror. Flip `blender_enabled` to `False` (or delete it with the dead-code removal above).

#### 12,365 lines of unscoped global CSS across three files with 98 colliding class names and explicit override comments

`🟡 medium` ｜ 工作量 `large`

- **证据**：`apps/web/src/App.css` 5,721 lines, `home/home.css` 3,623, `canvas/theme.css` 3,005. Extracted class names overlap: App.css∩theme.css = 52 shared classes (`floorplan-workspace`, `floorplan-stage`, `editor-toolbar`, `semantic-room`, `control-section`, `file-drop`, `is-ready`, `active`, …), App.css∩home.css = 46 (`asset-card`, `asset-gallery`, `asset-detail-panel`, `asset-library-shell`, …). `home/home.css:2031` and `:2076` carry comments literally reading '覆盖 App.css …' — the cascade is a deliberate dependency. `home/AssetsPage.tsx:4-5` imports both files, so behaviour depends on import order, while `home/ProjectCanvasPage.tsx:3` imports only home.css and `canvas/ProjectCanvas.tsx:23` only theme.css.
- **影响**：Real, and the mechanism is slightly different from — and broader than — described. Because AppRouter statically imports every page, Vite emits a single CSS bundle, so all three files load on every route regardless of which module imported them; the collisions are therefore global, not confined to /assets, and 'a CSS change can break a page that does not import the file' is true everywhere rather than on one route. Concrete maintenance cost is confirmed: FloorplanModule is styled twice (App.css standalone vs theme.css canvas-focus) and the asset library twice (App.css + home.css overrides), so every visual fix is a two-place edit or a regressi …
- **修法**：Adopt CSS Modules or a scoping prefix per surface — Vite supports `*.module.css` with zero config, and the class collisions are the whole problem. Concretely: (1) after deleting the standalone FloorplanModule UI, delete its now-orphaned rules from App.css and keep only the theme.css copies; (2) extract the ~46 shared asset-library classes into `assetLibrary.css` imported by AssetLibrary.tsx alone, and delete the `覆盖 App.css` override blocks at home.css:2020-2100; (3) rename remaining generic names (`active`, `notice`, `legend`, `is-ready`) into their component namespace.

#### Duplicated helpers and three parallel job-type→stage maps across the Python/TS boundary

`⚪ low` ｜ 工作量 `medium`

- **证据**：`_mapping` is defined identically in `assets.py:74` and `canvas.py:20`; `_as_mapping`/`_as_list` again in `processors/layout.py:42-48` and `processors/ai_workflow.py:194-200` (note the two variants differ: `canvas._mapping` copies via `dict(value)`, `ai_workflow._as_mapping` returns the caller's live dict). The streaming file-SHA256 loop is written four times: `main.py:420-424`, `main.py:722-726`, `layout.py:210-213`, `ai_workflow.py:245-249`. The job-type→workflow-stage mapping exists three times — `main.py:150-157` `WORKFLOW_STAGE_BY_JOB_TYPE`, `canvas.py:185-195` `_PARTIAL_STAGE_BY_JOB_TYPE`, `web/src/canvas/activeJobs.ts:80-126` (`actionFromJobType` + `workflowStageFromAction`) — and the stage-adjacency graph twice more: `main.py:158-166` `WORKFLOW_NEXT_STAGES` vs `web/src/canvas/canRunAction.ts:100-119` `allowedParentStagesFor`, with a third partial copy in the `_validate_parent_asset` if-chain (`main.py:693-715`).
- **影响**：Duplication is real; the 'already inconsistent' proof is not, and should be dropped. WORKFLOW_NEXT_STAGES is keyed by workflow STAGE and is used at exactly one site (main.py:655, eligible_next_stages in the resume bundle), whose key comes from _workflow_asset_stage — which can only return layout/color_plan/…/local_edit and never 'floorplan'. main.py:695's `parent_module in {'layout','floorplan'}` tests a moduleKey, a different vocabulary, so the two are not in contradiction. What remains is genuine: the workflow DAG is encoded five times across two languages, so adding stage 09 is a five-place edit, and the imperative if-chain at :694-717 is …
- **修法**：Backend: create `app/workflow_graph.py` holding one `STAGE_BY_JOB_TYPE` dict and one `ALLOWED_PARENT_STAGES` dict; rewrite `_validate_parent_asset`'s if-chain to look up `ALLOWED_PARENT_STAGES[workflow_stage]` and delete `WORKFLOW_NEXT_STAGES` and `_PARTIAL_STAGE_BY_JOB_TYPE`. Move `_mapping`/`_as_list` and `sha256_file` into `app/utils.py` and import everywhere (settle on the copying variant). Frontend: serve the same graph from the variants endpoint proposed above and delete `allowedParentStagesFor`.

#### Dead no-op block in canRunAction and startup logging that bypasses the logger

`⚪ low` ｜ 工作量 `trivial`

- **证据**：`web/src/canvas/canRunAction.ts:193-204` builds a `needsApproval` array of 7 actions, then `if (needsApproval.includes(action) && !approved && action !== 'set_baseline') { }` — an empty body containing only a comment. The array is never read again; the actual gate is the duplicate 6-element inline array at `:205-222`. Separately, `apps/api/app/main.py:98` uses `print(f"backfilled {count} scene assets")` and `:100-101` `import traceback; traceback.print_exc()` inside the lifespan handler, while every other module uses `logging.getLogger(__name__)` (e.g. `jobs.py:38`).
- **影响**：Real, trivial, and both fixes are one-liners. The logging half is worth more than its size suggests given finding 0: main.py:88-103 is the exact code path that silently destroys forked approvals, and a failure there is currently swallowed to stdout with no level and no logger name — invisible to any aggregation and, since the except is bare, non-fatal. The dead if-block is pure reader confusion with no behavioural effect (the duplicate array below enforces the same rule minus set_baseline). Low/trivial.
- **修法**：Delete canRunAction.ts:192-204 and hoist the remaining list at :206-213 into a module-level `const DERIVE_ACTIONS`. In main.py, replace `print` with `logger.info` and `traceback.print_exc()` with `logger.exception("startup asset backfill failed")`.


### A.4 测试与质量闸门（11 条）

| 级别 | 工作量 | 问题 |
|---|---|---|
| 🔴 critical | medium | The five core AI generation stages are stubbed at the processor level — their real code never executes in any test |
| 🔴 critical | small | No CI exists, and the project's own quality gate cannot run because it is pinned to an unrelated shared conda env |
| 🟠 high | trivial | check.sh runs `npm run lint` and `npm run build` but never `npm test` — the 52 frontend tests are ungated, as are all six Playwright scripts |
| 🟠 high | small | The upload boundary's JPEG and WEBP header parsers have literally never executed — and the fixture that appears to cover JPEG is actually a … |
| 🟠 high | small | The parallel fan-out / incremental-publish / cancel machinery from the latency audit is 0% covered |
| 🟠 high | medium | Measured backend coverage is 68%, twelve points below the self-imposed 80% floor |
| 🟠 high | small | The Playwright E2E contains four self-passing assertions, including one that is logically a tautology |
| 🟠 high | medium | E2E is hardwired to two pre-existing local project IDs, so it can never run on a clean machine or in CI |
| 🟠 high | medium | Zero frontend tests for any stateful code: the 890-line canvas runner, the 699-line action hook, the API client and every React component ar … |
| 🟡 medium | medium | Hand-written Postgres DDL is 0% covered, and _ensure_canvas_tables is a no-op that cannot add columns |
| ⚪ low | trivial | Three endpoints declare an Idempotency-Key header that is silently discarded |

#### The five core AI generation stages are stubbed at the processor level — their real code never executes in any test

`🔴 critical` ｜ 工作量 `medium`

- **证据**：tests/test_ai_workflow.py:57 defines `_fake_workflow_processor(stage)` which returns a hand-written result dict, and it is installed wholesale via `monkeypatch.setitem(PROCESSORS, ...)` at lines 214, 288, 328, 333, 338. Coverage confirms the consequence: app/processors/ai_workflow.py is 49% covered with the entire bodies of `run_ai_color_plan` (492-554), `run_ai_axonometric` (562-643), `run_ai_space_render` (663-776), `run_ai_style_scheme` (878-949) and `run_ai_tone_scheme` (959-1023) reported as MISSING. No test anywhere patches `app.processors.ai_workflow.edit_floorplan_image` or `ai_workflow._generate` for these five stages — grep over tests/ returns hits only for `app.processors.image`, `app.processors.layout` and `app.processors.floorplan_enhancement`. The correct seam already exists and is already proven: tests/test_ai_workflow_derivatives.py:398 and :488 patch `ai_workflow._require_provider` + `ai_workflow._generate` and call the real `run_ai_local_edit`, which is why local edit …
- **影响**：Confirmed and the single most consequential gap in the suite. The tests assert against a hand-written dict that the test file itself authored, so every contract the fake fabricates — `variantGroupId` propagation, `count`/`succeededCount`/`failedCount`/`batchStatus` consistency, `approvedLayout.sha256`, `inputRoles`, output ordering — is validated against the fake, not the code. Concretely: the ProcessorError branches at ai_workflow.py:496 and :499 (empty semanticLayout, invalid variant type) have never run, nor has the per-variant failure conversion at :520-525, which is the only thing standing between a single provider timeout and a whole ba …
- **修法**：Add tests that call `run_ai_color_plan` / `run_ai_axonometric` / `run_ai_space_render` / `run_ai_style_scheme` / `run_ai_tone_scheme` directly with only `ai_workflow._require_provider` and `ai_workflow._generate` monkeypatched — copy the pattern from tests/test_ai_workflow_derivatives.py:398. Assert on the real contract: output ordering matches the requested variant order, `count`/`succeededCount`/`failedCount`/`batchStatus` are consistent, a `_generate` raising `ProcessorError` produces a `status: "failed"` output rather than aborting the batch, and `approvedLayout.sha256` / `semanticInput.sha256` are computed from the real inputs. Then keep …

#### No CI exists, and the project's own quality gate cannot run because it is pinned to an unrelated shared conda env

`🔴 critical` ｜ 工作量 `small`

- **证据**：There is no `.github/`, no GitLab/Circle/Travis config anywhere in the repo (verified by `ls -a` and a find for workflow YAML). scripts/check.sh:7-10 hard-exits unless `CONDA_DEFAULT_ENV == llf_v1`. I reproduced the breakage: `~/miniconda3/envs/llf_v1/bin/python -c "from PIL import Image"` fails with `ImportError: dlopen(.../PIL/_imaging.cpython-312-darwin.so, 0x0002): symbol not found in flat namespace '_jpeg_resync_to_restart'`. Root cause of the divergence: llf_v1 has Pillow **9.5.0** while apps/api/pyproject.toml declares `Pillow>=11` — llf_v1 was never installed from pyproject at all; it is a hand-curated env shared across the user's other projects (`conda env list` shows charge/develop/image/japan/llf_v1), and its conda-linked Pillow 9.5.0 lost its libjpeg symbol when another package replaced the jpeg lib. Every other API dependency (fastapi, sqlalchemy, shapely, ortools, cv2, numpy, httpx, psycopg, pydantic_settings, multipart, pytest_cov) imports fine in llf_v1 — Pillow is the …
- **影响**：Downgraded from critical to medium, and narrowed. The unrunnable-gate half is baseline. What survives: this repo has zero automated verification of any kind, and the backend environment cannot be reproduced on another machine (no uv.lock, no requirements.txt) even though the working .venv exists. For a single-developer local pilot the missing GitHub Actions workflow is a process gap rather than a live defect — the actionable, cheap items are `uv lock` in apps/api, adding `.coverage` to .gitignore, and repointing check.sh/dev.sh at `apps/api/.venv/bin/python` so the gate becomes runnable at all (which is the prerequisite for findings [2] and [ …
- **修法**：Delete the conda guard from scripts/check.sh:7-10 and drive everything from the project venv: `API_PY="$PROJECT_ROOT/apps/api/.venv/bin/python"`, run `$API_PY -m ruff check .` and `$API_PY -m pytest` in apps/api, and reuse the same interpreter for apps/enhancer (verified working) or give the enhancer its own venv. Do the same in scripts/dev.sh:13-16. Commit a `uv.lock` (`uv lock` in apps/api) so the env is reproducible. Then add a `.github/workflows/ci.yml` that runs `uv sync --extra dev` + ruff + pytest + `npm ci && npm run lint && npm run build && npm test` on push. Add `.coverage` to .gitignore while there.

#### check.sh runs `npm run lint` and `npm run build` but never `npm test` — the 52 frontend tests are ungated, as are all six Playwright scripts

`🟠 high` ｜ 工作量 `trivial`

- **证据**：scripts/check.sh:20-22 is the entire web section: `npm run lint` then `npm run build`. apps/web/package.json:10 defines `"test": "vitest run"`, and I ran it: 12 test files, 52 tests, all passing in 1.32s. apps/web/scripts/ contains six browser scripts (check_e2e_main.mjs 308 lines, check_canvas_mvp_paths.mjs 154, check_local_edit_dock.mjs 207, check_project_isolation.mjs 67, check_stack_gallery.mjs 60, check_layout_click.mjs 80) and not one of them is referenced by check.sh or by any npm script.
- **影响**：A 1.3-second test suite that the author already wrote is never executed by the gate, so it will silently rot. The E2E scripts — which are the only thing enforcing the repo's own mandatory browser-verification rule in AGENTS.md — have no entry point at all, meaning the AGENTS.md policy is enforced by discipline only.
- **修法**：Add `npm test` to scripts/check.sh after `npm run lint`. Add npm scripts `"e2e": "node scripts/check_e2e_main.mjs"` and run it from a separate `scripts/check-e2e.sh` that boots api+web first (the main gate should stay fast). Note that @playwright/test is already a devDependency but unused — the scripts drive raw `playwright.chromium` with no runner, no retries and no reporter; porting them to @playwright/test would give retries and a JUnit report for free.

#### The upload boundary's JPEG and WEBP header parsers have literally never executed — and the fixture that appears to cover JPEG is actually a PNG

`🟠 high` ｜ 工作量 `small`

- **证据**：app/storage.py:24-108 is the untrusted-input gate for every uploaded floor plan. Coverage: app/storage.py 46%, missing `50-65` (the JPEG dispatch and the whole WEBP VP8X/VP8/VP8L branch) and `69-108` (all 41 lines of the hand-rolled `_jpeg_dimensions` marker walker). tests/test_api.py:432-438 looks like the JPEG test — it reads `example/平面图.jpeg` and posts it as `("平面图.jpeg", source, "image/jpeg")` — but I probed the file: `open('example/平面图.jpeg','rb').read()[:2]` is `b'\x89P'`, i.e. it is a **PNG with a .jpeg extension**. `_image_header_dimensions` on it returns `(1075, 737)` via the PNG branch at storage.py:46-49. I confirmed by running that single test under coverage: `app/storage.py 45% ... Missing 50-65, 69-108`. Every one of the 8 `cv2.imencode` calls across tests/ uses `".png"`. Of the four formats declared allowed at storage.py:13 (`.png/.jpg/.jpeg/.webp`), only PNG has ever been parsed.
- **影响**：Confirmed high. This is the product's front door: `save_upload` is the only path for a floor plan, and a phone photo or design-tool export is overwhelmingly JPEG, meaning real first-use traffic hits 41 lines of hand-rolled marker walking that has never executed once. Two failure modes, both user-visible: `_jpeg_dimensions` returning None on a JPEG with a large APP1/EXIF segment or a progressive SOF2 frame yields a flat 415 '无法解析上传图片' on upload; a wrong width/height slips past the 10000-dimension / 40M-pixel guard at :31-41 before OpenCV allocates. The mislabeled fixture is what makes the hole invisible — the suite reads as if JPEG is covered. …
- **修法**：Add unit tests for `_image_header_dimensions` / `_jpeg_dimensions` with real bytes: a baseline JPEG, a progressive JPEG (SOF2, marker 0xC2), a JPEG carrying a large EXIF/APP1 segment before SOF, a truncated JPEG, and each of VP8X/VP8/VP8L WEBP. Assert dimensions match Pillow's. Add a 413 case (declared dimensions over MAX_IMAGE_DIMENSION) — storage.py:38 is also uncovered. Separately, replace `example/平面图.jpeg` with an actual JPEG or rename it to .png so the fixture stops lying, and consider rejecting extension/magic-byte mismatches in `save_upload` (storage.py:116-131 currently trusts the filename suffix for the allow-list and then writes th …

#### The parallel fan-out / incremental-publish / cancel machinery from the latency audit is 0% covered

`🟠 high` ｜ 工作量 `small`

- **证据**：app/processors/ai_workflow.py:29-78 (`_fanout_generate`) is reported entirely missing by coverage (`48-78`). It owns four non-trivial behaviours: ThreadPoolExecutor width `max(1, min(_VARIANT_FANOUT_WORKERS, len(keys)))`, output re-ordering back to input key order via `sorted(completed, key=lambda item: item[0])` under `as_completed`, the mid-batch `should_cancel` path that cancels pending futures and returns `batchStatus="canceled"`, and the `executor.shutdown(wait=not canceled)` detach. It is the single shared implementation behind all five stages (called at lines 552, 641, 774, 947, 1021). The only cancellation tests, tests/test_job_cancellation.py:86 and :103, stub `PROCESSORS["WHITE_MODEL_RENDER"]` with `cancel_then_return` / `cancel_then_fail`, so they exercise app/jobs.py's terminal-state handling and never enter `_fanout_generate`.
- **影响**：Confirmed high, and one item in the proposed fix is wrong in a way worth knowing. Case (4) as written — 'generate_one raising for one key surfaces per-key failure without killing the batch' — is not the contract: `future.result()` at :70 re-raises, so an exception from `generate_one` propagates out and the `finally` at :76-78 then runs `shutdown(wait=True)`, blocking the worker thread until every other in-flight provider call finishes (up to the provider timeout, 5 min per call). The design relies on each caller swallowing ProcessorError internally (ai_workflow.py:520-525 does), so the correct test is the inverse: assert that an UNEXPECTED ex …
- **修法**：Unit-test `_fanout_generate` directly with a synthetic `generate_one` — no HTTP, no DB. Cases: (1) completion order deliberately inverted (make key[2] return instantly, key[0] sleep) and assert the result preserves input order; (2) `on_progress` receives strictly growing output lists all carrying `batchStatus == "running"`; (3) `should_cancel` flipping true after the first completion returns `batchStatus == "canceled"` with the partial outputs and does not block; (4) `generate_one` raising for one key surfaces per-key failure without killing the batch. This is ~60 lines of test for the highest-churn code in the backend.

#### Measured backend coverage is 68%, twelve points below the self-imposed 80% floor

`🟠 high` ｜ 工作量 `medium`

- **证据**：`.venv/bin/python -m pytest --cov=app --cov-report=term-missing` over the 155 passing tests: TOTAL 6216 statements, 1995 missed, **68%**. Worst modules by absolute uncovered statements: app/processors/blender_floorplan_scene.py 867/867 missed (0%), app/processors/ai_workflow.py 215 missed (49%), app/main.py 190 missed (81%), app/processors/layout.py 108 missed (63%), app/processors/blender_scene.py 79/79 missed (0%), app/processors/floorplan_enhancement.py 78 missed (78%), app/processors/kuyao_image_edit.py 76 missed (77%), app/storage.py 47 missed (46%), app/assets.py 40 missed (85%), app/processors/blender.py 31 missed (21%), app/canvas.py 30 missed (83%), app/jobs.py 26 missed (82%), app/database.py 21 missed (70%). Frontend is far worse: 52 vitest tests cover 12 pure-helper modules totalling ~1,675 LOC out of 23,251 LOC of non-test source under apps/web/src — roughly 7%.
- **影响**：Real but medium, because as a finding it is largely the sum of [0], [3] and [4] restated as a number. Its independent value is two concrete, verified items: (1) pyproject.toml enforces nothing, so the 80% bar the user set for themselves has no mechanism behind it — adding `--cov-fail-under=80` is the whole fix; (2) 946 permanently-unexecutable Blender statements (blender_floorplan_scene.py 867 + blender_scene.py 79) silently depress the number by ~13 points, so the figure that matters is closer to 78% on live code and an explicit `[tool.coverage.run] omit` would make the metric honest before it is enforced. The frontend ~7% is the more alarmi …
- **修法**：Add `--cov=app --cov-report=term-missing --cov-fail-under=80` to `[tool.pytest.ini_options] addopts` in apps/api/pyproject.toml, and explicitly omit the Blender modules in a `[tool.coverage.run] omit` list (with a comment stating they are gated off by BLENDER_ENABLED and covered manually). Then close the gap in priority order: ai_workflow.py (see the fan-out and processor findings above), storage.py, layout.py. On the frontend add `@vitest/coverage-v8` and start with canvasRunner.ts.

#### The Playwright E2E contains four self-passing assertions, including one that is logically a tautology

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/web/scripts/check_e2e_main.mjs:275-277: `const emptyOk = emptyNodes === 0 && (/从户型开始|上传户型/.test(emptyBody) || emptyNodes === 0)` — the right-hand disjunct `emptyNodes === 0` is already guaranteed true by the left conjunct, so the empty-state hint-text check can never fail; the step reduces to a node count. :260 `step('spawn_ui', !hasApproved, ...)` — when no `.canvas-handle-spawn` is found the step PASSES as long as the graph has no approved node, so a regression that stops rendering spawn handles scores green on any unapproved project. :213 `step('node_click_detail_or_actions', Boolean(prev?.ok), ...)` — re-reports an earlier step's result instead of asserting anything. :93 `step('assets_page', /我的资产|资产/.test(assetsText))` — passes on any page whose body text contains "资产", which includes an error state rendered under the nav label. `report.ok = report.steps.every(s => s.ok)` at :286 rolls all of these into the exit code.
- **影响**：Downgraded from high to medium on exposure, not on correctness. This script is invoked by nothing — no npm script, no shell script, no doc (verified by repo-wide grep) — so its false passes mislead a developer who runs it by hand rather than gating anything. Within that scope :260 is the genuine defect: it asserts the negation of what the step is named for, so a regression that stops rendering `.canvas-handle-spawn` scores PASS on any project without an approved node, which is the common local state. :275-277 is dead code in a conditional — harmless today but it makes the empty-state hint look tested when it is not. :213 and :93 are weak-asse …
- **修法**：Line 275: drop the `|| emptyNodes === 0` disjunct so the hint text is genuinely required. Line 260: make a missing spawn handle a hard FAIL and instead seed an approved node during setup so the precondition is guaranteed rather than inferred. Line 213: fail the step outright when no non-stack stage node exists, rather than aliasing a prior result. Line 93: assert on a concrete DOM node count (e.g. `.fb-asset-card`) instead of a substring of body text — the same substring-of-innerText pattern is used at :50 and :93 and should be replaced throughout.

#### E2E is hardwired to two pre-existing local project IDs, so it can never run on a clean machine or in CI

`🟠 high` ｜ 工作量 `medium`

- **证据**：apps/web/scripts/check_e2e_main.mjs:20-27 defaults `FULL` to `'project_28ad2095b5d64d15'` and `EMPTY` to `'project_d8cc984af1494e24'`. There is no seeding step anywhere in the script — step 4 (:100) immediately fetches `/v1/projects/${FULL}/canvas-graph` and asserts `graph?.nodes?.length`. The same hardcoding pattern appears across the sibling scripts in apps/web/scripts/.
- **影响**：Real, medium. These scripts are permanently bound to one developer's `.local/room_design.db`; deleting that file — which the project invites, since config.py:15 puts sqlite under `.local/` and it is gitignored — turns every canvas step into a failure indistinguishable from a genuine regression. That is almost certainly why the scripts were never wired into check.sh, which makes this finding the actual blocker behind [2] rather than a separate problem: adding `npm test` to the gate is one line, but adding E2E requires self-seeding first. Note the three scripts with no override at all are the worse offenders and should be fixed alongside check_ …
- **修法**：Replace the hardcoded defaults with a seed phase at the top of the script: POST `/v1/projects` twice to create a fresh full project and a fresh empty one, then drive the full project through floorplan analyze + layout + approve using the existing API endpoints (or a dedicated `POST /v1/testing/seed-project` guarded by an env flag) so the graph has approved nodes and at least one stack. Keep the argv/env overrides as an escape hatch for local debugging, but make the default path self-seeding.

#### Zero frontend tests for any stateful code: the 890-line canvas runner, the 699-line action hook, the API client and every React component are untested

`🟠 high` ｜ 工作量 `medium`

- **证据**：All 12 vitest files live in apps/web/src/canvas/ and import only pure helpers: actionLabels, activeJobs, buildCanvasFlow, canRunAction, layoutMath, menuMath, nodeStage, resumeActiveJobs, skeletonMath, spawnDerive, stackMath, stageDetail, plus `galleryGridColumns` from StackGallery. Untested: apps/web/src/workflow/canvasRunner.ts (890 lines, exports `runFloorplanAnalyze` at :158 and `executeCanvasAction` at :635 — the entire job submit/poll/publish orchestrator), apps/web/src/canvas/useCanvasRunAction.ts (699), apps/web/src/api.ts (297), apps/web/src/canvas/ProjectCanvas.tsx (1578), and every other component. jsdom is configured (vitest.config.ts:7) and @testing-library/react 16.3.2, @testing-library/jest-dom 7.0.0 and @testing-library/user-event 14.6.1 are all installed devDependencies with zero imports anywhere in src/.
- **影响**：Confirmed high — this is the frontend twin of finding [0] and the two together define the repo's risk profile. The untested surface is not incidental: it is the orchestration layer of the UI that was just rebuilt and is now the only way users reach the product. `executeCanvasAction` (canvasRunner.ts:635) and `runFloorplanAnalyze` (:158) own job submission, polling, terminal-state detection, cancel wiring and error surfacing — the exact behaviours the latency rework changed most recently, and the exact behaviours whose failure mode is a silently stuck spinner rather than a visible crash. The strongest part of the fix is that it needs no DOM: ` …
- **修法**：Test `executeCanvasAction` and `runFloorplanAnalyze` with a mocked api module (`vi.mock('../api')`): assert the job is submitted with an Idempotency-Key, that polling stops on SUCCEEDED/FAILED/CANCELED, that a FAILED job surfaces a user-facing `RunnerNotice` rather than swallowing the error, and that cancel actually calls `cancelJob`. That is the highest-value frontend test and needs no DOM. Then add one @testing-library render test for ProjectCanvas's empty state, since the tooling is already paid for.

#### Hand-written Postgres DDL is 0% covered, and _ensure_canvas_tables is a no-op that cannot add columns

`🟡 medium` ｜ 工作量 `medium`

- **证据**：app/database.py is 70% covered with missing `47-55, 68, 76-81, 109-115, 128-138, 145-199` — every `else:` (non-sqlite) branch of the four hand-rolled migrations: `_ensure_job_timing_columns` (:50-58), `_ensure_job_idempotency_column`, `_ensure_canvas_tables` (:161-199) and `_ensure_project_home_columns` (:115-120). conftest.py forces `DATABASE_URL=sqlite:///...`, and app/config.py:15 defaults to sqlite, so the Postgres DDL string literals — duplicated by hand from models.py, with different type names (JSONB vs TEXT, TIMESTAMPTZ vs DATETIME) — have never been parsed by a database. Separately, `init_db` at database.py:28-34 calls `Base.metadata.create_all(bind=engine)` **first**, so on a fresh DB the canvas tables already exist and `_ensure_canvas_tables` finds `PRAGMA table_info(canvases)` non-empty and skips; on an existing DB it only handles the case where the table is missing entirely (`if not existing:`) and has no path to add a newly declared column.
- **影响**：Downgraded from medium to low-medium, and the two halves deserve different weight. The Postgres half is near-zero risk for this pilot: config.py:15 defaults to sqlite, .env.example:2 has the Postgres URL commented out, and because `create_all` runs first the manual DDL is a no-op on any fresh Postgres database — so the JSONB/TIMESTAMPTZ divergence never actually reaches a server. The half that will bite is the column-drift trap: the moment anyone adds a field to `Canvas` or `CanvasNode` in models.py, fresh installs get it from `create_all` while every existing local DB silently does not, surfacing as `OperationalError: no such column` at quer …
- **修法**：Add a schema-parity test that, after `init_db()`, reflects the live tables and asserts the column set of `canvases`/`canvas_nodes`/`jobs`/`projects` matches `Base.metadata` exactly — that catches DDL drift on sqlite today and would have caught the create_all/manual-DDL redundancy. Add a Postgres-backed run (testcontainers or a CI service container) parameterised by DATABASE_URL so the `else:` branches execute at least once. Longer term, replacing these four functions with Alembic removes the duplicated DDL entirely.

#### Three endpoints declare an Idempotency-Key header that is silently discarded

`⚪ low` ｜ 工作量 `trivial`

- **证据**：I walked every `idempotency_key: IdempotencyKeyHeader` declaration in app/main.py and checked whether the identifier appears anywhere in the function body. Fourteen of seventeen pass it through to `create_job`. Three do not: app/main.py:1107 (`list_scene_assets`, a GET), :1214 (`approve_scene_asset_variant`) and :1326 (`unapprove_scene_asset_variant`). The parameter is accepted, validated for `max_length=64`, published in the OpenAPI schema, and then never read. tests/test_idempotency.py only covers `create_job` directly (:34-46) and the retry endpoint (:80-105), so nothing detects the dangling parameters.
- **影响**：Real and correctly self-rated low/trivial — no severity inflation here, which is worth noting given the rest of the batch. Functional risk is essentially nil: approve/unapprove are idempotent by construction and the third is a GET. The cost is a lying OpenAPI contract — a generated client or a frontend author reading the schema sees documented double-submit protection on `POST /assets/{id}/approve` that does not exist. Deleting three parameter declarations is the entire fix and it removes dead code at the same time.
- **修法**：Delete the `idempotency_key` parameter from the three functions at app/main.py:1107, :1214 and :1326. If double-submit protection on approve is actually wanted, implement it rather than declaring it.


### A.5 数据模型与运维（13 条）

| 级别 | 工作量 | 问题 |
|---|---|---|
| 🟠 high | small | All API timestamps are serialized without a timezone on SQLite, so the frontend reads UTC as local time (running-job timer permanently stuck … |
| 🟠 high | medium | No artifact retention or garbage collection: .local/artifacts is already 962 MB / 1399 files with zero rows referencing them, and nothing ev … |
| 🟠 high | medium | Schema evolution is ad-hoc ALTER shims covering 3 of 5 tables; the next column added to scene_assets or canvases silently breaks every exist … |
| 🟠 high | trivial | No logging configuration exists, so every logger.info() added by the latency audit is discarded and warnings print without timestamps |
| 🟠 high | medium | The canvases/canvas_nodes tables and all six canvas endpoints are dead - the infinite canvas never persists node positions, so every user re … |
| 🟡 medium | trivial | The jobs table has no indexes at all, yet every canvas load full-scans it with a three-predicate filter |
| 🟡 medium | medium | /v1/assets applies moduleKey and workflowStage filters in Python after LIMIT/OFFSET, so filtered queries silently return incomplete or empty … |
| 🟡 medium | small | Startup runs an unbounded full-table backfill before the server accepts any traffic, and swallows its failure to stdout |
| 🟡 medium | small | SQLite runs in rollback-journal mode with foreign keys OFF and 8 concurrent job workers - declared FK constraints are not enforced and write … |
| 🟡 medium | small | /health never touches the database or the artifact directory, and there is no readiness/liveness split or config validation at startup |
| 🟡 medium | medium | Variant approval state lives as a read-modify-write on a JSON blob with no concurrency control, so concurrent approvals of two variants sile … |
| ⚪ low | small | Absolute host filesystem paths are persisted into job payloads, so job retry and any artifact relocation break historical rows |
| ⚪ low | medium | The project canvas graph endpoint loads every asset and every partial job for a project with no limit |

#### All API timestamps are serialized without a timezone on SQLite, so the frontend reads UTC as local time (running-job timer permanently stuck at 0)

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/api/app/models.py:34-42,74-90,123-132 declare every timestamp as DateTime(timezone=True) and write tz-aware values via utc_now() (models.py:13-14, jobs.py:201,251). SQLite's SQLAlchemy dialect silently drops tzinfo on write and returns naive datetimes on read - verified in this repo's own venv: a round-trip of datetime.now(UTC) returns datetime.datetime(2026, 8, 5, 14, 24, 23, 397205) with no tzinfo. A live TestClient call to POST /v1/projects returns "createdAt": "2026-08-05T14:29:13.206695" - no Z, no offset. The frontend then does new Date(since).getTime() at apps/web/src/BatchProgress.tsx:23, fed by since={job.startedAt ?? job.createdAt} at apps/web/src/BatchProgress.tsx:53. On a UTC+8 machine JS parses the naive UTC string as local time, putting it 8 hours in the future; Math.max(0, ...) at BatchProgress.tsx:21 clamps the negative result to 0.
- **影响**：Every AI generation (1-5 minutes of paid provider time) shows "0分00秒" for its entire duration - the primary progress-feedback signal for the whole product is dead for any user not in UTC. formatUpdateDate (home/ProjectsPage.tsx:38-47) and relativeTime (home/HomePage.tsx:905) show dates off by the UTC offset. The bug also disappears on Postgres (TIMESTAMPTZ round-trips aware), so behavior differs by backend and will not reproduce for whoever debugs it on Postgres.
- **修法**：Fix at the API boundary rather than 20 call sites: in apps/api/app/schemas.py give APIModel a field serializer (or a reusable UtcDatetime = Annotated[datetime, PlainSerializer(...)]) that stamps tzinfo=UTC when value.tzinfo is None before isoformat(). Alternatively register a SQLAlchemy TypeDecorator that re-attaches UTC on load for SQLite. Add a test asserting createdAt ends in +00:00/Z.

#### No artifact retention or garbage collection: .local/artifacts is already 962 MB / 1399 files with zero rows referencing them, and nothing ever deletes a generated file

`🟠 high` ｜ 工作量 `medium`

- **证据**：grep -rn "unlink|rmtree|os.remove" apps/api/app/ returns only two hits, both temp-file cleanup inside processors (blender_floorplan_scene.py:2210, floorplan_vision.py:356). No retention job, no TTL, no orphan sweeper. delete_project (apps/api/app/main.py:1071-1101) explicitly documents "不物理删生成图" and only unbinds assets/jobs to project_id = NULL. thumbnails.py:24-45 writes two extra WebP files per image. Measured state of this workspace: .local/artifacts = 962 MB across 1399 files (352 thumbnails, 4.7 MB; ~1047 originals, ~957 MB), while both .local/room_design.db and .local/room-design.db are 0 bytes - the database has been reset and every one of those 957 MB is unreferenced.
- **影响**：Disk grows without bound at roughly 1 MB per generated image with no ceiling; a real deployment fills its volume and every subsequent job fails at path.write_bytes (storage.py:131) with an unhandled OSError. There is no repair path: no way to list orphaned files, no way to reclaim space, and no way to detect that a row's deliverables URL points at a file that no longer exists. .local/ is gitignored, so neither DB nor artifacts are covered by any backup story.
- **修法**：Add apps/api/app/maintenance.py with (a) find_orphan_artifacts(session) - set-difference of files in settings.artifact_dir against every URL referenced by SceneAsset.thumbnail_url/deliverables and Job.result, and (b) find_dangling_rows(session) - assets whose deliverables.fullUrl is missing on disk. Expose as POST /v1/maintenance/orphans?dryRun=true and add a retention policy (delete orphans older than N days, N from config). Also stop delete_project from leaving assets permanently ownerless.

#### Schema evolution is ad-hoc ALTER shims covering 3 of 5 tables; the next column added to scene_assets or canvases silently breaks every existing database

`🟠 high` ｜ 工作量 `medium`

- **证据**：apps/api/app/database.py:28-33 runs Base.metadata.create_all plus four hand-written shims. create_all creates missing tables but never adds columns to existing ones. Shipped this way so far: jobs.started_at, jobs.finished_at (database.py:36-58), jobs.idempotency_key + unique index (database.py:61-88), projects.design_prompt/cover_url/updated_at (database.py:96-119), and the canvases/canvas_nodes tables (database.py:122-201). scene_assets - the table holding all business state - has no shim at all. No version table, no ordering guarantee, no downgrade, and no test coverage: tests/conftest.py:10 does TEST_DB.unlink(missing_ok=True) on import, so every run exercises only the fresh-create_all path. _ensure_canvas_tables is additionally already dead and divergent - it runs after create_all has created those tables, so its branch never fires, and it declares viewport_json JSONB with no FOREIGN KEY clauses while models.py:143-147,169-182 declares JSON with four FKs.
- **影响**：The next Mapped[...] added to SceneAsset (or any column on canvases) deploys cleanly, passes all 100 tests, then throws OperationalError: no such column on the first request against any pre-existing database - including the developer's own. No rollback path, and no way to tell which shims a given DB has applied. A SQLite->Postgres move has no data-migration path at all (no dump/load script, and JSON-vs-JSONB drift is baked into the two competing DDL definitions).
- **修法**：Adopt alembic before the next schema change: alembic init, autogenerate an initial revision stamped against the current shipped schema, convert the four shims into explicit revisions, and replace init_db()'s create_all with alembic upgrade head. If alembic is unwanted, at minimum add a schema_version table, make init_db fail loudly when the DB version is behind the code, and add a test that boots against an older DDL snapshot.

#### No logging configuration exists, so every logger.info() added by the latency audit is discarded and warnings print without timestamps

`🟠 high` ｜ 工作量 `trivial`

- **证据**：grep -rn "basicConfig|dictConfig|logging.config" apps/api/app/ returns nothing, and scripts/dev.sh:37-41 starts uvicorn with no --log-config. Verified against this repo's venv: uvicorn.config.LOGGING_CONFIG['loggers'] contains only uvicorn, uvicorn.error, uvicorn.access, and LOGGING_CONFIG['root'] is None. App loggers (jobs.py:38 and the same pattern in ai_workflow.py) therefore propagate to an unconfigured root and fall through to logging.lastResort, a bare _StderrHandler at level WARNING. main.py:98 even falls back to raw print() + traceback.print_exc() for the startup backfill.
- **影响**：All of logger.info("job %s (%s) succeeded in %.1fs", ...) (jobs.py:255-260), "idempotent resubmit" (jobs.py:117), and every per-stage timing the previous latency audit added produce zero output - the instrumentation built to diagnose slow generations is invisible in the only way the app is ever run. Surviving WARNING/ERROR lines emit with no timestamp, level, or logger name, making them unusable for log shipping or correlating a user complaint to a job.
- **修法**：Add apps/api/app/logging_config.py with a dictConfig (root at INFO, '%(asctime)s %(levelname)s %(name)s %(message)s' or JSON formatter, level from a new log_level setting in config.py) and call it as the first statement of the lifespan at main.py:89. Replace main.py:98-101's print/traceback.print_exc() with logger.info/logger.exception.

#### The canvases/canvas_nodes tables and all six canvas endpoints are dead - the infinite canvas never persists node positions, so every user rearrangement is lost on reload

`🟠 high` ｜ 工作量 `medium`

- **证据**：grep -rn "v1/canvases" across the entire repo matches only apps/api/tests/test_canvases.py. The frontend never calls them. apps/web/src/canvas/ProjectCanvas.tsx:346 loads /v1/projects/{id}/canvas-graph (a coordinate-free logical graph, apps/api/app/canvas.py:299-455) and derives positions client-side via buildCanvasFlow (ProjectCanvas.tsx:241-268, position: { x: item.x, y: item.y }). Nodes are made draggable at ProjectCanvas.tsx:271 but no drag handler writes anywhere - no PATCH /nodes/batch call, no localStorage - and every loadGraph re-runs the deterministic layout and overwrites positions. Backing this dead path: 2 ORM models (models.py:135-201), 80 lines of hand-written migration DDL (database.py:122-201), 6 endpoints (main.py:2314-2497), 8 pydantic schemas (schemas.py:365-421), and 158 lines of tests.
- **影响**：The headline feature of the recently-built infinite canvas - arranging your work spatially - does not survive a page refresh, and no one would discover this from the test suite because 158 passing tests cover the persistence layer the UI never uses. The dead schema also inflates the migration surface (canvas_nodes DDL is one of only four hand-written shims that must stay in sync with models.py) and inflates the coverage number measured against the project's own 80% standard.
- **修法**：Decide and act: either (a) wire ProjectCanvas's onNodeDragStop to a debounced PATCH /v1/canvases/{id}/nodes/batch and merge stored coordinates over buildCanvasFlow defaults in applyGraph, or (b) delete Canvas/CanvasNode from models.py, the six endpoints, the _ensure_canvas_tables shim, the schemas, and test_canvases.py. Do not keep a third schema-bearing table maintained by hand for code no client calls.

#### The jobs table has no indexes at all, yet every canvas load full-scans it with a three-predicate filter

`🟡 medium` ｜ 工作量 `trivial`

- **证据**：apps/api/app/models.py:45-90 - Job declares index=True on zero columns; only the PK and the unique idempotency_key index (added by the shim at database.py:78-88) exist. build_project_canvas_graph runs WHERE project_id = ? AND type IN (13 values) AND status IN ('CANCELED','FAILED','RUNNING') ORDER BY created_at (apps/api/app/canvas.py:388-398) on every canvas open and every post-generation refresh (ProjectCanvas.tsx:346). list_jobs (main.py:2284-2289) filters project_id + status and orders by created_at. reclaim_stale_jobs scans on status (jobs.py:154-162) and backfill_scene_assets scans on type + status at every startup (assets.py:616-625). Contrast SceneAsset, which correctly indexes owner_id, project_id, job_id, parent_asset_id, generation_mode, created_at (models.py:101-127).
- **影响**：Jobs is the fastest-growing table (one row per submission plus one per retry, never pruned) and the canvas polls it. Every canvas refresh degrades linearly with total lifetime job count, on a SQLite file where that scan also holds a read lock against the 8 concurrent job workers. Invisible in tests because conftest wipes the DB each run.
- **修法**：Add index=True to Job.project_id, Job.status and Job.created_at in models.py, plus a composite Index('ix_jobs_project_status', 'project_id', 'status') in __table_args__ for the canvas-graph query - and ship it as a real migration, since create_all will not create indexes on an existing table.

#### /v1/assets applies moduleKey and workflowStage filters in Python after LIMIT/OFFSET, so filtered queries silently return incomplete or empty results

`🟡 medium` ｜ 工作量 `medium`

- **证据**：apps/api/app/main.py:1140-1159: the SQL statement filters only owner_id, thumbnail_url IS NOT NULL, optional generation_mode and project_id, then applies .offset(offset).limit(limit) at line 1148 - after which lines 1151-1158 discard rows in Python by module_key and metadata.workflowStage. limit is capped at 100 (Query(ge=1, le=100), line 1108), and the two library callers (apps/web/src/AssetLibrary.tsx:955, home/ProjectsPage.tsx:102) request limit=100 with no pagination UI. legacy/WorkflowAssetPicker.tsx:209-214 is the live caller passing moduleKey/workflowStage.
- **影响**：Once a user has more than 100 assets - plausible today given 1399 artifact files in this workspace - the asset picker for e.g. moduleKey=layout can return an empty list even though dozens of layout assets exist, because the newest 100 rows happened to be color-plan outputs. The user sees "no assets" and cannot resume a workflow from a real approved layout. The unfiltered library silently truncates to the newest 100 with no load-more, so older work becomes unreachable through the UI.
- **修法**：Push both filters into SQL before pagination. module_key and workflow_stage are already computed at write time (assets.py:544), so denormalize them into indexed columns on scene_assets and filter there; then apply .offset().limit() last and return a total count so the frontend can paginate.

#### Startup runs an unbounded full-table backfill before the server accepts any traffic, and swallows its failure to stdout

`🟡 medium` ｜ 工作量 `small`

- **证据**：apps/api/app/main.py:88-107: the lifespan calls init_db(), reclaim_stale_jobs(), then backfill_scene_assets(backfill_session) before yield. assets.py:613-633 selects every SUCCEEDED job of the 13 asset types with no limit, then per job issues an extra SELECT scene_assets.id (line 628) and calls ensure_scene_asset, which calls maybe_upgrade_thumbnail_url -> ensure_thumbnails -> two Image.open + save(..., method=6) WebP encodes for any asset lacking thumbnails (thumbnails.py:24-63). Failures are caught by a bare except Exception that prints a traceback to stdout (main.py:99-101).
- **影响**：Boot time grows linearly with lifetime job count and, on the first run after backfill-thumbnails was introduced, includes a synchronous LANCZOS+WebP encode of every historical image. During that window uvicorn is not serving, so /health fails and any supervisor or load balancer sees the instance as down - the classic slow-start crash loop. If the backfill raises, the app boots anyway in a silently half-migrated state.
- **修法**：Move the backfill out of the request-blocking startup path: run it on the job executor after readiness, or expose it only via the existing POST /v1/assets/backfill endpoint (main.py:1172). Bound it with a limit and a WHERE NOT EXISTS (SELECT 1 FROM scene_assets ...) so it is O(new rows). Replace the print/traceback.print_exc() with logger.exception.

#### SQLite runs in rollback-journal mode with foreign keys OFF and 8 concurrent job workers - declared FK constraints are not enforced and writers can hit 'database is locked'

`🟡 medium` ｜ 工作量 `small`

- **证据**：apps/api/app/database.py:15-25 creates the engine with only check_same_thread=False and pool_pre_ping; there is no PRAGMA event listener anywhere (grep -rn "PRAGMA" apps/api/app/ returns only the migration shims' table_info calls). Verified against this venv on a file-backed SQLite engine built the same way: journal_mode=delete, foreign_keys=0, busy_timeout=5000, QueuePool(size=5) + 10 overflow. Meanwhile jobs.py:70 runs 8 job workers, each committing on start (line 202), on every incremental publish_progress (line 213) and on finish (line 253), while should_cancel (lines 218-225) opens a fresh session per poll. models.py declares seven ForeignKeys (jobs.project_id, jobs.parent_job_id, scene_assets.project_id/job_id/parent_asset_id, canvases.project_id, canvas_nodes.canvas_id/asset_id/job_id) - none of which SQLite enforces.
- **影响**：Integrity: nothing stops POST /v1/canvases (main.py:2319-2328, which never checks the project exists) from creating a canvas pointing at a nonexistent project, or a canvas_node referencing a deleted asset. The manual cascade in delete_project (main.py:1077-1097) is the sole guard, and any path that forgets it leaves dangling rows with no constraint to catch it and no repair tool to find them. Concurrency: with rollback journal a writing job worker blocks all readers; 8 workers plus polling GET /v1/jobs/{id} on a 5 s busy timeout makes OperationalError: database is locked a realistic failure that surfaces as a lost job result.
- **修法**：Add an @event.listens_for(engine, 'connect') hook in database.py issuing PRAGMA foreign_keys=ON, PRAGMA journal_mode=WAL and PRAGMA busy_timeout=30000 for SQLite URLs. Turning FKs on will expose existing dangling rows - pair it with the orphan-detection tool from the retention finding, and add explicit existence checks to create_canvas and create_canvas_node.

#### /health never touches the database or the artifact directory, and there is no readiness/liveness split or config validation at startup

`🟡 medium` ｜ 工作量 `small`

- **证据**：apps/api/app/main.py:969-1006 - health() returns only static settings-derived booleans (floorplan_vision_configured, kuyao_image_edit_configured, stage names). It issues no query, does not stat settings.artifact_dir, and is not gated on startup completion. config.py:75-81 constructs Settings() and mkdirs directories at import time with no validation that required secrets are present - kuyao_api_key defaults to "" and an unconfigured deployment boots reporting "status": "ok". There are no deployment artifacts in the repo: no Dockerfile, Procfile, systemd unit or Makefile - only scripts/dev.sh, which hard-requires conda activate llf_v1 and starts three processes with --reload.
- **影响**：A supervisor or load balancer probing /health keeps routing traffic to an instance whose database file is missing, whose disk is full, or whose API key is empty - users only find out when a job fails minutes later after the provider call. Because the health check also answers before lifespan finishes (see the backfill finding), it is useless as a readiness signal. There is no documented or scripted production process model, so deployment today means running the dev script.
- **修法**：Split the endpoint: /health/live returns static OK; /health/ready executes SELECT 1, checks settings.artifact_dir.is_dir() and free space, and returns 503 with a machine-readable reason. Add a model_validator on Settings that fails startup when floorplan_vision_provider is a remote provider but floorplan_vision_api_key is empty. Commit a minimal Dockerfile/systemd unit pinning a single uvicorn worker (required - reclaim_stale_jobs is documented as single-process-only at jobs.py:150-151) with --timeout-graceful-shutdown.

#### Variant approval state lives as a read-modify-write on a JSON blob with no concurrency control, so concurrent approvals of two variants silently lose one

`🟡 medium` ｜ 工作量 `medium`

- **证据**：apps/api/app/main.py:1260-1313: approving a variant reads asset.metadata_json, copies variantApprovals into a new dict (1262-1266), inserts the new entry (1286-1290), rebuilds metadata and deliverables (1291-1310), assigns both back and commits. The same read-modify-write is repeated for unapproval at main.py:1348-1428. There is no version column, no SELECT ... FOR UPDATE and no uniqueness constraint - approval, the gate that lets a user spend money on the next generation stage (schemas.py:262-269 rejects unapproved layouts), is entirely untyped keys inside scene_assets.metadata. canvas.py:56-63 and main.py:746-758 each re-implement parsing of that blob's shape independently.
- **影响**：Two approvals issued close together (trivial on a canvas where a user approves two variants of the same batch) both read the same pre-state and the second commit overwrites the first - the earlier approval vanishes with no error, and any downstream asset derived from it now references an approvedVersionId that no longer appears in variantApprovals, which _workflow_approved_output (main.py:895-905) later rejects with a 409 the user cannot explain or recover from. Because the shape is untyped JSON, nothing validates it at the boundary despite the project's own schema-based-validation rule.
- **修法**：Promote approvals to a real table - asset_variant_approvals(asset_id, variant_id, version_id, output_url, approved_at, comment) with a PK on (asset_id, variant_id) - which turns idempotent re-approval into a constraint rather than the hand-rolled check at main.py:1267-1280 and makes concurrent approval of two variants two independent inserts. Short of that, add an updated_at-based optimistic-lock predicate to the UPDATE and 409 on lost updates.

#### Absolute host filesystem paths are persisted into job payloads, so job retry and any artifact relocation break historical rows

`⚪ low` ｜ 工作量 `small`

- **证据**：apps/api/app/main.py:1706, 1770, 1842 store "approved_layout_path": str(source) - an absolute path produced by _artifact_path_from_public_url (main.py:732-743) resolving against settings.artifact_dir - directly into the persisted Job.payload JSON. retry_job (main.py:2243-2251) replays original.payload verbatim into a new job, and AIWorkflowJobBase.approved_layout_path (schemas.py:252) validates only min_length=1, never that the path is inside artifact_dir or that the file still exists.
- **影响**：ARTIFACT_DIR is configurable (config.py:16, .env.example), so changing it - or containerizing, or moving the checkout - invalidates every stored payload: retries of any historical job fail on a missing file, surfacing as a generic GENERATION_FAILED rather than "this artifact moved". It also couples the DB to the filesystem by absolute path rather than by the stable /artifacts/<name> identity the rest of the system already uses.
- **修法**：Persist the public /artifacts/<name> URL (or bare filename) in job payloads and resolve it to a Path inside the processor at run time via the existing _artifact_path_from_public_url helper. Add a payload validator rejecting any path that does not resolve under settings.artifact_dir, which also closes the traversal surface of accepting a raw client-supplied filesystem path.

#### The project canvas graph endpoint loads every asset and every partial job for a project with no limit

`⚪ low` ｜ 工作量 `medium`

- **证据**：apps/api/app/canvas.py:312-318 selects all SceneAsset rows for a project, canvas.py:320-327 optionally unions all project_id IS NULL assets in the entire database, and canvas.py:388-398 selects all matching Job rows - none of the three has a LIMIT. Each asset is fanned out to one node per image variant (canvas.py:44-176, up to 12 for AI_SPACE_RENDER), and the whole thing is serialized into a single JSON response consumed by ProjectCanvas.tsx:346 on every project open and after every generation.
- **影响**：Response size and query cost grow linearly and without bound over a project's life; a long-running project with a few hundred assets produces thousands of nodes in one payload on every refresh, on top of the unindexed jobs scan. The includeOrphans=true path is worse - it merges every orphaned asset in the database into whichever project is being viewed (the frontend comment at ProjectCanvas.tsx:341-343 already warns about exactly this).
- **修法**：Add a bounded limit/cursor on the asset query ordered by created_at DESC, return hasMore, and have the canvas request older nodes on demand. Cap partial_jobs to jobs from the last N hours, since running jobs older than that are already reclaimed as WORKER_LOST.


### A.6 API 契约与前端质量（13 条）

| 级别 | 工作量 | 问题 |
|---|---|---|
| 🟠 high | large | The entire /v1/canvases persistence API is dead code — canvas node positions are never saved |
| 🟠 high | medium | Canvas node cards load full-size 2-3 MB PNGs instead of the 8 KB thumbnails that already exist on disk |
| 🟠 high | trivial | FastAPI 422 validation arrays render to users as the literal string "[object Object]" |
| 🟠 high | small | Canvas toasts are the only error surface, never auto-dismiss, have no dismiss control, and are invisible to screen readers |
| 🟡 medium | small | The generation dialog cannot be closed with the keyboard and does not trap or restore focus |
| 🟡 medium | small | Batch node PATCH 500s on non-numeric input, silently drops unknown IDs, and leaks SQL on FK violations |
| 🟡 medium | trivial | Local edit silently falls back to a hardcoded space id when asset metadata is unreadable |
| 🟡 medium | medium | Asset lists are hard-capped at 100 with no pagination UI, and offset is broken by post-SQL filtering |
| 🟡 medium | large | Zero component and E2E tests despite five installed test dependencies and an unconfigured test environment |
| 🟡 medium | trivial | 8 of 12 runtime npm dependencies are unused, including zod — which the project's own rules mandate for boundary validation |
| 🟡 medium | medium | The app still hard-locks to a 1120px minimum width and the canvas stylesheet has no media queries at all |
| ⚪ low | small | Backend validation errors reach Chinese users as raw English Pydantic strings (the real i18n issue) |
| ⚪ low | small | apiError is triplicated with divergent behaviour, and dead runGeneration swallows FAILED jobs |

#### The entire /v1/canvases persistence API is dead code — canvas node positions are never saved

`🟠 high` ｜ 工作量 `large`

- **证据**：`grep -rn "v1/canvases" apps/web/src` returns 0 matches. The frontend holds node positions in React Flow local state only (apps/web/src/canvas/ProjectCanvas.tsx:173 `useNodesState`, wired at :1110 `onNodesChange`), and recomputes them from scratch on every load via `layoutGraphByStage` (apps/web/src/canvas/layoutMath.ts:22-45, a deterministic stage-column grid). Meanwhile the backend ships 8 unreachable endpoints (apps/api/app/main.py:2314 create_canvas, :2331 list_canvases, :2347 get_canvas, :2386 update_canvas, :2403 delete_canvas, :2413 create_canvas_node, :2444 batch_patch_canvas_nodes, :2481 delete_canvas_node), two DB tables (apps/api/app/models.py:135 Canvas, :161 CanvasNode), 7 schemas (apps/api/app/schemas.py:365-421) and 158 lines of tests (apps/api/tests/test_canvases.py). There is no viewport persistence either — no localStorage or API write of viewport_json anywhere in ProjectCanvas.tsx.
- **影响**：Worse than 'lost on refresh': any card the user drags snaps back to the auto grid the moment ANY job finishes, because every generation completion calls applyGraph which recomputes all positions from layoutGraphByStage. On a canvas with several running jobs the user's arrangement is destroyed within seconds, mid-session. Independently, ~600 lines of backend (main.py:2314-2497), two DB tables (models.py:135, :161), 7 schemas and 158 lines of tests are maintained with no caller. Fix or delete — do not leave both halves half-built.
- **修法**：Decide one way. To ship the feature: on React Flow's `onNodeDragStop`, debounce a `PATCH /v1/canvases/{id}/nodes/batch`, and on canvas mount merge persisted `{x,y,z}` over `layoutGraphByStage` output, falling back to the computed grid for nodes with no stored position. To cut scope: delete main.py:2314-2497, the Canvas/CanvasNode models, the 7 canvas schemas and tests/test_canvases.py, keeping only `/canvas-graph`.

#### Canvas node cards load full-size 2-3 MB PNGs instead of the 8 KB thumbnails that already exist on disk

`🟠 high` ｜ 工作量 `medium`

- **证据**：apps/api/app/canvas.py `make()` sets `"thumbnailUrl": asset.thumbnail_url if url == full_url else None` — only the asset's single representative image gets a thumbnail; every other variant of a batch gets None. apps/api/app/assets.py:539 and :646 call `maybe_upgrade_thumbnail_url` only for that one representative URL, so `ensure_thumbnails` (apps/api/app/thumbnails.py:48) never runs per-variant. The frontend then falls back to the original: apps/web/src/canvas/CanvasNodeCard.tsx:26 `const thumb = assetUrl(node.thumbnailUrl || node.url || undefined)` and :31 for stack previews. Measured in .local/artifacts: `ai-local-edit-8fce1c221882.png` = 2,736,152 bytes vs `ai-local-edit-8fce1c221882-thumb-256.webp` = 9,270 bytes (~295x). Also `grep -rn 'loading="lazy"' apps/web/src/canvas/` returns 0 — all 11 canvas <img> tags load eagerly, including off-screen nodes.
- **影响**：Confirmed and sharpened: ReactFlow is mounted without `onlyRenderVisibleElements` (ProjectCanvas.tsx:1110-1132), so every node in the graph is in the DOM and every <img> fetches eagerly regardless of viewport. At the measured 1.39 MB PNG average, a 16-variant project pulls ~22 MB on open to paint 220x248 cards. Fix is two-part: generate thumbnails per output URL in assets.py (they don't exist yet), resolve them in canvas.py make(), and add loading="lazy" + onlyRenderVisibleElements.
- **修法**：In apps/api/app/assets.py call `ensure_thumbnails` for every output URL when archiving a multi-variant job, and in apps/api/app/canvas.py `make()` resolve each variant's own `-thumb-256.webp` (the naming in thumbnails.py `_thumb_path` is deterministic) instead of returning None. Add `loading="lazy"` and explicit width/height to the <img> tags at CanvasNodeCard.tsx:264, :272, :287, :368.

#### FastAPI 422 validation arrays render to users as the literal string "[object Object]"

`🟠 high` ｜ 工作量 `trivial`

- **证据**：apps/web/src/home/HomePage.tsx:486-489 and apps/web/src/home/ProjectsPage.tsx:194-198 both type the body as `{ detail?: string }` and do `throw new Error(payload?.detail ?? \`创建失败：${response.status}\`)`. FastAPI returns `detail` as an array for validation errors — verified against the running app: `POST /v1/projects {"name":"x","designPrompt":"a"*3000}` returns 422 `{'detail': [{'type':'string_too_long','loc':['body','designPrompt'],'msg':'String should have at most 2000 characters'}]}`. `new Error([{...}]).message` evaluates to `"[object Object]"` (verified with node). The path is reachable: the HomePage prompt textarea (HomePage.tsx:802-808) has no `maxLength` and its value is sent as `designPrompt`, which apps/api/app/schemas.py:25 caps at 2000 chars.
- **影响**：Confirmed as stated. Pasting a >2000-char design brief into the home prompt box yields an error banner reading exactly '[object Object]'. Trivial fix: import apiError from workflow/media.ts at both call sites and add maxLength={2000} to the textarea.
- **修法**：Replace both inline parsers with the existing `apiError(detail, status)` from apps/web/src/workflow/media.ts:35, which already handles the array case. Add `maxLength={2000}` to the HomePage textarea so the failure never reaches the server.

#### Canvas toasts are the only error surface, never auto-dismiss, have no dismiss control, and are invisible to screen readers

`🟠 high` ｜ 工作量 `small`

- **证据**：apps/web/src/canvas/ProjectCanvas.tsx:1398-1400 renders `{error && !inAnyFocus ? <div className="canvas-toast canvas-toast-error">{error}</div> : null}` and `{notice ? <div className="canvas-toast">{notice}</div> : null}`. `setNotice('')` appears exactly once in the 1578-line file (line 462, a preview-specific cleanup); there is no timer, no close button, and the CSS at apps/web/src/canvas/theme.css:391-409 has no animation or auto-hide. `setNotice` is called from ~30 sites including every catch block in useCanvasRunAction.ts (:243, :298, :334, :370, :406, :636). Neither div carries `role="status"`, `role="alert"` or `aria-live` — `grep -rn 'aria-live|role="status"|role="alert"' apps/web/src` matches only AssetLibrary.tsx:1802, home/UserSheet.tsx:459 and legacy/AiDesignWorkflow.tsx:1941.
- **影响**：Downgrade to low. A notice or error stays pinned top-right/top-left until the user triggers another action (cleared at useCanvasRunAction.ts:129 / ProjectCanvas.tsx:341), which is untidy rather than blocking — nothing is obscured, since the toast is a 360px box in the corner. The genuinely cheap wins are a `useEffect` timeout on `notice` and `role="alert"` on the error div; the dismiss button and full a11y pass are optional for this deployment.
- **修法**：Add `role="status"` (notice) / `role="alert"` (error) plus `aria-live` to both divs, auto-clear `notice` via a `useEffect` timeout keyed on the message, and add a dismiss button to the error toast.

#### The generation dialog cannot be closed with the keyboard and does not trap or restore focus

`🟡 medium` ｜ 工作量 `small`

- **证据**：apps/web/src/canvas/GenerateLayoutDialog.tsx:172-178 declares `role="dialog" aria-modal="true"` but the component has no keydown effect, no `autoFocus`, no focus trap and no focus restore — the only dismissals are the overlay `onClick={onCancel}` (:171) and the ✕ / 取消 buttons. The global Escape handler in ProjectCanvas.tsx:908-937 handles structureEditor, localEdit, stackGallery, layoutDetail, contextMenu, spawnMenu and panel but never touches `generateDialog` (state at :120, cleared only at :1474 and :1485). Worse, that handler returns early at :910 `if (isEditableTarget(event.target)) return`, and the dialog's prompt textarea (:215-222) is exactly such a target, so Escape is dead while the user is typing.
- **影响**：Confirmed but medium-low, not medium: three mouse dismissals exist (overlay, ✕, 取消), so nobody is trapped — the cost is a broken reflex (Esc does nothing on the modal that gates every generation) and an aria-modal dialog that leaks Tab focus to the canvas behind it. Fix is ~10 lines local to GenerateLayoutDialog: keydown→onCancel on Escape, autoFocus the textarea, restore focus on unmount.
- **修法**：Add a local keydown effect in GenerateLayoutDialog calling `onCancel` on Escape, `autoFocus` the textarea on mount, restore focus to the trigger on unmount, and cycle Tab within the dialog container.

#### Batch node PATCH 500s on non-numeric input, silently drops unknown IDs, and leaks SQL on FK violations

`🟡 medium` ｜ 工作量 `small`

- **证据**：apps/api/app/main.py:2464-2473 does `node.x = float(item["x"])` on raw dict entries. Verified: `PATCH /v1/canvases/{id}/nodes/batch {"nodes":[{"id":"<real>","x":"abc"}]}` raises an unhandled `ValueError: could not convert string to float: 'abc'`. Lines 2458-2463 `continue` past any entry whose id is missing, unknown, deleted or belongs to another canvas — verified `{"nodes":[{"id":"nope","x":5}]}` returns `200 []`. The body schema is `CanvasNodeBatchPatch.nodes: list[dict[str, Any]]` (schemas.py:421) with no per-item validation, while the purpose-built `CanvasNodePatch` (schemas.py:412) is imported at main.py:69 and never used. Related: `POST /v1/canvases` with a nonexistent projectId and `POST .../nodes` with a nonexistent assetId both leak raw `psycopg.errors.ForeignKeyViolation` as unhandled 500s (main.py:2319, :2418 never check existence). `CanvasNodeCreate.x: float` also accepts JSON `NaN` — verified 201 returning `"x": null` despite `CanvasNodeRead.x: float`.
- **影响**：Downgrade to low today, but it is a genuine prerequisite for finding [0]. Nothing can reach these handlers from the product, so no user is affected now. The value of the finding is that it prices the 'ship it' branch of [0]: wiring onNodeDragStop to PATCH /nodes/batch against the current handler would give you 500s on any malformed coordinate and silent success on stale node ids. Fix the schema (typed list item with required id) before wiring, not after.
- **修法**：Change `CanvasNodeBatchPatch.nodes` to `list[CanvasNodeBatchItem]` extending `CanvasNodePatch` with a required `id: str`; return 404 or a per-item `{applied, skipped}` result instead of `continue`; add existence checks for project/asset/job before insert and map IntegrityError to 422; constrain x/y/w/h with `Field(allow_inf_nan=False)`.

#### Local edit silently falls back to a hardcoded space id when asset metadata is unreadable

`🟡 medium` ｜ 工作量 `trivial`

- **证据**：apps/web/src/canvas/ProjectCanvas.tsx:543-551: `let spaceId = 'room_living'` then `if (resp.ok) { ... if (typeof sid === 'string' && sid.trim()) spaceId = sid.trim() }`. If `GET /v1/assets/{id}` fails or the metadata has no `spaceId`, the failure is never surfaced and the hardcoded default flows into the local-edit session (:552-558) and on to the job payload. The backend validates it at apps/api/app/schemas.py:328 `if self.space_id not in room_ids: raise ValueError("spaceId 不属于 semanticLayout.rooms")`.
- **影响**：Downgrade to low — narrow trigger (asset fetch failure), but the failure mode is bad when it hits: either a paid generation is applied to whatever room happens to be called room_living, or the user gets an opaque Chinese 422 about a spaceId they never selected, with the real cause (a failed fetch) never shown. One-line fix: drop the literal, abort entering local-edit and setNotice on a failed/absent lookup.
- **修法**：Remove the `'room_living'` literal. If the asset fetch fails or yields no spaceId, surface an actionable notice ('无法确定要修改的空间，请重新打开该方案') and abort entering local-edit mode instead of guessing.

#### Asset lists are hard-capped at 100 with no pagination UI, and offset is broken by post-SQL filtering

`🟡 medium` ｜ 工作量 `medium`

- **证据**：Every caller uses a fixed limit and no offset: apps/web/src/AssetLibrary.tsx:955 `'/v1/assets?limit=100'`, apps/web/src/home/ProjectsPage.tsx:102 `'/v1/assets?limit=100'`, apps/web/src/home/HomePage.tsx:423 `'/v1/assets?limit=24'`. `grep -rn 'hasMore|setOffset|加载更多' apps/web/src` returns nothing. Server-side, apps/api/app/main.py:1148 applies `.order_by(...).offset(offset).limit(limit)` in SQL, then lines 1151-1158 filter the returned page in Python by `module_key` and `metadata.workflowStage` — so a `moduleKey=layout&limit=50` request can return 3 rows, and advancing `offset` by 50 skips rows that were never shown. No endpoint returns a total count.
- **影响**：Confirmed at medium. Today's user-visible bug is the silent truncation: past 100 assets the library shows the newest 100 with no indication anything is missing and no way to reach the rest. The offset/filter interaction is latent (no caller passes offset) but it is a trap: it makes the documented `offset` parameter unusable for exactly the filtered queries the UI uses. Push moduleKey/workflowStage into the SQL WHERE (both live in metadata_json) before adding any paging.
- **修法**：Move `module_key` and `workflowStage` into the SQL WHERE clause (both live in `metadata_json`, so use a JSON path predicate) so offset/limit apply after filtering; return a total count alongside the rows; add incremental loading to AssetLibrary.

#### Zero component and E2E tests despite five installed test dependencies and an unconfigured test environment

`🟡 medium` ｜ 工作量 `large`

- **证据**：All 12 frontend test files are pure-function `.ts` modules under apps/web/src/canvas (actionLabels, activeJobs, buildCanvasFlow, canRunAction, layoutMath, menuMath, nodeStage, resumeActiveJobs, skeletonMath, spawnDerive, stackMath, stageDetail). `grep -rln '@testing-library' apps/web/src` returns nothing, so `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` and `jsdom` are installed and unused. `@playwright/test` is installed but there is no playwright.config and no e2e directory. apps/web/vite.config.ts has no `test` block at all, so vitest runs in the default `node` environment — a component test could not even mount today. That leaves 29 .tsx files (~20k lines), including ProjectCanvas.tsx (1578) and useCanvasRunAction.ts (699), with no coverage.
- **影响**：Confirmed at medium as a standards gap, with the caveat that 12 real unit-test files do exist — the pure-function layer (layout math, stack math, canRunAction, resumeActiveJobs) is genuinely covered, which is the part most worth covering. The concrete gap is that ~29 .tsx files including ProjectCanvas.tsx (1578) have no render coverage, and the one-line enabler (`test: { environment: 'jsdom' }`) is missing, so nobody can even start. Add the config plus render tests for GenerateLayoutDialog and the error-parsing paths in HomePage/ProjectsPage — the two surfaces that produced confirmed findings [2] and [4].
- **修法**：Add `test: { environment: 'jsdom', setupFiles: [...] }` to vite.config.ts, then write render tests for the highest-risk surfaces first: GenerateLayoutDialog (Escape/focus), CanvasNodeCard (FAILED/CANCELED/skeleton states), LocalEditDock (load error state), and the error-parsing paths in HomePage/ProjectsPage. Add one Playwright flow for upload → structure confirm → layout → color plan, or drop @playwright/test.

#### 8 of 12 runtime npm dependencies are unused, including zod — which the project's own rules mandate for boundary validation

`🟡 medium` ｜ 工作量 `trivial`

- **证据**：`grep -rn` across apps/web/src returns zero matches for `@hookform/resolvers`, `@tanstack/react-query`, `axios`, `konva`, `react-hook-form`, `react-konva`, `zod` and `zustand`. Only `@xyflow/react`, `react`, `react-dom` and `react-router-dom` are imported. Disk cost: zod 6.3M, @tanstack 4.7M, @hookform 2.2M, react-hook-form 2.1M, axios 2.0M, konva 1.8M, zustand 252K, react-konva 108K ≈ 19 MB. Separately, all 29 sites of the form `(await response.json()) as X` (e.g. ProjectCanvas.tsx:351 `as CanvasGraph`, resumeActiveJobs.ts:56 `as Job[]`, HomePage.tsx:490 `as Project`) are unchecked casts — no runtime validation of any API response.
- **影响**：Downgrade to low. Real value here is hygiene plus one substantive point: the canvas trusts every field of an untyped /canvas-graph response, so a backend shape change surfaces as an undefined-property crash inside React Flow rather than a handled error. `npm uninstall` the seven genuinely unused packages, keep zod, and safeParse exactly one thing — the /canvas-graph body at ProjectCanvas.tsx:351. Do not undertake a codebase-wide schema-validation pass.
- **修法**：`npm uninstall @hookform/resolvers @tanstack/react-query axios konva react-hook-form react-konva zustand`. Keep zod and use it: define a `CanvasGraph` schema in apps/web/src/canvas/types.ts and `safeParse` the `/canvas-graph` response at ProjectCanvas.tsx:351, surfacing a real error instead of crashing.

#### The app still hard-locks to a 1120px minimum width and the canvas stylesheet has no media queries at all

`🟡 medium` ｜ 工作量 `medium`

- **证据**：apps/web/src/App.css:59 `body { min-width: 1120px; }` — unchanged. App.css contains exactly 1 `@media` rule across 5721 lines; apps/web/src/canvas/theme.css contains 0 across 3005 lines; only home/home.css has 10. App.css is loaded on `/assets` (apps/web/src/home/AssetsPage.tsx:4) and via App.tsx:20, so the `min-width` on `body` applies globally.
- **影响**：Downgrade to low. Concrete effect is narrow: viewports under 1120px (a half-screen window on a 13" laptop) get whole-page horizontal scrolling on every route including the home page, which never needed the constraint — home.css already uses `min-width: 0` throughout. The worthwhile change is one line: move the 1120px floor off `body` onto the legacy workspace/AssetLibrary shells that actually depend on it. Skip the canvas breakpoint work.
- **修法**：Replace `body { min-width: 1120px }` with `min-width: 0`, moving any genuinely required minimums onto the specific components that need them, and add at least one breakpoint in canvas/theme.css collapsing `.cw-bottom-left` and `.cw-center-bar` into a single row below ~900px.

#### Backend validation errors reach Chinese users as raw English Pydantic strings (the real i18n issue)

`⚪ low` ｜ 工作量 `small`

- **证据**：apps/web/src/workflow/media.ts:35 `apiError` maps a 422 `detail` array to `detail.map(item => item.msg).join('; ')` and drops `loc` entirely. Verified server response for an over-length prompt: `msg: "String should have at most 2000 characters"`. The same applies across every multipart AI-workflow endpoint (main.py:1556-2110), which declare constraints via `Form(..., min_length=, max_length=, pattern=)` and therefore emit stock English Pydantic messages. Hand-written `HTTPException` details are correctly Chinese (e.g. main.py:173, :1594, :1679), so the UI mixes the two.
- **影响**：Confirmed at low. A user who writes a long local-edit instruction sees the toast 'String should have at most 1000 characters' in an otherwise all-Chinese UI, with no indication of which field. Cheapest correct fix is client-side: add maxLength to the prompt textareas so the request never leaves the browser. A RequestValidationError handler mapping (loc, type) to Chinese is the thorough version and worth it only if more Form-validated free-text fields are added.
- **修法**：Add a `RequestValidationError` handler in apps/api/app/main.py that maps `(loc, type)` to Chinese messages (e.g. `string_too_long` → `{字段}最多 {limit} 个字符`) and returns `detail` as a single string, so all clients receive one localized shape.

#### apiError is triplicated with divergent behaviour, and dead runGeneration swallows FAILED jobs

`⚪ low` ｜ 工作量 `small`

- **证据**：`apiError` is defined three times with different separators: apps/web/src/workflow/media.ts:35 (joins with `'; '`), apps/web/src/workflow/actions.ts:70 (`'; '`), apps/web/src/legacy/AiDesignWorkflow.tsx:269 (`'；'`), plus five more ad-hoc inline copies at home/ProjectsPage.tsx:269-278, home/ProjectsPage.tsx:194-197, home/HomePage.tsx:617-626, home/HomePage.tsx:485-489 and canvas/CanvasChrome.tsx:112. Separately, `runGeneration` (apps/web/src/workflow/actions.ts:193-210) has zero callers (`grep -rn runGeneration apps/web/src` matches only its definition) and, unlike `postAndPoll` in canvasRunner.ts:142-163, returns the completed job without checking `status === 'FAILED'`, so it would resolve successfully on a failed generation. apps/web/src/canvas/SpikeCanvas.tsx is likewise reachable only through canvas/index.ts:2 and never rendered.
- **影响**：Downgrade to trivial/cleanup. No user impact: runGeneration and SpikeCanvas are unreachable, and the two live apiError copies behave identically. Worth doing only as part of the [2] fix — delete actions.ts:70's copy and import media.ts's, delete runGeneration and SpikeCanvas. Do not schedule as its own item.
- **修法**：Delete the duplicate `apiError` in actions.ts and the five inline copies, importing the media.ts one everywhere. Delete `runGeneration` (actions.ts:193-210), SpikeCanvas.tsx, and its export at canvas/index.ts:2.


## 附录 B：被对抗性验证推翻的 4 条

初审提出、复核源码后不成立。记录于此以免重复讨论。

**B1.** API responses echo absolute server filesystem paths back to clients — *安全与租户隔离*

驳回理由：The mechanics are accurate — JobRead.payload (schemas.py:62) is unfiltered and the payloads do carry absolute paths (main.py:1507, 1702, 1716, 2054, 2101, all built from settings.artifact_dir in storage.py:127) — and I confirmed the frontend does not need them (the only payload reads are BatchProgress.tsx:8-10, canvas/resumeActiveJobs.ts:20-32, canvas/activeJobs.ts:133, workflow/concurrency.ts:33, none of which touch a *_path key). But the finding grades its own impact honestly as 'Harmless on a single-user laptop', and that is the whole story: the only party that can read these responses is the operator, on their own machine, about their own filesystem. CORS prevents a cross-origin page fro …

**B2.** Every graph apply triggers a second full node rebuild that erases the failed-skeleton action rule — *新画布代码正确性*

驳回理由：The functional half is a misread. CanvasNodeCard derives its own failure clause: `const skeletonFailed = node.isSkeleton && (jobStatus === 'FAILED' || 'CANCELED')` and `const showFooter = payload.showActions || skeletonFailed` (CanvasNodeCard.tsx:55-58). So even after the effect at ProjectCanvas.tsx:373-399 rewrites data.showActions to `item.id === selectedId`, a failed/cancelled placeholder still renders its footer — nothing is lost. The perf half is accurate (parentAssetIdsFromGraph returns a fresh Set at buildCanvasFlow.ts:59-65, so setDownstreamByAsset always changes identity and the effect always fires), but it is a duplicate setNodes on a canvas of a few dozen 220px cards, roughly once …

**B3.** Legacy local-edit panel silently dies on a tainted canvas — *新画布代码正确性*

驳回理由：Both premises fail. (1) The branch is unreachable: every local_edit route ends in LocalEditDock — useCanvasRunAction.ts:455-460 diverts `local_edit` with a node to openLocalEditDock before executeCanvasAction, and both needPanel handlers intercept kind === 'local_edit' (:580-586, :593-596); canvasRunner.ts:836-856 only produces that panel for a node with assetId+url, so setPanel({kind:'local_edit'}) is never reached and CanvasStagePanel's editor cannot render. (2) The tainting premise is wrong for the actual deployment: CORSMiddleware is installed app-wide (main.py:116-117) with cors_origins defaulting to http://127.0.0.1:5173,http://localhost:5173 (config.py:37), and it wraps the /artifacts …

**B4.** Sibling REST endpoints disagree on status codes, request shapes, and which parameters are honoured — *API 契约与前端质量*

驳回理由：The individual observations are accurate but the finding does not survive as a defect. Four of its six points (200-vs-204 deletes, PATCH reusing CanvasCreate, required-then-ignored canvasId at schemas.py:384, and the batch handler) are all inside the /v1/canvases API that finding [0] establishes has zero clients — so the stated impact, 'clients must special-case each endpoint', is false: there is exactly one client and it calls none of them. Point 5 is wrong as a defect: `idempotency_key: IdempotencyKeyHeader = None` at main.py:1107 is a shared Annotated alias declared on ~10 handlers; an unused optional header on a GET costs nothing. Point 4 (canvas-graph has no response_model) is real but …
