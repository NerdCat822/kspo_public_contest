import { type FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentStatus, ChatMessage, ToolCall } from '../../shared/types.ts';
import { ApiError, type DayData, api } from '../api.ts';
import { monthDay } from '../format.ts';
import { shortHall } from './DateStrip.tsx';
import { Card } from './ui.tsx';

const SOURCE_LABEL: Record<string, string> = {
  get_overview: '2주 일정',
  get_day_forecast: '날짜별 예측',
  get_live_status: '실시간 현황',
  search_shows: '공연 검색',
};

const ACTIVITY: Record<string, string> = {
  get_overview: '2주 일정을 보는 중이에요',
  get_day_forecast: '날짜별 예측을 보는 중이에요',
  get_live_status: '실시간 현황을 보는 중이에요',
  search_shows: '공연을 찾는 중이에요',
};

/** '11월 27일 예측'처럼 무엇을 보고 답했는지 */
function sourceLabel(call: ToolCall): string {
  const date = call.input.date;
  if (call.name === 'get_day_forecast' && typeof date === 'string') {
    const { m, d } = monthDay(date);
    return `${m}월 ${d}일 예측`;
  }
  return SOURCE_LABEL[call.name] ?? call.name;
}

interface Turn extends ChatMessage {
  sources?: string[];
  note?: string;
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 화면에 보이는 글자 수가 받은 글자 수를 프레임마다 따라잡게 한다.
 * 도구를 쓴 답은 서버에서 한꺼번에 오기도 해서, 그때도 흘러나오듯 보이게 한다.
 */
function useRevealed(text: string): string {
  const [count, setCount] = useState(text.length);
  const shown = useRef(text.length);
  useEffect(() => {
    shown.current = Math.min(shown.current, text.length);
    if (reducedMotion()) {
      shown.current = text.length;
      setCount(text.length);
      return;
    }
    let frame = 0;
    const step = () => {
      const left = text.length - shown.current;
      if (left <= 0) return;
      shown.current += Math.max(2, Math.ceil(left / 10));
      setCount(shown.current);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [text]);
  return text.slice(0, count);
}

/** 답의 '-' 로 시작하는 줄은 목록으로, 나머지는 문단으로 보여 준다(마크다운은 해석하지 않는다). */
function Reply({ text, onGrow }: { text: string; onGrow: () => void }) {
  const visible = useRevealed(text);
  useLayoutEffect(onGrow, [visible, onGrow]);
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of visible.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const list = /^[-•]\s+/.test(line);
    const content = line.replace(/^[-•]\s+/, '');
    const last = blocks[blocks.length - 1];
    if (last && last.list && list) last.lines.push(content);
    else blocks.push({ list, lines: [content] });
  }
  return (
    <div className="chat__text">
      {blocks.map((b, i) =>
        b.list ? (
          <ul key={i}>
            {b.lines.map((l, j) => (
              <li key={j}>{l}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.lines[0]}</p>
        ),
      )}
    </div>
  );
}

function suggestions(day: DayData | null): string[] {
  const out: string[] = [];
  const show = day?.shows.find((s) => s.major);
  if (day && show) {
    const { m, d } = monthDay(day.date);
    out.push(`${m}월 ${d}일 ${shortHall(show.hall)} 공연, 차로 가도 될까?`);
  }
  out.push('이번 주말에 공원 산책하기 좋은 시간은?', '지금 올림픽공원 주차 상황 어때?');
  return out;
}

export function AskDoctor({ day, date }: { day: DayData | null; date: string | null }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inView, setInView] = useState(true);
  const [scrolled, setScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const following = useRef(true); // 사용자가 위로 올려 읽는 중이 아니면 맨 아래를 따라간다
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let delay = 5_000;
    // AI 서비스가 늦게 뜨거나 잠시 꺼져 있어도, 새로고침하지 않고 다시 확인해 상담을 켠다
    const check = () =>
      api
        .agentStatus()
        .then((s) => {
          setStatus(s);
          setStatusError(null);
        })
        .catch((e: Error) => {
          setStatusError(e instanceof ApiError ? e.message : 'AI 서비스에 연결하지 못했어요.');
          timer = window.setTimeout(check, delay);
          delay = Math.min(delay * 2, 60_000);
        });
    void check();
    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, []);

  // 상담 창이 화면 밖으로 나가면 '물어보기' 버튼을 띄운다
  useEffect(() => {
    const card = document.getElementById('ask');
    if (!card) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.15 });
    io.observe(card);
    return () => io.disconnect();
  }, []);

  const follow = useCallback(() => {
    const box = scrollRef.current;
    if (box && following.current) box.scrollTop = box.scrollHeight;
  }, []);
  useLayoutEffect(follow, [turns, activity, follow]);

  const enabled = !!status?.enabled;

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy || !enabled) return;
    const history: ChatMessage[] = [...turns.map(({ role, content }) => ({ role, content })), { role: 'user', content: q }];
    const updateReply = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);
    const controller = new AbortController();
    abortRef.current = controller;
    following.current = true;
    setTurns((ts) => [...ts, { role: 'user', content: q }, { role: 'assistant', content: '' }]);
    setInput('');
    setError(null);
    setBusy(true);
    setActivity('데이터를 확인하는 중이에요');
    let received = '';
    try {
      const done = await api.agentChatStream(
        history,
        date,
        {
          onTool: (name) => setActivity(ACTIVITY[name] ?? '데이터를 확인하는 중이에요'),
          onText: (delta) => {
            received += delta;
            setActivity(null);
            updateReply((t) => ({ ...t, content: t.content + delta }));
          },
          onReset: (text) => {
            received = text;
            updateReply((t) => ({ ...t, content: text }));
          },
        },
        controller.signal,
      );
      const sources = [...new Set([...done.prefetched, ...done.toolCalls].map(sourceLabel))];
      updateReply((t) => ({ ...t, sources }));
    } catch (e) {
      const stopped = controller.signal.aborted;
      if (received.trim()) {
        updateReply((t) => ({ ...t, note: stopped ? '답을 멈췄어요' : '답을 끝까지 받지 못했어요' }));
      } else {
        // 받은 글자가 없으면 질문을 입력창으로 되돌린다
        setTurns((ts) => ts.slice(0, -2));
        setInput(q);
        if (!stopped) setError(e instanceof ApiError ? e.message : '답을 받지 못했어요. 잠시 뒤 다시 물어봐 주세요.');
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setActivity(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(input);
  };

  const onScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    setScrolled(box.scrollTop > 0);
  };

  const jumpToChat = () => {
    document.getElementById('ask')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    inputRef.current?.focus({ preventScroll: true });
  };

  const unavailable = statusError ?? (status && !status.enabled ? 'LLM API 키가 아직 설정되지 않아 상담을 쓸 수 없어요' : null);

  return (
    <>
      <Card className="chat" id="ask" title="길막닥터에게 물어보기">
        <div className={`chat__scroll${scrolled ? ' is-scrolled' : ''}`} ref={scrollRef} onScroll={onScroll}>
          {turns.length === 0 ? (
            <div className="chat__intro">
              <p className="muted">날짜나 공연 이름을 말하면 언제 도착하고 어떻게 움직이면 좋을지 데이터를 확인해 답해 드려요</p>
              <ul className="chat__suggest">
                {suggestions(day).map((s) => (
                  <li key={s}>
                    <button type="button" className="chip" disabled={!enabled || busy} onClick={() => void ask(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ol className="chat__list" aria-live="polite" aria-busy={busy}>
              {turns.map((t, i) => {
                const live = busy && i === turns.length - 1;
                return (
                  <li key={i} className={`chat__turn chat__turn--${t.role}`}>
                    <p className="chat__who">{t.role === 'user' ? '나' : '길막닥터'}</p>
                    {t.role === 'user' ? <p className="chat__text">{t.content}</p> : <Reply text={t.content} onGrow={follow} />}
                    {live && activity && <p className="chat__activity">{activity}</p>}
                    {t.note && <p className="chat__meta">{t.note}</p>}
                    {t.sources && t.sources.length > 0 && <p className="chat__meta">확인한 데이터: {t.sources.join(', ')}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {error && <p className="notice">{error}</p>}
        {unavailable && <p className="caption">{unavailable}</p>}

        <form className="chat__form" onSubmit={onSubmit}>
          <label htmlFor="ask-input" className="sr-only">
            질문
          </label>
          <input
            id="ask-input"
            ref={inputRef}
            className="chat__input"
            value={input}
            maxLength={500}
            placeholder={enabled ? '예: 토요일 KSPO DOME 공연 끝나고 언제 나가야 해?' : '상담을 쓸 수 없어요'}
            disabled={!enabled || busy}
            onChange={(e) => setInput(e.target.value)}
          />
          {busy ? (
            <button type="button" className="btn-secondary" onClick={() => abortRef.current?.abort()}>
              멈추기
            </button>
          ) : (
            <button type="submit" className="btn-primary" disabled={!enabled || !input.trim()}>
              보내기
            </button>
          )}
        </form>
      </Card>

      {!inView && (
        <button type="button" className="chat-jump" onClick={jumpToChat}>
          길막닥터에게 물어보기
        </button>
      )}
    </>
  );
}
