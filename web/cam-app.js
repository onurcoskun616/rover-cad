const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const authHeaders = () => ({ Authorization: `Bearer ${sessionToken}` });

const byId = (id) => document.getElementById(id);
const viewerContainer = byId("viewer-container");
const errorSection = byId("error-section");
const errorText = byId("error-text");
const camStatus = byId("cam-status");
const camSpinner = byId("cam-spinner");
const camStatusText = byId("cam-status-text");
const gcodeLink = byId("gcode-link");
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
const camPlanText = byId("cam-plan-text");
const camPreviewBtn = byId("cam-preview-btn");
const camPreviewView = byId("cam-preview-view");
const camSimOp = byId("cam-sim-op");
const camSimProgress = byId("cam-sim-progress");
const camSimPlay = byId("cam-sim-play");
const camSimSpeedBtns = { 1: byId("cam-sim-1x"), 2: byId("cam-sim-2x"), 5: byId("cam-sim-5x") };
const camConfirmBtn = byId("cam-confirm-btn");
const camRejectBtn = byId("cam-reject-btn");
const camReviseBtn = byId("cam-revise-btn");
const camReviseBox = byId("cam-revise-box");
const camReviseInput = byId("cam-revise-input");
const camReviseSubmit = byId("cam-revise-submit");
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
const simWorkspace = byId("sim-workspace");
const coordDisplay = byId("coord-display");
const coordX = byId("coord-x");
const coordY = byId("coord-y");
const coordZ = byId("coord-z");
const coordF = byId("coord-f");
const gcodePanel = byId("gcode-panel");
const gcodeLinesEl = byId("gcode-lines");

let viewer = null;
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
let camSim = null;
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

function resetSimLayout() {
  if (simWorkspace) simWorkspace.classList.remove("sim-active");
  if (gcodePanel) gcodePanel.hidden = true;
  if (coordDisplay) coordDisplay.hidden = true;
}

function setSimSpeed(mult) {
  if (camSim) camSim.setSpeed(mult);
  Object.entries(camSimSpeedBtns).forEach(([m, btn]) => {
    btn.classList.toggle("active", Number(m) === mult);
  });
}

async function loadModelPreview() {
  if (!stlUrl && !contourUrl) return;
  try {
    const { initViewer } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);
    if (stlUrl) {
      const { loadStl } = await import("./viewer.js");
      loadStl(viewer, stlUrl);
    } else if (contourUrl) {
      const response = await fetch(contourUrl);
      const data = await readJson(response);
      const { loadToolpath } = await import("./viewer.js");
      loadToolpath(viewer, data ?? { toolpaths: [] });
    }
  } catch (err) {
    console.error("3D önizleme yüklenemedi:", err);
  }
}

async function setupSimulation(simulationUrl) {
  const response = await fetch(simulationUrl);
  const data = await readJson(response);
  const { initViewer, loadSimulation } = await import("./viewer.js");
  if (!viewer) viewer = initViewer(viewerContainer);

  let lastLineIdx = -1;
  let gcodeLineEls = [];

  camSim = loadSimulation(viewer, data ?? { toolpaths: [] }, {
    onUpdate: ({ progress, op, x, y, z, f, lineIndex }) => {
      camSimProgress.value = String(Math.round(progress * 1000));
      camSimOp.textContent = `Operasyon: ${op || "—"}`;
      if (camSim && !camSim.isPlaying()) camSimPlay.textContent = "▶ Oynat";
      if (progress >= 1) camSimPlay.textContent = "▶ Tekrar Oynat";
      if (coordX) {
        coordX.textContent = x != null ? x.toFixed(3) : "0.000";
        coordY.textContent = y != null ? y.toFixed(3) : "0.000";
        coordZ.textContent = z != null ? z.toFixed(3) : "0.000";
        coordF.textContent = f != null ? String(Math.round(f)) : "0";
      }
      const cncX = byId("cnc-cam-x");
      const cncY = byId("cnc-cam-y");
      const cncZ = byId("cnc-cam-z");
      if (cncX) {
        cncX.textContent = x != null ? x.toFixed(3) : "0.000";
        cncY.textContent = y != null ? y.toFixed(3) : "0.000";
        cncZ.textContent = z != null ? z.toFixed(3) : "0.000";
      }
      if (lineIndex !== lastLineIdx && gcodeLineEls.length > 0) {
        if (lastLineIdx >= 0 && lastLineIdx < gcodeLineEls.length) gcodeLineEls[lastLineIdx].classList.remove("active");
        if (lineIndex >= 0 && lineIndex < gcodeLineEls.length) {
          gcodeLineEls[lineIndex].classList.add("active");
          const el = gcodeLineEls[lineIndex];
          const panel = gcodeLinesEl;
          if (panel) { const elTop = el.offsetTop - panel.offsetTop; panel.scrollTop = elTop - panel.clientHeight / 2 + el.clientHeight / 2; }
        }
        lastLineIdx = lineIndex;
      }
    },
  });

  if (camSim.gcodeLines && gcodeLinesEl) {
    gcodeLinesEl.innerHTML = "";
    gcodeLineEls = camSim.gcodeLines.map((text, i) => {
      const div = document.createElement("div");
      div.className = "gcode-line";
      div.innerHTML = `<span class="line-num">${i + 1}</span>${escapeHtml(text)}`;
      gcodeLinesEl.appendChild(div);
      return div;
    });
  }

  if (simWorkspace) simWorkspace.classList.add("sim-active");
  if (gcodePanel) gcodePanel.hidden = false;
  if (coordDisplay) coordDisplay.hidden = false;
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));

  camSimProgress.value = "0";
  camSimPlay.textContent = "▶ Oynat";
  setSimSpeed(1);
  const cncStatus = byId("cnc-cam-status");
  if (cncStatus) { cncStatus.textContent = "Hazır"; cncStatus.style.color = "#3ddc84"; }
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
    camPlanText.textContent = plan.planText || JSON.stringify(plan, null, 2);
    camPlanView.hidden = false;
    camReviseBox.hidden = true;
    camReviseInput.value = "";
    if (camSim) camSim.pause();
    camSim = null;
    camPreviewView.hidden = true;
    camPreviewToken = null;
    camEstimatedMinutes = null;
    camQuote.hidden = true;
    camQuoteForm.hidden = true;
    camQuoteResult.hidden = true;
    gcodeLink.hidden = true;
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
  finally { camPlanBtn.disabled = false; }
}

async function handleCamPlan() { await requestCamPlan(null); }

async function handleCamPreview() {
  if (!camPlan) return;
  camPreviewBtn.disabled = true;
  camReviseBtn.disabled = true;
  camPreviewView.hidden = true;
  camPreviewToken = null;
  gcodeLink.hidden = true;
  setCamStatus("Takım yolu simülasyonu hesaplanıyor…", true);
  try {
    const result = await runAsyncJob(
      `${API_BASE}/cam-simulate`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath, answers: camAnswers, plan: camPlan, prompt }) },
      (seconds) => {
        const phase = seconds < 15 ? "Kod üretiliyor" : seconds < 60 ? "TopkapiAl hesaplıyor" : "İşlem devam ediyor";
        setCamStatus(`${phase}… (${seconds}s)`, true);
      },
    );
    if (result.error || !result.ok || !result.body?.simulationUrl) {
      setCamStatus(result.error ?? result.body?.error ?? "Simülasyon üretilemedi.", false);
      return;
    }
    camPreviewToken = result.body.token ?? null;
    camEstimatedMinutes = result.body.estimatedMinutes ?? null;
    await setupSimulation(result.body.simulationUrl);
    setCamStatus("", false);
    camPreviewView.hidden = false;
    if (camEstimatedMinutes != null) {
      camQuoteTime.textContent = `Tahmini işleme süresi: ${camEstimatedMinutes} dk`;
      camQuote.hidden = false;
      camQuoteForm.hidden = true;
      camQuoteResult.hidden = true;
    }
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
  finally { camPreviewBtn.disabled = false; camReviseBtn.disabled = false; }
}

function handleCamReject() {
  if (camSim) camSim.pause();
  camPreviewView.hidden = true;
  camPreviewToken = null;
  resetSimLayout();
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  setCamStatus("Takım yolu reddedildi. Planı değiştirip tekrar simüle edin.", false);
}

async function handleCamConfirm() {
  if (!camPlan || !camPreviewToken) return;
  camConfirmBtn.disabled = true;
  camRejectBtn.disabled = true;
  setCamStatus("Takım yolu onaylandı, G-code üretiliyor…", true);
  try {
    const result = await runAsyncJob(
      `${API_BASE}/cam-confirm`,
      { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ stepPath, answers: camAnswers, plan: camPlan, prompt, token: camPreviewToken }) },
      (seconds) => setCamStatus(`G-code üretiliyor… (${seconds} sn)`, true),
    );
    if (result.error || !result.ok || !result.body?.gcodeUrl) {
      setCamStatus(result.error ?? result.body?.error ?? "G-code üretilemedi.", false);
      return;
    }
    setCamStatus("G-code hazır.", false);
    gcodeLink.href = result.body.gcodeUrl;
    gcodeLink.hidden = false;

    const cncSimBtn = byId("cnc-sim-btn");
    if (cncSimBtn) {
      cncSimBtn.hidden = false;
      cncSimBtn.onclick = async () => {
        try {
          const resp = await fetch(result.body.gcodeUrl);
          const gcode = await resp.text();
          sessionStorage.setItem("rover_cnc_gcode", JSON.stringify({ gcode, machineType: camAnswers.machineType || "freze" }));
          window.open("cnc-sim.html", "_blank");
        } catch { window.open("cnc-sim.html", "_blank"); }
      };
    }
  } catch (err) { setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false); }
  finally { camConfirmBtn.disabled = false; camRejectBtn.disabled = false; }
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
  if (camEstimatedMinutes == null) { setCamStatus("Önce takım yolu önizlemesi oluşturun.", false); return; }
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
camPreviewBtn.addEventListener("click", handleCamPreview);
camConfirmBtn.addEventListener("click", handleCamConfirm);
camRejectBtn.addEventListener("click", handleCamReject);

camSimPlay.addEventListener("click", () => {
  if (!camSim) return;
  const cncStatus = byId("cnc-cam-status");
  if (camSim.isPlaying()) {
    camSim.pause();
    camSimPlay.textContent = "▶ Oynat";
    if (cncStatus) { cncStatus.textContent = "Duraklatıldı"; cncStatus.style.color = "#f0c040"; }
  } else {
    camSim.play();
    camSimPlay.textContent = "⏸ Duraklat";
    if (cncStatus) { cncStatus.textContent = "Çalışıyor"; cncStatus.style.color = "#3ddc84"; }
  }
});

camSimProgress.addEventListener("input", () => {
  if (!camSim) return;
  camSim.pause();
  camSimPlay.textContent = "▶ Oynat";
  camSim.seek(Number(camSimProgress.value) / 1000);
});

Object.entries(camSimSpeedBtns).forEach(([m, btn]) => {
  btn.addEventListener("click", () => setSimSpeed(Number(m)));
});

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
  await loadModelPreview();
  camStepIndex = 0;
  await loadCamStep(0);
}

init();
