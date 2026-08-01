const API_BASE = "https://api.topkapikoleji.org";
// NOTE: shipped in a public static site, so this is not a real secret -- it
// only keeps casual/automated traffic off the endpoint, not a determined
// attacker (anyone can read it via view-source). Must match API_KEY in the
// backend's .env.
const API_KEY = "1d48ec585a4b306db72a23be0b7ce8f56618c1275a3ea5efcee96df1106712f1";

const tabText = document.getElementById("tab-text");
const tabImage = document.getElementById("tab-image");
const panelText = document.getElementById("panel-text");
const panelImage = document.getElementById("panel-image");
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
const viewerContainer = document.getElementById("viewer-container");
const generatedCodeEl = document.getElementById("generated-code");
const camSection = document.getElementById("cam-section");
const camBtn = document.getElementById("cam-btn");
const camStatus = document.getElementById("cam-status");
const camSpinner = document.getElementById("cam-spinner");
const camStatusText = document.getElementById("cam-status-text");
const gcodeLink = document.getElementById("gcode-link");
const camAssistant = document.getElementById("cam-assistant");
const camQuestionsForm = document.getElementById("cam-questions-form");
const camPlanBtn = document.getElementById("cam-plan-btn");
const camPlanView = document.getElementById("cam-plan-view");
const camPlanText = document.getElementById("cam-plan-text");
const camConfirmBtn = document.getElementById("cam-confirm-btn");
const camReviseBtn = document.getElementById("cam-revise-btn");
const camReviseBox = document.getElementById("cam-revise-box");
const camReviseInput = document.getElementById("cam-revise-input");
const camReviseSubmit = document.getElementById("cam-revise-submit");

let viewer = null;
let mode = "text"; // "text" | "image"
let lastStepPath = null;
let lastGeneratedCode = null;
let lastBbox = null;
let camAnswers = null;
let camPlan = null;

function setMode(next) {
  mode = next;
  const isText = next === "text";
  tabText.classList.toggle("active", isText);
  tabImage.classList.toggle("active", !isText);
  tabText.setAttribute("aria-selected", String(isText));
  tabImage.setAttribute("aria-selected", String(!isText));
  panelText.hidden = !isText;
  panelImage.hidden = isText;
}

tabText.addEventListener("click", () => setMode("text"));
tabImage.addEventListener("click", () => setMode("image"));

imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  imageLabel.textContent = file ? file.name : "Bir teknik resim seçin (PNG, JPG…)";
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
  lastGeneratedCode = null;
  lastBbox = null;
  generatedCodeEl.textContent = "";
  camSection.hidden = true;
  camStatus.hidden = true;
  gcodeLink.hidden = true;
  resetCamAssistant();
  lastStepPath = null;
}

function resetCamAssistant() {
  camAssistant.hidden = true;
  camQuestionsForm.hidden = true;
  camQuestionsForm.innerHTML = "";
  camPlanBtn.hidden = true;
  camPlanView.hidden = true;
  camPlanText.textContent = "";
  camReviseBox.hidden = true;
  camReviseInput.value = "";
  camAnswers = null;
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
    url = `${API_BASE}/generate`;
    options = {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ prompt }),
    };
  } else {
    const file = imageInput.files?.[0];
    if (!file) {
      showError("Lütfen bir teknik resim seçin.");
      return;
    }
    baseMessage = "Teknik resim yorumlanıp model oluşturuluyor";
    const form = new FormData();
    form.append("image", file);
    if (imagePromptInput.value.trim()) {
      form.append("prompt", imagePromptInput.value.trim());
    }
    url = `${API_BASE}/generate-from-image`;
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

  lastStepPath = data.stepPath ?? null;
  // Offer CAM for any part with an exported STEP: simple parts get automatic
  // G-code, complex parts fall through to the assistant flow.
  if (lastStepPath) {
    camSection.hidden = false;
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
  setCamStatus("CNC G-code üretiliyor…", true);

  try {
    const result = await runAsyncJob(
      `${API_BASE}/generate-cam`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ stepPath: lastStepPath }),
      },
      (seconds) => setCamStatus(`CNC G-code üretiliyor… (${seconds} sn)`, true),
    );

    if (result.error || !result.ok) {
      setCamStatus(result.error ?? result.body?.error ?? "İşlem başarısız.", false);
      return;
    }
    if (result.body?.complex) {
      // Complex part → start the assistant question flow.
      await startCamAssistant();
      return;
    }
    setCamStatus("G-code hazır.", false);
    if (result.body?.gcodeUrl) {
      gcodeLink.href = result.body.gcodeUrl;
      gcodeLink.hidden = false;
    }
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  } finally {
    camBtn.disabled = false;
  }
}

async function startCamAssistant() {
  setCamStatus("Parça inceleniyor, sorular hazırlanıyor…", true);
  try {
    const response = await fetch(`${API_BASE}/cam-questions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ stepPath: lastStepPath }),
    });
    const data = await readJson(response);
    if (!response.ok || !Array.isArray(data?.questions) || data.questions.length === 0) {
      setCamStatus(data?.error ?? "Sorular alınamadı.", false);
      return;
    }
    setCamStatus("", false);
    renderCamQuestions(data.questions);
    camAssistant.hidden = false;
    camQuestionsForm.hidden = false;
    camPlanBtn.hidden = false;
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  }
}

function renderCamQuestions(questions) {
  camQuestionsForm.innerHTML = "";
  questions.forEach((q, qi) => {
    const fieldset = document.createElement("fieldset");
    fieldset.className = "cam-question";
    fieldset.dataset.question = q.question;

    const legend = document.createElement("legend");
    legend.textContent = q.question;
    fieldset.appendChild(legend);

    const options = q.options && q.options.length ? q.options : ["Evet", "Hayır"];
    options.forEach((opt, oi) => {
      const id = `camq-${qi}-${oi}`;
      const label = document.createElement("label");
      label.className = "cam-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `camq-${qi}`;
      input.value = opt;
      input.id = id;
      if (oi === 0) input.checked = true;
      const span = document.createElement("span");
      span.textContent = opt;
      label.appendChild(input);
      label.appendChild(span);
      fieldset.appendChild(label);
    });

    // Free-text field, used when a "Diğer/Diger" option is selected.
    const other = document.createElement("input");
    other.type = "text";
    other.className = "cam-other";
    other.placeholder = "Diğer (yazın)";
    other.dataset.for = `camq-${qi}`;
    fieldset.appendChild(other);

    camQuestionsForm.appendChild(fieldset);
  });
}

function collectCamAnswers() {
  const answers = {};
  camQuestionsForm.querySelectorAll("fieldset.cam-question").forEach((fs) => {
    const question = fs.dataset.question;
    const checked = fs.querySelector("input[type=radio]:checked");
    let value = checked ? checked.value : "";
    if (/^diğer|^diger/i.test(value)) {
      const other = fs.querySelector("input.cam-other");
      if (other && other.value.trim()) value = other.value.trim();
    }
    answers[question] = value;
  });
  return answers;
}

async function requestCamPlan(changeRequest) {
  const body = { stepPath: lastStepPath, answers: camAnswers };
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
    gcodeLink.hidden = true;
  } catch (err) {
    setCamStatus(`Sunucuya bağlanılamadı: ${err.message}`, false);
  } finally {
    camPlanBtn.disabled = false;
  }
}

async function handleCamPlan() {
  camAnswers = collectCamAnswers();
  await requestCamPlan(null);
}

async function handleCamConfirm() {
  if (!camPlan) return;
  camConfirmBtn.disabled = true;
  camReviseBtn.disabled = true;
  setCamStatus("Plan onaylandı, G-code üretiliyor…", true);
  try {
    const result = await runAsyncJob(
      `${API_BASE}/cam-confirm`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ stepPath: lastStepPath, answers: camAnswers, plan: camPlan }),
      },
      (seconds) => setCamStatus(`Plan onaylandı, G-code üretiliyor… (${seconds} sn)`, true),
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
    camReviseBtn.disabled = false;
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

generateBtn.addEventListener("click", handleGenerate);
pdfBtn.addEventListener("click", handlePdf);
camBtn.addEventListener("click", handleCam);
camPlanBtn.addEventListener("click", handleCamPlan);
camConfirmBtn.addEventListener("click", handleCamConfirm);
camReviseBtn.addEventListener("click", () => {
  camReviseBox.hidden = !camReviseBox.hidden;
});
camReviseSubmit.addEventListener("click", () => {
  const change = camReviseInput.value.trim();
  if (change) requestCamPlan(change);
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    handleGenerate();
  }
});
