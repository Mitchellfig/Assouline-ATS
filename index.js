/**
 * ASSOULINE ATS — Zapier Webhook API
 * ─────────────────────────────────────────────────────────────────
 * Flow:
 *   LinkedIn Email → Zapier Mail → This API → Claude evaluates → ATS Dashboard
 * ─────────────────────────────────────────────────────────────────
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(cors());

// ─── CONFIG ───────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || "assouline-ats-secret",
  MODEL: process.env.CLAUDE_MODEL || "claude-sonnet-4-5",
};

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ─── IN-MEMORY STORE ──────────────────────────────────────────────
const store = {
  candidates: [],
  roles: [
    { id: "role_1", title: "Creative Director",        department: "Creative",   type: "creative" },
    { id: "role_2", title: "Art Director",             department: "Creative",   type: "creative" },
    { id: "role_3", title: "Marketing Manager",        department: "Marketing",  type: "general"  },
    { id: "role_4", title: "Marketing Coordinator",    department: "Marketing",  type: "general"  },
    { id: "role_5", title: "Retail Store Manager",     department: "Retail",     type: "general"  },
    { id: "role_6", title: "E-Commerce Manager",       department: "Digital",    type: "general"  },
    { id: "role_7", title: "Wholesale Account Manager",department: "Sales",      type: "general"  },
    { id: "role_8", title: "Editorial Assistant",      department: "Editorial",  type: "creative" },
    { id: "role_9", title: "Graphic Designer",         department: "Creative",   type: "creative" },
    { id: "role_10",title: "Project Manager",          department: "Operations", type: "general"  },
    { id: "role_11",title: "Digital Content Producer", department: "Digital",    type: "creative" },
  ],
};

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 1 — ZAPIER WEBHOOK ENDPOINT
// ═══════════════════════════════════════════════════════════════════
app.post("/webhook/parseur", async (req, res) => {
  try {
    const incomingSecret = req.headers["x-webhook-secret"];
    if (incomingSecret && incomingSecret !== CONFIG.WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized: invalid webhook secret" });
    }

    const payload = req.body;
    console.log("📩 Received payload:", JSON.stringify(payload, null, 2));

    // ── Parse LinkedIn email format ──────────────────────────────────
    // Subject format: "FW: New application: [Role] from [Candidate Name]"
    const subject  = payload.position_applied || payload.job_title || payload.subject || "";
    const bodyText = payload.body             || payload.resume    || payload.cv_text  || "";

    // Extract candidate name from subject line
    const nameMatch    = subject.match(/from\s+([A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)+)\s*$/i);
    const extractedName = nameMatch ? nameMatch[1].trim() : null;

    // Extract role from subject line
    const roleMatch    = subject.match(/(?:New\s+application|application)[:\s]+(.+?)\s+from\s+/i);
    const extractedRole = roleMatch
      ? roleMatch[1].trim()
      : subject.replace(/^FW:\s*/i, "").replace(/from\s+.+$/i, "").trim();

    // Extract candidate email from body (exclude Assouline internal addresses)
    const emailMatch    = bodyText.match(/([a-zA-Z0-9._%+\-]+@(?!assouline\.com)[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
    const extractedEmail = emailMatch ? emailMatch[1] : "";

    // Extract LinkedIn profile URL
    const linkedinMatch   = bodyText.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
    const extractedLinkedIn = linkedinMatch ? `https://linkedin.com/in/${linkedinMatch[1]}` : "";

    // Extract phone number
    const phoneMatch    = bodyText.match(/(\+?1?[\s.\-]?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/);
    const extractedPhone = phoneMatch ? phoneMatch[1].trim() : "";

    const rawCandidate = {
      parseur_id:   payload.id            || crypto.randomUUID(),
      full_name:    payload.full_name     || payload.name          || extractedName   || "Unknown",
      email:        extractedEmail        || payload.email         || "",
      phone:        payload.phone         || extractedPhone        || "",
      linkedin_url: payload.linkedin_url  || extractedLinkedIn     || "",
      location:     payload.location      || payload.city          || "",
      role_applied: extractedRole         || payload.role          || "",
      resume_text:  bodyText              || `Resume attached: ${payload.resume_filename || "see attachment"}`,
      resume_file:  payload.resume_filename || "",
      portfolio_url:payload.portfolio_url || payload.website       || "",
      cover_letter: payload.cover_letter  || "",
      years_exp:    payload.years_experience || payload.experience || "",
      skills:       payload.skills        || "",
      received_at:  new Date().toISOString(),
    };

    console.log(`👤 Candidate: ${rawCandidate.full_name} | ${rawCandidate.email} | ${rawCandidate.role_applied}`);

    // ── Match role ───────────────────────────────────────────────────
    const matchedRole = matchRole(rawCandidate.role_applied, store.roles);

    // ── Evaluate with Claude ─────────────────────────────────────────
    const evaluation = await evaluateCandidate(rawCandidate, matchedRole);

    // ── Build candidate record ───────────────────────────────────────
    const candidate = {
      id:         crypto.randomUUID(),
      ...rawCandidate,
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
      email:        candidate.email,
      role:         candidate.role_title,
      score:        evaluation.overall_score,
      status:       candidate.status,
    });

  } catch (err) {
    console.error("❌ Webhook error:", err);
    return res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 2 — GET ALL CANDIDATES
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
      c.email.toLowerCase().includes(q) ||
      c.role_title.toLowerCase().includes(q)
    );
  }
  results.sort((a, b) => (b.evaluation?.overall_score || 0) - (a.evaluation?.overall_score || 0));
  return res.json({ total: results.length, candidates: results });
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 3 — GET SINGLE CANDIDATE
// ═══════════════════════════════════════════════════════════════════
app.get("/candidates/:id", (req, res) => {
  const candidate = store.candidates.find(c => c.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  return res.json(candidate);
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 4 — UPDATE CANDIDATE STATUS
// ═══════════════════════════════════════════════════════════════════
app.patch("/candidates/:id/status", (req, res) => {
  const { status, notes } = req.body;
  const valid = ["new","reviewing","approved","rejected","on_hold","sent_to_hiring_manager"];
  if (!valid.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(", ")}` });
  }
  const idx = store.candidates.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Candidate not found" });
  store.candidates[idx].status     = status;
  store.candidates[idx].updated_at = new Date().toISOString();
  if (notes) store.candidates[idx].reviewer_notes = notes;
  return res.json({ success: true, candidate: store.candidates[idx] });
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 5 — GET ROLES
// ═══════════════════════════════════════════════════════════════════
app.get("/roles", (req, res) => {
  const rolesWithCounts = store.roles.map(role => ({
    ...role,
    applicant_count: store.candidates.filter(c => c.role_id === role.id).length,
    approved_count:  store.candidates.filter(c => c.role_id === role.id && c.status === "approved").length,
    pending_count:   store.candidates.filter(c => c.role_id === role.id && c.status === "new").length,
  }));
  return res.json({ roles: rolesWithCounts });
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 6 — RE-EVALUATE CANDIDATE
// ═══════════════════════════════════════════════════════════════════
app.post("/candidates/:id/re-evaluate", async (req, res) => {
  const candidate = store.candidates.find(c => c.id === req.params.id);
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const matchedRole  = store.roles.find(r => r.id === candidate.role_id);
  const evaluation   = await evaluateCandidate(candidate, matchedRole);
  candidate.evaluation   = evaluation;
  candidate.status       = deriveStatus(evaluation.overall_score);
  candidate.re_evaluated = new Date().toISOString();
  return res.json({ success: true, evaluation });
});

// ═══════════════════════════════════════════════════════════════════
//  ROUTE 7 — HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════
app.get("/health", (req, res) => {
  return res.json({
    status:     "ok",
    service:    "Assouline ATS API",
    candidates: store.candidates.length,
    roles:      store.roles.length,
    timestamp:  new Date().toISOString(),
  });
});

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
//  CLAUDE EVALUATION
// ═══════════════════════════════════════════════════════════════════
async function evaluateCandidate(candidate, role) {
  const isCreative = role?.type === "creative";

  const prompt = `
You are a senior HR evaluator at Assouline, a prestigious luxury publishing house known for exceptional taste, craftsmanship, and cultural sophistication.

ROLE: ${role?.title || candidate.role_applied || "Unknown Role"}
ROLE TYPE: ${isCreative ? "Creative (portfolio important)" : "General"}

CANDIDATE:
- Name: ${candidate.full_name}
- Email: ${candidate.email || "Not provided"}
- Location: ${candidate.location || "Not provided"}
- LinkedIn: ${candidate.linkedin_url || "Not provided"}
- Years of Experience: ${candidate.years_exp || "Not provided"}
- Skills: ${candidate.skills || "Not provided"}
- Portfolio: ${candidate.portfolio_url || "Not provided"}
- Resume File: ${candidate.resume_file || "Not provided"}
- Application / Resume Text:
${candidate.resume_text || "No resume text available"}

Return ONLY a valid JSON object — no markdown, no explanation:

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

SCORING: 80-100 = advance immediately · 60-79 = worth a look · 40-59 = borderline · 0-39 = does not meet requirements
LUXURY FIT: Consider experience with luxury, premium, or cultural brands and alignment with art, culture, travel, fashion.
`.trim();

  try {
    const response = await anthropic.messages.create({
      model:      CONFIG.MODEL,
      max_tokens: 1000,
      messages:   [{ role: "user", content: prompt }],
    });
    const text    = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const cleaned = text.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Claude evaluation error:", err.message);
    return {
      overall_score: 0, recommendation: "hold",
      summary: "Evaluation failed — please review manually.",
      strengths: [], concerns: ["Automated evaluation could not be completed"],
      experience_score: 0, skills_score: 0, culture_fit_score: 0,
      portfolio_score: null, luxury_brand_fit: "medium",
      interview_questions: [], red_flags: ["Manual review required"],
      notes: `Error: ${err.message}`,
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
