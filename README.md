# AI 室内设计 V0.2

这是一个可在本机运行的室内设计验证闭环。V0.2 在原有四模块基础上增加“真实平面图结构化生效果图”：

1. 平面图结构化：上传清晰正交户型图，校正自动墙线、补画墙线、框选房间，输出 Blender 俯视白模、室内机位和增强效果图。
2. AI 家装平面布局：按房间尺寸和固定家具规则生成最多两套无硬碰撞方案。
3. AI 白模渲染：上传白模截图，输出结构控制图和两张风格候选图。
4. 参数化效果图：根据结构化房间与家具数据构建 Blender 场景并生成单机位效果图。
5. 多材质替换：上传室内图，绘制墙面/地面蒙版并生成材质替换对比图。

当前图像增强部分使用本地可替换演示适配器，目的是验证交互、结构数据、任务和结果闭环，不承诺生产级写实质量。V0.2 的详细边界与验收标准见 [技术方案](AI室内设计V0.2平面图结构化生效果图技术方案.md)。

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

如果“平面图结构化”提示后端版本低于 V0.2，或
`POST /v1/floorplans/analyze` 返回 404，说明 8000 端口仍运行着旧进程。
停止旧服务后重新执行 `./scripts/dev.sh`，并确认
`http://127.0.0.1:8000/health` 返回 `"version": "0.2.0"`。

## 本地验证

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1
./scripts/check.sh
```

验证项包括后端 Ruff、后端 API 测试、前端 ESLint 和前端生产构建。

V0.2 固定测试图为 `example/平面图.jpeg`。建议输入总宽 `8150 mm`、总深 `6060 mm`；系统会提示该图宽深方向比例存在差异，需要用户确认。

## 数据与生成物

- 业务数据库：本机 PostgreSQL `room_design`
- 生成文件：`.local/artifacts/`
- API 配置：`apps/api/.env`
- 前端 API 地址：默认 `http://127.0.0.1:8000`

如暂时不使用 PostgreSQL，删除或重命名 `apps/api/.env` 后会自动使用 `.local/room_design.db`。

> AI 结果用于概念设计与效果预览，不作为尺寸、材料色差或施工依据。
