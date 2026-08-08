# Rover CAD - Deploy Rehberi

## Mimari

| Katman | Konum | Teknoloji |
|--------|-------|-----------|
| **Frontend** | Netlify | Statik HTML/JS/CSS (`web/` klasoru) |
| **Backend** | Windows PC (yerel) | Node.js Express (`src/server.js`) |
| **Tunel** | Cloudflare Tunnel | Backend'i internete acar |
| **FreeCAD** | Windows PC (yerel) | MCP uzerinden baglanir |
| **LLM** | Claude CLI | Yerel kurulu `claude` komutu |

---

## 1. Frontend Deploy (Netlify)

### Ilk Kurulum (tek seferlik)

```bash
# Netlify CLI yukle
npm install -g netlify-cli

# Netlify'a giris yap
npx netlify login

# Siteyi baglat (proje klasorunde)
npx netlify init
# "Create & configure a new site" sec
# Publish directory: web
```

### Her Guncelleme Icin

```bash
# Projeyi cek
git pull origin claude/devam-et-vumbm2

# Netlify'a deploy et
npx netlify deploy --prod --dir=web
```

---

## 2. Backend Deploy (Windows PC)

### Onkosuller

- **Node.js 18+**: https://nodejs.org
- **FreeCAD + freecad-mcp**: `pip install freecad-mcp` veya `uvx freecad-mcp`
- **Claude CLI**: https://docs.anthropic.com/claude-code
- **Cloudflare Tunnel**: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

### Ilk Kurulum

```bash
# Projeyi klonla
git clone https://github.com/onurcoskun616/rover-cad.git
cd rover-cad

# Bagimliliklari yukle
npm install

# .env dosyasi olustur
copy NUL .env
```

### .env Dosyasi

```env
PORT=3000
CORS_ORIGIN=https://YOUR-NETLIFY-SITE.netlify.app
API_KEY=guclu-bir-api-anahtari-buraya

# FreeCAD MCP (varsayilan: uvx freecad-mcp)
FREECAD_MCP_COMMAND=uvx
FREECAD_MCP_ARGS=freecad-mcp
FREECAD_MCP_CALL_TIMEOUT_MS=300000

# Claude CLI
CLAUDE_CLI_COMMAND=claude
CLAUDE_CLI_MODEL=
CLAUDE_CLI_TIMEOUT_MS=300000

# Dosya yollari
OUTPUT_DIR=output
DATA_DIR=data
```

### Backend Baslatma

```bash
# Normal calistirma
npm start

# Gelistirme modu (dosya degisikliklerinde otomatik yeniden baslar)
npm run dev
```

### Cloudflare Tunnel Kurulumu

```bash
# cloudflared yukle (Windows icin)
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Tunel olustur
cloudflared tunnel create rover-cad

# Tunel yapilandirmasi (~/.cloudflared/config.yml)
```

`config.yml` icerigi:

```yaml
tunnel: TUNNEL_ID_BURAYA
credentials-file: C:\Users\KULLANICI\.cloudflared\TUNNEL_ID.json

ingress:
  - hostname: api.YOUR-DOMAIN.com
    service: http://localhost:3000
  - service: http_status:404
```

```bash
# DNS kaydini olustur
cloudflared tunnel route dns rover-cad api.YOUR-DOMAIN.com

# Tuneli baslat
cloudflared tunnel run rover-cad
```

### Backend Guncelleme

```bash
# Projeyi cek
git pull origin claude/devam-et-vumbm2

# Bagimliliklari guncelle (yeni paket eklendiyse)
npm install

# Backend'i yeniden baslat
# Calistiriyorsan durdur (Ctrl+C) ve tekrar baslat:
npm start
```

---

## 3. Her Iki Taraf Icin Hizli Guncelleme

Branch'teki son degisiklikleri hem frontend hem backend'e yansitmak icin:

### Windows PC'de (Backend)

```bash
cd C:\path\to\rover-cad
git pull origin claude/devam-et-vumbm2
npm install
# Backend'i yeniden baslat
npm start
```

### Frontend (ayni PC'den veya herhangi bir yerden)

```bash
cd C:\path\to\rover-cad
npx netlify deploy --prod --dir=web
```

---

## 4. Sorun Giderme

### Backend baslamiyor
- `node --version` ile Node.js 18+ kontrol et
- `.env` dosyasinin dogru oldugundan emin ol
- `npm install` ile bagimliliklari tekrar yukle

### FreeCAD baglanti hatasi
- FreeCAD'in kurulu ve PATH'te oldugundan emin ol
- `uvx freecad-mcp` komutunun calistigini kontrol et
- Timeout'u artir: `FREECAD_MCP_CALL_TIMEOUT_MS=600000`

### Claude CLI hatasi
- `claude --version` ile CLI'in kurulu oldugunu kontrol et
- API anahtarinin gecerli oldugunu dogrula

### Netlify deploy hatasi
- `npx netlify status` ile giris durumunu kontrol et
- `npx netlify login` ile tekrar giris yap

### Cloudflare Tunnel baglanti kopuyor
- `cloudflared tunnel run rover-cad` komutunu tekrar calistir
- Windows'ta servis olarak kur: `cloudflared service install`
