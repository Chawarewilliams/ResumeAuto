"""
Centralized configuration management.

Loads settings from .env file and environment variables.
Validates required settings and provides typed access via AppConfig dataclass.
"""

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


# Project root is the parent of the 'app' directory
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _get_project_root() -> Path:
    """Return the project root directory."""
    return PROJECT_ROOT


@dataclass(frozen=True)
class SMTPConfig:
    """SMTP server configuration."""
    host: str
    port: int
    username: str
    password: str
    sender_email: str
    sender_name: str


@dataclass(frozen=True)
class CandidateConfig:
    """Candidate personal information for email templates."""
    name: str
    job_role: str
    experience: str
    current_company: str
    skills: str
    phone: str
    email: str
    linkedin: str


@dataclass(frozen=True)
class ResumeConfig:
    """Resume attachment configuration."""
    path: str
    enabled: bool
    allowed_extensions: list[str]
    max_size_mb: float


@dataclass(frozen=True)
class RateLimitConfig:
    """Rate limiting configuration."""
    delay_seconds: int
    max_emails_per_run: int


@dataclass(frozen=True)
class AppConfig:
    """
    Master application configuration.

    All settings are loaded from environment variables (via .env file).
    This dataclass is frozen (immutable) to prevent accidental mutation.
    """
    smtp: SMTPConfig
    candidate: CandidateConfig
    resume: ResumeConfig
    rate_limit: RateLimitConfig
    dry_run: bool
    auto_confirm: bool
    database_path: str
    blocked_domains: list[str]
    log_level: str
    log_file: str
    project_root: Path

    def __repr__(self) -> str:
        """Safe repr that never exposes credentials."""
        return (
            f"AppConfig(\n"
            f"  smtp_host={self.smtp.host!r},\n"
            f"  smtp_port={self.smtp.port},\n"
            f"  smtp_username={self.smtp.username!r},\n"
            f"  smtp_password=****,\n"
            f"  sender_email={self.smtp.sender_email!r},\n"
            f"  candidate_name={self.candidate.name!r},\n"
            f"  job_role={self.candidate.job_role!r},\n"
            f"  dry_run={self.dry_run},\n"
            f"  auto_confirm={self.auto_confirm},\n"
            f"  max_emails_per_run={self.rate_limit.max_emails_per_run},\n"
            f"  delay_seconds={self.rate_limit.delay_seconds},\n"
            f"  database_path={self.database_path!r},\n"
            f"  blocked_domains_count={len(self.blocked_domains)},\n"
            f"  resume_enabled={self.resume.enabled},\n"
            f"  log_level={self.log_level!r}\n"
            f")"
        )


def _env(key: str, default: Optional[str] = None, required: bool = False) -> str:
    """
    Read an environment variable with optional default.

    Args:
        key: Environment variable name.
        default: Default value if not set.
        required: If True, raise error when missing.

    Returns:
        The environment variable value.

    Raises:
        SystemExit: If required variable is missing.
    """
    value = os.getenv(key, default)
    if required and (value is None or value.strip() == ""):
        print(
            f"\n❌ ERROR: Required environment variable '{key}' is not set.\n"
            f"   Please set it in your .env file or environment.\n"
            f"   See .env.example for reference.\n",
            file=sys.stderr,
        )
        sys.exit(1)
    return value if value is not None else ""


def _env_bool(key: str, default: bool = False) -> bool:
    """Read an environment variable as a boolean."""
    value = os.getenv(key, str(default)).strip().lower()
    return value in ("true", "1", "yes", "on")


def _env_int(key: str, default: int = 0) -> int:
    """Read an environment variable as an integer."""
    value = os.getenv(key, str(default)).strip()
    try:
        return int(value)
    except ValueError:
        print(
            f"\n⚠️  WARNING: '{key}' value '{value}' is not a valid integer. "
            f"Using default: {default}\n",
            file=sys.stderr,
        )
        return default


def _env_float(key: str, default: float = 0.0) -> float:
    """Read an environment variable as a float."""
    value = os.getenv(key, str(default)).strip()
    try:
        return float(value)
    except ValueError:
        print(
            f"\n⚠️  WARNING: '{key}' value '{value}' is not a valid number. "
            f"Using default: {default}\n",
            file=sys.stderr,
        )
        return default


def _env_list(key: str, default: str = "") -> list[str]:
    """Read a comma-separated environment variable as a list of stripped strings."""
    value = os.getenv(key, default).strip()
    if not value:
        return []
    return [item.strip().lower() for item in value.split(",") if item.strip()]


def _resolve_path(path_str: str) -> str:
    """Resolve a path relative to project root."""
    path = Path(path_str)
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return str(path.resolve())


def load_config(env_file: Optional[str] = None) -> AppConfig:
    """
    Load and validate the complete application configuration.

    Args:
        env_file: Optional path to .env file. Defaults to PROJECT_ROOT/.env

    Returns:
        Fully validated AppConfig instance.

    Raises:
        SystemExit: If required configuration is missing.
    """
    # Load .env file
    if env_file:
        env_path = Path(env_file)
    else:
        env_path = PROJECT_ROOT / ".env"

    if env_path.exists():
        load_dotenv(env_path, override=True)
    else:
        print(
            f"\n⚠️  WARNING: No .env file found at {env_path}\n"
            f"   Copy .env.example to .env and configure your settings.\n"
            f"   Running with environment variables and defaults only.\n",
            file=sys.stderr,
        )

    # Build configuration
    smtp = SMTPConfig(
        host=_env("SMTP_HOST", "smtp.gmail.com"),
        port=_env_int("SMTP_PORT", 587),
        username=_env("SMTP_USERNAME", required=False),
        password=_env("SMTP_PASSWORD", required=False),
        sender_email=_env("SENDER_EMAIL", required=False),
        sender_name=_env("SENDER_NAME", ""),
    )

    candidate = CandidateConfig(
        name=_env("CANDIDATE_NAME", ""),
        job_role=_env("JOB_ROLE", ""),
        experience=_env("EXPERIENCE", ""),
        current_company=_env("CURRENT_COMPANY", ""),
        skills=_env("SKILLS", ""),
        phone=_env("PHONE", ""),
        email=_env("CANDIDATE_EMAIL", ""),
        linkedin=_env("LINKEDIN", ""),
    )

    resume = ResumeConfig(
        path=_resolve_path(_env("RESUME_PATH", "./attachments/resume.pdf")),
        enabled=_env_bool("RESUME_ENABLED", True),
        allowed_extensions=_env_list(
            "RESUME_ALLOWED_EXTENSIONS", ".pdf,.doc,.docx"
        ),
        max_size_mb=_env_float("RESUME_MAX_SIZE_MB", 10.0),
    )

    rate_limit = RateLimitConfig(
        delay_seconds=_env_int("EMAIL_DELAY_SECONDS", 10),
        max_emails_per_run=_env_int("MAX_EMAILS_PER_RUN", 50),
    )

    # Default blocked domains
    default_blocked = (
        "gmail.com,yahoo.com,hotmail.com,outlook.com,live.com,"
        "icloud.com,protonmail.com,rediffmail.com,aol.com,zoho.com,"
        "yandex.com,mail.com,gmx.com,tutanota.com,fastmail.com,"
        "hushmail.com,inbox.com,proton.me"
    )

    config = AppConfig(
        smtp=smtp,
        candidate=candidate,
        resume=resume,
        rate_limit=rate_limit,
        dry_run=_env_bool("DRY_RUN", False),
        auto_confirm=_env_bool("AUTO_CONFIRM", False),
        database_path=_resolve_path(
            _env("DATABASE_PATH", "./data/database/hr_automation.db")
        ),
        blocked_domains=_env_list("BLOCKED_DOMAINS", default_blocked),
        log_level=_env("LOG_LEVEL", "INFO").upper(),
        log_file=_resolve_path(_env("LOG_FILE", "./logs/hr_automation.log")),
        project_root=PROJECT_ROOT,
    )

    return config


# Module-level singleton — lazy loaded
_config: Optional[AppConfig] = None


def get_config(env_file: Optional[str] = None) -> AppConfig:
    """
    Get the application configuration (singleton).

    On first call, loads configuration from .env file.
    Subsequent calls return the cached config.

    Args:
        env_file: Optional path to .env file (only used on first call).

    Returns:
        The application configuration.
    """
    global _config
    if _config is None:
        _config = load_config(env_file)
    return _config


def reset_config() -> None:
    """Reset the config singleton. Used primarily in testing."""
    global _config
    _config = None
