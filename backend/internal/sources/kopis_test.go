package sources

import (
	"reflect"
	"testing"
)

func TestParseSchedule(t *testing.T) {
	got := ParseSchedule("화요일 ~ 금요일(11:00,14:00), 토요일 ~ 일요일(11:00,14:00,17:00), HOL(9:30)")
	want := map[int][]string{
		1: {"11:00", "14:00"}, 2: {"11:00", "14:00"}, 3: {"11:00", "14:00"}, 4: {"11:00", "14:00"},
		5: {"11:00", "14:00", "17:00"}, 6: {"11:00", "14:00", "17:00"},
		HolidayKey: {"09:30"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSchedule = %v, want %v", got, want)
	}

	// 요일이 한 주를 넘어가는 범위(금~월)
	wrap := ParseSchedule("금요일 ~ 월요일(19:00)")
	for _, d := range []int{4, 5, 6, 0} {
		if len(wrap[d]) != 1 || wrap[d][0] != "19:00" {
			t.Fatalf("wrap[%d] = %v", d, wrap[d])
		}
	}
	if len(wrap[2]) != 0 {
		t.Fatalf("수요일은 없어야 함: %v", wrap[2])
	}
}

func TestParseRuntime(t *testing.T) {
	cases := map[string]int{"2시간 30분": 150, "1시간": 60, "90분": 90, "": 0}
	for in, want := range cases {
		if got := ParseRuntime(in); got != want {
			t.Errorf("ParseRuntime(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestHallOf(t *testing.T) {
	halls := []Hall{{ID: "FC001247-01", Name: "KSPO DOME(체조경기장)", Seats: 15000}, {ID: "FC001247-03", Name: "올림픽홀", Seats: 2452}}
	if h := hallOf(PerfDetail{HallID: "FC001247-03"}, halls); h == nil || h.Name != "올림픽홀" {
		t.Fatalf("공연장 ID로 찾지 못함: %v", h)
	}
	if h := hallOf(PerfDetail{Facility: "올림픽공원 (KSPO DOME(체조경기장))"}, halls); h == nil || h.Seats != 15000 {
		t.Fatalf("시설명으로 찾지 못함: %v", h)
	}
}

func TestCommas(t *testing.T) {
	for in, want := range map[int]string{600: "600", 1000: "1,000", 1234567: "1,234,567"} {
		if got := commas(in); got != want {
			t.Errorf("commas(%d) = %s, want %s", in, got, want)
		}
	}
}
