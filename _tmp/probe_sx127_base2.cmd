sudo systemctl stop rtk-base
sleep 1
/opt/rtk-base/.venv/bin/python - <<'PY'
from LoRaRF import SX127x
import RPi.GPIO as GPIO
cases=[('sx127_cs0',0,0,22,-1,-1),('sx127_cs1',0,1,22,-1,-1),('sx127_ws_cs0',0,0,18,16,6),('sx127_ws_cs1',0,1,18,16,6)]
for name,bus,cs,rst,irq,txen in cases:
    GPIO.setmode(GPIO.BCM)
    GPIO.setwarnings(False)
    l=SX127x()
    try:
        ok=l.begin(bus,cs,rst,irq,txen,-1)
        print(name,'begin',ok)
        try:
            print(name,'version',hex(l.readRegister(0x42)))
        except Exception as e:
            print(name,'read err',repr(e))
    except Exception as e:
        print(name,'err',repr(e))
    finally:
        try:
            l.end()
        except Exception as e:
            print(name,'end err',repr(e))
        try:
            GPIO.cleanup()
        except Exception:
            pass
PY
sudo systemctl start rtk-base
