/**
 * ResumeAuto Engine — Structured Activity Log & Event Audit Trail
 * Records every system event (discovery, matching, sending, delivery, replies) with full metadata.
 */

const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync } = require("./storage");

const ACTIVITY_LOG_FILE = path.resolve("./activity_log.json");
const MAX_EVENTS = 1000;

let _logCache = null;

function loadActivityLogs() {
  if (_logCache) return _logCache;
  const list = safeReadJsonSync(ACTIVITY_LOG_FILE, []);
  _logCache = Array.isArray(list) ? list : [];
  return _logCache;
}

function saveActivityLogs() {
  if (!_logCache) return;
  atomicWriteJsonSync(ACTIVITY_LOG_FILE, _logCache.slice(0, MAX_EVENTS));
}

/**
 * Record a structured activity event.
 *
 * @param {Object} event
 * @param {string} event.eventType - e.g. "JOB_DISCOVERED", "MATCH_CALCULATED", "EMAIL_SENT", "REPLY_RECEIVED"
 * @param {string} event.entity - e.g. "Job", "Recruiter", "Email", "Campaign", "System"
 * @param {string} event.status - "SUCCESS", "WARN", "ERROR", "INFO"
 * @param {string} event.message - Human readable description
 * @param {Object} [event.metadata] - Extra details, e.g. { jobId, score, email, error }
 */
function logActivity({ eventType, entity = "System", status = "INFO", message, metadata = {} }) {
  loadActivityLogs();
  const entry = {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    timeFormatted: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    eventType,
    entity,
    status,
    message,
    metadata,
  };

  _logCache.unshift(entry);
  if (_logCache.length > MAX_EVENTS) {
    _logCache = _logCache.slice(0, MAX_EVENTS);
  }
  saveActivityLogs();
  return entry;
}

/**
 * Query activity logs with filtering and pagination.
 */
function queryActivityLogs({ limit = 50, entity, eventType, status } = {}) {
  loadActivityLogs();
  let filtered = _logCache;
  if (entity) {
    filtered = filtered.filter(e => e.entity.toLowerCase() === entity.toLowerCase());
  }
  if (eventType) {
    filtered = filtered.filter(e => e.eventType.toLowerCase() === eventType.toLowerCase());
  }
  if (status) {
    filtered = filtered.filter(e => e.status.toLowerCase() === status.toLowerCase());
  }
  return filtered.slice(0, limit);
}

module.exports = {
  logActivity,
  queryActivityLogs,
};
