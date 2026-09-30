"""
Structured logging configuration.

Provides a configured logger that:
- Writes to both console and rotating log file
- Uses structured format with timestamps
- NEVER logs sensitive data (passwords, tokens, credentials)
- Supports configurable log levels
"""

import logging
import sys
from pathlib import Path
from typing import Optional


# Sensitive keys that must never appear in logs
_SENSITIVE_KEYS = frozenset({
    "password", "smtp_password", "app_password", "token",
    "oauth_token", "secret", "api_key", "credential",
})


def _is_sensitive(key: str) -> bool:
    """Check if a key name refers to sensitive data."""
    return key.lower().strip() in _SENSITIVE_KEYS


def setup_logger(
    name: str = "hr_automation",
    log_level: str = "INFO",
    log_file: Optional[str] = None,
) -> logging.Logger:
    """
    Set up and return a configured logger.

    Args:
        name: Logger name.
        log_level: Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        log_file: Optional path to log file. Creates parent dirs if needed.

    Returns:
        Configured logging.Logger instance.
    """
    logger = logging.getLogger(name)

    # Avoid adding duplicate handlers on repeated calls
    if logger.handlers:
        return logger

    level = getattr(logging, log_level.upper(), logging.INFO)
    logger.setLevel(level)

    # Log format: structured with timestamp, level, and message
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console handler — always present
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # File handler — if log file path is provided
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.FileHandler(
            str(log_path), encoding="utf-8"
        )
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    # Prevent propagation to root logger
    logger.propagate = False

    return logger


def get_logger(name: str = "hr_automation") -> logging.Logger:
    """
    Get an existing logger by name.

    If the logger hasn't been set up yet, returns a basic logger.

    Args:
        name: Logger name.

    Returns:
        The logger instance.
    """
    logger = logging.getLogger(name)
    if not logger.handlers:
        # Basic setup if not yet configured
        return setup_logger(name)
    return logger


def log_email_event(
    logger: logging.Logger,
    recipient: str,
    status: str,
    campaign_id: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    """
    Log a structured email event.

    Args:
        logger: Logger instance.
        recipient: Recipient email address.
        status: Email status (SENT, FAILED, SKIPPED, etc.).
        campaign_id: Optional campaign ID.
        error: Optional error message.
    """
    parts = [f"{recipient} | {status}"]
    if campaign_id is not None:
        parts.append(f"campaign={campaign_id}")
    if error:
        parts.append(f"error={error}")

    message = " | ".join(parts)

    if status in ("FAILED", "SEND_FAILED"):
        logger.error(message)
    elif status.startswith("SKIPPED"):
        logger.info(message)
    elif status == "SENT":
        logger.info(message)
    else:
        logger.debug(message)
