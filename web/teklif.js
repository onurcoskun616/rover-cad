const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const authHeaders = () => ({ Authorization: `Bearer ${sessionToken}` });

const byId = (id) => document.getElementById(id);
const errorSection = byId("error-section");
const errorText = byId("error-text");
const uploadSection = byId("tq-upload-section");
const fileInput = byId("tq-file-input");
const fileLabel = byId("tq-file-label");
const uploadBtn = byId("tq-upload-btn");
const tqStatus = byId("tq-status");
const tqSpinner = byId("tq-spinner");
const tqStatusText = byId("tq-status-text");
const tqDfm = byId("tq-dfm");
const tqDfmScore = byId("tq-dfm-score");
const tqDfmList = byId("tq-dfm-list");
const tqWizard = byId("tq-wizard");
const tqStepProgress = byId("tq-step-progress");
const tqStepTitle = byId("tq-step-title");
const tqStepIntro = byId("tq-step-intro");
const tqStepFields = byId("tq-step-fields");
const tqBackBtn = byId("tq-back-btn");
const tqNextBtn = byId("tq-next-btn");
const tqPlanView = byId("tq-plan-view");
const tqPlanSummary = byId("tq-plan-summary");
const tqPlanNotes = byId("tq-plan-notes");
const tqQuoteBtn = byId("tq-quote-btn");
const tqQuoteResult = byId("tq-quote-result");
const tqQuoteBreakdown = byId("tq-quote-breakdown");
const tqQuotePdf = byId("tq-quote-pdf");
const tqRestartBtn = byId("tq-restart-btn");

let stepPath = null;
let bbox = null;
let tqAnswers = {};
let tqStepIndex = 0;
let tqPlan = null;
let tqEstimatedMinutes = null;

async function readJson(response) {
  try { return await response.json(); } catch { return null; }
}

const POLL_INTERVAL_MS = 1500;
// Same worst-case ceiling as cam-app.js's own wizard: a real FreeCAD import +
// an LLM-drafted plan + a real FreeCAD toolpath simulation can legitimately
// take several minutes for a complex part, and the whole point of this page
// is that its price is backed by that real verification, not a guess.
const POLL_TIMEOUT_MS = 35 * 60 * 1000;
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

function setStatus(message, busy) {
  tqStatus.hidden = !message;
  tqSpinner.hidden = !busy;
  tqStatusText.textContent = message ?? "";
}

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  fileLabel.textContent = file ? file.name : "Bir dosya seçin veya buraya sürükleyin";
  uploadBtn.disabled = !file;
});

async function handleUpload() {
  const file = fileInput.files?.[0];
  if (!file) return;
  clearError();
  uploadBtn.disabled = true;
  setStatus("Dosya yükleniyor ve CAD motoruna aktarılıyor…", true);
  try {
    const form = new FormData();
    form.append("file", file);
    const result = await runAsyncJob(
      `${API_BASE}/upload-step`,
      { method: "POST", headers: authHeaders(), body: form },
      (seconds) => setStatus(`Dosya yükleniyor ve CAD motoruna aktarılıyor… (${seconds} sn)`, true),
    );
    if (result.error || !result.ok) {
      setStatus("", false);
      showError(result.error ?? result.body?.error ?? "Dosya yüklenemedi.");
      uploadBtn.disabled = false;
      return;
    }
    stepPath = result.body.stepPath;
    bbox = result.body.bbox ?? null;
    uploadSection.hidden = true;
    setStatus("", false);
    await runDfmAnalysis();
    tqStepIndex = 0;
    await loadStep(0);
  } catch (err) {
    setStatus("", false);
    showError(`Sunucuya bağlanılamadı: ${err.message}`);
    uploadBtn.disabled = false;
  }
}

// Runs right after upload, before the wizard -- shows the operator a
// manufacturability read on the part before they spend time answering
// wizard questions. Deliberately never blocks the flow: if the analysis
// itself errors out (unsupported geometry, a transient FreeCAD hiccup),
// the DFM card just stays hidden and the wizard proceeds anyway -- this
// page's core promise is a price, not a DFM report.
async function runDfmAnalysis() {
  setStatus("Üretilebilirlik analizi yapılıyor…", true);
  try {
    const result = await runAsyncJob(
      `${API_BASE}/dfm-analyze`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath }) },
      (seconds) => setStatus(`Üretilebilirlik analizi yapılıyor… (${seconds}s)`, true),
    );
    setStatus("", false);
    if (result.error || !result.ok || !result.body?.dfm) return;
    renderDfmResult(result.body.dfm);
  } catch {
    setStatus("", false);
  }
}

function renderDfmResult(dfm) {
  const status = dfm.score === 100 ? "Üretime Hazır" : "Gözden Geçirin";
  tqDfmScore.textContent = `Üretilebilirlik Skoru: ${dfm.score}/100 — ${status}`;
  tqDfmList.innerHTML = (dfm.checks || []).map((c) =>
    `<li class="${c.ok ? "cam-safety-ok" : "cam-safety-fail"}">${c.ok ? "✓" : "✕"} ${c.label}: ${c.detail}</li>`
  ).join("");
  tqDfm.hidden = false;
}

async function loadStep(targetIndex) {
  setStatus("Adım hazırlanıyor…", true);
  try {
    const response = await fetch(`${API_BASE}/cam-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ stepPath, prompt: "", answers: tqAnswers, targetIndex }),
    });
    const data = await readJson(response);
    if (!response.ok || !data) { setStatus("", false); showError(data?.error ?? "Adım alınamadı."); return; }
    setStatus("", false);
    if (data.done) { tqWizard.hidden = true; tqPlanView.hidden = false; tqPlanSummary.textContent = ""; tqPlanNotes.textContent = ""; return; }
    renderStep(data);
    tqWizard.hidden = false;
  } catch (err) { setStatus("", false); showError(`Sunucuya bağlanılamadı: ${err.message}`); }
}

function renderStep(data) {
  const step = data.step;
  tqStepIndex = data.index;
  tqStepProgress.textContent = `Adım ${data.index + 1} / ${data.total}`;
  tqStepTitle.textContent = step.title;
  if (step.intro) { tqStepIntro.textContent = step.intro; tqStepIntro.hidden = false; } else { tqStepIntro.hidden = true; }
  tqStepFields.innerHTML = "";
  step.fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "cam-field";
    const inputId = `tqf-${f.name}`;
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
    tqStepFields.appendChild(wrap);
  });
  tqBackBtn.hidden = tqStepIndex === 0;
  tqNextBtn.textContent = data.index + 1 >= data.total ? "Tamam" : "İleri";
}

function collectCurrentStep() {
  tqStepFields.querySelectorAll("input, select").forEach((el) => {
    let value = el.value;
    if (el.dataset.type === "number") { const n = Number(value); if (Number.isFinite(n)) value = n; }
    tqAnswers[el.name] = value;
  });
}

async function handleNext() { collectCurrentStep(); await loadStep(tqStepIndex + 1); }
async function handleBack() { collectCurrentStep(); if (tqStepIndex === 0) return; await loadStep(tqStepIndex - 1); }

// One button chains plan -> simulate -> quote, so the visitor sees a single
// "get my price" action instead of cam.html's separate plan/generate/quote
// steps -- this page only needs a price, never the G-code itself.
async function handleQuote() {
  tqQuoteBtn.disabled = true;
  clearError();
  try {
    setStatus("İşleme planı hazırlanıyor…", true);
    const planResult = await runAsyncJob(
      `${API_BASE}/cam-plan`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath, answers: tqAnswers, prompt: "" }) },
      (seconds) => setStatus(`İşleme planı hazırlanıyor… (${seconds}s)`, true),
    );
    if (planResult.error || !planResult.body?.plan) { setStatus("", false); showError(planResult.error ?? "Plan oluşturulamadı."); return; }
    tqPlan = planResult.body.plan;

    setStatus("İşleme süresi hesaplanıyor…", true);
    const simResult = await runAsyncJob(
      `${API_BASE}/cam-simulate`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath, answers: tqAnswers, plan: tqPlan, prompt: "" }) },
      (seconds) => setStatus(`İşleme süresi hesaplanıyor… (${seconds}s)`, true),
    );
    if (simResult.error || !simResult.ok) { setStatus("", false); showError(simResult.error ?? simResult.body?.error ?? "Süre hesaplanamadı."); return; }
    tqEstimatedMinutes = simResult.body.estimatedMinutes ?? null;
    if (tqEstimatedMinutes == null) { setStatus("", false); showError("İşleme süresi hesaplanamadı."); return; }

    setStatus("Fiyat hesaplanıyor…", true);
    const quoteResponse = await fetch(`${API_BASE}/cam-quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        mode: "basit",
        minutes: tqEstimatedMinutes,
        answers: tqAnswers,
        bbox,
        material: tqAnswers.material,
        partName: "Anında Teklif",
        useCatalogDefaults: true,
        quantity: Math.max(1, Math.round(Number(byId("tq-quantity").value) || 1)),
      }),
    });
    const quoteData = await readJson(quoteResponse);
    if (!quoteResponse.ok || !quoteData?.quote) { setStatus("", false); showError(quoteData?.error ?? "Teklif oluşturulamadı."); return; }

    setStatus("", false);
    tqPlanSummary.textContent = tqPlan.summary || "";
    tqPlanNotes.textContent = tqPlan.notes ? `Notlar: ${tqPlan.notes}` : "";
    tqPlanView.hidden = true;
    renderQuoteResult(quoteData.quote, quoteData.pdfUrl);
  } catch (err) {
    setStatus("", false);
    showError(`Sunucuya bağlanılamadı: ${err.message}`);
  } finally {
    tqQuoteBtn.disabled = false;
  }
}

function renderQuoteResult(quote, pdfUrl) {
  const lines = [`Tahmini işleme süresi (birim): ${quote.minutes} dk`, `Adet: ${quote.quantity}`, ""];
  const pad = (s, n) => String(s).padEnd(n);
  for (const it of quote.items) lines.push(`${pad(it.label, 34)} ${Number(it.amount).toLocaleString("tr-TR")} TL`);
  lines.push("", `${pad("Birim Fiyat", 34)} ${Number(quote.unitPrice).toLocaleString("tr-TR")} TL`);
  if (quote.quantity > 1) {
    lines.push(`${pad(`TOPLAM (${quote.quantity} adet)`, 34)} ${Number(quote.total).toLocaleString("tr-TR")} TL`);
  } else {
    lines.push(`${pad("TOPLAM", 34)} ${Number(quote.total).toLocaleString("tr-TR")} TL`);
  }
  tqQuoteBreakdown.textContent = lines.join("\n");
  if (pdfUrl) { tqQuotePdf.href = pdfUrl; tqQuotePdf.hidden = false; } else { tqQuotePdf.hidden = true; }
  tqQuoteResult.hidden = false;
}

uploadBtn.addEventListener("click", handleUpload);
tqNextBtn.addEventListener("click", handleNext);
tqBackBtn.addEventListener("click", handleBack);
tqQuoteBtn.addEventListener("click", handleQuote);
tqRestartBtn.addEventListener("click", () => window.location.reload());
