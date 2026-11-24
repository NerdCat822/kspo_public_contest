// Package model 은 예측 모델이다(analysis/build_model_v1.py 가 만든 baseline.json 을 실행 파일에 넣어 쓴다).
// Python AI 서비스가 꺼졌을 때 같은 계산을 대신한다(ai/models/baseline-v1.json 과 같은 파일).
//
//	수요(t) = 요일 유형별 기준선(t) + Σ 공연별 (좌석/1000) × 공연 영향 곡선(t - 시작)
//
// 단계는 학습 기간 08~23시 구간 분포의 50/80/95 분위로 나눈다.
// 단위는 동2·남2·북2문 동시 주차대수이며, 화면에는 상대값과 단계만 보여 준다.
package model

import (
	_ "embed"
	"encoding/json"
	"math"
	"sort"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/types"
)

//go:embed baseline.json
var baselineJSON []byte

type baselineFile struct {
	Meta struct {
		Version     string   `json:"version"`
		Period      string   `json:"period"`
		FitMaeCars  *float64 `json:"fitMaeCars"`
		TestMaeCars *float64 `json:"testMaeCars"`
		TestLabel   *string  `json:"testLabel"`
		Note        string   `json:"note"`
	} `json:"meta"`
	BinMinutes int `json:"binMinutes"`
	Baseline   struct {
		Weekday []float64 `json:"weekday"`
		Weekend []float64 `json:"weekend"`
	} `json:"baseline"`
	Kernel struct {
		Offset int       `json:"offsetFromStartMinutes"`
		Values []float64 `json:"values"`
	} `json:"eventKernelPer1000Seats"`
	Thresholds struct {
		P50 float64 `json:"p50"`
		P80 float64 `json:"p80"`
		P95 float64 `json:"p95"`
	} `json:"thresholds"`
	ExitSurge struct {
		Median    *int              `json:"medianMinutesTo80pct"`
		ShowsUsed *int              `json:"showsUsed"`
		Shows     []json.RawMessage `json:"shows"`
	} `json:"exitSurge"`
}

var b = func() baselineFile {
	var f baselineFile
	if err := json.Unmarshal(baselineJSON, &f); err != nil {
		panic("baseline.json 을 읽지 못함: " + err.Error())
	}
	return f
}()

// 화면에 보여 주는 시간대(06:00~24:00)
const viewFrom, viewTo = 6 * 60, 24 * 60

func bins() int { return 24 * 60 / b.BinMinutes }

func Thresholds() types.Thresholds {
	return types.Thresholds{Normal: b.Thresholds.P50 / b.Thresholds.P95, Busy: b.Thresholds.P80 / b.Thresholds.P95, Jam: 1}
}

func ExitMinutes() int {
	if b.ExitSurge.Median != nil {
		return *b.ExitSurge.Median
	}
	return 70
}

func Meta() types.ModelMeta {
	shows := len(b.ExitSurge.Shows)
	if b.ExitSurge.ShowsUsed != nil {
		shows = *b.ExitSurge.ShowsUsed
	}
	return types.ModelMeta{
		Version:     b.Meta.Version,
		Period:      b.Meta.Period,
		FitMaeCars:  b.Meta.FitMaeCars,
		TestMaeCars: b.Meta.TestMaeCars,
		TestLabel:   b.Meta.TestLabel,
		ExitMinutes: ExitMinutes(),
		ExitShows:   shows,
		Note:        b.Meta.Note,
		Source:      "embedded",
	}
}

func levelOf(cars float64) types.Level {
	switch {
	case cars >= b.Thresholds.P95:
		return types.Jam
	case cars >= b.Thresholds.P80:
		return types.Busy
	case cars >= b.Thresholds.P50:
		return types.Normal
	}
	return types.Calm
}

func round(v float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.Round(v*p) / p
}

type DayForecast struct {
	Bins []types.ForecastBin
	Peak types.Peak
}

// ForecastDay 는 날짜 유형과 그날 공연으로 06~24시 30분 단위 수요를 계산한다.
func ForecastDay(dayType types.DayType, shows []types.Show) DayForecast {
	base := b.Baseline.Weekend
	if dayType == types.Weekday {
		base = b.Baseline.Weekday
	}
	n := bins()
	effect := make([]float64, n)
	for _, s := range shows {
		if !s.Major {
			continue
		}
		sb := kst.ToMinutes(s.Start) / b.BinMinutes
		for i, k := range b.Kernel.Values {
			bin := sb + b.Kernel.Offset/b.BinMinutes + i
			if bin >= 0 && bin < n {
				effect[bin] += k * float64(s.Seats) / 1000
			}
		}
	}

	out := []types.ForecastBin{}
	for bin := viewFrom / b.BinMinutes; bin < viewTo/b.BinMinutes; bin++ {
		cars := base[bin] + effect[bin]
		share := 0.0
		if cars > 0 {
			share = round(effect[bin]/cars, 2)
		}
		out = append(out, types.ForecastBin{
			T: kst.HHMM(bin * b.BinMinutes), Level: levelOf(cars), Ratio: round(cars/b.Thresholds.P95, 3), EventShare: share,
		})
	}
	peak := out[0]
	for _, x := range out[1:] {
		if x.Ratio > peak.Ratio {
			peak = x
		}
	}
	return DayForecast{Bins: out, Peak: types.Peak{T: peak.T, Level: peak.Level}}
}

func roundDown15(min int) int { return int(math.Floor(float64(min)/15)) * 15 }

// ConcertAdvice 는 공연 관람객 처방이다: 언제까지 도착하면 수월한지, 끝나고 언제 출차가 몰리는지.
// exitMinutes 는 공연 종료 후 출차의 80%가 빠지는 데 걸리는 시간(모델 메타의 exitMinutes).
//
// 공연 3시간 전 ~ 30분 전에 붐비는 구간이 있으면, 그 붐빔이 실제로 시작된 시각(이어진 구간의 처음)을
// BusyFrom 으로 삼는다. 3시간 전보다 먼저 시작됐으면 거기까지 거슬러 올라간다. 그래야 진단의
// "붐비기 시작" 시각과 같고, 권장 도착 시각이 이미 붐비는 시간에 잡히지 않는다.
func ConcertAdvice(show types.Show, bins []types.ForecastBin, exitMinutes int) types.ConcertAdvice {
	start := kst.ToMinutes(show.Start)
	busy := func(i int) bool { return bins[i].Level.Rank() >= types.Busy.Rank() }
	windowStart, first := -1, -1
	for i, x := range bins {
		t := kst.ToMinutes(x.T)
		if t < start-180 || t >= start-30 {
			continue
		}
		if windowStart < 0 {
			windowStart = i
		}
		if busy(i) {
			first = i
			break
		}
	}
	// 공연 3시간 전에 이미 붐비면 차로 일찍 오는 것보다 대중교통이 현실적이다.
	transitFirst := first >= 0 && first == windowStart
	arriveBy := kst.HHMM(roundDown15(start - 45))
	var busyFrom *string
	if first >= 0 {
		for first > 0 && busy(first-1) {
			first--
		}
		arriveBy = kst.HHMM(roundDown15(kst.ToMinutes(bins[first].T) - 15))
		busyFrom = types.Ptr(bins[first].T)
	}
	end := kst.ToMinutes(show.End)
	return types.ConcertAdvice{
		ShowID: show.ID, ArriveBy: arriveBy, BusyFrom: busyFrom, Start: show.Start, End: show.End,
		ExitRush:     types.Window{From: kst.HHMM(end), To: kst.HHMM(end + exitMinutes)},
		TransitFirst: transitFirst,
	}
}

type run struct {
	from, to int
	items    []types.ForecastBin
}

func (r run) quiet() bool { return r.items[0].Level.Rank() <= types.Normal.Rank() }

func (r run) mean(f func(types.ForecastBin) float64) float64 {
	s := 0.0
	for _, x := range r.items {
		s += f(x)
	}
	return s / float64(len(r.items))
}

// ParkAdvice 는 공원 방문객 처방이다: 08~20시 중 덜 붐비는 시간대와 피할 시간대.
func ParkAdvice(bins []types.ForecastBin) types.ParkAdvice {
	var runs []run
	for _, x := range bins {
		t := kst.ToMinutes(x.T)
		if t < 8*60 || t >= 20*60 {
			continue
		}
		quiet := x.Level.Rank() <= types.Normal.Rank()
		if n := len(runs); n > 0 && runs[n-1].to == t && runs[n-1].quiet() == quiet {
			runs[n-1].to = t + b.BinMinutes
			runs[n-1].items = append(runs[n-1].items, x)
		} else {
			runs = append(runs, run{from: t, to: t + b.BinMinutes, items: []types.ForecastBin{x}})
		}
	}
	ratio := func(x types.ForecastBin) float64 { return x.Ratio }
	share := func(x types.ForecastBin) float64 { return x.EventShare }

	var best []run
	for _, r := range runs {
		if r.quiet() && len(r.items) >= 2 {
			best = append(best, r)
		}
	}
	sort.SliceStable(best, func(i, j int) bool {
		mi, mj := best[i].mean(ratio), best[j].mean(ratio)
		if mi != mj {
			return mi < mj
		}
		return len(best[i].items) > len(best[j].items)
	})
	if len(best) > 2 {
		best = best[:2]
	}
	sort.SliceStable(best, func(i, j int) bool { return best[i].from < best[j].from })

	out := types.ParkAdvice{Best: []types.Window{}, Avoid: []types.AvoidWindow{}}
	for _, r := range best {
		out.Best = append(out.Best, types.Window{From: kst.HHMM(r.from), To: kst.HHMM(r.to)})
	}
	for _, r := range runs {
		if r.quiet() {
			continue
		}
		reason := "usual"
		if r.mean(share) > 0.25 {
			reason = "event"
		}
		out.Avoid = append(out.Avoid, types.AvoidWindow{From: kst.HHMM(r.from), To: kst.HHMM(r.to), Reason: reason})
	}
	return out
}
