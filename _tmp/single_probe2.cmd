sudo systemctl stop rtk-base
sleep 1
sudo gpioinfo | grep -E 'line +6:|line +16:|line +18:|line +20:|line +21:|line +22:|line +23:'
/opt/rtk-base/.venv/bin/python - <<'PY'
from LoRaRF import SX126x
l=SX126x()
print('try begin')
ok=l.begin(0,0,18,20,16,6,-1)
print('ok',ok)
try:
    print('mode',hex(l.getMode()))
except Exception as e:
    print('mode err',repr(e))
try:
    l.end()
except Exception as e:
    print('end err',repr(e))
PY
sudo systemctl start rtk-base
