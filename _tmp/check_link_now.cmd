journalctl -u rtk-base -n 80 --no-pager | grep '"'"'Status:'"'"' || true
journalctl -u rtk-rover -n 120 --no-pager | grep '"'"'LoRa heartbeat RX'"'"' || true
journalctl -u rtk-rover -n 120 --no-pager | grep '"'"'LoRa correction RX'"'"' || true
