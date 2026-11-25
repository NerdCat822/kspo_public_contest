"""analysis/fetch_kcisa.py 로 받은 2025년 데이터를 PostgreSQL(스키마 gilmak)에 넣는다.

사용법:
    python3 analysis/load_kcisa.py .env            # 받은 것 전부(입출차, 연계 데이터)
    python3 analysis/load_kcisa.py .env linked     # 하나만

- DB 주소는 .env 의 DATABASE_URL 을 쓴다(이 PC 의 127.0.0.1:5432, 공용 postgres-db 컨테이너).
- 몇 번을 돌려도 같은 결과가 되게 쓴다. 같은 ID(입출차 LOCAL_ID, 연계 데이터 시각)는 한 번만 들어간다.
- 시각은 원본이 한국 시각이라 Asia/Seoul 로 읽어 timestamptz 로 둔다.
- 원본 문자열이 형식에 맞지 않는 행은 넣지 않고 건수만 알려 준다.
"""
import glob
import gzip
import io
import json
import os
import re
import sys

import psycopg2

SCHEMA = """
CREATE SCHEMA IF NOT EXISTS gilmak;

-- 한국체육산업개발 올림픽공원 입출차정보(전체구역), 2025년. 문화공공데이터광장 API_CPM_008.
CREATE TABLE IF NOT EXISTS gilmak.kspo_inout_2025 (
    local_id   text PRIMARY KEY,        -- 원본 ID(B050-1872898)
    entry_gate text NOT NULL,           -- 원본 입구 이름(동2문입구#1, 북2문CMB 등)
    entry_zone text NOT NULL,           -- 입구 문(동2문, 남2문, 북2문, 서2문, 남4문, 남3문, 서1문). 문이 아니면 이름(회관 임원)
    entry_at   timestamptz NOT NULL,
    exit_gate  text,
    exit_zone  text,
    exit_at    timestamptz              -- 원본에 출차시간이 비어 있으면 NULL
);
CREATE INDEX IF NOT EXISTS kspo_inout_2025_entry_at ON gilmak.kspo_inout_2025 (entry_at);
COMMENT ON TABLE gilmak.kspo_inout_2025 IS '한국체육산업개발 올림픽공원 입출차정보(전체구역) 2025년, 문화공공데이터광장 API_CPM_008';

-- 한국체육산업개발 올림픽공원 차량입출차, 공연, 날씨정보 등 연계 데이터, 2025년 시간 단위. API_CPM_009.
CREATE TABLE IF NOT EXISTS gilmak.kspo_linked_2025 (
    observed_at timestamptz PRIMARY KEY,  -- 시각(1시간 단위)
    local_id    text,
    parking     integer,                  -- 주차대수
    visitors    integer,                  -- 방문객(원본 값. 주차대수의 5배로 계산된 값으로 보인다)
    temp        double precision,         -- 기온(℃)
    wind        double precision,         -- 원본 표기는 '풍향'. 값 범위(0~8.4)로 보아 풍속(m/s)으로 보인다
    rain        double precision,         -- 강수량(mm). 비가 오지 않으면 NULL
    humidity    double precision,         -- 습도(%)
    holiday     text,                     -- 휴일 이름(추석 연휴 등). 아니면 NULL
    shows       text,                     -- 그 시각에 걸린 공연명(여러 개면 ', ' 로 이음). 없으면 NULL
    audience    integer                   -- 공연관람객수
);
COMMENT ON TABLE gilmak.kspo_linked_2025 IS '한국체육산업개발 올림픽공원 차량입출차·공연·날씨 연계 데이터 2025년, 문화공공데이터광장 API_CPM_009';
"""

INOUT_RE = re.compile(r"^입구:(?P<eg>.*?), 입차시간:(?P<ea>.*?), 출구:(?P<xg>.*?), 출차시간:(?P<xa>.*)$")
ZONE_RE = re.compile(r"^(.*?문)")
GATE_SUFFIX_RE = re.compile(r"\s*(입구|출구)?\s*(#\d+)?\s*$")
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$")


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def zone(gate):
    """'동2문입구#1' → '동2문'. 문 이름이 아닌 곳('회관 임원 입구', '사전정산기#19')은 입구·출구·번호만 뗀다."""
    gate = (gate or "").strip()
    m = ZONE_RE.match(gate)
    if m:
        return m.group(1)
    return GATE_SUFFIX_RE.sub("", gate) or None


def esc(v):
    """COPY text 형식 값. None 은 \\N"""
    if v is None or v == "":
        return r"\N"
    return str(v).replace("\\", "\\\\").replace("\t", " ").replace("\n", " ").replace("\r", " ")


def copy_rows(cur, table, columns, rows, conflict):
    """임시 표에 COPY 로 넣은 뒤 같은 키는 건너뛰고 옮긴다. 새로 들어간 행 수를 돌려준다."""
    cur.execute("DROP TABLE IF EXISTS stage")
    cur.execute(f"CREATE TEMP TABLE stage (LIKE {table} INCLUDING DEFAULTS) ON COMMIT DROP")
    buf = io.StringIO("".join("\t".join(esc(v) for v in r) + "\n" for r in rows))
    cur.copy_expert(f"COPY stage ({', '.join(columns)}) FROM STDIN", buf)
    cur.execute(f"INSERT INTO {table} ({', '.join(columns)}) SELECT {', '.join(columns)} FROM stage ON CONFLICT ({conflict}) DO NOTHING")
    return cur.rowcount


def load_inout(cur):
    cols = ["local_id", "entry_gate", "entry_zone", "entry_at", "exit_gate", "exit_zone", "exit_at"]
    files = sorted(glob.glob("data/raw/kcisa/inout/page-*.json.gz"))
    total = added = bad = 0
    for f in files:
        items = json.load(gzip.open(f))["response"]["body"]["items"]["item"]
        rows = []
        for it in items:
            m = INOUT_RE.match((it.get("DESCRIPTION") or "").strip())
            if not m or not TS_RE.match(m["ea"].strip()):
                bad += 1
                continue
            xa = m["xa"].strip()
            xa = xa if TS_RE.match(xa) else None
            rows.append([it["LOCAL_ID"], m["eg"].strip(), zone(m["eg"]), m["ea"].strip(), m["xg"].strip() or None, zone(m["xg"]), xa])
        total += len(items)
        added += copy_rows(cur, "gilmak.kspo_inout_2025", cols, rows, "local_id")
    return len(files), total, added, bad


def kv(text):
    """'주차대수:429,방문객:1287, 기온:1.5, ...' → dict"""
    out = {}
    for part in re.split(r",\s*(?=[^,:]+:)", text or ""):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip()] = v.strip()
    return out


def num(v, cast=float):
    try:
        return cast(v) if v not in (None, "") else None
    except ValueError:
        return None


def load_linked(cur):
    cols = ["observed_at", "local_id", "parking", "visitors", "temp", "wind", "rain", "humidity", "holiday", "shows", "audience"]
    files = sorted(glob.glob("data/raw/kcisa/linked/page-*.xml.gz"))
    total = added = bad = 0
    for f in files:
        text = gzip.open(f).read().decode("utf-8")
        rows = []
        for item in re.findall(r"<item>(.*?)</item>", text, flags=re.S):
            def field(name):
                m = re.search(rf"<{name}>(.*?)</{name}>", item, flags=re.S)
                if not m:
                    return None
                v = m.group(1)
                c = re.match(r"\s*<!\[CDATA\[(.*)\]\]>\s*$", v, flags=re.S)
                return (c.group(1) if c else v).strip()
            total += 1
            at = field("ISSUED_DATE")
            if not at or not TS_RE.match(at):
                bad += 1
                continue
            d = kv(field("DESCRIPTION"))
            title = (field("TITLE") or "").replace("\n", " ")
            m = re.match(r"^공연명:(.*),\s*공연관람객수:(\d*)\s*$", title, flags=re.S)
            shows = re.sub(r"\s+", " ", m.group(1)).strip(" ,") if m else None
            audience = num(m.group(2), int) if m else None
            rows.append([at, field("LOCAL_ID"), num(d.get("주차대수"), int), num(d.get("방문객"), int), num(d.get("기온")), num(d.get("풍향")),
                         num(d.get("강수량")), num(d.get("습도")), d.get("휴일") or None, shows or None, audience])
        added += copy_rows(cur, "gilmak.kspo_linked_2025", cols, rows, "observed_at")
    return len(files), total, added, bad


def main():
    env = load_env(sys.argv[1])
    which = sys.argv[2:] or ["inout", "linked"]
    conn = psycopg2.connect(env["DATABASE_URL"])
    conn.autocommit = False
    with conn, conn.cursor() as cur:
        cur.execute("SET TIME ZONE 'Asia/Seoul'")
        cur.execute(SCHEMA)
        for name in which:
            if not os.path.isdir(f"data/raw/kcisa/{name}"):
                print(f"{name}: 받은 파일이 없어요(analysis/fetch_kcisa.py 먼저)")
                continue
            files, total, added, bad = (load_inout if name == "inout" else load_linked)(cur)
            done = os.path.exists(f"data/raw/kcisa/{name}/done")
            print(f"{name}: 파일 {files}개, 원본 {total:,}행, 새로 넣음 {added:,}행, 형식 오류 {bad:,}행{'' if done else ' (수집 진행 중)'}")
        cur.execute("ANALYZE gilmak.kspo_inout_2025")
        cur.execute("ANALYZE gilmak.kspo_linked_2025")
    conn.close()


if __name__ == "__main__":
    main()
