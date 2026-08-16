# Rover CAD — Yapay Zeka Destekli CAD & CNC Simülasyon Platformu

Topkapı Okulları tarafından geliştirilen, doğal dil komutlarıyla 3D model oluşturma, CNC G-code üretimi ve gerçek zamanlı tezgah simülasyonu sağlayan eğitim amaçlı web platformu.

**Canlı Site:** [topkapikoleji.org](https://topkapikoleji.org)

---

## Genel Bakış

Rover CAD iki ana modülden oluşur:

1. **CAD Modülü** — Doğal dilde veya teknik resim yükleyerek 3D model oluşturma, parametrik düzenleme, PDF teknik çizim çıktısı
2. **CNC Simülatör** — Tarayıcıda çalışan 3 eksenli freze ve 2 eksenli torna simülasyonu, LLM destekli chatbot ile G-code üretimi

---

## Mimari

```
┌─────────────────────────────────────────────────────────────────┐
│                       FRONTEND (GitHub Pages)                    │
│  web/                                                            │
│  ├── index.html ─── CAD ana sayfa (Three.js 3D viewer)          │
│  ├── cnc-sim.html ─ CNC Simülatör (~2300 satır, monolitik)     │
│  ├── cam.html ───── CAM sayfası (toolpath üretimi)              │
│  ├── dashboard.html, login.html, admin.html                     │
│  └── *.js ───────── Modül betikleri                              │
├─────────────────────────────────────────────────────────────────┤
│                    BACKEND 1: Node.js/Express                    │
│  src/server.js                                                   │
│  ├── FreeCAD MCP entegrasyonu (3D model üretimi)                │
│  ├── LLM ile CAD/CAM asistan akışları                           │
│  ├── Supabase Auth + PostgreSQL                                  │
│  ├── PDF teknik çizim, DXF/STEP yükleme                        │
│  └── Kota yönetimi, proje arşivi                                │
├─────────────────────────────────────────────────────────────────┤
│                    BACKEND 2: Flask (Python)                     │
│  server/app.py                                                   │
│  ├── CNC chatbot WebSocket sunucusu (Flask-SocketIO)            │
│  ├── OpenAI-uyumlu LLM API çağrıları                           │
│  ├── Oturum/konuşma/operasyon geçmişi (SQLite)                 │
│  └── G-code üretimi için sistem promptu                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## CNC Simülatör Özellikleri

### Freze (Mill) — Three.js 3D
- 3 eksenli (X/Y/Z) gerçek zamanlı tezgah simülasyonu
- Heightmap tabanlı malzeme kaldırma (150x105 grid, `Float32Array`)
- Soğutma sıvısı ve talaş parçacık simülasyonu
- 7 malzeme desteği: çelik, alüminyum, pirinç, bakır, dökme demir, titanyum, ahşap, plastik, akrilik
- Stok boyutu ve malzeme dinamik değiştirme
- G0/G1/G2/G3 + T-code desteği
- NC dosya yükleme (.nc, .gcode, .ngc, .txt, .tap)
- Kamera görünümleri: üstten, önden, yandan, izometrik, tel kafes

### Torna (Lathe) — Canvas 2D
- 2 eksenli (X/Z) torna simülasyonu
- Yarıçap profili tabanlı malzeme kaldırma
- Ayrı stok boyutu ve devir kontrolü

### Takım Magazin Sistemi (40 Slot)
- 12 önceden tanımlı takım (parmak freze, matkap, top freze, pah freze, kaba freze)
- Poka-Yoke otomatik takım seçimi (operasyon tipine göre)
- 3D magazin diski animasyonu: çekilme → disk dönüşü → iniş
- Chatbot komutlarıyla veya T-code ile takım değişimi
- HUD'da aktif takım bilgisi gösterimi

### SafetyInterceptor (Güvenlik Katmanı)
- Heightmap-farkında çarpışma tespiti
- Rapid hareket çarpma kontrolü
- Stok sınırı taşma kontrolü
- Spindle durumu doğrulama
- E-STOP otomatik devreye alma

### LLM Chatbot (4 Katmanlı Mimari)
```
Katman 1: Module Script ─── Simülasyon motoru, parseGcode, toolpath üreticileri
Katman 2: Non-module Script ── WebSocket, isControl yönlendirme, collectMachineState
Katman 3: Flask Backend ──── Oturum yönetimi, LLM API, konuşma geçmişi
Katman 4: LLM ──────────── G-code üretimi (sistem promptu ile)
```

**Hibrit Komut Yönlendirme:**
- **Yerel (taiExec):** Kontrol komutları (spindle, soğutma, devir, feed), işlem komutları (delik, cep, kanal, yüzey, kontur, pah) — deterministik takım seçimi + Poka-Yoke
- **LLM:** Karmaşık doğal dil komutları — G-code üretimi + `<gcode>` tag ayrıştırma

---

## Proje Yapısı

```
rover-cad/
├── web/                          # Frontend (GitHub Pages deploy)
│   ├── index.html                # CAD ana sayfa
│   ├── cnc-sim.html              # CNC Simülatör (Three.js + Canvas 2D)
│   ├── cnc-sim.css               # Simülatör stilleri
│   ├── cam.html                  # CAM sayfası
│   ├── cam-app.js                # CAM uygulama mantığı
│   ├── app.js                    # CAD viewer JS
│   ├── viewer.js                 # 3D model görüntüleyici
│   ├── dashboard.html/js         # Kullanıcı paneli
│   ├── admin.html/js             # Yönetim paneli
│   ├── login.html/js             # Giriş sayfası
│   ├── session-nav.js            # Oturum navigasyonu
│   ├── kinematicPlayer.js        # Kinematik animasyon oynatıcı
│   ├── style.css                 # Ana stiller
│   ├── logo.png                  # Logo
│   ├── CNAME                     # GitHub Pages alan adı (topkapikoleji.org)
│   └── .nojekyll                 # Jekyll bypass
│
├── server/                       # CNC Chatbot Backend (Python/Flask)
│   ├── app.py                    # Flask + SocketIO sunucu (~500 satır)
│   ├── schema.sql                # SQLite şeması (sessions, conversations, operations)
│   ├── llm_system_prompt.txt     # LLM G-code üretim promptu
│   ├── requirements.txt          # Python bağımlılıkları
│   ├── runtime.txt               # Python sürümü
│   └── .env.example              # Ortam değişkenleri şablonu
│
├── src/                          # CAD Backend (Node.js/Express)
│   ├── server.js                 # Express sunucu
│   ├── config.js                 # Yapılandırma
│   ├── routes/                   # API rotaları
│   │   ├── generate.js           # LLM ile 3D model üretimi
│   │   ├── generateFromImage.js  # Görüntüden model üretimi
│   │   ├── camAssistant.js       # CAM asistan akışları
│   │   ├── dimensions.js         # Parametrik ölçü yönetimi
│   │   ├── paramEdit.js          # Parametre düzenleme
│   │   ├── revise.js             # İteratif tasarım düzenleme
│   │   ├── simulate.js           # Simülasyon
│   │   ├── uploadStep.js         # STEP dosya yükleme
│   │   ├── uploadDxf.js          # DXF dosya yükleme
│   │   ├── generatePdf.js        # PDF teknik çizim
│   │   ├── jobs.js               # Asenkron iş kuyruğu
│   │   ├── inventory.js          # Envanter yönetimi
│   │   ├── auth.js               # Kimlik doğrulama
│   │   ├── admin.js              # Yönetim rotaları
│   │   └── health.js             # Sağlık kontrolü
│   ├── services/                 # İş mantığı servisleri
│   │   ├── freecadMcpClient.js   # FreeCAD MCP bağlantısı
│   │   ├── openaiClient.js       # OpenAI API istemcisi
│   │   ├── camService.js         # CAM toolpath servisi
│   │   ├── camAssistantService.js# CAM asistan servisi
│   │   ├── dimensionService.js   # Ölçü çıkarma servisi
│   │   ├── paramEditService.js   # Parametre düzenleme servisi
│   │   ├── exportService.js      # Dışa aktarma servisi
│   │   ├── database.js           # PostgreSQL bağlantısı
│   │   ├── supabaseAuth.js       # Supabase kimlik doğrulama
│   │   ├── quotaStore.js         # LLM kota yönetimi
│   │   ├── quotaCron.js          # Aylık kota sıfırlama
│   │   ├── jobStore.js           # Asenkron iş deposu
│   │   ├── projectArchiveService.js # Proje arşivi
│   │   ├── promptCacheService.js # Prompt önbelleği
│   │   ├── inventoryService.js   # Envanter servisi
│   │   ├── sinumerikTransformer.js # Sinumerik dönüştürücü
│   │   ├── heidenhainTransformer.js # Heidenhain dönüştürücü
│   │   └── industrialTransformers.js # Endüstriyel format dönüşüm
│   └── prompts/                  # LLM sistem promptları
│       ├── freecad-system-prompt.txt
│       ├── freecad-image-system-prompt.txt
│       ├── cam-plan-system-prompt.txt
│       ├── cam-code-system-prompt.txt
│       └── sim-system-prompt.txt
│
├── test/                         # Test dosyaları
│   ├── project-archive.test.js
│   ├── llm-metering.test.js
│   └── prompt-cache.test.js
│
├── supabase/migrations/          # Veritabanı migration dosyaları
├── examples/                     # Örnek dosyalar
│   └── crank_piston_sim.py       # Krank-piston simülasyonu
│
├── .github/workflows/
│   └── deploy-pages.yml          # GitHub Pages CI/CD
│
├── render.yaml                   # Render.com deploy yapılandırması
├── netlify.toml                  # Netlify yapılandırması (alternatif)
├── package.json                  # Node.js bağımlılıkları
├── .env.example                  # Node.js ortam değişkenleri şablonu
├── .gitignore
├── DEPLOY.md                     # Deploy talimatları
├── NEXT_STEPS.md                 # Geliştirme yol haritası
├── start.bat                     # Windows başlatma betiği
└── start-dev.bat                 # Windows geliştirme betiği
```

---

## Kurulum

### Gereksinimler

- **Node.js** >= 18
- **Python** >= 3.12
- **FreeCAD** (MCP server için, opsiyonel)
- **Supabase** hesabı (auth + PostgreSQL, opsiyonel)

### 1. Depoyu Klonla

```bash
git clone https://github.com/onurcoskun616/rover-cad.git
cd rover-cad
```

### 2. Node.js Backend (CAD)

```bash
# Bağımlılıkları yükle
npm install

# .env dosyasını oluştur
cp .env.example .env
# .env dosyasını düzenle: LLM_PROVIDER, API anahtarları, Supabase bilgileri

# Geliştirme modunda başlat
npm run dev

# Üretim modunda başlat
npm start
```

### 3. Python Backend (CNC Chatbot)

```bash
cd server

# Sanal ortam oluştur
python -m venv venv
source venv/bin/activate   # Linux/Mac
# venv\Scripts\activate    # Windows

# Bağımlılıkları yükle
pip install -r requirements.txt

# .env dosyasını oluştur
cp .env.example .env
# LLM_API_KEY değerini gir

# Sunucuyu başlat
python app.py
```

### 4. Frontend (Yerel Geliştirme)

```bash
# web/ klasörünü herhangi bir HTTP sunucusuyla servis et
cd web
python -m http.server 8080
# veya
npx serve .
```

Tarayıcıda `http://localhost:8080` adresine git.

---

## Deploy

### Frontend — GitHub Pages

`web/` dizini GitHub Pages üzerinden otomatik deploy edilir.

**CI/CD:** `.github/workflows/deploy-pages.yml` — `claude/devam-et-vumbm2` branch'ine `web/**` değişikliği push edildiğinde otomatik tetiklenir.

**Alan Adı:** `topkapikoleji.org` (`web/CNAME`)

### Backend — Render.com

CNC chatbot backend'i Render.com üzerinde barındırılır.

**URL:** `https://rover-cnc-backend.onrender.com`

**Yapılandırma:** `render.yaml` dosyasında tanımlı.

```yaml
services:
  - type: web
    name: rover-cnc-backend
    runtime: python
    rootDir: server
    buildCommand: pip install -r requirements.txt
    startCommand: python app.py
```

**Gerekli ortam değişkenleri (Render Dashboard):**
| Değişken | Açıklama |
|---|---|
| `LLM_PROVIDER` | `openai` |
| `LLM_MODEL` | `gpt-4o-mini` |
| `LLM_BASE_URL` | `https://api.openai.com/v1` |
| `LLM_API_KEY` | OpenAI API anahtarı |
| `SECRET_KEY` | Flask gizli anahtar (otomatik üretilir) |

---

## LLM Yapılandırması

### CNC Chatbot Backend (server/.env)

OpenAI, OpenRouter veya herhangi bir OpenAI-uyumlu API desteklenir:

```env
# OpenAI doğrudan
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...
LLM_BASE_URL=https://api.openai.com/v1

# OpenRouter üzerinden
LLM_PROVIDER=openai
LLM_MODEL=qwen/qwen3-32b
LLM_API_KEY=sk-or-v1-...
LLM_BASE_URL=https://openrouter.ai/api/v1
```

### CAD Backend (.env)

```env
LLM_PROVIDER=claude          # "openai" veya "claude"
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

---

## Veritabanı

### CNC Chatbot — SQLite (`server/rover_cnc.db`)

Üç tablo:
- **sessions** — Makine tipi, malzeme, stok boyutları
- **conversations** — Kullanıcı/asistan mesaj geçmişi
- **operations** — G-code operasyon arşivi

### CAD Backend — PostgreSQL (Supabase)

- Kullanıcı hesapları ve kimlik doğrulama
- Proje arşivi ve sürüm yönetimi
- LLM kota takibi

---

## Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| **3D Render** | Three.js r160 |
| **2D Render** | HTML5 Canvas |
| **Frontend** | Vanilla JS, Tailwind CSS |
| **CNC Backend** | Python 3.12, Flask, Flask-SocketIO, eventlet |
| **CAD Backend** | Node.js 18+, Express |
| **WebSocket** | Socket.IO |
| **3D Motor** | FreeCAD (MCP Server üzerinden) |
| **Auth** | Supabase Auth |
| **Veritabanı** | SQLite (CNC), PostgreSQL (CAD) |
| **LLM** | OpenAI API, OpenRouter, Claude |
| **CI/CD** | GitHub Actions |
| **Hosting** | GitHub Pages (frontend), Render.com (backend) |

---

## API Uç Noktaları

### CNC Chatbot (WebSocket — Flask-SocketIO)

| Olay | Yön | Açıklama |
|---|---|---|
| `connect` | Client → Server | Bağlantı kurulumu |
| `chat_message` | Client → Server | Kullanıcı mesajı + makine durumu JSON |
| `chat_response` | Server → Client | LLM yanıtı (metin + `<gcode>` blokları) |
| `chat_error` | Server → Client | Hata bildirimi |

### CAD Backend (REST — Express)

| Yol | Metot | Açıklama |
|---|---|---|
| `/api/generate` | POST | Doğal dilden 3D model üretimi |
| `/api/generate-from-image` | POST | Görüntüden model üretimi |
| `/api/upload-step` | POST | STEP dosya yükleme |
| `/api/upload-dxf` | POST | DXF dosya yükleme |
| `/api/dimensions` | GET/POST | Parametrik ölçü okuma/güncelleme |
| `/api/param-edit` | POST | Parametre düzenleme |
| `/api/revise` | POST | İteratif tasarım düzenleme |
| `/api/cam-questions` | POST | CAM asistan soruları |
| `/api/cam-plan` | POST | CAM işleme planı |
| `/api/cam-confirm` | POST | CAM plan onayı + G-code üretimi |
| `/api/simulate` | POST | Simülasyon |
| `/api/generate-pdf` | POST | PDF teknik çizim |
| `/api/jobs/:id` | GET | Asenkron iş durumu |
| `/api/health` | GET | Sağlık kontrolü |

---

## CNC Simülatör Komut Referansı

### Kontrol Komutları (Yerel İşleme)

| Komut | Açıklama |
|---|---|
| `spindle aç / kapat` | İş mili kontrolü |
| `soğutma aç / kapat` | Soğutma sıvısı kontrolü |
| `1500 devir` / `rpm 3000` | Devir ayarı |
| `feed 200` / `ilerleme 150` | İlerleme hızı |
| `başlat` / `durdur` / `reset` | Çalışma kontrolü |
| `yeni parça` | Stok sıfırlama |
| `malzeme alüminyum` | Malzeme değiştirme |
| `stok 300x200x80` | Stok boyutu ayarlama |
| `T05` / `takım 5` | Manuel takım seçimi |
| `magazin göster` | Takım listesi |
| `üstten / önden / yandan / izometrik` | Kamera görünümü |

### İşlem Komutları (Yerel + Poka-Yoke)

| Komut | Açıklama |
|---|---|
| `20mm çapında 15mm delik aç` | Delik delme (otomatik takım) |
| `60x40mm 10mm cep aç` | Dikdörtgen cep (otomatik takım) |
| `50mm kanal aç 8mm derinlik` | Kanal açma |
| `yüzey düzelt` | Yüzey frezeleme |
| `kontur 5mm derinlik` | Kontur frezeleme |
| `2mm pah kır` | Pah kırma |

### LLM Komutları (Karmaşık İşlemler)

Yukarıdaki yerel komutlara uymayan her şey LLM'e yönlendirilir:
- *"Stok ortasına yıldız şekli oyma"*
- *"Köşelere 4 delik aç, kenardan 15mm içeride"*
- *"Çapı 30mm'ye tornala"*

---

## Takım Kütüphanesi

| ID | Takım | Tip | Çap | Boy | Maks RPM |
|---|---|---|---|---|---|
| T01 | Ø6 Parmak Freze | endmill | 6mm | 20mm | 12000 |
| T02 | Ø10 Parmak Freze | endmill | 10mm | 25mm | 10000 |
| T03 | Ø16 Parmak Freze | endmill | 16mm | 30mm | 9000 |
| T04 | Ø20 Parmak Freze | endmill | 20mm | 35mm | 8000 |
| T05 | Ø26 Parmak Freze | endmill | 26mm | 26mm | 7000 |
| T06 | Ø32 Kaba Freze | roughing | 32mm | 35mm | 6000 |
| T07 | Ø8 Matkap | drill | 8mm | 40mm | 6000 |
| T08 | Ø12 Matkap | drill | 12mm | 50mm | 5000 |
| T09 | Ø5 Top Freze | ballmill | 5mm | 15mm | 15000 |
| T10 | Ø10 Top Freze | ballmill | 10mm | 20mm | 12000 |
| T11 | Ø3 Pah Freze | chamfer | 3mm | 10mm | 18000 |
| T12 | Ø6 Pah Freze | chamfer | 6mm | 12mm | 15000 |

---

## Geliştirme

### Test

```bash
# Node.js testleri
npm test

# Tek dosya
node --test test/llm-metering.test.js
```

### Windows Başlatma

```bat
:: Tüm servisleri başlat
start.bat

:: Geliştirme modunda
start-dev.bat
```

---

## Lisans

Bu proje Topkapı Okulları'na aittir. Eğitim amaçlı geliştirilmiştir.
