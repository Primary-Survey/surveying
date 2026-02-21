set -e
sudo sed -i 's/^  uart_hat_auto_config: .*/  uart_hat_auto_config: true/' /opt/rtk-rover/config/rover.yaml
sudo systemctl restart rtk-rover
sleep 3
journalctl -u rtk-rover -n 60 --no-pager
