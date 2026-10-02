/**
 * Mimari Cephe Stüdyosu.
 *
 * Kat planı / cephe görünüşünden parametrik bina modeli üretir, sonra
 * parametreleri DETERMİNİSTİK olarak düzenler: /param-edit yapay zekaya
 * gitmez, değeri üretilen kodun içinde doğrudan değiştirip FreeCAD'de
 * yeniden çalıştırır. Bu yüzden "pencere adedi 3 -> 2" dediğinizde kodun
 * geri kalanı birebir aynı kalır, cephe bozulmaz.
 *
 * CAD sayfasından (app.js) bağımsızdır; yalnızca viewer.js'i paylaşır.
 */

import { initViewer, loadStl } from "./viewer.js";

const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const authHeaders = () => ({ Authorization: `Bearer ${sessionToken}` });

const planInput = document.getElementById("plan-input");
const cepheInput = document.getElementById("cephe-input");
const gorselInput = document.getElementById("gorsel-input");
const promptInput = document.getElementById("arch-prompt");
const generateBtn = document.getElementById("arch-generate-btn");

const statusSection = document.getElementById("arch-status");
const statusText = document.getElementById("arch-status-text");
const errorSection = document.getElementById("arch-error");
const errorText = document.getElementById("arch-error-text");

const resultSection = document.getElementById("arch-result");
const viewerContainer = document.getElementById("arch-viewer");
const stepLink = document.getElementById("arch-step-link");
const stlLink = document.getElementById("arch-stl-link");
const warningEl = document.getElementById("arch-warning");
const paramsEl = document.getElementById("arch-params");
const codeEl = document.getElementById("arch-code");

const FILE_FIELDS = [
  { input: planInput, field: "plan", nameEl: document.getElementById("plan-name") },
  { input: cepheInput, field: "cephe", nameEl: document.getElementById("cephe-name") },
  { input: gorselInput, field: "gorsel", nameEl: document.getElementById("gorsel-name") },
];

let viewer = null;
let currentCode = "";
let currentProjectId = null;

// --- Yardimcilar -----------------------------------------------------------

const POLL_INTERVAL_MS = 1500;
// Mimari bir sayfa okuma + cok katli bir cephe uretimi, bir parcadan daha uzun
// surer; backend'in 3 denemeli kendi kendini duzeltme dongusu de buna eklenir.
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** POST -> { jobId }, sonra GET /jobs/:id ile kisa isteklerle bekle. */
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
  if (!jobId) return { ok: true, body: startData };

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (onTick) onTick(Math.round((Date.now() - startedAt) / 1000));

    let statusResp;
    let statusData;
    try {
      statusResp = await fetch(`${API_BASE}/jobs/${jobId}`, { headers: authHeaders() });
      statusData = await readJson(statusResp);
    } catch {
      continue; // gecici ag hatasi; beklemeye devam
    }
    if (statusResp.status === 404) return { error: "İş bulunamadı veya zaman aşımına uğradı." };
    if (!statusResp.ok || !statusData) continue;
    if (statusData.status === "pending") continue;
    if (statusData.status === "error") return { error: statusData.error ?? "İşlem başarısız oldu." };
    if (statusData.status === "done") {
      const { status, ok, ...body } = statusData;
      return { ok, body };
    }
  }
  return { error: "İşlem zaman aşımına uğradı." };
}

function showStatus(message) {
  statusText.textContent = message;
  statusSection.hidden = false;
}

function hideStatus() {
  statusSection.hidden = true;
}

function showError(message, extraHtml) {
  errorText.textContent = message;
  const prevNote = errorSection.querySelector(".arch-export-note");
  if (prevNote) prevNote.remove();
  if (extraHtml) {
    const note = document.createElement("p");
    note.className = "arch-export-note";
    note.textContent = extraHtml;
    errorSection.appendChild(note);
  }
  errorSection.hidden = false;
}

function clearError() {
  errorSection.hidden = true;
  errorText.textContent = "";
  errorSection.querySelector(".arch-export-note")?.remove();
}

// --- ROVER_PARAMS cozumleme (paramEditService.js'in aynasi) ---------------
// Backend ayni blogu kendisi de cozuyor; buradaki kopya yalnizca paneli
// cizmek icin, degisiklik her zaman /param-edit uzerinden deterministik
// olarak uygulanir.

const PARAMS_START = "# ROVER_PARAMS_START";
const PARAMS_END = "# ROVER_PARAMS_END";

function parseParams(code) {
  if (!code) return [];
  const lines = code.split("\n");
  const params = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === PARAMS_START) {
      inBlock = true;
      continue;
    }
    if (trimmed === PARAMS_END) break;
    if (!inBlock) continue;
    const match = trimmed.match(/^(\w+)\s*=\s*([\d.eE+-]+)\s*(?:#\s*(.*))?$/);
    if (match) {
      params.push({
        name: match[1],
        value: parseFloat(match[2]),
        unit: (match[3] || "mm").trim(),
      });
    }
  }
  return params;
}

const LABELS = {
  kat_sayisi: "Kat sayısı",
  kat_yuksekligi: "Kat yüksekliği",
  doseme_kalinligi: "Döşeme kalınlığı",
  cephe_genislik: "Cephe genişliği",
  bina_derinlik: "Bina derinliği",
  duvar_kalinligi: "Duvar kalınlığı",
  pencere_sayisi: "Pencere adedi (kat başına)",
  pencere_genislik: "Pencere genişliği",
  pencere_yukseklik: "Pencere yüksekliği",
  parapet_yuksekligi: "Parapet (denizlik) yüksekliği",
  kasa_genisligi: "Kasa genişliği",
  kasa_kalinligi: "Kasa kalınlığı",
  giris_kapisi: "Giriş kapısı",
  kapi_genislik: "Kapı genişliği",
  kapi_yukseklik: "Kapı yüksekliği",
};

function labelFor(name) {
  if (LABELS[name]) return LABELS[name];
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Panelde once kullanicinin en sik degistirdigi parametreler.
const PRIORITY = [
  "pencere_sayisi",
  "kat_sayisi",
  "pencere_genislik",
  "pencere_yukseklik",
  "kasa_genisligi",
  "kasa_kalinligi",
  "kat_yuksekligi",
  "parapet_yuksekligi",
  "cephe_genislik",
];

function sortParams(params) {
  return [...params].sort((a, b) => {
    const ia = PRIORITY.indexOf(a.name);
    const ib = PRIORITY.indexOf(b.name);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    }
    return a.name.localeCompare(b.name, "tr");
  });
}

// --- Parametre paneli ------------------------------------------------------

function renderParams(code) {
  const params = sortParams(parseParams(code));
  paramsEl.replaceChildren();

  if (!params.length) {
    const p = document.createElement("p");
    p.className = "arch-params-empty";
    p.textContent =
      "Bu modelde düzenlenebilir parametre bulunamadı. Model parametre bloğu olmadan " +
      "üretilmiş olabilir; yeniden oluşturmayı deneyin.";
    paramsEl.appendChild(p);
    return;
  }

  for (const param of params) {
    paramsEl.appendChild(buildParamRow(param));
  }
}

function buildParamRow(param) {
  const isCount = param.unit === "adet";

  const row = document.createElement("div");
  row.className = isCount ? "arch-param is-count" : "arch-param";

  const label = document.createElement("div");
  const name = document.createElement("div");
  name.className = "arch-param-name";
  name.textContent = labelFor(param.name);
  const unit = document.createElement("div");
  unit.className = "arch-param-unit";
  unit.textContent = `${param.name} · ${param.unit}`;
  label.append(name, unit);

  const inputWrap = document.createElement("div");
  inputWrap.className = "arch-param-input";

  const input = document.createElement("input");
  input.type = "number";
  input.value = String(param.value);
  if (isCount) {
    // Adet bir tam sayi: 2.5 pencere diye bir sey yok. Sayilar 1 adim,
    // olculer 10 mm adim ilerliyor.
    input.step = "1";
    input.min = "0";
  } else {
    input.step = "10";
    input.min = "0";
  }

  const dec = document.createElement("button");
  dec.type = "button";
  dec.className = "arch-step-btn";
  dec.textContent = "−";
  dec.title = "Azalt";

  const inc = document.createElement("button");
  inc.type = "button";
  inc.className = "arch-step-btn";
  inc.textContent = "+";
  inc.title = "Arttır";

  const stepBy = (delta) => {
    const step = isCount ? 1 : 10;
    const next = (Number(input.value) || 0) + delta * step;
    input.value = String(Math.max(0, isCount ? Math.round(next) : next));
  };
  dec.addEventListener("click", () => stepBy(-1));
  inc.addEventListener("click", () => stepBy(1));

  inputWrap.append(dec, input, inc);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "arch-apply-btn";
  apply.textContent = "Uygula";
  apply.addEventListener("click", () => {
    let value = Number(input.value);
    if (!Number.isFinite(value)) {
      showError("Geçerli bir sayı girin.");
      return;
    }
    if (isCount) {
      value = Math.round(value);
      input.value = String(value);
    }
    applyParam(param.name, value, row);
  });

  row.append(label, inputWrap, apply);
  return row;
}

async function applyParam(paramName, newValue, row) {
  clearError();
  row.classList.add("arch-param-busy");
  showStatus(`${labelFor(paramName)} = ${newValue} uygulanıyor…`);

  const result = await runAsyncJob(
    `${API_BASE}/param-edit`,
    {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        code: currentCode,
        paramName,
        newValue,
        projectId: currentProjectId,
        basePrompt: "Mimari cephe parametrik düzenleme",
      }),
    },
    (seconds) => showStatus(`${labelFor(paramName)} uygulanıyor… (${seconds} sn)`),
  );

  row.classList.remove("arch-param-busy");
  hideStatus();

  if (result.error || !result.ok) {
    showError(result.error ?? result.body?.error ?? "Parametre uygulanamadı.");
    return;
  }
  showResult(result.body);
}

// --- Sonuc ---------------------------------------------------------------

function showResult(body) {
  resultSection.hidden = false;

  if (!viewer) {
    // Bina olcegi: 12 m'lik bir cephe 12000 mm, sinir kurenin yaricapi ~10000
    // ve loadStl kamerayi radius*2.2'ye koyuyor. Varsayilan far=5000 /
    // maxDistance=4000 ile model tamamen kirpilirdi.
    viewer = initViewer(viewerContainer, { far: 400000, maxDistance: 200000 });
  }
  if (body.stlUrl) loadStl(viewer, body.stlUrl);

  if (body.stepUrl) {
    stepLink.href = body.stepUrl;
    stepLink.hidden = false;
  } else {
    stepLink.hidden = true;
  }
  if (body.stlUrl) {
    stlLink.href = body.stlUrl;
    stlLink.hidden = false;
  } else {
    stlLink.hidden = true;
  }

  if (body.warning) {
    warningEl.textContent = body.warning;
    warningEl.hidden = false;
  } else {
    warningEl.hidden = true;
  }

  if (body.generatedCode) {
    currentCode = body.generatedCode;
    codeEl.textContent = body.generatedCode;
    renderParams(body.generatedCode);
  }
  if (body.projectId) currentProjectId = body.projectId;
}

// --- Uretim --------------------------------------------------------------

async function handleGenerate() {
  clearError();

  const formData = new FormData();
  let fileCount = 0;
  for (const { input, field } of FILE_FIELDS) {
    for (const file of input.files ?? []) {
      formData.append(field, file);
      fileCount += 1;
    }
  }

  const prompt = promptInput.value.trim();
  if (!fileCount && !prompt) {
    showError(
      "En az bir kat planı/cephe dosyası yükleyin veya binayı yazılı olarak tarif edin.",
    );
    return;
  }
  if (prompt) formData.append("prompt", prompt);
  if (currentProjectId) formData.append("projectId", currentProjectId);

  generateBtn.disabled = true;
  showStatus("Çizimler okunuyor ve parametrik model kuruluyor…");

  const result = await runAsyncJob(
    `${API_BASE}/arch-facade`,
    { method: "POST", headers: authHeaders(), body: formData },
    (seconds) => showStatus(`Çizimler okunuyor ve model kuruluyor… (${seconds} sn)`),
  );

  generateBtn.disabled = false;
  hideStatus();

  if (result.error || !result.ok) {
    // DXF/DWG yuklendiginde backend ne yapilmasi gerektigini anlatiyor
    // (AutoCAD Architecture dosyalari icin EXPORTTOAUTOCAD gibi).
    const body = result.body ?? {};
    showError(
      result.error ?? body.error ?? "Model oluşturulamadı.",
      body.needsExport ? body.error : null,
    );
    return;
  }
  showResult(result.body);
}

// --- Baglantilar ---------------------------------------------------------

for (const { input, nameEl } of FILE_FIELDS) {
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    nameEl.textContent = files.length
      ? files.map((f) => f.name).join(", ")
      : "Dosya seçilmedi";
    input.closest(".arch-drop")?.classList.toggle("has-file", files.length > 0);
  });
}

generateBtn.addEventListener("click", handleGenerate);
