from __future__ import annotations

import argparse
import logging
import signal
from pathlib import Path

from base_station.app import BaseStationApplication
from base_station.config import AppConfig, as_dict, load_config


def _configure_logging(cfg: AppConfig) -> logging.Logger:
    level_name = cfg.logging.level.upper()
    level = getattr(logging, level_name, logging.INFO)
    log_path = Path(cfg.logging.file_path)
    if not log_path.is_absolute():
        base_dir = cfg.config_path.parent if cfg.config_path else Path.cwd()
        log_path = (base_dir / log_path).resolve()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.StreamHandler(),
        logging.FileHandler(log_path, encoding="utf-8"),
    ]
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )
    logger = logging.getLogger("rtk-base")
    logger.info("Log file: %s", log_path)
    return logger


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="RTK base station service")
    parser.add_argument(
        "--config",
        default="config/base.yaml",
        help="Path to base YAML config file",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    cfg = load_config(args.config)
    logger = _configure_logging(cfg)
    logger.info("Effective config: %s", as_dict(cfg))
    app = BaseStationApplication(cfg, logger=logger)

    def _handle_signal(signum: int, _frame: object) -> None:
        logger.info("Received signal %d, stopping base service", signum)
        app.request_stop()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    app.run_forever()


if __name__ == "__main__":
    main()

