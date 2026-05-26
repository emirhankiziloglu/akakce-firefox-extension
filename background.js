import {
  loadSettings,
  loadTrackedProducts,
  saveTrackedProducts,
  detectBlockedPage,
  extractProductsFromHtml,
  sendDiscordNotification,
  sendWhatsAppNotification,
  formatPrice,
  isSignificantPriceChange,
  normalizePrice,
  checkItopyaCheaperPrice
} from './utils.js';
import { cloudSyncProduct, cloudAddPriceHistory } from './supabase.js';

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkPrices') {
    await checkAllPrices();
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  chrome.alarms.create('checkPrices', {
    periodInMinutes: Math.max(45, settings.checkInterval)
  });
});

async function checkAllPrices(isManual = false) {
  const products = await loadTrackedProducts();
  const settings = await loadSettings();

  if (products.length === 0) return;

  let updated = false;
  const total = products.length;

  for (let i = 0; i < products.length; i++) {
    const product = products[i];

    // İlerleme durumunu popup'a bildir
    chrome.runtime.sendMessage({
      action: 'scan_progress',
      current: i + 1,
      total,
      title: product.title || product.url
    }).catch(() => {});

    // Rate limiting: ürünler arası 6-10 sn bekleme
    if (i > 0) {
      const delay = Math.floor(Math.random() * 4000) + 6000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    // Her 10 üründe 20 sn dinlenme (CF rate limit reset)
    if (i > 0 && i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 20000));
    }

    try {
      let foundProduct = await fetchProductFromOpenTab(product);

      if (!foundProduct) {
        const response = await fetch(product.url, {
          headers: {
            'User-Agent': navigator.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': navigator.language
              ? `${navigator.language},tr;q=0.9,en-US;q=0.8`
              : 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
          }
        });
        const html = await response.text();

        if (!html) continue;

        if (detectBlockedPage(html)) {
          product.lastError = 'Akakçe geçici engellemesi. Bir sonraki turda tekrar denenecek.';
          break;
        }

        const parsedProducts = extractProductsFromHtml(html, product.url);
        foundProduct = parsedProducts.length > 0
          ? (parsedProducts.find(p => p.url === product.url) || parsedProducts[0])
          : null;
      }

      if (foundProduct && foundProduct.price > 0) {
        product.lastError = null;
        product.lastCheckedAt = new Date().toISOString();

        let shouldNotify = false;
        const previousPrice = product.currentPrice;
        const priceChanged = isSignificantPriceChange(product.currentPrice, foundProduct.price);
        
        let analysisChanged = false;
        const newAnalysis = foundProduct.akakceMarketAnalysis || null;
        if (JSON.stringify(product.akakceMarketAnalysis) !== JSON.stringify(newAnalysis)) {
          product.akakceMarketAnalysis = newAnalysis;
          analysisChanged = true;
        }

        let categoryChanged = false;
        if (foundProduct.category && foundProduct.category !== 'Diğer' && product.category !== foundProduct.category) {
          product.category = foundProduct.category;
          categoryChanged = true;
        }

        if (priceChanged) {
          product.previousPrice = product.currentPrice;
          product.currentPrice = foundProduct.price;

          if (product.targetPrice > 0) {
            if (product.currentPrice <= product.targetPrice && product.currentPrice < product.previousPrice) {
              shouldNotify = true;
            }
          } else {
            shouldNotify = true;
          }

          if (!product.priceHistory) product.priceHistory = [];
          product.priceHistory.push({ price: foundProduct.price, checkedAt: product.lastCheckedAt });
          if (product.priceHistory.length > 50) product.priceHistory.shift();
        }

        if (priceChanged || analysisChanged || categoryChanged) {
          updated = true;

          const cloudProduct = await cloudSyncProduct(product).catch(error => {
            product.lastError = 'Veritabanı güncellenemedi: ' + error.message;
            return null;
          });
          if (priceChanged && cloudProduct?.id) {
            await cloudAddPriceHistory(cloudProduct.id, foundProduct.price, product.lastCheckedAt).catch(error => {
              product.lastError = 'Fiyat geçmişi yazılamadı: ' + error.message;
            });
          }

          if (shouldNotify) {
            await sendDiscordNotification(settings, product, previousPrice, product.currentPrice);
            await sendWhatsAppNotification(settings, product, previousPrice, product.currentPrice);
            const notifTitle = product.targetPrice > 0 && product.currentPrice <= product.targetPrice
              ? '🎯 Hedef Fiyata İndi!'
              : 'Fiyat değişti';
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: notifTitle,
              message: `${product.title}\n${formatPrice(previousPrice)} → ${formatPrice(product.currentPrice)}`
            });
          }
        }

        if (await applyItopyaExactSkuUpgrade(product, products)) {
          updated = true;
        }
      } else {
        product.lastError = 'Fiyat okunamadı';
      }
    } catch (error) {
      product.lastError = 'Bağlantı hatası: ' + error.message;
    }
  }

  // Tarama bitti
  chrome.runtime.sendMessage({ action: 'scan_done', total }).catch(() => {});

  if (updated || products.length > 0) {
    await saveTrackedProducts(products);
  }
}

async function applyItopyaExactSkuUpgrade(product, products) {
  const isAkakceProduct = product.url?.includes('akakce.com');
  const sourcePrice = normalizePrice(product.currentPrice);
  if (!isAkakceProduct || !product.title || sourcePrice <= 0) return false;

  try {
    const itopyaProduct = await checkItopyaCheaperPrice(product.title, sourcePrice);
    const itopyaPrice = normalizePrice(itopyaProduct?.price);
    if (!itopyaProduct?.url || itopyaPrice <= 0 || itopyaPrice >= sourcePrice) return false;

    product.previousPrice = sourcePrice;
    product.currentPrice = itopyaPrice;
    product.url = itopyaProduct.url;
    product.title = itopyaProduct.title || product.title;
    product.store = 'İtopya';
    product.source = 'itopya';
    product.itopyaUpgradedAt = new Date().toISOString();
    if (!product.priceHistory) product.priceHistory = [];
    product.priceHistory.push({ price: itopyaPrice, checkedAt: product.itopyaUpgradedAt });
    if (product.priceHistory.length > 50) product.priceHistory.shift();
    await cloudSyncProduct(product).catch(() => {});
    await saveTrackedProducts(products);
    return true;
  } catch (itopyaErr) {
    console.warn('İtopya SKU kontrol hatası:', itopyaErr.message);
    return false;
  }
}

async function checkOnePrice(productRef) {
  const products = await loadTrackedProducts();
  const settings = await loadSettings();
  const product = products.find(item =>
    item.id === productRef?.id ||
    item.url === productRef?.url ||
    item.cloudId === productRef?.cloudId
  );

  if (!product) {
    throw new Error('Ürün takip listesinde bulunamadı.');
  }

  chrome.runtime.sendMessage({
    action: 'scan_progress',
    current: 1,
    total: 1,
    title: product.title || product.url
  }).catch(() => {});

  try {
    let foundProduct = await fetchProductFromOpenTab(product);

    if (!foundProduct) {
      const response = await fetch(product.url, {
        headers: {
          'User-Agent': navigator.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': navigator.language
            ? `${navigator.language},tr;q=0.9,en-US;q=0.8`
            : 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });
      const html = await response.text();

      if (!html) throw new Error('Sayfa boş döndü.');
      if (detectBlockedPage(html)) throw new Error('Bot koruması nedeniyle okunamadı. Ürün sayfasını açık tutup tekrar deneyin.');

      const parsedProducts = extractProductsFromHtml(html, product.url);
      foundProduct = parsedProducts.length > 0
        ? (parsedProducts.find(item => item.url === product.url) || parsedProducts[0])
        : null;
    }

    if (!foundProduct?.price) throw new Error('Fiyat okunamadı.');

    product.lastError = null;
    product.lastCheckedAt = new Date().toISOString();
    const previousPrice = product.currentPrice;
    const priceChanged = isSignificantPriceChange(product.currentPrice, foundProduct.price);
    
    let analysisChanged = false;
    const newAnalysis = foundProduct.akakceMarketAnalysis || null;
    if (JSON.stringify(product.akakceMarketAnalysis) !== JSON.stringify(newAnalysis)) {
      product.akakceMarketAnalysis = newAnalysis;
      analysisChanged = true;
    }

    let categoryChanged = false;
    if (foundProduct.category && foundProduct.category !== 'Diğer' && product.category !== foundProduct.category) {
      product.category = foundProduct.category;
      categoryChanged = true;
    }

    if (priceChanged || analysisChanged || categoryChanged) {
      if (priceChanged) {
        product.previousPrice = product.currentPrice;
        product.currentPrice = foundProduct.price;
        if (!product.priceHistory) product.priceHistory = [];
        product.priceHistory.push({ price: foundProduct.price, checkedAt: product.lastCheckedAt });
        if (product.priceHistory.length > 50) product.priceHistory.shift();
      }

      const cloudProduct = await cloudSyncProduct(product);
      if (priceChanged && cloudProduct?.id) {
        await cloudAddPriceHistory(cloudProduct.id, foundProduct.price, product.lastCheckedAt);
      }

      await saveTrackedProducts(products);

      if (priceChanged) {
        await sendDiscordNotification(settings, product, previousPrice, product.currentPrice);
        await sendWhatsAppNotification(settings, product, previousPrice, product.currentPrice);
      }
    }

    await applyItopyaExactSkuUpgrade(product, products);
    chrome.runtime.sendMessage({ action: 'scan_done', total: 1 }).catch(() => {});
    return product;
  } catch (error) {
    product.lastError = error.message;
    product.lastCheckedAt = new Date().toISOString();
    await cloudSyncProduct(product).catch(() => {});
    chrome.runtime.sendMessage({ action: 'scan_done', total: 1 }).catch(() => {});
    throw error;
  }
}

function fetchProductFromOpenTab(product) {
  return new Promise(resolve => {
    chrome.tabs.query({ url: [
      'https://*.akakce.com/*', 'https://akakce.com/*',
      'https://*.itopya.com/*', 'https://itopya.com/*',
      'https://*.incehesap.com/*', 'https://incehesap.com/*',
      'https://*.pttavm.com/*', 'https://pttavm.com/*',
      'https://*.n11.com/*', 'https://n11.com/*',
      'https://*.vatanbilgisayar.com/*', 'https://vatanbilgisayar.com/*'
    ] }, (tabs) => {
      const productTab = tabs.find(tab => sameProductUrl(tab.url, product.url));
      if (!productTab?.id) {
        resolve(null);
        return;
      }

      chrome.tabs.sendMessage(productTab.id, { action: 'extract_products' }, (response) => {
        if (chrome.runtime.lastError || !response?.products) {
          resolve(null);
          return;
        }
        const foundProduct = response.products.find(item => sameProductUrl(item.url, product.url)) || response.products[0];
        resolve(foundProduct?.price ? foundProduct : null);
      });
    });
  });
}

function sameProductUrl(left, right) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.hostname.replace(/^www\./, '') === rightUrl.hostname.replace(/^www\./, '') &&
      decodeURIComponent(leftUrl.pathname) === decodeURIComponent(rightUrl.pathname);
  } catch (error) {
    return left === right;
  }
}

async function handleAutoPriceUpdate(productInfo) {
  if (!productInfo?.url || !productInfo?.price) return false;

  const products = await loadTrackedProducts();
  const product = products.find(item => sameProductUrl(item.url, productInfo.url));

  if (!product) return false;

  const previousPrice = product.currentPrice;
  const newPrice = productInfo.price;
  const priceChanged = isSignificantPriceChange(previousPrice, newPrice);
  
  let analysisChanged = false;
  const newAnalysis = productInfo.akakceMarketAnalysis || null;
  if (JSON.stringify(product.akakceMarketAnalysis) !== JSON.stringify(newAnalysis)) {
    product.akakceMarketAnalysis = newAnalysis;
    analysisChanged = true;
  }

  let categoryChanged = false;
  if (productInfo.category && productInfo.category !== 'Diğer' && product.category !== productInfo.category) {
    product.category = productInfo.category;
    categoryChanged = true;
  }

  if (priceChanged || analysisChanged || categoryChanged) {
    product.lastError = null;
    product.lastCheckedAt = new Date().toISOString();

    if (priceChanged) {
      product.previousPrice = previousPrice;
      product.currentPrice = newPrice;

      if (!product.priceHistory) product.priceHistory = [];
      product.priceHistory.push({ price: newPrice, checkedAt: product.lastCheckedAt });
      if (product.priceHistory.length > 50) product.priceHistory.shift();
    }

    const cloudProduct = await cloudSyncProduct(product).catch(err => {
      product.lastError = 'Veritabanı güncellenemedi: ' + err.message;
      return null;
    });

    if (priceChanged && cloudProduct?.id) {
      await cloudAddPriceHistory(cloudProduct.id, newPrice, product.lastCheckedAt).catch(err => {
        product.lastError = 'Fiyat geçmişi yazılamadı: ' + err.message;
      });
    }

    await saveTrackedProducts(products);

    let shouldNotify = false;
    if (priceChanged) {
      if (product.targetPrice > 0) {
        if (newPrice <= product.targetPrice && newPrice < previousPrice) {
          shouldNotify = true;
        }
      } else if (newPrice < previousPrice) {
        shouldNotify = true;
      }
    }

    if (shouldNotify) {
      const settings = await loadSettings();
      await sendDiscordNotification(settings, product, previousPrice, newPrice);
      await sendWhatsAppNotification(settings, product, previousPrice, newPrice);

      const notifTitle = product.targetPrice > 0 && newPrice <= product.targetPrice
        ? '🎯 Hedef Fiyata İndi!'
        : 'Fiyat değişti';
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: notifTitle,
        message: `${product.title}\n${formatPrice(previousPrice)} → ${formatPrice(newPrice)}`
      });
    }

    chrome.runtime.sendMessage({ action: 'product_updated', product }).catch(() => {});
    return true;
  }

  return false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'check_now') {
    checkAllPrices(true).then(() => sendResponse({ success: true }));
    return true;
  }
  if (request.action === 'check_product') {
    checkOnePrice(request.product)
      .then(product => sendResponse({ success: true, product }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (request.action === 'get_tracked_products') {
    loadTrackedProducts()
      .then(products => sendResponse({ success: true, products }))
      .catch(error => sendResponse({ success: false, error: error.message, products: [] }));
    return true;
  }
  if (request.action === 'track_product') {
    let productToTrack = request.product;
    (async () => {
      try {
        let wasItopyaCheaper = false;
        if (productToTrack.url?.includes('akakce.com')) {
          const sourcePrice = normalizePrice(productToTrack.currentPrice);
          const cheaperItopya = await checkItopyaCheaperPrice(productToTrack.title, sourcePrice);
          const itopyaPrice = normalizePrice(cheaperItopya?.price);
          if (cheaperItopya?.url && itopyaPrice > 0 && itopyaPrice < sourcePrice) {
            productToTrack = {
              ...productToTrack,
              id: btoa(encodeURIComponent(cheaperItopya.url)).replace(/=/g, '').slice(-30),
              url: cheaperItopya.url,
              title: cheaperItopya.title || productToTrack.title,
              imageUrl: cheaperItopya.imageUrl || productToTrack.imageUrl || '',
              currentPrice: itopyaPrice,
              previousPrice: itopyaPrice,
              store: 'İtopya',
              source: 'itopya',
              akakceMarketAnalysis: cheaperItopya.akakceMarketAnalysis || null,
              category: productToTrack.category || 'Diğer',
              priceHistory: [{ price: itopyaPrice, checkedAt: new Date().toISOString() }]
            };
            wasItopyaCheaper = true;
          }
        }
        const synced = await cloudSyncProduct(productToTrack, { includeHistory: true });
        sendResponse({ success: true, product: synced, wasItopyaCheaper });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }
  if (request.action === 'auto_price_update') {
    handleAutoPriceUpdate(request.product)
      .then(updated => sendResponse({ success: true, updated }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});
