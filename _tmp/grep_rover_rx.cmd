journalctl -u rtk-rover -n 200 --no-pager | grep '"'"'LoRa correction RX'"'"' || true
journalctl -u rtk-rover -n 200 --no-pager | grep '"'"'LoRa heartbeat RX'"'"' || true
