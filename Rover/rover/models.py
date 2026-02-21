from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Literal

FixQuality = Literal[
    "no-fix",
    "gps",
    "dgps",
    "rtk-float",
    "rtk-fixed",
    "dead-reckoning",
    "unknown",
]


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


@dataclass(slots=True)
class RoverFix:
    timestamp_utc: str
    lat: float
    lng: float
    quality: FixQuality = "unknown"
    alt_m: float | None = None
    accuracy_m: float | None = None
    hdop: float | None = None
    satellites: int | None = None
    correction_age_s: float | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "timestamp_utc": self.timestamp_utc,
            "lat": self.lat,
            "lng": self.lng,
            "quality": self.quality,
            "alt_m": self.alt_m,
            "accuracy_m": self.accuracy_m,
            "hdop": self.hdop,
            "satellites": self.satellites,
            "correction_age_s": self.correction_age_s,
        }


@dataclass(slots=True)
class RoverState:
    device_id: str
    gnss_connected: bool = False
    lora_connected: bool = False
    bluetooth_connected: bool = False
    bluetooth_client: str | None = None
    lora_bytes_rx: int = 0
    last_correction_utc: str | None = None
    fix: RoverFix | None = None
    warnings: list[str] = field(default_factory=list)
    last_error: str | None = None

    def to_payload(self) -> dict[str, object]:
        return {
            "rover": {
                "device_id": self.device_id,
                "gnss_connected": self.gnss_connected,
                "lora_connected": self.lora_connected,
                "bluetooth_connected": self.bluetooth_connected,
                "bluetooth_client": self.bluetooth_client,
                "lora_bytes_rx": self.lora_bytes_rx,
                "last_correction_utc": self.last_correction_utc,
            },
            "fix": self.fix.to_dict() if self.fix else None,
            "warnings": list(self.warnings),
            "error": self.last_error,
        }

