package api

import (
	"testing"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/collector"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

func rec(at string, parking int) collector.Record {
	return collector.Record{At: at, Parking: &parking}
}

func TestUsualFromAveragesSameTimeAcrossDays(t *testing.T) {
	days := [][]collector.Record{
		{rec("2026-11-23 14:00", 1900), rec("2026-11-23 14:05", 2000), rec("2026-11-23 14:10", 2100)},
		{rec("2026-11-24 13:55", 1790), rec("2026-11-24 14:06", 1800)},
		{rec("2026-11-25 09:00", 900)}, // 같은 시각 기록이 없는 날은 뺀다
		{{At: "2026-11-26 14:05"}},     // 주차대수를 못 받은 기록도 뺀다
	}
	u := usualFrom(days, 14*60+5, types.Weekday)
	if u == nil || u.Sum != 1900 || u.Days != 2 || u.DayType != types.Weekday {
		t.Fatalf("14:05 에 가장 가까운 값(2000, 1800)의 평균 1900, 2일이어야 함: %+v", u)
	}
}

func TestUsualFromNeedsTwoDays(t *testing.T) {
	days := [][]collector.Record{{rec("2026-11-23 14:05", 2000)}}
	if u := usualFrom(days, 14*60+5, types.Weekday); u != nil {
		t.Fatalf("하루치로는 평소라고 하지 않는다: %+v", u)
	}
}

func TestUsualKindGroupsHolidayWithWeekend(t *testing.T) {
	if usualKind(types.Holiday) != types.Weekend || usualKind(types.Weekend) != types.Weekend || usualKind(types.Weekday) != types.Weekday {
		t.Fatal("공휴일은 주말과 같은 묶음이어야 함")
	}
}
