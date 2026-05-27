# Akprays - Akakçe Fiyat Takibi

Akprays, Akakçe ve Epey üzerinden ürün aramayı, fiyat takibi yapmayı, fiyat geçmişini görüntülemeyi ve belirgin indirimlerde bildirim almayı kolaylaştıran bir Chrome uzantısıdır.

## Özellikler

- Akakçe ve Epey kaynaklarında aynı anda ürün arama
- Arama sonuçlarını en düşük fiyata göre sıralama
- Akakçe ve Epey sonuçlarını kaynak badge'leriyle ayırma
- Ürünleri bulut hesabına bağlı takip listesine ekleme
- Takipteki ürünleri arama sonuçlarında "Zaten takipte" olarak gösterme
- Fiyat değişimlerini renkli durumlarla gösterme
- Anlamlı fiyat değişimlerinde fiyat geçmişi kaydetme
- Fiyat geçmişi grafiği ve ürün bazlı analiz görünümü
- Ciddi fiyat düşüşlerini ana ekranda öne çıkarma
- Discord webhook ve WhatsApp CallMeBot bildirim desteği
- İncehesap Gaming Gecesi haftalık arşivi ve fiyat geçmişi
- Kampanya geri sayımları: Gaming Gecesi, İtopik Saatler, Acil Susam Açıl
- Dışa aktar / içe aktar işlemleri

## Kurulum

1. Chrome'da `chrome://extensions/` adresini açın.
2. Sağ üstten **Geliştirici modu** seçeneğini etkinleştirin.
3. **Paketlenmemiş öğe yükle** butonuna tıklayın.
4. Bu repo klasörünü seçin.
5. Uzantıyı açıp e-posta ve şifreyle giriş yapın.

## Kullanım

1. Arama sekmesinde ürün adını yazın.
2. Arama kaynaklarını seçin: `Akakçe`, `Epey` veya ikisi birlikte.
3. Sonuçlardan takip etmek istediğiniz üründe **Takibe Al** butonuna basın.
4. **Takip Edilenler** sekmesinden ürünleri yenileyebilir, analizlerini görebilir veya silebilirsiniz.
5. Ayarlar ikonundan bildirim ve kontrol ayarlarını düzenleyebilirsiniz.
6. **Gaming Gecesi** sekmesinde İncehesap Gaming Gecesi arşivini senkronize edip haftalık ürünleri inceleyebilirsiniz.

## Supabase

Uzantı kullanıcı hesabı, takip edilen ürünler, ayarlar ve bazı arşiv verileri için Supabase kullanır.

Gaming Gecesi arşivi için gerekli tablo/policy SQL'i:

```text
scripts/supabase-gaming-gecesi.sql
```

Supabase tarafında RLS açıksa ilgili tablolara `authenticated` rolü için select/insert/update/delete yetkilerinin verilmesi gerekir.

## Bildirimler

Discord bildirimi için bir webhook URL'si girilebilir.

WhatsApp bildirimi için CallMeBot kullanılır. Kurulum rehberi:

https://www.callmebot.com/blog/free-api-whatsapp-messages/

## Sınırlamalar

- Periyodik kontroller Chrome açıkken çalışır.
- Akakçe, Epey veya diğer siteler bot koruması uygulayabilir.
- Epey araması için sitenin kendi encoded arama URL formatı kullanılır; bazı durumlarda ürün sayfası arka planda geçici bir Chrome sekmesiyle okunur.
- Uzantı, mağazaların gösterdiği fiyatı okumaya çalışır; kupon, sepet indirimi veya anlık kampanyalar her zaman yakalanamayabilir.
- Gaming Gecesi verileri üçüncü taraf public kaynaktan senkronize edilir; kaynak erişilemezse arşiv güncellenmeyebilir.

## Geliştirme

Kodlar vanilla JavaScript, HTML ve CSS ile yazılmıştır. Manifest V3 kullanılır.

Temel kontroller:

```bash
node --check popup.js
node --check utils.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"
```

## Changelog

Sürüm notları için:

```text
CHANGELOG.md
```
