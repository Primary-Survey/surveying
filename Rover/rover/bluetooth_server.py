from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
import threading
from dataclasses import dataclass
from typing import Any

from rover.config import BluetoothConfig
from rover.protocol import encode_message_line


@dataclass
class BluetoothTelemetryServer:
    cfg: BluetoothConfig
    logger: logging.Logger

    def __post_init__(self) -> None:
        self._running = False
        self._server_sock: Any = None
        self._client_sock: Any = None
        self._client_addr: str | None = None
        self._accept_thread: threading.Thread | None = None
        self._client_thread: threading.Thread | None = None
        self._client_lock = threading.Lock()
        self._last_command: dict[str, Any] | None = None

    @property
    def has_client(self) -> bool:
        return self._client_sock is not None

    @property
    def client_addr(self) -> str | None:
        return self._client_addr

    @property
    def last_command(self) -> dict[str, Any] | None:
        return self._last_command

    def start(self) -> None:
        # Use the standard SPP UUID (0x1101) with a fixed RFCOMM channel. Android
        # clients typically discover the channel via SDP.
        #
        # SDP registration usually requires root privileges on modern BlueZ.
        # We rely on systemd `ExecStartPre` to run `sdptool add ...` as root.
        # If you run this manually as root, we'll also try to register here.
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            self._register_spp_service()

        self._server_sock = socket.socket(
            socket.AF_BLUETOOTH,
            socket.SOCK_STREAM,
            socket.BTPROTO_RFCOMM,
        )
        # Bind to any local adapter.
        bdaddr_any = getattr(socket, "BDADDR_ANY", "00:00:00:00:00:00")
        self._server_sock.bind((bdaddr_any, int(self.cfg.channel)))
        self._server_sock.listen(1)
        self._server_sock.settimeout(1.0)
        self._running = True
        self._accept_thread = threading.Thread(target=self._accept_loop, daemon=True)
        self._accept_thread.start()
        self.logger.info(
            "Bluetooth server started as '%s' on RFCOMM channel %d",
            self.cfg.service_name,
            self.cfg.channel,
        )

    def stop(self) -> None:
        self._running = False
        self._close_client()
        if self._server_sock:
            try:
                self._server_sock.close()
            except Exception:
                pass
            self._server_sock = None

    def broadcast_json(self, payload: dict[str, Any]) -> bool:
        return self.send_line(encode_message_line(payload))

    def send_line(self, payload: str) -> bool:
        with self._client_lock:
            sock = self._client_sock
        if sock is None:
            return False
        try:
            sock.send(payload.encode("utf-8"))
            return True
        except Exception as exc:
            self.logger.warning("Bluetooth send failed: %s", exc)
            self._close_client()
            return False

    def _register_spp_service(self) -> None:
        channel = int(self.cfg.channel)
        try:
            subprocess.run(
                ["sdptool", "add", f"--channel={channel}", "SP"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.logger.info("Bluetooth SDP: registered Serial Port service on channel %d", channel)
        except FileNotFoundError:
            self.logger.warning("sdptool not found; Bluetooth SDP registration skipped")
        except Exception as exc:
            self.logger.warning("Bluetooth SDP registration failed: %s", exc)

    def _accept_loop(self) -> None:
        assert self._server_sock is not None
        while self._running:
            try:
                client, client_info = self._server_sock.accept()
            except Exception:
                continue
            # Close any existing client before promoting the new socket.
            # Do this outside the lock to avoid re-entrant locking deadlocks.
            self._close_client()
            with self._client_lock:
                self._client_sock = client
                self._client_addr = str(client_info[0]) if client_info else "unknown"
            self.logger.info("Bluetooth client connected: %s", self._client_addr)
            self._client_thread = threading.Thread(
                target=self._client_rx_loop,
                args=(client,),
                daemon=True,
            )
            self._client_thread.start()

    def _close_client(self) -> None:
        with self._client_lock:
            sock = self._client_sock
            self._client_sock = None
            self._client_addr = None
        if sock is not None:
            try:
                sock.close()
            except Exception:
                pass

    def _client_rx_loop(self, sock: Any) -> None:
        buffer = ""
        try:
            sock.settimeout(1.0)
        except Exception:
            pass
        while self._running:
            try:
                data = sock.recv(1024)
            except Exception:
                continue
            if not data:
                break
            buffer += data.decode("utf-8", errors="ignore")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    parsed = json.loads(line)
                    if isinstance(parsed, dict):
                        self._last_command = parsed
                except Exception:
                    pass
        self.logger.info("Bluetooth client disconnected")
        self._close_client()
