/**
 * ResumeAuto Engine — Recruiter Database & Anti-Harassment Outreach Shield
 * Manages recruiter contacts and prevents repeated/duplicate outreach.
 */

const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync, withFileLock } = require("./storage");
const { isSuppressed } = require("./suppression");

const RECRUITERS_FILE = path.resolve("./recruiters.json");

let _recruitersCache = null;

function loadRecruiters() {
  if (_recruitersCache) return _recruitersCache;
  const list = safeReadJsonSync(RECRUITERS_FILE, []);
  _recruitersCache = Array.isArray(list) ? list : [];
  return _recruitersCache;
}

function saveRecruiters() {
  if (!_recruitersCache) return;
  atomicWriteJsonSync(RECRUITERS_FILE, _recruitersCache);
}

/**
 * Register or update a recruiter record.
 */
function upsertRecruiter(data) {
  loadRecruiters();
  const cleanEmail = (data.email || "").trim().toLowerCase();
  if (!cleanEmail) return null;

  const now = new Date().toISOString();
  let existing = _recruitersCache.find(r => r.email === cleanEmail);

  if (existing) {
    if (data.name && (!existing.name || existing.name === "Hiring Team")) existing.name = data.name;
    if (data.company && (!existing.company || existing.company === "Target Company")) existing.company = data.company;
    if (data.designation) existing.designation = data.designation;
    if (data.linkedin_url) existing.linkedin_url = data.linkedin_url;
    if (data.verified_status) existing.verified_status = data.verified_status;
    if (data.reply_status) existing.reply_status = data.reply_status;
    if (data.notes) existing.notes = (existing.notes ? existing.notes + " | " : "") + data.notes;
    existing.updated_at = now;
    saveRecruiters();
    return existing;
  }

  const newRecruiter = {
    id: data.id || `rec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: data.name || "Hiring Manager",
    email: cleanEmail,
    company: data.company || "Target Company",
    designation: data.designation || "Recruiter / Talent Acquisition",
    linkedin_url: data.linkedin_url || "",
    source: data.source || "Direct",
    verified_status: data.verified_status || "PENDING",
    last_contacted_at: data.last_contacted_at || null,
    contact_count: data.contact_count || 0,
    reply_status: data.reply_status || "NO_REPLY",
    notes: data.notes || "",
    created_at: now,
    updated_at: now,
  };

  _recruitersCache.push(newRecruiter);
  saveRecruiters();
  return newRecruiter;
}

/**
 * Check whether it is safe to contact a recruiter.
 * Evaluates:
 * 1. Suppression list (opted-out, hard-bounced)
 * 2. Recent contact cooldown (prevents spamming same recruiter within 3 days unless sequence drip)
 * 3. Max outreach attempts threshold
 */
function checkOutreachSafety(email, company, options = {}) {
  const cleanEmail = (email || "").trim().toLowerCase();
  if (!cleanEmail) {
    return { safe: false, reason: "No email address provided" };
  }

  // 1. Suppression check
  const suppression = isSuppressed(cleanEmail);
  if (suppression.suppressed) {
    return { safe: false, reason: `Recipient suppressed: ${suppression.reason}` };
  }

  loadRecruiters();
  const recruiter = _recruitersCache.find(r => r.email === cleanEmail);
  if (!recruiter) {
    return { safe: true, recruiter: null };
  }

  // 2. Opt-out or rejected status
  if (recruiter.reply_status === "NOT_INTERESTED" || recruiter.reply_status === "UNSUBSCRIBED") {
    return { safe: false, reason: `Recruiter marked as ${recruiter.reply_status}`, recruiter };
  }

  // 3. Max contact frequency
  const maxContacts = options.maxContacts || 3;
  if (recruiter.contact_count >= maxContacts && !options.isDripStep) {
    return {
      safe: false,
      reason: `Recruiter already contacted ${recruiter.contact_count} times (max ${maxContacts})`,
      recruiter
    };
  }

  // 4. Cooldown (same recruiter contacted within last 24h)
  if (recruiter.last_contacted_at && !options.isDripStep) {
    const elapsedHours = (Date.now() - new Date(recruiter.last_contacted_at).getTime()) / 3600000;
    if (elapsedHours < 24) {
      return {
        safe: false,
        reason: `Cooldown active: contacted ${Math.round(elapsedHours)}h ago (<24h)`,
        recruiter
      };
    }
  }

  return { safe: true, recruiter };
}

/**
 * Record a successful outreach attempt for a recruiter.
 */
function recordOutreach(email, company) {
  const recruiter = upsertRecruiter({ email, company });
  if (recruiter) {
    recruiter.contact_count = (recruiter.contact_count || 0) + 1;
    recruiter.last_contacted_at = new Date().toISOString();
    recruiter.updated_at = new Date().toISOString();
    saveRecruiters();
  }
  return recruiter;
}

module.exports = {
  loadRecruiters,
  upsertRecruiter,
  checkOutreachSafety,
  recordOutreach,
};
