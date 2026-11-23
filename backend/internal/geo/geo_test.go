package geo

import (
	"math"
	"testing"
)

func TestFromTMKnownPoint(t *testing.T) {
	// 서울시 돌발정보 샘플(탄천나들목·봉은교 공사)의 TM 좌표
	lat, lng := FromTM(206076.7132692197, 446245.6950463236)
	if math.Abs(lat-37.5157) > 0.001 || math.Abs(lng-127.0687) > 0.001 {
		t.Fatalf("FromTM = %.5f, %.5f", lat, lng)
	}
}

func TestRoundTrip(t *testing.T) {
	x, y := ToTM(ParkCenter.Lat, ParkCenter.Lng)
	lat, lng := FromTM(x, y)
	if math.Abs(lat-ParkCenter.Lat) > 1e-7 || math.Abs(lng-ParkCenter.Lng) > 1e-7 {
		t.Fatalf("왕복 오차: %.8f, %.8f", lat, lng)
	}
}
