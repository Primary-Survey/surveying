set -e
sudo systemctl stop rtk-base
/opt/rtk-base/.venv/bin/python - <<'PY'
import time
import serial
import RPi.GPIO as GPIO
M0=22
M1=27
GPIO.setmode(GPIO.BCM)
GPIO.setwarnings(False)
GPIO.setup(M0,GPIO.OUT)
GPIO.setup(M1,GPIO.OUT)
# Enter config mode M0=0, M1=1
GPIO.output(M0,GPIO.LOW)
GPIO.output(M1,GPIO.HIGH)
time.sleep(0.2)
ser=serial.Serial('/dev/ttyS0',9600,timeout=0.5)
ser.reset_input_buffer()
# C0 = save config; len=0x09
# addh,addl,netid,serial,power,channel,transmission,cryptH,cryptL
# serial=0x62 => UART9600 + air-rate2400
# power=0x00 (22dBm)
# channel=913-850=63 (0x3F)
# transmission=0x03 transparent mode
cfg=bytes([0xC0,0x00,0x09,0xFF,0xFF,0x00,0x62,0x00,0x3F,0x03,0x00,0x00])
for i in range(3):
    ser.write(cfg)
    ser.flush()
    time.sleep(0.3)
    resp=ser.read(64)
    print('attempt',i,'resp',resp.hex())
# Back to normal mode
GPIO.output(M0,GPIO.LOW)
GPIO.output(M1,GPIO.LOW)
time.sleep(0.1)
ser.close()
GPIO.cleanup()
PY
sudo systemctl start rtk-base
sleep 1
journalctl -u rtk-base -n 40 --no-pager
