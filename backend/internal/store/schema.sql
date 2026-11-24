-- 길막닥터 저장소(PostgreSQL). 백엔드가 뜰 때마다 실행한다. 몇 번을 돌려도 결과가 같게 쓴다.
-- 계정·DB 만들기는 README '배포' 를 따른다. 시각은 모두 timestamptz 이고, DB 시간대를 Asia/Seoul 로 두면
-- psql 에서 한국 시각으로 보인다.

CREATE SCHEMA IF NOT EXISTS gilmak;

-- 실시간 수집기가 5분마다 남기는 값. 기관 API 가 이력을 주지 않아 직접 모은다(예측과 실측 비교, 재학습).
-- 같은 분에 두 번 모으면(서버를 곧바로 다시 띄운 경우) 나중 값으로 덮는다.
CREATE TABLE IF NOT EXISTS gilmak.live_snapshot (
    observed_at timestamptz PRIMARY KEY,   -- 모은 시각(분 단위)
    parking     integer,                   -- 한국체육산업개발 실시간 주차대수 합계. 못 받으면 NULL
    pop_level   text,                      -- 서울시 도시데이터 올림픽공원 인구 혼잡도
    pop_min     integer,                   -- 추정 인구 하한·상한(명)
    pop_max     integer,
    road_level  text,                      -- 주변 도로 소통 단계
    road_speed  double precision           -- 주변 도로 평균 속도(km/h)
);

COMMENT ON TABLE gilmak.live_snapshot IS '실시간 수집 기록(5분 간격): 주차대수, 공원 인구, 주변 도로 소통';

-- 외부 API 응답 캐시(KOPIS 공연장·공연 목록·공연 상세, 특일정보). 서버를 다시 띄워도 다시 부르지 않게 남긴다.
-- 만료된 행은 서버가 뜰 때 7일이 지난 것부터 지운다.
CREATE TABLE IF NOT EXISTS gilmak.api_cache (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    saved_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE gilmak.api_cache IS '외부 공공 API 응답 캐시(KOPIS, 특일정보)';
