"""《109.5°》通关反馈收集服务（开发期可选后端，非比赛提交内容）。

用法：
    pip install -r server/requirements.txt
    uvicorn app:app --app-dir server --host 127.0.0.1 --port 8787
    # 或：python server/app.py

公网暴露（cloudflared 快速隧道）：
    cloudflared tunnel --url http://127.0.0.1:8787
    把返回的 https://xxx.trycloudflare.com 作为 VITE_FEEDBACK_ENDPOINT 重新构建前端。

数据以 JSONL 追加写入 server/data/feedback.jsonl 与 attempts.jsonl（均已 gitignore）。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from threading import Lock
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE = DATA_DIR / "feedback.jsonl"
ATTEMPT_FILE = DATA_DIR / "attempts.jsonl"
WRITE_LOCK = Lock()

app = FastAPI(title="109.5° feedback collector", version="0.1.0")

# 前端是静态托管（GitHub Pages / itch.io / cloudflared 隧道），来源域名不固定，
# 收集器开放所有来源；要收口时把 allow_origins 换成显式来源列表即可。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


FeedbackTag = Literal[
    "rules_unclear",
    "stuck_reasoning",
    "controls_awkward",
    "too_much_walking",
    "too_easy",
    "very_fun",
]


class Feedback(BaseModel):
    game: str = Field(min_length=1, max_length=64)
    level: int = Field(ge=1)
    levelId: str = Field(default="", max_length=128)
    difficulty: int = Field(ge=1, le=5)
    fun: int = Field(ge=1, le=5)
    moves: int | None = Field(default=None, ge=0)
    par: int | None = Field(default=None, ge=0)
    participantId: str | None = Field(default=None, max_length=128)
    sessionId: str | None = Field(default=None, max_length=128)
    attemptId: str | None = Field(default=None, max_length=128)
    tags: list[FeedbackTag] = Field(default_factory=list, max_length=6)

    @field_validator("tags")
    @classmethod
    def tags_are_unique(cls, tags: list[FeedbackTag]) -> list[FeedbackTag]:
        if len(tags) != len(set(tags)):
            raise ValueError("feedback tags must be unique")
        return tags


class AttemptCounters(BaseModel):
    validMoves: int = Field(ge=0)
    invalidInputs: int = Field(ge=0)
    undos: int = Field(ge=0)
    solverHints: int = Field(ge=0)
    previews: int = Field(ge=0)
    inspects: int = Field(ge=0)
    marks: int = Field(ge=0)
    rulesOpened: int = Field(ge=0)
    budgetExhausted: bool


class AttemptCondition(BaseModel):
    tutorialEnabled: bool
    animationMode: Literal["clear", "fast"]
    inputMode: Literal["keyboard", "touch"]
    visualBlindMode: bool
    cohort: str | None = Field(default=None, max_length=64)
    assignment: str | None = Field(default=None, max_length=64)


class Attempt(BaseModel):
    schemaVersion: Literal[1]
    attemptId: str = Field(min_length=1, max_length=128)
    participantId: str = Field(min_length=1, max_length=128)
    sessionId: str = Field(min_length=1, max_length=128)
    game: str = Field(min_length=1, max_length=64)
    level: int = Field(ge=1)
    levelId: str = Field(min_length=1, max_length=128)
    sessionAttemptIndex: int = Field(ge=1)
    condition: AttemptCondition
    par: int | None = Field(default=None, ge=0)
    moveLimit: int | None = Field(default=None, ge=1)
    stageCount: int | None = Field(default=None, ge=1)
    startedAt: str = Field(min_length=1, max_length=64)
    endedAt: str = Field(min_length=1, max_length=64)
    durationMs: int = Field(ge=0)
    activeMs: int = Field(ge=0)
    outcome: Literal["completed", "restart", "level_exit", "page_exit"]
    completed: bool
    assisted: bool
    finalMoves: int = Field(ge=0)
    finalStage: int = Field(ge=0)
    maxStage: int = Field(ge=0)
    counters: AttemptCounters

    @model_validator(mode="after")
    def fields_are_consistent(self) -> "Attempt":
        if self.completed != (self.outcome == "completed"):
            raise ValueError("completed must match outcome")
        if self.assisted != (self.counters.solverHints > 0):
            raise ValueError("assisted must match solverHints")
        if self.activeMs > self.durationMs:
            raise ValueError("activeMs cannot exceed durationMs")
        if self.maxStage < self.finalStage:
            raise ValueError("maxStage cannot be below finalStage")
        return self


def append_jsonl(path: Path, row: dict) -> None:
    with WRITE_LOCK, path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/feedback")
async def submit(fb: Feedback, request: Request) -> dict:
    row = {
        "id": uuid.uuid4().hex,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "origin": request.headers.get("origin", ""),
        **fb.model_dump(),
    }
    append_jsonl(DATA_FILE, row)
    return {"ok": True, "id": row["id"]}


@app.post("/api/attempt")
async def submit_attempt(request: Request) -> dict:
    try:
        # sendBeacon 在卸载阶段使用 text/plain 以避免跨域预检；这里始终按原始 JSON 校验。
        attempt = Attempt.model_validate_json(await request.body())
    except ValueError as error:
        raise HTTPException(status_code=422, detail="invalid attempt payload") from error
    row = {
        "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "origin": request.headers.get("origin", ""),
        **attempt.model_dump(),
    }
    append_jsonl(ATTEMPT_FILE, row)
    return {"ok": True, "attemptId": attempt.attemptId}


@app.get("/api/feedback")
def list_feedback() -> dict:
    """调试用：已收集行数。"""
    count = sum(1 for _ in DATA_FILE.open("r", encoding="utf-8")) if DATA_FILE.exists() else 0
    return {"count": count, "file": str(DATA_FILE)}


@app.get("/api/attempt")
def list_attempts() -> dict:
    """调试用：已收集的完整尝试行数。"""
    count = sum(1 for _ in ATTEMPT_FILE.open("r", encoding="utf-8")) if ATTEMPT_FILE.exists() else 0
    return {"count": count, "file": str(ATTEMPT_FILE)}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("FEEDBACK_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port)
