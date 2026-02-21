from __future__ import annotations

from dataclasses import dataclass

MAGIC = b"RTK"
VERSION = 1

TYPE_HEARTBEAT = 1
TYPE_CORRECTIONS = 2

HEADER_LEN = 8


@dataclass(slots=True)
class ParsedPacket:
    packet_type: int
    network_id: int
    seq: int
    payload: bytes


def build_packet(packet_type: int, *, network_id: int, seq: int, payload: bytes) -> bytes:
    if not (0 <= network_id <= 255):
        raise ValueError("network_id must be 0..255")
    seq &= 0xFFFF
    return MAGIC + bytes([VERSION, network_id, packet_type]) + seq.to_bytes(2, "big") + payload


def parse_packet(raw: bytes) -> ParsedPacket | None:
    if len(raw) < HEADER_LEN:
        return None
    if raw[:3] != MAGIC:
        return None
    version = raw[3]
    if version != VERSION:
        return None
    network_id = raw[4]
    packet_type = raw[5]
    seq = int.from_bytes(raw[6:8], "big")
    payload = raw[8:]
    return ParsedPacket(packet_type=packet_type, network_id=network_id, seq=seq, payload=payload)


def encode_station_id(station_id: str, *, max_len: int = 32) -> bytes:
    cleaned = (station_id or "").encode("ascii", errors="ignore").strip()
    return cleaned[:max_len]


def decode_station_id(payload: bytes) -> str:
    return payload.decode("ascii", errors="ignore").strip() or "unknown"

