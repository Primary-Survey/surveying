from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from glob import glob
from pathlib import Path

from base_station.config import CorrectionsConfig
from base_station.models import utc_now_iso

try:
    import serial
except Exception:  # pragma: no cover
    serial = None


class CorrectionSource:
    def start(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def stop(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def read_chunk(self) -> bytes:  # pragma: no cover - interface
        raise NotImplementedError

    @property
    def connected(self) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass
class SerialCorrectionSource(CorrectionSource):
    cfg: CorrectionsConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._serial: serial.Serial | None = None
        self._connected = False
        self._next_probe_log_at = 0.0

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> None:
        if serial is None:
            raise RuntimeError("pyserial is not installed")
        opened = self._open_serial()
        if not opened:
            self.logger.warning(
                "Correction serial unavailable at startup; will keep retrying"
            )

    def stop(self) -> None:
        self._close_serial()
        self._connected = False

    def read_chunk(self) -> bytes:
        if serial is None:
            return b""
        if self._serial is None:
            if not self._open_serial():
                return b""
        assert self._serial is not None
        try:
            payload = self._serial.read(int(self.cfg.read_chunk_bytes))
        except Exception as exc:
            self.logger.warning("Correction serial read error: %s", exc)
            self._connected = False
            self._close_serial()
            time.sleep(0.5)
            return b""
        if payload:
            self._connected = True
        return payload or b""

    def _open_serial(self) -> bool:
        if serial is None:
            return False
        attempts: list[str] = []
        for port in self._candidate_ports():
            if not self._port_exists(port):
                continue
            attempts.append(port)
            try:
                self._serial = serial.Serial(
                    port=port,
                    baudrate=int(self.cfg.baudrate),
                    timeout=float(self.cfg.read_timeout_s),
                )
            except Exception as exc:
                self._connected = False
                if self._should_log_probe():
                    self.logger.warning("Correction serial open failed on %s: %s", port, exc)
                continue
            self._connected = True
            self.cfg.serial_port = port
            self.logger.info("Correction serial opened on %s", port)
            return True

        self._connected = False
        if self._should_log_probe():
            if attempts:
                self.logger.warning(
                    "Correction serial unavailable on candidate ports: %s",
                    ", ".join(attempts),
                )
            else:
                self.logger.warning(
                    "Correction serial unavailable: no candidate ports found"
                )
        return False

    def _candidate_ports(self) -> list[str]:
        preferred = (self.cfg.serial_port or "").strip()
        ports: list[str] = []

        def add(port: str) -> None:
            p = port.strip()
            if p and p not in ports:
                ports.append(p)

        add(preferred)
        gnss_patterns = (
            "/dev/serial/by-id/*u-blox*",
            "/dev/serial/by-id/*UBLOX*",
            "/dev/serial/by-id/*GNSS*",
            "/dev/serial/by-id/*gps*",
            "/dev/serial/by-id/*",
        )
        for pattern in gnss_patterns:
            for path in sorted(glob(pattern)):
                if self._is_likely_lora_usb(path):
                    continue
                add(path)
        for fallback in (
            "/dev/ttyACM0",
            "/dev/ttyACM1",
            "/dev/ttyACM2",
            "/dev/ttyUSB0",
            "/dev/ttyUSB1",
            "/dev/ttyUSB2",
            "/dev/serial0",
            "/dev/ttyAMA0",
        ):
            add(fallback)
        return ports

    def _is_likely_lora_usb(self, port: str) -> bool:
        lowered = port.lower()
        markers = (
            "cp210",
            "usb_to_uart",
            "silicon_labs",
            "sx126",
            "lora",
            "ebyte",
            "e22",
        )
        return any(marker in lowered for marker in markers)

    def _port_exists(self, port: str) -> bool:
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

    def _should_log_probe(self) -> bool:
        now = time.monotonic()
        if now < self._next_probe_log_at:
            return False
        self._next_probe_log_at = now + 10.0
        return True


@dataclass
class SimulatedCorrectionSource(CorrectionSource):
    cfg: CorrectionsConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._connected = False
        self._next_at = 0.0
        self._seq = 0

    @property
    def connected(self) -> bool:
        return self._connected

    def start(self) -> None:
        self._connected = True
        self._next_at = 0.0
        self._seq = 0
        self.logger.info(
            "Correction source: simulation (every %.2fs, %d bytes)",
            self.cfg.simulate_interval_s,
            self.cfg.simulate_chunk_bytes,
        )

    def stop(self) -> None:
        self._connected = False

    def read_chunk(self) -> bytes:
        if not self._connected:
            return b""
        now = time.monotonic()
        if now < self._next_at:
            return b""
        self._next_at = now + max(float(self.cfg.simulate_interval_s), 0.05)
        self._seq += 1

        prefix = (self.cfg.simulate_prefix or "RTCMTEST").encode("ascii", errors="ignore")
        prefix = prefix[:24] if prefix else b"RTCMTEST"
        stamp = utc_now_iso().encode("ascii")
        seq = str(self._seq).encode("ascii")

        payload = prefix + b" " + stamp + b" " + seq
        target = int(self.cfg.simulate_chunk_bytes) if self.cfg.simulate_chunk_bytes else 0
        if target > 0:
            if len(payload) < target:
                payload = payload + b"#" * (target - len(payload))
            elif len(payload) > target:
                payload = payload[:target]
        return payload
