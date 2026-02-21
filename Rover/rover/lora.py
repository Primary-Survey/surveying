from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from glob import glob
from pathlib import Path
from typing import Callable

from rover.config import LoRaConfig
from rover.lora_uart_hat import configure_sx126x_uart_hat
from rover.models import utc_now_iso

try:
    import serial
except Exception:  # pragma: no cover
    serial = None


CorrectionCallback = Callable[[bytes], None]

# Heartbeat/control framing (matches Base/base_station/lora_protocol.py).
# These frames are stripped out before forwarding correction bytes to GNSS.
HB_PREFIX = b"\x02RTKHB,"
HB_SUFFIX = b"\x03"
HB_MAX_FRAME_LEN = 200  # bytes


@dataclass
class SerialLoRaCorrectionReceiver:
    cfg: LoRaConfig
    logger: logging.Logger
    on_correction_bytes: CorrectionCallback

    def __post_init__(self) -> None:
        self._serial: serial.Serial | None = None
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._connected = False
        self._bytes_rx = 0
        self._last_rx_utc: str | None = None
        self._next_rx_log_at = 0.0
        self._rx_buf = b""
        self._heartbeats_rx = 0
        self._last_hb_utc: str | None = None
        self._last_hb_from: str | None = None
        self._last_hb_seq: int | None = None
        self._next_hb_log_at = 0.0
        self._hat_config_attempted_ports: set[str] = set()

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
        if serial is None:
            raise RuntimeError("pyserial is not installed")
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()
        self.logger.info(
            "LoRa serial receiver starting on %s @ %d MHz",
            self.cfg.serial_port,
            self.cfg.frequency_mhz,
        )

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._close_serial()
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

    def _open_serial(self) -> bool:
        if serial is None:
            return False
        attempts: list[str] = []
        for port in self._candidate_ports():
            if not self._port_exists(port):
                continue
            attempts.append(port)
            self._configure_uart_hat_if_needed(port)
            try:
                self._serial = serial.Serial(
                    port=port,
                    baudrate=self.cfg.baudrate,
                    timeout=self.cfg.read_timeout_s,
                )
            except Exception as exc:
                self.logger.warning("LoRa serial open failed on %s: %s", port, exc)
                self._connected = False
                continue
            self._connected = True
            self.cfg.serial_port = port
            self.logger.info(
                "LoRa serial opened on %s @ %d baud",
                port,
                self.cfg.baudrate,
            )
            return True

        self._connected = False
        if attempts:
            self.logger.warning("LoRa serial unavailable on candidate ports: %s", ", ".join(attempts))
        else:
            self.logger.warning("LoRa serial unavailable: no candidate ports found")
        return False

    def _configure_uart_hat_if_needed(self, serial_port: str) -> None:
        if serial_port in self._hat_config_attempted_ports:
            return
        self._hat_config_attempted_ports.add(serial_port)
        if not bool(self.cfg.uart_hat_auto_config):
            return
        configure_sx126x_uart_hat(
            serial_port=serial_port,
            frequency_mhz=float(self.cfg.frequency_mhz),
            network_id=int(self.cfg.network_id),
            tx_power_dbm=int(self.cfg.tx_power_dbm),
            m0_pin=int(self.cfg.uart_hat_m0_pin),
            m1_pin=int(self.cfg.uart_hat_m1_pin),
            address=int(self.cfg.uart_hat_address),
            air_speed=int(self.cfg.uart_hat_air_speed),
            buffer_size=int(self.cfg.uart_hat_buffer_size),
            persist=bool(self.cfg.uart_hat_persist),
            logger=self.logger,
        )

    def _candidate_ports(self) -> list[str]:
        preferred = (self.cfg.serial_port or "").strip()
        ports: list[str] = []

        def add(port: str) -> None:
            p = port.strip()
            if p and p not in ports:
                ports.append(p)

        add(preferred)
        for pattern in (
            "/dev/serial/by-id/*CP2102*",
            "/dev/serial/by-id/*USB_to_UART*",
            "/dev/serial/by-id/*",
        ):
            for path in sorted(glob(pattern)):
                add(path)
        for fallback in ("/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/serial0", "/dev/ttyS0"):
            add(fallback)
        return ports

    def _port_exists(self, port: str) -> bool:
        # Non-/dev paths are allowed (for test/dev environments).
        if not port.startswith("/dev/"):
            return True
        return Path(port).exists()

    def _close_serial(self) -> None:
        if not self._serial:
            return
        try:
            self._serial.close()
        except Exception:
            pass
        self._serial = None

    def _reader_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._serial is None and not self._open_serial():
                time.sleep(1.0)
                continue
            assert self._serial is not None
            try:
                payload = self._serial.read(self.cfg.receive_chunk_bytes)
            except Exception as exc:
                self.logger.warning("LoRa read error: %s", exc)
                self._connected = False
                self._close_serial()
                time.sleep(0.5)
                continue
            if not payload:
                continue
            self._bytes_rx += len(payload)
            self._last_rx_utc = utc_now_iso()
            self._connected = True
            now = time.monotonic()
            if now >= self._next_rx_log_at:
                self.logger.info(
                    "LoRa correction RX: total=%d bytes (last chunk=%d bytes)",
                    self._bytes_rx,
                    len(payload),
                )
                self._next_rx_log_at = now + 5.0
            self._consume_stream(payload)

    def _consume_stream(self, chunk: bytes) -> None:
        """
        Strip heartbeat frames (control plane) from the LoRa byte stream and
        forward only correction bytes (data plane) to GNSS.
        """
        if not chunk:
            return
        self._rx_buf += chunk
        prefix_len = len(HB_PREFIX)

        while True:
            start = self._rx_buf.find(HB_PREFIX)
            if start < 0:
                # No heartbeat prefix found; flush data, but keep only the
                # minimal suffix that could be the start of HB_PREFIX.
                keep_tail = self._prefix_overlap_tail_len(self._rx_buf)
                if keep_tail > 0:
                    data = self._rx_buf[:-keep_tail]
                    self._rx_buf = self._rx_buf[-keep_tail:]
                else:
                    data = self._rx_buf
                    self._rx_buf = b""
                self._emit_data(data)
                return

            if start > 0:
                # Bytes before the control frame are correction bytes.
                data = self._rx_buf[:start]
                self._rx_buf = self._rx_buf[start:]
                self._emit_data(data)
                continue

            # Buffer starts with heartbeat prefix.
            end = self._rx_buf.find(HB_SUFFIX, prefix_len)
            if end < 0:
                # Incomplete frame. If it grows too large, treat as false-positive
                # and resync by emitting one byte as data.
                if len(self._rx_buf) > HB_MAX_FRAME_LEN:
                    self._emit_data(self._rx_buf[:1])
                    self._rx_buf = self._rx_buf[1:]
                    continue
                return

            frame_len = end + 1
            if frame_len > HB_MAX_FRAME_LEN:
                # Probably not a real heartbeat frame; resync.
                self._emit_data(self._rx_buf[:1])
                self._rx_buf = self._rx_buf[1:]
                continue

            frame = self._rx_buf[:frame_len]
            self._rx_buf = self._rx_buf[frame_len:]
            self._handle_heartbeat_frame(frame)

    def _handle_heartbeat_frame(self, frame: bytes) -> None:
        # Update link state even if parsing fails; receipt itself verifies RF path.
        self._heartbeats_rx += 1
        self._last_hb_utc = utc_now_iso()

        station_id: str | None = None
        seq: int | None = None
        try:
            body = frame[len(HB_PREFIX) : -len(HB_SUFFIX)]
            parts = body.split(b",")
            if parts:
                station_id = parts[0].decode("ascii", errors="ignore").strip() or None
            if len(parts) >= 3:
                seq = int(parts[2].decode("ascii", errors="ignore").strip() or "0")
        except Exception:
            pass

        if station_id:
            self._last_hb_from = station_id
        if seq is not None:
            self._last_hb_seq = seq

        now = time.monotonic()
        if now >= self._next_hb_log_at:
            self.logger.info(
                "LoRa heartbeat RX: from=%s seq=%s (count=%d)",
                self._last_hb_from or "unknown",
                str(self._last_hb_seq) if self._last_hb_seq is not None else "n/a",
                self._heartbeats_rx,
            )
            self._next_hb_log_at = now + 5.0

    def _emit_data(self, payload: bytes) -> None:
        if not payload:
            return
        try:
            self.on_correction_bytes(payload)
        except Exception as exc:
            self.logger.warning("Correction callback failed: %s", exc)

    def _prefix_overlap_tail_len(self, data: bytes) -> int:
        """
        Return the largest suffix length of `data` that matches a prefix of
        HB_PREFIX, excluding the full-prefix case (handled by find()).
        """
        max_tail = min(len(data), max(len(HB_PREFIX) - 1, 0))
        for n in range(max_tail, 0, -1):
            if data.endswith(HB_PREFIX[:n]):
                return n
        return 0
