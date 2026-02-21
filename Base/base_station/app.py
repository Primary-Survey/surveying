from __future__ import annotations

import logging
import threading
import time
from typing import Protocol

from base_station.config import AppConfig
from base_station.corrections import (
    CorrectionSource,
    SerialCorrectionSource,
    SimulatedCorrectionSource,
)
from base_station.lora import SerialLoRaCorrectionTransmitter
from base_station.lora_packets import (
    TYPE_CORRECTIONS,
    TYPE_HEARTBEAT,
    build_packet,
    encode_station_id,
)
from base_station.lora_protocol import build_heartbeat_frame
from base_station.lora_sx126x import Sx126xLoRaPacketTransmitter
from base_station.models import BaseState


class LoRaTransmitter(Protocol):
    connected: bool
    bytes_tx: int
    last_tx_utc: str | None

    def start(self) -> None: ...

    def stop(self) -> None: ...

    def send(self, payload: bytes) -> bool: ...


class BaseStationApplication:
    def __init__(self, cfg: AppConfig, logger: logging.Logger) -> None:
        self.cfg = cfg
        self.logger = logger
        self._stop_event = threading.Event()
        self._state = BaseState(device_id=cfg.device_id)

        self._lora: LoRaTransmitter | None = None
        self._source: CorrectionSource | None = None
        self._packetize = False

        self._status_next_at = 0.0
        self._hb_next_at = 0.0
        self._hb_seq = 0
        self._pkt_seq = 0

    def request_stop(self) -> None:
        self._stop_event.set()

    def run_forever(self) -> None:
        try:
            self._start_components()
            self._loop()
        finally:
            self._stop_components()

    def _start_components(self) -> None:
        if self.cfg.lora.enabled:
            transport = (self.cfg.lora.transport or "serial").strip().lower()
            self._packetize = transport in {"sx126x_spi", "sx126x", "spi"}
            if self._packetize:
                self._lora = Sx126xLoRaPacketTransmitter(self.cfg.lora, logger=self.logger)
            else:
                self._lora = SerialLoRaCorrectionTransmitter(self.cfg.lora, logger=self.logger)
            self._lora.start()

        mode = (self.cfg.corrections.mode or "simulate").strip().lower()
        if mode == "serial":
            self._source = SerialCorrectionSource(self.cfg.corrections, logger=self.logger)
            self._source.start()
        else:
            self._source = SimulatedCorrectionSource(self.cfg.corrections, logger=self.logger)
            self._source.start()

        # If serial is selected but no hardware is present, optionally fall back to simulation.
        if (
            mode == "serial"
            and isinstance(self._source, SerialCorrectionSource)
            and self.cfg.corrections.fallback_to_sim
        ):
            # First read attempt will decide if we should fall back.
            payload = self._source.read_chunk()
            if not payload and not self._source.connected:
                self.logger.warning("Serial correction source not available; falling back to simulation")
                self._source.stop()
                self._source = SimulatedCorrectionSource(self.cfg.corrections, logger=self.logger)
                self._source.start()

    def _stop_components(self) -> None:
        if self._source:
            self._source.stop()
        if self._lora:
            self._lora.stop()

    def _loop(self) -> None:
        assert self._source is not None
        while not self._stop_event.is_set():
            payload = self._source.read_chunk()
            if payload and self._lora:
                if self._packetize:
                    max_chunk = max(int(self.cfg.lora.max_payload_bytes), 16)
                    for i in range(0, len(payload), max_chunk):
                        chunk = payload[i : i + max_chunk]
                        self._pkt_seq = (self._pkt_seq + 1) & 0xFFFF
                        pkt = build_packet(
                            TYPE_CORRECTIONS,
                            network_id=int(self.cfg.lora.network_id),
                            seq=self._pkt_seq,
                            payload=chunk,
                        )
                        ok = self._lora.send(pkt)
                        if not ok:
                            self._state.last_error = "LoRa write failed"
                            break
                else:
                    ok = self._lora.send(payload)
                    if not ok:
                        self._state.last_error = "LoRa write failed"

            # Always send a small heartbeat so the rover can verify the radio
            # link even when no RTCM bytes are flowing yet.
            now = time.monotonic()
            if (
                self._lora
                and self.cfg.lora.heartbeat_enabled
                and now >= self._hb_next_at
            ):
                self._hb_seq = (self._hb_seq + 1) & 0xFFFF
                if self._packetize:
                    hb = build_packet(
                        TYPE_HEARTBEAT,
                        network_id=int(self.cfg.lora.network_id),
                        seq=self._hb_seq,
                        payload=encode_station_id(self.cfg.device_id),
                    )
                else:
                    hb = build_heartbeat_frame(self.cfg.device_id, self._hb_seq)
                self._lora.send(hb)
                self._hb_next_at = now + max(float(self.cfg.lora.heartbeat_interval_s), 0.2)

            self._state.corrections_connected = self._source.connected
            self._state.lora_connected = bool(self._lora and self._lora.connected)
            if self._lora:
                self._state.lora_bytes_tx = self._lora.bytes_tx
                self._state.last_tx_utc = self._lora.last_tx_utc
            if now >= self._status_next_at:
                self.logger.info(
                    "Status: corr=%s lora=%s bytes_tx=%d last_tx=%s",
                    "OK" if self._state.corrections_connected else "NO",
                    "OK" if self._state.lora_connected else "NO",
                    self._state.lora_bytes_tx,
                    self._state.last_tx_utc or "n/a",
                )
                self._status_next_at = now + 5.0

            # Avoid busy-looping in simulation mode.
            if not payload:
                time.sleep(0.02)
