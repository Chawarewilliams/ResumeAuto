/**
 * ResumeAuto Engine — Centralized Email Safety Engine & Duplicate Protection System
 *
 * Implements the mandatory 13-stage verification pipeline:
 * INPUT -> Normalize -> Syntax Validation -> Domain Extraction -> Personal Domain Check
 * -> Disposable Domain Check -> Suppression Check -> Duplicate / In-Flight Lock Check
 * -> Previous Contact / Cooldown Check -> Recruiter Policy Check -> Company Policy Check
 * -> Rate Limit Check -> Final Send Eligibility
 *
 * Zero email sends may bypass this engine.
 */

const path = require("path");
const fs = require("fs");
const { safeReadJsonSync, atomicWriteJsonSync, withFileLock } = require("./storage");
const { isSuppressed } = require("./suppression");
const { checkOutreachSafety } = require("./recruiterModel");

const BLOCKED_DOMAINS_FILE = path.resolve("./blocked_domains.json");

// Default Fallback Personal & Disposable Domain Lists
const DEFAULT_PERSONAL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "pm.me",
  "rediffmail.com",
  "aol.com",
  "zoho.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "yandex.com",
  "yandex.ru",
];

const DEFAULT_DISPOSABLE_DOMAINS = [
  "temp-mail.org",
  "10minutemail.com",
  "guerrillamail.com",
  "mailinator.com",
  "trashmail.com",
  "getairmail.com",
  "dispostable.com",
  "yopmail.com",
  "tempmail.net",
  "sharklasers.com",
  "throwawaymail.com",
  "fakemailgenerator.com",
];

// RFC 5321 & Dummy Recipient Set
const DUMMY_EMAILS = new Set([
  "user@example.com",
  "user+tag@email.com",
  "your@gmail.com",
  "your-email@gmail.com",
  "recruiter@company.com",
  "test@test.com",
  "example@example.com",
  "admin@example.com",
  "info@example.com",
]);

// Self / Sender accounts to never email
const SELF_EMAILS = new Set([
  "milinchaware@gmail.com",
  "milinchaware9@gmail.com",
]);

// In-Memory Active Send Locks (Mutex to prevent worker race conditions)
// Key: normalizedEmail -> { lockedAt: number, workerId: string|number, campaignId: string, timeout: NodeJS.Timeout }
const _activeSendLocks = new Map();
const DEFAULT_LOCK_TTL_MS = 60000; // 60s max send timeout before auto-release

// In-Memory Caches
let _blockedDomainsCache = null;
let _personalDomainsSet = new Set();
let _disposableDomainsSet = new Set();
let _customBlockedDomainsSet = new Set();

/**
 * Load or reload blocked domains configuration from disk.
 */
function loadBlockedDomains() {
  if (_blockedDomainsCache) return _blockedDomainsCache;

  const data = safeReadJsonSync(BLOCKED_DOMAINS_FILE, {
    personal: DEFAULT_PERSONAL_DOMAINS,
    disposable: DEFAULT_DISPOSABLE_DOMAINS,
    customBlocked: [],
    updatedAt: new Date().toISOString(),
  });

  _blockedDomainsCache = data;
  _personalDomainsSet = new Set((data.personal || DEFAULT_PERSONAL_DOMAINS).map(d => d.toLowerCase().trim()));
  _disposableDomainsSet = new Set((data.disposable || DEFAULT_DISPOSABLE_DOMAINS).map(d => d.toLowerCase().trim()));
  _customBlockedDomainsSet = new Set((data.customBlocked || []).map(d => d.toLowerCase().trim().replace(/^@/, "")));

  return _blockedDomainsCache;
}

function invalidateBlockedDomainsCache() {
  _blockedDomainsCache = null;
}

/**
 * Save updated blocked domains.
 */
async function saveBlockedDomains(newData) {
  return await withFileLock(BLOCKED_DOMAINS_FILE, async () => {
    const updated = {
      personal: Array.from(new Set(newData.personal || DEFAULT_PERSONAL_DOMAINS)),
      disposable: Array.from(new Set(newData.disposable || DEFAULT_DISPOSABLE_DOMAINS)),
      customBlocked: Array.from(new Set(newData.customBlocked || [])),
      updatedAt: new Date().toISOString(),
    };
    atomicWriteJsonSync(BLOCKED_DOMAINS_FILE, updated);
    _blockedDomainsCache = updated;
    _personalDomainsSet = new Set(updated.personal.map(d => d.toLowerCase().trim()));
    _disposableDomainsSet = new Set(updated.disposable.map(d => d.toLowerCase().trim()));
    _customBlockedDomainsSet = new Set(updated.customBlocked.map(d => d.toLowerCase().trim().replace(/^@/, "")));
    return updated;
  });
}

/**
 * 1. Normalize Email
 * Strips wrappers, quotes, leading identifiers, trailing punctuation, and normalizes case.
 */
function normalizeEmail(raw) {
  if (!raw || typeof raw !== "string") return "";
  let clean = raw.trim().toLowerCase();
  clean = clean.replace(/^[<"'\s]+|[>"'\s]+$/g, "");
  clean = clean.replace(/^email[:\s.]+/i, "");
  clean = clean.replace(/[.,;:!?)]+$/, "");
  return clean.trim();
}

/**
 * 2. Validate RFC 5321 Syntax & Dummy/Self Addresses
 */
function validateSyntax(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, reason: "Empty or non-string email input" };
  }
  const clean = normalizeEmail(email);

  if (clean.length < 6 || clean.length > 254) {
    return { valid: false, reason: `Email length (${clean.length}) must be between 6 and 254 characters` };
  }
  if (clean.includes(" ")) {
    return { valid: false, reason: "Email contains whitespace characters" };
  }

  const parts = clean.split("@");
  if (parts.length !== 2) {
    return { valid: false, reason: "Email must contain exactly one '@' symbol" };
  }
  const [local, domain] = parts;

  // Local-part checks
  if (!local || local.length > 64) {
    return { valid: false, reason: "Local-part cannot be empty or exceed 64 characters" };
  }
  if (local.startsWith(".") || local.endsWith(".")) {
    return { valid: false, reason: "Local-part cannot start or end with a period" };
  }
  if (local.includes("..")) {
    return { valid: false, reason: "Local-part cannot contain consecutive periods" };
  }
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) {
    return { valid: false, reason: "Local-part contains invalid characters" };
  }

  // Domain checks
  if (!domain || domain.length > 255) {
    return { valid: false, reason: "Domain cannot be empty or exceed 255 characters" };
  }
  if (domain.startsWith(".") || domain.endsWith(".") || domain.startsWith("-") || domain.endsWith("-")) {
    return { valid: false, reason: "Domain cannot start or end with hyphen or period" };
  }
  if (domain.includes("..")) {
    return { valid: false, reason: "Domain cannot contain consecutive periods" };
  }
  if (!/^[a-z0-9.-]+$/i.test(domain)) {
    return { valid: false, reason: "Domain contains invalid characters" };
  }

  const domainParts = domain.split(".");
  if (domainParts.length < 2) {
    return { valid: false, reason: "Domain must include a Top-Level Domain (TLD)" };
  }
  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-z]{2,}$/i.test(tld)) {
    return { valid: false, reason: `Invalid TLD: '${tld}'` };
  }
  const invalidTlds = new Set(["png", "jpg", "jpeg", "pdf", "gif", "txt", "zip", "exe", "doc", "docx"]);
  if (invalidTlds.has(tld)) {
    return { valid: false, reason: `Domain TLD indicates a media file extension: .${tld}` };
  }

  // Dummy email check
  if (DUMMY_EMAILS.has(clean)) {
    return { valid: false, reason: `Placeholder / dummy test email address: ${clean}` };
  }

  // Self address check
  if (SELF_EMAILS.has(clean)) {
    return { valid: false, reason: `Sender's own email address: ${clean}` };
  }

  return { valid: true, clean, domain };
}

/**
 * 3. Check Personal Domain
 */
function isPersonalEmailDomain(domain) {
  if (!domain) return false;
  loadBlockedDomains();
  const cleanDom = domain.toLowerCase().trim();

  if (_personalDomainsSet.has(cleanDom)) return true;

  // Check subdomains (e.g. mail.gmail.com)
  for (const personal of _personalDomainsSet) {
    if (cleanDom.endsWith(`.${personal}`)) return true;
  }
  return false;
}

/**
 * 4. Check Disposable Domain
 */
function isDisposableEmailDomain(domain) {
  if (!domain) return false;
  loadBlockedDomains();
  const cleanDom = domain.toLowerCase().trim();

  if (_disposableDomainsSet.has(cleanDom)) return true;

  for (const disp of _disposableDomainsSet) {
    if (cleanDom.endsWith(`.${disp}`)) return true;
  }
  return false;
}

/**
 * 5. Check Custom Blocked Domain
 */
function isCustomBlockedDomain(domain) {
  if (!domain) return false;
  loadBlockedDomains();
  const cleanDom = domain.toLowerCase().trim();
  return _customBlockedDomainsSet.has(cleanDom);
}

/**
 * ─── IN-FLIGHT ATOMIC SEND LOCK (RACE CONDITION GUARD) ─────────
 * Prevents multiple workers or concurrent requests from sending to the
 * same recipient simultaneously.
 */
function acquireSendLock(email, { workerId = "default", campaignId = "default", ttlMs = DEFAULT_LOCK_TTL_MS } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { acquired: false, reason: "Invalid email for send lock" };

  const now = Date.now();
  const existing = _activeSendLocks.get(normalized);

  if (existing) {
    // Check if existing lock is still valid
    if (now - existing.lockedAt < ttlMs) {
      return {
        acquired: false,
        reason: `Send lock active by worker '${existing.workerId}' (held for ${Math.round((now - existing.lockedAt) / 1000)}s)`,
        existing,
      };
    }
    // Expired lock: clear previous timeout and re-acquire
    if (existing.timeout) clearTimeout(existing.timeout);
  }

  const timeout = setTimeout(() => {
    releaseSendLock(normalized);
  }, ttlMs);

  const lockInfo = {
    email: normalized,
    workerId,
    campaignId,
    lockedAt: now,
    timeout,
  };

  _activeSendLocks.set(normalized, lockInfo);
  return { acquired: true, lockInfo };
}

function releaseSendLock(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const existing = _activeSendLocks.get(normalized);
  if (existing) {
    if (existing.timeout) clearTimeout(existing.timeout);
    _activeSendLocks.delete(normalized);
    return true;
  }
  return false;
}

function hasActiveSendLock(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const existing = _activeSendLocks.get(normalized);
  if (!existing) return false;
  if (Date.now() - existing.lockedAt >= DEFAULT_LOCK_TTL_MS) {
    releaseSendLock(normalized);
    return false;
  }
  return true;
}

function getActiveSendLocksCount() {
  return _activeSendLocks.size;
}

/**
 * ─── CENTRAL EMAIL SAFETY EVALUATION PIPELINE ──────────────────
 * Every email MUST pass through this evaluator before entering queue or sending.
 *
 * @param {string} rawEmail - Email candidate
 * @param {Object} options
 * @param {string} [options.company] - Company name if known
 * @param {string} [options.campaignId] - Current campaign ID
 * @param {string|number} [options.workerId] - Worker ID attempting send
 * @param {boolean} [options.allowPersonal] - Override to allow personal domains (default false)
 * @param {boolean} [options.acquireLock] - If eligible, atomically acquire send lock (default false)
 * @param {boolean} [options.skipCooldown] - If true, bypass cooldown check (e.g. resend mode)
 * @param {Function} [options.isCooldownFunc] - Custom cooldown resolver (email) => { inCooldown, lastSentDate, unlockDate }
 * @param {Array<string>} [options.ownSenderAddresses] - Active configured sender email accounts
 * @returns {Object} Safety verdict
 */
function evaluateEmailSafety(rawEmail, options = {}) {
  const {
    company = "",
    campaignId = "global",
    workerId = 0,
    allowPersonal = false,
    acquireLock = false,
    skipCooldown = false,
    skipLockCheck = false,
    isCooldownFunc = null,
    ownSenderAddresses = [],
  } = options;

  // 1. Normalize
  const normalized = normalizeEmail(rawEmail);
  if (!normalized) {
    return {
      eligible: false,
      status: "INVALID_SYNTAX",
      reason: "No email address found in input",
      normalizedEmail: "",
      domain: "",
      company,
    };
  }

  // 2. Syntax Validation
  const syntax = validateSyntax(normalized);
  if (!syntax.valid) {
    return {
      eligible: false,
      status: "INVALID_SYNTAX",
      reason: syntax.reason,
      normalizedEmail: normalized,
      domain: syntax.domain || "",
      company,
    };
  }

  const domain = syntax.domain;

  // 3. Sender Self-Email Check
  if (ownSenderAddresses && ownSenderAddresses.length > 0) {
    const isOwn = ownSenderAddresses.some(a => a && a.toLowerCase().trim() === normalized);
    if (isOwn) {
      return {
        eligible: false,
        status: "SELF_SENDER",
        reason: `Matches active sending account address: ${normalized}`,
        normalizedEmail: normalized,
        domain,
        company,
      };
    }
  }

  // 4. Personal Email Domain Check
  if (!allowPersonal && isPersonalEmailDomain(domain)) {
    return {
      eligible: false,
      status: "BLOCKED_PERSONAL_DOMAIN",
      reason: `Personal email provider (@${domain}) is blocked for recruitment outreach`,
      normalizedEmail: normalized,
      domain,
      company,
      isPersonal: true,
    };
  }

  // 5. Disposable Email Domain Check
  if (isDisposableEmailDomain(domain)) {
    return {
      eligible: false,
      status: "BLOCKED_DISPOSABLE_DOMAIN",
      reason: `Disposable/temporary email provider (@${domain}) is not permitted`,
      normalizedEmail: normalized,
      domain,
      company,
      isDisposable: true,
    };
  }

  // 6. Custom Blocked Domain Check
  if (isCustomBlockedDomain(domain)) {
    return {
      eligible: false,
      status: "BLOCKED_CUSTOM_DOMAIN",
      reason: `Domain @${domain} has been manually blocked in settings`,
      normalizedEmail: normalized,
      domain,
      company,
    };
  }

  // 7. Suppression List Check (Email, Domain, Company)
  const suppression = isSuppressed(normalized, company);
  if (suppression.suppressed) {
    return {
      eligible: false,
      status: "SUPPRESSED",
      reason: `Recipient suppressed: ${suppression.reason} [Type: ${suppression.type || 'OPT_OUT'}]`,
      normalizedEmail: normalized,
      domain,
      company,
      suppressionType: suppression.type || "OPT_OUT",
    };
  }

  // 8. Active In-Flight Send Lock Check (Race Condition Guard)
  if (!skipLockCheck && hasActiveSendLock(normalized)) {
    const existingLock = _activeSendLocks.get(normalized);
    if (!existingLock || workerId === null || workerId === undefined || existingLock.workerId !== workerId) {
      return {
        eligible: false,
        status: "DUPLICATE_ACTIVE_LOCK",
        reason: `Outreach to ${normalized} is currently in-flight by an active worker stream`,
        normalizedEmail: normalized,
        domain,
        company,
      };
    }
  }

  // 9. Historical Cooldown Check
  if (!skipCooldown && typeof isCooldownFunc === "function") {
    const cd = isCooldownFunc(normalized);
    if (cd && cd.inCooldown) {
      return {
        eligible: false,
        status: "SKIPPED_COOLDOWN",
        reason: `In cooldown until ${cd.unlockDate || 'future date'} (last contacted: ${cd.lastSentDate || 'recently'})`,
        normalizedEmail: normalized,
        domain,
        company,
        lastContactDate: cd.lastSentDate,
        unlockDate: cd.unlockDate,
      };
    }
  }

  // 10. Recruiter Anti-Harassment Outreach Safety Check
  const recSafety = checkOutreachSafety(normalized, company);
  if (!recSafety.safe) {
    return {
      eligible: false,
      status: "RECRUITER_POLICY_BLOCKED",
      reason: recSafety.reason,
      normalizedEmail: normalized,
      domain,
      company,
    };
  }

  // 11. Optional Lock Acquisition if sending immediately
  let lockAcquired = false;
  if (acquireLock) {
    const lockRes = acquireSendLock(normalized, { workerId, campaignId });
    if (!lockRes.acquired) {
      return {
        eligible: false,
        status: "DUPLICATE_ACTIVE_LOCK",
        reason: lockRes.reason,
        normalizedEmail: normalized,
        domain,
        company,
      };
    }
    lockAcquired = true;
  }

  // 12. Final Eligibility
  return {
    eligible: true,
    status: "ELIGIBLE",
    reason: "Passed all email safety, domain, suppression, and cooldown checks",
    normalizedEmail: normalized,
    domain,
    company: company || "Target Company",
    lockAcquired,
  };
}

/**
 * ─── BATCH SAFETY EVALUATION & IMPORT QUALITY REPORT ───────────
 * Evaluates an entire list of raw lines / emails and produces an
 * exact, categorized Import Quality Report.
 *
 * @param {Array<string|Object>} rawItems - Array of raw lines or objects
 * @param {Object} options - Pipeline options passed to evaluateEmailSafety
 * @returns {Object} Quality Report with counts and categorized lists
 */
function evaluateBatchSafety(rawItems, options = {}) {
  const seenInBatch = new Set();

  const report = {
    inputTotal: 0,
    uniqueCount: 0,
    eligibleCount: 0,
    personalBlockedCount: 0,
    disposableBlockedCount: 0,
    invalidCount: 0,
    duplicateInBatchCount: 0,
    suppressedCount: 0,
    cooldownCount: 0,
    recruiterBlockedCount: 0,
    ready: [],
    rejected: [],
    summary: {},
  };

  if (!Array.isArray(rawItems)) {
    return report;
  }

  for (const item of rawItems) {
    let rawText = "";
    let company = options.company || "Your Company";

    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      report.inputTotal++;

      if (trimmed.includes(",")) {
        const parts = trimmed.split(",");
        rawText = parts[0].trim();
        company = parts[1]?.trim() || company;
      } else {
        rawText = trimmed;
      }
    } else if (item && typeof item === "object") {
      report.inputTotal++;
      rawText = item.email || item.recipient || item.text || "";
      company = item.company || company;
    }

    // Extract emails from line
    const match = rawText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
    if (!match || match.length === 0) {
      report.invalidCount++;
      report.rejected.push({
        raw: rawText,
        reason: "No valid email found in line",
        status: "INVALID_SYNTAX",
      });
      continue;
    }

    for (const cand of match) {
      const normalized = normalizeEmail(cand);

      // Check intra-batch duplicate
      if (seenInBatch.has(normalized)) {
        report.duplicateInBatchCount++;
        report.rejected.push({
          email: normalized,
          company,
          reason: `Duplicate entry within the same input batch: ${normalized}`,
          status: "DUPLICATE_IN_BATCH",
        });
        continue;
      }
      seenInBatch.add(normalized);
      report.uniqueCount++;

      // Evaluate through safety pipeline
      const verdict = evaluateEmailSafety(normalized, {
        ...options,
        company,
        acquireLock: false, // Never acquire send lock during pre-flight preview/import
      });

      if (verdict.eligible) {
        report.eligibleCount++;
        report.ready.push({
          email: verdict.normalizedEmail,
          company: verdict.company,
          domain: verdict.domain,
          status: "ELIGIBLE",
        });
      } else {
        if (verdict.status === "BLOCKED_PERSONAL_DOMAIN") report.personalBlockedCount++;
        else if (verdict.status === "BLOCKED_DISPOSABLE_DOMAIN") report.disposableBlockedCount++;
        else if (verdict.status === "SUPPRESSED") report.suppressedCount++;
        else if (verdict.status === "SKIPPED_COOLDOWN") report.cooldownCount++;
        else if (verdict.status === "RECRUITER_POLICY_BLOCKED") report.recruiterBlockedCount++;
        else if (verdict.status === "INVALID_SYNTAX") report.invalidCount++;

        report.rejected.push({
          email: verdict.normalizedEmail,
          company: verdict.company,
          reason: verdict.reason,
          status: verdict.status,
          domain: verdict.domain,
          lastContactDate: verdict.lastContactDate || null,
          unlockDate: verdict.unlockDate || null,
        });
      }
    }
  }

  report.summary = {
    INPUT: report.inputTotal,
    UNIQUE: report.uniqueCount,
    ELIGIBLE: report.eligibleCount,
    PERSONAL_BLOCKED: report.personalBlockedCount,
    DISPOSABLE_BLOCKED: report.disposableBlockedCount,
    INVALID: report.invalidCount,
    DUPLICATE_IN_BATCH: report.duplicateInBatchCount,
    SUPPRESSED: report.suppressedCount,
    COOLDOWN: report.cooldownCount,
    RECRUITER_COOLDOWN: report.recruiterBlockedCount,
  };

  return report;
}

module.exports = {
  DEFAULT_PERSONAL_DOMAINS,
  DEFAULT_DISPOSABLE_DOMAINS,
  loadBlockedDomains,
  saveBlockedDomains,
  normalizeEmail,
  validateSyntax,
  isPersonalEmailDomain,
  isDisposableEmailDomain,
  isCustomBlockedDomain,
  acquireSendLock,
  releaseSendLock,
  hasActiveSendLock,
  getActiveSendLocksCount,
  evaluateEmailSafety,
  evaluateBatchSafety,
};
