/**
 * ResumeAuto Engine — Job Source Ingestion Manager
 * Coordinates multi-source ingestion, deduplication, match scoring, and DB persistence.
 */

const CsvJobSource = require("./csvAdapter");
const ApiImportJobSource = require("./apiImportAdapter");
const { findDuplicateJob } = require("../jobModel");
const { calculateJobMatch } = require("../matchingEngine");
const { upsertRecruiter } = require("../recruiterModel");

const _adapters = new Map();
const _csv = new CsvJobSource();
const _api = new ApiImportJobSource();

_adapters.set("csv", _csv);
_adapters.set("api", _api);
_adapters.set("api_import", _api);
_adapters.set("json", _api);
_adapters.set("direct", _api);

function registerSource(key, adapterInstance) {
  _adapters.set(key, adapterInstance);
}

function getSource(key, rawData) {
  if (_adapters.has(key)) return _adapters.get(key);
  // Auto-detect based on payload
  if (Array.isArray(rawData) || (typeof rawData === "object" && rawData !== null && !Buffer.isBuffer(rawData))) {
    return _api;
  }
  return _csv;
}

/**
 * Ingest raw jobs through an adapter, filter out duplicates,
 * calculate transparent match scores, and return ingestion results.
 */
async function ingestJobsFromSource(sourceKey, rawData, existingJobs = []) {
  const adapter = getSource(sourceKey, rawData);
  const normalizedJobs = await adapter.ingest(rawData);

  const results = {
    totalParsed: normalizedJobs.length,
    newJobs: [],
    duplicateJobs: [],
    skippedCount: 0,
  };

  const currentJobPool = [...existingJobs];

  for (const candidate of normalizedJobs) {
    // 1. Check multi-level duplicate detection
    const duplicateMatch = findDuplicateJob(candidate, currentJobPool);
    if (duplicateMatch) {
      results.duplicateJobs.push({
        job: candidate,
        reason: duplicateMatch.reason,
      });
      results.skippedCount++;
      continue;
    }

    // 2. Calculate transparent match score
    const match = calculateJobMatch(candidate);
    candidate.match_score = match.score;
    candidate.match_details = match;
    candidate.application_status = match.score >= 65 ? "MATCHED" : "NEW";

    // 3. Register recruiter contact if email provided
    if (candidate.email) {
      upsertRecruiter({
        email: candidate.email,
        company: candidate.company,
        designation: "Recruiter / Hiring Contact",
        source: adapter.name,
      });
    }

    currentJobPool.unshift(candidate);
    results.newJobs.push(candidate);
  }

  return results;
}

module.exports = {
  registerSource,
  getSource,
  ingestJobsFromSource,
};
