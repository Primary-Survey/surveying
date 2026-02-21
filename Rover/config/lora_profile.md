# LoRa profile (rover/base alignment)

Set both LoRa radios to the same RF profile:

- Frequency: `913.0 MHz`
- Bandwidth: `125 kHz`
- Spreading factor: `7`
- Coding rate: `4/5`
- Network ID: `18`
- UART baud: `57600` (or matching your config)

The rover runtime assumes the LoRa HAT acts as a transparent serial pipe for RTCM bytes.
If your HAT requires explicit AT setup, apply the matching vendor commands first, then set:

- `lora.serial_port` in `config/rover.yaml`
- `lora.baudrate` in `config/rover.yaml`
- `lora.frequency_mhz` and `lora.network_id` in `config/rover.yaml`

