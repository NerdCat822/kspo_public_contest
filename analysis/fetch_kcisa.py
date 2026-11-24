"""문화공공데이터광장(api.kcisa.kr)에서 한국체육산업개발 2025년 데이터를 받아 data/raw/kcisa/ 에 쌓는다.

사용법:
    python3 analysis/fetch_kcisa.py .env inout     # 입출차정보(전체구역), 약 241만 건, 4~5시간
    python3 analysis/fetch_kcisa.py .env linked    # 차량입출차·공연·날씨 연계 데이터, 7,803건

받은 뒤 analysis/load_kcisa.py 로 PostgreSQL 에 넣는다.

- 키는 .env 의 CULTURE_API_KEY_INOUT / CULTURE_API_KEY_LINKED 를 읽는다(출력에 노출하지 않는다).
- 개발 계정은 키마다 하루 1,000건이고, 1분 구간마다 한 번만 받아 준다(더 부르면 429). 그래서 한 쪽을 받으면 61초 쉰다.
- 한 번에 최대 10,000건이다. 쪽마다 파일 하나(page-00001.json.gz)로 남겨서, 끊겨도 받은 쪽은 건너뛰고 이어 받는다.
- 연계 데이터는 JSON 으로 받으면 DESCRIPTION(주차대수·기온 등)이 비어 온다. XML(기본 형식)로 받는다.
- 다 받으면 폴더에 done 파일을 남긴다.
"""
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROWS = 10000  # numOfRows 최대값(더 크게 줘도 10,000행만 온다)
PAUSE = 61  # 1분 구간에 한 번만 받아 준다
DATASETS = {
    "inout": {"url": "https://api.kcisa.kr/openapi/API_CPM_008/request", "key": "CULTURE_API_KEY_INOUT", "fmt": "json"},
    "linked": {"url": "https://api.kcisa.kr/openapi/API_CPM_009/request", "key": "CULTURE_API_KEY_LINKED", "fmt": "xml"},
}


def load_env(path):
    env = {}
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def log(msg):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)


def parse(raw, fmt):
    """(결과코드, 전체 건수, 이 쪽의 행 수)"""
    if fmt == "json":
        res = json.loads(raw)["response"]
        body = res.get("body") or {}
        items = (body.get("items") or {}).get("item") or []
        if isinstance(items, dict):
            items = [items]
        return res["header"]["resultCode"], int(body.get("totalCount") or 0), len(items)
    text = raw.decode("utf-8", "replace")
    code = re.search(r"<resultCode>(.*?)</resultCode>", text)
    total = re.search(r"<totalCount>(\d+)</totalCount>", text)
    return (code.group(1) if code else ""), int(total.group(1)) if total else 0, text.count("<item>")


def fetch(url, key, page, fmt):
    """한 쪽을 받는다. 429(분당 한 번)와 일시 오류는 기다렸다 다시 부른다."""
    query = urllib.parse.urlencode({"serviceKey": key, "numOfRows": ROWS, "pageNo": page})
    headers = {"Accept": "application/json"} if fmt == "json" else {}
    throttled = failed = 0
    while True:
        try:
            req = urllib.request.Request(f"{url}?{query}", headers=headers)
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read()
            code, total, count = parse(raw, fmt)
            if code != "0000":
                raise ValueError(f"resultCode {code}")
            return raw, total, count
        except urllib.error.HTTPError as e:
            if e.code == 429:
                throttled += 1
                if throttled > 60:  # 10분 넘게 막히면 하루 한도(1,000건)를 넘긴 것으로 본다
                    raise SystemExit(f"{page}쪽: 429 가 10분 넘게 이어져요. 하루 한도를 넘겼을 수 있어요. 내일 다시 실행하면 이어 받아요.")
                time.sleep(10)
                continue
            err = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError, KeyError) as e:
            err = type(e).__name__ + (f" {e}" if isinstance(e, ValueError) else "")
        failed += 1
        if failed > 10:
            raise SystemExit(f"{page}쪽: 10번 실패했어요({err}). 다시 실행하면 이어 받아요.")
        log(f"{page}쪽 실패({err}), 30초 뒤 다시 시도")
        time.sleep(30)


def main():
    env_path, name = sys.argv[1], sys.argv[2]
    ds = DATASETS[name]
    key = load_env(env_path)[ds["key"]]
    out_dir = os.path.join("data", "raw", "kcisa", name)
    os.makedirs(out_dir, exist_ok=True)
    meta_path = os.path.join(out_dir, "meta.json")
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}

    page, got = 1, 0
    while True:
        path = os.path.join(out_dir, f"page-{page:05d}.{ds['fmt']}.gz")
        pages = meta.get("pages")
        if pages and page > pages:
            break
        if os.path.exists(path):
            page += 1
            continue
        raw, total, count = fetch(ds["url"], key, page, ds["fmt"])
        if not pages:
            pages = -(-total // ROWS)
            meta = {"totalCount": total, "numOfRows": ROWS, "pages": pages}
            json.dump(meta, open(meta_path, "w"))
        expect = ROWS if page < pages else total - ROWS * (pages - 1)
        if count != expect:
            raise SystemExit(f"{page}쪽: {expect}행이어야 하는데 {count}행이에요. 다시 실행해 주세요.")
        tmp = path + ".tmp"
        with gzip.open(tmp, "wb") as f:
            f.write(raw)
        os.replace(tmp, path)
        got += 1
        log(f"{name} {page}/{pages}쪽 {count:,}행")
        if page >= pages:
            break
        page += 1
        time.sleep(PAUSE)

    with open(os.path.join(out_dir, "done"), "w") as f:
        f.write(json.dumps({**meta, "finishedAt": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False))
    log(f"{name} 완료: 전체 {meta.get('totalCount', 0):,}건, {meta.get('pages')}쪽 (이번 실행에서 {got}쪽 받음)")


if __name__ == "__main__":
    main()
