# 《109.5°》

比赛 H5 纯玩法解谜游戏。正式作品已定题为 **《109.5°》**：把 SN2 背面进攻、构型翻转和共轭传播抽象为四方向棋盘规则，现有 50 个正式关 + 10 个待删选综合候选，共 60 个 JSON 关卡。项目无后端、无运行时联网依赖，只使用程序化 Canvas 轻包装。

核心动作始终只有四方向移动：从中心开口的背面撞入，触发取代与 180° 翻转；后续关卡逐步加入共振、光照转轴、三臂空穴、弹射中心和护罩闸门。正式曲线为 01–09 核心搬运、10–15 共振、16–20 光照/分步、21–26 空穴、27–32 弹射、33–39 阶段护罩、40 复习、41–46 终盘新关系、47–50 综合 mastery；51–60 是用于横向试玩和后续删选的综合候选池。

定题前的落选研发原型《t+3》（延迟多层控制）已从仓库删除，候选比较与淘汰理由见 `docs/design.md`，历史代码在 git 记录中。

## 快速开始

```bash
pnpm install
pnpm dev          # 本地开发服务器
pnpm test         # 引擎与 solver 测试
pnpm typecheck    # 类型检查
pnpm build        # 产出静态站点到 dist/（可直接静态托管）
pnpm solve chem level-01   # 命令行 solver 验证关卡可解
pnpm audit:chem            # 审计全部关卡的决策密度与最长通勤
```

## 目录结构

```
src/
  core/           共享层：GameDefinition 协议、通用 BFS solver、撤销栈、关卡加载、键盘、补间
  games/
    chem/         《109.5°》正式游戏：level.ts / engine.ts / render.ts / 60 个 levels/*.json
  shell/          正式浏览器壳：HUD、撤销/重开、画布宿主（唯一允许 any 的胶合层）
scripts/
  solve.ts        命令行 solver（未来 AI 关卡 pipeline 的验证环节复用它）
docs/
  design.md       设计思路文档（比赛要求）
  iteration.md    迭代演进文档（比赛要求）
```

## 文档（比赛要求）

- [docs/design.md](docs/design.md) — 设计思路：机制定义、候选方案与淘汰理由、50 关正式曲线 + 10 关候选池、AI 关卡 pipeline、架构决策
- [docs/iteration.md](docs/iteration.md) — 迭代演进：按时间记录的每次设计/实现迭代
- [AGENTS.md](AGENTS.md) — 协作规范（AI 代理与人类协作者必读，含文档维护硬性要求）

## 通关反馈收集（可选，默认关闭）

默认构建**无任何联网行为**。想收集通关后的难度 / 趣味评分（各 1–5）与可选快捷标签：

1. 起后端：`pip install -r server/requirements.txt && uvicorn app:app --app-dir server --port 8787`（或 `python server/app.py`）
2. dev 下已默认开启；生产构建用 `VITE_FEEDBACK_ENDPOINT=<地址> pnpm build` 开启
3. 公网收集：`cloudflared tunnel --url http://127.0.0.1:8787`，用返回的 https 地址重建前端；隧道地址变化时也可用 `?fb=<url>` 临时覆盖，免重建

详见 [server/README.md](server/README.md)。

## 技术栈

vanilla TypeScript + Vite + Canvas 2D，唯一运行时依赖 `zod`（关卡校验）。
引擎层零 DOM、零副作用、纯函数，同一份代码在浏览器运行、也被 Node 侧的 solver 复用。
不引入前端框架、物理引擎、后端服务。
