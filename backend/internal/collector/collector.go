// Package collector 는 실시간 값을 5분마다 data/runtime/live-YYYY-MM-DD.jsonl 에 쌓는다.
// 기관 API 는 이력을 주지 않아서, 예측과 실측을 비교하려면 직접 모아야 한다.
package collector

import (
	"bufio"
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/sources"
)

const interval = 5 * time.Minute

type Record struct {
	At        string   `json:"at"`
	Parking   *int     `json:"parking"`
	PopLevel  *string  `json:"popLevel"`
	PopMin    *int     `json:"popMin"`
	PopMax    *int     `json:"popMax"`
	RoadLevel *string  `json:"roadLevel"`
	RoadSpeed *float64 `json:"roadSpeed"`
}

type Collector struct {
	src *sources.Client
	dir string
	mu  sync.Mutex
}

func New(src *sources.Client, dataDir string) *Collector {
	return &Collector{src: src, dir: filepath.Join(dataDir, "runtime")}
}

func (c *Collector) file(date string) string {
	return filepath.Join(c.dir, "live-"+date+".jsonl")
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

	line, err := json.Marshal(rec)
	if err != nil {
		return rec, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := os.MkdirAll(c.dir, 0o755); err != nil {
		return rec, err
	}
	f, err := os.OpenFile(c.file(kst.Today()), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return rec, err
	}
	defer f.Close()
	_, err = f.Write(append(line, '\n'))
	return rec, err
}

// Day 는 그날 모은 기록이다.
func (c *Collector) Day(date string) []Record {
	f, err := os.Open(c.file(date))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Record
	s := bufio.NewScanner(f)
	for s.Scan() {
		var r Record
		if json.Unmarshal(s.Bytes(), &r) == nil {
			out = append(out, r)
		}
	}
	return out
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
