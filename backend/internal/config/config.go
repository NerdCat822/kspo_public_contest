// Package config 는 저장소 루트와 backend 폴더의 .env 를 읽어 설정을 만든다.
// 이미 설정된 환경변수가 .env 보다 우선한다.
package config

import (
	"bufio"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	KopisKey       string
	SeoulKey       string
	DataGoKrKey    string
	CultureKey     string
	KspoParkingKey string
	// 네이버 클라우드 플랫폼 Maps. Client ID 는 화면의 지도 스크립트에 쓰이는 공개 값이고,
	// Client Secret 은 서버에서 부르는 REST API(Geocoding·Directions 등) 용 비밀 값이다.
	NaverMapClientID     string
	NaverMapClientSecret string
	// AIServiceURL 은 Python AI 서비스(ai/). 예측(/ml/forecast)과 상담(/agent/*)을 맡는다.
	AIServiceURL string
	// DataDir 아래에 cache(외부 API 캐시)와 runtime(실시간 수집 기록)이 쌓인다.
	DataDir string
	// Addr 는 서버가 듣는 주소. PORT 가 있으면 ":PORT"(클라우드 배포용).
	Addr string
	// StaticDir 가 있으면 빌드된 화면(app/dist)도 함께 서빙한다.
	StaticDir string
	Collect   bool
}

// 한국체육산업개발이 공공데이터 개방목록에 공개한 실시간 주차현황 키
const defaultKspoParkingKey = "PARKING21803504"

func Load() Config {
	file := map[string]string{}
	for _, p := range []string{filepath.Join("..", ".env"), ".env"} {
		readDotEnv(p, file)
	}
	get := func(names ...string) string {
		for _, n := range names {
			if v, ok := os.LookupEnv(n); ok && v != "" {
				return v
			}
			if v := file[n]; v != "" {
				return v
			}
		}
		return ""
	}

	addr := get("ADDR")
	if port := get("PORT"); addr == "" && port != "" {
		addr = ":" + port
	}
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	dataDir := get("GILMAK_DATA_DIR")
	if dataDir == "" {
		dataDir = "data"
	}
	parkingKey := get("KSPO_PARKING_KEY")
	if parkingKey == "" {
		parkingKey = defaultKspoParkingKey
	}
	aiURL := strings.TrimRight(get("AI_SERVICE_URL"), "/")
	if aiURL == "" {
		aiURL = "http://127.0.0.1:8090"
	}

	return Config{
		KopisKey:             get("KOPIS_API_KEY"),
		SeoulKey:             get("SEOUL_API_KEY", "SEOUL_OPENDATA_API_KEY"),
		DataGoKrKey:          get("DATA_GO_KR_KEY", "PUBLIC_DATA_API_KEY"),
		CultureKey:           get("CULTURE_API_KEY"),
		KspoParkingKey:       parkingKey,
		NaverMapClientID:     get("NAVER_CLOUD_PLATFORM_CLIENT_ID"),
		NaverMapClientSecret: get("NAVER_CLOUD_PLATFORM_CLIENT_SECRET"),
		AIServiceURL:         aiURL,
		DataDir:              dataDir,
		Addr:                 addr,
		StaticDir:            get("STATIC_DIR"),
		Collect:              get("GILMAK_COLLECT") != "0",
	}
}

func readDotEnv(path string, into map[string]string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		into[strings.TrimSpace(k)] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
}

// Secrets 는 오류 메시지에서 가려야 할 값들이다.
func (c Config) Secrets() []string {
	return []string{c.KopisKey, c.SeoulKey, c.DataGoKrKey, c.CultureKey, c.NaverMapClientSecret}
}

// QueryKey 는 data.go.kr 키를 쿼리에 넣을 형태로 만든다.
// 포털은 인코딩된 키(%포함)와 디코딩된 키를 둘 다 발급하므로 이미 인코딩된 키는 그대로 쓴다.
func QueryKey(key string) string {
	if strings.Contains(key, "%") {
		return key
	}
	return url.QueryEscape(key)
}
