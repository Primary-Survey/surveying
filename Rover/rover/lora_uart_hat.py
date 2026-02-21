from __future__ import annotations

import logging
import time

try:
    import serial
except Exception:  # pragma: no cover
    serial = None

try:
    import RPi.GPIO as GPIO
except Exception:  # pragma: no cover
    GPIO = None


_AIR_SPEED_CODE = {
    1200: 0x01,
    2400: 0x02,
    4800: 0x03,
    9600: 0x04,
    19200: 0x05,
    38400: 0x06,
    62500: 0x07,
}

_BUFFER_SIZE_CODE = {
    240: 0x00,
    128: 0x40,
    64: 0x80,
    32: 0xC0,
}

_TX_POWER_CODE = {
    22: 0x00,
    17: 0x01,
    13: 0x02,
    10: 0x03,
}


def _clamp_channel(freq_mhz: float) -> tuple[int, int]:
    base = 850 if float(freq_mhz) >= 850 else 410
    channel = int(round(float(freq_mhz) - base))
    channel = max(0, min(83, channel))
    return base, channel


def configure_sx126x_uart_hat(
    *,
    serial_port: str,
    frequency_mhz: float,
    network_id: int,
    tx_power_dbm: int,
    m0_pin: int,
    m1_pin: int,
    address: int,
    air_speed: int,
    buffer_size: int,
    persist: bool,
    logger: logging.Logger,
    attempts: int = 3,
) -> bool:
    """
    Configure Waveshare SX1262 UART HAT for transparent mode.

    The board is configured using the vendor command frame:
    [C0/C2, 00, 09, ADDH, ADDL, NETID, SERIAL, OPTION, CHANNEL, TXMODE, CRYPTH, CRYPTL]
    """
    if serial is None:
        logger.warning("UART HAT config skipped: pyserial is not installed")
        return False
    if GPIO is None:
        logger.warning("UART HAT config skipped: RPi.GPIO is not installed")
        return False

    air_code = _AIR_SPEED_CODE.get(int(air_speed), _AIR_SPEED_CODE[2400])
    if int(air_speed) not in _AIR_SPEED_CODE:
        logger.warning("Unsupported LoRa air speed %s, falling back to 2400", air_speed)

    buffer_code = _BUFFER_SIZE_CODE.get(int(buffer_size), _BUFFER_SIZE_CODE[240])
    if int(buffer_size) not in _BUFFER_SIZE_CODE:
        logger.warning("Unsupported LoRa buffer size %s, falling back to 240", buffer_size)

    power_code = _TX_POWER_CODE.get(int(tx_power_dbm), _TX_POWER_CODE[22])
    if int(tx_power_dbm) not in _TX_POWER_CODE:
        logger.warning("Unsupported LoRa TX power %s, falling back to 22dBm", tx_power_dbm)

    base_mhz, channel = _clamp_channel(float(frequency_mhz))
    addh = (int(address) >> 8) & 0xFF
    addl = int(address) & 0xFF
    header = 0xC0 if bool(persist) else 0xC2
    serial_cfg = 0x60 + air_code  # UART 9600 + LoRa air data rate
    option_cfg = buffer_code + power_code + 0x20  # keep noise RSSI enabled
    tx_mode_cfg = 0x03  # transparent transmission mode

    frame = bytes(
        [
            header,
            0x00,
            0x09,
            addh,
            addl,
            int(network_id) & 0xFF,
            serial_cfg,
            option_cfg,
            channel,
            tx_mode_cfg,
            0x00,
            0x00,
        ]
    )

    ser = None
    try:
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        GPIO.setup(int(m0_pin), GPIO.OUT)
        GPIO.setup(int(m1_pin), GPIO.OUT)

        # Enter configuration mode (M0=0, M1=1).
        GPIO.output(int(m0_pin), GPIO.LOW)
        GPIO.output(int(m1_pin), GPIO.HIGH)
        time.sleep(0.15)

        ser = serial.Serial(
            port=serial_port,
            baudrate=9600,
            timeout=0.5,
            write_timeout=0.5,
        )
        ser.reset_input_buffer()
        ser.reset_output_buffer()

        max_attempts = max(int(attempts), 1)
        for i in range(max_attempts):
            ser.write(frame)
            ser.flush()
            time.sleep(0.25)
            ack = ser.read(64)
            if len(ack) >= 3 and ack[0] == 0xC1 and ack[1] == 0x00 and ack[2] == 0x09:
                logger.info(
                    "UART HAT configured: %.3fMHz (base=%d + ch=%d), net=%d, addr=%d",
                    float(frequency_mhz),
                    base_mhz,
                    channel,
                    int(network_id) & 0xFF,
                    int(address) & 0xFFFF,
                )
                return True
            if ack:
                logger.warning("UART HAT config ACK mismatch (attempt %d): %s", i + 1, ack.hex())

        logger.warning(
            "UART HAT config got no ACK on %s. Check jumper set to B and remove M0/M1 jumpers.",
            serial_port,
        )
        return False
    except Exception as exc:
        logger.warning("UART HAT config failed: %s", exc)
        return False
    finally:
        # Return to normal mode (M0=0, M1=0).
        try:
            if GPIO is not None:
                GPIO.output(int(m0_pin), GPIO.LOW)
                GPIO.output(int(m1_pin), GPIO.LOW)
        except Exception:
            pass
        try:
            if ser is not None:
                ser.close()
        except Exception:
            pass
