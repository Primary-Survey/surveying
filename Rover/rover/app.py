from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from rover.bluetooth_server import BluetoothTelemetryServer
from rover.config import AppConfig
from rover.gnss import GnssReceiver, SerialGnssReceiver, SimulatedGnssReceiver
from rover.lora import SerialLoRaCorrectionReceiver
from rover.lora_sx126x import Sx126xLoRaPacketReceiver
from rover.models import RoverFix, RoverState
from rover.oled import OledDisplay
from rover.protocol import build_telemetry_message


def _iso_age_seconds(timestamp_utc: str | None) -> float | None:
    if not timestamp_utc:
        return None
    try:
        dt = datetime.fromisoformat(timestamp_utc.replace("Z", "+00:00"))
    except ValueError:
        return None
    return (datetime.now(timezone.utc) - dt).total_seconds()


class LoRaReceiver(Protocol):
    connected: bool
    bytes_rx: int
    last_rx_utc: str | None

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def is_receiving_recent(self, timeout_s: float) -> bool: ...


class RoverApplication:
    def __init__(self, cfg: AppConfig, logger: logging.Logger) -> None:
        self.cfg = cfg
        self.logger = logger
        self._stop_event = threading.Event()
        self._display_next_at = 0.0
        self._telemetry_next_at = 0.0
        self._state = RoverState(device_id=cfg.device_id)
        self._startup_warnings: list[str] = []
        self._gnss: GnssReceiver | None = None
        self._lora: LoRaReceiver | None = None
        self._bt: BluetoothTelemetryServer | None = None
        root = cfg.config_path.parent if cfg.config_path else Path.cwd()
        self._oled = OledDisplay(cfg.oled, logger=logger, root_path=root)

    def request_stop(self) -> None:
        self._stop_event.set()

    def run_forever(self) -> None:
        try:
            self._start_components()
            period_s = 1.0 / max(self.cfg.update_hz, 1.0)
            while not self._stop_event.is_set():
                loop_started = time.monotonic()
                state = self._collect_state()
                now = time.monotonic()
                if now >= self._telemetry_next_at:
                    self._broadcast(state)
                    self._telemetry_next_at = now + 1.0 / max(
                        self.cfg.bluetooth.broadcast_hz,
                        1.0,
                    )
                if now >= self._display_next_at:
                    self._oled.show_status(state)
                    self._display_next_at = now + max(
                        self.cfg.oled.refresh_interval_s,
                        0.25,
                    )
                sleep_for = period_s - (time.monotonic() - loop_started)
                if sleep_for > 0:
                    time.sleep(sleep_for)
        except KeyboardInterrupt:
            self.logger.info("Stopping rover service (Ctrl+C)")
        except Exception as exc:
            self._state.last_error = str(exc)
            self.logger.exception("Fatal rover error")
            self._oled.show_error(str(exc))
            raise
        finally:
            self._stop_components()

    def _start_components(self) -> None:
        self._oled.start()
        self._oled.show_boot(self.cfg.device_id)

        self._gnss = self._build_gnss_receiver()

        if self.cfg.lora.enabled:
            transport = (self.cfg.lora.transport or "serial").strip().lower()
            if transport in {"sx126x_spi", "sx126x", "spi"}:
                self._lora = Sx126xLoRaPacketReceiver(
                    cfg=self.cfg.lora,
                    logger=self.logger,
                    on_correction_bytes=self._on_correction_bytes,
                )
            else:
                self._lora = SerialLoRaCorrectionReceiver(
                    cfg=self.cfg.lora,
                    logger=self.logger,
                    on_correction_bytes=self._on_correction_bytes,
                )
            try:
                self._lora.start()
            except Exception as exc:
                self._startup_warnings.append(f"LoRa disabled: {exc}")
                self.logger.warning("LoRa receiver failed to start: %s", exc)

        if self.cfg.bluetooth.enabled:
            self._bt = BluetoothTelemetryServer(self.cfg.bluetooth, logger=self.logger)
            try:
                self._bt.start()
            except Exception as exc:
                self._startup_warnings.append(f"Bluetooth disabled: {exc}")
                self.logger.warning("Bluetooth server failed to start: %s", exc)
                self._bt = None

    def _build_gnss_receiver(self) -> GnssReceiver:
        if self.cfg.gnss.enabled:
            try:
                receiver = SerialGnssReceiver(self.cfg.gnss, logger=self.logger)
                receiver.start()
                self.logger.info("GNSS source: serial")
                return receiver
            except Exception as exc:
                if not self.cfg.gnss.simulate_without_hardware:
                    raise
                self.logger.warning("Serial GNSS unavailable (%s), using simulation", exc)
                self._startup_warnings.append("GNSS simulation mode")

        receiver = SimulatedGnssReceiver(self.cfg.gnss, logger=self.logger)
        receiver.start()
        self.logger.info("GNSS source: simulation")
        return receiver

    def _stop_components(self) -> None:
        if self._bt:
            self._bt.stop()
        if self._lora:
            self._lora.stop()
        if self._gnss:
            self._gnss.stop()
        self._oled.stop()

    def _on_correction_bytes(self, payload: bytes) -> None:
        if self._gnss:
            self._gnss.write_correction(payload)

    def _collect_state(self) -> RoverState:
        state = RoverState(device_id=self.cfg.device_id)
        state.last_error = self._state.last_error
        state.warnings.extend(self._startup_warnings)

        if self._gnss:
            state.gnss_connected = self._gnss.connected
            fix = self._gnss.get_fix()
            if fix:
                correction_age = _iso_age_seconds(self._gnss.last_correction_utc)
                fix = RoverFix(
                    timestamp_utc=fix.timestamp_utc,
                    lat=fix.lat,
                    lng=fix.lng,
                    quality=fix.quality,
                    alt_m=fix.alt_m,
                    accuracy_m=fix.accuracy_m,
                    hdop=fix.hdop,
                    satellites=fix.satellites,
                    correction_age_s=correction_age,
                )
                state.fix = fix
            state.last_correction_utc = self._gnss.last_correction_utc

        if self._lora:
            state.lora_connected = self._lora.connected and self._lora.is_receiving_recent(
                self.cfg.lora.correction_timeout_s
            )
            state.lora_bytes_rx = self._lora.bytes_rx
            if not state.lora_connected:
                state.warnings.append("Waiting for LoRa corrections")

        if self._bt:
            state.bluetooth_connected = self._bt.has_client
            state.bluetooth_client = self._bt.client_addr

        if not state.fix:
            state.warnings.append("Waiting for GNSS fix")

        self._state = state
        return state

    def _broadcast(self, state: RoverState) -> None:
        if not self._bt:
            return
        payload = build_telemetry_message(state)
        self._bt.broadcast_json(payload)
