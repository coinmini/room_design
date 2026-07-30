# AI 室内设计四模块 MVP

这是一个可在本机运行的首版业务闭环，包含：

1. AI 家装平面布局：按房间尺寸和固定家具规则生成最多两套无硬碰撞方案。
2. AI 白模渲染：上传白模截图，输出结构控制图和两张风格候选图。
3. 平面图生效果图：根据结构化房间与家具数据构建 Blender 场景并生成单机位效果图。
4. 多材质替换：上传室内图，绘制墙面/地面蒙版并生成材质替换对比图。

当前图像生成部分使用本地可替换演示适配器，目的是先验证交互、数据、任务和结果闭环，不承诺生产级写实质量。

## 本地启动

环境和依赖已安装后，在项目根目录运行：

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/dev.sh
```

启动完成后访问：

- Web：http://127.0.0.1:5173
- API 文档：http://127.0.0.1:8000/docs
- 健康检查：http://127.0.0.1:8000/health

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

## 本地验证

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/check.sh
```

验证项包括后端 Ruff、后端 API 测试、前端 ESLint 和前端生产构建。

## 数据与生成物

- 业务数据库：本机 PostgreSQL `room_design`
- 生成文件：`.local/artifacts/`
- API 配置：`apps/api/.env`
- 前端 API 地址：默认 `http://127.0.0.1:8000`

如暂时不使用 PostgreSQL，删除或重命名 `apps/api/.env` 后会自动使用 `.local/room_design.db`。

> AI 结果用于概念设计与效果预览，不作为尺寸、材料色差或施工依据。
