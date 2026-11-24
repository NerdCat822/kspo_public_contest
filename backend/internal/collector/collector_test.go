package collector

import "testing"

func TestParkingAtPicksNearestWithinTolerance(t *testing.T) {
	a, b := 1500, 1600
	recs := []Record{{At: "2026-11-23 13:50", Parking: &a}, {At: "2026-11-23 14:04", Parking: &b}, {At: "2026-11-23 14:05"}}
	if v, ok := ParkingAt(recs, 14*60+5, 10); !ok || v != 1600 {
		t.Fatalf("14:05 에 가장 가까운 값은 14:04 의 1600: %d %v", v, ok)
	}
	if _, ok := ParkingAt(recs, 16*60, 10); ok {
		t.Fatal("10분 안에 기록이 없으면 false")
	}
	if _, ok := ParkingAt(nil, 600, 10); ok {
		t.Fatal("기록이 없으면 false")
	}
}
