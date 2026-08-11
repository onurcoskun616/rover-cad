const API_BASE = "https://api.topkapikoleji.org";
const token = localStorage.getItem("rover_session");
document.getElementById("logout-btn")?.addEventListener("click", () => {
  localStorage.removeItem("rover_session"); window.location.replace("login.html");
});
if (token) {
  fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.ok ? r.json() : Promise.reject())
    .then(({ user }) => { const link = document.getElementById("admin-link"); if (link) link.hidden = user.role !== "admin"; })
    .catch(() => { localStorage.removeItem("rover_session"); window.location.replace("login.html"); });
}
