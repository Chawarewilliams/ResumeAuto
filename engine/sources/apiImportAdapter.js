/**
 * ResumeAuto Engine — API / JSON Payload Job Source Adapter
 * Handles structured job array imports from REST webhooks or external feeds.
 */

const JobSource = require("./baseSource");

class ApiImportJobSource extends JobSource {
  constructor() {
    super("API_Feed", "api");
  }

  async parse(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (typeof input === "object" && Array.isArray(input.jobs)) return input.jobs;
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        return Array.isArray(parsed) ? parsed : (parsed.jobs || [parsed]);
      } catch (_) {
        return [];
      }
    }
    return [];
  }
}

module.exports = ApiImportJobSource;
