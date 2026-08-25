# 通关反馈收集服务（可选开发工具）

比赛提交仍是纯静态、无后端；本服务只在你想收集通关后的「难度 / 趣味」评分时启用。
数据以 JSONL 追加写入 `server/data/feedback.jsonl`（已 gitignore，不会进仓库）。

## 本地跑

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --app-dir server --host 127.0.0.1 --port 8787
# 或直接：python server/app.py（端口可用环境变量 FEEDBACK_PORT 覆盖）
```

## 接前端（构建期开关 `VITE_FEEDBACK_ENDPOINT`）

- **dev**：默认已开启，端点就是上面的 `http://127.0.0.1:8787`，无需任何配置。
- **生产构建**：设置环境变量再构建
  ```bash
  VITE_FEEDBACK_ENDPOINT=https://<你的地址> pnpm build
  ```
  不设置时反馈功能完全休眠（不渲染 UI、不发请求），产物保持纯静态零联网。
- **临时覆盖**：任何环境下可用 `?fb=<url>` 查询参数覆盖端点，不用重新构建。

## 公网暴露（cloudflared）

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

把返回的 `https://xxx.trycloudflare.com` 配置为 `VITE_FEEDBACK_ENDPOINT` 后重新构建前端即可。
注意：快速隧道（quick tunnel）地址每次重启都会变；长期收集请改用命名隧道
（`cloudflared tunnel create` 固定域名），或把评分页部署与隧道地址解耦后再固定构建。

## API

- `POST /api/feedback` — body `{game, level, levelId, difficulty, fun, moves?, par?}` → `{ok, id}`
  - `difficulty` / `fun` 取值 1–5，服务端校验。
- `GET /api/feedback` — `{count, file}`（调试用，已收集行数）
- `GET /health` — `{ok: true}`

CORS 全开（静态托管来源域名不固定）；要收口时改 `server/app.py` 里的 `allow_origins`。
