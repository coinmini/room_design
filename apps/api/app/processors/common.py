from __future__ import annotations

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
