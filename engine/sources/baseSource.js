/**
 * ResumeAuto Engine — Abstract Job Source Adapter
 * All job ingestion feeds must inherit from JobSource and return normalized Job records.
 */

const { createJobRecord } = require("../jobModel");

class JobSource {
  constructor(name, type = "generic") {
    this.name = name;
    this.type = type;
  }

  /**
   * Parse input data (string, buffer, object) into an array of raw items.
   */
  async parse(input) {
    throw new Error(`[JobSource: ${this.name}] parse() must be implemented by subclass.`);
  }

  /**
   * Normalize a raw item into the standard Job record schema.
   */
  normalize(rawItem) {
    return createJobRecord({
      ...rawItem,
      source: this.name,
    });
  }

  /**
   * Execute full ingestion pipeline on raw data:
   * parse -> normalize -> return standardized jobs
   */
  async ingest(input) {
    const rawItems = await this.parse(input);
    const normalized = [];
    for (const raw of rawItems) {
      if (!raw) continue;
      const job = this.normalize(raw);
      normalized.push(job);
    }
    return normalized;
  }
}

module.exports = JobSource;
