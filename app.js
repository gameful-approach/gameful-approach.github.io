import {
  steps, contextLabels, labels, choiceGuidance, starterApproaches,
  patterns, examples, aiasDescriptions
} from "./data.js";
import {
  detectWebGPU, browserModels, recommendBrowserModel, detectOllama,
  createBrowserEngine, createOllamaEngine, isAbort
} from "./llm.js";
import { rubricTask, instructionsTask, alignmentTask } from "./tasks.js";

const STORAGE_KEY = "valid-ai-designer-state-v2";
const PREFS_KEY = "valid-ai-designer-ai-prefs-v1";

const root = document.getElementById("valid-ai-designer");
const $ = (selector) => root.querySelector(selector);

// Each step's colors come from CSS tokens, so the light and dark themes both work.
const stepStyle = (index) => `--step-color:var(--step-${index});--step-soft:var(--step-${index}-soft)`;

/* ---------- State ---------- */

const SELECT_OPTIONS = {
  context: contextLabels,
  delivery: labels.delivery,
  purposeType: labels.purposeType,
  outcome: labels.outcome,
  evidenceType: labels.evidenceType,
  accountability: labels.accountability,
  risk: labels.risk,
  aiCapability: labels.aiCapability,
  structure: labels.structure,
  aiRole: labels.aiRole,
  aiasLevel: labels.aiasLevel,
  disclosure: labels.disclosure,
  grading: labels.grading,
  verification: labels.verification
};
const TEXT_FIELDS = ["purposeStatement", "learningStatement", "inferenceStatement", "skills", "product",
  "undermine", "mitigation", "stages", "allowed", "support"];
const ANSWER_FIELDS = [...Object.keys(SELECT_OPTIONS), ...TEXT_FIELDS];
// Every field a starting approach can fill in.
const STARTER_FIELDS = Object.keys(starterApproaches.independent.values);

const defaultState = {
  view: "start", step: 0, starter: "recommend",
  recommendPending: false, recommendedStarter: "", touchedFields: [],
  context: "art", delivery: "classroom", purposeType: "both", purposeStatement: "", learningStatement: "", inferenceStatement: "",
  outcome: "analysis", skills: "", evidenceType: "case", product: "", accountability: "individual",
  risk: "moderate", aiCapability: "draft", undermine: "", mitigation: "",
  structure: "medium", stages: "", aiRole: "critique", aiasLevel: "auto", allowed: "", disclosure: "decisions",
  grading: "analytic", verification: "defense", support: "", exampleContext: "art",
  ai: null,              // { signature, by, finishedAt, alignment, instructions, rubric }
  aiRubricHidden: false, // showing the template rubric instead of the AI version
  aiCleared: false,      // answers changed, so earlier AI output was discarded
  rubricName: "",        // Canvas export: blank means use the default name
  rubricPoints: 100
};
const freshState = () => structuredClone(defaultState);

function clampPoints(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.round(n * 100) / 100) : 100;
}

function cleanAI(saved) {
  if (!saved || typeof saved !== "object" || typeof saved.signature !== "string") return null;
  const str = (value) => (typeof value === "string" ? value : "");
  const list = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  const legacyModel = str(saved.model); // the previous version stored one model name
  const out = {
    signature: saved.signature,
    by: saved.by && typeof saved.by === "object"
      ? saved.by
      : { alignment: legacyModel, instructions: legacyModel, rubric: legacyModel },
    finishedAt: Number(saved.finishedAt) || 0,
    criteriaNames: list(saved.criteriaNames)
  };
  if (Array.isArray(saved.rubric) && saved.rubric.every((row) => Array.isArray(row) && row.length === 4 && row.every((d) => typeof d === "string"))) {
    out.rubric = saved.rubric;
  }
  if (saved.instructions && typeof saved.instructions.overview === "string") {
    const i = saved.instructions;
    out.instructions = { overview: i.overview, permitted: list(i.permitted), prohibited: list(i.prohibited), documentation: str(i.documentation), why: str(i.why) };
  }
  if (Array.isArray(saved.alignment)) {
    out.alignment = saved.alignment
      .filter((item) => item && typeof item.issue === "string")
      .map((item) => ({
        severity: ["high", "medium", "low"].includes(item.severity) ? item.severity : "medium",
        fields: list(item.fields), issue: item.issue, suggestion: str(item.suggestion)
      }));
  }
  return out.rubric || out.instructions || out.alignment ? out : null;
}

function loadState() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { saved = null; }
  const s = freshState();
  if (!saved || typeof saved !== "object") return s;
  for (const key of Object.keys(defaultState)) {
    if (Object.hasOwn(saved, key)) s[key] = saved[key];
  }
  // Saves from the previous version used started / resultsShown flags.
  if (!Object.hasOwn(saved, "view")) s.view = saved.started ? (saved.resultsShown ? "results" : "workflow") : "start";
  if (!["start", "workflow", "results"].includes(s.view)) s.view = "start";
  s.step = Math.max(0, Math.min(steps.length - 1, Number(s.step) || 0));
  if (!Object.hasOwn(starterApproaches, s.starter)) s.starter = defaultState.starter;
  if (!Object.hasOwn(starterApproaches, s.recommendedStarter)) s.recommendedStarter = "";
  for (const [field, options] of Object.entries(SELECT_OPTIONS)) {
    if (!Object.hasOwn(options, s[field])) s[field] = defaultState[field];
  }
  for (const field of TEXT_FIELDS) {
    if (typeof s[field] !== "string") s[field] = "";
  }
  if (!Object.hasOwn(contextLabels, s.exampleContext)) s.exampleContext = s.context;
  s.touchedFields = Array.isArray(s.touchedFields) ? s.touchedFields.filter((f) => ANSWER_FIELDS.includes(f)) : [];
  s.recommendPending = Boolean(s.recommendPending);
  s.aiRubricHidden = Boolean(s.aiRubricHidden);
  s.aiCleared = Boolean(s.aiCleared);
  s.rubricName = typeof s.rubricName === "string" ? s.rubricName.slice(0, 120) : "";
  s.rubricPoints = clampPoints(s.rubricPoints);
  s.ai = cleanAI(s.ai);
  return s;
}

let state = loadState();
let saveTimer = 0;

function save() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}

function touch(field) {
  if (!state.touchedFields.includes(field)) state.touchedFields.push(field);
}

// Fill in a starting approach without overwriting anything the instructor has edited.
function applyValues(values, keep = []) {
  const protectedFields = new Set([...state.touchedFields, ...keep]);
  for (const field of STARTER_FIELDS) {
    if (protectedFields.has(field)) continue;
    state[field] = Object.hasOwn(values, field) ? values[field] : defaultState[field];
  }
}

/* ---------- Helpers ---------- */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function optionList(options, selected) {
  return Object.entries(options).map(([value, label]) =>
    `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(label)}</option>`
  ).join("");
}

function filled(value, fallback) {
  const clean = String(value ?? "").trim();
  return clean || fallback;
}

function guidanceMarkup(field, value) {
  const item = choiceGuidance[field]?.[value];
  if (!item) return "";
  return `<div class="valid-choice-hint text-small" data-guidance-for="${esc(field)}">
    ${esc(item.why)}
    <details>
      <summary>Not sure? See when to choose this</summary>
      <p><strong>Choose this when:</strong> ${esc(item.choose)}</p>
      <p><strong>Keep in mind:</strong> ${esc(item.caution)}</p>
    </details>
  </div>`;
}

function textarea(field, label, placeholder) {
  return `<div class="valid-field-group">
    <label class="form-label" for="valid-${field}">${esc(label)}
      <textarea class="form-control" id="valid-${field}" data-field="${field}" placeholder="${esc(placeholder)}">${esc(state[field])}</textarea>
    </label>
    <div class="valid-example-action">
      <button class="btn btn-ghost" type="button" data-use-example="${field}">Insert an example to edit</button>
    </div>
  </div>`;
}

function select(field, label, options) {
  return `<div class="valid-field-group">
    <label class="form-label" for="valid-${field}">${esc(label)}
      <select class="form-select" id="valid-${field}" data-field="${field}">${optionList(options, state[field])}</select>
    </label>
    ${guidanceMarkup(field, state[field])}
  </div>`;
}

function duration(seconds) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function timeAgo(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `on ${new Date(timestamp).toLocaleDateString()}`;
}

/* ---------- Template examples (deterministic) ---------- */

function recommendedExample(field) {
  const skillExamples = {
    knowledge: "Explain the central concept accurately, connect it to a relevant example, distinguish it from a common misconception, and identify when it applies.",
    analysis: "Analyze evidence from multiple sources, evaluate its credibility and relevance, compare competing interpretations, identify assumptions or gaps, and draw a well-supported conclusion.",
    application: "Apply relevant concepts to a new problem, select an appropriate method, complete the task accurately, and justify the most consequential decisions.",
    creation: "Design an original response to a defined need, apply disciplinary criteria, test or revise the work, and justify major design decisions.",
    communication: "Explain complex ideas accurately for a named audience, organize the explanation effectively, and reflect on how evidence and feedback shaped the final message.",
    judgment: "Weigh evidence, stakeholder needs, risks, and ethical or professional standards to make and defend a responsible decision."
  };
  const productExamples = {
    written: "Each student will submit an evidence-based analysis that advances a clear conclusion, uses credible sources, addresses a competing interpretation, and explains the limits of the evidence.",
    case: "Each student will submit a case analysis that evaluates the available evidence, compares at least two possible courses of action, recommends one option, and explains risks, limitations, and tradeoffs.",
    solution: "Each student will submit a working solution with tests or intermediate reasoning, an explanation of the selected method, and a short analysis of limitations or alternative approaches.",
    performance: "Each student will complete the procedure or performance under defined conditions and provide a brief explanation of the most important decisions made.",
    design: "Each student will submit a completed design, selected process evidence, and a rationale connecting major choices to user needs, constraints, and disciplinary criteria.",
    dialogue: "Each student will present or defend a claim, respond to one evidence-based challenge, and submit a concise reflection identifying how the response changed or strengthened the reasoning.",
    portfolio: "Each student will submit selected artifacts showing planning, feedback, revision, and a final rationale explaining growth and consequential decisions."
  };
  const undermineExamples = {
    whole: "AI could generate most of the final submission, making it difficult to determine whether the student can perform the intended capability.",
    draft: "A plausible AI-generated draft could conceal whether the student can develop the central approach and make the key disciplinary decisions.",
    sources: "AI could supply convincing but inaccurate claims or fabricated citations that the student accepts without evaluating the underlying evidence.",
    solve: "AI could produce a correct-looking solution or code without revealing whether the student understands the method, assumptions, or errors.",
    media: "AI-generated media could obscure the student’s authorship, creative decisions, and control of disciplinary techniques.",
    edit: "Extensive AI rewriting could mask whether the student can communicate the ideas accurately and effectively.",
    uncertain: "Current AI capabilities may complete or substantially reshape the task in ways that make the student’s own learning difficult to identify."
  };
  const aiRules = {
    none: "AI may be used during designated practice activities but not during the independent assessed component. Students must disclose any AI-assisted preparation materials.",
    support: "AI may be used for brainstorming, organization, or feedback. It may not generate the final response, supply unverified claims, or fabricate sources. Students must verify consequential information and disclose how AI influenced the work.",
    collaborator: "Students may use an approved AI tool for alternatives, drafting, or analysis support. They remain responsible for verification, confidentiality, professional standards, and every final decision.",
    critique: "Students must use an approved AI response as an object of critique. AI may generate alternatives but may not write the final critique. Students must verify all claims in original sources and submit the required interaction record."
  };

  switch (field) {
    case "purposeStatement": return "Students must make evidence-based decisions they will encounter in professional practice.";
    case "learningStatement": return `The assessment measures students’ ${labels.outcome[state.outcome]}, including the ability to use disciplinary knowledge and explain consequential decisions.`;
    case "inferenceStatement":
      return state.aiRole === "none"
        ? "The completed task must support the claim that each student can demonstrate the essential capability independently under defined conditions."
        : `The completed task must support the claim that the student can demonstrate ${labels.outcome[state.outcome]} while selecting, directing, and evaluating legitimate tools responsibly.`;
    case "skills": return skillExamples[state.outcome];
    case "product": return productExamples[state.evidenceType];
    case "undermine": return undermineExamples[state.aiCapability];
    case "mitigation":
      if (state.aiRole === "none") return "Add an independent or observed component, explain why unaided evidence is needed, and provide an accessible equivalent for students who cannot attend the original setting.";
      if (state.aiRole === "critique") return "Require claim-level verification, annotations tied to disciplinary criteria, a corrected response, and a brief individual defense of one consequential revision.";
      return "Add a human-authored starting point, selected process checkpoints, source verification, an AI decision log, and a brief individual explanation of key choices.";
    case "stages": {
      const ending = state.delivery === "async" ? "recorded or written individual defense" : "brief individual defense";
      return `purpose and criteria → initial attempt or proposal → evidence check → draft or performance → feedback → revision → ${ending}`;
    }
    case "allowed": return aiRules[state.aiRole];
    case "support": {
      const scale = state.structure === "large" ? "grader calibration, benchmark responses, and targeted spot checks" : "an annotated example, checkpoints, and a calibrated rubric";
      const access = state.aiRole === "none" ? "clear independent-work conditions and accessibility accommodations" : "an approved tool or equivalent alternative, privacy guidance, and a short AI-literacy practice activity";
      return `Provide ${access}; ${scale}; clear disclosure instructions; and written or recorded alternatives for verification.`;
    }
    default: return "";
  }
}

/* ---------- Views ---------- */

function setView(view) {
  state.view = view;
  $("#valid-start").hidden = view !== "start";
  $("#valid-workflow").hidden = view !== "workflow";
  $("#valid-results").hidden = view !== "results";
  $("#valid-header").classList.toggle("is-compact", view !== "start");
}

// Switching views works like moving to a new page: start at the top and put
// keyboard and screen reader focus on the new heading.
function enterView(view, headingSelector) {
  setView(view);
  window.scrollTo(0, 0);
  $(headingSelector)?.focus({ preventScroll: true });
}

/* ---------- Starting approach ---------- */

function renderStarter() {
  $("#valid-starter-list").innerHTML = Object.entries(starterApproaches).map(([value, item]) => `
    <label class="valid-starter-option">
      <span class="form-check">
        <input class="form-check-input" type="radio" name="valid-starter" value="${esc(value)}"${value === state.starter ? " checked" : ""}>
        <span><strong>${esc(item.title)}</strong><span class="valid-starter-summary text-small">${esc(item.summary)}</span></span>
      </span>
    </label>`).join("");
  renderStarterGuidance();
}

function renderStarterGuidance() {
  const item = starterApproaches[state.starter];
  $("#valid-starter-guidance").innerHTML = `
    <dl>
      <dt>Choose this when</dt><dd>${esc(item.choose)}</dd>
      <dt>Why it helps</dt><dd>${esc(item.why)}</dd>
      <dt>Keep in mind</dt><dd>${esc(item.caution)}</dd>
    </dl>`;
  $("#valid-quick-start").textContent = state.starter === "recommend"
    ? "Continue — answer two questions first"
    : `Continue with ${item.title.toLowerCase()}`;
}

function beginWorkflow() {
  state.step = 0;
  setView("workflow");
  renderStep();
  window.scrollTo(0, 0);
  $("#valid-step-heading")?.focus({ preventScroll: true });
  save();
}

function startOver() {
  if ((state.touchedFields.length || state.ai) && !window.confirm("Start over? This clears all of your answers and any AI suggestions.")) return;
  ai.controller?.abort();
  resetAIPanel();
  const starter = state.starter;
  state = freshState();
  state.starter = starter;
  renderStarter();
  enterView("start", "#valid-start-heading");
  save();
}

/* ---------- Wizard ---------- */

function stepFields(step) {
  switch (step) {
    case 0: return `
      ${select("context", "Interest area", contextLabels)}
      ${select("delivery", "Delivery mode", labels.delivery)}
      ${select("purposeType", "Assessment purpose", labels.purposeType)}
      ${textarea("purposeStatement", "Why is this worth assessing?", "Example: Students must make evidence-based decisions they will encounter in professional practice.")}
      ${textarea("learningStatement", "What learning does it measure?", "Name the knowledge, reasoning, practice, or judgment this assessment should reveal.")}
      ${textarea("inferenceStatement", "What specific inference must this task support?", "Example: The completed task must support the claim that the student can evaluate evidence and defend a professional decision.")}`;
    case 1: return `
      ${select("outcome", "Primary student capability", labels.outcome)}
      ${textarea("skills", "What exactly should students be able to do?", "Use observable verbs. Example: Evaluate competing explanations, verify claims, and justify a recommendation with disciplinary evidence.")}`;
    case 2: return `
      ${select("evidenceType", "Primary form of evidence", labels.evidenceType)}
      ${select("accountability", "Who produces the evidence?", labels.accountability)}
      ${textarea("product", "What will students produce or perform?", "Describe the artifact, performance, decision, explanation, or process evidence that would demonstrate the skill.")}`;
    case 3: return `
      ${select("risk", "Risk that AI could substitute for the intended learning", labels.risk)}
      ${select("aiCapability", "Most likely AI capability", labels.aiCapability)}
      ${textarea("undermine", "How could AI use weaken the intended evidence?", "Example: A polished final report could conceal whether the student can evaluate evidence independently.")}
      ${textarea("mitigation", "What change would preserve the intended learning?", "Example: Add a human-first attempt, process checkpoints, source verification, or a brief individual defense.")}`;
    case 4: return `
      ${select("structure", "Course size and structure", labels.structure)}
      ${textarea("stages", "What stages and instructions will structure the work?", "Example: proposal → evidence check → draft → feedback → revision → individual rationale.")}`;
    case 5: return `
      ${select("aiRole", "Role of AI in assessed work", labels.aiRole)}
      ${select("aiasLevel", "AI Assessment Scale (AIAS 2.1)", labels.aiasLevel)}
      ${textarea("allowed", "What AI uses are permitted or required?", "State concrete examples of allowed, required, and prohibited uses.")}
      ${select("disclosure", "What AI-use evidence must students submit?", labels.disclosure)}`;
    default: return `
      ${select("grading", "Primary grading method", labels.grading)}
      ${select("verification", "Individual verification method", labels.verification)}
      ${textarea("support", "What implementation support is needed?", "Consider tool access, privacy, accessibility, AI literacy, examples, checkpoints, grader calibration, and alternatives.")}`;
  }
}

function renderStep() {
  const step = steps[state.step];

  $("#valid-step-list").innerHTML = steps.map((item, index) => {
    const cls = index === state.step ? "is-current" : index < state.step ? "is-done" : "";
    const current = index === state.step ? ' aria-current="step"' : "";
    return `<li class="${cls}" style="${stepStyle(index)}"><button type="button" data-go-step="${index}"${current}><span class="valid-step-num">${index + 1}</span> <span class="valid-step-name">${esc(item.name)}</span></button></li>`;
  }).join("");

  const recommendNote = state.starter === "recommend" && state.recommendedStarter && state.step === 2
    ? `<p class="valid-note text-small">Based on your answers, the remaining steps are prefilled using <strong>${esc(starterApproaches[state.recommendedStarter].title)}</strong>. Change anything you like.</p>`
    : "";

  const panel = $("#valid-panel");
  panel.style.cssText = stepStyle(state.step);
  panel.innerHTML = `
    <div class="valid-panel-header">
      <span class="valid-step-kicker"><span class="valid-step-letter" aria-hidden="true">${esc(step.letter)}</span>Step ${state.step + 1} of ${steps.length} · ${esc(step.tag)}</span>
      <h2 id="valid-step-heading" tabindex="-1">${esc(step.name)}</h2>
      <p class="valid-question">${esc(step.question)}</p>
      ${recommendNote}
    </div>
    <div class="valid-fields">${stepFields(state.step)}</div>`;

  $("#valid-back").disabled = state.step === 0;
  $("#valid-next").textContent = state.step === steps.length - 1 ? "Build my assessment plan" : `Next: ${steps[state.step + 1].name}`;
}

function goToStep(index) {
  const target = Math.max(0, Math.min(steps.length - 1, index));
  if (state.recommendPending && target > 1) applyRecommendedApproach();
  state.step = target;
  renderStep();
  const list = $("#valid-step-list");
  if (list.getBoundingClientRect().top < 0) list.scrollIntoView({ block: "start" });
  $("#valid-step-heading").focus({ preventScroll: true });
  scheduleSave();
}

function applyRecommendedApproach() {
  const match = {
    knowledge: "independent", analysis: "critique", application: "professional",
    creation: "support", communication: "support", judgment: "professional"
  }[state.outcome] || "critique";
  applyValues(starterApproaches[match].values, ["outcome"]);
  state.recommendPending = false;
  state.recommendedStarter = match;
}

/* ---------- Plan logic (deterministic) ---------- */

function resolvedAIAS() {
  if (state.aiasLevel !== "auto") return state.aiasLevel;
  if (state.aiRole === "none") return "one";
  // Evaluating and correcting AI output is AIAS 3: the AI output is material, not a collaborator.
  if (state.aiRole === "critique") return "three";
  if (state.aiRole === "collaborator") return state.outcome === "creation" ? "five" : "four";
  return "three";
}

function aiasAlignmentNote(level) {
  if (level === "one" && state.aiRole !== "none") return "Check alignment: AIAS 1 excludes AI from the assessed task, but the selected AI role permits or requires it.";
  if (level !== "one" && state.aiRole === "none") return "Check alignment: the selected AIAS level expects an AI role, but the assessment currently excludes AI.";
  if (level === "two" && ["critique", "collaborator"].includes(state.aiRole)) return "Check alignment: AIAS 2 limits AI to planning, but the selected AI role uses AI beyond planning.";
  if (["four", "five"].includes(level) && state.aiRole === "support") return "Check alignment: this level expects substantial AI involvement, but the selected role permits only limited support.";
  return state.aiasLevel === "auto"
    ? "Recommended from the selected AI role and learning outcome."
    : "Selected by the designer; confirm that the task instructions and rubric enforce this choice.";
}

function scorePattern(pattern) {
  let score = 0;
  if (pattern.outcomes.includes(state.outcome)) score += 4;
  if (pattern.evidenceTypes.includes(state.evidenceType)) score += 3;
  if (pattern.aiRoles.includes(state.aiRole)) score += 3;
  if (pattern.integrity && ["high", "uncertain"].includes(state.risk)) score += 2;
  if (state.accountability === "both" && pattern.name.includes("Team product")) score += 3;
  if (state.delivery === "async" && ["Process portfolio with checkpoints", "Human-first comparison and reflection", "Multimodal explanation"].includes(pattern.name)) score += 1;
  if (state.structure === "large" && ["Attempt–feedback–retry task", "Bounded application task", "Verified AI-output critique"].includes(pattern.name)) score += 1;
  if (state.aiRole === "none" && pattern.name === "Bounded application task") score += 2;
  return score;
}

function safeguards() {
  const items = [`Align every rubric criterion with ${labels.outcome[state.outcome]}; remove criteria that reward surface polish without evidence of the intended learning.`];
  items.push({
    knowledge: "Sample enough knowledge to support the intended inference and include explanation or application so recall is not the only evidence.",
    analysis: "Use evidence of comparable complexity and score the quality of criteria, verification, reasoning, and conclusions.",
    application: "Use a sufficiently novel problem and collect enough reasoning or explanation to show transfer rather than reproduction.",
    creation: "Assess the rationale, constraints, process, and revisions as well as the polish of the final product.",
    communication: "Define the audience and purpose clearly, and do not let production quality outweigh disciplinary meaning.",
    judgment: "Use realistic ambiguity and tradeoffs, and pair shared decisions with concise evidence of individual accountability."
  }[state.outcome]);
  if (["high", "uncertain"].includes(state.risk)) items.push("Add at least one independent source of evidence: a human-first attempt, process checkpoint, observed performance, or brief individual defense.");
  items.push({
    none: "Explain why independent performance is necessary and create practical conditions for it; do not treat AI-detector output as proof.",
    support: "Give concrete examples of permitted and prohibited uses, require a specific disclosure, and verify consequential claims and sources.",
    collaborator: "Provide an accessible institutional tool or equivalent alternative, retain relevant interactions, and grade the student’s decisions rather than the AI product.",
    critique: "Use a fixed instructor-provided AI output when possible so students critique equivalent material and graders can anticipate defensible corrections."
  }[state.aiRole]);
  if (state.delivery === "async") items.push("Use staged deadlines and persistent process evidence; offer recorded or written verification rather than requiring a live defense.");
  if (state.structure === "large") items.push("Use an analytic rubric, exemplars, targeted spot checks, and grader calibration; double-score a sample to check agreement.");
  else if (state.structure === "team" || state.accountability !== "individual") items.push("Pair every shared product with an individual memo, defense, or contribution record.");
  else items.push("Pilot the task with a small sample, annotate benchmark responses, and calibrate scoring before high-stakes use.");
  return items;
}

// Five distinct criteria. (The original overlapped three reasoning criteria worth 80%.)
function rubricCriteria() {
  const capability = labels.outcome[state.outcome];
  const evidence = labels.evidenceType[state.evidenceType];
  const level = resolvedAIAS();
  const independent = level === "one" || state.aiRole === "none";

  return [
    { name: "Primary disciplinary capability", weight: 35, descriptions: [
      `Demonstrates ${capability} with accuracy, depth, and insight; transfers it to complexity or ambiguity.`,
      `Demonstrates ${capability} accurately in the assigned context using appropriate disciplinary knowledge.`,
      `Demonstrates parts of ${capability}, but accuracy, depth, or transfer is inconsistent.`,
      `Provides insufficient evidence of ${capability} or relies on unsupported conclusions and procedures.`] },
    { name: "Use of evidence", weight: 25, descriptions: [
      "Selects highly relevant, credible evidence, evaluates its quality and limitations, and weighs alternatives.",
      "Uses relevant, credible evidence and addresses important limitations.",
      "Uses some evidence, but quality, verification, or consideration of alternatives is uneven.",
      "Uses weak, inaccurate, unverified, or insufficient evidence."] },
    { name: "Decision rationale and process", weight: 15, descriptions: [
      "Explains consequential decisions and revisions precisely, showing how feedback and evidence changed the work.",
      "Explains key decisions and revisions and links them to evidence or feedback.",
      "Explains some decisions, but the rationale or record of revision is thin.",
      "Does not explain decisions or show how the work developed."] },
    { name: `Quality of ${evidence}`, weight: 15, descriptions: [
      `The ${evidence} is complete, purposeful, and unusually effective for its audience.`,
      `The ${evidence} is complete, clear, and fit for purpose.`,
      `The ${evidence} is incomplete or difficult to interpret in places.`,
      `The ${evidence} is missing, unusable, or off-task.`] },
    independent
      ? { name: "Independent demonstration", weight: 10, descriptions: [
          "Demonstrates the capability fully independently and explains decisions flexibly, confirming ownership.",
          "Demonstrates the capability independently and accurately explains the key reasoning.",
          "Independent performance or explanation only partly confirms ownership and understanding.",
          "Cannot independently reproduce, explain, or defend the consequential parts of the work."] }
      : { name: "Responsible AI use and accountability", weight: 10, descriptions: [
          `Works consistently within ${labels.aiasLevel[level]}, verifies consequential output, documents use transparently, and owns the result.`,
          `Works within ${labels.aiasLevel[level]}, verifies important output, and provides the required disclosure.`,
          "Disclosure, verification, or accountability is incomplete or inconsistent with the AI-use rules.",
          "AI use conflicts with the rules, relies on unverified output, or omits required disclosure."] }
  ];
}

// Every answer the AI layer reads. If it changes, earlier AI output no longer applies.
// (Same field order as the previous version, so its saved AI output still matches.)
const SIGNATURE_FIELDS = ["context", "delivery", "purposeType", "purposeStatement", "learningStatement", "inferenceStatement",
  "outcome", "skills", "evidenceType", "product", "accountability", "risk", "aiCapability", "undermine", "mitigation",
  "structure", "stages", "aiRole", "aiasLevel", "allowed", "disclosure", "grading", "verification", "support"];

function planSignature() {
  return JSON.stringify(SIGNATURE_FIELDS.map((key) => state[key]));
}

/* ---------- Results ---------- */

function showResults() {
  setView("results");
  renderResults();
  window.scrollTo(0, 0);
  $("#valid-results-heading").focus({ preventScroll: true });
  save();
  initAI();
}

// AI output made before the latest edits. It's kept (and labeled) as long as the
// rubric's criteria are unchanged; otherwise the descriptors wouldn't line up.
function aiIsStale() {
  return Boolean(state.ai) && state.ai.signature !== planSignature();
}

function staleNote() {
  return aiIsStale() ? " Made before your latest edits." : "";
}

function renderResults() {
  planEditing = null;
  const sameCriteria = JSON.stringify(state.ai?.criteriaNames ?? []) === JSON.stringify(rubricCriteria().map((c) => c.name));
  if (aiIsStale() && !sameCriteria) {
    ai.controller?.abort(); // a run in progress is for the old answers
    state.ai = null;
    state.aiCleared = true;
    state.aiRubricHidden = false;
    resetAIPanel();
  }
  const level = resolvedAIAS();

  const planItems = [
    ["Verify", `${contextLabels[state.context]} · ${labels.delivery[state.delivery]} · ${labels.purposeType[state.purposeType]}. ${filled(state.purposeStatement, "Purpose not yet specified.")} ${filled(state.learningStatement, "")} Intended inference: ${filled(state.inferenceStatement, "not yet specified")}`],
    ["Articulate", `${labels.outcome[state.outcome]}. ${filled(state.skills, "Exact observable skill not yet specified.")}`],
    ["Locate", `${labels.evidenceType[state.evidenceType]} produced as ${labels.accountability[state.accountability]}. ${filled(state.product, "Student evidence not yet described.")}`],
    ["Inspect", `${labels.risk[state.risk]}. ${filled(state.undermine, "How AI could weaken the evidence has not yet been described.")} ${filled(state.mitigation, "")}`],
    ["Design", `${labels.structure[state.structure]}. ${filled(state.stages, "Assignment stages not yet specified.")}`],
    ["Assign", `${labels.aiRole[state.aiRole]} · ${labels.aiasLevel[level]}; submit ${labels.disclosure[state.disclosure]}. ${filled(state.allowed, "Detailed AI-use rules not yet specified.")}`],
    ["Implement", `${labels.grading[state.grading]} with ${labels.verification[state.verification]}. ${filled(state.support, "Implementation support not yet specified.")}`]
  ];
  $("#valid-plan-summary").innerHTML = planItems.map(([name, text], index) => `
    <li style="${stepStyle(index)}" data-plan-step="${index}">
      <span class="valid-plan-letter" aria-hidden="true">${esc(steps[index].letter)}</span>
      <div class="valid-plan-head">
        <strong>${esc(name)}</strong>
        <button class="btn btn-ghost valid-plan-edit" type="button" data-edit-step="${index}" aria-expanded="false" aria-controls="valid-plan-editor-${index}">Edit<span class="sr-only"> ${esc(name)}</span></button>
      </div>
      <span class="valid-plan-text">${esc(text)}</span>
    </li>`).join("");

  $("#valid-aias-label").textContent = `· ${labels.aiasLevel[level]}`;
  $("#valid-aias-summary").innerHTML = `
    <article class="valid-aias-card">
      <h3>${esc(labels.aiasLevel[level])}</h3>
      <p>${esc(aiasDescriptions[level])}</p>
      <p class="text-small text-muted">${esc(aiasAlignmentNote(level))}</p>
    </article>`;

  const ranked = patterns
    .map((pattern) => ({ pattern, score: scorePattern(pattern) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const best = ranked[0].pattern;
  $("#valid-approach-label").textContent = `· ${best.name}`;
  $("#valid-approaches").innerHTML = `
    <article class="valid-recommendation">
      <span class="viz-badge">Strongest fit</span>
      <h3>${esc(best.name)}</h3>
      <dl>
        <dt>Approach</dt><dd>${esc(best.description)}</dd>
        <dt>Evidence</dt><dd>${esc(best.evidence)}</dd>
        <dt>Watch for</dt><dd>${esc(best.caution)}</dd>
      </dl>
    </article>
    <p class="text-small text-muted valid-alternatives-label">Two alternatives worth considering</p>
    <ul class="valid-alternatives">
      ${ranked.slice(1).map(({ pattern }) => `<li><strong>${esc(pattern.name)}</strong><span class="text-small">${esc(pattern.description)} <em>Watch for:</em> ${esc(pattern.caution)}</span></li>`).join("")}
    </ul>`;

  $("#valid-safeguards").innerHTML = safeguards().map((item) => `<li>${esc(item)}</li>`).join("");

  renderRubric();

  const exampleSelect = $("#valid-example-area");
  exampleSelect.innerHTML = optionList(contextLabels, state.exampleContext);
  exampleSelect.value = state.exampleContext;
  renderExample();

  renderAIOutputs();
  updateAIControls();
  renderAIStatus();
}

function renderRubric() {
  const criteria = rubricCriteria();
  const level = resolvedAIAS();
  const aiRubric = state.ai?.rubric?.length === criteria.length ? state.ai.rubric : null;
  const showAI = Boolean(aiRubric) && !state.aiRubricHidden;
  const descriptions = (index) => (showAI ? aiRubric[index] : criteria[index].descriptions);
  const levels = ["Exemplary · 4", "Proficient · 3", "Developing · 2", "Beginning · 1"];
  const methodNames = { analytic: "analytic rubric", holistic: "holistic rubric", checklist: "criterion checklist", contract: "specifications guide" };

  $("#valid-rubric-ai-tag").hidden = !showAI;
  $("#valid-rubric-toolbar").hidden = !aiRubric;
  $("#valid-rubric-ai-note").textContent = showAI
    ? `Descriptors rewritten for your answers by ${state.ai.by?.rubric || "local AI"}.${staleNote()} Criteria and weights are unchanged.`
    : "Showing the template descriptors. An AI-personalized version is available.";
  $("#valid-rubric-toggle").textContent = showAI ? "Show template version" : "Show AI version";
  $("#valid-rubric-intro").textContent = `This ${methodNames[state.grading]} is aligned to ${labels.outcome[state.outcome]}, ${labels.evidenceType[state.evidenceType]}, and ${labels.aiasLevel[level]}. It is a draft: review the criteria and weighting, then pilot and calibrate before high-stakes use.`;

  let heading;
  let rows;
  if (state.grading === "analytic") {
    heading = `<tr><th scope="col">Criterion</th>${levels.map((item) => `<th scope="col">${esc(item)}</th>`).join("")}</tr>`;
    rows = criteria.map((item, i) => `<tr><th scope="row">${esc(item.name)}<br><span class="text-small text-muted">${item.weight}%</span></th>${descriptions(i).map((d) => `<td>${esc(d)}</td>`).join("")}</tr>`).join("");
  } else if (state.grading === "holistic") {
    heading = '<tr><th scope="col">Overall level</th><th scope="col">Integrated performance description</th></tr>';
    rows = levels.map((levelName, li) => `<tr><th scope="row">${esc(levelName)}</th><td>${criteria.map((item, i) => `<strong>${esc(item.name)}:</strong> ${esc(descriptions(i)[li])}`).join("<br><br>")}</td></tr>`).join("");
  } else if (state.grading === "checklist") {
    heading = '<tr><th scope="col">Criterion</th><th scope="col">Meets expectations when</th><th scope="col">Revise when</th></tr>';
    rows = criteria.map((item, i) => `<tr><th scope="row">${esc(item.name)} <span class="text-small text-muted">(${item.weight}%)</span></th><td>${esc(descriptions(i)[1])}</td><td>${esc(descriptions(i)[2])}</td></tr>`).join("");
  } else {
    heading = '<tr><th scope="col">Required specification</th><th scope="col">Satisfactory evidence</th></tr>';
    rows = criteria.map((item, i) => `<tr><th scope="row">${esc(item.name)} <span class="text-small text-muted">(${item.weight}%)</span></th><td>${esc(descriptions(i)[1])}</td></tr>`).join("");
  }

  const nameField = $("#valid-rubric-name");
  if (document.activeElement !== nameField) nameField.value = state.rubricName;
  nameField.placeholder = defaultRubricName();
  const pointsField = $("#valid-rubric-points");
  if (document.activeElement !== pointsField) pointsField.value = String(state.rubricPoints);
  $("#valid-export-format-note").hidden = state.grading === "analytic";
  $("#valid-rubric-output").innerHTML = `
    <div class="valid-rubric-table-wrap" role="region" aria-label="Draft rubric table" tabindex="0">
      <table class="valid-rubric-table"><thead>${heading}</thead><tbody>${rows}</tbody></table>
    </div>`;
}

function renderExample() {
  const example = examples[state.exampleContext] || examples[state.context];
  $("#valid-example").innerHTML = `
    <h3>${esc(example.title)}</h3>
    <dl>
      <dt>Published implementation</dt><dd>${esc(example.implementation)}</dd>
      <dt>Assignment adaptation</dt><dd>${esc(example.assignment)}</dd>
      <dt>What the study found</dt><dd>${esc(example.finding)}</dd>
      <dt>Evidence status</dt><dd>${esc(example.evidence)}</dd>
      <dt>Source</dt><dd><a href="${esc(example.url)}" target="_blank" rel="noopener noreferrer">Read the published source<span class="sr-only"> (opens in a new tab)</span></a></dd>
    </dl>`;
}

/* ---------- Editing answers on the plan page ---------- */

let planEditing = null; // { step, snapshot, touched }

function idsForPlan(html) {
  // The wizard panel may hold the same fields, so the plan editor gets its own IDs.
  return html.replace(/\b(id|for)="valid-/g, '$1="valid-plan-');
}

function openPlanEditor(index) {
  if (planEditing) closePlanEditor({ keep: true, rerender: false });
  const row = $(`[data-plan-step="${index}"]`);
  if (!row) return;
  row.insertAdjacentHTML("beforeend", `
    <div class="valid-plan-editor" id="valid-plan-editor-${index}" role="group" aria-label="Edit ${esc(steps[index].name)}">
      <div class="valid-fields">${idsForPlan(stepFields(index))}</div>
      <div class="viz-row valid-plan-editor-actions">
        <button class="btn btn-primary" type="button" data-plan-done>Update plan</button>
        <button class="btn btn-ghost" type="button" data-plan-cancel>Cancel</button>
      </div>
    </div>`);
  const editor = row.querySelector(".valid-plan-editor");
  const fields = [...editor.querySelectorAll("[data-field]")].map((el) => el.dataset.field);
  planEditing = {
    step: index,
    snapshot: Object.fromEntries(fields.map((f) => [f, state[f]])),
    exampleContext: state.exampleContext,
    touched: [...state.touchedFields]
  };
  row.classList.add("is-editing");
  const button = row.querySelector("[data-edit-step]");
  button.setAttribute("aria-expanded", "true");
  button.hidden = true;
  editor.querySelector("[data-field]")?.focus();
}

function closePlanEditor({ keep, rerender = true }) {
  if (!planEditing) return;
  const { step, snapshot, touched, exampleContext } = planEditing;
  if (!keep) {
    Object.assign(state, snapshot);
    state.touchedFields = touched;
    state.exampleContext = exampleContext;
  }
  planEditing = null;
  if (rerender && keep) {
    renderResults();
    announce("Plan updated.");
  } else {
    const row = $(`[data-plan-step="${step}"]`);
    row?.querySelector(".valid-plan-editor")?.remove();
    row?.classList.remove("is-editing");
    const button = row?.querySelector("[data-edit-step]");
    if (button) { button.hidden = false; button.setAttribute("aria-expanded", "false"); }
  }
  save();
  $(`[data-edit-step="${step}"]`)?.focus();
}

/* ---------- Canvas rubric export ---------- */

function defaultRubricName() {
  return `VALID-AI rubric: ${labels.evidenceType[state.evidenceType]}`;
}

// Canvas reads the file as UTF-8; plain punctuation avoids odd characters in older imports.
function plainText(value) {
  return String(value ?? "")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...").replace(/\u00B7/g, "-")
    .replace(/\u2192/g, "->").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function csvCell(value) {
  return `"${plainText(value).replace(/"/g, '""')}"`;
}

// Format from Canvas's rubric importer (lib/rubric_csv_importer.rb in canvas-lms):
// one row per criterion, grouped by "Rubric Name", with repeating
// Rating Name / Rating Description / Rating Points columns.
function canvasRubricCSV() {
  const criteria = rubricCriteria();
  const aiRubric = state.ai?.rubric?.length === criteria.length && !state.aiRubricHidden ? state.ai.rubric : null;
  const total = clampPoints(state.rubricPoints);
  const name = plainText(state.rubricName) || defaultRubricName();
  const levels = [["Exemplary", 1], ["Proficient", 0.75], ["Developing", 0.5], ["Beginning", 0.25]];
  const header = ["Rubric Name", "Criteria Name", "Criteria Description", "Criteria Enable Range"];
  levels.forEach((_, i) => header.push(`Rating Name ${i + 1}`, `Rating Description ${i + 1}`, `Rating Points ${i + 1}`));
  const rows = criteria.map((criterion, i) => {
    const max = (criterion.weight * total) / 100;
    const descriptions = aiRubric ? aiRubric[i] : criterion.descriptions;
    const row = [name, criterion.name, `Weight: ${criterion.weight}% of the assessment.`, "FALSE"];
    levels.forEach(([level, share], li) => row.push(level, descriptions[li], String(Math.round(max * share * 100) / 100)));
    return row;
  });
  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function downloadCanvasRubric() {
  const name = plainText(state.rubricName) || defaultRubricName();
  const file = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rubric"}-canvas.csv`;
  const url = URL.createObjectURL(new Blob([canvasRubricCSV()], { type: "text/csv;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: file });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#valid-export-status").textContent = `Downloaded ${file}.`;
}

/* ---------- Local AI ---------- */

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      model: typeof p.model === "string" ? p.model : "",
      useOllama: Boolean(p.useOllama),
      downloaded: Array.isArray(p.downloaded) ? p.downloaded.filter((id) => typeof id === "string") : []
    };
  } catch {
    return { model: "", useOllama: false, downloaded: [] };
  }
}

const ai = {
  ready: false,          // device check finished
  gpu: null,
  browser: [],           // in-browser model options
  ollama: [],            // models found on a local Ollama server
  recommended: "",
  ollamaState: "idle",   // idle | connecting | connected | failed
  ollamaMessage: "",
  engine: null,
  engineKey: "",
  busy: false,
  controller: null,
  prefs: loadPrefs()
};
let aiInitStarted = false;

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(ai.prefs)); } catch { /* storage unavailable */ }
}

function aiContext() {
  const level = resolvedAIAS();
  return {
    discipline: contextLabels[state.context],
    delivery: labels.delivery[state.delivery],
    purposeType: labels.purposeType[state.purposeType],
    whyAssess: state.purposeStatement,
    learningMeasured: state.learningStatement,
    intendedInference: state.inferenceStatement,
    primaryCapability: labels.outcome[state.outcome],
    observableSkills: state.skills,
    evidenceType: labels.evidenceType[state.evidenceType],
    whoProduces: labels.accountability[state.accountability],
    studentProduct: state.product,
    aiRisk: labels.risk[state.risk],
    likelyAICapability: labels.aiCapability[state.aiCapability],
    howAICouldUndermine: state.undermine,
    mitigation: state.mitigation,
    courseStructure: labels.structure[state.structure],
    stages: state.stages,
    aiRole: labels.aiRole[state.aiRole],
    aiasLevel: labels.aiasLevel[level],
    aiasMeaning: aiasDescriptions[level],
    aiUseRules: state.allowed,
    aiDisclosure: labels.disclosure[state.disclosure],
    gradingMethod: labels.grading[state.grading],
    verification: labels.verification[state.verification],
    support: state.support
  };
}

async function initAI() {
  if (aiInitStarted) return;
  aiInitStarted = true;
  ai.gpu = await detectWebGPU();
  if (ai.gpu) {
    ai.browser = browserModels(ai.gpu);
    ai.recommended = recommendBrowserModel(ai.browser, ai.gpu)?.id ?? "";
  }
  ai.ready = true;
  renderModelPicker();
  // Reconnect automatically only if the person connected to Ollama before.
  if (ai.prefs.useOllama) connectOllama({ automatic: true });
}

const choiceValue = (model) => `${model.kind}:${model.id}`;

function selectedModel() {
  const value = $("#valid-ai-model").value;
  return [...ai.ollama, ...ai.browser].find((m) => choiceValue(m) === value) ?? null;
}

function modelLabel(model) {
  if (model.kind === "ollama") return model.size ? `${model.id} · ${model.size}` : model.id;
  const parts = [`${model.label}${model.id === ai.recommended ? " (recommended)" : ""}`, model.note,
    `needs ~${(model.vramMB / 1024).toFixed(1)} GB GPU memory`];
  if (ai.prefs.downloaded.includes(model.id)) parts.push("downloaded");
  return parts.join(" · ");
}

function renderModelPicker() {
  const picker = $("#valid-ai-model");
  const previous = picker.value;
  const group = (label, models) => (models.length
    ? `<optgroup label="${esc(label)}">${models.map((m) => `<option value="${esc(choiceValue(m))}">${esc(modelLabel(m))}</option>`).join("")}</optgroup>`
    : "");
  picker.innerHTML = group("Ollama on this computer", ai.ollama) + group("In this browser", ai.browser);
  const values = [...picker.options].map((option) => option.value);
  const wanted = [ai.prefs.model, previous, ai.ollama[0] && choiceValue(ai.ollama[0]), ai.recommended && `browser:${ai.recommended}`]
    .find((value) => value && values.includes(value));
  if (wanted) picker.value = wanted;
  $("#valid-ai-model-field").hidden = values.length === 0;
  updateAIControls();
  renderAIStatus();
}

function updateAIControls() {
  const hasModels = $("#valid-ai-model").options.length > 0;
  $("#valid-ai-model").disabled = ai.busy || !hasModels;
  const run = $("#valid-ai-run");
  run.disabled = ai.busy || !hasModels;
  run.textContent = ai.busy ? "Working…" : state.ai ? "Personalize again" : "Personalize";
  $("#valid-ai-stop").hidden = !ai.busy;
  const ollama = $("#valid-ai-ollama");
  ollama.hidden = ai.ollamaState === "connected";
  ollama.disabled = ai.busy || ai.ollamaState === "connecting";
  ollama.textContent = ai.ollamaState === "connecting"
    ? "Connecting to Ollama…"
    : ai.ollamaState === "failed" ? "Try connecting to Ollama again" : "Have Ollama installed? Connect to it";
}

function renderAIStatus() {
  if (ai.busy) {
    $("#valid-ai-status").textContent = "Working on this computer. You can keep reading your plan while it runs.";
    return;
  }
  const parts = [];
  if (ai.ollamaMessage) parts.push(ai.ollamaMessage);
  if (aiIsStale()) parts.push("<strong>You've changed answers since these AI suggestions were made.</strong> Personalize again to update them.");
  if (state.aiCleared && !state.ai) parts.push("<strong>Your answers changed, so the earlier AI suggestions were cleared.</strong> Personalize again to update them.");
  if (!ai.ready) {
    parts.push("Checking what this device can run…");
  } else {
    const model = selectedModel();
    if (!model) {
      parts.push("This browser can't run AI models because it doesn't support WebGPU. Try Chrome or Edge on a recent computer, or connect to Ollama. The plan works fine without AI.");
    } else if (model.kind === "ollama") {
      parts.push("Uses Ollama on this computer. Nothing leaves your machine.");
    } else if (ai.prefs.downloaded.includes(model.id)) {
      parts.push("Runs in your browser. This model is already downloaded, so it loads from your browser's storage.");
    } else {
      parts.push("Runs entirely in your browser. The first run downloads the model, which can take several minutes; after that it loads from your browser's storage.");
    }
  }
  if (state.ai?.finishedAt) parts.push(`Last personalized ${timeAgo(state.ai.finishedAt)}.`);
  $("#valid-ai-status").innerHTML = parts.join(" ");
}

async function connectOllama({ automatic = false } = {}) {
  ai.ollamaState = "connecting";
  ai.ollamaMessage = "";
  updateAIControls();
  const { reachable, models } = await detectOllama();
  ai.ollama = models;
  if (reachable && models.length) {
    ai.ollamaState = "connected";
    ai.prefs.useOllama = true;
    if (!automatic) ai.prefs.model = choiceValue(models[0]);
    savePrefs();
  } else if (automatic) {
    ai.ollamaState = "idle";
  } else {
    ai.ollamaState = "failed";
    ai.ollamaMessage = reachable
      ? "<strong>Ollama is running but has no chat models yet.</strong> Run <code>ollama pull qwen3:8b</code>, then connect again."
      : "<strong>Couldn't reach Ollama at localhost:11434.</strong> Check that it's running and that OLLAMA_ORIGINS includes this site (the README explains how). Chrome may also ask you to allow access to devices on your local network.";
  }
  renderModelPicker();
}

function setProgress(fraction, text) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  $("#valid-ai-progress").hidden = false;
  $("#valid-ai-progress-bar").style.width = `${pct}%`;
  $("#valid-ai-progress-track").setAttribute("aria-valuenow", String(pct));
  const label = $("#valid-ai-progress-text");
  if (label.textContent !== text) label.textContent = text;
}

// Only milestones are announced to screen readers, not every percentage tick.
function announce(text) {
  $("#valid-ai-announcer").textContent = text;
}

function resetAIPanel() {
  $("#valid-ai-progress").hidden = true;
  $("#valid-ai-error").hidden = true;
}

function showError(lines, title = "Some sections couldn't be generated.") {
  const box = $("#valid-ai-error");
  box.innerHTML = `<strong>${esc(title)}</strong> The template versions are still shown.<ul>${lines.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`;
  box.hidden = false;
}

function isFatal(err) {
  return /out of memory|OOM|device (was )?lost|DeviceLost|GPUDevice|allocate/i.test(String(err?.message ?? err));
}

function friendlyError(err, kind) {
  const message = String(err?.message ?? err);
  if (kind === "ollama" && (err instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(message))) {
    return "Couldn't reach Ollama. Check that it's running and that OLLAMA_ORIGINS includes this site.";
  }
  if (isFatal(err)) return "The model ran out of GPU memory. Pick a smaller model and try again.";
  if (kind === "browser" && /Failed to fetch|NetworkError|Load failed|ERR_|importing a module script failed|dynamically imported module/i.test(message)) {
    return "Couldn't download the AI library or model. Check your internet connection (and that cdn.jsdelivr.net and huggingface.co aren't blocked on this network), then try again.";
  }
  if (/WebGPU|navigator\.gpu|adapter/i.test(message)) return "This browser couldn't start WebGPU. Try Chrome or Edge, or connect to Ollama.";
  if (/did not return JSON|Unexpected token|JSON/i.test(message)) return "The model's answer wasn't in the expected format. Try again, or pick a larger model.";
  return message;
}

async function disposeEngine() {
  const engine = ai.engine;
  ai.engine = null;
  ai.engineKey = "";
  if (engine) await engine.dispose();
}

async function getEngine(model, signal) {
  const key = choiceValue(model);
  if (ai.engine && ai.engineKey === key) return ai.engine;
  await disposeEngine();
  if (model.kind === "ollama") {
    ai.engine = createOllamaEngine(model);
  } else {
    navigator.storage?.persist?.().catch(() => {});
    announce(`Loading ${model.label}.`);
    ai.engine = await createBrowserEngine(model, {
      signal,
      onLoadProgress: (fraction, text) => {
        const pct = Math.round(fraction * 100);
        if (/fetch/i.test(text)) setProgress(fraction, `Downloading ${model.label} (first time only): ${pct}%`);
        else if (/load/i.test(text)) setProgress(fraction, `Loading ${model.label} into GPU memory: ${pct}%`);
        else setProgress(fraction, `Preparing ${model.label}…`);
      }
    });
  }
  ai.engineKey = key;
  return ai.engine;
}

async function runPersonalisation() {
  const model = selectedModel();
  if (ai.busy || !model) return;
  ai.busy = true;
  ai.controller = new AbortController();
  const { signal } = ai.controller;
  ai.ollamaMessage = "";
  $("#valid-ai-error").hidden = true;
  updateAIControls();
  renderAIStatus();

  const started = Date.now();
  const ctx = aiContext();
  const signature = planSignature();
  const jobs = [
    { key: "alignment", label: "Checking your answers for contradictions", task: alignmentTask(ctx), expected: 900 },
    { key: "instructions", label: "Drafting student AI-use instructions", task: instructionsTask(ctx), expected: 1600 },
    { key: "rubric", label: "Rewriting the rubric descriptors", task: rubricTask(ctx, rubricCriteria()), expected: 4000 }
  ];
  const result = state.ai?.signature === signature ? { ...state.ai, by: { ...state.ai.by } } : { signature, by: {} };
  const failures = [];
  let finished = 0;
  let engine = null;

  try {
    setProgress(0, model.kind === "browser" ? "Loading the AI library…" : `Connecting to ${model.label}…`);
    engine = await getEngine(model, signal);
    if (model.kind === "browser" && !ai.prefs.downloaded.includes(model.id)) {
      ai.prefs.downloaded.push(model.id);
      savePrefs();
    }
    for (const [index, job] of jobs.entries()) {
      if (signal.aborted) break;
      const label = `${job.label} (${index + 1} of ${jobs.length})…`;
      setProgress(index / jobs.length, label);
      announce(label);
      try {
        const raw = await engine.generate(job.task.messages, job.task.schema, {
          maxTokens: job.task.maxTokens,
          signal,
          onProgress: (chars) => setProgress((index + Math.min(chars / job.expected, 0.95)) / jobs.length, label)
        });
        if (signal.aborted) break;
        result[job.key] = job.task.validate(raw);
        result.by[job.key] = engine.label;
        result.criteriaNames = rubricCriteria().map((c) => c.name);
        result.finishedAt = Date.now();
        state.ai = { ...result, by: { ...result.by } };
        state.aiCleared = false;
        if (job.key === "rubric") state.aiRubricHidden = false;
        finished += 1;
        renderAIOutputs({ reveal: job.key });
        renderRubric();
        scheduleSave();
      } catch (err) {
        if (isAbort(err) || signal.aborted) break;
        failures.push(`${job.label}: ${friendlyError(err, model.kind)}`);
        if (isFatal(err)) {
          await disposeEngine();
          break;
        }
      }
    }
  } catch (err) {
    if (!isAbort(err) && !signal.aborted) failures.push(friendlyError(err, model.kind));
    await disposeEngine().catch(() => {});
  }
  const engineFailed = !engine && failures.length > 0;

  const elapsed = duration(Math.max(1, Math.round((Date.now() - started) / 1000)));
  let summary;
  if (signal.aborted) {
    summary = finished ? "Stopped. The sections that finished are kept below." : "Stopped.";
    setProgress(finished / jobs.length, summary);
  } else if (engineFailed) {
    summary = `${model.label} couldn't start.`;
    setProgress(0, summary);
    showError(failures, `${model.label} couldn't start.`);
  } else if (failures.length) {
    summary = `Finished ${finished} of ${jobs.length} sections in ${elapsed}.`;
    setProgress(finished / jobs.length, summary);
    showError(failures);
  } else {
    summary = `Done in ${elapsed} with ${engine?.label ?? model.label}. Review each AI section below before you use it.`;
    setProgress(1, summary);
  }
  announce(summary);

  ai.busy = false;
  ai.controller = null;
  renderModelPicker();
}

function renderAIOutputs({ reveal } = {}) {
  const result = state.ai;
  const list = (items, empty) => (items.length
    ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
    : `<p class="text-muted">${esc(empty)}</p>`);

  const alignmentSection = $("#valid-alignment-section");
  if (result?.alignment) {
    const issues = result.alignment;
    $("#valid-alignment-label").textContent = issues.length
      ? `· ${issues.length} possible ${issues.length === 1 ? "issue" : "issues"}`
      : "· no conflicts found";
    const body = issues.length
      ? `<ul class="valid-issues">${issues.map((item) => `
          <li>
            <span class="valid-sev is-${esc(item.severity)}">${esc(item.severity)}<span class="sr-only"> priority</span></span>
            <span class="valid-issue-text">
              <strong>${esc(item.issue)}</strong>
              ${item.suggestion ? `<span class="valid-issue-suggestion">${esc(item.suggestion)}</span>` : ""}
              ${item.fields.length ? `<span class="valid-issue-fields text-small">Check: ${esc(item.fields.join(" · "))}</span>` : ""}
            </span>
          </li>`).join("")}</ul>`
      : "<p>No contradictions found between your answers.</p>";
    $("#valid-alignment").innerHTML = `${body}<p class="text-small valid-ai-foot">Checked by ${esc(result.by?.alignment || "local AI")}.${staleNote()} A small model can miss problems or flag non-issues, so treat this as a second reader, not a verdict.</p>`;
    alignmentSection.hidden = false;
    if (reveal === "alignment") alignmentSection.open = true;
  } else {
    alignmentSection.hidden = true;
  }

  const instructionsSection = $("#valid-instructions-section");
  if (result?.instructions) {
    const i = result.instructions;
    $("#valid-instructions").innerHTML = `
      <div class="valid-ai-toolbar">
        <p class="text-small">Draft by ${esc(result.by?.instructions || "local AI")}.${staleNote()} Review and edit before sharing with students.</p>
        <button class="btn btn-ghost text-small" type="button" data-copy-instructions>Copy text</button>
      </div>
      <p>${esc(i.overview)}</p>
      <h4>You may use AI to</h4>${list(i.permitted, "AI isn't permitted for this assignment.")}
      <h4>You may not use AI to</h4>${list(i.prohibited, "No specific restrictions were listed.")}
      ${i.documentation ? `<h4>What to submit about your AI use</h4><p>${esc(i.documentation)}</p>` : ""}
      ${i.why ? `<h4>Why these rules</h4><p>${esc(i.why)}</p>` : ""}`;
    instructionsSection.hidden = false;
    if (reveal === "instructions") instructionsSection.open = true;
  } else {
    instructionsSection.hidden = true;
  }

  if (reveal === "rubric") $("#valid-rubric-section").open = true;
}

function instructionsText(i) {
  const bullets = (items) => (items.length ? items.map((item) => `- ${item}`) : ["- (none)"]);
  return [
    "AI use in this assignment", "", i.overview, "",
    "You may use AI to:", ...bullets(i.permitted), "",
    "You may not use AI to:", ...bullets(i.prohibited),
    ...(i.documentation ? ["", "What to submit about your AI use:", i.documentation] : []),
    ...(i.why ? ["", "Why these rules:", i.why] : [])
  ].join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------- Events ---------- */

function bindEvents() {
  // Starting approach
  $("#valid-starter-list").addEventListener("change", (event) => {
    if (event.target.name !== "valid-starter") return;
    state.starter = event.target.value;
    renderStarterGuidance();
    scheduleSave();
  });

  $("#valid-quick-start").addEventListener("click", () => {
    applyValues(starterApproaches[state.starter].values);
    state.recommendPending = state.starter === "recommend";
    state.recommendedStarter = "";
    beginWorkflow();
  });

  $("#valid-guided-start").addEventListener("click", () => {
    for (const field of ANSWER_FIELDS) state[field] = defaultState[field];
    state.exampleContext = state.context;
    state.touchedFields = [];
    state.recommendPending = false;
    state.recommendedStarter = "";
    beginWorkflow();
  });

  // Wizard. Listeners are delegated, so re-rendering a step never drops them,
  // and typing never triggers a re-render (the cause of the old focus bug).
  const onEdit = (control) => {
    const field = control.dataset.field;
    const previousContext = state.context;
    state[field] = control.value;
    touch(field);
    if (field === "context" && state.exampleContext === previousContext) state.exampleContext = state.context;
    if (control.tagName === "SELECT") {
      const hint = control.closest(".valid-field-group")?.querySelector("[data-guidance-for]");
      if (hint) hint.outerHTML = guidanceMarkup(field, state[field]);
    }
    scheduleSave();
  };
  for (const container of [$("#valid-panel"), $("#valid-plan-summary")]) {
  container.addEventListener("input", (event) => {
    if (event.target.matches("textarea[data-field]")) onEdit(event.target);
  });
  container.addEventListener("change", (event) => {
    if (event.target.matches("select[data-field]")) onEdit(event.target);
  });
  container.addEventListener("click", (event) => {
    const button = event.target.closest("[data-use-example]");
    if (!button) return;
    const field = button.dataset.useExample;
    const example = recommendedExample(field);
    const target = container.querySelector(`[data-field="${field}"]`);
    if (!target || !example) return;
    const current = target.value.trim();
    if (current && current !== example && !window.confirm("Replace what you've written with the example?")) return;
    target.value = example;
    state[field] = example;
    touch(field);
    button.textContent = "Example inserted";
    target.focus();
    scheduleSave();
  });
  }

  $("#valid-plan-summary").addEventListener("click", (event) => {
    const edit = event.target.closest("[data-edit-step]");
    if (edit) openPlanEditor(Number(edit.dataset.editStep));
    else if (event.target.closest("[data-plan-done]")) closePlanEditor({ keep: true });
    else if (event.target.closest("[data-plan-cancel]")) closePlanEditor({ keep: false });
  });
  $("#valid-plan-summary").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && planEditing) closePlanEditor({ keep: false });
  });

  $("#valid-rubric-name").addEventListener("input", (event) => {
    state.rubricName = event.target.value.slice(0, 120);
    scheduleSave();
  });
  $("#valid-rubric-points").addEventListener("change", (event) => {
    state.rubricPoints = clampPoints(event.target.value);
    event.target.value = String(state.rubricPoints);
    scheduleSave();
  });
  $("#valid-export-canvas").addEventListener("click", downloadCanvasRubric);

  $("#valid-step-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-go-step]");
    if (button) goToStep(Number(button.dataset.goStep));
  });
  $("#valid-back").addEventListener("click", () => {
    if (state.step > 0) goToStep(state.step - 1);
  });
  $("#valid-next").addEventListener("click", () => {
    if (state.step < steps.length - 1) goToStep(state.step + 1);
    else showResults();
  });
  $("#valid-change-start").addEventListener("click", startOver);

  // Results
  $("#valid-restart").addEventListener("click", startOver);
  $("#valid-edit-answers").addEventListener("click", () => {
    setView("workflow");
    renderStep();
    window.scrollTo(0, 0);
    $("#valid-step-heading").focus({ preventScroll: true });
    save();
  });
  $("#valid-example-area").addEventListener("change", (event) => {
    state.exampleContext = event.target.value;
    renderExample();
    scheduleSave();
  });
  $("#valid-rubric-toggle").addEventListener("click", () => {
    state.aiRubricHidden = !state.aiRubricHidden;
    renderRubric();
    scheduleSave();
  });
  $("#valid-print").addEventListener("click", () => window.print());

  // Local AI
  $("#valid-ai-run").addEventListener("click", runPersonalisation);
  $("#valid-ai-stop").addEventListener("click", () => ai.controller?.abort());
  $("#valid-ai-ollama").addEventListener("click", () => connectOllama());
  $("#valid-ai-model").addEventListener("change", (event) => {
    ai.prefs.model = event.target.value;
    ai.ollamaMessage = "";
    savePrefs();
    renderAIStatus();
  });
  $("#valid-instructions").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy-instructions]");
    if (!button || !state.ai?.instructions) return;
    const ok = await copyText(instructionsText(state.ai.instructions));
    button.textContent = ok ? "Copied" : "Couldn't copy";
    setTimeout(() => { button.textContent = "Copy text"; }, 2000);
  });

  // Printing opens every section so nothing is left out of the PDF.
  let openBeforePrint = null;
  window.addEventListener("beforeprint", () => {
    const sections = [...root.querySelectorAll("#valid-results details")];
    openBeforePrint = sections.map((section) => [section, section.open]);
    sections.forEach((section) => { section.open = true; });
  });
  window.addEventListener("afterprint", () => {
    openBeforePrint?.forEach(([section, open]) => { section.open = open; });
    openBeforePrint = null;
  });

  // Flush a pending save if the tab is closed or hidden.
  window.addEventListener("pagehide", () => { if (saveTimer) save(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer) save();
  });
}

/* ---------- Start ---------- */

function init() {
  bindEvents();
  if (state.view === "results") {
    setView("results");
    renderResults();
    initAI();
  } else if (state.view === "workflow") {
    setView("workflow");
    renderStep();
  } else {
    setView("start");
    renderStarter();
  }
}

init();
