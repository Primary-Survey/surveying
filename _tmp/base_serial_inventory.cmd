set -e
echo '=== base serial inventory ==='
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/ttyS* /dev/ttyAMA* /dev/serial* 2>/dev/null || true
echo '=== base by-id ==='
ls -l /dev/serial/by-id 2>/dev/null || true
echo '=== base by-path ==='
ls -l /dev/serial/by-path 2>/dev/null || true
