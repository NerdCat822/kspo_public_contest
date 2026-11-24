// Package store 는 PostgreSQL 저장소다. 실시간 수집 기록(gilmak.live_snapshot)과
// 외부 API 캐시(gilmak.api_cache)를 남긴다. 표는 Open 이 schema.sql 로 맞춘다.
//
// DATABASE_URL 이 없으면 쓰지 않는다. 그때는 수집 기록과 캐시가 파일로 남는다(collector.Files, cache.Dir).
package store

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/collector"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/kst"
)

//go:embed schema.sql
var schema string

// 질의 하나에 거는 시간. 캐시 읽기는 캐시 잠금을 쥔 채 불리므로 짧게 둔다.
const queryTimeout = 3 * time.Second

type DB struct {
	pool *pgxpool.Pool
	name string
}

// Open 은 DB 에 붙고 표를 맞춘다. DB 가 막 뜨는 중일 수 있어 ctx 가 끝날 때까지 다시 시도한다.
func Open(ctx context.Context, url string) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, errors.New("DATABASE_URL 을 읽지 못했어요")
	}
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	for {
		err = pool.Ping(ctx)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			pool.Close()
			return nil, fmt.Errorf("%s@%s 에 붙지 못했어요: %w", cfg.ConnConfig.Database, cfg.ConnConfig.Host, err)
		case <-time.After(2 * time.Second):
		}
	}
	// 인자가 없으면 단순 질의로 보내져 여러 문장을 한 번에 실행할 수 있다.
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("표 만들기 실패: %w", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM gilmak.api_cache WHERE expires_at < now() - interval '7 days'`); err != nil {
		log.Printf("[store] 만료 캐시 지우기 실패: %v", err)
	}
	return &DB{pool: pool, name: cfg.ConnConfig.Database}, nil
}

func (d *DB) Close() { d.pool.Close() }

// Name 은 붙은 DB 이름이다(로그용, 비밀번호 없음).
func (d *DB) Name() string { return d.name }

// Ping 은 지금 DB 에 붙을 수 있는지 본다(/api/health).
func (d *DB) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

func timeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), queryTimeout)
}

// ── 실시간 수집 기록 ──────────────────────

// Live 는 수집기가 쓰는 저장소다.
func (d *DB) Live() collector.Sink { return live{d.pool} }

type live struct{ pool *pgxpool.Pool }

const stampLayout = "2006-01-02 15:04"

func (l live) Append(r collector.Record) error {
	at, err := time.ParseInLocation(stampLayout, r.At, kst.Zone)
	if err != nil {
		return fmt.Errorf("수집 시각 %q: %w", r.At, err)
	}
	ctx, cancel := timeout()
	defer cancel()
	_, err = l.pool.Exec(ctx, `
		INSERT INTO gilmak.live_snapshot (observed_at, parking, pop_level, pop_min, pop_max, road_level, road_speed)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (observed_at) DO UPDATE SET
			parking = EXCLUDED.parking, pop_level = EXCLUDED.pop_level,
			pop_min = EXCLUDED.pop_min, pop_max = EXCLUDED.pop_max,
			road_level = EXCLUDED.road_level, road_speed = EXCLUDED.road_speed`,
		at, r.Parking, r.PopLevel, r.PopMin, r.PopMax, r.RoadLevel, r.RoadSpeed)
	return err
}

func (l live) Day(date string) ([]collector.Record, error) {
	start, ok := kst.ParseYMD(date)
	if !ok {
		return nil, fmt.Errorf("날짜 형식이 아니에요: %q", date)
	}
	ctx, cancel := timeout()
	defer cancel()
	rows, err := l.pool.Query(ctx, `
		SELECT observed_at, parking, pop_level, pop_min, pop_max, road_level, road_speed
		FROM gilmak.live_snapshot
		WHERE observed_at >= $1 AND observed_at < $2
		ORDER BY observed_at`, start, start.AddDate(0, 0, 1))
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (collector.Record, error) {
		var r collector.Record
		var at time.Time
		err := row.Scan(&at, &r.Parking, &r.PopLevel, &r.PopMin, &r.PopMax, &r.RoadLevel, &r.RoadSpeed)
		r.At = kst.Stamp(at)
		return r, err
	})
}

// ── 외부 API 캐시 ─────────────────────────

// Cache 는 외부 API 캐시가 persist 항목을 남기는 곳이다.
func (d *DB) Cache() cache.Store { return apiCache{d.pool} }

type apiCache struct{ pool *pgxpool.Pool }

func (c apiCache) Load(key string) ([]byte, time.Time, bool) {
	ctx, cancel := timeout()
	defer cancel()
	var value []byte
	var expires time.Time
	err := c.pool.QueryRow(ctx, `SELECT value, expires_at FROM gilmak.api_cache WHERE key = $1`, key).Scan(&value, &expires)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			log.Printf("[store] 캐시 읽기 실패 %s: %v", key, err)
		}
		return nil, time.Time{}, false
	}
	return value, expires, true
}

func (c apiCache) Save(key string, value []byte, expires time.Time) {
	ctx, cancel := timeout()
	defer cancel()
	_, err := c.pool.Exec(ctx, `
		INSERT INTO gilmak.api_cache (key, value, expires_at, saved_at) VALUES ($1, $2, $3, now())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at, saved_at = now()`,
		key, json.RawMessage(value), expires)
	if err != nil {
		log.Printf("[store] 캐시 저장 실패 %s: %v", key, err)
	}
}
