# Room Design MVP API

## 启动

```bash
cd /Users/bolin/Documents/AI/room_design
conda activate llf_v1

cp apps/api/.env.example apps/api/.env

cd apps/api
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

默认也支持不创建 `.env`，此时使用工作区 `.local/room_design.db` SQLite 数据库。

接口文档：

- Swagger: http://127.0.0.1:8000/docs
- 健康检查: http://127.0.0.1:8000/health

## 测试

```bash
cd /Users/bolin/Documents/AI/room_design/apps/api
conda activate llf_v1
pytest
```

图像生成暂用本地演示适配器。模块三优先调用 Blender，调用失败时返回基础场景预览。

