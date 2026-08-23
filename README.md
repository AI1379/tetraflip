# Lexin Games

比赛 H5 解谜游戏项目（≥50 关、纯玩法、无剧情无美术包装）。当前处于**双原型并行验证**阶段，同一套引擎骨架上跑两个候选玩法：

| 原型 | 代号 | 一句话规则 | 状态 |
| --- | --- | --- | --- |
| **t+3** | `src/games/t3` | 每次方向输入，会在延迟若干回合后再次控制另一枚棋子 | v0 可玩（1 关） |
| **Inversion** | `src/games/chem` | 只能从开口臂的背面撞入中心，撞入后中心构型翻转（SN2 立体化学的纯规则抽象） | v0 可玩（1 关） |

哪个原型活下来，由「第 5 关测试」决定，见 [设计文档](docs/design.md) §3。

## 快速开始

```bash
pnpm install
pnpm dev          # 本地开发服务器
pnpm test         # 引擎与 solver 测试
pnpm typecheck    # 类型检查
pnpm build        # 产出静态站点到 dist/（可直接静态托管）
pnpm solve t3 level-01     # 命令行 solver 验证关卡可解
```

## 目录结构

```
src/
  core/           共享层：GameDefinition 协议、通用 BFS solver、撤销栈、关卡加载、键盘、补间
  games/
    t3/           t+3：level.ts（zod 校验）/ engine.ts（纯函数引擎）/ render.ts / levels/*.json
    chem/         Inversion：同上结构
  shell/          浏览器壳：游戏切换、HUD、撤销/重开、画布宿主（唯一允许 any 的胶合层）
scripts/
  solve.ts        命令行 solver（未来 AI 关卡 pipeline 的验证环节复用它）
docs/
  design.md       设计思路文档（比赛要求）
  iteration.md    迭代演进文档（比赛要求）
```

## 文档（比赛要求）

- [docs/design.md](docs/design.md) — 设计思路：机制定义、候选方案与淘汰理由、50 关曲线、AI 关卡 pipeline、架构决策
- [docs/iteration.md](docs/iteration.md) — 迭代演进：按时间记录的每次设计/实现迭代
- [AGENTS.md](AGENTS.md) — 协作规范（AI 代理与人类协作者必读，含文档维护硬性要求）

## 技术栈

vanilla TypeScript + Vite + Canvas 2D，唯一运行时依赖 `zod`（关卡校验）。
引擎层零 DOM、零副作用、纯函数，同一份代码在浏览器运行、也被 Node 侧的 solver 复用。
不引入前端框架、物理引擎、后端服务。
