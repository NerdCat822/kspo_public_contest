"""길막닥터 AI 서비스: 예측 모델(ML)과 상담 에이전트.

    cd ai && uv run uvicorn app.main:app --host 127.0.0.1 --port 8090

Go 백엔드가 /ml/forecast 로 예측을 받고, 화면의 상담 요청(/api/agent/*)을 /agent/* 로 넘긴다.
화면은 /agent/chat/stream 으로 답을 글자 단위로 받는다.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from typing import Literal

import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .agent.service import run_chat, stream_chat
from .config import settings
from .ml.model_v0 import BaselineModel, ShowInput

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("gilmak.ai")

app = FastAPI(title="길막닥터 AI", version="0.1.0")
model = BaselineModel(settings.model_path)
KST = timezone(timedelta(hours=9))
WEEKDAYS = "월화수목금토일"


# ── 예측(ML) ──────────────────────────────


class ShowIn(BaseModel):
    start: str = Field(pattern=r"^\d{2}:\d{2}$")
    seats: int = Field(ge=0)
    major: bool


class DayIn(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    dayType: Literal["weekday", "weekend", "holiday"]
    shows: list[ShowIn] = []


class ForecastRequest(BaseModel):
    days: list[DayIn] = Field(min_length=1, max_length=62)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": model.meta()["version"], "agent": {"enabled": settings.agent_enabled, "model": settings.llm_model}}


@app.get("/ml/model")
def ml_model() -> dict:
    return {"model": model.meta(), "thresholds": model.thresholds()}


@app.post("/ml/forecast")
def ml_forecast(req: ForecastRequest) -> dict:
    forecasts = []
    for d in req.days:
        shows = [ShowInput(start=s.start, seats=s.seats, major=s.major) for s in d.shows]
        forecasts.append({"date": d.date, **model.forecast_day(d.dayType, shows)})
    return {"model": model.meta(), "thresholds": model.thresholds(), "forecasts": forecasts}


# ── 상담 에이전트 ──────────────────────────


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=6000)  # 길막닥터의 앞선 답도 대화 기록으로 다시 온다


class ChatContext(BaseModel):
    date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    context: ChatContext = ChatContext()


def _context_line(ctx: ChatContext) -> str:
    now = datetime.now(KST)
    line = f"지금은 {now:%Y-%m-%d}({WEEKDAYS[now.weekday()]}) {now:%H:%M}입니다."
    if ctx.date:
        d = datetime.strptime(ctx.date, "%Y-%m-%d")
        line += f" 사용자가 화면에서 보고 있는 날짜는 {ctx.date}({WEEKDAYS[d.weekday()]})입니다."
    return line


def _view_date(ctx: ChatContext) -> str:
    """미리 읽을 날짜: 화면에서 보고 있는 날짜, 없으면 오늘."""
    return ctx.date or datetime.now(KST).strftime("%Y-%m-%d")


def _check_chat(req: ChatRequest) -> None:
    if not settings.agent_enabled:
        raise HTTPException(status_code=503, detail={"code": "no_api_key", "message": "LLM API 키가 설정되지 않았어요."})
    if req.messages[-1].role != "user":
        raise HTTPException(status_code=400, detail={"code": "bad_request", "message": "마지막 메시지는 사용자 질문이어야 해요."})


def _llm_error(e: Exception) -> tuple[int, dict[str, str]]:
    """Claude API 오류를 (HTTP 상태, {code, message}) 로 바꾼다."""
    if isinstance(e, anthropic.AuthenticationError):
        return 503, {"code": "bad_api_key", "message": "LLM API 키가 올바르지 않아요."}
    if isinstance(e, anthropic.RateLimitError):
        return 429, {"code": "rate_limited", "message": "요청이 많아요. 잠시 뒤 다시 물어봐 주세요."}
    if isinstance(e, anthropic.APIStatusError):
        log.warning("Claude API 오류 %s request_id=%s", e.status_code, getattr(e, "request_id", None))
        return 502, {"code": "llm_error", "message": "답을 만드는 중 오류가 났어요."}
    if isinstance(e, anthropic.APIConnectionError):
        return 502, {"code": "llm_unreachable", "message": "LLM 서버에 연결하지 못했어요."}
    log.exception("상담 처리 중 오류", exc_info=e)
    return 500, {"code": "internal", "message": "답을 만드는 중 오류가 났어요."}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/agent/status")
def agent_status() -> dict:
    return {"enabled": settings.agent_enabled, "model": settings.llm_model}


@app.post("/agent/chat")
def agent_chat(req: ChatRequest) -> dict:
    """답을 다 만든 뒤 한 번에 돌려준다."""
    _check_chat(req)
    try:
        result = run_chat([m.model_dump() for m in req.messages], _context_line(req.context), _view_date(req.context))
    except (anthropic.APIError, ValueError) as e:
        status, detail = _llm_error(e)
        raise HTTPException(status_code=status, detail=detail) from e
    return {
        "reply": result.reply, "toolCalls": result.tool_calls, "prefetched": result.prefetched,
        "stopReason": result.stop_reason, "model": result.model,
    }


@app.post("/agent/chat/stream")
def agent_chat_stream(req: ChatRequest) -> StreamingResponse:
    """답을 만들어지는 대로 Server-Sent Events 로 보낸다.

    event: tool  {name}            도구로 데이터를 확인하기 시작함
    event: text  {delta}           답 글자
    event: reset {text}            지금까지 받은 답을 text 로 바꿈(다시 요청했거나 거절로 끝남)
    event: done  {stopReason, model, toolCalls, prefetched}
    event: error {code, message}   중간에 실패함(응답 상태는 이미 200 이라 이벤트로 알린다)
    """
    _check_chat(req)
    history = [m.model_dump() for m in req.messages]
    context = _context_line(req.context)
    date = _view_date(req.context)

    def events() -> Iterator[str]:
        try:
            for name, data in stream_chat(history, context, date):
                yield _sse(name, data)
        except Exception as e:  # noqa: BLE001 - 어떤 오류든 화면이 알 수 있게 error 이벤트로 끝낸다
            yield _sse("error", _llm_error(e)[1])

    # X-Accel-Buffering: 앞에 nginx 같은 프록시를 두어도 모아 보내지 않게 한다
    return StreamingResponse(
        events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
