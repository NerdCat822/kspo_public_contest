"""대화 한 턴을 처리한다: 모델이 도구로 데이터를 확인하고 답을 만든다(Tool Runner 가 루프를 돈다).

stream_chat 은 화면에 바로 보낼 이벤트를 차례로 내고, run_chat 은 그 이벤트를 모아 한 번에 돌려준다.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import anthropic

from ..config import FALLBACK_MODELS, settings
from .prompts import SYSTEM_PROMPT
from .tools import TOOLS, get_day_forecast, get_live_status

log = logging.getLogger("gilmak.agent")

MAX_HISTORY = 12  # 최근 메시지만 보낸다
MAX_TOOL_ROUNDS = 8
MAX_JSON_RETRIES = 2  # 도구 입력 JSON 을 읽지 못했을 때 그 턴을 다시 요청하는 횟수

REFUSAL_REPLY = "이 질문에는 답하기 어려워요. 올림픽공원 방문이나 주차·교통에 대해 물어봐 주세요."
CUT_SHORT_REPLY = "확인할 내용이 많아 답을 마치지 못했어요. 질문을 조금 좁혀 다시 물어봐 주세요."
EMPTY_REPLY = "답을 만들지 못했어요. 다시 물어봐 주세요."

# (이름, 데이터). tool{name} → text{delta}… → done{stopReason, model, toolCalls}
# reset{text} 는 화면에 쌓인 답을 text 로 바꾸라는 뜻이다(다시 요청했거나 거절로 끝난 경우).
Event = tuple[str, dict[str, Any]]

_client: anthropic.Anthropic | None = None


def client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=settings.anthropic_api_key, max_retries=2, timeout=120.0)
    return _client


@dataclass
class ChatResult:
    reply: str
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    stop_reason: str | None = None
    model: str = ""
    prefetched: list[dict[str, Any]] = field(default_factory=list)


def prefetch(date: str) -> tuple[str, list[dict[str, Any]]]:
    """화면에서 보고 있는 날짜의 예측과 실시간 현황을 질문과 함께 넣으려고 미리 읽는다.

    대화에 도구 결과가 들어가면 API 가 그다음 답을 다 만든 뒤 한꺼번에 보내서 글자가 흘러나오지 않는다
    (2026-11, Sonnet 5.5 에서 확인). 가장 많이 묻는 두 가지를 미리 넣어 두면 대부분의 질문은 도구 없이
    바로 흘러나오고, 모델 호출도 한 번으로 줄어 더 빠르다. 다른 날짜나 공연이 필요할 때만 도구를 쓴다.
    """
    jobs = {"get_day_forecast": (get_day_forecast, {"date": date}), "get_live_status": (get_live_status, {})}
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {name: pool.submit(tool.call, args) for name, (tool, args) in jobs.items()}
    parts: list[str] = []
    sources: list[dict[str, Any]] = []
    for name, future in futures.items():
        try:
            parts.append(future.result())
            sources.append({"name": name, "input": jobs[name][1]})
        except Exception as e:  # noqa: BLE001 - 못 읽은 것은 모델이 필요하면 도구로 다시 확인한다
            log.warning("미리 읽기 실패 %s: %s", name, e)
    return "\n\n".join(parts), sources


def build_messages(history: list[dict[str, str]], context: str, data: str = "") -> list[dict[str, Any]]:
    """화면 맥락(오늘 날짜, 보고 있는 날짜)과 미리 읽은 데이터는 마지막 사용자 메시지 앞에 붙인다.
    시스템 프롬프트는 바꾸지 않는다(캐시 유지)."""
    msgs: list[dict[str, Any]] = [{"role": m["role"], "content": m["content"]} for m in history[-MAX_HISTORY:]]
    while msgs and msgs[0]["role"] != "user":  # 첫 메시지는 user 여야 한다
        msgs.pop(0)
    head = f"[화면 맥락] {context}"
    if data:
        head += f"\n\n[미리 확인한 데이터]\n{data}"
    last = msgs[-1]
    last["content"] = [{"type": "text", "text": head}, {"type": "text", "text": last["content"]}]
    return msgs


def _runner(messages: list[Any], max_iterations: int):
    extra: dict[str, Any] = {}
    if settings.llm_model in FALLBACK_MODELS:
        # 안전 분류기가 요청을 거절하면 같은 호출 안에서 서버가 대체 모델로 다시 돌린다.
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    return client().beta.messages.tool_runner(
        model=settings.llm_model,
        max_tokens=16000,
        # 도구 정의와 시스템 프롬프트는 모든 대화에 공통이라 여기에 캐시 지점을 둔다(새 대화의 첫 요청도 캐시를 읽음).
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        tools=TOOLS,
        messages=list(messages),
        output_config={"effort": settings.llm_effort},
        cache_control={"type": "ephemeral"},  # 대화 끝부분은 자동 캐시(도구 호출 루프 안에서 재사용)
        max_iterations=max_iterations,
        stream=True,
        **extra,
    )


def _log_usage(message: Any) -> None:
    u = message.usage
    log.info(
        "turn model=%s stop=%s in=%s out=%s cache_write=%s cache_read=%s",
        message.model, message.stop_reason, u.input_tokens, u.output_tokens,
        u.cache_creation_input_tokens, u.cache_read_input_tokens,
    )


def stream_chat(history: list[dict[str, str]], context: str, date: str | None = None) -> Iterator[Event]:
    """date 가 있으면 그날 예측과 실시간 현황을 미리 읽어 질문에 붙인다."""
    data, prefetched = prefetch(date) if date else ("", [])
    # 끝난 턴(모델 답 + 도구 결과)을 따라 적어 둔다. 도구 입력 JSON 이 깨져 턴이 실패하면 여기서부터 다시 요청한다.
    messages: list[Any] = build_messages(history, context, data)
    reply = ""  # 지금까지 화면에 보낸 답
    calls: list[dict[str, Any]] = []
    final: Any = None
    rounds = 0
    retries = 0

    while True:
        runner = _runner(messages, max(1, MAX_TOOL_ROUNDS - rounds))
        turn_start = reply
        try:
            for stream in runner:
                turn_start = reply
                turn_text = False
                for event in stream:
                    if event.type == "content_block_start" and event.content_block.type == "tool_use":
                        yield "tool", {"name": event.content_block.name}
                    elif event.type == "text" and event.text:
                        if not turn_text and reply and not reply.endswith("\n"):
                            reply += "\n\n"  # 앞 턴의 말과 이번 턴의 말을 문단으로 나눈다
                            yield "text", {"delta": "\n\n"}
                        turn_text = True
                        reply += event.text
                        yield "text", {"delta": event.text}
                message = stream.get_final_message()
                final = message
                rounds += 1
                _log_usage(message)
                messages.append({"role": "assistant", "content": message.content})
                # 거절, 길이 초과(잘린 도구 입력일 수 있음), 답 완료는 도구를 돌리지 않고 끝낸다.
                if message.stop_reason != "tool_use":
                    break
                tool_results = runner.generate_tool_call_response()  # 도구 실행. runner 가 다음 턴에 이 결과를 그대로 쓴다
                if tool_results is None:
                    break
                calls += [{"name": b.name, "input": b.input} for b in message.content if b.type == "tool_use"]
                messages.append(tool_results)
            break
        except ValueError:
            # 모델이 쓴 도구 입력 JSON 을 SDK 가 읽지 못했다. 그 턴만 다시 요청한다(API 오류는 ValueError 가 아니라 그대로 올라간다).
            retries += 1
            if retries > MAX_JSON_RETRIES:
                raise
            log.warning("도구 입력 JSON 을 읽지 못해 턴을 다시 요청합니다 (%d/%d)", retries, MAX_JSON_RETRIES)
            if reply != turn_start:
                reply = turn_start
                yield "reset", {"text": reply}
        finally:
            runner.close()

    if final is not None and final.stop_reason == "refusal":
        # 거절로 끝나면 그 전까지 흘려보낸 부분 답은 버린다.
        reply = REFUSAL_REPLY
        yield "reset", {"text": reply}
    elif not reply.strip():
        cut_short = final is not None and final.stop_reason == "tool_use"  # 도구 호출 한도에 걸려 끝남
        reply = CUT_SHORT_REPLY if cut_short else EMPTY_REPLY
        yield "reset", {"text": reply}

    yield "done", {
        "stopReason": final.stop_reason if final is not None else None,
        "model": final.model if final is not None else settings.llm_model,
        "toolCalls": calls,
        "prefetched": prefetched,
    }


def run_chat(history: list[dict[str, str]], context: str, date: str | None = None) -> ChatResult:
    reply = ""
    done: dict[str, Any] = {}
    for name, data in stream_chat(history, context, date):
        if name == "text":
            reply += data["delta"]
        elif name == "reset":
            reply = data["text"]
        elif name == "done":
            done = data
    return ChatResult(
        reply=reply.strip(),
        tool_calls=done.get("toolCalls", []),
        stop_reason=done.get("stopReason"),
        model=done.get("model", ""),
        prefetched=done.get("prefetched", []),
    )
