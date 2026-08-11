# TOPKAPIAI — Daha Sonra Yapılacaklar

Bu liste Supabase ve gerçek API canlıya alınana kadar korunacak ana takip listesidir.
Tamamlanan maddeler silinmeyecek, `[x]` olarak işaretlenecektir.

## 1. Supabase kurulumu

- [ ] Üretim için Supabase projesini oluştur.
- [ ] `supabase/migrations/202608110001_llm_quota.sql` migration dosyasını çalıştır.
- [ ] PostgreSQL tablolarını, indeksleri ve kota fonksiyonlarını doğrula.
- [ ] Email ile giriş sağlayıcısını etkinleştir.
- [ ] Google ile giriş sağlayıcısını ve OAuth izin ekranını yapılandır.
- [ ] `https://topkapikoleji.org/login.html` yönlendirme adresini ekle.
- [ ] Supabase callback adresini Google OAuth ayarlarına ekle.

## 2. Backend ve alan adı

- [ ] Node.js backend'i sürekli çalışan bir üretim sunucusuna kur.
- [ ] `api.topkapikoleji.org` DNS kaydını backend'e yönlendir.
- [ ] HTTPS sertifikasını etkinleştir.
- [ ] CORS'u yalnızca üretim alan adlarıyla sınırla.
- [ ] `/health` ve veritabanı bağlantı kontrollerini doğrula.

## 3. Üretim ortam değişkenleri

- [ ] `SUPABASE_URL` değerini sunucudaki `.env` dosyasına ekle.
- [ ] `SUPABASE_ANON_KEY` değerini sunucudaki `.env` dosyasına ekle.
- [ ] Doğrudan bağlantı veya session pooler kullanan `DATABASE_URL` değerini ekle.
- [ ] `ADMIN_EMAIL` değerini belirle.
- [ ] LLM sağlayıcı anahtarlarını yalnızca backend ortamında sakla.
- [ ] Gizli anahtarların GitHub'a veya frontend koduna girmediğini denetle.

## 4. Kullanıcı ve veri geçişi

- [ ] Geçici JSON kullanıcılarını PostgreSQL'e taşıyacak geçiş planını kesinleştir.
- [ ] Gerekli kullanıcıları Supabase Auth'a aktar veya parola yenileme akışı başlat.
- [ ] Üyelik planı, aylık limit ve kalan kullanım verilerini eşleştir.
- [ ] İlk yönetici hesabını oluştur ve admin yetkisini doğrula.
- [ ] E-posta doğrulama ve parola sıfırlama mesajlarını markaya göre düzenle.

## 5. LLM kota ve tüketim doğrulaması

- [ ] CAD, CAM ve simülasyon çağrılarının tamamının kota katmanından geçtiğini test et.
- [ ] OpenAI ve Claude giriş/çıkış/cache token ölçümlerini gerçek yanıtlarla doğrula.
- [ ] Eşzamanlı isteklerde atomik rezervasyon ve mahsuplaşmayı yük testiyle doğrula.
- [ ] Başarısız ve zaman aşımına uğrayan çağrılarda rezervasyon iadesini doğrula.
- [ ] Model bazlı USD maliyet raporunu kontrol et.
- [ ] Aylık 50.000 ücretsiz token yenilemesini test et.
- [ ] Kaçırılan cron yenilemesinin ilk istekte telafi edildiğini test et.

## 6. Dashboard ve admin'i gerçek veriye bağlama

- [ ] Dashboard'daki örnek veri modunu gerçek hesap verisine bağla.
- [ ] Admin kullanıcı, plan, durum ve kota işlemlerini PostgreSQL'e bağla.
- [ ] Admin LLM tüketim tablosunu gerçek rapor uçlarına bağla.
- [ ] Önizleme modunu üretimde kapat.
- [ ] Yetkisiz kullanıcıların `admin.html` ve admin API uçlarına erişemediğini test et.

## 7. Canlıya geçiş kontrolleri

- [ ] Kayıt, giriş, Google giriş, çıkış ve parola sıfırlama akışlarını uçtan uca test et.
- [ ] Ücretsiz limit dolduğunda doğru kullanıcı mesajının gösterildiğini doğrula.
- [ ] Mobil ve masaüstü tarayıcı testlerini tamamla.
- [ ] Veritabanı yedekleme ve geri yükleme planını etkinleştir.
- [ ] Hata kayıtları, uptime takibi ve kritik kullanım uyarılarını kur.
- [ ] Güvenlik ve oran sınırlama kontrollerini tamamla.
- [ ] GitHub Pages frontend'i ve API sürümünü birlikte yayınla.
- [ ] Canlı yayından sonra giriş, dashboard, admin ve birer CAD/CAM/simülasyon işlemini tekrar doğrula.
