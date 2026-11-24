// Package cache 는 외부 API 응답용 TTL 캐시다.
// 같은 키로 동시에 들어온 요청은 한 번만 호출하고, persist 면 저장소(파일 또는 PostgreSQL)에도
// 남겨 서버를 다시 띄워도 외부 API 를 다시 부르지 않는다.
package cache

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// Store 는 persist 항목을 남기는 곳이다. 값은 JSON 이다.
// 캐시는 선택 사항이라 Save 는 실패해도 알리지 않는다.
type Store interface {
	Load(key string) (value []byte, expires time.Time, ok bool)
	Save(key string, value []byte, expires time.Time)
}

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
	store    Store
	mu       sync.Mutex
	items    map[string]entry
	inflight map[string]*call
}

func New(store Store) *Cache {
	return &Cache{store: store, items: map[string]entry{}, inflight: map[string]*call{}}
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
		if v, exp, ok := fromStore[T](c, key); ok && exp.After(now) {
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

	exp := time.Now().Add(ttl)
	c.mu.Lock()
	delete(c.inflight, key)
	if err == nil {
		c.items[key] = entry{value: v, expires: exp}
	}
	c.mu.Unlock()
	close(cl.done)
	// 저장소(DB)에 남기는 동안 다른 키 조회를 막지 않게 잠금 밖에서 쓴다.
	if err == nil && persist {
		toStore(c, key, v, exp)
	}
	return v, err
}

func fromStore[T any](c *Cache, key string) (T, time.Time, bool) {
	var v T
	b, exp, ok := c.store.Load(key)
	if !ok || json.Unmarshal(b, &v) != nil {
		return v, time.Time{}, false
	}
	return v, exp, true
}

func toStore[T any](c *Cache, key string, v T, exp time.Time) {
	if b, err := json.Marshal(v); err == nil {
		c.store.Save(key, b, exp)
	}
}

// Dir 은 dir 아래 키마다 JSON 파일 하나로 남긴다(DATABASE_URL 이 없을 때).
func Dir(dir string) Store { return dirStore(dir) }

type dirStore string

type diskEntry struct {
	Value   json.RawMessage `json:"value"`
	Expires int64           `json:"expires"` // unix ms
}

var unsafeKey = regexp.MustCompile(`[^\w.-]+`)

func (d dirStore) path(key string) string {
	return filepath.Join(string(d), unsafeKey.ReplaceAllString(key, "_")+".json")
}

func (d dirStore) Load(key string) ([]byte, time.Time, bool) {
	var e diskEntry
	b, err := os.ReadFile(d.path(key))
	if err != nil || json.Unmarshal(b, &e) != nil {
		return nil, time.Time{}, false
	}
	return e.Value, time.UnixMilli(e.Expires), true
}

func (d dirStore) Save(key string, value []byte, exp time.Time) {
	b, err := json.Marshal(diskEntry{Value: value, Expires: exp.UnixMilli()})
	if err != nil {
		return
	}
	if os.MkdirAll(string(d), 0o755) == nil {
		_ = os.WriteFile(d.path(key), b, 0o644)
	}
}
