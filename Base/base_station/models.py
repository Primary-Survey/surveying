from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


@dataclass(slots=True)
class BaseState:
    device_id: str
    lora_connected: bool = False
    corrections_connected: bool = False
    lora_bytes_tx: int = 0
    last_tx_utc: str | None = None
    warnings: list[str] = field(default_factory=list)
    last_error: str | None = None

