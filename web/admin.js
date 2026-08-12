const API_BASE = "https://api.topkapikoleji.org";
const sessionToken = localStorage.getItem("rover_session");
const fmt = new Intl.NumberFormat("tr-TR");
const byId = (id) => document.getElementById(id);

const demoData = {
  stats: { users: 1284, activeUsers: 1168, monthlyTokensUsed: 1846250, files: 7432 },
  usage: [
    { feature: "POST /generate", provider: "claude", model: "sonnet", calls: 184, inputTokens: 428000, outputTokens: 196000, cacheReadTokens: 82000, cacheWriteTokens: 12000, totalTokens: 718000, costUsd: 8.42 },
    { feature: "POST /cam-confirm", provider: "claude", model: "sonnet", calls: 96, inputTokens: 241000, outputTokens: 132000, cacheReadTokens: 45000, cacheWriteTokens: 8000, totalTokens: 426000, costUsd: 5.13 },
    { feature: "POST /simulate/generate", provider: "openai", model: "gpt-4o", calls: 72, inputTokens: 181000, outputTokens: 94000, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 275000, costUsd: 3.67 }
  ],
  users: [
    { id: "1", name: "Tahir Fırat", email: "tahir@topkapikoleji.org", plan: "pro", usedTokens: 38240, monthlyTokens: 100000, bonusTokens: 20000, status: "active", initials: "TF" },
    { id: "2", name: "Ecem Şuekinci", email: "ecem@topkapikoleji.org", plan: "free", usedTokens: 7650, monthlyTokens: 50000, bonusTokens: 0, status: "active", initials: "EŞ" },
    { id: "3", name: "Mehmet Yılmaz", email: "mehmet@example.com", plan: "free", usedTokens: 42100, monthlyTokens: 50000, bonusTokens: 5000, status: "active", initials: "MY" },
    { id: "4", name: "Selin Kaya", email: "selin@example.com", plan: "pro", usedTokens: 89120, monthlyTokens: 150000, bonusTokens: 0, status: "active", initials: "SK" },
    { id: "5", name: "Ahmet Demir", email: "ahmet@example.com", plan: "free", usedTokens: 12800, monthlyTokens: 50000, bonusTokens: 0, status: "blocked", initials: "AD" }
  ],
  activity: [
    { icon: "＋", title: "Yeni kullanıcı kaydı", detail: "Ecem Şuekinci ücretsiz planla katıldı", time: "8 dakika önce", tone: "blue" },
    { icon: "↗", title: "Token kotası güncellendi", detail: "Selin Kaya · 150.000 token", time: "34 dakika önce", tone: "green" },
    { icon: "◇", title: "Yeni proje oluşturuldu", detail: "Makine Parçası Tasarımı", time: "1 saat önce", tone: "violet" },
    { icon: "!", title: "Hesap erişimi durduruldu", detail: "Ahmet Demir", time: "Dün, 18:20", tone: "orange" }
  ]
};

let allUsers = [];
let previewMode = false;

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function renderStats(stats) {
  const items = [
    ["Toplam kullanıcı", fmt.format(stats.users), "+%8 bu ay", "users"],
    ["Aktif kullanıcı", fmt.format(stats.activeUsers), `%${Math.round((stats.activeUsers / stats.users) * 100)} aktif`, "active"],
    ["Bu ay kullanılan", fmt.format(stats.monthlyTokensUsed), "token", "tokens"],
    ["Oluşturulan dosya", fmt.format(stats.files || 0), "+342 bu ay", "files"]
  ];
  byId("stats").innerHTML = items.map(([label, value, note, tone]) => `<article><div class="admin-metric-icon ${tone}">${tone === "users" ? "◎" : tone === "active" ? "✓" : tone === "tokens" ? "↗" : "▤"}</div><div><span>${label}</span><strong>${value}</strong><small>${note}</small></div></article>`).join("");
}

function renderUsage(items = []) {
  const featureNames = { "/generate": "CAD model üretimi", "/generate-from-image": "Resimden CAD", "/revise": "CAD revizyonu", "/cam-confirm": "CAM / CNC üretimi", "/simulate/generate": "Simülasyon üretimi" };
  byId("llm-usage-list").innerHTML = items.length ? items.map((item) => {
    const path = String(item.feature).replace(/^POST\s+/, "");
    return `<tr><td><strong>${safeText(featureNames[path] || path)}</strong><small>${safeText(item.provider)}</small></td><td>${safeText(item.model)}</td><td>${fmt.format(item.calls)}</td><td>${fmt.format(item.inputTokens)}</td><td>${fmt.format(item.outputTokens)}</td><td>${fmt.format((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))}</td><td><b>${fmt.format(item.totalTokens)}</b></td><td>$${Number(item.costUsd || 0).toFixed(2)}</td></tr>`;
  }).join("") : '<tr><td colspan="8">Henüz ölçülmüş LLM kullanımı bulunmuyor.</td></tr>';
}

function filteredUsers() {
  const query = byId("search").value.trim().toLocaleLowerCase("tr-TR");
  const status = byId("status-filter").value;
  const plan = byId("plan-filter").value;
  return allUsers.filter((user) => `${user.name} ${user.email}`.toLocaleLowerCase("tr-TR").includes(query) && (status === "all" || user.status === status) && (plan === "all" || user.plan === plan));
}

function renderUsers() {
  const users = filteredUsers();
  byId("user-count").textContent = `${fmt.format(allUsers.length)} kayıtlı kullanıcı`;
  byId("result-summary").textContent = users.length ? `${users.length} kullanıcı gösteriliyor` : "Sonuç bulunamadı";
  byId("users-list").innerHTML = users.map((user) => {
    const totalLimit = Number(user.monthlyTokens) + Number(user.bonusTokens || 0);
    const rate = totalLimit ? Math.min(100, Math.round((user.usedTokens / totalLimit) * 100)) : 0;
    return `<tr data-user-id="${safeText(user.id)}">
      <td><div class="admin-user-cell"><span>${safeText(user.initials || user.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join(""))}</span><div><strong>${safeText(user.name)}</strong><small>${safeText(user.email)}</small></div></div></td>
      <td><select class="admin-inline-select" data-field="plan"><option value="free" ${user.plan === "free" ? "selected" : ""}>Ücretsiz</option><option value="pro" ${user.plan === "pro" ? "selected" : ""}>Pro</option></select></td>
      <td><div class="admin-usage-cell"><span><b>${fmt.format(user.usedTokens)}</b> / ${fmt.format(totalLimit)}</span><i><em style="width:${rate}%"></em></i></div></td>
      <td><select class="admin-inline-select status-${safeText(user.status)}" data-field="status"><option value="active" ${user.status === "active" ? "selected" : ""}>Aktif</option><option value="blocked" ${user.status === "blocked" ? "selected" : ""}>Engelli</option></select></td>
      <td><input class="admin-quota-input" data-field="monthlyTokens" type="number" min="0" step="1000" value="${Number(user.monthlyTokens)}" aria-label="${safeText(user.name)} aylık token kotası"></td>
      <td><div class="admin-bonus-cell"><span>${fmt.format(user.bonusTokens || 0)}</span><button class="admin-grant-btn" data-grant="${safeText(user.id)}" type="button">+ Token ver</button></div></td>
      <td><button class="admin-save-btn" data-save="${safeText(user.id)}" type="button">Kaydet</button></td>
    </tr>`;
  }).join("");
}

function renderActivity(items) {
  byId("activity-list").innerHTML = items.map((item) => `<div class="admin-activity"><span class="${safeText(item.tone)}">${safeText(item.icon)}</span><div><strong>${safeText(item.title)}</strong><small>${safeText(item.detail)}</small></div><time>${safeText(item.time)}</time></div>`).join("");
}

function render(data, isPreview) {
  previewMode = isPreview;
  allUsers = data.users;
  renderStats(data.stats);
  renderUsage(data.usage);
  renderUsers();
  renderActivity(data.activity || demoData.activity);
  byId("preview-banner").hidden = !isPreview;
}

async function loadAdmin() {
  if (!sessionToken) { render(demoData, true); return; }
  try {
    const headers = { Authorization: `Bearer ${sessionToken}` };
    const [statsResponse, usersResponse, usageResponse] = await Promise.all([fetch(`${API_BASE}/admin/stats`, { headers }), fetch(`${API_BASE}/admin/users`, { headers }), fetch(`${API_BASE}/admin/usage-summary?days=31`, { headers })]);
    if (statsResponse.status === 403) throw new Error("Bu hesapta yönetici yetkisi bulunmuyor.");
    if (!statsResponse.ok || !usersResponse.ok) throw new Error("Yönetim verileri alınamadı.");
    const stats = await statsResponse.json();
    const usersPayload = await usersResponse.json();
    const usagePayload = usageResponse.ok ? await usageResponse.json() : { usage: [] };
    render({ stats, users: usersPayload.users, usage: usagePayload.usage, activity: [] }, false);
  } catch (error) {
    render(demoData, true);
    byId("admin-notice").textContent = `${error.message} Örnek verilerle önizleme açıldı.`;
  }
}

["search", "status-filter", "plan-filter"].forEach((id) => byId(id).addEventListener(id === "search" ? "input" : "change", renderUsers));

byId("users-list").addEventListener("click", async (event) => {
  const id = event.target.dataset.save;
  if (!id) return;
  const row = event.target.closest("tr");
  const body = {};
  row.querySelectorAll("[data-field]").forEach((field) => { body[field.dataset.field] = field.type === "number" ? Number(field.value) : field.value; });
  if (!previewMode) {
    const response = await fetch(`${API_BASE}/admin/users/${id}`, { method: "PATCH", headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) { byId("admin-notice").textContent = "Değişiklik kaydedilemedi."; return; }
  }
  const user = allUsers.find((item) => String(item.id) === String(id));
  if (user) Object.assign(user, body);
  event.target.textContent = "Kaydedildi";
  byId("admin-notice").textContent = previewMode ? "Değişiklik yalnızca önizleme verisine uygulandı." : "Kullanıcı güncellendi.";
  setTimeout(() => { event.target.textContent = "Kaydet"; renderUsers(); }, 1000);
});

byId("users-list").addEventListener("click", async (event) => {
  const userId = event.target.dataset.grant;
  if (!userId) return;
  const user = allUsers.find((u) => String(u.id) === String(userId));
  const input = prompt(`${user ? user.name + " kullanıcısına" : "Kullanıcıya"} kaç bonus token eklemek istiyorsunuz?`, "10000");
  if (!input) return;
  const amount = Number(input);
  if (!amount || amount <= 0) { byId("admin-notice").textContent = "Geçerli bir token miktarı giriniz."; return; }
  if (previewMode) {
    if (user) user.bonusTokens = (user.bonusTokens || 0) + amount;
    renderUsers();
    byId("admin-notice").textContent = `Önizleme: ${fmt.format(amount)} bonus token eklendi.`;
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/admin/users/${userId}/grant-tokens`, {
      method: "POST", headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount }),
    });
    if (!response.ok) { byId("admin-notice").textContent = "Token eklenemedi."; return; }
    const data = await response.json();
    const idx = allUsers.findIndex((u) => String(u.id) === String(userId));
    if (idx >= 0 && data.user) allUsers[idx] = data.user;
    renderUsers();
    byId("admin-notice").textContent = `${fmt.format(amount)} bonus token başarıyla eklendi.`;
  } catch { byId("admin-notice").textContent = "Token eklenirken hata oluştu."; }
});

document.querySelectorAll("[data-admin-action]").forEach((button) => button.addEventListener("click", () => {
  const action = button.dataset.adminAction;
  if (action === "tokens") { document.getElementById("users").scrollIntoView({ behavior: "smooth" }); return; }
  byId("admin-notice").textContent = "Bu yönetim işlemi API bağlantısı açıldığında etkinleşecek.";
}));

byId("logout-btn").addEventListener("click", () => { localStorage.removeItem("rover_session"); location.replace("login.html"); });
loadAdmin();
