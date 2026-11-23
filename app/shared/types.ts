// 화면이 받는 API 응답 형태. Go 백엔드의 backend/internal/types/types.go 와 같아야 한다(바꾸면 양쪽을 함께 바꾼다).

/** 혼잡 단계. 서울시 실시간 도시데이터의 인구 혼잡 용어(여유·보통·약간 붐빔·붐빔)와 맞췄다. */
export type Level = 'calm' | 'normal' | 'busy' | 'jam';

export const LEVEL_LABEL: Record<Level, string> = {
  calm: '여유',
  normal: '보통',
  busy: '붐빔',
  jam: '매우 붐빔',
};

export type DayType = 'weekday' | 'weekend' | 'holiday';

/** 그날 열리는 공연 회차 하나 */
export interface Show {
  id: string;
  name: string;
  hall: string;
  seats: number;
  /** 시작 시각 HH:MM (KST) */
  start: string;
  /** 종료 예상 HH:MM. 런타임이 없으면 기본값으로 추정 */
  end: string;
  runtimeMin: number;
  runtimeKnown: boolean;
  genre: string;
  /** 2,000석 이상 공연장(예측에 반영) */
  major: boolean;
}

export interface ForecastBin {
  /** 구간 시작 HH:MM */
  t: string;
  level: Level;
  /** 상대 수요(최근 기준 분포의 95분위 = 1) */
  ratio: number;
  /** 공연 영향이 차지하는 비중 0~1 */
  eventShare: number;
}

export interface Window {
  from: string;
  to: string;
}

export interface ConcertAdvice {
  showId: string;
  /** 이 시각 전에 도착하면 수월하다(transitFirst 면 그만큼 일찍 와야 한다는 뜻) */
  arriveBy: string;
  /** 붐빔이 시작되는 시각 */
  busyFrom: string | null;
  start: string;
  end: string;
  /** 공연 종료 후 출차가 몰리는 구간 */
  exitRush: Window;
  transitFirst: boolean;
}

export interface ParkAdvice {
  best: Window[];
  avoid: (Window & { reason: 'event' | 'usual' })[];
}

export interface DayWeather {
  sky: string | null;
  minTemp: number | null;
  maxTemp: number | null;
  rainChance: number | null;
  precipType: string | null;
  source: 'kma';
}

export interface DayResponse {
  date: string;
  weekday: string;
  dayType: DayType;
  holidayName: string | null;
  shows: Show[];
  forecast: {
    bins: ForecastBin[];
    peak: { t: string; level: Level };
    /** 단계 경계(ratio 기준) */
    thresholds: { normal: number; busy: number; jam: number };
  };
  advice: { concert: ConcertAdvice[]; park: ParkAdvice };
  weather: DayWeather | null;
  model: {
    version: string;
    fitMaeCars: number | null;
    exitMinutes: number;
    note: string;
    /** ml-service(Python AI 서비스) | embedded(Go 내장 모델) */
    source: string;
  };
}

/** 화면이 시작할 때 받는 공개 설정 */
export interface ConfigResponse {
  naverMapClientId: string | null;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentStatus {
  enabled: boolean;
  model: string;
}

/** 에이전트가 확인한 데이터(도구 호출, 또는 질문과 함께 미리 읽은 것) */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** /api/agent/chat/stream 의 마지막 done 이벤트 */
export interface AgentDone {
  toolCalls: ToolCall[];
  prefetched: ToolCall[];
  stopReason: string | null;
  model: string;
}

/** /api/agent/chat (한 번에 받는 답) */
export interface AgentReply extends AgentDone {
  reply: string;
}

export interface OverviewDay {
  date: string;
  weekday: string;
  dayType: DayType;
  holidayName: string | null;
  peakLevel: Level;
  peakTime: string;
  majorShows: { name: string; hall: string; start: string; seats: number }[];
}

export interface RoadLink {
  id: string;
  name: string;
  from: string;
  to: string;
  speed: number;
  idx: '원활' | '서행' | '정체' | string;
  /** [경도, 위도][] */
  path: [number, number][];
}

export interface ParkingLot {
  id: string;
  name: string;
  capacity: number;
  lat: number;
  lng: number;
  address: string;
  /** 예: 10분 600원 */
  fee: string | null;
}

export interface Station {
  name: string;
  line: string;
  lat: number;
  lng: number;
}

export interface Control {
  id: string;
  kind: string;
  info: string;
  from: string | null;
  to: string | null;
  distanceM: number | null;
  lat: number | null;
  lng: number | null;
}

export interface LiveResponse {
  fetchedAt: string;
  parking: { sum: number; at: string; today: { at: string; sum: number }[] } | null;
  population: {
    level: string;
    message: string;
    min: number;
    max: number;
    at: string;
    forecast: { at: string; level: string }[];
  } | null;
  road: {
    level: string;
    speed: number;
    message: string;
    at: string;
    links: RoadLink[];
  } | null;
  weather: {
    temp: number;
    sky: string | null;
    precipType: string;
    message: string;
    pm10Level: string;
    at: string;
  } | null;
  lots: ParkingLot[];
  stations: Station[];
  controls: Control[];
  errors: Record<string, string>;
}
