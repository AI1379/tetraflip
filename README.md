# 《109.5°》

《109.5°》是一个纯玩法的 H5 Canvas 解谜游戏。它把“从背面进入、整体翻转、交换手中物”的直觉规则，逐步扩展成共振、光照、空穴、弹射和阶段护罩，玩家不需要化学知识也能游玩；化学原理只是设计底层的灵感。

项目是比赛提交作品，默认构建为纯静态页面：没有后端依赖、没有运行时联网请求，也不需要美术资源。

## 当前内容

- **01–50：主线教学曲线**。从核心搬运开始，依次学习共振、光照分步目标、三臂空穴、弹射中心、阶段护罩和综合解题；50《终局》是唯一的主线终局。
- **51–74：通关后正式挑战**。分为「进阶综合」「全机制组合」「转辙与红线」三章，保留 `moveLimit` 步数预算带来的高压题型。
- **LV.999：发现制隐藏彩蛋**。物理序号为 75，故意不服从前面曲线，不参与难度排序或曲线拟合；它是独立的全机制压力测试。

全部 75 个 JSON 关卡都经过 zod 校验和 BFS 最短解验证；涉及空穴、弹射、护罩等特殊机制的关卡另有语义轨迹或约束测试。LV.999 在普通选关界面默认隐藏，避免破坏发现感；评审或开发可用深链接直接进入。

## 怎么玩

每回合只有四方向移动。玩家站到中心开口的背面并撞入，中心会整体翻转；携带色珠撞入时，手中珠进入中心，原开口珠交换到手中。随着关卡推进，还会遇到：

- 相邻同色臂之间的共振传播；
- 会改变全场开口方向的光照格；
- 带缺口的三臂中心（空穴）；
- 会把珠子送到指定格或中心的弹射中心；
- 按阶段解除、或由中间产物重新生成的护罩。

桌面端支持方向键和 `WASD`，棋盘支持触屏滑动；`Z` / `Backspace` 撤销，`R` 重开。按住方向可预演下一步，键盘预演松开会取消，轻点才执行。关卡内的提示、标记和 Inspect 面板都是辅助信息，不会替代解题。

## 快速开始

```powershell
pnpm install
pnpm dev                         # 启动本地开发服务器
```

常用验证命令：

```powershell
pnpm solve chem level-01         # 打印指定关卡的 BFS 最短解
pnpm trace:chem level-01         # 回放最短解并输出机制事件
pnpm audit:chem                  # 审计全部关卡的决策密度与走路税
pnpm test                        # TypeScript / Vitest 测试
pnpm typecheck                   # tsc --noEmit
pnpm build                       # 生成 dist/ 静态站点
```

## 难度曲线与机器实验

目前拿不到足量的真人完整首次尝试，因此 01–74 使用 `machine-controlled / human-uncalibrated` 口径：机器结果是发布阶段的代理证据，不冒充真人通关概率。

难度分析在离线环境完成，规则唯一事实源仍是 `src/games/chem/engine.ts`：

1. 精确状态图：最短距离、最短解数量、动作分岔、错误恢复代价、死局和预算脆弱性。
2. 固定预算随机玩家：`search-B` 在 B=8/32/128 下随机化动作顺序和探索误差，记录成功率、步数和重开分布。
3. Tabular RL：独立 Q-learning 基线，测量首次学会和达到稳定成功率所需样本。
4. 深度代理：Python 中的共享 MLP QR-DQN，使用同一 TypeScript JSONL bridge；只作为第四类交叉证据。

机器代理的配置、seed、原始记录和报告都落盘。带 `moveLimit` 的关卡同时跑移除红线的反事实，只有多种子、多代理同向且通过直接预算扫描时才允许进入调参候选。LV.999 永久排除在这些聚合之外，只生成独立压力签名。

Node 侧命令：

```powershell
pnpm difficulty:chem                # 状态图 + 随机预算层
pnpm difficulty:chem:rl             # TypeScript tabular RL
pnpm difficulty:chem:calibrate      # 机器特征校准工具
pnpm difficulty:chem:budget-sweep   # moveLimit 直接扫描
```

Python 深度代理使用 CPython 3.12 和 `uv pip` 管理，浏览器构建不会加载 Python、PyTorch 或模型权重：

```powershell
uv venv --python 3.12 ml/.venv
uv pip sync --python ml/.venv ml/requirements.lock
pnpm difficulty:chem:deep
pnpm difficulty:chem:deep:report
pnpm test:ml
```

当前实验结论和限制见 [docs/difficulty-report.md](docs/difficulty-report.md) 与 [docs/deep-difficulty-report.md](docs/deep-difficulty-report.md)。最新一轮把 51–56 的段末断崖改为可见的阶段检查点，并验证了新顺序；没有用单一深度模型的表征异常去强行改关。后续若继续研究，优先比较图结构 / attention 编码，而不是把隐藏历史塞进 GRU。

## 可选的试玩反馈收集

默认构建完全不联网。若要做受控试玩，可以单独启动开发用 FastAPI 收集器，并在构建时设置 `VITE_FEEDBACK_ENDPOINT`；只有明确同意的试玩链接加上 `telemetry=1` 才会上报匿名 attempt 摘要。Python 依赖同样用 `uv pip` 安装，细节见 [server/README.md](server/README.md)。

## 目录结构

```text
src/core/                   共享协议、BFS solver、状态图、统计与随机工具
src/games/chem/             游戏类型、纯函数引擎、渲染器、75 个 JSON 关卡
src/shell/                  浏览器壳、输入、HUD、进度、可选 telemetry
scripts/                    solver、trace、审计、难度实验与关卡分配脚本
ml/                         Python bridge、随机 / RL / QR-DQN 离线实验
docs/design.md              设计思路、机制定义、曲线和 AI pipeline
docs/iteration.md           按日期记录的实现与实验迭代
docs/playtest.md            真人盲测协议（当前用于未来校准和视觉验收）
```

## 技术约束

运行时使用 vanilla TypeScript、Vite、Canvas 2D 和 zod。引擎与 `core` 层零 DOM、零副作用，所有状态转移都是 `step(state, action) → 新 state`，因此同一套规则可以被浏览器、Node solver 和 Python bridge 复用。

提交前建议执行：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm audit:chem
```

设计决策和实验变更必须同步记录在 [docs/design.md](docs/design.md) 与 [docs/iteration.md](docs/iteration.md)；协作和提交纪律见 [AGENTS.md](AGENTS.md)。
