/**
 * ResumeAuto Engine — CSV & Delimited Text Job Source Adapter
 * Parses spreadsheets, CSVs, and tab-delimited text exports into normalized Jobs.
 */

const JobSource = require("./baseSource");

class CsvJobSource extends JobSource {
  constructor() {
    super("CSV_Import", "file");
  }

  async parse(input) {
    if (!input || typeof input !== "string") return [];
    const lines = input.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return [];

    const firstLine = lines[0];
    let delimiter = ",";
    if (firstLine.includes("\t")) delimiter = "\t";
    else if (firstLine.includes(";") && !firstLine.includes(",")) delimiter = ";";

    const rows = [];
    let headers = null;

    // Detect header row
    const firstCols = firstLine.split(delimiter).map(c => c.trim().toLowerCase().replace(/['"]/g, ""));
    const hasHeader = firstCols.some(c => /role|title|company|email|job|position/i.test(c));

    const startIndex = hasHeader ? 1 : 0;
    if (hasHeader) {
      headers = firstCols;
    }

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("#")) continue;

      // Handle simple CSV splitting with quotes
      const cols = line.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ""));
      if (!cols.length) continue;

      if (headers) {
        const item = {};
        headers.forEach((h, idx) => {
          const val = cols[idx] || "";
          if (/email/i.test(h)) item.email = val;
          else if (/company/i.test(h)) item.company = val;
          else if (/title|role|position|designation/i.test(h)) item.job_title = val;
          else if (/location|city/i.test(h)) item.location = val;
          else if (/url|link/i.test(h)) item.job_url = val;
          else if (/skill/i.test(h)) item.skills = val;
          else if (/exp/i.test(h)) item.experience_required = val;
          else if (/id/i.test(h)) item.external_job_id = val;
          else if (/status/i.test(h)) item.status = val;
          else if (/note/i.test(h)) item.notes = val;
        });
        if (item.email || item.company || item.job_title) {
          rows.push(item);
        }
      } else {
        // Fallback positional format: email, company, role
        const email = cols[0] || "";
        const company = cols[1] || "Target Company";
        const role = cols[2] || "Python Developer";
        if (email.includes("@") || company) {
          rows.push({ email, company, job_title: role });
        }
      }
    }

    return rows;
  }
}

module.exports = CsvJobSource;
