# RTK Rover (Raspberry Pi 4)

This folder contains the rover runtime for:

- GNSS position intake (serial, with simulation fallback)
- LoRa correction stream intake (913 MHz profile variables included)
- Bluetooth telemetry broadcast to the mobile app
- Optional 128x64 1.3" OLED status screen (disabled by default)

## Telemetry format sent to mobile

Each Bluetooth line is one JSON object:

```json
{
  "type": "rover.telemetry.v1",
  "timestamp_utc": "2026-02-13T02:00:00Z",
  "rover": {
    "device_id": "ROVER-PI4-01",
    "gnss_connected": true,
    "lora_connected": true,
    "bluetooth_connected": true,
    "bluetooth_client": "AA:BB:CC:DD:EE:FF",
    "lora_bytes_rx": 2048,
    "last_correction_utc": "2026-02-13T01:59:59Z"
  },
  "fix": {
    "timestamp_utc": "2026-02-13T02:00:00Z",
    "lat": 35.123456,
    "lng": -97.123456,
    "quality": "rtk-fixed",
    "accuracy_m": 0.02,
    "hdop": 0.4,
    "satellites": 18,
    "correction_age_s": 1.2
  },
  "warnings": [],
  "error": null
}
```

## Configure

1. Copy `config/rover.example.yaml` to `config/rover.yaml`.
1. Set your serial ports:
   - GNSS: usually `/dev/ttyACM0` or `/dev/serial0`
   - LoRa HAT: depends on your hat wiring, often `/dev/ttyS0` or `/dev/serial0`
1. Set `device_id` and keep LoRa/base profile values aligned with your base station.
1. Use `config/lora_profile.md` to keep both 913 MHz radios on the same profile.
1. Put your OLED boot logo at `assets/logo.png` (optional).

## Install on Pi

Run this on the Raspberry Pi:

```bash
cd Rover
sudo bash scripts/install_rover.sh
```

If you want to push from your Windows PC over SSH:

```powershell
pwsh Rover/scripts/deploy_to_pi.ps1 -HostName raspberrypi.local -User primary
```

## Run manually

```bash
cd Rover
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m rover.main --config config/rover.example.yaml --simulate
```

## Service commands

```bash
sudo systemctl status rtk-rover.service
sudo journalctl -u rtk-rover.service -f
sudo systemctl restart rtk-rover.service
```

## Notes

- `--simulate` lets you test full app + Bluetooth before GNSS is installed.
- LoRa module is treated as a transparent serial correction link.
- GNSS correction bytes received over LoRa are forwarded directly into the GNSS serial port.
- Bluetooth server uses BlueZ + RFCOMM sockets; it will attempt to register SPP via `sdptool`.
