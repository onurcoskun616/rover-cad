const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
const fmt = new Intl.NumberFormat("tr-TR");
const byId = (id) => document.getElementById(id);

const demoData = {
  user: { name: "Tahir Fırat", email: "ornek@mail.com", plan: "free", monthlyTokens: 50000, usedTokens: 7650, remainingTokens: 42350, createdAt: "2026-08-11" },
  projects: [
    { name: "Makine Parçası Tasarımı", detail: "3B model · 4 çıktı", updated: "12 dakika önce", status: "Devam ediyor", tone: "blue" },
    { name: "Atölye Yerleşim Planı", detail: "Teknik çizim · 2 çıktı", updated: "Dün, 18:42", status: "Tamamlandı", tone: "green" },
    { name: "Dişli Kutusu Revizyonu", detail: "3B model · 7 çıktı", updated: "8 Ağustos 2026", status: "Taslak", tone: "violet" }
  ],
  files: [
    { name: "makine-parcasi-v4.step", project: "Makine Parçası Tasarımı", type: "STEP", date: "Bugün, 14:32", icon: "3D" },
    { name: "atolye-plani.pdf", project: "Atölye Yerleşim Planı", type: "PDF", date: "Dün, 18:42", icon: "PDF" },
    { name: "disli-kutusu.nc", project: "Dişli Kutusu Revizyonu", type: "CNC", date: "8 Ağustos 2026", icon: "NC" }
  ]
};

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function render(data, isPreview = false) {
  const { user, projects = demoData.projects, files = demoData.files } = data;
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

  byId("project-list").innerHTML = projects.map((project) => `
    <article class="project-card">
      <div class="project-thumb ${safeText(project.tone)}"><span>◇</span></div>
      <div class="project-copy"><strong>${safeText(project.name)}</strong><span>${safeText(project.detail)}</span><small>${safeText(project.updated)}</small></div>
      <span class="project-status ${safeText(project.tone)}">${safeText(project.status)}</span>
      <button type="button" aria-label="${safeText(project.name)} projesini aç">→</button>
    </article>`).join("");

  byId("file-list").innerHTML = files.map((file) => `
    <tr><td><span class="file-icon">${safeText(file.icon)}</span><strong>${safeText(file.name)}</strong></td><td>${safeText(file.project)}</td><td><span class="file-type">${safeText(file.type)}</span></td><td>${safeText(file.date)}</td><td><button type="button" aria-label="${safeText(file.name)} dosyasını indir">↓</button></td></tr>`).join("");
}

async function loadDashboard() {
  if (!sessionToken) { render(demoData, true); return; }
  try {
    const headers = { Authorization: `Bearer ${sessionToken}` };
    const [meResponse, usageResponse] = await Promise.all([
      fetch(`${API_BASE}/auth/me`, { headers }),
      fetch(`${API_BASE}/auth/usage`, { headers })
    ]);
    if (!meResponse.ok) throw new Error("Oturum doğrulanamadı");
    const { user } = await meResponse.json();
    const usagePayload = usageResponse.ok ? await usageResponse.json() : { usage: [] };
    render({ user, usage: usagePayload.usage });
  } catch {
    render(demoData, true);
    byId("dashboard-notice").textContent = "API bağlantısı kurulamadı; tasarım önizleme verileriyle açıldı.";
  }
}

byId("logout-btn").addEventListener("click", () => {
  if (!sessionToken) { location.href = "login.html"; return; }
  localStorage.removeItem("rover_session");
  location.replace("login.html");
});

document.querySelectorAll("[data-demo-action]").forEach((button) => button.addEventListener("click", () => {
  byId("dashboard-notice").textContent = "Bu işlem API bağlantısı açıldığında etkinleşecek.";
}));

loadDashboard();
