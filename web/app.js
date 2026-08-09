const API_BASE = "https://api.topkapikoleji.org";
// NOTE: shipped in a public static site, so this is not a real secret -- it
// only keeps casual/automated traffic off the endpoint, not a determined
// attacker (anyone can read it via view-source). Must match API_KEY in the
// backend's .env.
const API_KEY = "1d48ec585a4b306db72a23be0b7ce8f56618c1275a3ea5efcee96df1106712f1";

const tabText = document.getElementById("tab-text");
const tabImage = document.getElementById("tab-image");
const tabStep = document.getElementById("tab-step");
const panelText = document.getElementById("panel-text");
const panelImage = document.getElementById("panel-image");
const panelStep = document.getElementById("panel-step");
const stepInput = document.getElementById("step-input");
const stepLabel = document.getElementById("step-label");
const dxfThicknessField = document.getElementById("dxf-thickness-field");
const dxfThickness = document.getElementById("dxf-thickness");
const promptInput = document.getElementById("prompt-input");
const imageInput = document.getElementById("image-input");
const imageLabel = document.getElementById("image-label");
const imagePromptInput = document.getElementById("image-prompt-input");
const generateBtn = document.getElementById("generate-btn");
const statusSection = document.getElementById("status-section");
const spinner = document.getElementById("spinner");
const statusText = document.getElementById("status-text");
const errorSection = document.getElementById("error-section");
const errorText = document.getElementById("error-text");
const resultSection = document.getElementById("result-section");
const warningText = document.getElementById("warning-text");
const stepLink = document.getElementById("step-link");
const stlLink = document.getElementById("stl-link");
const pdfLink = document.getElementById("pdf-link");
const pdfBtn = document.getElementById("pdf-btn");
const reviseSection = document.getElementById("revise-section");
const reviseInput = document.getElementById("revise-input");
const reviseBtn = document.getElementById("revise-btn");
const viewerContainer = document.getElementById("viewer-container");
const generatedCodeEl = document.getElementById("generated-code");
const camSection = document.getElementById("cam-section");
const camBtn = document.getElementById("cam-btn");
const camStatus = document.getElementById("cam-status");
const camSpinner = document.getElementById("cam-spinner");
const camStatusText = document.getElementById("cam-status-text");
const gcodeLink = document.getElementById("gcode-link");
const camAssistant = document.getElementById("cam-assistant");
const camWizard = document.getElementById("cam-wizard");
const camStepProgress = document.getElementById("cam-step-progress");
const camStepTitle = document.getElementById("cam-step-title");
const camStepIntro = document.getElementById("cam-step-intro");
const camStepFields = document.getElementById("cam-step-fields");
const camBackBtn = document.getElementById("cam-back-btn");
const camNextBtn = document.getElementById("cam-next-btn");
const camPlanBtn = document.getElementById("cam-plan-btn");
const camPlanView = document.getElementById("cam-plan-view");
const camPlanText = document.getElementById("cam-plan-text");
const camPreviewBtn = document.getElementById("cam-preview-btn");
const camPreviewView = document.getElementById("cam-preview-view");
const camSimOp = document.getElementById("cam-sim-op");
const camSimProgress = document.getElementById("cam-sim-progress");
const camSimPlay = document.getElementById("cam-sim-play");
const camSimSpeedBtns = {
  1: document.getElementById("cam-sim-1x"),
  2: document.getElementById("cam-sim-2x"),
  5: document.getElementById("cam-sim-5x"),
};
const camConfirmBtn = document.getElementById("cam-confirm-btn");
const camRejectBtn = document.getElementById("cam-reject-btn");
const camReviseBtn = document.getElementById("cam-revise-btn");
const camReviseBox = document.getElementById("cam-revise-box");
const camReviseInput = document.getElementById("cam-revise-input");
const camReviseSubmit = document.getElementById("cam-revise-submit");
const camQuote = document.getElementById("cam-quote");
const camQuoteTime = document.getElementById("cam-quote-time");
const camQuoteBtn = document.getElementById("cam-quote-btn");
const camQuoteForm = document.getElementById("cam-quote-form");
const quoteFieldsBasit = document.getElementById("quote-fields-basit");
const quoteFieldsDetayli = document.getElementById("quote-fields-detayli");
const camQuoteSubmit = document.getElementById("cam-quote-submit");
const camQuoteResult = document.getElementById("cam-quote-result");
const camQuoteBreakdown = document.getElementById("cam-quote-breakdown");
const camQuotePdf = document.getElementById("cam-quote-pdf");
const simWorkspace = document.getElementById("sim-workspace");
const coordDisplay = document.getElementById("coord-display");
const coordX = document.getElementById("coord-x");
const coordY = document.getElementById("coord-y");
const coordZ = document.getElementById("coord-z");
const coordF = document.getElementById("coord-f");
const gcodePanel = document.getElementById("gcode-panel");
const gcodeLinesEl = document.getElementById("gcode-lines");
const tabSim = document.getElementById("tab-sim");
const panelSim = document.getElementById("panel-sim");
const simDemoBtn = document.getElementById("sim-demo-btn");
const kinSimView = document.getElementById("kin-sim-view");
const kinSimStatus = document.getElementById("kin-sim-status");
const kinSimProgress = document.getElementById("kin-sim-progress");
const kinSimPlay = document.getElementById("kin-sim-play");
const kinSimSpeedBtns = {
  1: document.getElementById("kin-sim-1x"),
  2: document.getElementById("kin-sim-2x"),
  5: document.getElementById("kin-sim-5x"),
};
const kinCollisionAlert = document.getElementById("kin-collision-alert");

let viewer = null;
let mode = "text"; // "text" | "image" | "step"
let lastStepPath = null;
let lastGeneratedCode = null;
let lastBbox = null;
let lastPrompt = "";
let camAnswers = {};
let camStepIndex = 0;
let camStepFieldNames = [];
let camPreviewToken = null;
let camEstimatedMinutes = null;
let camSim = null; // active simulation controller
let camPlan = null;
let lastDimData = null;
let dimEditInProgress = false;
let dimEditQueue = [];
let kinSim = null;

function setMode(next) {
  mode = next;
  const tabs = [
    [tabText, panelText, "text"],
    [tabImage, panelImage, "image"],
    [tabStep, panelStep, "step"],
    [tabSim, panelSim, "sim"],
  ];
  for (const [tab, panel, name] of tabs) {
    const active = name === next;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
  }
  if (next === "sim") {
    generateBtn.hidden = true;
  } else {
    generateBtn.hidden = false;
    generateBtn.textContent = next === "step" ? "Yükle ve Önizle" : "Oluştur";
  }
}

tabText.addEventListener("click", () => setMode("text"));
tabImage.addEventListener("click", () => setMode("image"));
tabStep.addEventListener("click", () => setMode("step"));
tabSim.addEventListener("click", () => setMode("sim"));

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  imageLabel.textContent = file ? file.name : "Bir teknik resim seçin (PNG, JPG…)";
});

stepInput.addEventListener("change", () => {
  const file = stepInput.files?.[0];
  stepLabel.textContent = file
    ? file.name
    : "Bir dosya seçin (.step, .stp, .iges, .igs, .dxf)";
  const isDxf = !!file && /\.dxf$/i.test(file.name);
  dxfThicknessField.hidden = !isDxf;
});

function setLoading(isLoading, message) {
  statusSection.hidden = !isLoading;
  spinner.hidden = !isLoading;
  statusText.textContent = message ?? "";
  generateBtn.disabled = isLoading;
}

function showError(message) {
  errorSection.hidden = false;
  errorText.textContent = message;
}

function clearError() {
  errorSection.hidden = true;
  errorText.textContent = "";
}

function resetResult() {
  resultSection.hidden = true;
  warningText.hidden = true;
  warningText.textContent = "";
  stepLink.hidden = true;
  stlLink.hidden = true;
  pdfLink.hidden = true;
  pdfBtn.hidden = true;
  reviseSection.hidden = true;
  reviseInput.value = "";
  lastGeneratedCode = null;
  lastBbox = null;
  lastPrompt = "";
  lastDimData = null;
  dimEditInProgress = false;
  dimEditQueue = [];
  generatedCodeEl.textContent = "";
  camSection.hidden = true;
  camStatus.hidden = true;
  gcodeLink.hidden = true;
  resetCamAssistant();
  resetKinSim();
  if (viewer) {
    import("./viewer.js").then(({ clearDimensions }) => clearDimensions(viewer)).catch(() => {});
  }
  lastStepPath = null;
}

function resetKinSim() {
  if (kinSim) kinSim.pause();
  kinSim = null;
  kinSimView.hidden = true;
  kinSimPlay.textContent = "Oynat";
  kinSimProgress.value = "0";
  kinSimStatus.textContent = "Durum: Hazir";
  kinCollisionAlert.hidden = true;
  Object.values(kinSimSpeedBtns).forEach((b) => b.classList.remove("active"));
  if (kinSimSpeedBtns[1]) kinSimSpeedBtns[1].classList.add("active");
}

function resetCamAssistant() {
  camAssistant.hidden = true;
  camWizard.hidden = true;
  camStepFields.innerHTML = "";
  camStepIntro.hidden = true;
  camBackBtn.hidden = true;
  camPlanBtn.hidden = true;
  camPlanView.hidden = true;
  camPlanText.textContent = "";
  camPreviewView.hidden = true;
  camReviseBox.hidden = true;
  camReviseInput.value = "";
  camQuote.hidden = true;
  camQuoteForm.hidden = true;
  camQuoteResult.hidden = true;
  camQuotePdf.hidden = true;
  camAnswers = {};
  camStepIndex = 0;
  camStepFieldNames = [];
  camPreviewToken = null;
  camEstimatedMinutes = null;
  if (camSim) camSim.pause();
  camSim = null;
  camPlan = null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 7 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST to an async route that returns { jobId }, then poll GET /jobs/:id with
 * short requests until it finishes. Each request stays well under Cloudflare's
 * 100s limit. Resolves to { ok, body } on success, or { error, body? } on any
 * HTTP/job failure.
 * @param {string} url
 * @param {RequestInit} options fetch options for the POST
 * @param {(seconds:number)=>void} [onTick] progress callback (elapsed seconds)
 */
async function runAsyncJob(url, options, onTick) {
  const startResp = await fetch(url, options);
  const startData = await readJson(startResp);
  if (!startResp.ok) {
    return {
      error: startData?.error ?? `Sunucu hatası (HTTP ${startResp.status})`,
      body: startData,
    };
  }
  const jobId = startData?.jobId;
  if (!jobId) {
    // Not an async route (or older backend): treat the response as the result.
    return { ok: true, body: startData };
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (onTick) onTick(Math.round((Date.now() - startedAt) / 1000));

    let statusResp;
    let statusData;
    try {
      statusResp = await fetch(`${API_BASE}/jobs/${jobId}`, {
        headers: { "x-api-key": API_KEY },
      });
      statusData = await readJson(statusResp);
    } catch {
      continue; // transient network blip; keep polling
    }

    if (statusResp.status === 404) {
      return { error: "İş bulunamadı veya zaman aşımına uğradı." };
    }
    if (!statusResp.ok || !statusData) {
      continue;
    }
    if (statusData.status === "pending") {
      if (onTick && statusData.elapsed != null) onTick(statusData.elapsed);
      continue;
    }
    if (statusData.status === "error") {
      return { error: statusData.error ?? "İşlem başarısız oldu." };
    }
    if (statusData.status === "done") {
      const { status, ok, ...body } = statusData;
      return { ok, body };
    }
  }
  return { error: "İşlem zaman aşımına uğradı." };
}

async function handleGenerate() {
  clearError();
  resetResult();

  let url;
  let options;
  let baseMessage;
  if (mode === "text") {
    const prompt = promptInput.value.trim();
    if (!prompt) {
      showError("Lütfen bir istek yazın.");
      return;
    }
    baseMessage = "3D model oluşturuluyor";
    lastPrompt = prompt;
    url = `${API_BASE}/generate`;
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ prompt }),
    };
  } else if (mode === "image") {
    const file = imageInput.files?.[0];
    if (!file) {
      showError("Lütfen bir teknik resim seçin.");
      return;
    }
    baseMessage = "Teknik resim yorumlanıp model oluşturuluyor";
    lastPrompt = imagePromptInput.value.trim();
    const form = new FormData();
    form.append("image", file);
    if (lastPrompt) {
      form.append("prompt", lastPrompt);
    }
    url = `${API_BASE}/generate-from-image`;
    options = { method: "POST", headers: { "x-api-key": API_KEY }, body: form };
  } else {
    // STEP/IGES/DXF upload: import in FreeCAD, preview, then jump into CAM.
    const file = stepInput.files?.[0];
    if (!file) {
      showError("Lütfen bir CAD dosyası seçin.");
      return;
    }
    baseMessage = "Dosya yükleniyor ve CAD motoruna aktarılıyor";
    lastPrompt = "";
    const form = new FormData();
    form.append("file", file);
    if (/\.dxf$/i.test(file.name)) {
      const thk = dxfThickness.value.trim();
      if (thk) form.append("thickness", thk);
      url = `${API_BASE}/upload-dxf`;
    } else {
      url = `${API_BASE}/upload-step`;
    }
    options = { method: "POST", headers: { "x-api-key": API_KEY }, body: form };
  }

  setLoading(true, `${baseMessage}, bu biraz zaman alabilir…`);
  try {
    const result = await runAsyncJob(url, options, (seconds) => {
      setLoading(true, `${baseMessage}… (${seconds} sn)`);
    });

    if (result.error) {
      showError(result.error);
      if (result.body?.generatedCode) {
        resultSection.hidden = false;
        generatedCodeEl.textContent = result.body.generatedCode;
      }
      return;
    }
    if (!result.ok) {
      const mainErr = result.body?.error ?? "Model oluşturulamadı.";
      const detail = result.body?.lastError;
      showError(detail ? `${mainErr}\n\nDetay: ${detail}` : mainErr);
      if (result.body?.generatedCode) {
        resultSection.hidden = false;
        generatedCodeEl.textContent = result.body.generatedCode;
      }
      return;
    }
    showResult(result.body);
  } catch (err) {
    showError(`Sunucuya bağlanılamadı: ${err.message}`);
  } finally {
    setLoading(false);
  }
}

function showResult(data) {
  resetSimLayout();
  resultSection.hidden = false;

  if (data.warning) {
    warningText.hidden = false;
    warningText.textContent = `Uyarı: ${data.warning}`;
  }
  if (data.stepUrl) {
    stepLink.href = data.stepUrl;
    stepLink.hidden = false;
  }
  if (data.stlUrl) {
    stlLink.href = data.stlUrl;
    stlLink.hidden = false;
    loadStlPreview(data.stlUrl);
  } else if (data.contourUrl) {
    // 2D DXF (no thickness): show the contour as lines instead of a solid.
    loadContourPreview(data.contourUrl);
  }
  if (data.generatedCode) {
    generatedCodeEl.textContent = data.generatedCode;
  }

  lastGeneratedCode = data.generatedCode ?? null;
  lastBbox = data.bbox ?? null;
  // The PDF is generated on demand to keep /generate fast. Reset any stale
  // PDF link so the user re-generates with the current dimensions.
  pdfLink.hidden = true;
  pdfBtn.hidden = false;
  pdfBtn.textContent = "Teknik Resim (PDF)";
  pdfBtn.disabled = false;
  // Allow iterative editing once we have code to revise.
  reviseSection.hidden = !lastGeneratedCode;

  lastStepPath = data.stepPath ?? null;
  // Offer CAM for any part with an exported STEP; every part goes through the
  // CAM assistant (questions -> plan -> confirm).
  if (lastStepPath) {
    camSection.hidden = false;
  }

  if (data.anchors && data.anchors.length) {
    showAnchors(data.anchors, data.center);
  }
}

async function handleRevise() {
  const instruction = reviseInput.value.trim();
  if (!instruction) return;
  if (!lastGeneratedCode) {
    showError("Önce bir model oluşturun.");
    return;
  }
  clearError();
  const previousCode = lastGeneratedCode;
  const base = lastPrompt;
  reviseBtn.disabled = true;
  setLoading(true, "Tasarım güncelleniyor, bu biraz zaman alabilir…");
  try {
    const result = await runAsyncJob(
      `${API_BASE}/revise`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ prompt: instruction, previousCode, basePrompt: base }),
      },
      (seconds) => setLoading(true, `Tasarım güncelleniyor… (${seconds} sn)`),
    );

    if (result.error || !result.ok) {
      showError(result.error ?? result.body?.error ?? "Tasarım güncellenemedi.");
      if (result.body?.generatedCode) {
        resultSection.hidden = false;
        generatedCodeEl.textContent = result.body.generatedCode;
      }
      return;
    }
    showResult(result.body);
    // Fold the change into the prompt context so later CAM thread detection and
    // further revisions keep the full intent.
    lastPrompt = base ? `${base} ; ${instruction}` : instruction;
    reviseInput.value = "";
  } catch (err) {
    showError(`Sunucuya bağlanılamadı: ${err.message}`);
  } finally {
    setLoading(false);
    reviseBtn.disabled = false;
  }
}

async function handlePdf() {
  if (!lastStepPath) return;
  pdfBtn.disabled = true;
  const original = pdfBtn.textContent;
  pdfBtn.textContent = "PDF oluşturuluyor…";
  try {
    const result = await runAsyncJob(
      `${API_BASE}/generate-pdf`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          stepPath: lastStepPath,
          code: lastGeneratedCode,
          bbox: lastBbox,
        }),
      },
      (seconds) => {
        pdfBtn.textContent = `PDF oluşturuluyor… (${seconds} sn)`;
      },
    );

    if (result.error || !result.ok || !result.body?.pdfUrl) {
      pdfBtn.textContent = result.error ?? result.body?.error ?? "PDF oluşturulamadı";
      return;
    }
    pdfLink.href = result.body.pdfUrl;
    pdfLink.hidden = false;
    pdfBtn.hidden = true;
  } catch (err) {
    pdfBtn.textContent = `Hata: ${err.message}`;
  } finally {
    pdfBtn.disabled = false;
    if (pdfLink.hidden && pdfBtn.textContent.startsWith("PDF oluşturuluyor…")) {
      pdfBtn.textContent = original;
    }
  }
}

function setCamStatus(message, busy) {
  camStatus.hidden = !message;
  camSpinner.hidden = !busy;
  camStatusText.textContent = message ?? "";
}

async function handleCam() {
  if (!lastStepPath) return;
  camBtn.disabled = true;
  gcodeLink.hidden = true;
  resetCamAssistant();
  camAssistant.hidden = false;

  // Every part goes through the sequential CAM wizard. Nothing is planned or
  // machined until every step is answered.
  try {
    camStepIndex = 0;
    await loadCamStep(0);
  } finally {
    camBtn.disabled = false;
  }
}

// Fetch and render one wizard step. `targetIndex` selects the step; the backend
// shapes its recommendations from the answers gathered so far.
async function loadCamStep(targetIndex) {
  setCamStatus("Adım hazırlanıyor…", true);
  try {
    const response = await fetch(`${API_BASE}/cam-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        stepPath: lastStepPath,
        prompt: lastPrompt,
        answers: camAnswers,
        targetIndex,
      }),
    });
    const data = await readJson(response);
    if (!response.ok || !data) {
      setCamStatus(data?.error ?? "Adım alınamadı.", false);
      return;
    }
    setCamStatus("", false);
    if (data.done) {
      // All information collected → allow the plan to be generated.
      camWizard.hidden = true;
      camPlanBtn.hidden = false;
      return;
    }
    renderCamStep(data);
    camWizard.hidden = false;
    camPlanBtn.hidden = true;
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  }
}

function renderCamStep(data) {
  const step = data.step;
  camStepIndex = data.index;
  camStepFieldNames = step.fields.map((f) => f.name);

  camStepProgress.textContent = `Adım ${data.index + 1} / ${data.total}`;
  camStepTitle.textContent = step.title;
  if (step.intro) {
    camStepIntro.textContent = step.intro;
    camStepIntro.hidden = false;
  } else {
    camStepIntro.hidden = true;
  }

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
        o.value = opt;
        o.textContent = opt;
        if (String(opt) === String(f.value)) o.selected = true;
        input.appendChild(o);
      });
    } else {
      input = document.createElement("input");
      input.type = f.type === "number" ? "number" : "text";
      if (f.type === "number") input.step = "any";
      input.value = f.value ?? "";
    }
    input.id = inputId;
    input.name = f.name;
    input.dataset.type = f.type;
    wrap.appendChild(input);
    camStepFields.appendChild(wrap);
  });

  camBackBtn.hidden = camStepIndex === 0;
  camNextBtn.textContent = data.index + 1 >= data.total ? "Tamam" : "İleri";
}

// Read the current step's inputs into camAnswers (numbers coerced to Number).
function collectCurrentStep() {
  camStepFields.querySelectorAll("input, select").forEach((el) => {
    let value = el.value;
    if (el.dataset.type === "number") {
      const n = Number(value);
      if (Number.isFinite(n)) value = n;
    }
    camAnswers[el.name] = value;
  });
}

async function handleCamNext() {
  collectCurrentStep();
  await loadCamStep(camStepIndex + 1);
}

async function handleCamBack() {
  collectCurrentStep();
  if (camStepIndex === 0) return;
  await loadCamStep(camStepIndex - 1);
}

async function requestCamPlan(changeRequest) {
  const body = { stepPath: lastStepPath, answers: camAnswers, prompt: lastPrompt };
  if (changeRequest && camPlan) {
    body.previousPlan = camPlan;
    body.changeRequest = changeRequest;
  }
  setCamStatus("İşleme planı oluşturuluyor…", true);
  camPlanBtn.disabled = true;
  try {
    const result = await runAsyncJob(
      `${API_BASE}/cam-plan`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify(body),
      },
      (seconds) => setCamStatus(`İşleme planı oluşturuluyor… (${seconds}s)`, true),
    );
    if (result.error || !result.body?.plan) {
      setCamStatus(result.error ?? "Plan oluşturulamadı.", false);
      return;
    }
    const plan = result.body.plan;
    camPlan = plan;
    setCamStatus("", false);
    camPlanText.textContent = plan.planText || JSON.stringify(plan, null, 2);
    camPlanView.hidden = false;
    camReviseBox.hidden = true;
    camReviseInput.value = "";
    // A new plan invalidates any previous simulation/approval/quote.
    if (camSim) camSim.pause();
    camSim = null;
    camPreviewView.hidden = true;
    camPreviewToken = null;
    camEstimatedMinutes = null;
    camQuote.hidden = true;
    camQuoteForm.hidden = true;
    camQuoteResult.hidden = true;
    gcodeLink.hidden = true;
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  } finally {
    camPlanBtn.disabled = false;
  }
}

async function handleCamPlan() {
  // camAnswers is already fully populated by the wizard.
  await requestCamPlan(null);
}

// Build the Path operations and show an animated toolpath simulation in the 3D
// viewer. No G-code is produced until the user approves this simulation.
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
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          stepPath: lastStepPath,
          answers: camAnswers,
          plan: camPlan,
          prompt: lastPrompt,
        }),
      },
      (seconds) => {
        const phase = seconds < 15 ? "Kod üretiliyor" : seconds < 60 ? "FreeCAD hesaplıyor" : "İşlem devam ediyor";
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
    // The toolpath (and its estimated time) is known → enable the quote engine.
    if (camEstimatedMinutes != null) {
      camQuoteTime.textContent = `Tahmini işleme süresi: ${camEstimatedMinutes} dk`;
      camQuote.hidden = false;
      camQuoteForm.hidden = true;
      camQuoteResult.hidden = true;
    }
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  } finally {
    camPreviewBtn.disabled = false;
    camReviseBtn.disabled = false;
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function resetSimLayout() {
  if (simWorkspace) simWorkspace.classList.remove("sim-active");
  if (gcodePanel) gcodePanel.hidden = true;
  if (coordDisplay) coordDisplay.hidden = true;
  document.querySelector("main").classList.remove("sim-expanded");
}

function setSimSpeed(mult) {
  if (camSim) camSim.setSpeed(mult);
  Object.entries(camSimSpeedBtns).forEach(([m, btn]) => {
    btn.classList.toggle("active", Number(m) === mult);
  });
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
      if (camSim && !camSim.isPlaying()) camSimPlay.textContent = "Oynat";
      if (progress >= 1) camSimPlay.textContent = "Tekrar Oynat";

      if (coordX) {
        coordX.textContent = x != null ? x.toFixed(3) : "0.000";
        coordY.textContent = y != null ? y.toFixed(3) : "0.000";
        coordZ.textContent = z != null ? z.toFixed(3) : "0.000";
        coordF.textContent = f != null ? String(Math.round(f)) : "0";
      }

      if (lineIndex !== lastLineIdx && gcodeLineEls.length > 0) {
        if (lastLineIdx >= 0 && lastLineIdx < gcodeLineEls.length) {
          gcodeLineEls[lastLineIdx].classList.remove("active");
        }
        if (lineIndex >= 0 && lineIndex < gcodeLineEls.length) {
          gcodeLineEls[lineIndex].classList.add("active");
          const el = gcodeLineEls[lineIndex];
          const panel = gcodeLinesEl;
          if (panel) {
            const elTop = el.offsetTop - panel.offsetTop;
            panel.scrollTop = elTop - panel.clientHeight / 2 + el.clientHeight / 2;
          }
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
  document.querySelector("main").classList.add("sim-expanded");
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));

  camSimProgress.value = "0";
  camSimPlay.textContent = "Oynat";
  setSimSpeed(1);
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
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({
          stepPath: lastStepPath,
          answers: camAnswers,
          plan: camPlan,
          prompt: lastPrompt,
          token: camPreviewToken,
        }),
      },
      (seconds) => setCamStatus(`G-code üretiliyor… (${seconds} sn)`, true),
    );

    if (result.error || !result.ok || !result.body?.gcodeUrl) {
      setCamStatus(result.error ?? result.body?.error ?? "G-code üretilemedi.", false);
      return;
    }
    setCamStatus("G-code hazır.", false);
    gcodeLink.href = result.body.gcodeUrl;
    gcodeLink.hidden = false;
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  } finally {
    camConfirmBtn.disabled = false;
    camRejectBtn.disabled = false;
  }
}

function setQuoteMode(mode) {
  const detailed = mode === "detayli";
  quoteFieldsBasit.hidden = detailed;
  quoteFieldsDetayli.hidden = !detailed;
}

function currentQuoteMode() {
  const checked = camQuoteForm.querySelector('input[name="quote-mode"]:checked');
  return checked ? checked.value : "basit";
}

function numVal(id) {
  const el = document.getElementById(id);
  if (!el) return undefined;
  const v = el.value.trim();
  return v === "" ? undefined : Number(v);
}

function collectQuoteInputs(mode) {
  if (mode === "detayli") {
    return {
      materialPrice: numVal("q-materialPrice-d"),
      materialPriceUnit: document.getElementById("q-materialUnit-d").value,
      amortHourly: numVal("q-amortHourly"),
      energyPrice: numVal("q-energyPrice"),
      powerKw: numVal("q-powerKw"),
      toolCost: numVal("q-toolCost"),
      toolLifeParts: numVal("q-toolLifeParts"),
      consumableHourly: numVal("q-consumableHourly"),
      consumablePerPart: numVal("q-consumablePerPart"),
      overheadPct: numVal("q-overheadPct"),
      scrapPct: numVal("q-scrapPct"),
      profitPct: numVal("q-profitPct-d"),
    };
  }
  return {
    hourlyRate: numVal("q-hourlyRate"),
    materialPrice: numVal("q-materialPrice-b"),
    materialPriceUnit: document.getElementById("q-materialUnit-b").value,
    profitPct: numVal("q-profitPct-b"),
  };
}

function renderQuoteBreakdown(quote) {
  const lines = [`Tahmini süre: ${quote.minutes} dk`, ""];
  const pad = (s, n) => String(s).padEnd(n);
  for (const it of quote.items) {
    lines.push(`${pad(it.label, 34)} ${Number(it.amount).toLocaleString("tr-TR")} TL`);
  }
  lines.push("");
  lines.push(`${pad("TOPLAM", 34)} ${Number(quote.total).toLocaleString("tr-TR")} TL`);
  return lines.join("\n");
}

async function handleQuoteSubmit() {
  if (camEstimatedMinutes == null) {
    setCamStatus("Önce takım yolu önizlemesi oluşturun.", false);
    return;
  }
  const mode = currentQuoteMode();
  camQuoteSubmit.disabled = true;
  setCamStatus("Teklif hesaplanıyor…", true);
  try {
    const response = await fetch(`${API_BASE}/cam-quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({
        mode,
        minutes: camEstimatedMinutes,
        answers: camAnswers,
        bbox: lastBbox,
        material: camAnswers.material,
        partName: lastPrompt || "Parca",
        inputs: collectQuoteInputs(mode),
      }),
    });
    const data = await readJson(response);
    if (!response.ok || !data?.quote) {
      setCamStatus(data?.error ?? "Teklif oluşturulamadı.", false);
      return;
    }
    setCamStatus("", false);
    camQuoteBreakdown.textContent = renderQuoteBreakdown(data.quote);
    if (data.pdfUrl) {
      camQuotePdf.href = data.pdfUrl;
      camQuotePdf.hidden = false;
    } else {
      camQuotePdf.hidden = true;
    }
    camQuoteResult.hidden = false;
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  } finally {
    camQuoteSubmit.disabled = false;
  }
}

async function loadStlPreview(stlUrl) {
  try {
    const { initViewer, loadStl } = await import("./viewer.js");
    if (!viewer) {
      viewer = initViewer(viewerContainer);
    }
    loadStl(viewer, stlUrl);
    if (lastStepPath && !lastDimData) {
      fetchAndShowDimensions();
    }
  } catch (err) {
    console.error("3D önizleme yüklenemedi:", err);
  }
}

async function showAnchors(anchors, center) {
  if (!anchors || !anchors.length) return;
  try {
    const c = center || [0, 0, 0];
    const dimData = {
      dimensions: anchors.map((a) => ({
        id: a.paramName,
        paramName: a.paramName,
        label: a.label,
        value: a.value,
        unit: a.unit || "mm",
        editable: a.editable !== false,
        symbol: a.symbol || null,
        count: a.count || 1,
        p1: a.p1,
        p2: a.p2,
        ext1: a.ext1 || null,
        ext2: a.ext2 || null,
      })),
      center: c,
    };
    lastDimData = dimData;
    const { initViewer, loadDimensions } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);
    loadDimensions(viewer, dimData, { onEdit: handleDimensionEdit });
  } catch (err) {
    console.error("Anchor etiketleri yüklenemedi:", err);
  }
}

async function fetchAndShowDimensions() {
  if (!lastStepPath) return;
  try {
    const resp = await fetch(`${API_BASE}/extract-dimensions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ stepPath: lastStepPath }),
    });
    const data = await readJson(resp);
    if (!resp.ok || !data?.dimensions) return;
    lastDimData = data;
    const { initViewer, loadDimensions } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);
    loadDimensions(viewer, data, { onEdit: handleDimensionEdit });
  } catch (err) {
    console.error("Ölçü etiketleri yüklenemedi:", err);
  }
}

function codeHasParamBlock(code) {
  return code && code.includes("# ROVER_PARAMS_START") && code.includes("# ROVER_PARAMS_END");
}

function findParamForDim(code, dim) {
  if (!code) return null;
  const lines = code.split("\n");
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "# ROVER_PARAMS_START") { inBlock = true; continue; }
    if (trimmed === "# ROVER_PARAMS_END") break;
    if (!inBlock) continue;
    const m = trimmed.match(/^(\w+)\s*=\s*([\d.eE+-]+)\s*(?:#\s*(.*))?$/);
    if (m) {
      const paramValue = parseFloat(m[2]);
      if (Math.abs(paramValue - dim.value) < 0.01) return m[1];
    }
  }
  return null;
}

function setDimLock(locked) {
  document.querySelectorAll(".dim-label").forEach((el) => {
    if (locked) el.classList.add("dim-updating");
    else el.classList.remove("dim-updating");
  });
}

async function handleDimensionEdit(dim, newValue) {
  if (dimEditInProgress) {
    dimEditQueue.push({ dim, newValue });
    return;
  }
  dimEditInProgress = true;
  setDimLock(true);

  const code = lastGeneratedCode || buildSyntheticCode();
  if (!code) {
    showError("Ölçü düzenlemesi için model kodu gereklidir.");
    dimEditInProgress = false;
    setDimLock(false);
    return;
  }

  const paramName = dim.paramName
    ? dim.paramName
    : (codeHasParamBlock(code) ? findParamForDim(code, dim) : null);
  const useDeterministic = !!paramName;

  const { clearDimensions } = await import("./viewer.js");
  clearDimensions(viewer);
  setLoading(true, `Ölçü güncelleniyor: ${dim.label} → ${newValue} mm…`);

  try {
    let result;
    if (useDeterministic) {
      result = await runAsyncJob(
        `${API_BASE}/param-edit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
          body: JSON.stringify({ code, paramName, newValue }),
        },
        (seconds) => setLoading(true, `Ölçü güncelleniyor… (${seconds} sn)`),
      );
    } else {
      const prefix = dim.symbol === "dia" ? "çapı" : "";
      const label = dim.label.toLowerCase();
      const countNote = dim.count > 1 ? ` (${dim.count} adet)` : "";
      let instruction;
      if (dim.symbol === "dia") {
        instruction = `${dim.label}${countNote} ${prefix} ${dim.value} mm olan ölçüyü ${newValue} mm yap`;
      } else {
        instruction = `${label} ölçüsünü ${dim.value} mm'den ${newValue} mm'ye değiştir`;
      }
      result = await runAsyncJob(
        `${API_BASE}/revise`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
          body: JSON.stringify({
            prompt: instruction,
            previousCode: code,
            basePrompt: lastPrompt,
          }),
        },
        (seconds) => setLoading(true, `Ölçü güncelleniyor… (${seconds} sn)`),
      );
      if (result.ok) {
        lastPrompt = lastPrompt ? `${lastPrompt} ; ${instruction}` : instruction;
      }
    }

    if (result.error || !result.ok) {
      showError(result.error ?? result.body?.error ?? "Ölçü güncellenemedi.");
      fetchAndShowDimensions();
      return;
    }
    showResult(result.body);
  } catch (err) {
    showError(`Sunucuya bağlanılamadı: ${err.message}`);
    fetchAndShowDimensions();
  } finally {
    setLoading(false);
    dimEditInProgress = false;
    setDimLock(false);
    if (dimEditQueue.length > 0) {
      const next = dimEditQueue.shift();
      handleDimensionEdit(next.dim, next.newValue);
    }
  }
}

function buildSyntheticCode() {
  if (!lastStepPath) return null;
  const lines = [
    "import FreeCAD as App",
    "import Part",
    'doc = App.newDocument("RoverCAD")',
    `Part.insert(${JSON.stringify(lastStepPath)}, doc.Name)`,
    "doc.recompute()",
  ];
  if (lastDimData?.dimensions?.length) {
    lines.push("");
    lines.push("# ROVER_DIMENSIONS: Mevcut olculer");
    for (const d of lastDimData.dimensions) {
      const prefix = d.symbol === "dia" ? "Cap " : "";
      const count = d.count > 1 ? ` (${d.count} adet)` : "";
      lines.push(`# ${d.label}: ${prefix}${d.value} ${d.unit}${count}`);
    }
  }
  return lines.join("\n");
}

// 2D contour preview (DXF without thickness): draw the contour as lines.
async function loadContourPreview(contourUrl) {
  try {
    const response = await fetch(contourUrl);
    const data = await readJson(response);
    const { initViewer, loadToolpath } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);
    loadToolpath(viewer, data ?? { toolpaths: [] });
  } catch (err) {
    console.error("2D önizleme yüklenemedi:", err);
  }
}

// --- Machine & tool inventory ("Makine ve Takımlarım") ---------------------
const mainSection = document.querySelector("main");
const inventorySection = document.getElementById("inventory-section");
const navMain = document.getElementById("nav-main");
const navInventory = document.getElementById("nav-inventory");
const machinesList = document.getElementById("machines-list");
const toolsList = document.getElementById("tools-list");

function showView(view) {
  const inv = view === "inventory";
  inventorySection.hidden = !inv;
  mainSection.hidden = inv;
  navInventory.classList.toggle("active", inv);
  navMain.classList.toggle("active", !inv);
  if (inv) {
    loadMachines();
    loadTools();
  }
}

async function apiJson(url, options) {
  const resp = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY, ...(options?.headers || {}) },
  });
  return { ok: resp.ok, data: await readJson(resp) };
}

async function loadMachines() {
  machinesList.innerHTML = "<li>Yükleniyor…</li>";
  const { ok, data } = await apiJson(`${API_BASE}/machines`, { method: "GET" });
  if (!ok || !data) {
    machinesList.innerHTML = "<li>Makineler yüklenemedi.</li>";
    return;
  }
  const machines = data.machines || [];
  if (!machines.length) {
    machinesList.innerHTML = "<li class=\"inventory-empty\">Kayıtlı makine yok.</li>";
    return;
  }
  machinesList.innerHTML = "";
  machines.forEach((m) => {
    const li = document.createElement("li");
    li.className = "inventory-item";
    const info = document.createElement("span");
    info.textContent = `${m.name} — ${m.axisCount} eksen, ${m.postProcessor}, ${m.hourlyRate} TL/saat`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary";
    del.textContent = "Sil";
    del.addEventListener("click", () => deleteEntity("machines", m.id, loadMachines));
    li.append(info, del);
    machinesList.appendChild(li);
  });
}

async function loadTools() {
  toolsList.innerHTML = "<li>Yükleniyor…</li>";
  const { ok, data } = await apiJson(`${API_BASE}/tools`, { method: "GET" });
  if (!ok || !data) {
    toolsList.innerHTML = "<li>Takımlar yüklenemedi.</li>";
    return;
  }
  const tools = data.tools || [];
  if (!tools.length) {
    toolsList.innerHTML = "<li class=\"inventory-empty\">Kayıtlı takım yok.</li>";
    return;
  }
  toolsList.innerHTML = "";
  tools.forEach((t) => {
    const li = document.createElement("li");
    li.className = "inventory-item";
    const info = document.createElement("span");
    info.textContent = `${t.name} — Ø${t.diameter}mm, ${t.flutes} ağız, ${t.material}${t.stock != null ? `, stok: ${t.stock}` : ""}`;
    const del = document.createElement("button");
    del.type = "button";
    del.className = "secondary";
    del.textContent = "Sil";
    del.addEventListener("click", () => deleteEntity("tools", t.id, loadTools));
    li.append(info, del);
    toolsList.appendChild(li);
  });
}

async function deleteEntity(kind, id, reload) {
  const { ok } = await apiJson(`${API_BASE}/${kind}/${id}`, { method: "DELETE" });
  if (ok) reload();
}

function fieldNum(id) {
  const v = document.getElementById(id).value.trim();
  return v === "" ? undefined : Number(v);
}

async function addMachineProfile() {
  const name = document.getElementById("m-name").value.trim();
  if (!name) {
    alert("Makine adı zorunludur.");
    return;
  }
  const body = {
    name,
    axisCount: Number(document.getElementById("m-axis").value),
    postProcessor: document.getElementById("m-post").value,
    maxSpindleRpm: fieldNum("m-rpm"),
    workArea: { x: fieldNum("m-wx"), y: fieldNum("m-wy"), z: fieldNum("m-wz") },
    hourlyRate: fieldNum("m-rate"),
  };
  const { ok, data } = await apiJson(`${API_BASE}/machines`, { method: "POST", body: JSON.stringify(body) });
  if (!ok) {
    alert(data?.error ?? "Makine eklenemedi.");
    return;
  }
  document.getElementById("m-name").value = "";
  loadMachines();
}

async function addToolProfile() {
  const name = document.getElementById("t-name").value.trim();
  if (!name) {
    alert("Takım adı/kodu zorunludur.");
    return;
  }
  const body = {
    name,
    type: document.getElementById("t-type").value,
    diameter: fieldNum("t-dia"),
    flutes: fieldNum("t-flutes"),
    material: document.getElementById("t-material").value,
    cuttingSpeedMin: fieldNum("t-vmin"),
    cuttingSpeedMax: fieldNum("t-vmax"),
    stock: fieldNum("t-stock"),
  };
  const { ok, data } = await apiJson(`${API_BASE}/tools`, { method: "POST", body: JSON.stringify(body) });
  if (!ok) {
    alert(data?.error ?? "Takım eklenemedi.");
    return;
  }
  document.getElementById("t-name").value = "";
  loadTools();
}

navMain.addEventListener("click", () => showView("main"));
navInventory.addEventListener("click", () => showView("inventory"));
document.getElementById("m-add").addEventListener("click", addMachineProfile);
document.getElementById("t-add").addEventListener("click", addToolProfile);

generateBtn.addEventListener("click", handleGenerate);
reviseBtn.addEventListener("click", handleRevise);
pdfBtn.addEventListener("click", handlePdf);
camBtn.addEventListener("click", handleCam);
camNextBtn.addEventListener("click", handleCamNext);
camBackBtn.addEventListener("click", handleCamBack);
camPlanBtn.addEventListener("click", handleCamPlan);
camPreviewBtn.addEventListener("click", handleCamPreview);
camConfirmBtn.addEventListener("click", handleCamConfirm);
camRejectBtn.addEventListener("click", handleCamReject);
camSimPlay.addEventListener("click", () => {
  if (!camSim) return;
  if (camSim.isPlaying()) {
    camSim.pause();
    camSimPlay.textContent = "Oynat";
  } else {
    camSim.play();
    camSimPlay.textContent = "Duraklat";
  }
});
camSimProgress.addEventListener("input", () => {
  if (!camSim) return;
  camSim.pause();
  camSimPlay.textContent = "Oynat";
  camSim.seek(Number(camSimProgress.value) / 1000);
});
Object.entries(camSimSpeedBtns).forEach(([m, btn]) => {
  btn.addEventListener("click", () => setSimSpeed(Number(m)));
});
camReviseBtn.addEventListener("click", () => {
  camReviseBox.hidden = !camReviseBox.hidden;
});
camReviseSubmit.addEventListener("click", () => {
  const change = camReviseInput.value.trim();
  if (change) requestCamPlan(change);
});
camQuoteBtn.addEventListener("click", () => {
  camQuoteForm.hidden = false;
  camQuoteResult.hidden = true;
  setQuoteMode(currentQuoteMode());
});
camQuoteForm.querySelectorAll('input[name="quote-mode"]').forEach((radio) => {
  radio.addEventListener("change", () => setQuoteMode(radio.value));
});
camQuoteSubmit.addEventListener("click", handleQuoteSubmit);

// --- Kinematic simulation ---------------------------------------------------

async function handleSimDemo() {
  clearError();
  resetKinSim();
  simDemoBtn.disabled = true;
  simDemoBtn.textContent = "FreeCAD'de olusturuluyor…";
  setLoading(true, "Simulasyon parcalari FreeCAD'de olusturuluyor…");
  try {
    const result = await runAsyncJob(
      `${API_BASE}/simulate/demo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({}),
      },
      (seconds) => {
        simDemoBtn.textContent = `FreeCAD calisiyor… (${seconds} sn)`;
        setLoading(true, `Simulasyon parcalari olusturuluyor… (${seconds} sn)`);
      },
    );

    if (result.error || !result.ok) {
      showError(result.error ?? result.body?.error ?? "Simulasyon basarisiz.");
      simDemoBtn.textContent = "HATA - tekrar dene";
      return;
    }

    const { partsInline, partStlUrls, kinematicsData, kinematicsUrl } = result.body;
    const parts = partsInline || partStlUrls;
    if (!parts?.length) {
      showError("Simulasyon verisi eksik (STL yok).");
      simDemoBtn.textContent = "HATA - tekrar dene";
      return;
    }

    let kinData = kinematicsData;
    if (!kinData && kinematicsUrl) {
      simDemoBtn.textContent = "Kinematik veri yukleniyor…";
      const kinResp = await fetch(kinematicsUrl);
      kinData = await kinResp.json();
    }
    if (!kinData) {
      showError("Kinematik veri alinamadi.");
      simDemoBtn.textContent = "HATA - tekrar dene";
      return;
    }

    simDemoBtn.textContent = "3D sahne hazirlaniyor…";
    const { initViewer } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);

    simDemoBtn.textContent = "STL parcalar yukleniyor…";
    const { loadKinematicSim } = await import("./kinematicPlayer.js");
    kinSim = await loadKinematicSim(viewer, parts, kinData, {
      onUpdate: ({ angle, playing, collided }) => {
        kinSimProgress.value = String(Math.round(angle * 10) % 3600);
        kinSimStatus.textContent = collided
          ? "Durum: Carpma!"
          : playing
            ? `Durum: Calisiyor (${Math.round(angle % 360)}°)`
            : `Durum: Durdu (${Math.round(angle % 360)}°)`;
        if (!playing) kinSimPlay.textContent = "Oynat";
      },
      onCollision: (pairs) => {
        kinCollisionAlert.hidden = false;
        kinCollisionAlert.textContent = `Carpma algilandi: ${pairs.map((p) => p.join(" <-> ")).join(", ")}. Simulasyon durduruldu.`;
        kinSimPlay.textContent = "Oynat";
      },
    });

    kinSimView.hidden = false;
    kinSimPlay.textContent = "Oynat";
    kinCollisionAlert.hidden = true;
    setKinSimSpeed(1);
    simDemoBtn.textContent = "Demo: Krank-Piston Simulasyonu";
  } catch (err) {
    showError(`Simulasyon basarisiz: ${err.message}`);
    simDemoBtn.textContent = `HATA: ${err.message}`;
  } finally {
    setLoading(false);
    simDemoBtn.disabled = false;
  }
}

function setKinSimSpeed(mult) {
  if (kinSim) kinSim.setSpeed(mult);
  Object.entries(kinSimSpeedBtns).forEach(([m, btn]) => {
    btn.classList.toggle("active", Number(m) === mult);
  });
}

simDemoBtn.addEventListener("click", handleSimDemo);

kinSimPlay.addEventListener("click", () => {
  if (!kinSim) return;
  if (kinSim.isPlaying()) {
    kinSim.pause();
    kinSimPlay.textContent = "Oynat";
  } else {
    if (!kinCollisionAlert.hidden) {
      kinSim.reset();
      kinCollisionAlert.hidden = true;
    }
    kinSim.play();
    kinSimPlay.textContent = "Duraklat";
  }
});

kinSimProgress.addEventListener("input", () => {
  if (!kinSim) return;
  kinSim.pause();
  kinSimPlay.textContent = "Oynat";
  kinSim.seek(Number(kinSimProgress.value) / 10);
});

Object.entries(kinSimSpeedBtns).forEach(([m, btn]) => {
  btn.addEventListener("click", () => setKinSimSpeed(Number(m)));
});

promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    handleGenerate();
  }
});
