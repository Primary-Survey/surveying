from __future__ import annotations

import asyncio
import logging
import os
import signal
from typing import Any

from dbus_next import Variant
from dbus_next.aio import MessageBus
from dbus_next.constants import BusType
from dbus_next.service import ServiceInterface, method


BLUEZ_SERVICE = "org.bluez"
AGENT_MANAGER_PATH = "/org/bluez"
AGENT_PATH = "/com/rtk/agent"


class RtkBluetoothAgent(ServiceInterface):
    """
    BlueZ pairing agent that auto-accepts requests using "Just Works" semantics.

    Goal: allow Android pairing without requiring any PIN/passcode to be entered
    or confirmed on the rover (the rover has no UI).
    """

    def __init__(self, bus: MessageBus, logger: logging.Logger) -> None:
        super().__init__("org.bluez.Agent1")
        self._bus = bus
        self._logger = logger

    async def _trust_device(self, device_path: str) -> None:
        # Trusting helps prevent repeated authorization prompts on reconnect.
        try:
            introspection = await self._bus.introspect(BLUEZ_SERVICE, device_path)
            obj = self._bus.get_proxy_object(BLUEZ_SERVICE, device_path, introspection)
            props = obj.get_interface("org.freedesktop.DBus.Properties")
            await props.call_set("org.bluez.Device1", "Trusted", Variant("b", True))
            self._logger.info("Trusted device: %s", device_path)
        except Exception as exc:
            self._logger.warning("Failed to trust device %s: %s", device_path, exc)

    @method()
    def Release(self):
        self._logger.info("Agent released by BlueZ")

    @method()
    def RequestPinCode(self, device: "o") -> "s":
        # Legacy PIN pairing fallback. Android should normally use SSP (Just Works),
        # but returning a PIN here avoids hard failures if a stack requests it.
        self._logger.info("RequestPinCode from %s -> returning 0000", device)
        asyncio.create_task(self._trust_device(str(device)))
        return "0000"

    @method()
    def RequestPasskey(self, device: "o") -> "u":
        self._logger.info("RequestPasskey from %s -> returning 0", device)
        asyncio.create_task(self._trust_device(str(device)))
        return 0

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):
        # No UI; log only.
        self._logger.info("DisplayPinCode for %s: %s", device, pincode)

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):
        # No UI; log only.
        self._logger.info("DisplayPasskey for %s: %06u (entered=%s)", device, passkey, entered)

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):
        # Auto-confirm numeric comparison.
        self._logger.info("RequestConfirmation for %s: %06u -> auto-accept", device, passkey)
        asyncio.create_task(self._trust_device(str(device)))
        return None  # Explicit for clarity; D-Bus method has no return signature.

    @method()
    def RequestAuthorization(self, device: "o"):
        # Auto-authorize.
        self._logger.info("RequestAuthorization for %s -> auto-accept", device)
        asyncio.create_task(self._trust_device(str(device)))
        return None

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):
        # Auto-authorize all services (SPP, etc).
        self._logger.info("AuthorizeService for %s uuid=%s -> auto-accept", device, uuid)
        asyncio.create_task(self._trust_device(str(device)))
        return None

    @method()
    def Cancel(self):
        self._logger.info("Pairing cancelled")


async def _register_as_default_agent(bus: MessageBus, capability: str, logger: logging.Logger) -> None:
    introspection = await bus.introspect(BLUEZ_SERVICE, AGENT_MANAGER_PATH)
    obj = bus.get_proxy_object(BLUEZ_SERVICE, AGENT_MANAGER_PATH, introspection)
    mgr = obj.get_interface("org.bluez.AgentManager1")

    # (Re)register on every boot. BlueZ will error if agent already registered;
    # attempt an unregister first for robustness.
    try:
        await mgr.call_unregister_agent(AGENT_PATH)
    except Exception:
        pass

    await mgr.call_register_agent(AGENT_PATH, capability)
    await mgr.call_request_default_agent(AGENT_PATH)
    logger.info("Registered BlueZ agent at %s (capability=%s)", AGENT_PATH, capability)


async def _main_async() -> int:
    log_level = os.getenv("ROVER_BT_AGENT_LOG_LEVEL", "INFO").upper().strip() or "INFO"
    capability = os.getenv("ROVER_BT_AGENT_CAPABILITY", "NoInputNoOutput").strip() or "NoInputNoOutput"

    logging.basicConfig(level=getattr(logging, log_level, logging.INFO), format="%(asctime)s %(levelname)s %(message)s")
    logger = logging.getLogger("rtk-bt-agent")

    bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
    agent = RtkBluetoothAgent(bus, logger)
    bus.export(AGENT_PATH, agent)

    await _register_as_default_agent(bus, capability, logger)

    stop_event = asyncio.Event()

    def _request_stop(*_: Any) -> None:
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _request_stop)
        except NotImplementedError:
            # Windows/dev environments.
            pass

    logger.info("BT agent running (capability=%s).", capability)
    await stop_event.wait()
    logger.info("BT agent stopping.")
    return 0


def main() -> int:
    try:
        return asyncio.run(_main_async())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
