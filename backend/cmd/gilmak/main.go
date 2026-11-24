// 길막닥터 API 서버.
//
//	cd backend && go run ./cmd/gilmak
//
// 기본 주소는 127.0.0.1:8080 이고 PORT 를 주면 :PORT 로 듣는다(클라우드 배포).
// STATIC_DIR 에 빌드된 화면(app/dist)을 주면 화면까지 한 서버로 서빙한다.
// 실시간 수집기를 끄려면 GILMAK_COLLECT=0.
// DATABASE_URL 이 있으면 수집 기록과 API 캐시를 PostgreSQL 에, 없으면 GILMAK_DATA_DIR 아래 파일에 남긴다.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/NerdCat822/kspo_public_contest/backend/internal/api"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/cache"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/collector"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/config"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/sources"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/store"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cacheStore, sink, closeStorage := openStorage(ctx, cfg)
	defer closeStorage()
	src := sources.New(cfg, cacheStore)
	col := collector.New(src, sink)

	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	_ = r.SetTrustedProxies(nil)
	api.New(cfg, src, col).Register(r)
	if cfg.StaticDir != "" {
		serveStatic(r, cfg.StaticDir)
	}

	if cfg.Collect {
		go col.Run(ctx)
	}

	srv := &http.Server{Addr: cfg.Addr, Handler: r, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("길막닥터 API http://%s", displayAddr(cfg.Addr))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdown)
}

// openStorage 는 DATABASE_URL 이 있으면 PostgreSQL 을, 없으면 DataDir 아래 파일을 쓴다.
// DB 주소를 줬는데 붙지 못하면 멈춘다. 파일로 조용히 넘어가면 수집 기록이 두 곳으로 갈라진다.
func openStorage(ctx context.Context, cfg config.Config) (cache.Store, collector.Sink, func()) {
	if cfg.DatabaseURL == "" {
		log.Printf("저장소: 파일 %s (DATABASE_URL 없음)", cfg.DataDir)
		return cache.Dir(filepath.Join(cfg.DataDir, "cache")), collector.Files(filepath.Join(cfg.DataDir, "runtime")), func() {}
	}
	openCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	db, err := store.Open(openCtx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("저장소: PostgreSQL %v", err)
	}
	log.Printf("저장소: PostgreSQL %s (스키마 gilmak)", db.Name())
	return db.Cache(), db.Live(), db.Close
}

// serveStatic 은 빌드된 단일 페이지 앱을 서빙한다. 없는 경로는 index.html 로 돌린다.
func serveStatic(r *gin.Engine, dir string) {
	index := filepath.Join(dir, "index.html")
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(http.StatusNotFound, gin.H{"error": "없는 API 입니다."})
			return
		}
		p := filepath.Join(dir, filepath.Clean("/"+c.Request.URL.Path))
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			c.File(p)
			return
		}
		c.File(index)
	})
}

func displayAddr(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "localhost" + addr
	}
	return addr
}
