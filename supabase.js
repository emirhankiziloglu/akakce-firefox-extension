// Supabase configuration for Akprays Chrome Extension
// Uses the Supabase REST API directly (no npm needed in MV3)

export const SUPABASE_URL = 'https://exifsxceyfjpijansmlb.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_TAkWN109OKHByjs0-A0uzw_03tiTW8c';
const MIN_SIGNIFICANT_PRICE_CHANGE = 1;

const headers = (token = null) => {
  const h = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${token || SUPABASE_KEY}`
  };
  return h;
};

function decodeJwtPayload(token) {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(normalized)
        .split('')
        .map(char => '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function isJwtExpired(token, leewaySeconds = 30) {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return payload.exp <= Math.floor(Date.now() / 1000) + leewaySeconds;
}

async function clearStoredSession() {
  await chrome.storage.local.remove(['sb_session', 'activeUserId']);
}

function isAuthExpiredError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('jwt expired') || message.includes('invalid jwt') || message.includes('session expired');
}

async function refreshSession(session) {
  if (!session?.refresh_token) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
    body: JSON.stringify({ refresh_token: session.refresh_token })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    await clearStoredSession();
    return null;
  }

  const normalized = await normalizeSession(data);
  await chrome.storage.local.set({ sb_session: normalized, activeUserId: normalized.user?.id });
  return normalized;
}

async function normalizeSession(session) {
  if (!session?.access_token) return session || null;
  if (isJwtExpired(session.access_token)) {
    return refreshSession(session);
  }
  if (session.user?.id) return session;

  const payload = decodeJwtPayload(session.access_token);
  const userFromToken = payload?.sub
    ? {
        id: payload.sub,
        email: payload.email || session.user?.email || ''
      }
    : null;

  if (userFromToken) {
    const normalized = { ...session, user: { ...(session.user || {}), ...userFromToken } };
    await chrome.storage.local.set({ sb_session: normalized, activeUserId: userFromToken.id });
    return normalized;
  }

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: headers(session.access_token)
  });
  if (!res.ok) return session;

  const user = await res.json();
  const normalized = { ...session, user };
  await chrome.storage.local.set({ sb_session: normalized, activeUserId: user.id });
  return normalized;
}

async function getCurrentUserId() {
  const session = await getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Oturum kullanıcısı okunamadı. Lütfen çıkış yapıp tekrar giriş yapın.');
  return userId;
}

// ── Auth ──────────────────────────────────────────────────────────────

export async function signUp(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  if (data.access_token) {
    const normalized = await normalizeSession(data);
    await chrome.storage.local.set({ sb_session: normalized, activeUserId: normalized.user?.id });
    return normalized;
  }
  return data;
}

export async function signInWithEmail(email, password) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error_description || data.error);
  const normalized = await normalizeSession(data);
  await chrome.storage.local.set({ sb_session: normalized, activeUserId: normalized.user?.id });
  return normalized;
}

export async function getSession() {
  const { sb_session } = await chrome.storage.local.get('sb_session');
  if (!sb_session) {
    await clearStoredSession();
    return null;
  }
  return normalizeSession(sb_session || null);
}

export async function signOut() {
  const session = await getSession();
  if (session?.access_token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: headers(session.access_token)
    }).catch(() => {});
  }
  await clearStoredSession();
}

// ── DB Helpers ────────────────────────────────────────────────────────

async function dbFetch(path, options = {}) {
  const session = await getSession();
  if (!session?.access_token) throw new Error('Oturum süresi doldu. Lütfen tekrar giriş yapın.');
  const token = session?.access_token || null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers || {}) }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401 || isAuthExpiredError(err)) {
      await clearStoredSession();
      throw new Error('Oturum süresi doldu. Lütfen tekrar giriş yapın.');
    }
    throw new Error(err.message || `HTTP ${res.status}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── Products ──────────────────────────────────────────────────────────

export async function cloudGetProducts() {
  return dbFetch('tracked_products?select=*,price_history(price,checked_at)&order=created_at.desc');
}

function mapCloudProduct(row) {
  const priceHistory = Array.isArray(row.price_history)
    ? row.price_history.map(item => ({
        price: Number(item.price),
        checkedAt: item.checked_at
      }))
    : [];
  const idSource = row.url || row.id;

  return {
    id: btoa(encodeURIComponent(idSource)).replace(/=/g, '').slice(-30),
    cloudId: row.id,
    url: row.url,
    title: row.title || 'Buluttan senkronize edilen ürün',
    imageUrl: row.image_url || '',
    price: Number(row.current_price) || 0,
    currentPrice: Number(row.current_price) || 0,
    previousPrice: Number(row.previous_price) || Number(row.current_price) || 0,
    targetPrice: Number(row.target_price) || 0,
    currency: 'TL',
    lastCheckedAt: row.last_checked || null,
    createdAt: row.created_at || new Date().toISOString(),
    source: row.url?.includes('itopya.com') ? 'itopya' : 'akakce',
    priceHistory,
    akakceMarketAnalysis: row.akakce_market_analysis || null,
    lastError: row.last_error || null,
    store: row.store || 'Bilinmiyor',
    category: row.category || 'Diğer',
    isBought: row.is_bought || false,
    boughtPrice: row.bought_price ? Number(row.bought_price) : null,
    boughtAt: row.bought_at || null
  };
}

export async function cloudLoadTrackedProducts() {
  const session = await getSession();
  if (!session?.user?.id) return [];
  const rows = await cloudGetProducts();
  return Array.isArray(rows) ? rows.map(mapCloudProduct) : [];
}

export async function cloudUpsertProduct(product) {
  const userId = await getCurrentUserId();
  const payload = {
    user_id: userId,
    url: product.url,
    title: product.title,
    image_url: product.imageUrl,
    current_price: product.currentPrice,
    previous_price: product.previousPrice,
    target_price: product.targetPrice || null,
    last_checked: product.lastCheckedAt || null,
    akakce_market_analysis: product.akakceMarketAnalysis || null,
    last_error: product.lastError || null,
    category: product.category || 'Diğer',
    is_bought: product.isBought || false,
    bought_price: product.boughtPrice || null,
    bought_at: product.boughtAt || null
  };
  return dbFetch('tracked_products?on_conflict=user_id,url', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload)
  });
}

export async function cloudSyncProduct(product, options = {}) {
  const rows = await cloudUpsertProduct(product);
  const cloudProduct = rows?.[0];

  if (options.includeHistory && cloudProduct?.id && Array.isArray(product.priceHistory)) {
    for (const item of product.priceHistory) {
      await cloudAddPriceHistory(cloudProduct.id, item.price, item.checkedAt);
    }
  }

  return cloudProduct;
}

export async function cloudDeleteProduct(url) {
  const userId = await getCurrentUserId();
  return dbFetch(`tracked_products?url=eq.${encodeURIComponent(url)}&user_id=eq.${userId}`, {
    method: 'DELETE'
  });
}

async function prunePriceHistory(productId, keepCount = 50) {
  const oldRows = await dbFetch(
    `price_history?select=id&product_id=eq.${encodeURIComponent(productId)}&order=checked_at.desc&offset=${keepCount}`
  );
  const oldIds = Array.isArray(oldRows)
    ? oldRows.map(row => row.id).filter(Boolean)
    : [];

  if (oldIds.length === 0) return;

  await dbFetch(`price_history?id=in.(${oldIds.join(',')})`, {
    method: 'DELETE'
  });
}

export async function cloudAddPriceHistory(productId, price, checkedAt = null) {
  const normalizedPrice = Number(price);
  if (!productId || !normalizedPrice) return null;

  const latestRows = await dbFetch(
    `price_history?select=id,price&product_id=eq.${encodeURIComponent(productId)}&order=checked_at.desc&limit=1`
  );
  const latestPrice = Number(latestRows?.[0]?.price);
  if (Number.isFinite(latestPrice) && Math.abs(latestPrice - normalizedPrice) < MIN_SIGNIFICANT_PRICE_CHANGE) {
    return latestRows?.[0] || null;
  }

  const inserted = await dbFetch('price_history', {
    method: 'POST',
    body: JSON.stringify({
      product_id: productId,
      price: normalizedPrice,
      ...(checkedAt ? { checked_at: checkedAt } : {})
    })
  });

  await prunePriceHistory(productId).catch(() => {});
  return inserted;
}

// ── Gaming Gecesi Archive ─────────────────────────────────────

export async function cloudGetGamingWeeks() {
  const rows = await dbFetch('gaming_gecesi_weeks?select=*&order=campaign_date.desc');
  return Array.isArray(rows) ? rows : [];
}

export async function cloudGetGamingProducts(campaignWeek) {
  const weekFilter = campaignWeek ? `&campaign_week=eq.${encodeURIComponent(campaignWeek)}` : '';
  const rows = await dbFetch(
    `gaming_gecesi_price_history?select=*,gaming_gecesi_products(*)&order=index.asc${weekFilter}`
  );
  return Array.isArray(rows) ? rows.map(mapGamingHistoryRow) : [];
}

export async function cloudUpsertGamingWeek(week) {
  return dbFetch('gaming_gecesi_weeks?on_conflict=campaign_week', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({
      campaign_week: week.campaignWeek,
      campaign_date: week.campaignDate,
      product_count: week.productCount || 0,
      source_updated_at: week.lastUpdated || null
    })
  });
}

export async function cloudUpsertGamingProducts(products) {
  if (!Array.isArray(products) || products.length === 0) return null;

  const productPayload = products.map(product => ({
    product_id: String(product.productId),
    name: product.name,
    url: product.url,
    image_url: product.imageUrl || '',
    category: product.category || inferGamingCategory(product.name),
    first_seen: product.firstSeen || null,
    last_seen: product.lastUpdated || null
  }));

  await dbFetch('gaming_gecesi_products?on_conflict=product_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(productPayload)
  });

  const historyPayload = products.map(product => ({
    product_id: String(product.productId),
    campaign_week: product.campaignWeek,
    campaign_date: product.campaignDate,
    index: product.index || null,
    normal_price: Number(product.normalPrice) || null,
    discount_price: Number(product.discountPrice) || null,
    discount_percent: Number(product.discountPercent) || null,
    stock: Number(product.stock) || 0,
    first_seen: product.firstSeen || null,
    source_updated_at: product.lastUpdated || null,
    stock_out_at: product.stockOutAt || null
  }));

  return dbFetch('gaming_gecesi_price_history?on_conflict=product_id,campaign_week', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(historyPayload)
  });
}

function mapGamingHistoryRow(row) {
  const product = row.gaming_gecesi_products || {};
  return {
    productId: row.product_id,
    campaignWeek: row.campaign_week,
    campaignDate: row.campaign_date,
    index: row.index,
    name: product.name || '',
    url: product.url || '',
    imageUrl: product.image_url || '',
    category: product.category || 'Diğer',
    normalPrice: Number(row.normal_price) || 0,
    discountPrice: Number(row.discount_price) || 0,
    discountPercent: Number(row.discount_percent) || 0,
    stock: Number(row.stock) || 0,
    firstSeen: row.first_seen,
    lastUpdated: row.source_updated_at,
    stockOutAt: row.stock_out_at
  };
}

function inferGamingCategory(name) {
  const text = String(name || '').toLocaleLowerCase('tr-TR');
  if (/ekran kart|rtx|radeon|geforce|\brx\b/.test(text)) return 'Ekran Kartı';
  if (/anakart|motherboard|b650|x670|z790|b760/.test(text)) return 'Anakart';
  if (/işlemci|islemci|ryzen|intel core|\bcpu\b/.test(text)) return 'İşlemci';
  if (/ram|ddr4|ddr5|bellek/.test(text)) return 'RAM';
  if (/ssd|nvme|m\.2|disk/.test(text)) return 'SSD';
  if (/monitör|monitor/.test(text)) return 'Monitör';
  if (/mouse|klavye|kulaklık|headset|mikrofon/.test(text)) return 'Çevre Birimi';
  if (/kasa|psu|power supply|soğutucu|sogutucu/.test(text)) return 'Bileşen';
  if (/notebook|laptop/.test(text)) return 'Notebook';
  if (/koltuk/.test(text)) return 'Oyuncu Koltuğu';
  return 'Diğer';
}

// ── Settings ──────────────────────────────────────────────────────────

export async function cloudGetSettings() {
  const rows = await dbFetch('settings?select=*&limit=1');
  const row = rows?.[0];
  if (!row) return null;
  return {
    checkInterval: row.check_interval,
    enableDiscord: row.enable_discord,
    discordWebhookUrl: row.discord_webhook_url || '',
    enableWhatsApp: row.enable_whatsapp,
    callMeBotPhone: row.call_me_bot_phone || '',
    callMeBotApiKey: row.call_me_bot_api_key || ''
  };
}

export async function cloudSaveSettings(settings) {
  const userId = await getCurrentUserId();
  const payload = {
    user_id: userId,
    check_interval: settings.checkInterval,
    enable_discord: settings.enableDiscord,
    discord_webhook_url: settings.discordWebhookUrl,
    enable_whatsapp: settings.enableWhatsApp,
    call_me_bot_phone: settings.callMeBotPhone,
    call_me_bot_api_key: settings.callMeBotApiKey
  };
  return dbFetch('settings?on_conflict=user_id', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(payload)
  });
}
