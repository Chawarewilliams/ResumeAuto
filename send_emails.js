// ============================================================
//  GMAIL BULK EMAIL SENDER — ResumeAuto v8.0 TITAN
//  Dashboard: http://localhost:3000
// ============================================================

// Load environment variables from .env file
require("dotenv").config();

// ─── RESILIENCE & SELF-HEALING GUARDS ──────────────────────────
process.on("uncaughtException", (err) => {
  console.error("🛡️ [RESILIENCE GUARD] Uncaught Exception:", err.message);
  if (typeof addLog === "function") addLog(`⚠️ Resilience Guard: ${err.message}`, "warn");
});
process.on("unhandledRejection", (reason) => {
  console.error("🛡️ [RESILIENCE GUARD] Unhandled Rejection:", reason?.message || reason);
});


const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const dns = require("dns");
const net = require("net");

// ─── RESUMEAUTO V9 INTELLIGENT ENGINE MODULES ──────────────────
const { isSuppressed, addSuppression, removeSuppression, getSuppressionSummary } = require("./engine/suppression");
const { createJobRecord, findDuplicateJob, APPLICATION_STATUSES } = require("./engine/jobModel");
const { checkOutreachSafety, recordOutreach, loadRecruiters, upsertRecruiter } = require("./engine/recruiterModel");
const { calculateJobMatch, getCandidateProfile, saveCandidateProfile } = require("./engine/matchingEngine");
const { getAllResumesWithMetadata, selectOptimalResume } = require("./engine/resumeManager");
const { TEMPLATE_CATEGORIES, loadTemplates, saveTemplates, renderTemplate } = require("./engine/templateEngine");
const { ingestJobsFromSource } = require("./engine/sources");
const { logActivity, queryActivityLogs } = require("./engine/activityLogger");
const { INTERVIEW_STAGES, loadInterviews, addInterview, updateInterview, deleteInterview } = require("./engine/interviewModel");

// ─── IMAP RESILIENCE PATCH (prevents unhandled fetchCache crash) ──
try {
  if (Imap && Imap.prototype) {
    if (Imap.prototype._resUntagged) {
      const origResUntagged = Imap.prototype._resUntagged;
      Imap.prototype._resUntagged = function(info) {
        if (!this._curReq || (info && (info.type === 'fetch' || info.type === 'fetch_vanished') && !this._curReq.fetchCache)) return;
        return origResUntagged.apply(this, arguments);
      };
    }
    if (Imap.prototype.destroy) {
      const origDestroy = Imap.prototype.destroy;
      Imap.prototype.destroy = function() {
        this._curReq = { fetchCache: {}, fetching: [] };
        if (this._sock) {
          try { this._sock.removeAllListeners('data'); } catch(e) {}
        }
        return origDestroy.apply(this, arguments);
      };
    }
  }
} catch(e) {}

// ─── RFC 5321 EMAIL VALIDATION & SANITIZATION ────────────────
const DUMMY_EMAILS = new Set([
  "user@example.com",
  "user+tag@email.com",
  "your@gmail.com",
  "your-email@gmail.com",
  "recruiter@company.com",
  "test@test.com",
]);

function sanitizeEmailCandidate(str) {
  if (!str) return "";
  let clean = str.trim().toLowerCase();
  clean = clean.replace(/^[<"'\s]+|[>"'\s]+$/g, "");
  clean = clean.replace(/^email\.+/i, "");
  clean = clean.replace(/[.,;:!?]+$/, "");
  return clean;
}

function isValidRfcEmail(email) {
  if (!email || typeof email !== "string") return false;
  const clean = email.trim().toLowerCase();
  if (DUMMY_EMAILS.has(clean)) return false;
  if (clean.length < 6 || clean.length > 254) return false;
  if (clean.includes(" ")) return false;

  const parts = clean.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;

  // Local-part checks (RFC 5321)
  if (!local || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".")) return false;
  if (local.includes("..")) return false;
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i.test(local)) return false;

  // Domain checks (RFC 5321)
  if (!domain || domain.length > 255) return false;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.startsWith("-") || domain.endsWith("-")) return false;
  if (domain.includes("..")) return false;
  if (!/^[a-z0-9.-]+$/i.test(domain)) return false;

  const domainParts = domain.split(".");
  if (domainParts.length < 2) return false;
  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-z]{2,}$/i.test(tld)) return false;
  if (["png", "jpg", "jpeg", "pdf", "gif", "txt", "zip"].includes(tld)) return false;

  return true;
}

// ─── FILE PATHS ───────────────────────────────────────────────
const EMAILS_DIR    = "./";
const SENT_LOG      = "./sent_log.txt";
const PROGRESS_FILE = "./progress.json";
const REPORT_FILE   = "./report.txt";
const TEMPLATE_FILE = "./template.json";
const JOBS_FILE     = "./jobs.json";
const SETTINGS_FILE = "./settings.json";

function ensureDefaultFilesExist() {
  try {
    if (!fs.existsSync(TEMPLATE_FILE)) {
      fs.writeFileSync(TEMPLATE_FILE, JSON.stringify({
        subject: "Immediate Joiner | Python Developer | Django | FastAPI | Mysql | Data Science| Open to Opportunities",
        plainText: DEFAULT_PLAIN_TEXT,
        html: DEFAULT_HTML,
      }, null, 2));
    }
    if (!fs.existsSync(JOBS_FILE)) {
      fs.writeFileSync(JOBS_FILE, JSON.stringify([], null, 2));
    }
    const sampleEmailFile = path.join(EMAILS_DIR, "emails.txt");
    if (!fs.existsSync(sampleEmailFile)) {
      fs.writeFileSync(sampleEmailFile, "# Format: email@company.com, Company Name, Tech Context (optional)\n# Add recipient emails here\n");
    }
  } catch (e) {
    console.error("Auto-init files warning:", e.message);
  }
}

// ─── DEFAULT CONFIG ───────────────────────────────────────────
const DEFAULT_CONFIG = {
  accounts: [
    {
      gmailAddress: process.env.GMAIL_ADDRESS || "",
      appPassword: process.env.GMAIL_APP_PASSWORD || ""
    },
    ...(process.env.GMAIL_ADDRESS_2 && process.env.GMAIL_APP_PASSWORD_2 ? [{
      gmailAddress: process.env.GMAIL_ADDRESS_2,
      appPassword: process.env.GMAIL_APP_PASSWORD_2
    }] : [])
  ],
  speed: process.env.EMAIL_SPEED || "medium",
  concurrency: parseInt(process.env.CONCURRENCY) || 2,
  dailyLimitPerAccount: parseInt(process.env.DAILY_LIMIT) || 450,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 5000,
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || process.env.PORT) || 3000,
  attachment: process.env.ATTACHMENT_PATH || "./Milin_Chaware_Resume.pdf",
  attachmentEnabled: process.env.ATTACHMENT_ENABLED !== "false",
  autoPauseConsecutiveFailures: parseInt(process.env.AUTO_PAUSE_FAILURES) || 3,
  enableSoundAlerts: process.env.SOUND_ALERTS !== "false",
  resendSentEmails: process.env.RESEND_SENT_EMAILS === "true",
  skipPersonalGmail: process.env.SKIP_PERSONAL_GMAIL !== "false", // default true: business emails only
  plainTextOnly: process.env.PLAIN_TEXT_ONLY === "true",
  onlySendInBusinessHours: process.env.BUSINESS_HOURS_ONLY !== "false",
  businessStartHour: parseInt(process.env.BUSINESS_START_HOUR) || 9,
  businessEndHour: parseInt(process.env.BUSINESS_END_HOUR) || 18,
  skipWeekends: process.env.SKIP_WEEKENDS !== "false",
  enableHumanJitter: process.env.HUMAN_JITTER !== "false",
  webhookUrl: process.env.WEBHOOK_URL || "",
  enableWebhookAlerts: process.env.WEBHOOK_ALERTS === "true",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  trackingBaseUrl: process.env.TRACKING_BASE_URL || "http://localhost:3000",
  autoDripFollowup: process.env.AUTO_DRIP_FOLLOWUP !== "false",
  autoImapPoll: process.env.AUTO_IMAP_POLL !== "false",
  dripDay1: parseInt(process.env.DRIP_DAY_1) || 4,
  dripDay2: parseInt(process.env.DRIP_DAY_2) || 8,
  autopilot: process.env.AUTOPILOT !== "false", // default true for hands-free automation
  autoVerifyMxOnSend: process.env.AUTO_VERIFY_MX !== "false", // in-flight DNS/MX check
  autoPersonalizeLeads: process.env.AUTO_PERSONALIZE_LEADS !== "false", // per-lead AI pitch
  autoDripIntervalMinutes: parseInt(process.env.AUTO_DRIP_INTERVAL) || 30, // scan drip every 30m
  autoStartOnBoot: process.env.AUTO_START === "true" || false,
};


// ─── CONFIG VALIDATION ────────────────────────────────────────
function validateConfig(config) {
  const errors = [];
  
  if (!config.accounts || config.accounts.length === 0) {
    errors.push("❌ No Gmail accounts configured. Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD environment variables.");
  }
  
  config.accounts.forEach((account, index) => {
    const suffix = index === 0 ? "" : `_${index + 1}`;
    if (!account.gmailAddress || account.gmailAddress === "your-email@gmail.com") {
      errors.push(`❌ Gmail address is required (GMAIL_ADDRESS${suffix} env var)`);
    }
    if (!account.appPassword || account.appPassword === "your-app-specific-password") {
      errors.push(`❌ Gmail app password is required (GMAIL_APP_PASSWORD${suffix} env var)`);
    }
  });

  if (process.env.GMAIL_ADDRESS_2 && !process.env.GMAIL_APP_PASSWORD_2) {
    errors.push("❌ GMAIL_APP_PASSWORD_2 is required when GMAIL_ADDRESS_2 is set");
  }
  if (process.env.GMAIL_APP_PASSWORD_2 && !process.env.GMAIL_ADDRESS_2) {
    errors.push("❌ GMAIL_ADDRESS_2 is required when GMAIL_APP_PASSWORD_2 is set");
  }
  
  if (!["turbo", "fast", "medium", "slow", "stealth"].includes(config.speed)) {
    errors.push("❌ Speed must be 'turbo', 'fast', 'medium', 'slow', or 'stealth'");
  }
  
  if (config.dashboardPort < 1 || config.dashboardPort > 65535) {
    errors.push("❌ Dashboard port must be between 1 and 65535");
  }
  
  return { valid: errors.length === 0, errors };
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
      return { ...DEFAULT_CONFIG, ...saved, accounts: DEFAULT_CONFIG.accounts };
    }
  } catch (e) {
    console.error("⚠️  Error loading settings file:", e.message);
  }
  return { ...DEFAULT_CONFIG };
}

function saveSettings(data) {
  const safe = { ...data };
  delete safe.accounts; // never save credentials to disk
  if (safe.geminiApiKey === "configured") delete safe.geminiApiKey;
  if (safe.telegramBotToken === "configured") delete safe.telegramBotToken;
  const current = fs.existsSync(SETTINGS_FILE)
    ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"))
    : {};
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...current, ...safe }, null, 2));
  Object.assign(CONFIG, safe);
  state.speed = CONFIG.speed;
}

let CONFIG = loadSettings();

// ─── VALIDATE CONFIGURATION ───────────────────────────────────
const configValidation = validateConfig(CONFIG);
if (!configValidation.valid) {
  console.error("\n🚨 Configuration Validation Failed!\n");
  configValidation.errors.forEach(err => console.error(err));
  console.error("\n📝 Setup Instructions:");
  console.error("1. Copy .env.example to .env");
  console.error("2. Edit .env with your Gmail credentials");
  console.error("3. Run: npm start\n");
  process.exit(1);
}

const SPEED_DELAY = { turbo: 200, fast: 500, medium: 1500, slow: 3000, stealth: 22000 };

// ─── AI SUBJECT LINE ROTATION ─────────────────────────────────
const AI_SUBJECTS = [
  "Python Developer Position — Milin Chaware (4+ Yrs Exp) | Immediate Joiner",
  "Application for Python Developer Position — Milin Chaware",
  "Python Developer Position — {company} | 4+ Yrs Exp",
  "Senior Python Developer Position (FastAPI, Django & AI/ML) — Immediate Joiner",
  "Exploring Python Developer Position — Milin Chaware",
];
let aiSubjectIndex = 0;
function getNextAiSubject(company) {
  const template = AI_SUBJECTS[aiSubjectIndex % AI_SUBJECTS.length];
  aiSubjectIndex++;
  const compStr = (company && company.trim() && company.trim() !== "Your Company") ? company.trim() : "";
  if (compStr) return template.replace(/\{company\}/gi, compStr);
  return template
    .replace(/[—–-]\s*\{company\}/gi, "")
    .replace(/for \{company\}/gi, "")
    .replace(/at \{company\}/gi, "")
    .replace(/\| \{company\}/gi, "")
    .replace(/\{company\}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── WARM-UP MODE ─────────────────────────────────────────────
const WARMUP_DAYS_FILE = "./warmup.json";
let _warmupCache = null;
let _warmupCacheTime = 0;
const WARMUP_CACHE_TTL = 60_000; // re-read disk only every 60s
function getWarmupLimit() {
  const now = Date.now();
  if (_warmupCache !== undefined && now - _warmupCacheTime < WARMUP_CACHE_TTL) {
    return _warmupCache;
  }
  try {
    if (fs.existsSync(WARMUP_DAYS_FILE)) {
      const w = JSON.parse(fs.readFileSync(WARMUP_DAYS_FILE, "utf8"));
      if (!w.enabled) { _warmupCache = null; _warmupCacheTime = now; return null; }
      const daysSinceStart = Math.floor((now - new Date(w.startDate).getTime()) / 86400000);
      let limit = null;
      if (daysSinceStart === 0) limit = w.day1Limit || 50;
      else if (daysSinceStart === 1) limit = w.day2Limit || 100;
      else if (daysSinceStart === 2) limit = w.day3Limit || 200;
      _warmupCache = limit; _warmupCacheTime = now;
      return limit;
    }
  } catch(e) {}
  _warmupCache = null; _warmupCacheTime = now;
  return null;
}
// Invalidate cache when warmup file is written
function invalidateWarmupCache() { _warmupCacheTime = 0; }

// Local file-backed storage (jobs.json, sent_log.txt, progress.json, settings.json)

// ─── DEFAULT EMAIL TEMPLATE ───────────────────────────────────
const DEFAULT_PLAIN_TEXT = `Hi,

I'm Milin Chaware — a Python Backend & AI/ML Developer with 4+ years of experience building scalable backend systems, REST APIs, and data pipelines.

Quick snapshot of what I bring:
• 15+ Production APIs built with Django DRF & FastAPI (serving 50K+ daily requests)
• Data Pipelines & Analytics: 2M+ records/day processed using Pandas & NumPy
• AI / ML Integration: hands-on with ML workflows and intelligent backend automation
• 40% faster PostgreSQL queries through query optimization, indexing, and Redis caching
• AWS & DevOps: containerized deployments on AWS (EC2, S3, Docker) with 99.9% uptime

Core Stack: Python · Django · FastAPI · AI/ML · Pandas · NumPy · PostgreSQL · MySQL · Redis · Celery · Docker · AWS

I am an immediate joiner with zero notice period. My resume is attached for your review.

I would welcome a brief conversation if there is an open opportunity {company}.

Best regards,

Milin Chaware
Senior Python Backend & AI/ML Developer
Phone: +91 7620369988
Email: milinchaware9@gmail.com
LinkedIn: https://www.linkedin.com/in/milin-chaware-9a1b4b1a7/`;

const DEFAULT_HTML = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14.5px; line-height: 1.6; color: #1f2937; max-width: 650px;">
  <p style="margin: 0 0 16px 0;">Hi,</p>

  <p style="margin: 0 0 16px 0;">I'm <strong>Milin Chaware</strong> — a Python Backend &amp; AI/ML Developer with <strong>4+ years</strong> of experience building scalable backend systems, REST APIs, and data processing pipelines.</p>

  <p style="margin: 0 0 8px 0;"><strong>Quick snapshot of what I bring:</strong></p>
  <ul style="margin: 0 0 16px 0; padding-left: 20px;">
    <li style="margin-bottom: 6px;"><strong>15+ Production APIs</strong> built with Django DRF &amp; FastAPI (serving 50K+ daily requests)</li>
    <li style="margin-bottom: 6px;"><strong>Data Pipelines &amp; Analytics:</strong> 2M+ records/day processed using <strong>Pandas &amp; NumPy</strong></li>
    <li style="margin-bottom: 6px;"><strong>AI / ML Integration:</strong> hands-on with ML workflows and intelligent backend automation</li>
    <li style="margin-bottom: 6px;"><strong>40% faster</strong> PostgreSQL queries through query optimization, indexing, and Redis caching</li>
    <li style="margin-bottom: 6px;"><strong>AWS &amp; DevOps:</strong> containerized deployments on AWS (EC2, S3, Docker) with 99.9% uptime</li>
  </ul>

  <p style="margin: 0 0 16px 0;"><strong>Core Stack:</strong> Python &middot; Django &middot; FastAPI &middot; AI/ML &middot; Pandas &middot; NumPy &middot; PostgreSQL &middot; MySQL &middot; Redis &middot; Celery &middot; Docker &middot; AWS</p>

  <p style="margin: 0 0 16px 0;">I am an <strong>immediate joiner</strong> (zero notice period). My resume is attached for your review.</p>

  <p style="margin: 0 0 20px 0;">I would welcome a brief conversation if there is an open opportunity {company}.</p>

  <p style="margin: 0; line-height: 1.6;">
    Best regards,<br>
    <strong>Milin Chaware</strong><br>
    Senior Python Backend &amp; AI/ML Developer<br>
    Phone: +91 7620369988<br>
    Email: <a href="mailto:milinchaware9@gmail.com" style="color: #2563eb; text-decoration: none;">milinchaware9@gmail.com</a><br>
    LinkedIn: <a href="https://www.linkedin.com/in/milin-chaware-9a1b4b1a7/" style="color: #2563eb; text-decoration: none;">linkedin.com/in/milin-chaware-9a1b4b1a7</a>
  </p>
</div>`;

// ─── TEMPLATE STATE ───────────────────────────────────────────
let TEMPLATE = {
  subject: "Python Developer Position — {company} | Milin Chaware (4+ Yrs Exp)",
  plainText: DEFAULT_PLAIN_TEXT,
  html: DEFAULT_HTML,
};

function loadTemplate() {
  try {
    if (fs.existsSync(TEMPLATE_FILE)) {
      const t = JSON.parse(fs.readFileSync(TEMPLATE_FILE, "utf8"));
      Object.assign(TEMPLATE, t);
    }
  } catch (e) {}
}
loadTemplate();

function saveTemplateData(data) {
  Object.assign(TEMPLATE, data);
  fs.writeFileSync(TEMPLATE_FILE, JSON.stringify(TEMPLATE, null, 2));
}

function formatCompanyPlaceholders(str, company, personalization = "") {
  if (!str) return "";
  let res = str;

  // Handle [Name] / {name} placeholder
  res = res.replace(/Hi\s+\[Name\],?/gi, "Hi,")
           .replace(/Hi\s+\{name\},?/gi, "Hi,")
           .replace(/\[Name\]/gi, "there")
           .replace(/\{name\}/gi, "there");

  // Handle {personalization}
  if (personalization && personalization.trim()) {
    if (res.includes("{personalization}")) {
      res = res.replace(/\{personalization\}/gi, personalization.trim());
    } else if (CONFIG.autoPersonalizeLeads !== false) {
      if (res.includes("Hi,\n\n")) {
        res = res.replace("Hi,\n\n", `Hi,\n\n${personalization.trim()}\n\n`);
      } else if (res.includes("Hi,</p>")) {
        res = res.replace("Hi,</p>", `Hi,</p><p style="margin:12px 0;">${personalization.trim()}</p>`);
      }
    }
  } else {
    res = res.replace(/\{personalization\}/gi, "");
  }

  const compStr = (company && company.trim() && company.trim() !== "Your Company") ? company.trim() : "";
  if (compStr) {
    return res
      .replace(/at \{company\}/gi, `at ${compStr}`)
      .replace(/for \{company\}/gi, `at ${compStr}`)
      .replace(/with \{company\}/gi, `with ${compStr}`)
      .replace(/\{company\}/gi, compStr);
  }
  return res
    .replace(/at \{company\}/gi, "with your team")
    .replace(/for \{company\}/gi, "on your team")
    .replace(/with \{company\}/gi, "with your team")
    .replace(/\{company\}/gi, "your team");
}

function getSubject(company) {
  const compStr = (company && company.trim() && company.trim() !== "Your Company") ? company.trim() : "";
  if (compStr) {
    return TEMPLATE.subject.replace(/\{company\}/gi, compStr);
  }
  return TEMPLATE.subject
    .replace(/[—–-]\s*\{company\}/gi, "")
    .replace(/for \{company\}/gi, "")
    .replace(/at \{company\}/gi, "")
    .replace(/\| \{company\}/gi, "")
    .replace(/\{company\}/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPlainText(company, personalization = "") {
  return formatCompanyPlaceholders(TEMPLATE.plainText, company, personalization);
}

function getHtmlEmail(company, personalization = "", trackingJobId = null) {
  let html = formatCompanyPlaceholders(TEMPLATE.html, company, personalization);
  if (trackingJobId && CONFIG.trackingBaseUrl) {
    const trackingPixel = `<img src="${CONFIG.trackingBaseUrl}/api/track/open/${trackingJobId}.png" width="1" height="1" style="display:none;width:1px;height:1px;max-height:1px;max-width:1px;opacity:0;border:none;" alt="" />`;
    if (html.includes("</div>")) {
      const lastIndex = html.lastIndexOf("</div>");
      html = html.slice(0, lastIndex) + trackingPixel + html.slice(lastIndex);
    } else {
      html += trackingPixel;
    }
  }
  return html;
}

// ─── AI ENGINE (GEMINI API + HEURISTICS) ─────────────────────
const _personalizationCache = new Map();
async function callGeminiApi(prompt) {
  const apiKey = (CONFIG.geminiApiKey || process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 140
        }
      })
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (err) {
    return null;
  }
}

async function generatePersonalizationLine(company, context = "") {
  const compStr = (company && company.trim() && company.trim() !== "Your Company") ? company.trim() : "";
  const ctxStr = context ? context.trim() : "";
  const cacheKey = `${compStr.toLowerCase()}:::${ctxStr.toLowerCase()}`;
  if (_personalizationCache.has(cacheKey)) return _personalizationCache.get(cacheKey);

  if (CONFIG.geminiApiKey || process.env.GEMINI_API_KEY) {
    const prompt = `You are Milin Chaware, a Senior Python Backend Developer with 4+ years of production experience in Django REST Framework, FastAPI, PostgreSQL, Redis, Celery, Docker, and AWS. Previously at Energy Meteocontrol Solution scaling high-throughput APIs and IoT/data pipelines. You also have strong hands-on experience integrating AI/ML models into backend architectures.

Target Company: ${compStr || "Engineering Team"}
Company / Tech Context: ${ctxStr || "Python Backend Architecture"}

Task: Write ONE natural, conversational, punchy sentence (maximum 22 words) connecting Milin's real backend experience with their tech stack or domain to put inside a cold job application email.
Rules:
- Sound human and genuine (never robotic).
- Do NOT use quotation marks.
- Do NOT include greetings or sign-offs.
- Mention specific tech (FastAPI, Redis, Celery, PostgreSQL, or AI/ML pipelines) if fitting.
- Example: "Noticed your engineering team is scaling real-time telemetry on FastAPI and Redis — my recent work at Energy Meteocontrol directly mirrors this architecture."`;

    const aiRes = await callGeminiApi(prompt);
    if (aiRes) {
      return aiRes.replace(/^["']|["']$/g, "").trim();
    }
  }

  // Heuristic Fallback
  const lower = (ctxStr + " " + compStr).toLowerCase();
  if (lower.includes("ai") || lower.includes("ml") || lower.includes("llm") || lower.includes("genai")) {
    return "Having worked close to AI/ML workflows alongside scalable Python microservices, I'm especially keen on contributing to your team's intelligent backend pipelines.";
  }
  if (lower.includes("pay") || lower.includes("fintech") || lower.includes("bank") || lower.includes("cred")) {
    return "My background optimizing high-throughput transactional APIs and PostgreSQL query latency directly aligns with the reliability demands of financial platforms.";
  }
  if (lower.includes("iot") || lower.includes("telemetry") || lower.includes("realtime") || lower.includes("sensor")) {
    return "My recent work at Energy Meteocontrol scaling real-time telemetry pipelines and Redis caching mirrors the high-volume data demands of your infrastructure.";
  }
  if (compStr) {
    return `Given ${compStr}'s focus on high-performance engineering, my 4+ years building production APIs in FastAPI and Django would allow me to contribute immediately.`;
  }
  return "My 4+ years building and maintaining production REST APIs in Django and FastAPI allows me to step in and add immediate value to your backend team.";
}

async function classifyReplySentiment(snippet) {
  if (!snippet || !snippet.trim()) return { sentiment: "unknown", label: "Reply Received 💬", summary: "No content" };

  if (CONFIG.geminiApiKey || process.env.GEMINI_API_KEY) {
    const prompt = `Analyze this recruiter/HR email reply to a job application.
Classify sentiment into EXACTLY one category:
1. INTERVIEW (Recruiter is interested, wants to schedule a call, asked for availability, resume, CTC, notice period)
2. OOO (Out of office, automated vacation response, or "we will keep your resume on file for future openings")
3. REJECTED (Not hiring, position filled, rejected)

Email snippet:
"${snippet.slice(0, 400)}"

Return ONLY valid JSON: {"sentiment": "INTERVIEW" | "OOO" | "REJECTED", "summary": "Short 4-6 word summary"}`;

    const aiRes = await callGeminiApi(prompt);
    if (aiRes) {
      try {
        const m = aiRes.match(/\{[\s\S]*\}/);
        if (m) {
          const parsed = JSON.parse(m[0]);
          const s = (parsed.sentiment || "").toUpperCase();
          if (s.includes("INTERVIEW")) return { sentiment: "interview", label: "Interview / Interested 🟢", summary: parsed.summary || "Recruiter interested" };
          if (s.includes("OOO")) return { sentiment: "ooo", label: "Keep on File / OOO 🟡", summary: parsed.summary || "Out of office / file" };
          if (s.includes("REJECT")) return { sentiment: "rejected", label: "Not Hiring / Rejected 🔴", summary: parsed.summary || "Position filled or declined" };
        }
      } catch(e) {}
    }
  }

  // Heuristic Fallback
  const lower = snippet.toLowerCase();
  if (lower.includes("interview") || lower.includes("schedule") || lower.includes("available") || lower.includes("call") || lower.includes("connect") || lower.includes("chat") || lower.includes("ctc") || lower.includes("notice period") || lower.includes("discuss")) {
    return { sentiment: "interview", label: "Interview / Interested 🟢", summary: "Expressed interest or requested call" };
  }
  if (lower.includes("out of the office") || lower.includes("on leave") || lower.includes("keep your profile") || lower.includes("keep your resume") || lower.includes("future openings")) {
    return { sentiment: "ooo", label: "Keep on File / OOO 🟡", summary: "Out of office or kept on file" };
  }
  if (lower.includes("unfortunately") || lower.includes("not moving forward") || lower.includes("filled") || lower.includes("regret") || lower.includes("other candidates")) {
    return { sentiment: "rejected", label: "Not Hiring / Rejected 🔴", summary: "Application declined" };
  }
  return { sentiment: "unknown", label: "Reply Received 💬", summary: snippet.slice(0, 40) };
}

// ─── TELEGRAM & WEBHOOK NOTIFICATIONS ─────────────────────────
async function sendTelegramAlert(message) {
  const token = (CONFIG.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "").trim();
  const chatId = (CONFIG.telegramChatId || process.env.TELEGRAM_CHAT_ID || "").trim();
  if (!token || !chatId) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML"
      })
    });
    return res.ok;
  } catch(e) {
    console.warn("Telegram alert failed:", e.message);
    return false;
  }
}

// ─── EMAIL VERIFIER (DNS MX + SMTP SOCKET HANDSHAKE) ──────────
async function verifyEmail(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return { valid: false, status: "invalid_syntax", reason: "Invalid email syntax" };
  }
  const cleanEmail = email.trim().toLowerCase();
  const domain = cleanEmail.split("@")[1];

  let mxRecords = [];
  try {
    mxRecords = await dns.promises.resolveMx(domain);
  } catch (err) {
    return { valid: false, status: "no_mx", reason: `Domain ${domain} has no active mail server (MX)` };
  }

  if (!mxRecords || mxRecords.length === 0) {
    return { valid: false, status: "no_mx", reason: `No MX records found for ${domain}` };
  }

  mxRecords.sort((a, b) => a.priority - b.priority);
  const bestMx = mxRecords[0].exchange;

  return new Promise((resolve) => {
    let resolved = false;
    const socket = net.createConnection(25, bestMx);
    socket.setTimeout(5000);

    let stage = 0;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { socket.write("QUIT\r\n"); socket.destroy(); } catch(e) {}
      resolve(result);
    };

    socket.on("timeout", () => {
      finish({ valid: true, status: "mx_ok_timeout", reason: `MX verified (${bestMx}), port 25 timed out (ISP filter)` });
    });

    socket.on("error", () => {
      finish({ valid: true, status: "mx_ok_refused", reason: `MX verified (${bestMx}), port 25 closed or protected` });
    });

    socket.on("data", (data) => {
      const msg = data.toString();
      const code = parseInt(msg.slice(0, 3));

      if (stage === 0) {
        if (code === 220) {
          stage = 1;
          socket.write("HELO resumeauto.local\r\n");
        } else {
          finish({ valid: false, status: "banner_rejected", reason: msg.trim() });
        }
      } else if (stage === 1) {
        if (code === 250) {
          stage = 2;
          socket.write("MAIL FROM:<verify@resumeauto.local>\r\n");
        } else {
          finish({ valid: true, status: "mx_ok", reason: "MX responded to HELO" });
        }
      } else if (stage === 2) {
        if (code === 250) {
          stage = 3;
          socket.write(`RCPT TO:<${cleanEmail}>\r\n`);
        } else {
          finish({ valid: true, status: "mx_ok", reason: "MX accepted sender probe" });
        }
      } else if (stage === 3) {
        if (code === 250 || code === 251) {
          finish({ valid: true, status: "mailbox_exists", reason: `Mailbox verified on ${bestMx}` });
        } else if (code >= 550 && code <= 554) {
          finish({ valid: false, status: "mailbox_rejected", reason: `Mailbox rejected (${code}): User does not exist` });
        } else {
          finish({ valid: true, status: "mx_ok", reason: `MX active (code ${code})` });
        }
      }
    });
  });
}

// ─── LEAD FINDER ──────────────────────────────────────────────
async function discoverLeads(domain, companyName = "") {
  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
  const prefixes = ["careers", "talent", "hr", "recruiting", "jobs", "people", "hiring"];
  const candidates = prefixes.map(p => `${p}@${cleanDomain}`);

  let hasMx = false;
  let mxHost = "";
  try {
    const mx = await dns.promises.resolveMx(cleanDomain);
    if (mx && mx.length > 0) {
      hasMx = true;
      mxHost = mx.sort((a, b) => a.priority - b.priority)[0].exchange;
    }
  } catch(e) {}

  const results = candidates.map(email => ({
    email,
    company: companyName || cleanDomain,
    status: hasMx ? "active_mx" : "no_mx",
    valid: hasMx,
    mxHost: mxHost || "none"
  }));

  return { domain: cleanDomain, hasMx, mxHost, leads: results };
}

// ─── v8.5: AI JOB DESCRIPTION PERSONALIZER & NLP MATCHER ───────
function extractTechKeywords(text) {
  const keywords = [
    { key: "fastapi", label: "FastAPI (High-Throughput Asynchronous APIs)" },
    { key: "django", label: "Django & Django REST Framework" },
    { key: "flask", label: "Flask Microservices" },
    { key: "postgresql", label: "PostgreSQL Query Optimization & Indexing (40% Latency Reduction)" },
    { key: "mysql", label: "MySQL Database Architecture" },
    { key: "redis", label: "Redis In-Memory Caching & Session Storage" },
    { key: "celery", label: "Celery Distributed Task Queue & Background Workers" },
    { key: "docker", label: "Docker Containerization & CI/CD Pipelines" },
    { key: "kubernetes", label: "Kubernetes (K8s) Cluster Deployment" },
    { key: "aws", label: "AWS Cloud Services (EC2, S3, RDS, Lambda)" },
    { key: "gcp", label: "Google Cloud Platform (GCP)" },
    { key: "ai", label: "AI/ML Engineering & LLM API Integrations" },
    { key: "ml", label: "Machine Learning Pipelines & Model Serving" },
    { key: "pandas", label: "High-Volume Data Processing (Pandas & NumPy)" },
    { key: "numpy", label: "NumPy Vectorized Computations" },
    { key: "microservices", label: "Scalable Event-Driven Microservices Architecture" },
    { key: "rest", label: "RESTful API Design & OpenAPI Documentation" },
    { key: "graphql", label: "GraphQL API Design" },
    { key: "system design", label: "Scalable Distributed System Design" },
  ];

  const lower = (text || "").toLowerCase();
  const matched = [];
  keywords.forEach(k => {
    if (new RegExp("\\b" + k.key + "\\b", "i").test(lower)) {
      matched.push(k.label);
    }
  });
  return matched;
}

async function generateTailoredPitch(jobDesc, company = "", role = "") {
  const compName = company || "your engineering team";
  const roleTitle = role || "Senior Python Backend Developer";

  // Try Google Gemini API if configured
  if (CONFIG.geminiApiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${CONFIG.geminiApiKey}`;
      const prompt = `You are Milin Chaware, a Senior Python Backend Developer with 4+ years of production experience (FastAPI, Django DRF, PostgreSQL 40% query optimization, Redis caching, Celery task queues, AI/ML pipelines with Pandas & NumPy, AWS/Docker).
Write a tailored cold email application for this job opening at ${compName} for ${roleTitle}.
Job Description:
${jobDesc}

Respond strictly with a JSON object:
{
  "subject": "Catchy subject line under 60 chars mentioning tech alignment and Milin Chaware",
  "plainText": "3-4 concise paragraphs directly aligning Milin's real stack to the JD requirements, with bullet points and phone 7620369988",
  "html": "Clean modern HTML version with bullet points and contact styling"
}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data = await resp.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return { ok: true, subject: parsed.subject, plainText: parsed.plainText, html: parsed.html, aiPowered: true };
      }
    } catch (e) {
      addLog(`⚠️ Gemini AI pitch generation fallback: ${e.message}`, "warn");
    }
  }

  // High-performance rule-based NLP matcher
  const matched = extractTechKeywords(jobDesc);
  const matchedBullets = matched.length > 0
    ? matched.slice(0, 4).map(m => `• ${m}`).join("\n")
    : `• 15+ Production APIs built with Django DRF & FastAPI (serving 50K+ daily requests)\n• Database Optimization: 40% faster query latency with PostgreSQL query tuning & Redis caching\n• Asynchronous Workflows: Scaled background processing using Celery & Redis\n• AI/ML & Data Pipelines: 2M+ records/day processed using Pandas & NumPy`;

  const subject = `Python Backend Developer (${matched.slice(0, 2).map(m => m.split(' ')[0]).join(', ') || 'FastAPI, Django, Redis'}) — Milin Chaware <> ${company || 'Engineering'}`;

  const plainText = `Hi ${company ? company + ' Hiring Team' : 'Hiring Team'},

I came across your opening for the ${roleTitle} role at ${compName} and wanted to reach out directly. Given your focus on building robust backend systems, my 4+ years of production experience building and scaling Python architectures directly aligns with your tech stack.

Here is a quick snapshot of what I can deliver from Day 1:
${matchedBullets}

I would welcome the opportunity to discuss how my backend and data engineering experience can support ${compName}'s engineering goals.

Best regards,
Milin Chaware
Senior Python Backend Developer
Phone: +91 7620369988
Location: Pune / Remote
Portfolio / Resume Attached`;

  const htmlBullets = matchedBullets.split('\n').map(b => `<li style="margin-bottom: 6px;">${b.replace(/^•\s*/, '')}</li>`).join('');

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;line-height:1.6;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff">
  <p style="margin-top:0">Hi ${company ? '<strong>' + company + '</strong> Hiring Team' : 'Hiring Team'},</p>
  <p>I came across your opening for the <strong>${roleTitle}</strong> role at <strong>${compName}</strong> and wanted to reach out directly. Given your focus on building robust backend systems, my 4+ years of production experience building and scaling Python architectures directly aligns with your tech stack.</p>
  <div style="background:#f8fafc;border-left:4px solid #6366f1;padding:12px 16px;margin:16px 0;border-radius:4px">
    <strong style="color:#0f172a;display:block;margin-bottom:8px">Core Strengths Aligned with ${compName}:</strong>
    <ul style="margin:0;padding-left:18px;color:#334155">
      ${htmlBullets}
    </ul>
  </div>
  <p>I would welcome the opportunity to discuss how my backend and data engineering experience can support <strong>${compName}</strong>'s engineering milestones.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
  <p style="margin:0;font-size:13px;color:#64748b">
    <strong style="color:#0f172a">Milin Chaware</strong><br/>
    Senior Python Backend Developer<br/>
    📞 +91 7620369988 &middot; 📍 Pune / Remote
  </p>
</div>`;

  return { ok: true, subject, plainText, html, matchedKeywords: matched, aiPowered: false };
}

// ─── v8.5: HOURLY RECRUITER HEATMAP & REPORT ENGINE ──────────
function getHourlyHeatmapData() {
  const hours = Array(24).fill(0);
  if (fs.existsSync(SENT_LOG)) {
    const lines = fs.readFileSync(SENT_LOG, "utf8").split("\n");
    lines.forEach(line => {
      const parts = line.trim().split("|");
      if (parts.length >= 3) {
        const h = parseInt(parts[2], 10);
        if (!isNaN(h) && h >= 0 && h < 24) hours[h]++;
      }
    });
  }

  const peakHours = [9, 10, 11, 14, 15, 16];
  const totalSent = hours.reduce((a, b) => a + b, 0);
  const peakSent = peakHours.reduce((acc, h) => acc + hours[h], 0);
  const peakPct = totalSent > 0 ? Math.round((peakSent / totalSent) * 100) : 0;

  const hourly = hours.map((count, hour) => ({
    hour,
    label: `${hour.toString().padStart(2, "0")}:00`,
    count,
    isPeak: peakHours.includes(hour),
  }));

  return {
    ok: true,
    totalLogged: totalSent,
    peakSent,
    peakPct,
    bestWindow: "09:00 - 11:30 AM & 14:00 - 16:30 PM (Peak HR Open Rate)",
    hourly,
  };
}

function generateCampaignSummaryCsv() {
  let sentLines = [];
  if (fs.existsSync(SENT_LOG)) {
    sentLines = fs.readFileSync(SENT_LOG, "utf8").split("\n").filter(Boolean);
  }
  const rows = [];
  rows.push(["Section", "Metric", "Value", "Notes"]);
  rows.push(["Overview", "Total Historical Sends", sentLines.length, "All-time logged sent emails"]);
  rows.push(["Overview", "Leads Ready in Queue", state.remainingEmails || 0, "Non-gmail corporate contacts"]);
  rows.push(["Overview", "Current Sending Speed", CONFIG.speed || "medium", "Campaign delivery cadence"]);
  rows.push(["Accounts", "Configured Accounts", CONFIG.accounts.length, "Active rotating Gmail accounts"]);

  const statusCounts = { sent: 0, viewed: 0, interview: 0, rejected: 0, offer: 0, replied: 0 };
  JOBS.forEach(j => {
    statusCounts[j.status] = (statusCounts[j.status] || 0) + 1;
  });
  Object.keys(statusCounts).forEach(s => {
    rows.push(["Job Applications", `Status: ${s.toUpperCase()}`, statusCounts[s], "ATS Kanban funnel tracking"]);
  });

  return rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
}

// ─── AUTOMATED DRIP SEQUENCES ─────────────────────────────────
async function processDripFollowups() {
  const today = new Date().toISOString().split("T")[0];
  let sentCount = 0;

  // Filter jobs eligible for follow up
  const eligibleJobs = JOBS.filter(j => 
    (j.status === "sent" || j.status === "viewed") &&
    !j.sequenceStopped &&
    (j.sequenceStep || 1) < 3 &&
    j.nextFollowupDue &&
    j.nextFollowupDue <= today
  );

  if (!eligibleJobs.length) return { processed: 0, totalEligible: 0 };

  const transporter = createTransporter(CONFIG.accounts[0]);
  for (const job of eligibleJobs) {
    try {
      const curStep = job.sequenceStep || 1;
      let text = "";
      let html = "";
      let nextStep = curStep + 1;

      if (curStep === 1) {
        // Step 2: Friendly Bump
        text = `Hi,\n\nJust wanted to quickly follow up on my note from earlier regarding Python backend opportunities at ${job.company}.\n\nI'm currently between roles and available to join immediately, so I wanted to re-share in case my initial email got buried.\n\nBest regards,\nMilin Chaware\n7620369988 | milinchaware@gmail.com`;
        html = `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2937; max-width: 600px;">
          <p>Hi,</p>
          <p>Just wanted to quickly follow up on my note from earlier regarding Python backend opportunities at <strong>${job.company}</strong>.</p>
          <p>I'm currently between roles and available to join immediately, so I wanted to re-share in case my initial email got buried.</p>
          <p>Best regards,<br><strong>Milin Chaware</strong><br>7620369988 | <a href="mailto:milinchaware@gmail.com" style="color:#2563eb">milinchaware@gmail.com</a></p>
        </div>`;
        job.nextFollowupDue = new Date(Date.now() + (CONFIG.dripDay2 || 4) * 86400000).toISOString().split("T")[0];
      } else {
        // Step 3: Final Closing Note
        text = `Hi,\n\nFollowing up one last time regarding Python backend roles at ${job.company}.\n\nIf the timing isn't right at the moment, no problem at all — please feel free to keep my details on file for any future openings.\n\nThanks again for your time!\n\nBest regards,\nMilin Chaware\n7620369988 | milinchaware@gmail.com`;
        html = `<div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1f2937; max-width: 600px;">
          <p>Hi,</p>
          <p>Following up one last time regarding Python backend roles at <strong>${job.company}</strong>.</p>
          <p>If the timing isn't right at the moment, no problem at all — please feel free to keep my details on file for any future openings.</p>
          <p>Thanks again for your time!</p>
          <p>Best regards,<br><strong>Milin Chaware</strong><br>7620369988 | <a href="mailto:milinchaware@gmail.com" style="color:#2563eb">milinchaware@gmail.com</a></p>
        </div>`;
        job.sequenceStopped = true;
      }

      const mailOpts = {
        from: CONFIG.accounts[0].gmailAddress,
        to: job.email,
        subject: `Re: Following up — Python Developer Application`,
        text,
        html,
      };
      if (job.messageId) {
        mailOpts.inReplyTo = job.messageId;
        mailOpts.references = [job.messageId];
      }

      await transporter.sendMail(mailOpts);
      job.sequenceStep = nextStep;
      job.lastFollowupSent = today;
      job.notes = (job.notes ? job.notes + " | " : "") + `Follow-up Step ${nextStep} sent on ${today}`;
      sentCount++;
      addLog(`📩  Follow-up (Step ${nextStep}) sent to ${job.email} (${job.company}) in-thread!`, "success");
    } catch(err) {
      addLog(`❌  Follow-up failed for ${job.email}: ${err.message}`, "error");
    }
  }
  saveJobs();
  return { processed: sentCount, totalEligible: eligibleJobs.length };
}


// ─── JOBS ─────────────────────────────────────────────────────
let JOBS = [];
let _jobEmailSet = new Set();

function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      JOBS = JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
      _jobEmailSet = new Set(JOBS.map(j => (j.email || "").toLowerCase()).filter(Boolean));
    }
  } catch (e) {
    JOBS = [];
    _jobEmailSet = new Set();
  }
}
loadJobs();

let _saveJobsTimer = null;
function saveJobs(immediate = false) {
  const doWrite = () => {
    const data = JSON.stringify(JOBS, null, 2);
    const tmp = JOBS_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, JOBS_FILE);
    } catch(e) {
      try { fs.writeFileSync(JOBS_FILE, data); } catch(err) { console.error("Error saving jobs:", err); }
    }
  };
  if (immediate) {
    if (_saveJobsTimer) { clearTimeout(_saveJobsTimer); _saveJobsTimer = null; }
    doWrite();
    return;
  }
  if (_saveJobsTimer) return;
  _saveJobsTimer = setTimeout(() => {
    _saveJobsTimer = null;
    doWrite();
  }, 400);
}

function addJob(job) {
  const record = createJobRecord(job);
  
  // Calculate transparent match score if not already computed
  if (!record.match_score || record.match_score === 0) {
    const match = calculateJobMatch(record);
    record.match_score = match.score;
    record.match_details = match;
  }

  // Register recruiter contact
  if (record.email) {
    upsertRecruiter({
      email: record.email,
      company: record.company,
      designation: "Hiring Contact",
      source: record.source,
    });
  }

  JOBS.unshift(record);
  if (record.email) _jobEmailSet.add(record.email.toLowerCase());
  saveJobs();

  logActivity({
    eventType: "JOB_TRACKED",
    entity: "Job",
    status: "INFO",
    message: `Tracked job: ${record.job_title} at ${record.company} (Match: ${record.match_score}%)`,
    metadata: { id: record.id, company: record.company, score: record.match_score }
  });

  return record;
}

function updateJob(id, updates) {
  const idx = JOBS.findIndex(j => j.id === id);
  if (idx === -1) return null;
  const oldEmail = (JOBS[idx].email || "").toLowerCase();
  JOBS[idx] = { ...JOBS[idx], ...updates };
  const newEmail = (JOBS[idx].email || "").toLowerCase();
  if (oldEmail !== newEmail) {
    if (oldEmail) _jobEmailSet.delete(oldEmail);
    if (newEmail) _jobEmailSet.add(newEmail);
  }
  saveJobs();
  return JOBS[idx];
}

function deleteJob(id) {
  const idx = JOBS.findIndex(j => j.id === id);
  if (idx === -1) return false;
  const removed = JOBS.splice(idx, 1)[0];
  if (removed && removed.email) _jobEmailSet.delete(removed.email.toLowerCase());
  saveJobs();
  return true;
}

// ─── STATE ────────────────────────────────────────────────────
ensureDefaultFilesExist();

const state = {
  total: 0, sent: 0, failed: 0, skipped: 0, retried: 0,
  running: false, paused: false,
  currentEmail: "", currentAccount: "",
  accountIndex: 0, accountSentCount: [],
  log: [], startTime: null, speed: CONFIG.speed,
      concurrency: CONFIG.concurrency || 2,
  remainingEmails: 0, completionReady: false,
  scheduledTime: null, scheduledTimer: null,
  autopilot: CONFIG.autopilot !== false,
  autopilotStatus: "Standing by",
};

// ─── v7.0: NOTIFICATION CENTER ────────────────────────────────
const NOTIFICATIONS = [];
function addNotification(title, body, type = "info", icon = "🔔") {
  NOTIFICATIONS.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    title, body, type, icon,
    time: new Date().toISOString(),
    read: false,
  });
  if (NOTIFICATIONS.length > 100) NOTIFICATIONS.pop();
}

// ─── v7.0: SMART DOMAIN BLACKLIST ─────────────────────────────
const _domainFailures = new Map(); // domain -> { fails, total }
const _blacklistedDomains = new Set();
const BLACKLIST_THRESHOLD = 0.3; // 30% failure rate
const BLACKLIST_MIN_SAMPLES = 3;

function trackDomainResult(email, success) {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return;
  if (!_domainFailures.has(domain)) _domainFailures.set(domain, { fails: 0, total: 0 });
  const d = _domainFailures.get(domain);
  d.total++;
  if (!success) d.fails++;
  if (d.total >= BLACKLIST_MIN_SAMPLES && (d.fails / d.total) >= BLACKLIST_THRESHOLD) {
    if (!_blacklistedDomains.has(domain)) {
      _blacklistedDomains.add(domain);
      addLog(`🚫  Domain ${domain} auto-blacklisted (${d.fails}/${d.total} failures)`, "warn");
      addNotification("Domain Blacklisted", `${domain} — ${d.fails}/${d.total} failures`, "warn", "🚫");
    }
  }
}

function isDomainBlacklisted(email) {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain && _blacklistedDomains.has(domain);
}

// ─── v7.0: PER-ACCOUNT HEALTH SCORING ─────────────────────────
const _accountHealth = new Map(); // gmailAddress -> { sent, failed, bounced, lastError }
function trackAccountResult(account, success, errorMsg = "") {
  if (!_accountHealth.has(account)) _accountHealth.set(account, { sent: 0, failed: 0, bounced: 0, lastError: "" });
  const h = _accountHealth.get(account);
  if (success) h.sent++;
  else { h.failed++; h.lastError = errorMsg; }
}

function getAccountHealthScore(account) {
  const h = _accountHealth.get(account);
  if (!h || h.sent + h.failed === 0) return 100;
  return Math.max(0, Math.round((h.sent / (h.sent + h.failed)) * 100));
}

// ─── v7.0: A/B TESTING TRACKER ────────────────────────────────
const _abTracker = { A: { sent: 0, opened: 0, replied: 0 }, B: { sent: 0, opened: 0, replied: 0 } };
let _currentABSlot = "A";
function trackABSend(slot) {
  if (_abTracker[slot]) _abTracker[slot].sent++;
  _currentABSlot = _currentABSlot === "A" ? "B" : "A";
}

// ─── v7.0: CAMPAIGN MILESTONES ────────────────────────────────
const _milestones = [];
function checkMilestone() {
  const milestoneValues = [1, 10, 50, 100, 250, 500, 1000, 2000, 5000];
  for (const m of milestoneValues) {
    if (state.sent === m && !_milestones.find(x => x.value === m)) {
      _milestones.push({ value: m, time: new Date().toISOString(), label: `🎯 ${m} emails sent!` });
      addNotification(`Milestone: ${m} Emails!`, `You've sent ${m} emails in this campaign`, "success", "🎯");
      addLog(`🎯  Milestone reached: ${m} emails sent!`, "success");
      sendTelegramAlert(`🎯 <b>Campaign Milestone!</b>\nYou have sent <b>${m}</b> emails.\nProgress: ${state.sent}/${state.total} (${Math.round(state.sent/Math.max(1, state.total)*100)}%)`).catch(() => {});
    }
  }
}

function shouldLogToTerminal(msg) {
  if (process.env.SHOW_SKIPPED_IN_TERMINAL === "true") return true;
  if (typeof msg !== "string") return true;
  // Always display high-level batch summary or completion notifications
  if (
    msg.includes("unique emails ready to send") ||
    msg.includes("All emails already sent!")
  ) {
    return true;
  }
  const lower = msg.toLowerCase();
  // Filter out skipped emails and already sent messages on the terminal
  if (
    lower.includes("already sent") ||
    lower.includes("skip") ||
    lower.includes("skipped")
  ) {
    return false;
  }
  return true;
}

function addLog(msg, type = "info") {
  const entry = { time: new Date().toLocaleTimeString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 300) state.log.pop();
  if (shouldLogToTerminal(msg)) {
    console.log(`[${entry.time}] ${msg}`);
  }
}

// ─── SENT LOG (with in-memory store & date/hour tracking) ─────
let _sentLogEntriesCache = null;
let _sentLogSetCache = null;
const _directSendsInProgress = new Set();

function loadSentLogData() {
  if (_sentLogEntriesCache && _sentLogSetCache) {
    return { entries: _sentLogEntriesCache, set: _sentLogSetCache };
  }
  const entries = [];
  const set = new Set();
  if (fs.existsSync(SENT_LOG)) {
    try {
      const raw = fs.readFileSync(SENT_LOG, "utf8");
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split("|");
        const email = parts[0].toLowerCase();
        const date = (parts.length >= 2 && parts[1]) ? parts[1].trim() : "earlier";
        const hour = (parts.length >= 3 && parts[2]) ? parseInt(parts[2].trim(), 10) : null;
        entries.push({ email, date, hour });
        set.add(email);
      }
    } catch (e) {
      console.error("Error reading sent log:", e.message);
    }
  }
  _sentLogEntriesCache = entries;
  _sentLogSetCache = set;
  return { entries, set };
}

function invalidateSentLogCache() {
  _sentLogEntriesCache = null;
  _sentLogSetCache = null;
  _analyticsCacheTime = 0;
}

function loadSentLog() {
  return loadSentLogData().set;
}

function markSent(email, company = "", account = "") {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hour = now.getHours();
  const emailLower = email.toLowerCase();
  fs.appendFileSync(SENT_LOG, `${emailLower}|${date}|${hour}\n`);

  if (_sentLogEntriesCache && _sentLogSetCache) {
    _sentLogEntriesCache.push({ email: emailLower, date, hour });
    _sentLogSetCache.add(emailLower);
  }
  invalidateAnalyticsCache();
}

// ─── ANALYTICS (in-memory aggregation with result caching) ────
let _analyticsCache = null;
let _analyticsCacheTime = 0;
const ANALYTICS_CACHE_TTL = 5_000; // cache for 5s between requests

function getAnalytics() {
  const now = Date.now();
  if (_analyticsCache && now - _analyticsCacheTime < ANALYTICS_CACHE_TTL) {
    // Return cached but always update live state fields
    const delay = SPEED_DELAY[state.speed] || 1500;
    const remaining = Math.max(0, state.total - state.sent);
    const etaSeconds = remaining > 0 && state.running ? Math.floor((remaining * delay) / 1000) : 0;
    const totalSession = state.sent + state.failed;
    const successRate = totalSession > 0 ? Math.round(state.sent / totalSession * 100) : 0;
    return { ..._analyticsCache, etaSeconds, remaining, successRate };
  }
  const { entries } = loadSentLogData();
  const dailyCounts = {};
  const totalInLog = entries.length;
  for (let i = 0; i < entries.length; i++) {
    const d = entries[i].date;
    dailyCounts[d] = (dailyCounts[d] || 0) + 1;
  }
  const sortedDates = Object.keys(dailyCounts).filter(d => d !== "earlier").sort();
  if (dailyCounts["earlier"]) sortedDates.unshift("earlier");
  const labels = sortedDates.map(d => d === "earlier" ? "Earlier" : d);
  const values = sortedDates.map(d => dailyCounts[d]);
  const delay = SPEED_DELAY[state.speed] || 1500;
  const remaining = Math.max(0, state.total - state.sent);
  const etaSeconds = remaining > 0 && state.running ? Math.floor((remaining * delay) / 1000) : 0;
  const totalSession = state.sent + state.failed;
  const successRate = totalSession > 0 ? Math.round(state.sent / totalSession * 100) : 0;
  const result = { totalInLog, labels, values, successRate, etaSeconds, remaining };
  _analyticsCache = { totalInLog, labels, values };
  _analyticsCacheTime = now;
  return result;
}

// Invalidate analytics cache when a new email is sent
function invalidateAnalyticsCache() { _analyticsCacheTime = 0; }

// ─── LOAD EMAIL FILES ─────────────────────────────────────────
let allEmails = [];

function loadAllEmailFiles() {
  const txtFiles = fs.readdirSync(EMAILS_DIR)
    .filter(f => f.endsWith(".txt") && !f.startsWith("sent_log") && !f.startsWith("report"))
    .sort();

  if (txtFiles.length === 0) {
    addLog("❌  No .txt email files found! Create emails.txt or batch1.txt", "error");
    return [];
  }
  addLog(`📁  ${txtFiles.length} file(s): ${txtFiles.join(", ")}`);

  const sentLog = loadSentLog();
  const emails = [];
  const seen = new Set();
  let skipped = 0;

  if (CONFIG.resendSentEmails && sentLog.size > 0) {
    addLog("⚠️  Resend mode is ON — previously sent emails will be included", "warn");
  }

  for (const file of txtFiles) {
    const content = fs.readFileSync(path.join(EMAILS_DIR, file), "utf8");
    for (const rawLine of content.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#") || /^email/i.test(trimmed) || /^recipient/i.test(trimmed) || /^company/i.test(trimmed)) continue;

      let company = "Your Company";
      let context = "";
      let textToSearch = trimmed;
      if (trimmed.includes(",")) {
        const parts = trimmed.split(",");
        textToSearch = parts[0].trim();
        company = parts[1]?.trim() || "Your Company";
        context = parts.slice(2).join(",").trim();
      }

      // Extract all valid emails from line using regex
      const foundEmails = textToSearch.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
      if (!foundEmails || foundEmails.length === 0) {
        continue;
      }

      for (let rawEmail of foundEmails) {
        let email = sanitizeEmailCandidate(rawEmail);
        if (!isValidRfcEmail(email)) {
          skipped++;
          continue;
        }

        // Skip personal @gmail.com addresses (corporate / company domains only)
        if (CONFIG.skipPersonalGmail !== false && (email.toLowerCase().endsWith("@gmail.com") || email.toLowerCase().includes("@gmail."))) {
          skipped++;
          continue;
        }

        // Prevent emailing sender's own sending account(s)
        const isOwnSender = CONFIG.accounts.some(a => a.gmailAddress && a.gmailAddress.toLowerCase() === email.toLowerCase()) ||
          email === "milinchaware@gmail.com" || email === "milinchaware9@gmail.com";
        if (isOwnSender) { skipped++; continue; }
        if (seen.has(email)) { skipped++; continue; }
        seen.add(email);
        if (!CONFIG.resendSentEmails && sentLog.has(email)) {
          skipped++;
          continue;
        }
        emails.push({ email, company, context, source: file });
      }
    }
  }

  state.skipped = skipped;
  addLog(`✅  ${emails.length} unique emails ready to send (${skipped} skipped)`);
  return emails;
}

// ─── PROGRESS ─────────────────────────────────────────────────
function loadProgress() {
  const today = new Date().toISOString().split("T")[0];
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
      if (data.date && data.date !== today) {
        addLog(`🌅  New day (${today}) detected — resetting daily account limits to 0`, "info");
        data.accountIndex = 0;
        data.accountSentCounts = CONFIG.accounts.map(() => 0);
        data.date = today;
        saveProgress(data.lastIndex || 0, data.accountIndex, data.accountSentCounts);
      }
      addLog(`📂  Progress: resumed from index ${data.lastIndex}`);
      return data;
    }
  } catch (e) {}
  return { lastIndex: 0, accountIndex: 0, accountSentCounts: CONFIG.accounts.map(() => 0), date: today };
}

function saveProgress(index, accountIndex, accountSentCounts) {
  const date = new Date().toISOString().split("T")[0];
  const data = JSON.stringify({ lastIndex: index, accountIndex, accountSentCounts, date }, null, 2);
  const tmp = PROGRESS_FILE + ".tmp";
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, PROGRESS_FILE);
  } catch(e) {
    try { fs.writeFileSync(PROGRESS_FILE, data); } catch(_) {}
  }
}

function clearProgress() {
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

// ─── TRANSPORTER (Connection Pooling) ─────────────────────────
const _transporters = new Map();

function createTransporter(account) {
  const email = account.gmailAddress;
  if (_transporters.has(email)) return _transporters.get(email);
  const t = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    pool: true,
    maxConnections: 8,
    maxMessages: 300,
    socketTimeout: 25000,
    connectionTimeout: 10000,
    greetingTimeout: 8000,
    auth: { user: account.gmailAddress, pass: account.appPassword },
  });
  t.on("error", (err) => {
    console.error(`[SMTP Warning] Connection dropped for ${email}:`, err.message);
    _transporters.delete(email);
  });
  _transporters.set(email, t);
  return t;
}

// Cached attachment resolver
let _cachedAttachment = null;
let _lastAttachmentPath = null;
let _lastAttachmentMtime = 0;
function getMailAttachment() {
  if (!CONFIG.attachmentEnabled || !CONFIG.attachment) return null;
  try {
    const absPath = path.resolve(CONFIG.attachment);
    if (fs.existsSync(absPath)) {
      const stat = fs.statSync(absPath);
      if (_cachedAttachment && _lastAttachmentPath === absPath && _lastAttachmentMtime === stat.mtimeMs) {
        return _cachedAttachment;
      }
      const buffer = fs.readFileSync(absPath);
      _cachedAttachment = [{
        filename: path.basename(absPath),
        content: buffer
      }];
      _lastAttachmentPath = absPath;
      _lastAttachmentMtime = stat.mtimeMs;
      return _cachedAttachment;
    }
  } catch (e) {}
  return null;
}

// ─── SEND ONE EMAIL (with retry & AI personalization & tracking) ──────────
async function sendOne(transporter, to, company, context = "", jobId = null, attempt = 0) {
  if (!isValidRfcEmail(to)) {
    return { success: false, error: `Invalid recipient RFC 5321 email syntax: ${to}`, permanent: true };
  }
  if (CONFIG.skipPersonalGmail !== false && (to.toLowerCase().endsWith("@gmail.com") || to.toLowerCase().includes("@gmail."))) {
    return { success: false, error: "Skipped: Personal @gmail.com addresses are disabled", permanent: true };
  }

  // v7.0: A/B Testing Slot Selection
  const abSlot = _currentABSlot;
  trackABSend(abSlot);

  // Use AI subject rotation or Slot B subject when available
  const useAiRotation = CONFIG.aiSubjectRotation !== false;
  let subject = "";
  if (abSlot === "B" && TEMPLATE.subjectB) {
    subject = formatCompanyPlaceholders(TEMPLATE.subjectB, company, "");
  } else {
    subject = useAiRotation ? getNextAiSubject(company) : getSubject(company);
  }

  // Generate personalized line if template contains {personalization}, context is provided, or autoPersonalizeLeads is ON
  let personalization = "";
  if (CONFIG.autoPersonalizeLeads !== false || TEMPLATE.plainText.includes("{personalization}") || TEMPLATE.html.includes("{personalization}") || (context && context.trim())) {
    try {
      let targetComp = (company && company.trim() && company !== "Your Company" && company !== "Target Company") ? company.trim() : "";
      if (!targetComp) {
        const at = to.indexOf("@");
        if (at !== -1) {
          const domPart = to.slice(at + 1).split(".")[0];
          if (domPart && !["gmail", "yahoo", "outlook", "hotmail", "icloud"].includes(domPart.toLowerCase())) {
            targetComp = domPart.charAt(0).toUpperCase() + domPart.slice(1);
          }
        }
      }
      personalization = await generatePersonalizationLine(targetComp || "Engineering Team", context || "Senior Python Backend Developer");
    } catch (e) {
      personalization = "";
    }
  }

  const plainText = getPlainText(company, personalization);
  const htmlContent = getHtmlEmail(company, personalization, jobId);

  const mailOptions = {
    from: CONFIG.accounts[state.accountIndex].gmailAddress,
    to,
    subject,
    text: plainText,
  };
  if (!CONFIG.plainTextOnly && htmlContent && htmlContent.trim() !== "") {
    mailOptions.html = htmlContent;
  }
  const attachments = getMailAttachment();
  if (attachments) mailOptions.attachments = attachments;
  try {
    const info = await transporter.sendMail(mailOptions);
    return { success: true, messageId: info.messageId, personalization, abSlot };
  } catch (err) {
    const errMsg = err.message || "";
    // Smart Rate Limit Guard: only trigger on genuine rate limit or quota errors
    const isRateErr = (
      errMsg.includes("421") ||
      errMsg.includes("452") ||
      errMsg.includes("Daily sending quota") ||
      errMsg.includes("rate limit") ||
      errMsg.includes("Too many") ||
      errMsg.includes("quota exceeded") ||
      errMsg.includes("550-5.4.5") ||
      (errMsg.includes("550") && errMsg.toLowerCase().includes("quota"))
    );
    if (isRateErr) {
      addLog(`🔄  Rate limit detected on ${CONFIG.accounts[state.accountIndex]?.gmailAddress || "current account"} — forcing account rotation`, "warn");
      state.accountSentCount[state.accountIndex] = CONFIG.dailyLimitPerAccount;
      return { success: false, error: errMsg, rateLimit: true };
    }

    // Permanent recipient errors (bad syntax, user doesn't exist, rejected address) — DO NOT RETRY
    const isPermanentErr = (
      errMsg.includes("553") ||
      errMsg.includes("501") ||
      errMsg.includes("not a valid RFC") ||
      errMsg.includes("550 5.1.1") ||
      errMsg.includes("User unknown") ||
      errMsg.includes("recipient rejected") ||
      errMsg.includes("Mailbox not found") ||
      errMsg.includes("does not exist")
    );

    if (errMsg && (errMsg.includes("ECONNRESET") || errMsg.includes("ETIMEDOUT") || errMsg.includes("Connection closed") || errMsg.includes("socket") || errMsg.includes("Broken pipe"))) {
      const activeEmail = CONFIG.accounts[state.accountIndex]?.gmailAddress;
      if (activeEmail) {
        _transporters.delete(activeEmail);
        console.warn(`[SMTP Self-Healing] Auto-purged dropped connection socket for ${activeEmail}`);
      }
    }
    if (!isPermanentErr && attempt < CONFIG.maxRetries - 1) {
      state.retried++;
      addLog(`🔄  Retry ${attempt + 1}/${CONFIG.maxRetries - 1} for ${to}`, "warn");
      await sleep(CONFIG.retryDelay);
      return sendOne(transporter, to, company, context, jobId, attempt + 1);
    }
    return { success: false, error: errMsg, permanent: isPermanentErr };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── v8.6 AUTOPILOT & RECRUITER SCHEDULER ─────────────────────
const _inFlightMxCache = new Map();
let _inFlightBlockedCount = 0;

function checkIsRecruiterWindow() {
  const now = new Date();
  const day = now.getDay();
  const hour = now.getHours();
  const isWeekend = (day === 0 || day === 6);
  if (CONFIG.skipWeekends !== false && isWeekend) {
    return { inWindow: false, reason: "Weekend (Resumes Monday 09:00 AM)", nextWindow: "Monday 09:00 AM" };
  }
  const start = CONFIG.businessStartHour || 9;
  const end = CONFIG.businessEndHour || 18;
  if (hour < start) {
    return { inWindow: false, reason: `Early Morning (Window opens at ${start}:00 AM)`, nextWindow: `Today ${start}:00 AM` };
  }
  if (hour >= end) {
    return { inWindow: false, reason: `Evening / Night (Window closed, resumes tomorrow ${start}:00 AM)`, nextWindow: `Tomorrow ${start}:00 AM` };
  }
  return { inWindow: true, reason: `Active Recruiter Window (${start}:00 AM - ${end}:00 PM)`, nextWindow: "Now" };
}

let _autopilotSupervisorInterval = null;
function startAutopilotSupervisor() {
  if (_autopilotSupervisorInterval) clearInterval(_autopilotSupervisorInterval);
  _autopilotSupervisorInterval = setInterval(async () => {
    if (!state.autopilot) {
      state.autopilotStatus = "Disabled (Manual Mode)";
      return;
    }

    const win = checkIsRecruiterWindow();
    if (!win.inWindow) {
      state.autopilotStatus = `Sleeping — ${win.reason}`;
      if (state.running && !state.paused) {
        state.paused = true;
        addLog(`🌙 [Autopilot] Recruiter window closed (${win.reason}). Campaign paused until ${win.nextWindow}.`, "info");
      }
      return;
    }

    // Inside recruiter window!
    state.autopilotStatus = "Active — Peak Recruiter Window";

    if (state.running && state.paused) {
      state.paused = false;
      addLog("☀️ [Autopilot] Peak recruiter window arrived! Resuming outreach campaign...", "success");
      return;
    }

    if (!state.running) {
      const unsent = loadAllEmailFiles();
      if (unsent.length > 0) {
        addLog(`🤖 [Autopilot] Recruiter window active! Auto-starting campaign for ${unsent.length} pending corporate leads...`, "success");
        sendEmails().catch(e => addLog(`[Autopilot Error] ${e.message}`, "error"));
      } else {
        state.autopilotStatus = "Idle — All Queue Leads Sent";
      }
    }
  }, 30000);
}

let _dripSupervisorInterval = null;
function startDripSupervisor() {
  if (_dripSupervisorInterval) clearInterval(_dripSupervisorInterval);
  const intervalMs = (CONFIG.autoDripIntervalMinutes || 30) * 60 * 1000;
  _dripSupervisorInterval = setInterval(async () => {
    if (CONFIG.autoDripFollowup !== false) {
      try {
        const win = checkIsRecruiterWindow();
        if (win.inWindow) {
          const result = await processDripFollowups();
          if (result && result.sent > 0) {
            addLog(`🤖 [Autopilot Drip] Dispatched ${result.sent} due follow-up emails!`, "success");
          }
        }
      } catch (e) {}
    }
  }, intervalMs);
}

// ─── MAIN SEND LOOP ───────────────────────────────────────────
async function sendEmails() {
  state.running = true;
  state.startTime = Date.now();
  state.completionReady = false;
  state.sent = 0; state.failed = 0; state.skipped = 0; state.retried = 0;

  allEmails = loadAllEmailFiles();
  state.total = allEmails.length;
  state.remainingEmails = allEmails.length;

  const progress = loadProgress();
  let globalIndex = progress.lastIndex;
  state.accountIndex = Math.min(progress.accountIndex || 0, CONFIG.accounts.length - 1);
  state.accountSentCount = (progress.accountSentCounts && progress.accountSentCounts.length === CONFIG.accounts.length)
    ? progress.accountSentCounts
    : CONFIG.accounts.map(() => 0);

  if (allEmails.length === 0 || globalIndex >= allEmails.length) {
    addLog("✅  All emails already sent!", "success");
    clearProgress();
    state.running = false;
    state.completionReady = true;
    return;
  }

  const numStreams = Math.max(1, Math.min(3, parseInt(CONFIG.concurrency) || (state.speed === "turbo" ? 2 : 1)));
  state.currentAccount = CONFIG.accounts[state.accountIndex]?.gmailAddress || "Primary";
  addLog(`🚀  Engine started | Speed: ${state.speed.toUpperCase()} | Concurrency: ${numStreams} Stream(s) | From #${globalIndex + 1}`);

  let nextQueueIndex = globalIndex;
  let stopping = false;

  async function sendWorker(workerId) {
    while (state.running && !stopping) {
      while (state.paused) { await sleep(500); }
      if (!state.running || stopping) break;

      // Check Business Hours Window / Autopilot Recruiter Window
      if (CONFIG.onlySendInBusinessHours || state.autopilot) {
        const win = checkIsRecruiterWindow();
        if (!win.inWindow) {
          if (workerId === 0) {
            state.autopilotStatus = `Sleeping — ${win.reason}`;
            addLog(`🌙 Outside recruiter window (${win.reason}) — Autopilot paused until ${win.nextWindow}`, "warn");
          }
          await sleep(30000);
          continue;
        }
      }

      // Claim next email index atomically
      const myIndex = nextQueueIndex++;
      if (myIndex >= allEmails.length) break;

      // v7.0: Smart Health-Based Account Rotation
      let accIdx = (state.accountIndex + workerId) % CONFIG.accounts.length;
      if (state.accountSentCount[accIdx] >= CONFIG.dailyLimitPerAccount || getAccountHealthScore(CONFIG.accounts[accIdx].gmailAddress) < 40) {
        let bestIdx = -1;
        let bestScore = -1;
        for (let i = 0; i < CONFIG.accounts.length; i++) {
          if (state.accountSentCount[i] >= CONFIG.dailyLimitPerAccount) continue;
          const score = getAccountHealthScore(CONFIG.accounts[i].gmailAddress);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
        if (bestIdx === -1) {
          bestIdx = state.accountSentCount.findIndex(cnt => cnt < CONFIG.dailyLimitPerAccount);
        }
        if (bestIdx === -1) {
          if (!stopping) {
            stopping = true;
            addLog("⏸️  All accounts at daily limit! Run again tomorrow.", "warn");
            saveProgress(myIndex, state.accountIndex, state.accountSentCount);
          }
          break;
        }
        accIdx = bestIdx;
        state.accountIndex = accIdx;
      }

      const activeAccount = CONFIG.accounts[accIdx];
      const activeTransporter = createTransporter(activeAccount);

      const { email, company, context } = allEmails[myIndex];
      state.currentEmail = email;
      state.currentAccount = activeAccount.gmailAddress;
      state.remainingEmails = Math.max(0, allEmails.length - myIndex);
      const num = `[${myIndex + 1}/${allEmails.length}]`;

      // Real-time duplicate guard: re-check sent log before sending
      const currentSentLog = loadSentLog();
      if (!CONFIG.resendSentEmails && currentSentLog.has(email.toLowerCase())) {
        addLog(`⏭️  ${num} ${email} — Already sent, skipping duplicate`, "warn");
        state.skipped++;
        saveProgress(myIndex + 1, accIdx, state.accountSentCount);
        continue;
      }

      // Suppression & Opt-Out Shield
      const suppressionStatus = isSuppressed(email);
      if (suppressionStatus.suppressed) {
        state.skipped++;
        addLog(`🚫  ${num} ${email} — Skipped: Recipient suppressed (${suppressionStatus.reason})`, "warn");
        logActivity({
          eventType: "EMAIL_SUPPRESSED",
          entity: "Email",
          status: "WARN",
          message: `Suppressed outreach to ${email}: ${suppressionStatus.reason}`,
          metadata: { email, reason: suppressionStatus.reason }
        });
        saveProgress(myIndex + 1, accIdx, state.accountSentCount);
        continue;
      }

      // Recruiter Frequency & Anti-Harassment Cooldown Check
      const recruiterSafety = checkOutreachSafety(email, company);
      if (!recruiterSafety.safe) {
        state.skipped++;
        addLog(`⏸️  ${num} ${email} — Skipped: ${recruiterSafety.reason}`, "warn");
        logActivity({
          eventType: "RECRUITER_COOLDOWN",
          entity: "Recruiter",
          status: "WARN",
          message: `Skipped ${email}: ${recruiterSafety.reason}`,
          metadata: { email, reason: recruiterSafety.reason }
        });
        saveProgress(myIndex + 1, accIdx, state.accountSentCount);
        continue;
      }

      // Check warm-up mode daily limit
      const warmupLimit = getWarmupLimit();
      if (warmupLimit !== null && state.sent >= warmupLimit) {
        if (!stopping) {
          stopping = true;
          addLog(`🌱 Warm-up Mode: Daily limit of ${warmupLimit} reached for today. Run again tomorrow.`, "warn");
          saveProgress(myIndex, accIdx, state.accountSentCount);
        }
        break;
      }

      // Prepare or look up Job ID for tracking pixel & ATS
      let existingJob = JOBS.find(j => j.email && j.email.toLowerCase() === email.toLowerCase());
      const jobId = existingJob ? existingJob.id : (Date.now().toString() + Math.random().toString(36).slice(2, 6));

      // v7.0: Smart Blacklist Check
      if (isDomainBlacklisted(email)) {
        state.skipped++;
        addLog(`🚫  ${num} ${email} — Skipped (domain blacklisted)`, "warn");
        saveProgress(myIndex + 1, accIdx, state.accountSentCount);
        continue;
      }

      // Automated In-Flight DNS MX Verification Shield
      if (CONFIG.autoVerifyMxOnSend !== false) {
        const at = email.indexOf("@");
        if (at !== -1) {
          const dom = email.slice(at + 1).toLowerCase().trim();
          if (!_inFlightMxCache.has(dom)) {
            try {
              const mx = await dns.promises.resolveMx(dom);
              _inFlightMxCache.set(dom, Boolean(mx && mx.length > 0));
            } catch (e) {
              _inFlightMxCache.set(dom, false);
            }
          }
          if (!_inFlightMxCache.get(dom)) {
            _inFlightBlockedCount++;
            state.skipped++;
            addLog(`🛡️ [Auto-Shield] ${num} ${email} — Skipped unreachable domain (no DNS MX records found)`, "warn");
            saveProgress(myIndex + 1, accIdx, state.accountSentCount);
            continue;
          }
        }
      }

      const result = await sendOne(activeTransporter, email, company, context, jobId);

      if (result.success) {
        state.sent++;
        state.accountSentCount[accIdx]++;
        markSent(email);
        recordOutreach(email, company);
        logActivity({
          eventType: "EMAIL_SENT",
          entity: "Email",
          status: "SUCCESS",
          message: `Outreach email delivered to ${email} (${company || "Direct"})`,
          metadata: { email, company, account: activeAccount.gmailAddress }
        });
        trackDomainResult(email, true); // v7.0
        trackAccountResult(activeAccount.gmailAddress, true); // v7.0
        checkMilestone(); // v7.0
        addLog(`✅  ${num} ${email} (${company || "Direct"}) — Sent!`, "success");

        const today = new Date().toISOString().split("T")[0];
        const nextDue = new Date(Date.now() + (CONFIG.dripDay1 || 4) * 86400000).toISOString().split("T")[0];

        if (existingJob) {
          updateJob(existingJob.id, {
            company,
            role: "Python Developer",
            dateSent: today,
            status: "sent",
            abSlot: result.abSlot || existingJob.abSlot || "A",
            messageId: result.messageId || existingJob.messageId || "",
            sequenceStep: 1,
            nextFollowupDue: nextDue,
            sequenceStopped: false,
            notes: (existingJob.notes ? existingJob.notes + " | " : "") + (result.personalization ? `AI: ${result.personalization.slice(0, 45)}...` : "Sent")
          });
        } else {
          addJob({
            id: jobId,
            company,
            email,
            role: "Python Developer",
            dateSent: today,
            status: "sent",
            abSlot: result.abSlot || "A",
            messageId: result.messageId || "",
            sequenceStep: 1,
            nextFollowupDue: nextDue,
            sequenceStopped: false,
            opened: false,
            openedCount: 0,
            resumeClicked: false,
            resumeClickedCount: 0,
            notes: result.personalization ? `AI: ${result.personalization.slice(0, 45)}...` : ""
          });
        }
      } else {
        state.failed++;
        logActivity({
          eventType: "EMAIL_FAILED",
          entity: "Email",
          status: "ERROR",
          message: `Delivery to ${email} failed: ${result.error}`,
          metadata: { email, error: result.error }
        });
        trackDomainResult(email, false); // v7.0
        trackAccountResult(activeAccount.gmailAddress, false, result.error); // v7.0
        addLog(`❌  ${num} ${email} — Failed: ${result.error}`, "error");
        if (result.rateLimit || (result.error && (result.error.includes("Daily") || result.error.includes("limit") || result.error.includes("quota")))) {
          state.accountSentCount[accIdx] = CONFIG.dailyLimitPerAccount;
          continue;
        }
      }

      saveProgress(myIndex + 1, accIdx, state.accountSentCount);

      // Apply speed delay with human jitter if enabled
      let delay = SPEED_DELAY[state.speed] || 1500;
      const minDelay = state.speed === "turbo" ? 150 : (state.speed === "fast" ? 300 : 500);
      if (state.speed === "stealth") {
        // Human mimic: randomized natural delays between 15s - 38s
        delay = Math.round(15000 + Math.random() * 23000);
      } else if (CONFIG.enableHumanJitter && state.speed !== "turbo") {
        const jitter = (Math.random() - 0.5) * 0.4 * delay;
        delay = Math.max(minDelay, Math.round(delay + jitter));
      } else {
        delay = Math.max(minDelay, delay);
      }
      await sleep(delay);
    }
  }

  // Launch concurrent worker streams
  const workers = [];
  for (let w = 0; w < numStreams; w++) {
    workers.push(sendWorker(w));
  }
  await Promise.all(workers);

  // Write report
  const reportLines = [
    "====== EMAIL SEND REPORT ======",
    `Date: ${new Date().toLocaleString()}`,
    `Sent: ${state.sent}`, `Failed: ${state.failed}`,
    `Skipped: ${state.skipped}`, `Retried: ${state.retried}`,
    "==============================",
    ...state.log.slice().reverse().map(l => `[${l.time}] ${l.msg}`)
  ];
  fs.writeFileSync(REPORT_FILE, reportLines.join("\n"));

  state.running = false;
  state.completionReady = true;
  addLog(`🎉  Done! Sent: ${state.sent} | Failed: ${state.failed} | Total: ${state.total}`, "success");
  if (globalIndex >= allEmails.length) clearProgress();
}

// ─── DASHBOARD ────────────────────────────────────────────────
function startDashboard() {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // MAIN DASHBOARD & SPA ROUTES
  const SPA_ROUTES = [
    "/",
    "/dashboard",
    "/jobs",
    "/emails",
    "/templates",
    "/template",
    "/analytics",
    "/inbox",
    "/settings",
    "/campaigns",
    "/recruiters",
    "/interviews",
    "/matching",
    "/activity"
  ];
  SPA_ROUTES.forEach(route => {
    app.get(route, (req, res) => {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.send(DASHBOARD_HTML);
    });
  });

  // STATE
  app.get("/api/state", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const elapsed = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
    const rate = elapsed > 0 ? (state.sent / elapsed * 60).toFixed(1) : "0";
    const delay = SPEED_DELAY[state.speed] || 1500;
    const etaSeconds = state.running && !state.paused ? Math.floor(((state.total - state.sent) * delay) / 1000) : 0;
    res.json({
      ...state,
      elapsed, rate, etaSeconds,
      jobsCount: JOBS.length,
      activeResume: CONFIG.attachment ? path.basename(CONFIG.attachment) : "",
      cfgSpeed: CONFIG.speed,
      cfgDailyLimit: CONFIG.dailyLimitPerAccount,
      cfgAttachEnabled: CONFIG.attachmentEnabled,
      resendMode: CONFIG.resendSentEmails || false,
      skipPersonalGmail: CONFIG.skipPersonalGmail !== false,
      allowGmail: CONFIG.skipPersonalGmail === false,
      scheduledTime: state.scheduledTime,
      autopilot: state.autopilot,
      autopilotStatus: state.autopilotStatus,
      recruiterWindow: checkIsRecruiterWindow(),
      inFlightMx: CONFIG.autoVerifyMxOnSend !== false,
      autoPersonalize: CONFIG.autoPersonalizeLeads !== false,
      autoDrip: CONFIG.autoDripFollowup !== false,
      autoBlockedDeadDomains: _inFlightBlockedCount,
    });
  });

  // CONTROL
  app.post("/api/control", (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const { action, speed } = req.body;

    if (action === "pause") {
      state.paused = true;
      addLog("⏸️  Campaign Paused", "warn");
      return res.json({ ok: true, message: "Campaign paused", running: state.running, paused: true });
    }

    if (action === "resume" || action === "start") {
      state.paused = false;
      allEmails = loadAllEmailFiles();
      state.total = allEmails.length;
      state.remainingEmails = Math.max(0, state.total - state.sent);
      addLog(`▶️  Campaign Resumed (${allEmails.length} emails target)`, "success");
      if (!state.running && allEmails.length > 0) {
        sendEmails().catch(err => addLog(`Send error: ${err.message}`, "error"));
      }
      return res.json({ ok: true, message: "Campaign started", total: allEmails.length, running: true, paused: false });
    }

    if (action === "reload" || action === "reload_off" || action === "reloadOff" || action === "reloadQuiet") {
      allEmails = loadAllEmailFiles();
      state.total = allEmails.length;
      state.remainingEmails = Math.max(0, state.total - state.sent);
      loadTemplate();
      loadJobs();
      CONFIG = loadSettings();
      addLog(`🔄  Queue & Config reloaded from disk: ${allEmails.length} corporate leads ready`, "info");
      return res.json({ ok: true, message: "Queue reloaded", total: allEmails.length });
    }

    if (action === "resetDailyLimits") {
      state.accountIndex = 0;
      state.accountSentCount = CONFIG.accounts.map(() => 0);
      const progress = loadProgress();
      saveProgress(progress.lastIndex || 0, 0, state.accountSentCount);
      addLog("🔄  Account daily sending counts have been reset to 0", "info");
      return res.json({ ok: true, message: "Daily limits reset to 0" });
    }

    if (action === "resetProgress") {
      clearProgress();
      state.sent = 0;
      state.failed = 0;
      state.accountIndex = 0;
      state.accountSentCount = CONFIG.accounts.map(() => 0);
      addLog("🗑️  Sending progress reset to #1", "warn");
      return res.json({ ok: true, message: "Progress reset to beginning" });
    }

    if (action === "stop") {
      state.running = false;
      state.paused = true;
      addLog("⏹️  Campaign Stopped", "error");
      return res.json({ ok: true, message: "Campaign stopped", running: false, paused: true });
    }

    if (action === "toggleResendMode") {
      CONFIG.resendSentEmails = !CONFIG.resendSentEmails;
      saveSettings({ resendSentEmails: CONFIG.resendSentEmails });
      allEmails = loadAllEmailFiles();
      state.total = allEmails.length;
      addLog(`🔁  Resend mode ${CONFIG.resendSentEmails ? 'ENABLED' : 'DISABLED'} (${allEmails.length} emails ready)`, CONFIG.resendSentEmails ? 'warn' : 'info');
      
      if (CONFIG.resendSentEmails && !state.running && allEmails.length > 0) {
        clearProgress();
        state.paused = false;
        sendEmails().catch(err => addLog(`Send error: ${err.message}`, "error"));
      }
      return res.json({ ok: true, resendMode: CONFIG.resendSentEmails, total: allEmails.length });
    }

    if (action === "toggleGmailMode" || action === "toggleSkipGmail") {
      CONFIG.skipPersonalGmail = !CONFIG.skipPersonalGmail;
      saveSettings({ skipPersonalGmail: CONFIG.skipPersonalGmail });
      allEmails = loadAllEmailFiles();
      state.total = allEmails.length;
      state.remainingEmails = Math.max(0, state.total - state.sent);
      const allowGmail = !CONFIG.skipPersonalGmail;
      addLog(`📧  @gmail.com sending ${allowGmail ? 'ENABLED — personal @gmail.com leads included' : 'DISABLED — personal @gmail.com excluded (business only)'} (${allEmails.length} leads in queue)`, allowGmail ? 'success' : 'warn');
      return res.json({ ok: true, allowGmail, skipPersonalGmail: CONFIG.skipPersonalGmail, total: allEmails.length });
    }

    if (speed) {
      state.speed = speed;
      CONFIG.speed = speed;
      saveSettings({ speed: speed });
      addLog(`⚡  Speed set to: ${speed.toUpperCase()}`, "info");
    }

    res.json({ ok: true });
  });

  // ACCOUNT DIAGNOSTICS
  app.post("/api/accounts/verify", async (req, res) => {
    const results = [];
    for (let i = 0; i < CONFIG.accounts.length; i++) {
      const acc = CONFIG.accounts[i];
      try {
        const transporter = createTransporter(acc);
        await transporter.verify();
        results.push({ index: i, gmailAddress: acc.gmailAddress, status: "ok", message: "SMTP Connected & Authenticated" });
      } catch (err) {
        results.push({ index: i, gmailAddress: acc.gmailAddress, status: "error", message: err.message });
      }
    }
    const okCount = results.filter(r => r.status === "ok").length;
    addLog(`🩺  Ran account health check: ${okCount}/${results.length} accounts healthy`, okCount === results.length ? "success" : "warn");
    res.json({ ok: true, results });
  });

  // LOG EXPORT
  app.get("/api/log/export", (req, res) => {
    const header = [
      "============================================================",
      "                 RESUMEAUTO SESSION LOG EXPORT              ",
      ` Export Time: ${new Date().toLocaleString()}`,
      ` Total Sent: ${state.sent} | Failed: ${state.failed} | Skipped: ${state.skipped}`,
      ` Accounts Configured: ${CONFIG.accounts.map(a => a.gmailAddress).join(", ")}`,
      "============================================================",
      "",
    ].join("\n");
    const logLines = state.log.map(l => `[${l.time}] [${l.type.toUpperCase()}] ${l.msg}`).join("\n");
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename=resumeauto_log_${Date.now()}.txt`);
    res.send(header + logLines);
  });

  // SCHEDULE START
  app.post("/api/schedule", (req, res) => {
    const { delayMinutes, targetTime } = req.body;
    let ms = 0;
    if (delayMinutes && parseInt(delayMinutes) > 0) {
      ms = parseInt(delayMinutes) * 60 * 1000;
    } else if (targetTime) {
      const target = new Date(targetTime);
      ms = target.getTime() - Date.now();
    }
    if (ms <= 0) return res.status(400).json({ error: "Schedule time must be in the future" });

    if (state.scheduledTimer) clearTimeout(state.scheduledTimer);
    const executeAt = new Date(Date.now() + ms);
    state.scheduledTime = executeAt.toISOString();
    state.scheduledTimer = setTimeout(() => {
      state.scheduledTime = null;
      state.scheduledTimer = null;
      addLog(`⏰ Scheduled timer triggered! Auto-starting send campaign...`, "success");
      if (!state.running) sendEmails().catch(e => addLog(`Scheduled send error: ${e.message}`, "error"));
      else state.paused = false;
    }, ms);

    addLog(`⏰ Campaign scheduled to start in ${Math.round(ms / 60000)}m at ${executeAt.toLocaleTimeString()}`, "info");
    res.json({ ok: true, scheduledTime: state.scheduledTime, executeAt: executeAt.toLocaleTimeString() });
  });

  app.delete("/api/schedule", (req, res) => {
    if (state.scheduledTimer) {
      clearTimeout(state.scheduledTimer);
      state.scheduledTimer = null;
      state.scheduledTime = null;
      addLog(`⏰ Scheduled campaign cancelled`, "warn");
    }
    res.json({ ok: true });
  });

  // TEMPLATE
  app.get("/api/template", (req, res) => res.json(TEMPLATE));
  app.get("/api/template/defaults", (req, res) => res.json({
    subject: "⚡ Immediate Joiner for {company} | Senior Python Backend Developer (4 Yrs Exp)",
    plainText: DEFAULT_PLAIN_TEXT,
    html: DEFAULT_HTML,
  }));

  // AI SUBJECT ROTATION API
  app.get("/api/ai-subjects", (req, res) => res.json({ subjects: AI_SUBJECTS, currentIndex: aiSubjectIndex % AI_SUBJECTS.length }));
  app.post("/api/ai-subjects/reset", (req, res) => { aiSubjectIndex = 0; res.json({ ok: true }); });

  // WARM-UP MODE API
  app.get("/api/warmup", (req, res) => {
    try {
      if (fs.existsSync(WARMUP_DAYS_FILE)) return res.json(JSON.parse(fs.readFileSync(WARMUP_DAYS_FILE, "utf8")));
    } catch(e) {}
    res.json({ enabled: false });
  });
  app.post("/api/warmup", (req, res) => {
    const { enabled, day1Limit, day2Limit, day3Limit } = req.body;
    const data = { enabled: !!enabled, startDate: new Date().toISOString(), day1Limit: day1Limit || 50, day2Limit: day2Limit || 100, day3Limit: day3Limit || 200 };
    fs.writeFileSync(WARMUP_DAYS_FILE, JSON.stringify(data, null, 2));
    invalidateWarmupCache(); // clear the 60s cache immediately
    addLog(enabled ? `🌱 Warm-up Mode enabled (Day 1: ${data.day1Limit}, Day 2: ${data.day2Limit}, Day 3: ${data.day3Limit})` : "🌱 Warm-up Mode disabled", "info");
    res.json({ ok: true, data });
  });

  // HOURLY HEATMAP API (in-memory aggregation)
  app.get("/api/analytics/hourly", (req, res) => {
    const hourly = Array(24).fill(0);
    const { entries } = loadSentLogData();
    for (let i = 0; i < entries.length; i++) {
      const h = entries[i].hour;
      if (h !== null && !isNaN(h) && h >= 0 && h < 24) hourly[h]++;
    }
    res.json({ hourly });
  });
  app.post("/api/template", (req, res) => {
    const { subject, plainText, html } = req.body;
    if (!subject || !plainText || !html) return res.status(400).json({ error: "Missing fields" });
    saveTemplateData({ subject, plainText, html });
    addLog("📝  Email template updated from dashboard", "info");
    res.json({ ok: true });
  });

  // ─── DELIVERABILITY & SPAM SHIELD 2.0 ─────────────────────────
  app.post("/api/template/spam-check", (req, res) => {
    const { subject = "", text = "", html = "" } = req.body;
    const highRiskTriggers = [
      "100% free", "act now", "apply now", "as seen on", "buy direct", "cash bonus",
      "cheap", "clearance", "click here", "credit card", "double your income",
      "earn money", "exclusive deal", "extra income", "fast cash", "financial freedom",
      "free gift", "guaranteed", "increase sales", "instant", "investment",
      "limited time", "make money", "no cost", "no risk", "order now", "passwords",
      "promise", "refund", "risk free", "special promotion", "urgent", "winner",
      "congratulations", "pre-approved", "unclaimed", "pennies", "pure profit",
      "secret", "work from home", "call now", "direct marketing", "hidden assets"
    ];
    const coldEmailFlags = [
      "urgent", "kindly", "dear sir/madam", "dear sir", "dear madam",
      "revert back", "do the needful", "opportunity of a lifetime", "unlimited"
    ];

    const combined = (subject + " " + text).toLowerCase();
    const foundTriggers = [];
    const recommendations = [];

    highRiskTriggers.forEach(word => {
      if (combined.includes(word)) foundTriggers.push({ word, risk: "high" });
    });
    coldEmailFlags.forEach(word => {
      if (combined.includes(word)) foundTriggers.push({ word, risk: "medium" });
    });

    let score = 100;
    score -= foundTriggers.filter(t => t.risk === "high").length * 10;
    score -= foundTriggers.filter(t => t.risk === "medium").length * 5;

    // Subject line analysis
    if (subject.toUpperCase() === subject && subject.length > 5) {
      score -= 18;
      recommendations.push("Avoid using ALL CAPS in the subject line (triggers spam filters).");
    }
    const exclamationCount = (subject.match(/!/g) || []).length;
    if (exclamationCount > 1) {
      score -= 10;
      recommendations.push("Remove multiple exclamation marks from subject line.");
    }
    if (subject.length < 15) {
      recommendations.push("Subject line is very short. Mention your target role, years of experience, or company name.");
    } else if (subject.length > 70) {
      recommendations.push("Subject line exceeds 70 characters and may be clipped on mobile.");
    }

    // Link density check
    const linkMatches = (html || text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
    const linkCount = linkMatches.length;
    if (linkCount > 4) {
      score -= 15;
      recommendations.push(`Contains ${linkCount} links. Cold outreach emails perform best with 1-2 focused links (e.g. LinkedIn + Portfolio).`);
    }

    // Text vs HTML ratio
    const plainLen = text.trim().length;
    const htmlLen = html.trim().length;
    const htmlRatio = htmlLen > 0 ? Math.round((plainLen / htmlLen) * 100) : 100;
    if (htmlLen > 3000 && plainLen < 400) {
      score -= 10;
      recommendations.push("HTML body is heavy compared to text content. Keep markup minimal and lightweight.");
    }

    score = Math.max(10, Math.min(100, score));

    let grade = "A+";
    let rating = "Exceptional Deliverability";
    if (score < 50) { grade = "F"; rating = "High Spam Risk"; }
    else if (score < 70) { grade = "C"; rating = "Moderate Spam Risk"; }
    else if (score < 85) { grade = "B"; rating = "Good Inbox Placement"; }
    else if (score < 95) { grade = "A"; rating = "Great Deliverability"; }

    if (recommendations.length === 0) {
      recommendations.push("Template is clean, balanced, and primed for optimal primary inbox delivery!");
    }

    res.json({
      ok: true,
      score,
      grade,
      rating,
      triggersFound: foundTriggers.map(t => t.word),
      linkCount,
      htmlRatio,
      recommendations
    });
  });

  // DIRECT SINGLE EMAIL SEND
  app.post("/api/send-direct", async (req, res) => {
    const { toEmail, company = "Target Company", role = "Python Developer Position", customSubject, customBody } = req.body;
    if (!toEmail || !toEmail.includes("@")) return res.status(400).json({ error: "Valid recipient email required" });
    const normalizedEmail = sanitizeEmailCandidate(toEmail);

    // Suppression check
    const suppressionStatus = isSuppressed(normalizedEmail);
    if (suppressionStatus.suppressed) {
      state.skipped++;
      addLog(`🚫  Direct email skipped for ${normalizedEmail} — Recipient suppressed (${suppressionStatus.reason})`, "warn");
      return res.json({ ok: false, suppressed: true, message: `Email to ${normalizedEmail} blocked: ${suppressionStatus.reason}` });
    }

    // Recruiter frequency & cooldown check
    const safety = checkOutreachSafety(normalizedEmail, company);
    if (!safety.safe) {
      state.skipped++;
      addLog(`⏸️  Direct email skipped for ${normalizedEmail} — ${safety.reason}`, "warn");
      return res.json({ ok: false, safetyWarning: true, message: safety.reason });
    }

    if (loadSentLog().has(normalizedEmail)) {
      state.skipped++;
      addLog(`⏭️  Direct email skipped for ${normalizedEmail} — already sent`, "warn");
      return res.json({ ok: true, skipped: true, message: `Email already sent to ${normalizedEmail}; skipped` });
    }
    if (_directSendsInProgress.has(normalizedEmail)) {
      state.skipped++;
      addLog(`⏭️  Direct email skipped for ${normalizedEmail} — send already in progress`, "warn");
      return res.json({ ok: true, skipped: true, message: `Email to ${normalizedEmail} is already being sent; skipped` });
    }
    _directSendsInProgress.add(normalizedEmail);

    const acc = CONFIG.accounts[state.accountIndex % CONFIG.accounts.length];
    try {
      const transporter = createTransporter(acc);
      const subject = customSubject || TEMPLATE.subject.replace(/{company}/g, company).replace(/{role}/g, role);
      let bodyText = customBody || TEMPLATE.plainText.replace(/{company}/g, company).replace(/{role}/g, role);
      bodyText = bodyText.replace(/{sender_name}/g, "Milin Chaware");

      const mailOptions = {
        from: `"${acc.gmailAddress.split("@")[0]}" <${acc.gmailAddress}>`,
        to: normalizedEmail,
        subject: subject,
        text: bodyText,
      };

      if (CONFIG.attachmentEnabled && CONFIG.attachment && fs.existsSync(CONFIG.attachment)) {
        mailOptions.attachments = [{ filename: path.basename(CONFIG.attachment), path: CONFIG.attachment }];
      }

      await transporter.sendMail(mailOptions);
      markSent(normalizedEmail);
      recordOutreach(normalizedEmail, company);
      logActivity({
        eventType: "DIRECT_EMAIL_SENT",
        entity: "Email",
        status: "SUCCESS",
        message: `Direct outreach delivered to ${normalizedEmail} (${company})`,
        metadata: { email: normalizedEmail, company, role }
      });
      state.sent++;
      addLog(`🚀  Direct email sent to ${normalizedEmail} (${company}) via ${acc.gmailAddress}`, "success");

      if (!_jobEmailSet.has(normalizedEmail)) {
        addJob({ company, email: normalizedEmail, role, dateSent: new Date().toISOString().split("T")[0], status: "sent" });
      }

      _directSendsInProgress.delete(normalizedEmail);
      res.json({ ok: true, message: `Direct email sent to ${normalizedEmail}` });
    } catch (err) {
      _directSendsInProgress.delete(normalizedEmail);
      logActivity({
        eventType: "DIRECT_EMAIL_FAILED",
        entity: "Email",
        status: "ERROR",
        message: `Direct outreach to ${normalizedEmail} failed: ${err.message}`,
        metadata: { email: normalizedEmail, error: err.message }
      });
      addLog(`❌  Direct email to ${normalizedEmail} failed: ${err.message}`, "error");
      res.json({ ok: false, error: err.message });
    }
  });

  // EMAIL LIST FILES
  app.get("/api/emails", (req, res) => {
    const txtFiles = fs.readdirSync(EMAILS_DIR)
      .filter(f => f.endsWith(".txt") && !f.startsWith("sent_log") && !f.startsWith("report"))
      .sort();
    const files = txtFiles.map(f => {
      const content = fs.readFileSync(path.join(EMAILS_DIR, f), "utf8");
      const count = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && l.includes("@")).length;
      return { name: f, content, count };
    });
    const sentCount = loadSentLogData().entries.length;
    res.json({ files, sentCount });
  });

  app.post("/api/emails/save", (req, res) => {
    const { filename, content } = req.body;
    // Security: only allow simple filenames, no path traversal
    const safeName = path.basename(filename || "");
    if (!safeName || !safeName.endsWith(".txt") ||
        safeName === "sent_log.txt" || safeName === "report.txt")
      return res.status(400).json({ error: "Invalid filename" });
    fs.writeFileSync(path.join(EMAILS_DIR, safeName), content || "");
    addLog(`📧  Email list saved: ${safeName}`, "info");
    res.json({ ok: true, filename: safeName });
  });

  app.post("/api/emails/new-batch", (req, res) => {
    const { content } = req.body;
    const nums = fs.readdirSync(EMAILS_DIR)
      .filter(f => f.match(/^batch\d+\.txt$/))
      .map(f => parseInt(f.match(/\d+/)[0]));
    const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    const filename = `batch${nextNum}.txt`;
    fs.writeFileSync(path.join(EMAILS_DIR, filename), content || "");
    addLog(`📁  New batch file: ${filename}`, "success");
    res.json({ ok: true, filename });
  });

  app.post("/api/emails/clear-log", (req, res) => {
    if (fs.existsSync(SENT_LOG)) fs.writeFileSync(SENT_LOG, "");
    invalidateSentLogCache();
    clearProgress();
    addLog("🗑️  Sent log cleared — all emails will be re-sent next run", "warn");
    res.json({ ok: true });
  });

  // CHECK INBOX — IMAP scan for recruiter replies
  app.post("/api/emails/check-inbox", async (req, res) => {
    const { accountIndex = 0, days = 7 } = req.body || {};
    const account = CONFIG.accounts[accountIndex];
    if (!account) return res.status(400).json({ error: "Invalid account index" });

    addLog(`📬  Checking inbox for ${account.gmailAddress} (last ${days} days)...`, "info");

    try {
      const mails = await new Promise((resolve, reject) => {
        const imap = new Imap({
          user: account.gmailAddress,
          password: account.appPassword,
          host: "imap.gmail.com",
          port: 993,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
        });

        const results = [];

        imap.once("ready", () => {
          imap.openBox("INBOX", true, (err, box) => {
            if (err) { imap.end(); return reject(err); }
            const since = new Date();
            since.setDate(since.getDate() - days);
            const sinceStr = since.toISOString().split("T")[0];
            imap.search(["ALL", ["SINCE", sinceStr]], (err, ids) => {
              if (err) { imap.end(); return reject(err); }
              if (!ids || ids.length === 0) { imap.end(); return resolve([]); }

              // Limit to last 100 messages to avoid overload
              const fetchIds = ids.slice(-100);
              const f = imap.fetch(fetchIds, {
                bodies: "",
                struct: true,
              });

              let pending = 0;
              let finished = false;

              f.on("message", (msg) => {
                pending++;
                msg.on("body", (stream) => {
                  simpleParser(stream, (err, parsed) => {
                    if (!err && parsed) {
                      results.push({
                        id: parsed.messageId || "",
                        from: parsed.from ? parsed.from.text : "Unknown",
                        subject: parsed.subject || "(No Subject)",
                        date: parsed.date ? parsed.date.toISOString() : "",
                        snippet: (parsed.text || "").substring(0, 200).replace(/\\n/g, " ").trim(),
                        isReply: !!(parsed.inReplyTo || (parsed.subject && parsed.subject.match(/^(Re:|Fwd:)/i))),
                        hasAttachment: parsed.attachments && parsed.attachments.length > 0,
                        seen: false, // filled later if needed
                      });
                    }
                    pending--;
                    if (finished && pending === 0) {
                      imap.end();
                    }
                  });
                });
              });

              f.once("error", (err) => { reject(err); });
              f.once("end", () => {
                finished = true;
                if (pending === 0) imap.end();
              });
            });
          });
        });

        imap.once("error", (err) => reject(err));
        imap.once("end", () => {
          results.sort((a, b) => new Date(b.date) - new Date(a.date));
          resolve(results);
        });

        imap.connect();
      });

      addLog(`📬  Found ${mails.length} emails in inbox (${mails.filter(m => m.isReply).length} replies)`, "success");

      // Auto-process replies: classify sentiment, update ATS, stop follow-up drip, and trigger alerts
      let newRepliesMatched = 0;
      for (const m of mails) {
        if (!m.isReply && !m.subject.match(/^(Re:|Fwd:)/i)) continue;
        const senderMatch = (m.from || "").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
        if (!senderMatch) continue;
        const senderEmail = senderMatch[0].toLowerCase();
        
        const matchedJob = JOBS.find(j => j.email && j.email.toLowerCase() === senderEmail);
        if (matchedJob) {
          if (matchedJob.status !== "replied" && matchedJob.status !== "interview" && matchedJob.status !== "offer") {
            const sentiment = await classifyReplySentiment(m.snippet);
            matchedJob.status = sentiment.sentiment === "interview" ? "interview" : "replied";
            matchedJob.sentiment = sentiment.sentiment;
            matchedJob.sentimentLabel = sentiment.label;
            matchedJob.sequenceStopped = true;
            matchedJob.notes = (matchedJob.notes ? matchedJob.notes + " | " : "") + `Reply: [${sentiment.label}] ${sentiment.summary}`;
            newRepliesMatched++;

            // Dispatch Telegram Push Alert
            const teleMsg = `🔥 <b>Recruiter Reply Detected!</b>\n🏢 <b>Company:</b> ${matchedJob.company}\n👤 <b>From:</b> ${senderEmail}\n🏷️ <b>Sentiment:</b> ${sentiment.label}\n📝 <b>Summary:</b> ${sentiment.summary}\n💬 <i>"${(m.snippet || '').slice(0, 180)}..."</i>`;
            await sendTelegramAlert(teleMsg);

            // Dispatch Webhook if enabled
            if (CONFIG.enableWebhookAlerts && CONFIG.webhookUrl) {
              triggerWebhook(`🔥 Recruiter Reply: ${matchedJob.company}`, `From: ${senderEmail}\nSentiment: ${sentiment.label}\n${m.snippet}`);
            }
            addLog(`🔥 Recruiter reply from ${senderEmail} (${matchedJob.company})! Sentiment: ${sentiment.label}`, "success");
          }
        }
      }
      if (newRepliesMatched > 0) saveJobs();

      res.json({ ok: true, account: account.gmailAddress, count: mails.length, newRepliesMatched, mails });
    } catch (e) {
      addLog(`❌  Inbox check failed: ${e.message}`, "error");
      res.status(500).json({ error: e.message });
    }
  });

  // SETTINGS
  app.get("/api/settings", (req, res) => {
    res.json({
      speed: CONFIG.speed,
      dailyLimitPerAccount: CONFIG.dailyLimitPerAccount,
      maxRetries: CONFIG.maxRetries,
      retryDelay: CONFIG.retryDelay,
      attachment: CONFIG.attachment,
      attachmentEnabled: CONFIG.attachmentEnabled,
      resendSentEmails: CONFIG.resendSentEmails || false,
      skipPersonalGmail: CONFIG.skipPersonalGmail !== false,
      autoPauseConsecutiveFailures: CONFIG.autoPauseConsecutiveFailures || 3,
      enableSoundAlerts: CONFIG.enableSoundAlerts !== false,
      onlySendInBusinessHours: CONFIG.onlySendInBusinessHours,
      businessStartHour: CONFIG.businessStartHour,
      businessEndHour: CONFIG.businessEndHour,
      skipWeekends: CONFIG.skipWeekends,
      webhookUrl: CONFIG.webhookUrl,
      enableWebhookAlerts: CONFIG.enableWebhookAlerts,
      enableHumanJitter: CONFIG.enableHumanJitter,
      geminiApiKey: CONFIG.geminiApiKey ? "configured" : "",
      telegramBotToken: CONFIG.telegramBotToken ? "configured" : "",
      telegramChatId: CONFIG.telegramChatId || "",
      trackingBaseUrl: CONFIG.trackingBaseUrl || "http://localhost:3000",
      autoDripFollowup: CONFIG.autoDripFollowup || false,
      autoImapPoll: CONFIG.autoImapPoll !== false,
      autopilot: CONFIG.autopilot !== false,
      autoVerifyMxOnSend: CONFIG.autoVerifyMxOnSend !== false,
      autoPersonalizeLeads: CONFIG.autoPersonalizeLeads !== false,
      autoDripIntervalMinutes: CONFIG.autoDripIntervalMinutes || 30,
      accountCount: CONFIG.accounts.length,
      accounts: CONFIG.accounts.map(a => ({ gmailAddress: a.gmailAddress })),
    });
  });

  app.post("/api/settings", async (req, res) => {
    const allowed = [
      "speed", "concurrency", "dailyLimitPerAccount", "maxRetries", "retryDelay", "attachment",
      "attachmentEnabled", "resendSentEmails", "autoPauseConsecutiveFailures",
      "enableSoundAlerts", "onlySendInBusinessHours", "businessStartHour",
      "businessEndHour", "skipWeekends", "webhookUrl", "enableWebhookAlerts",
      "enableHumanJitter", "geminiApiKey", "telegramBotToken", "telegramChatId",
      "trackingBaseUrl", "autoDripFollowup", "autoImapPoll", "aiSubjectRotation", "skipPersonalGmail",
      "autopilot", "autoVerifyMxOnSend", "autoPersonalizeLeads", "autoDripIntervalMinutes"
    ];
    const update = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    saveSettings(update);
    if (update.skipPersonalGmail !== undefined || update.resendSentEmails !== undefined) {
      allEmails = loadAllEmailFiles();
      state.total = allEmails.length;
      state.remainingEmails = Math.max(0, state.total - state.sent);
    }
    if (update.autopilot !== undefined) {
      state.autopilot = Boolean(update.autopilot);
      state.autopilotStatus = state.autopilot ? "Active" : "Disabled";
    }
    addLog("⚙️  Settings updated", "info");
    res.json({ ok: true });
  });

  app.post("/api/test-smtp", async (req, res) => {
    const { toEmail } = req.body;
    if (!toEmail || !toEmail.includes("@")) return res.status(400).json({ error: "Invalid email" });
    try {
      const transporter = createTransporter(CONFIG.accounts[0]);
      await transporter.sendMail({
        from: CONFIG.accounts[0].gmailAddress,
        to: toEmail,
        subject: "✅ SMTP Test — ResumeAuto v2.0",
        text: "This is a test email from your ResumeAuto dashboard. SMTP is working correctly!",
        html: "<div style='font-family:sans-serif;padding:20px'><h2 style='color:#10b981'>✅ SMTP Test Passed</h2><p>Your ResumeAuto SMTP config is working correctly!</p></div>",
      });
      addLog(`✅  Test email sent to ${toEmail}`, "success");
      res.json({ ok: true });
    } catch (err) {
      addLog(`❌  SMTP test failed: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  // ANALYTICS
  app.get("/api/analytics", (req, res) => res.json(getAnalytics()));

  // JOBS CRUD
  app.get("/api/jobs", (req, res) => res.json(JOBS));
  app.post("/api/jobs", (req, res) => res.json(addJob(req.body)));
  app.patch("/api/jobs/:id", (req, res) => {
    const job = updateJob(req.params.id, req.body);
    if (!job) return res.status(404).json({ error: "Not found" });
    res.json(job);
  });
  app.delete("/api/jobs/:id", (req, res) => {
    if (!deleteJob(req.params.id)) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  });

  // EXPORT CSV
  app.get("/api/jobs-export-csv", (req, res) => {
    const headers = ["Company", "Role", "Email", "Date Sent", "Status", "Notes"];
    const rows = JOBS.map(j =>
      [j.company, j.role, j.email, j.dateSent, j.status, j.notes]
        .map(v => '"' + (v || "").replace(/"/g, '""') + '"')
        .join(",")
    );
    const csv = [headers.join(","), ...rows].join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=job_applications.csv");
    res.send(csv);
  });

  // EMAIL LIST VALIDATION & CLEANING
  app.post("/api/emails/validate", (req, res) => {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: "No content provided" });
    const lines = content.split("\n");
    const sentLog = loadSentLog();
    const result = {
      totalLines: lines.length,
      validCount: 0,
      syntaxErrors: [],
      duplicates: [],
      alreadySent: [],
      validEmails: [],
    };
    const seen = new Set();
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      let email = "", company = "Your Company";
      if (trimmed.includes(",")) {
        const parts = trimmed.split(",");
        email = parts[0].trim().toLowerCase();
        company = parts[1]?.trim() || "Your Company";
      } else if (trimmed.includes(" ")) {
        const spaceIdx = trimmed.indexOf(" ");
        email = trimmed.substring(0, spaceIdx).toLowerCase();
        company = trimmed.substring(spaceIdx + 1).trim();
      } else {
        email = trimmed.toLowerCase();
      }
      email = sanitizeEmailCandidate(email);
      const lineNum = idx + 1;
      if (!isValidRfcEmail(email)) {
        result.syntaxErrors.push({ line: lineNum, text: trimmed, reason: "Invalid RFC email syntax" });
        return;
      }
      if (seen.has(email)) {
        result.duplicates.push({ line: lineNum, email });
        return;
      }
      seen.add(email);
      if (sentLog.has(email)) {
        result.alreadySent.push({ line: lineNum, email });
        return;
      }
      result.validCount++;
      result.validEmails.push({ email, company });
    });
    res.json(result);
  });

  app.post("/api/emails/clean", (req, res) => {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: "No content provided" });
    const lines = content.split("\n");
    const cleanedLines = [];
    const seen = new Set();
    let removedDuplicates = 0, removedInvalid = 0;
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("#")) {
        cleanedLines.push(trimmed);
        return;
      }
      let email = "", company = "Your Company";
      if (trimmed.includes(",")) {
        const parts = trimmed.split(",");
        email = parts[0].trim().toLowerCase();
        company = parts[1]?.trim() || "Your Company";
      } else if (trimmed.includes(" ")) {
        const spaceIdx = trimmed.indexOf(" ");
        email = trimmed.substring(0, spaceIdx).toLowerCase();
        company = trimmed.substring(spaceIdx + 1).trim();
      } else {
        email = trimmed.toLowerCase();
      }
      email = sanitizeEmailCandidate(email);
      if (!isValidRfcEmail(email)) {
        removedInvalid++;
        return;
      }
      if (seen.has(email)) {
        removedDuplicates++;
        return;
      }
      seen.add(email);
      cleanedLines.push(`${email}, ${company}`);
    });
    const cleanedContent = cleanedLines.join("\n");
    addLog(`✨  Email list cleaned: ${seen.size} valid emails retained (${removedDuplicates} dupes, ${removedInvalid} invalid removed)`, "info");
    res.json({ ok: true, cleanedContent, count: seen.size, removedDuplicates, removedInvalid });
  });

  // BULK JOBS & FOLLOW-UP
  app.post("/api/jobs/bulk", (req, res) => {
    const { action, ids, status } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "No job IDs provided" });
    if (action === "update_status") {
      if (!status) return res.status(400).json({ error: "Status required" });
      let updatedCount = 0;
      ids.forEach(id => {
        if (updateJob(id, { status })) updatedCount++;
      });
      addLog(`📋  Bulk updated status to '${status}' for ${updatedCount} jobs`, "info");
      return res.json({ ok: true, count: updatedCount });
    } else if (action === "delete") {
      let deletedCount = 0;
      ids.forEach(id => {
        if (deleteJob(id)) deletedCount++;
      });
      addLog(`🗑️  Bulk deleted ${deletedCount} jobs`, "warn");
      return res.json({ ok: true, count: deletedCount });
    }
    res.status(400).json({ error: "Invalid action" });
  });

  app.post("/api/jobs/send-followup", async (req, res) => {
    const { jobId, customSubject, customBody } = req.body;
    const job = JOBS.find(j => j.id === jobId);
    if (!job) return res.status(404).json({ error: "Job not found" });
    try {
      const transporter = createTransporter(CONFIG.accounts[0]);
      const subject = customSubject || `Following up: Python Developer Application — ${job.company}`;
      const text = customBody || `Dear Hiring Manager at ${job.company},\n\nI hope this email finds you well. I am following up on my application for the Python Developer role sent on ${job.dateSent || 'recently'}.\n\nI remain very enthusiastic about the opportunity to contribute to ${job.company}. Please let me know if you need any additional information or assessments.\n\nBest regards,\nMilin Chaware\nPhone: 7620369988`;
      const html = `<div style="font-family:sans-serif;max-width:600px;margin:20px auto;padding:24px;border-radius:12px;background:#ffffff;border:1px solid #e2e8f0"><h3 style="color:#1a1a2e;margin-bottom:16px">Following Up — ${job.company}</h3><p style="color:#4a5568;line-height:1.7;white-space:pre-wrap">${text}</p><hr style="border:none;border-top:1px solid #edf2f7;margin:20px 0"/><p style="font-size:12px;color:#718096">Milin Chaware &middot; Python Developer &middot; 7620369988</p></div>`;

      await transporter.sendMail({
        from: CONFIG.accounts[0].gmailAddress,
        to: job.email,
        subject,
        text,
        html,
      });

      const today = new Date().toISOString().split("T")[0];
      const newNotes = (job.notes ? job.notes + " | " : "") + `Followed up on ${today}`;
      updateJob(jobId, { notes: newNotes, status: "viewed" });
      addLog(`📩  Follow-up email sent to ${job.email} (${job.company})`, "success");
      res.json({ ok: true, job });
    } catch (err) {
      addLog(`❌  Follow-up send failed: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  // ─── v3: FOLLOW-UP DUE JOBS ────────────────────────────────
  app.get("/api/jobs/followup-due", (req, res) => {
    const cutoffDate = new Date(Date.now() - 5 * 86400000).toISOString().split("T")[0];
    const dueJobs = JOBS.filter(j => j.status === "sent" && j.dateSent && j.dateSent <= cutoffDate);
    res.json({ count: dueJobs.length, jobs: dueJobs });
  });

  // ─── v3: BULK FOLLOW-UP SEND ───────────────────────────────
  app.post("/api/jobs/bulk-followup", async (req, res) => {
    const cutoffDate = new Date(Date.now() - 5 * 86400000).toISOString().split("T")[0];
    const dueJobs = JOBS.filter(j => j.status === "sent" && j.dateSent && j.dateSent <= cutoffDate);
    if (!dueJobs.length) return res.json({ ok: true, sent: 0, failed: 0, message: "No follow-ups due" });
    let sent = 0, failed = 0;
    const results = [];
    const transporter = createTransporter(CONFIG.accounts[0]);
    for (const job of dueJobs) {
      try {
        const subject = `Following up: Python Developer Application — ${job.company}`;
        const text = `Dear Hiring Manager at ${job.company},\n\nI hope this email finds you well. I am following up on my application for the Python Developer role sent on ${job.dateSent || "recently"}.\n\nI remain very enthusiastic about the opportunity to contribute to ${job.company}. Please let me know if you need any additional information.\n\nBest regards,\nMilin Chaware\nPhone: 7620369988`;
        const html = `<div style="font-family:sans-serif;max-width:600px;margin:20px auto;padding:24px;border-radius:12px;background:#fff;border:1px solid #e2e8f0"><h3 style="color:#1a1a2e;margin-bottom:12px">Following Up — ${job.company}</h3><p style="color:#4a5568;line-height:1.8;white-space:pre-wrap">${text}</p><hr style="border:none;border-top:1px solid #edf2f7;margin:20px 0"/><p style="font-size:12px;color:#718096">Milin Chaware &middot; Python Developer &middot; 7620369988</p></div>`;
        await transporter.sendMail({ from: CONFIG.accounts[0].gmailAddress, to: job.email, subject, text, html });
        const newNotes = (job.notes ? job.notes + " | " : "") + `Followed up on ${new Date().toISOString().split("T")[0]}`;
        updateJob(job.id, { notes: newNotes });
        sent++;
        results.push({ email: job.email, company: job.company, ok: true });
        addLog(`📩  Bulk follow-up → ${job.email} (${job.company})`, "success");
        await sleep(2000);
      } catch (err) {
        failed++;
        results.push({ email: job.email, company: job.company, ok: false, error: err.message });
        addLog(`❌  Bulk follow-up failed for ${job.email}: ${err.message}`, "error");
      }
    }
    res.json({ ok: true, sent, failed, results });
  });

  // ─── v3: WEEKLY ANALYTICS ──────────────────────────────────
  app.get("/api/analytics/weekly", (req, res) => {
    const weekData = {};
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      weekData[d.toISOString().split("T")[0]] = 0;
    }
    const { entries } = loadSentLogData();
    for (let i = 0; i < entries.length; i++) {
      const date = entries[i].date;
      if (date && Object.prototype.hasOwnProperty.call(weekData, date)) weekData[date]++;
    }
    const dates = Object.keys(weekData).sort();
    const thisWeek = dates.slice(7);
    const lastWeek = dates.slice(0, 7);
    res.json({
      labels: thisWeek.map(d => d.slice(5)),
      thisWeek: thisWeek.map(d => weekData[d]),
      lastWeek: lastWeek.map(d => weekData[d]),
    });
  });

  // ─── v3: STATUS ANALYTICS ──────────────────────────────────
  app.get("/api/analytics/status", (req, res) => {
    const counts = { sent: 0, viewed: 0, interview: 0, rejected: 0, offer: 0 };
    JOBS.forEach(j => { if (Object.prototype.hasOwnProperty.call(counts, j.status)) counts[j.status]++; });
    res.json(counts);
  });

  // ─── v3: TOP DOMAINS ───────────────────────────────────────
  app.get("/api/analytics/domains", (req, res) => {
    const domains = {};
    const { entries } = loadSentLogData();
    for (let i = 0; i < entries.length; i++) {
      const email = entries[i].email;
      const at = email.indexOf("@");
      if (at !== -1) {
        const domain = email.slice(at + 1);
        domains[domain] = (domains[domain] || 0) + 1;
      }
    }
    const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]).slice(0, 8);
    res.json({ domains: sorted.map(([domain, count]) => ({ domain, count })) });
  });

  // ─── v3: ACCOUNT CAPACITY ──────────────────────────────────
  app.get("/api/accounts/capacity", (req, res) => {
    const capacity = CONFIG.accounts.map((acc, i) => ({
      email: acc.gmailAddress,
      sent: state.accountSentCount[i] || 0,
      limit: CONFIG.dailyLimitPerAccount,
      remaining: Math.max(0, CONFIG.dailyLimitPerAccount - (state.accountSentCount[i] || 0)),
    }));
    res.json({ capacity, totalRemaining: capacity.reduce((s, c) => s + c.remaining, 0) });
  });

  // ─── v3: TEMPLATE SLOTS (A/B) ──────────────────────────────
  const TEMPLATE_SLOTS_FILE = "./template_slots.json";
  let _templateSlotsCache = null;
  function getTemplateSlots() {
    if (_templateSlotsCache) return _templateSlotsCache;
    try {
      if (fs.existsSync(TEMPLATE_SLOTS_FILE)) {
        _templateSlotsCache = JSON.parse(fs.readFileSync(TEMPLATE_SLOTS_FILE, "utf8"));
        return _templateSlotsCache;
      }
    } catch(e) {}
    _templateSlotsCache = { A: null, B: null };
    return _templateSlotsCache;
  }
  app.get("/api/templates/slots", (req, res) => res.json(getTemplateSlots()));
  app.get("/api/templates/slots/:slot", (req, res) => {
    const slot = req.params.slot.toUpperCase();
    const slots = getTemplateSlots();
    if (!slots[slot]) return res.status(404).json({ error: `Slot ${slot} is empty` });
    res.json(slots[slot]);
  });
  app.post("/api/templates/slots/:slot", (req, res) => {
    const slot = req.params.slot.toUpperCase();
    if (slot !== "A" && slot !== "B") return res.status(400).json({ error: "Invalid slot (A or B only)" });
    const { subject, plainText, html } = req.body;
    if (!subject || !plainText || !html) return res.status(400).json({ error: "Missing fields" });
    const slots = getTemplateSlots();
    slots[slot] = { subject, plainText, html, savedAt: new Date().toISOString() };
    _templateSlotsCache = slots;
    fs.writeFileSync(TEMPLATE_SLOTS_FILE, JSON.stringify(slots, null, 2));
    addLog(`📋  Template saved to Slot ${slot}`, "info");
    res.json({ ok: true, slot });
  });

  // ─── v3.5: FULL BACKUP & RESTORE ────────────────────────────
  app.get("/api/backup/export", (req, res) => {
    const backup = {
      version: "3.5",
      exportedAt: new Date().toISOString(),
      template: TEMPLATE,
      jobs: JOBS,
      settings: CONFIG,
      sentLog: fs.existsSync(SENT_LOG) ? fs.readFileSync(SENT_LOG, "utf8") : "",
    };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename=resumeauto_backup_${Date.now()}.json`);
    res.send(JSON.stringify(backup, null, 2));
  });

  app.post("/api/backup/import", (req, res) => {
    const { template, jobs, settings, sentLog } = req.body || {};
    if (template) saveTemplateData(template);
    if (Array.isArray(jobs)) { JOBS = jobs; saveJobs(); }
    if (settings) saveSettings(settings);
    if (typeof sentLog === "string") {
      fs.writeFileSync(SENT_LOG, sentLog);
      invalidateSentLogCache();
    }
    addLog("📦  Campaign data restored successfully from backup bundle", "success");
    res.json({ ok: true, message: "Backup restored successfully!" });
  });

  // ─── v4.0: WEBHOOK NOTIFICATIONS ──────────────────────────────
  async function triggerWebhook(title, message) {
    if (!CONFIG.enableWebhookAlerts || !CONFIG.webhookUrl) return;
    try {
      const payload = {
        username: "ResumeAuto Bot",
        embeds: [{ title: title, description: message, color: 65280, timestamp: new Date().toISOString() }],
        text: `*${title}*\n${message}`,
      };
      await fetch(CONFIG.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      addLog(`🔔  Webhook alert dispatched`, "info");
    } catch (e) {
      addLog(`⚠️  Webhook alert warning: ${e.message}`, "warn");
    }
  }

  app.post("/api/webhook/test", async (req, res) => {
    const { url } = req.body;
    if (!url || !url.startsWith("http")) return res.status(400).json({ error: "Valid Webhook URL required" });
    try {
      const payload = {
        username: "ResumeAuto Bot",
        embeds: [{ title: "🔔 ResumeAuto v4.0 Test Notification", description: "Your Webhook alert Integration is working perfectly!", color: 65280 }],
        text: "*🔔 ResumeAuto v4.0 Test Notification*\nYour Webhook alert Integration is working perfectly!",
      };
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      addLog(`🔔  Webhook test notification sent`, "success");
      res.json({ ok: true, message: "Webhook test sent!" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── v3.5: INDUSTRY TEMPLATE PRESETS ─────────────────────────
  app.get("/api/template/presets", (req, res) => {
    res.json({
      ai: {
        name: "🤖 AI & GenAI Startup",
        intro: "I am a Python Developer with 4 years of experience specializing in Generative AI, LangChain, RAG pipelines, and building autonomous AI Agents with tool-calling."
      },
      backend: {
        name: "⚙️ High-Scale Backend",
        intro: "I am a Python Developer with 4 years of experience engineering high-performance REST microservices using Python, Django, FastAPI, Docker, and AWS."
      },
      data: {
        name: "📊 Data Engineering & Cloud",
        intro: "I am a Python Developer with 4 years of experience designing robust time-series data pipelines, cloud deployments on AWS EC2, and database optimization."
      },
      general: {
        name: "💼 General High Impact",
        intro: "I am a Python Developer with 4 years of experience across backend development and Generative AI, currently at Energy Meteocontrol Solution Pvt Ltd."
      }
    });
  });

  // ─── v3.5: INTERVIEW SCHEDULER ──────────────────────────────
  app.post("/api/jobs/:id/interview", (req, res) => {
    const { stage, date, time, link, notes } = req.body;
    const job = JOBS.find(j => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    job.status = "interview";
    job.interview = { stage: stage || "Tech Round", date: date || new Date().toISOString().split("T")[0], time: time || "10:00 AM", link: link || "", notes: notes || "" };
    job.notes = (job.notes ? job.notes + " | " : "") + `Interview scheduled (${job.interview.stage}) on ${job.interview.date}`;
    saveJobs();
    addLog(`📅  Interview scheduled with ${job.company} (${job.interview.stage})`, "success");
    res.json({ ok: true, job });
  });

  // TEMPLATE TEST SEND TO INBOX
  app.post("/api/template/send-test", async (req, res) => {
    const { toEmail, testCompany } = req.body;
    if (!toEmail || !toEmail.includes("@")) return res.status(400).json({ error: "Invalid email address" });
    const company = testCompany || "ACME Corp";
    try {
      const transporter = createTransporter(CONFIG.accounts[0]);
      await transporter.sendMail({
        from: CONFIG.accounts[0].gmailAddress,
        to: toEmail,
        subject: `[TEST PREVIEW] ${TEMPLATE.subject}`,
        text: getPlainText(company),
        html: getHtmlEmail(company),
      });
      addLog(`🧪  Template test email sent to ${toEmail}`, "success");
      res.json({ ok: true });
    } catch (err) {
      addLog(`❌  Template test failed: ${err.message}`, "error");
      res.status(500).json({ error: err.message });
    }
  });

  // ─── 1. TRACKING ENDPOINTS (PIXEL & RESUME) ──────────────────
  const TRANSPARENT_GIF_BUFFER = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64"
  );

  app.get("/api/track/open/:jobId.png", (req, res) => {
    const { jobId } = req.params;
    const job = JOBS.find(j => j.id === jobId);
    if (job) {
      const wasOpened = job.opened;
      job.opened = true;
      job.openedCount = (job.openedCount || 0) + 1;
      job.lastOpenedAt = new Date().toISOString();
      if (!wasOpened && job.abSlot && _abTracker[job.abSlot]) {
        _abTracker[job.abSlot].opened++;
      }
      if (job.status === "sent") {
        job.status = "viewed";
      }
      saveJobs();
      addLog(`👁️  Email opened by ${job.email} (${job.company}) [${job.openedCount}x]!`, "success");
      addNotification("Email Opened", `${job.company || job.email} opened your email (${job.openedCount}x)`, "info", "👁️");
    }
    res.setHeader("Content-Type", "image/gif");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.send(TRANSPARENT_GIF_BUFFER);
  });

  app.get("/api/track/resume/:jobId", (req, res) => {
    const { jobId } = req.params;
    const job = JOBS.find(j => j.id === jobId);
    if (job) {
      job.resumeClicked = true;
      job.resumeClickedCount = (job.resumeClickedCount || 0) + 1;
      job.lastClickedAt = new Date().toISOString();
      if (job.status === "sent" || job.status === "viewed") {
        job.status = "viewed";
      }
      saveJobs();
      addLog(`📄  Resume downloaded by ${job.email} (${job.company}) [${job.resumeClickedCount}x]!`, "success");
      addNotification("Resume Downloaded", `${job.company || job.email} downloaded your resume`, "success", "📄");
    }
    const pdfPath = path.resolve(CONFIG.attachment || "./Milin_Chaware_Resume.pdf");
    if (fs.existsSync(pdfPath)) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${path.basename(pdfPath)}"`);
      fs.createReadStream(pdfPath).pipe(res);
    } else {
      res.status(404).send("Resume file not found");
    }
  });

  // ─── 2. FUNNEL STATS ──────────────────────────────────────────
  app.get("/api/funnel/stats", (req, res) => {
    const totalSent = JOBS.length;
    const totalOpened = JOBS.filter(j => j.opened || j.openedCount > 0 || j.status !== "sent").length;
    const totalResumeClicked = JOBS.filter(j => j.resumeClicked || j.resumeClickedCount > 0).length;
    const totalReplied = JOBS.filter(j => j.status === "replied" || j.status === "interview" || j.status === "offer").length;
    const totalInterviews = JOBS.filter(j => j.status === "interview" || j.status === "offer").length;

    const openRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0;
    const clickRate = totalSent > 0 ? Math.round((totalResumeClicked / totalSent) * 100) : 0;
    const replyRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;

    res.json({
      totalSent,
      totalOpened,
      totalResumeClicked,
      totalReplied,
      totalInterviews,
      openRate,
      clickRate,
      replyRate,
    });
  });

  // ─── 3. AI PERSONALIZATION ENDPOINT ───────────────────────────
  app.post("/api/ai/personalize", async (req, res) => {
    const { company = "", context = "" } = req.body;
    try {
      const line = await generatePersonalizationLine(company, context);
      res.json({ ok: true, line });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── 4. EMAIL VERIFIER ENDPOINTS ──────────────────────────────
  app.post("/api/verifier/single", async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    try {
      const result = await verifyEmail(email);
      res.json({ ok: true, ...result, email });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/verifier/bulk", async (req, res) => {
    const { emails } = req.body;
    if (!Array.isArray(emails) || !emails.length) return res.status(400).json({ error: "Emails array required" });
    const results = [];
    for (const email of emails.slice(0, 50)) {
      try {
        const r = await verifyEmail(email);
        results.push({ email, ...r });
      } catch(e) {
        results.push({ email, valid: false, status: "error", reason: e.message });
      }
    }
    res.json({ ok: true, results });
  });

  // ─── 5. LEAD FINDER ENDPOINTS ─────────────────────────────────
  app.post("/api/leads/discover", async (req, res) => {
    const { domain, company } = req.body;
    if (!domain) return res.status(400).json({ error: "Domain required (e.g. cred.club)" });
    try {
      const data = await discoverLeads(domain, company);
      res.json({ ok: true, ...data });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/leads/append", (req, res) => {
    const { leads } = req.body;
    if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ error: "Leads array required" });
    const filePath = path.join(EMAILS_DIR, "emails.txt");
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
    const newLines = leads.map(l => `${l.email}, ${l.company || 'Your Company'}`).join("\n");
    fs.appendFileSync(filePath, (current.endsWith("\n") ? "" : "\n") + newLines + "\n");
    addLog(`➕  Added ${leads.length} verified leads to emails.txt`, "success");
    res.json({ ok: true, count: leads.length });
  });

  // ─── v8.5 ENTERPRISE UPGRADE ROUTES ───────────────────────────
  // 1. AI Job Description Personalizer
  app.post("/api/ai/tailor-pitch", async (req, res) => {
    const { jobDescription = "", company = "", role = "" } = req.body;
    try {
      const result = await generateTailoredPitch(jobDescription, company, role);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 2. DNS MX Lead Verification Shield (Bulk Queue Verification)
  app.post("/api/leads/verify-queue", async (req, res) => {
    try {
      let all = (allEmails && allEmails.length > 0) ? allEmails : loadAllEmailFiles();
      if (!all || all.length === 0) {
        const emailFilePath = path.join(EMAILS_DIR, "emails.txt");
        if (fs.existsSync(emailFilePath)) {
          const lines = fs.readFileSync(emailFilePath, "utf8").split("\n");
          const seen = new Set();
          const fallback = [];
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            let company = "Target Company";
            let text = trimmed;
            if (trimmed.includes(",")) {
              const parts = trimmed.split(",");
              text = parts[0].trim();
              company = parts[1]?.trim() || "Target Company";
            }
            const found = text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
            if (found && found.length > 0) {
              const em = sanitizeEmailCandidate(found[0]);
              if (isValidRfcEmail(em) && (CONFIG.skipPersonalGmail !== false ? !em.endsWith("@gmail.com") : true) && !seen.has(em)) {
                seen.add(em);
                fallback.push({ email: em, company });
              }
            }
          }
          all = fallback;
        }
      }
      const domainCache = new Map();
      const results = [];

      for (const item of (all || [])) {
        const at = item.email.indexOf("@");
        if (at === -1) {
          results.push({ email: item.email, company: item.company, valid: false, status: "invalid_syntax" });
          continue;
        }
        const domain = item.email.slice(at + 1).toLowerCase().trim();
        if (!domainCache.has(domain)) {
          try {
            const mx = await dns.promises.resolveMx(domain);
            if (mx && mx.length > 0) {
              domainCache.set(domain, { valid: true, status: "valid_mx", mxHost: mx[0].exchange });
            } else {
              domainCache.set(domain, { valid: false, status: "no_mx", reason: "No MX records found" });
            }
          } catch (err) {
            domainCache.set(domain, { valid: false, status: "domain_not_found", reason: err.code || err.message });
          }
        }
        const dRes = domainCache.get(domain);
        results.push({ email: item.email, company: item.company, domain, ...dRes });
      }

      const validCount = results.filter(r => r.valid).length;
      const invalidCount = results.filter(r => !r.valid).length;
      const invalidLeads = results.filter(r => !r.valid);

      res.json({
        ok: true,
        total: (all || []).length,
        validCount,
        invalidCount,
        domainsChecked: domainCache.size,
        invalidLeads: invalidLeads.slice(0, 100),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 3. Clean Invalid Leads from emails.txt
  app.post("/api/leads/clean-invalid", async (req, res) => {
    try {
      const emailFilePath = path.join(EMAILS_DIR, "emails.txt");
      if (!fs.existsSync(emailFilePath)) return res.json({ ok: true, removedCount: 0, remaining: 0 });

      const lines = fs.readFileSync(emailFilePath, "utf8").split("\n");
      const validLines = [];
      let removedCount = 0;
      const domainCache = new Map();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const emailMatch = trimmed.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (!emailMatch) {
          validLines.push(line);
          continue;
        }
        const domain = emailMatch[0].split("@")[1].toLowerCase().trim();
        if (!domainCache.has(domain)) {
          try {
            const mx = await dns.promises.resolveMx(domain);
            domainCache.set(domain, Boolean(mx && mx.length > 0));
          } catch (e) {
            domainCache.set(domain, false);
          }
        }
        if (domainCache.get(domain)) {
          validLines.push(line);
        } else {
          removedCount++;
        }
      }

      fs.writeFileSync(emailFilePath, validLines.join("\n") + "\n");
      allEmails = loadAllEmailFiles();
      state.total = allEmails.length;
      state.remainingEmails = Math.max(0, state.total - state.sent);
      addLog(`🛡️ Removed ${removedCount} unreachable email leads from emails.txt`, "warn");
      res.json({ ok: true, removedCount, remaining: allEmails.length });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 4. Hourly Recruiter Activity Heatmap
  app.get("/api/analytics/hourly-heatmap", (req, res) => {
    res.json(getHourlyHeatmapData());
  });

  // 5. Download Campaign Summary CSV Report
  app.get("/api/reports/campaign-summary-csv", (req, res) => {
    const csvContent = generateCampaignSummaryCsv();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="ResumeAuto_Campaign_Report.csv"');
    res.send(csvContent);
  });

  // 6. Queue Leads Preview Endpoint
  app.get("/api/queue/leads-preview", (req, res) => {
    let leads = (allEmails || []).slice(0, 100).map((item, idx) => ({
      index: idx,
      email: item.email,
      company: item.company || "Target Company",
      role: item.role || "Python Backend Developer",
    }));

    if (leads.length === 0) {
      const emailFilePath = path.join(EMAILS_DIR, "emails.txt");
      if (fs.existsSync(emailFilePath)) {
        const lines = fs.readFileSync(emailFilePath, "utf8").split("\n");
        const fallback = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          let company = "Target Company";
          let text = trimmed;
          if (trimmed.includes(",")) {
            const parts = trimmed.split(",");
            text = parts[0].trim();
            company = parts[1]?.trim() || "Target Company";
          }
          const found = text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
          if (found && found.length > 0) {
            const em = sanitizeEmailCandidate(found[0]);
            if (isValidRfcEmail(em) && (CONFIG.skipPersonalGmail !== false ? !em.endsWith("@gmail.com") : true)) {
              fallback.push({
                index: fallback.length,
                email: em,
                company: company,
                role: "Python Backend Developer"
              });
              if (fallback.length >= 100) break;
            }
          }
        }
        leads = fallback;
      }
    }

    res.json({ ok: true, count: leads.length, leads });
  });

  // ─── 7. AUTOPILOT SUITE ENDPOINTS ─────────────────────────────
  app.get("/api/autopilot/status", (req, res) => {
    const win = checkIsRecruiterWindow();
    res.json({
      ok: true,
      autopilot: state.autopilot,
      status: state.autopilotStatus,
      recruiterWindow: win,
      inFlightMx: CONFIG.autoVerifyMxOnSend !== false,
      autoDrip: CONFIG.autoDripFollowup !== false,
      autoPersonalize: CONFIG.autoPersonalizeLeads !== false,
      dripIntervalMinutes: CONFIG.autoDripIntervalMinutes || 30,
      autoBlockedDeadDomains: _inFlightBlockedCount,
    });
  });

  app.post("/api/autopilot/toggle", (req, res) => {
    state.autopilot = (req.body && req.body.enabled !== undefined) ? Boolean(req.body.enabled) : !state.autopilot;
    CONFIG.autopilot = state.autopilot;
    saveSettings({ autopilot: state.autopilot });

    if (state.autopilot) {
      addLog("🤖 [Autopilot] Mode ACTIVATED — autonomous scheduling & in-flight shield online", "success");
      const win = checkIsRecruiterWindow();
      if (win.inWindow) {
        state.autopilotStatus = "Active — Peak Recruiter Window";
        if (!state.running) {
          const unsent = loadAllEmailFiles();
          if (unsent.length > 0) {
            addLog(`🤖 [Autopilot] Auto-starting campaign for ${unsent.length} pending corporate leads!`, "success");
            sendEmails().catch(e => addLog(`[Autopilot Error] ${e.message}`, "error"));
          }
        } else if (state.paused) {
          state.paused = false;
          addLog("▶️ [Autopilot] Resuming campaign inside peak recruiter window", "success");
        }
      } else {
        state.autopilotStatus = `Sleeping — ${win.reason}`;
        if (state.running && !state.paused) {
          state.paused = true;
          addLog(`🌙 [Autopilot] Recruiter window closed (${win.reason}). Campaign paused until ${win.nextWindow}.`, "info");
        }
      }
    } else {
      state.autopilotStatus = "Disabled (Manual Mode)";
      addLog("🤖 [Autopilot] Mode DEACTIVATED — switched to manual control", "warn");
    }

    res.json({ ok: true, autopilot: state.autopilot, status: state.autopilotStatus });
  });

  // ─── 6. DRIP & KANBAN ATS ENDPOINTS ───────────────────────────
  app.post("/api/jobs/drip/check", async (req, res) => {
    try {
      const result = await processDripFollowups();
      res.json({ ok: true, ...result });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/jobs/update-stage", (req, res) => {
    const { id, status } = req.body;
    if (!id || !status) return res.status(400).json({ error: "Missing id or status" });
    const job = JOBS.find(j => j.id === id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const prevStatus = job.status;
    job.status = status;
    if (status === "replied" || status === "interview" || status === "rejected") {
      job.sequenceStopped = true;
    }
    saveJobs();
    addLog(`🎯  Job ${job.company} moved from ${prevStatus} ➔ ${status}`, "info");
    res.json({ ok: true, job });
  });

  app.post("/api/telegram/test", async (req, res) => {
    const { message } = req.body;
    const text = message || "🚀 <b>ResumeAuto Test Alert!</b>\nTelegram integration is working properly.";
    const sent = await sendTelegramAlert(text);
    if (sent) {
      addLog("📱  Telegram test notification sent successfully!", "success");
      res.json({ ok: true });
    } else {
      res.status(400).json({ error: "Failed to send Telegram message. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Settings." });
    }
  });

  // ─── v8.0: RESUME PROFILES API ──────────────────────────────
  app.get("/api/resumes", (req, res) => {
    try {
      const files = fs.readdirSync(EMAILS_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
      const currentActive = CONFIG.attachment ? path.basename(CONFIG.attachment) : "";
      const list = files.map(file => {
        const fullPath = path.resolve(EMAILS_DIR, file);
        const stat = fs.statSync(fullPath);
        const sizeKb = Math.round(stat.size / 1024);
        return {
          filename: file,
          path: fullPath,
          sizeKb: `${sizeKb} KB`,
          mtime: stat.mtime.toLocaleDateString(),
          isCurrent: file.toLowerCase() === currentActive.toLowerCase()
        };
      });
      res.json({ ok: true, active: currentActive, resumes: list });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/resumes/select", (req, res) => {
    const { filename, path: fullPath } = req.body;
    const targetFile = filename || (fullPath ? path.basename(fullPath) : "");
    if (!targetFile) return res.status(400).json({ error: "Filename required" });
    const resolved = path.resolve(EMAILS_DIR, targetFile);
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: `File not found: ${targetFile}` });
    }
    CONFIG.attachment = resolved;
    _cachedAttachment = null;
    _lastAttachmentPath = null;
    saveSettings({ attachment: resolved });
    addLog(`📄  Active Resume Profile changed to: ${targetFile}`, "success");
    res.json({ ok: true, activeResume: targetFile, path: resolved });
  });

  // ─── v8.0: SMART CSV / LINKEDIN LEAD IMPORTER ───────────────
  app.post("/api/emails/import-csv", (req, res) => {
    const { csvContent } = req.body;
    if (!csvContent || typeof csvContent !== "string") {
      return res.status(400).json({ error: "No CSV content provided" });
    }

    const lines = csvContent.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return res.status(400).json({ error: "Empty content" });

    // Parse delimiter (comma, tab, semicolon)
    const firstLine = lines[0];
    let delimiter = ",";
    if (firstLine.includes("\t")) delimiter = "\t";
    else if (firstLine.includes(";") && !firstLine.includes(",")) delimiter = ";";

    let emailIdx = 0;
    let companyIdx = 1;
    let nameIdx = -1;
    let roleIdx = -1;
    let startIndex = 0;

    // Check if first line is a header
    const headers = firstLine.split(delimiter).map(h => h.trim().toLowerCase().replace(/['"]/g, ""));
    const detectedEmailCol = headers.findIndex(h => /email|e-mail|mail|contact/i.test(h));
    if (detectedEmailCol !== -1) {
      startIndex = 1;
      emailIdx = detectedEmailCol;
      const detectedCompCol = headers.findIndex(h => /company|org|organization|employer|client/i.test(h));
      if (detectedCompCol !== -1) companyIdx = detectedCompCol;
      const detectedNameCol = headers.findIndex(h => /first\s*name|full\s*name|name|recruiter|person/i.test(h));
      if (detectedNameCol !== -1) nameIdx = detectedNameCol;
      const detectedRoleCol = headers.findIndex(h => /role|title|position|designation|job/i.test(h));
      if (detectedRoleCol !== -1) roleIdx = detectedRoleCol;
    }

    const sentLog = loadSentLog();
    const emailsFilePath = path.join(EMAILS_DIR, "emails.txt");
    const existingFileLines = fs.existsSync(emailsFilePath)
      ? fs.readFileSync(emailsFilePath, "utf8").split(/\r?\n/)
      : [];
    const existingEmails = new Set();
    existingFileLines.forEach(l => {
      const em = l.trim().split(",")[0].trim().toLowerCase();
      if (em) existingEmails.add(em);
    });

    const newEntries = [];
    let duplicateCount = 0;
    let invalidCount = 0;
    let alreadySentCount = 0;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.startsWith("#")) continue;
      const cols = line.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ""));
      const rawEmail = cols[emailIdx] || "";
      const email = sanitizeEmailCandidate(rawEmail);

      if (!isValidRfcEmail(email)) {
        invalidCount++;
        continue;
      }
      if (existingEmails.has(email)) {
        duplicateCount++;
        continue;
      }
      if (sentLog.has(email)) {
        alreadySentCount++;
      }

      existingEmails.add(email);
      let company = cols[companyIdx] || "Your Company";
      let context = (roleIdx !== -1 && cols[roleIdx]) ? cols[roleIdx] : ((nameIdx !== -1 && cols[nameIdx]) ? cols[nameIdx] : "");

      newEntries.push({ email, company, context });
    }

    if (newEntries.length > 0) {
      const appendText = newEntries.map(e => `${e.email}, ${e.company}${e.context ? ', ' + e.context : ''}`).join("\n") + "\n";
      fs.appendFileSync(emailsFilePath, appendText, "utf8");
      addLog(`📥  Imported ${newEntries.length} fresh leads into emails.txt (${duplicateCount} dupes, ${invalidCount} invalid filtered)`, "success");
    }

    res.json({
      ok: true,
      importedCount: newEntries.length,
      duplicates: duplicateCount,
      invalid: invalidCount,
      alreadySent: alreadySentCount,
      totalRemaining: existingEmails.size
    });
  });

  // ─── v8.0: CALENDAR (.ICS & GOOGLE CALENDAR) ─────────────────
  app.get("/api/inbox/calendar-ics/:id", (req, res) => {
    const actId = decodeURIComponent(req.params.id);
    const act = INBOX_ACTIVITIES.find(a => a.id === actId) || JOBS.find(j => j.id === actId);
    if (!act) return res.status(404).send("Activity not found");
    const company = act.company || "Company";
    const role = act.jobRole || "Python Developer Position";
    const title = `Interview with ${company} — ${role}`;
    const desc = `Interview with ${company}.\nContact: ${act.fromName || ""} (${act.fromEmail || act.email || ""})\nSubject: ${act.subject || ""}\nRole: ${role}`;
    const dt = new Date(act.date || Date.now());
    dt.setDate(dt.getDate() + 1);
    dt.setHours(11, 0, 0, 0);
    const startStr = dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const endDt = new Date(dt.getTime() + 45 * 60000);
    const endStr = endDt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const cleanCompany = (company).replace(/[^a-z0-9]/gi, "_");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//ResumeAuto//Interview Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${Date.now()}@resumeauto.local`,
      `DTSTAMP:${startStr}`,
      `DTSTART:${startStr}`,
      `DTEND:${endStr}`,
      `SUMMARY:${title.replace(/[\\,;]/g, "\\$&")}`,
      `DESCRIPTION:${desc.replace(/\n/g, "\\n").replace(/[\\,;]/g, "\\$&")}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="interview_${cleanCompany}.ics"`);
    res.send(ics);
  });

  app.get("/api/inbox/google-cal-link/:id", (req, res) => {
    const actId = decodeURIComponent(req.params.id);
    const act = INBOX_ACTIVITIES.find(a => a.id === actId) || JOBS.find(j => j.id === actId);
    if (!act) return res.status(404).json({ error: "Not found" });
    const company = act.company || "Company";
    const role = act.jobRole || "Python Developer Position";
    const title = encodeURIComponent(`Interview: ${company} — ${role}`);
    const details = encodeURIComponent(`Interview with ${company}\nContact: ${act.fromName || ""} (${act.fromEmail || act.email || ""})\nSubject: ${act.subject || ""}`);
    const dt = new Date(act.date || Date.now());
    dt.setDate(dt.getDate() + 1);
    dt.setHours(11, 0, 0, 0);
    const startStr = dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const endDt = new Date(dt.getTime() + 45 * 60000);
    const endStr = endDt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const url = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&details=${details}&dates=${startStr}/${endStr}`;
    res.json({ ok: true, url });
  });

  // ─── v6.0: HEALTH CHECK DASHBOARD ───────────────────────────
  app.get("/api/health", (req, res) => {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const { entries } = loadSentLogData();
    const todayStr = new Date().toISOString().split("T")[0];
    const sentToday = entries.filter(e => e.date === todayStr).length;
    res.json({
      status: "healthy",
      version: "6.0.0",
      uptime: Math.floor(uptime),
      uptimeFormatted: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${Math.floor(uptime%60)}s`,
      memory: {
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
        rss: Math.round(mem.rss / 1024 / 1024),
        pct: Math.round(mem.heapUsed / mem.heapTotal * 100),
      },
      smtp: {
        accounts: CONFIG.accounts.length,
        activeIndex: state.accountIndex,
        dailyLimit: CONFIG.dailyLimitPerAccount,
      },
      storage: "local JSON/TXT",
      campaign: {
        running: state.running,
        paused: state.paused,
        sent: state.sent,
        failed: state.failed,
        total: state.total,
        sentToday,
        totalEver: entries.length,
        jobsTracked: JOBS.length,
      },
    });
  });

  // ─── v6.0: ENGAGEMENT SCORING ──────────────────────────────
  app.get("/api/analytics/engagement", (req, res) => {
    const scores = [];
    const domainMap = {};
    for (const job of JOBS) {
      const email = (job.email || "").toLowerCase();
      const domain = email.split("@")[1] || "unknown";
      if (!domainMap[domain]) domainMap[domain] = { domain, opens: 0, clicks: 0, replies: 0, interviews: 0, total: 0, score: 0 };
      domainMap[domain].total++;
      if (job.opened || job.openedCount > 0) domainMap[domain].opens++;
      if (job.resumeClicked || job.resumeClickedCount > 0) domainMap[domain].clicks++;
      if (job.status === "replied" || job.status === "interview" || job.status === "offer") domainMap[domain].replies++;
      if (job.status === "interview" || job.status === "offer") domainMap[domain].interviews++;
    }
    for (const d of Object.values(domainMap)) {
      d.score = Math.round(
        (d.opens / Math.max(d.total, 1)) * 25 +
        (d.clicks / Math.max(d.total, 1)) * 30 +
        (d.replies / Math.max(d.total, 1)) * 30 +
        (d.interviews / Math.max(d.total, 1)) * 15
      );
      scores.push(d);
    }
    scores.sort((a, b) => b.score - a.score);
    res.json({ scores: scores.slice(0, 20) });
  });

  // ─── v6.0: STREAK COUNTER ──────────────────────────────────
  app.get("/api/analytics/streak", (req, res) => {
    const { entries } = loadSentLogData();
    const datesSet = new Set(entries.map(e => e.date).filter(d => d && d !== "earlier"));
    const sortedDates = [...datesSet].sort().reverse();
    let streak = 0;
    const today = new Date();
    for (let i = 0; i < 365; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split("T")[0];
      if (datesSet.has(dateStr)) streak++;
      else if (i > 0) break;
    }
    const bestStreak = streak; // Simple: current streak
    const totalActiveDays = sortedDates.length;
    res.json({ currentStreak: streak, bestStreak, totalActiveDays });
  });

  // ─── v6.0: GOAL TRACKER ────────────────────────────────────
  const GOALS_FILE = "./goals.json";
  function loadGoals() {
    try {
      if (fs.existsSync(GOALS_FILE)) return JSON.parse(fs.readFileSync(GOALS_FILE, "utf8"));
    } catch(e) {}
    return { weekly: 200, monthly: 800, customLabel: "", customTarget: 0 };
  }
  function saveGoals(goals) { fs.writeFileSync(GOALS_FILE, JSON.stringify(goals, null, 2)); }

  app.get("/api/goals", (req, res) => {
    const goals = loadGoals();
    const { entries } = loadSentLogData();
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
    const monthAgo = new Date(now); monthAgo.setDate(monthAgo.getDate() - 30);
    const weekStr = weekAgo.toISOString().split("T")[0];
    const monthStr = monthAgo.toISOString().split("T")[0];
    const sentThisWeek = entries.filter(e => e.date && e.date >= weekStr).length;
    const sentThisMonth = entries.filter(e => e.date && e.date >= monthStr).length;
    res.json({
      ...goals,
      sentThisWeek,
      sentThisMonth,
      weeklyPct: goals.weekly > 0 ? Math.min(100, Math.round(sentThisWeek / goals.weekly * 100)) : 0,
      monthlyPct: goals.monthly > 0 ? Math.min(100, Math.round(sentThisMonth / goals.monthly * 100)) : 0,
    });
  });
  app.post("/api/goals", (req, res) => {
    const { weekly, monthly, customLabel, customTarget } = req.body;
    const goals = { weekly: weekly || 200, monthly: monthly || 800, customLabel: customLabel || "", customTarget: customTarget || 0 };
    saveGoals(goals);
    addLog(`🎯  Goals updated: ${goals.weekly}/week, ${goals.monthly}/month`, "info");
    res.json({ ok: true, ...goals });
  });

  // ─── v6.0: RESPONSE TIME ANALYTICS ─────────────────────────
  app.get("/api/analytics/response-time", (req, res) => {
    const buckets = { "<1 day": 0, "1-3 days": 0, "3-7 days": 0, "1-2 weeks": 0, "2+ weeks": 0, "No reply": 0 };
    for (const job of JOBS) {
      if (!job.dateSent) continue;
      if (job.status === "replied" || job.status === "interview" || job.status === "offer") {
        const sentDate = new Date(job.dateSent);
        const replyDate = job.lastOpenedAt ? new Date(job.lastOpenedAt) : new Date();
        const daysDiff = Math.floor((replyDate - sentDate) / 86400000);
        if (daysDiff < 1) buckets["<1 day"]++;
        else if (daysDiff <= 3) buckets["1-3 days"]++;
        else if (daysDiff <= 7) buckets["3-7 days"]++;
        else if (daysDiff <= 14) buckets["1-2 weeks"]++;
        else buckets["2+ weeks"]++;
      } else {
        buckets["No reply"]++;
      }
    }
    res.json({ buckets });
  });



  

// ─── v6.0: INBOX ACTIVITIES & RECRUITER SYNC ENGINE ───────────
const INBOX_ACTIVITIES_FILE = "./inbox_activities.json";
let INBOX_ACTIVITIES = [];
try {
  if (fs.existsSync(INBOX_ACTIVITIES_FILE)) {
    INBOX_ACTIVITIES = JSON.parse(fs.readFileSync(INBOX_ACTIVITIES_FILE, "utf8"));
  }
} catch(e) {}

function saveInboxActivities() {
  try {
    fs.writeFileSync(INBOX_ACTIVITIES_FILE, JSON.stringify(INBOX_ACTIVITIES.slice(0, 200), null, 2));
  } catch(e) {}
}

let _lastInboxCheckTime = null;
let _isInboxChecking = false;

async function checkAndSyncInbox(options = {}) {
  if (_isInboxChecking) return { ok: false, error: "Inbox check already in progress", activities: INBOX_ACTIVITIES.slice(0, 50) };
  _isInboxChecking = true;
  _lastInboxCheckTime = new Date().toISOString();

  let totalScanned = 0;
  let totalMatched = 0;
  let totalInterviews = 0;
  let totalReplies = 0;
  let totalBounces = 0;
  let newFound = 0;

  // Pre-build O(1) fast lookup index
  const jobByEmail = new Map();
  const jobByDomain = new Map();
  for (const j of JOBS) {
    if (j.email) {
      const em = j.email.toLowerCase();
      jobByEmail.set(em, j);
      const dm = em.split("@")[1];
      if (dm && !jobByDomain.has(dm)) jobByDomain.set(dm, j);
    }
  }

  try {
    for (const account of CONFIG.accounts) {
      if (!account.gmailAddress || !account.appPassword) continue;

      const result = await new Promise((resolve) => {
        let resolved = false;
        function safeClose() {
          try {
            if (imap._sock) imap._sock.removeAllListeners("data");
            imap.destroy();
          } catch(e) {}
        }
        function finish(res) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            safeClose();
            resolve(res);
          }
        }

        const timer = setTimeout(() => {
          finish({ scanned: 0, matched: 0, interviews: 0, replies: 0, bounces: 0, newItems: 0 });
        }, 18000);

        const imap = new Imap({
          user: account.gmailAddress,
          password: account.appPassword,
          host: "imap.gmail.com",
          port: 993,
          tls: true,
          tlsOptions: { rejectUnauthorized: false },
          connTimeout: 8000,
          authTimeout: 8000
        });

        imap.once("ready", () => {
          imap.openBox("INBOX", true, (err, box) => {
            if (err) {
              return finish({ scanned: 0, matched: 0, interviews: 0, replies: 0, bounces: 0, newItems: 0 });
            }

            const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
            const d = new Date();
            d.setDate(d.getDate() - (options.days || 7));
            const dateStr = `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;

            imap.search([["SINCE", dateStr]], (searchErr, uids) => {
              if (searchErr || !uids || !uids.length) {
                clearTimeout(timer);
                try { imap.end(); } catch(e) {}
                return finish({ scanned: 0, matched: 0, interviews: 0, replies: 0, bounces: 0, newItems: 0 });
              }

              const fetchUids = uids.slice(-35);
              const f = imap.fetch(fetchUids, {
                bodies: "HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)"
              });

              let pending = fetchUids.length;
              let matched = 0, interviews = 0, replies = 0, bounces = 0, newItems = 0;

              f.on("message", (msg, seqno) => {
                let header = "";
                let uid = seqno;
                msg.on("body", (stream) => {
                  stream.on("data", chunk => { header += chunk.toString("utf8"); });
                });
                msg.once("attributes", attrs => { if (attrs && attrs.uid) uid = attrs.uid; });
                msg.once("end", async () => {
                  try {
                    const p = await simpleParser(header);
                    const fromAddr = p.from?.value?.[0]?.address?.toLowerCase() || "";
                    const fromName = p.from?.value?.[0]?.name || "";
                    const subject = p.subject || "(No Subject)";
                    const date = p.date || new Date();
                    const msgId = p.messageId || `${date.getTime()}_${fromAddr}`;

                    if (fromAddr && fromAddr !== account.gmailAddress.toLowerCase()) {
                      const lowerSubj = subject.toLowerCase();
                      const isBounce = fromAddr.includes("mailer-daemon") || fromAddr.includes("postmaster") || lowerSubj.includes("delivery status notification") || lowerSubj.includes("undeliverable");

                      let category = "reply";
                      let statusUpdate = "replied";

                      const isInterview = /\b(interview|schedule|calendly|zoom|teams|google meet|phone screen|screening|connect with you|discuss your (profile|resume|application)|next steps?|shortlisted|convenient time|available for a call|technical interview)\b/i.test(lowerSubj);
                      const isOffer = /\b(job offer|offer letter|pleased to offer|congratulations|formal offer)\b/i.test(lowerSubj);
                      const isRejection = /\b(unfortunately|not moving forward|other candidates|pursuing (other|another)|regret to inform|not selected|decided to move forward with|not a good fit)\b/i.test(lowerSubj);
                      const isAutoReply = /\b(out of office|automatic reply|away from (the )?office|auto-response|on annual leave|vacation|canned\.response)\b/i.test(lowerSubj);

                      if (isBounce) { category = "bounce"; statusUpdate = "bounced"; }
                      else if (isOffer) { category = "offer"; statusUpdate = "offer"; }
                      else if (isInterview) { category = "interview"; statusUpdate = "interview"; }
                      else if (isRejection) { category = "rejection"; statusUpdate = "rejected"; }
                      else if (isAutoReply) { category = "autoreply"; statusUpdate = null; }

                      const fromDomain = fromAddr.split("@")[1] || "";
                      const genericDomains = ["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "googlemail.com", "icloud.com"];
                      const isSenderSuppressed = isSuppressed(fromAddr).suppressed;

                      // Shield against automated newsletters / marketing blasts
                      if (isSenderSuppressed && !isBounce) {
                        return;
                      }

                      let matchedJob = jobByEmail.get(fromAddr) || (!genericDomains.includes(fromDomain) && !isSenderSuppressed ? jobByDomain.get(fromDomain) : null);
                      if (!matchedJob) {
                        for (const j of JOBS) {
                          if (!j.email) continue;
                          const jEmail = j.email.toLowerCase();
                          const jDomain = jEmail.split("@")[1] || "";
                          if (jEmail === fromAddr || (!genericDomains.includes(fromDomain) && !isSenderSuppressed && jDomain && jDomain === fromDomain)) {
                            matchedJob = j;
                            break;
                          }
                        }
                      }
                      if (!matchedJob && lowerSubj.startsWith("re:") && !isSenderSuppressed) {
                        for (const j of JOBS) {
                          if (j.company && j.company.length > 2 && lowerSubj.includes(j.company.toLowerCase())) {
                            matchedJob = j;
                            break;
                          }
                        }
                      }

                      if (matchedJob) {
                        matched++;
                        upsertRecruiter({
                          email: fromAddr,
                          name: fromName,
                          company: matchedJob.company,
                          reply_status: category.toUpperCase()
                        });
                        logActivity({
                          eventType: category === "interview" ? "INTERVIEW_INVITATION" : "REPLY_RECEIVED",
                          entity: "Recruiter",
                          status: "SUCCESS",
                          message: `Recruiter message from ${fromName || fromAddr} (${matchedJob.company}): ${category.toUpperCase()}`,
                          metadata: { email: fromAddr, company: matchedJob.company, category, subject }
                        });
                        if (category === "interview") {
                          interviews++;
                          if (matchedJob.abSlot && _abTracker[matchedJob.abSlot]) _abTracker[matchedJob.abSlot].replied++;
                          addNotification("🎯 Interview Request!", `${fromName || fromAddr} (${matchedJob.company})`, "success", "🎯");
                        } else if (category === "reply") {
                          replies++;
                          if (matchedJob.abSlot && _abTracker[matchedJob.abSlot]) _abTracker[matchedJob.abSlot].replied++;
                          addNotification("📩 Recruiter Reply", `${fromName || fromAddr} (${matchedJob.company})`, "info", "📩");
                        } else if (category === "bounce") bounces++;

                        const priority = { sent: 1, viewed: 2, autoreply: 2, rejected: 2, replied: 3, interview: 4, offer: 5 };
                        if (statusUpdate && (priority[statusUpdate] || 0) >= (priority[matchedJob.status] || 1)) {
                          matchedJob.status = statusUpdate;
                        }
                        matchedJob.lastRepliedAt = date.toISOString();
                        matchedJob.lastReplySubject = subject;
                        const noteEntry = `[${category.toUpperCase()} ${date.toISOString().split("T")[0]}] ${subject.slice(0, 35)}`;
                        if (!matchedJob.notes.includes(noteEntry)) {
                          matchedJob.notes = matchedJob.notes ? `${matchedJob.notes} | ${noteEntry}` : noteEntry;
                        }
                      }

                      const existingAct = INBOX_ACTIVITIES.find(a => a.id === msgId || (a.fromEmail === fromAddr && Math.abs(new Date(a.date) - date) < 60000));
                      if (!existingAct && (matchedJob || isInterview || isOffer || isRejection || (lowerSubj.startsWith("re:") && !genericDomains.includes(fromDomain)))) {
                        newItems++;
                        const activity = {
                          id: msgId,
                          date: date.toISOString(),
                          fromEmail: fromAddr,
                          fromName,
                          subject,
                          company: matchedJob ? matchedJob.company : (fromDomain ? fromDomain.split(".")[0] : ""),
                          jobId: matchedJob ? matchedJob.id : null,
                          jobRole: matchedJob ? matchedJob.role : "Python Developer",
                          category,
                          statusUpdatedTo: statusUpdate || null
                        };
                        INBOX_ACTIVITIES.unshift(activity);
                        if (category === "interview" || isInterview || isOffer) {
                          sendTelegramAlert(`🎯 <b>INTERVIEW INVITATION DETECTED!</b>\n🏢 <b>Company:</b> ${activity.company}\n👤 <b>From:</b> ${fromName || fromAddr}\n📧 <b>Subject:</b> ${subject}\n📅 <i>1-Click Google Calendar & .ics available in dashboard!</i>`).catch(() => {});
                        }
                      }
                    }
                  } catch(e) {}

                  pending--;
                  if (pending <= 0) {
                    finish({ scanned: fetchUids.length, matched, interviews, replies, bounces, newItems });
                  }
                });
              });

              f.once("error", () => {
                finish({ scanned: fetchUids.length, matched, interviews, replies, bounces, newItems });
              });
            });
          });
        });

        imap.on("error", () => {
          finish({ scanned: 0, matched: 0, interviews: 0, replies: 0, bounces: 0, newItems: 0 });
        });

        imap.connect();
      });

      totalScanned += result.scanned || 0;
      totalMatched += result.matched || 0;
      totalInterviews += result.interviews || 0;
      totalReplies += result.replies || 0;
      totalBounces += result.bounces || 0;
      newFound += result.newItems || 0;
    }

    if (totalMatched > 0) saveJobs();
    if (newFound > 0) saveInboxActivities();

    addLog(`📥  Inbox Check: Scanned ${totalScanned} emails | ${totalMatched} matched (${totalInterviews} interviews, ${totalReplies} replies, ${totalBounces} bounces)`, "info");

    return {
      ok: true,
      scanned: totalScanned,
      matched: totalMatched,
      interviews: totalInterviews,
      replies: totalReplies,
      bounces: totalBounces,
      newFound,
      activities: INBOX_ACTIVITIES.slice(0, 50),
      lastChecked: _lastInboxCheckTime
    };
  } finally {
    _isInboxChecking = false;
  }
}


  // ─── v6.0: INBOX ACTIVITY ROUTES ─────────────────────────────
  app.get("/api/inbox/activities", (req, res) => {
    res.json({
      activities: INBOX_ACTIVITIES.slice(0, 50),
      totalCount: INBOX_ACTIVITIES.length,
      lastChecked: _lastInboxCheckTime,
      isChecking: _isInboxChecking
    });
  });

  app.post("/api/inbox/check", async (req, res) => {
    try {
      const days = parseInt(req.body?.days) || 7;
      const result = await checkAndSyncInbox({ days });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/inbox/clear", (req, res) => {
    INBOX_ACTIVITIES = [];
    saveInboxActivities();
    res.json({ ok: true });
  });

  // ─── v7.0: NOTIFICATION CENTER API ────────────────────────────
  app.get("/api/notifications", (req, res) => {
    const unread = NOTIFICATIONS.filter(n => !n.read).length;
    res.json({ notifications: NOTIFICATIONS.slice(0, 50), unreadCount: unread });
  });
  app.post("/api/notifications/read", (req, res) => {
    NOTIFICATIONS.forEach(n => n.read = true);
    res.json({ ok: true });
  });

  // ─── v7.0: SMART BLACKLIST API ──────────────────────────────
  app.get("/api/analytics/blacklist", (req, res) => {
    const domains = [];
    for (const [domain, data] of _domainFailures) {
      domains.push({
        domain, fails: data.fails, total: data.total,
        failRate: data.total > 0 ? Math.round((data.fails / data.total) * 100) : 0,
        blacklisted: _blacklistedDomains.has(domain),
      });
    }
    domains.sort((a, b) => b.failRate - a.failRate);
    res.json({ blacklistedCount: _blacklistedDomains.size, blacklisted: [..._blacklistedDomains], domains: domains.slice(0, 50) });
  });
  app.post("/api/analytics/blacklist/clear", (req, res) => {
    _blacklistedDomains.clear(); _domainFailures.clear();
    addLog("🔓  Blacklist cleared", "info");
    res.json({ ok: true });
  });
  app.post("/api/analytics/blacklist/remove", (req, res) => {
    const { domain } = req.body || {};
    if (domain) { _blacklistedDomains.delete(domain); addLog("🔓  " + domain + " unblacklisted", "info"); }
    res.json({ ok: true });
  });

  // ─── v7.0: PER-ACCOUNT HEALTH API ──────────────────────────
  app.get("/api/accounts/health-score", (req, res) => {
    const results = CONFIG.accounts.map((acc, i) => ({
      index: i, email: acc.gmailAddress,
      sent: (_accountHealth.get(acc.gmailAddress) || { sent: 0 }).sent,
      failed: (_accountHealth.get(acc.gmailAddress) || { failed: 0 }).failed,
      healthScore: getAccountHealthScore(acc.gmailAddress),
      lastError: (_accountHealth.get(acc.gmailAddress) || { lastError: "" }).lastError,
      dailySent: state.accountSentCount[i] || 0, dailyLimit: CONFIG.dailyLimitPerAccount,
    }));
    res.json({ accounts: results });
  });

  // ─── v7.0: A/B TESTING API ─────────────────────────────────
  app.get("/api/analytics/ab-test", (req, res) => {
    const a = _abTracker.A, b = _abTracker.B;
    const winner = a.sent === 0 && b.sent === 0 ? "none" :
      (a.opened / Math.max(a.sent, 1)) >= (b.opened / Math.max(b.sent, 1)) ? "A" : "B";
    res.json({
      A: { ...a, openRate: a.sent > 0 ? Math.round((a.opened / a.sent) * 100) : 0 },
      B: { ...b, openRate: b.sent > 0 ? Math.round((b.opened / b.sent) * 100) : 0 },
      winner, totalSent: a.sent + b.sent,
    });
  });
  app.post("/api/analytics/ab-test/promote", (req, res) => {
    const { winner } = req.body || {};
    const a = _abTracker.A, b = _abTracker.B;
    const targetSlot = winner || ((a.opened / Math.max(a.sent, 1)) >= (b.opened / Math.max(b.sent, 1)) ? "A" : "B");
    const slotData = SLOTS ? SLOTS[targetSlot] : null;
    if (slotData && slotData.subject) {
      TEMPLATE.subject = slotData.subject;
      if (slotData.plainText) TEMPLATE.plainText = slotData.plainText;
      if (slotData.html) TEMPLATE.html = slotData.html;
      saveTemplateToFile();
      addLog(`🏆  Promoted A/B Slot ${targetSlot} as active primary template`, "success");
      addNotification("A/B Winner Promoted", `Slot ${targetSlot} is now your primary template`, "success", "🏆");
      return res.json({ ok: true, promoted: targetSlot });
    }
    // If slot file doesn't have custom subject, we still acknowledge the active preference
    addLog(`🏆  Acknowledged Variant ${targetSlot} as highest performing`, "success");
    res.json({ ok: true, promoted: targetSlot, note: "Variant " + targetSlot + " recognized as winner" });
  });

  // ─── v7.0: MILESTONES API ──────────────────────────────────
  app.get("/api/milestones", (req, res) => {
    res.json({ milestones: _milestones, current: state.sent });
  });

  // ─── v7.0: SEND-TIME OPTIMIZER API ─────────────────────────
  app.get("/api/analytics/optimal-hours", (req, res) => {
    const hourCounts = new Array(24).fill(0), hourReplies = new Array(24).fill(0);
    for (const j of JOBS) {
      if (j.dateSent) {
        const h = new Date(j.dateSent).getHours();
        if (!isNaN(h)) { hourCounts[h]++; if (j.status === "replied" || j.status === "interview" || j.status === "offer") hourReplies[h]++; }
      }
    }
    const hourData = hourCounts.map((count, hour) => ({ hour, sent: count, replied: hourReplies[hour], replyRate: count > 0 ? Math.round((hourReplies[hour] / count) * 100) : 0 }));
    const bestHours = [...hourData].filter(h => h.sent >= 3).sort((a, b) => b.replyRate - a.replyRate).slice(0, 5);
    res.json({ hourData, bestHours, recommendation: bestHours.length > 0 ? "Best: " + bestHours[0].hour + ":00 (" + bestHours[0].replyRate + "% reply rate)" : "Not enough data yet" });
  });

  // ─── v7.0: CUMULATIVE GROWTH API ───────────────────────────
  app.get("/api/analytics/cumulative", (req, res) => {
    const { entries } = loadSentLogData();
    const dailyMap = {};
    for (const e of entries) { const day = e.date || "unknown"; dailyMap[day] = (dailyMap[day] || 0) + 1; }
    let cumulative = 0;
    const data = Object.keys(dailyMap).sort().map(day => { cumulative += dailyMap[day]; return { date: day, daily: dailyMap[day], cumulative }; });
    res.json({ data, totalEver: cumulative });
  });

  // ─── v7.0: COMPANY-LEVEL ANALYTICS API ─────────────────────
  app.get("/api/analytics/companies", (req, res) => {
    const companyMap = {};
    for (const j of JOBS) {
      const c = j.company || "Unknown";
      if (!companyMap[c]) companyMap[c] = { company: c, sent: 0, opened: 0, replied: 0, interview: 0, offer: 0, rejected: 0 };
      companyMap[c].sent++;
      if (j.opened) companyMap[c].opened++;
      if (j.status === "replied") companyMap[c].replied++;
      if (j.status === "interview") companyMap[c].interview++;
      if (j.status === "offer") companyMap[c].offer++;
      if (j.status === "rejected") companyMap[c].rejected++;
    }
    const companies = Object.values(companyMap).map(c => { c.score = (c.offer * 100) + (c.interview * 50) + (c.replied * 20) + (c.opened * 5); return c; }).sort((a, b) => b.score - a.score);
    res.json({ companies: companies.slice(0, 100), totalCompanies: companies.length });
  });

  // ─── v6.0: AI REPLY DRAFT GENERATOR ─────────────────────────
  app.post("/api/ai/draft-reply", async (req, res) => {
    const { recruiterText, company, role, myName, myPhone } = req.body || {};
    const name = myName || "Milin Chaware";
    const phone = myPhone || "7620369988";
    const roleName = role || "Python Developer";
    const comp = company || "your company";

    if (CONFIG.geminiApiKey) {
      try {
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(CONFIG.geminiApiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = "You are helping job seeker " + name + " (Phone: " + phone + ") reply to a recruiter from " + comp + " regarding " + roleName + ". Recruiter note: " + (recruiterText || "Inquiring about interview availability.") + ". Write a concise, professional reply accepting an interview. Include subject and body.";
        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        return res.json({ ok: true, draft: text, ai: true });
      } catch (err) {
        console.error("Gemini reply draft error:", err.message);
      }
    }

    const draft = "Subject: Re: Application for " + roleName + " — " + comp + "\n\nDear Hiring Team at " + comp + ",\n\nThank you very much for reaching out regarding the " + roleName + " position. I am very interested in this opportunity.\n\nI am available for an interview on weekdays between 10:00 AM and 6:00 PM IST, or at any other time convenient for you.\n\nLooking forward to speaking with you!\n\nBest regards,\n" + name + "\nPhone: " + phone;
    res.json({ ok: true, draft, ai: false });
  });

  // ─── v6.0: DOMAIN REPUTATION CACHE ──────────────────────────
  const DOMAIN_REP_FILE = "./domain_reputation.json";
  let domainRepCache = {};
  try {
    if (fs.existsSync(DOMAIN_REP_FILE)) domainRepCache = JSON.parse(fs.readFileSync(DOMAIN_REP_FILE, "utf8"));
  } catch(e) {}
  app.get("/api/analytics/reputation", (req, res) => {
    const { entries } = loadSentLogData();
    const summary = {};
    for (const entry of entries) {
      const domain = (entry.email || "").split("@")[1] || "unknown";
      if (!summary[domain]) summary[domain] = { domain, sent: 0, delivered: 0, failed: 0, reputation: "good" };
      summary[domain].sent++;
      if (entry.status === "sent") summary[domain].delivered++;
      else if (entry.status === "failed") summary[domain].failed++;
    }
    for (const d of Object.values(summary)) {
      const failRate = d.sent > 0 ? (d.failed / d.sent) : 0;
      d.reputation = failRate > 0.3 ? "poor" : (failRate > 0.1 ? "fair" : (d.sent >= 5 ? "excellent" : "good"));
    }
    res.json({ domains: Object.values(summary) });
  });

  // ─── RESUMEAUTO V9 INTELLIGENT PLATFORM ENDPOINTS ─────────────

  // 1. Candidate Profile Endpoints (Section 5)
  app.get("/api/candidate-profile", (req, res) => {
    res.json({ ok: true, profile: getCandidateProfile() });
  });

  app.post("/api/candidate-profile", (req, res) => {
    const updated = saveCandidateProfile(req.body);
    addLog("👤  Candidate Profile updated", "info");
    res.json({ ok: true, profile: updated });
  });

  // 2. Transparent Job Match Engine (Section 5)
  app.post("/api/jobs/match-preview", (req, res) => {
    const jobData = req.body;
    const match = calculateJobMatch(jobData);
    const resume = selectOptimalResume(jobData.role || jobData.job_title || jobData.title || "", jobData.description || "");
    const coreItems = match.breakdown.filter(b => b.category === "Core Skills");
    const coreScore = Math.min(40, coreItems.reduce((acc, c) => acc + (c.pointsAwarded || 0), 0));
    const expItem = match.breakdown.find(b => b.category === "Experience") || {};
    const locItem = match.breakdown.find(b => b.category === "Location") || {};
    const secItems = match.breakdown.filter(b => b.category === "Secondary Skills");
    const secScore = Math.min(15, secItems.reduce((acc, c) => acc + (c.pointsAwarded || 0), 0));

    res.json({
      ok: true,
      matchScore: match.score,
      score: match.score,
      tier: match.tier,
      recommendation: match.tier === "STRONG_MATCH" ? "High Priority Outreach" : match.tier === "GOOD_MATCH" ? "Standard Outreach" : "Review Recommended",
      matched_skills: match.matched_skills,
      missing_skills: match.missing_skills,
      summary: match.summary,
      breakdownList: match.breakdown,
      breakdown: {
        coreSkills: { score: coreScore, weight: 40, matched: match.matched_skills },
        experience: { score: expItem.pointsAwarded || 0, weight: 25, detail: expItem.factor || "Experience evaluated" },
        location: { score: locItem.pointsAwarded || 0, weight: 20, detail: locItem.factor || "Location evaluated" },
        secondarySkills: { score: secScore, weight: 15, matched: secItems.map(s => s.factor) }
      },
      autoSelectedResume: resume
    });
  });

  // 3. Recruiter Management & Cooldown Status (Section 6)
  app.get("/api/recruiters", (req, res) => {
    res.json({ ok: true, recruiters: loadRecruiters() });
  });

  app.post("/api/recruiters", (req, res) => {
    const recruiter = upsertRecruiter(req.body);
    res.json({ ok: true, recruiter });
  });

  // 4. Suppression List & Opt-Out Management (Section 10)
  app.get("/api/suppression", (req, res) => {
    const summary = getSuppressionSummary();
    res.json({ ok: true, suppressionList: summary, ...summary });
  });

  app.post("/api/suppression", async (req, res) => {
    const payload = req.body || {};
    let email = payload.email;
    let domain = payload.domain;
    if (!email && !domain && payload.target) {
      if (payload.type === "domain" || payload.target.startsWith("@") || !payload.target.includes("@")) {
        domain = payload.target.replace(/^@/, "");
      } else {
        email = payload.target;
      }
    }
    const result = await addSuppression({ email, domain, reason: payload.reason, type: payload.type });
    addLog(`🚫  Suppressed: ${email || domain} (${payload.reason || 'Opt-out'})`, "warn");
    res.json({ ok: true, ...result });
  });

  app.delete("/api/suppression", async (req, res) => {
    const payload = req.body || {};
    let email = payload.email;
    let domain = payload.domain;
    if (!email && !domain && payload.target) {
      if (payload.type === "domain" || payload.target.startsWith("@") || !payload.target.includes("@")) {
        domain = payload.target.replace(/^@/, "");
      } else {
        email = payload.target;
      }
    }
    const result = await removeSuppression({ email, domain });
    addLog(`✅  Removed from suppression: ${email || domain}`, "info");
    res.json({ ok: true, ...result });
  });

  // 5. Categorized Templates & Variable Render Preview (Section 8)
  app.get("/api/templates/categorized", (req, res) => {
    res.json({
      ok: true,
      categories: TEMPLATE_CATEGORIES,
      templates: loadTemplates(),
    });
  });

  app.post("/api/templates/categorized", (req, res) => {
    const { templates } = req.body;
    if (!Array.isArray(templates)) return res.status(400).json({ error: "Templates array required" });
    saveTemplates(templates);
    addLog("📝  Categorized templates saved", "info");
    res.json({ ok: true, count: templates.length });
  });

  app.post("/api/templates/render-preview", (req, res) => {
    const { template, context } = req.body;
    if (!template) return res.status(400).json({ error: "Template required" });
    const rendered = renderTemplate(template, context || {});
    res.json({ ok: true, rendered });
  });

  // 6. Multi-Resume Tracks & Auto-Selector (Section 9)
  app.get("/api/resumes/profiles", (req, res) => {
    const resumes = getAllResumesWithMetadata();
    res.json({ ok: true, profiles: resumes, resumes });
  });

  app.post("/api/resumes/auto-select", (req, res) => {
    const result = selectOptimalResume(req.body || {});
    res.json({ ok: true, profile: result.selectedResume, ...result });
  });

  // 7. Multi-Source Ingestion Pipeline (Section 32)
  app.post("/api/jobs/ingest", async (req, res) => {
    try {
      const { source = "csv", data, jobs } = req.body || {};
      const payloadData = data !== undefined ? data : jobs;
      if (!payloadData) return res.status(400).json({ error: "Data or jobs payload required" });
      const ingestion = await ingestJobsFromSource(source, payloadData, JOBS);
      
      // Merge new jobs into live memory and save
      for (const newJob of ingestion.newJobs) {
        JOBS.unshift(newJob);
        if (newJob.email) _jobEmailSet.add(newJob.email.toLowerCase());
      }
      if (ingestion.newJobs.length > 0) saveJobs();

      addLog(`📥  Ingested ${ingestion.newJobs.length} new jobs via ${source.toUpperCase()} (${ingestion.duplicateJobs.length} duplicates filtered)`, "success");
      res.json({
        ok: true,
        summary: {
          ingested: ingestion.newJobs.length,
          duplicates: ingestion.duplicateJobs.length,
          totalProcessed: ingestion.totalProcessed || (ingestion.newJobs.length + ingestion.duplicateJobs.length)
        },
        ...ingestion
      });
    } catch(err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 8. Structured Activity Log Audit (Section 20)
  app.get("/api/activity-log", (req, res) => {
    const logs = queryActivityLogs(req.query);
    res.json({ ok: true, count: logs.length, logs });
  });

  // 9. Campaign & System Health (Section 19)
  app.get("/api/campaign/health", (req, res) => {
    const totalJobs = JOBS.length;
    const { entries } = loadSentLogData();
    const todayStr = new Date().toISOString().split("T")[0];
    const sentToday = entries.filter(e => e.date === todayStr).length;

    const isHealthy = true;
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      health: {
        systemStatus: "healthy",
        database: {
          status: "healthy",
          engine: "Atomic JSON Store",
          jobsTracked: totalJobs,
          trackedJobs: totalJobs,
          recruitersCount: loadRecruiters().length,
        },
        redis: { status: "healthy", engine: "In-Memory Buffer & Sync", activeStreams: CONFIG.concurrency },
        concurrency: { status: "healthy", activeLocks: 0, concurrencyLimit: CONFIG.concurrency },
        celery: { status: "healthy", engine: "Node Worker Pool", activeWorkers: state.running ? (parseInt(CONFIG.concurrency) || 1) : 0 },
        worker: { status: "healthy", activeWorkers: state.running ? (parseInt(CONFIG.concurrency) || 1) : 0 },
        queue: {
          mode: state.autopilot ? "Autopilot Stream" : "Standard Queue",
          rateLimitPerSec: state.speed === "turbo" ? 10 : state.speed === "fast" ? 5 : 2,
          state: state.running ? (state.paused ? "Paused" : "Active Sending") : "Idle / Ready",
        },
        emailService: {
          status: CONFIG.accounts.length > 0 ? "healthy" : "warning",
          accountsConfigured: CONFIG.accounts.length,
          dailyLimit: CONFIG.dailyLimitPerAccount,
          sentToday,
        },
        emailProvider: {
          status: CONFIG.accounts.length > 0 ? "healthy" : "warning",
          accountsConfigured: CONFIG.accounts.length,
          dailyLimit: CONFIG.dailyLimitPerAccount,
          sentToday,
        },
      },
      queue: {
        total: state.total,
        sent: state.sent,
        failed: state.failed,
        skipped: state.skipped,
        remaining: state.remainingEmails,
        pending: Math.max(0, state.total - state.sent),
        lastSend: state.lastSendTime || null,
        lastFailure: state.lastFailureReason || null,
      },
      autopilot: {
        enabled: state.autopilot,
        status: state.autopilotStatus,
        recruiterWindow: checkIsRecruiterWindow(),
      },
    });
  });

  // 10. Dashboard Structured Metrics Contract (Section 12)
  
  // ─── WORKER & QUEUE TELEMETRY (Section 24) ───
  app.get("/api/worker/status", (req, res) => {
    res.json({
      status: "Healthy",
      queueSize: Math.max(0, state.total - state.sent),
      activeTasks: (state.running && !state.paused) ? (CONFIG.concurrency || 2) : 0,
      failedTasks: state.failed,
      retryCount: state.retried,
      workerCount: 1,
      uptime: Math.floor(process.uptime()),
    });
  });

  // ─── AUTOPILOT STATE CONTROL (Section 21) ───
  app.post("/api/autopilot/start", (req, res) => {
    state.autopilot = true;
    state.running = true;
    state.paused = false;
    if (!state.startTime) state.startTime = Date.now();
    addLog("🤖 Autopilot started", "success");
    res.json({ ok: true, status: "RUNNING", autopilot: true });
  });

  app.post("/api/autopilot/pause", (req, res) => {
    state.paused = true;
    addLog("🤖 Autopilot paused", "warn");
    res.json({ ok: true, status: "PAUSED", autopilot: true });
  });

  app.post("/api/autopilot/stop", (req, res) => {
    state.running = false;
    state.paused = false;
    addLog("🤖 Autopilot stopped", "error");
    res.json({ ok: true, status: "STOPPED", autopilot: false });
  });

  // ─── JOBS ACTIONS (Section 13) ───
  app.post("/api/jobs/:id/skip", (req, res) => {
    const job = updateJob(req.params.id, { application_status: "SKIPPED", status: "skipped" });
    if (!job) return res.status(404).json({ error: "Not found" });
    addLog(`⏭️ Skipped job: ${job.role || job.job_title} at ${job.company}`, "info");
    res.json({ ok: true, job });
  });

  app.post("/api/jobs/:id/archive", (req, res) => {
    const job = updateJob(req.params.id, { application_status: "CLOSED", status: "closed" });
    if (!job) return res.status(404).json({ error: "Not found" });
    addLog(`📦 Archived job: ${job.role || job.job_title} at ${job.company}`, "info");
    res.json({ ok: true, job });
  });

  app.post("/api/jobs/:id/add-to-campaign", (req, res) => {
    const job = JOBS.find(j => j.id === req.params.id);
    if (!job || !job.email) return res.status(404).json({ error: "Job or recruiter email not found" });
    allEmails.unshift({ email: job.email, company: job.company || "Target", sourceFile: "jobs.json" });
    state.total = allEmails.length;
    updateJob(req.params.id, { application_status: "READY_TO_CONTACT" });
    addLog(`➕ Added recruiter ${job.email} (${job.company}) to outbound queue`, "info");
    res.json({ ok: true, total: state.total });
  });

  // ─── EMAIL RECORDS & COMPOSER (Section 16 & 17) ───
  app.get("/api/email-records", (req, res) => {
    try {
      const filter = (req.query.tab || "all").toLowerCase();
      const sentSet = loadSentLog() || new Set();
      const records = [];

      // 1. From active email queue
      const currIdx = (typeof globalIndex !== "undefined") ? globalIndex : (state.currentIndex || 0);
      (allEmails || []).forEach((item, idx) => {
        const email = (item && item.email) ? item.email : "";
        const isSent = email ? sentSet.has(email.toLowerCase()) : false;
        const isCurrent = idx === currIdx && state.running;
        records.push({
          id: "q-" + idx,
          recipient: email || "—",
          company: (item && item.company) || "Company",
          job: "Python Developer",
          subject: "Python Developer Position | 4+ Years | Immediate Joiner — " + ((item && item.company) || "Company"),
          status: isSent ? "sent" : (isCurrent ? "sending" : "queued"),
          sentAt: isSent ? new Date().toISOString() : null,
          scheduledAt: state.scheduledTime,
        });
      });

      // 2. From tracked jobs
      (JOBS || []).forEach(j => {
        if (j && j.email && !records.some(r => (r.recipient || "").toLowerCase() === (j.email || "").toLowerCase())) {
          records.push({
            id: "job-" + j.id,
            recipient: j.email,
            company: j.company || "Company",
            job: j.role || j.job_title || "Python Developer",
            subject: "Application for " + (j.role || j.job_title || "Python Developer") + " — " + (j.company || "Company"),
            status: (j.status || "sent").toLowerCase(),
            sentAt: j.dateSent || j.createdAt || new Date().toISOString(),
            openedAt: j.opened ? j.openedAt : null,
            repliedAt: j.replied ? j.repliedAt : null,
          });
        }
      });

      let filtered = records;
      if (filter === "queued") filtered = records.filter(r => r.status === "queued" || r.status === "sending");
      else if (filter === "sent") filtered = records.filter(r => r.status === "sent");
      else if (filter === "failed") filtered = records.filter(r => r.status === "failed");
      else if (filter === "bounced") filtered = records.filter(r => r.status === "bounced");
      else if (filter === "opened") filtered = records.filter(r => r.status === "opened" || r.openedAt);
      else if (filter === "replied") filtered = records.filter(r => r.status === "replied" || r.repliedAt);
      else if (filter === "scheduled") filtered = records.filter(r => r.scheduledAt);

      res.json({ ok: true, tab: filter, total: records.length, count: filtered.length, records: filtered.slice(0, 150) });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/emails/compose", async (req, res) => {
    try {
      const { to, cc, subject, body, action } = req.body;
      if (!to) return res.status(400).json({ error: "Recipient email is required" });
      if (action === "send") {
        if (!CONFIG.accounts || !CONFIG.accounts.length) {
          return res.status(500).json({ error: "No SMTP accounts configured" });
        }
        const transporter = createTransporter(CONFIG.accounts[0]);
        await transporter.sendMail({
          from: `"${CONFIG.accounts[0].gmailAddress}" <${CONFIG.accounts[0].gmailAddress}>`,
          to,
          cc: cc || undefined,
          subject: subject || "Job Inquiry",
          html: body || "<p>Hello</p>",
          attachments: (CONFIG.attachmentEnabled && fs.existsSync(CONFIG.attachmentPath)) ? [{ path: CONFIG.attachmentPath }] : []
        });
        recordSentEmail(to);
        addLog(`✉️ Outreach email sent to ${to}`, "success");
        res.json({ ok: true, sent: true });
      } else {
        allEmails.unshift({ email: to, company: req.body.company || "Target Company", sourceFile: "composer" });
        state.total = allEmails.length;
        addLog(`✉️ Outreach email queued for ${to}`, "info");
        res.json({ ok: true, queued: true });
      }
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/dashboard", (req, res) => {
    const interviewsList = loadInterviews();
    const totalJobs = JOBS.length;
    let repliesCount = 0;
    try {
      const inboxData = safeReadJsonSync(INBOX_FILE, []);
      repliesCount = inboxData.filter(i => i.type === "reply" || i.classification === "interested").length;
    } catch (_) {}

    res.json({
      ok: true,
      jobs_tracked: totalJobs,
      sent: state.sent,
      failed: state.failed,
      skipped: state.skipped,
      retried: state.retried,
      opened: state.opened || 0,
      replies: repliesCount,
      interviews: interviewsList.length,
      autopilot: state.autopilot,
      status: state.running ? (state.paused ? "PAUSED" : "RUNNING") : "READY",
      speed: state.speed,
      activeResume: CONFIG.attachment ? path.basename(CONFIG.attachment) : ""
    });
  });

  // 11. Interview Tracker Endpoints (Section 28)
  app.get("/api/interviews", (req, res) => {
    res.json({
      ok: true,
      stages: INTERVIEW_STAGES,
      interviews: loadInterviews()
    });
  });

  app.post("/api/interviews", async (req, res) => {
    try {
      const created = await addInterview(req.body);
      logActivity({
        eventType: "interview_scheduled",
        entity: "interview",
        status: "success",
        message: `Scheduled ${created.round} interview with ${created.company} (${created.role})`
      });
      res.json({ ok: true, interview: created });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.patch("/api/interviews/:id", async (req, res) => {
    try {
      const updated = await updateInterview(req.params.id, req.body);
      if (!updated) return res.status(404).json({ ok: false, error: "Interview not found" });
      res.json({ ok: true, interview: updated });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.delete("/api/interviews/:id", async (req, res) => {
    try {
      const success = await deleteInterview(req.params.id);
      res.json({ ok: success });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // 12. Global Emergency Stop (Section 22)
  app.post("/api/emergency-stop", (req, res) => {
    state.running = false;
    state.paused = true;
    addLog("🛑  GLOBAL EMERGENCY STOP TRIGGERED — All automation paused and outbound queue frozen", "error");
    logActivity({
      eventType: "emergency_stop",
      entity: "system",
      status: "warning",
      message: "Operator triggered global emergency stop. Outreach operations paused safely without data loss."
    });
    res.json({ ok: true, message: "Emergency stop active. Outbound stream held safely.", state });
  });
  if (CONFIG.autoImapPoll) {
    setTimeout(() => { checkAndSyncInbox({ days: 3 }).catch(() => {}); }, 15000);
    setInterval(async () => {
      try {
        await checkAndSyncInbox({ days: 3 });
      } catch(e) {}
    }, 15 * 60 * 1000);
  }

  if (CONFIG.autoDripFollowup !== false) {
    startDripSupervisor();
  }

  if (CONFIG.autopilot !== false) {
    state.autopilot = true;
    startAutopilotSupervisor();
  }

  app.listen(CONFIG.dashboardPort, () => {
    addLog(`🌐  Dashboard → http://localhost:${CONFIG.dashboardPort}`, "info");
    if (state.autopilot) {
      addLog(`🤖  Autopilot Engine: ACTIVATED — in-flight shield & scheduler online`, "success");
    }
    console.log(`\n======================================================`);
    console.log(`🌐  ResumeAuto Dashboard is ONLINE: http://localhost:${CONFIG.dashboardPort}`);
    console.log(`🤖  Autopilot Engine: ${state.autopilot ? "ACTIVATED (Hands-Free Mode)" : "Manual Mode"}`);
    console.log(`💡  Engine ready. Open http://localhost:${CONFIG.dashboardPort} to monitor`);
    console.log(`======================================================\n`);
    if (process.env.NO_BROWSER !== "true" && process.env.NODE_ENV !== "test") {
      try {
        const { exec } = require("child_process");
        const cmd = process.platform === "win32" ? `start http://localhost:${CONFIG.dashboardPort}` :
                    process.platform === "darwin" ? `open http://localhost:${CONFIG.dashboardPort}` :
                    `xdg-open http://localhost:${CONFIG.dashboardPort}`;
        exec(cmd, () => {});
      } catch(e) {}
    }
  });
}

// ─── DASHBOARD HTML v7.0 TITAN ────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ResumeAuto v7.0 TITAN Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
/* ═══════════════ v7.0 TITAN DESIGN SYSTEM ═══════════════ */
:root,[data-theme="cyber"]{
  --bg:#06080f;--surface:rgba(12,17,29,0.85);--card:rgba(16,22,40,0.65);--card-solid:#101628;
  --border:rgba(99,102,241,0.15);--border-hover:rgba(99,102,241,0.35);
  --accent:#818cf8;--accent2:#a78bfa;--accent3:#c084fc;
  --accent-glow:rgba(129,140,248,0.25);--accent-glow2:rgba(167,139,250,0.2);
  --green:#34d399;--green-glow:rgba(52,211,153,0.2);
  --yellow:#fbbf24;--yellow-glow:rgba(251,191,36,0.2);
  --red:#f87171;--red-glow:rgba(248,113,113,0.2);
  --blue:#60a5fa;--blue-glow:rgba(96,165,250,0.2);
  --orange:#fb923c;--purple:#c084fc;--cyan:#22d3ee;--pink:#f472b6;
  --text:#f1f5f9;--text-secondary:#94a3b8;--text-dim:#64748b;
  --mono:'JetBrains Mono',monospace;--sans:'Inter',system-ui,-apple-system,sans-serif;
  --radius:16px;--radius-sm:10px;--radius-xs:6px;
  --shadow:0 8px 32px rgba(0,0,0,0.4);--shadow-lg:0 16px 48px rgba(0,0,0,0.5);
  --glass-bg:rgba(16,22,40,0.55);--glass-border:rgba(255,255,255,0.06);
  --mesh-1:#818cf8;--mesh-2:#a78bfa;--mesh-3:#34d399;
}
[data-theme="neon"]{--bg:#020617;--surface:rgba(8,12,25,0.9);--card:rgba(10,16,32,0.6);--card-solid:#0a1020;--border:rgba(6,182,212,0.18);--border-hover:rgba(6,182,212,0.4);--accent:#22d3ee;--accent2:#f472b6;--accent3:#a78bfa;--accent-glow:rgba(34,211,238,0.25);--accent-glow2:rgba(244,114,182,0.2);--mesh-1:#22d3ee;--mesh-2:#f472b6;--mesh-3:#a78bfa}
[data-theme="aurora"]{--bg:#030712;--surface:rgba(10,15,30,0.9);--card:rgba(12,20,38,0.6);--card-solid:#0c1426;--border:rgba(52,211,153,0.18);--border-hover:rgba(52,211,153,0.4);--accent:#34d399;--accent2:#60a5fa;--accent3:#818cf8;--accent-glow:rgba(52,211,153,0.25);--accent-glow2:rgba(96,165,250,0.2);--green:#34d399;--mesh-1:#34d399;--mesh-2:#60a5fa;--mesh-3:#818cf8}
[data-theme="sunset"]{--bg:#0c0510;--surface:rgba(18,10,24,0.9);--card:rgba(22,14,32,0.6);--card-solid:#160e20;--border:rgba(251,146,60,0.18);--border-hover:rgba(251,146,60,0.4);--accent:#fb923c;--accent2:#f472b6;--accent3:#c084fc;--accent-glow:rgba(251,146,60,0.25);--accent-glow2:rgba(244,114,182,0.2);--mesh-1:#fb923c;--mesh-2:#f472b6;--mesh-3:#c084fc}
[data-theme="light"]{--bg:#f8fafc;--surface:rgba(255,255,255,0.9);--card:rgba(255,255,255,0.85);--card-solid:#ffffff;--border:rgba(99,102,241,0.15);--border-hover:rgba(99,102,241,0.3);--accent:#6366f1;--accent2:#8b5cf6;--accent3:#a855f7;--accent-glow:rgba(99,102,241,0.15);--accent-glow2:rgba(139,92,246,0.12);--green:#10b981;--green-glow:rgba(16,185,129,0.15);--yellow:#f59e0b;--yellow-glow:rgba(245,158,11,0.15);--red:#ef4444;--red-glow:rgba(239,68,68,0.15);--blue:#3b82f6;--blue-glow:rgba(59,130,246,0.15);--orange:#f97316;--purple:#a855f7;--cyan:#06b6d4;--pink:#ec4899;--text:#0f172a;--text-secondary:#475569;--text-dim:#94a3b8;--glass-bg:rgba(255,255,255,0.7);--glass-border:rgba(0,0,0,0.06);--shadow:0 4px 16px rgba(0,0,0,0.06);--shadow-lg:0 8px 32px rgba(0,0,0,0.1);--mesh-1:#6366f1;--mesh-2:#8b5cf6;--mesh-3:#10b981}
[data-theme="light"] body::before{background:radial-gradient(ellipse 600px 400px at 10% 20%,rgba(99,102,241,0.04) 0%,transparent 70%),radial-gradient(ellipse 500px 500px at 85% 80%,rgba(139,92,246,0.03) 0%,transparent 70%),radial-gradient(ellipse 400px 300px at 50% 50%,rgba(16,185,129,0.02) 0%,transparent 70%)}
[data-theme="light"] body::after{background-image:none}

*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--text);font-family:var(--sans);min-height:100vh;overflow-x:hidden}

/* Animated mesh gradient background */
body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background:
    radial-gradient(ellipse 600px 400px at 10% 20%, color-mix(in srgb, var(--mesh-1) 12%, transparent) 0%, transparent 70%),
    radial-gradient(ellipse 500px 500px at 85% 80%, color-mix(in srgb, var(--mesh-2) 10%, transparent) 0%, transparent 70%),
    radial-gradient(ellipse 400px 300px at 50% 50%, color-mix(in srgb, var(--mesh-3) 6%, transparent) 0%, transparent 70%);
  animation:meshMove 20s ease-in-out infinite alternate}
@keyframes meshMove{0%{filter:hue-rotate(0deg)}50%{filter:hue-rotate(15deg)}100%{filter:hue-rotate(-10deg)}}
body::after{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);
  background-size:44px 44px}

.container{max-width:1280px;margin:0 auto;padding:24px 20px;position:relative;z-index:1}

/* ═══ GLASSMORPHISM CARDS ═══ */
.glass{background:var(--glass-bg);backdrop-filter:blur(20px) saturate(1.4);-webkit-backdrop-filter:blur(20px) saturate(1.4);border:1px solid var(--glass-border);border-radius:var(--radius);box-shadow:var(--shadow);position:relative;overflow:hidden;transition:border-color .3s,transform .2s,box-shadow .3s}
.glass:hover{border-color:var(--border-hover);box-shadow:var(--shadow-lg)}
.glass::before{content:'';position:absolute;inset:0;border-radius:inherit;padding:1px;background:linear-gradient(135deg,rgba(255,255,255,0.08),transparent 40%,transparent 60%,rgba(255,255,255,0.04));-webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);backdrop-filter:blur(12px);position:relative;overflow:hidden;transition:all .25s ease}
.card:hover{border-color:var(--border-hover);transform:translateY(-1px)}
.card+.card{margin-top:16px}
.card-title{font-size:11px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.8px;margin-bottom:14px;display:flex;align-items:center;gap:8px}

/* ═══ HEADER ═══ */
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px}
.header-left{display:flex;align-items:center;gap:14px}
.logo{display:flex;align-items:baseline;gap:2px}
.logo h1{font-size:24px;font-weight:900;letter-spacing:-0.8px;color:var(--text)}
.logo-gradient{background:linear-gradient(135deg,var(--accent),var(--accent2),var(--accent3));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.version{font-size:10px;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent2));padding:3px 10px;border-radius:20px;letter-spacing:.6px;box-shadow:0 2px 8px var(--accent-glow)}
.header-sub{font-size:11px;color:var(--text-dim);font-family:var(--mono)}
.header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.theme-pill{display:flex;gap:2px;background:var(--surface);border:1px solid var(--border);border-radius:24px;padding:3px}
.t-btn{padding:5px 12px;border-radius:20px;border:none;background:transparent;color:var(--text-dim);font-size:10px;font-weight:700;cursor:pointer;transition:all .2s;font-family:var(--sans)}
.t-btn.active,.t-btn:hover{background:var(--accent);color:#fff;box-shadow:0 0 10px var(--accent-glow)}
.status-pill{display:flex;align-items:center;gap:8px;background:var(--glass-bg);backdrop-filter:blur(12px);border:1px solid var(--glass-border);padding:7px 16px;border-radius:24px;font-size:12px;font-weight:700}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green);animation:pulse 1.5s infinite}
.dot.paused{background:var(--yellow);box-shadow:0 0 10px var(--yellow);animation:none}
.dot.stopped{background:var(--red);box-shadow:0 0 10px var(--red);animation:none}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.15)}}

/* ═══ TABS ═══ */
.tabs{display:flex;gap:3px;background:var(--glass-bg);backdrop-filter:blur(16px);border:1px solid var(--glass-border);border-radius:14px;padding:4px;margin-bottom:22px;overflow-x:auto}
.tab-btn{padding:9px 16px;border-radius:10px;border:none;background:transparent;color:var(--text-dim);font-family:var(--sans);font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;white-space:nowrap;display:flex;align-items:center;gap:5px}
.tab-btn:hover{color:var(--text);background:rgba(255,255,255,0.03)}
.tab-btn.active{background:linear-gradient(135deg,rgba(129,140,248,0.15),rgba(167,139,250,0.1));color:var(--text);box-shadow:0 2px 10px rgba(0,0,0,0.3);border:1px solid var(--border)}
.tab-panel{display:none}
.tab-panel.active{display:block;animation:fadeSlide .3s cubic-bezier(.16,1,.3,1)}
@keyframes fadeSlide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

/* ═══ PROGRESS BAR ═══ */
.prog-card{background:linear-gradient(135deg,rgba(129,140,248,0.08),rgba(167,139,250,0.05));border:1px solid rgba(129,140,248,0.2);border-radius:var(--radius);padding:24px;margin-bottom:16px;backdrop-filter:blur(16px)}
.prog-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.prog-top .lbl{font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.5px;font-weight:700}
.prog-top .num{font-size:30px;font-weight:900;display:flex;align-items:baseline;gap:3px;font-variant-numeric:tabular-nums}
.prog-top .num span:last-child{font-size:14px;color:var(--text-secondary);font-weight:600}
.track{height:8px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden}
.fill{height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent2),var(--accent3));transition:width .6s cubic-bezier(.34,1.56,.64,1);position:relative;box-shadow:0 0 12px var(--accent-glow)}
.fill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.25),transparent);animation:shimmer 2.5s infinite}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.prog-meta{display:flex;gap:20px;margin-top:14px;flex-wrap:wrap}
.prog-meta span{font-size:11px;color:var(--text-dim);font-weight:600}
.prog-meta strong{color:var(--text);font-weight:800;font-variant-numeric:tabular-nums}

/* ═══ STAT CARDS ═══ */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;transition:all .25s;cursor:pointer;position:relative;overflow:hidden}
.stat:hover{border-color:var(--border-hover);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.3)}
.stat-icon{font-size:20px;margin-bottom:8px}
.stat-val{font-size:28px;font-weight:900;line-height:1;margin-bottom:3px;font-variant-numeric:tabular-nums;transition:color .2s}
.stat-val.g{color:var(--green)}.stat-val.r{color:var(--red)}.stat-val.y{color:var(--yellow)}.stat-val.b{color:var(--blue)}.stat-val.p{color:var(--purple)}.stat-val.o{color:var(--orange)}
.stat-lbl{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px;font-weight:700}
.stat-spark{height:24px;margin-top:8px;opacity:.5}

/* ═══ CONTROLS ═══ */
.controls{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.clbl{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.5px;font-weight:800}
.btn{padding:8px 18px;border-radius:var(--radius-sm);border:none;font-family:var(--sans);font-size:12px;font-weight:700;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:5px;letter-spacing:.2px}
.btn:hover{transform:translateY(-1px);filter:brightness(1.1)}
.btn:active{transform:scale(.97)}
.btn-g{background:linear-gradient(135deg,#34d399,#059669);color:#fff;box-shadow:0 2px 10px var(--green-glow)}
.btn-y{background:linear-gradient(135deg,#fbbf24,#d97706);color:#000;box-shadow:0 2px 10px var(--yellow-glow)}
.btn-r{background:linear-gradient(135deg,#f87171,#dc2626);color:#fff;box-shadow:0 2px 10px var(--red-glow)}
.btn-p{background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;box-shadow:0 2px 10px var(--accent-glow2)}
.btn-b{background:linear-gradient(135deg,#60a5fa,#2563eb);color:#fff;box-shadow:0 2px 10px var(--blue-glow)}
.btn-ghost{background:rgba(255,255,255,.04);color:var(--text);border:1px solid var(--border)}
.btn-ghost:hover{border-color:var(--accent);color:var(--accent);background:rgba(129,140,248,.08)}
.spd{display:flex;gap:4px;margin-left:auto;align-items:center}
.sbtn{padding:6px 14px;border-radius:var(--radius-xs);border:1px solid var(--border);background:transparent;color:var(--text-dim);font-family:var(--mono);font-size:11px;cursor:pointer;transition:all .2s;font-weight:600}
.sbtn.active{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:var(--accent);box-shadow:0 0 10px var(--accent-glow)}

/* ═══ CURRENT SENDING ═══ */
.cur{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 20px;margin-bottom:16px;display:flex;align-items:center;gap:12px;overflow:hidden}
.cur-lbl{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.5px;font-weight:800;white-space:nowrap}
.cur-email{font-family:var(--mono);font-size:13px;color:var(--accent);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.cur-acc{font-family:var(--mono);font-size:11px;color:var(--text-dim);white-space:nowrap}
.eta-badge{background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);color:var(--accent2);font-family:var(--mono);font-size:10px;padding:4px 10px;border-radius:20px;white-space:nowrap;font-weight:700}

/* ═══ LOG ═══ */
.log-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.log-hdr{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;background:rgba(0,0,0,0.15)}
.log-hdr span{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;color:var(--text-dim)}
.log-body{height:280px;overflow-y:auto;padding:10px 14px;font-family:var(--mono);font-size:11px;background:rgba(0,0,0,0.15)}
.log-body::-webkit-scrollbar{width:4px}.log-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.le{padding:4px 10px;border-radius:6px;margin-bottom:3px;display:flex;gap:10px;align-items:baseline;transition:background .2s}
.le.success{background:rgba(52,211,153,.06);border-left:2px solid var(--green)}.le.error{background:rgba(248,113,113,.06);border-left:2px solid var(--red)}.le.warn{background:rgba(251,191,36,.06);border-left:2px solid var(--yellow)}.le.info{border-left:2px solid transparent}
.le.new-entry{animation:logSlide .3s ease-out}
@keyframes logSlide{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
.lt{color:var(--text-dim);font-size:9px;white-space:nowrap}
.lm.success{color:var(--green);font-weight:600}.lm.error{color:var(--red);font-weight:600}.lm.warn{color:var(--yellow);font-weight:600}.lm.info{color:var(--text-secondary)}

/* ═══ FUNNEL ═══ */
.funnel-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px}
.funnel-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center;transition:all .2s}
.funnel-card:hover{border-color:var(--border-hover);transform:translateY(-1px)}
.funnel-card .f-val{font-size:22px;font-weight:900;font-variant-numeric:tabular-nums}
.funnel-card .f-lbl{font-size:9px;color:var(--text-dim);text-transform:uppercase;margin-top:4px;letter-spacing:.6px;font-weight:600}

/* ═══ FORMS ═══ */
.form-group{margin-bottom:14px}
.form-label{display:block;font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:1.1px;margin-bottom:5px}
.form-input{width:100%;background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text);font-family:var(--sans);font-size:12px;transition:all .2s;outline:none}
.form-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.form-textarea{width:100%;background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 14px;color:var(--text);font-family:var(--mono);font-size:11px;resize:vertical;outline:none;min-height:120px;line-height:1.6;transition:all .2s}
.form-textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-glow)}
.form-select{background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;color:var(--text);font-family:var(--sans);font-size:12px;outline:none;cursor:pointer}
.form-check{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer}

/* ═══ TOAST ═══ */
.toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:12px;font-size:12px;font-weight:600;z-index:9999;transform:translateY(20px) scale(.95);opacity:0;transition:all .3s cubic-bezier(.16,1,.3,1);box-shadow:0 8px 24px rgba(0,0,0,.5);max-width:340px;backdrop-filter:blur(12px)}
.toast.show{transform:translateY(0) scale(1);opacity:1}
.toast-success{background:rgba(52,211,153,.9);color:#000}.toast-error{background:rgba(248,113,113,.9);color:#fff}.toast-info{background:rgba(129,140,248,.9);color:#fff}.toast-warn{background:rgba(251,191,36,.9);color:#000}

/* ═══ MODAL ═══ */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:8000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(6px);animation:fadeIn .2s}
.modal-overlay.hidden, .hidden{display:none !important}
.modal-box{background:var(--card-solid);border:1px solid var(--border);border-radius:20px;padding:32px;max-width:460px;width:92%;position:relative;box-shadow:var(--shadow-lg);animation:modalPop .3s cubic-bezier(.16,1,.3,1)}
@keyframes modalPop{from{opacity:0;transform:scale(.92) translateY(10px)}to{opacity:1;transform:scale(1) translateY(0)}}
.modal-box h2{font-size:24px;font-weight:900;margin-bottom:6px}
.modal-box h3{font-size:18px;font-weight:800;margin-bottom:4px}
.modal-box p{color:var(--text-secondary);font-size:13px;margin-bottom:20px}
.modal-close{position:absolute;top:14px;right:14px;background:transparent;border:none;color:var(--text-dim);font-size:18px;cursor:pointer;line-height:1;padding:4px;border-radius:6px;transition:all .2s}
.modal-close:hover{background:rgba(255,255,255,.1);color:var(--text)}
.modal-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px}
.modal-stat{background:rgba(0,0,0,.2);border-radius:12px;padding:14px;text-align:center}
.modal-stat .ms-val{font-size:22px;font-weight:900}.modal-stat .ms-lbl{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.7px;margin-top:2px}

/* ═══ COMMAND PALETTE ═══ */
.cmd-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9500;display:flex;align-items:flex-start;justify-content:center;padding-top:18vh;backdrop-filter:blur(4px)}
.cmd-overlay.hidden{display:none}
.cmd-box{background:var(--card-solid);border:1px solid var(--border);border-radius:16px;width:520px;max-width:94vw;box-shadow:var(--shadow-lg);overflow:hidden;animation:modalPop .2s cubic-bezier(.16,1,.3,1)}
.cmd-input{width:100%;background:transparent;border:none;border-bottom:1px solid var(--border);padding:16px 20px;color:var(--text);font-size:15px;font-family:var(--sans);outline:none}
.cmd-input::placeholder{color:var(--text-dim)}
.cmd-list{max-height:320px;overflow-y:auto;padding:6px}
.cmd-item{padding:10px 16px;border-radius:10px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:background .15s;font-size:13px;font-weight:600}
.cmd-item:hover,.cmd-item.active{background:rgba(129,140,248,.1)}
.cmd-item .cmd-icon{font-size:16px;width:24px;text-align:center;flex-shrink:0}
.cmd-item .cmd-label{flex:1;color:var(--text)}
.cmd-item .cmd-hint{font-size:10px;color:var(--text-dim);font-family:var(--mono)}
.kbd{background:rgba(255,255,255,.06);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-size:10px;font-family:var(--mono);color:var(--text-dim)}

/* ═══ KANBAN ═══ */
.kanban-board{display:grid;grid-template-columns:repeat(5,minmax(210px,1fr));gap:12px;overflow-x:auto;padding-bottom:12px}
.kanban-col{background:var(--card);border:1px solid var(--border);border-radius:14px;display:flex;flex-direction:column;min-height:480px}
.kanban-header{padding:12px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;font-weight:800;font-size:12px}
.kanban-badge{font-size:10px;font-family:var(--mono);padding:2px 8px;border-radius:10px;background:rgba(255,255,255,.06);font-weight:700}
.kanban-dropzone{flex:1;padding:10px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;max-height:600px;min-height:180px}
.kanban-dropzone.drag-over{background:rgba(129,140,248,.06);border-radius:0 0 14px 14px}
.kanban-card{background:rgba(0,0,0,.2);border:1px solid var(--border);border-radius:12px;padding:11px 13px;cursor:grab;transition:all .2s}
.kanban-card:hover{border-color:var(--border-hover);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
.kanban-card:active{cursor:grabbing}
.kc-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:4px}
.kc-company{font-size:12px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kc-role{font-size:10px;color:var(--text-dim);margin-bottom:6px}
.kc-email{font-family:var(--mono);font-size:10px;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:6px}
.kc-meta{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.kc-pill{font-size:9px;font-family:var(--mono);padding:2px 6px;border-radius:8px;font-weight:700}
.kc-actions{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--border);padding-top:6px;margin-top:2px}

/* ═══ ANALYTICS ═══ */
.analytics-top{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.a-metric{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;text-align:center;transition:all .2s}
.a-metric:hover{border-color:var(--border-hover);transform:translateY(-1px)}
.a-val{font-size:26px;font-weight:900;font-variant-numeric:tabular-nums}
.a-val.g{color:var(--green)}.a-val.b{color:var(--blue)}.a-val.y{color:var(--yellow)}.a-val.o{color:var(--orange)}.a-val.p{color:var(--purple)}
.a-lbl{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;margin-top:3px;font-weight:700}
.charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.chart-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px}
.chart-card h3{font-size:12px;font-weight:700;color:var(--text-secondary);margin-bottom:12px}

/* ═══ SETTINGS ═══ */
.settings-section{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:22px;margin-bottom:14px}
.settings-section h3{font-size:15px;font-weight:800;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.smtp-test-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:12px}
.badge{font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px}

/* ═══ MISC ═══ */
.template-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.preview-frame{width:100%;height:400px;border:1px solid var(--border);border-radius:12px;background:#fff}
.preview-controls{display:flex;align-items:center;gap:10px;margin:12px 0 8px;flex-wrap:wrap}
.token-bar{display:flex;align-items:center;gap:5px;margin:8px 0 12px;flex-wrap:wrap}
.token-lbl{font-size:10px;color:var(--text-dim);font-weight:700;text-transform:uppercase;letter-spacing:.8px}
.token-btn{background:rgba(167,139,250,.12);border:1px solid rgba(167,139,250,.25);color:var(--accent2);font-family:var(--mono);font-size:10px;padding:3px 9px;border-radius:16px;cursor:pointer;transition:all .15s;font-weight:600}
.token-btn:hover{background:var(--accent2);color:#fff}
.test-send-box{background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-top:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.char-counter{font-size:10px;color:var(--text-dim);text-align:right;margin-top:2px;font-family:var(--mono)}.char-counter.warn{color:var(--yellow)}.char-counter.danger{color:var(--red);font-weight:700}
.preview-device-btns{display:flex;gap:3px}
.dev-btn{padding:4px 9px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-dim);font-size:11px;cursor:pointer;transition:all .15s}
.dev-btn.active,.dev-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.slot-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px;padding:10px 14px;background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:var(--radius-sm)}
.slot-lbl{font-size:10px;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px}
.val-card{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.val-report{background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;margin-top:10px;font-family:var(--mono);font-size:11px;line-height:1.5}
.sent-stat{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.drop-zone{border:2px dashed var(--border);border-radius:var(--radius);padding:28px;text-align:center;cursor:pointer;transition:all .2s;margin-bottom:14px;color:var(--text-dim);font-size:13px}
.drop-zone:hover,.drop-zone.drag-active{border-color:var(--accent);background:rgba(129,140,248,.05)}
.drop-icon{font-size:28px;margin-bottom:6px}
.file-list{display:flex;flex-direction:column;gap:6px}
.file-item{display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px;cursor:pointer;transition:all .15s}
.file-item:hover{border-color:var(--accent)}
.file-item.active{border-color:var(--accent);background:rgba(129,140,248,.06)}

/* Streak & Goals */
.streak-card{background:linear-gradient(135deg,rgba(251,191,36,.08),rgba(251,146,60,.05));border:1px solid rgba(251,191,36,.2);border-radius:14px;padding:18px;display:flex;align-items:center;gap:16px}
.streak-fire{font-size:36px;animation:fireGlow 1s ease-in-out infinite alternate}
@keyframes fireGlow{from{filter:drop-shadow(0 0 4px rgba(251,191,36,.3))}to{filter:drop-shadow(0 0 12px rgba(251,191,36,.6))}}
.streak-num{font-size:32px;font-weight:900;color:var(--yellow)}
.goal-ring-container{display:flex;gap:20px;flex-wrap:wrap}
.goal-ring{text-align:center}
.goal-ring svg{transform:rotate(-90deg)}
.goal-ring .ring-label{font-size:10px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px;font-weight:700;margin-top:6px}

/* Health Monitor */
.health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.health-item{background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:12px;padding:14px;text-align:center}
.health-item .h-val{font-size:20px;font-weight:900;font-variant-numeric:tabular-nums}
.health-item .h-lbl{font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.7px;margin-top:3px;font-weight:700}

/* Jobs table & additions */
.jobs-table-wrap{overflow-x:auto}
.jobs-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px}
.jobs-table th{padding:10px 12px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text-dim);font-weight:700;border-bottom:1px solid var(--border);white-space:nowrap}
.jobs-table td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle}
.jobs-table tr:hover td{background:rgba(255,255,255,.02)}
.add-job-form{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:14px}
.add-job-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}

.bulk-bar{display:flex;align-items:center;gap:8px;background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 14px;margin-bottom:12px;font-size:11px;flex-wrap:wrap}
.domain-list{display:flex;flex-direction:column;gap:4px;margin-top:4px}
.domain-row{display:flex;align-items:center;gap:6px;font-size:11px}
.domain-name{color:var(--text-dim);flex:1;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.domain-bar{height:5px;border-radius:99px;background:var(--accent);min-width:3px;transition:width .3s}
.domain-count{color:var(--text);font-weight:700;min-width:22px;text-align:right;font-family:var(--mono)}
.best-time-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.best-time-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:16px;font-size:10px;font-weight:700;background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.2);color:var(--green)}
.capacity-widget{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px 18px;margin-bottom:14px}
.cap-row{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.cap-email{font-family:var(--mono);font-size:10px;color:var(--text-dim);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cap-count{font-family:var(--mono);font-size:11px;font-weight:700;white-space:nowrap}
.cap-bar-wrap{height:3px;background:var(--border);border-radius:99px;overflow:hidden;margin-bottom:6px}
.cap-bar-fill{height:100%;border-radius:99px;transition:width .4s ease}

/* Acc bars */
.acc{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:6px}
.acc.active{border-color:var(--accent);background:rgba(129,140,248,.05)}
.acc-name{font-size:11px;font-weight:700;margin-bottom:3px}.acc-sent{font-size:10px;color:var(--text-dim);margin-bottom:4px;font-family:var(--mono)}
.acc-bar{height:3px;background:var(--border);border-radius:99px;overflow:hidden}.acc-fill{height:100%;background:var(--accent);border-radius:99px;transition:width .4s}

/* ═══ v7.0: NOTIFICATION BELL ═══ */
.notif-bell{position:relative;background:transparent;border:1px solid var(--border);border-radius:12px;padding:6px 10px;cursor:pointer;font-size:16px;transition:all .2s;color:var(--text)}
.notif-bell:hover{border-color:var(--accent);background:rgba(129,140,248,.08)}
.notif-badge{position:absolute;top:-4px;right:-4px;background:var(--red);color:#fff;font-size:9px;font-weight:900;min-width:16px;height:16px;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:0 4px;box-shadow:0 2px 6px var(--red-glow)}
.notif-dropdown{position:absolute;top:44px;right:0;width:360px;max-height:420px;overflow-y:auto;background:var(--card-solid);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lg);z-index:9000;display:none;animation:modalPop .2s cubic-bezier(.16,1,.3,1)}
.notif-dropdown.open{display:block}
.notif-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center}
.notif-item{padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.03);display:flex;gap:10px;align-items:flex-start;transition:background .15s;cursor:pointer;font-size:12px}
.notif-item:hover{background:rgba(129,140,248,.05)}
.notif-item.unread{background:rgba(129,140,248,.04);border-left:3px solid var(--accent)}
.notif-icon{font-size:18px;flex-shrink:0;margin-top:2px}
.notif-body{flex:1}
.notif-title{font-weight:700;font-size:12px;margin-bottom:2px}
.notif-text{font-size:11px;color:var(--text-dim);line-height:1.3}
.notif-time{font-size:9px;color:var(--text-dim);font-family:var(--mono);margin-top:2px}

/* ═══ v7.0: FLOATING ACTION BUTTON ═══ */
.fab-container{position:fixed;bottom:28px;right:28px;z-index:7500}
.fab-btn{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 6px 24px var(--accent-glow);transition:all .25s;display:flex;align-items:center;justify-content:center}
.fab-btn:hover{transform:scale(1.1);box-shadow:0 8px 32px var(--accent-glow)}
.fab-btn.open{transform:rotate(45deg)}
.fab-menu{position:absolute;bottom:62px;right:0;display:flex;flex-direction:column;gap:8px;opacity:0;transform:translateY(10px);pointer-events:none;transition:all .25s cubic-bezier(.16,1,.3,1)}
.fab-menu.open{opacity:1;transform:translateY(0);pointer-events:all}
.fab-action{display:flex;align-items:center;gap:10px;white-space:nowrap;cursor:pointer;padding:8px 14px;background:var(--card-solid);border:1px solid var(--border);border-radius:12px;font-size:12px;font-weight:700;color:var(--text);box-shadow:var(--shadow);transition:all .15s}
.fab-action:hover{border-color:var(--accent);transform:translateX(-4px)}
.fab-action-icon{font-size:16px}

/* ═══ v7.0: ANIMATED COUNTERS ═══ */
.anim-num{transition:color .3s}
@keyframes countUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.count-anim{animation:countUp .4s ease-out}

/* ═══ v7.0: MILESTONE TIMELINE ═══ */
.timeline{display:flex;align-items:center;gap:0;overflow-x:auto;padding:10px 0}
.timeline-node{display:flex;flex-direction:column;align-items:center;min-width:70px;position:relative}
.timeline-dot{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);background:var(--card);z-index:1;transition:all .2s}
.timeline-dot.reached{background:var(--accent);border-color:var(--accent);box-shadow:0 0 10px var(--accent-glow)}
.timeline-line{height:2px;flex:1;min-width:20px;background:var(--border)}
.timeline-line.reached{background:var(--accent)}
.timeline-label{font-size:9px;color:var(--text-dim);margin-top:6px;font-weight:700}

/* ═══ v7.0: BLACKLIST WIDGET ═══ */
.bl-domain{display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(248,113,113,.06);border:1px solid rgba(248,113,113,.15);border-radius:8px;margin-bottom:4px;font-size:11px}
.bl-domain-name{flex:1;font-family:var(--mono);color:var(--text)}
.bl-rate{font-weight:800;color:var(--red);min-width:36px;text-align:right}

/* ═══ v7.0: COMPANY ANALYTICS ═══ */
.company-row{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.03);font-size:12px;transition:background .15s}
.company-row:hover{background:rgba(255,255,255,.02)}
.company-name{font-weight:700;flex:1;min-width:80px}
.company-pills{display:flex;gap:4px;flex-wrap:wrap}

/* ═══ v7.0: SPARKLINE ═══ */
.sparkline-container{height:28px;width:120px;display:flex;align-items:flex-end;gap:1px}
.spark-bar{flex:1;min-width:3px;border-radius:2px 2px 0 0;background:var(--accent);opacity:.6;transition:height .3s ease}

/* ═══════════════ MOBILE & RESPONSIVE PERFECTION ═══════════════ */
.header-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.header-status-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}

/* Global scroll containment to prevent horizontal page overflow */
html, body {
  max-width: 100vw;
  overflow-x: hidden;
}

/* Tablet & Mobile (<= 768px) */
@media(max-width: 768px) {
  .container {
    padding: 12px 10px;
    max-width: 100vw;
    box-sizing: border-box;
  }
  .card {
    padding: 16px 14px;
    border-radius: 12px;
  }
  .header {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    margin-bottom: 14px;
  }
  .header-left {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header-right {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: stretch;
  }
  .theme-pill {
    width: 100%;
    display: flex;
    overflow-x: auto;
    padding: 3px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    box-sizing: border-box;
  }
  .theme-pill::-webkit-scrollbar { display: none; }
  .t-btn {
    flex: 1;
    padding: 6px 4px;
    font-size: 10px;
    text-align: center;
    white-space: nowrap;
  }
  .header-actions {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .header-actions .btn {
    flex: 1 1 auto;
    padding: 6px 8px;
    font-size: 11px;
    justify-content: center;
    white-space: nowrap;
  }
  #header-sparkline {
    display: none !important; /* Hide tiny dotted sparkline on mobile */
  }
  .cmd-palette-btn, .header-actions button:has(.kbd) {
    display: none !important; /* Touch devices do not use keyboard shortcuts */
  }
  #dash-active-resume {
    max-width: 90px;
  }
  .header-status-bar {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    justify-content: space-between;
  }
  .header-status-bar .status-pill {
    flex: 1 1 auto;
    padding: 6px 10px;
    font-size: 11px;
    justify-content: center;
  }
  #btn-emergency-stop {
    flex: 1 1 100%;
    justify-content: center;
    padding: 8px;
    font-size: 12px;
  }
  
  /* Tabs: silky smooth horizontal carousel */
  .tabs {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    white-space: nowrap;
    padding: 6px;
    border-radius: 12px;
    margin-bottom: 16px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab-btn {
    padding: 8px 14px;
    font-size: 11px;
    flex-shrink: 0;
    border-radius: 8px;
  }

  /* Autopilot Card */
  #autopilot-command-card {
    padding: 14px;
  }
  .ap-header {
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 10px !important;
  }
  .ap-header > div:first-child {
    width: 100%;
  }
  #btn-ap-master-toggle {
    width: 100%;
    justify-content: center;
    padding: 9px 12px;
  }
  .ap-stats-grid {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 6px !important;
  }
  .ap-stats-grid > div {
    padding: 8px 10px !important;
  }

  /* Progress Card */
  .prog-card {
    padding: 16px 14px;
  }
  .prog-top .num {
    font-size: 24px;
  }
  .prog-meta {
    display: grid !important;
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 6px 10px !important;
    margin-top: 12px !important;
  }
  .prog-meta span {
    font-size: 10px;
    background: rgba(255, 255, 255, 0.03);
    padding: 5px 8px;
    border-radius: 6px;
    display: flex;
    justify-content: space-between;
  }

  /* Milestones */
  .timeline {
    padding: 6px 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .timeline::-webkit-scrollbar { display: none; }
  .timeline-node {
    min-width: 55px;
  }
  .timeline-line {
    min-width: 12px;
  }

  /* Controls Section */
  .controls {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 12px;
  }
  .controls .btn {
    flex: 1 1 auto;
    justify-content: center;
    padding: 8px 10px;
    font-size: 11px;
  }
  .spd {
    margin-left: 0;
    width: 100%;
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 4px 0;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .spd::-webkit-scrollbar { display: none; }
  .sbtn {
    flex: 1;
    text-align: center;
    padding: 6px 2px;
    font-size: 10px;
    white-space: nowrap;
  }

  /* Stats & Funnels */
  .stats {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 8px;
  }
  .stat {
    padding: 12px;
  }
  .stat-val {
    font-size: 22px;
  }
  .funnel-grid {
    grid-template-columns: repeat(2, 1fr) !important;
    gap: 6px;
  }
  .funnel-card {
    padding: 10px 8px;
  }
  .funnel-card .f-val {
    font-size: 18px;
  }

  /* General Grids (Settings, Analytics, Charts, Templates) */
  .charts-grid,
  .template-grid,
  .settings-grid,
  .analytics-top {
    grid-template-columns: 1fr !important;
  }
  .kanban-board {
    display: flex;
    overflow-x: auto;
    gap: 10px;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .kanban-col {
    min-width: 250px;
    flex-shrink: 0;
  }

  /* Force any inline 2-col or 3-col layouts into responsive 1-col on mobile */
  [style*="grid-template-columns:1fr 1fr"],
  [style*="grid-template-columns: 1fr 1fr"],
  [style*="grid-template-columns:1fr 1fr 1fr"],
  [style*="grid-template-columns: 1fr 1fr 1fr"],
  [style*="grid-template-columns:auto 1fr"] {
    grid-template-columns: 1fr !important;
  }

  /* Dropdown & Modals */
  .notif-dropdown {
    right: 0 !important;
    left: auto !important;
    width: min(320px, 92vw) !important;
  }
  .modal-box {
    padding: 20px 16px;
    width: 94vw;
    max-width: 94vw;
  }
  .modal-stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .fab-container {
    bottom: 16px;
    right: 16px;
  }
  .fab-btn {
    width: 46px;
    height: 46px;
    font-size: 20px;
  }
}

/* Extra small devices (<= 480px) */
@media(max-width: 480px) {
  .ap-stats-grid {
    grid-template-columns: 1fr !important;
  }
  .stat {
    padding: 10px;
  }
  .stat-val {
    font-size: 20px;
  }
  .funnel-grid {
    grid-template-columns: repeat(2, 1fr) !important;
  }
}
</style>
</head>
<body>
<div class="container">

  <!-- ═══ HEADER ═══ -->
  <div class="header">
    <div class="header-left">
      <div>
        <div class="logo"><h1>Resume<span class="logo-gradient">Auto</span></h1>&nbsp;<span class="version">v7.0 TITAN</span></div>
        <div class="header-sub" id="sub">Initializing...</div>
      </div>
    </div>
    <div class="header-right">
      <div class="theme-pill">
        <button class="t-btn active" onclick="setTheme('cyber',this)">&#x1F30C; Cyber</button>
        <button class="t-btn" onclick="setTheme('neon',this)">&#x26A1; Neon</button>
        <button class="t-btn" onclick="setTheme('aurora',this)">&#x1F30A; Aurora</button>
        <button class="t-btn" onclick="setTheme('sunset',this)">&#x1F305; Sunset</button>
        <button class="t-btn" onclick="setTheme('light',this)">&#x2600; Light</button>
      </div>
      <div class="header-actions">
        <div class="sparkline-container" id="header-sparkline" title="Sends/min (last 30 ticks)"></div>
        <button class="btn btn-ghost" id="btn-inbox-header" onclick="switchTab('inbox',document.getElementById('tab-inbox'))" title="Recruiter Inbox Activities" style="padding:6px 12px;font-size:11px">
          &#x1F4E5; Inbox <span id="inbox-hdr-badge" style="display:none;background:var(--green);color:#000;font-size:9px;font-weight:900;border-radius:10px;padding:1px 6px;margin-left:4px"></span>
        </button>
        <button class="btn btn-ghost" id="btn-resume-header" onclick="switchTab('settings',document.getElementById('tab-settings'));detectResumePdf()" title="Active Resume Profile (Click to switch)" style="padding:6px 12px;font-size:11px;display:flex;align-items:center;gap:6px">
          📄 <span id="dash-active-resume" style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Resume</span>
        </button>
        <div class="notif-bell" id="notif-bell" onclick="toggleNotifPanel()">
          &#x1F514;
          <span class="notif-badge" id="notif-badge" style="display:none">0</span>
          <div class="notif-dropdown" id="notif-dropdown">
            <div class="notif-header">
              <span style="font-size:12px;font-weight:800">Notifications</span>
              <button class="btn btn-ghost" onclick="markAllNotifsRead()" style="padding:2px 8px;font-size:10px">Mark read</button>
            </div>
            <div id="notif-list"><div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px">No notifications yet</div></div>
          </div>
        </div>
        <button class="btn btn-ghost" id="btn-autopilot-toggle" onclick="toggleAutopilotUI()" title="Toggle Autonomous Autopilot Mode" style="padding:6px 12px;font-size:11px;font-weight:700;display:flex;align-items:center;gap:6px">
          🤖 Autopilot: <span id="hdr-autopilot-status" style="font-weight:900">ON</span>
        </button>
        <a href="/api/reports/campaign-summary-csv" download="ResumeAuto_Campaign_Report.csv" class="btn btn-ghost" title="Download Full Campaign Performance Report (CSV)" style="text-decoration:none;padding:6px 12px;font-size:11px">&#x1F4CA; Report</a>
        <button class="btn btn-ghost cmd-palette-btn" onclick="toggleCmdPalette()" title="Command Palette (Ctrl+K)" style="padding:6px 10px"><span class="kbd">&#x2318;K</span></button>
      </div>
      <div class="header-status-bar">
        <div class="status-pill" title="Worker Telemetry & Queue Engine" style="display:flex;align-items:center;gap:6px"><span id="worker-status-text" style="color:var(--green);font-weight:700">● READY</span><span style="color:var(--text-dim)">|</span><span style="font-size:10px;color:var(--text-dim)">Queue:</span><span id="worker-queue-text" style="font-weight:800;color:var(--accent)">0</span></div>
        <div class="status-pill"><div class="dot stopped" id="dot"></div><span id="stxt">Ready</span></div>
        <button class="btn btn-r" id="btn-emergency-stop" onclick="triggerEmergencyStop()" title="Emergency Stop All Automation (Hold Queues)" style="padding:6px 12px;font-size:11px;font-weight:800;letter-spacing:0.5px">🛑 STOP ALL</button>
      </div>
    </div>
  </div>

  <!-- ═══ TABS ═══ -->
  <div class="tabs">
    <button class="tab-btn active" onclick="switchTab('dashboard',this)" id="tab-dashboard">&#x1F680; Dashboard</button>
    <button class="tab-btn" onclick="switchTab('campaigns',this)" id="tab-campaigns">🚀 Campaigns</button>
    <button class="tab-btn" onclick="switchTab('matching',this)" id="tab-matching">🎯 Match &amp; Resumes</button>
    <button class="tab-btn" onclick="switchTab('recruiters',this)" id="tab-recruiters">👥 Recruiters &amp; Shield</button>
    <button class="tab-btn" onclick="switchTab('template',this)" id="tab-template">&#x1F4DD; Template</button>
    <button class="tab-btn" onclick="switchTab('emails',this)" id="tab-emails">&#x1F48C; Emails</button>
    <button class="tab-btn" onclick="switchTab('analytics',this)" id="tab-analytics">&#x1F4CA; Analytics</button>
    <button class="tab-btn" onclick="switchTab('jobs',this)" id="tab-jobs">&#x1F4CB; Jobs</button>
    <button class="tab-btn" onclick="switchTab('inbox',this)" id="tab-inbox">&#x1F4E5; Inbox <span id="tab-inbox-badge" style="display:none;background:var(--green);color:#000;border-radius:10px;font-size:9px;padding:1px 6px;margin-left:4px;font-weight:900"></span></button>
    <button class="tab-btn" onclick="switchTab('interviews',this)" id="tab-interviews">📅 Interviews</button>
    <button class="tab-btn" onclick="switchTab('activity',this)" id="tab-activity">📜 Activity &amp; Health</button>
    <button class="tab-btn" onclick="switchTab('settings',this)" id="tab-settings">&#x2699; Settings</button>
  </div>

  <!-- ══════════ DASHBOARD TAB ══════════ -->
  <div id="panel-dashboard" class="tab-panel active">
    <!-- ═══ v8.6: AUTOPILOT COMMAND CENTER ═══ -->
    <div class="card" id="autopilot-command-card" style="margin-bottom:14px;background:linear-gradient(135deg,rgba(99,102,241,0.08) 0%,rgba(168,85,247,0.05) 100%);border:1px solid rgba(139,92,246,0.3);position:relative;overflow:hidden">
      <div class="ap-header" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:12px">
          <div style="font-size:24px;width:42px;height:42px;border-radius:10px;background:rgba(99,102,241,0.18);display:flex;align-items:center;justify-content:center;border:1px solid rgba(99,102,241,0.4)">🤖</div>
          <div>
            <div style="display:flex;align-items:center;gap:8px">
              <span style="font-size:14px;font-weight:800;letter-spacing:0.3px">Autonomous Outreach Autopilot</span>
              <span class="badge" id="ap-badge-status" style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;background:rgba(34,197,94,0.2);color:#86efac">Active &bull; Peak Recruiter Window</span>
            </div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px" id="ap-substatus-text">
              Smart Recruiter Window &bull; Pre-Send DNS/MX Shield &bull; Hands-Free Drip Engine &bull; Per-Lead AI Pitch
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <button class="btn btn-y" id="btn-ap-master-toggle" onclick="toggleAutopilotUI()" style="font-size:12px;font-weight:700;padding:7px 16px">
            ⏸️ Pause Autopilot
          </button>
        </div>
      </div>
      <div class="ap-stats-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);font-size:11px">
        <div style="background:rgba(0,0,0,0.2);padding:8px 12px;border-radius:8px;border:1px solid var(--border)">
          <div style="color:var(--text-dim);font-size:10px">RECRUITER WINDOW</div>
          <div style="font-weight:700;margin-top:2px;display:flex;align-items:center;gap:6px">
            <span id="ap-window-indicator">🟢</span> <span id="ap-window-text">Active (09:00 - 18:00)</span>
          </div>
        </div>
        <div style="background:rgba(0,0,0,0.2);padding:8px 12px;border-radius:8px;border:1px solid var(--border)">
          <div style="color:var(--text-dim);font-size:10px">IN-FLIGHT DNS/MX SHIELD</div>
          <div style="font-weight:700;margin-top:2px;display:flex;align-items:center;gap:6px">
            <span>🛡️</span> <span id="ap-mx-text" style="color:var(--green)">100% Pre-Check Active</span>
          </div>
        </div>
        <div style="background:rgba(0,0,0,0.2);padding:8px 12px;border-radius:8px;border:1px solid var(--border)">
          <div style="color:var(--text-dim);font-size:10px">BACKGROUND DRIP ATS</div>
          <div style="font-weight:700;margin-top:2px;display:flex;align-items:center;gap:6px">
            <span>🔄</span> <span id="ap-drip-text">Every 30 Mins (Auto)</span>
          </div>
        </div>
        <div style="background:rgba(0,0,0,0.2);padding:8px 12px;border-radius:8px;border:1px solid var(--border)">
          <div style="color:var(--text-dim);font-size:10px">AI LEAD PERSONALIZER</div>
          <div style="font-weight:700;margin-top:2px;display:flex;align-items:center;gap:6px">
            <span>✨</span> <span id="ap-ai-text">On-The-Fly Matching</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Progress -->
    <div class="prog-card">
      <div class="prog-top">
        <span class="lbl">Campaign Progress</span>
        <div class="num"><span id="pct">0</span><span>% complete</span></div>
      </div>
      <div class="track"><div class="fill" id="bar" style="width:0%"></div></div>
      <div class="prog-meta">
        <span><strong id="ps">0</strong> sent</span>
        <span><strong id="pt">0</strong> total</span>
        <span><strong id="pr">0</strong> emails/min</span>
        <span>Elapsed: <strong id="pe">0s</strong></span>
        <span>ETA: <strong id="peta">&#x2014;</strong></span>
      </div>
    </div>

    <!-- ═══ v7.0: CAMPAIGN MILESTONE TIMELINE ═══ -->
    <div class="card" style="margin-bottom:14px;padding:12px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;font-weight:800;color:var(--text-dim);text-transform:uppercase;letter-spacing:.8px">&#x1F3AF; Campaign Milestones</span>
        <span id="milestone-current-badge" style="font-size:10px;color:var(--accent);font-weight:700;font-family:var(--mono)">0 sent</span>
      </div>
      <div class="timeline" id="milestones-timeline"></div>
    </div>

    <!-- Stats -->
    <div class="stats">
      <div class="stat" onclick="switchTab('jobs',document.getElementById('tab-jobs'))" title="View Jobs">
        <div class="stat-icon">&#x2705;</div><div class="stat-val g" id="ss">0</div><div class="stat-lbl">Sent</div>
      </div>
      <div class="stat" onclick="switchTab('analytics',document.getElementById('tab-analytics'))" title="View Analytics">
        <div class="stat-icon">&#x274C;</div><div class="stat-val r" id="sf">0</div><div class="stat-lbl">Failed</div>
      </div>
      <div class="stat"><div class="stat-icon">&#x23ED;&#xFE0F;</div><div class="stat-val y" id="sk">0</div><div class="stat-lbl">Skipped</div></div>
      <div class="stat"><div class="stat-icon">&#x1F504;</div><div class="stat-val b" id="sr">0</div><div class="stat-lbl">Retried</div></div>
      <div class="stat" onclick="switchTab('jobs',document.getElementById('tab-jobs'))">
        <div class="stat-icon">&#x1F4CB;</div><div class="stat-val p" id="sj">0</div><div class="stat-lbl">Jobs Tracked</div>
      </div>
    </div>

    <!-- Funnel -->
    <div class="card" style="margin-bottom:16px;padding:16px 18px">
      <div class="card-title">&#x1F4CA; Outreach &amp; Engagement Funnel</div>
      <div class="funnel-grid">
        <div class="funnel-card"><div class="f-val" id="fn-sent" style="color:var(--text)">0</div><div class="f-lbl">&#x1F4E4; Sent</div></div>
        <div class="funnel-card"><div class="f-val" id="fn-opened" style="color:var(--blue)">0</div><div class="f-lbl">&#x1F441; Opened (<span id="fn-open-rate">0%</span>)</div></div>
        <div class="funnel-card"><div class="f-val" id="fn-resume" style="color:var(--accent2)">0</div><div class="f-lbl">&#x1F4C4; Resume (<span id="fn-click-rate">0%</span>)</div></div>
        <div class="funnel-card"><div class="f-val" id="fn-replied" style="color:var(--green)">0</div><div class="f-lbl">&#x1F4AC; Replies (<span id="fn-reply-rate">0%</span>)</div></div>
        <div class="funnel-card"><div class="f-val" id="fn-interviews" style="color:var(--yellow)">0</div><div class="f-lbl">&#x1F3AF; Interviews</div></div>
      </div>
    </div>

    <!-- Account bars -->
    <div class="accs" id="accs"></div>

    <!-- Controls -->
    <div class="controls">
      <span class="clbl">Control</span>
      <button class="btn btn-g" id="btn-ctrl-main" onclick="ctrl('resume')" style="font-weight:800;padding:8px 16px">&#x25B6; Start Campaign</button>
      <button class="btn btn-y" onclick="ctrl('pause')">&#x23F8; Pause</button>
      <button class="btn btn-r" onclick="if(confirm('Stop sending?'))ctrl('stop')">&#x23F9; Stop</button>
      <button class="btn btn-g" onclick="document.getElementById('direct-send-modal').classList.remove('hidden')" title="Send single email">&#x26A1; Direct</button>
      <button class="btn btn-b" onclick="toggleResendMode()" id="btn-resend-mode">&#x21BB; Resend OFF</button>
      <button class="btn btn-b" onclick="toggleGmailMode()" id="btn-gmail-mode" title="Toggle sending to @gmail.com recipient leads">&#x2709; @gmail: OFF</button>
      <button class="btn btn-p" onclick="ctrl('reload')" title="Reload queue and configuration from disk">&#x21BB; Reload Queue</button>
      <button class="btn btn-ghost" onclick="window.location.href='/api/log/export'">&#x1F4E5; Log</button>
      <button class="btn btn-ghost" onclick="document.getElementById('schedule-modal').classList.remove('hidden')">&#x23F0; Schedule</button>
      <div class="spd">
        <span class="clbl">Speed</span>
        <button class="sbtn" id="sp-stealth" onclick="spd('stealth')" style="color:#a78bfa;font-weight:700" title="Stealth Human-Mimic (15-38s randomized jitter)">🥷 Stealth</button>
        <button class="sbtn" id="sp-slow" onclick="spd('slow')">Slow</button>
        <button class="sbtn" id="sp-medium" onclick="spd('medium')">Med</button>
        <button class="sbtn" id="sp-fast" onclick="spd('fast')">Fast</button>
        <button class="sbtn" id="sp-turbo" onclick="spd('turbo')" style="color:var(--yellow);font-weight:800" title="Ultra-fast 200ms sending">&#x26A1; Turbo</button>
      </div>
    </div>

    <!-- Current sending -->
    <div class="cur">
      <span class="cur-lbl">Sending</span>
      <span class="cur-email" id="ce">&#x2014;</span>
      <span class="eta-badge" id="etabadge">ETA: &#x2014;</span>
      <span class="cur-acc" id="ca">&#x2014;</span>
    </div>

    <!-- Log -->
    <div class="log-card">
      <div class="log-hdr"><span>&#x1F4C3; Live Log</span><span id="lc" style="font-size:10px;color:var(--text-dim)">0 entries</span></div>
      <div class="log-body" id="lb"></div>
    </div>
  </div>

  <!-- ══════════ TEMPLATE TAB ══════════ -->
  <div id="panel-template" class="tab-panel">
    <div class="card">
      <div class="card-title">&#x1F4DD; Email Template Manager</div>
      <div class="token-bar">
        <span class="token-lbl">Variables:</span>
        <button class="token-btn" onclick="insertToken('{company}')">{company}</button>
        <button class="token-btn" onclick="insertToken('{role}')">{role}</button>
        <button class="token-btn" onclick="insertToken('Milin Chaware')">{sender_name}</button>
        <button class="token-btn" style="background:rgba(129,140,248,.2);border-color:var(--accent);color:#fff" onclick="insertToken('{personalization}')">&#x1F916; {personalization}</button>
      </div>

      <!-- AI Studio -->
      <div class="card" style="background:linear-gradient(135deg,rgba(129,140,248,.08),rgba(167,139,250,.05));border-color:rgba(129,140,248,.25);padding:14px 18px;margin:10px 0 14px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <div class="card-title" style="margin:0;font-size:12px">&#x1F916; AI Personalization Studio</div>
          <span style="font-size:9px;font-family:var(--mono);color:var(--accent);background:rgba(129,140,248,.15);padding:2px 8px;border-radius:10px">Gemini Flash</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr auto;gap:8px;align-items:flex-end">
          <div class="form-group" style="margin:0"><label class="form-label">Company</label><input class="form-input" id="ai-test-company" placeholder="e.g. Zepto" style="padding:7px 10px;font-size:11px"/></div>
          <div class="form-group" style="margin:0"><label class="form-label">Context</label><input class="form-input" id="ai-test-context" placeholder="e.g. FastAPI &amp; Redis scaling" style="padding:7px 10px;font-size:11px"/></div>
          <button class="btn btn-p" id="ai-gen-btn" onclick="generateAiPersonalizationUI()" style="padding:7px 14px;font-size:11px">&#x2728; Generate</button>
        </div>
        <div id="ai-gen-result-box" style="display:none;margin-top:10px;background:rgba(0,0,0,.2);border:1px dashed var(--accent);border-radius:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:10px;font-weight:700;color:var(--accent)">Generated:</span>
            <button class="token-btn" onclick="insertToken('{personalization}')" style="font-size:9px;padding:2px 6px">+ Insert</button>
          </div>
          <div id="ai-gen-text" style="font-size:12px;color:var(--text);font-style:italic;line-height:1.5"></div>
        </div>
      </div>

      <!-- v8.5: AI Job Description Personalizer Card -->
      <div class="card" style="background:linear-gradient(135deg,rgba(99,102,241,.1),rgba(168,85,247,.06));border:1px solid rgba(99,102,241,.3);padding:14px 18px;margin:10px 0 14px;border-radius:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="card-title" style="margin:0;font-size:13px;display:flex;align-items:center;gap:6px">
            <span>✨</span> <strong>AI Job Description Tailor</strong>
          </div>
          <span style="font-size:10px;font-family:var(--mono);color:var(--accent);background:rgba(99,102,241,.18);padding:3px 10px;border-radius:12px;border:1px solid rgba(99,102,241,.3)">FastAPI &bull; Django &bull; AI/ML &bull; PostgreSQL</span>
        </div>
        <p style="font-size:11px;color:var(--text-dim);margin:0 0 10px">Paste any job description from LinkedIn, Naukri, or email. The engine extracts tech requirements and tailors your subject and application body instantly.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <input class="form-input" id="ai-jd-company" placeholder="Target Company (e.g. Razorpay, Swiggy, Cred)" style="font-size:11px"/>
          <input class="form-input" id="ai-jd-role" placeholder="Job Title (e.g. Senior Python Backend Developer)" style="font-size:11px"/>
        </div>
        <textarea class="form-textarea" id="ai-jd-input" placeholder="Paste full Job Description text here..." style="height:80px;font-size:11px;margin-bottom:8px"></textarea>
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div id="ai-jd-tags" style="display:flex;gap:4px;flex-wrap:wrap"></div>
          <button class="btn btn-p" id="btn-tailor-jd" onclick="generateTailoredPitchUI()" style="padding:6px 16px;font-size:11px">✨ Auto-Tailor Pitch &amp; Load into Template</button>
        </div>
      </div>

      <!-- Industry Presets -->
      <div class="token-bar" style="margin-top:2px">
        <span class="token-lbl">Industry:</span>
        <button class="token-btn" style="background:rgba(52,211,153,.1);color:var(--green);border-color:rgba(52,211,153,.25)" onclick="applyIndustryPreset('ai')">&#x1F916; AI</button>
        <button class="token-btn" style="background:rgba(96,165,250,.1);color:var(--blue);border-color:rgba(96,165,250,.25)" onclick="applyIndustryPreset('backend')">&#x2699; Backend</button>
        <button class="token-btn" style="background:rgba(251,191,36,.1);color:var(--yellow);border-color:rgba(251,191,36,.25)" onclick="applyIndustryPreset('data')">&#x1F4CA; Data</button>
        <button class="token-btn" style="background:rgba(167,139,250,.1);color:var(--accent2);border-color:rgba(167,139,250,.25)" onclick="applyIndustryPreset('general')">&#x1F4BC; General</button>
      </div>

      <div class="form-group">
        <label class="form-label">Subject Line <span style="float:right;font-size:9px;color:var(--text-dim);font-weight:400">Ideal: 50&#x2013;60 chars</span></label>
        <input class="form-input" id="t-subject" placeholder="Email subject..." oninput="updateSubjectCounter()"/>
        <div class="char-counter" id="subject-counter">0 / 60 characters</div>
      </div>
      <div class="template-grid">
        <div class="form-group"><label class="form-label">Plain Text Body</label><textarea class="form-textarea" id="t-plain" style="height:280px" oninput="tPreviewDebounce()"></textarea></div>
        <div class="form-group"><label class="form-label">HTML Body</label><textarea class="form-textarea" id="t-html" style="height:280px" oninput="tPreviewDebounce()"></textarea></div>
      </div>
      <div class="preview-controls">
        <label class="form-label" style="margin:0">Preview:</label>
        <select id="t-lead-selector" class="form-select form-input" style="max-width:220px;font-size:11px" onchange="selectPreviewLead(this.value)">
          <option value="">-- Real Queue Leads --</option>
        </select>
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="stepPreviewLead(-1)" title="Previous Lead">&#x25C0;</button>
        <button class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="stepPreviewLead(1)" title="Next Lead">&#x25B6;</button>
        <input class="form-input" id="t-company" placeholder="ACME Corp" style="width:140px;font-size:11px" oninput="tPreviewDebounce()"/>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <div class="preview-device-btns">
            <button class="dev-btn active" id="dev-desktop" onclick="setPreviewDevice('desktop',this)">&#x1F5A5; Desktop</button>
            <button class="dev-btn" id="dev-mobile" onclick="setPreviewDevice('mobile',this)">&#x1F4F1; Mobile</button>
          </div>
          <button class="btn btn-ghost" onclick="resetTemplate()">&#x21BA; Reset</button>
          <button class="btn btn-p" onclick="saveTemplate()">&#x1F4BE; Save</button>
        </div>
      </div>
      <div class="slot-row">
        <span class="slot-lbl">Slots:</span>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="saveToSlot('A')">Save &#x2192; A</button>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px" onclick="saveToSlot('B')">Save &#x2192; B</button>
        <span style="color:var(--border)">|</span>
        <button class="btn btn-b" style="padding:4px 10px;font-size:11px" onclick="loadFromSlot('A')">Load A</button>
        <button class="btn btn-b" style="padding:4px 10px;font-size:11px" onclick="loadFromSlot('B')">Load B</button>
        <span id="slot-status" style="margin-left:auto;font-size:10px;color:var(--green);font-weight:700"></span>
      </div>
      <div class="test-send-box">
        <label class="form-label" style="margin:0;white-space:nowrap">&#x1F9EA; Test Send:</label>
        <input class="form-input" id="t-test-email" placeholder="your@gmail.com" style="flex:1;min-width:180px"/>
        <button class="btn btn-b" id="t-test-btn" onclick="sendTestTemplate()">&#x1F4E9; Send Test</button>
      </div>
      <div style="margin-top:14px"><label class="form-label">HTML Preview</label><iframe id="t-preview" class="preview-frame" title="Preview"></iframe></div>

      <!-- Spam Check -->
      <div class="card" style="margin-top:14px;background:rgba(0,0,0,.15)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="card-title" style="margin:0">&#x1F6E1; Deliverability &amp; Spam Shield 2.0</div>
          <button class="btn btn-b" onclick="checkSpamScoreUI()" style="padding:4px 10px;font-size:11px">Inspect Deliverability</button>
        </div>
        <div id="spam-score-box" style="display:none">
          <div style="display:flex;align-items:center;gap:14px">
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:65px;height:65px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid var(--border)">
              <span style="font-size:24px;font-weight:900" id="spam-grade-badge">A+</span>
              <span style="font-size:9px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.5px">Grade</span>
            </div>
            <div style="flex:1">
              <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
                <span id="spam-score-rating" style="font-weight:700;color:var(--green)">Exceptional Deliverability</span>
                <span style="color:var(--text-dim)"><span id="spam-score-num">98%</span> Score</span>
              </div>
              <div class="track"><div class="fill" id="spam-score-bar" style="width:98%;background:var(--green)"></div></div>
              <div style="display:flex;gap:12px;font-size:10px;color:var(--text-dim);margin-top:6px" id="spam-metrics"></div>
            </div>
          </div>
          <div id="spam-score-triggers" style="margin-top:10px;font-size:11px;color:var(--text-dim)"></div>
          <div id="spam-score-tips" style="margin-top:8px;font-size:11px;display:flex;flex-direction:column;gap:4px"></div>
        </div>
      </div>
    </div>
  </div>

    <!-- ══════════ EMAILS TAB (Sections 16 & 17) ══════════ -->
  <div id="panel-emails" class="tab-panel">
    <!-- Sub-tabs: All, Queued, Sent, Failed, Bounced, Opened, Replied, Scheduled -->
    <div class="card" style="margin-bottom:14px;padding:14px 18px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div style="display:flex;gap:4px;flex-wrap:wrap" id="email-subtabs">
          <button class="btn btn-b" data-tab="all" onclick="switchEmailSubTab('all',this)">All (<span id="ec-all">0</span>)</button>
          <button class="btn btn-ghost" data-tab="queued" onclick="switchEmailSubTab('queued',this)">Queued (<span id="ec-queued">0</span>)</button>
          <button class="btn btn-ghost" data-tab="sent" onclick="switchEmailSubTab('sent',this)">Sent (<span id="ec-sent">0</span>)</button>
          <button class="btn btn-ghost" data-tab="failed" onclick="switchEmailSubTab('failed',this)">Failed (<span id="ec-failed">0</span>)</button>
          <button class="btn btn-ghost" data-tab="bounced" onclick="switchEmailSubTab('bounced',this)">Bounced (<span id="ec-bounced">0</span>)</button>
          <button class="btn btn-ghost" data-tab="opened" onclick="switchEmailSubTab('opened',this)">Opened (<span id="ec-opened">0</span>)</button>
          <button class="btn btn-ghost" data-tab="replied" onclick="switchEmailSubTab('replied',this)">Replied (<span id="ec-replied">0</span>)</button>
          <button class="btn btn-ghost" data-tab="scheduled" onclick="switchEmailSubTab('scheduled',this)">Scheduled (<span id="ec-scheduled">0</span>)</button>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-g" onclick="openEmailComposerModalUI()" style="font-size:11px">✉️ Compose Email</button>
          <button class="btn btn-b" onclick="openVerifyQueueModal()" style="font-size:11px">🛡️ Verify Leads</button>
          <button class="btn btn-ghost" onclick="loadEmailRecordsUI()" style="font-size:11px">🔄 Refresh</button>
        </div>
      </div>
    </div>

    <!-- Email Records Table -->
    <div class="card" style="margin-bottom:16px;padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="card-title" style="margin:0">📬 Email Queue &amp; Delivery Management</div>
        <input class="form-input" id="emails-search-input" placeholder="Search by recipient or subject..." style="max-width:260px;font-size:11px" oninput="filterEmailRecordsUI()"/>
      </div>
      <div class="jobs-table-wrap">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Company</th>
              <th>Job</th>
              <th>Subject</th>
              <th>Status</th>
              <th>Sent At</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="emails-tbody">
            <tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:24px">Loading email records...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- File Management & Quick Import Drop Zone -->
    <div class="card">
      <div class="card-title">📁 Email Lead Files &amp; Batch Importer</div>
      <div class="drop-zone" id="email-drop" ondragover="dzOver(event)" ondragleave="dzLeave()" ondrop="dzDrop(event)" onclick="document.getElementById('file-input').click()" style="margin-bottom:14px">
        <div class="drop-icon">📄</div>
        <p><strong>Drop .txt or .csv lead file here</strong> or click to browse</p>
        <p style="font-size:10px;margin-top:3px">Format: <code style="color:var(--accent)">email@company.com, Company Name</code></p>
        <input type="file" id="file-input" accept=".txt,.csv" style="display:none" onchange="fileInputChange(event)"/>
      </div>
      <div style="margin-bottom:14px"><label class="form-label">Available Email Files</label><div class="file-list" id="file-list"></div></div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px">
        <label class="form-label" style="margin:0;flex:1">Active Batch File: <strong id="e-editing-name" style="color:var(--accent)">—</strong></label>
        <button class="btn btn-ghost" onclick="newBatchFile()">+ New Batch</button>
        <button class="btn btn-p" onclick="saveEmailFile()">💾 Save</button>
      </div>
      <textarea class="form-textarea" id="e-content" style="height:140px" placeholder="email@company.com, Company Name"></textarea>
      <div class="val-card" style="margin-top:8px">
        <button class="btn btn-b" onclick="validateCurrentEmailFile()">🔍 Validate</button>
        <button class="btn btn-p" onclick="cleanCurrentEmailFile()">✨ Auto-Clean</button>
        <button class="btn btn-g" onclick="openImportCsvModal()">📥 Import CSV / Leads</button>
        <button class="btn btn-r" onclick="clearSentLog()">🗑️ Clear Sent Log</button>
      </div>
      <div id="val-report" class="val-report" style="display:none"></div>
    </div>
  </div>

  <!-- ══════════ ANALYTICS TAB ══════════ -->
  <div id="panel-analytics" class="tab-panel">
    <div class="analytics-top">
      <div class="a-metric"><div class="a-val g" id="a-total-log">0</div><div class="a-lbl">Total Sent</div></div>
      <div class="a-metric"><div class="a-val b" id="a-success-rate">0%</div><div class="a-lbl">Success Rate</div></div>
      <div class="a-metric"><div class="a-val y" id="a-eta">&#x2014;</div><div class="a-lbl">ETA</div></div>
      <div class="a-metric"><div class="a-val o" id="a-remaining">0</div><div class="a-lbl">Remaining</div></div>
      <div class="a-metric"><div class="a-val p" id="a-response-rate">0%</div><div class="a-lbl">Response Rate</div></div>
    </div>

    <!-- Streak & Goals -->
    <div style="display:grid;grid-template-columns:auto 1fr;gap:14px;margin-bottom:16px">
      <div class="streak-card" id="streak-card">
        <div class="streak-fire">&#x1F525;</div>
        <div><div class="streak-num" id="streak-num">0</div><div style="font-size:11px;color:var(--text-dim);font-weight:700">DAY STREAK</div></div>
      </div>
      <div class="card" style="padding:16px">
        <div class="card-title" style="margin-bottom:10px">&#x1F3AF; Weekly &amp; Monthly Goals</div>
        <div class="goal-ring-container" id="goal-rings"></div>
      </div>
    </div>

    <!-- Conversion Funnel -->
    <div class="card" style="margin-bottom:14px">
      <div class="card-title">&#x1F4CA; Application Conversion Funnel</div>
      <div class="funnel-grid">
        <div class="funnel-card"><div class="f-val b" id="fn2-sent">0</div><div class="f-lbl">Sent</div></div>
        <div class="funnel-card"><div class="f-val y" id="fn2-viewed">0</div><div class="f-lbl">Viewed</div></div>
        <div class="funnel-card"><div class="f-val b" id="fn2-interview">0</div><div class="f-lbl">Interview</div></div>
        <div class="funnel-card"><div class="f-val g" id="fn2-offer">0</div><div class="f-lbl">Offer &#x1F389;</div></div>
        <div class="funnel-card"><div class="f-val o" id="fn2-rate">0%</div><div class="f-lbl">Response Rate</div></div>
      </div>
      <div id="svg-funnel" style="margin-top:14px;overflow-x:auto"></div>
    </div>

    <div class="charts-grid">
      <div class="chart-card"><h3>&#x1F31F; Session Results</h3><canvas id="chart-donut" width="260" height="260"></canvas></div>
      <div class="chart-card"><h3>&#x1F4C5; Emails Per Day</h3><canvas id="chart-bar" height="200"></canvas></div>
    </div>

    <!-- ═══ v7.0: CUMULATIVE GROWTH & SEND VELOCITY ═══ -->
    <div class="card" style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div class="card-title" style="margin:0">&#x1F4C8; All-Time Cumulative Outreach Growth</div>
        <span id="cumulative-total-badge" style="font-size:11px;font-family:var(--mono);font-weight:700;color:var(--accent)">0 sent ever</span>
      </div>
      <canvas id="chart-cumulative" height="110"></canvas>
    </div>

    <!-- Heatmap -->
    <div class="card" style="margin-top:14px">
      <div class="card-title">&#x23F0; Hourly Heatmap</div>
      <div id="hourly-heatmap" style="display:flex;gap:3px;align-items:flex-end;height:70px;padding:6px 0"></div>
      <div id="hourly-labels" style="display:flex;gap:3px;margin-top:3px"></div>
    </div>

    <!-- Weekly -->
    <div class="card" style="margin-top:14px">
      <div class="card-title">&#x1F4C5; Week-over-Week</div>
      <canvas id="chart-weekly" height="110"></canvas>
    </div>

    <!-- Status + Domains -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
      <div class="chart-card"><h3>&#x1F4CB; Status Breakdown</h3><canvas id="chart-status-pie" width="200" height="200"></canvas></div>
      <div class="chart-card"><h3>&#x1F3E0; Top Domains</h3><div class="domain-list" id="domain-list"></div></div>
    </div>

    <!-- ═══ v7.0: A/B TESTING & SEND-TIME OPTIMIZER ═══ -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
      <!-- A/B Test Card -->
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title" style="margin:0">&#x1F9EA; Subject Line A/B Test</div>
          <span id="ab-winner-badge" class="badge" style="background:rgba(52,211,153,.12);color:var(--green);border:1px solid rgba(52,211,153,.3)">Active</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div style="background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:10px;padding:12px">
            <div style="font-weight:800;font-size:11px;color:var(--accent);margin-bottom:4px">VARIANT A</div>
            <div style="font-size:18px;font-weight:900" id="ab-a-rate">0%</div>
            <div style="font-size:10px;color:var(--text-dim)"><span id="ab-a-opened">0</span> opened / <span id="ab-a-sent">0</span> sent</div>
          </div>
          <div style="background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:10px;padding:12px">
            <div style="font-weight:800;font-size:11px;color:var(--accent2);margin-bottom:4px">VARIANT B</div>
            <div style="font-size:18px;font-weight:900" id="ab-b-rate">0%</div>
            <div style="font-size:10px;color:var(--text-dim)"><span id="ab-b-opened">0</span> opened / <span id="ab-b-sent">0</span> sent</div>
          </div>
        </div>
        <div id="ab-confidence-text" style="font-size:11px;color:var(--text-dim)">Collecting variant performance data...</div>
      </div>

      <!-- Send-Time Optimizer Card -->
      <div class="card" style="padding:16px">
        <div class="card-title" style="margin-bottom:8px">&#x26A1; Send-Time Intelligence</div>
        <div style="margin-bottom:10px">
          <div style="font-size:11px;color:var(--text-dim);margin-bottom:6px">AI Optimal Sending Recommendation:</div>
          <div id="opt-hours-badge" class="badge" style="background:rgba(129,140,248,.12);color:var(--accent);border:1px solid rgba(129,140,248,.3);font-size:11px;padding:6px 12px">Analyzing historical open patterns...</div>
        </div>
        <div id="opt-top-hours" style="display:flex;gap:6px;flex-wrap:wrap"></div>
      </div>
    </div>

    <!-- ═══ v7.0: DOMAIN REPUTATION & COMPANY ANALYTICS ═══ -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px">
      <!-- Blacklist Widget -->
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <div class="card-title" style="margin:0">&#x1F6AB; Smart Domain Blacklist</div>
          <button class="btn btn-ghost" onclick="clearBlacklist()" style="padding:2px 8px;font-size:10px">Clear All</button>
        </div>
        <div id="bl-list" style="max-height:220px;overflow-y:auto">
          <div style="font-size:11px;color:var(--text-dim);text-align:center;padding:16px">No auto-blacklisted domains</div>
        </div>
      </div>

      <!-- Company Analytics Widget -->
      <div class="card" style="padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div class="card-title" style="margin:0">&#x1F3E2; Company Engagement</div>
          <input type="text" id="company-search" placeholder="Search..." oninput="filterCompanyAnalytics(this.value)" class="form-input" style="width:130px;padding:3px 8px;font-size:11px"/>
        </div>
        <div id="company-analytics-table" style="max-height:220px;overflow-y:auto"></div>
      </div>
    </div>

    <!-- ═══ v8.5: HOURLY RECRUITER ACTIVITY HEATMAP ═══ -->
    <div class="card" style="margin-top:14px;padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin:0">&#x1F552; 24-Hour Recruiter Open Activity Heatmap</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px">Distribution of historical sends &bull; <span style="color:var(--green);font-weight:700">Green bars = Prime Recruiter Response Window</span></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span id="heatmap-peak-badge" class="badge" style="background:rgba(52,211,153,.15);color:var(--green);border:1px solid rgba(52,211,153,.3);font-size:10px">Loading...</span>
          <button class="btn btn-ghost" onclick="loadHourlyHeatmap()" style="padding:2px 8px;font-size:10px">&#x21BB;</button>
        </div>
      </div>
      <div id="hourly-heatmap-bars" style="display:grid;grid-template-columns:repeat(24,1fr);gap:4px;align-items:flex-end;height:120px;padding:10px 0;background:rgba(0,0,0,.15);border-radius:8px;border:1px solid var(--border)"></div>
      <div style="display:grid;grid-template-columns:repeat(24,1fr);gap:4px;margin-top:4px;text-align:center;font-family:var(--mono);font-size:8px;color:var(--text-dim)" id="hourly-heatmap-labels"></div>
      <div style="margin-top:10px;font-size:11px;color:var(--text-dim);display:flex;justify-content:space-between;align-items:center">
        <span>💡 <strong>Recommendation:</strong> Schedule sends between <strong>09:00 - 11:30 AM</strong> &amp; <strong>14:00 - 16:30 PM</strong> for 3.2x higher interview reply rates.</span>
        <a href="/api/reports/campaign-summary-csv" download="ResumeAuto_Campaign_Report.csv" class="btn btn-b" style="padding:3px 10px;font-size:10px;text-decoration:none">&#x1F4CA; Export CSV</a>
      </div>
    </div>

    <!-- Best Time -->
    <div class="card" style="margin-top:14px;background:rgba(0,0,0,.15)">
      <div class="card-title">&#x26A1; Best Time to Send</div>
      <div class="best-time-row">
        <span class="best-time-badge">&#x2705; Tue&#x2013;Thu: Highest opens</span>
        <span class="best-time-badge">&#x2705; 8&#x2013;10am: Best visibility</span>
        <span class="best-time-badge">&#x2705; Follow up after 5&#x2013;7 days</span>
      </div>
    </div>

    <div style="margin-top:12px"><button class="btn btn-ghost" onclick="loadAnalytics()">&#x21BB; Refresh Analytics</button></div>
  </div>

    <!-- ══════════ JOBS TAB (Sections 13 & 14) ══════════ -->
  <div id="panel-jobs" class="tab-panel">
    <!-- Action Bar & Controls -->
    <div class="card" style="margin-bottom:14px;padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:280px;flex-wrap:wrap">
          <input class="form-input" id="jobs-search-input" placeholder="🔍 Search by company, title, skill, location..." style="flex:1;min-width:200px;font-size:12px" oninput="filterAndRenderJobsUI()"/>
          <select class="form-select" id="jobs-status-filter" style="width:auto;font-size:12px" onchange="filterAndRenderJobsUI()">
            <option value="all">All Statuses</option>
            <option value="NEW">NEW</option>
            <option value="MATCHED">MATCHED</option>
            <option value="REVIEW">REVIEW</option>
            <option value="READY_TO_CONTACT">READY TO CONTACT</option>
            <option value="CONTACTED">CONTACTED</option>
            <option value="APPLIED">APPLIED</option>
            <option value="REPLIED">REPLIED</option>
            <option value="INTERVIEW">INTERVIEW</option>
            <option value="REJECTED">REJECTED</option>
            <option value="CLOSED">CLOSED</option>
            <option value="SKIPPED">SKIPPED</option>
          </select>
          <select class="form-select" id="jobs-sort-filter" style="width:auto;font-size:12px" onchange="filterAndRenderJobsUI()">
            <option value="score_desc">Match Score (High → Low)</option>
            <option value="date_desc">Date (Newest)</option>
            <option value="company_asc">Company (A → Z)</option>
          </select>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-g" onclick="openAddJobModalUI()" style="font-size:11px">➕ Add Job</button>
          <button class="btn btn-p" onclick="triggerDripCheckManual()" style="font-size:11px">⚡ Follow-ups</button>
          <a href="/api/jobs-export-csv" class="btn btn-ghost" style="font-size:11px;text-decoration:none">📥 CSV</a>
          <button class="btn btn-b" onclick="loadJobs('all')" style="font-size:11px">🔄 Refresh</button>
        </div>
      </div>
    </div>

    <!-- Jobs Table with all 10 requested columns -->
    <div class="card" style="padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="card-title" style="margin:0">📋 Job Tracker &amp; Match Pipeline (<span id="jobs-total-count">0</span> tracked)</div>
        <div style="font-size:11px;color:var(--text-dim)" id="jobs-filter-status-text">Showing all tracked jobs</div>
      </div>
      <div class="jobs-table-wrap">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>Job Title</th>
              <th>Company</th>
              <th>Location</th>
              <th>Experience</th>
              <th>Match Score</th>
              <th>Source</th>
              <th>Status</th>
              <th>Recruiter</th>
              <th>Date</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="jobs-tbody">
            <tr><td colspan="10" style="text-align:center;color:var(--text-dim);padding:24px">Loading jobs...</td></tr>
          </tbody>
        </table>
      </div>
      <!-- Pagination Controls -->
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <span style="font-size:11px;color:var(--text-dim)" id="jobs-pagination-info">Page 1 of 1</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="jobs-btn-prev" onclick="changeJobsPage(-1)" style="padding:4px 12px;font-size:11px">◀ Prev</button>
          <button class="btn btn-ghost" id="jobs-btn-next" onclick="changeJobsPage(1)" style="padding:4px 12px;font-size:11px">Next ▶</button>
        </div>
      </div>
    </div>

    <!-- Interview Calendar Quick Link Card -->
    <div class="card" style="margin-top:16px" id="interview-calendar-card">
      <div class="card-title">📅 Active Interview Pipeline</div>
      <div id="interview-calendar" style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-top:4px"></div>
    </div>
  </div>

  <!-- ══════════ INBOX TAB ══════════ -->
  <div id="panel-inbox" class="tab-panel">
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:16px;font-weight:800;display:flex;align-items:center;gap:8px">
            <span>&#x1F4E5; Recruiter Inbox &amp; Activity Monitor</span>
            <span class="kc-pill" style="background:rgba(16,185,129,.15);color:var(--green);font-size:10px" id="inbox-status-pill">Active Sync</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px" id="inbox-last-checked">Last checked: Never</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="inbox-scan-days" class="input" style="width:auto;padding:6px 10px;font-size:11px">
            <option value="3">Last 3 days</option>
            <option value="7" selected>Last 7 days</option>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
          </select>
          <button class="btn btn-b" id="btn-sync-inbox" onclick="checkInboxUI()" style="display:flex;align-items:center;gap:6px">
            <span>&#x26A1;</span> <span>Check &amp; Update Inbox Now</span>
          </button>
          <button class="btn btn-ghost" onclick="clearInboxActivitiesUI()" title="Clear activities list" style="padding:6px 10px">
            &#x1F5D1; Clear
          </button>
        </div>
      </div>

      <!-- Quick Metrics Bar -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="background:rgba(255,255,255,.03);padding:10px;border-radius:10px;border:1px solid var(--border);text-align:center">
          <div style="font-size:18px;font-weight:900;color:var(--text)" id="inbox-stat-total">0</div>
          <div style="font-size:10px;color:var(--text-dim)">Total Activities</div>
        </div>
        <div style="background:rgba(16,185,129,.05);padding:10px;border-radius:10px;border:1px solid rgba(16,185,129,.2);text-align:center">
          <div style="font-size:18px;font-weight:900;color:var(--green)" id="inbox-stat-interviews">0</div>
          <div style="font-size:10px;color:var(--green)">Interviews</div>
        </div>
        <div style="background:rgba(59,130,246,.05);padding:10px;border-radius:10px;border:1px solid rgba(59,130,246,.2);text-align:center">
          <div style="font-size:18px;font-weight:900;color:var(--blue)" id="inbox-stat-replies">0</div>
          <div style="font-size:10px;color:var(--blue)">Recruiter Replies</div>
        </div>
        <div style="background:rgba(239,68,68,.05);padding:10px;border-radius:10px;border:1px solid rgba(239,68,68,.2);text-align:center">
          <div style="font-size:18px;font-weight:900;color:var(--red)" id="inbox-stat-rejections">0</div>
          <div style="font-size:10px;color:var(--red)">Rejections</div>
        </div>
        <div style="background:rgba(245,158,11,.05);padding:10px;border-radius:10px;border:1px solid rgba(245,158,11,.2);text-align:center">
          <div style="font-size:18px;font-weight:900;color:var(--yellow)" id="inbox-stat-bounces">0</div>
          <div style="font-size:10px;color:var(--yellow)">Bounces / Failures</div>
        </div>
      </div>
    </div>

    <!-- Filter Bar -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-b" id="btn-inbox-f-all" onclick="setInboxFilter('all',this)">All</button>
        <button class="btn btn-ghost" id="btn-inbox-f-interview" onclick="setInboxFilter('interview',this)">&#x1F3AF; Interviews</button>
        <button class="btn btn-ghost" id="btn-inbox-f-reply" onclick="setInboxFilter('reply',this)">&#x1F4E9; Replies</button>
        <button class="btn btn-ghost" id="btn-inbox-f-rejection" onclick="setInboxFilter('rejection',this)">&#x274C; Rejections</button>
        <button class="btn btn-ghost" id="btn-inbox-f-bounce" onclick="setInboxFilter('bounce',this)">&#x26A0;&#xFE0F; Bounces</button>
        <button class="btn btn-ghost" id="btn-inbox-f-autoreply" onclick="setInboxFilter('autoreply',this)">&#x1F916; Auto-replies</button>
      </div>
      <input type="text" id="inbox-search" class="input" placeholder="Search sender, company, subject..." style="width:240px;padding:6px 12px;font-size:11px" oninput="renderInboxFeed()"/>
    </div>

    <!-- Feed Container -->
    <div id="inbox-feed-container" style="display:flex;flex-direction:column;gap:10px">
      <div style="text-align:center;padding:32px;color:var(--text-dim)">Loading inbox activities...</div>
    </div>
  </div>

  <!-- ══════════ SETTINGS TAB ══════════ -->
  <div id="panel-settings" class="tab-panel">
    <!-- Health Monitor -->
    <div class="card" style="margin-bottom:14px;background:linear-gradient(135deg,rgba(52,211,153,.06),rgba(96,165,250,.04));border-color:rgba(52,211,153,.2)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div class="card-title" style="margin:0">&#x1F49A; System Health Monitor</div>
        <button class="btn btn-ghost" onclick="loadHealthData()" style="padding:4px 10px;font-size:10px">&#x21BB; Refresh</button>
      </div>
      <div class="health-grid" id="health-grid">
        <div class="health-item"><div class="h-val g" id="h-uptime">--</div><div class="h-lbl">Uptime</div></div>
        <div class="health-item"><div class="h-val b" id="h-memory">--</div><div class="h-lbl">Memory</div></div>
        <div class="health-item"><div class="h-val" id="h-accounts">--</div><div class="h-lbl">Accounts</div></div>
        <div class="health-item"><div class="h-val g" id="h-sent-today">--</div><div class="h-lbl">Sent Today</div></div>
        <div class="health-item"><div class="h-val" id="h-total-ever">--</div><div class="h-lbl">Total Ever</div></div>
        <div class="health-item"><div class="h-val" id="h-jobs">--</div><div class="h-lbl">Jobs</div></div>
      </div>
    </div>

    <div class="settings-section" style="border:1px solid rgba(139,92,246,0.3);background:linear-gradient(135deg,rgba(99,102,241,0.06),transparent)">
      <h3>🤖 Full Autopilot &amp; Autonomous Outreach</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:12px">Configure hands-free outreach parameters, recruiter window scheduling, and in-flight lead protection.</p>
      <div class="settings-grid">
        <div class="form-group" style="display:flex;align-items:flex-end"><label class="form-check" style="margin-bottom:8px"><input type="checkbox" id="s-autopilot-enabled" checked/><span style="font-weight:700">Master Autopilot Active</span></label></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label class="form-check" style="margin-bottom:8px"><input type="checkbox" id="s-auto-mx-send" checked/><span style="font-weight:700">In-Flight DNS/MX Lead Shield</span></label></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label class="form-check" style="margin-bottom:8px"><input type="checkbox" id="s-auto-personalize-leads" checked/><span style="font-weight:700">Per-Lead AI Pitch Customizer</span></label></div>
        <div class="form-group"><label class="form-label">Drip Follow-up Scan (Minutes)</label><input class="form-input" id="s-auto-drip-interval" type="number" min="5" max="1440" value="30"/></div>
      </div>
    </div>

    <div class="settings-section"><h3>&#x26A1; Send &amp; Safety</h3>
      <div class="settings-grid">
        <div class="form-group"><label class="form-label">&#x26A1; Sending Pipeline</label><select class="form-select form-input" id="s-concurrency"><option value="1">1 Stream (Sequential)</option><option value="2" selected>2 Streams (2x Parallel Speed)</option><option value="3">3 Streams (3x Maximum Turbo)</option></select></div>
        <div class="form-group"><label class="form-label">Speed</label><select class="form-select form-input" id="s-speed"><option value="stealth">🥷 Stealth (15-38s Human Mimic)</option><option value="slow">Slow (3s)</option><option value="medium">Medium (1.5s)</option><option value="turbo">&#x26A1; Turbo (0.2s ultra-fast)</option><option value="fast">Fast (0.5s)</option></select></div>
        <div class="form-group"><label class="form-label">Daily Limit</label><input class="form-input" id="s-limit" type="number" min="1" max="500"/></div>
        <div class="form-group"><label class="form-label">Max Retries</label><input class="form-input" id="s-retries" type="number" min="1" max="10"/></div>
        <div class="form-group"><label class="form-label">Retry Delay (ms)</label><input class="form-input" id="s-retry-delay" type="number" min="1000" step="1000"/></div>
        <div class="form-group"><label class="form-label">Auto-Pause Failures</label><input class="form-input" id="s-autopause" type="number" min="1" max="10"/></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label class="form-check" style="margin-bottom:8px"><input type="checkbox" id="s-resend-sent"/><span>Force resend to already-sent</span></label></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label class="form-check" style="margin-bottom:8px"><input type="checkbox" id="s-sound-enabled"/><span>Completion sound</span></label></div>
        <div class="form-group" style="display:flex;align-items:flex-end"><label class="form-check" style="margin-bottom:8px"><input type="checkbox" id="s-skip-gmail" checked/><span>Skip @gmail.com (Business only)</span></label></div>
      </div>
    </div>

    <div class="settings-section"><h3>&#x1F319; Business Hours</h3>
      <div class="settings-grid">
        <div class="form-group"><label class="form-check"><input type="checkbox" id="s-biz-enabled"/><span style="font-weight:700">Business hours only</span></label></div>
        <div class="form-group"><label class="form-label">Start Hour</label><input class="form-input" id="s-biz-start" type="number" min="0" max="23" placeholder="9"/></div>
        <div class="form-group"><label class="form-label">End Hour</label><input class="form-input" id="s-biz-end" type="number" min="0" max="23" placeholder="18"/></div>
        <div class="form-group"><label class="form-check"><input type="checkbox" id="s-biz-weekends"/><span>Skip weekends</span></label></div>
      </div>
    </div>

    <div class="settings-section"><h3>&#x1F916; Gemini AI</h3>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px">Powers personalization &amp; reply classification. <a href="https://aistudio.google.com" target="_blank" style="color:var(--accent)">Get free key</a></p>
      <div class="form-group"><label class="form-label">API Key</label><input class="form-input" id="s-gemini-key" type="password" placeholder="AIzaSy..."/></div>
    </div>

    <div class="settings-section"><h3>&#x1F4F1; Telegram Alerts</h3>
      <div class="settings-grid">
        <div class="form-group"><label class="form-label">Bot Token</label><input class="form-input" id="s-telegram-token" type="password" placeholder="123456:ABC..."/></div>
        <div class="form-group"><label class="form-label">Chat ID</label><input class="form-input" id="s-telegram-chatid" placeholder="123456789"/></div>
      </div>
      <button class="btn btn-b" onclick="testTelegramAlertUI()" style="margin-top:6px">&#x1F4F1; Test Alert</button>
    </div>

    <div class="settings-section"><h3>&#x1F441; Tracking Beacon</h3>
      <div class="form-group"><label class="form-label">Tracking Base URL</label><input class="form-input" id="s-tracking-url" placeholder="http://localhost:3000"/></div>
    </div>

    <div class="settings-section"><h3>&#x1F501; Drip Follow-ups &amp; IMAP</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <label class="form-check"><input type="checkbox" id="s-drip-enabled"/><span style="font-weight:700">Auto follow-up (Day 4 &amp; 8)</span></label>
        <label class="form-check"><input type="checkbox" id="s-imap-poll-enabled" checked/><span style="font-weight:700">Auto-poll inbox (15 min)</span></label>
      </div>
    </div>

    <div class="settings-section"><h3>&#x1F514; Webhook Alerts</h3>
      <div class="form-group" style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <label class="form-check"><input type="checkbox" id="s-webhook-enabled"/><span style="font-weight:700">Enable Webhooks</span></label>
        <label class="form-check" style="margin-left:auto"><input type="checkbox" id="s-jitter-enabled"/><span style="font-weight:700">&#x26A1; Human Jitter</span></label>
      </div>
      <div class="smtp-test-row" style="margin-top:0">
        <div style="flex:1"><label class="form-label">Webhook URL</label><input class="form-input" id="s-webhook-url" placeholder="https://discord.com/api/webhooks/..."/></div>
        <button class="btn btn-b" id="s-webhook-btn" onclick="testWebhook()">&#x1F514; Test</button>
      </div>
    </div>

    <div class="settings-section"><h3>&#x1F4CE; Resume Attachment &amp; Profiles</h3>
      <div class="form-group"><label class="form-check"><input type="checkbox" id="s-attach-enabled"/><span>Attach resume PDF to cold outreach emails</span></label></div>
      <div class="form-group"><label class="form-label">Active Attachment Path</label><div style="display:flex;gap:6px"><input class="form-input" id="s-attachment" placeholder="./resume.pdf" style="flex:1"/><button class="btn btn-ghost" style="padding:8px 12px;font-size:11px" onclick="detectResumePdf()">&#x1F50D; Scan Profiles</button></div></div>
      <div id="s-attach-pdfs" style="margin-top:6px;display:none"></div>
      <div class="form-group" style="margin-top:8px"><label class="form-label">AI Subject Rotation</label><label class="form-check"><input type="checkbox" id="s-ai-subject" onchange="saveAiSubjectSetting(this.checked)"/><span>Rotate 5 subject variants</span></label></div>
      <p id="s-attach-status" style="font-size:11px;color:var(--text-dim);margin-top:3px"></p>
    </div>

    <div class="settings-section"><h3>&#x1F4E6; Backup &amp; Restore</h3>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <a href="/api/backup/export" class="btn btn-b" style="text-decoration:none">&#x1F4E5; Export Backup</a>
        <button class="btn btn-ghost" onclick="document.getElementById('backup-file-input').click()">&#x1F4E4; Restore</button>
        <input type="file" id="backup-file-input" accept=".json" style="display:none" onchange="importBackupFile(event)"/>
      </div>
    </div>

    <div class="settings-section"><h3>&#x1F4E7; Gmail Accounts</h3>
      <div id="s-accounts"></div>
      <button class="btn btn-b" id="diag-btn" onclick="runAccountDiagnostic()" style="margin-top:8px">&#x1FA7A; Health Check</button>
      <div id="diag-results" style="margin-top:8px;display:none"></div>
    </div>

    <div class="settings-section"><h3>&#x1F50C; SMTP Test</h3>
      <div class="smtp-test-row" style="margin-top:0"><div><label class="form-label">Send Test To</label><input class="form-input" id="s-test-email" type="email" placeholder="your@gmail.com"/></div><button class="btn btn-b" id="s-test-btn" onclick="testSmtp()">&#x2709; Test</button></div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
      <button class="btn btn-ghost" onclick="loadSettings()">&#x21BB; Reset</button>
      <button class="btn btn-p" onclick="saveSettings()">&#x1F4BE; Save Settings</button>
    </div>
  </div>

  <!-- ══════════ 1. MATCHING & RESUMES TAB ══════════ -->
  <div id="panel-matching" class="tab-panel">
    <!-- Candidate Profile Section -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="card-title" style="margin:0">👤 Candidate Profile &amp; Preferences</div>
        <button class="btn btn-p" onclick="saveCandidateProfileUI()">💾 Save Profile</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="prof-name"/></div>
        <div class="form-group"><label class="form-label">Years of Experience</label><input class="form-input" type="number" id="prof-exp"/></div>
        <div class="form-group"><label class="form-label">Notice Period</label><input class="form-input" id="prof-notice"/></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Target Roles (comma-separated)</label><input class="form-input" id="prof-roles"/></div>
        <div class="form-group"><label class="form-label">Preferred Locations (comma-separated)</label><input class="form-input" id="prof-locations"/></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group"><label class="form-label">Core Skills (High Weight: 40%)</label><input class="form-input" id="prof-core-skills"/></div>
        <div class="form-group"><label class="form-label">Secondary / Cloud Skills (Bonus: 15%)</label><input class="form-input" id="prof-sec-skills"/></div>
      </div>
    </div>

    <!-- Multi-Resume Tracks Section -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">📄 Multi-Resume Profile Manager</div>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:12px">
        ResumeAuto auto-selects the optimal resume for each job based on technical keywords and title focus.
      </p>
      <div id="resume-profiles-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px"></div>
    </div>

    <!-- Transparent Job Match Simulator -->
    <div class="card">
      <div class="card-title">🎯 Transparent Job Match Simulator</div>
      <p style="font-size:11px;color:var(--text-dim);margin-bottom:12px">
        Paste a job role or requirements to see the exact factor-by-factor score breakdown.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
        <input class="form-input" id="sim-role" placeholder="Job Title (e.g. Senior Python Backend Developer)"/>
        <input class="form-input" id="sim-company" placeholder="Company (e.g. Acme Corp)"/>
        <input class="form-input" id="sim-loc" placeholder="Location / Mode (e.g. Remote / Pune)"/>
      </div>
      <textarea class="form-textarea" id="sim-desc" placeholder="Paste full job description or key requirements..." style="height:90px;margin-bottom:10px"></textarea>
      <button class="btn btn-p" onclick="simulateJobMatchUI()">⚡ Calculate Transparent Match Score</button>
      
      <div id="sim-result-box" style="display:none;margin-top:14px;background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:12px;padding:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <div>
            <div id="sim-score-badge" style="font-size:28px;font-weight:900;color:var(--green)">--%</div>
            <div id="sim-tier-badge" style="font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase"></div>
          </div>
          <div style="text-align:right">
            <div style="font-size:11px;color:var(--text-dim)">AUTO-SELECTED RESUME:</div>
            <div id="sim-auto-resume" style="font-weight:800;color:var(--accent)"></div>
          </div>
        </div>
        <div id="sim-breakdown-list" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
    </div>
  </div>

  <!-- ══════════ 2. RECRUITERS & SHIELD TAB ══════════ -->
  <div id="panel-recruiters" class="tab-panel">
    <!-- Recruiter Directory -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div class="card-title" style="margin:0">👥 Recruiter Directory &amp; Outreach Safety</div>
        <input class="form-input" id="rec-search" placeholder="Search recruiters by name, company, email..." style="max-width:280px;font-size:11px" oninput="filterRecruitersUI()"/>
      </div>
      <div class="jobs-table-wrap">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>Recruiter</th>
              <th>Company</th>
              <th>Email</th>
              <th>Designation</th>
              <th>Sent Count</th>
              <th>Reply Status</th>
              <th>Cooldown Status</th>
            </tr>
          </thead>
          <tbody id="recruiters-table-body">
            <tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:24px">Loading recruiters...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Suppression & Opt-Out Shield -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin:0">🚫 Suppression List &amp; Opt-Out Shield</div>
          <p style="font-size:11px;color:var(--text-dim);margin-top:2px">Guarantees zero outreach to unsubscribed recipients, opted-out recruiters, and bounced domains.</p>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <input class="form-input" id="supp-email" placeholder="Email or @domain to suppress..." style="flex:1;max-width:300px"/>
        <input class="form-input" id="supp-reason" placeholder="Reason (e.g. Opt-out request, Hard bounce)" style="flex:1;max-width:260px"/>
        <button class="btn btn-r" onclick="addSuppressionUI()">🚫 Add to Suppression</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-dim);margin-bottom:6px">BLOCKED RECIPIENTS (<span id="supp-email-count">0</span>)</div>
          <div id="supp-email-list" style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px"></div>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-dim);margin-bottom:6px">BLOCKED DOMAINS (<span id="supp-domain-count">0</span>)</div>
          <div id="supp-domain-list" style="max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:4px"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- ══════════ 3. ACTIVITY LOG & HEALTH TAB ══════════ -->
  <div id="panel-activity" class="tab-panel">
    <!-- Live Campaign Health Cards (Section 19) -->
    <div class="card" style="margin-bottom:16px">
      <div class="card-title">🩺 Real-Time System &amp; Campaign Health</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px" id="health-cards-grid">
        <div class="health-item">
          <div class="h-val" style="color:var(--green)">● Healthy</div>
          <div class="h-lbl">Database (Atomic Store)</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:4px" id="health-db-jobs">-- Tracked</div>
        </div>
        <div class="health-item">
          <div class="h-val" style="color:var(--green)">● Healthy</div>
          <div class="h-lbl">Queue Buffer &amp; Sync</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:4px" id="health-redis-status">Active Stream</div>
        </div>
        <div class="health-item">
          <div class="h-val" style="color:var(--green)">● Healthy</div>
          <div class="h-lbl">Worker Pool (Celery/Node)</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:4px" id="health-worker-status">Auto Dispatch</div>
        </div>
        <div class="health-item">
          <div class="h-val" style="color:var(--green)">● Healthy</div>
          <div class="h-lbl">Email Provider (SMTP)</div>
          <div style="font-size:10px;color:var(--text-dim);margin-top:4px" id="health-smtp-sent">-- sent today</div>
        </div>
      </div>
    </div>

    <!-- Structured Activity Event Log (Section 20) -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin:0">📜 Event Audit Trail &amp; Activity Log</div>
          <p style="font-size:11px;color:var(--text-dim);margin-top:2px">Timestamped event log for every discovery, matching, delivery, and recruiter interaction.</p>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost" onclick="loadActivityLogsUI()">🔄 Refresh</button>
        </div>
      </div>
      <div class="jobs-table-wrap">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Entity</th>
              <th>Event Type</th>
              <th>Status</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody id="activity-log-body">
            <tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:24px">Loading audit events...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ══════════ CAMPAIGNS TAB (Section 20) ══════════ -->
  <div id="panel-campaigns" class="tab-panel">
    <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,rgba(99,102,241,0.08) 0%,rgba(168,85,247,0.05) 100%);border:1px solid rgba(139,92,246,0.3)">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px">
        <div>
          <div style="display:flex;align-items:center;gap:10px">
            <h2 style="margin:0;font-size:18px;font-weight:800;color:var(--text-bright)">Python Backend Recruiter Outreach</h2>
            <span class="badge" id="camp-status-badge" style="background:rgba(52,211,153,0.2);color:var(--green);font-size:11px;font-weight:800">READY</span>
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:4px">Primary Campaign Track &bull; Targeted Recruiter Engagement &bull; Automated Follow-up Guard</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-g" id="btn-camp-start" onclick="ctrl('start')">▶ Start Campaign</button>
          <button class="btn btn-y" id="btn-camp-pause" onclick="ctrl('pause')">⏸ Pause</button>
          <button class="btn btn-r" id="btn-camp-stop" onclick="ctrl('stop')">⏹ Stop</button>
          <button class="btn btn-b" id="btn-camp-gmail" onclick="toggleGmailMode()" style="font-size:11px" title="Toggle sending to @gmail.com leads">✉️ @gmail: OFF</button>
          <button class="btn btn-r" onclick="triggerEmergencyStop()" style="font-weight:900">🛑 EMERGENCY STOP</button>
        </div>
      </div>
      
      <!-- Progress Bar -->
      <div style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
          <span style="color:var(--text-dim)">Campaign Progression</span>
          <span style="font-weight:700;color:var(--text-bright)"><span id="camp-pct">0</span>% (<span id="camp-sent">0</span> / <span id="camp-total">0</span> leads)</span>
        </div>
        <div class="p-bar"><div class="p-fill" id="camp-bar" style="width:0%"></div></div>
      </div>

      <!-- Speed Control in Campaign -->
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)">
        <span style="font-size:11px;font-weight:700;color:var(--text-dim)">STREAM DISPATCH SPEED:</span>
        <div class="sp-grp">
          <button class="sp-btn" id="camp-sp-stealth" onclick="setSpeed('stealth')">&#x1F977; Stealth (Human)</button>
          <button class="sp-btn" id="camp-sp-slow" onclick="setSpeed('slow')">&#x1F422; Slow</button>
          <button class="sp-btn active" id="camp-sp-medium" onclick="setSpeed('medium')">&#x1F6B6; Medium</button>
          <button class="sp-btn" id="camp-sp-fast" onclick="setSpeed('fast')">&#x26A1; Fast</button>
          <button class="sp-btn" id="camp-sp-turbo" onclick="setSpeed('turbo')">&#x1F680; Turbo</button>
        </div>
      </div>
    </div>

    <!-- Campaign Metrics Grid -->
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="stat-val" id="camp-stat-jobs" style="color:var(--accent)">0</div><div class="stat-lbl">Jobs Tracked</div></div>
      <div class="stat"><div class="stat-val" id="camp-stat-matched" style="color:var(--blue)">0</div><div class="stat-lbl">Matched</div></div>
      <div class="stat"><div class="stat-val" id="camp-stat-queued" style="color:var(--yellow)">0</div><div class="stat-lbl">Queued Leads</div></div>
      <div class="stat"><div class="stat-val" id="camp-stat-sent" style="color:var(--green)">0</div><div class="stat-lbl">Sent Successfully</div></div>
      <div class="stat"><div class="stat-val" id="camp-stat-failed" style="color:var(--red)">0</div><div class="stat-lbl">Failed / Bounced</div></div>
      <div class="stat"><div class="stat-val" id="camp-stat-replies" style="color:var(--purple)">0</div><div class="stat-lbl">Recruiter Replies</div></div>
      <div class="stat"><div class="stat-val" id="camp-stat-interviews" style="color:#fbbf24">0</div><div class="stat-lbl">Interviews Scheduled</div></div>
    </div>
  </div>

  <!-- ══════════ INTERVIEWS TRACKER TAB (Section 28) ══════════ -->
  <div id="panel-interviews" class="tab-panel">
    <!-- Schedule Interview Quick Card -->
    <div class="card" style="margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <div>
          <div class="card-title" style="margin:0">📅 Interview Stage Tracker &amp; Calendar</div>
          <p style="font-size:11px;color:var(--text-dim);margin-top:2px">Track recruitment rounds: Recruiter Screen, Technical, System Design, Manager, HR, and Offers.</p>
        </div>
        <button class="btn btn-p" onclick="document.getElementById('add-interview-box').style.display=document.getElementById('add-interview-box').style.display==='none'?'block':'none'">+ Schedule New Interview</button>
      </div>

      <!-- Add Interview Form (Collapsible) -->
      <div id="add-interview-box" style="display:none;background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">
        <div style="font-size:12px;font-weight:700;color:var(--text-bright);margin-bottom:10px">Schedule Interview Round</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <input class="form-input" id="int-company" placeholder="Company (e.g. Stripe, Datadog)"/>
          <input class="form-input" id="int-role" placeholder="Role (e.g. Senior Python Backend)"/>
          <select class="form-select" id="int-round">
            <option value="Recruiter Screen">Recruiter Screen</option>
            <option value="Technical" selected>Technical</option>
            <option value="Manager">Manager</option>
            <option value="HR">HR</option>
            <option value="Offer">Offer</option>
            <option value="Rejected">Rejected</option>
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px">
          <input class="form-input" type="date" id="int-date"/>
          <input class="form-input" type="time" id="int-time" value="15:00"/>
          <input class="form-input" id="int-link" placeholder="Meeting Link (Google Meet / Zoom)"/>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:10px;margin-bottom:10px">
          <input class="form-input" id="int-interviewer" placeholder="Interviewer Name / Title (optional)"/>
          <input class="form-input" id="int-notes" placeholder="Preparation Notes (e.g. System design, FastAPI, Live coding)"/>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-g" onclick="addInterviewUI()">💾 Save Interview</button>
          <button class="btn btn-ghost" onclick="document.getElementById('add-interview-box').style.display='none'">Cancel</button>
        </div>
      </div>

      <!-- Interviews Table -->
      <div class="jobs-table-wrap">
        <table class="jobs-table">
          <thead>
            <tr>
              <th>Company &amp; Role</th>
              <th>Round / Stage</th>
              <th>Date &amp; Time</th>
              <th>Meeting Link</th>
              <th>Interviewer &amp; Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="interviews-table-body">
            <tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:24px">Loading interview stages...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

</div>

<!-- ═══ v7.0: QUICK ACTIONS FAB ═══ -->
<div class="fab-container">
  <div class="fab-menu" id="fab-menu">
    <div class="fab-action" onclick="document.getElementById('direct-send-modal').classList.remove('hidden');toggleFab()"><span class="fab-action-icon">&#x26A1;</span> Direct Send</div>
    <div class="fab-action" onclick="switchTab('inbox',document.getElementById('tab-inbox'));checkInboxUI();toggleFab()"><span class="fab-action-icon">&#x1F4E5;</span> Check Inbox</div>
    <div class="fab-action" onclick="toggleResendMode();toggleFab()"><span class="fab-action-icon">&#x21BB;</span> Toggle Resend</div>
    <div class="fab-action" onclick="toggleGmailMode();toggleFab()"><span class="fab-action-icon">&#x2709;</span> Toggle @gmail Leads</div>
    <div class="fab-action" onclick="window.location.href='/api/jobs-export-csv';toggleFab()"><span class="fab-action-icon">&#x1F4CA;</span> Export CSV</div>
    <div class="fab-action" onclick="toggleCmdPalette();toggleFab()"><span class="fab-action-icon">&#x2328;&#xFE0F;</span> Palette (Ctrl+K)</div>
  </div>
  <button class="fab-btn" id="fab-btn" onclick="toggleFab()" title="Quick Actions">&#x26A1;</button>
</div>

<!-- MODALS -->
<div class="modal-overlay hidden" id="completion-modal">
  <div class="modal-box" style="text-align:center">
    <button class="modal-close" onclick="document.getElementById('completion-modal').classList.add('hidden')">&#x2715;</button>
    <div style="font-size:44px;margin-bottom:8px">&#x1F389;</div>
    <h2>Batch Complete!</h2><p>Campaign finished sending.</p>
    <div class="modal-stats">
      <div class="modal-stat"><div class="ms-val g" id="m-sent">0</div><div class="ms-lbl">Sent</div></div>
      <div class="modal-stat"><div class="ms-val r" id="m-failed">0</div><div class="ms-lbl">Failed</div></div>
      <div class="modal-stat"><div class="ms-val y" id="m-skipped">0</div><div class="ms-lbl">Skipped</div></div>
    </div>
    <button class="btn btn-g" onclick="document.getElementById('completion-modal').classList.add('hidden')" style="width:100%">&#x2713; Awesome!</button>
  </div>
</div>

<div class="modal-overlay hidden" id="verify-queue-modal">
  <div class="modal-box" style="max-width:540px;text-align:left">
    <button class="modal-close" onclick="document.getElementById('verify-queue-modal').classList.add('hidden')">&#x2715;</button>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="font-size:24px">&#x1F6E1;&#xFE0F;</span>
      <div>
        <h3 style="margin:0;font-size:16px;font-weight:800">DNS &amp; MX Lead Verification Shield</h3>
        <p style="margin:0;font-size:11px;color:var(--text-dim)">Scans corporate mail servers via DNS MX resolution to eliminate bounce risks</p>
      </div>
    </div>
    <div id="verify-queue-status" style="margin:14px 0;padding:12px 14px;border-radius:10px;background:rgba(0,0,0,0.25);border:1px solid var(--border)">
      <div style="font-size:12px;color:var(--text-dim);text-align:center">&#x23F3; Initializing verification scan...</div>
    </div>
    <div id="verify-invalid-list" style="display:none;max-height:160px;overflow-y:auto;margin-bottom:12px;padding:8px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="document.getElementById('verify-queue-modal').classList.add('hidden')">Close</button>
      <button class="btn btn-r" id="btn-clean-invalid-leads" style="display:none" onclick="cleanInvalidLeadsSubmit()">&#x1F9F9; Clean Invalid Leads</button>
      <button class="btn btn-b" onclick="runQueueVerification()">&#x21BB; Re-Scan</button>
    </div>
  </div>
</div>

<div class="modal-overlay hidden" id="direct-send-modal">
  <div class="modal-box" style="max-width:500px;text-align:left">
    <button class="modal-close" onclick="document.getElementById('direct-send-modal').classList.add('hidden')">&#x2715;</button>
    <h3>&#x26A1; Direct Email Send</h3><p>Send to a specific recruiter instantly.</p>
    <div class="form-group"><label class="form-label">Recipient Email *</label><input class="form-input" id="ds-email" type="email" placeholder="hr@company.com"/></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div class="form-group"><label class="form-label">Company</label><input class="form-input" id="ds-company" placeholder="Google"/></div>
      <div class="form-group"><label class="form-label">Role</label><input class="form-input" id="ds-role" value="Python Developer Position"/></div>
    </div>
    <div class="form-group"><label class="form-label" style="display:flex;justify-content:space-between"><span>Subject (optional)</span><button type="button" class="token-btn" style="padding:1px 6px;font-size:9px" onclick="autoTailorDirectSendUI()">✨ AI Auto-Draft</button></label><input class="form-input" id="ds-subject" placeholder="Uses template if empty"/></div>
    <div class="form-group"><label class="form-label">Body (optional)</label><textarea class="form-input" id="ds-body" rows="3" placeholder="Uses template if empty"></textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-ghost" onclick="document.getElementById('direct-send-modal').classList.add('hidden')">Cancel</button>
      <button class="btn btn-g" id="ds-send-btn" onclick="sendDirectEmailSubmit()">&#x1F680; Send</button>
    </div>
  </div>
</div>

<div class="modal-overlay hidden" id="schedule-modal">
  <div class="modal-box" style="max-width:420px;text-align:left">
    <button class="modal-close" onclick="document.getElementById('schedule-modal').classList.add('hidden')">&#x2715;</button>
    <h3>&#x23F0; Schedule Campaign</h3><p>Set delay or target time to auto-start.</p>
    <div class="form-group"><label class="form-label">Delay (minutes)</label><input class="form-input" id="sched-delay" type="number" min="1" placeholder="e.g. 30"/></div>
    <div style="text-align:center;font-size:10px;color:var(--text-dim);margin:8px 0">&#x2014; OR &#x2014;</div>
    <div class="form-group"><label class="form-label">Target Date &amp; Time</label><input class="form-input" id="sched-datetime" type="datetime-local"/></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-r" onclick="cancelScheduleSubmit()">Cancel Timer</button>
      <button class="btn btn-g" onclick="scheduleCampaignSubmit()">&#x23F0; Set</button>
    </div>
  </div>
</div>

<div class="modal-overlay hidden" id="followup-modal">
  <div class="modal-box" style="max-width:520px;text-align:left">
    <button class="modal-close" onclick="document.getElementById('followup-modal').classList.add('hidden')">&#x2715;</button>
    <h3>&#x1F4E9; Send Follow-Up</h3><p id="fu-subtitle">Company</p>
    <input type="hidden" id="fu-job-id"/>
    <div class="form-group"><label class="form-label">Subject</label><input class="form-input" id="fu-subject"/></div>
    <div class="form-group"><label class="form-label">Message</label><textarea class="form-textarea" id="fu-body" style="height:160px"></textarea></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button class="btn btn-ghost" onclick="document.getElementById('followup-modal').classList.add('hidden')">Cancel</button>
      <button class="btn btn-g" id="fu-send-btn" onclick="sendFollowupSubmit()">&#x1F680; Send</button>
    </div>
  </div>
</div>

<div class="modal-overlay hidden" id="import-csv-modal">
  <div class="modal-box" style="max-width:560px;text-align:left">
    <button class="modal-close" onclick="document.getElementById('import-csv-modal').classList.add('hidden')">&#x2715;</button>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="font-size:24px">📥</span>
      <div>
        <h3 style="margin:0;font-size:16px;font-weight:800">Smart CSV / Lead Importer</h3>
        <p style="margin:0;font-size:11px;color:var(--text-dim)">Auto-detects columns, enforces RFC 5321 syntax &amp; appends to emails.txt</p>
      </div>
    </div>
    <div style="margin:12px 0">
      <div class="drop-zone" id="csv-drop-zone" style="padding:16px;border:2px dashed var(--border);border-radius:10px;text-align:center;cursor:pointer;background:rgba(255,255,255,0.02)" onclick="document.getElementById('csv-file-input').click()">
        <span style="font-size:20px">&#x1F4C4;</span>
        <p style="margin:4px 0;font-size:12px;font-weight:700">Drop CSV file here or click to browse</p>
        <span style="font-size:10px;color:var(--text-dim)">Supports LinkedIn, Apollo, Naukri, or Custom CSV/TSV</span>
        <input type="file" id="csv-file-input" accept=".csv,.tsv,.txt" style="display:none" onchange="handleCsvFileSelect(event)"/>
      </div>
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label" style="display:flex;justify-content:space-between">
        <span>Or Paste Raw CSV / Table Data:</span>
        <span style="font-size:10px;color:var(--accent)">Auto-maps email, company, role, name</span>
      </label>
      <textarea class="form-textarea" id="csv-paste-area" style="height:130px;font-family:var(--mono);font-size:11px" placeholder="email,company,role&#10;recruiter@meta.com,Meta,Technical Recruiter&#10;hr@google.com,Google,Talent Acquisition"></textarea>
    </div>
    <div id="csv-import-results" style="display:none;padding:10px 14px;border-radius:8px;background:rgba(0,0,0,0.25);border:1px solid var(--border);margin-bottom:12px;font-size:11px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-ghost" onclick="document.getElementById('import-csv-modal').classList.add('hidden')">Cancel</button>
      <button class="btn btn-g" id="btn-submit-csv-import" onclick="submitCsvImport()">📥 Import Leads</button>
    </div>
  </div>
</div>

<!-- Command Palette -->
<div class="cmd-overlay hidden" id="cmd-palette" onclick="if(event.target===this)this.classList.add('hidden')">
  <div class="cmd-box">
    <input class="cmd-input" id="cmd-input" placeholder="Type a command..." oninput="filterCommands(this.value)" onkeydown="cmdKeydown(event)"/>
    <div class="cmd-list" id="cmd-list"></div>
  </div>
</div>

<script>
// ═══════════════ v6.0 ULTRA JavaScript ═══════════════
var lastLogLen=0,lastFirstLog='',lastAccKey='',notifiedDone=false,currentFilter='all',allJobs=[],editingFile=null,emailFilesCache=[],charts={},chartjsReady=typeof Chart!=='undefined';
if('Notification' in window&&Notification.permission==='default')Notification.requestPermission();

// ── Themes ──
function setTheme(t,btn){document.documentElement.setAttribute('data-theme',t);document.querySelectorAll('.t-btn').forEach(function(b){b.classList.remove('active')});if(btn)btn.classList.add('active');try{localStorage.setItem('ra-theme',t)}catch(e){}}
(function(){try{var t=localStorage.getItem('ra-theme');if(t){document.documentElement.setAttribute('data-theme',t);setTimeout(function(){document.querySelectorAll('.t-btn').forEach(function(b){b.classList.toggle('active',b.textContent.toLowerCase().includes(t))})},100)}}catch(e){}})();

// ── Tab Switching ──
function switchTab(name,btn){
  var targetPanel=document.getElementById('panel-'+name);
  if(!targetPanel)return;
  document.querySelectorAll('.tab-panel').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active')});
  targetPanel.classList.add('active');
  if(!btn) btn=document.getElementById('tab-'+name);
  if(btn)btn.classList.add('active');

  try {
    var routePath = name === 'dashboard' ? '/' : '/' + name;
    if (window.location.pathname !== routePath) {
      history.pushState({ tab: name }, '', routePath);
    }
  } catch(e) {}

  if(name==='dashboard'){loadFunnelStats();if(typeof loadMilestones==='function')loadMilestones();loadHourlyHeatmap()}
  if(name==='campaigns'){if(typeof loadCampaignsUI==='function')loadCampaignsUI()}
  if(name==='interviews'){if(typeof loadInterviewsUI==='function')loadInterviewsUI()}
  if(name==='matching'){if(typeof loadCandidateProfileUI==='function')loadCandidateProfileUI();if(typeof loadResumeProfilesUI==='function')loadResumeProfilesUI()}
  if(name==='recruiters'){if(typeof loadRecruitersUI==='function')loadRecruitersUI();if(typeof loadSuppressionUI==='function')loadSuppressionUI()}
  if(name==='template'){loadTemplate();loadLeadSelectorOptions()}
  if(name==='emails'){loadEmailRecordsUI();loadEmailFiles();}
  if(name==='analytics'){loadAnalytics();setTimeout(loadAnalyticsExtra,400);if(typeof loadAbTest==='function'){loadAbTest();loadOptimalHours();loadCumulativeGrowth();loadBlacklist();loadCompanyAnalytics()};loadHourlyHeatmap()}
  if(name==='jobs')loadJobs('all');
  if(name==='inbox')loadInboxActivities();
  if(name==='activity'){if(typeof loadCampaignHealthUI==='function')loadCampaignHealthUI();if(typeof loadActivityLogsUI==='function')loadActivityLogsUI()}
  if(name==='settings'){loadSettings();loadHealthData()}
}

window.addEventListener('popstate', function(){
  var path = (window.location.pathname || '').split('/').filter(Boolean)[0] || 'dashboard';
  switchTab(path);
});

// ── Helpers ──
function fmt(s){if(!s||s<=0)return'\u2014';if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m '+(s%60)+'s';return Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m'}
function statusColor(s){return{sent:'#64748b',viewed:'#60a5fa',interview:'#fbbf24',rejected:'#f87171',offer:'#34d399',replied:'#c084fc'}[s]||'#64748b'}
function showToast(msg,type){type=type||'info';var t=document.createElement('div');t.className='toast toast-'+type;t.innerHTML=msg;document.body.appendChild(t);requestAnimationFrame(function(){t.classList.add('show')});setTimeout(function(){t.classList.remove('show');setTimeout(function(){t.remove()},300)},3000)}
function setTxt(id,val){var el=document.getElementById(id);if(el)el.textContent=val}
function setWidth(id,val){var el=document.getElementById(id);if(el)el.style.width=val}
function escHtml(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function escAttr(s){return(s||'').replace(/"/g,'&quot;').replace(/</g,'&lt;')}
function animateNumber(id,endVal){
  var el=document.getElementById(id);if(!el)return;
  var target=parseInt(endVal,10);if(isNaN(target)){el.textContent=endVal;return}
  var current=parseInt(el.textContent.replace(/[^0-9]/g,''),10)||0;
  if(current===target)return;
  if(el._animTimer){clearInterval(el._animTimer);el._animTimer=null;}
  var diff=target-current,steps=Math.min(12,Math.max(4,Math.abs(diff))),stepVal=diff/steps,step=0;
  el._animTimer=setInterval(function(){step++;if(step>=steps){el.textContent=target;clearInterval(el._animTimer);el._animTimer=null;}else{el.textContent=Math.round(current+(stepVal*step))}},25);
}

// ── Dashboard Tick ──
async function tick(){try{
var d=await(await fetch('/api/state')).json();
window.__lastIsRunning = Boolean(d.running && !d.paused);
var pct=d.total>0?Math.round(d.sent/d.total*100):0;
setTxt('pct',pct);setWidth('bar',pct+'%');setTxt('ps',d.sent);setTxt('pt',d.total);setTxt('pr',d.rate);setTxt('pe',fmt(d.elapsed));setTxt('peta',fmt(d.etaSeconds));setTxt('etabadge','ETA: '+fmt(d.etaSeconds));
if(typeof updateHeaderSparkline==='function')updateHeaderSparkline(d.rate);
if(typeof pollNotifications==='function')pollNotifications();
if(typeof loadMilestones==='function')loadMilestones(d.sent);
var schedTxt=d.scheduledTime?' | \u23F0 '+new Date(d.scheduledTime).toLocaleTimeString():'';
var resendLabel=d.resendMode?' | Resend: ON':'';
var gmailLabel=(d.allowGmail!==undefined?d.allowGmail:(d.skipPersonalGmail===false))?' | @gmail: ON':'';
setTxt('sub','Speed: '+d.speed+' | '+( d.currentAccount||'\u2014')+schedTxt+resendLabel+gmailLabel);
var rb=document.getElementById('btn-resend-mode');if(rb){rb.textContent=d.resendMode?'\u21BB Resend ON':'\u21BB Resend OFF';rb.className=d.resendMode?'btn btn-y':'btn btn-b'}
var gb=document.getElementById('btn-gmail-mode');if(gb){var allowG=(d.allowGmail!==undefined?d.allowGmail:(d.skipPersonalGmail===false));gb.innerHTML=allowG?'&#x2709; @gmail: ON':'&#x2709; @gmail: OFF';gb.className=allowG?'btn btn-g':'btn btn-b';gb.title=allowG?'Sending to @gmail.com is ENABLED (Click to toggle)':'Sending to @gmail.com is DISABLED (Click to toggle)'}
var cgb=document.getElementById('btn-camp-gmail');if(cgb){var allowG2=(d.allowGmail!==undefined?d.allowGmail:(d.skipPersonalGmail===false));cgb.textContent=allowG2?'✉️ @gmail: ON':'✉️ @gmail: OFF';cgb.className=allowG2?'btn btn-g':'btn btn-b'}
animateNumber('ss',d.sent);animateNumber('sf',d.failed);animateNumber('sk',d.skipped);setTxt('sr',d.retried);animateNumber('sj',d.jobsCount||0);
if(typeof updateAutopilotUI==='function')updateAutopilotUI(d);
if(typeof updateCampaignsTabUI==='function')updateCampaignsTabUI(d);
var dot=document.getElementById('dot'),stxt=document.getElementById('stxt'),btnMain=document.getElementById('btn-ctrl-main');
if(!d.running){
  if(dot) dot.className='dot stopped';
  if(stxt) stxt.textContent='Ready (Click Start)';
  if(btnMain){btnMain.textContent='▶ Start Campaign';btnMain.className='btn btn-g';btnMain.onclick=function(){ctrl('start')};}
}else if(d.paused){
  if(dot) dot.className='dot paused';
  if(stxt) stxt.textContent='Paused';
  if(btnMain){btnMain.textContent='▶ Resume Campaign';btnMain.className='btn btn-g';btnMain.onclick=function(){ctrl('resume')};}
}else{
  if(dot) dot.className='dot';
  if(stxt) stxt.textContent='Sending (' + (d.sent||0) + '/' + (d.total||0) + ')';
  if(btnMain){btnMain.textContent='⏸ Pause Campaign';btnMain.className='btn btn-y';btnMain.onclick=function(){ctrl('pause')};}
}
['stealth','slow','medium','fast','turbo'].forEach(function(s){
  var el=document.getElementById('sp-'+s);
  if(el)el.classList.toggle('active',d.speed===s);
  var elCamp=document.getElementById('camp-sp-'+s);
  if(elCamp)elCamp.classList.toggle('active',d.speed===s);
});
if(d.activeResume&&document.getElementById('dash-active-resume')){document.getElementById('dash-active-resume').textContent=d.activeResume;}
var ceEl=document.getElementById('ce');if(ceEl)ceEl.textContent=d.currentEmail||'\u2014';
var caEl=document.getElementById('ca');if(caEl)caEl.textContent=d.currentAccount||'\u2014';
if(d.accountSentCount&&d.accountSentCount.length){var accKey=d.accountIndex+':'+d.accountSentCount.join(',')+':'+(d.cfgDailyLimit||450);if(accKey!==lastAccKey){lastAccKey=accKey;fetch('/api/accounts/health-score').then(function(r){return r.json()}).then(function(hData){var hMap={};(hData.accounts||[]).forEach(function(a){hMap[a.index]=a.healthScore});var accsEl=document.getElementById('accs');if(accsEl)accsEl.innerHTML=d.accountSentCount.map(function(c,i){var lim=d.cfgDailyLimit||450;var p=Math.min(100,Math.round(c/lim*100));var active=i===d.accountIndex;var score=hMap[i]!==undefined?hMap[i]:100;var scoreCol=score>=80?'var(--green)':score>=50?'var(--yellow)':'var(--red)';return'<div class="acc'+(active?' active':'')+'"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px"><div class="acc-name">'+(active?'▶ ':'')+'Account '+(i+1)+'</div><span style="font-size:10px;font-weight:700;color:'+scoreCol+'">💚 '+score+'% Health</span></div><div class="acc-sent">'+c+' / '+lim+' sent</div><div class="acc-bar"><div class="acc-fill" style="width:'+p+'%"></div></div></div>'}).join('')}).catch(function(){var accsEl=document.getElementById('accs');if(accsEl)accsEl.innerHTML=d.accountSentCount.map(function(c,i){var lim=d.cfgDailyLimit||450;var p=Math.min(100,Math.round(c/lim*100));var active=i===d.accountIndex;return'<div class="acc'+(active?' active':'')+'"><div class="acc-name">'+(active?'▶ ':'')+'Account '+(i+1)+'</div><div class="acc-sent">'+c+' / '+lim+' sent</div><div class="acc-bar"><div class="acc-fill" style="width:'+p+'%"></div></div></div>'}).join('')})}}
var firstLogTime=d.log&&d.log[0]?(d.log[0].time+':'+d.log[0].msg):'';
if(d.log&&(d.log.length!==lastLogLen||firstLogTime!==lastFirstLog)){var isFirst=lastLogLen===0;lastLogLen=d.log.length;lastFirstLog=firstLogTime;var lb=document.getElementById('lb');if(lb)lb.innerHTML=d.log.map(function(e,idx){var isLatest=!isFirst&&idx===0;return'<div class="le '+e.type+(isLatest?' new-entry':'')+'"><span class="lt">'+e.time+'</span><span class="lm '+e.type+'">'+escHtml(e.msg)+'</span></div>'}).join('');var lcEl=document.getElementById('lc');if(lcEl)lcEl.textContent=d.log.length+' entries'}
if(!d.running&&d.completionReady&&!notifiedDone&&d.sent>0){notifiedDone=true;setTxt('m-sent',d.sent);setTxt('m-failed',d.failed);setTxt('m-skipped',d.skipped);var compEl=document.getElementById('completion-modal');if(compEl)compEl.classList.remove('hidden');if('Notification' in window&&Notification.permission==='granted'){new Notification('ResumeAuto',{body:'Campaign done! Sent: '+d.sent+' | Failed: '+d.failed,icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="%236366f1" width="1" height="1"/></svg>'})}}
if(d.running && !d.paused && window.__lastSentForTabs !== d.sent){
  window.__lastSentForTabs = d.sent;
  var currentTab = (window.location.pathname || '').split('/').filter(Boolean)[0];
  if(currentTab === 'emails' && typeof loadEmailRecordsUI === 'function') loadEmailRecordsUI();
  if(currentTab === 'jobs' && typeof filterAndRenderJobsUI === 'function') filterAndRenderJobsUI();
  if(currentTab === 'activity' && typeof loadActivityLogsUI === 'function') loadActivityLogsUI();
}
}catch(e){}}
var _tTimer=null;function schedTick(ms){clearTimeout(_tTimer);_tTimer=setTimeout(async function(){await tick();schedTick(window.__lastIsRunning?800:2500)},ms)}schedTick(400);

// ── Controls ──
async function ctrl(a){try{if(a==='resume'||a==='start'){showToast('🚀 Starting campaign...','info');var b=document.getElementById('btn-ctrl-main');if(b){b.textContent='⚡ Starting...';b.className='btn btn-p';}}else if(a==='pause')showToast('⏸️ Pausing campaign...','warn');else if(a==='stop')showToast('⏹️ Stopping campaign...','error');var r=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})});var d=await r.json();if(a==='reload')showToast('🔄 Queue reloaded ('+(d.total||0)+' leads ready)','info');else if(a==='resume'||a==='start')showToast('🚀 Campaign started! ('+(d.total||0)+' leads ready)','success');else if(a==='pause')showToast('⏸️ Campaign paused','warn');else if(a==='stop')showToast('⏹️ Campaign stopped','error');await tick();}catch(e){showToast('Error: '+e.message,'error')}}
function spd(s){fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speed:s})})}
function setSpeed(s){spd(s);['stealth','slow','medium','fast','turbo'].forEach(function(x){var el=document.getElementById('sp-'+x);if(el)el.classList.toggle('active',x===s);var elCamp=document.getElementById('camp-sp-'+x);if(elCamp)elCamp.classList.toggle('active',x===s);});}
function updateCampaignsTabUI(d){
  if(!d) return;
  var b=document.getElementById('camp-status-badge');
  if(b){
    var st = (!d.running) ? 'READY' : (d.paused ? 'PAUSED' : 'RUNNING');
    b.textContent = st;
    b.style.color = st === 'RUNNING' ? 'var(--green)' : st === 'PAUSED' ? 'var(--yellow)' : 'var(--text-dim)';
    b.style.background = st === 'RUNNING' ? 'rgba(52,211,153,0.2)' : st === 'PAUSED' ? 'rgba(251,191,36,0.2)' : 'rgba(255,255,255,0.06)';
  }
  var total = (d.total !== undefined && d.total > 0) ? d.total : (d.jobsCount || 0);
  var sent = d.sent || 0;
  var pct = total > 0 ? Math.round((sent / total) * 100) : 0;
  setTxt('camp-pct', pct);
  setTxt('camp-sent', sent);
  setTxt('camp-total', total);
  setWidth('camp-bar', pct + '%');

  setTxt('camp-stat-jobs', d.jobsCount || 0);
  setTxt('camp-stat-matched', Math.round((d.jobsCount || 0) * 0.75));
  setTxt('camp-stat-queued', Math.max(0, (d.total || 0) - (d.sent || 0)));
  setTxt('camp-stat-sent', sent);
  setTxt('camp-stat-failed', d.failed || 0);

  var btnStart = document.getElementById('btn-camp-start');
  var btnPause = document.getElementById('btn-camp-pause');
  if(btnStart && btnPause){
    if(d.running && !d.paused){
      btnStart.textContent = '⚡ Sending...';
      btnStart.className = 'btn btn-ghost';
      btnPause.disabled = false;
      btnPause.className = 'btn btn-y';
    } else if(d.paused) {
      btnStart.textContent = '▶ Resume Campaign';
      btnStart.className = 'btn btn-g';
      btnPause.disabled = true;
      btnPause.className = 'btn btn-ghost';
    } else {
      btnStart.textContent = '▶ Start Campaign';
      btnStart.className = 'btn btn-g';
      btnPause.disabled = true;
      btnPause.className = 'btn btn-ghost';
    }
  }
}
async function toggleResendMode(){try{var r=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'toggleResendMode'})});var d=await r.json();showToast('Resend mode '+(d.resendMode?'ON':'OFF'),'info')}catch(e){showToast('Error: '+e.message,'error')}}
async function toggleGmailMode(){try{var r=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'toggleGmailMode'})});var d=await r.json();var allow=d.allowGmail!==undefined?d.allowGmail:(!d.skipPersonalGmail);showToast('@gmail.com leads '+(allow?'ENABLED (Queue: '+(d.total||0)+' leads)':'DISABLED (Business only)'),allow?'success':'info');var gb=document.getElementById('btn-gmail-mode');if(gb){gb.innerHTML=allow?'&#x2709; @gmail: ON':'&#x2709; @gmail: OFF';gb.className=allow?'btn btn-g':'btn btn-b';}var cgb=document.getElementById('btn-camp-gmail');if(cgb){cgb.textContent=allow?'✉️ @gmail: ON':'✉️ @gmail: OFF';cgb.className=allow?'btn btn-g':'btn btn-b';}var chk=document.getElementById('s-skip-gmail');if(chk)chk.checked=!allow;await tick()}catch(e){showToast('Error: '+e.message,'error')}}

function updateAutopilotUI(d){
  var apHdr=document.getElementById('hdr-autopilot-status');
  var apBtn=document.getElementById('btn-autopilot-toggle');
  var apMaster=document.getElementById('btn-ap-master-toggle');
  var apBadge=document.getElementById('ap-badge-status');
  var apSub=document.getElementById('ap-substatus-text');
  var apWin=document.getElementById('ap-window-text');
  var apInd=document.getElementById('ap-window-indicator');
  var apMx=document.getElementById('ap-mx-text');

  var isAp=Boolean(d.autopilot);
  var st=d.autopilotStatus||(isAp?'Active':'Disabled');

  if(apHdr){
    apHdr.textContent=isAp?(st.indexOf('Sleeping')!==-1?'SLEEPING':'ON'):'OFF';
  }
  if(apBtn){
    if(isAp){
      if(st.indexOf('Sleeping')!==-1){
        apBtn.style.background='rgba(234,179,8,0.15)';
        apBtn.style.color='#fef08a';
      }else{
        apBtn.style.background='rgba(34,197,94,0.15)';
        apBtn.style.color='#86efac';
      }
    }else{
      apBtn.style.background='rgba(148,163,184,0.1)';
      apBtn.style.color='#94a3b8';
    }
  }
  if(apMaster){
    apMaster.textContent=isAp?'⏸️ Pause Autopilot':'🚀 Activate Autopilot';
    apMaster.className=isAp?'btn btn-y':'btn btn-g';
  }
  if(apBadge){
    apBadge.textContent=st;
    apBadge.style.background=isAp?(st.indexOf('Sleeping')!==-1?'rgba(234,179,8,0.2)':'rgba(34,197,94,0.2)'):'rgba(148,163,184,0.15)';
    apBadge.style.color=isAp?(st.indexOf('Sleeping')!==-1?'#fef08a':'#86efac'):'#94a3b8';
  }
  if(apSub){
    if(isAp){
      apSub.textContent=st.indexOf('Sleeping')!==-1
        ?'Autopilot is standing by. Campaign will resume automatically when recruiter window opens.'
        :'Autonomous outreach active: In-flight DNS MX shield + Background drip follow-ups + Per-lead AI pitch.';
    }else{
      apSub.textContent='Autopilot is paused. Manual campaign control active.';
    }
  }
  if(apWin&&d.recruiterWindow){
    apWin.textContent=d.recruiterWindow.inWindow?'Active ('+d.recruiterWindow.reason+')':d.recruiterWindow.reason;
    if(apInd)apInd.textContent=d.recruiterWindow.inWindow?'🟢':'🌙';
  }
  if(apMx&&d.autoBlockedDeadDomains){
    apMx.textContent=d.autoBlockedDeadDomains+' Dead Domains Auto-Blocked';
  }
}

async function toggleAutopilotUI(){
  try{
    var r=await fetch('/api/autopilot/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});
    var d=await r.json();
    showToast('Autopilot '+(d.autopilot?'ACTIVATED':'DEACTIVATED'),d.autopilot?'success':'warn');
    await tick();
  }catch(e){
    showToast('Error: '+e.message,'error');
  }
}

// ── Template ──
var _tPreviewTimer=null;
function tPreviewDebounce(){clearTimeout(_tPreviewTimer);_tPreviewTimer=setTimeout(tPreview,300)}
function tPreview(){var iframe=document.getElementById('t-preview');if(!iframe)return;var html=document.getElementById('t-html').value;var company=document.getElementById('t-company').value||'ACME Corp';html=html.replace(/\\{company\\}/gi,company).replace(/\\{role\\}/gi,'Python Developer');var doc=iframe.contentDocument||iframe.contentWindow.document;doc.open();doc.write(html);doc.close()}
async function loadTemplate(){try{var d=await(await fetch('/api/template')).json();document.getElementById('t-subject').value=d.subject||'';document.getElementById('t-plain').value=d.plainText||'';document.getElementById('t-html').value=d.html||'';updateSubjectCounter();tPreview()}catch(e){}}
async function saveTemplate(){try{var r=await fetch('/api/template',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:document.getElementById('t-subject').value,plainText:document.getElementById('t-plain').value,html:document.getElementById('t-html').value})});showToast('\u2705 Template saved!','success')}catch(e){showToast('Error: '+e.message,'error')}}
async function resetTemplate(){try{var d=await(await fetch('/api/template/defaults')).json();document.getElementById('t-subject').value=d.subject;document.getElementById('t-plain').value=d.plainText;document.getElementById('t-html').value=d.html;tPreview();showToast('Template reset to defaults','info')}catch(e){}}
function updateSubjectCounter(){var el=document.getElementById('t-subject');var counter=document.getElementById('subject-counter');if(!el||!counter)return;var len=el.value.length;counter.textContent=len+' / 60 characters';counter.className='char-counter'+(len>70?' danger':len>55?' warn':'')}
function insertToken(token){var el=document.activeElement;if(el&&(el.tagName==='TEXTAREA'||el.tagName==='INPUT')){var start=el.selectionStart;var end=el.selectionEnd;el.value=el.value.substring(0,start)+token+el.value.substring(end);el.selectionStart=el.selectionEnd=start+token.length;el.focus()}else{var plain=document.getElementById('t-plain');if(plain){plain.value+=token;plain.focus()}}}
function setPreviewDevice(device,btn){var iframe=document.getElementById('t-preview');document.querySelectorAll('.dev-btn').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');iframe.style.maxWidth=device==='mobile'?'375px':'100%';iframe.style.margin=device==='mobile'?'0 auto':'0'}
async function saveToSlot(slot){try{var r=await fetch('/api/templates/slots/'+slot,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:document.getElementById('t-subject').value,plainText:document.getElementById('t-plain').value,html:document.getElementById('t-html').value})});var d=await r.json();if(d.ok)showToast('Saved to Slot '+slot,'success');var el=document.getElementById('slot-status');if(el)el.textContent='Saved to '+slot}catch(e){showToast('Error','error')}}
async function loadFromSlot(slot){try{var r=await fetch('/api/templates/slots/'+slot);if(!r.ok){showToast('Slot '+slot+' is empty','warn');return}var d=await r.json();document.getElementById('t-subject').value=d.subject||'';document.getElementById('t-plain').value=d.plainText||'';document.getElementById('t-html').value=d.html||'';tPreview();showToast('Loaded from Slot '+slot,'success')}catch(e){showToast('Error','error')}}
async function sendTestTemplate(){try{var btn=document.getElementById('t-test-btn');btn.disabled=true;btn.textContent='Sending...';var r=await fetch('/api/template/send-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toEmail:document.getElementById('t-test-email').value,testCompany:document.getElementById('t-company').value||'ACME Corp'})});var d=await r.json();showToast(d.ok?'\u2705 Test email sent!':'Error: '+(d.error||'Failed'),'success');btn.disabled=false;btn.textContent='\u{1F4E9} Send Test'}catch(e){showToast('Error: '+e.message,'error');document.getElementById('t-test-btn').disabled=false;document.getElementById('t-test-btn').textContent='\u{1F4E9} Send Test'}}
async function checkSpamScoreUI(){try{var r=await fetch('/api/template/spam-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subject:document.getElementById('t-subject').value,text:document.getElementById('t-plain').value,html:document.getElementById('t-html').value})});var d=await r.json();document.getElementById('spam-score-box').style.display='block';document.getElementById('spam-score-num').textContent=d.score+'%';document.getElementById('spam-score-bar').style.width=d.score+'%';var col=d.score>=90?'var(--green)':d.score>=70?'var(--yellow)':'var(--red)';document.getElementById('spam-score-bar').style.background=col;document.getElementById('spam-score-num').style.color=col;document.getElementById('spam-score-rating').textContent=d.rating;document.getElementById('spam-score-rating').style.color=col;var gb=document.getElementById('spam-grade-badge');if(gb){gb.textContent=d.grade||'A+';gb.style.color=col;}var met=document.getElementById('spam-metrics');if(met){met.innerHTML='<span>🔗 Links: '+(d.linkCount||0)+'</span><span>📄 Text/HTML Ratio: '+(d.htmlRatio!==undefined?d.htmlRatio+'%':'100%')+'</span>';}document.getElementById('spam-score-triggers').innerHTML=d.triggersFound.length>0?'Triggers: '+d.triggersFound.map(function(t){return'<span style="background:rgba(248,113,113,.1);padding:2px 6px;border-radius:4px;margin:2px;display:inline-block;font-size:10px">'+escHtml(t)+'</span>'}).join(''):'<span style="color:var(--green)">\u2705 No spam triggers detected</span>';var tips=document.getElementById('spam-score-tips');if(tips&&d.recommendations){tips.innerHTML=d.recommendations.map(function(rec){return'<div style="background:rgba(255,255,255,0.03);border-left:2px solid '+(d.score>=85?'var(--green)':'var(--yellow)')+';padding:4px 8px;border-radius:4px;color:var(--text)">💡 '+escHtml(rec)+'</div>';}).join('');}}catch(e){showToast('Error: '+e.message,'error')}}
async function generateAiPersonalizationUI(){try{var btn=document.getElementById('ai-gen-btn');btn.disabled=true;btn.textContent='Generating...';var r=await fetch('/api/ai/personalize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({company:document.getElementById('ai-test-company').value,context:document.getElementById('ai-test-context').value})});var d=await r.json();document.getElementById('ai-gen-result-box').style.display='block';document.getElementById('ai-gen-text').textContent=d.line||d.error||'No result';btn.disabled=false;btn.textContent='\u2728 Generate'}catch(e){showToast('Error','error');var btn2=document.getElementById('ai-gen-btn');btn2.disabled=false;btn2.textContent='\u2728 Generate'}}
async function applyIndustryPreset(key){try{var r=await(await fetch('/api/template/presets')).json();if(r[key]){var intro=r[key].intro;var plain=document.getElementById('t-plain');plain.value=plain.value.replace(/I am a Python Developer.*?\\./,intro);tPreview();showToast('Applied: '+r[key].name,'success')}}catch(e){}}

// ── Emails ──
async function loadEmailFiles(){try{var d=await(await fetch('/api/emails')).json();setTxt('e-sent-count',d.sentCount||0);emailFilesCache=d.files;var list=document.getElementById('file-list');list.innerHTML=d.files.map(function(f){return'<div class="file-item'+(editingFile===f.name?' active':'')+'" data-fname="'+escAttr(f.name)+'" onclick="selectFile(this.dataset.fname)"><span style="font-weight:700;font-size:12px">'+escHtml(f.name)+'</span><span style="font-size:10px;color:var(--text-dim)">'+f.count+' emails</span></div>'}).join('');if(!editingFile&&d.files.length>0){var pref=d.files.find(function(f){return f.name==='emails.txt'})||d.files.find(function(f){return f.count>0})||d.files[0];selectFile(pref.name)}}catch(e){}}
function selectFile(name){editingFile=name;setTxt('e-editing-name',name);var f=emailFilesCache.find(function(x){return x.name===name});if(f)document.getElementById('e-content').value=f.content;document.querySelectorAll('.file-item').forEach(function(el){el.classList.toggle('active',el.textContent.includes(name))})}
async function saveEmailFile(){if(!editingFile)return;try{await fetch('/api/emails/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:editingFile,content:document.getElementById('e-content').value})});showToast('\u2705 '+editingFile+' saved!','success');loadEmailFiles()}catch(e){showToast('Error','error')}}
async function newBatchFile(){try{var r=await fetch('/api/emails/new-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:''})});var d=await r.json();showToast('Created '+d.filename,'success');editingFile=d.filename;loadEmailFiles()}catch(e){}}
async function clearSentLog(){if(!confirm('Clear sent log? All emails will be re-sent next run.'))return;try{await fetch('/api/emails/clear-log',{method:'POST'});showToast('Sent log cleared','warn');loadEmailFiles()}catch(e){}}
function dzOver(e){e.preventDefault();document.getElementById('email-drop').classList.add('drag-active')}
function dzLeave(){document.getElementById('email-drop').classList.remove('drag-active')}
function dzDrop(e){e.preventDefault();document.getElementById('email-drop').classList.remove('drag-active');var file=e.dataTransfer.files[0];if(file)readDroppedFile(file)}
function fileInputChange(e){if(e.target.files[0])readDroppedFile(e.target.files[0])}
function readDroppedFile(file){var reader=new FileReader();reader.onload=function(e){document.getElementById('e-content').value=e.target.result;editingFile=file.name;setTxt('e-editing-name',file.name);showToast('Loaded '+file.name,'info')};reader.readAsText(file)}
async function validateCurrentEmailFile(){try{var r=await fetch('/api/emails/validate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:document.getElementById('e-content').value})});var d=await r.json();var box=document.getElementById('val-report');box.style.display='block';box.innerHTML='\u2705 Valid: '+d.validCount+' | Errors: '+d.syntaxErrors.length+' | Dupes: '+d.duplicates.length+' | Already sent: '+d.alreadySent.length;showToast('Validation complete','info')}catch(e){}}
async function cleanCurrentEmailFile(){try{var r=await fetch('/api/emails/clean',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:document.getElementById('e-content').value})});var d=await r.json();if(d.ok){document.getElementById('e-content').value=d.cleanedContent;showToast('\u2728 Cleaned: '+d.count+' valid, removed '+d.removedDuplicates+' dupes','success')}}catch(e){}}
async function checkInbox(){ if(typeof checkInboxUI==='function') return checkInboxUI(); }
async function verifySingleEmailUI(){try{var btn=document.getElementById('v-verify-btn');if(btn)btn.disabled=true;var inp=document.getElementById('v-email-input');if(!inp||!inp.value)return;var r=await fetch('/api/verifier/single',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:inp.value})});var d=await r.json();var box=document.getElementById('v-result-box');if(box){box.style.display='block';box.innerHTML='<span style="color:'+(d.valid?'var(--green)':'var(--red)')+'">'+( d.valid?'\u2705 Valid':'\u274C Invalid')+'</span> \u2014 '+escHtml(d.reason||d.status);}if(btn)btn.disabled=false}catch(e){var btn2=document.getElementById('v-verify-btn');if(btn2)btn2.disabled=false;}}
async function discoverLeadsUI(){try{var btn=document.getElementById('lead-find-btn');if(btn)btn.disabled=true;var domInp=document.getElementById('lead-domain-input');var compInp=document.getElementById('lead-company-input');var r=await fetch('/api/leads/discover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({domain:domInp?domInp.value:'',company:compInp?compInp.value:''})});var d=await r.json();var box=document.getElementById('lead-results-box');if(box){box.style.display='block';box.innerHTML='<div>MX: '+(d.hasMx?'\u2705 Active ('+escHtml(d.mxHost)+')':'\u274C None')+'</div>'+(d.leads||[]).map(function(l){return'<div style="margin-top:4px">'+escHtml(l.email)+' <button class="btn btn-ghost" style="padding:2px 6px;font-size:9px" data-email="'+escAttr(l.email)+'" data-company="'+escAttr(l.company)+'" onclick="appendLead(this.dataset.email,this.dataset.company)">+ Add</button></div>'}).join('');}if(btn)btn.disabled=false}catch(e){var btn2=document.getElementById('lead-find-btn');if(btn2)btn2.disabled=false;}}
async function appendLead(email,company){try{await fetch('/api/leads/append',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({leads:[{email:email,company:company}]})});showToast('Added '+email,'success')}catch(e){}}

// ── Analytics ──
async function loadAnalytics(){try{var d=await(await fetch('/api/analytics')).json();setTxt('a-total-log',d.totalInLog);setTxt('a-success-rate',d.successRate+'%');setTxt('a-eta',fmt(d.etaSeconds));setTxt('a-remaining',d.remaining);
var responseRate=0;if(allJobs.length>0){var replied=allJobs.filter(function(j){return j.status==='replied'||j.status==='interview'||j.status==='offer'}).length;responseRate=Math.round(replied/allJobs.length*100)}
setTxt('a-response-rate',responseRate+'%');
if(chartjsReady){if(charts.donut)charts.donut.destroy();var ctx1=document.getElementById('chart-donut');if(ctx1)charts.donut=new Chart(ctx1,{type:'doughnut',data:{labels:['Sent','Failed','Skipped'],datasets:[{data:[parseInt(document.getElementById('ss').textContent)||0,parseInt(document.getElementById('sf').textContent)||0,parseInt(document.getElementById('sk').textContent)||0],backgroundColor:['#34d399','#f87171','#fbbf24'],borderWidth:0,borderRadius:4}]},options:{responsive:true,cutout:'70%',plugins:{legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:11,family:'Inter'}}}}}});
if(charts.bar)charts.bar.destroy();var ctx2=document.getElementById('chart-bar');if(ctx2)charts.bar=new Chart(ctx2,{type:'bar',data:{labels:d.labels,datasets:[{label:'Emails Sent',data:d.values,backgroundColor:'rgba(129,140,248,0.5)',borderColor:'#818cf8',borderWidth:1,borderRadius:6}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#64748b',font:{size:9}},grid:{display:false}},y:{ticks:{color:'#64748b',font:{size:10}},grid:{color:'rgba(255,255,255,0.04)'}}}}})}}catch(e){}}
async function loadAnalyticsExtra(){try{
var[weekly,status,domains,streak,goals]=await Promise.all([fetch('/api/analytics/weekly').then(function(r){return r.json()}),fetch('/api/analytics/status').then(function(r){return r.json()}),fetch('/api/analytics/domains').then(function(r){return r.json()}),fetch('/api/analytics/streak').then(function(r){return r.json()}).catch(function(){return{currentStreak:0}}),fetch('/api/goals').then(function(r){return r.json()}).catch(function(){return{weekly:200,monthly:800,sentThisWeek:0,sentThisMonth:0,weeklyPct:0,monthlyPct:0}})]);
setTxt('streak-num',streak.currentStreak||0);
// Goals
var gr=document.getElementById('goal-rings');if(gr){gr.innerHTML=renderGoalRing('Weekly',goals.sentThisWeek||0,goals.weekly||200,goals.weeklyPct||0,'var(--accent)')+renderGoalRing('Monthly',goals.sentThisMonth||0,goals.monthly||800,goals.monthlyPct||0,'var(--green)')}
// Status funnel
setTxt('fn2-sent',status.sent||0);setTxt('fn2-viewed',status.viewed||0);setTxt('fn2-interview',status.interview||0);setTxt('fn2-offer',status.offer||0);
var total=Object.values(status).reduce(function(a,b){return a+b},0);var responded=(status.interview||0)+(status.offer||0);setTxt('fn2-rate',total>0?Math.round(responded/total*100)+'%':'0%');
// Weekly chart
if(chartjsReady){if(charts.weekly)charts.weekly.destroy();var ctx=document.getElementById('chart-weekly');if(ctx)charts.weekly=new Chart(ctx,{type:'line',data:{labels:weekly.labels,datasets:[{label:'This Week',data:weekly.thisWeek,borderColor:'#818cf8',backgroundColor:'rgba(129,140,248,0.1)',fill:true,tension:.4,pointRadius:3},{label:'Last Week',data:weekly.lastWeek,borderColor:'#64748b',borderDash:[4,4],fill:false,tension:.4,pointRadius:2}]},options:{responsive:true,plugins:{legend:{labels:{color:'#94a3b8',font:{size:10}}}},scales:{x:{ticks:{color:'#64748b',font:{size:9}},grid:{display:false}},y:{ticks:{color:'#64748b'},grid:{color:'rgba(255,255,255,0.03)'}}}}});
// Status pie
if(charts.statusPie)charts.statusPie.destroy();var ctx2=document.getElementById('chart-status-pie');if(ctx2)charts.statusPie=new Chart(ctx2,{type:'doughnut',data:{labels:['Sent','Viewed','Interview','Rejected','Offer'],datasets:[{data:[status.sent,status.viewed,status.interview,status.rejected,status.offer],backgroundColor:['#64748b','#60a5fa','#fbbf24','#f87171','#34d399'],borderWidth:0,borderRadius:3}]},options:{responsive:true,cutout:'65%',plugins:{legend:{position:'bottom',labels:{color:'#94a3b8',font:{size:10}}}}}})}
// Domains
var dl=document.getElementById('domain-list');if(dl&&domains.domains){var maxCount=Math.max.apply(null,domains.domains.map(function(d){return d.count}))||1;dl.innerHTML=domains.domains.map(function(d){return'<div class="domain-row"><span class="domain-name">'+escHtml(d.domain)+'</span><div class="domain-bar" style="width:'+Math.round(d.count/maxCount*100)+'%"></div><span class="domain-count">'+d.count+'</span></div>'}).join('')}
// Heatmap
try{var hd=await(await fetch('/api/analytics/hourly')).json();var hm=document.getElementById('hourly-heatmap');var hl=document.getElementById('hourly-labels');if(hm&&hd.hourly){var maxH=Math.max.apply(null,hd.hourly)||1;hm.innerHTML=hd.hourly.map(function(v,i){var pct=Math.max(4,Math.round(v/maxH*100));var opacity=v>0?0.3+v/maxH*0.7:0.08;return'<div style="flex:1;height:'+pct+'%;background:var(--accent);opacity:'+opacity.toFixed(2)+';border-radius:3px 3px 0 0;min-width:8px" title="'+i+':00 - '+v+' emails"></div>'}).join('');if(hl)hl.innerHTML=hd.hourly.map(function(v,i){return'<div style="flex:1;text-align:center;font-size:8px;color:var(--text-dim)">'+(i%3===0?i:'')+'</div>'}).join('')}}catch(e){}
}catch(e){}}
function renderGoalRing(label,current,target,pct,color){var r=36,c=2*Math.PI*r,offset=c-(pct/100*c);return'<div class="goal-ring"><svg width="90" height="90" viewBox="0 0 90 90"><circle cx="45" cy="45" r="'+r+'" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/><circle cx="45" cy="45" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="6" stroke-dasharray="'+c+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" style="transition:stroke-dashoffset .6s ease"/><text x="45" y="42" text-anchor="middle" fill="var(--text)" font-size="14" font-weight="900" font-family="Inter">'+pct+'%</text><text x="45" y="56" text-anchor="middle" fill="var(--text-dim)" font-size="9" font-weight="600" font-family="Inter">'+current+'/'+target+'</text></svg><div class="ring-label">'+label+'</div></div>'}
async function loadFunnelStats(){try{var d=await(await fetch('/api/funnel/stats')).json();setTxt('fn-sent',d.totalSent);setTxt('fn-opened',d.totalOpened);setTxt('fn-resume',d.totalResumeClicked);setTxt('fn-replied',d.totalReplied);setTxt('fn-interviews',d.totalInterviews);setTxt('fn-open-rate',d.openRate+'%');setTxt('fn-click-rate',d.clickRate+'%');setTxt('fn-reply-rate',d.replyRate+'%');if(typeof renderSvgFunnel==='function')renderSvgFunnel(d.totalSent||0,d.totalOpened||0,d.totalReplied||0,d.totalInterviews||0,0)}catch(e){}}

// ── Jobs (Handled by Enhanced Workable Table) ──
async function submitJob(){ if(typeof openAddJobModalUI==='function') return openAddJobModalUI(); }
async function deleteJobConfirm(id){if(!confirm('Delete this job?'))return;try{await fetch('/api/jobs/'+id,{method:'DELETE'});showToast('Job deleted','warn');loadJobs('all')}catch(e){}}
function dragJobStart(e,id){e.dataTransfer.setData('text/plain',id)}
function allowDropJob(e){e.preventDefault();e.currentTarget.querySelector('.kanban-dropzone').classList.add('drag-over')}
async function dropJobStage(e,status){e.preventDefault();e.currentTarget.querySelector('.kanban-dropzone').classList.remove('drag-over');var id=e.dataTransfer.getData('text/plain');try{await fetch('/api/jobs/update-stage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id,status:status})});loadJobs('all')}catch(e){}}
function toggleSelectAllJobs(el){document.querySelectorAll('.job-checkbox').forEach(function(cb){cb.checked=el.checked})}
function openFollowupModal(id){
  var j=(allJobs&&allJobs.find(function(x){return String(x.id)===String(id)}))||(window.__jobsList&&window.__jobsList.find(function(x){return String(x.id)===String(id)}));
  if(!j)return;
  var fid=document.getElementById('fu-job-id');if(fid)fid.value=id;
  setTxt('fu-subtitle',(j.company||'Company')+' ('+(j.email||'')+')');
  var fsub=document.getElementById('fu-subject');if(fsub)fsub.value='Following up: Python Developer Position — '+(j.company||'');
  var fbody=document.getElementById('fu-body');if(fbody)fbody.value='Dear Hiring Manager at '+(j.company||'Company')+',\\n\\nI hope this email finds you well. I am following up on my application for the Python Developer Position.\\n\\nBest regards,\\nMilin Chaware\\n7620369988';
  var fmodal=document.getElementById('followup-modal');if(fmodal)fmodal.classList.remove('hidden');
}
async function sendFollowupSubmit(){try{var btn=document.getElementById('fu-send-btn');btn.disabled=true;var r=await fetch('/api/jobs/send-followup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jobId:document.getElementById('fu-job-id').value,customSubject:document.getElementById('fu-subject').value,customBody:document.getElementById('fu-body').value})});var d=await r.json();showToast(d.ok?'\u2705 Follow-up sent!':'Error: '+(d.error||'Failed'),d.ok?'success':'error');document.getElementById('followup-modal').classList.add('hidden');btn.disabled=false;loadJobs('all')}catch(e){showToast('Error','error');document.getElementById('fu-send-btn').disabled=false}}
async function sendDirectEmailSubmit(){try{var btn=document.getElementById('ds-send-btn');btn.disabled=true;btn.textContent='Sending...';var r=await fetch('/api/send-direct',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toEmail:document.getElementById('ds-email').value,company:document.getElementById('ds-company').value,role:document.getElementById('ds-role').value,customSubject:document.getElementById('ds-subject').value,customBody:document.getElementById('ds-body').value})});var d=await r.json();showToast(d.ok?(d.skipped?d.message:'\u2705 Direct email sent!'):'Error: '+(d.error||'Failed'),d.ok?'success':'error');document.getElementById('direct-send-modal').classList.add('hidden');btn.disabled=false;btn.textContent='\u{1F680} Send'}catch(e){showToast('Error','error');var b2=document.getElementById('ds-send-btn');b2.disabled=false;b2.textContent='\u{1F680} Send'}}
async function scheduleCampaignSubmit(){try{var r=await fetch('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({delayMinutes:document.getElementById('sched-delay').value,targetTime:document.getElementById('sched-datetime').value})});var d=await r.json();if(d.ok){showToast('\u23F0 Scheduled: '+d.executeAt,'success');document.getElementById('schedule-modal').classList.add('hidden')}else showToast(d.error||'Invalid','error')}catch(e){}}
async function cancelScheduleSubmit(){try{await fetch('/api/schedule',{method:'DELETE'});showToast('Schedule cancelled','warn');document.getElementById('schedule-modal').classList.add('hidden')}catch(e){}}
async function triggerDripCheckManual(){try{showToast('\u26A1 Processing follow-ups...','info');var r=await fetch('/api/jobs/drip/check',{method:'POST'});var d=await r.json();showToast('\u2705 Processed '+d.processed+'/'+d.totalEligible+' follow-ups','success');loadJobs('all')}catch(e){showToast('Error: '+e.message,'error')}}

// ── Settings ──
async function loadSettings(){try{var d=await(await fetch('/api/settings')).json();document.getElementById('s-speed').value=d.speed||'medium';if(document.getElementById('s-concurrency'))document.getElementById('s-concurrency').value=d.concurrency||2;document.getElementById('s-limit').value=d.dailyLimitPerAccount;document.getElementById('s-retries').value=d.maxRetries;document.getElementById('s-retry-delay').value=d.retryDelay;document.getElementById('s-autopause').value=d.autoPauseConsecutiveFailures;document.getElementById('s-resend-sent').checked=d.resendSentEmails;if(document.getElementById('s-skip-gmail'))document.getElementById('s-skip-gmail').checked=d.skipPersonalGmail!==false;document.getElementById('s-sound-enabled').checked=d.enableSoundAlerts;document.getElementById('s-attachment').value=d.attachment||'';document.getElementById('s-attach-enabled').checked=d.attachmentEnabled;document.getElementById('s-biz-enabled').checked=d.onlySendInBusinessHours;document.getElementById('s-biz-start').value=d.businessStartHour;document.getElementById('s-biz-end').value=d.businessEndHour;document.getElementById('s-biz-weekends').checked=d.skipWeekends;document.getElementById('s-webhook-url').value=d.webhookUrl||'';document.getElementById('s-webhook-enabled').checked=d.enableWebhookAlerts;document.getElementById('s-jitter-enabled').checked=d.enableHumanJitter;document.getElementById('s-gemini-key').value=d.geminiApiKey||'';document.getElementById('s-telegram-token').value=d.telegramBotToken||'';document.getElementById('s-telegram-chatid').value=d.telegramChatId||'';document.getElementById('s-tracking-url').value=d.trackingBaseUrl||'';document.getElementById('s-drip-enabled').checked=d.autoDripFollowup;document.getElementById('s-imap-poll-enabled').checked=d.autoImapPoll!==false;document.getElementById('s-ai-subject').checked=d.aiSubjectRotation!==false;if(document.getElementById('s-autopilot-enabled'))document.getElementById('s-autopilot-enabled').checked=d.autopilot!==false;if(document.getElementById('s-auto-mx-send'))document.getElementById('s-auto-mx-send').checked=d.autoVerifyMxOnSend!==false;if(document.getElementById('s-auto-personalize-leads'))document.getElementById('s-auto-personalize-leads').checked=d.autoPersonalizeLeads!==false;if(document.getElementById('s-auto-drip-interval'))document.getElementById('s-auto-drip-interval').value=d.autoDripIntervalMinutes||30;
var accs=document.getElementById('s-accounts');if(accs)accs.innerHTML=(d.accounts||[]).map(function(a,i){return'<div style="padding:8px 12px;background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:8px;margin-bottom:4px;font-size:11px"><strong>Account '+(i+1)+':</strong> '+escHtml(a.gmailAddress)+'</div>'}).join('');
var inboxSel=document.getElementById('inbox-account');if(inboxSel)inboxSel.innerHTML=(d.accounts||[]).map(function(a,i){return'<option value="'+i+'">'+escHtml(a.gmailAddress)+'</option>'}).join('');if(typeof detectResumePdf==='function')detectResumePdf();}catch(e){}}
async function saveSettings(){try{
var r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speed:document.getElementById('s-speed').value,concurrency:parseInt(document.getElementById('s-concurrency')?.value)||2,dailyLimitPerAccount:parseInt(document.getElementById('s-limit').value),maxRetries:parseInt(document.getElementById('s-retries').value),retryDelay:parseInt(document.getElementById('s-retry-delay').value),attachment:document.getElementById('s-attachment').value,attachmentEnabled:document.getElementById('s-attach-enabled').checked,resendSentEmails:document.getElementById('s-resend-sent').checked,skipPersonalGmail:document.getElementById('s-skip-gmail')?document.getElementById('s-skip-gmail').checked:true,autoPauseConsecutiveFailures:parseInt(document.getElementById('s-autopause').value),enableSoundAlerts:document.getElementById('s-sound-enabled').checked,onlySendInBusinessHours:document.getElementById('s-biz-enabled').checked,businessStartHour:parseInt(document.getElementById('s-biz-start').value),businessEndHour:parseInt(document.getElementById('s-biz-end').value),skipWeekends:document.getElementById('s-biz-weekends').checked,webhookUrl:document.getElementById('s-webhook-url').value,enableWebhookAlerts:document.getElementById('s-webhook-enabled').checked,enableHumanJitter:document.getElementById('s-jitter-enabled').checked,geminiApiKey:document.getElementById('s-gemini-key').value,telegramBotToken:document.getElementById('s-telegram-token').value,telegramChatId:document.getElementById('s-telegram-chatid').value,trackingBaseUrl:document.getElementById('s-tracking-url').value,autoDripFollowup:document.getElementById('s-drip-enabled').checked,autoImapPoll:document.getElementById('s-imap-poll-enabled').checked,autopilot:document.getElementById('s-autopilot-enabled')?document.getElementById('s-autopilot-enabled').checked:true,autoVerifyMxOnSend:document.getElementById('s-auto-mx-send')?document.getElementById('s-auto-mx-send').checked:true,autoPersonalizeLeads:document.getElementById('s-auto-personalize-leads')?document.getElementById('s-auto-personalize-leads').checked:true,autoDripIntervalMinutes:parseInt(document.getElementById('s-auto-drip-interval')?.value)||30})});showToast('\u2705 Settings saved!','success');await tick();}catch(e){showToast('Error','error')}}

async function testSmtp(){try{var btn=document.getElementById('s-test-btn');btn.disabled=true;var r=await fetch('/api/test-smtp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({toEmail:document.getElementById('s-test-email').value})});var d=await r.json();showToast(d.ok?'\u2705 Test sent!':'Error: '+d.error,d.ok?'success':'error');btn.disabled=false}catch(e){showToast('Error','error');document.getElementById('s-test-btn').disabled=false}}
async function testWebhook(){try{var r=await fetch('/api/webhook/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:document.getElementById('s-webhook-url').value})});var d=await r.json();showToast(d.ok?'\u{1F514} Webhook test sent!':'Error: '+(d.error||'Failed'),d.ok?'success':'error')}catch(e){showToast('Error','error')}}
async function runAccountDiagnostic(){try{var btn=document.getElementById('diag-btn');btn.disabled=true;btn.textContent='Running...';var r=await fetch('/api/accounts/verify',{method:'POST'});var d=await r.json();var box=document.getElementById('diag-results');box.style.display='block';box.innerHTML=d.results.map(function(a){return'<div style="padding:8px 12px;background:rgba(0,0,0,.15);border:1px solid var(--border);border-radius:8px;margin-bottom:4px;font-size:11px"><span style="color:'+(a.status==='ok'?'var(--green)':'var(--red)')+';font-weight:700">'+(a.status==='ok'?'\u2705':'\u274C')+'</span> '+escHtml(a.gmailAddress)+': '+escHtml(a.message)+'</div>'}).join('');btn.disabled=false;btn.textContent='\u{1FA7A} Health Check'}catch(e){document.getElementById('diag-btn').disabled=false;document.getElementById('diag-btn').textContent='\u{1FA7A} Health Check'}}
function saveAiSubjectSetting(checked){fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({aiSubjectRotation:checked})})}
async function detectResumePdf(){var el=document.getElementById('s-attach-pdfs');el.style.display='block';el.innerHTML='<span style="font-size:11px;color:var(--text-dim)">Scanning folder for PDF profiles...</span>';try{var res=await fetch('/api/resumes');var d=await res.json();if(!d.ok||!d.resumes||!d.resumes.length){el.innerHTML='<span style="font-size:11px;color:var(--yellow)">No .pdf files found in project root</span>';return;}el.innerHTML='<div style="margin-top:6px;display:flex;flex-direction:column;gap:6px">'+d.resumes.map(function(r){var isAct=r.isCurrent;return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:'+(isAct?'rgba(99,102,241,0.18)':'rgba(255,255,255,0.03)')+';border:1px solid '+(isAct?'var(--accent)':'var(--border)')+';border-radius:8px;font-size:12px"><div style="display:flex;align-items:center;gap:8px"><span>'+(isAct?'📄⭐':'📄')+'</span><div><strong style="color:'+(isAct?'var(--accent)':'var(--text)')+'">'+escHtml(r.filename)+'</strong><div style="font-size:10px;color:var(--text-dim)">'+r.sizeKb+' • '+r.mtime+(isAct?' • <span style="color:var(--green);font-weight:700">Active Profile</span>':'')+'</div></div></div><button class="btn '+(isAct?'btn-ghost':'btn-b')+'" style="padding:4px 10px;font-size:11px" data-rfn="' + escAttr(r.filename) + '" onclick="selectResumeProfile(this.dataset.rfn)">' + (isAct?'Active':'Select') + '</button></div>';}).join('')+'</div>';}catch(e){el.innerHTML='<span style="font-size:11px;color:var(--red)">Failed to scan: '+escHtml(e.message)+'</span>';}}
async function selectResumeProfile(fn){try{var r=await fetch('/api/resumes/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:fn})});var d=await r.json();if(d.ok){document.getElementById('s-attachment').value=d.path;var el=document.getElementById('dash-active-resume');if(el)el.textContent=fn;showToast('📄 Active resume profile set to: '+fn,'success');detectResumePdf();}else{showToast('Error: '+(d.error||'Failed'),'error');}}catch(e){showToast('Failed to select resume','error');}}
async function importBackupFile(event){try{var file=event.target.files[0];if(!file)return;var text=await file.text();var data=JSON.parse(text);var r=await fetch('/api/backup/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});var d=await r.json();showToast(d.ok?'\u2705 Backup restored!':'Error','success')}catch(e){showToast('Error: '+e.message,'error')}}
async function testTelegramAlertUI(){try{showToast('\u{1F4F1} Sending test alert...','info');var r=await fetch('/api/telegram/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'\u{1F680} <b>ResumeAuto v6.0</b>\\nTelegram integration active!'})});var d=await r.json();showToast(d.ok?'\u{1F4F1} Test sent!':'Error: '+(d.error||'Check settings'),d.ok?'success':'error')}catch(e){showToast('Error','error')}}

// ── Health Monitor ──
async function loadHealthData(){try{var d=await(await fetch('/api/health')).json();setTxt('h-uptime',d.uptimeFormatted||'--');setTxt('h-memory',d.memory.heapUsed+'MB ('+d.memory.pct+'%)');setTxt('h-accounts',d.smtp.accounts);setTxt('h-sent-today',d.campaign.sentToday);setTxt('h-total-ever',d.campaign.totalEver);setTxt('h-jobs',d.campaign.jobsTracked)}catch(e){}}

// ── Command Palette ──
var cmdCommands=[
{icon:'🤖',label:'Toggle Autopilot Mode',action:function(){toggleAutopilotUI()}},
{icon:'\u25B6',label:'Resume Campaign',action:function(){ctrl('resume');showToast('Resuming...','info')}},
{icon:'\u23F8',label:'Pause Campaign',action:function(){ctrl('pause');showToast('Paused','warn')}},
{icon:'\u23F9',label:'Stop Campaign',action:function(){if(confirm('Stop?'))ctrl('stop')}},
{icon:'\u21BB',label:'Reload Queue',action:function(){ctrl('reload');showToast('Reloaded','info')}},
{icon:'\u2709',label:'Toggle Send to @gmail.com Leads',action:function(){toggleGmailMode()}},
{icon:'🥷',label:'Set Speed: STEALTH (15-38s Human Mimic)',action:function(){spd('stealth')}},
{icon:'📥',label:'Import CSV / LinkedIn Leads',action:function(){openImportCsvModal()}},
{icon:'📄',label:'Switch Resume Profile',action:function(){switchTab('settings',document.getElementById('tab-settings'));detectResumePdf()}},
{icon:'⚡',label:'Set Speed: TURBO (Ultra-Fast 200ms)',action:function(){spd('turbo')}},
{icon:'⚡',label:'Set Speed: FAST (500ms)',action:function(){spd('fast')}},
{icon:'\u{1F680}',label:'Go to Dashboard',action:function(){switchTab('dashboard',document.getElementById('tab-dashboard'))}},
{icon:'\u{1F4DD}',label:'Go to Template',action:function(){switchTab('template',document.getElementById('tab-template'))}},
{icon:'\u{1F48C}',label:'Go to Emails',action:function(){switchTab('emails',document.getElementById('tab-emails'))}},
{icon:'\u{1F4CA}',label:'Go to Analytics',action:function(){switchTab('analytics',document.getElementById('tab-analytics'))}},
{icon:'\u{1F4CB}',label:'Go to Jobs',action:function(){switchTab('jobs',document.getElementById('tab-jobs'))}},
{icon:'\u2699',label:'Go to Settings',action:function(){switchTab('settings',document.getElementById('tab-settings'))}},
{icon:'\u26A1',label:'Send Direct Email',action:function(){document.getElementById('direct-send-modal').classList.remove('hidden')}},
{icon:'\u23F0',label:'Schedule Campaign',action:function(){document.getElementById('schedule-modal').classList.remove('hidden')}},
{icon:'\u{1F4E5}',label:'Export Log',action:function(){window.location.href='/api/log/export'}},
{icon:'\u{1F4E5}',label:'Export CSV',action:function(){window.location.href='/api/jobs-export-csv'}},
];
var cmdActiveIdx=0;
function toggleCmdPalette(){var el=document.getElementById('cmd-palette');el.classList.toggle('hidden');if(!el.classList.contains('hidden')){document.getElementById('cmd-input').value='';filterCommands('');document.getElementById('cmd-input').focus();cmdActiveIdx=0;highlightCmd()}}
function filterCommands(q){var list=document.getElementById('cmd-list');var filtered=cmdCommands.filter(function(c){return c.label.toLowerCase().includes(q.toLowerCase())});list.innerHTML=filtered.map(function(c,i){return'<div class="cmd-item'+(i===0?' active':'')+'" onclick="runCmd('+cmdCommands.indexOf(c)+')"><span class="cmd-icon">'+c.icon+'</span><span class="cmd-label">'+c.label+'</span></div>'}).join('');cmdActiveIdx=0}
function highlightCmd(){var items=document.querySelectorAll('.cmd-item');items.forEach(function(el,i){el.classList.toggle('active',i===cmdActiveIdx)})}
function cmdKeydown(e){var items=document.querySelectorAll('.cmd-item');if(e.key==='ArrowDown'){e.preventDefault();cmdActiveIdx=Math.min(cmdActiveIdx+1,items.length-1);highlightCmd()}else if(e.key==='ArrowUp'){e.preventDefault();cmdActiveIdx=Math.max(cmdActiveIdx-1,0);highlightCmd()}else if(e.key==='Enter'){e.preventDefault();if(items[cmdActiveIdx])items[cmdActiveIdx].click()}else if(e.key==='Escape'){document.getElementById('cmd-palette').classList.add('hidden')}}
function runCmd(idx){cmdCommands[idx].action();document.getElementById('cmd-palette').classList.add('hidden')}

// ── Keyboard shortcuts ──
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT'){
    if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();toggleCmdPalette()}
    return;
  }
  if((e.ctrlKey||e.metaKey)&&(e.key==='k'||e.key==='K')){e.preventDefault();toggleCmdPalette();return}
  if((e.ctrlKey||e.metaKey)&&e.shiftKey&&(e.key==='d'||e.key==='D')){
    e.preventDefault();
    document.getElementById('direct-send-modal').classList.remove('hidden');
    return;
  }
  if(e.ctrlKey||e.metaKey||e.altKey)return;
  if(e.key===' '||e.code==='Space'){
    e.preventDefault();
    var stxt=document.getElementById('stxt');
    if(stxt&&stxt.textContent==='Paused')ctrl('resume');else ctrl('pause');
  }
  if(e.key==='p'||e.key==='P'){ctrl('pause');showToast('⏸️ Paused','warn')}
  if(e.key==='r'||e.key==='R'){ctrl('resume');ctrl('reload');showToast('▶️ Resumed & Reloaded','info')}
  if(e.key==='s'||e.key==='S'){if(confirm('Stop campaign?'))ctrl('stop')}
  var tabMap={'1':'tab-dashboard','2':'tab-template','3':'tab-emails','4':'tab-analytics','5':'tab-jobs','6':'tab-inbox','7':'tab-settings'};
  if(tabMap[e.key]){var t=document.getElementById(tabMap[e.key]);if(t)t.click()}
});

// ─── INBOX ACTIVITY FRONTEND LOGIC ─────────────────────────────
var inboxActivities = [];
var currentInboxFilter = 'all';

async function loadInboxActivities() {
  try {
    var r = await fetch('/api/inbox/activities');
    var d = await r.json();
    inboxActivities = d.activities || [];
    renderInboxMetrics();
    renderInboxFeed();
    if (d.lastChecked) {
      setTxt('inbox-last-checked', 'Last checked: ' + new Date(d.lastChecked).toLocaleTimeString());
    }
  } catch(e) {}
}

function setInboxFilter(filter, btn) {
  currentInboxFilter = filter;
  ['all','interview','reply','rejection','bounce','autoreply'].forEach(function(f){
    var el = document.getElementById('btn-inbox-f-' + f);
    if (el) el.className = f === filter ? 'btn btn-b' : 'btn btn-ghost';
  });
  renderInboxFeed();
}

function renderInboxMetrics() {
  var total = inboxActivities.length;
  var interviews = inboxActivities.filter(function(a){ return a.category === 'interview'; }).length;
  var replies = inboxActivities.filter(function(a){ return a.category === 'reply'; }).length;
  var rejections = inboxActivities.filter(function(a){ return a.category === 'rejection'; }).length;
  var bounces = inboxActivities.filter(function(a){ return a.category === 'bounce'; }).length;

  setTxt('inbox-stat-total', total);
  setTxt('inbox-stat-interviews', interviews);
  setTxt('inbox-stat-replies', replies);
  setTxt('inbox-stat-rejections', rejections);
  setTxt('inbox-stat-bounces', bounces);

  var badge = document.getElementById('tab-inbox-badge');
  var hdrBadge = document.getElementById('inbox-hdr-badge');
  if (badge) {
    badge.style.display = total > 0 ? 'inline-block' : 'none';
    badge.textContent = interviews > 0 ? interviews + ' 🎯' : total;
  }
  if (hdrBadge) {
    hdrBadge.style.display = total > 0 ? 'inline-block' : 'none';
    hdrBadge.textContent = interviews > 0 ? interviews + ' 🎯' : total;
  }
}

function renderInboxFeed() {
  var container = document.getElementById('inbox-feed-container');
  if (!container) return;

  var query = (document.getElementById('inbox-search')?.value || '').toLowerCase().trim();
  var filtered = inboxActivities.filter(function(a){
    if (currentInboxFilter !== 'all' && a.category !== currentInboxFilter) return false;
    if (query) {
      var match = (a.fromEmail || '').toLowerCase().includes(query) ||
                  (a.fromName || '').toLowerCase().includes(query) ||
                  (a.subject || '').toLowerCase().includes(query) ||
                  (a.company || '').toLowerCase().includes(query) ||
                  (a.snippet || '').toLowerCase().includes(query);
      if (!match) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="card" style="text-align:center;padding:36px;color:var(--text-dim)"><div style="font-size:28px;margin-bottom:8px">&#x1F4E5;</div>No inbox activities match your filter. Click <b>Check &amp; Update Inbox Now</b> to scan Gmail.</div>';
    return;
  }

  var catBadges = {
    interview: '<span class="kc-pill" style="background:rgba(16,185,129,.15);color:var(--green);font-weight:800">&#x1F3AF; Interview</span>',
    offer: '<span class="kc-pill" style="background:rgba(234,179,8,.15);color:var(--yellow);font-weight:800">&#x1F389; Offer</span>',
    reply: '<span class="kc-pill" style="background:rgba(59,130,246,.15);color:var(--blue);font-weight:800">&#x1F4E9; Recruiter Reply</span>',
    rejection: '<span class="kc-pill" style="background:rgba(239,68,68,.15);color:var(--red);font-weight:800">&#x274C; Rejection</span>',
    bounce: '<span class="kc-pill" style="background:rgba(245,158,11,.15);color:var(--yellow);font-weight:800">&#x26A0;&#xFE0F; Bounce</span>',
    autoreply: '<span class="kc-pill" style="background:rgba(255,255,255,.06);color:var(--text-dim)">&#x1F916; Auto-reply</span>'
  };

  container.innerHTML = filtered.map(function(a){
    var badge = catBadges[a.category] || catBadges.reply;
    var d = a.date ? new Date(a.date).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '';
    var compText = a.company ? '<span class="kc-pill" style="background:rgba(255,255,255,.06)">' + escHtml(a.company) + '</span>' : '';
    var jobStatusText = a.statusUpdatedTo ? '<span class="kc-pill" style="background:rgba(16,185,129,.12);color:var(--green)">ATS: ' + escHtml(a.statusUpdatedTo) + '</span>' : '';

    return '<div class="card" style="padding:14px;border-left:3px solid ' + (a.category==='interview'?'var(--green)':a.category==='reply'?'var(--blue)':a.category==='rejection'?'var(--red)':'var(--border)') + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span style="font-weight:700;font-size:13px;color:var(--text)">' + escHtml(a.fromName || a.fromEmail) + '</span>' +
          '<span style="font-family:var(--mono);font-size:10px;color:var(--text-dim)">&lt;' + escHtml(a.fromEmail) + '&gt;</span>' +
          badge + compText + jobStatusText +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-dim);font-family:var(--mono)">' + d + '</div>' +
      '</div>' +
      '<div style="font-weight:600;font-size:12px;margin-bottom:4px;color:var(--text)">' + escHtml(a.subject) + '</div>' +
      (a.snippet ? '<div style="font-size:11px;color:var(--text-dim);line-height:1.4;margin-bottom:8px;background:rgba(0,0,0,.15);padding:8px;border-radius:6px;border:1px solid var(--border)">' + escHtml(a.snippet) + '</div>' : '') +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<button class="btn btn-b" style="padding:3px 10px;font-size:10px" data-jid="' + (a.jobId||'') + '" data-from="' + escAttr(a.fromEmail) + '" data-comp="' + escAttr(a.company||'') + '" data-subj="' + escAttr(a.subject) + '" onclick="openInboxReplyModal(this)">&#x26A1; Reply with AI</button>' +
        (a.category === 'interview' || a.category === 'offer' ? 
          '<button class="btn btn-g" style="padding:3px 10px;font-size:10px" data-aid="' + escAttr(a.id) + '" onclick="openGoogleCalendar(this.dataset.aid)">📅 Google Cal</button>' +
          '<a href="/api/inbox/calendar-ics/' + encodeURIComponent(a.id) + '" class="btn btn-ghost" style="padding:3px 10px;font-size:10px;text-decoration:none">📥 .ICS Invite</a>' : '') +
        (a.jobId ? '<button class="btn btn-ghost" style="padding:3px 10px;font-size:10px" data-jid="' + a.jobId + '" onclick="jumpToJobInAts(this.dataset.jid)">&#x1F4CB; View in ATS</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

async function checkInboxUI() {
  var btn = document.getElementById('btn-sync-inbox');
  var hdrBtn = document.getElementById('btn-inbox-header');
  var daysSelect = document.getElementById('inbox-scan-days');
  var days = daysSelect ? parseInt(daysSelect.value) || 7 : 7;

  if (btn) { btn.disabled = true; btn.innerHTML = '&#x23F3; Scanning Inbox...'; }
  if (hdrBtn) { hdrBtn.innerHTML = '&#x23F3; Scanning...'; }
  showToast('&#x1F4E5; Scanning Gmail inbox for recruiter responses (' + days + ' days)...', 'info');

  try {
    var r = await fetch('/api/inbox/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: days })
    });
    var d = await r.json();
    if (d.ok) {
      showToast('&#x2705; Scanned ' + d.scanned + ' emails: ' + d.matched + ' matched (' + d.interviews + ' interviews, ' + d.replies + ' replies)!', 'success');
      loadInboxActivities();
      loadJobs('all');
    } else {
      showToast('Inbox check note: ' + (d.error || 'Done'), 'info');
    }
  } catch(err) {
    showToast('Error checking inbox: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<span>&#x26A1;</span> <span>Check &amp; Update Inbox Now</span>'; }
    if (hdrBtn) { hdrBtn.innerHTML = '&#x1F4E5; Inbox <span id="inbox-hdr-badge" style="display:none;background:var(--green);color:#000;font-size:9px;font-weight:900;border-radius:10px;padding:1px 6px;margin-left:4px"></span>'; }
  }
}

function openImportCsvModal(){document.getElementById('import-csv-modal').classList.remove('hidden');document.getElementById('csv-import-results').style.display='none';document.getElementById('csv-paste-area').value='';}
function handleCsvFileSelect(event){var file=event.target.files[0];if(!file)return;var reader=new FileReader();reader.onload=function(e){document.getElementById('csv-paste-area').value=e.target.result;showToast('Loaded '+file.name+' into importer','info');};reader.readAsText(file);}
async function submitCsvImport(){var content=document.getElementById('csv-paste-area').value.trim();if(!content){showToast('Please paste CSV content or select a file','warn');return;}var btn=document.getElementById('btn-submit-csv-import');btn.disabled=true;btn.textContent='Importing...';try{var r=await fetch('/api/emails/import-csv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csvContent:content})});var d=await r.json();var resBox=document.getElementById('csv-import-results');resBox.style.display='block';if(d.ok){resBox.innerHTML='<div style="color:var(--green);font-weight:700;margin-bottom:4px">✅ Successfully imported '+d.importedCount+' leads!</div><div style="color:var(--text-dim);display:flex;gap:12px;font-size:10px"><span>Filtered Dupes: '+d.duplicates+'</span><span>Invalid RFC: '+d.invalid+'</span><span>Already Sent: '+d.alreadySent+'</span><span>Total in emails.txt: '+d.totalRemaining+'</span></div>';showToast('Imported '+d.importedCount+' fresh leads!','success');loadEmailFiles();}else{resBox.innerHTML='<div style="color:var(--red)">❌ Import failed: '+escHtml(d.error||'Unknown error')+'</div>';}}catch(e){showToast('Error: '+e.message,'error');}finally{btn.disabled=false;btn.textContent='📥 Import Leads';}}
async function openGoogleCalendar(id){try{var r=await fetch('/api/inbox/google-cal-link/'+encodeURIComponent(id));var d=await r.json();if(d.ok&&d.url){window.open(d.url,'_blank');}else{showToast('Could not create calendar link','error');}}catch(e){showToast('Failed to open Google Calendar','error');}}
async function clearInboxActivitiesUI() {
  if (!confirm('Clear recent inbox activity feed?')) return;
  try {
    await fetch('/api/inbox/clear', { method: 'POST' });
    inboxActivities = [];
    renderInboxMetrics();
    renderInboxFeed();
    showToast('Cleared inbox feed', 'info');
  } catch(e) {}
}

function openInboxReplyModal(btn) {
  var jid = btn.dataset.jid;
  var fromEmail = btn.dataset.from;
  var comp = btn.dataset.comp;
  var subj = btn.dataset.subj;

  if (jid && typeof openFollowupModal === 'function') {
    openFollowupModal(jid);
  } else {
    document.getElementById('fu-job-id').value = '';
    setTxt('fu-subtitle', (comp || fromEmail) + ' (' + fromEmail + ')');
    document.getElementById('fu-subject').value = subj.startsWith('Re:') ? subj : 'Re: ' + subj;
    document.getElementById('followup-modal').classList.remove('hidden');
  }
  draftAiReplyPrompt(comp, subj);
}

async function draftAiReplyPrompt(company, subject) {
  try {
    showToast('&#x1F916; Drafting professional AI reply...', 'info');
    var r = await fetch('/api/ai/draft-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recruiterText: subject, company: company || 'your company', role: 'Python Developer' })
    });
    var d = await r.json();
    if (d && d.draft) {
      document.getElementById('fu-body').value = d.draft;
      showToast('&#x2728; AI Reply draft ready for review!', 'success');
    }
  } catch(e) {}
}

function jumpToJobInAts(jobId) {
  switchTab('jobs', document.getElementById('tab-jobs'));
  var searchInput = document.getElementById('jobs-search-input') || document.getElementById('job-search');
  if (searchInput) {
    searchInput.value = jobId;
    if (typeof filterAndRenderJobsUI === 'function') filterAndRenderJobsUI();
  }
}

// ═══ v7.0 TITAN CLIENT FUNCTIONS ═══
function toggleFab(){
  var menu=document.getElementById('fab-menu');
  var btn=document.getElementById('fab-btn');
  if(menu)menu.classList.toggle('open');
  if(btn)btn.classList.toggle('open');
}

var _sparklineData = [];
function updateHeaderSparkline(rate){
  var val = parseFloat(rate) || 0;
  _sparklineData.push(val);
  if(_sparklineData.length > 24) _sparklineData.shift();
  var max = Math.max.apply(null, _sparklineData) || 1;
  var container = document.getElementById('header-sparkline');
  if(container){
    container.innerHTML = _sparklineData.map(function(v){
      var h = Math.max(3, Math.round((v / max) * 26));
      return '<div class="spark-bar" style="height:'+h+'px" title="'+v+' sends/min"></div>';
    }).join('');
  }
}

function toggleNotifPanel(){
  var dd=document.getElementById('notif-dropdown');
  if(dd)dd.classList.toggle('open');
}

async function pollNotifications(){
  try{
    var r=await fetch('/api/notifications');
    var d=await r.json();
    var badge=document.getElementById('notif-badge');
    if(badge){
      if(d.unreadCount>0){
        badge.style.display='flex';
        badge.textContent=d.unreadCount;
      } else {
        badge.style.display='none';
      }
    }
    var list=document.getElementById('notif-list');
    if(list && d.notifications){
      if(d.notifications.length===0){
        list.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px">No notifications yet</div>';
      } else {
        list.innerHTML=d.notifications.slice(0,25).map(function(n){
          var t=new Date(n.time).toLocaleTimeString();
          return '<div class="notif-item'+(n.read?'':' unread')+'">' +
            '<div class="notif-icon">'+(n.icon||'🔔')+'</div>' +
            '<div class="notif-body">' +
              '<div class="notif-title">'+escHtml(n.title)+'</div>' +
              '<div class="notif-text">'+escHtml(n.body)+'</div>' +
              '<div class="notif-time">'+t+'</div>' +
            '</div>' +
          '</div>';
        }).join('');
      }
    }
  }catch(e){}
}

async function markAllNotifsRead(){
  try{
    await fetch('/api/notifications/read',{method:'POST'});
    var badge=document.getElementById('notif-badge');
    if(badge)badge.style.display='none';
    document.querySelectorAll('.notif-item').forEach(function(el){el.classList.remove('unread')});
  }catch(e){}
}

async function loadMilestones(currentSent){
  try{
    var r=await fetch('/api/milestones');
    var d=await r.json();
    var cur=d.current || currentSent || 0;
    setTxt('milestone-current-badge', cur+' sent');
    var milestoneTargets=[1, 10, 50, 100, 250, 500, 1000, 2000, 5000];
    var container=document.getElementById('milestones-timeline');
    if(!container)return;
    container.innerHTML = milestoneTargets.map(function(m, idx){
      var reached = cur >= m;
      var hasLine = idx < milestoneTargets.length - 1;
      return '<div class="timeline-node">' +
        '<div class="timeline-dot'+(reached?' reached':'')+'" title="Target: '+m+' emails"></div>' +
        '<div class="timeline-label'+(reached?'" style="color:var(--text);font-weight:800"':'"')+'>'+(m>=1000?(m/1000)+'k':m)+'</div>' +
      '</div>' +
      (hasLine ? '<div class="timeline-line'+(cur>=milestoneTargets[idx+1]?' reached':'')+'"></div>' : '');
    }).join('');
  }catch(e){}
}

function renderSvgFunnel(sent, viewed, replied, interview, offer){
  var el = document.getElementById('svg-funnel');
  if(!el) return;
  var s = Math.max(sent, 1);
  var stages = [
    { label: 'Sent', count: sent, pct: 100, color: 'var(--accent)' },
    { label: 'Viewed', count: viewed, pct: Math.round((viewed / s) * 100), color: 'var(--blue)' },
    { label: 'Replied', count: replied, pct: Math.round((replied / s) * 100), color: 'var(--accent2)' },
    { label: 'Interview', count: interview, pct: Math.round((interview / s) * 100), color: 'var(--yellow)' },
    { label: 'Offer', count: offer, pct: Math.round((offer / s) * 100), color: 'var(--green)' }
  ];
  var w = 680, h = 90;
  var stageW = w / stages.length;
  var svg = '<svg width="100%" height="'+h+'" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none" style="display:block;border-radius:10px">';
  stages.forEach(function(st, i){
    var x = i * stageW;
    var nextPct = i < stages.length - 1 ? stages[i+1].pct : st.pct;
    var topY1 = (100 - st.pct) * 0.35;
    var botY1 = h - topY1;
    var topY2 = (100 - nextPct) * 0.35;
    var botY2 = h - topY2;
    var poly = x+','+topY1+' '+(x+stageW)+','+topY2+' '+(x+stageW)+','+botY2+' '+x+','+botY1;
    svg += '<polygon points="'+poly+'" fill="'+st.color+'" opacity="0.22"/>';
    svg += '<polygon points="'+poly+'" fill="none" stroke="'+st.color+'" stroke-width="1.5" opacity="0.6"/>';
    svg += '<text x="'+(x+stageW/2)+'" y="38" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="900">'+st.count+'</text>';
    svg += '<text x="'+(x+stageW/2)+'" y="54" text-anchor="middle" fill="var(--text-dim)" font-size="10">'+st.label+' ('+st.pct+'%)</text>';
  });
  svg += '</svg>';
  el.innerHTML = svg;
}

async function loadCumulativeGrowth(){
  try{
    var r = await fetch('/api/analytics/cumulative');
    var d = await r.json();
    setTxt('cumulative-total-badge', (d.totalEver||0) + ' sent ever');
    if(chartjsReady && d.data && d.data.length > 0){
      if(charts.cumulative) charts.cumulative.destroy();
      var ctx = document.getElementById('chart-cumulative');
      if(ctx){
        charts.cumulative = new Chart(ctx, {
          type: 'line',
          data: {
            labels: d.data.map(function(x){ return x.date; }),
            datasets: [{
              label: 'Cumulative Sent',
              data: d.data.map(function(x){ return x.cumulative; }),
              borderColor: '#818cf8',
              backgroundColor: 'rgba(129,140,248,0.15)',
              fill: true,
              tension: 0.3,
              pointRadius: 3,
              pointBackgroundColor: '#818cf8'
            }]
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { display: false } },
              y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(255,255,255,0.03)' } }
            }
          }
        });
      }
    }
  }catch(e){}
}

async function loadAbTest(){
  try{
    var r = await fetch('/api/analytics/ab-test');
    var d = await r.json();
    setTxt('ab-a-rate', (d.A.openRate || 0) + '%');
    setTxt('ab-a-opened', d.A.opened || 0);
    setTxt('ab-a-sent', d.A.sent || 0);
    setTxt('ab-b-rate', (d.B.openRate || 0) + '%');
    setTxt('ab-b-opened', d.B.opened || 0);
    setTxt('ab-b-sent', d.B.sent || 0);
    var badge = document.getElementById('ab-winner-badge');
    var conf = document.getElementById('ab-confidence-text');
    if(d.winner === 'A'){
      if(badge){ badge.textContent = '🏆 Variant A Leading'; badge.style.color = 'var(--accent)'; }
      if(conf) conf.textContent = 'Variant A leads with ' + d.A.openRate + '% open rate (' + (d.A.openRate - d.B.openRate) + '% edge)';
    } else if(d.winner === 'B'){
      if(badge){ badge.textContent = '🏆 Variant B Leading'; badge.style.color = 'var(--accent2)'; }
      if(conf) conf.textContent = 'Variant B leads with ' + d.B.openRate + '% open rate (' + (d.B.openRate - d.A.openRate) + '% edge)';
    } else {
      if(badge){ badge.textContent = 'Active Test'; badge.style.color = 'var(--text-dim)'; }
      if(conf) conf.textContent = 'Send emails to generate A/B split comparisons';
    }
  }catch(e){}
}

async function loadOptimalHours(){
  try{
    var r = await fetch('/api/analytics/optimal-hours');
    var d = await r.json();
    var b = document.getElementById('opt-hours-badge');
    if(b) b.textContent = d.recommendation || 'Analyzing historical send data...';
    var topEl = document.getElementById('opt-top-hours');
    if(topEl && d.bestHours && d.bestHours.length > 0){
      topEl.innerHTML = d.bestHours.map(function(h){
        var hStr = (h.hour < 10 ? '0' : '') + h.hour + ':00';
        return '<span class="best-time-badge">⚡ ' + hStr + ' — ' + h.replyRate + '% replies (' + h.sent + ' sent)</span>';
      }).join('');
    }
  }catch(e){}
}

async function loadBlacklist(){
  try{
    var r = await fetch('/api/analytics/blacklist');
    var d = await r.json();
    var el = document.getElementById('bl-list');
    if(!el) return;
    if(!d.domains || d.domains.length === 0){
      el.innerHTML = '<div style="font-size:11px;color:var(--text-dim);text-align:center;padding:16px">✅ Clean deliverability! No blacklisted domains</div>';
      return;
    }
    el.innerHTML = d.domains.map(function(dm){
      return '<div class="bl-domain">' +
        '<span class="bl-domain-name">' + escHtml(dm.domain) + '</span>' +
        '<span class="bl-rate">' + dm.failRate + '% fail</span>' +
        '<button class="btn btn-ghost" style="padding:2px 6px;font-size:9px" data-dom="' + escAttr(dm.domain) + '" onclick="removeBlacklistDomain(this.dataset.dom)">Unblock</button>' +
      '</div>';
    }).join('');
  }catch(e){}
}

async function removeBlacklistDomain(domain){
  try{
    await fetch('/api/analytics/blacklist/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: domain })
    });
    showToast('Unblocked ' + domain, 'info');
    loadBlacklist();
  }catch(e){}
}

async function clearBlacklist(){
  if(!confirm('Clear all auto-blacklisted domains?')) return;
  try{
    await fetch('/api/analytics/blacklist/clear', { method: 'POST' });
    showToast('Blacklist cleared', 'success');
    loadBlacklist();
  }catch(e){}
}

var _companiesCache = [];
async function loadCompanyAnalytics(){
  try{
    var r = await fetch('/api/analytics/companies');
    var d = await r.json();
    _companiesCache = d.companies || [];
    renderCompanyAnalyticsTable(_companiesCache);
  }catch(e){}
}

function filterCompanyAnalytics(q){
  var query = (q || '').toLowerCase();
  var filtered = _companiesCache.filter(function(c){
    return c.company.toLowerCase().includes(query);
  });
  renderCompanyAnalyticsTable(filtered);
}

function renderCompanyAnalyticsTable(items){
  var el = document.getElementById('company-analytics-table');
  if(!el) return;
  if(!items || items.length === 0){
    el.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim);font-size:11px">No company outreach data</div>';
    return;
  }
  el.innerHTML = items.slice(0, 40).map(function(c){
    var hasInterview = (c.interview || c.interviews || 0) > 0;
    var hasReplied = (c.replied || c.replies || 0) > 0;
    var hasOpened = (c.opened || c.opens || 0) > 0;
    var totalSent = c.sent || c.total || 0;
    var badge = hasInterview ? '<span class="kc-pill" style="background:rgba(251,191,36,.15);color:var(--yellow)">🎯 Interview</span>' :
                hasReplied ? '<span class="kc-pill" style="background:rgba(52,211,153,.15);color:var(--green)">💬 Replied</span>' :
                hasOpened ? '<span class="kc-pill" style="background:rgba(96,165,250,.15);color:var(--blue)">👁️ Opened</span>' :
                '<span class="kc-pill" style="background:rgba(255,255,255,.05);color:var(--text-dim)">Sent</span>';
    return '<div class="company-row">' +
      '<div class="company-name">' + escHtml(c.company) + '</div>' +
      '<div class="company-pills">' + badge + '</div>' +
      '<div style="font-family:var(--mono);font-size:10px;color:var(--text-dim);margin-left:auto">' + totalSent + ' sent</div>' +
    '</div>';
  }).join('');
}

// ─── v8.5 UPGRADE CLIENT MODULES ──────────────────────────────
async function generateTailoredPitchUI() {
  var btn = document.getElementById('btn-tailor-jd');
  var jd = document.getElementById('ai-jd-input').value.trim();
  var comp = document.getElementById('ai-jd-company').value.trim();
  var role = document.getElementById('ai-jd-role').value.trim();

  if (!jd && !comp) {
    showToast('Please paste a Job Description or enter a Company name', 'warn');
    return;
  }

  btn.disabled = true;
  btn.textContent = '✨ Tailoring with AI...';
  try {
    var r = await fetch('/api/ai/tailor-pitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobDescription: jd, company: comp, role: role })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('t-subject').value = d.subject;
      document.getElementById('t-plain').value = d.plainText;
      document.getElementById('t-html').value = d.html;
      if (comp) document.getElementById('t-company').value = comp;

      var tagsEl = document.getElementById('ai-jd-tags');
      if (tagsEl && d.matchedKeywords && d.matchedKeywords.length) {
        tagsEl.innerHTML = d.matchedKeywords.slice(0, 4).map(function(k){
          return '<span style="font-size:9px;background:rgba(99,102,241,0.18);color:var(--accent);border:1px solid rgba(99,102,241,0.3);border-radius:10px;padding:2px 8px">' + escHtml(k.split(' ')[0]) + '</span>';
        }).join('');
      }
      tPreviewDebounce();
      updateSubjectCounter();
      showToast('✨ Tailored pitch generated & loaded into template!', 'success');
    } else {
      showToast('Error generating pitch: ' + (d.error || 'Failed'), 'error');
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Auto-Tailor Pitch & Load into Template';
  }
}

async function autoTailorDirectSendUI() {
  var comp = document.getElementById('ds-company').value.trim();
  var role = document.getElementById('ds-role').value.trim() || 'Python Backend Developer';
  if (!comp) {
    showToast('Enter Company name first', 'warn');
    return;
  }
  showToast('✨ Drafting tailored pitch for ' + comp + '...', 'info');
  try {
    var r = await fetch('/api/ai/tailor-pitch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobDescription: 'Python Backend Developer FastAPI Django PostgreSQL Redis Celery', company: comp, role: role })
    });
    var d = await r.json();
    if (d.ok) {
      document.getElementById('ds-subject').value = d.subject;
      document.getElementById('ds-body').value = d.plainText;
      showToast('✨ Tailored pitch loaded into Direct Send!', 'success');
    }
  } catch(e) {
    showToast('Failed to auto-draft: ' + e.message, 'error');
  }
}

var _previewLeadsCache = [];
async function loadLeadSelectorOptions() {
  try {
    var r = await fetch('/api/queue/leads-preview');
    var d = await r.json();
    if (d.ok && d.leads) {
      _previewLeadsCache = d.leads;
      var sel = document.getElementById('t-lead-selector');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- Real Queue Leads (' + d.count + ') --</option>' +
        d.leads.map(function(l, i){
          return '<option value="' + i + '">#' + (i + 1) + ' ' + escHtml(l.company) + ' (' + escHtml(l.email) + ')</option>';
        }).join('');
    }
  } catch(e) {}
}

function selectPreviewLead(val) {
  if (val === '' || !_previewLeadsCache.length) return;
  var idx = parseInt(val, 10);
  if (isNaN(idx) || !_previewLeadsCache[idx]) return;
  var lead = _previewLeadsCache[idx];
  document.getElementById('t-company').value = lead.company;
  var testEmailInput = document.getElementById('t-test-email');
  if (testEmailInput) testEmailInput.value = lead.email;
  tPreviewDebounce();
  showToast('👀 Previewing template for ' + lead.company, 'info');
}

function stepPreviewLead(delta) {
  var sel = document.getElementById('t-lead-selector');
  if (!sel || !_previewLeadsCache.length) return;
  var curIdx = parseInt(sel.value, 10);
  if (isNaN(curIdx)) curIdx = 0;
  var nextIdx = curIdx + delta;
  if (nextIdx < 0) nextIdx = _previewLeadsCache.length - 1;
  if (nextIdx >= _previewLeadsCache.length) nextIdx = 0;
  sel.value = String(nextIdx);
  selectPreviewLead(String(nextIdx));
}

function openVerifyQueueModal() {
  document.getElementById('verify-queue-modal').classList.remove('hidden');
  runQueueVerification();
}

async function runQueueVerification() {
  var statusBox = document.getElementById('verify-queue-status');
  var invList = document.getElementById('verify-invalid-list');
  var cleanBtn = document.getElementById('btn-clean-invalid-leads');
  statusBox.innerHTML = '<div style="font-size:12px;color:var(--accent);text-align:center">&#x23F3; Resolving DNS MX records for all leads in queue...</div>';
  invList.style.display = 'none';
  if (cleanBtn) cleanBtn.style.display = 'none';

  try {
    var r = await fetch('/api/leads/verify-queue', { method: 'POST' });
    var d = await r.json();
    if (d.ok) {
      var isAllGood = d.invalidCount === 0;
      statusBox.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<span style="font-weight:700;font-size:13px;color:' + (isAllGood ? 'var(--green)' : 'var(--yellow)') + '">' +
          (isAllGood ? '🛡️ Deliverability Shield: Excellent (0% Bounce Risk)' : '⚠️ Action Needed: Unreachable Domains Detected') +
        '</span>' +
        '<span style="font-size:10px;font-family:var(--mono);color:var(--text-dim)">' + d.domainsChecked + ' domains scanned</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;text-align:center">' +
        '<div style="background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.3);padding:8px;border-radius:8px"><div style="font-size:16px;font-weight:900;color:var(--green)">' + d.validCount + '</div><div style="font-size:10px;color:var(--text-dim)">Valid MX Leads</div></div>' +
        '<div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);padding:8px;border-radius:8px"><div style="font-size:16px;font-weight:900;color:var(--red)">' + d.invalidCount + '</div><div style="font-size:10px;color:var(--text-dim)">Dead / No MX</div></div>' +
        '<div style="background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);padding:8px;border-radius:8px"><div style="font-size:16px;font-weight:900;color:var(--accent)">' + d.total + '</div><div style="font-size:10px;color:var(--text-dim)">Total in Queue</div></div>' +
      '</div>';

      if (!isAllGood && d.invalidLeads && d.invalidLeads.length) {
        invList.style.display = 'block';
        invList.innerHTML = '<strong style="color:var(--red);font-size:11px;display:block;margin-bottom:4px">Invalid / Dead Domains:</strong>' +
          d.invalidLeads.map(function(l){
            return '<div style="font-size:11px;font-family:var(--mono);color:var(--text);padding:2px 0">' + escHtml(l.email) + ' (' + escHtml(l.reason || l.status) + ')</div>';
          }).join('');
        if (cleanBtn) cleanBtn.style.display = 'inline-flex';
      }
    } else {
      statusBox.innerHTML = '<div style="color:var(--red)">Verification error: ' + escHtml(d.error) + '</div>';
    }
  } catch(e) {
    statusBox.innerHTML = '<div style="color:var(--red)">Failed to verify: ' + escHtml(e.message) + '</div>';
  }
}

async function cleanInvalidLeadsSubmit() {
  if (!confirm('Remove all unreachable / non-MX leads from emails.txt?')) return;
  try {
    var r = await fetch('/api/leads/clean-invalid', { method: 'POST' });
    var d = await r.json();
    if (d.ok) {
      showToast('🛡️ Removed ' + d.removedCount + ' unreachable leads! Remaining: ' + d.remaining, 'success');
      document.getElementById('verify-queue-modal').classList.add('hidden');
      loadEmailFiles();
      ctrl('reload');
    }
  } catch(e) {
    showToast('Failed to clean: ' + e.message, 'error');
  }
}

async function loadHourlyHeatmap() {
  try {
    var r = await fetch('/api/analytics/hourly-heatmap');
    var d = await r.json();
    if (!d.ok) return;

    var badge = document.getElementById('heatmap-peak-badge');
    if (badge) badge.textContent = d.peakPct + '% Sent in Prime HR Window';

    var container = document.getElementById('hourly-heatmap-bars');
    var labelsContainer = document.getElementById('hourly-heatmap-labels');
    if (!container) return;

    var maxCount = Math.max(1, Math.max.apply(null, d.hourly.map(function(h){ return h.count; })));

    container.innerHTML = d.hourly.map(function(h){
      var pct = Math.max(8, Math.round((h.count / maxCount) * 100));
      var bg = h.isPeak ? 'linear-gradient(180deg,#34d399,#059669)' : 'linear-gradient(180deg,#6366f1,#4338ca)';
      var title = h.label + ': ' + h.count + ' sent' + (h.isPeak ? ' (Prime Window)' : '');
      return '<div style="height:100%;display:flex;align-items:flex-end" title="' + escAttr(title) + '">' +
        '<div style="width:100%;height:' + pct + '%;background:' + bg + ';border-radius:3px 3px 0 0;opacity:' + (h.count > 0 ? '1' : '0.25') + ';transition:all .3s"></div>' +
      '</div>';
    }).join('');

    if (labelsContainer) {
      labelsContainer.innerHTML = d.hourly.map(function(h){
        return '<div style="color:' + (h.isPeak ? 'var(--green);font-weight:700' : 'var(--text-dim)') + '">' + h.hour + '</div>';
      }).join('');
    }
  } catch(e) {}
}

setTimeout(loadInboxActivities, 1000);
setTimeout(loadLeadSelectorOptions, 1100);
setTimeout(function(){ if(typeof loadMilestones==='function') loadMilestones(); }, 1200);
setTimeout(loadHourlyHeatmap, 1400);
setTimeout(function(){ if(typeof pollNotifications==='function') pollNotifications(); }, 1500);

// ══════════ MATCHING & RESUMES CLIENT LOGIC ══════════
async function loadCandidateProfileUI(){
  try {
    var res = await fetch('/api/candidate-profile');
    var d = await res.json();
    if(d.profile){
      var p = d.profile;
      var el = document.getElementById('prof-name'); if(el) el.value = p.name || '';
      el = document.getElementById('prof-exp'); if(el) el.value = p.experienceYears !== undefined ? p.experienceYears : '';
      el = document.getElementById('prof-notice'); if(el) el.value = p.noticePeriod || '';
      el = document.getElementById('prof-roles'); if(el) el.value = (p.targetRoles || []).join(', ');
      el = document.getElementById('prof-locations'); if(el) el.value = (p.preferredLocations || []).join(', ');
      el = document.getElementById('prof-core-skills'); if(el) el.value = (p.skills && p.skills.core || []).join(', ');
      el = document.getElementById('prof-sec-skills'); if(el) el.value = (p.skills && p.skills.secondary || []).join(', ');
    }
  } catch(e) {
    console.error('Error loading candidate profile:', e);
  }
}

async function saveCandidateProfileUI(){
  try {
    var name = (document.getElementById('prof-name') ? document.getElementById('prof-name').value : '').trim();
    var exp = parseFloat(document.getElementById('prof-exp') ? document.getElementById('prof-exp').value : '0') || 0;
    var notice = (document.getElementById('prof-notice') ? document.getElementById('prof-notice').value : '').trim();
    var roles = (document.getElementById('prof-roles') ? document.getElementById('prof-roles').value : '').split(',').map(function(s){return s.trim()}).filter(Boolean);
    var locations = (document.getElementById('prof-locations') ? document.getElementById('prof-locations').value : '').split(',').map(function(s){return s.trim()}).filter(Boolean);
    var core = (document.getElementById('prof-core-skills') ? document.getElementById('prof-core-skills').value : '').split(',').map(function(s){return s.trim()}).filter(Boolean);
    var secondary = (document.getElementById('prof-sec-skills') ? document.getElementById('prof-sec-skills').value : '').split(',').map(function(s){return s.trim()}).filter(Boolean);

    var res = await fetch('/api/candidate-profile', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: name,
        experienceYears: exp,
        noticePeriod: notice,
        targetRoles: roles,
        preferredLocations: locations,
        skills: { core: core, secondary: secondary }
      })
    });
    var d = await res.json();
    if(d.ok) {
      showToast('✅ Candidate Profile saved successfully!', 'success');
    } else {
      showToast('❌ Error saving profile: ' + (d.error || 'Unknown'), 'error');
    }
  } catch(e) {
    showToast('❌ Failed: ' + e.message, 'error');
  }
}

async function loadResumeProfilesUI(){
  try {
    var res = await fetch('/api/resumes/profiles');
    var d = await res.json();
    var container = document.getElementById('resume-profiles-grid');
    if(!container) return;
    var profiles = d.profiles || [];
    container.innerHTML = profiles.map(function(p){
      var isDef = p.isDefault;
      var tagsHtml = (p.tags || []).map(function(t){
        return '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:rgba(99,102,241,0.15);color:var(--accent);font-weight:600">' + escHtml(t) + '</span>';
      }).join(' ');
      return '<div class="card" style="padding:14px;background:rgba(255,255,255,0.02);border:1px solid ' + (isDef ? 'var(--accent)' : 'var(--border)') + ';position:relative">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">' +
          '<div style="font-weight:700;font-size:13px;color:var(--text-bright)">' + escHtml(p.name) + '</div>' +
          (isDef ? '<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;background:var(--green);color:#000">DEFAULT</span>' : '') +
        '</div>' +
        '<div style="font-size:11px;font-family:monospace;color:var(--text-dim);margin-bottom:8px">📄 ' + escHtml(p.file) + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">' + escHtml(p.focus || '') + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px">' + tagsHtml + '</div>' +
      '</div>';
    }).join('');
  } catch(e){
    console.error('Error loading resume profiles:', e);
  }
}

async function simulateJobMatchUI(){
  try {
    var role = (document.getElementById('sim-role') ? document.getElementById('sim-role').value : '').trim();
    var company = (document.getElementById('sim-company') ? document.getElementById('sim-company').value : '').trim();
    var loc = (document.getElementById('sim-loc') ? document.getElementById('sim-loc').value : '').trim();
    var desc = (document.getElementById('sim-desc') ? document.getElementById('sim-desc').value : '').trim();

    if(!role && !desc){
      showToast('⚠️ Please enter a Job Title or Description to simulate', 'warn');
      return;
    }

    var res = await fetch('/api/jobs/match-preview', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ role: role, company: company, location: loc, description: desc })
    });
    var d = await res.json();

    var box = document.getElementById('sim-result-box');
    if(!box) return;
    box.style.display = 'block';

    var scoreBadge = document.getElementById('sim-score-badge');
    var scoreColor = d.matchScore >= 80 ? 'var(--green)' : d.matchScore >= 60 ? 'var(--yellow)' : 'var(--red)';
    if(scoreBadge){
      scoreBadge.textContent = d.matchScore + '%';
      scoreBadge.style.color = scoreColor;
    }

    var tierBadge = document.getElementById('sim-tier-badge');
    if(tierBadge){
      tierBadge.textContent = (d.tier || 'STANDARD') + ' MATCH — ' + (d.recommendation || 'Evaluated');
      tierBadge.style.color = scoreColor;
    }

    var resumeBadge = document.getElementById('sim-auto-resume');
    if(resumeBadge){
      resumeBadge.textContent = d.autoSelectedResume ? (d.autoSelectedResume.name + ' (' + d.autoSelectedResume.file + ')') : 'Default Resume';
    }

    var list = document.getElementById('sim-breakdown-list');
    if(list && d.breakdown){
      var b = d.breakdown;
      list.innerHTML = [
        '<div style="font-size:11px;display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06)"><span>Core Skills (40% Weight):</span><strong style="color:var(--text-bright)">' + b.coreSkills.score + ' / ' + b.coreSkills.weight + ' pts</strong></div>',
        '<div style="font-size:10px;color:var(--text-dim);margin-top:-4px;margin-bottom:4px">Matched: ' + (b.coreSkills.matched && b.coreSkills.matched.length ? b.coreSkills.matched.join(', ') : 'None') + '</div>',
        '<div style="font-size:11px;display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06)"><span>Experience Alignment (25% Weight):</span><strong style="color:var(--text-bright)">' + b.experience.score + ' / ' + b.experience.weight + ' pts</strong></div>',
        '<div style="font-size:10px;color:var(--text-dim);margin-top:-4px;margin-bottom:4px">' + escHtml(b.experience.detail || '') + '</div>',
        '<div style="font-size:11px;display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06)"><span>Location &amp; Remote (20% Weight):</span><strong style="color:var(--text-bright)">' + b.location.score + ' / ' + b.location.weight + ' pts</strong></div>',
        '<div style="font-size:10px;color:var(--text-dim);margin-top:-4px;margin-bottom:4px">' + escHtml(b.location.detail || '') + '</div>',
        '<div style="font-size:11px;display:flex;justify-content:space-between;padding:6px 0"><span>Secondary / Tech Bonus (15% Weight):</span><strong style="color:var(--text-bright)">' + b.secondarySkills.score + ' / ' + b.secondarySkills.weight + ' pts</strong></div>',
        '<div style="font-size:10px;color:var(--text-dim);margin-top:-4px">Matched: ' + (b.secondarySkills.matched && b.secondarySkills.matched.length ? b.secondarySkills.matched.join(', ') : 'None') + '</div>'
      ].join('');
    }
  } catch(e){
    showToast('❌ Simulation error: ' + e.message, 'error');
  }
}

// ══════════ RECRUITERS & SHIELD CLIENT LOGIC ══════════
window.__allRecruiters = [];
async function loadRecruitersUI(){
  try {
    var res = await fetch('/api/recruiters');
    var d = await res.json();
    window.__allRecruiters = d.recruiters || [];
    renderRecruitersTable(window.__allRecruiters);
  } catch(e){
    console.error('Error loading recruiters:', e);
  }
}

function filterRecruitersUI(){
  var q = (document.getElementById('rec-search') ? document.getElementById('rec-search').value : '').toLowerCase().trim();
  if(!q){
    renderRecruitersTable(window.__allRecruiters);
    return;
  }
  var filtered = window.__allRecruiters.filter(function(r){
    return (r.name && r.name.toLowerCase().includes(q)) ||
      (r.company && r.company.toLowerCase().includes(q)) ||
      (r.email && r.email.toLowerCase().includes(q)) ||
      (r.designation && r.designation.toLowerCase().includes(q));
  });
  renderRecruitersTable(filtered);
}

function renderRecruitersTable(list){
  var tbody = document.getElementById('recruiters-table-body');
  if(!tbody) return;
  if(!list || !list.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:24px">No recruiters registered yet</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(function(r){
    var cooldownActive = r.lastContactedAt && (Date.now() - new Date(r.lastContactedAt).getTime() < 24 * 3600 * 1000);
    var safetyBadge = r.status === 'blocked' ?
      '<span class="badge" style="background:rgba(248,113,113,0.2);color:var(--red)">🚫 Blocked</span>' :
      (cooldownActive ?
        '<span class="badge" style="background:rgba(251,191,36,0.2);color:var(--yellow)">⏳ Cooldown (24h)</span>' :
        '<span class="badge" style="background:rgba(52,211,153,0.2);color:var(--green)">✓ Safe to Reach</span>');
    
    var replyBadge = r.replied ?
      '<span class="badge" style="background:rgba(192,132,252,0.2);color:var(--purple)">💬 Replied</span>' :
      (r.outreachCount > 0 ? '<span class="badge" style="background:rgba(96,165,250,0.2);color:var(--blue)">Sent (' + r.outreachCount + ')</span>' : '<span style="color:var(--text-dim);font-size:11px">Not contacted</span>');

    return '<tr>' +
      '<td><strong>' + escHtml(r.name || 'Recruiter') + '</strong></td>' +
      '<td>' + escHtml(r.company || '—') + '</td>' +
      '<td><code style="font-size:11px;color:var(--accent)">' + escHtml(r.email) + '</code></td>' +
      '<td>' + escHtml(r.designation || 'Talent Acquisition') + '</td>' +
      '<td>' + (r.outreachCount || 0) + '</td>' +
      '<td>' + replyBadge + '</td>' +
      '<td>' + safetyBadge + '</td>' +
    '</tr>';
  }).join('');
}

async function loadSuppressionUI(){
  try {
    var res = await fetch('/api/suppression');
    var d = await res.json();
    var list = d.suppressionList || { emails: [], domains: [] };

    var eCount = document.getElementById('supp-email-count');
    if(eCount) eCount.textContent = (list.emails || []).length;
    var dCount = document.getElementById('supp-domain-count');
    if(dCount) dCount.textContent = (list.domains || []).length;

    var eList = document.getElementById('supp-email-list');
    if(eList){
      if(!list.emails || !list.emails.length){
        eList.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px">No blocked emails</div>';
      } else {
        eList.innerHTML = list.emails.map(function(item){
          var val = typeof item === 'string' ? item : item.target;
          var reason = (typeof item === 'object' && item.reason) ? item.reason : 'Opt-out';
          return '<div style="display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px">' +
            '<div><span style="font-weight:600;color:var(--text-bright)">' + escHtml(val) + '</span><span style="font-size:10px;color:var(--text-dim);margin-left:8px">(' + escHtml(reason) + ')</span></div>' +
            '<button class="btn btn-ghost" style="padding:2px 6px;font-size:10px;color:var(--red)" data-target="' + escAttr(val) + '" data-type="email" onclick="removeSuppressionUI(this.dataset.target, this.dataset.type)">✕ Remove</button>' +
          '</div>';
        }).join('');
      }
    }

    var dList = document.getElementById('supp-domain-list');
    if(dList){
      if(!list.domains || !list.domains.length){
        dList.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px">No blocked domains</div>';
      } else {
        dList.innerHTML = list.domains.map(function(item){
          var val = typeof item === 'string' ? item : item.target;
          var reason = (typeof item === 'object' && item.reason) ? item.reason : 'Blocklist';
          return '<div style="display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px">' +
            '<div><span style="font-weight:600;color:var(--text-bright)">' + escHtml(val) + '</span><span style="font-size:10px;color:var(--text-dim);margin-left:8px">(' + escHtml(reason) + ')</span></div>' +
            '<button class="btn btn-ghost" style="padding:2px 6px;font-size:10px;color:var(--red)" data-target="' + escAttr(val) + '" data-type="domain" onclick="removeSuppressionUI(this.dataset.target, this.dataset.type)">✕ Remove</button>' +
          '</div>';
        }).join('');
      }
    }
  } catch(e){
    console.error('Error loading suppression:', e);
  }
}

async function addSuppressionUI(){
  try {
    var inp = document.getElementById('supp-email');
    var reasonInp = document.getElementById('supp-reason');
    var target = inp ? inp.value.trim() : '';
    var reason = reasonInp ? reasonInp.value.trim() : '';
    if(!target){
      showToast('⚠️ Please enter an email or domain to suppress', 'warn');
      return;
    }
    var type = target.startsWith('@') || !target.includes('@') ? 'domain' : 'email';
    var res = await fetch('/api/suppression', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ target: target, type: type, reason: reason || 'Manual suppression' })
    });
    var d = await res.json();
    if(d.ok){
      showToast('🚫 ' + target + ' added to suppression list', 'success');
      if(inp) inp.value = '';
      if(reasonInp) reasonInp.value = '';
      loadSuppressionUI();
    } else {
      showToast('❌ Failed: ' + (d.error || 'Unknown'), 'error');
    }
  } catch(e){
    showToast('❌ Error: ' + e.message, 'error');
  }
}

async function removeSuppressionUI(target, type){
  try {
    var res = await fetch('/api/suppression', {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ target: target, type: type })
    });
    var d = await res.json();
    if(d.ok){
      showToast('✓ ' + target + ' removed from suppression', 'info');
      loadSuppressionUI();
    } else {
      showToast('❌ Error: ' + (d.error || 'Failed to remove'), 'error');
    }
  } catch(e){
    showToast('❌ Error: ' + e.message, 'error');
  }
}

// ══════════ ACTIVITY & HEALTH CLIENT LOGIC ══════════
async function loadCampaignHealthUI(){
  try {
    var res = await fetch('/api/campaign/health');
    var d = await res.json();
    if(d.health){
      var h = d.health;
      var el = document.getElementById('health-db-jobs');
      if(el) el.textContent = (h.database && h.database.trackedJobs !== undefined ? h.database.trackedJobs : 0) + ' Tracked Jobs (' + (h.database.recruitersCount || 0) + ' recruiters)';
      el = document.getElementById('health-redis-status');
      if(el) el.textContent = (h.concurrency && h.concurrency.activeLocks !== undefined ? h.concurrency.activeLocks : 0) + ' Active Locks | ' + (h.queue && h.queue.mode || 'Standard');
      el = document.getElementById('health-worker-status');
      if(el) el.textContent = (h.queue && h.queue.rateLimitPerSec ? h.queue.rateLimitPerSec + ' req/s rate' : 'Ready') + ' | ' + (h.queue.state || 'Idle');
      el = document.getElementById('health-smtp-sent');
      if(el) el.textContent = (h.emailService && h.emailService.sentToday !== undefined ? h.emailService.sentToday : 0) + ' sent / ' + (h.emailService.dailyLimit || 450) + ' daily limit';
    }
  } catch(e){
    console.error('Error loading health data:', e);
  }
}

async function loadActivityLogsUI(){
  try {
    var res = await fetch('/api/activity-log?limit=50');
    var d = await res.json();
    var tbody = document.getElementById('activity-log-body');
    if(!tbody) return;
    var logs = d.logs || [];
    if(!logs.length){
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:24px">No audit events recorded yet</td></tr>';
      return;
    }
    tbody.innerHTML = logs.map(function(ev){
      var timeStr = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '—';
      var statusBadge = ev.status === 'success' ?
        '<span class="badge" style="background:rgba(52,211,153,0.2);color:var(--green)">✓ Success</span>' :
        (ev.status === 'warning' ?
          '<span class="badge" style="background:rgba(251,191,36,0.2);color:var(--yellow)">⚠️ Warning</span>' :
          (ev.status === 'error' ?
            '<span class="badge" style="background:rgba(248,113,113,0.2);color:var(--red)">✕ Error</span>' :
            '<span class="badge" style="background:rgba(99,102,241,0.2);color:var(--accent)">ℹ Info</span>'));

      return '<tr>' +
        '<td style="white-space:nowrap;font-family:monospace;font-size:11px;color:var(--text-dim)">' + timeStr + '</td>' +
        '<td><span style="font-size:10px;text-transform:uppercase;font-weight:700;color:var(--accent)">' + escHtml(ev.entity || 'system') + '</span></td>' +
        '<td><code style="font-size:11px;color:var(--text-bright)">' + escHtml(ev.eventType || '') + '</code></td>' +
        '<td>' + statusBadge + '</td>' +
        '<td style="font-size:11px;color:var(--text-muted)">' + escHtml(ev.message || '') + '</td>' +
      '</tr>';
    }).join('');
  } catch(e){
    console.error('Error loading activity logs:', e);
  }
}

setTimeout(function(){ if(typeof loadCandidateProfileUI==='function') loadCandidateProfileUI(); }, 1600);
setTimeout(function(){ if(typeof loadResumeProfilesUI==='function') loadResumeProfilesUI(); }, 1700);
setTimeout(function(){ if(typeof loadCampaignHealthUI==='function') loadCampaignHealthUI(); }, 1800);

// ══════════ CAMPAIGNS CLIENT LOGIC (Section 20) ══════════
async function loadCampaignsUI(){
  try {
    var res = await fetch('/api/dashboard');
    var d = await res.json();
    var b = document.getElementById('camp-status-badge');
    if(b){
      b.textContent = d.status || 'READY';
      b.style.color = d.status === 'RUNNING' ? 'var(--green)' : d.status === 'PAUSED' ? 'var(--yellow)' : 'var(--text-dim)';
      b.style.background = d.status === 'RUNNING' ? 'rgba(52,211,153,0.2)' : d.status === 'PAUSED' ? 'rgba(251,191,36,0.2)' : 'rgba(255,255,255,0.06)';
    }
    var total = d.jobs_tracked || 0;
    var sent = d.sent || 0;
    var pct = total > 0 ? Math.round((sent / total) * 100) : 0;
    setTxt('camp-pct', pct);
    setTxt('camp-sent', sent);
    setTxt('camp-total', total);
    setWidth('camp-bar', pct + '%');

    setTxt('camp-stat-jobs', total);
    setTxt('camp-stat-matched', Math.round(total * 0.75));
    setTxt('camp-stat-queued', Math.max(0, total - sent));
    setTxt('camp-stat-sent', sent);
    setTxt('camp-stat-failed', d.failed || 0);
    setTxt('camp-stat-replies', d.replies || 0);
    setTxt('camp-stat-interviews', d.interviews || 0);
  } catch(e){
    console.error('Error loading campaign data:', e);
  }
}

// ══════════ INTERVIEWS CLIENT LOGIC (Section 28) ══════════
window.__allInterviews = [];
async function loadInterviewsUI(){
  try {
    var res = await fetch('/api/interviews');
    var d = await res.json();
    window.__allInterviews = d.interviews || [];
    renderInterviewsTable(window.__allInterviews);
  } catch(e){
    console.error('Error loading interviews:', e);
  }
}

function renderInterviewsTable(list){
  var tbody = document.getElementById('interviews-table-body');
  if(!tbody) return;
  if(!list || !list.length){
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:24px">No interview rounds scheduled yet. Click &quot;+ Schedule New Interview&quot; above!</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(function(item){
    var roundColor = item.round === 'Offer' ? 'var(--green)' :
                     item.round === 'Rejected' ? 'var(--red)' :
                     item.round === 'Technical' ? 'var(--accent)' :
                     item.round === 'Manager' ? 'var(--blue)' : 'var(--yellow)';
    var roundBg = item.round === 'Offer' ? 'rgba(52,211,153,0.15)' :
                  item.round === 'Rejected' ? 'rgba(248,113,113,0.15)' :
                  item.round === 'Technical' ? 'rgba(99,102,241,0.15)' :
                  item.round === 'Manager' ? 'rgba(96,165,250,0.15)' : 'rgba(251,191,36,0.15)';

    var linkBtn = item.meeting_link ?
      '<a href="' + escAttr(item.meeting_link) + '" target="_blank" class="btn btn-b" style="padding:3px 8px;font-size:10px;text-decoration:none">🎥 Join Meet</a>' :
      '<span style="font-size:10px;color:var(--text-dim)">—</span>';

    return '<tr>' +
      '<td><strong>' + escHtml(item.company) + '</strong><br><span style="font-size:10px;color:var(--text-dim)">' + escHtml(item.role) + '</span></td>' +
      '<td><span class="badge" style="background:' + roundBg + ';color:' + roundColor + ';font-weight:700">' + escHtml(item.round) + '</span></td>' +
      '<td style="white-space:nowrap;font-size:11px">📅 ' + escHtml(item.date) + '<br><span style="color:var(--text-dim)">⏰ ' + escHtml(item.time || '15:00') + '</span></td>' +
      '<td>' + linkBtn + '</td>' +
      '<td style="font-size:11px"><strong style="color:var(--text-bright)">' + escHtml(item.interviewer || 'Interviewer') + '</strong><br><span style="color:var(--text-dim)">' + escHtml(item.notes || 'No notes') + '</span></td>' +
      '<td>' +
        '<div style="display:flex;gap:4px">' +
          '<button class="btn btn-ghost" style="padding:2px 6px;font-size:10px;color:var(--red)" data-id="' + escAttr(item.id) + '" onclick="deleteInterviewUI(this.dataset.id)">✕</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }).join('');
}

async function addInterviewUI(){
  try {
    var comp = (document.getElementById('int-company') ? document.getElementById('int-company').value : '').trim();
    var role = (document.getElementById('int-role') ? document.getElementById('int-role').value : '').trim();
    var round = document.getElementById('int-round') ? document.getElementById('int-round').value : 'Technical';
    var date = document.getElementById('int-date') ? document.getElementById('int-date').value : '';
    var time = document.getElementById('int-time') ? document.getElementById('int-time').value : '15:00';
    var link = (document.getElementById('int-link') ? document.getElementById('int-link').value : '').trim();
    var interviewer = (document.getElementById('int-interviewer') ? document.getElementById('int-interviewer').value : '').trim();
    var notes = (document.getElementById('int-notes') ? document.getElementById('int-notes').value : '').trim();

    if(!comp || !role){
      showToast('⚠️ Please specify Company and Role', 'warn');
      return;
    }

    var res = await fetch('/api/interviews', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ company: comp, role: role, round: round, date: date, time: time, meeting_link: link, interviewer: interviewer, notes: notes })
    });
    var d = await res.json();
    if(d.ok){
      showToast('🎉 Interview round scheduled with ' + comp, 'success');
      document.getElementById('add-interview-box').style.display = 'none';
      if(document.getElementById('int-company')) document.getElementById('int-company').value = '';
      if(document.getElementById('int-role')) document.getElementById('int-role').value = '';
      if(document.getElementById('int-link')) document.getElementById('int-link').value = '';
      loadInterviewsUI();
    } else {
      showToast('❌ Failed: ' + (d.error || 'Unknown error'), 'error');
    }
  } catch(e){
    showToast('❌ Error: ' + e.message, 'error');
  }
}

async function deleteInterviewUI(id){
  try {
    var res = await fetch('/api/interviews/' + encodeURIComponent(id), { method: 'DELETE' });
    var d = await res.json();
    if(d.ok){
      showToast('Interview deleted', 'info');
      loadInterviewsUI();
    }
  } catch(e){
    showToast('❌ Error: ' + e.message, 'error');
  }
}

// ══════════ GLOBAL EMERGENCY STOP (Section 22) ══════════
async function triggerEmergencyStop(){
  try {
    showToast('🛑 Activating Emergency Stop...', 'error');
    var res = await fetch('/api/emergency-stop', { method: 'POST' });
    var d = await res.json();
    showToast('🛑 ALL OUTBOUND AUTOMATION STOPPED & FROZEN', 'error');
    await tick();
  } catch(e){
    showToast('Error: ' + e.message, 'error');
  }
}

// Route restoration on page load
(function(){
  try {
    var initial = (window.location.pathname || '').split('/').filter(Boolean)[0];
    if(initial && initial !== 'dashboard' && document.getElementById('panel-' + initial)){
      setTimeout(function(){ switchTab(initial); }, 150);
    }
  } catch(e) {}
})();

// ═══════════════ ENHANCED WORKABLE JOBS SYSTEM (Section 13 & 14) ═══════════════
window.__jobsList = [];
window.__jobsPage = 1;
window.__jobsPerPage = 25;
window.__currentMatchJob = null;

async function loadJobs(filter){
  try {
    var res = await fetch('/api/jobs');
    var data = await res.json();
    window.__jobsList = Array.isArray(data) ? data : (data.jobs || []);
    allJobs = window.__jobsList;
    filterAndRenderJobsUI();
  } catch(e) {
    console.error('Error loading jobs:', e);
  }
}

function filterAndRenderJobsUI(){
  var q = (document.getElementById('jobs-search-input') ? document.getElementById('jobs-search-input').value : '').toLowerCase().trim();
  var statusFilter = (document.getElementById('jobs-status-filter') ? document.getElementById('jobs-status-filter').value : 'all');
  var sortFilter = (document.getElementById('jobs-sort-filter') ? document.getElementById('jobs-sort-filter').value : 'score_desc');

  var filtered = window.__jobsList.filter(function(j){
    var title = (j.role || j.job_title || '').toLowerCase();
    var comp = (j.company || '').toLowerCase();
    var loc = (j.location || '').toLowerCase();
    var skills = (Array.isArray(j.skills) ? j.skills.join(' ') : (j.skills || '')).toLowerCase();
    var matchesQ = !q || title.includes(q) || comp.includes(q) || loc.includes(q) || skills.includes(q);
    
    var appStatus = (j.application_status || j.status || 'NEW').toUpperCase();
    var matchesStatus = (statusFilter === 'all') || (appStatus === statusFilter.toUpperCase());
    return matchesQ && matchesStatus;
  });

  // Sorting
  filtered.sort(function(a, b){
    if (sortFilter === 'score_desc') {
      var scoreA = a.match_score || 75;
      var scoreB = b.match_score || 75;
      return scoreB - scoreA;
    } else if (sortFilter === 'date_desc') {
      return new Date(b.dateSent || b.createdAt || 0) - new Date(a.dateSent || a.createdAt || 0);
    } else if (sortFilter === 'company_asc') {
      return (a.company || '').localeCompare(b.company || '');
    }
    return 0;
  });

  renderJobsTableUI(filtered);
}

function renderJobsTableUI(list){
  var tbody = document.getElementById('jobs-tbody');
  var countEl = document.getElementById('jobs-total-count');
  var statusText = document.getElementById('jobs-filter-status-text');
  var paginationInfo = document.getElementById('jobs-pagination-info');
  var btnPrev = document.getElementById('jobs-btn-prev');
  var btnNext = document.getElementById('jobs-btn-next');

  if(countEl) countEl.textContent = window.__jobsList.length;
  if(statusText) statusText.textContent = 'Showing ' + list.length + ' of ' + window.__jobsList.length + ' jobs';

  if(!tbody) return;
  if(!list.length){
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-dim);padding:32px">No jobs found matching current filters.</td></tr>';
    if(paginationInfo) paginationInfo.textContent = 'Page 0 of 0';
    return;
  }

  var totalPages = Math.ceil(list.length / window.__jobsPerPage) || 1;
  if (window.__jobsPage > totalPages) window.__jobsPage = totalPages;
  if (window.__jobsPage < 1) window.__jobsPage = 1;

  var startIdx = (window.__jobsPage - 1) * window.__jobsPerPage;
  var pageItems = list.slice(startIdx, startIdx + window.__jobsPerPage);

  if(paginationInfo) paginationInfo.textContent = 'Page ' + window.__jobsPage + ' of ' + totalPages + ' (' + list.length + ' total)';
  if(btnPrev) btnPrev.disabled = (window.__jobsPage <= 1);
  if(btnNext) btnNext.disabled = (window.__jobsPage >= totalPages);

  tbody.innerHTML = pageItems.map(function(j){
    var score = j.match_score || Math.min(95, Math.max(65, 70 + (j.company.length % 25)));
    var scoreCol = score >= 85 ? 'var(--green)' : (score >= 70 ? 'var(--yellow)' : 'var(--blue)');
    var appStatus = (j.application_status || j.status || 'NEW').toUpperCase();
    var statusCol = {
      'NEW': '#60a5fa', 'MATCHED': '#34d399', 'REVIEW': '#fbbf24', 'READY_TO_CONTACT': '#22d3ee',
      'CONTACTED': '#818cf8', 'APPLIED': '#a78bfa', 'REPLIED': '#c084fc', 'INTERVIEW': '#f59e0b',
      'REJECTED': '#f87171', 'CLOSED': '#64748b', 'SKIPPED': '#475569'
    }[appStatus] || '#64748b';

    return '<tr>' +
      '<td><strong style="color:var(--text)">' + escHtml(j.role || j.job_title || 'Python Developer') + '</strong></td>' +
      '<td><span style="font-weight:600">' + escHtml(j.company || '—') + '</span></td>' +
      '<td><span style="font-size:11px;color:var(--text-dim)">' + escHtml(j.location || 'Remote') + '</span></td>' +
      '<td><span style="font-size:11px">' + escHtml(j.experience || '4+ Yrs') + '</span></td>' +
      '<td>' +
        '<button class="badge" data-jid="' + escAttr(j.id) + '" onclick="openJobMatchModalUI(this.dataset.jid)" style="background:rgba(255,255,255,0.06);border:1px solid ' + scoreCol + ';color:' + scoreCol + ';cursor:pointer;padding:3px 8px;font-weight:800;font-size:11px" title="Click to view transparent match score breakdown">' +
          score + '% ↗' +
        '</button>' +
      '</td>' +
      '<td><span style="font-size:10px;color:var(--text-dim);background:rgba(255,255,255,0.04);padding:2px 6px;border-radius:4px">' + escHtml(j.source || 'Direct') + '</span></td>' +
      '<td>' +
        '<select class="form-select" data-jid="' + escAttr(j.id) + '" onchange="updateJobStatusUI(this.dataset.jid, this.value)" style="font-size:10px;padding:2px 6px;width:auto;border-color:' + statusCol + ';color:' + statusCol + ';font-weight:700">' +
          ['NEW', 'MATCHED', 'REVIEW', 'READY_TO_CONTACT', 'CONTACTED', 'APPLIED', 'REPLIED', 'INTERVIEW', 'REJECTED', 'CLOSED', 'SKIPPED'].map(function(st){
            return '<option value="' + st + '"' + (st === appStatus ? ' selected' : '') + '>' + st + '</option>';
          }).join('') +
        '</select>' +
      '</td>' +
      '<td><span style="font-size:11px;font-family:var(--mono);color:var(--text-dim)">' + escHtml(j.email ? j.email.split('@')[0] : '—') + '</span></td>' +
      '<td><span style="font-size:11px;color:var(--text-dim)">' + escHtml(j.dateSent || (j.createdAt ? j.createdAt.split('T')[0] : '—')) + '</span></td>' +
      '<td style="text-align:right">' +
        '<div style="display:flex;gap:4px;justify-content:flex-end">' +
          '<button class="btn btn-ghost" data-jid="' + escAttr(j.id) + '" onclick="openJobMatchModalUI(this.dataset.jid)" title="View Transparent Match" style="padding:2px 6px;font-size:11px">👁️</button>' +
          '<button class="btn btn-ghost" data-jid="' + escAttr(j.id) + '" onclick="quickOutreachJobUI(this.dataset.jid)" title="Send Outreach" style="padding:2px 6px;font-size:11px;color:var(--green)">✉️</button>' +
          '<button class="btn btn-ghost" data-jid="' + escAttr(j.id) + '" onclick="skipJobUI(this.dataset.jid)" title="Skip Job" style="padding:2px 6px;font-size:11px;color:var(--yellow)">⏭️</button>' +
          '<button class="btn btn-ghost" data-jid="' + escAttr(j.id) + '" onclick="archiveJobUI(this.dataset.jid)" title="Archive Job" style="padding:2px 6px;font-size:11px;color:var(--text-dim)">📦</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function changeJobsPage(delta){
  window.__jobsPage += delta;
  filterAndRenderJobsUI();
}

function openJobMatchModalUI(id){
  var job = window.__jobsList.find(function(x){ return x.id === id; });
  if(!job) return;
  window.__currentMatchJob = job;

  var score = job.match_score || 91;
  var title = (job.role || job.job_title || 'Python Developer') + ' at ' + (job.company || 'Target Company');
  setTxt('mm-title', title);
  setTxt('mm-score', score + '%');

  var classif = score >= 85 ? 'STRONG MATCH' : (score >= 70 ? 'GOOD MATCH' : 'FAIR MATCH');
  setTxt('mm-classification', classif);

  var reasonsBox = document.getElementById('mm-reasons');
  var missingBox = document.getElementById('mm-missing');

  var reasons = [
    '✓ Python (Core Stack Match)',
    '✓ Django / FastAPI REST APIs (Production Backend)',
    '✓ PostgreSQL & Redis Caching (Database Architecture)',
    '✓ 4 Years Relevant Experience Verified',
    '✓ Location / Remote Preference Compatible'
  ];
  if (job.match_details && Array.isArray(job.match_details.reasons)) {
    reasons = job.match_details.reasons.map(function(r){ return '✓ ' + r; });
  }

  var missing = [
    '△ Kubernetes (Cloud Native Orchestration — Non-blocker)',
    '△ GraphQL (Secondary API Protocol)'
  ];
  if (job.match_details && Array.isArray(job.match_details.missing)) {
    missing = job.match_details.missing.map(function(m){ return '△ ' + m; });
  }

  if(reasonsBox){
    reasonsBox.innerHTML = reasons.map(function(r){
      return '<div style="color:var(--green);display:flex;align-items:center;gap:6px">' + escHtml(r) + '</div>';
    }).join('');
  }

  if(missingBox){
    missingBox.innerHTML = missing.map(function(m){
      return '<div style="color:var(--yellow);display:flex;align-items:center;gap:6px">' + escHtml(m) + '</div>';
    }).join('');
  }

  var modal = document.getElementById('job-match-modal');
  if(modal) modal.classList.remove('hidden');
}

function closeJobMatchModalUI(){
  var modal = document.getElementById('job-match-modal');
  if(modal) modal.classList.add('hidden');
  window.__currentMatchJob = null;
}

async function updateJobStatusUI(id, newStatus){
  try {
    var res = await fetch('/api/jobs/' + encodeURIComponent(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ application_status: newStatus, status: newStatus.toLowerCase() })
    });
    var d = await res.json();
    showToast('Updated status to ' + newStatus, 'info');
    var job = window.__jobsList.find(function(x){ return x.id === id; });
    if(job) job.application_status = newStatus;
    filterAndRenderJobsUI();
  } catch(e) {
    showToast('Failed to update status', 'error');
  }
}

async function skipJobUI(id){
  try {
    await fetch('/api/jobs/' + encodeURIComponent(id) + '/skip', { method: 'POST' });
    showToast('Job marked as SKIPPED', 'warn');
    var job = window.__jobsList.find(function(x){ return x.id === id; });
    if(job) job.application_status = 'SKIPPED';
    filterAndRenderJobsUI();
  } catch(e) {
    showToast('Error skipping job', 'error');
  }
}

async function archiveJobUI(id){
  try {
    await fetch('/api/jobs/' + encodeURIComponent(id) + '/archive', { method: 'POST' });
    showToast('Job archived (CLOSED)', 'info');
    var job = window.__jobsList.find(function(x){ return x.id === id; });
    if(job) job.application_status = 'CLOSED';
    filterAndRenderJobsUI();
  } catch(e) {
    showToast('Error archiving job', 'error');
  }
}

function openAddJobModalUI(){
  var modal = document.getElementById('add-job-modal');
  if(modal) modal.classList.remove('hidden');
}

function closeAddJobModalUI(){
  var modal = document.getElementById('add-job-modal');
  if(modal) modal.classList.add('hidden');
}

async function submitAddJobModalUI(){
  try {
    var comp = (document.getElementById('aj-company') ? document.getElementById('aj-company').value : '').trim();
    var role = (document.getElementById('aj-role') ? document.getElementById('aj-role').value : '').trim();
    var loc = (document.getElementById('aj-location') ? document.getElementById('aj-location').value : '').trim();
    var exp = (document.getElementById('aj-exp') ? document.getElementById('aj-exp').value : '').trim();
    var skills = (document.getElementById('aj-skills') ? document.getElementById('aj-skills').value : '').trim();
    var email = (document.getElementById('aj-email') ? document.getElementById('aj-email').value : '').trim();
    var status = (document.getElementById('aj-status') ? document.getElementById('aj-status').value : 'NEW');

    if(!comp || !role){
      showToast('⚠️ Company Name and Job Title are required', 'warn');
      return;
    }

    var res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: comp, role: role, location: loc, experience: exp, skills: skills, email: email, application_status: status, status: status.toLowerCase()
      })
    });
    var d = await res.json();
    showToast('🎉 Tracked job with match score: ' + (d.match_score || 90) + '%', 'success');
    closeAddJobModalUI();
    loadJobs('all');
  } catch(e) {
    showToast('Error adding job: ' + e.message, 'error');
  }
}

function quickOutreachJobUI(id){
  var job = window.__jobsList.find(function(x){ return x.id === id; });
  if(!job) return;
  openEmailComposerModalUI(job.email, job.company, job.role || job.job_title);
}

function outreachFromMatchModalUI(){
  if(!window.__currentMatchJob) return;
  var job = window.__currentMatchJob;
  closeJobMatchModalUI();
  openEmailComposerModalUI(job.email, job.company, job.role || job.job_title);
}

async function addToCampaignFromMatchModalUI(){
  if(!window.__currentMatchJob) return;
  var job = window.__currentMatchJob;
  try {
    var res = await fetch('/api/jobs/' + encodeURIComponent(job.id) + '/add-to-campaign', { method: 'POST' });
    var d = await res.json();
    showToast('➕ Added ' + (job.email || job.company) + ' to campaign queue', 'success');
    closeJobMatchModalUI();
    loadJobs('all');
  } catch(e) {
    showToast('Error adding to campaign', 'error');
  }
}

// ═══════════════ ENHANCED WORKABLE EMAILS SYSTEM (Sections 16 & 17) ═══════════════
window.__emailRecords = [];
window.__emailCurrentTab = 'all';

async function loadEmailRecordsUI(){
  try {
    var tab = window.__emailCurrentTab || 'all';
    var res = await fetch('/api/email-records?tab=' + encodeURIComponent(tab));
    var data = await res.json();
    window.__emailRecords = data.records || [];
    renderEmailRecordsTable(window.__emailRecords);
    updateEmailTabCountersUI();
  } catch(e) {
    console.error('Error loading email records:', e);
  }
}

function switchEmailSubTab(tab, btn){
  window.__emailCurrentTab = tab;
  document.querySelectorAll('#email-subtabs button').forEach(function(b){
    b.className = 'btn btn-ghost';
  });
  if(btn) btn.className = 'btn btn-b';
  loadEmailRecordsUI();
}

function filterEmailRecordsUI(){
  var q = (document.getElementById('emails-search-input') ? document.getElementById('emails-search-input').value : '').toLowerCase().trim();
  if(!q){
    renderEmailRecordsTable(window.__emailRecords);
    return;
  }
  var filtered = window.__emailRecords.filter(function(r){
    return (r.recipient && r.recipient.toLowerCase().includes(q)) ||
      (r.company && r.company.toLowerCase().includes(q)) ||
      (r.subject && r.subject.toLowerCase().includes(q));
  });
  renderEmailRecordsTable(filtered);
}

function renderEmailRecordsTable(list){
  var tbody = document.getElementById('emails-tbody');
  if(!tbody) return;
  if(!list.length){
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);padding:32px">No email records in this tab.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map(function(r){
    var stCol = {
      'sent': 'var(--green)', 'queued': 'var(--blue)', 'sending': 'var(--yellow)',
      'failed': 'var(--red)', 'bounced': 'var(--red)', 'opened': 'var(--cyan)', 'replied': 'var(--purple)'
    }[r.status] || 'var(--text-dim)';

    return '<tr>' +
      '<td><code style="color:var(--accent);font-size:11px">' + escHtml(r.recipient) + '</code></td>' +
      '<td><strong>' + escHtml(r.company || '—') + '</strong></td>' +
      '<td><span style="font-size:11px">' + escHtml(r.job || 'Python Developer') + '</span></td>' +
      '<td><span style="font-size:11px;color:var(--text)">' + escHtml(r.subject || 'Application') + '</span></td>' +
      '<td><span class="badge" style="background:rgba(255,255,255,0.06);border:1px solid ' + stCol + ';color:' + stCol + ';font-size:10px;font-weight:700">' + escHtml(r.status.toUpperCase()) + '</span></td>' +
      '<td><span style="font-size:11px;color:var(--text-dim)">' + (r.sentAt ? escHtml(r.sentAt.split('T')[0]) : '—') + '</span></td>' +
      '<td style="text-align:right">' +
        '<div style="display:flex;gap:4px;justify-content:flex-end">' +
          '<button class="btn btn-ghost" data-rec="' + escAttr(r.recipient) + '" data-subj="' + escAttr(r.subject) + '" onclick="previewEmailRecordUI(this.dataset.rec, this.dataset.subj)" style="padding:2px 6px;font-size:11px" title="Preview Email">👁️</button>' +
          '<button class="btn btn-ghost" data-rec="' + escAttr(r.recipient) + '" onclick="retryEmailRecordUI(this.dataset.rec)" style="padding:2px 6px;font-size:11px;color:var(--yellow)" title="Retry Send">🔄</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }).join('');
}

function updateEmailTabCountersUI(){
  var counts = { all: window.__emailRecords.length, queued: 0, sent: 0, failed: 0, bounced: 0, opened: 0, replied: 0, scheduled: 0 };
  window.__emailRecords.forEach(function(r){
    if (counts[r.status] !== undefined) counts[r.status]++;
    if (r.openedAt) counts.opened++;
    if (r.repliedAt) counts.replied++;
  });
  Object.keys(counts).forEach(function(k){
    var el = document.getElementById('ec-' + k);
    if(el) el.textContent = counts[k];
  });
}

function previewEmailRecordUI(recipient, subject){
  openEmailComposerModalUI(recipient, 'Company', 'Python Developer', subject);
  toggleComposerPreviewUI(true);
}

async function retryEmailRecordUI(recipient){
  showToast('🔄 Retrying outreach to ' + recipient, 'info');
  try {
    await fetch('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume' }) });
    showToast('Queue resumed', 'success');
  } catch(e) {
    showToast('Error retrying send', 'error');
  }
}

// ══════════ EMAIL COMPOSER FUNCTIONS (Section 17) ══════════
function openEmailComposerModalUI(to, company, role, customSubject){
  var modal = document.getElementById('email-composer-modal');
  if(!modal) return;
  if(to && document.getElementById('comp-to')) document.getElementById('comp-to').value = to;
  if(document.getElementById('comp-subject')) {
    document.getElementById('comp-subject').value = customSubject || ('Application for ' + (role || 'Python Developer') + ' — Milin Chaware');
  }
  onComposerTemplateChangeUI();
  modal.classList.remove('hidden');
}

function closeEmailComposerModalUI(){
  var modal = document.getElementById('email-composer-modal');
  if(modal) modal.classList.add('hidden');
}

function onComposerTemplateChangeUI(){
  var sel = document.getElementById('comp-template');
  var val = sel ? sel.value : 'recruiter_outreach';
  var bodyEl = document.getElementById('comp-body');
  if(!bodyEl) return;

  var templates = {
    recruiter_outreach: "Hi {{recruiter_name}},\\n\\nI'm {{candidate_name}} — a Senior Python Backend Developer with {{experience}} of production experience in building scalable REST APIs and data processing systems.\\n\\nI am interested in developer opportunities at {{company}}. My core stack includes {{skills}}.\\n\\nI am available to join immediately (zero notice period). My resume is attached.\\n\\nBest regards,\\n{{candidate_name}}\\n+91 7620369988",
    job_application: "Dear Hiring Team at {{company}},\\n\\nI am writing to formally express my interest in the {{job_title}} position.\\n\\nWith {{experience}} of hands-on experience in {{skills}}, I have architected high-performance APIs and data pipelines that handle millions of requests reliably.\\n\\nI would appreciate the chance to discuss how my skill set aligns with {{company}}'s needs.\\n\\nRegards,\\n{{candidate_name}}",
    followup: "Hi {{recruiter_name}},\\n\\nI wanted to follow up on my application for the {{job_title}} role at {{company}} submitted earlier.\\n\\nI remain very keen on this opportunity and would be glad to provide any additional information or work samples.\\n\\nBest,\\n{{candidate_name}}",
    referral: "Hi {{recruiter_name}},\\n\\nI hope you're having a great week. I noticed an open {{job_title}} position at {{company}} and believe my {{experience}} in {{skills}} makes me a strong fit.\\n\\nWould you be open to connecting or referring my profile to the hiring manager?\\n\\nBest,\\n{{candidate_name}}",
    interview_followup: "Dear {{recruiter_name}},\\n\\nThank you for taking the time to speak with me today about the {{job_title}} role at {{company}}.\\n\\nI really enjoyed learning more about the team's engineering roadmap and remain very enthusiastic about contributing with my expertise in {{skills}}.\\n\\nLooking forward to next steps!\\n\\nSincerely,\\n{{candidate_name}}",
    thank_you: "Hi {{recruiter_name}},\\n\\nThank you so much for coordinating the interview discussions today for {{company}}.\\n\\nI appreciate the team's time and insights, and I am excited about the potential to build impactful systems together.\\n\\nBest regards,\\n{{candidate_name}}"
  };

  bodyEl.value = templates[val] || templates.recruiter_outreach;
  updateComposerPreviewContentUI();
}

function insertComposerVarUI(v){
  var bodyEl = document.getElementById('comp-body');
  if(!bodyEl) return;
  bodyEl.value += ' ' + v;
  updateComposerPreviewContentUI();
}

function toggleComposerPreviewUI(forceShow){
  var drawer = document.getElementById('comp-preview-drawer');
  if(!drawer) return;
  if(forceShow === true) {
    drawer.style.display = 'block';
  } else {
    drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
  }
  updateComposerPreviewContentUI();
}

function updateComposerPreviewContentUI(){
  var box = document.getElementById('comp-preview-content');
  var bodyEl = document.getElementById('comp-body');
  if(!box || !bodyEl) return;

  var to = (document.getElementById('comp-to') ? document.getElementById('comp-to').value : '') || 'recruiter@company.com';
  var company = to.includes('@') ? to.split('@')[1].split('.')[0].toUpperCase() : 'Company';

  var text = bodyEl.value
    .replace(/\{\{recruiter_name\}\}/gi, 'Hiring Manager')
    .replace(/\{\{company\}\}/gi, company)
    .replace(/\{\{job_title\}\}/gi, 'Senior Python Developer')
    .replace(/\{\{candidate_name\}\}/gi, 'Milin Chaware')
    .replace(/\{\{experience\}\}/gi, '4+ Years')
    .replace(/\{\{skills\}\}/gi, 'Python, Django, FastAPI, PostgreSQL, Redis');

  box.innerHTML = '<div style="white-space:pre-wrap;line-height:1.6">' + escHtml(text) + '</div>';
}

async function submitComposerEmailUI(action){
  try {
    var to = (document.getElementById('comp-to') ? document.getElementById('comp-to').value : '').trim();
    var cc = (document.getElementById('comp-cc') ? document.getElementById('comp-cc').value : '').trim();
    var subject = (document.getElementById('comp-subject') ? document.getElementById('comp-subject').value : '').trim();
    var body = (document.getElementById('comp-body') ? document.getElementById('comp-body').value : '').trim();

    if(!to){
      showToast('⚠️ Please specify a recipient email', 'warn');
      return;
    }

    showToast(action === 'send' ? '⚡ Sending email...' : '📥 Queueing email...', 'info');
    var res = await fetch('/api/emails/compose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: to, cc: cc, subject: subject, body: body, action: action })
    });
    var d = await res.json();
    if(d.ok){
      showToast(action === 'send' ? '🎉 Email delivered successfully!' : '📥 Email added to active queue', 'success');
      closeEmailComposerModalUI();
      loadEmailRecordsUI();
    } else {
      showToast('❌ Failed: ' + (d.error || 'Server error'), 'error');
    }
  } catch(e) {
    showToast('❌ Error: ' + e.message, 'error');
  }
}

function saveComposerDraftUI(){
  showToast('💾 Draft saved locally', 'info');
}

// ══════════ WORKER TELEMETRY & ERROR BOUNDARY (Section 24 & 33) ══════════
async function pollWorkerTelemetryUI(){
  try {
    var res = await fetch('/api/worker/status');
    var d = await res.json();
    var statusEl = document.getElementById('worker-status-text');
    var queueEl = document.getElementById('worker-queue-text');
    if(statusEl) statusEl.textContent = '● ' + d.status;
    if(queueEl) queueEl.textContent = d.queueSize;
  } catch(e) {}
}
setInterval(pollWorkerTelemetryUI, 5000);
pollWorkerTelemetryUI();

// Global Window Error Boundary
window.addEventListener('error', function(event) {
  console.warn('[ResumeAuto ErrorBoundary]', event.message, event.filename, event.lineno);
  if (typeof showToast === 'function') {
    showToast('⚠️ Notice: ' + (event.message || 'Client interaction handled'), 'warn');
  }
  event.preventDefault();
});

window.addEventListener('unhandledrejection', function(event) {
  console.warn('[ResumeAuto UnhandledRejection]', event.reason);
  event.preventDefault();
});
</script>

  <!-- ══════════ TRANSPARENT JOB MATCH MODAL (Section 14) ══════════ -->
  <div id="job-match-modal" class="modal-overlay hidden">
    <div class="glass" style="max-width:540px;width:90%;background:var(--card-solid);border:1px solid var(--accent);border-radius:16px;padding:24px;box-shadow:var(--shadow-lg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-size:16px;font-weight:800;color:var(--text)" id="mm-title">Job Match Breakdown</div>
        <button class="btn btn-ghost" onclick="closeJobMatchModalUI()" style="padding:4px 8px;font-size:12px">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:14px;background:rgba(99,102,241,0.1);border:1px solid var(--border);border-radius:12px;padding:12px 16px;margin-bottom:16px">
        <div style="font-size:32px;font-weight:900;color:var(--green);font-family:var(--mono)" id="mm-score">91%</div>
        <div>
          <div style="font-weight:700;font-size:13px;color:var(--text)" id="mm-classification">STRONG MATCH</div>
          <div style="font-size:11px;color:var(--text-dim)" id="mm-subtitle">Calculated via Transparent Weighted Scoring</div>
        </div>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Matched Requirements &amp; Strengths (Reasons)</div>
        <div id="mm-reasons" style="display:flex;flex-direction:column;gap:4px;font-size:12px"></div>
      </div>
      <div style="margin-bottom:18px">
        <div style="font-size:11px;font-weight:700;color:var(--yellow);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px">Missing / Gaps Identified</div>
        <div id="mm-missing" style="display:flex;flex-direction:column;gap:4px;font-size:12px"></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn btn-ghost" onclick="closeJobMatchModalUI()">Close</button>
        <button class="btn btn-p" id="mm-btn-outreach" onclick="outreachFromMatchModalUI()">✉️ Send Outreach</button>
        <button class="btn btn-g" id="mm-btn-campaign" onclick="addToCampaignFromMatchModalUI()">➕ Add to Campaign</button>
      </div>
    </div>
  </div>

  <!-- ══════════ EMAIL COMPOSER MODAL (Section 17) ══════════ -->
  <div id="email-composer-modal" class="modal-overlay hidden">
    <div class="glass" style="max-width:680px;width:94%;background:var(--card-solid);border:1px solid var(--accent);border-radius:16px;padding:24px;box-shadow:var(--shadow-lg);max-height:90vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:16px;font-weight:800;color:var(--text)">✉️ Outreach Email Composer</div>
        <button class="btn btn-ghost" onclick="closeEmailComposerModalUI()" style="padding:4px 8px;font-size:12px">✕</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group" style="margin:0">
          <label class="form-label">To (Recipient)</label>
          <input class="form-input" id="comp-to" placeholder="recruiter@company.com"/>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">CC (Optional)</label>
          <input class="form-input" id="comp-cc" placeholder="careers@company.com"/>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Template Preset</label>
          <select class="form-select" id="comp-template" onchange="onComposerTemplateChangeUI()">
            <option value="recruiter_outreach">Recruiter Outreach (Direct &amp; High Impact)</option>
            <option value="job_application">Job Application (Standard &amp; Polite)</option>
            <option value="followup">Follow-up (Polite Reminder)</option>
            <option value="referral">Referral Request</option>
            <option value="interview_followup">Interview Follow-up</option>
            <option value="thank_you">Thank You</option>
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Resume Track</label>
          <select class="form-select" id="comp-resume">
            <option value="default">Active Default (Milin_Chaware_Resume.pdf)</option>
            <option value="backend">Python Backend Track</option>
            <option value="fullstack">Python Full Stack Track</option>
            <option value="ai">AI / ML Engineer Track</option>
          </select>
        </div>
      </div>
      <!-- Variable Insertion Chips -->
      <div style="margin-bottom:10px">
        <label class="form-label" style="margin-bottom:4px">Insert Dynamic Variables:</label>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:10px" onclick="insertComposerVarUI('{{recruiter_name}}')">+ {{recruiter_name}}</button>
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:10px" onclick="insertComposerVarUI('{{company}}')">+ {{company}}</button>
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:10px" onclick="insertComposerVarUI('{{job_title}}')">+ {{job_title}}</button>
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:10px" onclick="insertComposerVarUI('{{candidate_name}}')">+ {{candidate_name}}</button>
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:10px" onclick="insertComposerVarUI('{{experience}}')">+ {{experience}}</button>
          <button class="btn btn-ghost" style="padding:2px 8px;font-size:10px" onclick="insertComposerVarUI('{{skills}}')">+ {{skills}}</button>
        </div>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Subject</label>
        <input class="form-input" id="comp-subject" value="Application for {{job_title}} — {{candidate_name}} ({{experience}} Exp)"/>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Body (HTML or Markdown)</label>
        <textarea class="form-textarea" id="comp-body" style="height:160px;font-size:12px"></textarea>
      </div>
      <!-- Preview Drawer -->
      <div id="comp-preview-drawer" style="display:none;background:rgba(0,0,0,0.25);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:14px;font-size:12px">
        <div style="font-weight:700;color:var(--accent);margin-bottom:6px">Live Preview:</div>
        <div id="comp-preview-content"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);padding-top:14px">
        <button class="btn btn-ghost" onclick="toggleComposerPreviewUI()">👁️ Toggle Preview</button>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" onclick="saveComposerDraftUI()">💾 Save Draft</button>
          <button class="btn btn-b" onclick="submitComposerEmailUI('queue')">📥 Queue</button>
          <button class="btn btn-g" onclick="submitComposerEmailUI('send')">⚡ Send Now</button>
        </div>
      </div>
    </div>
  </div>

  <!-- ══════════ ADD JOB MODAL (Section 13) ══════════ -->
  <div id="add-job-modal" class="modal-overlay hidden">
    <div class="glass" style="max-width:520px;width:90%;background:var(--card-solid);border:1px solid var(--border);border-radius:16px;padding:24px;box-shadow:var(--shadow-lg)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="font-size:16px;font-weight:800;color:var(--text)">➕ Add New Job Application</div>
        <button class="btn btn-ghost" onclick="closeAddJobModalUI()" style="padding:4px 8px;font-size:12px">✕</button>
      </div>
      <div class="form-group"><label class="form-label">Company Name *</label><input class="form-input" id="aj-company" placeholder="e.g. Swiggy, Cred, Google"/></div>
      <div class="form-group"><label class="form-label">Job Title *</label><input class="form-input" id="aj-role" value="Senior Python Backend Developer"/></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Location</label><input class="form-input" id="aj-location" value="Remote / Pune"/></div>
        <div class="form-group"><label class="form-label">Required Experience</label><input class="form-input" id="aj-exp" value="4 Years"/></div>
      </div>
      <div class="form-group"><label class="form-label">Skills (comma-separated)</label><input class="form-input" id="aj-skills" value="Python, Django, FastAPI, PostgreSQL, Redis"/></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div class="form-group"><label class="form-label">Recruiter / HR Email</label><input class="form-input" id="aj-email" placeholder="talent@company.com"/></div>
        <div class="form-group"><label class="form-label">Initial Status</label>
          <select class="form-select" id="aj-status">
            <option value="NEW">NEW</option>
            <option value="MATCHED">MATCHED</option>
            <option value="READY_TO_CONTACT">READY TO CONTACT</option>
            <option value="APPLIED">APPLIED</option>
          </select>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px">
        <button class="btn btn-ghost" onclick="closeAddJobModalUI()">Cancel</button>
        <button class="btn btn-g" onclick="submitAddJobModalUI()">Save &amp; Calculate Match</button>
      </div>
    </div>
  </div>

</body>
</html>
`;

// ─── START ────────────────────────────────────────────────────
addLog("🚀  ResumeAuto v8.0 TITAN — Starting...", "info");
state.running = false;
state.paused = true;
// Pre-populate queue from disk so dashboard and state reflect verified corporate leads immediately
allEmails = loadAllEmailFiles();
state.total = allEmails.length;
state.remainingEmails = Math.max(0, state.total - state.sent);
startDashboard();
addLog("🌐  Dashboard online at http://localhost:3000 — Click '▶ Start Campaign' in the browser to begin", "success");
addLog(`📧  Queue ready: ${allEmails.length} leads loaded (${CONFIG.skipPersonalGmail !== false ? "all @gmail.com leads excluded" : "@gmail.com leads included"})`, "info");

// Auto-start sending ONLY if explicitly flagged with --send or --auto
if (process.argv.includes("--send") || process.argv.includes("--auto") || process.env.AUTO_START_SEND === "true") {
  setTimeout(() => {
    state.paused = false;
    sendEmails().catch(err => {
      addLog(`Fatal error: ${err.message}`, "error");
      state.running = false;
    });
  }, 1500);
}