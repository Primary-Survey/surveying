#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install_rover.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="/opt/rtk-rover"
SERVICE_NAME="rtk-rover.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
AGENT_SERVICE_NAME="rtk-bt-agent.service"
AGENT_SERVICE_PATH="/etc/systemd/system/${AGENT_SERVICE_NAME}"
SERVICE_USER="${SUDO_USER:-pi}"
NEEDS_REBOOT=0

echo "[1/8] Installing OS dependencies..."
apt-get update
apt-get install -y \
  python3-venv \
  python3-pip \
  python3-dev \
  python3-spidev \
  python3-rpi-lgpio \
  libbluetooth-dev \
  rfkill \
  bluetooth \
  bluez \
  bluez-tools \
  i2c-tools \
  rsync

echo "[2/8] Configuring Bluetooth (compat + auto-enable)..."
# Modern BlueZ disables legacy SDP helpers by default. `sdptool add ...` requires
# bluetoothd "compat" mode (`-C`) so Android can discover the RFCOMM channel via SDP.
BT_BIN="$(command -v bluetoothd || true)"
if [[ -z "${BT_BIN}" || ! -x "${BT_BIN}" ]]; then
  for cand in /usr/libexec/bluetooth/bluetoothd /usr/lib/bluetooth/bluetoothd; do
    if [[ -x "${cand}" ]]; then
      BT_BIN="${cand}"
      break
    fi
  done
fi

if [[ -n "${BT_BIN}" && -x "${BT_BIN}" ]]; then
  mkdir -p /etc/systemd/system/bluetooth.service.d
  cat > /etc/systemd/system/bluetooth.service.d/override.conf <<EOF
[Service]
ExecStart=
ExecStart=${BT_BIN} -C
EOF
  systemctl daemon-reload
  systemctl restart bluetooth || true
else
  echo "bluetoothd not found; skipping compat override."
fi

# Keep the controller powered after boot.
if [[ -f /etc/bluetooth/main.conf ]]; then
  if grep -q '^AutoEnable=' /etc/bluetooth/main.conf; then
    sed -i 's/^AutoEnable=.*/AutoEnable=true/' /etc/bluetooth/main.conf
  else
    echo 'AutoEnable=true' >> /etc/bluetooth/main.conf
  fi
fi
systemctl restart bluetooth || true

if command -v raspi-config >/dev/null 2>&1; then
  echo "[3/8] Enabling Raspberry Pi interfaces (I2C + SPI + UART)..."
  raspi-config nonint do_i2c 0 || true
  raspi-config nonint do_spi 0 || true
  raspi-config nonint do_serial_hw 0 || true
  raspi-config nonint do_serial 1 || true  # disable serial console/login shell
  NEEDS_REBOOT=1
else
  echo "[3/8] raspi-config not found, skipping interface auto-config."
fi

# Best-effort config.txt/cmdline.txt tweaks for images without raspi-config.
if [[ -f /boot/firmware/config.txt ]]; then
  if grep -q '^#dtparam=spi=on' /boot/firmware/config.txt; then
    sed -i 's/^#dtparam=spi=on/dtparam=spi=on/' /boot/firmware/config.txt
    NEEDS_REBOOT=1
  fi
  if ! grep -q '^dtoverlay=uart1$' /boot/firmware/config.txt; then
    sed -i '/^enable_uart=1$/a dtoverlay=uart1' /boot/firmware/config.txt || true
    NEEDS_REBOOT=1
  fi
fi
if [[ -f /boot/firmware/cmdline.txt ]]; then
  if grep -q 'console=serial0,115200' /boot/firmware/cmdline.txt; then
    sed -i 's/console=serial0,115200 //' /boot/firmware/cmdline.txt
    NEEDS_REBOOT=1
  fi
fi

echo "[4/8] Syncing project to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "__pycache__" \
  --exclude "config/rover.yaml" \
  --exclude "config/logs/" \
  "${SOURCE_DIR}/" "${INSTALL_DIR}/"

echo "[5/8] Creating Python virtualenv..."
python3 -m venv --system-site-packages "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade pip wheel
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"
"${INSTALL_DIR}/.venv/bin/pip" install --no-deps "LoRaRF==1.4.0" || true

echo "[6/8] Preparing config..."
if [[ ! -f "${INSTALL_DIR}/config/rover.yaml" ]]; then
  cp "${INSTALL_DIR}/config/rover.example.yaml" "${INSTALL_DIR}/config/rover.yaml"
fi

echo "[7/8] Installing systemd service..."
cp "${INSTALL_DIR}/systemd/${SERVICE_NAME}" "${SERVICE_PATH}"
sed -i "s/^User=.*/User=${SERVICE_USER}/" "${SERVICE_PATH}"
sed -i "s/^Group=.*/Group=${SERVICE_USER}/" "${SERVICE_PATH}"
cp "${INSTALL_DIR}/systemd/${AGENT_SERVICE_NAME}" "${AGENT_SERVICE_PATH}"

echo "[8/8] Enabling service + serial/i2c/bluetooth groups..."
usermod -a -G dialout,i2c,bluetooth "${SERVICE_USER}" || true
systemctl daemon-reload
systemctl enable --now "${AGENT_SERVICE_NAME}" "${SERVICE_NAME}"

echo
echo "RTK rover service installed."
echo "Edit config: ${INSTALL_DIR}/config/rover.yaml"
echo "Logs: journalctl -u ${SERVICE_NAME} -f"
echo "Status: systemctl status ${SERVICE_NAME}"
if [[ "${NEEDS_REBOOT}" -eq 1 ]]; then
  echo
  echo "NOTE: SPI/UART changes were applied. Reboot the Pi to ensure they take effect."
fi
