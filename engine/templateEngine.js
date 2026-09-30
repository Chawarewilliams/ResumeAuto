/**
 * ResumeAuto Engine — Multi-Category Template System
 * Supports 8 category presets, handlebars-style variables, and instant preview.
 */

const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync } = require("./storage");

const TEMPLATES_FILE = path.resolve("./templates_categorized.json");

const TEMPLATE_CATEGORIES = {
  RECRUITER_OUTREACH: "Recruiter Outreach",
  DIRECT_APPLICATION: "Direct Application",
  REFERRAL_REQUEST: "Referral Request",
  FOLLOW_UP: "Follow-up",
  INTERVIEW_FOLLOW_UP: "Interview Follow-up",
  THANK_YOU: "Thank You",
  AVAILABILITY_CONFIRMATION: "Availability Confirmation",
  JOB_APPLICATION: "Job Application",
};

const DEFAULT_TEMPLATES = [
  {
    id: "recruiter_outreach_1",
    category: "RECRUITER_OUTREACH",
    name: "Core Tech Snapshot (Achievement Focused)",
    subject: "Application for {{job_title}} — {{candidate_name}} ({{experience}} Exp) | Immediate Joiner",
    plainText: `Hi {{recruiter_name}},

I'm {{candidate_name}} — a Python Backend & AI/ML Developer with {{experience}} of experience building high-performance backend systems, REST APIs, and data processing pipelines.

Quick snapshot of what I bring to {{company}}:
• 15+ Production APIs built with Django DRF & FastAPI (handling 50K+ daily requests)
• Data Pipelines & Analytics: 2M+ records/day processed using Pandas & NumPy
• AI / ML Integration: hands-on with ML workflows and intelligent backend automation
• 40% faster PostgreSQL query performance through profiling, indexing, and Redis caching
• Containerized AWS & Docker deployments with 99.9% uptime

Core Stack: {{skills}}

I am an immediate joiner with zero notice period. My resume is attached for your review.

I would welcome a brief conversation if there is an open opportunity at {{company}}.

Best regards,

{{candidate_name}}
Phone: +91 7620369988
Email: milinchaware9@gmail.com
LinkedIn: https://www.linkedin.com/in/milin-chaware-9a1b4b1a7/`,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14.5px; line-height: 1.6; color: #1f2937; max-width: 650px;">
  <p style="margin: 0 0 16px 0;">Hi {{recruiter_name}},</p>
  <p style="margin: 0 0 16px 0;">I'm <strong>{{candidate_name}}</strong> — a Python Backend &amp; AI/ML Developer with <strong>{{experience}}</strong> building high-performance backend systems and data pipelines.</p>
  <p style="margin: 0 0 8px 0;"><strong>Quick snapshot of what I bring to {{company}}:</strong></p>
  <ul style="margin: 0 0 16px 0; padding-left: 20px;">
    <li style="margin-bottom: 6px;"><strong>15+ Production APIs</strong> built with Django DRF &amp; FastAPI (serving 50K+ daily requests)</li>
    <li style="margin-bottom: 6px;"><strong>Data Pipelines &amp; Analytics:</strong> 2M+ records/day processed using <strong>Pandas &amp; NumPy</strong></li>
    <li style="margin-bottom: 6px;"><strong>AI / ML Integration:</strong> hands-on with ML workflows and intelligent backend automation</li>
    <li style="margin-bottom: 6px;"><strong>40% faster</strong> PostgreSQL queries via indexing, profiling &amp; Redis caching</li>
    <li style="margin-bottom: 6px;"><strong>AWS &amp; DevOps:</strong> containerized deployments on AWS (EC2, S3, Docker) with 99.9% uptime</li>
  </ul>
  <p style="margin: 0 0 16px 0;"><strong>Core Stack:</strong> {{skills}}</p>
  <p style="margin: 0 0 16px 0;">I am an <strong>immediate joiner (zero notice period)</strong>. My resume is attached for your review.</p>
  <p style="margin: 0; line-height: 1.6;">
    Best regards,<br>
    <strong>{{candidate_name}}</strong><br>
    Phone: +91 7620369988<br>
    Email: <a href="mailto:milinchaware9@gmail.com" style="color: #2563eb; text-decoration: none;">milinchaware9@gmail.com</a><br>
    LinkedIn: <a href="https://www.linkedin.com/in/milin-chaware-9a1b4b1a7/" style="color: #2563eb; text-decoration: none;">linkedin.com/in/milin-chaware-9a1b4b1a7</a>
  </p>
</div>`,
  },
  {
    id: "follow_up_1",
    category: "FOLLOW_UP",
    name: "Polite Check-in Follow-up",
    subject: "Following up: Application for {{job_title}} — {{candidate_name}}",
    plainText: `Hi {{recruiter_name}},

I hope you are having a productive week.

I wanted to quickly follow up on my application for the {{job_title}} role at {{company}}. I remain very interested in the team's engineering challenges and would love to contribute with my Python backend & data systems background.

Please let me know if you would like any additional portfolio links or code samples.

Best regards,
{{candidate_name}}
+91 7620369988`,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14.5px; line-height: 1.6; color: #1f2937; max-width: 600px;">
  <p>Hi {{recruiter_name}},</p>
  <p>I hope you are having a productive week.</p>
  <p>I wanted to quickly follow up on my application for the <strong>{{job_title}}</strong> role at <strong>{{company}}</strong>. I remain very interested in your team's engineering challenges and would love to contribute with my Python backend &amp; data systems background.</p>
  <p>Please let me know if you would like any additional details, portfolio links, or code samples.</p>
  <p>Best regards,<br><strong>{{candidate_name}}</strong><br>+91 7620369988</p>
</div>`,
  },
  {
    id: "direct_app_1",
    category: "DIRECT_APPLICATION",
    name: "Direct Engineering Application",
    subject: "{{job_title}} Application — {{candidate_name}} (Immediate Joiner)",
    plainText: `Dear Hiring Team at {{company}},

Please accept my application for the {{job_title}} position.

With {{experience}} building production APIs (FastAPI & Django), managing high-throughput data processing, and optimizing PostgreSQL performance, I am excited about the opportunity to join {{company}}.

I am available to join immediately (notice period: {{notice_period}}).

Resume attached for your review.

Sincerely,
{{candidate_name}}
milinchaware9@gmail.com`,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14.5px; line-height: 1.6; color: #1f2937;">
  <p>Dear Hiring Team at {{company}},</p>
  <p>Please accept my application for the <strong>{{job_title}}</strong> position.</p>
  <p>With <strong>{{experience}}</strong> building production APIs (FastAPI &amp; Django), managing high-throughput data processing, and optimizing PostgreSQL performance, I am excited about the opportunity to join <strong>{{company}}</strong>.</p>
  <p>I am available to join <strong>immediately</strong> (notice period: {{notice_period}}).</p>
  <p>Resume attached for your review.</p>
  <p>Sincerely,<br><strong>{{candidate_name}}</strong><br>milinchaware9@gmail.com</p>
</div>`,
  }
];

function loadTemplates() {
  const data = safeReadJsonSync(TEMPLATES_FILE, null);
  if (data && Array.isArray(data)) return data;
  return DEFAULT_TEMPLATES;
}

function saveTemplates(list) {
  atomicWriteJsonSync(TEMPLATES_FILE, list);
}

/**
 * Render variables into subject, plainText, and html.
 * Supports both {{variable}} and {variable} syntax.
 */
function renderTemplate(template, context = {}) {
  const defaults = {
    recruiter_name: context.recruiter_name || context.name || "Hiring Team",
    company: context.company || "Target Company",
    job_title: context.job_title || context.role || "Python Developer",
    candidate_name: context.candidate_name || "Milin Chaware",
    experience: context.experience || "4+ years",
    skills: context.skills || "Python · Django · FastAPI · PostgreSQL · Redis · Celery · Docker · AWS",
    location: context.location || "Remote / Pune",
    notice_period: context.notice_period || "0 days (Immediate Joiner)",
  };

  const replaceVars = (text) => {
    if (!text || typeof text !== "string") return "";
    let rendered = text;

    for (const [key, val] of Object.entries(defaults)) {
      // {{key}}
      const reDouble = new RegExp(`{{\\s*${key}\\s*}}`, "gi");
      rendered = rendered.replace(reDouble, String(val));
      // {key}
      const reSingle = new RegExp(`{\\s*${key}\\s*}`, "gi");
      rendered = rendered.replace(reSingle, String(val));
    }

    // Legacy aliases
    rendered = rendered.replace(/{role}/gi, defaults.job_title);
    rendered = rendered.replace(/{sender_name}/gi, defaults.candidate_name);
    return rendered;
  };

  return {
    subject: replaceVars(template.subject),
    plainText: replaceVars(template.plainText),
    html: replaceVars(template.html),
  };
}

module.exports = {
  TEMPLATE_CATEGORIES,
  DEFAULT_TEMPLATES,
  loadTemplates,
  saveTemplates,
  renderTemplate,
};
