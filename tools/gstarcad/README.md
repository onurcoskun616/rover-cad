# GstarCAD köprüsü — Faz A (salt okuma)

Mimari projeleri LLM ile değiştirmenin ilk adımı: **önce okumayı sağlam oturtmak.**
Bu klasör o adımın araçlarını tutar. Henüz backend'e bağlı değil — kasıtlı olarak.

## Neden önce sonda

GstarCAD 2025 ve sonrası Python destekliyor (`pygcad`, 790+ arayüz, Python 3.11.8,
Windows 10+). Ama "API var" ile "bu sürümde şu çağrı şöyle çalışıyor" aynı şey değil.
Topluluk kayıtlarında canlı ortamda programı çökerten üç bilinen tuzak var:

| Tuzak | Ne oluyor | Burada ne yapıyoruz |
|---|---|---|
| COM / `win32com` | GstarCAD kendini Running Object Table'a koymuyor; bağlanma başarısız olunca `Dispatch`'e düşen kod **programın ikinci kopyasını açıp oturumu kilitliyor** | COM'a hiç dokunmuyoruz |
| `gcdbEntGet` (DXF grupları) ile nokta okumak | Süreç iz bırakmadan ölüyor | Kullanmıyoruz; geometri alt sınıf metotlarıyla okunuyor |
| Dosyadan gelen **öznitelikli blokların** özniteliklerini okumak | Cast başarılı oluyor, öznitelik okunurken program çöküyor | Sonda blok **adlarını** sayıyor, özniteliklere **dokunmuyor** |

Ayrıca kaydedilmiş bir dosyadan gelen varlıklar temel `GcDbEntity` olarak dönebiliyor;
alt sınıf özelliklerini okumak için downcast gerekiyor. Mimari proje okumak tam olarak
bu senaryo — yani okuma da en az yazma kadar dikkat istiyor.

Bu yüzden LLM'e betik ürettirmeden önce **ölçüyoruz.**

## `rover_oku_probe.py` — ne yapar

Açık çizimi **hiç değiştirmeden** tarar ve iki şeyi birden çıkarır:

1. **Çizimin envanteri** — katmanlar, katman başına varlık sayısı, varlık türleri,
   blok adları ve adetleri, yazı örnekleri (ölçüler ve etiketler burada), çizim
   sınırları, Z=0 düzlemi dışındaki varlık sayısı
2. **API sondası** — bu sürümde hangi metot isimlerinin gerçekten çalıştığı
   (`api_probe` bölümü). Katman adı `layer()` mi `getLayer()` mi, dosya adı
   `originalFileName()` mi — tahmin etmek yerine ölçüyoruz.

İkincisi uzun vadede daha değerli: Faz B'de LLM'e vereceğimiz sistem promptunu
bu çıktıya göre yazacağız, böylece üretilen kod ilk seferde çalışır.

## Kullanım — iki adım

Betik iki komut kaydeder. Sırayla çalıştırın; ikincisine ancak birincisi
geçtiyse geçin.

**Adım 1 — `ROVERTEST`** (boruhattı testi)
Hiçbir şey taramaz, hiçbir dosya yazmaz. Sadece şunu kanıtlar: Python yüklendi,
`@command()` kaydı çalıştı, pygcad erişilebilir ve açık bir çizim var. Burada
takılırsa sorun API'de değil kurulumdadır ve taramaya geçmenin anlamı yoktur.

**Adım 2 — `ROVEROKU`** (asıl tarama)
Açık çizimi salt-okunur tarar, özeti komut satırına yazar, ayrıntılı JSON'u
kullanıcı klasörünüze `rover_dwg_oku.json` olarak kaydeder.

Her iki adımda da önce `APPLOAD` ile `rover_oku_probe.py` dosyasını yükleyin.

Çıkan JSON'u paylaşın — Faz B'nin tasarımı ona göre yapılacak.

## Güvenlik

Betik hiçbir yazma işlemi yapmaz: tüm tablolar ve varlıklar yalnızca `kForRead` ile
açılır, hiçbir setter çağrılmaz, hiçbir varlık eklenmez/silinmez, çizim diske
kaydedilmez. Bu, kodda determinist olarak doğrulanıyor — `kForWrite`,
`appendGcDbEntity`, `setLayer`, `erase`, `saveAs` ve yukarıdaki üç tuzağın hiçbiri
betikte geçmiyor.

Yine de alışkanlık olarak **projenin bir kopyası üzerinde** çalıştırın.

## Sırada ne var

- **Faz A (burası)** — okuma. Sonda çalışınca, LLM'in salt-okunur sorgu betiği
  üretmesi (“bu cephede kaç pencere var, ölçüleri ne”) ve bunun backend'e bağlanması.
  Üretilen her betik çalıştırılmadan önce determinist bir kapıdan geçecek: yazma
  çağrısı içeren betik reddedilecek, prompta güvenilmeyecek.
- **Faz B** — şablonlu, kısıtlı düzenleme; her işlem otomatik yedek + öncesi/sonrası raporu.
- **Faz C** — serbest betik, yalnızca dosyanın kopyası üzerinde.

## Gereksinimler

- GstarCAD **2025 veya üzeri** (Python bu sürümle geldi)
- Python **3.11.8**, Windows 10+
- İkincil geliştirme (secondary development) paketini kapsayan lisans
