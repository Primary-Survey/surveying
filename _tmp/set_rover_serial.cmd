set -e
sudo cp /opt/rtk-rover/config/rover.yaml /opt/rtk-rover/config/rover.yaml.bak.$(date +%s)
sudo sed -i 's/^  transport: .*/  transport: serial/' /opt/rtk-rover/config/rover.yaml
sudo systemctl restart rtk-rover
sleep 2
journalctl -u rtk-rover -n 80 --no-pager
