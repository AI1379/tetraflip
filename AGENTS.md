# AGENTS.md — 仓库协作规范

本文件约束所有在本仓库工作的 AI 编码代理与人类协作者。**改动任何代码前先读完本文件。**

## 项目一句话

比赛 H5 解谜游戏（≥50 关、纯玩法、无剧情无美术包装）。当前为双原型并行阶段：
`src/games/t3`（t+3，延迟多层控制）与 `src/games/chem`（Inversion，SN2 立体化学抽象）。
机制定义与设计理由见 `docs/design.md`，时间线见 `docs/iteration.md`。

## 硬约束（比赛规则）

- 纯 H5 静态页，无后端、无联网运行时依赖
- 关卡 ≥50 个，全部 JSON 化
- 不做故事、不做美术包装，评审只看玩法
- 截止 2026-08-31，时间极紧：一切决策优先权衡「实现风险 × 好玩收益」，避免过度工程

## 技术栈铁律

- vanilla TypeScript + Vite + Canvas 2D；唯一允许的运行时依赖是 `zod`
- 新增任何依赖必须有充分理由，默认拒绝
- 禁止引入前端框架、状态管理库、物理引擎、构建期之外的运行时服务

## 架构

- `src/core/` 共享层：`protocol.ts`（GameDefinition 协议）、`solver.ts`（通用 BFS）、`undo.ts`、`levels.ts`、`keyboard.ts`、`tween.ts`
- `src/games/<id>/` 每个游戏一个目录：`level.ts`（类型 + zod 校验）、`engine.ts`（纯函数引擎）、`render.ts`、`levels/*.json`
- `src/shell/` 浏览器胶合层（DOM / 键盘 / HUD / 画布宿主）——**只有这一层允许 `any`**（因为要桥接异构游戏类型）
- 引擎层与 core 层：零 DOM、零副作用、纯函数，必须能在 Node 中被 import（solver、测试、`scripts/solve.ts` 都依赖这一点）
- 所有状态转移走 `step(state, action) → 新 state`（不可变）；渲染层只读状态，禁止改状态

## 关卡规范

- 文件名 `level-XX.json`，序号零填充（决定关卡顺序）
- 入库关卡必须通过：zod 校验 + `pnpm solve <game> level-XX` 可解
- 关卡的最短解长度应符合该关的设计意图（不要出现绕开核心机制的捷径；发现捷径要改图并在文档中记录）

## 文档要求（比赛硬性要求，未遵守视为任务未完成）

比赛要求提交**详细的设计思路文档**与**迭代演进文档**，对应仓库中：

1. `docs/design.md` — 设计思路：机制定义、候选方案对比与淘汰理由、50 关曲线、AI 关卡 pipeline、架构决策。
   **任何玩法 / 规则 / 架构层面的决策变更，必须先在此文档记录「决策 + 理由」，再动代码。**
2. `docs/iteration.md` — 迭代演进：按时间追加条目。每个有意义的迭代（新机制、规则修改、关卡批次、pipeline 进展、重要修复）必须记录：日期 / 改了什么 / 为什么 / 如何验证 / 遗留问题。
3. 提交自检：涉及玩法、规则、关卡、架构的改动 → 两份文档同步更新；纯渲染 / 测试 / 重构 → 至少在 `iteration.md` 记一行。

## 其他纪律

- `prompt.txt` 是外部策划草稿，已通过 `.git/info/exclude` 排除，**不要提交进仓库**；也不要把外部对话原文复制进仓库——文档只写提炼后的结论与决策
- 引擎逻辑改动必须附带 vitest 测试（`src/**/*.test.ts`）
- 提交前跑：`pnpm typecheck && pnpm test && pnpm build`
- 提交信息用简洁中文或英文均可，说清「改了什么 + 为什么」

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 本地开发服务器 |
| `pnpm test` | 运行测试（vitest） |
| `pnpm typecheck` | 类型检查（tsc --noEmit） |
| `pnpm build` | 产出静态站点（dist/） |
| `pnpm solve <t3\|chem> level-XX` | 命令行 solver 验证关卡可解并打印最短解 |
