sudo systemctl stop rtk-base
sleep 1
raspi-gpio get 6,16,18,20,21,22,23
sudo gpioinfo | grep -E 'line +6:|line +16:|line +18:|line +20:|line +21:|line +22:|line +23:'
sudo systemctl start rtk-base
