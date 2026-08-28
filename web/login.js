const API_BASE = location.hostname === "localhost" || location.hostname === "127.0.0.1" ? location.origin : "https://api.topkapikoleji.org";
let mode = "login";

const form = document.getElementById("auth-form");
const nameWrap = document.getElementById("name-wrap");
const submit = document.getElementById("submit");
const error = document.getElementById("auth-error");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const nameInput = document.getElementById("name");
const title = document.getElementById("auth-title");
const description = document.getElementById("auth-description");
const forgotPassword = document.getElementById("forgot-password");

function showMessage(message) {
  error.textContent = message;
  error.hidden = false;
}

const loginReason = new URLSearchParams(location.search).get("reason");
if (loginReason) {
  showMessage(loginReason);
  history.replaceState(null, "", location.pathname);
}

function setMode(next) {
  mode = next;
  const login = next === "login";
  document.getElementById("login-tab").classList.toggle("active", login);
  document.getElementById("login-tab").setAttribute("aria-selected", String(login));
  document.getElementById("register-tab").classList.toggle("active", !login);
  document.getElementById("register-tab").setAttribute("aria-selected", String(!login));
  nameWrap.hidden = login;
  nameInput.required = !login;
  passwordInput.autocomplete = login ? "current-password" : "new-password";
  forgotPassword.hidden = !login;
  title.textContent = login ? "Geleceğe Hoş Geldiniz" : "Üretmeye başlayın";
  description.textContent = login ? "" : "Birkaç saniye içinde ücretsiz hesabınızı oluşturun.";
  description.hidden = login;
  submit.querySelector("span").textContent = login ? "Giriş yap" : "Hesap oluştur";
  error.hidden = true;
}

document.getElementById("login-tab").onclick = () => setMode("login");
document.getElementById("register-tab").onclick = () => setMode("register");

const oauthParams = new URLSearchParams(location.hash.slice(1));
if (oauthParams.get("access_token")) {
  localStorage.setItem("rover_session", oauthParams.get("access_token"));
  if (oauthParams.get("refresh_token")) localStorage.setItem("rover_refresh", oauthParams.get("refresh_token"));
  history.replaceState(null, "", location.pathname);
  location.replace("index.html");
}

document.getElementById("google-login").onclick = async () => {
  error.hidden = true;
  try {
    const redirectTo = `${location.origin}${location.pathname}`;
    const r = await fetch(`${API_BASE}/auth/oauth/google?redirectTo=${encodeURIComponent(redirectTo)}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    location.href = data.url;
  } catch (err) {
    showMessage(err.message);
  }
};

forgotPassword.onclick = async () => {
  error.hidden = true;
  const email = emailInput.value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    showMessage("Şifre sıfırlama bağlantısı için önce e-posta adresinizi yazın.");
    emailInput.focus();
    return;
  }
  forgotPassword.disabled = true;
  try {
    const redirectTo = `${location.origin}${location.pathname}`;
    const response = await fetch(`${API_BASE}/auth/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, redirectTo }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Şifre sıfırlama e-postası gönderilemedi.");
    showMessage("Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.");
  } catch (err) {
    showMessage(err.message);
  } finally {
    forgotPassword.disabled = false;
  }
};

form.onsubmit = async (e) => {
  e.preventDefault();
  error.hidden = true;
  submit.disabled = true;
  try {
    const body = { email: emailInput.value, password: passwordInput.value, ...(mode === "register" ? { name: nameInput.value } : {}) };
    const r = await fetch(`${API_BASE}/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    if (data.emailVerificationRequired) {
      showMessage("Hesabınızı etkinleştirmek için e-posta adresinize gönderilen bağlantıyı açın.");
      return;
    }
    localStorage.setItem("rover_session", data.token);
    if (data.refreshToken) localStorage.setItem("rover_refresh", data.refreshToken);
    location.replace("index.html");
  } catch (err) {
    showMessage(err.message);
  } finally {
    submit.disabled = false;
  }
};
