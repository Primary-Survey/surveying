sudo systemctl stop rtk-base
sleep 1
profiles="
waveshare_cs0 0 0 18 20 16 6 -1
waveshare_cs1 0 1 18 20 16 6 -1
default_cs0 0 0 22 23 -1 -1 -1
default_cs1 0 1 22 23 -1 -1 -1
ws_txenminus1_cs0 0 0 18 20 16 -1 -1
"
while read -r name bus cs rst busy irq txen rxen; do
  [ -z "$name" ] && continue
  echo "=== $name ==="
  /opt/rtk-base/.venv/bin/python - <<PY
from LoRaRF import SX126x
import RPi.GPIO as GPIO
l=None
try:
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    GPIO.setup($busy, GPIO.IN)
    print('busy-pre', GPIO.input($busy))
except Exception as e:
    print('busy-pre-err', repr(e))
try:
    l=SX126x()
    ok=l.begin($bus,$cs,$rst,$busy,$irq,$txen,$rxen)
    print('begin',ok)
    if ok:
        try:
            print('mode',hex(l.getMode()))
            print('status',hex(l.getStatus()))
        except Exception as e:
            print('status-err',repr(e))
except Exception as e:
    print('err',repr(e))
finally:
    try:
        if l is not None:
            l.end()
    except Exception as e:
        print('end-err',repr(e))
    try:
        GPIO.cleanup()
    except Exception:
        pass
PY
done <<EOF
$profiles
EOF
sudo systemctl start rtk-base
