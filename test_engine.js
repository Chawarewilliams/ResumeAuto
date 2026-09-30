/**
 * ResumeAuto Engine — Test Suite
 * Validates deduplication, transparent matching, resume selection, suppression, and template rendering.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { atomicWriteJsonSync, safeReadJsonSync } = require("./engine/storage");
const { isSuppressed, addSuppression, removeSuppression } = require("./engine/suppression");
const { createJobRecord, findDuplicateJob, generateJobHash } = require("./engine/jobModel");
const { checkOutreachSafety, upsertRecruiter } = require("./engine/recruiterModel");
const { calculateJobMatch } = require("./engine/matchingEngine");
const { selectOptimalResume } = require("./engine/resumeManager");
const { renderTemplate } = require("./engine/templateEngine");
const { ingestJobsFromSource } = require("./engine/sources");
const { logActivity, queryActivityLogs } = require("./engine/activityLogger");

async function runTests() {
  console.log("🚀 Starting ResumeAuto Engine Test Suite...\n");
  let passed = 0;

  // ─── 1. Storage & Atomic Write Tests ────────────────────────
  console.log("Test 1: Storage Atomic Operations");
  const testJsonPath = path.resolve("./test_temp_storage.json");
  atomicWriteJsonSync(testJsonPath, { test: 123, status: "ok" });
  const readBack = safeReadJsonSync(testJsonPath);
  assert.strictEqual(readBack.test, 123);
  assert.strictEqual(readBack.status, "ok");
  if (fs.existsSync(testJsonPath)) fs.unlinkSync(testJsonPath);
  console.log("  ✅ Atomic write & read passed");
  passed++;

  // ─── 2. Suppression List Tests ──────────────────────────────
  console.log("Test 2: Suppression & Opt-Out Shield");
  await addSuppression({ email: "optout.test@company.com", reason: "Requested opt-out" });
  const check1 = isSuppressed("optout.test@company.com");
  assert.strictEqual(check1.suppressed, true);
  assert.strictEqual(check1.type, "opt_out");

  const check2 = isSuppressed("clean.recruiter@goodfirm.com");
  assert.strictEqual(check2.suppressed, false);

  const checkDomain = isSuppressed("news@insideapple.apple.com");
  assert.strictEqual(checkDomain.suppressed, true); // apple.com is suppressed

  await removeSuppression({ email: "optout.test@company.com" });
  console.log("  ✅ Suppression check & opt-out management passed");
  passed++;

  // ─── 3. Job Model & 4-Level Deduplication ───────────────────
  console.log("Test 3: Multi-Layer Duplicate Detection");
  const jobA = createJobRecord({
    job_title: "Python Backend Developer",
    company: "Acme Corp",
    location: "Pune, India",
    job_url: "https://acme.com/jobs/12345?utm_source=linkedin&ref=board",
    external_job_id: "ACM-123",
  });
  assert.strictEqual(jobA.job_title, "Python Backend Developer");
  assert.strictEqual(jobA.normalized_url, "acme.com/jobs/12345");

  // Duplicate test 1: external_job_id
  const dupe1 = findDuplicateJob({ external_job_id: "ACM-123", company: "Other" }, [jobA]);
  assert.ok(dupe1 && dupe1.duplicate);
  assert.ok(dupe1.reason.includes("external_job_id"));

  // Duplicate test 2: normalized URL
  const dupe2 = findDuplicateJob({ job_url: "https://acme.com/jobs/12345/?utm_campaign=winter" }, [jobA]);
  assert.ok(dupe2 && dupe2.duplicate);
  assert.ok(dupe2.reason.includes("normalized URL"));

  // Duplicate test 3: company + title + location
  const dupe3 = findDuplicateJob({ company: "Acme Corp", job_title: "Python Backend Developer", location: "Pune, India" }, [jobA]);
  assert.ok(dupe3 && dupe3.duplicate);

  // Non-duplicate test
  const uniqueJob = findDuplicateJob({ company: "New Tech", job_title: "FastAPI Lead", location: "Remote" }, [jobA]);
  assert.strictEqual(uniqueJob, null);
  console.log("  ✅ 4-layer duplicate detection passed");
  passed++;

  // ─── 4. Recruiter Model & Anti-Harassment Safety ────────────
  console.log("Test 4: Recruiter Anti-Harassment Shield");
  upsertRecruiter({
    email: "hr@acme.com",
    company: "Acme Corp",
    name: "Jane Doe",
    contact_count: 3,
  });
  const safetyCheck = checkOutreachSafety("hr@acme.com", "Acme Corp", { maxContacts: 3 });
  assert.strictEqual(safetyCheck.safe, false);
  assert.ok(safetyCheck.reason.includes("already contacted 3 times"));

  const safetyCheckFresh = checkOutreachSafety("fresh.lead@acme.com", "Acme Corp");
  assert.strictEqual(safetyCheckFresh.safe, true);
  console.log("  ✅ Recruiter safety checks passed");
  passed++;

  // ─── 5. Transparent Job Matching Engine ─────────────────────
  console.log("Test 5: Transparent Weighted Job Matching");
  const pythonJob = {
    job_title: "Senior Python Backend Developer",
    description: "Looking for 4 years experience with Python, Django, FastAPI, PostgreSQL, Redis, and Docker in Remote or Pune.",
    location: "Pune, Maharashtra, India (Remote)",
    skills: ["Python", "FastAPI", "Redis", "Docker"],
  };
  const matchResult = calculateJobMatch(pythonJob);
  assert.ok(matchResult.score >= 80, `Expected score >= 80, got ${matchResult.score}`);
  assert.strictEqual(matchResult.tier, "STRONG_MATCH");
  assert.ok(matchResult.breakdown.length >= 4, "Breakdown should have at least 4 factors explained");
  console.log(`  ✅ Match score calculated: ${matchResult.score}% (${matchResult.tier})`);
  console.log(`     Summary: ${matchResult.summary}`);
  passed++;

  // ─── 6. Multi-Resume Track Selection ────────────────────────
  console.log("Test 6: Multi-Resume Track Auto-Selection");
  const aiJob = {
    job_title: "GenAI & LLM Engineer",
    description: "Building autonomous AI agents using LangChain, RAG, and Python.",
  };
  const selectedAi = selectOptimalResume(aiJob);
  assert.strictEqual(selectedAi.selectedResume.id, "ai_ml");

  const backendJob = {
    job_title: "Python Backend API Engineer",
    description: "High-scale FastAPI and Django REST microservices with PostgreSQL.",
  };
  const selectedBackend = selectOptimalResume(backendJob);
  assert.strictEqual(selectedBackend.selectedResume.id, "backend");
  console.log("  ✅ Auto-selected appropriate resume profile based on requirements");
  passed++;

  // ─── 7. Template Variable Rendering ─────────────────────────
  console.log("Test 7: Template Rendering with Category Variables");
  const tmpl = {
    subject: "Application for {{job_title}} at {{company}}",
    plainText: "Hi {{recruiter_name}}, I have {{experience}} with {{skills}}. Available: {{notice_period}}.",
    html: "<p>Hi {{recruiter_name}}</p>",
  };
  const rendered = renderTemplate(tmpl, {
    recruiter_name: "Sarah Connor",
    company: "Cyberdyne Systems",
    job_title: "Senior Python Architect",
  });
  assert.strictEqual(rendered.subject, "Application for Senior Python Architect at Cyberdyne Systems");
  assert.ok(rendered.plainText.includes("Sarah Connor"));
  assert.ok(rendered.plainText.includes("4+ years"));
  assert.ok(rendered.plainText.includes("0 days (Immediate Joiner)"));
  console.log("  ✅ Template rendered variables accurately");
  passed++;

  // ─── 8. Ingestion Adapters ──────────────────────────────────
  console.log("Test 8: Source Ingestion & Deduplication Pipeline");
  const rawCsv = `Email,Company,Role,Location
lead1@startup.io,Startup IO,Python Developer,Remote
lead2@bigcorp.com,BigCorp,Django Backend Engineer,Bengaluru
lead1@startup.io,Startup IO,Python Developer,Remote`; // intentional duplicate line

  const ingestRes = await ingestJobsFromSource("csv", rawCsv, []);
  assert.strictEqual(ingestRes.totalParsed, 3);
  assert.strictEqual(ingestRes.newJobs.length, 2);
  assert.strictEqual(ingestRes.duplicateJobs.length, 1);
  assert.ok(ingestRes.newJobs[0].match_score > 0);
  console.log("  ✅ Source ingestion filtered duplicate and scored new jobs");
  passed++;

  // ─── 9. Structured Activity Logger ──────────────────────────
  console.log("Test 9: Activity Logger Event Auditing");
  logActivity({
    eventType: "JOB_DISCOVERED",
    entity: "Job",
    status: "SUCCESS",
    message: "Discovered 2 new Python roles via CSV",
  });
  const logs = queryActivityLogs({ limit: 5 });
  assert.ok(logs.length > 0);
  assert.strictEqual(logs[0].eventType, "JOB_DISCOVERED");
  console.log("  ✅ Activity logger successfully captured and indexed event");
  passed++;

  console.log(`\n🎉 ALL ${passed}/9 ENGINE TESTS PASSED PERFECTLY!\n`);
}

runTests().catch(err => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
