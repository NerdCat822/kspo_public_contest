"""Go 백엔드(/api) 호출. 에이전트 도구가 쓰는 데이터는 모두 여기서 온다."""

from __future__ import annotations

from typing import Any

import httpx2

from ..config import settings

_client = httpx2.Client(base_url=settings.gilmak_api_url, timeout=30.0, headers={"User-Agent": "gilmak-ai/0.1"})


def get(path: str, **params: Any) -> dict[str, Any]:
    res = _client.get(path, params={k: v for k, v in params.items() if v is not None})
    res.raise_for_status()
    return res.json()
