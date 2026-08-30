from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any, Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
CHAPTERS = (
    ("核心搬运", 1, 6),
    ("共振", 7, 12),
    ("光照 / 分步", 13, 17),
    ("空穴", 18, 23),
    ("弹射", 24, 29),
    ("阶段护罩", 30, 36),
    ("结构碰撞", 37, 43),
    ("主线 mastery", 44, 50),
    ("赛后扩展", 51, 56),
    ("全机制组合", 57, 66),
    ("转辙与红线", 67, 74),
)


def load_report(path: Path, expected_condition: str) -> dict[str, Any]:
    report = json.loads(path.read_text(encoding="utf-8"))
    if report.get("schemaVersion") != 1:
        raise ValueError(f"unsupported report schema in {path}")
    if report.get("condition") != expected_condition:
        raise ValueError(
            f"expected {expected_condition!r} report at {path}, got {report.get('condition')!r}"
        )
    return report


def level_map(report: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {int(row["ordinal"]): row for row in report["aggregate"]}


def seed_level_map(report: dict[str, Any]) -> dict[tuple[int, int], dict[str, Any]]:
    return {
        (int(seed["seed"]), int(row["ordinal"])): row
        for seed in report["seeds"]
        for row in seed["levels"]
    }


def exact_reproduction_mismatches(
    actual: dict[str, Any], no_limit: dict[str, Any], ordinals: Iterable[int]
) -> list[str]:
    actual_rows = seed_level_map(actual)
    no_limit_rows = seed_level_map(no_limit)
    mismatches: list[str] = []
    for ordinal in ordinals:
        for seed in actual["config"]["seeds"]:
            left = actual_rows[(int(seed), ordinal)]
            right = no_limit_rows[(int(seed), ordinal)]
            fields = ("episodesTrained", "episodesToThreshold", "prior", "final")
            if any(left[field] != right[field] for field in fields):
                mismatches.append(f"L{ordinal:02d}/seed-{seed}")
    return mismatches


def threshold_text(row: dict[str, Any], cap: int) -> str:
    value = row["medianEpisodesToThreshold"]
    if value is None:
        return f">{cap}"
    return str(int(value))


def median_learned(rows: Iterable[dict[str, Any]]) -> str:
    values = [
        float(row["medianEpisodesToThreshold"])
        for row in rows
        if row["medianEpisodesToThreshold"] is not None
    ]
    return str(int(statistics.median(values))) if values else "—"


def budget_128_success(machine_row: dict[str, Any]) -> float:
    match = next(
        row
        for row in machine_row["randomized"]
        if int(row["summary"]["planningBudget"]) == 128
    )
    return float(match["summary"]["successRate"])


def no_limit_budget_128_success(machine_row: dict[str, Any]) -> float | None:
    row = machine_row.get("counterfactualWithoutMoveLimit")
    if row is None:
        return None
    match = next(
        report
        for report in row["randomized"]
        if int(report["summary"]["planningBudget"]) == 128
    )
    return float(match["summary"]["successRate"])


def paired_recovery(
    actual_row: dict[str, Any], no_limit_row: dict[str, Any], *, minimum_gain: int = 1_000
) -> bool:
    if int(no_limit_row["thresholdReachedSeeds"]) < 2:
        return False
    actual_median = actual_row["medianEpisodesToThreshold"]
    no_limit_median = float(no_limit_row["medianEpisodesToThreshold"])
    return (
        int(actual_row["thresholdReachedSeeds"]) < 2
        or actual_median is None
        or float(actual_median) - no_limit_median >= minimum_gain
    )


def format_ordinals(ordinals: Iterable[int]) -> str:
    values = list(ordinals)
    return "、".join(f"{value:02d}" for value in values) if values else "无"


def render_report(
    actual: dict[str, Any],
    no_limit: dict[str, Any],
    machine: dict[str, Any],
    lv999_actual: dict[str, Any] | None = None,
    lv999_no_limit: dict[str, Any] | None = None,
) -> str:
    actual_levels = level_map(actual)
    no_limit_levels = level_map(no_limit)
    machine_levels = {int(row["ordinal"]): row for row in machine["levels"]}
    cap = int(actual["config"]["episodes_per_level"])
    reproduction = exact_reproduction_mismatches(actual, no_limit, range(1, 57))

    recovered: list[int] = []
    search_fragile: list[int] = []
    budget_candidates: list[int] = []
    for ordinal in range(57, 75):
        deep_recovers = paired_recovery(actual_levels[ordinal], no_limit_levels[ordinal])
        machine_row = machine_levels[ordinal]
        actual_search = budget_128_success(machine_row)
        no_limit_search = no_limit_budget_128_success(machine_row)
        search_recovers = (
            no_limit_search is not None and no_limit_search - actual_search >= 0.2
        )
        if deep_recovers:
            recovered.append(ordinal)
        if search_recovers:
            search_fragile.append(ordinal)
        if deep_recovers and search_recovers:
            budget_candidates.append(ordinal)

    runtime = actual["runtime"]
    lines = [
        "# 《109.5°》共享 QR-DQN 难度实验",
        "",
        f"生成时间：{actual['generatedAt']}（实际组） / {no_limit['generatedAt']}（无红线组）",
        "",
        "校准状态：**机器代理，未真人校准**。episode 阈值衡量共享网络的学习成本，不是真人通关概率。",
        "",
        (
            f"运行环境：Python {runtime['python']}；PyTorch {runtime['torch']}；"
            f"CUDA {runtime['torchCuda']}；{runtime['deviceName']}；观测维度 {runtime['observationDimension']}。"
        ),
        "",
        "## 可比性检查",
        "",
        (
            "01–56 实际 / 无红线逐 seed 完全复现。"
            if not reproduction
            else "01–56 存在复现差异：" + "、".join(reproduction)
        ),
        "达到 80% 独立评估成功率后停止本关训练；`>3000` 是右删失，不参与删失组内部排序。",
        "",
        "## 章节画像",
        "",
        "| 章节 | 关卡 | 实际：已学会关中位数 | 实际删失关 | 无红线：已学会关中位数 | 无红线删失关 |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    for name, start, end in CHAPTERS:
        actual_rows = [actual_levels[index] for index in range(start, end + 1)]
        no_limit_rows = [no_limit_levels[index] for index in range(start, end + 1)]
        actual_censored = sum(row["medianEpisodesToThreshold"] is None for row in actual_rows)
        no_limit_censored = sum(row["medianEpisodesToThreshold"] is None for row in no_limit_rows)
        lines.append(
            f"| {name} | {start:02d}–{end:02d} | {median_learned(actual_rows)} | "
            f"{actual_censored} | {median_learned(no_limit_rows)} | {no_limit_censored} |"
        )

    if lv999_actual is not None and lv999_no_limit is not None:
        stress_actual = lv999_actual["aggregate"][0]
        stress_no_limit = lv999_no_limit["aggregate"][0]
        machine_stress = machine_levels[75]
        machine_actual = budget_128_success(machine_stress)
        machine_no_limit = no_limit_budget_128_success(machine_stress)
        lines.extend(
            [
                "",
                "## LV.999 独立压力签名",
                "",
                (
                    f"B128 实际 / 无红线为 {machine_actual:.0%} / "
                    f"{machine_no_limit:.0%}；共享 QR-DQN 实际 / 无红线均为 "
                    f"{threshold_text(stress_actual, cap)}（0/3 达标） / "
                    f"{threshold_text(stress_no_limit, cap)}（0/3 达标）。"
                ),
                "该结果只说明隐藏关同时具有零冗余压力与第一阶段模型无法分辨的结构压力，不进入 01–74 曲线或调整候选。",
            ]
        )

    lines.extend(
        [
            "",
            "## 红线课程反事实",
            "",
            f"- 无红线课程中深度代理显著恢复：{format_ordinals(recovered)}。",
            f"- B128 搜索代理显著恢复：{format_ordinals(search_fragile)}。",
            f"- 两个独立代理共同指向、进入直接预算扫描候选：{format_ordinals(budget_candidates)}。",
            "- 共享网络会继承前面关卡的训练差异，所以这里是课程总效应；候选只表示应扫描本关最小可接受 `moveLimit`，不能把后段差值直接归因于本关红线。",
            "",
            "## 逐关结果",
            "",
            "| 关 | 名称 | 训练前成功率 | 实际阈值 | 实际达标种子 | 无红线阈值 | 无红线达标种子 |",
            "| ---: | --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for ordinal in range(1, 75):
        actual_row = actual_levels[ordinal]
        no_limit_row = no_limit_levels[ordinal]
        prior = float(actual_row["meanPriorSuccessRate"])
        no_limit_threshold = threshold_text(no_limit_row, cap) if ordinal >= 57 else "—"
        no_limit_seeds = no_limit_row["thresholdReachedSeeds"] if ordinal >= 57 else "—"
        lines.append(
            f"| {ordinal:02d} | {actual_row['name']} | {prior:.0%} | "
            f"{threshold_text(actual_row, cap)} | {actual_row['thresholdReachedSeeds']}/3 | "
            f"{no_limit_threshold} | {no_limit_seeds}{'/3' if ordinal >= 57 else ''} |"
        )

    lines.extend(
        [
            "",
            "## 解释边界",
            "",
            "- 网络与 replay 按正式关序共享，因此结果包含迁移、遗忘和训练顺序效应。",
            "- 从首个红线关开始，实际 / 无红线两条课程的参数历史已经分叉；关卡级预算结论必须读取直接 B128 扫描，不能读取本表差值。",
            "- 第一阶段 MLP 不显式建模玩家记忆、规则误解或人群能力分布；这些属于后续 GRU / 概念掌握实验。",
            "- 物理 75 / LV.999 永久独立报告，不进入上述章节、倒挂或调参候选。",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Render the shared QR-DQN report")
    parser.add_argument("--actual", type=Path, default=REPO_ROOT / "artifacts" / "difficulty" / "deep-rl.json")
    parser.add_argument("--no-limit", type=Path, default=REPO_ROOT / "artifacts" / "difficulty" / "deep-rl-no-limit.json")
    parser.add_argument("--machine", type=Path, default=REPO_ROOT / "artifacts" / "difficulty" / "machine.json")
    parser.add_argument("--lv999-actual", type=Path, default=REPO_ROOT / "artifacts" / "difficulty" / "deep-rl-lv999.json")
    parser.add_argument("--lv999-no-limit", type=Path, default=REPO_ROOT / "artifacts" / "difficulty" / "deep-rl-lv999-no-limit.json")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "docs" / "deep-difficulty-report.md")
    args = parser.parse_args()
    actual = load_report(args.actual, "actual")
    no_limit = load_report(args.no_limit, "no-move-limit")
    lv999_actual = load_report(args.lv999_actual, "actual")
    lv999_no_limit = load_report(args.lv999_no_limit, "no-move-limit")
    machine = json.loads(args.machine.read_text(encoding="utf-8"))
    args.output.write_text(
        render_report(actual, no_limit, machine, lv999_actual, lv999_no_limit),
        encoding="utf-8",
    )
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
