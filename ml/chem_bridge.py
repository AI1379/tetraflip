from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Iterable

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]


class BridgeError(RuntimeError):
    pass


class ChemBridge:
    """Persistent JSONL client for the authoritative TypeScript engine."""

    def __init__(self) -> None:
        pnpm = shutil.which("pnpm")
        if pnpm is None:
            raise BridgeError("pnpm is required to launch the TypeScript bridge")
        self._process = subprocess.Popen(
            [pnpm, "exec", "vite-node", "scripts/chem-ml-bridge.ts"],
            cwd=REPO_ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.hello = self.request({"type": "hello"})
        self.levels = {int(row["ordinal"]): row for row in self.hello["levels"]}

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self._process.poll() is not None:
            raise BridgeError(f"TypeScript bridge exited with {self._process.returncode}")
        assert self._process.stdin is not None
        assert self._process.stdout is not None
        self._process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            raise BridgeError("TypeScript bridge closed stdout")
        response = json.loads(line)
        if not response.get("ok"):
            raise BridgeError(str(response.get("error", "unknown bridge error")))
        return response

    def reset(
        self,
        levels: Iterable[int],
        *,
        remove_move_limit: bool = False,
        include_state_keys: bool = False,
    ) -> list[dict[str, Any]]:
        response = self.request(
            {
                "type": "reset",
                "levels": list(levels),
                "removeMoveLimit": remove_move_limit,
                "includeStateKeys": include_state_keys,
            }
        )
        return response["items"]

    def reset_indices(
        self,
        indices: Iterable[int],
        levels: Iterable[int],
        *,
        remove_move_limit: bool = False,
        include_state_keys: bool = False,
    ) -> list[dict[str, Any]]:
        response = self.request(
            {
                "type": "resetIndices",
                "indices": list(indices),
                "levels": list(levels),
                "removeMoveLimit": remove_move_limit,
                "includeStateKeys": include_state_keys,
            }
        )
        return response["items"]

    def step(
        self,
        actions: Iterable[int],
        *,
        include_state_keys: bool = False,
    ) -> list[dict[str, Any]]:
        response = self.request(
            {
                "type": "step",
                "actions": list(actions),
                "includeStateKeys": include_state_keys,
            }
        )
        return response["items"]

    def trace(
        self,
        level: int,
        actions: Iterable[int],
        *,
        remove_move_limit: bool = False,
    ) -> dict[str, Any]:
        return self.request(
            {
                "type": "trace",
                "level": level,
                "actions": list(actions),
                "removeMoveLimit": remove_move_limit,
            }
        )

    def close(self) -> None:
        if self._process.poll() is not None:
            return
        if self._process.stdin is not None:
            self._process.stdin.close()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._process.terminate()
            self._process.wait(timeout=5)

    def __enter__(self) -> ChemBridge:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class ChemFeatureEncoder:
    """Fixed-size visible-state encoder; it contains no transition or solver logic."""

    MAX_WIDTH = 12
    MAX_HEIGHT = 12
    MAX_CENTERS = 12
    MAX_GROUPS = 4
    MAX_STAGE_LOOKAHEAD = 4
    DIRECTIONS = 4

    def __init__(self, hello: dict[str, Any]) -> None:
        self.colors = tuple(hello["colors"])
        self.color_count = len(self.colors) + 1  # 0 = empty / no held group
        self.levels = {int(row["ordinal"]): row for row in hello["levels"]}
        sample_level = next(iter(self.levels))
        sample = self._encode(self.levels[sample_level], self._blank_observation(sample_level))
        self.dimension = int(sample.shape[0])

    def _one_hot(self, value: int, size: int) -> list[float]:
        output = [0.0] * size
        if 0 <= value < size:
            output[value] = 1.0
        return output

    def _blank_observation(self, ordinal: int) -> dict[str, Any]:
        level = self.levels[ordinal]
        return {
            "levelOrdinal": ordinal,
            "player": [0, 0],
            "holding": 0,
            "centers": [
                {"arms": [0, 0, 0, 0], "leaving": 0, "shielded": 0}
                for _ in level["centers"]
            ],
            "groups": [],
            "stage": 0,
            "moves": 0,
            "moveLimit": level["moveLimit"],
            "won": False,
            "progress": 0.0,
        }

    def encode(self, observation: dict[str, Any]) -> np.ndarray:
        ordinal = int(observation["levelOrdinal"])
        return self._encode(self.levels[ordinal], observation)

    def encode_many(self, observations: Iterable[dict[str, Any]]) -> np.ndarray:
        encoded = [self.encode(observation) for observation in observations]
        if not encoded:
            return np.empty((0, self.dimension), dtype=np.float32)
        return np.stack(encoded)

    def _encode(self, level: dict[str, Any], observation: dict[str, Any]) -> np.ndarray:
        values: list[float] = []
        width = int(level["width"])
        height = int(level["height"])
        player = observation["player"]
        stage = int(observation["stage"])
        stages = level["stages"]
        move_limit = observation["moveLimit"]
        horizon = int(move_limit) if move_limit is not None else max(20, int(level["par"] or 10) * 3)

        values.extend([width / self.MAX_WIDTH, height / self.MAX_HEIGHT])
        values.extend(
            [
                float(player[0]) / max(1, width - 1),
                float(player[1]) / max(1, height - 1),
            ]
        )
        values.extend(self._one_hot(int(observation["holding"]), self.color_count))
        values.extend(self._one_hot(min(stage, self.MAX_STAGE_LOOKAHEAD), self.MAX_STAGE_LOOKAHEAD + 1))
        values.extend(
            [
                len(stages) / self.MAX_STAGE_LOOKAHEAD,
                float(observation["moves"]) / max(1, horizon),
                max(0.0, (horizon - float(observation["moves"])) / max(1, horizon)),
                1.0 if move_limit is not None else 0.0,
                1.0 if observation["won"] else 0.0,
                float(observation["progress"]),
                float(level["par"] or 0) / 32.0,
            ]
        )

        wall_set = {tuple(cell) for cell in level["walls"]}
        light_set = {tuple(cell) for cell in level["lights"]}
        for y in range(self.MAX_HEIGHT):
            for x in range(self.MAX_WIDTH):
                values.append(1.0 if (x, y) in wall_set else 0.0)
        for y in range(self.MAX_HEIGHT):
            for x in range(self.MAX_WIDTH):
                values.append(1.0 if (x, y) in light_set else 0.0)

        dynamic_centers = observation["centers"]
        for index in range(self.MAX_CENTERS):
            if index >= len(level["centers"]):
                values.extend([0.0] * self._center_width())
                continue
            static = level["centers"][index]
            dynamic = dynamic_centers[index]
            values.append(1.0)
            values.extend(
                [
                    float(static["pos"][0]) / max(1, width - 1),
                    float(static["pos"][1]) / max(1, height - 1),
                ]
            )
            values.extend(self._one_hot(int(static["kind"]), 2))
            shield_until = int(static["shieldUntilStage"])
            values.extend(
                [
                    1.0 if shield_until >= 0 else 0.0,
                    max(0, shield_until) / self.MAX_STAGE_LOOKAHEAD,
                    float(static["ejects"]),
                    float(static["hitLights"]),
                    float(static["hitCenters"]),
                ]
            )
            reactive = static["reactiveTo"]
            values.append(1.0 if reactive is not None else 0.0)
            values.append(
                0.0 if reactive is None else (int(reactive["center"]) + 1) / self.MAX_CENTERS
            )
            values.extend(
                self._one_hot(-1 if reactive is None else int(reactive["arm"]), self.DIRECTIONS)
            )
            values.extend(
                self._one_hot(0 if reactive is None else int(reactive["color"]), self.color_count)
            )
            values.extend(self._one_hot(int(dynamic["leaving"]), self.DIRECTIONS))
            values.append(float(dynamic["shielded"]))
            for color in dynamic["arms"]:
                values.extend(self._one_hot(int(color), self.color_count))

            for offset in range(self.MAX_STAGE_LOOKAHEAD):
                goal_colors = [0] * self.DIRECTIONS
                target_stage = stage + offset
                if target_stage < len(stages):
                    for goal in stages[target_stage]:
                        if int(goal["center"]) == index:
                            goal_colors[int(goal["arm"])] = int(goal["color"])
                for color in goal_colors:
                    values.extend(self._one_hot(color, self.color_count))

        groups = observation["groups"]
        for index in range(self.MAX_GROUPS):
            if index >= len(groups):
                values.extend([0.0] * (3 + self.color_count))
                continue
            group = groups[index]
            values.extend(
                [
                    1.0,
                    float(group["pos"][0]) / max(1, width - 1),
                    float(group["pos"][1]) / max(1, height - 1),
                ]
            )
            values.extend(self._one_hot(int(group["color"]), self.color_count))

        return np.asarray(values, dtype=np.float32)

    def _center_width(self) -> int:
        return (
            1
            + 2
            + 2
            + 5
            + 1
            + 1
            + self.DIRECTIONS
            + self.color_count
            + self.DIRECTIONS
            + 1
            + self.DIRECTIONS * self.color_count
            + self.MAX_STAGE_LOOKAHEAD * self.DIRECTIONS * self.color_count
        )

