set -e
sudo systemctl stop rtk-rover
sleep 1
python3 - <<'PY'
import serial, time, binascii
port='/dev/ttyS0'
baud=9600
s=serial.Serial(port=port, baudrate=baud, timeout=0.2)
start=time.time()
count=0
chunks=[]
while time.time()-start < 10:
    b=s.read(256)
    if b:
        count += len(b)
        if len(chunks) < 8:
            chunks.append(b)
s.close()
print('bytes',count)
for i,c in enumerate(chunks):
    print(i, len(c), binascii.hexlify(c[:32]).decode())
PY
sudo systemctl start rtk-rover
