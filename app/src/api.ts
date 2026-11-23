import type { AgentDone, AgentStatus, ChatMessage, ConfigResponse, DayResponse, LiveResponse, OverviewDay } from '../shared/types.ts';

type WithErrors<T> = T & { errors: Record<string, string> };

/** API 오류. 상담 API 는 {detail: {code, message}} 로 이유를 알려 준다. */
export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let message = `요청 실패 (${res.status})`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { detail?: { code?: string; message?: string } };
    message = body.detail?.message ?? message;
    code = body.detail?.code ?? null;
  } catch {
    // 본문이 JSON 이 아니면 상태 코드만 알린다
  }
  return new ApiError(res.status, message, code);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as T;
}

/** Server-Sent Events 를 {event, data} 로 읽는다. 서버는 줄바꿈으로 \n 만 쓴다. */
async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }); // 한글 글자가 조각 경계에서 잘려도 이어 붙인다
      let end = buffer.indexOf('\n\n');
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join('\n') };
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ChatStreamHandlers {
  /** 도구로 데이터를 확인하기 시작함 */
  onTool: (name: string) => void;
  /** 답 글자가 더 옴 */
  onText: (delta: string) => void;
  /** 지금까지 받은 답을 text 로 바꿔야 함 */
  onReset: (text: string) => void;
}

/** 답을 만들어지는 대로 받는다. 끝나면 확인한 데이터 목록을 돌려준다. */
async function agentChatStream(
  messages: ChatMessage[],
  date: string | null,
  on: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<AgentDone> {
  const res = await fetch('/api/agent/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, context: date ? { date } : {} }),
    signal,
  });
  if (!res.ok || !res.body) throw await toApiError(res);
  for await (const { event, data } of readEvents(res.body)) {
    const payload = JSON.parse(data) as Record<string, unknown>;
    if (event === 'tool') on.onTool(String(payload.name));
    else if (event === 'text') on.onText(String(payload.delta));
    else if (event === 'reset') on.onReset(String(payload.text));
    else if (event === 'done') return payload as unknown as AgentDone;
    else if (event === 'error') {
      throw new ApiError(502, String(payload.message ?? '답을 만드는 중 오류가 났어요.'), (payload.code as string) ?? null);
    }
  }
  throw new ApiError(502, '답이 중간에 끊겼어요. 다시 물어봐 주세요.', 'incomplete');
}

export const api = {
  config: () => request<ConfigResponse>('/api/config'),
  overview: () => request<{ days: OverviewDay[]; errors: Record<string, string> }>('/api/overview?days=14'),
  day: (date: string) => request<WithErrors<DayResponse>>(`/api/day?date=${date}`),
  live: () => request<LiveResponse>('/api/live'),
  agentStatus: () => request<AgentStatus>('/api/agent/status'),
  agentChatStream,
};

export type DayData = WithErrors<DayResponse>;
