// Package cache 는 외부 API 응답용 TTL 캐시다.
// 같은 키로 동시에 들어온 요청은 한 번만 호출하고, persist 면 디스크에도 저장해
// 서버를 다시 띄워도 외부 API 를 다시 부르지 않는다.
package cache

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

type entry struct {
	value   any
	expires time.Time
}

type call struct {
	done  chan struct{}
	value any
	err   error
}

type Cache struct {
	dir      string
	mu       sync.Mutex
	items    map[string]entry
	inflight map[string]*call
}

func New(dir string) *Cache {
	return &Cache{dir: dir, items: map[string]entry{}, inflight: map[string]*call{}}
}

type diskEntry[T any] struct {
	Value   T     `json:"value"`
	Expires int64 `json:"expires"` // unix ms
}

var unsafeKey = regexp.MustCompile(`[^\w.-]+`)

func (c *Cache) path(key string) string {
	return filepath.Join(c.dir, unsafeKey.ReplaceAllString(key, "_")+".json")
}

// Get 은 key 의 값을 돌려준다. 없거나 만료됐으면 load 로 채운다.
func Get[T any](c *Cache, key string, ttl time.Duration, persist bool, load func() (T, error)) (T, error) {
	now := time.Now()
	c.mu.Lock()
	if e, ok := c.items[key]; ok && e.expires.After(now) {
		c.mu.Unlock()
		return e.value.(T), nil
	}
	if persist {
		if v, exp, ok := readDisk[T](c, key); ok && exp.After(now) {
			c.items[key] = entry{value: v, expires: exp}
			c.mu.Unlock()
			return v, nil
		}
	}
	if running, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		<-running.done
		if running.err != nil {
			var zero T
			return zero, running.err
		}
		return running.value.(T), nil
	}
	cl := &call{done: make(chan struct{})}
	c.inflight[key] = cl
	c.mu.Unlock()

	v, err := load()
	cl.value, cl.err = v, err

	c.mu.Lock()
	delete(c.inflight, key)
	if err == nil {
		exp := time.Now().Add(ttl)
		c.items[key] = entry{value: v, expires: exp}
		if persist {
			writeDisk(c, key, v, exp)
		}
	}
	c.mu.Unlock()
	close(cl.done)
	return v, err
}

func readDisk[T any](c *Cache, key string) (T, time.Time, bool) {
	var d diskEntry[T]
	b, err := os.ReadFile(c.path(key))
	if err != nil || json.Unmarshal(b, &d) != nil {
		return d.Value, time.Time{}, false
	}
	return d.Value, time.UnixMilli(d.Expires), true
}

// 디스크 캐시는 선택 사항이라 실패해도 무시한다.
func writeDisk[T any](c *Cache, key string, v T, exp time.Time) {
	b, err := json.Marshal(diskEntry[T]{Value: v, Expires: exp.UnixMilli()})
	if err != nil {
		return
	}
	if os.MkdirAll(c.dir, 0o755) == nil {
		_ = os.WriteFile(c.path(key), b, 0o644)
	}
}
