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
const viewerContainer = document.getElementById("viewer-container");
const generatedCodeEl = document.getElementById("generated-code");
const camSection = document.getElementById("cam-section");
const camBtn = document.getElementById("cam-btn");
const camStatus = document.getElementById("cam-status");
const camSpinner = document.getElementById("cam-spinner");
const camStatusText = document.getElementById("cam-status-text");
const gcodeLink = document.getElementById("gcode-link");

let viewer = null;
let mode = "text"; // "text" | "image"
let lastStepPath = null;

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
  generatedCodeEl.textContent = "";
  camSection.hidden = true;
  camStatus.hidden = true;
  gcodeLink.hidden = true;
  lastStepPath = null;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function handleGenerate() {
  clearError();
  resetResult();

  let response;
  try {
    if (mode === "text") {
      const prompt = promptInput.value.trim();
      if (!prompt) {
        showError("Lütfen bir istek yazın.");
        return;
      }
      setLoading(true, "FreeCAD'de model oluşturuluyor, bu biraz zaman alabilir…");
      response = await fetch(`${API_BASE}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        body: JSON.stringify({ prompt }),
      });
    } else {
      const file = imageInput.files?.[0];
      if (!file) {
        showError("Lütfen bir teknik resim seçin.");
        return;
      }
      setLoading(true, "Teknik resim yorumlanıp model oluşturuluyor, bu biraz zaman alabilir…");
      const form = new FormData();
      form.append("image", file);
      if (imagePromptInput.value.trim()) {
        form.append("prompt", imagePromptInput.value.trim());
      }
      response = await fetch(`${API_BASE}/generate-from-image`, {
        method: "POST",
        headers: { "x-api-key": API_KEY },
        body: form,
      });
    }

    const data = await readJson(response);

    if (!response.ok) {
      showError(data?.error ?? `Sunucu hatası (HTTP ${response.status})`);
      if (data?.generatedCode) {
        resultSection.hidden = false;
        generatedCodeEl.textContent = data.generatedCode;
      }
      return;
    }

    if (!data) {
      showError("Sunucudan beklenmeyen bir yanıt alındı.");
      return;
    }

    showResult(data);
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
  if (data.pdfUrl) {
    pdfLink.href = data.pdfUrl;
    pdfLink.hidden = false;
  }
  if (data.generatedCode) {
    generatedCodeEl.textContent = data.generatedCode;
  }

  lastStepPath = data.stepPath ?? null;
  if (data.camSimple && lastStepPath) {
    camSection.hidden = false;
  }
}

async function handleCam() {
  if (!lastStepPath) return;
  camBtn.disabled = true;
  gcodeLink.hidden = true;
  camStatus.hidden = false;
  camSpinner.hidden = false;
  camStatusText.textContent = "CNC G-code üretiliyor…";

  try {
    const response = await fetch(`${API_BASE}/generate-cam`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
      body: JSON.stringify({ stepPath: lastStepPath }),
    });
    const data = await readJson(response);

    if (!response.ok) {
      camStatusText.textContent = data?.error ?? `Sunucu hatası (HTTP ${response.status})`;
      return;
    }
    if (data?.complex) {
      camStatusText.textContent = data.message ?? "Bu parça karmaşık, CAM asistanı yakında.";
      return;
    }
    camStatusText.textContent = "G-code hazır.";
    if (data?.gcodeUrl) {
      gcodeLink.href = data.gcodeUrl;
      gcodeLink.hidden = false;
    }
  } catch (err) {
    camStatusText.textContent = `Sunucuya bağlanılamadı: ${err.message}`;
  } finally {
    camSpinner.hidden = true;
    camBtn.disabled = false;
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
camBtn.addEventListener("click", handleCam);
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    handleGenerate();
  }
});
