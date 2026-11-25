package model

import (
	"testing"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

func TestForecastDayRange(t *testing.T) {
	f := ForecastDay(types.Weekday, nil)
	if len(f.Bins) != 36 || f.Bins[0].T != "06:00" || f.Bins[35].T != "23:30" {
		t.Fatalf("06:00~23:30 30분 구간 36개여야 함: %d개, %s~%s", len(f.Bins), f.Bins[0].T, f.Bins[len(f.Bins)-1].T)
	}
	for _, b := range f.Bins {
		if b.EventShare != 0 {
			t.Fatalf("공연이 없으면 공연 영향은 0: %+v", b)
		}
	}
}

func TestBigShowRaisesEvening(t *testing.T) {
	show := types.Show{ID: "x", Start: "19:00", End: "21:30", Seats: 15000, Major: true}
	quiet := ForecastDay(types.Weekday, nil)
	busy := ForecastDay(types.Weekday, []types.Show{show})
	// 2025년 기준(v1)으로는 평일 저녁 KSPO DOME 공연 하나면 '붐빔', 다른 공연과 겹치거나 주말이면 '매우 붐빔'까지 오른다.
	// 공연 없는 평일도 오전이 '붐빔'이라 단계 대신 혼잡 수치(ratio)로 비교한다.
	if busy.Peak.Level.Rank() < types.Busy.Rank() || ratioAt(busy, busy.Peak.T) <= ratioAt(quiet, quiet.Peak.T) {
		t.Fatalf("1.5만 석 공연일 피크는 붐빔 이상이고 공연 없는 날 피크보다 붐벼야 함: %+v vs %+v", busy.Peak, quiet.Peak)
	}
	for i, b := range busy.Bins {
		if b.T == "19:00" && b.Ratio <= quiet.Bins[i].Ratio {
			t.Fatalf("공연 시작 시각 수요가 늘지 않음: %v vs %v", b.Ratio, quiet.Bins[i].Ratio)
		}
	}

	a := ConcertAdvice(show, busy.Bins, ExitMinutes())
	if a.ExitRush.From != "21:30" || a.ExitRush.To != kst.HHMM(21*60+30+ExitMinutes()) {
		t.Fatalf("출차 집중 구간은 종료(21:30)부터 %d분: %+v", ExitMinutes(), a.ExitRush)
	}
	if a.BusyFrom == nil {
		t.Fatalf("붐비기 시작하는 시각이 있어야 함")
	}
}

// 붐빔이 공연 3시간 전보다 먼저 시작돼도 처방은 그 시작 시각을 알려야 한다(진단의 "붐비기 시작"과 같은 시각).
// 권장 도착 시각은 그보다 앞이어야 한다.
func TestConcertAdviceBusyFromIsStartOfRun(t *testing.T) {
	bins := []types.ForecastBin{}
	for m := 6 * 60; m < 24*60; m += 30 {
		level := types.Normal
		if m >= 15*60+30 && m < 22*60 { // 15:30~22:00 붐빔
			level = types.Busy
		}
		bins = append(bins, types.ForecastBin{T: kst.HHMM(m), Level: level})
	}
	show := types.Show{ID: "x", Start: "19:00", End: "21:10", Seats: 15000, Major: true}
	a := ConcertAdvice(show, bins, 70)
	if a.BusyFrom == nil || *a.BusyFrom != "15:30" {
		t.Fatalf("붐비기 시작 시각은 15:30 이어야 함(3시간 전인 16:00 이 아니라): %v", a.BusyFrom)
	}
	if a.ArriveBy != "15:15" {
		t.Fatalf("권장 도착 시각은 붐비기 15분 전인 15:15 여야 함: %s", a.ArriveBy)
	}
	if !a.TransitFirst {
		t.Fatalf("공연 3시간 전에 이미 붐비면 대중교통을 먼저 권해야 함")
	}

	// 붐빔이 공연 1시간 반 전에 시작되면 그 시각 그대로, 대중교통 우선은 아니다.
	for i := range bins {
		m := 6*60 + i*30
		bins[i].Level = types.Normal
		if m >= 17*60+30 && m < 22*60 {
			bins[i].Level = types.Busy
		}
	}
	a = ConcertAdvice(show, bins, 70)
	if a.BusyFrom == nil || *a.BusyFrom != "17:30" || a.ArriveBy != "17:15" || a.TransitFirst {
		t.Fatalf("17:30 부터 붐비면 17:15 전 도착, 대중교통 우선 아님: %+v", a)
	}

	// 공연 전에 붐비지 않으면 시작 45분 전 도착
	for i := range bins {
		bins[i].Level = types.Calm
	}
	a = ConcertAdvice(show, bins, 70)
	if a.BusyFrom != nil || a.ArriveBy != "18:15" || a.TransitFirst {
		t.Fatalf("붐비지 않으면 18:15 전 도착: %+v", a)
	}
}

func ratioAt(f DayForecast, t string) float64 {
	for _, b := range f.Bins {
		if b.T == t {
			return b.Ratio
		}
	}
	return 0
}

func TestMetaComesFromModelFile(t *testing.T) {
	m := Meta()
	if m.Version == "" || m.Note == "" || m.Period == "" {
		t.Fatalf("모델 파일의 버전·기간·설명이 메타로 나와야 함: %+v", m)
	}
	if m.ExitShows <= 0 || m.ExitMinutes <= 0 {
		t.Fatalf("출차 소요시간과 잰 회차 수가 있어야 함: %+v", m)
	}
}

func TestParkAdviceAvoidsShow(t *testing.T) {
	show := types.Show{ID: "x", Start: "17:00", End: "19:30", Seats: 15000, Major: true}
	p := ParkAdvice(ForecastDay(types.Weekend, []types.Show{show}).Bins)
	found := false
	for _, w := range p.Avoid {
		if w.Reason == "event" {
			found = true
		}
	}
	if !found {
		t.Fatalf("공연 때문에 피할 시간이 있어야 함: %+v", p.Avoid)
	}
}
