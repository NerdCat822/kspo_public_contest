from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app import main
from app.agent import gilmak_api, service, tools

DAY = {
    "date": "2026-11-27", "weekday": "금", "dayType": "weekday", "holidayName": None,
    "shows": [{
        "id": "PF1-2026-11-27-19:00", "name": "테스트 콘서트", "hall": "KSPO DOME(체조경기장)", "seats": 15000,
        "start": "19:00", "end": "21:30", "runtimeMin": 150, "runtimeKnown": False, "genre": "대중음악", "major": True,
    }],
    "forecast": {
        "bins": [
            {"t": "06:00", "level": "calm", "ratio": 0.4, "eventShare": 0},
            {"t": "06:30", "level": "calm", "ratio": 0.4, "eventShare": 0},
            {"t": "07:00", "level": "jam", "ratio": 1.1, "eventShare": 0.5},
        ],
        "peak": {"t": "07:00", "level": "jam"},
        "thresholds": {"normal": 0.6, "busy": 0.8, "jam": 1},
    },
    "advice": {
        "concert": [{
            "showId": "PF1-2026-11-27-19:00", "arriveBy": "15:45", "busyFrom": "16:00", "start": "19:00", "end": "21:30",
            "exitRush": {"from": "21:30", "to": "22:40"}, "transitFirst": True,
        }],
        "park": {"best": [{"from": "08:00", "to": "09:30"}], "avoid": [{"from": "16:00", "to": "22:00", "reason": "event"}]},
    },
    "weather": {"sky": "맑음", "minTemp": 2, "maxTemp": 11, "rainChance": 20, "precipType": None, "source": "kma"},
    "model": {"version": "v0-2024-07", "fitMaeCars": 164.1, "exitMinutes": 70, "note": "", "source": "ml-service"},
    "errors": {},
}


def test_day_tool_summarizes(monkeypatch):
    monkeypatch.setattr(gilmak_api, "get", lambda path, **p: DAY)
    text = tools.get_day_forecast.call({"date": "2026-11-27"})
    assert "06:00~07:00 여유 / 07:00~07:30 매우 붐빔" in text
    assert "대중교통 권장" in text and "출차 집중 21:30~22:40" in text
    assert "런타임 정보 없어 추정" in text


def test_day_tool_rejects_bad_date():
    from anthropic.lib.tools import ToolError

    with pytest.raises(ToolError):
        tools.get_day_forecast.call({"date": "11월 27일"})


def test_search_shows(monkeypatch):
    shows = {"shows": [
        {"date": "2026-11-27", "start": "19:00", "end": "21:30", "name": "조용필 & 위대한 탄생", "hall": "KSPO DOME(체조경기장)", "seats": 15000, "major": True},
        {"date": "2026-11-28", "start": "15:00", "end": "16:20", "name": "백 번째 리뷰", "hall": "뮤즈라이브", "seats": 237, "major": False},
    ]}
    monkeypatch.setattr(gilmak_api, "get", lambda path, **p: shows)
    assert "2026-11-27 19:00" in tools.search_shows.call({"keyword": "조용필"})
    assert "찾지 못했어요" in tools.search_shows.call({"keyword": "없는공연"})


def test_context_goes_into_last_user_message():
    msgs = service.build_messages(
        [{"role": "assistant", "content": "안녕"}, {"role": "user", "content": "언제 가?"}], "지금은 2026-11-23(월)",
    )
    assert msgs[0]["role"] == "user"
    assert msgs[-1]["content"][0]["text"].startswith("[화면 맥락]")
    assert msgs[-1]["content"][1]["text"] == "언제 가?"


def test_chat_without_key_returns_503(monkeypatch):
    monkeypatch.setattr(main, "settings", main.settings.__class__(**{**main.settings.__dict__, "anthropic_api_key": ""}))
    for path in ("/agent/chat", "/agent/chat/stream"):
        res = TestClient(main.app).post(path, json={"messages": [{"role": "user", "content": "주차 어때?"}]})
        assert res.status_code == 503
        assert res.json()["detail"]["code"] == "no_api_key"


# ── 스트리밍: Tool Runner 대신 정해진 이벤트를 내는 가짜를 쓴다 ──


def _usage():
    return SimpleNamespace(input_tokens=1, output_tokens=1, cache_creation_input_tokens=0, cache_read_input_tokens=0)


def _text(t):
    return SimpleNamespace(type="text", text=t)


def _tool_start(name):
    return SimpleNamespace(type="content_block_start", content_block=SimpleNamespace(type="tool_use", name=name))


def _message(stop_reason, *, tool=None):
    content = [SimpleNamespace(type="tool_use", name=tool, input={"date": "2026-11-27"})] if tool else []
    return SimpleNamespace(stop_reason=stop_reason, model="claude-sonnet-5-5", content=content, usage=_usage())


class FakeStream:
    def __init__(self, events, message=None, fail=False):
        self.events, self.message, self.fail = events, message, fail

    def __iter__(self):
        yield from self.events
        if self.fail:
            raise ValueError("도구 입력 JSON 을 읽지 못함")

    def get_final_message(self):
        return self.message


class FakeRunner:
    def __init__(self, *streams):
        self.streams = streams
        self.tools_run = 0
        self.closed = False

    def __iter__(self):
        yield from self.streams

    def generate_tool_call_response(self):
        self.tools_run += 1
        return {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}

    def close(self):
        self.closed = True


def _use_runners(monkeypatch, *runners):
    queue = list(runners)
    sent = []

    def fake(messages, max_iterations):
        sent.append(list(messages))
        return queue.pop(0)

    monkeypatch.setattr(service, "_runner", fake)
    monkeypatch.setattr(service, "prefetch", lambda date: ("", []))
    return sent


def _collect(history=None):
    return list(service.stream_chat(history or [{"role": "user", "content": "27일 차로 가도 돼?"}], "지금은 2026-11-23(월)"))


def test_stream_sends_tool_then_text_then_done(monkeypatch):
    runner = FakeRunner(
        FakeStream([_tool_start("get_day_forecast")], _message("tool_use", tool="get_day_forecast")),
        FakeStream([_text("대중교통을 "), _text("권해요")], _message("end_turn")),
    )
    _use_runners(monkeypatch, runner)
    events = _collect()
    assert events[0] == ("tool", {"name": "get_day_forecast"})
    assert [d["delta"] for n, d in events if n == "text"] == ["대중교통을 ", "권해요"]
    name, done = events[-1]
    assert name == "done" and done["stopReason"] == "end_turn"
    assert done["toolCalls"] == [{"name": "get_day_forecast", "input": {"date": "2026-11-27"}}]
    assert runner.tools_run == 1 and runner.closed


def test_stream_separates_text_from_different_turns(monkeypatch):
    _use_runners(monkeypatch, FakeRunner(
        FakeStream([_text("확인해 볼게요."), _tool_start("get_live_status")], _message("tool_use", tool="get_live_status")),
        FakeStream([_text("지금은 여유로워요.")], _message("end_turn")),
    ))
    result = service.run_chat([{"role": "user", "content": "지금 어때?"}], "지금은 2026-11-23(월)")
    assert result.reply == "확인해 볼게요.\n\n지금은 여유로워요."


def test_stream_replaces_partial_answer_on_refusal(monkeypatch):
    _use_runners(monkeypatch, *(FakeRunner(FakeStream([_text("그건")], _message("refusal"))) for _ in range(2)))
    events = _collect()
    assert ("reset", {"text": service.REFUSAL_REPLY}) in events
    assert service.run_chat([{"role": "user", "content": "?"}], "").reply == service.REFUSAL_REPLY


def test_stream_retries_turn_when_tool_json_is_broken(monkeypatch):
    first = FakeRunner(
        FakeStream([_tool_start("get_day_forecast")], _message("tool_use", tool="get_day_forecast")),
        FakeStream([_text("반쯤 쓴 말")], fail=True),
    )
    second = FakeRunner(FakeStream([_text("다시 쓴 답")], _message("end_turn")))
    sent = _use_runners(monkeypatch, first, second)
    events = _collect()
    assert ("reset", {"text": ""}) in events
    assert first.closed and first.tools_run == 1
    # 다시 요청할 때는 끝난 턴(모델 답 + 도구 결과)을 이어 붙여 보낸다
    assert [m["role"] for m in sent[1]] == ["user", "assistant", "user"]
    text = ""
    for name, data in events:
        text = data["text"] if name == "reset" else text + data.get("delta", "")
    assert text == "다시 쓴 답"


def test_stream_endpoint_sends_sse(monkeypatch):
    monkeypatch.setattr(main, "settings", main.settings.__class__(**{**main.settings.__dict__, "anthropic_api_key": "test"}))

    def fake_stream(history, context, date):
        yield "text", {"delta": "안녕"}
        raise ValueError("중간 실패")

    monkeypatch.setattr(main, "stream_chat", fake_stream)
    res = TestClient(main.app).post("/agent/chat/stream", json={"messages": [{"role": "user", "content": "주차 어때?"}]})
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert 'event: text\ndata: {"delta": "안녕"}\n\n' in res.text
    assert 'event: error\ndata: {"code": "internal"' in res.text


def test_ml_forecast_endpoint():
    res = TestClient(main.app).post("/ml/forecast", json={"days": [
        {"date": "2026-11-27", "dayType": "weekday", "shows": [{"start": "19:00", "seats": 15000, "major": True}]},
    ]})
    assert res.status_code == 200
    body = res.json()
    assert body["forecasts"][0]["peak"]["level"] == "jam"
    assert body["model"]["version"] == "v0-2024-07"


def test_prefetched_data_goes_before_question(monkeypatch):
    def fake_get(path, **params):
        if path == "/api/day":
            return DAY
        raise tools.ToolError("실시간 서버에 연결하지 못함")

    monkeypatch.setattr(gilmak_api, "get", fake_get)
    data, sources = service.prefetch("2026-11-27")
    assert sources == [{"name": "get_day_forecast", "input": {"date": "2026-11-27"}}]  # 실패한 실시간은 빠진다
    msgs = service.build_messages([{"role": "user", "content": "차로 가도 돼?"}], "지금은 2026-11-23(월)", data)
    head = msgs[-1]["content"][0]["text"]
    assert head.startswith("[화면 맥락]") and "[미리 확인한 데이터]" in head and "대중교통 권장" in head
    assert msgs[-1]["content"][1]["text"] == "차로 가도 돼?"
