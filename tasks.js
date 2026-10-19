// The three personalization tasks. Each returns { messages, schema, maxTokens, validate }.
// The model only rewrites wording from the instructor's own answers. The rubric's
// criteria and weights, the AIAS level, the pattern ranking, and the research
// examples all stay deterministic.

const SYSTEM = [
  "You are an instructional design assistant helping a university instructor design an assessment.",
  "Use ONLY the information the instructor provided. Do not invent research findings, statistics, citations, tools, or institutional policies.",
  "Write in clear, concrete, plain English. Be specific to this assignment rather than generic.",
  "Respond with a single JSON object that matches the requested structure, and nothing else. /no_think"
].join(" ");

// Labels match the questions in the wizard, so the alignment check can name them.
export const FIELD_LABELS = {
  discipline: "Interest area",
  delivery: "Delivery mode",
  purposeType: "Assessment purpose",
  whyAssess: "Why this is worth assessing",
  learningMeasured: "Learning measured",
  intendedInference: "Intended inference",
  primaryCapability: "Primary student capability",
  observableSkills: "What students should be able to do",
  evidenceType: "Primary form of evidence",
  whoProduces: "Who produces the evidence",
  studentProduct: "What students produce or perform",
  aiRisk: "Risk that AI could substitute for the learning",
  likelyAICapability: "Most likely AI capability",
  howAICouldUndermine: "How AI could weaken the evidence",
  mitigation: "Change that preserves the learning",
  courseStructure: "Course size and structure",
  stages: "Stages and instructions",
  aiRole: "Role of AI in assessed work",
  aiasLevel: "AIAS level",
  aiasMeaning: "What the AIAS level means",
  aiUseRules: "Permitted or required AI uses",
  aiDisclosure: "AI-use evidence students submit",
  gradingMethod: "Grading method",
  verification: "Individual verification method",
  support: "Implementation support"
};

// Small in-browser models have a 4,096-token window, so long answers are trimmed.
const FIELD_LIMIT = 500;

function clip(value, limit = FIELD_LIMIT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function brief(ctx, keys = Object.keys(FIELD_LABELS), limit = FIELD_LIMIT) {
  return keys
    .filter((key) => clip(ctx[key], limit))
    .map((key) => `- ${FIELD_LABELS[key]}: ${clip(ctx[key], limit)}`)
    .join("\n");
}

const text = (value) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/* ---------- 1. Personalized rubric descriptors ---------- */

export function rubricTask(ctx, criteria) {
  const schema = {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        minItems: criteria.length,
        maxItems: criteria.length,
        items: {
          type: "object",
          properties: {
            exemplary: { type: "string" },
            proficient: { type: "string" },
            developing: { type: "string" },
            beginning: { type: "string" }
          },
          required: ["exemplary", "proficient", "developing", "beginning"]
        }
      }
    },
    required: ["criteria"]
  };

  const keys = ["discipline", "delivery", "primaryCapability", "observableSkills", "evidenceType", "whoProduces",
    "studentProduct", "aiRole", "aiasLevel", "aiUseRules", "verification"];
  const list = criteria.map((c, i) => [
    `${i + 1}. ${c.name} (${c.weight}%)`,
    `   Exemplary: ${c.descriptions[0]}`,
    `   Proficient: ${c.descriptions[1]}`,
    `   Developing: ${c.descriptions[2]}`,
    `   Beginning: ${c.descriptions[3]}`
  ].join("\n")).join("\n");

  const user = `The instructor's assessment:\n${brief(ctx, keys)}\n\nHere are ${criteria.length} rubric criteria with generic template wording:\n${list}\n\nRewrite the four performance descriptors for each criterion, in the same order, so they describe this specific assignment: name what students actually produce and the skills listed above. Keep each criterion's meaning and keep the four levels parallel, so the difference between levels is clear. Each descriptor is one sentence of under 35 words describing observable features of student work. Do not mention percentages or level names.`;

  return {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    schema,
    maxTokens: 1400,
    validate(out) {
      const rows = out?.criteria;
      if (!Array.isArray(rows) || rows.length !== criteria.length) throw new Error("The rubric came back with the wrong number of criteria.");
      return rows.map((row) => {
        const levels = [row?.exemplary, row?.proficient, row?.developing, row?.beginning].map((s) => clip(text(s), 400));
        if (levels.some((s) => !s)) throw new Error("The rubric was missing a descriptor.");
        return levels;
      });
    }
  };
}

/* ---------- 2. Student-facing AI-use instructions ---------- */

export function instructionsTask(ctx) {
  const schema = {
    type: "object",
    properties: {
      overview: { type: "string" },
      permitted: { type: "array", items: { type: "string" }, maxItems: 6 },
      prohibited: { type: "array", items: { type: "string" }, maxItems: 6 },
      documentation: { type: "string" },
      why: { type: "string" }
    },
    required: ["overview", "permitted", "prohibited", "documentation", "why"]
  };

  const keys = ["discipline", "delivery", "studentProduct", "observableSkills", "howAICouldUndermine", "mitigation",
    "aiRole", "aiasLevel", "aiasMeaning", "aiUseRules", "aiDisclosure", "verification"];
  const user = `The instructor's assessment:\n${brief(ctx, keys)}\n\nWrite the AI-use instructions that will appear in the assignment for STUDENTS. Address students as "you".\n- overview: 2 or 3 sentences naming the AIAS level and what it means for this assignment.\n- permitted: concrete examples of allowed AI uses for this task (an empty list if AI is not allowed).\n- prohibited: concrete examples of uses that are not allowed.\n- documentation: exactly what students must submit about their AI use.\n- why: 1 or 2 sentences on how these rules protect the learning the assignment is meant to show.\nKeep each list item under 20 words. Stay consistent with the instructor's stated rules and do not add permissions they did not give.`;

  return {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    schema,
    maxTokens: 700,
    validate(out) {
      const overview = text(out?.overview);
      if (!overview) throw new Error("The instructions came back incomplete.");
      const items = (list) => (Array.isArray(list) ? list.map(text).filter(Boolean).slice(0, 6) : []);
      return {
        overview,
        permitted: items(out.permitted),
        prohibited: items(out.prohibited),
        documentation: text(out.documentation),
        why: text(out.why)
      };
    }
  };
}

/* ---------- 3. Alignment check ---------- */

export function alignmentTask(ctx) {
  const schema = {
    type: "object",
    properties: {
      issues: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["high", "medium", "low"] },
            fields: { type: "array", items: { type: "string" }, maxItems: 3 },
            issue: { type: "string" },
            suggestion: { type: "string" }
          },
          required: ["severity", "fields", "issue", "suggestion"]
        }
      }
    },
    required: ["issues"]
  };

  const user = `The instructor's assessment:\n${brief(ctx, Object.keys(FIELD_LABELS), 350)}\n\nCheck this design for internal contradictions: places where the answers conflict with each other, or where the student product would not support the intended inference. For example: the purpose mentions teamwork but the evidence is individual work; the AI-use rules allow drafting but the risk notes say drafting undermines the skill; the student product does not show the listed skills.\nReport at most 5 real problems, most serious first. In "fields", use the labels exactly as written above (for example "Permitted or required AI uses"). Do not report missing information unless it breaks the design. If the answers are consistent, return {"issues": []}.`;

  return {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
    schema,
    maxTokens: 700,
    validate(out) {
      if (!Array.isArray(out?.issues)) throw new Error("The alignment check came back incomplete.");
      const known = new Map(Object.values(FIELD_LABELS).map((label) => [label.toLowerCase(), label]));
      return out.issues
        .map((item) => ({
          severity: ["high", "medium", "low"].includes(item?.severity) ? item.severity : "medium",
          fields: Array.isArray(item?.fields)
            ? item.fields.map((f) => known.get(text(f).toLowerCase())).filter(Boolean).slice(0, 3)
            : [],
          issue: clip(text(item?.issue), 300),
          suggestion: clip(text(item?.suggestion), 300)
        }))
        .filter((item) => item.issue)
        .slice(0, 5);
    }
  };
}
