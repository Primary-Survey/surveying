set -e
sudo cp /opt/rtk-base/config/base.yaml /opt/rtk-base/config/base.yaml.bak.$(date +%s)
sudo awk '
  {print}
' /opt/rtk-base/config/base.yaml > /tmp/base.yaml.tmp
sudo sed -i 's/^  transport: .*/  transport: serial/' /opt/rtk-base/config/base.yaml
sudo systemctl restart rtk-base
sleep 2
journalctl -u rtk-base -n 60 --no-pager
