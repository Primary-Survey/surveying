set -euo pipefail
sudo /opt/rtk-rover/.venv/bin/python - <<'PY'
import yaml
from pathlib import Path

p = Path('/opt/rtk-rover/config/rover.yaml')
data = yaml.safe_load(p.read_text()) or {}
lora = data.setdefault('lora', {})

lora['transport'] = 'sx126x_spi'

lora.setdefault('spi_bus_id', 0)
lora.setdefault('spi_cs_id', 0)
lora.setdefault('reset_pin', 18)
lora.setdefault('busy_pin', 20)
lora.setdefault('irq_pin', 16)
lora.setdefault('txen_pin', 6)
lora.setdefault('rxen_pin', -1)

lora.setdefault('tx_power_dbm', 22)
lora.setdefault('sync_word', 0x3444)
lora.setdefault('spreading_factor', 7)
lora.setdefault('bandwidth_hz', 125000)
lora.setdefault('coding_rate', 5)
lora.setdefault('preamble_length', 12)
lora.setdefault('crc_enabled', True)

p.write_text(yaml.safe_dump(data, sort_keys=False))
print('patched', p)
PY

sudo systemctl restart rtk-rover.service
sudo systemctl is-active rtk-rover.service