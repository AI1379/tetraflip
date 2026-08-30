# 通关反馈收集服务（可选开发工具）

比赛提交仍是纯静态、无后端；本服务用于收集匿名完整尝试，以及通关后的「难度 / 趣味」评分与快捷标签。
数据分别追加到 `server/data/attempts.jsonl` 与 `server/data/feedback.jsonl`（均已 gitignore，不会进仓库）。
完整尝试只含随机参与者 / 会话 / 尝试 ID、关卡、会话内尝试次序、教程 / 动画 / 输入方式实验条件、有效时长、结果和操作计数，不记录按键序列、设备指纹或个人信息。

## 本地跑

```powershell
uv venv --python 3.12 server/.venv
uv pip install --python server/.venv -r server/requirements.txt
server/.venv/Scripts/uvicorn.exe app:app --app-dir server --host 127.0.0.1 --port 8787
# 或直接：server/.venv/Scripts/python.exe server/app.py（端口可用环境变量 FEEDBACK_PORT 覆盖）
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

- `POST /api/feedback` — body `{game, level, levelId, difficulty, fun, moves?, par?, tags?}` → `{ok, id}`
  - `difficulty` / `fun` 取值 1–5，服务端校验。
  - `tags` 是可选数组，只接受：`rules_unclear`、`stuck_reasoning`、`controls_awkward`、`too_much_walking`、`too_easy`、`very_fun`；省略时按空数组处理。
- `GET /api/feedback` — `{count, file}`（调试用，已收集行数）
- `POST /api/attempt` — 接收前端 schema v1 的完整匿名尝试；通关、重开、换关和离开页面都会结束一条尝试。
- `GET /api/attempt` — `{count, file}`（调试用，已收集尝试行数）
- `GET /health` — `{ok: true}`

前端无论是否配置端点，都会在浏览器 `localStorage` 中滚动保留最近 500 条完整尝试；配置端点后再同时上报。页面隐藏期间不计入 `activeMs`，因此切走标签页不会虚增解题时间。
自动上报还要求试玩链接显式带 `telemetry=1`；该参数只在玩家知情同意后使用。普通入口即使配置了反馈端点也不会静默上传尝试。

CORS 全开（静态托管来源域名不固定）；要收口时改 `server/app.py` 里的 `allow_origins`。
