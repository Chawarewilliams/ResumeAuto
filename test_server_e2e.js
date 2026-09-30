/**
 * Server End-to-End Integration Test Suite
 * Tests server startup, dashboard HTML rendering, and all new REST endpoints.
 */

const http = require("http");
const { spawn } = require("child_process");
const assert = require("assert");

const TEST_PORT = 3456;

function request(options, data = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: TEST_PORT,
        ...options,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            parsed = body;
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) {
      const payload = typeof data === "string" ? data : JSON.stringify(data);
      req.setHeader("Content-Type", "application/json");
      req.setHeader("Content-Length", Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

async function run() {
  console.log(`🌐 Launching send_emails.js on port ${TEST_PORT}...`);
  const env = { ...process.env, PORT: String(TEST_PORT), DASHBOARD_PORT: String(TEST_PORT), NO_BROWSER: "true", NODE_ENV: "test", AUTO_START_SEND: "false" };
  const server = spawn("node", ["send_emails.js"], { env });

  let serverLogs = "";
  server.stdout.on("data", (d) => {
    serverLogs += d.toString();
  });
  server.stderr.on("data", (d) => {
    serverLogs += d.toString();
  });

  // Wait for server to come online
  let online = false;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const res = await request({ path: "/api/state", method: "GET" });
      if (res.status === 200) {
        online = true;
        break;
      }
    } catch (e) {
      // not yet up
    }
  }

  if (!online) {
    server.kill();
    console.error("Server output on failure:\n", serverLogs);
    throw new Error("Server failed to come online within timeout");
  }
  console.log("✅ Server is online and accepting requests.\n");

  let passed = 0;

  try {
    // 1. Test Dashboard HTML
    console.log("Test 1: Dashboard HTML & New Panels");
    const htmlRes = await request({ path: "/", method: "GET" });
    assert.strictEqual(htmlRes.status, 200);
    assert.ok(typeof htmlRes.body === "string");
    assert.ok(htmlRes.body.includes('id="panel-matching"'), "Missing panel-matching in HTML");
    assert.ok(htmlRes.body.includes('id="panel-recruiters"'), "Missing panel-recruiters in HTML");
    assert.ok(htmlRes.body.includes('id="panel-activity"'), "Missing panel-activity in HTML");
    assert.ok(htmlRes.body.includes("loadCandidateProfileUI"), "Missing loadCandidateProfileUI in HTML");
    assert.ok(htmlRes.body.includes("simulateJobMatchUI"), "Missing simulateJobMatchUI in HTML");
    assert.ok(htmlRes.body.includes("loadRecruitersUI"), "Missing loadRecruitersUI in HTML");
    assert.ok(htmlRes.body.includes("loadBlockedDomainsUI"), "Missing loadBlockedDomainsUI in HTML");
    assert.ok(htmlRes.body.includes("testEmailSafetyUI"), "Missing testEmailSafetyUI in HTML");
    console.log("  ✅ Dashboard contains all 3 new panels and safety engine UI client scripts");
    passed++;

    // 2. Candidate Profile API
    console.log("Test 2: Candidate Profile GET & POST API");
    const getProf = await request({ path: "/api/candidate-profile", method: "GET" });
    assert.strictEqual(getProf.status, 200);
    assert.ok(getProf.body.profile);

    const postProf = await request(
      { path: "/api/candidate-profile", method: "POST" },
      { name: "Test Candidate", experienceYears: 5, targetRoles: ["Full Stack", "Backend"] }
    );
    assert.strictEqual(postProf.status, 200);
    assert.strictEqual(postProf.body.ok, true);
    console.log("  ✅ Candidate profile API works");
    passed++;

    // 3. Match Preview Simulator API
    console.log("Test 3: Transparent Job Match Preview API");
    const matchRes = await request(
      { path: "/api/jobs/match-preview", method: "POST" },
      {
        role: "Senior Python Backend Engineer",
        company: "Google",
        location: "Pune, India",
        description: "Looking for 5+ years experience in Python, FastAPI, PostgreSQL, Redis, and Cloud Architecture."
      }
    );
    assert.strictEqual(matchRes.status, 200);
    assert.ok(typeof matchRes.body.matchScore === "number");
    assert.ok(matchRes.body.breakdown);
    assert.ok(matchRes.body.breakdown.coreSkills);
    assert.ok(matchRes.body.autoSelectedResume);
    console.log(`  ✅ Match Preview returned score: ${matchRes.body.matchScore}% with resume: ${matchRes.body.autoSelectedResume.name}`);
    passed++;

    // 4. Recruiters API
    console.log("Test 4: Recruiter Directory API");
    const recRes = await request({ path: "/api/recruiters", method: "GET" });
    assert.strictEqual(recRes.status, 200);
    assert.ok(Array.isArray(recRes.body.recruiters));
    console.log(`  ✅ Recruiter API returned ${recRes.body.recruiters.length} recruiters`);
    passed++;

    // 5. Suppression API
    console.log("Test 5: Suppression & Opt-Out Shield API");
    const addSupp = await request(
      { path: "/api/suppression", method: "POST" },
      { target: "test.blocked@domain.com", type: "email", reason: "Integration Test" }
    );
    assert.strictEqual(addSupp.status, 200);
    assert.strictEqual(addSupp.body.ok, true);

    const getSupp = await request({ path: "/api/suppression", method: "GET" });
    assert.strictEqual(getSupp.status, 200);
    // console.log("getSupp.body:", JSON.stringify(getSupp.body));
    assert.ok(getSupp.body.suppressionList.emails.some((e) => (typeof e === "string" ? e : (e.email || e.target)) === "test.blocked@domain.com"));

    const delSupp = await request(
      { path: "/api/suppression", method: "DELETE" },
      { target: "test.blocked@domain.com", type: "email" }
    );
    assert.strictEqual(delSupp.status, 200);
    console.log("  ✅ Suppression CRUD API works");
    passed++;

    // 6. Resume Profiles & Auto-select API
    console.log("Test 6: Resume Profiles & Auto-Select API");
    const resProfiles = await request({ path: "/api/resumes/profiles", method: "GET" });
    assert.strictEqual(resProfiles.status, 200);
    assert.ok(Array.isArray(resProfiles.body.profiles));

    const autoSelect = await request(
      { path: "/api/resumes/auto-select", method: "POST" },
      { title: "Machine Learning Engineer", description: "PyTorch LLM Fine Tuning" }
    );
    assert.strictEqual(autoSelect.status, 200);
    assert.strictEqual(autoSelect.body.profile.id, "ai_ml");
    console.log("  ✅ Auto-select selected AI/ML track as expected");
    passed++;

    // 7. Activity Log API
    console.log("Test 7: Event Audit Trail & Activity Log API");
    const actRes = await request({ path: "/api/activity-log?limit=10", method: "GET" });
    assert.strictEqual(actRes.status, 200);
    assert.ok(Array.isArray(actRes.body.logs));
    console.log(`  ✅ Activity log returned ${actRes.body.logs.length} events`);
    passed++;

    // 8. Campaign Health API
    console.log("Test 8: System & Campaign Health API");
    const healthRes = await request({ path: "/api/campaign/health", method: "GET" });
    assert.strictEqual(healthRes.status, 200);
    assert.ok(healthRes.body.health);
    assert.strictEqual(healthRes.body.health.systemStatus, "healthy");
    assert.ok(healthRes.body.health.database);
    assert.ok(healthRes.body.health.concurrency);
    console.log("  ✅ Health API verified all subsystems healthy");
    passed++;

    // 9. Job Ingestion API
    console.log("Test 9: Job Ingestion Adapter API");
    const ingestRes = await request(
      { path: "/api/jobs/ingest", method: "POST" },
      {
        source: "api_import",
        jobs: [
          {
            title: `Staff Platform Engineer ${Date.now()}`,
            company: `Integration Test Corp ${Date.now()}`,
            email: `recruiter.${Date.now()}@testcorp.com`,
            url: `https://testcorp.com/careers/job-${Date.now()}`
          }
        ]
      }
    );
    assert.strictEqual(ingestRes.status, 200);
    assert.strictEqual(ingestRes.body.ok, true);
    assert.strictEqual(ingestRes.body.summary.ingested, 1);
    console.log("  ✅ Ingestion API successfully accepted and parsed job");
    passed++;

    // 10. SPA Direct Route Loading
    console.log("Test 10: SPA Direct Route Loading (/campaigns, /interviews, /jobs)");
    const campRoute = await request({ path: "/campaigns", method: "GET" });
    assert.strictEqual(campRoute.status, 200);
    assert.ok(campRoute.body.includes('id="panel-campaigns"'));
    const intRoute = await request({ path: "/interviews", method: "GET" });
    assert.strictEqual(intRoute.status, 200);
    assert.ok(intRoute.body.includes('id="panel-interviews"'));
    console.log("  ✅ SPA routes loaded HTML without 404s");
    passed++;

    // 11. Dashboard Contract API
    console.log("Test 11: Dashboard Structured Contract API");
    const dashRes = await request({ path: "/api/dashboard", method: "GET" });
    assert.strictEqual(dashRes.status, 200);
    assert.strictEqual(dashRes.body.ok, true);
    assert.ok(typeof dashRes.body.jobs_tracked === "number");
    assert.ok(typeof dashRes.body.sent === "number");
    assert.ok(typeof dashRes.body.interviews === "number");
    console.log("  ✅ GET /api/dashboard returned structured metrics");
    passed++;

    // 12. Interview Tracker API
    console.log("Test 12: Interview Tracker API (GET, POST, DELETE)");
    const getInt = await request({ path: "/api/interviews", method: "GET" });
    assert.strictEqual(getInt.status, 200);
    assert.ok(Array.isArray(getInt.body.interviews));

    const postInt = await request(
      { path: "/api/interviews", method: "POST" },
      {
        company: "Test E2E Corp",
        role: "Senior AI Engineer",
        round: "Technical",
        date: "2026-10-01",
        time: "14:00",
        meeting_link: "https://meet.google.com/test-e2e",
        interviewer: "Jane Test",
        notes: "Live system design"
      }
    );
    assert.strictEqual(postInt.status, 200);
    assert.strictEqual(postInt.body.ok, true);
    const createdId = postInt.body.interview.id;

    const delInt = await request({ path: `/api/interviews/${createdId}`, method: "DELETE" });
    assert.strictEqual(delInt.status, 200);
    assert.strictEqual(delInt.body.ok, true);
    console.log("  ✅ Interview Tracker CRUD passed");
    passed++;

    // 13. Global Emergency Stop API
    console.log("Test 13: Global Emergency Stop API");
    const stopRes = await request({ path: "/api/emergency-stop", method: "POST" });
    assert.strictEqual(stopRes.status, 200);
    assert.strictEqual(stopRes.body.ok, true);
    assert.strictEqual(stopRes.body.state.running, false);
    assert.strictEqual(stopRes.body.state.paused, true);
    console.log("  ✅ Emergency stop triggered and verified safely");
    passed++;

    // 14. Worker & Queue Telemetry API (Section 24)
    console.log("Test 14: Worker & Queue Telemetry API");
    const workerRes = await request({ path: "/api/worker/status", method: "GET" });
    assert.strictEqual(workerRes.status, 200);
    assert.strictEqual(workerRes.body.status, "Healthy");
    assert.ok(typeof workerRes.body.queueSize === "number");
    console.log("  ✅ Worker status verified (Healthy, queue telemetry active)");
    passed++;

    // 15. Autopilot State Control APIs (Section 21)
    console.log("Test 15: Autopilot State Controls (start, pause, stop)");
    const autoStart = await request({ path: "/api/autopilot/start", method: "POST" });
    assert.strictEqual(autoStart.status, 200);
    assert.strictEqual(autoStart.body.status, "RUNNING");
    const autoPause = await request({ path: "/api/autopilot/pause", method: "POST" });
    assert.strictEqual(autoPause.status, 200);
    assert.strictEqual(autoPause.body.status, "PAUSED");
    const autoStop = await request({ path: "/api/autopilot/stop", method: "POST" });
    assert.strictEqual(autoStop.status, 200);
    assert.strictEqual(autoStop.body.status, "STOPPED");
    console.log("  ✅ Autopilot state transitions verified (RUNNING -> PAUSED -> STOPPED)");
    passed++;

    // 16. Email Records API (Section 16 & 17)
    console.log("Test 16: Email Records & Composer API");
    const emailRecs = await request({ path: "/api/email-records?tab=all", method: "GET" });
    assert.strictEqual(emailRecs.status, 200);
    assert.strictEqual(emailRecs.body.ok, true);
    assert.ok(Array.isArray(emailRecs.body.records));

    const compQueue = await request(
      { path: "/api/emails/compose", method: "POST" },
      { to: "test.lead@example.com", subject: "Test Application", body: "Hello", action: "queue" }
    );
    assert.strictEqual(compQueue.status, 200);
    assert.strictEqual(compQueue.body.queued, true);
    console.log("  ✅ Email Records & Queue Composer verified");
    passed++;

    // 17. Toggle @gmail.com Mode API & UI Controls
    console.log("Test 17: Toggle @gmail.com Mode API & UI Synchronization");
    const dashHtmlRes = await request({ path: "/", method: "GET" });
    assert.ok(typeof dashHtmlRes.body === "string" && dashHtmlRes.body.includes("btn-gmail-mode"));
    
    // Check initial state
    const initState = await request({ path: "/api/state", method: "GET" });
    const initialAllow = initState.body.allowGmail;

    // Toggle mode
    const toggleRes = await request(
      { path: "/api/control", method: "POST" },
      { action: "toggleGmailMode" }
    );
    assert.strictEqual(toggleRes.status, 200);
    assert.strictEqual(toggleRes.body.ok, true);
    assert.strictEqual(toggleRes.body.allowGmail, !initialAllow);

    // Verify /api/state matches
    const updatedState = await request({ path: "/api/state", method: "GET" });
    assert.strictEqual(updatedState.body.allowGmail, !initialAllow);
    assert.strictEqual(updatedState.body.skipPersonalGmail, initialAllow);

    // Toggle back to restore state
    const restoreRes = await request(
      { path: "/api/control", method: "POST" },
      { action: "toggleGmailMode" }
    );
    assert.strictEqual(restoreRes.status, 200);
    assert.strictEqual(restoreRes.body.allowGmail, initialAllow);
    console.log("  ✅ @gmail.com sending mode toggles smoothly and synchronizes with state");
    passed++;

    // 18. Central Safety Engine Check API (Section 4 & 5)
    console.log("Test 18: Email Safety Engine Check API (Single & Batch)");
    const singleSafety = await request(
      { path: "/api/safety/check", method: "POST" },
      { email: "hr@yahoo.com" }
    );
    assert.strictEqual(singleSafety.status, 200);
    assert.strictEqual(singleSafety.body.ok, true);
    assert.strictEqual(singleSafety.body.verdict.eligible, false);
    assert.strictEqual(singleSafety.body.verdict.status, "BLOCKED_PERSONAL_DOMAIN");

    const corpSafety = await request(
      { path: "/api/safety/check", method: "POST" },
      { email: "hr@intel.com", company: "Intel" }
    );
    assert.strictEqual(corpSafety.status, 200);
    assert.strictEqual(corpSafety.body.verdict.eligible, true);
    assert.strictEqual(corpSafety.body.verdict.status, "ELIGIBLE");

    const batchSafety = await request(
      { path: "/api/safety/check", method: "POST" },
      {
        emails: [
          "careers@company.com, Company One",
          "recruiter@gmail.com, Personal One",
          "careers@company.com, Company One",
          "disposable@mailinator.com",
        ]
      }
    );
    assert.strictEqual(batchSafety.status, 200);
    assert.strictEqual(batchSafety.body.report.uniqueCount, 3);
    assert.strictEqual(batchSafety.body.report.duplicateInBatchCount, 1);
    assert.strictEqual(batchSafety.body.report.personalBlockedCount, 1);
    assert.strictEqual(batchSafety.body.report.disposableBlockedCount, 1);
    assert.strictEqual(batchSafety.body.report.eligibleCount, 1);
    console.log("  ✅ /api/safety/check verified single verdict and batch quality report");
    passed++;

    // 19. Blocked Domains Management API (Section 5)
    console.log("Test 19: Blocked Domains CRUD & Safety Telemetry API");
    const getBlocked = await request({ path: "/api/safety/blocked-domains", method: "GET" });
    assert.strictEqual(getBlocked.status, 200);
    assert.ok(Array.isArray(getBlocked.body.blockedDomains.personal));
    assert.ok(getBlocked.body.blockedDomains.personal.includes("gmail.com"));

    // Add custom blocked domain
    const addBlocked = await request(
      { path: "/api/safety/blocked-domains", method: "POST" },
      { domain: "competitor-spam.com", type: "custom" }
    );
    assert.strictEqual(addBlocked.status, 200);
    assert.ok(addBlocked.body.blockedDomains.customBlocked.includes("competitor-spam.com"));

    // Remove custom blocked domain
    const delBlocked = await request(
      { path: "/api/safety/blocked-domains", method: "DELETE" },
      { domain: "competitor-spam.com", type: "custom" }
    );
    assert.strictEqual(delBlocked.status, 200);
    assert.ok(!delBlocked.body.blockedDomains.customBlocked.includes("competitor-spam.com"));

    // Safety stats
    const statsRes = await request({ path: "/api/safety/stats", method: "GET" });
    assert.strictEqual(statsRes.status, 200);
    assert.ok(typeof statsRes.body.stats.activeSendLocks === "number");
    assert.ok(typeof statsRes.body.stats.personalDomainsBlockedCount === "number");
    console.log("  ✅ Blocked domains management and safety telemetry verified");
    passed++;

    console.log(`\n🎉 ALL ${passed}/${passed} SERVER INTEGRATION TESTS PASSED!`);
  } finally {
    server.kill();
  }
}

run().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
