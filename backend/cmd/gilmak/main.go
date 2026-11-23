// 길막닥터 API 서버.
//
//	cd backend && go run ./cmd/gilmak
//
// 기본 주소는 127.0.0.1:8080 이고 PORT 를 주면 :PORT 로 듣는다(클라우드 배포).
// STATIC_DIR 에 빌드된 화면(app/dist)을 주면 화면까지 한 서버로 서빙한다.
// 실시간 수집기를 끄려면 GILMAK_COLLECT=0.
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
	"github.com/NerdCat822/kspo_public_contest/backend/internal/collector"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/config"
	"github.com/NerdCat822/kspo_public_contest/backend/internal/sources"
)

func main() {
	cfg := config.Load()
	src := sources.New(cfg)
	col := collector.New(src, cfg.DataDir)

	r := gin.New()
	r.Use(gin.Logger(), gin.Recovery())
	_ = r.SetTrustedProxies(nil)
	api.New(cfg, src, col).Register(r)
	if cfg.StaticDir != "" {
		serveStatic(r, cfg.StaticDir)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
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
