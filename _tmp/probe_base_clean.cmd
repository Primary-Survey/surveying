sudo systemctl stop rtk-base
profiles="
waveshare_cs0 0 0 18 20 16 6 -1
waveshare_cs1 0 1 18 20 16 6 -1
default_cs0 0 0 22 23 -1 -1 -1
default_cs1 0 1 22 23 -1 -1 -1
alt_busy23_cs0 0 0 18 23 16 6 -1
alt_busy23_cs1 0 1 18 23 16 6 -1
alt_irq26_cs0 0 0 18 20 26 6 -1
alt_irq26_cs1 0 1 18 20 26 6 -1
"

while read -r name bus cs rst busy irq txen rxen; do
  [ -z "$name" ] && continue
  echo "=== $name ==="
  /opt/rtk-base/.venv/bin/python - <<PY
from LoRaRF import SX126x
import traceback
name="$name"
bus=$bus
cs=$cs
rst=$rst
busy=$busy
irq=$irq
txen=$txen
rxen=$rxen
l=None
try:
    l=SX126x()
    ok=l.begin(bus,cs,rst,busy,irq,txen,rxen)
    print("begin:", ok)
    if ok:
        try:
            print("mode:", hex(l.getMode()))
            print("status:", hex(l.getStatus()))
        except Exception as e:
            print("status error:", repr(e))
except Exception as e:
    print("exception:", repr(e))
finally:
    try:
        if l is not None:
            l.end()
    except Exception as e:
        print("end err:", repr(e))
PY
done <<EOF
$profiles
EOF

sudo systemctl start rtk-base
