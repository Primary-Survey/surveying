set -e
echo '=== rover serial inventory ==='
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/ttyS* /dev/ttyAMA* /dev/serial* 2>/dev/null || true
echo '=== rover by-id ==='
ls -l /dev/serial/by-id 2>/dev/null || true
echo '=== rover by-path ==='
ls -l /dev/serial/by-path 2>/dev/null || true
echo '=== rover service short tail ==='
journalctl -u rtk-rover -n 30 --no-pager
