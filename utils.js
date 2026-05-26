import {
  getSession,
  cloudLoadTrackedProducts,
  cloudSyncProduct,
  cloudGetSettings,
  cloudSaveSettings
} from './supabase.js';

function normalizePrice(text) {
  if (!text) return 0;
  if (typeof text === 'number') return Number.isFinite(text) ? text : 0;
  let cleaned = String(text).replace(/TL|₺/gi, '').replace(/\s/g, '').replace(/&nbsp;/g, '').trim();
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

function formatPrice(number) {
  return number.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' TL';
}

function calculatePriceChange(oldPrice, newPrice) {
  const diff = newPrice - oldPrice;
  const percent = oldPrice > 0 ? (diff / oldPrice) * 100 : 0;
  return { diff, percent: percent.toFixed(2) };
}

const MIN_SIGNIFICANT_PRICE_CHANGE = 1;

function isSignificantPriceChange(oldPrice, newPrice) {
  const oldValue = Number(oldPrice);
  const newValue = Number(newPrice);
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) return false;
  return Math.abs(newValue - oldValue) >= MIN_SIGNIFICANT_PRICE_CHANGE;
}

function detectBlockedPage(html) {
  const lowerHtml = html.toLowerCase();

  // Cloudflare Challenge Pages
  if (html.includes('id="cf-challenge-form"')) return true;
  if (html.includes('id="challenge-running"')) return true;
  if (html.includes('class="cf-browser-verification"')) return true;
  if (lowerHtml.includes('<title>just a moment...</title>')) return true;
  if (lowerHtml.includes('<title>attention required! | cloudflare</title>')) return true;

  // Generic Captcha / Security Pages
  if (lowerHtml.includes('<title>güvenlik kontrolü</title>')) return true;
  if (lowerHtml.includes('<title>erişim reddedildi</title>')) return true;

  return false;
}

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

function extractSellerPriceRegex(html, domain) {
  let title = '';
  let price = 0;
  let originalPrice = 0;
  let discountType = null;

  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = titleMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (title.endsWith('Fiyatı')) title = title.substring(0, title.length - 6).trim();
  }

  if (domain.includes('itopya.com')) {
    const warningMatch = html.match(/class="[^"]*product-price-warning[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (warningMatch) {
      const p = parseLoosePrice(warningMatch[1]);
      if (p > 0) {
        price = p;
        discountType = 'sepette';
      }
    }
    const stdPriceMatch = html.match(/class="[^"]*product-price[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (stdPriceMatch) {
      const p = parseLoosePrice(stdPriceMatch[1]);
      if (p > 0) {
        if (price > 0 && price < p) {
          originalPrice = p;
        } else if (price === 0) {
          price = p;
        }
      }
    }
  } else if (domain.includes('incehesap.com')) {
    const sepetMatch = html.match(/class="[^"]*sepet-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                       html.match(/class="[^"]*sepet-fiyat[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (sepetMatch) {
      const p = parseLoosePrice(sepetMatch[1]);
      if (p > 0) {
        price = p;
        discountType = 'sepette';
      }
    }
    const stdPriceMatch = html.match(/id="price"[^>]*>([\s\S]*?)<\/span>/i) ||
                          html.match(/class="[^"]*price-new[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                          html.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (stdPriceMatch) {
      const p = parseLoosePrice(stdPriceMatch[1]);
      if (p > 0) {
        if (price > 0 && price < p) {
          originalPrice = p;
        } else if (price === 0) {
          price = p;
        }
      }
    }
  } else if (domain.includes('pttavm.com')) {
    const priceMatch = html.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                       html.match(/class="[^"]*new-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (priceMatch) {
      price = parseLoosePrice(priceMatch[1]);
    }
  } else if (domain.includes('n11.com')) {
    const newPriceMatch = html.match(/class="[^"]*(?:ins-price-value|newPrice)[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                         html.match(/class="[^"]*price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (newPriceMatch) {
      price = parseLoosePrice(newPriceMatch[1]);
    }
    const sepetMatch = html.match(/class="[^"]*(?:sepet-indirim|basket-price|instant-discount)[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (sepetMatch) {
      const p = parseLoosePrice(sepetMatch[1]);
      if (p > 0) {
        if (price > 0 && p < price) {
          originalPrice = price;
          price = p;
          discountType = 'sepette';
        } else {
          price = p;
          discountType = 'sepette';
        }
      }
    }
  } else if (domain.includes('vatanbilgisayar.com')) {
    const priceMatch = html.match(/class="[^"]*product-list__price[^"]*"[^>]*>([\s\S]*?)<\/span>/i) ||
                       html.match(/class="[^"]*product-price[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (priceMatch) {
      price = parseLoosePrice(priceMatch[1]);
    }
    if (html.includes("Web'e Özel")) {
      discountType = 'webe_ozel';
    }
    const sepetMatch = html.match(/class="[^"]*sepette-indirim[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (sepetMatch) {
      const p = parseLoosePrice(sepetMatch[1]);
      if (p > 0) {
        originalPrice = price;
        price = p;
        discountType = 'sepette';
      }
    }
  }

  if (price === 0) {
    const priceRegex = /(?:price|fiyat|fiyatı)[\s\S]{0,100}?>([\s\S]*?)<\/span>/gi;
    let match;
    while ((match = priceRegex.exec(html)) !== null) {
      const p = parseLoosePrice(match[1]);
      if (p > 0) {
        price = p;
        break;
      }
    }
  }

  return { title, price, originalPrice, discountType };
}

function extractSellerPriceDOM(doc, url) {
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

  return { title, price, originalPrice, discountType };
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

function getProductCategoryDOM(doc, url = '') {
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

function getProductCategoryRegex(html, url = '') {
  let category = 'Diğer';
  const urlCategory = getCategoryFromUrl(url);

  // 1. Try matching the breadcrumbs container first
  const breadcrumbRegex = /<(?:div|ul|ol|nav)[^>]*(?:id="BC_v8"|id="BC_"|class="[^"]*breadcrumb[^"]*"|itemtype="[^"]*BreadcrumbList[^"]*")[^>]*>([\s\S]*?)<\/(?:div|ul|ol|nav)>/i;
  const breadcrumbMatch = html.match(breadcrumbRegex);

  if (breadcrumbMatch) {
    const containerHtml = breadcrumbMatch[1];
    const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch;
    const listItems = [];

    while ((liMatch = liRegex.exec(containerHtml)) !== null) {
      const inner = liMatch[1];
      const nameMatch = inner.match(/<span[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/i) || 
                        inner.match(/<a[^>]*>([\s\S]*?)<\/a>/i) ||
                        inner.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
      const rawText = nameMatch ? nameMatch[1] : inner;
      const cleaned = rawText.replace(/<[^>]*>/g, '').replace(/\s*>\s*/g, '').trim();
      if (cleaned) {
        listItems.push(cleaned);
      }
    }

    if (listItems.length >= 4) {
      category = listItems[3];
    } else if (listItems.length >= 2) {
      category = listItems[listItems.length - 2];
    }
  }

  // Clean up and safety-check text
  if (category) {
    category = category.trim();
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

function extractProductsFromHtml(html, baseUrl) {
  const storeObj = getSupportedStore(baseUrl);

  if (typeof DOMParser === 'undefined') {
    if (storeObj) {
      const parsed = extractSellerPriceRegex(html, baseUrl);
      if (parsed.price > 0) {
        const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
        const akakceMarketAnalysis = parsed.discountType ? {
          discountType: parsed.discountType,
          originalPrice: parsed.originalPrice || parsed.price,
          discountPrice: parsed.price
        } : null;

        return [{
          id: uniqueId,
          title: parsed.title || `${storeObj.name} Ürünü`,
          price: parsed.price,
          url: baseUrl,
          store: storeObj.name,
          akakceMarketAnalysis,
          category: getProductCategoryRegex(html, baseUrl)
        }];
      }
    }

    const products = [];
    let bestPrice = 0;
    let title = '';
    let store = 'Bilinmiyor';

    const islandRegex = /<astro-island[^>]*props="([^"]+)"/g;
    let islandMatch;
    while ((islandMatch = islandRegex.exec(html)) !== null) {
      try {
        const propsRaw = islandMatch[1].replace(/&quot;/g, '"');
        if (propsRaw.includes('"spotPg"')) {
          const props = JSON.parse(propsRaw);
          const spotPg = props.spotPg;
          if (spotPg && spotPg[1] && spotPg[1].price) {
            bestPrice = parseFloat(spotPg[1].price[1]);
            const vdName = spotPg[1].vdName ? spotPg[1].vdName[1] : '';
            const pgNick = spotPg[1].pgNick ? spotPg[1].pgNick[1] : '';
            store = pgNick ? `${vdName}/${pgNick}` : vdName;
            if (props.metadata && props.metadata[1] && props.metadata[1].name) {
              title = props.metadata[1].name[1];
            }
            break;
          }
        }
      } catch (e) {}
    }

    if (bestPrice === 0) {
      const priceRegex = /class="[^"]*(?:pt_v8|pt_v9|pt_v10|price)[^"]*"[^>]*>([\s\S]*?)<\/./gi;
      let match;
      while ((match = priceRegex.exec(html)) !== null) {
        const textContent = match[1].replace(/<[^>]*>/g, '');
        const p = normalizePrice(textContent);
        if (p > 0) {
          bestPrice = p;
          break;
        }
      }
    }

    if (bestPrice > 0) {
      if (!title || typeof title !== 'string') {
        const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([\s\S]*?)<\/title>/i);
        title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
        if (title) title = title.split('Fiyatları')[0].split('-')[0].trim();
        if (!title) title = 'Akakçe Ürünü';
      }
      if (store === 'Bilinmiyor') {
        const storeMatch = html.match(/class="[^"]*(?:v_v8|seller_name|s_v8)[^"]*"[^>]*>([\s\S]*?)<\/./i);
        store = storeMatch ? storeMatch[1].replace(/<[^>]*>/g, '').trim() : 'Bilinmiyor';
      }
      const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
      products.push({
        id: uniqueId,
        title,
        price: bestPrice,
        url: baseUrl,
        store,
        category: getProductCategoryRegex(html, baseUrl)
      });
    }
    return products;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  if (storeObj) {
    const parsed = extractSellerPriceDOM(doc, baseUrl);
    if (parsed.price > 0) {
      const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
      const akakceMarketAnalysis = parsed.discountType ? {
        discountType: parsed.discountType,
        originalPrice: parsed.originalPrice || parsed.price,
        discountPrice: parsed.price
      } : null;

      return [{
        id: uniqueId,
        title: parsed.title || `${storeObj.name} Ürünü`,
        price: parsed.price,
        url: baseUrl,
        store: storeObj.name,
        akakceMarketAnalysis,
        category: getProductCategoryDOM(doc, baseUrl)
      }];
    }
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
          if (props.metadata && props.metadata[1] && props.metadata[1].name) {
            title = props.metadata[1].name[1];
          } else {
            const titleNode = doc.querySelector('h1');
            title = titleNode ? titleNode.textContent.trim() : '';
          }
          if (price > 0) {
            const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
            products.push({
              id: uniqueId,
              title,
              price,
              url: baseUrl,
              store: store || 'Bilinmiyor',
              category: getProductCategoryDOM(doc, baseUrl)
            });
            return products;
          }
        }
      } catch (e) {}
    }

    const titleNode = doc.querySelector('h1');
    const title = titleNode ? titleNode.textContent.trim() : '';
    const priceNode = doc.querySelector('.pt_v8, .pb_v8, span.pt_v8, .price, .pt_v9, .pt_v10');
    let priceText = priceNode ? priceNode.textContent : '';
    
    if (!priceText) {
      const priceMeta = doc.querySelector('meta[itemprop="price"]');
      if (priceMeta) priceText = priceMeta.getAttribute('content');
    }
    
    const price = normalizePrice(priceText);
    
    if (price > 0) {
      let store = 'Bilinmiyor';
      const storeNode = doc.querySelector('.v_v8, .seller_name, .s_v8');
      if (storeNode) {
        store = storeNode.textContent.trim();
        if (!store) {
           const img = storeNode.querySelector('img');
           if (img) store = img.getAttribute('alt') || img.getAttribute('title') || 'Bilinmiyor';
        }
      }
      
      const uniqueId = btoa(encodeURIComponent(baseUrl)).replace(/=/g, '').slice(-30);
      products.push({
        id: uniqueId,
        title,
        price,
        url: baseUrl,
        store,
        category: getProductCategoryDOM(doc, baseUrl)
      });
    }
  }

  return products;
}

async function sendDiscordNotification(settings, product, oldPrice, newPrice) {
  if (!settings.enableDiscord || !settings.discordWebhookUrl) return;
  
  const { diff, percent } = calculatePriceChange(oldPrice, newPrice);
  const diffText = `${diff > 0 ? '+' : ''}${formatPrice(diff)} / ${percent}%`;
  
  const payload = {
    embeds: [{
      title: "Akakçe Fiyat Değişimi",
      description: product.title,
      url: product.url,
      color: diff < 0 ? 0x00FF00 : 0xFF0000,
      fields: [
        { name: "Eski fiyat", value: formatPrice(oldPrice), inline: true },
        { name: "Yeni fiyat", value: formatPrice(newPrice), inline: true },
        { name: "Değişim", value: diffText, inline: true },
        { name: "Mağaza", value: product.store || 'Bilinmiyor', inline: true }
      ],
      timestamp: new Date().toISOString()
    }]
  };

  try {
    await fetch(settings.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("Discord notification failed:", error);
  }
}

async function sendWhatsAppNotification(settings, product, oldPrice, newPrice) {
  if (!settings.enableWhatsApp || !settings.callMeBotPhone || !settings.callMeBotApiKey) return;
  
  const { diff, percent } = calculatePriceChange(oldPrice, newPrice);
  const diffText = `${diff > 0 ? '+' : ''}${formatPrice(diff)} / ${percent}%`;
  
  const text = `*Akakçe Fiyat Değişimi*
Ürün: ${product.title}
Eski fiyat: ${formatPrice(oldPrice)}
Yeni fiyat: ${formatPrice(newPrice)}
Değişim: ${diffText}
Mağaza: ${product.store || 'Bilinmiyor'}
Link: ${product.url}`;

  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(settings.callMeBotPhone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(settings.callMeBotApiKey)}`;
  
  try {
    await fetch(url);
  } catch (error) {
    console.error("WhatsApp notification failed:", error);
  }
}

async function loadTrackedProducts() {
  try {
    return await cloudLoadTrackedProducts();
  } catch (error) {
    if (!isSessionExpiredError(error)) console.error("Error loading cloud products:", error);
    return [];
  }
}

async function saveTrackedProducts(products) {
  const session = await getSession();
  if (!session?.user?.id) return;
  await Promise.all(products.map(product => cloudSyncProduct(product)));
}

async function saveSettings(settings) {
  const session = await getSession();
  if (!session?.user?.id) return;
  await cloudSaveSettings(settings);
}

async function loadSettings() {
  const defaults = {
    checkInterval: 60,
    enableDiscord: false,
    discordWebhookUrl: '',
    enableWhatsApp: false,
    callMeBotPhone: '',
    callMeBotApiKey: ''
  };

  const session = await getSession();
  if (!session?.user?.id) return defaults;

  try {
    return { ...defaults, ...await cloudGetSettings() };
  } catch (error) {
    if (!isSessionExpiredError(error)) console.error("Error loading cloud settings:", error);
    return defaults;
  }
}

function isSessionExpiredError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('oturum süresi doldu') || message.includes('jwt expired');
}

function getTitleMatchScore(title1, title2) {
  const t1 = String(title1).toLowerCase().replace(/ı/g, 'i').replace(/[^\w\d]/g, ' ').split(/\s+/).filter(x => x.length >= 2);
  const t2 = String(title2).toLowerCase().replace(/ı/g, 'i').replace(/[^\w\d]/g, ' ').split(/\s+/).filter(x => x.length >= 2);
  if (t1.length === 0 || t2.length === 0) return 0;

  const set2 = new Set(t2);
  const common = t1.filter(x => set2.has(x));

  // Calculate overlap relative to the shorter title to avoid verbose description penalties
  const intersectionRatio = common.length / Math.min(t1.length, t2.length);

  // Detect alphanumeric model codes (e.g. "9700x", "a850gl", "nv3", or minimum 4-digit numbers)
  const hasModelMatch = t1.some(w1 => {
    const isModelCode = /\d+[a-zA-Z]+|[a-zA-Z]+\d+/i.test(w1) || (w1.length >= 4 && /\d+/.test(w1));
    return isModelCode && set2.has(w1);
  });

  const compact2 = t2.join('');
  const hasContainedModelMatch = t1.some(w1 => {
    const isModelCode = w1.length >= 4 && /\d/.test(w1) && /[a-zA-Z]/i.test(w1);
    return isModelCode && compact2.includes(w1);
  });

  if (hasModelMatch && intersectionRatio >= 0.4) {
    return 1.0; // Force match if the model code is identical and we have decent overlap
  }

  if (hasContainedModelMatch && common.length >= 1) {
    return Math.max(0.7, intersectionRatio);
  }

  return intersectionRatio;
}

function getExactSkuTokens(title) {
  const original = String(title || '');
  const normalized = original
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/fiyatı|fiyatları|en ucuz|işlemci|ram|ssd|ekran kartı|pci|express|mhz|ghz|gb|tb|cl\d+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const skuMatches = normalized.match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b|\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{8,}\b/gi) || [];
  return [...new Set(skuMatches
    .filter(isLikelyExactSkuToken)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3))];
}

function isLikelyExactSkuToken(token) {
  const value = String(token || '').toLocaleLowerCase('tr-TR').replace(/^[-\s]+|[-\s]+$/g, '');
  if (!value || /^\d+$/.test(value)) return false;

  const compact = value.replace(/[^a-z0-9]/g, '');
  if (compact.length < 6) return false;
  if (!/[a-z]/.test(compact) || !/\d/.test(compact)) return false;

  const techSpecPatterns = [
    /^\d+(mhz|ghz|gb|tb|w|hz|mm|cm|inch|in)?[a-z]*$/,
    /^(ddr|gddr|lpddr)\d+/,
    /^cl\d+/,
    /^gen\d+/,
    /^pcie\d*/,
    /^\d+x\d+$/,
    /^\d+gbx\d+$/,
    /^\d+mhz/,
    /^\d+ghz/,
    /mhz/,
    /ghz/,
    /(^|-)cl\d+/,
    /(^|-)ddr\d+/,
    /(^|-)gen\d+/
  ];

  return !techSpecPatterns.some(pattern => pattern.test(value) || pattern.test(compact));
}

function normalizeSku(value) {
  return String(value || '').toLocaleLowerCase('tr-TR').replace(/[^a-z0-9]/g, '');
}

function extractItopyaProductCode(html) {
  const codeMatch =
    String(html || '').match(/<p[^>]*class="[^"]*\bcode\b[^"]*"[^>]*>\s*Ürün\s*Kodu\s*:\s*([^<]+)<\/p>/i) ||
    String(html || '').match(/Ürün\s*Kodu\s*:\s*([A-Z0-9-]+)/i);
  return codeMatch ? codeMatch[1].replace(/\s+/g, ' ').trim() : '';
}

function getCapacityTokens(title) {
  const tokens = [];
  const text = String(title || '').toLocaleLowerCase('tr-TR').replace(',', '.');
  const capacityRegex = /\b(\d+(?:\.\d+)?)\s*(tb|gb)\b/gi;
  let match;
  while ((match = capacityRegex.exec(text)) !== null) {
    const value = Number(match[1]);
    if (!value) continue;
    const unit = match[2].toLowerCase();
    const gb = unit === 'tb' ? value * 1000 : value;
    tokens.push(String(gb));
  }
  return [...new Set(tokens)];
}

function hasCapacityMismatch(sourceTitle, candidateTitle) {
  const sourceCaps = getCapacityTokens(sourceTitle);
  const candidateCaps = getCapacityTokens(candidateTitle);
  if (sourceCaps.length === 0 || candidateCaps.length === 0) return false;
  return !sourceCaps.some(capacity => candidateCaps.includes(capacity));
}

async function checkItopyaCheaperPrice(title, akakcePrice) {
  try {
    const skuTokens = getExactSkuTokens(title);
    if (skuTokens.length === 0) return null;

    const links = [];
    const baselinePrice = normalizePrice(akakcePrice);

    for (const query of skuTokens) {
      const searchUrl = `https://www.itopya.com/ara?bul=${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': navigator.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      if (!response.ok) continue;
      const html = await response.text();

      const linkRegex = /href="\/([^"]+?_u\d+)"/gi;
      let match;
      while ((match = linkRegex.exec(html)) !== null) {
        const path = match[1];
        const fullUrl = `https://www.itopya.com/${path}`;
        if (!links.includes(fullUrl)) {
          links.push(fullUrl);
        }
        if (links.length >= 6) break;
      }
      if (links.length >= 6) break;
    }

    if (links.length === 0) return null;

    let cheaperProduct = null;
    let minPrice = baselinePrice > 0 ? baselinePrice : Infinity;

    for (const url of links) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': navigator.userAgent }
        });
        if (!res.ok) continue;
        const prodHtml = await res.text();
        const parsed = extractProductsFromHtml(prodHtml, url);
        if (parsed && parsed.length > 0) {
          const item = parsed[0];
          const price = Number(item.price);
          const productCode = extractItopyaProductCode(prodHtml);
          const hasExactSku = productCode &&
            skuTokens.some(token => normalizeSku(productCode) === normalizeSku(token));

          if (!hasExactSku) continue;
          if (hasCapacityMismatch(title, item.title)) continue;
          if (!Number.isFinite(price) || price <= 100) continue;

          if (price > 0 && price < minPrice) {
            minPrice = price;
            cheaperProduct = item;
          }
        }
      } catch (e) {
        console.error("Failed to parse Itopya detail page:", url, e);
      }
    }

    return cheaperProduct;
  } catch (error) {
    console.error("Itopya search failed:", error);
    return null;
  }
}

export {
  normalizePrice,
  formatPrice,
  calculatePriceChange,
  isSignificantPriceChange,
  MIN_SIGNIFICANT_PRICE_CHANGE,
  detectBlockedPage,
  extractProductsFromHtml,
  sendDiscordNotification,
  sendWhatsAppNotification,
  saveTrackedProducts,
  loadTrackedProducts,
  saveSettings,
  loadSettings,
  SUPPORTED_SELLER_DOMAINS,
  getSupportedStore,
  parseLoosePrice,
  checkItopyaCheaperPrice
};
