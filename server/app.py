"""《109.5°》通关反馈收集服务（开发期可选后端，非比赛提交内容）。

用法：
    pip install -r server/requirements.txt
    uvicorn app:app --app-dir server --host 127.0.0.1 --port 8787
    # 或：python server/app.py

公网暴露（cloudflared 快速隧道）：
    cloudflared tunnel --url http://127.0.0.1:8787
    把返回的 https://xxx.trycloudflare.com 作为 VITE_FEEDBACK_ENDPOINT 重新构建前端。

数据以 JSONL 追加写入 server/data/feedback.jsonl（已 gitignore）。
"""
from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DATA_FILE = DATA_DIR / "feedback.jsonl"

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
    tags: list[FeedbackTag] = Field(default_factory=list, max_length=6)

    @field_validator("tags")
    @classmethod
    def tags_are_unique(cls, tags: list[FeedbackTag]) -> list[FeedbackTag]:
        if len(tags) != len(set(tags)):
            raise ValueError("feedback tags must be unique")
        return tags


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
    with DATA_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return {"ok": True, "id": row["id"]}


@app.get("/api/feedback")
def list_feedback() -> dict:
    """调试用：已收集行数。"""
    count = sum(1 for _ in DATA_FILE.open("r", encoding="utf-8")) if DATA_FILE.exists() else 0
    return {"count": count, "file": str(DATA_FILE)}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("FEEDBACK_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port)
