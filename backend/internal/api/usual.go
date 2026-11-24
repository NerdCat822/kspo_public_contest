package api

import (
	"math"
	"sync"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/collector"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

// "평소 이 시각" 주차대수. 기관 API 는 이력을 주지 않아서 수집기가 모은 기록으로 낸다.
// 대형 공연이 없던 날 가운데 오늘과 같은 유형(평일끼리, 주말·공휴일끼리)만 골라 같은 시각 값을 평균한다.
const (
	usualLookbackDays = 28              // KOPIS 목록 조회가 31일까지라 그 안에서
	usualMinDays      = 2               // 이보다 적으면 "평소"라고 하지 않는다
	usualTolMinutes   = 10              // 5분마다 모으므로 ±10분 안의 기록을 같은 시각으로 본다
	usualTTL          = 5 * time.Minute // 다시 계산하는 주기
)

type usualCache struct {
	mu      sync.Mutex
	at      time.Time
	value   *types.ParkingUsual
	running bool
}

// usualParking 은 마지막으로 계산한 값을 바로 돌려주고, 오래됐으면 뒤에서 다시 계산한다.
// 지난 공연 목록(KOPIS)을 읽느라 실시간 응답이 늦어지지 않게 하려는 것이다.
// 서버가 뜬 직후나 한동안 요청이 없던 뒤의 첫 응답에는 없을 수 있다(화면은 1분마다 다시 받는다).
func (s *Server) usualParking() *types.ParkingUsual {
	u := &s.usual
	u.mu.Lock()
	defer u.mu.Unlock()
	age := time.Since(u.at)
	if !u.running && age > usualTTL {
		u.running = true
		go func() {
			v := s.computeUsual(kst.Now())
			u.mu.Lock()
			u.value, u.at, u.running = v, time.Now(), false
			u.mu.Unlock()
		}()
	}
	if age > 3*usualTTL { // 다른 시각을 기준으로 낸 값은 쓰지 않는다
		return nil
	}
	return u.value
}

func (s *Server) computeUsual(now time.Time) *types.ParkingUsual {
	today := now.Format("2006-01-02")
	from, to := kst.AddDays(today, -usualLookbackDays), kst.AddDays(today, -1)
	holidays := s.src.Holidays(from, today)
	shows, err := s.src.ShowsByDate(from, to, holidays)
	if err != nil {
		return nil // 공연이 있던 날을 가려낼 수 없으면 "평소"라고 하지 않는다
	}
	kind := usualKind(dayTypeOf(today, holidays))
	var days [][]collector.Record
	for d := to; d >= from; d = kst.AddDays(d, -1) {
		if usualKind(dayTypeOf(d, holidays)) != kind || hasMajor(shows[d]) {
			continue
		}
		if recs := s.collector.Day(d); len(recs) > 0 {
			days = append(days, recs)
		}
	}
	return usualFrom(days, now.Hour()*60+now.Minute(), kind)
}

// usualFrom 은 날짜별 기록에서 minute(자정부터 몇 분)에 가장 가까운 주차대수를 하나씩 골라 평균한다.
func usualFrom(days [][]collector.Record, minute int, kind types.DayType) *types.ParkingUsual {
	sum, n := 0, 0
	for _, recs := range days {
		if v, ok := collector.ParkingAt(recs, minute, usualTolMinutes); ok {
			sum += v
			n++
		}
	}
	if n < usualMinDays {
		return nil
	}
	return &types.ParkingUsual{Sum: int(math.Round(float64(sum) / float64(n))), Days: n, DayType: kind}
}

// usualKind 는 공휴일을 주말로 묶는다(예측 모델과 같은 기준).
func usualKind(t types.DayType) types.DayType {
	if t == types.Weekday {
		return types.Weekday
	}
	return types.Weekend
}

func hasMajor(shows []types.Show) bool {
	for _, s := range shows {
		if s.Major {
			return true
		}
	}
	return false
}
