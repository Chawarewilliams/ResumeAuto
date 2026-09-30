/**
 * ResumeAuto Engine — Interview Tracker Model
 * Tracks application stages and interview rounds (Applied, Recruiter Screen, Technical, Manager, HR, Offer, Rejected)
 */

const path = require("path");
const { safeReadJsonSync, atomicWriteJsonSync, withFileLock } = require("./storage");

const INTERVIEWS_FILE = path.resolve("./interviews.json");

const INTERVIEW_STAGES = [
  "Applied",
  "Recruiter Screen",
  "Technical",
  "Manager",
  "HR",
  "Offer",
  "Rejected"
];

function loadInterviews() {
  const data = safeReadJsonSync(INTERVIEWS_FILE, {
    interviews: [
      {
        id: "int_demo_1",
        company: "Stripe",
        role: "Senior Backend Engineer (Python)",
        round: "Technical",
        date: new Date(Date.now() + 86400000 * 2).toISOString().split("T")[0],
        time: "15:00",
        meeting_link: "https://meet.google.com/abc-defg-hij",
        interviewer: "Alex Chen (Staff Engineer)",
        notes: "System design deep dive on idempotency and distributed rate limiters.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      {
        id: "int_demo_2",
        company: "Datadog",
        role: "Distributed Systems Developer",
        round: "Recruiter Screen",
        date: new Date(Date.now() + 86400000 * 4).toISOString().split("T")[0],
        time: "17:30",
        meeting_link: "https://zoom.us/j/9876543210",
        interviewer: "Sarah Jenkins (Senior Talent Partner)",
        notes: "Introductory conversation regarding team alignment and Python/FastAPI focus.",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ],
    updatedAt: new Date().toISOString()
  });

  return Array.isArray(data.interviews) ? data.interviews : [];
}

async function addInterview(payload) {
  return await withFileLock(INTERVIEWS_FILE, async () => {
    const interviews = loadInterviews();
    const id = `int_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const newInterview = {
      id,
      company: payload.company || "Company",
      role: payload.role || payload.job_title || "Software Engineer",
      round: INTERVIEW_STAGES.includes(payload.round) ? payload.round : "Recruiter Screen",
      date: payload.date || new Date().toISOString().split("T")[0],
      time: payload.time || "11:00",
      meeting_link: payload.meeting_link || payload.link || "",
      interviewer: payload.interviewer || "",
      notes: payload.notes || "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    interviews.unshift(newInterview);
    atomicWriteJsonSync(INTERVIEWS_FILE, {
      interviews,
      updatedAt: new Date().toISOString()
    });

    return newInterview;
  });
}

async function updateInterview(id, updates) {
  return await withFileLock(INTERVIEWS_FILE, async () => {
    const interviews = loadInterviews();
    const idx = interviews.findIndex(i => i.id === id);
    if (idx === -1) return null;

    interviews[idx] = {
      ...interviews[idx],
      ...updates,
      updatedAt: new Date().toISOString()
    };

    atomicWriteJsonSync(INTERVIEWS_FILE, {
      interviews,
      updatedAt: new Date().toISOString()
    });

    return interviews[idx];
  });
}

async function deleteInterview(id) {
  return await withFileLock(INTERVIEWS_FILE, async () => {
    let interviews = loadInterviews();
    const initialLen = interviews.length;
    interviews = interviews.filter(i => i.id !== id);
    if (interviews.length !== initialLen) {
      atomicWriteJsonSync(INTERVIEWS_FILE, {
        interviews,
        updatedAt: new Date().toISOString()
      });
      return true;
    }
    return false;
  });
}

module.exports = {
  INTERVIEW_STAGES,
  loadInterviews,
  addInterview,
  updateInterview,
  deleteInterview
};
