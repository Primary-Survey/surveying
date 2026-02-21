sudo systemctl stop rtk-base
sleep 1
/opt/rtk-base/.venv/bin/python - <<'PY'
from LoRaRF import SX126x
import RPi.GPIO as GPIO

def test(name, bus, cs, rst, busy, irq, txen, rxen):
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    l=SX126x()
    l.busyCheck = lambda timeout=5000: False
    try:
        ok=l.begin(bus,cs,rst,busy,irq,txen,rxen)
        print(name, 'begin', ok)
        try:
            st=l.getStatus()
            md=l.getMode()
            print(name,'status',hex(st),'mode',hex(md))
        except Exception as e:
            print(name,'status_err',repr(e))
    except Exception as e:
        print(name,'err',repr(e))
    finally:
        try:
            l.end()
        except Exception as e:
            print(name,'end_err',repr(e))
        try:
            GPIO.cleanup()
        except Exception:
            pass

cases=[
('ws_cs0',0,0,18,20,16,6,-1),
('ws_cs1',0,1,18,20,16,6,-1),
('def_cs0',0,0,22,23,-1,-1,-1),
('def_cs1',0,1,22,23,-1,-1,-1),
]
for c in cases:
    test(*c)
PY
sudo systemctl start rtk-base
