/**
 * ResumeAuto Engine — Unified Job Model & 4-Level Deduplication Engine
 *
 * Implements:
 * 1. external_job_id check
 * 2. Normalized job URL check
 * 3. company + job_title + location check
 * 4. Content hash check (SHA-256)
 */

const crypto = require("crypto");
const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync, withFileLock } = require("./storage");

const JOBS_FILE = path.resolve("./jobs.json");

const APPLICATION_STATUSES = [
  "NEW",
  "MATCHED",
  "REVIEW",
  "READY_TO_CONTACT",
  "CONTACTED",
  "APPLIED",
  "REPLIED",
  "INTERVIEW",
  "REJECTED",
  "CLOSED",
  "SKIPPED",
];

/**
 * Normalizes a URL by removing tracking params, hashes, and protocol variations.
 */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl.trim());
    // Strip common analytics / tracking query parameters
    const paramsToDelete = [];
    for (const key of parsed.searchParams.keys()) {
      if (/^(utm_|ref|source|tracking|fbclid|gclid)/i.test(key)) {
        paramsToDelete.push(key);
      }
    }
    paramsToDelete.forEach(p => parsed.searchParams.delete(p));
    // Normalize path (remove trailing slash)
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.hash = "";
    return `${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, "");
  }
}

/**
 * Generate a deterministic content hash for a job.
 */
function generateJobHash({ company = "", job_title = "", location = "", description = "", skills = [] }) {
  const normCompany = company.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normTitle = job_title.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normLoc = location.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const normSkills = Array.isArray(skills) ? [...skills].sort().join(",").toLowerCase() : "";
  const normDesc = description.trim().toLowerCase().slice(0, 300);

  const payload = `${normCompany}|${normTitle}|${normLoc}|${normSkills}|${normDesc}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}

/**
 * Standardize and normalize raw input into a complete Job record.
 * Preserves legacy fields (role, dateSent, status) for 100% backward compatibility.
 */
function createJobRecord(raw) {
  const now = new Date().toISOString();
  const title = (raw.job_title || raw.role || "Python Developer").trim();
  const company = (raw.company || "Target Company").trim();
  const location = (raw.location || "Remote / India").trim();
  const url = (raw.job_url || raw.url || "").trim();
  const normalizedUrl = normalizeUrl(url);

  const skills = Array.isArray(raw.skills)
    ? raw.skills
    : typeof raw.skills === "string"
    ? raw.skills.split(/[,|]/).map(s => s.trim()).filter(Boolean)
    : [];

  const duplicateHash = raw.duplicate_hash || generateJobHash({
    company,
    job_title: title,
    location,
    description: raw.description || "",
    skills,
  });

  const appStatus = (raw.application_status || raw.status || "NEW").toUpperCase();
  const validAppStatus = APPLICATION_STATUSES.includes(appStatus) ? appStatus : "NEW";

  const record = {
    id: raw.id || `${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
    source: raw.source || "Direct",
    external_job_id: raw.external_job_id || null,
    job_url: url,
    normalized_url: normalizedUrl,
    company: company,
    company_domain: raw.company_domain || (raw.email && raw.email.includes("@") ? raw.email.split("@")[1].toLowerCase() : ""),
    job_title: title,
    location: location,
    work_mode: raw.work_mode || "Hybrid",
    experience_required: raw.experience_required || "3-5 years",
    salary: raw.salary || "Competitive",
    skills: skills,
    description: raw.description || "",
    posted_at: raw.posted_at || null,
    scraped_at: raw.scraped_at || now,
    job_status: raw.job_status || "OPEN",
    application_status: validAppStatus,
    match_score: typeof raw.match_score === "number" ? raw.match_score : 0,
    match_details: raw.match_details || null,
    duplicate_hash: duplicateHash,
    created_at: raw.createdAt || raw.created_at || now,
    updated_at: raw.updated_at || now,

    // Backward compatibility aliases for existing dashboard:
    role: title,
    email: raw.email || "",
    dateSent: raw.dateSent || null,
    status: raw.status || validAppStatus.toLowerCase(),
    notes: raw.notes || "",
    abSlot: raw.abSlot || "A",
    opened: Boolean(raw.opened),
    openedCount: raw.openedCount || 0,
    resumeClicked: Boolean(raw.resumeClicked),
    resumeClickedCount: raw.resumeClickedCount || 0,
    sequenceStopped: Boolean(raw.sequenceStopped),
  };

  return record;
}

/**
 * Multi-layer duplicate detector.
 * Checks against existing list of jobs using 4 checks:
 * 1. external_job_id
 * 2. normalized_url
 * 3. company + title + location key
 * 4. duplicate_hash
 */
function findDuplicateJob(candidate, existingJobs) {
  if (!Array.isArray(existingJobs) || existingJobs.length === 0) return null;

  const candNormUrl = normalizeUrl(candidate.job_url || candidate.url);
  const candExtId = candidate.external_job_id ? String(candidate.external_job_id).trim() : null;
  const candCompany = (candidate.company || "").trim().toLowerCase();
  const candTitle = (candidate.job_title || candidate.role || "").trim().toLowerCase();
  const candLoc = (candidate.location || "").trim().toLowerCase();
  const candHash = candidate.duplicate_hash || generateJobHash({
    company: candidate.company,
    job_title: candTitle,
    location: candLoc,
    description: candidate.description,
    skills: candidate.skills,
  });

  for (const job of existingJobs) {
    // 1. External ID check (if present on both)
    if (candExtId && job.external_job_id && String(job.external_job_id).trim() === candExtId) {
      return { duplicate: true, reason: `Matches external_job_id: ${candExtId}`, matchedJob: job };
    }

    // 2. Normalized URL check
    if (candNormUrl && job.normalized_url && job.normalized_url === candNormUrl) {
      return { duplicate: true, reason: `Matches normalized URL: ${job.job_url}`, matchedJob: job };
    }

    // 3. Company + Job Title + Location check
    const jobComp = (job.company || "").trim().toLowerCase();
    const jobTitle = (job.job_title || job.role || "").trim().toLowerCase();
    const jobLoc = (job.location || "").trim().toLowerCase();
    if (candCompany && candTitle && candCompany === jobComp && candTitle === jobTitle && candLoc === jobLoc) {
      return { duplicate: true, reason: `Matches company, title and location (${jobComp} - ${jobTitle})`, matchedJob: job };
    }

    // 4. Content hash check
    if (candHash && (job.duplicate_hash === candHash)) {
      return { duplicate: true, reason: `Matches content hash`, matchedJob: job };
    }

    // Legacy check: If email matches and same role
    if (candidate.email && job.email && candidate.email.toLowerCase().trim() === job.email.toLowerCase().trim()) {
      return { duplicate: true, reason: `Recruiter email already registered: ${job.email}`, matchedJob: job };
    }
  }

  return null;
}

module.exports = {
  APPLICATION_STATUSES,
  normalizeUrl,
  generateJobHash,
  createJobRecord,
  findDuplicateJob,
};
