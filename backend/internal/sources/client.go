// Package sources 는 외부 공공 API 연동이다.
// 응답은 cache 로 감싸서 외부 호출량을 줄인다. 로더는 요청 컨텍스트와 분리해,
// 한 사용자가 요청을 끊어도 같은 키를 기다리는 다른 요청까지 실패하지 않게 한다.
package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/config"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/httpx"
)

type Client struct {
	cfg   config.Config
	cache *cache.Cache
	http  *httpx.Client
}

func New(cfg config.Config) *Client {
	return &Client{
		cfg:   cfg,
		cache: cache.New(filepath.Join(cfg.DataDir, "cache")),
		http:  httpx.New(cfg.Secrets()),
	}
}

func bg(timeout time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), timeout)
}

// ── 느슨한 JSON 값 읽기(서울시 도시데이터는 숫자를 문자열로 줄 때가 많다) ──

func str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	default:
		return fmt.Sprint(t)
	}
}

func num(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0
		}
		return f
	}
	return 0
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

// commas 는 1234 → "1,234"
func commas(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	pre := len(s) % 3
	if pre > 0 {
		b.WriteString(s[:pre])
	}
	for i := pre; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}
