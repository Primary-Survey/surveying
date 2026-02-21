set -e
PORT='/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0'
sudo python3 - <<'PY'
from pathlib import Path
import yaml
p = Path('/opt/rtk-base/config/base.yaml')
obj = yaml.safe_load(p.read_text())
obj.setdefault('lora', {})['serial_port'] = '/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0'
p.write_text(yaml.safe_dump(obj, sort_keys=False), encoding='utf-8')
PY
sudo systemctl restart rtk-base
sleep 3
journalctl -u rtk-base -n 60 --no-pager
