/**
 * ResumeAuto Engine — Suppression List & Opt-Out Management
 * Ensures 100% compliance with opt-out requests, hard-bounce suppression,
 * and duplicate contact protection.
 */

const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync, withFileLock } = require("./storage");

const SUPPRESSION_FILE = path.resolve("./suppression_list.json");

// In-memory cache for ultra-fast lookup
let _suppressionCache = null;
let _suppressedEmails = new Set();
let _suppressedDomains = new Set();

/**
 * Load or initialize the suppression list.
 */
function loadSuppressionList() {
  if (_suppressionCache) return _suppressionCache;
  const data = safeReadJsonSync(SUPPRESSION_FILE, {
    emails: [],
    domains: [
      "apple.com",
      "naukri.com",
      "insideapple.apple.com",
      "linkedin.com",
      "mailer-daemon",
      "postmaster",
      "noreply.com",
      "no-reply.com",
    ],
    updatedAt: new Date().toISOString(),
  });

  _suppressionCache = data;
  _suppressedEmails = new Set(data.emails.map(e => (typeof e === "string" ? e : e.email).toLowerCase().trim()));
  _suppressedDomains = new Set(data.domains.map(d => d.toLowerCase().trim()));
  return _suppressionCache;
}

/**
 * Check if an email address or its domain is on the suppression list.
 * Returns { suppressed: boolean, reason?: string, type?: string }
 */
function isSuppressed(email) {
  if (!email || typeof email !== "string") {
    return { suppressed: true, reason: "Invalid email string", type: "invalid" };
  }

  loadSuppressionList();
  const clean = email.trim().toLowerCase();

  // Check exact email
  if (_suppressedEmails.has(clean)) {
    const record = _suppressionCache.emails.find(
      e => (typeof e === "string" ? e : e.email).toLowerCase().trim() === clean
    );
    const reason = typeof record === "object" ? record.reason : "Suppressed on user request / Opt-out";
    const type = typeof record === "object" ? record.type : "opt_out";
    return { suppressed: true, reason, type };
  }

  // Check domain
  const atIdx = clean.indexOf("@");
  if (atIdx !== -1) {
    const domain = clean.slice(atIdx + 1);
    if (_suppressedDomains.has(domain)) {
      return { suppressed: true, reason: `Domain @${domain} is on suppression list`, type: "domain_suppressed" };
    }
  }

  return { suppressed: false };
}

/**
 * Add an email or domain to the suppression list.
 */
async function addSuppression({ email, domain, reason = "Opted out / Unsubscribed", type = "opt_out" }) {
  return await withFileLock(SUPPRESSION_FILE, async () => {
    loadSuppressionList();
    let modified = false;

    if (email) {
      const cleanEmail = email.trim().toLowerCase();
      if (!_suppressedEmails.has(cleanEmail)) {
        _suppressionCache.emails.push({
          email: cleanEmail,
          target: cleanEmail,
          reason,
          type,
          addedAt: new Date().toISOString(),
        });
        _suppressedEmails.add(cleanEmail);
        modified = true;
      }
    }

    if (domain) {
      const cleanDomain = domain.trim().toLowerCase().replace(/^@/, "");
      if (!_suppressedDomains.has(cleanDomain)) {
        _suppressionCache.domains.push(cleanDomain);
        _suppressedDomains.add(cleanDomain);
        modified = true;
      }
    }

    if (modified) {
      _suppressionCache.updatedAt = new Date().toISOString();
      atomicWriteJsonSync(SUPPRESSION_FILE, _suppressionCache);
    }

    return { ok: true, count: _suppressionCache.emails.length };
  });
}

/**
 * Remove an email or domain from the suppression list.
 */
async function removeSuppression({ email, domain }) {
  return await withFileLock(SUPPRESSION_FILE, async () => {
    loadSuppressionList();
    let modified = false;

    if (email) {
      const cleanEmail = email.trim().toLowerCase();
      if (_suppressedEmails.has(cleanEmail)) {
        _suppressionCache.emails = _suppressionCache.emails.filter(
          e => (typeof e === "string" ? e : (e.email || e.target || "")).toLowerCase().trim() !== cleanEmail
        );
        _suppressedEmails.delete(cleanEmail);
        modified = true;
      }
    }

    if (domain) {
      const cleanDomain = domain.trim().toLowerCase().replace(/^@/, "");
      if (_suppressedDomains.has(cleanDomain)) {
        _suppressionCache.domains = _suppressionCache.domains.filter(
          d => d.toLowerCase().trim() !== cleanDomain
        );
        _suppressedDomains.delete(cleanDomain);
        modified = true;
      }
    }

    if (modified) {
      _suppressionCache.updatedAt = new Date().toISOString();
      atomicWriteJsonSync(SUPPRESSION_FILE, _suppressionCache);
    }

    return { ok: true, count: _suppressionCache.emails.length };
  });
}

/**
 * Get all suppressed records for the settings / dashboard view.
 */
function getSuppressionSummary() {
  loadSuppressionList();
  return {
    totalEmails: _suppressionCache.emails.length,
    totalDomains: _suppressionCache.domains.length,
    emails: _suppressionCache.emails,
    domains: _suppressionCache.domains,
    updatedAt: _suppressionCache.updatedAt,
  };
}

module.exports = {
  loadSuppressionList,
  isSuppressed,
  addSuppression,
  removeSuppression,
  getSuppressionSummary,
};
