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
let _suppressedCompanies = new Set();

const SUPPRESSION_REASONS = [
  "OPT_OUT",
  "BOUNCE",
  "COMPLAINT",
  "DO_NOT_CONTACT",
  "MANUAL_BLOCK",
];

function normalizeCompanyName(name) {
  if (!name || typeof name !== "string") return "";
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

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
    companies: [],
    updatedAt: new Date().toISOString(),
  });

  if (!Array.isArray(data.companies)) {
    data.companies = [];
  }

  _suppressionCache = data;
  _suppressedEmails = new Set(data.emails.map(e => (typeof e === "string" ? e : e.email).toLowerCase().trim()));
  _suppressedDomains = new Set(data.domains.map(d => d.toLowerCase().trim()));
  _suppressedCompanies = new Set(data.companies.map(c => normalizeCompanyName(typeof c === "string" ? c : c.company)).filter(Boolean));
  return _suppressionCache;
}

/**
 * Check if an email address, its domain, or its company is on the suppression list.
 * Returns { suppressed: boolean, reason?: string, type?: string }
 */
function isSuppressed(email, company = "") {
  if (!email || typeof email !== "string") {
    return { suppressed: true, reason: "Invalid email string", type: "invalid" };
  }

  loadSuppressionList();
  const clean = email.trim().toLowerCase();

  // 1. Check exact email
  if (_suppressedEmails.has(clean)) {
    const record = _suppressionCache.emails.find(
      e => (typeof e === "string" ? e : e.email).toLowerCase().trim() === clean
    );
    const reason = typeof record === "object" ? record.reason : "Suppressed on user request / Opt-out";
    const type = typeof record === "object" ? (record.type || "opt_out") : "opt_out";
    return { suppressed: true, reason, type };
  }

  // 2. Check domain
  const atIdx = clean.indexOf("@");
  if (atIdx !== -1) {
    const domain = clean.slice(atIdx + 1);
    if (_suppressedDomains.has(domain)) {
      return { suppressed: true, reason: `Domain @${domain} is on suppression list`, type: "domain_suppressed" };
    }
  }

  // 3. Check company
  if (company && typeof company === "string") {
    const normComp = normalizeCompanyName(company);
    if (normComp && _suppressedCompanies.has(normComp)) {
      const record = _suppressionCache.companies.find(
        c => normalizeCompanyName(typeof c === "string" ? c : c.company) === normComp
      );
      const reason = typeof record === "object" ? record.reason : `Company ${company} is suppressed`;
      const type = typeof record === "object" ? (record.type || "DO_NOT_CONTACT") : "DO_NOT_CONTACT";
      return { suppressed: true, reason, type };
    }
  }

  return { suppressed: false };
}

/**
 * Add an email, domain, or company to the suppression list.
 */
async function addSuppression({ email, domain, company, reason = "Opted out / Unsubscribed", type = "opt_out" }) {
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

    if (company) {
      const normComp = normalizeCompanyName(company);
      if (normComp && !_suppressedCompanies.has(normComp)) {
        if (!_suppressionCache.companies) _suppressionCache.companies = [];
        _suppressionCache.companies.push({
          company: company.trim(),
          normalized: normComp,
          reason,
          type,
          addedAt: new Date().toISOString(),
        });
        _suppressedCompanies.add(normComp);
        modified = true;
      }
    }

    if (modified) {
      _suppressionCache.updatedAt = new Date().toISOString();
      atomicWriteJsonSync(SUPPRESSION_FILE, _suppressionCache);
    }

    return {
      ok: true,
      totalEmails: _suppressionCache.emails.length,
      totalDomains: _suppressionCache.domains.length,
      totalCompanies: (_suppressionCache.companies || []).length,
    };
  });
}

/**
 * Remove an email, domain, or company from the suppression list.
 */
async function removeSuppression({ email, domain, company }) {
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

    if (company) {
      const normComp = normalizeCompanyName(company);
      if (normComp && _suppressedCompanies.has(normComp)) {
        _suppressionCache.companies = (_suppressionCache.companies || []).filter(
          c => normalizeCompanyName(typeof c === "string" ? c : c.company) !== normComp
        );
        _suppressedCompanies.delete(normComp);
        modified = true;
      }
    }

    if (modified) {
      _suppressionCache.updatedAt = new Date().toISOString();
      atomicWriteJsonSync(SUPPRESSION_FILE, _suppressionCache);
    }

    return {
      ok: true,
      totalEmails: _suppressionCache.emails.length,
      totalDomains: _suppressionCache.domains.length,
      totalCompanies: (_suppressionCache.companies || []).length,
    };
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
    totalCompanies: (_suppressionCache.companies || []).length,
    emails: _suppressionCache.emails,
    domains: _suppressionCache.domains,
    companies: _suppressionCache.companies || [],
    reasons: SUPPRESSION_REASONS,
    updatedAt: _suppressionCache.updatedAt,
  };
}

module.exports = {
  SUPPRESSION_REASONS,
  loadSuppressionList,
  isSuppressed,
  addSuppression,
  removeSuppression,
  getSuppressionSummary,
};

