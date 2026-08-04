from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any


class ProcessorError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        partial_result: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.partial_result = partial_result


MAX_PROVIDER_ERROR_BODY_BYTES = 8 * 1024
_MAX_PROVIDER_ERROR_DETAIL_CHARS = 200


def sanitize_provider_error_detail(raw: bytes, *, secrets: Sequence[str] = ()) -> str:
    """Extract whitelisted fields (code/type/message) from a provider error body.

    Providers sometimes echo sensitive values in error responses, so instead of
    retaining the raw body we keep only the fields needed to distinguish a
    retryable rate limit from a permanent rejection, each truncated; any known
    secret occurring inside those fields is redacted.
    """

    if not raw:
        return ""
    try:
        payload: Any = json.loads(raw[:MAX_PROVIDER_ERROR_BODY_BYTES])
    except (ValueError, UnicodeDecodeError):
        return ""
    if not isinstance(payload, dict):
        return ""
    error = payload.get("error")
    source = error if isinstance(error, dict) else payload
    parts: list[str] = []
    for key in ("code", "type", "message"):
        value = source.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(value.strip()[:_MAX_PROVIDER_ERROR_DETAIL_CHARS])
    detail = " | ".join(parts)[:_MAX_PROVIDER_ERROR_DETAIL_CHARS]
    for secret in secrets:
        if len(secret) >= 8:
            detail = detail.replace(secret, "***")
    return detail
