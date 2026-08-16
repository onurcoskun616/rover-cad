# Rover CAD — Yapay Zeka Destekli CAD & CNC Simülasyon Platformu

Topkapı Okulları tarafından geliştirilen, doğal dil komutlarıyla 3D model oluşturma, CNC G-code üretimi ve gerçek zamanlı tezgah simülasyonu sağlayan eğitim amaçlı web platformu.

**Canlı Site:** [topkapikoleji.org](https://topkapikoleji.org)

---

## Genel Bakış

Rover CAD beş ana modülden oluşur:

1. **CAD Asistanı** — Doğal dille, teknik resimle veya STEP/IGES/DXF dosya yükleyerek 3D model oluşturma, parametrik düzenleme, iteratif tasarım revizyonu, PDF teknik çizim
2. **CAM Asistanı** — Sihirbaz tabanlı adım adım işleme planı oluşturma, LLM ile G-code üretimi, maliyet/teklif hesaplama
3. **CNC Simülatör** — Tarayıcıda çalışan 3 eksenli freze ve 2 eksenli torna simülasyonu, LLM destekli chatbot ile G-code üretimi
4. **Montaj / Kinematik Simülasyon** — Python scripti veya doğal dille mekanizma oluşturma, Three.js tabanlı kinematik animasyon, çarpışma algılama
5. **Envanter, Dashboard, Admin** — Makine/takım profilleri, post-processor yönetimi, kullanıcı paneli, yönetim paneli, auth sistemi, kota takibi

---

## Mimari

```
┌─────────────────────────────────────────────────────────────────┐
│                       FRONTEND (GitHub Pages)                    │
│  web/                                                            │
│  ├── index.html ─── CAD ana sayfa (Three.js 3D viewer)          │
│  │   ├── Metin ile 3D model (text-to-3D)                        │
│  │   ├── Teknik resim ile 3D model (image-to-3D)                │
│  │   ├── STEP/IGES/DXF dosya yükleme                            │
│  │   ├── Montaj / Kinematik simülasyon                           │
│  │   ├── Parametrik düzenleme + iteratif revizyon                │
│  │   └── Envanter (makine profilleri + takım kütüphanesi)        │
│  ├── cnc-sim.html ─ CNC Simülatör (~2300 satır, monolitik)     │
│  ├── cam.html ───── CAM Asistanı (sihirbaz → plan → G-code)    │
│  ├── dashboard.html ─ Kullanıcı paneli (kota, projeler)         │
│  ├── admin.html ──── Yönetim paneli (kullanıcılar, LLM takip)  │
│  ├── login.html ──── Giriş / Kayıt (Supabase Auth)             │
│  └── *.js ───────── Modül betikleri                              │
├─────────────────────────────────────────────────────────────────┤
│                    BACKEND 1: Node.js/Express                    │
│  src/server.js                                                   │
│  ├── FreeCAD MCP entegrasyonu (MCP SDK + stdio transport)       │
│  ├── LLM ile CAD/CAM asistan akışları                           │
│  ├── Supabase Auth + PostgreSQL                                  │
│  ├── PDF teknik çizim, DXF/STEP/IGES yükleme                   │
│  ├── Parametrik düzenleme + iteratif revizyon                    │
│  ├── Post-processor dönüştürücüler (Sinumerik, Heidenhain...)   │
│  ├── Kota yönetimi, prompt önbellek, proje arşivi               │
│  └── Envanter servisi (makine + takım profilleri)               │
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

## CAD Asistanı

CAD modülü (`web/index.html`) 4 sekme halinde çalışır:

### 1. Metin ile 3D Model (Text-to-3D)

Kullanıcı doğal dille parça tanımlar, LLM FreeCAD Python scripti üretir, FreeCAD MCP Server modeli oluşturur.

```
Kullanıcı: "Çapı 30mm, yüksekliği 50mm olan bir silindir oluştur"
     ↓
LLM → FreeCAD Python scripti
     ↓
FreeCAD MCP → STEP + STL çıktısı
     ↓
Three.js 3D önizleme
```

- Sonuç: STEP, STL indirme + PDF teknik çizim oluşturma
- İteratif revizyon: "Yüksekliği 100mm yap", "Ortasına 12mm delik ekle", "Kenarları yuvarla"

### 2. Teknik Resim ile 3D Model (Image-to-3D)

PNG/JPG teknik resim yüklenir, LLM görüntüyü analiz eder ve FreeCAD scripti üretir.

- Opsiyonel ek talimat: "Delik çapı 8mm olsun"
- Aynı STEP/STL/PDF çıktı akışı

### 3. STEP/IGES/DXF Dosya Yükleme

Mevcut CAD dosyalarını yükleyerek önizleme ve CAM akışına geçiş:

- **STEP/IGES** (`.step`, `.stp`, `.iges`, `.igs`) — 3D model önizleme
- **DXF** (`.dxf`) — 2D profil yükleme, opsiyonel levha kalınlığı ile 3D'ye dönüştürme (kalınlık boşsa lazer/plazma 2D kesim olarak işlenir)

### 4. Parametrik Düzenleme

STEP dosyasından ölçü çıkarma ve interaktif düzenleme:

```
STEP yükleme → Ölçü çıkarma (dimensionService) → 3D etiketler
     ↓
Parametre değiştirme → FreeCAD'de yeniden oluşturma (LLM gerekmez)
```

- `ROVER_PARAMS` bloğu ile deterministik parametre ikamesi
- Her değişiklikte yeni STEP/STL üretilir

### 5. İteratif Tasarım Revizyonu

Mevcut tasarım üzerinde doğal dille değişiklik isteme:

- `/revise` endpoint'i ile önceki FreeCAD scriptini LLM'e gönderme
- LLM güncellenmiş script üretir, FreeCAD çalıştırır
- Zincirleme revizyon desteği: her adımda bir önceki script üzerine inşa edilir

### 6. PDF Teknik Çizim

FreeCAD TechDraw modülü ile otomatik teknik çizim:

- Standart mühendislik görünümleri (ön, üst, yan, izometrik)
- Ölçülendirme
- PDF olarak indirme

---

## CAM Asistanı

CAM modülü (`web/cam.html`) sihirbaz tabanlı adım adım akış sunar:

### Sihirbaz Akışı

```
1. Adım Sihirbazı (cam-wizard)
   ├── Makine seçimi, malzeme, stok boyutu
   ├── İşleme parametreleri (tolerans, yüzey kalitesi)
   └── Takım seçimi, operasyon sırası
         ↓
2. Plan Oluşturma (cam-plan)
   ├── LLM işleme planı önerisi
   ├── Plan revizyonu ("Dış konturu son adıma al")
   └── Plan onayı
         ↓
3. G-code Üretimi (cam-confirm)
   ├── LLM G-code üretimi
   ├── G-code indirme (.nc dosya)
   └── "CNC Simülatörde Aç" butonu → cnc-sim.html
```

### Teklif / Maliyet Hesaplama

İki mod:

**Basit Mod:**
- Saatlik makine ücreti (TL/saat)
- Malzeme birim fiyatı (TL/cm³ veya TL/kg)
- Kâr marjı (%)

**Detaylı Mod:**
- Malzeme maliyeti
- Makine amortisman payı (TL/saat)
- Enerji maliyeti (TL/kWh × güç tüketimi kW)
- Takım maliyeti (TL/takım ÷ ömür/parça)
- Sarf malzeme (TL/saat + TL/parça)
- Genel gider payı (%)
- Fire/hata payı (%)
- Kâr marjı (%)

Sonuç: PDF teklif formu olarak indirme

---

## Montaj / Kinematik Simülasyon

Montaj sekmesi (`index.html` → Montaj tab'ı) ile mekanizma oluşturma ve simülasyon:

### Giriş Modları

1. **Doğal dille mekanizma oluşturma:**
   - "Merkezde Z ekseninde dönen 50mm çapında bir disk oluştur"
   - "Bu diske X ekseninde hareket eden bir biyel kolu bağla"
   - Adım adım mekanizma inşa etme, geri alma desteği

2. **Python scripti yazma (gelişmiş mod):**
   - TopkapiAI Python scripti ile FreeCAD'de parça oluşturma
   - `_rover_sim_out` ve `_rover_sim_ts` değişkenleri otomatik enjekte
   - Her parça için ayrı STL + `kinematics.json` dosyası

3. **Demo: Krank-piston simülasyonu** (`examples/crank_piston_sim.py`)

### Simülasyon Görünümü

- Three.js tabanlı kinematik animasyon oynatıcı (`kinematicPlayer.js`)
- Oynat/Duraklat kontrolleri
- Hız ayarı: 1x, 2x, 5x
- İlerleme çubuğu ile zaman kontrolü
- Çarpışma algılama ve otomatik durdurma
- Her parçayı ayrı STL olarak indirme
- Montajlı STEP indirme

---

## FreeCAD MCP Entegrasyonu

3D model üretimi FreeCAD'in MCP (Model Context Protocol) sunucusu üzerinden yapılır:

### Bağlantı Mimarisi

```
Express Backend (src/server.js)
     ↓
freecadMcpClient.js
     ├── @modelcontextprotocol/sdk Client
     ├── StdioClientTransport (stdio subprocess)
     ├── Otomatik yeniden bağlanma (hata sonrası)
     └── Yapılandırılabilir timeout
           ↓
FreeCAD MCP Server (subprocess)
     ├── Python script çalıştırma
     ├── STEP/STL/PDF dışa aktarma
     └── Parametrik model güncelleme
```

### Özellikler

- **Pre-warm:** Sunucu başlangıcında FreeCAD bağlantısı açılır (soğuk başlatma maliyetini ortadan kaldırır)
- **Tool calling:** `callFreecadTool(toolName, args)` ile MCP tool çağırma
- **Asenkron iş kuyruğu:** Uzun süren FreeCAD operasyonları için `jobStore.js` ile kuyruk yönetimi, `/jobs/:id` endpoint'i ile durum sorgulama

### Kullanılan LLM Promptları

| Dosya | Amaç |
|---|---|
| `freecad-system-prompt.txt` | Metin → FreeCAD Python scripti üretimi |
| `freecad-image-system-prompt.txt` | Görüntü → FreeCAD Python scripti üretimi |
| `cam-plan-system-prompt.txt` | CAM işleme planı oluşturma |
| `cam-code-system-prompt.txt` | Plan → G-code üretimi |
| `sim-system-prompt.txt` | Kinematik simülasyon scripti üretimi |

---

## CNC Simülatör

### Freze (Mill) — Three.js 3D

- 3 eksenli (X/Y/Z) gerçek zamanlı tezgah simülasyonu
- Heightmap tabanlı malzeme kaldırma (150×105 grid, `Float32Array`)
- Soğutma sıvısı ve talaş parçacık simülasyonu
- 9 malzeme desteği: çelik, alüminyum, pirinç, bakır, dökme demir, titanyum, ahşap, plastik, akrilik
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

## Envanter Sistemi

`index.html` → "Makine ve Takımlarım" sekmesi ile makine ve takım profili yönetimi:

### Makine Profilleri

Her makine profili şunları içerir:
- İsim
- Eksen sayısı (3/4/5 eksen)
- Post-processor / kontrolcü seçimi
- Maksimum spindle hızı (rpm)
- Çalışma alanı (X×Y×Z mm)
- Saatlik makine ücreti (TL/saat)

### Post-Processor Desteği

| Kategori | Kontrolcüler |
|---|---|
| **Hobi / Atölye** | GRBL, Mach3, Mach4, LinuxCNC |
| **Endüstriyel CNC** | Fanuc, Siemens (Sinumerik), Heidenhain (TNC 640), Heidenhain (iTNC 530), Heidenhain (TNC 426/430), Haas, Mitsubishi (Meldas), Mazak, Okuma (OSP), Doosan |

### Endüstriyel Post-Processor Dönüştürücüler

Backend'de her kontrolcü için özel G-code dönüştürücü:

| Servis | Açıklama |
|---|---|
| `sinumerikTransformer.js` | Siemens Sinumerik formatına dönüştürme |
| `heidenhainTransformer.js` | Heidenhain conversational/Klartext formatına dönüştürme |
| `industrialTransformers.js` | Fanuc, Haas, Mazak, Okuma ve diğer formatlar |

### Takım Kütüphanesi

Kullanıcı tanımlı takımlar:
- İsim/kod, tip (düz uçlu freze, top uçlu, matkap, kılavuz, diş frezesi)
- Çap (mm), kesici kenar sayısı
- Malzeme (karbür, HSS)
- Önerilen kesme hızı aralığı (m/min)
- Stok adedi

### CNC Simülatör Dahili Takım Kütüphanesi (12 Slot)

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

## Auth Sistemi (Kimlik Doğrulama)

Supabase Auth ile kullanıcı yönetimi (`web/login.html`):

### Giriş Yöntemleri

- **Google OAuth:** Tek tıkla Google hesabıyla giriş
- **E-posta / Şifre:** Giriş yap veya yeni hesap oluştur

### Özellikler

- Yeni hesaplara aylık 50.000 ücretsiz token
- JWT tabanlı oturum yönetimi
- Otomatik yönlendirme (giriş yapmamış → login.html)
- Şifremi unuttum akışı

---

## Dashboard (Kullanıcı Paneli)

`web/dashboard.html` ile kullanıcı çalışma alanı:

### Bölümler

- **Token ve Kullanım:** Kullanılan / kalan / aylık kota, ilerleme çubuğu, kullanım oranı
- **Hesap Özeti:** E-posta, plan, üyelik tarihi, yenilenme tarihi
- **Son Projelerim:** Proje listesi, "Yeni proje oluştur" kısayolu
- **Dosyalarım ve Çıktılarım:** Oluşturulan STEP/STL/PDF/G-code dosyaları tablosu

### Hızlı İşlemler

- Yeni proje oluştur → CAD çalışma alanına git
- Dosya yükle
- Son işleme git (kaldığın yerden devam et)

---

## Admin Paneli (Yönetim)

`web/admin.html` ile sistem yönetimi:

### Bölümler

- **Sistem Özeti:** API servisi, GitHub Pages, veri görünümü durumu
- **LLM Tüketimi:** CAD/CAM/simülasyon bazında model, çağrı sayısı, giriş/çıkış token, önbellek, maliyet takibi
- **Kullanıcı Yönetimi:** Tüm kullanıcılar tablosu, arama, durum/plan filtresi, token kota ayarlama, engelleme, bonus token tanımlama
- **Son Hareketler:** Sistem etkinlik logu

### Yönetici İşlemleri

- Yeni kullanıcı ekleme ve davet
- Kullanıcı token kotası güncelleme
- Kullanım raporu dışa aktarma

---

## Backend Servisleri

### Kota Yönetimi

| Servis | Açıklama |
|---|---|
| `quotaStore.js` | LLM token kota takibi (kullanılan/kalan/limit) |
| `quotaCron.js` | Aylık otomatik kota sıfırlama (cron job) |

### Prompt Önbellek

`promptCacheService.js` — Aynı veya benzer istekler için LLM yanıtlarını önbelleğe alma, token tasarrufu

### Proje Arşivi

`projectArchiveService.js` — Kullanıcı projelerini PostgreSQL'de saklama, sürüm yönetimi, geçmiş projelere erişim

### Asenkron İş Kuyruğu

`jobStore.js` + `jobs.js` — Uzun süren FreeCAD operasyonları için:

```
POST /generate → { jobId: "abc123" }
GET /jobs/abc123 → { status: "running" | "done" | "error", result: {...} }
```

---

## Proje Yapısı

```
rover-cad/
├── web/                          # Frontend (GitHub Pages deploy)
│   ├── index.html                # CAD ana sayfa (4 sekme: metin/resim/dosya/montaj)
│   ├── cnc-sim.html              # CNC Simülatör (Three.js + Canvas 2D)
│   ├── cnc-sim.css               # Simülatör stilleri
│   ├── cam.html                  # CAM Asistanı (sihirbaz → plan → G-code → teklif)
│   ├── cam-app.js                # CAM uygulama mantığı
│   ├── app.js                    # CAD viewer JS
│   ├── viewer.js                 # 3D model görüntüleyici
│   ├── kinematicPlayer.js        # Kinematik animasyon oynatıcı
│   ├── dashboard.html/js         # Kullanıcı paneli (kota, projeler, dosyalar)
│   ├── admin.html/js             # Yönetim paneli (kullanıcılar, LLM takip)
│   ├── login.html/js             # Giriş / Kayıt sayfası (Supabase Auth)
│   ├── session-nav.js            # Oturum navigasyonu
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
├── src/                          # CAD/CAM Backend (Node.js/Express)
│   ├── server.js                 # Express sunucu (tüm rotaları bağlar)
│   ├── config.js                 # Yapılandırma
│   ├── routes/                   # API rotaları
│   │   ├── generate.js           # Metin → 3D model üretimi
│   │   ├── generateFromImage.js  # Görüntü → 3D model üretimi
│   │   ├── uploadStep.js         # STEP/IGES dosya yükleme
│   │   ├── uploadDxf.js          # DXF dosya yükleme
│   │   ├── revise.js             # İteratif tasarım revizyonu
│   │   ├── dimensions.js         # Parametrik ölçü çıkarma
│   │   ├── paramEdit.js          # Parametre düzenleme (LLM'siz)
│   │   ├── camAssistant.js       # CAM sihirbaz + plan + G-code
│   │   ├── simulate.js           # Kinematik simülasyon
│   │   ├── generatePdf.js        # PDF teknik çizim
│   │   ├── jobs.js               # Asenkron iş kuyruğu durumu
│   │   ├── inventory.js          # Envanter (makine + takım) CRUD
│   │   ├── auth.js               # Kimlik doğrulama rotaları
│   │   ├── admin.js              # Yönetim rotaları
│   │   └── health.js             # Sağlık kontrolü
│   ├── services/                 # İş mantığı servisleri
│   │   ├── freecadMcpClient.js   # FreeCAD MCP bağlantısı (MCP SDK)
│   │   ├── openaiClient.js       # OpenAI API istemcisi
│   │   ├── camService.js         # CAM toolpath servisi
│   │   ├── camAssistantService.js# CAM asistan iş mantığı
│   │   ├── dimensionService.js   # STEP ölçü çıkarma servisi
│   │   ├── paramEditService.js   # Parametre düzenleme servisi
│   │   ├── exportService.js      # Dışa aktarma servisi
│   │   ├── database.js           # PostgreSQL bağlantısı (Supabase)
│   │   ├── supabaseAuth.js       # Supabase kimlik doğrulama
│   │   ├── quotaStore.js         # LLM token kota yönetimi
│   │   ├── quotaCron.js          # Aylık kota sıfırlama cron
│   │   ├── jobStore.js           # Asenkron iş deposu
│   │   ├── projectArchiveService.js # Proje arşivi + sürüm yönetimi
│   │   ├── promptCacheService.js # Prompt önbelleği (token tasarrufu)
│   │   ├── inventoryService.js   # Envanter CRUD servisi
│   │   ├── sinumerikTransformer.js # Siemens Sinumerik G-code dönüştürücü
│   │   ├── heidenhainTransformer.js # Heidenhain Klartext dönüştürücü
│   │   └── industrialTransformers.js # Fanuc, Haas, Mazak, Okuma dönüştürücüler
│   └── prompts/                  # LLM sistem promptları
│       ├── freecad-system-prompt.txt      # Metin → FreeCAD script
│       ├── freecad-image-system-prompt.txt # Görüntü → FreeCAD script
│       ├── cam-plan-system-prompt.txt     # CAM plan oluşturma
│       ├── cam-code-system-prompt.txt     # Plan → G-code
│       └── sim-system-prompt.txt          # Kinematik simülasyon script
│
├── test/                         # Test dosyaları
│   ├── project-archive.test.js   # Proje arşivi testleri
│   ├── llm-metering.test.js      # LLM ölçümleme testleri
│   └── prompt-cache.test.js      # Prompt önbellek testleri
│
├── supabase/migrations/          # PostgreSQL migration dosyaları
├── examples/                     # Örnek dosyalar
│   └── crank_piston_sim.py       # Krank-piston kinematik simülasyonu
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

### 2. Node.js Backend (CAD/CAM)

```bash
npm install

cp .env.example .env
# .env dosyasını düzenle: LLM_PROVIDER, API anahtarları, Supabase, FreeCAD MCP

npm run dev    # Geliştirme
npm start      # Üretim
```

### 3. Python Backend (CNC Chatbot)

```bash
cd server
python -m venv venv
source venv/bin/activate   # Linux/Mac
# venv\Scripts\activate    # Windows

pip install -r requirements.txt

cp .env.example .env
# LLM_API_KEY değerini gir

python app.py
```

### 4. Frontend (Yerel Geliştirme)

```bash
cd web
python -m http.server 8080
# veya: npx serve .
```

Tarayıcıda `http://localhost:8080` adresine git.

---

## Deploy

### Frontend — GitHub Pages

`web/` dizini GitHub Pages üzerinden otomatik deploy edilir.

**CI/CD:** `.github/workflows/deploy-pages.yml` — `claude/devam-et-vumbm2` branch'ine `web/**` değişikliği push edildiğinde otomatik tetiklenir.

**Alan Adı:** `topkapikoleji.org` (`web/CNAME`)

### CNC Chatbot Backend — Render.com

**URL:** `https://rover-cnc-backend.onrender.com`

**Yapılandırma:** `render.yaml`

| Değişken | Açıklama |
|---|---|
| `LLM_PROVIDER` | `openai` |
| `LLM_MODEL` | `gpt-4o-mini` |
| `LLM_BASE_URL` | `https://api.openai.com/v1` |
| `LLM_API_KEY` | OpenAI API anahtarı |
| `SECRET_KEY` | Flask gizli anahtar (otomatik üretilir) |

### CAD/CAM Backend

**URL:** `https://api.topkapikoleji.org`

| Değişken | Açıklama |
|---|---|
| `LLM_PROVIDER` | `claude` veya `openai` |
| `OPENAI_API_KEY` | LLM API anahtarı |
| `SUPABASE_URL` | Supabase proje URL |
| `SUPABASE_SERVICE_KEY` | Supabase servis anahtarı |
| `DATABASE_URL` | PostgreSQL bağlantı dizesi |
| `FREECAD_MCP_COMMAND` | FreeCAD MCP başlatma komutu |

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

### CAD/CAM Backend (.env)

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
- **conversations** — Kullanıcı/asistan mesaj geçmişi (özet + G-code ayrımı)
- **operations** — G-code operasyon arşivi

### CAD/CAM Backend — PostgreSQL (Supabase)

- Kullanıcı hesapları ve kimlik doğrulama
- Proje arşivi ve sürüm yönetimi
- LLM token kota takibi (aylık otomatik sıfırlama)
- Makine ve takım envanter profilleri

---

## API Uç Noktaları

### CNC Chatbot (WebSocket — Flask-SocketIO)

| Olay | Yön | Açıklama |
|---|---|---|
| `connect` | Client → Server | Bağlantı kurulumu |
| `init_session` | Client → Server | Oturum başlatma (machineType, sessionKey) |
| `chat_message` | Client → Server | Kullanıcı mesajı + makine durumu JSON |
| `chat_response` | Server → Client | LLM yanıtı (metin + G-code blokları) |
| `chat_typing` | Server → Client | LLM düşünüyor bildirimi |
| `get_master_gcode` | Client → Server | Tüm operasyonların birleştirilmiş G-code'u |
| `master_gcode` | Server → Client | Birleştirilmiş G-code yanıtı |

### CAD/CAM Backend (REST — Express)

| Yol | Metot | Açıklama |
|---|---|---|
| **CAD** | | |
| `/generate` | POST | Metin → 3D model (FreeCAD MCP) |
| `/generate-from-image` | POST | Görüntü → 3D model |
| `/upload-step` | POST | STEP/IGES dosya yükleme + önizleme |
| `/upload-dxf` | POST | DXF dosya yükleme (opsiyonel kalınlık) |
| `/revise` | POST | İteratif tasarım revizyonu |
| `/extract-dimensions` | GET/POST | STEP'ten parametrik ölçü çıkarma |
| `/param-edit` | POST | Parametre düzenleme (LLM'siz) |
| `/generate-pdf` | POST | PDF teknik çizim oluşturma |
| **CAM** | | |
| `/cam-step` | POST | CAM sihirbaz adımı (soru-cevap) |
| `/cam-plan` | POST | İşleme planı oluşturma |
| `/cam-confirm` | POST | Plan onayı + G-code üretimi |
| **Simülasyon** | | |
| `/simulate` | POST | Kinematik simülasyon (Python script → STL + kinematics.json) |
| **Envanter** | | |
| `/machines` | GET/POST/PUT/DELETE | Makine profili CRUD |
| `/tools` | GET/POST/PUT/DELETE | Takım profili CRUD |
| **Auth & Admin** | | |
| `/auth/*` | POST | Giriş, kayıt, oturum doğrulama |
| `/admin/*` | GET/POST | Kullanıcı yönetimi, LLM kullanım raporu |
| **Genel** | | |
| `/jobs/:id` | GET | Asenkron iş durumu sorgulama |
| `/files/*` | GET | Üretilen dosyalar (STEP/STL/PDF/NC) |
| `/health` | GET | Sağlık kontrolü |

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

Yerel komutlara uymayan her şey LLM'e yönlendirilir:
- *"Stok ortasına yıldız şekli oyma"*
- *"Köşelere 4 delik aç, kenardan 15mm içeride"*
- *"Çapı 30mm'ye tornala"*

---

## Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| **3D Render** | Three.js r160 |
| **2D Render** | HTML5 Canvas |
| **Frontend** | Vanilla JS, Tailwind CSS |
| **CNC Backend** | Python 3.12, Flask, Flask-SocketIO, eventlet |
| **CAD/CAM Backend** | Node.js 18+, Express |
| **WebSocket** | Socket.IO |
| **3D Motor** | FreeCAD (MCP Server üzerinden) |
| **MCP SDK** | `@modelcontextprotocol/sdk` (stdio transport) |
| **Auth** | Supabase Auth (Google OAuth + e-posta/şifre) |
| **Veritabanı** | SQLite (CNC), PostgreSQL/Supabase (CAD) |
| **LLM** | OpenAI API, OpenRouter, Claude |
| **Post-Processor** | Sinumerik, Heidenhain, Fanuc, GRBL, Mach3/4 |
| **CI/CD** | GitHub Actions |
| **Hosting** | GitHub Pages (frontend), Render.com (CNC backend) |

---

## Geliştirme

### Test

```bash
npm test

# Tek dosya
node --test test/llm-metering.test.js
node --test test/prompt-cache.test.js
node --test test/project-archive.test.js
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
