/opt/rtk-base/.venv/bin/python - <<'PY'
import traceback
import RPi.GPIO as GPIO
from LoRaRF import SX126x

profiles = [
    ("waveshare_cs0", 0,0,18,20,16,6,-1),
    ("waveshare_cs1", 0,1,18,20,16,6,-1),
    ("default_cs0", 0,0,22,23,-1,-1,-1),
    ("default_cs1", 0,1,22,23,-1,-1,-1),
    ("alt_busy23_cs0", 0,0,18,23,16,6,-1),
    ("alt_busy23_cs1", 0,1,18,23,16,6,-1),
    ("alt_irq26_cs0", 0,0,18,20,26,6,-1),
    ("alt_irq26_cs1", 0,1,18,20,26,6,-1),
]

for name,bus,cs,rst,busy,irq,txen,rxen in profiles:
    print("===", name, "===")
    try:
        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        GPIO.setup(busy, GPIO.IN)
        print("busy pre:", GPIO.input(busy))
    except Exception as e:
        print("busy pre read err:", e)
    l=None
    try:
        l = SX126x()
        ok = l.begin(bus,cs,rst,busy,irq,txen,rxen)
        print("begin:", ok)
        if ok:
            try:
                st = l.getStatus()
                print("status:", hex(st))
            except Exception as e:
                print("getStatus err:", e)
    except Exception as e:
        print("exception:", repr(e))
        traceback.print_exc(limit=1)
    finally:
        try:
            if l is not None:
                l.end()
        except Exception as e:
            print("end err:", e)
        try:
            GPIO.cleanup()
        except Exception:
            pass
print("done")
PY
