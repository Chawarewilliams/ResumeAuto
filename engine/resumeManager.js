/**
 * ResumeAuto Engine — Multi-Resume Track Management & Intelligent Selector
 * Automatically selects the optimal resume profile based on job requirements.
 */

const fs = require("fs");
const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync } = require("./storage");

const RESUMES_CONFIG_FILE = path.resolve("./resumes_config.json");

const DEFAULT_RESUME_PROFILES = [
  {
    id: "backend",
    name: "Python Backend Resume",
    filename: "Milin_Chaware_Resume.pdf",
    tags: ["python", "django", "fastapi", "drf", "backend", "api", "microservices", "redis", "celery", "postgresql"],
    description: "Tailored for High-Scale Backend, REST APIs, and Distributed Systems",
    isDefault: true,
  },
  {
    id: "fullstack",
    name: "Python Full Stack Resume",
    filename: "Milin_Chaware_FullStack_Resume.pdf",
    fallbackFile: "Milin_Chaware_Resume.pdf",
    tags: ["fullstack", "full stack", "react", "frontend", "javascript", "typescript", "ui", "tailwind"],
    description: "Tailored for Full-Stack Roles (Python + React/Modern UI)",
    isDefault: false,
  },
  {
    id: "ai_ml",
    name: "AI & ML Engineer Resume",
    filename: "Milin_Chaware_AI_Resume.pdf",
    fallbackFile: "Milin_Chaware_Resume.pdf",
    tags: ["ai", "ml", "machine learning", "genai", "generative ai", "llm", "langchain", "rag", "agents", "nlp"],
    description: "Tailored for Generative AI, Autonomous Agents, and ML Workflows",
    isDefault: false,
  },
  {
    id: "data_engineer",
    name: "Data Engineer Resume",
    filename: "Milin_Chaware_Data_Resume.pdf",
    fallbackFile: "Milin_Chaware_Resume.pdf",
    tags: ["data", "etl", "pipeline", "pandas", "numpy", "airflow", "analytics", "sql", "data engineer"],
    description: "Tailored for High-Volume Data Pipelines & Analytics",
    isDefault: false,
  },
];

function loadResumeProfiles() {
  const data = safeReadJsonSync(RESUMES_CONFIG_FILE, null);
  if (data && Array.isArray(data.profiles)) return data.profiles;
  return DEFAULT_RESUME_PROFILES;
}

function saveResumeProfiles(profiles) {
  atomicWriteJsonSync(RESUMES_CONFIG_FILE, { profiles, updatedAt: new Date().toISOString() });
}

/**
 * Get details and file status for all configured resumes.
 */
function getAllResumesWithMetadata(baseDir = ".") {
  const profiles = loadResumeProfiles();
  return profiles.map(p => {
    let resolved = path.resolve(baseDir, p.filename);
    let exists = fs.existsSync(resolved);

    // If specific file doesn't exist yet on disk, check fallback
    if (!exists && p.fallbackFile) {
      const fallbackResolved = path.resolve(baseDir, p.fallbackFile);
      if (fs.existsSync(fallbackResolved)) {
        resolved = fallbackResolved;
        exists = true;
      }
    }

    let sizeKb = 0;
    if (exists) {
      try {
        const stat = fs.statSync(resolved);
        sizeKb = Math.round(stat.size / 1024);
      } catch (_) {}
    }

    return {
      ...p,
      resolvedPath: resolved,
      exists,
      sizeKb: `${sizeKb} KB`,
      sizeBytes: sizeKb * 1024,
    };
  });
}

/**
 * Automatically select the most relevant resume based on job title, skills, and description.
 */
function selectOptimalResume(job, description = "", baseDir = ".") {
  let jobObj = {};
  if (typeof job === "string") {
    jobObj = { job_title: job, description: typeof description === "string" ? description : "" };
    if (typeof description !== "string" && typeof baseDir === "string") {
      baseDir = description;
    }
  } else {
    jobObj = job || {};
    if (typeof description === "string" && description !== "") {
      baseDir = description;
    }
  }

  const allResumes = getAllResumesWithMetadata(baseDir);
  const text = [
    jobObj.job_title || jobObj.role || jobObj.title || "",
    jobObj.description || "",
    Array.isArray(jobObj.skills) ? jobObj.skills.join(" ") : (jobObj.skills || ""),
  ].join(" ").toLowerCase();

  let bestProfile = allResumes.find(r => r.isDefault) || allResumes[0];
  let highestScore = 0;
  let matchReason = "Default Python Backend profile";

  for (const profile of allResumes) {
    let score = 0;
    const matchedTags = [];
    for (const tag of profile.tags) {
      if (text.includes(tag.toLowerCase())) {
        score += tag.length > 5 ? 3 : 2;
        matchedTags.push(tag);
      }
    }

    // Role title matches receive a significant boost
    const roleTitle = (jobObj.job_title || jobObj.role || jobObj.title || "").toLowerCase();
    for (const tag of profile.tags) {
      if (roleTitle.includes(tag.toLowerCase())) {
        score += 5;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestProfile = profile;
      matchReason = `Matched job focus: ${matchedTags.slice(0, 3).join(", ")}`;
    }
  }

  return {
    ...bestProfile,
    selectedResume: bestProfile,
    path: bestProfile.resolvedPath,
    filename: path.basename(bestProfile.resolvedPath),
    file: path.basename(bestProfile.resolvedPath),
    sizeKb: bestProfile.sizeKb,
    reason: matchReason,
    score: highestScore,
  };
}

module.exports = {
  DEFAULT_RESUME_PROFILES,
  loadResumeProfiles,
  saveResumeProfiles,
  getAllResumesWithMetadata,
  selectOptimalResume,
};
