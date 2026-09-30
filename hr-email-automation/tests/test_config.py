"""
Tests for the configuration system.

Validates that:
- Config loads correctly from .env
- Defaults work when .env is missing
- Required fields are enforced
- Sensitive data never appears in repr
- Helper functions work correctly
"""

import os
import tempfile
from pathlib import Path

import pytest

from app.config import (
    AppConfig,
    SMTPConfig,
    CandidateConfig,
    ResumeConfig,
    RateLimitConfig,
    load_config,
    reset_config,
)
from app.utils.helpers import normalize_email, extract_domain


class TestConfigLoading:
    """Test configuration loading from .env files."""

    def setup_method(self) -> None:
        """Reset config singleton before each test."""
        reset_config()

    def teardown_method(self) -> None:
        """Reset config singleton after each test."""
        reset_config()

    def test_load_config_with_defaults(self) -> None:
        """Config should load with sensible defaults when no .env exists."""
        config = load_config(env_file="/nonexistent/.env")
        assert isinstance(config, AppConfig)
        assert isinstance(config.smtp, SMTPConfig)
        assert isinstance(config.candidate, CandidateConfig)
        assert isinstance(config.resume, ResumeConfig)
        assert isinstance(config.rate_limit, RateLimitConfig)

    def test_default_smtp_host(self) -> None:
        """Default SMTP host should be Gmail."""
        config = load_config(env_file="/nonexistent/.env")
        assert config.smtp.host == "smtp.gmail.com"
        assert config.smtp.port == 587

    def test_default_rate_limits(self) -> None:
        """Default rate limits should be conservative."""
        config = load_config(env_file="/nonexistent/.env")
        assert config.rate_limit.delay_seconds == 10
        assert config.rate_limit.max_emails_per_run == 50

    def test_default_dry_run_is_false(self) -> None:
        """Dry run should be disabled by default."""
        config = load_config(env_file="/nonexistent/.env")
        assert config.dry_run is False

    def test_default_auto_confirm_is_false(self) -> None:
        """Auto confirm should be disabled by default."""
        config = load_config(env_file="/nonexistent/.env")
        assert config.auto_confirm is False

    def test_blocked_domains_loaded(self) -> None:
        """Default blocked domains should include major personal providers."""
        config = load_config(env_file="/nonexistent/.env")
        assert "gmail.com" in config.blocked_domains
        assert "yahoo.com" in config.blocked_domains
        assert "hotmail.com" in config.blocked_domains
        assert "outlook.com" in config.blocked_domains
        assert "protonmail.com" in config.blocked_domains
        assert "rediffmail.com" in config.blocked_domains
        assert len(config.blocked_domains) >= 8

    def test_load_from_env_file(self, tmp_path: Path) -> None:
        """Config should load values from a .env file."""
        env_file = tmp_path / ".env"
        env_file.write_text(
            "SMTP_HOST=smtp.test.com\n"
            "SMTP_PORT=465\n"
            "SMTP_USERNAME=test@test.com\n"
            "SMTP_PASSWORD=testpass123\n"
            "SENDER_EMAIL=test@test.com\n"
            "DRY_RUN=true\n"
            "MAX_EMAILS_PER_RUN=10\n"
            "EMAIL_DELAY_SECONDS=5\n"
        )
        config = load_config(env_file=str(env_file))
        assert config.smtp.host == "smtp.test.com"
        assert config.smtp.port == 465
        assert config.smtp.username == "test@test.com"
        assert config.dry_run is True
        assert config.rate_limit.max_emails_per_run == 10
        assert config.rate_limit.delay_seconds == 5

    def test_config_is_frozen(self) -> None:
        """Config dataclass should be immutable."""
        config = load_config(env_file="/nonexistent/.env")
        with pytest.raises(AttributeError):
            config.dry_run = True  # type: ignore[misc]


class TestConfigSecurity:
    """Test that sensitive data is never exposed."""

    def setup_method(self) -> None:
        reset_config()

    def teardown_method(self) -> None:
        reset_config()

    def test_repr_hides_password(self, tmp_path: Path) -> None:
        """Config repr must never contain the actual SMTP password."""
        env_file = tmp_path / ".env"
        env_file.write_text("SMTP_PASSWORD=my_super_secret_password_123\n")
        config = load_config(env_file=str(env_file))
        config_str = repr(config)
        assert "my_super_secret_password_123" not in config_str
        assert "****" in config_str

    def test_str_hides_password(self, tmp_path: Path) -> None:
        """Config str conversion must never contain the actual SMTP password."""
        env_file = tmp_path / ".env"
        env_file.write_text("SMTP_PASSWORD=another_secret_456\n")
        config = load_config(env_file=str(env_file))
        config_str = str(config)
        assert "another_secret_456" not in config_str


class TestNormalizeEmail:
    """Test email normalization helper."""

    def test_lowercase(self) -> None:
        assert normalize_email("HR@ABC.COM") == "hr@abc.com"

    def test_strip_spaces(self) -> None:
        assert normalize_email("  hr@abc.com  ") == "hr@abc.com"

    def test_mixed_case_and_spaces(self) -> None:
        assert normalize_email(" Hr@Abc.Com ") == "hr@abc.com"

    def test_empty_string(self) -> None:
        assert normalize_email("") == ""

    def test_none_like(self) -> None:
        assert normalize_email("") == ""

    def test_already_normalized(self) -> None:
        assert normalize_email("hr@abc.com") == "hr@abc.com"


class TestExtractDomain:
    """Test domain extraction helper."""

    def test_valid_email(self) -> None:
        assert extract_domain("hr@company.com") == "company.com"

    def test_no_at_sign(self) -> None:
        assert extract_domain("invalid-email") == ""

    def test_empty_domain(self) -> None:
        assert extract_domain("user@") == ""

    def test_subdomain(self) -> None:
        assert extract_domain("hr@mail.company.com") == "mail.company.com"

    def test_gmail(self) -> None:
        assert extract_domain("user@gmail.com") == "gmail.com"
