from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from base_station.config import LoRaConfig
from base_station.models import utc_now_iso

try:
    from LoRaRF import SX126x  # type: ignore
except Exception:  # pragma: no cover
    SX126x = None


@dataclass
class Sx126xLoRaPacketTransmitter:
    cfg: LoRaConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._lora: SX126x | None = None
        self._connected = False
        self._bytes_tx = 0
        self._last_tx_utc: str | None = None
        self._next_log_at = 0.0

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
        self.logger.info(
            "LoRa SX126x TX starting on spidev%d.%d @ %0.3f MHz",
            self.cfg.spi_bus_id,
            self.cfg.spi_cs_id,
            self.cfg.frequency_mhz,
        )

    def stop(self) -> None:
        self._end_radio()
        self._connected = False

    def send(self, payload: bytes) -> bool:
        if not payload:
            return True
        if SX126x is None:
            self.logger.warning("LoRaRF is not installed; cannot use SX126x SPI transport")
            self._connected = False
            return False

        if self._lora is None:
            if not self._begin_radio():
                return False

        assert self._lora is not None
        try:
            self._lora.beginPacket()
            self._lora.write(list(payload), len(payload))
            self._lora.endPacket()
            self._lora.wait()
        except Exception as exc:
            self.logger.warning("LoRa SX126x transmit error: %s", exc)
            self._connected = False
            self._end_radio()
            return False

        self._connected = True
        self._bytes_tx += len(payload)
        self._last_tx_utc = utc_now_iso()

        now = time.monotonic()
        if now >= self._next_log_at:
            self.logger.info(
                "LoRa SX126x TX: total=%d bytes (last packet=%d bytes)",
                self._bytes_tx,
                len(payload),
            )
            self._next_log_at = now + 5.0
        return True

    def _begin_radio(self) -> bool:
        if SX126x is None:
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

            # Common Waveshare HAT wiring uses DIO2 as RF switch control.
            try:
                lora.setDio2RfSwitch()
            except Exception:
                pass

            lora.setFrequency(int(float(self.cfg.frequency_mhz) * 1_000_000))
            try:
                lora.setTxPower(int(self.cfg.tx_power_dbm), lora.TX_POWER_SX1262)
            except Exception:
                # Still usable on other variants; power will stay default.
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

