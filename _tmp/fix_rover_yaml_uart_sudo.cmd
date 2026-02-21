sudo python3 - <<'PY'
from pathlib import Path
import yaml
p = Path('/opt/rtk-rover/config/rover.yaml')
data = yaml.safe_load(p.read_text())
lora = data.setdefault('lora', {})
bs = data.get('base_station', {}) if isinstance(data.get('base_station'), dict) else {}
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
lora['uart_hat_auto_config'] = True
lora['uart_hat_m0_pin'] = int(lora.get('uart_hat_m0_pin', 22))
lora['uart_hat_m1_pin'] = int(lora.get('uart_hat_m1_pin', 27))
lora['uart_hat_address'] = int(lora.get('uart_hat_address', 65535))
lora['uart_hat_air_speed'] = int(lora.get('uart_hat_air_speed', 2400))
lora['uart_hat_buffer_size'] = int(lora.get('uart_hat_buffer_size', 240))
lora['uart_hat_persist'] = bool(lora.get('uart_hat_persist', True))
if isinstance(data.get('base_station'), dict):
    data['base_station'] = bs
p.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
PY
sudo systemctl restart rtk-rover
sleep 3
journalctl -u rtk-rover -n 40 --no-pager
