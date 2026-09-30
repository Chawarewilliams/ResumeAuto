#!/usr/bin/env python3
"""
HR Email Automation System — CLI Entry Point

Usage:
    python main.py import <file>       Import contacts from CSV/TXT
    python main.py validate <file>     Validate emails without sending
    python main.py preview <file>      Preview emails that would be sent
    python main.py send <file>         Send emails to valid contacts
    python main.py history             View send history
    python main.py status <email>      Check status of a specific email
    python main.py resend <email>      Resend to a specific email

Options:
    --dry-run                          Simulate without actually sending
    --campaign <name>                  Specify campaign name
    --version                          Show version
    --help                             Show this help message
"""

import argparse
import sys
from pathlib import Path

from app import __version__
from app.config import get_config
from app.utils.logger import setup_logger


def create_parser() -> argparse.ArgumentParser:
    """Create and configure the argument parser."""
    parser = argparse.ArgumentParser(
        prog="hr-email-automation",
        description=(
            "HR Email Automation System — Send professional job application "
            "emails with duplicate protection, validation, and campaign tracking."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python main.py import contacts.csv\n"
            "  python main.py validate contacts.csv\n"
            "  python main.py preview contacts.csv --dry-run\n"
            "  python main.py send contacts.csv --campaign 'Python Dev Sep 2026'\n"
            "  python main.py history\n"
            "  python main.py status hr@company.com\n"
            "  python main.py resend hr@company.com\n"
        ),
    )

    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Simulate sending without actually sending emails.",
    )

    parser.add_argument(
        "--campaign",
        type=str,
        default=None,
        help="Campaign name for tracking purposes.",
    )

    parser.add_argument(
        "--auto-confirm",
        action="store_true",
        default=False,
        help="Skip confirmation prompts (use with caution).",
    )

    # Subcommands
    subparsers = parser.add_subparsers(
        dest="command",
        title="commands",
        description="Available commands:",
    )

    # import command
    import_parser = subparsers.add_parser(
        "import",
        help="Import contacts from a CSV or TXT file.",
    )
    import_parser.add_argument(
        "file",
        type=str,
        help="Path to CSV or TXT file containing email addresses.",
    )

    # validate command
    validate_parser = subparsers.add_parser(
        "validate",
        help="Validate emails from a file without sending.",
    )
    validate_parser.add_argument(
        "file",
        type=str,
        help="Path to CSV or TXT file containing email addresses.",
    )

    # preview command
    preview_parser = subparsers.add_parser(
        "preview",
        help="Preview emails that would be sent.",
    )
    preview_parser.add_argument(
        "file",
        type=str,
        help="Path to CSV or TXT file containing email addresses.",
    )

    # send command
    send_parser = subparsers.add_parser(
        "send",
        help="Send emails to valid contacts from a file.",
    )
    send_parser.add_argument(
        "file",
        type=str,
        help="Path to CSV or TXT file containing email addresses.",
    )

    # history command
    subparsers.add_parser(
        "history",
        help="View email send history.",
    )

    # status command
    status_parser = subparsers.add_parser(
        "status",
        help="Check the send status of a specific email.",
    )
    status_parser.add_argument(
        "email",
        type=str,
        help="Email address to look up.",
    )

    # resend command
    resend_parser = subparsers.add_parser(
        "resend",
        help="Resend email to a specific address (requires explicit action).",
    )
    resend_parser.add_argument(
        "email",
        type=str,
        help="Email address to resend to.",
    )

    # search command
    search_parser = subparsers.add_parser(
        "search",
        help="Search contacts and send history.",
    )
    search_parser.add_argument(
        "query",
        type=str,
        help="Search query (email, company, status).",
    )

    return parser


def handle_command(args: argparse.Namespace) -> int:
    """
    Route the parsed command to the appropriate handler.

    Returns:
        Exit code (0 for success, 1 for error).
    """
    if args.command is None:
        print(
            "\n❌ No command specified. Use --help to see available commands.\n"
        )
        return 1

    # Phase 1: Only version/help work. Other commands show "coming soon".
    command_phases = {
        "import": 6,
        "validate": 3,
        "preview": 9,
        "send": 8,
        "history": 18,
        "status": 18,
        "resend": 16,
        "search": 18,
    }

    phase = command_phases.get(args.command, 0)
    print(
        f"\n🚧 Command '{args.command}' will be implemented in Phase {phase}.\n"
        f"   Current phase: 1 (Project Setup + Configuration)\n"
        f"   Run 'python main.py --version' or '--help' to verify setup.\n"
    )
    return 0


def main() -> int:
    """Main entry point for the CLI."""
    parser = create_parser()
    args = parser.parse_args()

    # Load configuration
    try:
        config = get_config()
    except SystemExit:
        return 1

    # Override config flags from CLI args
    if args.dry_run:
        print("\n🔍 DRY RUN MODE — No emails will be sent.\n")

    # Set up logging
    logger = setup_logger(
        log_level=config.log_level,
        log_file=config.log_file,
    )
    logger.info("HR Email Automation System started")
    logger.debug(f"Configuration loaded: {config}")

    # Route command
    return handle_command(args)


if __name__ == "__main__":
    sys.exit(main())
