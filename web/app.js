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
let camPlan = null;

function setMode(next) {
  mode = next;
  const tabs = [
    [tabText, panelText, "text"],
    [tabImage, panelImage, "image"],
    [tabStep, panelStep, "step"],
  ];
  for (const [tab, panel, name] of tabs) {
    const active = name === next;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
  }
  generateBtn.textContent = next === "step" ? "Yükle ve Önizle" : "Oluştur";
}

tabText.addEventListener("click", () => setMode("text"));
tabImage.addEventListener("click", () => setMode("image"));
tabStep.addEventListener("click", () => setMode("step"));

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  imageLabel.textContent = file ? file.name : "Bir teknik resim seçin (PNG, JPG…)";
});

stepInput.addEventListener("change", () => {
  const file = stepInput.files?.[0];
  stepLabel.textContent = file
    ? file.name
    : "Bir STEP/IGES dosyası seçin (.step, .stp, .iges, .igs)";
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
  generatedCodeEl.textContent = "";
  camSection.hidden = true;
  camStatus.hidden = true;
  gcodeLink.hidden = true;
  resetCamAssistant();
  lastStepPath = null;
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
  camPlan = null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 8 * 60 * 1000; // give long builds plenty of room

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
    baseMessage = "FreeCAD'de model oluşturuluyor";
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
    // STEP/IGES upload: import in FreeCAD, preview, then jump straight to CAM.
    const file = stepInput.files?.[0];
    if (!file) {
      showError("Lütfen bir STEP/IGES dosyası seçin.");
      return;
    }
    baseMessage = "Dosya yükleniyor ve FreeCAD'e aktarılıyor";
    lastPrompt = "";
    const form = new FormData();
    form.append("file", file);
    url = `${API_BASE}/upload-step`;
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
      showError(result.body?.error ?? "Model oluşturulamadı.");
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
  }
  if (data.generatedCode) {
    generatedCodeEl.textContent = data.generatedCode;
  }

  lastGeneratedCode = data.generatedCode ?? null;
  lastBbox = data.bbox ?? null;
  // The PDF is generated on demand to keep /generate fast.
  pdfBtn.hidden = false;
  // Allow iterative editing once we have code to revise.
  reviseSection.hidden = !lastGeneratedCode;

  lastStepPath = data.stepPath ?? null;
  // Offer CAM for any part with an exported STEP; every part goes through the
  // CAM assistant (questions -> plan -> confirm).
  if (lastStepPath) {
    camSection.hidden = false;
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
    const response = await fetch(`${API_BASE}/cam-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify(body),
    });
    const data = await readJson(response);
    if (!response.ok || !data?.plan) {
      setCamStatus(data?.error ?? "Plan oluşturulamadı.", false);
      return;
    }
    camPlan = data.plan;
    setCamStatus("", false);
    camPlanText.textContent = data.plan.planText || JSON.stringify(data.plan, null, 2);
    camPlanView.hidden = false;
    camReviseBox.hidden = true;
    camReviseInput.value = "";
    // A new plan invalidates any previous toolpath preview/approval/quote.
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

// Build the Path operations and show a toolpath preview in the 3D viewer. No
// G-code is produced until the user approves this preview.
async function handleCamPreview() {
  if (!camPlan) return;
  camPreviewBtn.disabled = true;
  camReviseBtn.disabled = true;
  camPreviewView.hidden = true;
  camPreviewToken = null;
  gcodeLink.hidden = true;
  setCamStatus("Takım yolu hesaplanıyor (önizleme)…", true);
  try {
    const result = await runAsyncJob(
      `${API_BASE}/cam-preview`,
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
      (seconds) => setCamStatus(`Takım yolu hesaplanıyor (önizleme)… (${seconds} sn)`, true),
    );

    if (result.error || !result.ok || !result.body?.previewUrl) {
      setCamStatus(result.error ?? result.body?.error ?? "Önizleme üretilemedi.", false);
      return;
    }
    camPreviewToken = result.body.token ?? null;
    camEstimatedMinutes = result.body.estimatedMinutes ?? null;
    await renderToolpathPreview(result.body.previewUrl);
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

async function renderToolpathPreview(previewUrl) {
  const response = await fetch(previewUrl);
  const data = await readJson(response);
  const { initViewer, loadToolpath } = await import("./viewer.js");
  if (!viewer) viewer = initViewer(viewerContainer);
  loadToolpath(viewer, data ?? { toolpaths: [] });
}

function handleCamReject() {
  // Reject the previewed toolpath: return to the plan so it can be revised.
  camPreviewView.hidden = true;
  camPreviewToken = null;
  setCamStatus("Takım yolu reddedildi. Planı değiştirip tekrar önizleyin.", false);
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
  } catch (err) {
    console.error("3D önizleme yüklenemedi:", err);
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
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    handleGenerate();
  }
});
