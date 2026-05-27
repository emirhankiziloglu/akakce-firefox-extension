if (window.__akpraysContentLoaded) {
  // content.js can be injected both by the manifest and manually from the popup.
  // Keep the second injection inert so listeners/UI are not duplicated.
} else {
window.__akpraysContentLoaded = true;

const SUPPORTED_SELLER_DOMAINS = [
  { name: 'İtopya', pattern: /itopya\.com/i },
  { name: 'Incehesap', pattern: /incehesap\.com/i },
  { name: 'PttAVM', pattern: /pttavm\.com/i },
  { name: 'n11', pattern: /n11\.com/i },
  { name: 'Vatan Bilgisayar', pattern: /vatanbilgisayar\.com/i }
];

function getSupportedStore(url) {
  try {
    const host = new URL(url).hostname;
    return SUPPORTED_SELLER_DOMAINS.find(store => store.pattern.test(host));
  } catch (e) {
    return null;
  }
}

function parseLoosePrice(text) {
  if (!text) return 0;
  const cleanText = text.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s/g, ' ').trim();
  const match = cleanText.match(/(\d[\d.\s]*,\d{2}|\d[\d.\s]*)/);
  if (!match) return 0;
  const normalized = match[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const price = Number.parseFloat(normalized);
  return Number.isFinite(price) ? price : 0;
}

function extractEpeyProductFromDom(doc, pageUrl) {
  if (!/epey\.com/i.test(pageUrl) || !/\.html(?:$|[?#])/i.test(pageUrl)) return null;

  const title = (doc.querySelector('h1')?.textContent || doc.title || '')
    .replace(/\s+-\s+Epey.*$/i, '')
    .trim();
  const offerRoot = doc.querySelector('#fiyatlar') ||
    doc.querySelector('[id*="fiyat" i]') ||
    Array.from(doc.querySelectorAll('section, div, table, ul')).find(node => /Sat(?:\u0131|i)c(?:\u0131|i)ya Git|Siteye Git|Ma(?:\u011f|g)azaya Git/i.test(node.textContent || ''));
  if (!offerRoot) return null;

  const rowTexts = Array.from(offerRoot.querySelectorAll('tr, li, article, .row, [class*="fiyat" i], [class*="price" i]'))
    .map(node => node.textContent || '')
    .filter(text => /TL|\u20ba/.test(text) && /Sat(?:\u0131|i)c(?:\u0131|i)ya Git|Siteye Git|Ma(?:\u011f|g)azaya Git|Stokta|Kargo/i.test(text));
  const scoped = rowTexts.length ? rowTexts.join('\n') : offerRoot.textContent || '';
  const prices = scoped
    .split(/\n+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => /TL|\u20ba/.test(line) && !/taksit|\/\s*ay|ayda|puan|yorum|de(?:\u011f|g)erlendirme|benzer|(?:\u00f6|o)nerilen/i.test(line))
    .flatMap(line => [...line.matchAll(/(\d[\d.\s]*,\d{2})\s*(?:TL|\u20ba)/g)].map(match => parseLoosePrice(match[1])))
    .filter(price => price > 0)
    .sort((a, b) => a - b);
  if (prices.length === 0) return null;

  const id = btoa(encodeURIComponent(pageUrl)).replace(/=/g, '').slice(-30);
  return {
    id,
    title: title || 'Epey \u00dcr\u00fcn\u00fc',
    price: prices[0],
    url: pageUrl,
    store: 'Epey',
    category: getProductCategory(doc),
    source: 'epey'
  };
}

function getCategoryFromUrl(url) {
  try {
    const urlObj = new URL(url);
    if (urlObj.hostname.includes('akakce.com')) {
      const segments = urlObj.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        const rawCat = segments[0].toLowerCase();
        const map = {
          'power-supply': 'Power Supply',
          'ssd': 'SSD',
          'ram': 'RAM',
          'anakart': 'Anakart',
          'islemci': 'İşlemci',
          'ekran-karti': 'Ekran Kartı',
          'bilgisayar-kasa': 'Bilgisayar Kasası',
          'sivi-sogutma': 'Sıvı Soğutma',
          'islemci-sogutucu': 'İşlemci Soğutucu',
          'monitor': 'Monitör'
        };
        if (map[rawCat]) return map[rawCat];
        return segments[0]
          .split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }
    }
  } catch (e) {}
  return null;
}

function getProductCategory(doc = document, url = window.location.href) {
  let category = 'Diğer';
  const urlCategory = getCategoryFromUrl(url);
  
  // 1. Try DOM parsing within breadcrumb containers only
  const bcContainer = doc.querySelector('nav#BC_v8, [itemtype*="BreadcrumbList"], .breadcrumbs, .breadcrumb');
  if (bcContainer) {
    const listItems = bcContainer.querySelectorAll('li');
    if (listItems.length >= 4) {
      const li = listItems[3];
      const nameEl = li.querySelector('span[itemprop="name"], a, span');
      category = nameEl ? nameEl.textContent : li.textContent;
    } else if (listItems.length >= 2) {
      const li = listItems[listItems.length - 2];
      const nameEl = li.querySelector('span[itemprop="name"], a, span');
      category = nameEl ? nameEl.textContent : li.textContent;
    }
  }
  
  // Clean up and safety-check text
  if (category) {
    category = category.trim().replace(/\s*>\s*/g, '').trim();
    if (category.includes('{') || category.includes('}') || category.includes('function') || category.length > 60) {
      category = 'Diğer';
    }
  }
  
  // 2. Akakçe URLs carry the specific category in the first path segment.
  // Prefer that over generic breadcrumbs like "Bilgisayar Bileşenleri".
  if (urlCategory && (!category || category === 'Diğer' || isGenericCategory(category))) {
    category = urlCategory;
  }
  
  return category || 'Diğer';
}

function isGenericCategory(category) {
  const normalized = String(category || '').toLocaleLowerCase('tr-TR');
  return [
    'bilgisayar bileşenleri',
    'bilgisayar, donanım',
    'bilgisayar',
    'diğer'
  ].includes(normalized);
}

function extractSellerProductFromDom(doc = document, url = window.location.href) {
  const storeObj = getSupportedStore(url);
  if (!storeObj) return null;

  let title = '';
  let price = 0;
  let originalPrice = 0;
  let discountType = null;

  const h1 = doc.querySelector('h1');
  if (h1) {
    title = h1.textContent.trim().replace(/\s+/g, ' ');
  } else {
    title = doc.title ? doc.title.split('-')[0].trim() : '';
  }
  if (title.endsWith('Fiyatı')) title = title.substring(0, title.length - 6).trim();

  const hostname = new URL(url).hostname;
  if (hostname.includes('itopya.com')) {
    const priceNode = doc.querySelector('.price') || doc.querySelector('.product-price strong');
    let basePrice = priceNode ? parseLoosePrice(priceNode.textContent) : 0;
    const warningNode = doc.querySelector('.product-price-warning') || doc.querySelector('.product-price-warning strong');
    let discountPrice = warningNode ? parseLoosePrice(warningNode.textContent) : 0;
    if (discountPrice > 0) {
      price = discountPrice;
      originalPrice = basePrice;
      discountType = 'sepette';
    } else {
      price = basePrice;
    }
  } else if (hostname.includes('incehesap.com')) {
    const priceNode = doc.querySelector('#price') || doc.querySelector('.price') || doc.querySelector('.product-price') || doc.querySelector('span[itemprop="price"]');
    let basePrice = priceNode ? parseLoosePrice(priceNode.textContent) : 0;
    const sepetNode = doc.querySelector('.sepet-price') || doc.querySelector('.sepet-fiyat') || doc.querySelector('.basket-price');
    let discountPrice = sepetNode ? parseLoosePrice(sepetNode.textContent) : 0;
    if (discountPrice > 0) {
      price = discountPrice;
      originalPrice = basePrice;
      discountType = 'sepette';
    } else {
      price = basePrice;
    }
  } else if (hostname.includes('pttavm.com')) {
    const priceNode = doc.querySelector('.price') || doc.querySelector('.new-price') || doc.querySelector('.discount-price');
    price = priceNode ? parseLoosePrice(priceNode.textContent) : 0;
    const textNodes = Array.from(doc.querySelectorAll('.badge, .discount-badge, span, div'));
    const sepetNode = textNodes.find(node => /sepette\s*(?:%?\s*\d+|\d+\s*%?)\s*indirim/i.test(node.textContent));
    if (sepetNode && price > 0) {
      const cartPriceNode = doc.querySelector('.sepet-price') || doc.querySelector('.cart-price');
      if (cartPriceNode) {
        const cp = parseLoosePrice(cartPriceNode.textContent);
        if (cp > 0 && cp < price) {
          originalPrice = price;
          price = cp;
          discountType = 'sepette';
        }
      }
    }
  } else if (hostname.includes('n11.com')) {
    const priceNode = doc.querySelector('.newPrice') || doc.querySelector('.price') || doc.querySelector('.ins-price-value');
    let basePrice = priceNode ? parseLoosePrice(priceNode.textContent) : 0;
    const sepetNode = doc.querySelector('.sepet-indirim') || doc.querySelector('.basket-price') || doc.querySelector('.instant-discount');
    let discountPrice = sepetNode ? parseLoosePrice(sepetNode.textContent) : 0;
    if (discountPrice > 0) {
      price = discountPrice;
      originalPrice = basePrice;
      discountType = 'sepette';
    } else {
      price = basePrice;
    }
  } else if (hostname.includes('vatanbilgisayar.com')) {
    const priceNode = doc.querySelector('.product-list__price') || doc.querySelector('.product-price');
    let basePrice = priceNode ? parseLoosePrice(priceNode.textContent) : 0;
    const sepetNode = doc.querySelector('.sepette-indirim') || doc.querySelector('.sepet-discount');
    let discountPrice = sepetNode ? parseLoosePrice(sepetNode.textContent) : 0;
    if (discountPrice > 0) {
      price = discountPrice;
      originalPrice = basePrice;
      discountType = 'sepette';
    } else {
      price = basePrice;
    }
    if (doc.body && doc.body.textContent.includes("Web'e Özel")) {
      discountType = 'webe_ozel';
    }
  }

  if (price === 0) {
    const priceNode = doc.querySelector('.price, .fiyat, span[class*="price"], div[class*="price"]');
    if (priceNode) price = parseLoosePrice(priceNode.textContent);
  }

  if (price > 0) {
    const uniqueId = btoa(encodeURIComponent(url)).replace(/=/g, '').slice(-30);
    const akakceMarketAnalysis = discountType ? {
      discountType,
      originalPrice: originalPrice || price,
      discountPrice: price
    } : null;

    return {
      id: uniqueId,
      title: title || `${storeObj.name} Ürünü`,
      price,
      url,
      store: storeObj.name,
      akakceMarketAnalysis,
      category: getProductCategory(doc, url)
    };
  }

  return null;
}

function normalizePrice(text) {
  if (!text) return 0;
  let cleaned = text.replace(/TL|₺/gi, '').replace(/\s/g, '').replace(/&nbsp;/g, '').trim();
  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    cleaned = cleaned.replace(',', '.');
  } else if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    if (parts[parts.length - 1].length === 3) {
      cleaned = cleaned.replace(/\./g, '');
    }
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function extractProductsFromDom(doc = document, baseUrl = window.location.href) {
  const storeObj = getSupportedStore(baseUrl);
  if (storeObj) {
    const p = extractSellerProductFromDom(doc, baseUrl);
    return p ? [p] : [];
  }

  const products = [];
  const productNodes = doc.querySelectorAll('li > a[href], .pw_v8, .p_v8, .pw_m, li.p, .v_v8, ul#APL > li, ul#CPL > li, ul#PL > li, ul.pl_v9 > li, ul.pl_v8 > li, li.p_w_v8');
  
  productNodes.forEach(node => {
    const linkNode = node.tagName.toLowerCase() === 'a' ? node : (node.querySelector('a.iC') || node.querySelector('a'));
    if (!linkNode) return;
    
    const url = linkNode.getAttribute('href');
    if (!url || url.startsWith('javascript')) return;
    
    const titleNode = node.querySelector('h3, .pn_v8, .pt_v8, h2');
    const title = titleNode ? titleNode.textContent.trim() : linkNode.getAttribute('title') || linkNode.textContent.trim();
    if (!title) return;
    
    const priceNode = node.querySelector('.pt_v8, .pb_v8, span.pt_v8, .price, .p_c_v8, .pt_v9, .pt_v10');
    let priceText = priceNode ? priceNode.textContent : '';
    
    if (!priceText) {
      const bNodes = node.querySelectorAll('b, strong, span');
      for (const b of bNodes) {
        if (b.textContent.includes('TL') || b.textContent.includes('₺')) {
          priceText = b.textContent;
          break;
        }
      }
    }
    
    const price = normalizePrice(priceText);
    if (price === 0) return;
    
    const storeNode = node.querySelector('.s_v8, .v_v8, .seller');
    const store = storeNode ? storeNode.textContent.trim() : 'Bilinmiyor';
    
    const origin = url.startsWith('http') ? new URL(url).origin : new URL(baseUrl).origin;
    const fullUrl = url.startsWith('http') ? url : origin + (url.startsWith('/') ? '' : '/') + url;
    
    if (!products.find(p => p.url === fullUrl)) {
      const uniqueId = btoa(encodeURIComponent(fullUrl)).replace(/=/g, '').slice(-30);
      products.push({
        id: uniqueId,
        title,
        price,
        url: fullUrl,
        store
      });
    }
  });

  if (products.length === 0) {
    const islands = doc.querySelectorAll('astro-island[props]');
    for (const island of islands) {
      try {
        const props = JSON.parse(island.getAttribute('props'));
        if (props.spotPg && props.spotPg[1] && props.spotPg[1].price) {
          const price = parseFloat(props.spotPg[1].price[1]);
          const vdName = props.spotPg[1].vdName ? props.spotPg[1].vdName[1] : '';
          const pgNick = props.spotPg[1].pgNick ? props.spotPg[1].pgNick[1] : '';
          const store = pgNick ? `${vdName}/${pgNick}` : vdName;
          let title = '';
          try {
            if (props.metadata && props.metadata[1] && props.metadata[1].name) {
              title = props.metadata[1].name[1];
            }
          } catch(e) {}
          
          if (!title || typeof title !== 'string') {
            const titleNode = doc.querySelector('h1');
            title = titleNode ? titleNode.textContent.trim() : (doc.title ? doc.title.split('Fiyatları')[0].split('-')[0].trim() : 'Akakçe Ürünü');
          }
          if (price > 0) {
            const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
            products.push({
              id: uniqueId,
              title,
              price,
              url: baseUrl,
              store: store || 'Bilinmiyor'
            });
            return products;
          }
        }
      } catch (e) {}
    }

    const titleNode = doc.querySelector('h1');
    let title = titleNode ? titleNode.textContent.trim() : '';
    if (!title && doc.title) {
       title = doc.title.split('Fiyatları')[0].split('-')[0].trim() || 'Akakçe Ürünü';
    }
    
    const priceNode = doc.querySelector('.pt_v8, .pb_v8, span.pt_v8, .price, .pt_v9, .pt_v10');
    let priceText = priceNode ? priceNode.textContent : '';
    
    if (!priceText) {
      const priceMeta = doc.querySelector('meta[itemprop="price"]');
      if (priceMeta) priceText = priceMeta.getAttribute('content');
    }
    
    if (!priceText) {
       const bNodes = doc.querySelectorAll('b, strong, span');
        for (const b of bNodes) {
          if (b.textContent.includes('TL') || b.textContent.includes('₺')) {
            priceText = b.textContent;
            break;
          }
        }
    }
    const price = normalizePrice(priceText);
    
    if (price > 0) {
      const storeNode = doc.querySelector('.v_v8, .seller_name, .s_v8');
      const store = storeNode ? storeNode.textContent.trim() : 'Bilinmiyor';
      
      const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
      products.push({
        id: uniqueId,
        title,
        price,
        url: baseUrl,
        store
      });
    }
  }

  return products;
}

function appendMainProduct(products) {
  const mainProduct = getMainProduct();
  if (mainProduct && !products.some(product => product.url === mainProduct.url)) {
    products.unshift(mainProduct);
  }
  return products;
}

function getMainProduct() {
  const epeyProduct = extractEpeyProductFromDom(document, window.location.href);
  if (epeyProduct) return epeyProduct;

  const storeObj = getSupportedStore(window.location.href);
  if (storeObj) {
    return extractSellerProductFromDom(document, window.location.href);
  }

  const islands = document.querySelectorAll('astro-island[props]');
  for (const island of islands) {
    try {
      const props = JSON.parse(island.getAttribute('props'));
      if (props.spotPg && props.spotPg[1] && props.spotPg[1].price) {
        const price = parseFloat(props.spotPg[1].price[1]);
        if (price > 0) {
          const vdName = props.spotPg[1].vdName ? props.spotPg[1].vdName[1] : '';
          const pgNick = props.spotPg[1].pgNick ? props.spotPg[1].pgNick[1] : '';
          const store = pgNick ? `${vdName}/${pgNick}` : vdName;
          
          let title = '';
          try {
             if (props.metadata && props.metadata[1] && props.metadata[1].name) {
               title = props.metadata[1].name[1];
             }
          } catch(e) {}
          if (!title || typeof title !== 'string') {
            const h1 = document.querySelector('h1');
            title = h1 ? h1.textContent.trim() : document.title.split('Fiyatları')[0].split('-')[0].trim();
          }
          const uniqueId = btoa(encodeURIComponent(window.location.href)).replace(/=/g, '').slice(-30);
          return {
            id: uniqueId,
            title: title || 'Akakçe Ürünü',
            price,
            url: window.location.href,
            store: store || 'Bilinmiyor',
            category: getProductCategory(document)
          };
        }
      }
    } catch(e) {}
  }

  const h1 = document.querySelector('h1');
  let title = h1 ? h1.textContent.trim() : '';
  if (!title && document.title) {
     title = document.title.split('Fiyatları')[0].split('-')[0].trim();
  }
  
  const priceNode = document.querySelector('.pt_v8, .pb_v8, span.pt_v8, .price, .pt_v9, .pt_v10');
  let priceText = priceNode ? priceNode.textContent : '';
  if (!priceText) {
    const bNodes = document.querySelectorAll('.pt_v8, b, strong, span');
    for (const b of bNodes) {
      if (b.textContent.includes('TL') || b.textContent.includes('₺')) {
        priceText = b.textContent;
        break;
      }
    }
  }
  const price = normalizePrice(priceText);
  
  if (price > 0) {
     let store = 'Bilinmiyor';
     const storeNode = document.querySelector('.v_v8, .seller_name, .s_v8');
     if (storeNode) {
       store = storeNode.textContent.trim();
       if (!store) {
          const img = storeNode.querySelector('img');
          if (img) store = img.getAttribute('alt') || img.getAttribute('title') || 'Bilinmiyor';
       }
     }
     
     const uniqueId = btoa(encodeURIComponent(window.location.href)).replace(/=/g, '').slice(-30);
     return {
        id: uniqueId,
        title: title || 'Akakçe Ürünü',
        price,
        url: window.location.href,
        store: store || 'Bilinmiyor',
        category: getProductCategory(document)
     };
  }
  return null;
}

function initTrackerUI() {
  const isSearchPage = window.location.href.includes('arama') || window.location.search.includes('q=');
  if (isSearchPage) return;

  const mainProduct = getMainProduct();
  if (!mainProduct) return;

  // Send auto price update on page load (Option C - Hybrid approach)
  chrome.runtime.sendMessage({
    action: 'auto_price_update',
    product: {
      ...mainProduct,
      currentPrice: mainProduct.price,
      lastCheckedAt: new Date().toISOString()
    }
  });

  chrome.runtime.sendMessage({ action: 'get_tracked_products' }, (result) => {
    const trackedProducts = result?.products || [];
    const existing = trackedProducts.some(product => product.id === mainProduct.id || product.url === mainProduct.url);

    // 1. Floating Button (Bottom Right)
    const container = document.createElement('div');
    container.id = 'akakce-tracker-injected-ui';
    
    let btnHtml = '';
    if (existing) {
      btnHtml = `<button class="ak-tracker-btn ak-tracked" id="ak-tracker-btn">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
        Takip Ediliyor
      </button>`;
    } else {
      btnHtml = `<button class="ak-tracker-btn" id="ak-tracker-btn">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg>
        Takibe Al
      </button>`;
    }

    container.innerHTML = btnHtml;
    document.body.appendChild(container);
    const floatBtn = document.getElementById('ak-tracker-btn');

    // 2. Inline Button (Under Satıcıya Git) - only attempt if we have a target element
    let targetEl = Array.from(document.querySelectorAll('a, button, span')).find(el => 
       el.textContent && (el.textContent.trim() === 'Satıcıya Git' || el.textContent.trim() === 'Siparişe Git')
    );
    if (!targetEl) {
       targetEl = document.querySelector('.pt_v8, .pb_v8, span.pt_v8, .price, .pt_v9, .pt_v10');
    }

    let inlineBtn = null;
    if (targetEl) {
      const inlineBtnWrapper = document.createElement('div');
      inlineBtnWrapper.style.width = '100%';
      inlineBtnWrapper.style.marginTop = '10px';
      inlineBtnWrapper.style.marginBottom = '10px';
      
      inlineBtn = document.createElement('button');
      inlineBtn.className = existing ? 'ak-tracker-btn ak-tracked' : 'ak-tracker-btn';
      inlineBtn.style.width = '100%';
      inlineBtn.style.justifyContent = 'center';
      inlineBtn.style.padding = '14px';
      inlineBtn.style.fontSize = '16px';
      inlineBtn.innerHTML = existing 
        ? `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Takip Ediliyor`
        : `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/></svg> Fiyatı Takip Et`;
        
      inlineBtnWrapper.appendChild(inlineBtn);
      
      // Insert after target element
      if (targetEl.parentNode) {
        targetEl.parentNode.insertBefore(inlineBtnWrapper, targetEl.nextSibling);
      }
    }

    // Direct Add Logic
    const handleTrack = (e) => {
      e.preventDefault();
      if (floatBtn && floatBtn.classList.contains('ak-tracked')) return;
      
      const newProduct = {
        ...mainProduct,
        currentPrice: mainProduct.price,
        previousPrice: mainProduct.price,
        targetPrice: 0,
        currency: 'TL',
        lastCheckedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        source: 'akakce',
        priceHistory: [{ price: mainProduct.price, checkedAt: new Date().toISOString() }]
      };
      
      chrome.runtime.sendMessage({ action: 'track_product', product: newProduct }, (response) => {
        if (response?.success) {
          const successHtml = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Takip Ediliyor`;
          
          if (floatBtn) {
             floatBtn.classList.add('ak-tracked');
             floatBtn.innerHTML = successHtml;
          }
          
          if (inlineBtn) {
             inlineBtn.classList.add('ak-tracked');
             inlineBtn.innerHTML = successHtml;
          }
        } else {
          console.error('Akprays cloud tracking failed:', response?.error || chrome.runtime.lastError?.message);
        }
      });
    };

    if (!existing) {
      if (floatBtn) floatBtn.addEventListener('click', handleTrack);
      if (inlineBtn) inlineBtn.addEventListener('click', handleTrack);
    }
  });
}

if (typeof window !== 'undefined') {
  setTimeout(initTrackerUI, 1000);
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extract_products') {
      sendResponse({ products: appendMainProduct(extractProductsFromDom()) });
    } else if (request.action === 'fetch_url') {
      fetch(request.url, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
        }
      })
      .then(res => res.text())
      .then(html => sendResponse({ html: html }))
      .catch(err => sendResponse({ error: err.message }));
      return true; // Keep message channel open for async
    }
  });
}
}
