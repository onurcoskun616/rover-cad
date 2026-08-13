const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const authHeaders = () => ({ Authorization: `Bearer ${sessionToken}` });

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
const tabSim = document.getElementById("tab-sim");
const panelSim = document.getElementById("panel-sim");
const simDemoBtn = document.getElementById("sim-demo-btn");
const simPromptInput = document.getElementById("sim-prompt-input");
const simGenerateBtn = document.getElementById("sim-generate-btn");
const simCodeInput = document.getElementById("sim-code-input");
const simRunBtn = document.getElementById("sim-run-btn");
const simUndoBtn = document.getElementById("sim-undo-btn");
const simStepIndicator = document.getElementById("sim-step-indicator");
const simDownloads = document.getElementById("sim-downloads");
const simDownloadParts = document.getElementById("sim-download-parts");
const simDownloadAssembly = document.getElementById("sim-download-assembly");
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
let lastProjectId = null;
let lastStlUrl = null;
let lastContourUrl = null;
let lastDimData = null;
let dimEditInProgress = false;
let dimEditQueue = [];
let kinSim = null;
let simCurrentCode = null;
let simCurrentKinematics = null;
let simCurrentPartsInline = null;
let simCurrentPartSteps = null;
let simCurrentAssemblyStep = null;
let simSessionId = null;
let simStepIndex = -1;
let simTotalSteps = 0;

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
  lastProjectId = null;
  lastDimData = null;
  dimEditInProgress = false;
  dimEditQueue = [];
  generatedCodeEl.textContent = "";
  camSection.hidden = true;
  lastStlUrl = null;
  lastContourUrl = null;
  resetKinSim();
  if (viewer) {
    import("./viewer.js").then(({ clearDimensions }) => clearDimensions(viewer)).catch(() => {});
  }
  lastStepPath = null;
}

function resetKinSim(keepContext) {
  if (kinSim) kinSim.pause();
  kinSim = null;
  kinSimView.hidden = true;
  kinSimPlay.textContent = "Oynat";
  kinSimProgress.value = "0";
  kinSimStatus.textContent = "Durum: Hazir";
  kinCollisionAlert.hidden = true;
  Object.values(kinSimSpeedBtns).forEach((b) => b.classList.remove("active"));
  if (kinSimSpeedBtns[1]) kinSimSpeedBtns[1].classList.add("active");
  simDownloads.hidden = true;
  simDownloadParts.innerHTML = "";
  simDownloadAssembly.hidden = true;
  if (!keepContext) {
    simCurrentCode = null;
    simCurrentKinematics = null;
    simCurrentPartsInline = null;
    simCurrentPartSteps = null;
    simCurrentAssemblyStep = null;
    simSessionId = null;
    simStepIndex = -1;
    simTotalSteps = 0;
  }
  updateSimStepUI();
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
        headers: authHeaders(),
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
      headers: { "Content-Type": "application/json", ...authHeaders() },
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
    options = { method: "POST", headers: authHeaders(), body: form };
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
    options = { method: "POST", headers: authHeaders(), body: form };
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
    lastStlUrl = data.stlUrl;
    loadStlPreview(data.stlUrl);
  } else if (data.contourUrl) {
    lastContourUrl = data.contourUrl;
    loadContourPreview(data.contourUrl);
  }
  if (data.generatedCode) {
    generatedCodeEl.textContent = data.generatedCode;
  }

  lastGeneratedCode = data.generatedCode ?? null;
  if (data.projectId) lastProjectId = data.projectId;
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
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          prompt: instruction,
          previousCode,
          basePrompt: base,
          projectId: lastProjectId,
        }),
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
        headers: { "Content-Type": "application/json", ...authHeaders() },
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
      headers: { "Content-Type": "application/json", ...authHeaders() },
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
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            code,
            paramName,
            newValue,
            projectId: lastProjectId,
            basePrompt: lastPrompt,
          }),
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
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            prompt: instruction,
            previousCode: code,
            basePrompt: lastPrompt,
            projectId: lastProjectId,
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
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(options?.headers || {}) },
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
camBtn.addEventListener("click", () => {
  if (!lastStepPath) return;
  sessionStorage.setItem("rover_cam_data", JSON.stringify({
    stepPath: lastStepPath,
    prompt: lastPrompt,
    projectId: lastProjectId,
    bbox: lastBbox,
    generatedCode: lastGeneratedCode,
    stlUrl: lastStlUrl,
    contourUrl: lastContourUrl,
  }));
  window.location.href = "cam.html";
});

// --- Kinematic simulation ---------------------------------------------------

function downloadBase64(filename, base64Data, mime) {
  const bin = atob(base64Data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showSimDownloads(partsInline, partSteps, assemblyStepBase64) {
  simCurrentPartsInline = partsInline;
  simCurrentPartSteps = partSteps || [];
  simCurrentAssemblyStep = assemblyStepBase64 || null;

  simDownloadParts.innerHTML = "";
  if (!partsInline?.length) {
    simDownloads.hidden = true;
    return;
  }

  const stepMap = {};
  for (const ps of simCurrentPartSteps) {
    stepMap[ps.name] = ps.stepBase64;
  }

  for (const part of partsInline) {
    const group = document.createElement("div");
    group.className = "sim-part-group";

    const nameEl = document.createElement("span");
    nameEl.className = "sim-part-name";
    nameEl.textContent = part.name;
    group.appendChild(nameEl);

    const btns = document.createElement("div");
    btns.className = "sim-part-btns";

    const stlBtn = document.createElement("button");
    stlBtn.type = "button";
    stlBtn.className = "secondary";
    stlBtn.textContent = "STL";
    stlBtn.addEventListener("click", () => {
      downloadBase64(`${part.name}.stl`, part.stlBase64, "model/stl");
    });
    btns.appendChild(stlBtn);

    if (stepMap[part.name]) {
      const stepBtn = document.createElement("button");
      stepBtn.type = "button";
      stepBtn.className = "secondary";
      stepBtn.textContent = "STEP";
      stepBtn.addEventListener("click", () => {
        downloadBase64(`${part.name}.step`, stepMap[part.name], "model/step");
      });
      btns.appendChild(stepBtn);
    }

    group.appendChild(btns);
    simDownloadParts.appendChild(group);
  }

  if (simCurrentAssemblyStep) {
    simDownloadAssembly.hidden = false;
  } else {
    simDownloadAssembly.hidden = true;
  }

  simDownloads.hidden = false;
}

function updateSimStepUI() {
  if (simStepIndex >= 0 && simTotalSteps > 0) {
    simStepIndicator.textContent = `Adim ${simStepIndex + 1} / ${simTotalSteps}`;
    simStepIndicator.hidden = false;
  } else {
    simStepIndicator.hidden = true;
  }
  simUndoBtn.hidden = simStepIndex <= 0;
}

async function handleSimUndo() {
  if (!simSessionId || simStepIndex <= 0) return;
  clearError();
  simUndoBtn.disabled = true;
  simUndoBtn.textContent = "Geri aliniyor…";
  try {
    const resp = await fetch(`${API_BASE}/simulate/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ sessionId: simSessionId }),
    });
    const data = await readJson(resp);
    if (!resp.ok || !data?.ok) {
      showError(data?.error ?? "Geri alma basarisiz.");
      return;
    }

    const { partsInline, kinematicsData, generatedCode, stepIndex, totalSteps } = data;
    simCurrentCode = generatedCode;
    simCurrentKinematics = kinematicsData;
    simStepIndex = stepIndex;
    simTotalSteps = totalSteps;
    if (generatedCode) simCodeInput.value = generatedCode;

    if (kinSim) kinSim.pause();
    kinSim = null;
    kinSimView.hidden = true;
    kinSimPlay.textContent = "Oynat";
    kinCollisionAlert.hidden = true;

    resultSection.hidden = false;
    const { initViewer } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);

    const { loadKinematicSim } = await import("./kinematicPlayer.js");
    kinSim = await loadKinematicSim(viewer, partsInline, kinematicsData, {
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
    showSimDownloads(partsInline, data.partSteps, data.assemblyStepBase64);
    updateSimStepUI();
    simGenerateBtn.textContent = simCurrentCode ? "Parcayi Ekle / Degistir" : "Mekanizma Olustur";
    simPromptInput.placeholder = simCurrentCode
      ? "Ornek: Bu diske X ekseninde hareket eden bir biyel kolu bagla"
      : "Ornek: Merkezde Z ekseninde donen 50mm capinda bir disk olustur";
    window.dispatchEvent(new Event("resize"));
  } catch (err) {
    showError(`Geri alma basarisiz: ${err.message}`);
  } finally {
    simUndoBtn.disabled = false;
    simUndoBtn.textContent = "Geri Al";
  }
}

async function handleSimDemo() {
  clearError();
  resetKinSim();
  simSessionId = crypto.randomUUID();
  simDemoBtn.disabled = true;
  simDemoBtn.textContent = "TopkapiAl'de olusturuluyor…";
  setLoading(true, "Simulasyon parcalari TopkapiAl'de olusturuluyor…");
  try {
    const result = await runAsyncJob(
      `${API_BASE}/simulate/demo`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ sessionId: simSessionId }),
      },
      (seconds) => {
        simDemoBtn.textContent = `TopkapiAl calisiyor… (${seconds} sn)`;
        setLoading(true, `Simulasyon parcalari olusturuluyor… (${seconds} sn)`);
      },
    );

    if (result.error || !result.ok) {
      showError(result.error ?? result.body?.error ?? "Simulasyon basarisiz.");
      simDemoBtn.textContent = "HATA - tekrar dene";
      return;
    }

    const { partsInline, partStlUrls, kinematicsData, kinematicsUrl } = result.body;
    let parts = partsInline || partStlUrls;
    if (!parts?.length) {
      showError("Simulasyon verisi eksik (STL yok).");
      simDemoBtn.textContent = "HATA - tekrar dene";
      return;
    }
    parts = parts.filter((p) => (p.stlBase64 && p.stlBase64.length > 0) || p.url);
    if (!parts.length) {
      showError("STL dosyalari bos veya bozuk.");
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
    resultSection.hidden = false;
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

    simCurrentKinematics = kinData;
    if (result.body.generatedCode) simCurrentCode = result.body.generatedCode;
    if (result.body.stepIndex != null) {
      simStepIndex = result.body.stepIndex;
      simTotalSteps = result.body.totalSteps;
    }
    kinSimView.hidden = false;
    kinSimPlay.textContent = "Oynat";
    kinCollisionAlert.hidden = true;
    setKinSimSpeed(1);
    showSimDownloads(parts, result.body.partSteps, result.body.assemblyStepBase64);
    updateSimStepUI();
    simDemoBtn.textContent = "Demo: Krank-Piston Simulasyonu";
    simGenerateBtn.textContent = "Parcayi Ekle / Degistir";
    simPromptInput.placeholder = "Ornek: Pistona bir yay ekle veya krank hizini artir";
    window.dispatchEvent(new Event("resize"));
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

async function handleSimGenerate() {
  const prompt = simPromptInput.value.trim();
  if (!prompt) {
    showError("Lutfen bir mekanizma tarifi yazin.");
    return;
  }
  clearError();
  resetKinSim(true);
  if (!simSessionId) simSessionId = crypto.randomUUID();
  simGenerateBtn.disabled = true;
  simGenerateBtn.textContent = "Kod uretiliyor…";
  setLoading(true, "Yapay zeka mekanizma kodu uretiyor…");
  try {
    const result = await runAsyncJob(
      `${API_BASE}/simulate/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          prompt,
          previousCode: simCurrentCode || undefined,
          previousKinematics: simCurrentKinematics || undefined,
          sessionId: simSessionId,
        }),
      },
      (seconds) => {
        const phase = seconds < 20 ? "Kod uretiliyor" : seconds < 60 ? "TopkapiAl calistiriliyor" : "Islem devam ediyor";
        simGenerateBtn.textContent = `${phase}… (${seconds} sn)`;
        setLoading(true, `${phase}… (${seconds} sn)`);
      },
    );

    if (result.error || !result.ok) {
      showError(result.error ?? result.body?.error ?? "Simulasyon basarisiz.");
      if (result.body?.generatedCode) {
        simCodeInput.value = result.body.generatedCode;
      }
      simGenerateBtn.textContent = "Mekanizma Olustur";
      return;
    }

    let { partsInline, kinematicsData, generatedCode } = result.body;
    if (!partsInline?.length) {
      showError("Simulasyon verisi eksik (STL yok).");
      simGenerateBtn.textContent = "Mekanizma Olustur";
      return;
    }
    partsInline = partsInline.filter((p) => p.stlBase64 && p.stlBase64.length > 0);
    if (!partsInline.length) {
      showError("STL dosyalari bos veya bozuk.");
      simGenerateBtn.textContent = "Mekanizma Olustur";
      return;
    }
    if (!kinematicsData) {
      showError("Kinematik veri alinamadi.");
      simGenerateBtn.textContent = "Mekanizma Olustur";
      return;
    }

    simCurrentCode = generatedCode;
    simCurrentKinematics = kinematicsData;
    if (generatedCode) simCodeInput.value = generatedCode;

    simGenerateBtn.textContent = "3D sahne hazirlaniyor…";
    resultSection.hidden = false;
    const { initViewer } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);

    simGenerateBtn.textContent = "STL parcalar yukleniyor…";
    const { loadKinematicSim } = await import("./kinematicPlayer.js");
    kinSim = await loadKinematicSim(viewer, partsInline, kinematicsData, {
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

    if (result.body.stepIndex != null) {
      simStepIndex = result.body.stepIndex;
      simTotalSteps = result.body.totalSteps;
    }
    kinSimView.hidden = false;
    kinSimPlay.textContent = "Oynat";
    kinCollisionAlert.hidden = true;
    setKinSimSpeed(1);
    showSimDownloads(partsInline, result.body.partSteps, result.body.assemblyStepBase64);
    updateSimStepUI();
    simGenerateBtn.textContent = simCurrentCode ? "Parcayi Ekle / Degistir" : "Mekanizma Olustur";
    simPromptInput.value = "";
    simPromptInput.placeholder = simCurrentCode
      ? "Ornek: Bu diske X ekseninde hareket eden bir biyel kolu bagla"
      : simPromptInput.placeholder;
    window.dispatchEvent(new Event("resize"));
  } catch (err) {
    showError(`Simulasyon basarisiz: ${err.message}`);
    simGenerateBtn.textContent = "Mekanizma Olustur";
  } finally {
    setLoading(false);
    simGenerateBtn.disabled = false;
  }
}

simGenerateBtn.addEventListener("click", handleSimGenerate);
simUndoBtn.addEventListener("click", handleSimUndo);
simDownloadAssembly.addEventListener("click", () => {
  if (simCurrentAssemblyStep) {
    downloadBase64("assembly.step", simCurrentAssemblyStep, "model/step");
  }
});

async function handleSimCustom() {
  const code = simCodeInput.value.trim();
  if (!code) {
    showError("Lutfen bir TopkapiAl Python scripti yazin.");
    return;
  }
  clearError();
  resetKinSim();
  simRunBtn.disabled = true;
  simRunBtn.textContent = "TopkapiAl'de calistiriliyor…";
  setLoading(true, "Simulasyon scripti TopkapiAl'de calistiriliyor…");
  try {
    const result = await runAsyncJob(
      `${API_BASE}/simulate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ code }),
      },
      (seconds) => {
        simRunBtn.textContent = `TopkapiAl calisiyor… (${seconds} sn)`;
        setLoading(true, `Simulasyon calistiriliyor… (${seconds} sn)`);
      },
    );

    if (result.error || !result.ok) {
      showError(result.error ?? result.body?.error ?? "Simulasyon basarisiz.");
      simRunBtn.textContent = "Simulasyonu Calistir";
      return;
    }

    const { partsInline, partStlUrls, kinematicsData, kinematicsUrl } = result.body;
    let parts = partsInline || partStlUrls;
    if (!parts?.length) {
      showError("Simulasyon verisi eksik (STL yok).");
      simRunBtn.textContent = "Simulasyonu Calistir";
      return;
    }
    parts = parts.filter((p) => (p.stlBase64 && p.stlBase64.length > 0) || p.url);
    if (!parts.length) {
      showError("STL dosyalari bos veya bozuk.");
      simRunBtn.textContent = "Simulasyonu Calistir";
      return;
    }

    let kinData = kinematicsData;
    if (!kinData && kinematicsUrl) {
      simRunBtn.textContent = "Kinematik veri yukleniyor…";
      const kinResp = await fetch(kinematicsUrl);
      kinData = await kinResp.json();
    }
    if (!kinData) {
      showError("Kinematik veri alinamadi.");
      simRunBtn.textContent = "Simulasyonu Calistir";
      return;
    }

    simRunBtn.textContent = "3D sahne hazirlaniyor…";
    resultSection.hidden = false;
    const { initViewer } = await import("./viewer.js");
    if (!viewer) viewer = initViewer(viewerContainer);

    simRunBtn.textContent = "STL parcalar yukleniyor…";
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
    showSimDownloads(parts, result.body.partSteps, result.body.assemblyStepBase64);
    simRunBtn.textContent = "Simulasyonu Calistir";
    window.dispatchEvent(new Event("resize"));
  } catch (err) {
    showError(`Simulasyon basarisiz: ${err.message}`);
    simRunBtn.textContent = "Simulasyonu Calistir";
  } finally {
    setLoading(false);
    simRunBtn.disabled = false;
  }
}

simRunBtn.addEventListener("click", handleSimCustom);

kinSimPlay.addEventListener("click", () => {
  if (!kinSim) return;
  const cncKinStatus = document.getElementById("cnc-kin-status");
  if (kinSim.isPlaying()) {
    kinSim.pause();
    kinSimPlay.textContent = "▶ Oynat";
    if (cncKinStatus) { cncKinStatus.textContent = "Duraklatıldı"; cncKinStatus.style.color = "#f0c040"; }
  } else {
    if (!kinCollisionAlert.hidden) {
      kinSim.reset();
      kinCollisionAlert.hidden = true;
    }
    kinSim.play();
    kinSimPlay.textContent = "⏸ Duraklat";
    if (cncKinStatus) { cncKinStatus.textContent = "Çalışıyor"; cncKinStatus.style.color = "#3ddc84"; }
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
