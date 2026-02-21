from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

from rover.config import OledConfig
from rover.models import RoverState

try:
    from luma.core.interface.serial import i2c
    from luma.oled.device import sh1106
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover
    i2c = None
    sh1106 = None
    Image = None
    ImageDraw = None
    ImageFont = None


@dataclass
class OledDisplay:
    cfg: OledConfig
    logger: logging.Logger
    root_path: Path

    def __post_init__(self) -> None:
        self._device = None
        self._enabled = self.cfg.enabled
        self._font = None

    @property
    def enabled(self) -> bool:
        return self._enabled

    def start(self) -> None:
        if not self._enabled:
            return
        if i2c is None or sh1106 is None or Image is None or ImageDraw is None:
            self.logger.warning("OLED dependencies missing, display disabled")
            self._enabled = False
            return
        try:
            serial_iface = i2c(
                port=self.cfg.i2c_port,
                address=int(self.cfg.i2c_address),
            )
            self._device = sh1106(serial_iface, rotate=self.cfg.rotate)
            self._font = ImageFont.load_default() if ImageFont is not None else None
        except Exception as exc:
            self.logger.warning("OLED init failed: %s", exc)
            self._enabled = False
            self._device = None

    def stop(self) -> None:
        if not self._enabled:
            return
        self.clear()

    def clear(self) -> None:
        if not self._enabled or self._device is None:
            return
        blank = Image.new("1", (self.cfg.width, self.cfg.height), 0)
        self._device.display(blank)

    def show_boot(self, device_id: str) -> None:
        if not self._enabled or self._device is None:
            return
        logo_path = (self.root_path / self.cfg.logo_path).resolve()
        image = Image.new("1", (self.cfg.width, self.cfg.height), 0)
        draw = ImageDraw.Draw(image)
        if logo_path.exists():
            try:
                logo = Image.open(logo_path).convert("1")
                logo.thumbnail((self.cfg.width, 42))
                x = (self.cfg.width - logo.width) // 2
                y = 0
                image.paste(logo, (x, y))
            except Exception:
                draw.text((0, 0), "RTK Rover", fill=255, font=self._font)
        else:
            draw.text((0, 0), "RTK Rover", fill=255, font=self._font)
        draw.text((0, 46), f"Booting {device_id}", fill=255, font=self._font)
        self._device.display(image)

    def show_error(self, message: str) -> None:
        if not self._enabled:
            return
        self._draw_lines(["ERROR", message[:20], message[20:40], message[40:60]])

    def show_status(self, state: RoverState) -> None:
        if not self._enabled:
            return
        fix = state.fix
        q = fix.quality if fix else "no-fix"
        sats = fix.satellites if fix and fix.satellites is not None else 0
        lat = f"{fix.lat:.6f}" if fix else "--"
        lng = f"{fix.lng:.6f}" if fix else "--"
        lora = "OK" if state.lora_connected else "NO"
        bt = "OK" if state.bluetooth_connected else "NO"
        gnss = "OK" if state.gnss_connected else "NO"
        warning = state.warnings[0] if state.warnings else ""
        lines = [
            f"{state.device_id[:12]}",
            f"Fix:{q} Sat:{sats}",
            f"Lat:{lat}",
            f"Lng:{lng}",
            f"GN:{gnss} LO:{lora} BT:{bt}",
            warning[:20] if warning else "",
        ]
        self._draw_lines(lines)

    def _draw_lines(self, lines: list[str]) -> None:
        if not self._enabled or self._device is None:
            return
        image = Image.new("1", (self.cfg.width, self.cfg.height), 0)
        draw = ImageDraw.Draw(image)
        y = 0
        for line in lines[:6]:
            draw.text((0, y), line, fill=255, font=self._font)
            y += 10
        self._device.display(image)
