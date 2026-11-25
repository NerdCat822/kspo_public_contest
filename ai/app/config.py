"""설정. 저장소 루트와 ai 폴더의 .env 를 읽고, 이미 설정된 환경변수를 우선한다."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

AI_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = AI_DIR.parent


def _read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip("'\"")
    return out


_FILE_ENV = {**_read_dotenv(ROOT_DIR / ".env"), **_read_dotenv(AI_DIR / ".env")}


def _get(name: str, default: str = "") -> str:
    value = os.environ.get(name) or _FILE_ENV.get(name)
    return value if value else default


# 서버 측 refusal fallback("fallbacks": "default")을 받는 모델
FALLBACK_MODELS = {"claude-fable-5-2", "claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str
    llm_model: str
    llm_effort: str
    gilmak_api_url: str
    model_path: Path

    @property
    def agent_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


def load_settings() -> Settings:
    return Settings(
        anthropic_api_key=_get("ANTHROPIC_API_KEY"),
        llm_model=_get("LLM_MODEL", "claude-sonnet-5-5"),
        llm_effort=_get("LLM_EFFORT", "medium"),
        gilmak_api_url=_get("GILMAK_API_URL", "http://127.0.0.1:8080").rstrip("/"),
        model_path=Path(_get("ML_MODEL_PATH", str(AI_DIR / "models" / "baseline-v1.json"))),
    )


settings = load_settings()
