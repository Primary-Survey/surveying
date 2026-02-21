sudo systemctl stop rtk-base
sleep 1
/opt/rtk-base/.venv/bin/python - <<'PY'
import RPi.GPIO as GPIO
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)
for p,mode in [(6,GPIO.OUT),(16,GPIO.IN),(18,GPIO.OUT),(20,GPIO.IN),(21,GPIO.OUT),(22,GPIO.OUT),(23,GPIO.IN),(25,GPIO.IN),(26,GPIO.IN)]:
    try:
        GPIO.setup(p, mode)
        print(p, 'OK')
    except Exception as e:
        print(p, 'ERR', repr(e))
try:
    GPIO.cleanup()
except Exception as e:
    print('cleanup ERR', repr(e))
PY
sudo systemctl start rtk-base
