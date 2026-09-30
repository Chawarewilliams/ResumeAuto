"""
Shared helper utilities.

Small, focused utility functions used across the application.
"""

from datetime import datetime
from typing import Optional


def normalize_email(email: str) -> str:
    """
    Normalize an email address for consistent comparison.

    Strips whitespace and converts to lowercase.

    Args:
        email: Raw email address string.

    Returns:
        Normalized email string.

    Examples:
        >>> normalize_email("  HR@ABC.COM  ")
        'hr@abc.com'
        >>> normalize_email("Hr@Abc.Com")
        'hr@abc.com'
    """
    if not email:
        return ""
    return email.strip().lower()


def extract_domain(email: str) -> str:
    """
    Extract the domain from an email address.

    Args:
        email: Email address (should be normalized first).

    Returns:
        Domain part of the email, or empty string if invalid.

    Examples:
        >>> extract_domain("hr@company.com")
        'company.com'
        >>> extract_domain("invalid-email")
        ''
    """
    if "@" not in email:
        return ""
    parts = email.rsplit("@", 1)
    if len(parts) == 2 and parts[1]:
        return parts[1].strip().lower()
    return ""


def format_timestamp(dt: Optional[datetime] = None) -> str:
    """
    Format a datetime for display.

    Args:
        dt: Datetime to format. Uses current time if None.

    Returns:
        Formatted datetime string.
    """
    if dt is None:
        dt = datetime.now()
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def truncate_string(text: str, max_length: int = 50) -> str:
    """
    Truncate a string with ellipsis if it exceeds max_length.

    Args:
        text: String to truncate.
        max_length: Maximum length before truncation.

    Returns:
        Truncated string.
    """
    if len(text) <= max_length:
        return text
    return text[: max_length - 3] + "..."


def confirm_action(prompt: str, auto_confirm: bool = False) -> bool:
    """
    Ask the user for confirmation before proceeding.

    Args:
        prompt: The confirmation message to display.
        auto_confirm: If True, skip the prompt and return True.

    Returns:
        True if user confirms, False otherwise.
    """
    if auto_confirm:
        print(f"{prompt} [AUTO-CONFIRMED]")
        return True

    while True:
        response = input(f"\n{prompt} (yes/no): ").strip().lower()
        if response in ("yes", "y"):
            return True
        if response in ("no", "n"):
            return False
        print("Please enter 'yes' or 'no'.")
