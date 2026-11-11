# Where Are We Eating

项目起步版。React 和 Express 通过 `GET /api/health` 验证连通，Supabase 的本地配置和环境变量模板可用于接下来的开发。

## 启动 React 和 Express

使用 Node.js 24，在本目录执行：

```bash
npm ci
npm run dev
```

打开 http://localhost:5173，页面应显示 `API connected`。也可以打开 http://localhost:3000/api/health，预期返回 `{"status":"ok"}`。健康检查只验证 Express。

## 启动本地 Supabase

启动 Docker，再执行：

```bash
npm run db -- start
npm run db -- status
cp client/.env.example client/.env
cp server/.env.example server/.env
```

按 `db status` 的输出填写 API URL 和 publishable key。Supabase Studio 在 http://127.0.0.1:54323。完成后可以用 `npm run db -- stop` 停止服务。

Supabase 配置和 SDK 依赖已就绪。接下来可以实现登录，并按 proposal 添加数据库迁移和投票流程。
