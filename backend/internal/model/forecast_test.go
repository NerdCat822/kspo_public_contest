package model

import (
	"testing"

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
	if busy.Peak.Level != types.Jam {
		t.Fatalf("1.5만 석 공연일 피크는 매우 붐빔이어야 함: %+v", busy.Peak)
	}
	for i, b := range busy.Bins {
		if b.T == "19:00" && b.Ratio <= quiet.Bins[i].Ratio {
			t.Fatalf("공연 시작 시각 수요가 늘지 않음: %v vs %v", b.Ratio, quiet.Bins[i].Ratio)
		}
	}

	a := ConcertAdvice(show, busy.Bins, ExitMinutes())
	if a.ExitRush.From != "21:30" || a.ExitRush.To != "22:40" {
		t.Fatalf("출차 집중 구간: %+v", a.ExitRush)
	}
	if a.BusyFrom == nil {
		t.Fatalf("붐비기 시작하는 시각이 있어야 함")
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
