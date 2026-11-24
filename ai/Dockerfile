# syntax=docker/dockerfile:1
# 길막닥터 AI 서비스 이미지: 예측 모델 v0(/ml/forecast)과 상담 에이전트(/agent/*). 앱 이미지는 루트 Dockerfile.
#
#   docker compose up -d --build      (저장소 루트 docker-compose.yml 참고)
#
# 키(.env)는 이미지에 넣지 않는다(.dockerignore). 실행할 때 env_file 로 넘긴다.
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    TZ=Asia/Seoul

RUN pip install uv==0.13.9

WORKDIR /app
# 의존성은 잠금 파일(uv.lock) 그대로 설치한다. 소스보다 먼저 복사해 의존성 층을 캐시한다
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app/ ./app/
COPY models/ ./models/

RUN useradd --no-create-home --uid 10001 gilmak
USER gilmak
ENV PATH=/opt/venv/bin:$PATH
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/health', timeout=4)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090"]
