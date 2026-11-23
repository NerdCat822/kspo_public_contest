// Package kst 는 모든 날짜·시각을 한국 표준시로 다룬다(tzdata 없이도 동작하도록 고정 오프셋).
package kst

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var Zone = time.FixedZone("KST", 9*60*60)

// Weekdays 는 time.Weekday 순서(일요일=0)의 한글 요일
var Weekdays = []string{"일", "월", "화", "수", "목", "금", "토"}

var ymdPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)

func Now() time.Time { return time.Now().In(Zone) }

func Today() string { return Now().Format("2006-01-02") }

// Stamp 는 'YYYY-MM-DD HH:MM'
func Stamp(t time.Time) string { return t.In(Zone).Format("2006-01-02 15:04") }

func ParseYMD(s string) (time.Time, bool) {
	if !ymdPattern.MatchString(s) {
		return time.Time{}, false
	}
	t, err := time.ParseInLocation("2006-01-02", s, Zone)
	return t, err == nil
}

func AddDays(s string, n int) string {
	t, _ := ParseYMD(s)
	return t.AddDate(0, 0, n).Format("2006-01-02")
}

// Weekday 는 0=일요일
func Weekday(s string) int {
	t, _ := ParseYMD(s)
	return int(t.Weekday())
}

// HHMM 은 자정 기준 분을 'HH:MM' 으로 바꾼다(24시간 넘으면 되감는다).
func HHMM(minutes int) string {
	m := ((minutes % 1440) + 1440) % 1440
	return fmt.Sprintf("%02d:%02d", m/60, m%60)
}

func ToMinutes(t string) int {
	h, m, _ := strings.Cut(t, ":")
	hh, _ := strconv.Atoi(h)
	mm, _ := strconv.Atoi(m)
	return hh*60 + mm
}
