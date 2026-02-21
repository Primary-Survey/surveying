from __future__ import annotations

import logging
import random
import threading
import time
from dataclasses import dataclass
from glob import glob
from pathlib import Path

from rover.config import GnssConfig
from rover.models import FixQuality, RoverFix, utc_now_iso

try:
    import serial
except Exception:  # pragma: no cover
    serial = None

try:
    import pynmea2
except Exception:  # pragma: no cover
    pynmea2 = None


def _quality_from_nmea(gps_quality: int) -> FixQuality:
    return {
        0: "no-fix",
        1: "gps",
        2: "dgps",
        4: "rtk-fixed",
        5: "rtk-float",
        6: "dead-reckoning",
    }.get(gps_quality, "unknown")


class GnssReceiver:
    def start(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def stop(self) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def get_fix(self) -> RoverFix | None:  # pragma: no cover - interface
        raise NotImplementedError

    def write_correction(self, payload: bytes) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    @property
    def connected(self) -> bool:  # pragma: no cover - interface
        raise NotImplementedError

    @property
    def last_correction_utc(self) -> str | None:  # pragma: no cover - interface
        raise NotImplementedError


@dataclass
class SerialGnssReceiver(GnssReceiver):
    cfg: GnssConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._serial: serial.Serial | None = None
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._fix_lock = threading.Lock()
        self._latest_fix: RoverFix | None = None
        self._connected = False
        self._last_correction_utc: str | None = None
        self._next_probe_log_at = 0.0

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def last_correction_utc(self) -> str | None:
        return self._last_correction_utc

    def start(self) -> None:
        if serial is None:
            raise RuntimeError("pyserial is not installed")
        if pynmea2 is None:
            raise RuntimeError("pynmea2 is not installed")
        self._stop_event.clear()
        opened = self._open_serial()
        if not opened and self.cfg.simulate_without_hardware:
            raise RuntimeError("GNSS serial unavailable")
        if not opened:
            self.logger.warning("GNSS serial unavailable at startup; will keep retrying")
        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._close_serial()
        self._connected = False

    def get_fix(self) -> RoverFix | None:
        with self._fix_lock:
            return self._latest_fix

    def write_correction(self, payload: bytes) -> None:
        if not payload:
            return
        if not self._serial:
            return
        try:
            self._serial.write(payload)
            self._last_correction_utc = utc_now_iso()
        except Exception as exc:
            self._connected = False
            self._close_serial()
            self.logger.warning("Failed to write GNSS correction bytes: %s", exc)

    def _reader_loop(self) -> None:
        while not self._stop_event.is_set():
            if self._serial is None and not self._open_serial():
                time.sleep(1.0)
                continue
            assert self._serial is not None
            try:
                raw = self._serial.readline()
            except Exception as exc:
                self._connected = False
                self._close_serial()
                self.logger.warning("GNSS serial read failed: %s", exc)
                time.sleep(0.5)
                continue

            if not raw:
                continue

            line = raw.decode("ascii", errors="ignore").strip()
            if not line.startswith("$"):
                continue
            parsed = self._parse_sentence(line)
            if parsed:
                with self._fix_lock:
                    self._latest_fix = parsed
                self._connected = True

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
                    baudrate=self.cfg.baudrate,
                    timeout=self.cfg.read_timeout_s,
                )
            except Exception as exc:
                self._connected = False
                if self._should_log_probe():
                    self.logger.warning("GNSS serial open failed on %s: %s", port, exc)
                continue
            self._connected = True
            self.cfg.serial_port = port
            self.logger.info("GNSS serial opened on %s @ %d", port, self.cfg.baudrate)
            return True

        self._connected = False
        if self._should_log_probe():
            if attempts:
                self.logger.warning(
                    "GNSS serial unavailable on candidate ports: %s",
                    ", ".join(attempts),
                )
            else:
                self.logger.warning("GNSS serial unavailable: no candidate ports found")
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

    def _parse_sentence(self, sentence: str) -> RoverFix | None:
        if pynmea2 is None:
            return None
        try:
            msg = pynmea2.parse(sentence)
        except Exception:
            return None
        if msg.sentence_type != "GGA":
            return None
        if not getattr(msg, "latitude", None) or not getattr(msg, "longitude", None):
            return None
        gps_quality = int(getattr(msg, "gps_qual", 0) or 0)
        hdop = float(getattr(msg, "horizontal_dil", 0.0) or 0.0)
        accuracy = hdop * 5.0 if hdop > 0 else None
        return RoverFix(
            timestamp_utc=utc_now_iso(),
            lat=float(msg.latitude),
            lng=float(msg.longitude),
            quality=_quality_from_nmea(gps_quality),
            alt_m=float(getattr(msg, "altitude", 0.0) or 0.0),
            accuracy_m=accuracy,
            hdop=hdop if hdop > 0 else None,
            satellites=int(getattr(msg, "num_sats", 0) or 0),
        )


@dataclass
class SimulatedGnssReceiver(GnssReceiver):
    cfg: GnssConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._fix_lock = threading.Lock()
        self._latest_fix: RoverFix | None = None
        self._connected = False
        self._lat = self.cfg.sim_lat
        self._lng = self.cfg.sim_lng
        self._last_correction_utc: str | None = None

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def last_correction_utc(self) -> str | None:
        return self._last_correction_utc

    def start(self) -> None:
        self._connected = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        self.logger.info("GNSS simulation enabled at %.7f, %.7f", self._lat, self._lng)

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self._connected = False

    def get_fix(self) -> RoverFix | None:
        with self._fix_lock:
            return self._latest_fix

    def write_correction(self, payload: bytes) -> None:
        if payload:
            self._last_correction_utc = utc_now_iso()

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            self._lat += random.uniform(-0.000002, 0.000002)
            self._lng += random.uniform(-0.000002, 0.000002)
            fix = RoverFix(
                timestamp_utc=utc_now_iso(),
                lat=self._lat,
                lng=self._lng,
                quality="rtk-fixed",
                alt_m=self.cfg.sim_alt_m,
                accuracy_m=0.02,
                hdop=0.4,
                satellites=18,
            )
            with self._fix_lock:
                self._latest_fix = fix
            time.sleep(0.25)
