const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
if (!sessionToken) window.location.replace("login.html");
const fmt = new Intl.NumberFormat("tr-TR");
const byId = (id) => document.getElementById(id);

const demoData = {
  user: { name: "Tahir Fırat", email: "ornek@mail.com", plan: "free", monthlyTokens: 50000, usedTokens: 7650, remainingTokens: 42350, createdAt: "2026-08-11" },
  usage: [
    { action: "Çapı 30mm, yüksekliği 50mm olan silindir", tokens: 3516, createdAt: new Date().toISOString() },
    { action: "Makine parçası üzerinde delik revizyonu", tokens: 3335, createdAt: new Date(Date.now() - 75 * 60 * 1000).toISOString() },
  ],
  projects: [
    { id: "demo-1", name: "Silindir tasarımı", prompt: "Çapı 30mm, yüksekliği 50mm olan bir silindir oluştur", operationLabel: "Metinden CAD", updatedAt: new Date().toISOString(), versionCount: 1, files: [] },
    { id: "demo-2", name: "Atölye yerleşim planı", prompt: "Atölye için yerleşim planı hazırla", operationLabel: "Teknik çizim", updatedAt: "2026-08-11T15:42:00.000Z", versionCount: 2, files: [] },
    { id: "demo-3", name: "Dişli kutusu revizyonu", prompt: "Dişli kutusu gövdesini revize et", operationLabel: "Revizyon", updatedAt: "2026-08-08T12:00:00.000Z", versionCount: 3, files: [] },
  ],
  files: [
    { name: "model.step", projectName: "Silindir tasarımı", type: "step", createdAt: new Date().toISOString(), url: "#" },
    { name: "preview.stl", projectName: "Silindir tasarımı", type: "stl", createdAt: new Date().toISOString(), url: "#" },
    { name: "model.py", projectName: "Silindir tasarımı", type: "source", createdAt: new Date().toISOString(), url: "#" },
  ],
};

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function shortText(value, max = 72) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function formatDate(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function actionLabel(action) {
  const text = String(action ?? "").replace(/\s+/g, " ").trim();
  const known = {
    "POST /generate": "CAD model üretimi",
    "POST /generate-from-image": "Teknik resimden CAD",
    "POST /revise": "Tasarım revizyonu",
    "POST /simulate/generate": "Simülasyon üretimi",
    "POST /cam-confirm": "CAM / CNC çıktısı",
  };
  return shortText(known[text] || text || "CAD işlemi", 88);
}

function fileTypeLabel(type) {
  return {
    step: "STEP",
    stl: "STL",
    source: "PY",
    pdf: "PDF",
    gcode: "CNC",
  }[String(type ?? "").toLowerCase()] || String(type || "DOSYA").toUpperCase();
}

function apiUrl(pathOrUrl) {
  const value = String(pathOrUrl || "");
  if (/^https?:\/\//i.test(value)) return value;
  return `${API_BASE}${value.startsWith("/") ? "" : "/"}${value}`;
}

function renderActivity(usage = []) {
  const list = usage.slice(0, 8);
  byId("activity-list").innerHTML = list.length ? list.map((item) => `
    <article class="activity-item">
      <div>
        <strong>${safeText(actionLabel(item.action))}</strong>
        <span>${safeText(formatDate(item.createdAt))}</span>
      </div>
      <b>-${safeText(fmt.format(Math.abs(Number(item.tokens) || Number(item.totalTokens) || 0)))}</b>
    </article>`).join("") : `<p class="empty-state">Henüz kayıtlı işlem yok.</p>`;
}

function renderProjects(projects = []) {
  const list = projects.slice(0, 6);
  byId("project-list").innerHTML = list.length ? list.map((project, index) => {
    const tone = ["blue", "green", "violet"][index % 3];
    const href = project.id ? `index.html?projectId=${encodeURIComponent(project.id)}` : "index.html";
    return `
      <article class="project-card">
        <div class="project-thumb ${tone}"><span>◇</span></div>
        <div class="project-copy">
          <strong>${safeText(shortText(project.name || project.prompt || "Adsız proje", 44))}</strong>
          <span>${safeText(shortText(project.prompt || project.operationLabel || "Kayıtlı CAD çalışması", 68))}</span>
          <small>${safeText(project.operationLabel || "CAD")} · ${safeText(project.versionCount || 1)} sürüm · ${safeText(formatDate(project.updatedAt))}</small>
        </div>
        <span class="project-status ${tone}">Devam et</span>
        <a class="project-open" href="${safeText(href)}" aria-label="${safeText(project.name)} projesini aç">→</a>
      </article>`;
  }).join("") : `<p class="empty-state">Başarılı tasarımlarınız burada proje olarak kaydedilecek.</p>`;
}

function renderFiles(files = []) {
  const list = files.slice(0, 60);
  byId("file-list").innerHTML = list.length ? list.map((file) => {
    const type = fileTypeLabel(file.type);
    const href = file.url ? apiUrl(file.url) : "#";
    const version = file.versionNumber ? `v${String(file.versionNumber).padStart(3, "0")}` : (file.versionId || "");
    return `
      <tr>
        <td><span class="file-icon">${safeText(type)}</span><strong>${safeText(file.name)}</strong></td>
        <td>${safeText(shortText(file.projectName || "Kayıtlı proje", 42))}<small>${safeText(version)} ${safeText(file.operationLabel || "")}</small></td>
        <td><span class="file-type">${safeText(type)}</span></td>
        <td>${safeText(formatDate(file.createdAt))}</td>
        <td><a class="file-download" href="${safeText(href)}" data-url="${safeText(href)}" data-name="${safeText(file.name)}" aria-label="${safeText(file.name)} dosyasını indir">↓</a></td>
      </tr>`;
  }).join("") : `<tr><td colspan="5"><p class="empty-state">Başarılı tasarımların STEP, STL ve kaynak dosyaları burada saklanacak.</p></td></tr>`;
}

function render(data, isPreview = false) {
  const { user, usage = [], projects = [], files = [] } = data;
  const rate = user.monthlyTokens ? Math.min(100, Math.round((user.usedTokens / user.monthlyTokens) * 100)) : 0;
  const initials = user.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  byId("welcome").textContent = `Geleceğe hoş geldiniz, ${user.name.split(" ")[0]}`;
  byId("user-name").textContent = user.name;
  byId("avatar").textContent = initials;
  byId("email").textContent = user.email;
  byId("plan").textContent = user.plan === "free" ? "Ücretsiz" : "Pro";
  byId("user-plan").textContent = `${user.plan === "free" ? "Ücretsiz" : "Pro"} plan`;
  byId("quota").textContent = fmt.format(user.monthlyTokens);
  byId("used").textContent = fmt.format(user.usedTokens);
  byId("remaining").textContent = fmt.format(user.remainingTokens);
  byId("usage-rate").textContent = `%${rate}`;
  byId("progress").style.width = `${rate}%`;
  byId("period").textContent = new Date().toLocaleDateString("tr-TR", { month: "long", year: "numeric" });
  byId("member-since").textContent = new Date(user.createdAt || Date.now()).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
  const renewal = new Date(); renewal.setMonth(renewal.getMonth() + 1, 1);
  byId("renewal").textContent = renewal.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
  byId("preview-banner").hidden = !isPreview;
  renderActivity(usage);
  renderProjects(projects);
  renderFiles(files);
}

async function loadDashboard() {
  try {
    const headers = { Authorization: `Bearer ${sessionToken}` };
    const [meResponse, usageResponse, projectsResponse, filesResponse] = await Promise.all([
      fetch(`${API_BASE}/auth/me`, { headers }),
      fetch(`${API_BASE}/auth/usage`, { headers }),
      fetch(`${API_BASE}/auth/projects`, { headers }),
      fetch(`${API_BASE}/auth/files`, { headers }),
    ]);
    if (!meResponse.ok) throw new Error("Oturum doğrulanamadı");
    const { user } = await meResponse.json();
    const usagePayload = usageResponse.ok ? await usageResponse.json() : { usage: [] };
    const projectsPayload = projectsResponse.ok ? await projectsResponse.json() : { projects: [] };
    const filesPayload = filesResponse.ok ? await filesResponse.json() : { files: [] };
    render({
      user,
      usage: usagePayload.usage ?? [],
      projects: projectsPayload.projects ?? [],
      files: filesPayload.files ?? [],
    });
  } catch {
    render({
      ...demoData,
      usage: [],
      projects: [],
      files: [],
    }, false);
    byId("dashboard-notice").textContent = "Veriler şu anda alınamadı. Lütfen sayfayı yenileyin.";
  }
}

byId("logout-btn").addEventListener("click", () => {
  if (!sessionToken) { location.href = "login.html"; return; }
  localStorage.removeItem("rover_session");
  location.replace("login.html");
});

document.querySelectorAll("[data-demo-action]").forEach((button) => button.addEventListener("click", () => {
  const firstProject = document.querySelector(".project-open");
  if (button.dataset.demoAction === "upload") {
    location.href = "index.html?mode=image";
    return;
  }
  if (button.dataset.demoAction === "history" && firstProject) {
    firstProject.click();
    return;
  }
  if (button.dataset.demoAction === "account") {
    document.getElementById("account")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  byId("dashboard-notice").textContent = "İlgili bölüm açıldı.";
}));

byId("file-list").addEventListener("click", async (event) => {
  const link = event.target.closest(".file-download");
  if (!link) return;
  event.preventDefault();
  if (!link.dataset.url || link.dataset.url === "#") return;
  try {
    byId("dashboard-notice").textContent = "Dosya hazırlanıyor…";
    const response = await fetch(link.dataset.url, { headers: { Authorization: `Bearer ${sessionToken}` } });
    if (!response.ok) throw new Error("Dosya indirilemedi");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = link.dataset.name || "topkapi-ai-dosya";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    byId("dashboard-notice").textContent = "Dosya indirildi.";
  } catch (error) {
    byId("dashboard-notice").textContent = error.message || "Dosya indirilemedi.";
  }
});

loadDashboard();
