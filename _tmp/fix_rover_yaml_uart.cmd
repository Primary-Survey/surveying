python3 - <<'PY'
from pathlib import Path
import yaml
p = Path('/opt/rtk-rover/config/rover.yaml')
data = yaml.safe_load(p.read_text())
lora = data.setdefault('lora', {})
bs = data.get('base_station', {}) if isinstance(data.get('base_station'), dict) else {}
# Move misplaced keys from base_station into lora if present.
for k in [
    'uart_hat_auto_config',
    'uart_hat_m0_pin',
    'uart_hat_m1_pin',
    'uart_hat_address',
    'uart_hat_air_speed',
    'uart_hat_buffer_size',
    'uart_hat_persist',
]:
    if k in bs and k not in lora:
        lora[k] = bs.pop(k)
# Force desired values for UART HAT testing.
lora['uart_hat_auto_config'] = True
lora.setdefault('uart_hat_m0_pin', 22)
lora.setdefault('uart_hat_m1_pin', 27)
lora.setdefault('uart_hat_address', 65535)
lora.setdefault('uart_hat_air_speed', 2400)
lora.setdefault('uart_hat_buffer_size', 240)
lora.setdefault('uart_hat_persist', True)
if isinstance(data.get('base_station'), dict):
    data['base_station'] = bs
p.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
PY
sudo systemctl restart rtk-rover
sleep 3
journalctl -u rtk-rover -n 60 --no-pager
