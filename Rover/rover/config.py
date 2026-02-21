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
    file_path: str = "logs/rtk-rover.log"


@dataclass(slots=True)
class GnssConfig:
    enabled: bool = True
    simulate_without_hardware: bool = False
    serial_port: str = "/dev/ttyACM0"
    baudrate: int = 115200
    read_timeout_s: float = 0.2
    # Default simulated position: Stanley Park, Vancouver, BC.
    sim_lat: float = 49.3043
    sim_lng: float = -123.1443
    sim_alt_m: float = 20.0


@dataclass(slots=True)
class LoRaConfig:
    enabled: bool = True
    # "serial" for transparent UART radios, "sx126x_spi" for Waveshare SX1262 LoRaWAN/GNSS HAT.
    transport: str = "serial"
    serial_port: str = "/dev/ttyS0"
    baudrate: int = 57600
    read_timeout_s: float = 0.1
    receive_chunk_bytes: int = 512
    correction_timeout_s: float = 10.0
    frequency_mhz: float = 913.0
    network_id: int = 18

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

    # Waveshare SX1262 915MHz UART HAT pre-flight configuration.
    # If enabled, rover toggles M0/M1 and writes module registers at startup.
    uart_hat_auto_config: bool = False
    uart_hat_m0_pin: int = 22
    uart_hat_m1_pin: int = 27
    uart_hat_address: int = 0xFFFF
    uart_hat_air_speed: int = 2400
    uart_hat_buffer_size: int = 240
    uart_hat_persist: bool = True


@dataclass(slots=True)
class BluetoothConfig:
    enabled: bool = True
    service_name: str = "RTK-Rover"
    service_uuid: str = "00001101-0000-1000-8000-00805F9B34FB"
    channel: int = 4
    broadcast_hz: float = 4.0


@dataclass(slots=True)
class OledConfig:
    enabled: bool = False
    width: int = 128
    height: int = 64
    i2c_port: int = 1
    i2c_address: int = 0x3C
    rotate: int = 0
    refresh_interval_s: float = 0.5
    logo_path: str = "assets/logo.png"


@dataclass(slots=True)
class BaseStationProfileConfig:
    station_id: str = "BASE-01"
    correction_format: str = "RTCM3"
    lora_frequency_mhz: float = 913.0
    lora_bandwidth_khz: int = 125
    lora_spreading_factor: int = 7
    lora_coding_rate: str = "4/5"


@dataclass(slots=True)
class AppConfig:
    device_id: str
    update_hz: float = 5.0
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    gnss: GnssConfig = field(default_factory=GnssConfig)
    lora: LoRaConfig = field(default_factory=LoRaConfig)
    bluetooth: BluetoothConfig = field(default_factory=BluetoothConfig)
    oled: OledConfig = field(default_factory=OledConfig)
    base_station: BaseStationProfileConfig = field(default_factory=BaseStationProfileConfig)
    config_path: Path | None = None


def _default_device_id() -> str:
    return socket.gethostname() or "ROVER-PI4"


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
    cfg.device_id = os.getenv("ROVER_DEVICE_ID", cfg.device_id)
    cfg.update_hz = _env_float("ROVER_UPDATE_HZ", cfg.update_hz)

    cfg.gnss.enabled = _env_bool("ROVER_GNSS_ENABLED", cfg.gnss.enabled)
    cfg.gnss.simulate_without_hardware = _env_bool(
        "ROVER_GNSS_SIMULATE",
        cfg.gnss.simulate_without_hardware,
    )
    cfg.gnss.serial_port = os.getenv("ROVER_GNSS_PORT", cfg.gnss.serial_port)
    cfg.gnss.baudrate = _env_int("ROVER_GNSS_BAUD", cfg.gnss.baudrate)

    cfg.lora.enabled = _env_bool("ROVER_LORA_ENABLED", cfg.lora.enabled)
    cfg.lora.transport = os.getenv("ROVER_LORA_TRANSPORT", cfg.lora.transport)
    cfg.lora.serial_port = os.getenv("ROVER_LORA_PORT", cfg.lora.serial_port)
    cfg.lora.baudrate = _env_int("ROVER_LORA_BAUD", cfg.lora.baudrate)
    cfg.lora.frequency_mhz = _env_float("ROVER_LORA_FREQ_MHZ", cfg.lora.frequency_mhz)
    cfg.lora.spi_bus_id = _env_int("ROVER_LORA_SPI_BUS_ID", cfg.lora.spi_bus_id)
    cfg.lora.spi_cs_id = _env_int("ROVER_LORA_SPI_CS_ID", cfg.lora.spi_cs_id)
    cfg.lora.reset_pin = _env_int("ROVER_LORA_RESET_PIN", cfg.lora.reset_pin)
    cfg.lora.busy_pin = _env_int("ROVER_LORA_BUSY_PIN", cfg.lora.busy_pin)
    cfg.lora.irq_pin = _env_int("ROVER_LORA_IRQ_PIN", cfg.lora.irq_pin)
    cfg.lora.txen_pin = _env_int("ROVER_LORA_TXEN_PIN", cfg.lora.txen_pin)
    cfg.lora.rxen_pin = _env_int("ROVER_LORA_RXEN_PIN", cfg.lora.rxen_pin)
    cfg.lora.uart_hat_auto_config = _env_bool(
        "ROVER_LORA_UART_HAT_AUTO_CONFIG", cfg.lora.uart_hat_auto_config
    )
    cfg.lora.uart_hat_m0_pin = _env_int(
        "ROVER_LORA_UART_HAT_M0_PIN", cfg.lora.uart_hat_m0_pin
    )
    cfg.lora.uart_hat_m1_pin = _env_int(
        "ROVER_LORA_UART_HAT_M1_PIN", cfg.lora.uart_hat_m1_pin
    )
    cfg.lora.uart_hat_address = _env_int(
        "ROVER_LORA_UART_HAT_ADDRESS", cfg.lora.uart_hat_address
    )
    cfg.lora.uart_hat_air_speed = _env_int(
        "ROVER_LORA_UART_HAT_AIR_SPEED", cfg.lora.uart_hat_air_speed
    )
    cfg.lora.uart_hat_buffer_size = _env_int(
        "ROVER_LORA_UART_HAT_BUFFER_SIZE", cfg.lora.uart_hat_buffer_size
    )
    cfg.lora.uart_hat_persist = _env_bool(
        "ROVER_LORA_UART_HAT_PERSIST", cfg.lora.uart_hat_persist
    )

    cfg.bluetooth.enabled = _env_bool("ROVER_BT_ENABLED", cfg.bluetooth.enabled)
    cfg.bluetooth.service_name = os.getenv("ROVER_BT_NAME", cfg.bluetooth.service_name)
    cfg.bluetooth.service_uuid = os.getenv("ROVER_BT_UUID", cfg.bluetooth.service_uuid)
    cfg.bluetooth.channel = _env_int("ROVER_BT_CHANNEL", cfg.bluetooth.channel)
    cfg.bluetooth.broadcast_hz = _env_float("ROVER_BT_HZ", cfg.bluetooth.broadcast_hz)

    cfg.oled.enabled = _env_bool("ROVER_OLED_ENABLED", cfg.oled.enabled)
    cfg.oled.logo_path = os.getenv("ROVER_OLED_LOGO", cfg.oled.logo_path)
    cfg.oled.i2c_address = _env_int("ROVER_OLED_ADDR", cfg.oled.i2c_address)

    cfg.logging.level = os.getenv("ROVER_LOG_LEVEL", cfg.logging.level)
    cfg.logging.file_path = os.getenv("ROVER_LOG_PATH", cfg.logging.file_path)


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
