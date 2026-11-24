# syntax=docker/dockerfile:1
# 길막닥터 앱 이미지: Go API 서버 + 빌드한 React 화면을 한 컨테이너로. AI 서비스(예측·상담)는 ai/Dockerfile.
#
#   docker compose up -d --build      (docker-compose.yml 참고)
#
# 키(.env)는 이미지에 넣지 않는다(.dockerignore). 실행할 때 env_file 로 넘긴다.

# ---------------------------------------------------------------- 1) 화면 빌드 (Node 는 여기서만 쓴다)
FROM node:22-slim AS web
WORKDIR /web
COPY app/package.json app/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY app/ ./
# 파일·API 모두 상대 경로(./assets, api/...)라 / 에도 하위 경로(/gilmak-doctor/)에도 그대로 올릴 수 있다.
# 네이버 지도 Client ID 는 넣지 않는다: 화면이 실행 중에 /api/config 로 받는다.
RUN npm run build

# ---------------------------------------------------------------- 2) API 서버 빌드
FROM golang:1.25-alpine AS api
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN go build -trimpath -ldflags="-s -w" -o /out/gilmak ./cmd/gilmak

# ---------------------------------------------------------------- 3) 실행 이미지
FROM alpine:3.22
# 공공 API 는 모두 https 라 인증서 묶음이 필요하다. 로그 시각을 한국 시간으로 보려고 tzdata 도 넣는다.
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -H -u 10001 gilmak \
    && mkdir -p /app/data && chown gilmak:gilmak /app/data
WORKDIR /app
COPY --from=api /out/gilmak /app/gilmak
COPY --from=web /web/dist /app/web
# DATABASE_URL 이 있으면 수집 기록·캐시는 PostgreSQL 로 간다. GILMAK_DATA_DIR 는 DB 가 없을 때만 쓴다.
ENV PORT=8080 \
    GIN_MODE=release \
    STATIC_DIR=/app/web \
    GILMAK_DATA_DIR=/app/data \
    TZ=Asia/Seoul
USER gilmak
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget -qO /dev/null http://127.0.0.1:8080/api/health || exit 1
CMD ["/app/gilmak"]
