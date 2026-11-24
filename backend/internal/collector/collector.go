// Package collector 는 실시간 값을 5분마다 쌓는다. 기관 API 는 이력을 주지 않아서,
// 예측과 실측을 비교하려면 직접 모아야 한다.
//
// 쌓는 곳은 Sink 로 고른다. 운영은 PostgreSQL(store.DB.Live, 표 gilmak.live_snapshot),
// DATABASE_URL 이 없으면 data/runtime/live-YYYY-MM-DD.jsonl 파일(Files).
package collector

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/sources"
)

const interval = 5 * time.Minute

// Record 는 한 번 모은 값이다. At 은 한국 시각 'YYYY-MM-DD HH:MM'.
type Record struct {
	At        string   `json:"at"`
	Parking   *int     `json:"parking"`
	PopLevel  *string  `json:"popLevel"`
	PopMin    *int     `json:"popMin"`
	PopMax    *int     `json:"popMax"`
	RoadLevel *string  `json:"roadLevel"`
	RoadSpeed *float64 `json:"roadSpeed"`
}

// Sink 는 모은 값을 남기고 날짜별로 돌려준다.
type Sink interface {
	Append(r Record) error
	// Day 는 그날(YYYY-MM-DD) 기록을 시각 순서로 돌려준다.
	Day(date string) ([]Record, error)
}

type Collector struct {
	src  *sources.Client
	sink Sink
}

func New(src *sources.Client, sink Sink) *Collector {
	return &Collector{src: src, sink: sink}
}

// Once 는 지금 값을 한 번 기록한다.
func (c *Collector) Once() (Record, error) {
	rec := Record{At: kst.Stamp(kst.Now())}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if p, err := c.src.ParkingSum(); err == nil {
			rec.Parking = &p.Sum
		}
	}()
	var city sources.CityData
	var cityErr error
	go func() {
		defer wg.Done()
		city, cityErr = c.src.CityData()
	}()
	wg.Wait()
	if cityErr == nil {
		if p := city.Population; p != nil {
			rec.PopLevel, rec.PopMin, rec.PopMax = &p.Level, &p.Min, &p.Max
		}
		if r := city.Road; r != nil {
			rec.RoadLevel, rec.RoadSpeed = &r.Level, &r.Speed
		}
	}

	return rec, c.sink.Append(rec)
}

// Day 는 그날 모은 기록이다. 읽지 못하면 비워 둔다(화면은 오늘 추이만 빠진다).
func (c *Collector) Day(date string) []Record {
	out, err := c.sink.Day(date)
	if err != nil {
		log.Printf("[collector] %s 기록 읽기 실패: %v", date, err)
		return nil
	}
	return out
}

// ParkingAt 은 하루치 기록에서 minute(자정부터 몇 분)에 가장 가까운 주차대수를 돌려준다.
// tol 분 안에 기록이 없으면 false. "평소 이 시각" 을 낼 때 쓴다.
func ParkingAt(recs []Record, minute, tol int) (int, bool) {
	best, bestGap := 0, tol+1
	for _, r := range recs {
		if r.Parking == nil || len(r.At) < 16 {
			continue
		}
		gap := kst.ToMinutes(r.At[11:16]) - minute
		if gap < 0 {
			gap = -gap
		}
		if gap < bestGap {
			best, bestGap = *r.Parking, gap
		}
	}
	return best, bestGap <= tol
}

// Run 은 ctx 가 끝날 때까지 5분마다 기록한다(시작하자마자 한 번).
func (c *Collector) Run(ctx context.Context) {
	tick := func() {
		r, err := c.Once()
		if err != nil {
			log.Printf("[collector] 실패: %v", err)
			return
		}
		log.Printf("[collector] %s 주차 %s대 · 인구 %s · 도로 %s", r.At, intOr(r.Parking), strOr(r.PopLevel), strOr(r.RoadLevel))
	}
	tick()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			tick()
		}
	}
}

func intOr(p *int) string {
	if p == nil {
		return "-"
	}
	return strconv.Itoa(*p)
}

func strOr(p *string) string {
	if p == nil || *p == "" {
		return "-"
	}
	return *p
}

// Files 는 dir/live-YYYY-MM-DD.jsonl 에 하루 파일 하나씩 쌓는다.
func Files(dir string) Sink { return &files{dir: dir} }

type files struct {
	dir string
	mu  sync.Mutex
}

func (f *files) path(date string) string {
	return filepath.Join(f.dir, "live-"+date+".jsonl")
}

func (f *files) Append(r Record) error {
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := os.MkdirAll(f.dir, 0o755); err != nil {
		return err
	}
	date, _, _ := strings.Cut(r.At, " ")
	fh, err := os.OpenFile(f.path(date), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer fh.Close()
	_, err = fh.Write(append(line, '\n'))
	return err
}

func (f *files) Day(date string) ([]Record, error) {
	fh, err := os.Open(f.path(date))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer fh.Close()
	var out []Record
	s := bufio.NewScanner(fh)
	for s.Scan() {
		var r Record
		if json.Unmarshal(s.Bytes(), &r) == nil {
			out = append(out, r)
		}
	}
	return out, s.Err()
}
