const API_URL = "https://api.topkapikoleji.org/generate";
// NOTE: shipped in a public static site, so this is not a real secret -- it
// only keeps casual/automated traffic off the endpoint, not a determined
// attacker (anyone can read it via view-source). Must match API_KEY in the
// backend's .env.
const API_KEY = "1d48ec585a4b306db72a23be0b7ce8f56618c1275a3ea5efcee96df1106712f1";

const promptInput = document.getElementById("prompt-input");
const generateBtn = document.getElementById("generate-btn");
const statusSection = document.getElementById("status-section");
const spinner = document.getElementById("spinner");
const statusText = document.getElementById("status-text");
const errorSection = document.getElementById("error-section");
const errorText = document.getElementById("error-text");
const resultSection = document.getElementById("result-section");
const stepLink = document.getElementById("step-link");
const stlLink = document.getElementById("stl-link");
const viewerContainer = document.getElementById("viewer-container");
const generatedCodeEl = document.getElementById("generated-code");

let viewer = null;

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
  stepLink.hidden = true;
  stlLink.hidden = true;
  generatedCodeEl.textContent = "";
}

async function handleGenerate() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    showError("Lütfen bir istek yazın.");
    return;
  }

  clearError();
  resetResult();
  setLoading(true, "FreeCAD'de model oluşturuluyor, bu biraz zaman alabilir…");

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      body: JSON.stringify({ prompt }),
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Response body wasn't JSON (e.g. a gateway error page); handled below.
    }

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
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    handleGenerate();
  }
});
