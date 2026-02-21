set -e
cd /home/primary/rtk-base-src/Base
sudo bash scripts/install_base.sh
sudo sed -i 's/^  transport: .*/  transport: serial/' /opt/rtk-base/config/base.yaml
if ! grep -q '^  uart_hat_auto_config:' /opt/rtk-base/config/base.yaml; then
  cat <<'EOF' | sudo tee -a /opt/rtk-base/config/base.yaml >/dev/null
  uart_hat_auto_config: true
  uart_hat_m0_pin: 22
  uart_hat_m1_pin: 27
  uart_hat_address: 65535
  uart_hat_air_speed: 2400
  uart_hat_buffer_size: 240
  uart_hat_persist: true
EOF
fi
sudo systemctl restart rtk-base
sleep 3
journalctl -u rtk-base -n 80 --no-pager
