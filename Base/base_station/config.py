from __future__ import annotations

import os
import socket
from dataclasses import asdict, dataclass, field, is_dataclass
from pathlib import Path
from typing import Any, Mapping

import yaml


@dataclass(slots=True)
class LoggingConfig:
    level: str = "INFO"
    file_path: str = "logs/rtk-base.log"


@dataclass(slots=True)
class CorrectionsConfig:
    # "simulate" for link testing, "serial" to forward RTCM bytes from a GNSS receiver.
    mode: str = "serial"

    # Serial correction source (GNSS that outputs RTCM).
    serial_port: str = "/dev/ttyACM0"
    baudrate: int = 115200
    read_timeout_s: float = 0.2
    read_chunk_bytes: int = 1024
    fallback_to_sim: bool = False

    # Simulated correction stream (for early testing without GNSS hardware).
    simulate_interval_s: float = 0.25
    simulate_chunk_bytes: int = 80
    simulate_prefix: str = "RTCMTEST"


@dataclass(slots=True)
class LoRaConfig:
    enabled: bool = True
    # "serial" for transparent UART radios, "sx126x_spi" for Waveshare SX1262 LoRaWAN/GNSS HAT.
    transport: str = "serial"
    serial_port: str = "/dev/ttyS0"
    baudrate: int = 57600
    write_timeout_s: float = 0.2
    frequency_mhz: float = 913.0
    network_id: int = 18
    # Link verification heartbeat. Sent even when no RTCM bytes are available.
    heartbeat_enabled: bool = True
    heartbeat_interval_s: float = 1.0

    # Waveshare SX1262 915MHz UART HAT pre-flight configuration.
    # If enabled, base toggles M0/M1 and writes module registers at startup.
    uart_hat_auto_config: bool = False
    uart_hat_m0_pin: int = 22
    uart_hat_m1_pin: int = 27
    uart_hat_address: int = 0xFFFF
    uart_hat_air_speed: int = 2400
    uart_hat_buffer_size: int = 240
    uart_hat_persist: bool = True

    # SX126x SPI wiring (BCM GPIO numbering).
    spi_bus_id: int = 0
    spi_cs_id: int = 0
    reset_pin: int = 18
    busy_pin: int = 20
    irq_pin: int = 16
    txen_pin: int = 6
    rxen_pin: int = -1

    # SX126x RF/profile params.
    tx_power_dbm: int = 22
    sync_word: int = 0x3444
    spreading_factor: int = 7
    bandwidth_hz: int = 125000
    coding_rate: int = 5  # 4/5
    preamble_length: int = 12
    crc_enabled: bool = True
    # Max payload bytes per LoRa packet for the correction stream (excluding packet header).
    max_payload_bytes: int = 240


@dataclass(slots=True)
class AppConfig:
    device_id: str
    update_hz: float = 5.0
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    corrections: CorrectionsConfig = field(default_factory=CorrectionsConfig)
    lora: LoRaConfig = field(default_factory=LoRaConfig)
    config_path: Path | None = None


def _default_device_id() -> str:
    return socket.gethostname() or "BASE-PI4"


def default_config() -> AppConfig:
    return AppConfig(device_id=_default_device_id())


def _update_dataclass(target: Any, updates: Mapping[str, Any]) -> None:
    for key, value in updates.items():
        if not hasattr(target, key):
            continue
        current = getattr(target, key)
        if is_dataclass(current) and isinstance(value, Mapping):
            _update_dataclass(current, value)
            continue
        setattr(target, key, value)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw.strip())
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw.strip())
    except ValueError:
        return default


def apply_env_overrides(cfg: AppConfig) -> None:
    cfg.device_id = os.getenv("BASE_DEVICE_ID", cfg.device_id)
    cfg.update_hz = _env_float("BASE_UPDATE_HZ", cfg.update_hz)

    cfg.logging.level = os.getenv("BASE_LOG_LEVEL", cfg.logging.level)
    cfg.logging.file_path = os.getenv("BASE_LOG_PATH", cfg.logging.file_path)

    cfg.corrections.mode = os.getenv("BASE_CORR_MODE", cfg.corrections.mode)
    cfg.corrections.serial_port = os.getenv(
        "BASE_CORR_PORT", cfg.corrections.serial_port
    )
    cfg.corrections.baudrate = _env_int("BASE_CORR_BAUD", cfg.corrections.baudrate)
    cfg.corrections.read_timeout_s = _env_float(
        "BASE_CORR_TIMEOUT_S", cfg.corrections.read_timeout_s
    )
    cfg.corrections.read_chunk_bytes = _env_int(
        "BASE_CORR_CHUNK_BYTES", cfg.corrections.read_chunk_bytes
    )
    cfg.corrections.fallback_to_sim = _env_bool(
        "BASE_CORR_FALLBACK_SIM", cfg.corrections.fallback_to_sim
    )
    cfg.corrections.simulate_interval_s = _env_float(
        "BASE_CORR_SIM_INTERVAL_S", cfg.corrections.simulate_interval_s
    )
    cfg.corrections.simulate_chunk_bytes = _env_int(
        "BASE_CORR_SIM_BYTES", cfg.corrections.simulate_chunk_bytes
    )
    cfg.corrections.simulate_prefix = os.getenv(
        "BASE_CORR_SIM_PREFIX", cfg.corrections.simulate_prefix
    )

    cfg.lora.enabled = _env_bool("BASE_LORA_ENABLED", cfg.lora.enabled)
    cfg.lora.transport = os.getenv("BASE_LORA_TRANSPORT", cfg.lora.transport)
    cfg.lora.serial_port = os.getenv("BASE_LORA_PORT", cfg.lora.serial_port)
    cfg.lora.baudrate = _env_int("BASE_LORA_BAUD", cfg.lora.baudrate)
    cfg.lora.write_timeout_s = _env_float(
        "BASE_LORA_WRITE_TIMEOUT_S", cfg.lora.write_timeout_s
    )
    cfg.lora.frequency_mhz = _env_float("BASE_LORA_FREQ_MHZ", cfg.lora.frequency_mhz)
    cfg.lora.network_id = _env_int("BASE_LORA_NET_ID", cfg.lora.network_id)
    cfg.lora.spi_bus_id = _env_int("BASE_LORA_SPI_BUS_ID", cfg.lora.spi_bus_id)
    cfg.lora.spi_cs_id = _env_int("BASE_LORA_SPI_CS_ID", cfg.lora.spi_cs_id)
    cfg.lora.reset_pin = _env_int("BASE_LORA_RESET_PIN", cfg.lora.reset_pin)
    cfg.lora.busy_pin = _env_int("BASE_LORA_BUSY_PIN", cfg.lora.busy_pin)
    cfg.lora.irq_pin = _env_int("BASE_LORA_IRQ_PIN", cfg.lora.irq_pin)
    cfg.lora.txen_pin = _env_int("BASE_LORA_TXEN_PIN", cfg.lora.txen_pin)
    cfg.lora.rxen_pin = _env_int("BASE_LORA_RXEN_PIN", cfg.lora.rxen_pin)
    cfg.lora.heartbeat_enabled = _env_bool(
        "BASE_LORA_HEARTBEAT_ENABLED", cfg.lora.heartbeat_enabled
    )
    cfg.lora.heartbeat_interval_s = _env_float(
        "BASE_LORA_HEARTBEAT_INTERVAL_S", cfg.lora.heartbeat_interval_s
    )
    cfg.lora.uart_hat_auto_config = _env_bool(
        "BASE_LORA_UART_HAT_AUTO_CONFIG", cfg.lora.uart_hat_auto_config
    )
    cfg.lora.uart_hat_m0_pin = _env_int(
        "BASE_LORA_UART_HAT_M0_PIN", cfg.lora.uart_hat_m0_pin
    )
    cfg.lora.uart_hat_m1_pin = _env_int(
        "BASE_LORA_UART_HAT_M1_PIN", cfg.lora.uart_hat_m1_pin
    )
    cfg.lora.uart_hat_address = _env_int(
        "BASE_LORA_UART_HAT_ADDRESS", cfg.lora.uart_hat_address
    )
    cfg.lora.uart_hat_air_speed = _env_int(
        "BASE_LORA_UART_HAT_AIR_SPEED", cfg.lora.uart_hat_air_speed
    )
    cfg.lora.uart_hat_buffer_size = _env_int(
        "BASE_LORA_UART_HAT_BUFFER_SIZE", cfg.lora.uart_hat_buffer_size
    )
    cfg.lora.uart_hat_persist = _env_bool(
        "BASE_LORA_UART_HAT_PERSIST", cfg.lora.uart_hat_persist
    )


def load_config(config_path: str | Path | None = None) -> AppConfig:
    cfg = default_config()
    resolved_path: Path | None = None
    if config_path:
        resolved_path = Path(config_path).expanduser().resolve()
        if resolved_path.exists():
            loaded = yaml.safe_load(resolved_path.read_text(encoding="utf-8")) or {}
            if isinstance(loaded, Mapping):
                _update_dataclass(cfg, loaded)
    apply_env_overrides(cfg)
    cfg.config_path = resolved_path
    return cfg


def as_dict(cfg: AppConfig) -> dict[str, Any]:
    return asdict(cfg)
