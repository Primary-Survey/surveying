from __future__ import annotations

import json
from typing import Any

from rover.models import RoverState, utc_now_iso

TELEMETRY_TYPE = "rover.telemetry.v1"


def build_telemetry_message(state: RoverState) -> dict[str, Any]:
    payload = state.to_payload()
    payload["type"] = TELEMETRY_TYPE
    payload["timestamp_utc"] = utc_now_iso()
    return payload


def encode_message_line(payload: dict[str, Any]) -> str:
    return json.dumps(payload, separators=(",", ":")) + "\n"


def decode_message_line(line: str) -> dict[str, Any] | None:
    raw = line.strip()
    if not raw:
        return None
    try:
        parsed: Any = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed

