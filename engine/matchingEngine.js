/**
 * ResumeAuto Engine — Intelligent Job Matching Engine
 * Calculates deterministic, transparent match scores with factor-by-factor explanations.
 */

const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync } = require("./storage");

const PROFILE_FILE = path.resolve("./candidate_profile.json");

const DEFAULT_PROFILE = {
  name: "Milin Chaware",
  title: "Senior Python Backend & AI/ML Developer",
  email: "milinchaware9@gmail.com",
  phone: "+91 7620369988",
  linkedin: "https://www.linkedin.com/in/milin-chaware-9a1b4b1a7/",
  years_experience: 4,
  notice_period: "Immediate Joiner (0 days)",
  salary_expectation: "Competitive / Market standard",
  remote_preference: "Remote / Hybrid",
  preferred_roles: [
    "Python Developer",
    "Senior Python Developer",
    "Python Backend Developer",
    "Backend Engineer",
    "FastAPI Developer",
    "Django Developer",
    "AI/ML Engineer",
    "Software Engineer",
  ],
  preferred_locations: [
    "Remote",
    "Pune",
    "Bengaluru",
    "Bangalore",
    "Mumbai",
    "Hyderabad",
    "Noida",
    "Gurugram",
    "India",
  ],
  core_skills: [
    "Python",
    "Django",
    "FastAPI",
    "DRF",
    "Flask",
    "REST API",
    "PostgreSQL",
    "MySQL",
    "Redis",
    "Celery",
  ],
  secondary_skills: [
    "Docker",
    "AWS",
    "EC2",
    "S3",
    "Pandas",
    "NumPy",
    "AI/ML",
    "Microservices",
    "Git",
    "SQL",
  ],
};

function getCandidateProfile() {
  return safeReadJsonSync(PROFILE_FILE, DEFAULT_PROFILE);
}

function saveCandidateProfile(profile) {
  const merged = { ...DEFAULT_PROFILE, ...profile };
  atomicWriteJsonSync(PROFILE_FILE, merged);
  return merged;
}

/**
 * Calculates a transparent match score for a job against the candidate profile.
 *
 * Scoring model (Total: 100 points):
 * 1. Core Technical Skills: up to 40 points
 * 2. Experience Level: up to 25 points
 * 3. Location / Remote Preference: up to 20 points
 * 4. Secondary & Cloud Skills: up to 15 points
 */
function calculateJobMatch(job, customProfile = null) {
  const profile = customProfile || getCandidateProfile();
  const breakdown = [];
  const matchedSkills = new Set();
  const missingSkills = new Set();

  const jobText = [
    job.job_title || job.role || "",
    job.description || "",
    Array.isArray(job.skills) ? job.skills.join(" ") : (job.skills || ""),
    job.location || "",
  ].join(" ").toLowerCase();

  // ─── 1. CORE SKILLS (40 Points Max) ──────────────────────
  let corePoints = 0;
  const coreSkillWeights = {
    python: 16,
    django: 8,
    fastapi: 8,
    drf: 4,
    rest: 4,
    postgresql: 4,
    redis: 4,
    celery: 4,
  };

  const coreList = profile.core_skills.map(s => s.toLowerCase());
  for (const skill of coreList) {
    const isMatched = jobText.includes(skill);
    if (isMatched) {
      matchedSkills.add(skill);
      const points = coreSkillWeights[skill] || 3;
      corePoints += points;
      breakdown.push({
        factor: `${skill.toUpperCase()} skill`,
        status: "matched",
        pointsAwarded: points,
        category: "Core Stack",
      });
    }
  }
  // Cap core points at 40
  corePoints = Math.min(40, corePoints);
  // Default Python boost if Python is explicitly in the role title
  if ((job.job_title || job.role || "").toLowerCase().includes("python") && corePoints < 20) {
    corePoints = Math.max(corePoints, 20);
    breakdown.push({
      factor: "Role Title specifies Python",
      status: "matched",
      pointsAwarded: 10,
      category: "Core Stack",
    });
  }

  // ─── 2. EXPERIENCE LEVEL (25 Points Max) ───────────────────
  let expPoints = 0;
  const candExp = profile.years_experience || 4;
  const expText = (job.experience_required || jobText).toLowerCase();

  // Extract years requested
  const expMatch = expText.match(/(\d+)\s*[-+to]*\s*(\d*)\s*(?:years?|yrs?)/i);
  if (expMatch) {
    const minReq = parseInt(expMatch[1], 10);
    const maxReq = expMatch[2] ? parseInt(expMatch[2], 10) : minReq + 2;

    if (candExp >= minReq && candExp <= maxReq + 2) {
      expPoints = 25;
      breakdown.push({
        factor: `Experience Requirement (${minReq}-${maxReq} yrs matches candidate's ${candExp} yrs)`,
        status: "matched",
        pointsAwarded: 25,
        category: "Experience",
      });
    } else if (candExp >= minReq - 1) {
      expPoints = 18;
      breakdown.push({
        factor: `Experience Requirement (${minReq}+ yrs partially matched with ${candExp} yrs)`,
        status: "partial_match",
        pointsAwarded: 18,
        category: "Experience",
      });
    } else {
      expPoints = 8;
      breakdown.push({
        factor: `Experience Requirement (${minReq}+ yrs differs from ${candExp} yrs)`,
        status: "low_match",
        pointsAwarded: 8,
        category: "Experience",
      });
    }
  } else {
    // If unspecified, assume intermediate fit
    expPoints = 20;
    breakdown.push({
      factor: `Experience requirement open / not strictly restricted`,
      status: "matched",
      pointsAwarded: 20,
      category: "Experience",
    });
  }

  // ─── 3. LOCATION & REMOTE PREFERENCE (20 Points Max) ───────
  let locPoints = 0;
  const jobLoc = (job.location || "").toLowerCase();
  const isRemote = jobLoc.includes("remote") || (job.work_mode && job.work_mode.toLowerCase() === "remote") || jobText.includes("work from home");

  if (isRemote) {
    locPoints = 20;
    breakdown.push({
      factor: "Remote / Work From Home allowed",
      status: "matched",
      pointsAwarded: 20,
      category: "Location",
    });
  } else {
    const matchedLoc = profile.preferred_locations.find(l => jobLoc.includes(l.toLowerCase()));
    if (matchedLoc) {
      locPoints = 18;
      breakdown.push({
        factor: `Target Location matched: ${matchedLoc}`,
        status: "matched",
        pointsAwarded: 18,
        category: "Location",
      });
    } else if (jobLoc.includes("india")) {
      locPoints = 14;
      breakdown.push({
        factor: "National location matched (India)",
        status: "partial_match",
        pointsAwarded: 14,
        category: "Location",
      });
    } else {
      locPoints = 8;
      breakdown.push({
        factor: `Location (${job.location || 'Unspecified'}) not in primary preference`,
        status: "low_match",
        pointsAwarded: 8,
        category: "Location",
      });
    }
  }

  // ─── 4. SECONDARY SKILLS (15 Points Max) ───────────────────
  let secPoints = 0;
  const secList = profile.secondary_skills.map(s => s.toLowerCase());
  for (const s of secList) {
    if (jobText.includes(s)) {
      matchedSkills.add(s);
      secPoints += 3;
      breakdown.push({
        factor: `${s.toUpperCase()} bonus`,
        status: "matched",
        pointsAwarded: 3,
        category: "Secondary Skills",
      });
    }
  }
  secPoints = Math.min(15, secPoints);

  // Check common missing skills
  const checkExtra = ["kubernetes", "golang", "java", "ruby", "c++", "c#", "flutter", "react native"];
  for (const ex of checkExtra) {
    if (jobText.includes(ex) && !matchedSkills.has(ex)) {
      missingSkills.add(ex);
    }
  }

  const totalScore = Math.min(100, Math.round(corePoints + expPoints + locPoints + secPoints));

  let tier = "LOW_MATCH";
  if (totalScore >= 80) tier = "STRONG_MATCH";
  else if (totalScore >= 65) tier = "GOOD_MATCH";
  else if (totalScore >= 50) tier = "MODERATE_MATCH";

  return {
    score: totalScore,
    tier,
    breakdown,
    matched_skills: Array.from(matchedSkills),
    missing_skills: Array.from(missingSkills),
    summary: `Score: ${totalScore}% (${tier.replace('_', ' ')}) — Core Skills: ${corePoints}/40, Exp: ${expPoints}/25, Location: ${locPoints}/20, Extras: ${secPoints}/15`,
  };
}

module.exports = {
  DEFAULT_PROFILE,
  getCandidateProfile,
  saveCandidateProfile,
  calculateJobMatch,
};
