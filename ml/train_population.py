from __future__ import annotations

import argparse
import json
import math
import os
import platform
import statistics
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np

os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
import torch
from torch import nn

from chem_bridge import ChemBridge, ChemFeatureEncoder, REPO_ROOT


ACTION_COUNT = 4


@dataclass(frozen=True)
class TrainingConfig:
    levels: tuple[int, ...]
    seeds: tuple[int, ...]
    episodes_per_level: int = 3_000
    evaluation_every: int = 100
    evaluation_trials: int = 40
    env_batch: int = 32
    replay_capacity: int = 12_000
    batch_size: int = 64
    hidden_size: int = 192
    quantiles: int = 21
    gamma: float = 0.98
    learning_rate: float = 3e-4
    epsilon_start: float = 0.8
    epsilon_end: float = 0.05
    evaluation_lapse: float = 0.03
    success_threshold: float = 0.8
    learning_starts: int = 256
    target_update_steps: int = 250
    stop_on_threshold: bool = True
    remove_move_limits: bool = False


class ReplayBuffer:
    def __init__(self, capacity: int, observation_dim: int) -> None:
        self.capacity = capacity
        self.observations = np.empty((capacity, observation_dim), dtype=np.float16)
        self.next_observations = np.empty((capacity, observation_dim), dtype=np.float16)
        self.actions = np.empty(capacity, dtype=np.int8)
        self.rewards = np.empty(capacity, dtype=np.float32)
        self.dones = np.empty(capacity, dtype=np.bool_)
        self.position = 0
        self.size = 0

    def add_many(
        self,
        observations: np.ndarray,
        actions: np.ndarray,
        rewards: np.ndarray,
        next_observations: np.ndarray,
        dones: np.ndarray,
    ) -> None:
        for index in range(observations.shape[0]):
            self.observations[self.position] = observations[index]
            self.next_observations[self.position] = next_observations[index]
            self.actions[self.position] = actions[index]
            self.rewards[self.position] = rewards[index]
            self.dones[self.position] = dones[index]
            self.position = (self.position + 1) % self.capacity
            self.size = min(self.size + 1, self.capacity)

    def sample(
        self,
        batch_size: int,
        rng: np.random.Generator,
        device: torch.device,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        indices = rng.integers(0, self.size, size=batch_size)
        observations = torch.as_tensor(
            self.observations[indices].astype(np.float32), device=device
        )
        actions = torch.as_tensor(self.actions[indices].astype(np.int64), device=device)
        rewards = torch.as_tensor(self.rewards[indices], device=device)
        next_observations = torch.as_tensor(
            self.next_observations[indices].astype(np.float32), device=device
        )
        dones = torch.as_tensor(self.dones[indices].astype(np.float32), device=device)
        return observations, actions, rewards, next_observations, dones

    def __len__(self) -> int:
        return self.size


class QuantileDqn(nn.Module):
    def __init__(self, observation_dim: int, hidden_size: int, quantiles: int) -> None:
        super().__init__()
        self.quantiles = quantiles
        self.network = nn.Sequential(
            nn.Linear(observation_dim, hidden_size),
            nn.LayerNorm(hidden_size),
            nn.SiLU(),
            nn.Linear(hidden_size, hidden_size),
            nn.SiLU(),
            nn.Linear(hidden_size, ACTION_COUNT * quantiles),
        )

    def forward(self, observations: torch.Tensor) -> torch.Tensor:
        output = self.network(observations)
        return output.view(-1, ACTION_COUNT, self.quantiles)


def quantile_huber_loss(
    predicted: torch.Tensor,
    targets: torch.Tensor,
    kappa: float = 1.0,
) -> torch.Tensor:
    """QR-DQN pairwise quantile Huber loss.

    predicted/targets are [batch, quantiles] for the selected current/next action.
    """

    difference = targets.unsqueeze(1) - predicted.unsqueeze(2)
    absolute = difference.abs()
    huber = torch.where(
        absolute <= kappa,
        0.5 * difference.square(),
        kappa * (absolute - 0.5 * kappa),
    )
    quantile_count = predicted.shape[1]
    taus = (
        (torch.arange(quantile_count, device=predicted.device, dtype=predicted.dtype) + 0.5)
        / quantile_count
    ).view(1, quantile_count, 1)
    weights = (taus - (difference.detach() < 0).to(predicted.dtype)).abs()
    return (weights * huber / kappa).mean()


class Learner:
    def __init__(
        self,
        observation_dim: int,
        config: TrainingConfig,
        seed: int,
        device: torch.device,
    ) -> None:
        torch.manual_seed(seed)
        if device.type == "cuda":
            torch.cuda.manual_seed_all(seed)
        self.device = device
        self.config = config
        self.rng = np.random.default_rng(seed)
        self.online = QuantileDqn(observation_dim, config.hidden_size, config.quantiles).to(device)
        self.target = QuantileDqn(observation_dim, config.hidden_size, config.quantiles).to(device)
        self.target.load_state_dict(self.online.state_dict())
        self.target.eval()
        self.optimizer = torch.optim.Adam(self.online.parameters(), lr=config.learning_rate)
        self.replay = ReplayBuffer(config.replay_capacity, observation_dim)
        self.optimization_steps = 0

    @torch.no_grad()
    def actions(
        self,
        observations: np.ndarray,
        *,
        epsilon: float,
    ) -> np.ndarray:
        tensor = torch.as_tensor(observations, device=self.device)
        greedy = self.online(tensor).mean(dim=2).argmax(dim=1).cpu().numpy()
        random_mask = self.rng.random(observations.shape[0]) < epsilon
        random_actions = self.rng.integers(0, ACTION_COUNT, size=observations.shape[0])
        return np.where(random_mask, random_actions, greedy).astype(np.int64)

    def optimize(self) -> float | None:
        config = self.config
        if len(self.replay) < max(config.learning_starts, config.batch_size):
            return None
        batch = self.replay.sample(config.batch_size, self.rng, self.device)
        observations, actions, rewards, next_observations, dones = batch
        predicted_all = self.online(observations)
        action_index = actions.view(-1, 1, 1).expand(-1, 1, config.quantiles)
        predicted = predicted_all.gather(1, action_index).squeeze(1)

        with torch.no_grad():
            next_actions = self.online(next_observations).mean(dim=2).argmax(dim=1)
            next_index = next_actions.view(-1, 1, 1).expand(-1, 1, config.quantiles)
            next_quantiles = self.target(next_observations).gather(1, next_index).squeeze(1)
            targets = rewards.unsqueeze(1) + config.gamma * (1 - dones.unsqueeze(1)) * next_quantiles

        loss = quantile_huber_loss(predicted, targets)
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(self.online.parameters(), 10.0)
        self.optimizer.step()
        self.optimization_steps += 1
        if self.optimization_steps % config.target_update_steps == 0:
            self.target.load_state_dict(self.online.state_dict())
        return float(loss.detach().cpu())


def max_moves_for(level: dict[str, Any], remove_move_limit: bool = False) -> int:
    if not remove_move_limit and level["moveLimit"] is not None:
        return int(level["moveLimit"])
    return max(20, int(level["par"] or 10) * 3)


def wilson_interval(successes: int, trials: int) -> dict[str, float]:
    if trials <= 0:
        return {"low": 0.0, "high": 0.0}
    z = 1.959963984540054
    rate = successes / trials
    denominator = 1 + z * z / trials
    center = (rate + z * z / (2 * trials)) / denominator
    margin = z * math.sqrt(rate * (1 - rate) / trials + z * z / (4 * trials * trials)) / denominator
    return {"low": max(0.0, center - margin), "high": min(1.0, center + margin)}


@torch.no_grad()
def evaluate_level(
    bridge: ChemBridge,
    encoder: ChemFeatureEncoder,
    learner: Learner,
    level_ordinal: int,
    trials: int,
    lapse: float,
    *,
    remove_move_limit: bool = False,
) -> dict[str, Any]:
    rows = bridge.reset([level_ordinal] * trials, remove_move_limit=remove_move_limit)
    observations = [row["observation"] for row in rows]
    active = np.ones(trials, dtype=np.bool_)
    successes = np.zeros(trials, dtype=np.bool_)
    solved_moves: list[int] = []
    input_counts = np.zeros(trials, dtype=np.int32)
    max_moves = max_moves_for(bridge.levels[level_ordinal], remove_move_limit)
    input_cap = max(16, max_moves * 4)

    for _ in range(input_cap):
        if not active.any():
            break
        features = encoder.encode_many(observations)
        actions = learner.actions(features, epsilon=lapse)
        actions[~active] = 0
        stepped = bridge.step(actions.tolist())
        for index, row in enumerate(stepped):
            if not active[index]:
                continue
            input_counts[index] += 1
            observations[index] = row["observation"]
            state = row["observation"]
            if state["won"]:
                active[index] = False
                successes[index] = True
                solved_moves.append(int(state["moves"]))
            elif int(state["moves"]) >= max_moves or input_counts[index] >= input_cap:
                active[index] = False

    success_count = int(successes.sum())
    return {
        "successes": success_count,
        "trials": trials,
        "successRate": success_count / trials,
        "successInterval": wilson_interval(success_count, trials),
        "meanMovesSolved": statistics.fmean(solved_moves) if solved_moves else None,
    }


def train_block(
    bridge: ChemBridge,
    encoder: ChemFeatureEncoder,
    learner: Learner,
    level_ordinal: int,
    requested_episodes: int,
    episode_offset: int,
    total_episodes: int,
) -> dict[str, Any]:
    config = learner.config
    env_count = min(config.env_batch, requested_episodes)
    rows = bridge.reset(
        [level_ordinal] * env_count,
        remove_move_limit=config.remove_move_limits,
    )
    observations = [row["observation"] for row in rows]
    input_counts = np.zeros(env_count, dtype=np.int32)
    max_moves = max_moves_for(bridge.levels[level_ordinal], config.remove_move_limits)
    input_cap = max(16, max_moves * 4)
    completed = 0
    solved = 0
    losses: list[float] = []

    while completed < requested_episodes:
        features = encoder.encode_many(observations)
        progress = min(1.0, (episode_offset + completed) / max(1, total_episodes))
        epsilon = config.epsilon_start * (1 - progress) + config.epsilon_end * progress
        actions = learner.actions(features, epsilon=epsilon)
        stepped = bridge.step(actions.tolist())
        next_raw = [row["observation"] for row in stepped]
        next_features = encoder.encode_many(next_raw)
        rewards = np.empty(env_count, dtype=np.float32)
        dones = np.zeros(env_count, dtype=np.bool_)

        for index, row in enumerate(stepped):
            input_counts[index] += 1
            before_progress = float(observations[index]["progress"])
            after_progress = float(row["observation"]["progress"])
            step_cost = -0.01 if row["effective"] else -0.03
            rewards[index] = (
                (1.0 if row["observation"]["won"] else 0.0)
                + 0.2 * (config.gamma * after_progress - before_progress)
                + step_cost
            )
            dones[index] = bool(row["observation"]["won"]) or (
                int(row["observation"]["moves"]) >= max_moves
                or input_counts[index] >= input_cap
            )

        learner.replay.add_many(features, actions, rewards, next_features, dones)
        loss = learner.optimize()
        if loss is not None:
            losses.append(loss)
        observations = next_raw

        done_indices = np.flatnonzero(dones).tolist()
        if not done_indices:
            continue
        remaining = requested_episodes - completed
        counted = done_indices[:remaining]
        completed += len(counted)
        solved += sum(bool(stepped[index]["observation"]["won"]) for index in counted)
        if completed >= requested_episodes:
            break
        reset = bridge.reset_indices(
            done_indices,
            [level_ordinal] * len(done_indices),
            remove_move_limit=config.remove_move_limits,
        )
        for replaced in reset:
            index = int(replaced["index"])
            observations[index] = replaced["item"]["observation"]
            input_counts[index] = 0

    return {
        "episodes": completed,
        "trainingSolveRate": solved / max(1, completed),
        "meanLoss": statistics.fmean(losses) if losses else None,
    }


def train_seed(
    bridge: ChemBridge,
    encoder: ChemFeatureEncoder,
    config: TrainingConfig,
    seed: int,
    device: torch.device,
) -> dict[str, Any]:
    learner = Learner(encoder.dimension, config, seed, device)
    rows: list[dict[str, Any]] = []
    print(f"seed {seed}: device={device} obs={encoder.dimension}", flush=True)

    for position, ordinal in enumerate(config.levels, start=1):
        descriptor = bridge.levels[ordinal]
        prior = evaluate_level(
            bridge,
            encoder,
            learner,
            ordinal,
            config.evaluation_trials,
            config.evaluation_lapse,
            remove_move_limit=config.remove_move_limits,
        )
        checkpoints: list[dict[str, Any]] = []
        episodes = 0
        episodes_to_threshold: int | None = (
            0 if prior["successRate"] >= config.success_threshold else None
        )
        while episodes < config.episodes_per_level and not (
            config.stop_on_threshold and episodes_to_threshold is not None
        ):
            requested = min(config.evaluation_every, config.episodes_per_level - episodes)
            training = train_block(
                bridge,
                encoder,
                learner,
                ordinal,
                requested,
                episodes,
                config.episodes_per_level,
            )
            episodes += int(training["episodes"])
            evaluation = evaluate_level(
                bridge,
                encoder,
                learner,
                ordinal,
                config.evaluation_trials,
                config.evaluation_lapse,
                remove_move_limit=config.remove_move_limits,
            )
            checkpoints.append(
                {"episode": episodes, "training": training, "evaluation": evaluation}
            )
            if (
                episodes_to_threshold is None
                and evaluation["successRate"] >= config.success_threshold
            ):
                episodes_to_threshold = episodes

        final = checkpoints[-1]["evaluation"] if checkpoints else prior
        row = {
            "ordinal": ordinal,
            "levelId": descriptor["id"],
            "name": descriptor["name"],
            "prior": prior,
            "episodesTrained": episodes,
            "episodesToThreshold": episodes_to_threshold,
            "final": final,
            "checkpoints": checkpoints,
        }
        rows.append(row)
        threshold_text = episodes_to_threshold if episodes_to_threshold is not None else f">{episodes}"
        print(
            f"  {position:02d}/{len(config.levels):02d} L{ordinal:02d} "
            f"prior={prior['successRate']:.2f} final={final['successRate']:.2f} "
            f"threshold={threshold_text}",
            flush=True,
        )

    return {"seed": seed, "levels": rows}


def median_optional(values: Iterable[int | None]) -> float | None:
    rows = list(values)
    finite = [value for value in rows if value is not None]
    return statistics.median(finite) if len(finite) >= math.ceil(len(rows) / 2) else None


def aggregate_seeds(seed_reports: list[dict[str, Any]], levels: tuple[int, ...]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for index, ordinal in enumerate(levels):
        rows = [report["levels"][index] for report in seed_reports]
        output.append(
            {
                "ordinal": ordinal,
                "levelId": rows[0]["levelId"],
                "name": rows[0]["name"],
                "meanPriorSuccessRate": statistics.fmean(row["prior"]["successRate"] for row in rows),
                "meanFinalSuccessRate": statistics.fmean(row["final"]["successRate"] for row in rows),
                "medianEpisodesToThreshold": median_optional(
                    row["episodesToThreshold"] for row in rows
                ),
                "thresholdReachedSeeds": sum(
                    row["episodesToThreshold"] is not None for row in rows
                ),
            }
        )
    return output


def parse_int_list(raw: str) -> tuple[int, ...]:
    values: list[int] = []
    for part in raw.split(","):
        token = part.strip()
        if "-" in token:
            start_raw, end_raw = token.split("-", 1)
            start, end = int(start_raw), int(end_raw)
            values.extend(range(start, end + 1))
        elif token:
            values.append(int(token))
    if not values:
        raise argparse.ArgumentTypeError("expected at least one integer or range")
    return tuple(values)


def choose_device(raw: str) -> torch.device:
    if raw == "auto":
        return torch.device("cuda" if torch.cuda.is_available() else "cpu")
    device = torch.device(raw)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but torch.cuda.is_available() is false")
    return device


def main() -> None:
    parser = argparse.ArgumentParser(description="Sequential shared QR-DQN Chem difficulty proxy")
    parser.add_argument("--levels", type=parse_int_list, default=parse_int_list("1-74"))
    parser.add_argument("--seeds", type=parse_int_list, default=parse_int_list("11,29,47"))
    parser.add_argument("--episodes-per-level", type=int, default=3_000)
    parser.add_argument("--evaluation-every", type=int, default=100)
    parser.add_argument("--evaluation-trials", type=int, default=40)
    parser.add_argument("--env-batch", type=int, default=32)
    parser.add_argument("--hidden-size", type=int, default=192)
    parser.add_argument("--quantiles", type=int, default=21)
    parser.add_argument("--device", default="auto")
    parser.add_argument(
        "--remove-move-limits",
        action="store_true",
        help="paired reasoning counterfactual for move-limit levels",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=REPO_ROOT / "artifacts" / "difficulty" / "deep-rl.json",
    )
    args = parser.parse_args()
    config = TrainingConfig(
        levels=args.levels,
        seeds=args.seeds,
        episodes_per_level=args.episodes_per_level,
        evaluation_every=args.evaluation_every,
        evaluation_trials=args.evaluation_trials,
        env_batch=args.env_batch,
        hidden_size=args.hidden_size,
        quantiles=args.quantiles,
        remove_move_limits=args.remove_move_limits,
    )
    if any(level == 75 for level in config.levels) and len(config.levels) > 1:
        raise ValueError("LV.999 may only be run as an isolated stress experiment")
    if config.episodes_per_level <= 0 or config.evaluation_trials <= 0:
        raise ValueError("episode and evaluation counts must be positive")
    device = choose_device(args.device)
    torch.use_deterministic_algorithms(True)

    with ChemBridge() as bridge:
        encoder = ChemFeatureEncoder(bridge.hello)
        seed_reports = [
            train_seed(bridge, encoder, config, seed, device) for seed in config.seeds
        ]
        report = {
            "schemaVersion": 1,
            "status": "experimental-machine-proxy",
            "condition": "no-move-limit" if config.remove_move_limits else "actual",
            "humanCalibrated": False,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "protocolVersion": bridge.hello["protocolVersion"],
            "config": {**asdict(config), "levels": list(config.levels), "seeds": list(config.seeds)},
            "runtime": {
                "python": platform.python_version(),
                "numpy": np.__version__,
                "torch": torch.__version__,
                "torchCuda": torch.version.cuda,
                "device": str(device),
                "deviceName": torch.cuda.get_device_name(0) if device.type == "cuda" else "CPU",
                "observationDimension": encoder.dimension,
            },
            "seeds": seed_reports,
            "aggregate": aggregate_seeds(seed_reports, config.levels),
            "notes": [
                "Shared network and replay are retained while levels are visited in official order.",
                "Prior success is measured before training on the current level and represents transfer, not human probability.",
                "This phase-one MLP baseline cannot trigger level edits without the design.md multi-proxy gate.",
            ],
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output}", flush=True)


if __name__ == "__main__":
    main()
