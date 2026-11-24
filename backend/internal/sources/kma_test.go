package sources

import "testing"

func pty(time, value string) kmaItem {
	return kmaItem{Category: "PTY", FcstTime: time, FcstValue: value}
}

func TestPrecipWindow(t *testing.T) {
	// 15~17시 비, 20시 눈: 종류는 가장 이른 것, 시간대는 처음부터 마지막 시각의 한 시간 뒤까지
	kind, from, to := precipWindow([]kmaItem{pty("2000", "3"), pty("0900", "0"), pty("1500", "1"), pty("1600", "1"), pty("1700", "1")})
	if kind == nil || *kind != "비" || from == nil || *from != "15:00" || to == nil || *to != "21:00" {
		t.Fatalf("비 15:00~21:00 이어야 함: %v %v %v", kind, from, to)
	}
	if kind, from, to := precipWindow([]kmaItem{pty("0900", "0"), pty("1000", "0")}); kind != nil || from != nil || to != nil {
		t.Fatal("강수 예보가 없으면 모두 nil")
	}
	if _, _, to := precipWindow([]kmaItem{pty("2300", "1")}); to == nil || *to != "24:00" {
		t.Fatalf("23시 강수의 끝은 24:00: %v", to)
	}
}
