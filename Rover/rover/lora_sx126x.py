from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Callable

from rover.config import LoRaConfig
from rover.lora_packets import TYPE_CORRECTIONS, TYPE_HEARTBEAT, decode_station_id, parse_packet
from rover.models import utc_now_iso

try:
    from LoRaRF import SX126x  # type: ignore
except Exception:  # pragma: no cover
    SX126x = None


CorrectionCallback = Callable[[bytes], None]


@dataclass
class Sx126xLoRaPacketReceiver:
    cfg: LoRaConfig
    logger: logging.Logger
    on_correction_bytes: CorrectionCallback

    def __post_init__(self) -> None:
        self._lora: SX126x | None = None
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._connected = False

        self._bytes_rx = 0
        self._last_rx_utc: str | None = None
        self._next_rx_log_at = 0.0

        self._heartbeats_rx = 0
        self._last_hb_utc: str | None = None
        self._last_hb_from: str | None = None
        self._last_hb_seq: int | None = None
        self._next_hb_log_at = 0.0

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def bytes_rx(self) -> int:
        return self._bytes_rx

    @property
    def last_rx_utc(self) -> str | None:
        return self._last_rx_utc

    @property
    def heartbeats_rx(self) -> int:
        return self._heartbeats_rx

    @property
    def last_heartbeat_utc(self) -> str | None:
        return self._last_hb_utc

    @property
    def last_heartbeat_from(self) -> str | None:
        return self._last_hb_from

    def start(self) -> None:
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()
        self.logger.info(
            "LoRa SX126x RX starting on spidev%d.%d @ %0.3f MHz",
            self.cfg.spi_bus_id,
            self.cfg.spi_cs_id,
            self.cfg.frequency_mhz,
        )

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._end_radio()
        self._connected = False

    def is_receiving_recent(self, timeout_s: float) -> bool:
        if not self._last_rx_utc:
            return False
        last = self._last_rx_utc.replace("Z", "+00:00")
        try:
            from datetime import datetime, timezone

            dt = datetime.fromisoformat(last)
            delta = datetime.now(timezone.utc) - dt
            return delta.total_seconds() <= timeout_s
        except Exception:
            return False

    def _reader_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._lora is None:
                if not self._begin_radio():
                    time.sleep(1.0)
                    continue

            assert self._lora is not None
            try:
                avail = int(self._lora.available())
            except Exception as exc:
                self.logger.warning("LoRa SX126x read error: %s", exc)
                self._connected = False
                self._end_radio()
                time.sleep(0.5)
                continue

            if avail <= 0:
                time.sleep(0.01)
                continue

            raw = self._read_packet_bytes()
            if not raw:
                continue

            pkt = parse_packet(raw)
            if not pkt or pkt.network_id != int(self.cfg.network_id):
                # Ignore foreign/non-RTK packets.
                continue

            if pkt.packet_type == TYPE_HEARTBEAT:
                self._handle_heartbeat(pkt.seq, pkt.payload)
                continue

            if pkt.packet_type == TYPE_CORRECTIONS:
                self._handle_corrections(pkt.payload)
                continue

    def _read_packet_bytes(self) -> bytes:
        assert self._lora is not None
        data = bytearray()
        # available() is bytes remaining in the current packet.
        # Loop until drained.
        for _ in range(4096):
            try:
                n = int(self._lora.available())
            except Exception:
                break
            if n <= 0:
                break
            try:
                b = self._lora.read()
            except Exception:
                break
            data.append(int(b) & 0xFF)
        return bytes(data)

    def _handle_heartbeat(self, seq: int, payload: bytes) -> None:
        self._heartbeats_rx += 1
        self._last_hb_utc = utc_now_iso()
        self._last_rx_utc = self._last_hb_utc
        self._last_hb_seq = seq
        self._last_hb_from = decode_station_id(payload)

        now = time.monotonic()
        if now >= self._next_hb_log_at:
            self.logger.info(
                "LoRa heartbeat RX: from=%s seq=%s (count=%d)",
                self._last_hb_from or "unknown",
                str(self._last_hb_seq) if self._last_hb_seq is not None else "n/a",
                self._heartbeats_rx,
            )
            self._next_hb_log_at = now + 5.0

    def _handle_corrections(self, payload: bytes) -> None:
        if not payload:
            return
        self._bytes_rx += len(payload)
        self._last_rx_utc = utc_now_iso()
        self._connected = True

        now = time.monotonic()
        if now >= self._next_rx_log_at:
            self.logger.info(
                "LoRa correction RX: total=%d bytes (last packet=%d bytes)",
                self._bytes_rx,
                len(payload),
            )
            self._next_rx_log_at = now + 5.0

        try:
            self.on_correction_bytes(payload)
        except Exception as exc:
            self.logger.warning("Correction callback failed: %s", exc)

    def _begin_radio(self) -> bool:
        if SX126x is None:
            self.logger.warning("LoRaRF is not installed; cannot use SX126x SPI transport")
            return False

        try:
            lora = SX126x()
            ok = bool(
                lora.begin(
                    int(self.cfg.spi_bus_id),
                    int(self.cfg.spi_cs_id),
                    int(self.cfg.reset_pin),
                    int(self.cfg.busy_pin),
                    int(self.cfg.irq_pin),
                    int(self.cfg.txen_pin),
                    int(self.cfg.rxen_pin),
                )
            )
            if not ok:
                self.logger.warning("LoRa SX126x begin() failed")
                self._connected = False
                return False

            try:
                lora.setDio2RfSwitch()
            except Exception:
                pass

            lora.setFrequency(int(float(self.cfg.frequency_mhz) * 1_000_000))
            try:
                lora.setRxGain(lora.RX_GAIN_POWER_SAVING)
            except Exception:
                pass

            lora.setLoRaModulation(
                int(self.cfg.spreading_factor),
                int(self.cfg.bandwidth_hz),
                int(self.cfg.coding_rate),
            )
            header_type = lora.HEADER_EXPLICIT
            lora.setLoRaPacket(
                header_type,
                int(self.cfg.preamble_length),
                255,
                bool(self.cfg.crc_enabled),
            )
            lora.setSyncWord(int(self.cfg.sync_word))

            # Start RX continuous mode.
            lora.request(lora.RX_CONTINUOUS)

            self._lora = lora
            self._connected = True
            self.logger.info(
                "LoRa SX126x configured: freq=%0.3fMHz sf=%d bw=%dHz cr=4/%d sync=0x%04X",
                float(self.cfg.frequency_mhz),
                int(self.cfg.spreading_factor),
                int(self.cfg.bandwidth_hz),
                int(self.cfg.coding_rate),
                int(self.cfg.sync_word),
            )
            return True
        except Exception as exc:
            self.logger.warning("LoRa SX126x init failed: %s", exc)
            self._connected = False
            self._lora = None
            return False

    def _end_radio(self) -> None:
        if not self._lora:
            return
        try:
            self._lora.end()
        except Exception:
            pass
        self._lora = None

