#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install_base.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="/opt/rtk-base"
SERVICE_NAME="rtk-base.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
SERVICE_USER="${SUDO_USER:-pi}"
NEEDS_REBOOT=0

echo "[1/7] Installing OS dependencies..."
apt-get update
apt-get install -y \
  python3-venv \
  python3-pip \
  python3-dev \
  python3-spidev \
  python3-rpi-lgpio \
  rsync

if command -v raspi-config >/dev/null 2>&1; then
  echo "[2/7] Enabling Raspberry Pi interfaces (SPI + UART)..."
  raspi-config nonint do_spi 0 || true
  raspi-config nonint do_serial_hw 0 || true
  raspi-config nonint do_serial 1 || true  # disable serial console/login shell
  NEEDS_REBOOT=1
else
  echo "[2/7] raspi-config not found, skipping interface auto-config."
fi

# Best-effort config.txt/cmdline.txt tweaks for images without raspi-config.
if [[ -f /boot/firmware/config.txt ]]; then
  if grep -q '^#dtparam=spi=on' /boot/firmware/config.txt; then
    sed -i 's/^#dtparam=spi=on/dtparam=spi=on/' /boot/firmware/config.txt
    NEEDS_REBOOT=1
  fi
  if ! grep -q '^dtoverlay=uart1$' /boot/firmware/config.txt; then
    # Map UART1 (ttyS0) to GPIO14/15. Needed for transparent UART LoRa radios.
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

echo "[3/7] Syncing project to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
rsync -a --delete \
  --exclude ".git" \
  --exclude "__pycache__" \
  --exclude "config/base.yaml" \
  --exclude "config/logs/" \
  "${SOURCE_DIR}/" "${INSTALL_DIR}/"

echo "[4/7] Creating Python virtualenv..."
python3 -m venv --system-site-packages "${INSTALL_DIR}/.venv"
"${INSTALL_DIR}/.venv/bin/pip" install --upgrade pip wheel
"${INSTALL_DIR}/.venv/bin/pip" install -r "${INSTALL_DIR}/requirements.txt"
# Waveshare SX126x HAT uses the LoRaRF library. Install without deps so we
# keep using the OS-provided spidev + RPi.GPIO shim (python3-rpi-lgpio).
"${INSTALL_DIR}/.venv/bin/pip" install --no-deps "LoRaRF==1.4.0" || true

echo "[5/7] Preparing config..."
mkdir -p "${INSTALL_DIR}/config"
if [[ ! -f "${INSTALL_DIR}/config/base.yaml" ]]; then
  cp "${INSTALL_DIR}/config/base.example.yaml" "${INSTALL_DIR}/config/base.yaml"
fi

echo "[6/7] Installing systemd service..."
cp "${INSTALL_DIR}/systemd/${SERVICE_NAME}" "${SERVICE_PATH}"
sed -i "s/^User=.*/User=${SERVICE_USER}/" "${SERVICE_PATH}"
sed -i "s/^Group=.*/Group=${SERVICE_USER}/" "${SERVICE_PATH}"

echo "[7/7] Enabling service + dialout group..."
usermod -a -G dialout "${SERVICE_USER}" || true
# If LoRa is on /dev/ttyS0, the serial login getty will conflict with the radio.
systemctl disable --now serial-getty@ttyS0.service || true
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo
echo "RTK base station service installed."
echo "Edit config: ${INSTALL_DIR}/config/base.yaml"
echo "Logs: journalctl -u ${SERVICE_NAME} -f"
echo "Status: systemctl status ${SERVICE_NAME}"
if [[ "${NEEDS_REBOOT}" -eq 1 ]]; then
  echo
  echo "NOTE: SPI/UART changes were applied. Reboot the Pi to ensure they take effect."
fi
