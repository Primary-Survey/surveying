set -e
echo '=== identity ==='
hostname
ip -brief addr | sed -n '1,5p'
echo '=== serial devices ==='
ls -l /dev/ttyS* /dev/ttyAMA* /dev/serial* /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true
echo '=== base service tail ==='
journalctl -u rtk-base -n 60 --no-pager || true
echo '=== gpioinfo 22/27 ==='
sudo gpioinfo | grep -E 'line +22:|line +27:' || true
