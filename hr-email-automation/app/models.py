"""
Data models for the HR Email Automation System.

Uses dataclasses for clean, typed data structures.
These models represent the core domain objects and are database-agnostic.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class EmailStatus(Enum):
    """Status of an email in the processing pipeline."""
    PENDING = "PENDING"
    SKIPPED_DUPLICATE = "SKIPPED_DUPLICATE"
    SKIPPED_PERSONAL_EMAIL = "SKIPPED_PERSONAL_EMAIL"
    SKIPPED_ALREADY_SENT = "SKIPPED_ALREADY_SENT"
    INVALID_EMAIL = "INVALID_EMAIL"
    SENT = "SENT"
    FAILED = "FAILED"


class ValidationResult(Enum):
    """Result of email validation."""
    FORMAT_VALID = "FORMAT_VALID"
    PERSONAL_DOMAIN = "PERSONAL_DOMAIN"
    DUPLICATE = "DUPLICATE"
    ALREADY_SENT = "ALREADY_SENT"
    READY_TO_SEND = "READY_TO_SEND"
    SEND_FAILED = "SEND_FAILED"
    INVALID_FORMAT = "INVALID_FORMAT"


@dataclass
class Contact:
    """Represents an HR/recruiter contact."""
    id: Optional[int] = None
    email: str = ""
    normalized_email: str = ""
    company_name: str = ""
    hr_name: str = ""
    job_role: str = ""
    source: str = ""
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    def __post_init__(self) -> None:
        """Normalize email on creation if not already set."""
        if self.email and not self.normalized_email:
            self.normalized_email = self.email.strip().lower()


@dataclass
class Campaign:
    """Represents an email campaign."""
    id: Optional[int] = None
    campaign_name: str = ""
    subject: str = ""
    body: str = ""
    created_at: Optional[datetime] = None


@dataclass
class EmailLog:
    """Represents a single email send attempt."""
    id: Optional[int] = None
    contact_id: Optional[int] = None
    campaign_id: Optional[int] = None
    recipient_email: str = ""
    status: EmailStatus = EmailStatus.PENDING
    message_id: str = ""
    error_message: str = ""
    send_attempt_count: int = 0
    last_attempt_at: Optional[datetime] = None
    sent_at: Optional[datetime] = None
    created_at: Optional[datetime] = None


@dataclass
class ProcessedEmail:
    """
    Result of processing a single email through the validation pipeline.

    This is an intermediate object used between input parsing and sending.
    """
    original_email: str = ""
    normalized_email: str = ""
    validation_result: ValidationResult = ValidationResult.INVALID_FORMAT
    reason: str = ""
    contact: Optional[Contact] = None

    @property
    def is_sendable(self) -> bool:
        """Check if this email is ready to send."""
        return self.validation_result == ValidationResult.READY_TO_SEND


@dataclass
class CampaignReport:
    """Summary report for an email campaign run."""
    total_input: int = 0
    unique_emails: int = 0
    invalid_emails: int = 0
    personal_emails: int = 0
    already_contacted: int = 0
    ready_to_send: int = 0
    successfully_sent: int = 0
    failed: int = 0
    skipped_duplicates: int = 0
    failed_details: list[dict] = field(default_factory=list)

    def display(self) -> str:
        """Generate a formatted campaign report string."""
        lines = [
            "",
            "=" * 48,
            "           EMAIL CAMPAIGN REPORT",
            "=" * 48,
            "",
            f"  Input emails       : {self.total_input}",
            f"  Unique emails      : {self.unique_emails}",
            f"  Invalid emails     : {self.invalid_emails}",
            f"  Personal emails    : {self.personal_emails}",
            f"  Duplicates         : {self.skipped_duplicates}",
            f"  Already contacted  : {self.already_contacted}",
            f"  Ready to send      : {self.ready_to_send}",
            f"  Successfully sent  : {self.successfully_sent}",
            f"  Failed             : {self.failed}",
            "",
            "=" * 48,
        ]

        if self.failed_details:
            lines.append("")
            lines.append("  FAILED EMAILS:")
            lines.append("  " + "-" * 44)
            for detail in self.failed_details:
                lines.append(f"  {detail.get('email', 'N/A')}")
                lines.append(f"    Reason: {detail.get('reason', 'Unknown')}")
            lines.append("")

        return "\n".join(lines)


class ApplicationStatus(str, Enum):
    """Possible application pipeline statuses."""
    NEW = "NEW"
    MATCHED = "MATCHED"
    REVIEW = "REVIEW"
    READY_TO_CONTACT = "READY_TO_CONTACT"
    CONTACTED = "CONTACTED"
    APPLIED = "APPLIED"
    REPLIED = "REPLIED"
    INTERVIEW = "INTERVIEW"
    REJECTED = "REJECTED"
    CLOSED = "CLOSED"
    SKIPPED = "SKIPPED"


@dataclass
class Job:
    """Unified Job Model as specified in Section 4."""
    id: str = ""
    source: str = "Direct"
    external_job_id: Optional[str] = None
    job_url: str = ""
    company: str = ""
    company_domain: str = ""
    job_title: str = ""
    location: str = ""
    work_mode: str = "Hybrid"
    experience_required: str = ""
    salary: str = ""
    skills: list[str] = field(default_factory=list)
    description: str = ""
    posted_at: Optional[str] = None
    scraped_at: Optional[str] = None
    job_status: str = "OPEN"
    application_status: ApplicationStatus = ApplicationStatus.NEW
    match_score: int = 0
    duplicate_hash: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class Recruiter:
    """Recruiter / Contact Model as specified in Section 6."""
    id: str = ""
    name: str = ""
    email: str = ""
    company: str = ""
    designation: str = ""
    linkedin_url: str = ""
    source: str = "Direct"
    verified_status: str = "PENDING"
    last_contacted_at: Optional[str] = None
    contact_count: int = 0
    reply_status: str = "NO_REPLY"
    notes: str = ""
    created_at: Optional[str] = None
    updated_at: Optional[str] = None

