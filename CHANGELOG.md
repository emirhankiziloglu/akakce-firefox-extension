# Changelog

## v3.4 sonrası

### Arama
- Akakçe aramasının yanına Epey araması eklendi.
- Arama kaynakları Akakçe ve Epey checkbox'larıyla seçilebilir hale getirildi.
- Arama butonu "Ara" olarak sadeleştirildi.
- Akakçe ve Epey sonuçları aynı listede, en düşük fiyat önce olacak şekilde gösteriliyor.
- Sonuç kartlarına kaynak badge'i eklendi: Akakçe mavi, Epey turuncu.
- Takipte olan ürünler arama sonuçlarında "Zaten takipte" olarak gösteriliyor.
- Epey araması için Epey'in `/kategori/e/{base64}/` URL formatı desteklendi.
- Epey ürün sayfası doğrudan okunamadığında arka planda Chrome sekmesi açarak DOM'dan ürün/fiyat okuma yedeği eklendi.
- Arama ekranındaki bozuk Türkçe karakterler düzeltildi.

### Takip edilen ürünler
- Fiyat durumuna göre renkli fiyat gösterimi eklendi: düşen, artan, sabit ve normal fiyatlar ayrıldı.
- Küçük fiyat değişimlerinin gereksiz history kaydı ve bildirim üretmesi engellendi.
- Fiyat değişmediğinde eski fiyatın üstü çizili gösterilmesi kaldırıldı.
- Chart noktaları yalnızca anlamlı fiyat değişimlerinde oluşacak şekilde düzenlendi.
- Ürün kartları daha kompakt hale getirildi.
- Yenile, analiz ve kart aksiyonları daha temiz ikonlu yapıya taşındı.
- Ürün özelindeki yenileme akışı tüm ürünleri taramak yerine ilgili ürüne odaklanacak şekilde iyileştirildi.

### Analiz ve fiyat geçmişi
- Akakçe fiyat analizi yakalama denemeleri eklendi, güvenilir olmayan kısımlar kaldırıldı.
- Ürün analizleri varsayılan olarak kapalı/collapsible yapı ile daha kompakt hale getirildi.
- Fiyat grafiği üzerinde tarih ve fiyat tooltip'i desteği geliştirildi.
- Ciddi fırsatlar görünümü eklendi; belirgin fiyat düşüşleri ana ekranda öne çıkarıldı.

### Gaming Gecesi
- Eski Siteler sekmesi kaldırıldı, yerine Gaming Gecesi sekmesi eklendi.
- İncehesap Gaming Gecesi haftalık arşivi Supabase üzerinde tutulacak şekilde eklendi.
- Haftalar, ürünler ve haftalık fiyat geçmişleri ayrı Supabase tablolarıyla desteklendi.
- Gaming Gecesi ürünleri hafta, kategori, stok ve arama filtresiyle listelenebilir hale getirildi.
- İncehesap Gaming Gecesi, İtopik Saatler ve Acil Susam Açıl geri sayım kartları eklendi.

### Mağaza ve kampanya denemeleri
- İtopya kampanya fiyatlarını SKU ve keyword ile eşleştirme denemeleri yapıldı.
- PttAVM kupon ve sepet fiyatı denemeleri geri alındı.
- Donanım Arşivi sıcak fırsatlar çekme denemeleri kaldırıldı; forum linki kısayol olarak bırakıldı.
- DataForSEO ve N11 deneysel takip kodları kaldırıldı.

### Hesap, Supabase ve ayarlar
- Giriş doğrulama ekranı ve oturum süresi dolduğunda daha düzgün hata yönetimi eklendi.
- Supabase JWT yenileme ve oturum temizleme akışı iyileştirildi.
- Takip edilen ürünler ve ayarlar için kullanıcı bazlı bulut verisi davranışı düzenlendi.
- Ayarlar butonu üst başlığa taşındı.
- WhatsApp CallMeBot ayarları için rehber bağlantısı eklendi.

### UI/UX
- Genel font, spacing, tab yerleşimi ve toolbar görünümü iyileştirildi.
- Takip edilenler filtreleri shadcn benzeri custom select yapısına taşındı.
- Arama ve kampanya kartları daha düzenli, kompakt ve okunur hale getirildi.
- Dışa aktar/içe aktar işlemleri üç nokta menüsüne taşındı.
