from __future__ import annotations

from dataclasses import dataclass

from base_station.models import utc_now_iso

# Heartbeat framing (control plane) for the LoRa serial stream.
#
# We multiplex these small frames alongside RTCM correction bytes on the same
# UART. Frames are delimited by STX/ETX to make them easy to detect and strip
# on the rover side without requiring line-based parsing.
HB_PREFIX = b"\x02RTKHB,"
HB_SUFFIX = b"\x03"


def _clean_field(value: str) -> str:
    # Avoid commas and control chars which would complicate parsing.
    safe = "".join(ch for ch in (value or "").strip() if 32 <= ord(ch) <= 126)
    safe = safe.replace(",", "_")
    return safe[:40] if safe else "BASE"


@dataclass(frozen=True, slots=True)
class HeartbeatFrame:
    station_id: str
    timestamp_utc: str
    seq: int

    def encode(self) -> bytes:
        body = f"{_clean_field(self.station_id)},{_clean_field(self.timestamp_utc)},{int(self.seq)}"
        return HB_PREFIX + body.encode("ascii", errors="ignore") + HB_SUFFIX


def build_heartbeat_frame(station_id: str, seq: int) -> bytes:
    return HeartbeatFrame(station_id=station_id, timestamp_utc=utc_now_iso(), seq=seq).encode()

