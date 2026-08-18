const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const authHeaders = () => ({ Authorization: `Bearer ${sessionToken}` });

const byId = (id) => document.getElementById(id);
const errorSection = byId("error-section");
const errorText = byId("error-text");
const camStatus = byId("cam-status");
const camSpinner = byId("cam-spinner");
const camStatusText = byId("cam-status-text");
const camAssistant = byId("cam-assistant");
const camWizard = byId("cam-wizard");
const camStepProgress = byId("cam-step-progress");
const camStepTitle = byId("cam-step-title");
const camStepIntro = byId("cam-step-intro");
const camStepFields = byId("cam-step-fields");
const camBackBtn = byId("cam-back-btn");
const camNextBtn = byId("cam-next-btn");
const camPlanBtn = byId("cam-plan-btn");
const camPlanView = byId("cam-plan-view");
const camPlanSummary = byId("cam-plan-summary");
const camPlanTbody = byId("cam-plan-tbody");
const camPlanNotes = byId("cam-plan-notes");
const camGenerateBtn = byId("cam-generate-btn");
const camReviseBtn = byId("cam-revise-btn");
const camReviseBox = byId("cam-revise-box");
const camReviseInput = byId("cam-revise-input");
const camReviseSubmit = byId("cam-revise-submit");
const gcodeOutput = byId("gcode-output");
const camSafetySummary = byId("cam-safety-summary");
const camSafetyList = byId("cam-safety-list");
const gcodePreview = byId("gcode-preview");
const gcodeLink = byId("gcode-link");
const cncSimBtn = byId("cnc-sim-btn");
const camQuote = byId("cam-quote");
const camQuoteTime = byId("cam-quote-time");
const camQuoteBtn = byId("cam-quote-btn");
const camQuoteForm = byId("cam-quote-form");
const quoteFieldsBasit = byId("quote-fields-basit");
const quoteFieldsDetayli = byId("quote-fields-detayli");
const camQuoteSubmit = byId("cam-quote-submit");
const camQuoteResult = byId("cam-quote-result");
const camQuoteBreakdown = byId("cam-quote-breakdown");
const camQuotePdf = byId("cam-quote-pdf");

let stepPath = null;
let prompt = "";
let projectId = null;
let bbox = null;
let generatedCode = null;
let stlUrl = null;
let contourUrl = null;
let camAnswers = {};
let camStepIndex = 0;
let camStepFieldNames = [];
let camPreviewToken = null;
let camEstimatedMinutes = null;
let camPlan = null;

const raw = sessionStorage.getItem("rover_cam_data");
if (!raw) {
  window.location.replace("index.html");
} else {
  const data = JSON.parse(raw);
  stepPath = data.stepPath;
  prompt = data.prompt || "";
  projectId = data.projectId || null;
  bbox = data.bbox || null;
  generatedCode = data.generatedCode || null;
  stlUrl = data.stlUrl || null;
  contourUrl = data.contourUrl || null;
}

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 7 * 60 * 1000;
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runAsyncJob(url, options, onTick) {
  const startResp = await fetch(url, options);
  const startData = await readJson(startResp);
  if (!startResp.ok) return { error: startData?.error ?? `Sunucu hatası (HTTP ${startResp.status})`, body: startData };
  const jobId = startData?.jobId;
  if (!jobId) return { ok: true, body: startData };
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (onTick) onTick(Math.round((Date.now() - startedAt) / 1000));
    let statusResp, statusData;
    try {
      statusResp = await fetch(`${API_BASE}/jobs/${jobId}`, { headers: authHeaders() });
      statusData = await readJson(statusResp);
    } catch { continue; }
    if (statusResp.status === 404) return { error: "İş bulunamadı veya zaman aşımına uğradı." };
    if (!statusResp.ok || !statusData) continue;
    if (statusData.status === "pending") { if (onTick && statusData.elapsed != null) onTick(statusData.elapsed); continue; }
    if (statusData.status === "error") return { error: statusData.error ?? "İşlem başarısız oldu." };
    if (statusData.status === "done") { const { status, ok, ...body } = statusData; return { ok, body }; }
  }
  return { error: "İşlem zaman aşımına uğradı." };
}

function showError(message) { errorSection.hidden = false; errorText.textContent = message; }
function clearError() { errorSection.hidden = true; errorText.textContent = ""; }

function setCamStatus(message, busy) {
  camStatus.hidden = !message;
  camSpinner.hidden = !busy;
  camStatusText.textContent = message ?? "";
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Critical machining parameters the machinist can review/tweak before the
// plan is turned into FreeCAD code — editing here writes straight into
// `camPlan.steps`, which is what gets sent to /cam-simulate and /cam-confirm
// verbatim, so an edit made here is exactly what the code generator sees.
const CAM_PLAN_NUMERIC_FIELDS = [
  { field: "stepDownMm", max: 10 },
  { field: "feedMmMin", max: null },
  { field: "startDepthMm", max: null },
  { field: "finalDepthMm", max: null },
];

function renderCamPlanTable(plan) {
  camPlanSummary.textContent = plan.summary || "";
  camPlanNotes.textContent = plan.notes ? `Notlar: ${plan.notes}` : "";
  camPlanTbody.innerHTML = (plan.steps || []).map((s, i) => {
    const cells = CAM_PLAN_NUMERIC_FIELDS.map(({ field, max }) => {
      const v = s[field];
      const maxAttr = max != null ? ` max="${max}"` : "";
      return `<td><input type="number" step="any"${maxAttr} class="cam-plan-input" data-idx="${i}" data-field="${field}" value="${v ?? ""}" /></td>`;
    }).join("");
    return (
      `<tr>` +
      `<td>${s.step}</td>` +
      `<td><strong>${escapeHtml(s.operation || "")}</strong> — ${escapeHtml(s.tool || "")}` +
      (s.description ? `<div class="cam-plan-desc">${escapeHtml(s.description)}</div>` : "") +
      `</td>` +
      cells +
      `</tr>`
    );
  }).join("");
}

// Delegated so it works for every row rendered above, including after a
// revised plan re-renders the whole table.
camPlanTbody.addEventListener("change", (ev) => {
  const input = ev.target.closest(".cam-plan-input");
  if (!input || !camPlan) return;
  const idx = Number(input.dataset.idx);
  const field = input.dataset.field;
  const step = camPlan.steps?.[idx];
  if (!step) return;
  let value = input.value.trim() === "" ? null : Number(input.value);
  if (value != null && !Number.isFinite(value)) value = null;
  const spec = CAM_PLAN_NUMERIC_FIELDS.find((f) => f.field === field);
  if (value != null && spec?.max != null && value > spec.max) {
    value = spec.max; // silently clamp (StepDown must never exceed the safety limit)
    input.value = String(value);
  }
  step[field] = value;
});

function renderSafetyChecks(checks) {
  if (!Array.isArray(checks) || checks.length === 0) {
    camSafetySummary.hidden = true;
    return;
  }
  camSafetyList.innerHTML = checks.map((c) =>
    `<li class="${c.ok ? "cam-safety-ok" : "cam-safety-fail"}">${c.ok ? "✓" : "✕"} ${escapeHtml(c.label || "")}</li>`
  ).join("");
  camSafetySummary.hidden = false;
}

async function loadCamStep(targetIndex) {
  setCamStatus("Adım hazırlanıyor…", true);
  try {
    const response = await fetch(`${API_BASE}/cam-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ stepPath, prompt, answers: camAnswers, targetIndex }),
    });
    const data = await readJson(response);
    if (!response.ok || !data) { setCamStatus(data?.error ?? "Adım alınamadı.", false); return; }
    setCamStatus("", false);
    if (data.done) { camWizard.hidden = true; camPlanBtn.hidden = false; return; }
    renderCamStep(data);
    camWizard.hidden = false;
    camPlanBtn.hidden = true;
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
}

function renderCamStep(data) {
  const step = data.step;
  camStepIndex = data.index;
  camStepFieldNames = step.fields.map((f) => f.name);
  camStepProgress.textContent = `Adım ${data.index + 1} / ${data.total}`;
  camStepTitle.textContent = step.title;
  if (step.intro) { camStepIntro.textContent = step.intro; camStepIntro.hidden = false; } else { camStepIntro.hidden = true; }
  camStepFields.innerHTML = "";
  step.fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "cam-field";
    const inputId = `camf-${f.name}`;
    const label = document.createElement("label");
    label.setAttribute("for", inputId);
    label.textContent = f.unit ? `${f.label} (${f.unit})` : f.label;
    wrap.appendChild(label);
    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      (f.options || []).forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if (String(opt) === String(f.value)) o.selected = true;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.type = f.type === "number" ? "number" : "text";
      if (f.type === "number") input.step = "any";
      input.value = f.value ?? "";
    }
    input.id = inputId; input.name = f.name; input.dataset.type = f.type;
    wrap.appendChild(input);
    camStepFields.appendChild(wrap);
  });
  camBackBtn.hidden = camStepIndex === 0;
  camNextBtn.textContent = data.index + 1 >= data.total ? "Tamam" : "İleri";
}

function collectCurrentStep() {
  camStepFields.querySelectorAll("input, select").forEach((el) => {
    let value = el.value;
    if (el.dataset.type === "number") { const n = Number(value); if (Number.isFinite(n)) value = n; }
    camAnswers[el.name] = value;
  });
}

async function handleCamNext() { collectCurrentStep(); await loadCamStep(camStepIndex + 1); }
async function handleCamBack() { collectCurrentStep(); if (camStepIndex === 0) return; await loadCamStep(camStepIndex - 1); }

async function requestCamPlan(changeRequest) {
  const body = { stepPath, answers: camAnswers, prompt };
  if (changeRequest && camPlan) { body.previousPlan = camPlan; body.changeRequest = changeRequest; }
  setCamStatus("İşleme planı oluşturuluyor…", true);
  camPlanBtn.disabled = true;
  try {
    const result = await runAsyncJob(
      `${API_BASE}/cam-plan`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body) },
      (seconds) => setCamStatus(`İşleme planı oluşturuluyor… (${seconds}s)`, true),
    );
    if (result.error || !result.body?.plan) { setCamStatus(result.error ?? "Plan oluşturulamadı.", false); return; }
    const plan = result.body.plan;
    camPlan = plan;
    setCamStatus("", false);
    renderCamPlanTable(plan);
    camPlanView.hidden = false;
    camReviseBox.hidden = true;
    camReviseInput.value = "";
    camPreviewToken = null;
    camEstimatedMinutes = null;
    gcodeOutput.hidden = true;
    camSafetySummary.hidden = true;
    camQuote.hidden = true;
    camQuoteForm.hidden = true;
    camQuoteResult.hidden = true;
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
  finally { camPlanBtn.disabled = false; }
}

async function handleCamPlan() { await requestCamPlan(null); }

async function handleCamGenerate() {
  if (!camPlan) return;
  camGenerateBtn.disabled = true;
  camReviseBtn.disabled = true;
  gcodeOutput.hidden = true;
  camPreviewToken = null;
  setCamStatus("G-code üretiliyor…", true);
  try {
    const simResult = await runAsyncJob(
      `${API_BASE}/cam-simulate`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath, answers: camAnswers, plan: camPlan, prompt }) },
      (seconds) => {
        const phase = seconds < 15 ? "Kod üretiliyor" : seconds < 60 ? "TopkapıAI hesaplıyor" : "İşlem devam ediyor";
        setCamStatus(`${phase}… (${seconds}s)`, true);
      },
    );
    if (simResult.error || !simResult.ok || !simResult.body?.token) {
      setCamStatus(simResult.error ?? simResult.body?.error ?? "G-code üretilemedi.", false);
      return;
    }
    camPreviewToken = simResult.body.token;
    camEstimatedMinutes = simResult.body.estimatedMinutes ?? null;

    setCamStatus("G-code dosyası hazırlanıyor…", true);
    const confirmResult = await runAsyncJob(
      `${API_BASE}/cam-confirm`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath, answers: camAnswers, plan: camPlan, prompt, token: camPreviewToken }) },
      (seconds) => setCamStatus(`G-code dosyası hazırlanıyor… (${seconds}s)`, true),
    );
    if (confirmResult.error || !confirmResult.ok || !confirmResult.body?.gcodeUrl) {
      setCamStatus(confirmResult.error ?? confirmResult.body?.error ?? "G-code üretilemedi.", false);
      return;
    }

    const gcodeUrl = confirmResult.body.gcodeUrl;
    setCamStatus("G-code hazır.", false);
    renderSafetyChecks(confirmResult.body.safetyChecks);

    gcodeLink.href = gcodeUrl;

    let gcodeText = "";
    try {
      const resp = await fetch(gcodeUrl);
      gcodeText = await resp.text();
    } catch { /* download link still works */ }

    if (gcodeText) {
      const lines = gcodeText.split("\n");
      const maxPreview = 200;
      const shown = lines.slice(0, maxPreview);
      gcodePreview.innerHTML = shown.map((line, i) =>
        `<div class="cam-gcode-line"><span class="cam-gcode-linenum">${i + 1}</span>${escapeHtml(line)}</div>`
      ).join("");
      if (lines.length > maxPreview) {
        gcodePreview.innerHTML += `<div class="cam-gcode-line cam-gcode-more">… toplam ${lines.length} satır (ilk ${maxPreview} gösterildi)</div>`;
      }
    }

    cncSimBtn.onclick = () => {
      const stockData = {
        gcode: gcodeText,
        machineType: camAnswers.machineType || "freze",
        material: camAnswers.material || "",
      };
      if (bbox) { stockData.bbox = bbox; }
      if (camAnswers.stockWidth) stockData.stockWidth = Number(camAnswers.stockWidth);
      if (camAnswers.stockLength) stockData.stockLength = Number(camAnswers.stockLength);
      if (camAnswers.stockHeight) stockData.stockHeight = Number(camAnswers.stockHeight);
      if (camAnswers.stockDiameter) stockData.stockDiameter = Number(camAnswers.stockDiameter);
      sessionStorage.setItem("rover_cnc_gcode", JSON.stringify(stockData));
      window.open("cnc-sim.html", "_blank");
    };

    gcodeOutput.hidden = false;

    if (camEstimatedMinutes != null) {
      camQuoteTime.textContent = `Tahmini işleme süresi: ${camEstimatedMinutes} dk`;
      camQuote.hidden = false;
      camQuoteForm.hidden = true;
      camQuoteResult.hidden = true;
    }
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
  finally { camGenerateBtn.disabled = false; camReviseBtn.disabled = false; }
}

function setQuoteMode(mode) {
  quoteFieldsBasit.hidden = mode === "detayli";
  quoteFieldsDetayli.hidden = mode !== "detayli";
}

function currentQuoteMode() {
  const checked = camQuoteForm.querySelector('input[name="quote-mode"]:checked');
  return checked ? checked.value : "basit";
}

function numVal(id) {
  const el = byId(id);
  if (!el) return undefined;
  const v = el.value.trim();
  return v === "" ? undefined : Number(v);
}

function collectQuoteInputs(mode) {
  if (mode === "detayli") {
    return {
      materialPrice: numVal("q-materialPrice-d"), materialPriceUnit: byId("q-materialUnit-d").value,
      amortHourly: numVal("q-amortHourly"), energyPrice: numVal("q-energyPrice"), powerKw: numVal("q-powerKw"),
      toolCost: numVal("q-toolCost"), toolLifeParts: numVal("q-toolLifeParts"),
      consumableHourly: numVal("q-consumableHourly"), consumablePerPart: numVal("q-consumablePerPart"),
      overheadPct: numVal("q-overheadPct"), scrapPct: numVal("q-scrapPct"), profitPct: numVal("q-profitPct-d"),
    };
  }
  return {
    hourlyRate: numVal("q-hourlyRate"), materialPrice: numVal("q-materialPrice-b"),
    materialPriceUnit: byId("q-materialUnit-b").value, profitPct: numVal("q-profitPct-b"),
  };
}

function renderQuoteBreakdown(quote) {
  const lines = [`Tahmini süre: ${quote.minutes} dk`, ""];
  const pad = (s, n) => String(s).padEnd(n);
  for (const it of quote.items) lines.push(`${pad(it.label, 34)} ${Number(it.amount).toLocaleString("tr-TR")} TL`);
  lines.push("", `${pad("TOPLAM", 34)} ${Number(quote.total).toLocaleString("tr-TR")} TL`);
  return lines.join("\n");
}

async function handleQuoteSubmit() {
  if (camEstimatedMinutes == null) { setCamStatus("Önce G-code üretin.", false); return; }
  const mode = currentQuoteMode();
  camQuoteSubmit.disabled = true;
  setCamStatus("Teklif hesaplanıyor…", true);
  try {
    const response = await fetch(`${API_BASE}/cam-quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ mode, minutes: camEstimatedMinutes, answers: camAnswers, bbox, material: camAnswers.material, partName: prompt || "Parca", inputs: collectQuoteInputs(mode) }),
    });
    const data = await readJson(response);
    if (!response.ok || !data?.quote) { setCamStatus(data?.error ?? "Teklif oluşturulamadı.", false); return; }
    setCamStatus("", false);
    camQuoteBreakdown.textContent = renderQuoteBreakdown(data.quote);
    if (data.pdfUrl) { camQuotePdf.href = data.pdfUrl; camQuotePdf.hidden = false; } else { camQuotePdf.hidden = true; }
    camQuoteResult.hidden = false;
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
  finally { camQuoteSubmit.disabled = false; }
}

camNextBtn.addEventListener("click", handleCamNext);
camBackBtn.addEventListener("click", handleCamBack);
camPlanBtn.addEventListener("click", handleCamPlan);
camGenerateBtn.addEventListener("click", handleCamGenerate);

camReviseBtn.addEventListener("click", () => { camReviseBox.hidden = !camReviseBox.hidden; });
camReviseSubmit.addEventListener("click", () => { const change = camReviseInput.value.trim(); if (change) requestCamPlan(change); });

camQuoteBtn.addEventListener("click", () => {
  camQuoteForm.hidden = false;
  camQuoteResult.hidden = true;
  setQuoteMode(currentQuoteMode());
});
camQuoteForm.querySelectorAll('input[name="quote-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => setQuoteMode(radio.value));
});
camQuoteSubmit.addEventListener("click", handleQuoteSubmit);

async function init() {
  camStepIndex = 0;
  await loadCamStep(0);
}

init();
