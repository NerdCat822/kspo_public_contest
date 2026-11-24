package sources

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeCityNotices(t *testing.T) {
	long := strings.Repeat("가", maxNoticeRunes+10)
	var city map[string]any
	if err := json.Unmarshal([]byte(`{
		"LIVE_DST_MESSAGE": [
			{"MSG_CN": "[송파구청] 마라톤 대회로\n올림픽로 교통통제", "CRT_DT": "2026-11-28 18:00", "EMPTY": ""},
			{"MSG_CN": "`+long+`"}
		],
		"LIVE_YNA_NEWS": {"YNA_TTL": "올림픽공원 앞 집회", "YNA_YMD": "20261129"}
	}`), &city); err != nil {
		t.Fatal(err)
	}
	out := normalizeCity(city)
	if len(out.Alerts) != 2 || out.Alerts[0]["MSG_CN"] != "[송파구청] 마라톤 대회로 올림픽로 교통통제" || out.Alerts[0]["CRT_DT"] != "2026-11-28 18:00" {
		t.Fatalf("재난문자는 받은 항목 이름 그대로, 줄바꿈은 띄어쓰기로: %+v", out.Alerts)
	}
	if _, ok := out.Alerts[0]["EMPTY"]; ok {
		t.Fatal("빈 값은 뺀다")
	}
	if r := []rune(out.Alerts[1]["MSG_CN"]); len(r) != maxNoticeRunes+1 {
		t.Fatalf("긴 내용은 %d자에서 자른다: %d자", maxNoticeRunes, len(r))
	}
	if len(out.News) != 1 || out.News[0]["YNA_TTL"] != "올림픽공원 앞 집회" {
		t.Fatalf("한 건이 객체로 와도 읽는다: %+v", out.News)
	}
	if empty := normalizeCity(map[string]any{}); empty.Alerts == nil || empty.News == nil || len(empty.Alerts) != 0 {
		t.Fatalf("없으면 빈 목록: %+v %+v", empty.Alerts, empty.News)
	}
}
