/**
 * ASSOULINE ATS — Zapier Webhook API
 * ─────────────────────────────────────────────────────────────────
 * Flow:
 *   LinkedIn Email → Zapier Mail → This API → Claude reads PDF resume
 *   → Claude evaluates → ATS Dashboard
 * ─────────────────────────────────────────────────────────────────
 */

const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");
const https    = require("https");
const http     = require("http");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ─── CONFIG ───────────────────────────────────────────────────────
const CONFIG = {
  PORT:              process.env.PORT              || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WEBHOOK_SECRET:    process.env.WEBHOOK_SECRET    || "assouline-ats-secret",
  MODEL:             process.env.CLAUDE_MODEL      || "claude-sonnet-4-5",
};

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ─── IN-MEMORY STORE ──────────────────────────────────────────────
const store = {
  candidates: [],
  roles: [
    { id: "role_1",  title: "Creative Director",         department: "Creative",   type: "creative" },
    { id: "role_2",  title: "Art Director",              department: "Creative",   type: "creative" },
    { id: "role_3",  title: "Marketing Manager",         department: "Marketing",  type: "general"  },
    { id: "role_4",  title: "Marketing Coordinator",     department: "Marketing",  type: "general"  },
    { id: "role_5",  title: "Retail Store Manager",      department: "Retail",     type: "general"  },
    { id: "role_6",  title: "E-Commerce Manager",        department: "Digital",    type: "general"  },
    { id: "role_7",  title: "Wholesale Account Manager", department: "Sales",      type: "general"  },
    { id: "role_8",  title: "Editorial Assistant",       department: "Editorial",  type: "creative" },
    { id: "role_9",  title: "Graphic Designer",          department: "Creative",   type: "creative" },
    { id: "role_10", title: "Project Manager",           department: "Operations", type: "general"  },
    { id: "role_11", title: "Digital Content Producer",  department: "Digital",    type: "creative" },
  ],
};

// ═══════════════════════════════════════════════════════════════════
//  PDF DOWNLOADER
//  Downloads PDF from URL and returns base64
// ═══════════════════════════════════════════════════════════════════
function downloadPDF(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const chunks = [];
    client.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("base64")));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  LINKEDIN EMAIL PARSER
// ═══════════════════════════════════════════════════════════════════
function parseLinkedInEmail(subject, rawBody) {
  // Extract candidate name from subject
  let candidateName = null;
  const n1 = subject.match(/from\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)+)\s*$/i);
  const n2 = subject.match(/[-–]\s*([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)+)\s*$/);
  if (n1) candidateName = n1[1].trim();
  else if (n2) candidateName = n2[1].trim();

  // Extract role from subject
  let roleApplied = null;
  const r1 = subject.match(/(?:New application|application)[:\s]+(.+?)\s+from\s+/i);
  const r2 = subject.match(/review\s+for\s+(.+?)(?:\s*[-–]\s*|\s*$)/i);
  if (r1) roleApplied = r1[1].trim();
  else if (r2) roleApplied = r2[1].trim();

  // Clean body
  let cleanBody = rawBody || "";
  cleanBody = cleanBody.replace(/https?:\/\/www\.linkedin\.com\/comm\/[^\s\n]*/gi, "");
  cleanBody = cleanBody.replace(/https?:\/\/[^\s\n]*/gi, "");
  cleanBody = cleanBody.replace(/This email was intended for.*/si, "");
  cleanBody = cleanBody.replace(/Learn why we included this.*/si, "");
  cleanBody = cleanBody.replace(/You are receiving Job Applicant emails.*/si, "");
  cleanBody = cleanBody.replace(/Unsubscribe.*/si, "");
  cleanBody = cleanBody.replace(/-{3,}/g, "");
  cleanBody = cleanBody.replace(/\n{3,}/g, "\n\n").trim();

  // Extract LinkedIn URL
  const lm = rawBody?.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
  const linkedinUrl = lm ? `https://linkedin.com/in/${lm[1]}` : "";

  return { candidateName, roleApplied, cleanBody, linkedinUrl };
}

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 1 — ZAPIER WEBHOOK
// ═══════════════════════════════════════════════════════════════════
app.post("/webhook/parseur", async (req, res) => {
  try {
    const incomingSecret = req.headers["x-webhook-secret"];
    if (incomingSecret && incomingSecret !== CONFIG.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = req.body;
    console.log("📩 Received payload:", JSON.stringify(payload, null, 2));

    const subject  = payload.position_applied || payload.subject || payload.job_title || "";
    const rawBody  = payload.body || payload.resume || "";
    const filename = payload.resume_filename || "";

    // Extract name from filename as fallback
    const nf = filename.match(/^([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)+)\s*[-–(]/);

    const parsed = parseLinkedInEmail(subject, rawBody);
    if (!parsed.candidateName && nf) parsed.candidateName = nf[1].trim();

    // ── Try to get PDF resume ──────────────────────────────────────
    let resumeBase64  = null;
    let resumeSource  = "none";

    // Option A: base64 file data sent directly from Zapier
    if (payload.resume_file_data && payload.resume_file_data.length > 100) {
      resumeBase64 = payload.resume_file_data.replace(/^data:application\/pdf;base64,/, "");
      resumeSource = "zapier_file_data";
      console.log("📄 PDF received via file data field");
    }

    // Option B: download from URL
    if (!resumeBase64 && payload.resume_url) {
      try {
        resumeBase64 = await downloadPDF(payload.resume_url);
        resumeSource = "url_download";
        console.log("📄 PDF downloaded from URL");
      } catch (e) {
        console.log("⚠️ Could not download PDF:", e.message);
      }
    }

    const rawCandidate = {
      parseur_id:    payload.id            || crypto.randomUUID(),
      full_name:     payload.full_name     || parsed.candidateName || "Unknown",
      email:         payload.email         || "",
      phone:         payload.phone         || "",
      linkedin_url:  payload.linkedin_url  || parsed.linkedinUrl   || "",
      location:      payload.location      || "",
      role_applied:  parsed.roleApplied    || payload.role         || "",
      resume_text:   parsed.cleanBody      || "",
      resume_file:   filename              || "",
      resume_base64: resumeBase64          || null,
      resume_source: resumeSource,
      portfolio_url: payload.portfolio_url || "",
      cover_letter:  payload.cover_letter  || "",
      years_exp:     payload.years_experience || "",
      skills:        payload.skills        || "",
      received_at:   new Date().toISOString(),
    };

    console.log(`👤 Candidate: ${rawCandidate.full_name} | ${rawCandidate.role_applied} | PDF: ${resumeSource}`);

    const matchedRole = matchRole(rawCandidate.role_applied, store.roles);
    const evaluation  = await evaluateCandidate(rawCandidate, matchedRole);

    const candidate = {
      id:         crypto.randomUUID(),
      ...rawCandidate,
      resume_base64: undefined, // don't store large base64 in memory
      role_id:    matchedRole?.id    || "unmatched",
      role_title: matchedRole?.title || rawCandidate.role_applied || "Unknown Role",
      role_type:  matchedRole?.type  || "general",
      evaluation,
      status:     deriveStatus(evaluation.overall_score),
      created_at: new Date().toISOString(),
    };

    store.candidates.push(candidate);
    console.log(`✅ Saved: ${candidate.full_name} → ${candidate.role_title} (score: ${evaluation.overall_score})`);

    return res.status(200).json({
      success:      true,
      candidate_id: candidate.id,
      name:         candidate.full_name,
      role:         candidate.role_title,
      score:        evaluation.overall_score,
      status:       candidate.status,
      resume_read:  resumeSource !== "none",
    });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTES 2-7 (unchanged)
// ═══════════════════════════════════════════════════════════════════
app.get("/candidates", (req, res) => {
  const { role_id, status, search } = req.query;
  let results = [...store.candidates];
  if (role_id) results = results.filter(c => c.role_id === role_id);
  if (status)  results = results.filter(c => c.status === status);
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(c =>
      c.full_name.toLowerCase().includes(q) ||
      (c.email||"").toLowerCase().includes(q) ||
      c.role_title.toLowerCase().includes(q)
    );
  }
  results.sort((a,b) => (b.evaluation?.overall_score||0) - (a.evaluation?.overall_score||0));
  return res.json({ total: results.length, candidates: results });
});

app.get("/candidates/:id", (req, res) => {
  const c = store.candidates.find(c => c.id === req.params.id);
  if (!c) return res.status(404).json({ error: "Not found" });
  return res.json(c);
});

app.patch("/candidates/:id/status", (req, res) => {
  const { status, notes } = req.body;
  const valid = ["new","reviewing","approved","rejected","on_hold","sent_to_hiring_manager"];
  if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status" });
  const idx = store.candidates.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });
  store.candidates[idx].status     = status;
  store.candidates[idx].updated_at = new Date().toISOString();
  if (notes) store.candidates[idx].reviewer_notes = notes;
  return res.json({ success: true, candidate: store.candidates[idx] });
});

app.get("/roles", (req, res) => {
  const roles = store.roles.map(r => ({
    ...r,
    applicant_count: store.candidates.filter(c => c.role_id === r.id).length,
    approved_count:  store.candidates.filter(c => c.role_id === r.id && c.status === "approved").length,
    pending_count:   store.candidates.filter(c => c.role_id === r.id && c.status === "new").length,
  }));
  return res.json({ roles });
});

app.post("/candidates/:id/re-evaluate", async (req, res) => {
  const candidate = store.candidates.find(c => c.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: "Not found" });
  const role       = store.roles.find(r => r.id === candidate.role_id);
  const evaluation = await evaluateCandidate(candidate, role);
  candidate.evaluation   = evaluation;
  candidate.status       = deriveStatus(evaluation.overall_score);
  candidate.re_evaluated = new Date().toISOString();
  return res.json({ success: true, evaluation });
});

app.get("/health", (req, res) => res.json({
  status: "ok", service: "Assouline ATS API",
  candidates: store.candidates.length, roles: store.roles.length,
  timestamp: new Date().toISOString(),
}));

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════
function matchRole(roleApplied, roles) {
  if (!roleApplied) return null;
  const n = roleApplied.toLowerCase();
  return roles.find(r =>
    n.includes(r.title.toLowerCase()) ||
    r.title.toLowerCase().includes(n)
  ) || null;
}

function deriveStatus(score) {
  if (score >= 80) return "approved";
  if (score >= 60) return "reviewing";
  if (score >= 40) return "on_hold";
  return "new";
}

// ═══════════════════════════════════════════════════════════════════
//  CLAUDE EVALUATION — reads actual PDF when available
// ═══════════════════════════════════════════════════════════════════
async function evaluateCandidate(candidate, role) {
  const isCreative = role?.type === "creative";
  const hasPDF     = !!candidate.resume_base64;

  console.log(`🤖 Evaluating ${candidate.full_name} | PDF: ${hasPDF} | Source: ${candidate.resume_source}`);

  // ── Build message content ────────────────────────────────────────
  const textPrompt = `
You are a senior HR evaluator at Assouline, a prestigious luxury publishing house.

ROLE: ${role?.title || candidate.role_applied || "Unknown Role"}
ROLE TYPE: ${isCreative ? "Creative (portfolio important)" : "General"}

CANDIDATE:
- Name: ${candidate.full_name}
- Location: ${candidate.location || "Not provided"}
- LinkedIn: ${candidate.linkedin_url || "Not provided"}
- Years of Experience: ${candidate.years_exp || "Not provided"}
- Skills: ${candidate.skills || "Not provided"}
- Portfolio: ${candidate.portfolio_url || "Not provided"}
- Resume File: ${candidate.resume_file || "Not provided"}
${candidate.resume_text ? `- Application Text:\n${candidate.resume_text}` : ""}
${hasPDF ? "- Full resume PDF is attached above — please read it carefully for complete evaluation." : "- No resume text available — evaluate based on available information only."}

Return ONLY valid JSON — no markdown, no explanation:

{
  "overall_score": <0-100>,
  "recommendation": "<advance|hold|reject>",
  "summary": "<2-3 sentence executive summary>",
  "strengths": ["<s1>","<s2>","<s3>"],
  "concerns": ["<c1>","<c2>"],
  "experience_score": <0-100>,
  "skills_score": <0-100>,
  "culture_fit_score": <0-100>,
  "portfolio_score": ${isCreative ? "<0-100 or null>" : "null"},
  "luxury_brand_fit": "<high|medium|low>",
  "interview_questions": ["<q1>","<q2>","<q3>"],
  "red_flags": [],
  "notes": "<additional notes>"
}

SCORING: 80-100 advance · 60-79 worth a look · 40-59 needs more info · 0-39 does not qualify
LUXURY FIT: Experience with luxury, premium, or cultural brands. Alignment with art, culture, travel, fashion.
${isCreative ? "Flag if no portfolio provided for a creative role." : ""}
`.trim();

  // Build message — include PDF if available
  let messages;
  if (hasPDF) {
    messages = [{
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type:       "base64",
            media_type: "application/pdf",
            data:       candidate.resume_base64,
          },
        },
        { type: "text", text: textPrompt },
      ],
    }];
  } else {
    messages = [{ role: "user", content: textPrompt }];
  }

  try {
    const response = await anthropic.messages.create({
      model:      CONFIG.MODEL,
      max_tokens: 1000,
      messages,
    });
    const text    = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const cleaned = text.replace(/```json|```/g, "").trim();
    const result  = JSON.parse(cleaned);
    console.log(`✨ Evaluation complete: score ${result.overall_score}`);
    return result;
  } catch (err) {
    console.error("Claude evaluation error:", err.message);
    return {
      overall_score: 45, recommendation: "hold",
      summary: "Resume PDF received. Please review manually — automated evaluation incomplete.",
      strengths: ["Resume attached — review recommended"],
      concerns:  ["Could not complete automated evaluation"],
      experience_score: 45, skills_score: 45, culture_fit_score: 45,
      portfolio_score: null, luxury_brand_fit: "medium",
      interview_questions: [
        "Walk us through your experience relevant to this role.",
        "What draws you to Assouline specifically?",
        "How does your background align with luxury publishing?"
      ],
      red_flags: [],
      notes: `PDF resume attached: ${candidate.resume_file}. Error: ${err.message}`,
    };
  }
}

// ─── START ────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 Assouline ATS API running on port ${CONFIG.PORT}`);
  console.log(`📋 Webhook: POST /webhook/parseur`);
  console.log(`📊 Candidates: GET /candidates`);
  console.log(`🎭 Roles: GET /roles`);
  console.log(`💚 Health: GET /health\n`);
});

module.exports = app;
