from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from glob import glob
from pathlib import Path

from base_station.config import LoRaConfig
from base_station.lora_uart_hat import configure_sx126x_uart_hat
from base_station.models import utc_now_iso

try:
    import serial
except Exception:  # pragma: no cover
    serial = None


@dataclass
class SerialLoRaCorrectionTransmitter:
    cfg: LoRaConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._serial: serial.Serial | None = None
        self._connected = False
        self._bytes_tx = 0
        self._last_tx_utc: str | None = None
        self._next_log_at = 0.0
        self._hat_config_attempted_ports: set[str] = set()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def bytes_tx(self) -> int:
        return self._bytes_tx

    @property
    def last_tx_utc(self) -> str | None:
        return self._last_tx_utc

    def start(self) -> None:
        if serial is None:
            raise RuntimeError("pyserial is not installed")
        # Open lazily on first send so we can boot even if the HAT is misconfigured.
        self.logger.info(
            "LoRa TX starting on %s @ %d MHz",
            self.cfg.serial_port,
            self.cfg.frequency_mhz,
        )

    def stop(self) -> None:
        self._close_serial()
        self._connected = False

    def send(self, payload: bytes) -> bool:
        if not payload:
            return True
        if serial is None:
            return False
        if self._serial is None:
            if not self._open_serial():
                return False
        assert self._serial is not None
        try:
            self._serial.write(payload)
        except Exception as exc:
            self.logger.warning("LoRa write error: %s", exc)
            self._connected = False
            self._close_serial()
            return False

        self._connected = True
        self._bytes_tx += len(payload)
        self._last_tx_utc = utc_now_iso()

        now = time.monotonic()
        if now >= self._next_log_at:
            self.logger.info(
                "LoRa correction TX: total=%d bytes (last chunk=%d bytes)",
                self._bytes_tx,
                len(payload),
            )
            self._next_log_at = now + 5.0
        return True

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
                    baudrate=int(self.cfg.baudrate),
                    timeout=float(self.cfg.write_timeout_s),
                    write_timeout=float(self.cfg.write_timeout_s),
                )
            except Exception as exc:
                self._connected = False
                self.logger.warning("LoRa serial open failed on %s: %s", port, exc)
                continue
            self._connected = True
            self.cfg.serial_port = port
            self.logger.info("LoRa serial opened on %s @ %d baud", port, self.cfg.baudrate)
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
