/**
 * Unit Test Suite for Email Safety Engine & Duplicate Protection System
 */

const assert = require("assert");
const {
  normalizeEmail,
  validateSyntax,
  isPersonalEmailDomain,
  isDisposableEmailDomain,
  acquireSendLock,
  releaseSendLock,
  hasActiveSendLock,
  evaluateEmailSafety,
  evaluateBatchSafety,
} = require("./engine/safetyEngine");
const { addSuppression, removeSuppression } = require("./engine/suppression");

async function runSafetyEngineTests() {
  console.log("🛡️ Running Email Safety Engine Test Suite...\n");
  let passed = 0;

  // 1. Normalization
  console.log("Test 1: Email Normalization");
  assert.strictEqual(normalizeEmail("  HR@Company.COM  "), "hr@company.com");
  assert.strictEqual(normalizeEmail("<recruiter@acme.org>"), "recruiter@acme.org");
  assert.strictEqual(normalizeEmail('"Lead.Dev@Tech.io."'), "lead.dev@tech.io");
  assert.strictEqual(normalizeEmail("email: talent@startup.in;"), "talent@startup.in");
  console.log("  ✅ Normalization cleans quotes, brackets, prefixes and casing");
  passed++;

  // 2. Syntax Validation
  console.log("Test 2: RFC 5321 Syntax & Dummy Filter");
  assert.strictEqual(validateSyntax("valid.talent@corp.com").valid, true);
  assert.strictEqual(validateSyntax("invalid..double@corp.com").valid, false);
  assert.strictEqual(validateSyntax("no-at-sign.com").valid, false);
  assert.strictEqual(validateSyntax("bad@domain").valid, false); // no TLD
  assert.strictEqual(validateSyntax("user@example.com").valid, false); // dummy
  assert.strictEqual(validateSyntax("recruiter@company.com").valid, false); // dummy
  console.log("  ✅ Syntax validation strictly enforces RFC rules and blocks dummy emails");
  passed++;

  // 3. Personal Domain Blocking
  console.log("Test 3: Personal Email Provider Blocking");
  const personalTestDomains = [
    "gmail.com",
    "yahoo.com",
    "yahoo.co.in",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "icloud.com",
    "protonmail.com",
    "rediffmail.com",
  ];
  for (const dom of personalTestDomains) {
    assert.strictEqual(isPersonalEmailDomain(dom), true, `Domain ${dom} should be flagged as personal`);
    const verdict = evaluateEmailSafety(`recruiter@${dom}`);
    assert.strictEqual(verdict.eligible, false);
    assert.strictEqual(verdict.status, "BLOCKED_PERSONAL_DOMAIN");
    assert.ok(verdict.reason.includes("Personal email provider"));
  }

  // Corporate domains should be permitted
  const corpVerdict1 = evaluateEmailSafety("hr@company.com");
  assert.strictEqual(corpVerdict1.eligible, true);
  const corpVerdict2 = evaluateEmailSafety("careers@company.in");
  assert.strictEqual(corpVerdict2.eligible, true);
  console.log("  ✅ All personal email domains blocked with exact reason; corporate domains allowed");
  passed++;

  // 4. Disposable Domain Blocking
  console.log("Test 4: Disposable Temporary Domain Blocking");
  assert.strictEqual(isDisposableEmailDomain("mailinator.com"), true);
  assert.strictEqual(isDisposableEmailDomain("temp-mail.org"), true);
  const dispVerdict = evaluateEmailSafety("throwaway@mailinator.com");
  assert.strictEqual(dispVerdict.eligible, false);
  assert.strictEqual(dispVerdict.status, "BLOCKED_DISPOSABLE_DOMAIN");
  console.log("  ✅ Disposable email providers accurately blocked");
  passed++;

  // 5. Suppression Check (Email, Domain, Company)
  console.log("Test 5: Suppression Check (Email, Domain, Company)");
  await addSuppression({ email: "suppressed.lead@enterprise.com", reason: "Opted out", type: "OPT_OUT" });
  await addSuppression({ company: "Blocked MegaCorp", reason: "Do not contact", type: "DO_NOT_CONTACT" });

  const suppVerdict1 = evaluateEmailSafety("suppressed.lead@enterprise.com");
  assert.strictEqual(suppVerdict1.eligible, false);
  assert.strictEqual(suppVerdict1.status, "SUPPRESSED");

  const suppVerdict2 = evaluateEmailSafety("fresh@blockedmegacorp.com", { company: "Blocked MegaCorp" });
  assert.strictEqual(suppVerdict2.eligible, false);
  assert.strictEqual(suppVerdict2.status, "SUPPRESSED");

  // Clean up
  await removeSuppression({ email: "suppressed.lead@enterprise.com", company: "Blocked MegaCorp" });
  console.log("  ✅ Email and company suppression successfully overrides eligibility");
  passed++;

  // 6. In-Flight Send Lock (Worker Race Condition Protection)
  console.log("Test 6: In-Flight Send Lock (Concurrency & Race Condition Guard)");
  const targetEmail = "concurrency.test@firm.com";
  releaseSendLock(targetEmail); // ensure clean

  // Worker A acquires lock
  const lockA = acquireSendLock(targetEmail, { workerId: "worker-A", campaignId: "camp-1" });
  assert.strictEqual(lockA.acquired, true);
  assert.strictEqual(hasActiveSendLock(targetEmail), true);

  // Worker B attempts to send to the same target concurrently
  const evalB = evaluateEmailSafety(targetEmail, { workerId: "worker-B", acquireLock: true });
  assert.strictEqual(evalB.eligible, false);
  assert.strictEqual(evalB.status, "DUPLICATE_ACTIVE_LOCK");
  assert.ok(evalB.reason.includes("currently in-flight by an active worker"));

  // Worker A completes send and releases lock
  const released = releaseSendLock(targetEmail);
  assert.strictEqual(released, true);
  assert.strictEqual(hasActiveSendLock(targetEmail), false);

  // Now Worker B or next task can safely evaluate
  const evalB2 = evaluateEmailSafety(targetEmail, { workerId: "worker-B", acquireLock: false });
  assert.strictEqual(evalB2.eligible, true);
  console.log("  ✅ Atomic in-flight send lock stops concurrent double-send race conditions");
  passed++;

  // 7. Batch Evaluation & Quality Report
  console.log("Test 7: Batch Evaluation & Import Quality Report");
  const batchInput = [
    "lead.partner@acmeworks.com, Acme Works",
    "hr@gmail.com, Google Recruiter", // personal
    "lead.partner@acmeworks.com, Acme Works", // duplicate in batch
    "recruiter@mailinator.com", // disposable
    "not-an-email-here", // invalid
    "fresh.lead@techstart.io, TechStart", // eligible
  ];

  const qualityReport = evaluateBatchSafety(batchInput);
  assert.strictEqual(qualityReport.uniqueCount, 4);
  assert.strictEqual(qualityReport.duplicateInBatchCount, 1);
  assert.strictEqual(qualityReport.personalBlockedCount, 1);
  assert.strictEqual(qualityReport.disposableBlockedCount, 1);
  assert.strictEqual(qualityReport.invalidCount, 1);
  assert.strictEqual(qualityReport.eligibleCount, 2); // lead.partner@acmeworks.com and fresh.lead@techstart.io
  assert.strictEqual(qualityReport.ready.length, 2);
  console.log("  ✅ Import Quality Report produces exact categorized metrics");
  passed++;

  console.log(`\n🎉 ALL ${passed}/7 EMAIL SAFETY ENGINE TESTS PASSED!\n`);
}

runSafetyEngineTests().catch(err => {
  console.error("❌ Safety engine test failed:", err);
  process.exit(1);
});
