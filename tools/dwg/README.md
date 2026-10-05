# Mimari çizim okuma — Faz A (ücretsiz, sunucu tarafı)

Bir mimari projeyi LLM ile değiştirmenin ilk adımı: **önce okumayı sağlam oturtmak.**
Bu klasör o adımı, **CAD programı gerektirmeden ve lisans ödemeden** yapar.

## Neden GstarCAD içinde çalışan betik değil

`tools/gstarcad/` altındaki sonda, GstarCAD'in kendi Python API'siyle çalışıyordu.
Çalışır, ama üç bedeli var:

| | GstarCAD içinde | **ezdxf (burası)** |
|---|---|---|
| Maliyet | Ücretli lisans, kullanıcı başına | **Ücretsiz** (ezdxf MIT, ODA dönüştürücü bedava) |
| Nerede çalışır | Masaüstünde, GUI açıkken, `APPLOAD` ile | **Sunucuda, başsız** — FreeCAD akışımızla aynı |
| Öznitelikli blok okuma | **Programı çökertiyor** (bilinen kayıt) | **Güvenle okuyor** — test edildi |
| Bizim test edebilmemiz | Hayır, GstarCAD yok | **Evet, burada test edildi** |

Üçüncü satır mimari için belirleyici: kat planları öznitelikli bloklarla doludur —
kapı/pencere tipleri, mahal etiketleri, aks numaraları. Asıl bilgi orada.

GstarCAD sondası silinmedi; GstarCAD lisansınız varsa hâlâ geçerli bir yol. Ama
önerilen yol artık bu.

## Kurulum

```
pip install -r tools/dwg/requirements.txt
```

DXF için bu kadarı yeterli. **DWG** okumak isterseniz ek olarak ODA File Converter
(ücretsiz) gerekir: https://www.opendesign.com/guestfiles/oda_file_converter

Not: DWG'yi CAD programınızdan DXF olarak kaydedebiliyorsanız dönüştürücüye hiç
gerek yok.

## Kullanım

```
python tools/dwg/rover_oku.py cizim.dxf
python tools/dwg/rover_oku.py cizim.dwg -o envanter.json
```

## Ne çıkarır

- **Birim** (`$INSUNITS`) — mm mi cm mi; tanımsızsa uyarı verir
- **Katmanlar** + katman başına varlık sayısı + **boş katmanlar** (hangi katmanda
  gerçekten iş var)
- **Varlık türleri** ve adetleri
- **Bloklar**: adlar, kaç kez kullanıldığı ve **öznitelikleri** (tag → örnek değerler)
- **Ölçüler**: `DIMENSION` varlıklarının **ölçülen gerçek değerleri**
- **Yazılar**: TEXT/MTEXT içerikleri (MTEXT biçim kodları temizlenmiş)
- **Çizim sınırları** ve toplam boyut

## Doğrulanmış mı

Evet. Gerçek bir kat planını taklit eden test çizimi üretilip çalıştırıldı; çıkan
değerler çizime konan değerlerle birebir karşılaştırıldı:

| Konan | Okunan |
|---|---|
| 3 adet PENCERE bloğu | `PENCERE: 3` |
| Öznitelikler TIP=P1,P2,P3 · GENISLIK=1200 | aynen okundu |
| 1 adet KAPI, TIP=K1 | aynen okundu |
| 2 ölçü: 12000 ve 10000 mm | `olculen: 12000.0`, `10000.0` |
| Birim mm | `birim: mm` |
| 1 TEXT + 1 MTEXT | aynen, `\P` → satır sonu |
| A-BOS katmanı boş | boş katmanlar listesinde |

## Güvenlik

Dosya yalnızca okunur. Hiçbir kaydetme çağrısı yoktur, girdi dosyası değiştirilmez.
Yine de alışkanlık olarak projenin kopyası üzerinde çalışın.

## Sırada ne var

- **Faz A (burası)** — okuma. Sırada: LLM'in salt-okunur sorgu betiği üretmesi
  ("bu cephede kaç pencere var, ölçüleri ne") ve bunun backend'e bağlanması.
  Üretilen her betik çalıştırılmadan önce determinist bir kapıdan geçecek:
  yazma çağrısı içeren betik reddedilecek — prompta güvenilmeyecek.
- **Faz B** — şablonlu, kısıtlı düzenleme. ezdxf yazma da yapabildiği için bu yol
  açık; her işlem otomatik yedek + öncesi/sonrası raporuyla.
- **Faz C** — serbest betik, yalnızca dosyanın kopyası üzerinde.
