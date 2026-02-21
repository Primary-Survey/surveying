# RTK Base Station (Raspberry Pi 4)

This folder contains the base-station runtime for:

- GNSS correction source (serial, with simulation mode for early testing)
- LoRa correction transmit over a 913 MHz profile (transparent serial pipe)

The base station does not use an OLED screen and does not talk to the mobile app.
The mobile app validates the base link by reading rover telemetry (LoRa RX bytes and last correction time).

## What it sends

In `simulate` mode, the base station sends small "test correction" byte payloads over LoRa.
This lets you validate that the base and rover LoRa HATs are actually passing bytes end-to-end.

In `serial` mode, the base station reads raw bytes from a GNSS serial port (RTCM output) and forwards them to LoRa.

## Configure

1. Copy `config/base.example.yaml` to `config/base.yaml`.
1. Align LoRa settings with the rover:
   - `frequency_mhz: 913.0`
   - `network_id: 18`
   - UART baud: `57600` (or whatever your radio is set to)
1. If you have a GNSS base module outputting RTCM, set:
   - `corrections.mode: serial`
   - `corrections.serial_port` (usually `/dev/ttyACM0`)

See `Rover/config/lora_profile.md` for the shared profile notes.

## Install on Pi

Run this on the base Raspberry Pi:

```bash
cd Base
sudo bash scripts/install_base.sh
```

## Service commands

```bash
sudo systemctl status rtk-base.service
sudo journalctl -u rtk-base.service -f
sudo systemctl restart rtk-base.service
```

