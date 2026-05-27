import {
  extractProductsFromHtml,
  formatPrice,
  saveTrackedProducts,
  loadTrackedProducts,
  saveSettings,
  loadSettings,
  detectBlockedPage,
  isSignificantPriceChange
} from './utils.js';
import {
  signUp,
  signInWithEmail,
  signOut,
  getSession,
  cloudSyncProduct,
  cloudDeleteProduct,
  cloudAddPriceHistory,
  cloudGetGamingWeeks,
  cloudGetGamingProducts,
  cloudUpsertGamingWeek,
  cloudUpsertGamingProducts
} from './supabase.js';


let currentSettings = {};
let trackedProducts = [];
let gamingWeeks = [];
let gamingProducts = [];
let gamingAllProducts = [];
// Legacy campaign checking variables removed
let countdownTimer = null;

const GAMING_PUBLIC_API = 'https://incehesap.ggbaba.info/api/public';
const ITOPYA_CAMPAIGN_URL = 'https://www.itopya.com/Kampanya/super-fiyatlilar--1397';
const ITOPYA_SEARCH_URL = 'https://www.itopya.com/ara?bul=';
const ITOPYA_MAX_PAGES = 20;
const ITOPYA_MIN_MATCH_SCORE = 0.70;
const ITOPYA_SKU_MATCH_SCORE = 0.60;
const ITOPYA_MAX_SEARCH_QUERIES_PER_PRODUCT = 3;
const GAMING_GECESI_SCHEDULE = { weekday: 5, previewHour: 19, startHour: 22, endHour: 2 };
const ITOPIK_SAATLER_SCHEDULE = { weekday: 3, startHour: 16, endHour: 22 };
const ACIL_SUSAM_ACIL_CAMPAIGN = {
  start: '2026-06-15T16:00:00+03:00',
  end: '2026-06-22T16:00:00+03:00',
  portalHour: 16
};

document.addEventListener('DOMContentLoaded', async () => {
  if (window.__akpraysPopupInitialized) return;
  window.__akpraysPopupInitialized = true;

  await getSession();
  currentSettings = await loadSettings();
  trackedProducts = await loadTrackedProducts();

  initTabs();
  initSettings();
  initDealCountdowns();
  // Auth controls should be wired before optional UI rendering so a product-card
  // render issue cannot leave the login screen unresponsive.
  await initAuth();
  initCustomSelects();
  renderTrackedProducts();
  initGamingGecesi();

  on('btn-search', 'click', handleSearch);
  on('search-input', 'keydown', (e) => { if (e.key === 'Enter') handleSearch(); });
  on('search-input', 'input', (e) => {
    const val = e.target.value.trim();
    if (!val) {
      const defaultViews = document.getElementById('search-default-views');
      if (defaultViews) defaultViews.style.display = 'block';
      const resultsContainer = document.getElementById('search-results');
      if (resultsContainer) resultsContainer.innerHTML = '';
    }
  });
  on('btn-save-settings', 'click', handleSaveSettings);
  on('btn-test-discord', 'click', handleTestDiscord);
  on('btn-test-whatsapp', 'click', handleTestWhatsApp);
  on('btn-open-settings', 'click', () => activateTab('settings'));
  on('btn-check-all', 'click', handleCheckAllProducts);
  on('btn-cancel-scan', 'click', handleCancelScan);
  on('btn-export', 'click', handleExport);
  on('btn-import', 'click', () => document.getElementById('import-file')?.click());
  on('btn-tracked-menu', 'click', toggleTrackedOverflowMenu);
  on('import-file', 'change', handleImport);
  on('filter-category', 'change', () => renderTrackedProducts());
  on('filter-discount', 'change', () => renderTrackedProducts());
  on('btn-gaming-refresh', 'click', () => syncGamingGecesiArchive({ force: true }));
  on('gaming-week-select', 'change', loadGamingProductsFromCloud);
  on('gaming-category-select', 'change', renderGamingProducts);
  on('gaming-search-input', 'input', renderGamingProducts);

  // Close card action menus when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.card-menu-wrapper')) {
      document.querySelectorAll('.card-dropdown-menu').forEach(m => {
        m.classList.remove('show');
      });
    }
  });

  document.addEventListener('click', closeTrackedOverflowMenuOnOutsideClick);

  // Interactive chart tooltip - delegated
  document.addEventListener('mousemove', (e) => {
    const container = e.target.closest('.sparkline-container');
    if (!container) return;
    const coordsRaw = container.dataset.chartCoords;
    if (!coordsRaw) return;

    const coords = JSON.parse(coordsRaw);
    const svg = container.querySelector('svg');
    const tooltip = container.querySelector('.chart-tooltip');
    const cursorLine = container.querySelector('.chart-cursor-line');
    if (!svg || !tooltip || !coords.length) return;

    const rect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    const scaleX = viewBox.width / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;

    // Find nearest point
    let nearest = coords[0];
    let nearestIdx = 0;
    let minDist = Infinity;
    coords.forEach((c, i) => {
      const dist = Math.abs(c.x - mouseX);
      if (dist < minDist) { minDist = dist; nearest = c; nearestIdx = i; }
    });

    // Move cursor line
    if (cursorLine) {
      cursorLine.setAttribute('x1', nearest.x);
      cursorLine.setAttribute('x2', nearest.x);
    }

    // Highlight active point
    container.querySelectorAll('.chart-point').forEach((dot, i) => {
      dot.classList.toggle('active', i === nearestIdx);
    });

    // Build minimal tooltip
    const boughtIdxRaw = container.dataset.boughtIdx;
    const boughtIdx = boughtIdxRaw ? parseInt(boughtIdxRaw, 10) : -1;
    const isBoughtPoint = (nearestIdx === boughtIdx);

    const priceStr = formatPrice(nearest.price);
    let changeHtml = '';
    if (nearestIdx > 0) {
      const prevPrice = coords[nearestIdx - 1].price;
      const change = ((nearest.price - prevPrice) / prevPrice) * 100;
      if (Math.abs(change) >= 0.1) {
        const cls = change < 0 ? 'down' : 'up';
        const sign = change > 0 ? '+' : '';
        changeHtml = ` <span class="chart-tooltip-change ${cls}">${sign}%${Math.abs(change).toFixed(1)}</span>`;
      }
    }
    const shortDate = formatShortDate(nearest.date);
    const boughtMarker = isBoughtPoint ? ` <span style="color: #fbbf24; font-weight: 700;">(Satın Alındı)</span>` : '';
    tooltip.innerHTML = `${shortDate} · ${priceStr}${changeHtml}${boughtMarker}`;
    tooltip.classList.add('visible');

    // Position tooltip clamped within container
    const tooltipX = (nearest.x / viewBox.width) * rect.width;
    const tooltipY = (nearest.y / viewBox.height) * rect.height;
    const containerW = container.offsetWidth;
    tooltip.style.left = `${Math.max(40, Math.min(tooltipX, containerW - 40))}px`;
    tooltip.style.top = `${Math.max(0, tooltipY - 28)}px`;
  });

  document.addEventListener('mouseleave', (e) => {
    const container = e.target.closest?.('.sparkline-container');
    if (!container) return;
    const tooltip = container.querySelector('.chart-tooltip');
    if (tooltip) tooltip.classList.remove('visible');
    container.querySelectorAll('.chart-point.active').forEach(d => d.classList.remove('active'));
  }, true);

  // Progress messages from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'scan_progress') {
      showScanProgress(msg.current, msg.total, msg.title);
    } else if (msg.action === 'scan_cancelled') {
      hideScanProgress(msg.total, { cancelled: true, current: msg.current });
      loadTrackedProducts()
        .then(p => { trackedProducts = p; renderTrackedProducts(); })
        .catch(() => { trackedProducts = []; renderTrackedProducts(); });
    } else if (msg.action === 'scan_done') {
      hideScanProgress(msg.total);
      loadTrackedProducts()
        .then(p => { trackedProducts = p; renderTrackedProducts(); })
        .catch(() => { trackedProducts = []; renderTrackedProducts(); });
    } else if (msg.action === 'product_updated') {
      loadTrackedProducts()
        .then(p => { trackedProducts = p; renderTrackedProducts(); })
        .catch(() => { trackedProducts = []; renderTrackedProducts(); });
    }
  });


});

function on(id, eventName, handler) {
  const element = document.getElementById(id);
  if (element) element.addEventListener(eventName, handler);
  return element;
}

async function initGamingGecesi() {
  const list = document.getElementById('gaming-list');
  if (!list) return;

  try {
    await loadGamingWeeksFromCloud();
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><p>Gaming Gecesi verileri okunamadı.</p></div>`;
    setGamingMeta(error.message || 'Supabase tablosu hazır değil');
  }
}

async function loadGamingWeeksFromCloud() {
  gamingWeeks = await cloudGetGamingWeeks();
  renderGamingWeekOptions();

  if (gamingWeeks.length === 0) {
    setGamingMeta('Supabase arşivi boş. Senkronize et.');
    const list = document.getElementById('gaming-list');
    if (list) list.innerHTML = `<div class="empty-state"><p>Henüz Gaming Gecesi arşivi yok.</p></div>`;
    return;
  }

  const weekSelect = document.getElementById('gaming-week-select');
  if (weekSelect && !weekSelect.value) weekSelect.value = gamingWeeks[0].campaign_week;
  await loadGamingProductsFromCloud();
}

function renderGamingWeekOptions() {
  const weekSelect = document.getElementById('gaming-week-select');
  if (!weekSelect) return;
  const selected = weekSelect.value;
  weekSelect.innerHTML = '';

  if (gamingWeeks.length === 0) {
    weekSelect.innerHTML = '<option value="">Hafta yok</option>';
    syncCustomSelect('gaming-week-select');
    return;
  }

  gamingWeeks.forEach(week => {
    const option = document.createElement('option');
    option.value = week.campaign_week;
    const formattedDate = new Date(week.campaign_date).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    option.textContent = formattedDate;
    weekSelect.appendChild(option);
  });

  if (gamingWeeks.some(week => week.campaign_week === selected)) {
    weekSelect.value = selected;
  }
  syncCustomSelect('gaming-week-select');
}

async function loadGamingProductsFromCloud() {
  const week = document.getElementById('gaming-week-select')?.value || gamingWeeks[0]?.campaign_week || '';
  if (!week) return;

  setGamingMeta('Supabase okunuyor...');
  gamingProducts = await cloudGetGamingProducts(week);
  gamingAllProducts = await cloudGetGamingProducts('');
  
  // Re-sync selects
  syncCustomSelect('gaming-week-select');
  updateGamingCategories();
  renderGamingProducts();

  const weekMeta = gamingWeeks.find(item => item.campaign_week === week);
  setGamingMeta(weekMeta?.source_updated_at ? `Son güncelleme: ${formatDateTime(weekMeta.source_updated_at)}` : 'Supabase arşivi');
}

async function syncGamingGecesiArchive({ force = false } = {}) {
  const btn = document.getElementById('btn-gaming-refresh');
  if (btn) btn.disabled = true;
  setGamingMeta('Public API okunuyor...');

  try {
    const weeksRes = await fetch(`${GAMING_PUBLIC_API}/weeks`, { headers: { Accept: 'application/json' } });
    if (!weeksRes.ok) throw new Error(`Weeks API ${weeksRes.status}`);
    const weeksPayload = await weeksRes.json();
    const weeks = Array.isArray(weeksPayload.data) ? weeksPayload.data : [];

    for (const week of weeks) {
      await cloudUpsertGamingWeek(week);
      const params = new URLSearchParams({ week: week.campaignWeek, inStockOnly: '0', sort: 'default', limit: '600' });
      const productsRes = await fetch(`${GAMING_PUBLIC_API}/products?${params.toString()}`, { headers: { Accept: 'application/json' } });
      if (!productsRes.ok) continue;
      const productsPayload = await productsRes.json();
      const products = Array.isArray(productsPayload.data) ? productsPayload.data : [];
      await cloudUpsertGamingProducts(products);
    }

    setGamingMeta('Senkron tamamlandı');
    await loadGamingWeeksFromCloud();
  } catch (error) {
    setGamingMeta(`Senkron başarısız: ${error.message}`);
    showStatus('Gaming Gecesi senkronize edilemedi: ' + error.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateGamingCategories() {
  const select = document.getElementById('gaming-category-select');
  if (!select) return;
  const selected = select.value;
  const categories = [...new Set(gamingProducts.map(product => product.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'));
    select.innerHTML = '<option value="all">Tümü</option>';
  categories.forEach(category => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
  if (categories.includes(selected)) {
    select.value = selected;
  } else {
    select.value = 'all';
  }
  syncCustomSelect('gaming-category-select');
}

function renderGamingProducts() {
  const list = document.getElementById('gaming-list');
  if (!list) return;

  const query = document.getElementById('gaming-search-input')?.value.trim().toLocaleLowerCase('tr-TR') || '';
  const category = document.getElementById('gaming-category-select')?.value || 'all';

  let products = [...gamingProducts];
  if (category !== 'all') products = products.filter(product => product.category === category);
  if (query) products = products.filter(product => String(product.name || '').toLocaleLowerCase('tr-TR').includes(query));

  if (products.length === 0) {
    list.innerHTML = `<div class="empty-state"><p>Filtreye uygun fırsat yok.</p></div>`;
    return;
  }

  list.innerHTML = products.map(product => renderGamingProductCard(product)).join('');
}

function renderGamingProductCard(product) {
  const normalPrice = Number(product.normalPrice) || 0;
  const discountPrice = Number(product.discountPrice) || 0;
  
  const history = getGamingProductHistory(product.productId);
  let cheapestPrice = Infinity;
  if (history.length > 0) {
    cheapestPrice = Math.min(...history.map(item => Number(item.discountPrice) || Infinity));
  }

  const historyHtml = history.length > 0
    ? `<div class="gaming-history-row">
        ${history.map(item => {
          const isCurrentWeek = (item.campaignWeek === product.campaignWeek);
          const itemPrice = Number(item.discountPrice) || 0;
          const isCheapest = (itemPrice === cheapestPrice && cheapestPrice !== Infinity);
          
          let badgeClass = 'gaming-history-badge';
          if (isCheapest) {
            badgeClass += ' cheapest';
          } else if (isCurrentWeek) {
            badgeClass += ' current';
          }
          return `<span class="${badgeClass}" title="${escapeHtml(item.campaignWeek)}">${formatShortDate(item.campaignDate)}: ${formatPrice(item.discountPrice)}</span>`;
        }).join('')}
      </div>`
    : '';

  return `
    <article class="gaming-card">
      <img src="${escapeHtml(product.imageUrl || '')}" alt="" loading="lazy">
      <div class="gaming-card-body">
        <div class="gaming-card-top">
          <a href="${safeExternalUrl(product.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(product.name)}</a>
        </div>
        <div class="gaming-price-row">
          <strong>${formatPrice(discountPrice)}</strong>
          <span>${formatPrice(normalPrice)}</span>
        </div>
        ${historyHtml}
      </div>
    </article>
  `;
}

function getGamingProductHistory(productId) {
  return gamingAllProducts
    .filter(product => product.productId === productId)
    .sort((a, b) => String(a.campaignDate).localeCompare(String(b.campaignDate)))
    .slice(-3);
}

function setGamingMeta(text) {
  setText('gaming-sync-meta', text);
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function initCustomSelects() {
  document.querySelectorAll('.custom-select').forEach(wrapper => {
    const select = document.getElementById(wrapper.dataset.selectId);
    const trigger = wrapper.querySelector('.select-trigger');
    const content = wrapper.querySelector('.select-content');
    if (!select || !trigger || !content) return;

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = content.hidden;
      closeCustomSelects(wrapper);
      content.hidden = !willOpen;
      trigger.setAttribute('aria-expanded', String(willOpen));
    });

    select.addEventListener('change', () => syncCustomSelect(select.id));
    syncCustomSelect(select.id);
  });

  document.addEventListener('click', () => closeCustomSelects());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCustomSelects();
  });
}

function closeCustomSelects(exceptWrapper = null) {
  document.querySelectorAll('.custom-select').forEach(wrapper => {
    if (wrapper === exceptWrapper) return;
    const trigger = wrapper.querySelector('.select-trigger');
    const content = wrapper.querySelector('.select-content');
    if (!trigger || !content) return;
    content.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  });
}

function syncCustomSelect(selectId) {
  const select = document.getElementById(selectId);
  const wrapper = document.querySelector(`.custom-select[data-select-id="${selectId}"]`);
  if (!select || !wrapper) return;

  const valueLabel = wrapper.querySelector('.select-value');
  const content = wrapper.querySelector('.select-content');
  if (!valueLabel || !content) return;

  const selectedOption = select.options[select.selectedIndex] || select.options[0];
  renderSelectLabel(valueLabel, selectedOption);
  content.innerHTML = '';

  Array.from(select.options).forEach(option => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'select-item';
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.value === select.value));

    const label = document.createElement('span');
    label.className = 'select-item-label';
    renderSelectLabel(label, option);
    item.appendChild(label);

    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'select-check');
    check.setAttribute('width', '15');
    check.setAttribute('height', '15');
    check.setAttribute('viewBox', '0 0 24 24');
    check.setAttribute('fill', 'none');
    check.setAttribute('stroke', 'currentColor');
    check.setAttribute('stroke-width', '2');
    check.setAttribute('stroke-linecap', 'round');
    check.setAttribute('stroke-linejoin', 'round');
    check.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm20 6-11 11-5-5');
    check.appendChild(path);
    item.appendChild(check);

    item.addEventListener('click', (event) => {
      event.stopPropagation();
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closeCustomSelects();
    });

    content.appendChild(item);
  });
}

function renderSelectLabel(container, option) {
  container.textContent = '';
  const tone = option?.dataset?.tone;
  if (tone) {
    const dot = document.createElement('span');
    dot.className = `select-dot tone-${tone}`;
    dot.setAttribute('aria-hidden', 'true');
    container.appendChild(dot);
  }
  container.append(document.createTextNode(option?.textContent || ''));
}

function initDealCountdowns() {
  updateDealCountdowns();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateDealCountdowns, 1000);
}

function updateDealCountdowns() {
  const now = new Date();
  const gamingState = getGamingGecesiState(now);
  updateCountdownElement('countdown-gaming-gecesi', gamingState);
  updateCountdownElement('gaming-countdown', gamingState);
  updateCountdownElement('countdown-itopik-saatler', getWeeklyWindowState(now, ITOPIK_SAATLER_SCHEDULE));
  updateCountdownElement('countdown-acil-susam-acil', getAcilSusamAcilState(now));
}

function updateCountdownElement(id, state) {
  const element = document.getElementById(id);
  if (!element) return;

  element.textContent = state.label;
  element.classList.toggle('is-live', state.isLive);
}

function getGamingGecesiState(now) {
  const nextStart = getNextWeeklyDate(now, GAMING_GECESI_SCHEDULE.weekday, GAMING_GECESI_SCHEDULE.startHour);
  const lastStart = new Date(nextStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastEnd = new Date(lastStart);
  lastEnd.setDate(lastEnd.getDate() + 1);
  lastEnd.setHours(GAMING_GECESI_SCHEDULE.endHour, 0, 0, 0);

  if (now >= lastStart && now < lastEnd) {
    return { isLive: true, label: `Canlı · ${formatDuration(lastEnd - now)}` };
  }

  const nextPreview = getNextWeeklyDate(now, GAMING_GECESI_SCHEDULE.weekday, GAMING_GECESI_SCHEDULE.previewHour);
  if (now < nextPreview && nextPreview < nextStart) {
    return { isLive: false, label: `Ürünlere ${formatDuration(nextPreview - now)}` };
  }

  return { isLive: false, label: formatDuration(nextStart - now) };
}

function getWeeklyWindowState(now, schedule) {
  const nextStart = getNextWeeklyDate(now, schedule.weekday, schedule.startHour);
  const lastStart = new Date(nextStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastEnd = new Date(lastStart);
  lastEnd.setHours(schedule.endHour, 0, 0, 0);
  if (lastEnd <= lastStart) lastEnd.setDate(lastEnd.getDate() + 1);

  if (now >= lastStart && now < lastEnd) {
    return { isLive: true, label: `Canlı · ${formatDuration(lastEnd - now)}` };
  }

  return { isLive: false, label: formatDuration(nextStart - now) };
}

function getAcilSusamAcilState(now) {
  const campaignStart = new Date(ACIL_SUSAM_ACIL_CAMPAIGN.start);
  const campaignEnd = new Date(ACIL_SUSAM_ACIL_CAMPAIGN.end);

  if (now < campaignStart) {
    return { isLive: false, label: `Başlangıca ${formatDuration(campaignStart - now)}` };
  }

  if (now >= campaignEnd) {
    return { isLive: false, label: 'Kampanya bitti' };
  }

  const nextPortal = new Date(now);
  nextPortal.setHours(ACIL_SUSAM_ACIL_CAMPAIGN.portalHour, 0, 0, 0);
  if (nextPortal <= now) nextPortal.setDate(nextPortal.getDate() + 1);
  const nextBoundary = nextPortal < campaignEnd ? nextPortal : campaignEnd;
  return { isLive: true, label: `Canlı · ${formatDuration(nextBoundary - now)}` };
}

function getNextWeeklyDate(now, weekday, hour) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  const daysUntil = (weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + daysUntil);
  if (next <= now) next.setDate(next.getDate() + 7);
  return next;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}g ${hours}s ${minutes}d`;
  if (hours > 0) return `${hours}s ${minutes}d ${seconds}sn`;
  return `${minutes}d ${seconds}sn`;
}

function toggleTrackedOverflowMenu(event) {
  event.stopPropagation();
  const menu = document.getElementById('tracked-overflow-menu');
  const button = document.getElementById('btn-tracked-menu');
  if (!menu || !button) return;

  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  button.setAttribute('aria-expanded', String(willOpen));
}

function closeTrackedOverflowMenu() {
  const menu = document.getElementById('tracked-overflow-menu');
  const button = document.getElementById('btn-tracked-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (button) button.setAttribute('aria-expanded', 'false');
}

function closeTrackedOverflowMenuOnOutsideClick(event) {
  const menuWrapper = event.target?.closest?.('.toolbar-menu');
  if (!menuWrapper) closeTrackedOverflowMenu();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch (error) {
    return '#';
  }
}

async function initAuth() {
  const screen = document.getElementById('auth-screen');
  const profileBtn = document.getElementById('user-profile');
  const emailSpan = document.getElementById('user-email');
  const verifying = document.getElementById('auth-verifying');

  let currentSession = await getSession();
  let authBusy = false;

  const setAppLocked = (locked) => {
    document.body.classList.toggle('auth-required', locked);
  };

  const openScreen = () => { if (screen) screen.style.transform = 'translateX(0)'; refreshScreenState(); };
  const closeScreen = () => {
    if (!currentSession?.user) return;
    hideAuthError();
    setAppLocked(false);
    if (screen) screen.style.transform = 'translateX(100%)';
  };

  function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    if (!el) return;
    el.textContent = msg; el.style.display = 'block';
  }
  function hideAuthError() {
    const el = document.getElementById('auth-error');
    if (el) el.style.display = 'none';
  }

  function validateAuthForm({ showMessage = false } = {}) {
    const emailInput = document.getElementById('auth-email-input');
    const passwordInput = document.getElementById('auth-password-input');
    const signinBtn = document.getElementById('btn-email-signin');
    const signupBtn = document.getElementById('btn-email-signup');
    const email = emailInput?.value.trim() || '';
    const password = passwordInput?.value || '';
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
    const passwordValid = password.length >= 6 && password.length <= 72;
    const formValid = emailValid && passwordValid;

    if (emailInput) emailInput.setCustomValidity(email || !showMessage ? '' : 'E-posta adresi gerekli.');
    if (passwordInput) passwordInput.setCustomValidity(password || !showMessage ? '' : 'Şifre gerekli.');

    if (signinBtn) signinBtn.disabled = authBusy;
    if (signupBtn) signupBtn.disabled = authBusy;

    if (showMessage) {
      if (!email) showAuthError('E-posta adresi boş olamaz.');
      else if (!emailValid) showAuthError('Geçerli bir e-posta adresi girin.');
      else if (!password) showAuthError('Şifre boş olamaz.');
      else if (password.length < 6) showAuthError('Şifre en az 6 karakter olmalı.');
      else if (password.length > 72) showAuthError('Şifre en fazla 72 karakter olabilir.');
      else hideAuthError();
    } else if (formValid) {
      hideAuthError();
    }

    return formValid;
  }

  function updateHeaderBadge(session) {
    if (session?.user) {
      emailSpan.textContent = session.user.email?.split('@')[0] || 'Hesabım';
      profileBtn.classList.add('active');
    } else {
      emailSpan.textContent = 'Giriş Yap';
      profileBtn.classList.remove('active');
    }
  }

  function refreshScreenState() {
    hideAuthError();
    if (verifying) verifying.style.display = 'none';
    const signedOut = document.getElementById('auth-signed-out');
    const signedIn = document.getElementById('auth-signed-in');
    if (currentSession?.user) {
      if (signedOut) signedOut.style.display = 'none';
      if (signedIn) signedIn.style.display = 'block';
      const authName = document.getElementById('auth-name');
      const authEmail = document.getElementById('auth-email-display');
      const productCount = document.getElementById('auth-product-count');
      if (authName) authName.textContent = currentSession.user.email || 'Kullanıcı';
      if (authEmail) authEmail.textContent = currentSession.user.email || '';
      if (productCount) productCount.textContent = `${trackedProducts.length} ürün senkronize`;
    } else {
      if (signedOut) signedOut.style.display = 'block';
      if (signedIn) signedIn.style.display = 'none';
    }
  }

  function syncCloudInBackground() {
    Promise.resolve()
      .then(reloadCloudState)
      .catch(error => {
        showStatus('Buluttaki ürünler okunamadı: ' + error.message, 'error');
      });
  }

  updateHeaderBadge(currentSession);

  // Auth modal Giriş/Kayıt sekme geçişi
  function switchAuthTab(tab) {
    const signinBtn = document.getElementById('tab-signin-btn');
    const signupBtn = document.getElementById('tab-signup-btn');
    const signinPanel = document.getElementById('auth-signin-panel');
    const signupPanel = document.getElementById('auth-signup-panel');
    if (!signinBtn || !signupBtn || !signinPanel || !signupPanel) return;
    if (tab === 'signin') {
      signinBtn.style.background = 'var(--background)'; signinBtn.style.color = 'var(--foreground)';
      signinBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
      signupBtn.style.background = 'transparent'; signupBtn.style.color = 'var(--muted-foreground)';
      signupBtn.style.boxShadow = 'none';
      signinPanel.style.display = 'block'; signupPanel.style.display = 'none';
    } else {
      signupBtn.style.background = 'var(--background)'; signupBtn.style.color = 'var(--foreground)';
      signupBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';
      signinBtn.style.background = 'transparent'; signinBtn.style.color = 'var(--muted-foreground)';
      signinBtn.style.boxShadow = 'none';
      signinPanel.style.display = 'none'; signupPanel.style.display = 'block';
    }
    hideAuthError();
    validateAuthForm();
  }

  // Auth ekranı: oturum yoksa başlangıçta görünür
  if (!currentSession?.user) {
    setAppLocked(true);
    if (verifying) verifying.style.display = 'none';
    refreshScreenState();
    if (screen) screen.style.transform = 'translateX(0)';
  } else {
    setAppLocked(false);
    if (verifying) verifying.style.display = 'none';
    if (screen) screen.style.transform = 'translateX(100%)';
    syncCloudInBackground();
  }

  on('tab-signin-btn', 'click', () => switchAuthTab('signin'));
  on('tab-signup-btn', 'click', () => switchAuthTab('signup'));
  on('auth-email-input', 'input', () => validateAuthForm());
  on('auth-password-input', 'input', () => validateAuthForm());
  on('auth-email-input', 'blur', () => validateAuthForm({ showMessage: true }));
  on('auth-password-input', 'blur', () => validateAuthForm({ showMessage: true }));
  validateAuthForm();

  // Header "Giriş Yap" butonu → hesap ekranı açar
  if (profileBtn) profileBtn.addEventListener('click', openScreen);
  on('btn-close-auth', 'click', closeScreen);

  // Header "Hesabım" ikonu (giriş yapılmışken) → hesap ekranı açar (çıkış için)

  // Giriş Yap
  on('btn-email-signin', 'click', async () => {
    const email = document.getElementById('auth-email-input')?.value.trim();
    const password = document.getElementById('auth-password-input')?.value;
    if (!validateAuthForm({ showMessage: true })) return;
    hideAuthError();
    const btn = document.getElementById('btn-email-signin');
    authBusy = true;
    btn.textContent = 'Giriş yapılıyor...'; btn.disabled = true;
    try {
      currentSession = await signInWithEmail(email, password);
      updateHeaderBadge(currentSession);
      setAppLocked(false);
      closeScreen();
      showStatus('Giriş başarılı! Veriler buluta senkronize ediliyor.', 'success');
      await reloadCloudState();
    } catch (e) {
      showAuthError(e.message || 'Giriş başarısız.');
    } finally {
      authBusy = false;
      btn.textContent = 'Giriş Yap';
      validateAuthForm();
    }
  });

  // Kayıt Ol
  on('btn-email-signup', 'click', async () => {
    const email = document.getElementById('auth-email-input')?.value.trim();
    const password = document.getElementById('auth-password-input')?.value;
    if (!validateAuthForm({ showMessage: true })) return;
    hideAuthError();
    const btn = document.getElementById('btn-email-signup');
    authBusy = true;
    btn.textContent = 'Hesap oluşturuluyor...'; btn.disabled = true;
    try {
      const result = await signUp(email, password);
      if (result.access_token) {
        currentSession = result;
        updateHeaderBadge(currentSession);
        setAppLocked(false);
        closeScreen();
        showStatus('Hesap oluşturuldu! Hoş geldin.', 'success');
      } else {
        showAuthError('Kayıt başarılı! E-postanı doğrula ve giriş yap.');
      }
    } catch (e) {
      showAuthError(e.message || 'Kayıt başarısız.');
    } finally {
      authBusy = false;
      btn.textContent = 'Hesap Oluştur';
      validateAuthForm();
    }
  });

  // Çıkış Yap
  on('btn-signout', 'click', async () => {
    const btn = document.getElementById('btn-signout');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Çıkış yapılıyor...';
    }
    try {
      await signOut();
      currentSession = null;
      trackedProducts = [];
      currentSettings = {};
      updateHeaderBadge(null);
      initSettings();
      renderTrackedProducts();
      setAppLocked(true);
      refreshScreenState();
      if (screen) screen.style.transform = 'translateX(0)';
      showStatus('Çıkış yapıldı.', 'info');
    } catch (e) {
      showAuthError(e.message || 'Çıkış yapılamadı.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Çıkış Yap';
      }
    }
  });
}


function initTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      activateTab(tab.dataset.tab);
    });
  });
}

function activateTab(tabName) {
  if (!tabName) return;

  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  document.getElementById(`tab-${tabName}`)?.classList.add('active');
  document.getElementById('btn-open-settings')?.classList.toggle('active', tabName === 'settings');

  if (tabName === 'tracked') {
    renderTrackedProducts();
  }
}

function initSettings() {
  const interval = document.getElementById('setting-interval');
  const discordEnable = document.getElementById('setting-discord-enable');
  const discordWebhook = document.getElementById('setting-discord-webhook');
  const whatsappEnable = document.getElementById('setting-whatsapp-enable');
  const whatsappPhone = document.getElementById('setting-whatsapp-phone');
  const whatsappApiKey = document.getElementById('setting-whatsapp-apikey');

  if (interval) interval.value = currentSettings.checkInterval || 60;
  if (discordEnable) discordEnable.checked = currentSettings.enableDiscord || false;
  if (discordWebhook) discordWebhook.value = currentSettings.discordWebhookUrl || '';
  if (whatsappEnable) whatsappEnable.checked = currentSettings.enableWhatsApp || false;
  if (whatsappPhone) whatsappPhone.value = currentSettings.callMeBotPhone || '';
  if (whatsappApiKey) whatsappApiKey.value = currentSettings.callMeBotApiKey || '';
}

function showStatus(message, type = 'info') {
  const el = document.getElementById('status-message');
  if (!el) return;
  el.textContent = message;
  el.className = '';
  if (type === 'error') el.classList.add('error');
  else if (type === 'success') el.classList.add('success');
  
  setTimeout(() => {
    el.classList.add('hidden');
  }, 3000);
}

async function handleCheckAllProducts() {
  if (trackedProducts.length === 0) {
    showStatus('Takip edilen ürün yok.', 'info');
    updateCheckAllButtonState();
    return;
  }

  const btn = document.getElementById('btn-check-all');
  if (btn) {
    btn.disabled = true;
    btn.style.opacity = '0.5';
    btn.style.cursor = 'not-allowed';
  }

  showScanProgress(0, trackedProducts.length, 'Başlatılıyor...');

  chrome.runtime.sendMessage({ action: 'check_now' }, () => {
    // background yanıt verince buton aktif olacak (scan_done mesajıyla)
  });
}

function handleCancelScan() {
  const cancelBtn = document.getElementById('btn-cancel-scan');
  const statusText = document.getElementById('scan-status-text');
  if (cancelBtn) cancelBtn.disabled = true;
  if (statusText) statusText.textContent = 'Durduruluyor...';
  chrome.runtime.sendMessage({ action: 'cancel_scan' }, () => {});
}

function showScanProgress(current, total, title) {
  const panel = document.getElementById('scan-progress');
  const bar = document.getElementById('scan-progress-bar');
  const counter = document.getElementById('scan-counter');
  const statusText = document.getElementById('scan-status-text');
  const currentItem = document.getElementById('scan-current-item');
  const cancelBtn = document.getElementById('btn-cancel-scan');

  if (!panel || !bar || !counter || !statusText || !currentItem) return;
  panel.style.display = 'block';
  if (cancelBtn) cancelBtn.disabled = false;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  bar.style.width = pct + '%';
  counter.textContent = `${current} / ${total}`;
  statusText.textContent = 'Taranıyor...';
  currentItem.textContent = title || '';
}

function hideScanProgress(total, options = {}) {
  const panel = document.getElementById('scan-progress');
  const bar = document.getElementById('scan-progress-bar');
  const counter = document.getElementById('scan-counter');
  const statusText = document.getElementById('scan-status-text');
  const currentItem = document.getElementById('scan-current-item');
  const btn = document.getElementById('btn-check-all');
  const cancelBtn = document.getElementById('btn-cancel-scan');

  if (!panel || !bar || !counter || !statusText || !currentItem) return;
  const current = options.current ?? total;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  bar.style.width = options.cancelled ? `${pct}%` : '100%';
  statusText.textContent = options.cancelled ? 'Tarama durduruldu' : `✓ ${total} ürün tarandı`;
  currentItem.textContent = '';
  counter.textContent = `${current} / ${total}`;

  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
  }
  if (cancelBtn) cancelBtn.disabled = false;

  setTimeout(() => {
    panel.style.display = 'none';
    bar.style.width = '0%';
  }, 3000);
}

async function handleSearch() {
  const query = document.getElementById('search-input')?.value.trim();
  if (!query) return;
  const sources = getSelectedSearchSources();
  if (sources.length === 0) {
    showStatus('En az bir arama kaynağı seçin.', 'error');
    return;
  }

  const defaultViews = document.getElementById('search-default-views');
  if (defaultViews) defaultViews.style.display = 'none';

  showStatus('Aranıyor...', 'info');
  const resultsContainer = document.getElementById('search-results');
  if (!resultsContainer) return;
  resultsContainer.innerHTML = '<div style="text-align:center; padding: 20px;">Yükleniyor...</div>';

  const allProducts = [];
  const failedSources = [];
  for (const source of sources) {
    try {
      const searchUrls = buildSearchUrls(query, source);
      if (searchUrls.length === 0) continue;

      const sourceProducts = [];
      for (const searchUrl of searchUrls) {
        let urlProducts = [];
        try {
        const response = await fetch(searchUrl, { headers: { Accept: 'text/html,application/xhtml+xml' } });
          if (response.ok) {
            const html = await response.text();
            if (!detectBlockedPage(html)) {
              urlProducts = extractProductsFromHtml(html, searchUrl, { query });
            }
          }
        } catch (error) {
          urlProducts = [];
        }

        if (urlProducts.length === 0 && source === 'epey' && isEpeyProductUrl(searchUrl)) {
          const tabProduct = await readEpeyProductFromTab(searchUrl, query).catch(() => null);
          if (tabProduct) urlProducts = [tabProduct];
        }

        sourceProducts.push(...urlProducts);
        if (sourceProducts.length > 0 && source === 'epey') break;
      }

      if (sourceProducts.length === 0) throw new Error('ürün bulunamadı');
      allProducts.push(...sourceProducts);
    } catch (sourceError) {
      console.error(`${source} search failed`, sourceError);
      failedSources.push(source === 'akakce' ? 'Akakçe' : 'Epey');
    }
  }

  const products = dedupeProducts(allProducts);
  renderSearchResults(products);
  if (products.length === 0 && failedSources.length) {
    showStatus(`${failedSources.join(', ')} okunamadı.`, 'error');
  } else if (failedSources.length) {
    showStatus(`Arama tamamlandı. Okunamayan: ${failedSources.join(', ')}.`, 'info');
  } else {
    showStatus('Arama tamamlandı.', 'success');
  }
}

function getSelectedSearchSources() {
  const sources = [];
  if (document.getElementById('search-source-akakce')?.checked) sources.push('akakce');
  if (document.getElementById('search-source-epey')?.checked) sources.push('epey');
  return sources;
}

function buildSearchUrls(query, source) {
  const directUrl = parseHttpUrl(query);
  if (directUrl) {
    if (source === 'akakce' && directUrl.hostname.includes('akakce.com')) return [directUrl.href];
    if (source === 'epey' && directUrl.hostname.includes('epey.com')) return [directUrl.href];
    return [];
  }

  if (source === 'akakce') return [`https://www.akakce.com/arama/?q=${encodeURIComponent(query)}`];
  if (source === 'epey') {
    return [
      buildEpeySearchUrl(query),
      ...buildEpeyCandidateUrls(query)
    ];
  }
  return [];
}

function buildEpeySearchPayload(query) {
  const normalized = String(query || '').trim();
  const fields = [
    `s:3:"ara";s:${utf8ByteLength(normalized)}:"${normalized}";`,
    's:7:"arasira";i:1;'
  ];

  return base64Utf8(`a:${fields.length}:{${fields.join('')}}_N;`);
}

function buildEpeySearchUrl(query) {
  return `https://www.epey.com/${inferEpeySearchCategory(query)}/e/${buildEpeySearchPayload(query)}/`;
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function buildEpeyCandidateUrls(query) {
  const category = inferEpeySearchCategory(query);
  return buildEpeyCandidateSlugs(query).map(slug => `https://www.epey.com/${category}/${slug}.html`);
}

function inferEpeySearchCategory(query) {
  const text = normalizeSearchQuery(query);
  if (/\b(ryzen|intel|core|x3d|i3|i5|i7|i9|islemci|cpu)\b/.test(text)) return 'islemci';
  if (/\b(rtx|gtx|radeon|geforce|ekran kart|gpu)\b/.test(text)) return 'ekran-karti';
  if (/\b(ssd|nvme|m2|m\.2)\b/.test(text)) return 'ssd';
  if (/\b(ram|ddr4|ddr5|bellek)\b/.test(text)) return 'bellek-ram';
  if (/\b(anakart|b650|x670|b760|z790)\b/.test(text)) return 'anakart';
  return 'islemci';
}

function buildEpeyCandidateSlugs(query) {
  const base = normalizeSearchQuery(query)
    .replace(/\b(islemci|cpu|processor|fiyat|fiyati|fiyatlari)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const slug = slugifySearchQuery(base);
  const slugs = new Set();
  if (slug) slugs.add(slug);
  if (/\bryzen\b/.test(base) && !slug.startsWith('amd-')) slugs.add(`amd-${slug}`);
  if (/\b(core|i3|i5|i7|i9)\b/.test(base) && !slug.startsWith('intel-')) slugs.add(`intel-${slug}`);
  return [...slugs].filter(Boolean);
}

function normalizeSearchQuery(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

function slugifySearchQuery(value) {
  return normalizeSearchQuery(value)
    .replace(/\./g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function isEpeyProductUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.hostname.includes('epey.com') && /\.html$/i.test(url.pathname);
  } catch (error) {
    return false;
  }
}

async function readEpeyProductFromTab(url, query) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, 9000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractEpeyProductFromPage,
      args: [url, query]
    });
    return result || null;
  } finally {
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs = 9000) {
  return new Promise(resolve => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function extractEpeyProductFromPage(url, query) {
  const normalize = (value) => String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const compact = (value) => normalize(value).replace(/\s+/g, '');
  const title = (document.querySelector('h1')?.textContent || document.title || '')
    .replace(/\s+-\s+Epey.*$/i, '')
    .trim();
  const queryCompact = compact(query);
  if (queryCompact && !compact(title).includes(queryCompact) && !compact(url).includes(queryCompact)) return null;

  const text = document.body?.innerText || '';
  const heading = `${title.replace(/\([^)]*\)/g, '').trim()} Fiyatları`;
  const headingIndex = text.indexOf(heading);
  const scoped = headingIndex >= 0 ? text.slice(headingIndex) : text;
  const prices = [...scoped.matchAll(/(\d[\d.\s]*,\d{2})\s*TL/g)]
    .map(match => Number.parseFloat(match[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.')))
    .filter(price => Number.isFinite(price) && price > 0);
  if (prices.length === 0) return null;
  const price = chooseRepresentativeLowestPrice(prices.slice(0, 30));
  if (!price) return null;

  const productUrl = location.href || url;
  const id = btoa(encodeURIComponent(productUrl)).replace(/=/g, '').slice(-30);
  return {
    id,
    title,
    price,
    url: productUrl,
    store: 'Epey',
    category: 'İşlemci',
    source: 'epey'
  };
}

function chooseRepresentativeLowestPrice(prices) {
  const sorted = prices
    .map(Number)
    .filter(price => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const plausibleFloor = median * 0.35;
  const plausible = sorted.filter(price => price >= plausibleFloor);
  return plausible.length ? plausible[0] : sorted[0];
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch (error) {
    return null;
  }
}

function dedupeProducts(products) {
  const seen = new Set();
  return products.filter(product => {
    const key = product.url || product.id || product.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getProductSourceKey(product) {
  const url = String(product?.url || '').toLowerCase();
  const source = String(product?.source || '').toLowerCase();
  const store = String(product?.store || '').toLocaleLowerCase('tr-TR');
  if (source === 'epey' || url.includes('epey.com') || store.includes('epey')) return 'epey';
  return 'akakce';
}

function isProductAlreadyTracked(product) {
  const productUrl = normalizeTrackedUrl(product?.url);
  return trackedProducts.some(item => {
    if (product?.id && item.id === product.id) return true;
    return productUrl && normalizeTrackedUrl(item.url) === productUrl;
  });
}

function normalizeTrackedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/$/, '');
  } catch (error) {
    return String(value || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

async function handleScanPage() {
  const defaultViews = document.getElementById('search-default-views');
  if (defaultViews) defaultViews.style.display = 'none';

  showStatus('Ürünler taranıyor...', 'info');
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.url?.includes('akakce.com')) {
      showStatus('Lütfen bir Akakçe sayfasında olduğunuzdan emin olun.', 'error');
      return;
    }
    
    chrome.tabs.sendMessage(activeTab.id, { action: "extract_products" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          files: ['content.js']
        }, () => {
          if (chrome.runtime.lastError) {
             showStatus('Sayfa okunamadı.', 'error');
             return;
          }
          setTimeout(() => {
             chrome.tabs.sendMessage(activeTab.id, { action: "extract_products" }, (res) => {
                if (res && res.products) {
                  renderSearchResults(res.products);
                  showStatus('Ürünler tarandı.', 'success');
                } else {
                  showStatus('Ürün bulunamadı.', 'error');
                }
             });
          }, 200);
        });
      } else if (response && response.products) {
        renderSearchResults(response.products);
        showStatus('Ürünler tarandı.', 'success');
      }
    });
  });
}

function renderSearchResults(products) {
  const container = document.getElementById('search-results');
  if (!container) return;
  container.innerHTML = '';
  
  if (!products || products.length === 0) {
    container.innerHTML = '<div style="text-align:center; padding: 20px;">Ürün bulunamadı.</div>';
    return;
  }

  const sortedProducts = [...products].sort((a, b) => {
    const priceA = Number(a.price) || Number.POSITIVE_INFINITY;
    const priceB = Number(b.price) || Number.POSITIVE_INFINITY;
    return priceA - priceB;
  });

  sortedProducts.forEach(product => {
    const card = document.createElement('div');
    card.className = 'card';
    const productUrl = safeExternalUrl(product.url);
    const productTitle = escapeHtml(product.title);
    const alreadyTracked = isProductAlreadyTracked(product);
    const productStore = escapeHtml(product.store || 'Bilinmiyor');
    const sourceKey = getProductSourceKey(product);
    const sourceLabel = sourceKey === 'epey' ? 'Epey' : 'Akakçe';
    const sourceBadgeHtml = `<span class="source-badge source-${sourceKey}">${sourceLabel}</span>`;
    const storeHtml = productStore && productStore !== 'Bilinmiyor' && productStore !== sourceLabel
      ? `<span class="store">${productStore}</span>`
      : sourceBadgeHtml;
    
    let discountBadgeHtml = '';
    let currentPriceHtml = `<span class="price">${formatPrice(product.price)}</span>`;
    let oldPriceStrikeHtml = '';

    const analysis = product.akakceMarketAnalysis;
    if (analysis && analysis.discountType) {
      const type = analysis.discountType;
      const original = Number(analysis.originalPrice || product.price);
      const current = Number(product.price);
      
      let badgeLabel = 'Sepette İndirim';
      let badgeClass = 'badge-discount-sepet';
      
      if (type === 'webe_ozel') {
        badgeLabel = "Web'e Özel";
        badgeClass = 'badge-discount-web';
      } else if (type === 'kupon') {
        badgeLabel = 'Kuponla';
        badgeClass = 'badge-discount-coupon';
      }
      
      discountBadgeHtml = `<span class="badge ${badgeClass}">${badgeLabel}</span>`;
      
      if (original > current) {
        oldPriceStrikeHtml = `<span class="previous-price strike">${formatPrice(original)}</span>`;
      }
    }

    card.innerHTML = `
      <h3 class="card-title">
        <a href="${productUrl}" target="_blank" rel="noopener noreferrer" title="${productTitle}">${productTitle}</a>
        ${discountBadgeHtml}
      </h3>
      <div class="card-row">
        <div style="display:flex; align-items:baseline;">
          ${currentPriceHtml}
          ${oldPriceStrikeHtml}
        </div>
        <div class="search-source-stack">
          ${sourceBadgeHtml}
          ${storeHtml === sourceBadgeHtml ? '' : storeHtml}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-track ${alreadyTracked ? 'is-tracked' : ''}" data-id="${product.id}" ${alreadyTracked ? 'disabled' : ''}>
          ${alreadyTracked ? 'Zaten takipte' : 'Takibe Al'}
        </button>
      </div>
    `;
    
    const trackBtn = card.querySelector('.btn-track');
    if (trackBtn && !alreadyTracked) trackBtn.addEventListener('click', () => trackProduct(product, trackBtn));
    container.appendChild(card);
  });
}

async function reloadCloudState() {
  currentSettings = await loadSettings();
  trackedProducts = await loadTrackedProducts();
  initSettings();
  renderTrackedProducts();
}

async function trackProduct(product, btnElement) {
  const existing = trackedProducts.find(p => p.id === product.id || p.url === product.url);
  if (existing) {
    if (btnElement) {
      btnElement.textContent = 'Zaten Takipte';
      btnElement.style.background = '#dc2626';
      setTimeout(() => {
        btnElement.textContent = 'Takibe Al';
        btnElement.style.background = '';
      }, 2000);
    } else {
      showStatus('Bu ürün zaten takipte.', 'error');
    }
    return;
  }
  
  const newProduct = {
    ...product,
    currentPrice: product.price,
    previousPrice: product.price,
    currency: 'TL',
    lastCheckedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    source: 'akakce',
    priceHistory: [{ price: product.price, checkedAt: new Date().toISOString() }]
  };
  
  if (btnElement) {
    btnElement.textContent = 'Ekleniyor...';
    btnElement.disabled = true;
  }
  
  chrome.runtime.sendMessage({ action: 'track_product', product: newProduct }, async (response) => {
    if (chrome.runtime.lastError || !response || !response.success) {
      const errMsg = response?.error || chrome.runtime.lastError?.message || 'Bilinmeyen hata';
      showStatus('Ürün veritabanına yazılamadı: ' + errMsg, 'error');
      if (btnElement) {
        btnElement.textContent = 'Takibe Al';
        btnElement.disabled = false;
      }
      return;
    }
    
    await reloadCloudState();
    
    if (btnElement) {
      btnElement.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:inline-block; vertical-align:middle; margin-right:4px; margin-bottom:2px;"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>Takibe Alındı`;
      btnElement.style.background = '#10b981';
      btnElement.disabled = true;
      showStatus('Takibe alındı', 'success');
    } else {
      showStatus('Takibe alındı', 'success');
    }
  });
}

function formatShortDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });
}

function formatCompactPrice(price) {
  const p = Number(price);
  if (p >= 100000) return `${(p / 1000).toFixed(0)}K`;
  if (p >= 10000) return `${(p / 1000).toFixed(1)}K`;
  if (p >= 1000) return `${(p / 1000).toFixed(1)}K`;
  return p.toFixed(0);
}

function formatDateTime(value) {
  if (!value) return 'Hic kontrol edilmedi';
  return new Date(value).toLocaleString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getPriceStateClass(product) {
  const previousPrice = Number(product?.previousPrice);
  const currentPrice = getSaneCurrentPrice(Number(product?.currentPrice || product?.price), previousPrice);
  const hasSepet = product?.akakceMarketAnalysis && product?.akakceMarketAnalysis.discountType;

  if (hasSepet) return 'price-drop';
  if (!currentPrice || !previousPrice) return 'price-normal';
  if (currentPrice < previousPrice) return 'price-drop';
  if (currentPrice > previousPrice) return 'price-rise';
  return 'price-same';
}

function getPriceChangePercent(currentPrice, previousPrice) {
  if (!currentPrice || !previousPrice) return 0;
  return ((currentPrice - previousPrice) / previousPrice) * 100;
}

function getSaneCurrentPrice(currentPrice, previousPrice) {
  const current = Number(currentPrice);
  const previous = Number(previousPrice);
  if (!Number.isFinite(current) || current <= 0) return current;
  if (!Number.isFinite(previous) || previous <= 1000) return current;
  if (current < previous * 0.25 && current < 1000) return previous;
  return current;
}

function getDistinctPriceEntries(history) {
  if (!Array.isArray(history)) return [];
  const sorted = history
    .filter(item => Number(item.price) > 0)
    .sort((a, b) => new Date(a.checkedAt) - new Date(b.checkedAt));
  const valid = sorted.filter((item, index) => {
    const price = Number(item.price);
    const previous = sorted[index - 1] ? Number(sorted[index - 1].price) : 0;
    const next = sorted[index + 1] ? Number(sorted[index + 1].price) : 0;
    return !isSuspiciousLowOutlier(price, previous || next);
  });
  if (valid.length <= 2) return valid;

  // First pass: deduplicate consecutive same-price entries
  const deduped = valid.reduce((items, item) => {
    const price = Number(item.price);
    const previous = items[items.length - 1];
    if (!previous || isSignificantPriceChange(Number(previous.price), price)) items.push(item);
    return items;
  }, []);

  if (deduped.length <= 3) return deduped;

  // Second pass: always keep first, last, and local extrema (peaks/valleys)
  const result = [deduped[0]];
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = Number(deduped[i - 1].price);
    const curr = Number(deduped[i].price);
    const next = Number(deduped[i + 1].price);
    const isPeak = curr > prev && curr > next;
    const isValley = curr < prev && curr < next;
    if (isPeak || isValley || isSignificantPriceChange(Number(result[result.length - 1].price), curr)) {
      result.push(deduped[i]);
    }
  }
  result.push(deduped[deduped.length - 1]);
  return result;
}

function isSuspiciousLowOutlier(price, referencePrice) {
  const priceValue = Number(price);
  const reference = Number(referencePrice);
  return Number.isFinite(priceValue)
    && Number.isFinite(reference)
    && reference > 1000
    && priceValue < 1000
    && priceValue < reference * 0.25;
}

function formatSignedPercent(value) {
  const rounded = Math.round(Math.abs(value));
  return `${value > 0 ? '+' : '-'}%${rounded}`;
}

function generateSparkline(history, targetPrice, boughtAt, boughtPrice) {
  if (!Array.isArray(history) || history.length === 0) return '';

  const entries = getDistinctPriceEntries(history).slice(-14);
  if (entries.length === 0) return '';
  const distinctPrices = new Set(entries.map(item => Number(item.price)));
  if (distinctPrices.size < 2) return '';

  const plotEntries = entries.length === 1
    ? [{ ...entries[0] }, { ...entries[0] }]
    : entries;
  const pricesForChart = plotEntries.map(item => Number(item.price));
  const minPrice = Math.min(...pricesForChart);
  const maxPrice = Math.max(...pricesForChart);
  const paddingForChart = (maxPrice - minPrice) * 0.16 || (minPrice * 0.015) || 1;
  const chartMin = Math.max(0, minPrice - paddingForChart);
  const chartMax = maxPrice + paddingForChart;
  const rangeForChart = chartMax - chartMin || 1;
  const wForChart = 320;
  const hForChart = 108;
  const topForChart = 14;
  const bottomForChart = 20;
  const leftPad = 0;
  const plotH = hForChart - topForChart - bottomForChart;
  const stepForChart = plotEntries.length > 1 ? wForChart / (plotEntries.length - 1) : 0;

  const coordsForChart = plotEntries.map((item, i) => {
    const x = leftPad + i * stepForChart;
    const y = topForChart + plotH - ((Number(item.price) - chartMin) / rangeForChart) * plotH;
    return { item, x, y, price: Number(item.price), index: i };
  });

  let boughtIndex = -1;
  if (boughtAt) {
    const bTime = new Date(boughtAt).getTime();
    let minDiff = Infinity;
    coordsForChart.forEach((c, idx) => {
      const cTime = new Date(c.item.checkedAt).getTime();
      const diff = Math.abs(cTime - bTime);
      if (diff < minDiff) {
        minDiff = diff;
        boughtIndex = idx;
      }
    });
  }

  // Smooth cubic bezier path
  function toBezierPath(points) {
    if (points.length < 2) return '';
    let d = `M ${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpx = (prev.x + curr.x) / 2;
      d += ` C ${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
    }
    return d;
  }

  // Closed fill path
  function toBezierFillPath(points) {
    if (points.length < 2) return '';
    const baseline = hForChart - bottomForChart;
    let d = `M ${points[0].x},${baseline}`;
    d += ` L ${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      const cpx = (prev.x + curr.x) / 2;
      d += ` C ${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
    }
    d += ` L ${points[points.length - 1].x},${baseline} Z`;
    return d;
  }

  const linePath = toBezierPath(coordsForChart);
  const fillPath = toBezierFillPath(coordsForChart);

  // 3 horizontal gridlines: min, mid, max
  const midPrice = (minPrice + maxPrice) / 2;
  const gridPrices = [maxPrice, midPrice, minPrice];
  const gridlinesHtml = gridPrices.map(p => {
    const gy = topForChart + plotH - ((p - chartMin) / rangeForChart) * plotH;
    return `<line class="chart-gridline" x1="0" x2="${wForChart}" y1="${gy}" y2="${gy}"/>
      <text class="chart-y-label" x="${wForChart + 3}" y="${gy + 3}" text-anchor="start">${formatCompactPrice(p)}</text>`;
  }).join('');

  // Target price dashed line
  let targetLineHtml = '';
  const tp = Number(targetPrice);
  if (tp > 0 && tp >= chartMin && tp <= chartMax) {
    const ty = topForChart + plotH - ((tp - chartMin) / rangeForChart) * plotH;
    targetLineHtml = `
      <line class="chart-target-line" x1="0" x2="${wForChart}" y1="${ty}" y2="${ty}"/>
      <text class="chart-target-label" x="2" y="${ty - 4}">Hedef</text>`;
  }

  // Date labels (start and end)
  const labelsHtml = coordsForChart
    .filter((_, i) => i === 0 || i === coordsForChart.length - 1)
    .map(point => `<text class="chart-axis-label" x="${point.x}" y="${hForChart - 2}" text-anchor="${point.x === leftPad ? 'start' : 'end'}">${formatShortDate(point.item.checkedAt)}</text>`)
    .join('');

  // Data dots
  const dotsHtml = coordsForChart.map((point, i) => {
    const isBoughtPoint = (i === boughtIndex);
    const cls = isBoughtPoint ? 'chart-point chart-point-bought' : 'chart-point';
    const r = isBoughtPoint ? '4.5' : '3.2';
    const style = isBoughtPoint ? 'style="fill: #fbbf24 !important; stroke: #f59e0b !important; stroke-width: 1.5px;"' : '';
    return `<circle class="${cls}" cx="${point.x}" cy="${point.y}" r="${r}" data-idx="${i}" ${style}/>`;
  }).join('');

  let boughtLineHtml = '';
  if (boughtIndex !== -1) {
    const bp = coordsForChart[boughtIndex];
    boughtLineHtml = `
      <line class="chart-bought-line" x1="${bp.x}" x2="${bp.x}" y1="${topForChart}" y2="${hForChart - bottomForChart}" style="stroke: #fbbf24; stroke-width: 1.25px; stroke-dasharray: 3,3; opacity: 0.85;"/>
      <text class="chart-bought-label" x="${bp.x + 4}" y="${topForChart + 9}" style="fill: #fbbf24; font-size: 8px; font-weight: 700; pointer-events: none;">Satın Alındı</text>
    `;
  }

  // Unique gradient id
  const gradId = `chartGrad_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const glowId = `chartNeonGlow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Trend calculation
  const firstP = pricesForChart[0];
  const lastP = pricesForChart[pricesForChart.length - 1];
  const trendPercent = firstP > 0 ? ((lastP - firstP) / firstP) * 100 : 0;
  let trendBadge = '';
  if (Math.abs(trendPercent) >= 0.5) {
    const isDown = trendPercent < 0;
    const arrow = isDown ? '↓' : '↑';
    const cls = isDown ? 'trend-down' : 'trend-up';
    trendBadge = `<span class="chart-trend-badge ${cls}">${arrow} %${Math.abs(Math.round(trendPercent))}</span>`;
  } else {
    trendBadge = `<span class="chart-trend-badge trend-flat">→ Sabit</span>`;
  }

  // Store coords as JSON for interactive tooltip
  const coordsData = JSON.stringify(coordsForChart.map(c => ({
    x: Math.round(c.x * 100) / 100,
    y: Math.round(c.y * 100) / 100,
    price: c.price,
    date: c.item.checkedAt
  })));

  return `
    <div class="sparkline-container" data-chart-coords='${coordsData}' data-chart-h="${hForChart}" data-chart-top="${topForChart}" data-chart-bottom="${bottomForChart}" ${boughtIndex !== -1 ? `data-bought-idx="${boughtIndex}"` : ''}>
      <svg viewBox="0 0 ${wForChart + 42} ${hForChart}" preserveAspectRatio="none" aria-label="Fiyat gecmisi">
        <defs>
          <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="rgba(16, 185, 129, 0.28)"/>
            <stop offset="100%" stop-color="rgba(16, 185, 129, 0.0)"/>
          </linearGradient>
          <filter id="${glowId}" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur"/>
            <feMerge>
              <feMergeNode in="blur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        ${gridlinesHtml}
        ${targetLineHtml}
        ${boughtLineHtml}
        <path class="chart-fill-path" d="${fillPath}" fill="url(#${gradId})"/>
        <path class="chart-path" d="${linePath}" filter="url(#${glowId})"/>
        <line class="chart-cursor-line" x1="0" x2="0" y1="${topForChart}" y2="${hForChart - bottomForChart}"/>
        ${dotsHtml}
        ${labelsHtml}
      </svg>
      <div class="chart-tooltip"></div>
      <div class="chart-summary">
        ${trendBadge}
      </div>
    </div>
  `;

}

function generatePriceAnalysis(product) {
  const entries = getDistinctPriceEntries(product.priceHistory);
  const prices = entries.map(item => Number(item.price)).filter(price => price > 0);
  const currentPrice = getSaneCurrentPrice(Number(product.currentPrice || product.price), Number(product.previousPrice || prices[prices.length - 1]));

  if (!currentPrice || prices.length < 2) return '';

  const allPrices = prices.includes(currentPrice) ? prices : [...prices, currentPrice];
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const firstPrice = allPrices[0];
  const periodDiffPercent = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;

  let verdict = '';
  let verdictClass = 'analysis-neutral';
  if (currentPrice <= minPrice) {
    verdict = 'En düşük fiyat';
    verdictClass = 'analysis-good';
  } else if (periodDiffPercent < -3) {
    verdict = `Başlangıca göre ${formatSignedPercent(periodDiffPercent)}`;
    verdictClass = 'analysis-good';
  } else if (periodDiffPercent > 3) {
    verdict = `Başlangıca göre ${formatSignedPercent(periodDiffPercent)}`;
    verdictClass = 'analysis-bad';
  }

  return `
    <div class="price-analysis-mini">
      <span>${formatPrice(minPrice)} - ${formatPrice(maxPrice)}</span>
      ${verdict ? `<span class="${verdictClass}">${verdict}</span>` : ''}
    </div>
  `;
}

function getSeriousDeals() {
  return trackedProducts
    .map(product => {
      const history = Array.isArray(product.priceHistory) ? product.priceHistory : [];
      const latestHistoryPoint = history[history.length - 1];
      const previousHistoryPoint = history.length > 1 ? history[history.length - 2] : null;
      const rawCurrentPrice = Number(product.currentPrice || latestHistoryPoint?.price || product.price);
      const previousPrice = Number(product.previousPrice || previousHistoryPoint?.price);
      const currentPrice = getSaneCurrentPrice(rawCurrentPrice, previousPrice);

      if (!currentPrice || !previousPrice || currentPrice >= previousPrice) return null;

      const dropPercent = ((previousPrice - currentPrice) / previousPrice) * 100;
      if (dropPercent < 7) return null;

      return {
        ...product,
        currentPrice,
        previousPrice,
        dropPercent
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.dropPercent - a.dropPercent)
    .slice(0, 5);
}

// Legacy campaign checking functions removed

function renderSeriousDeals() {
  const container = document.getElementById('serious-deals');
  if (!container) return;

  const deals = getSeriousDeals();
  if (deals.length === 0) {
    container.innerHTML = '';
    return;
  }

  const cards = deals.map(product => {
    const lastChecked = product.lastCheckedAt
      ? `Son kontrol: ${formatDateTime(product.lastCheckedAt)}`
      : 'Son kontrol yok';
    const dropPercent = Math.round(product.dropPercent);
    const productUrl = safeExternalUrl(product.url);
    const productTitle = escapeHtml(product.title);
    const productStore = escapeHtml(product.store || 'Bilinmiyor');
    const storeHtml = productStore && productStore !== 'Bilinmiyor'
      ? `<span>${productStore}</span>`
      : '';

    return `
      <div class="card deal-card">
        <div>
          <a class="deal-title" href="${productUrl}" target="_blank" rel="noopener noreferrer" title="${productTitle}">${productTitle}</a>
          <div class="deal-meta">
            ${storeHtml}
            <span>${lastChecked}</span>
          </div>
          <div class="deal-meta">
            <span>Önceki: ${formatPrice(product.previousPrice)}</span>
            <span class="deal-price">${formatPrice(product.currentPrice)}</span>
          </div>
        </div>
        <span class="deal-drop">%${dropPercent} düştü</span>
      </div>
    `;
  }).join('');

  container.innerHTML = `
    <div class="section-title">
      <h2>Ciddi Fırsatlar</h2>
      <span>%7+ düşen ${deals.length} ürün</span>
    </div>
    ${cards}
  `;
}

function renderTrackedProducts() {
  const container = document.getElementById('tracked-list');
  renderSeriousDeals();
  if (!container) return;
  container.innerHTML = '';
  updateCheckAllButtonState();
  
  if (trackedProducts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
        <p>Takip edilen ürün yok.</p>
      </div>`;
    return;
  }

  // Populate category filter dropdown dynamically
  const filterCategory = document.getElementById('filter-category');
  if (filterCategory) {
    const selectedValue = filterCategory.value;
    const uniqueCategories = [...new Set(trackedProducts.map(getDisplayCategory).filter(Boolean))].sort();
    
    const currentOptions = Array.from(filterCategory.options).map(o => o.value).filter(Boolean);
    if (JSON.stringify(currentOptions) !== JSON.stringify(uniqueCategories)) {
      filterCategory.innerHTML = '<option value="">Tümü</option>';
      uniqueCategories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        filterCategory.appendChild(opt);
      });
      if (uniqueCategories.includes(selectedValue)) {
        filterCategory.value = selectedValue;
      } else {
        filterCategory.value = '';
      }
    }
    syncCustomSelect('filter-category');
  }

  // Filter and sort products
  let filtered = [...trackedProducts];
  const selectedCategory = filterCategory ? filterCategory.value : '';
  if (selectedCategory) {
    filtered = filtered.filter(p => getDisplayCategory(p) === selectedCategory);
  }

  const filterDiscount = document.getElementById('filter-discount');
  const discountVal = filterDiscount ? filterDiscount.value : 'all';
  syncCustomSelect('filter-discount');
  if (discountVal === 'discounted_only') {
    filtered = filtered.filter(p => getPriceStateClass(p) === 'price-drop');
  } else if (discountVal === 'increased_only') {
    filtered = filtered.filter(p => getPriceStateClass(p) === 'price-rise');
  } else if (discountVal === 'unchanged_only') {
    filtered = filtered.filter(p => getPriceStateClass(p) === 'price-same' || getPriceStateClass(p) === 'price-normal');
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p>Filtreye uygun ürün bulunamadı.</p>
      </div>`;
    return;
  }
  
  filtered.forEach(product => {
    const card = document.createElement('div');
    card.className = product.isBought ? 'card tracked-card bought-product' : 'card tracked-card';
    const productUrl = safeExternalUrl(product.url);
    const productTitle = escapeHtml(product.title);
    const productStore = escapeHtml(product.store || 'Bilinmiyor');
    const storeHtml = productStore && productStore !== 'Bilinmiyor'
      ? `<span>${productStore}</span>`
      : '';
    const priceStateClass = getPriceStateClass(product);
    const rawCurrentPrice = Number(product.currentPrice);
    const previousPrice = Number(product.previousPrice);
    const currentPrice = getSaneCurrentPrice(rawCurrentPrice, previousPrice);
    const previousPriceHtml = previousPrice && currentPrice && previousPrice !== currentPrice
      ? `<span class="previous-price">${formatPrice(previousPrice)}</span>`
      : '';
    
    let errorHtml = '';
    if (product.lastError) {
      errorHtml = `<div class="error-text">${escapeHtml(product.lastError)}</div>`;
    }
    
    let dateText = 'Hiç kontrol edilmedi';
    if (product.lastCheckedAt) {
      const d = new Date(product.lastCheckedAt);
      dateText = d.toLocaleString('tr-TR');
    }
    
    const sparklineHtml = generateSparkline(product.priceHistory, product.targetPrice, product.boughtAt, product.boughtPrice);
    const analysisHtml = generatePriceAnalysis(product);
    const detailsHtml = [sparklineHtml, analysisHtml].filter(Boolean).join('');
    
    let discountBadgeHtml = '';
    let currentPriceHtml = `<span class="price compact-price ${priceStateClass}">${formatPrice(currentPrice)}</span>`;
    let oldPriceStrikeHtml = previousPriceHtml;

    const analysis = product.akakceMarketAnalysis;
    if (analysis && analysis.discountType) {
      const type = analysis.discountType;
      const original = Number(analysis.originalPrice || product.currentPrice);
      const current = Number(product.currentPrice);
      
      let badgeLabel = 'Sepette İndirim';
      let badgeClass = 'badge-discount-sepet';
      
      if (type === 'webe_ozel') {
        badgeLabel = "Web'e Özel";
        badgeClass = 'badge-discount-web';
      } else if (type === 'kupon') {
        badgeLabel = 'Kuponla';
        badgeClass = 'badge-discount-coupon';
      }
      
      discountBadgeHtml = `<span class="badge ${badgeClass}">${badgeLabel}</span>`;
      
      if (original > current) {
        oldPriceStrikeHtml = `<span class="previous-price strike">${formatPrice(original)}</span>`;
      }
    }

    let boughtInfoHtml = '';
    if (product.isBought && product.boughtPrice) {
      boughtInfoHtml = `<div class="bought-price-badge" style="font-size: 11px; color: var(--warning); font-weight: 650; margin-top: 4px;">
        ${formatPrice(product.boughtPrice)} fiyatıyla satın alındı (${new Date(product.boughtAt).toLocaleDateString('tr-TR')})
      </div>`;
    }

    let badgeHtml = '';
    const changePercent = getPriceChangePercent(currentPrice, previousPrice);
    const absolutePercent = Math.abs(changePercent);

    if (previousPrice && currentPrice && absolutePercent >= 1) {
       if (changePercent <= -12) {
          badgeHtml = `<span class="badge badge-hot">%${Math.round(absolutePercent)} Dibe Vurdu</span>`;
       } else if (changePercent <= -3) {
          badgeHtml = `<span class="badge badge-drop">%${Math.round(absolutePercent)} İndirim</span>`;
       } else if (changePercent >= 8) {
          badgeHtml = `<span class="badge badge-rise">%${Math.round(absolutePercent)} Sert Yükseliş</span>`;
       } else if (changePercent >= 3) {
          badgeHtml = `<span class="badge badge-rise">%${Math.round(absolutePercent)} Yükselişte</span>`;
       }
    }

    card.innerHTML = `
      <div class="tracked-card-top">
        <div class="tracked-main">
          <div class="tracked-title-row">
            <a class="tracked-title" href="${productUrl}" target="_blank" rel="noopener noreferrer" title="${productTitle}">${productTitle}</a>
            ${badgeHtml}
            ${discountBadgeHtml}
          </div>
          <div class="tracked-meta">
            ${storeHtml}
            <span>Son kontrol: ${dateText}</span>
          </div>
        </div>
        <div class="tracked-actions" style="position: relative;">
          <div class="card-menu-wrapper">
            <button class="icon-btn btn-card-menu" data-id="${product.id}" title="İşlemler" aria-label="İşlemler">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="1.5"/>
                <circle cx="12" cy="5" r="1.5"/>
                <circle cx="12" cy="19" r="1.5"/>
              </svg>
            </button>
            <div class="card-dropdown-menu" id="menu-${product.id}">
              <button class="menu-item btn-check-refresh" data-id="${product.id}">
                <span class="dot green-dot"></span><span>Yenile</span>
              </button>
              <button class="menu-item btn-check-bought" data-id="${product.id}">
                <span class="dot yellow-dot"></span><span>${product.isBought ? 'Alınmadı' : 'Aldım'}</span>
              </button>
              <button class="menu-item btn-check-delete" data-id="${product.id}">
                <span class="dot red-dot"></span><span>Sil</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="tracked-price-row">
        <div class="tracked-price-copy">
          ${currentPriceHtml}
          ${oldPriceStrikeHtml}
        ${boughtInfoHtml}
      </div>
      ${detailsHtml ? `
        <button class="analysis-toggle-btn btn-show-analysis" type="button" data-id="${product.id}" title="Fiyat analizi ve grafiği">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 3v18h18"/>
            <path d="m19 9-5 5-4-4-3 3"/>
          </svg>
          <span>Analiz</span>
        </button>
      ` : ''}
      </div>
      ${detailsHtml ? `
        <div class="tracked-details-panel" style="display:none">
          ${detailsHtml}
        </div>
      ` : ''}
      ${errorHtml}
    `;
    
    const targetInput = card.querySelector('.target-input');
    if (targetInput) targetInput.addEventListener('change', async (e) => {
      const val = parseFloat(e.target.value);
      const prodIndex = trackedProducts.findIndex(p => p.id === product.id);
      if (prodIndex > -1) {
        trackedProducts[prodIndex].targetPrice = isNaN(val) ? 0 : val;
        await cloudSyncProduct(trackedProducts[prodIndex]);
        showStatus('Hedef fiyat güncellendi', 'success');
      }
    });

    // Toggle menu click
    const menuBtn = card.querySelector('.btn-card-menu');
    if (menuBtn) menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const openMenu = card.querySelector('.card-dropdown-menu');
      if (openMenu) {
        const isShown = openMenu.classList.contains('show');
        document.querySelectorAll('.card-dropdown-menu').forEach(m => {
          m.classList.remove('show');
        });
        if (!isShown) {
          openMenu.classList.add('show');
        }
      }
    });

    // Analysis chart click
    const analysisItemBtn = card.querySelector('.btn-show-analysis');
    if (analysisItemBtn) analysisItemBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = card.querySelector('.tracked-details-panel');
      if (!panel) return;
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      card.classList.toggle('details-open', !isOpen);
    });

    // Refresh click
    const refreshItemBtn = card.querySelector('.btn-check-refresh');
    if (refreshItemBtn) refreshItemBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const openMenu = card.querySelector('.card-dropdown-menu');
      if (openMenu) openMenu.classList.remove('show');
      
      showStatus('Kontrol ediliyor...', 'info');
      chrome.runtime.sendMessage({
        action: 'check_product',
        product: { id: product.id, url: product.url, cloudId: product.cloudId }
      }, async (res) => {
        if (chrome.runtime.lastError) {
           showStatus('Fiyat kontrol edilemedi: ' + chrome.runtime.lastError.message, 'error');
           return;
        }
        if (res && res.success) {
           trackedProducts = await loadTrackedProducts();
           renderTrackedProducts();
           showStatus('Fiyat kontrol edildi.', 'success');
        } else {
           showStatus('Fiyat kontrol edilemedi: ' + (res?.error || 'Bilinmeyen hata'), 'error');
        }
      });
    });

    // Bought click
    const boughtItemBtn = card.querySelector('.btn-check-bought');
    if (boughtItemBtn) boughtItemBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const openMenu = card.querySelector('.card-dropdown-menu');
      if (openMenu) openMenu.classList.remove('show');
      
      const prodIndex = trackedProducts.findIndex(p => p.id === product.id);
      if (prodIndex === -1) return;
      
      const targetProd = trackedProducts[prodIndex];
      const newBoughtState = !targetProd.isBought;
      
      targetProd.isBought = newBoughtState;
      if (newBoughtState) {
        targetProd.boughtPrice = targetProd.currentPrice;
        targetProd.boughtAt = new Date().toISOString();
        
        if (!targetProd.priceHistory) targetProd.priceHistory = [];
        const hasHistoryToday = targetProd.priceHistory.some(h => h.price === targetProd.currentPrice && Math.abs(new Date(h.checkedAt) - new Date(targetProd.boughtAt)) < 5000);
        if (!hasHistoryToday) {
          targetProd.priceHistory.push({ price: targetProd.currentPrice, checkedAt: targetProd.boughtAt });
        }
      } else {
        targetProd.boughtPrice = null;
        targetProd.boughtAt = null;
      }
      
      showStatus('Kaydediliyor...', 'info');
      try {
        const cloudProduct = await cloudSyncProduct(targetProd);
        if (newBoughtState && cloudProduct?.id) {
          await cloudAddPriceHistory(cloudProduct.id, targetProd.boughtPrice, targetProd.boughtAt);
        }
        await saveTrackedProducts(trackedProducts);
        renderTrackedProducts();
        showStatus(newBoughtState ? 'Ürün satın alındı olarak işaretlendi.' : 'Ürün satın alınmadı olarak işaretlendi.', 'success');
      } catch (err) {
        showStatus('Değişiklik kaydedilemedi: ' + err.message, 'error');
      }
    });

    // Delete click
    const deleteItemBtn = card.querySelector('.btn-check-delete');
    if (deleteItemBtn) deleteItemBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const openMenu = card.querySelector('.card-dropdown-menu');
      if (openMenu) openMenu.classList.remove('show');
      
      if (confirm(`"${product.title}" takibini silmek istediğinize emin misiniz?`)) {
        showStatus('Siliniyor...', 'info');
        try {
          await cloudDeleteProduct(product.url);
          trackedProducts = trackedProducts.filter(p => p.id !== product.id);
          await saveTrackedProducts(trackedProducts);
          renderTrackedProducts();
          showStatus('Ürün silindi.', 'success');
        } catch (error) {
          showStatus('Ürün veritabanından silinemedi: ' + error.message, 'error');
        }
      }
    });
    
    // Click card to toggle chart panel
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, button, input, .icon-btn, .sparkline-container, .card-dropdown-menu')) return;
      const panel = card.querySelector('.tracked-details-panel');
      if (!panel) return;
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      card.classList.toggle('details-open', !isOpen);
    });
    
    container.appendChild(card);
  });
}

function updateCheckAllButtonState() {
  const btn = document.getElementById('btn-check-all');
  if (!btn) return;
  const isEmpty = trackedProducts.length === 0;
  btn.disabled = isEmpty;
  btn.style.opacity = isEmpty ? '0.45' : '';
  btn.style.cursor = isEmpty ? 'not-allowed' : '';
}

function getDisplayCategory(product) {
  const urlCategory = getCategoryFromAkakceUrl(product?.url);
  const storedCategory = product?.category || '';
  if (urlCategory && (!storedCategory || isGenericCategory(storedCategory))) {
    return urlCategory;
  }
  return storedCategory || 'Diğer';
}

function getCategoryFromAkakceUrl(url) {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes('akakce.com')) return null;
    const rawCategory = urlObj.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
    if (!rawCategory) return null;
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
    if (map[rawCategory]) return map[rawCategory];
    return rawCategory
      .split('-')
      .map(part => part.charAt(0).toLocaleUpperCase('tr-TR') + part.slice(1))
      .join(' ');
  } catch (error) {
    return null;
  }
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



async function handleSaveSettings() {
  const intervalInput = document.getElementById('setting-interval');
  const discordEnable = document.getElementById('setting-discord-enable');
  const discordWebhook = document.getElementById('setting-discord-webhook');
  const whatsappEnable = document.getElementById('setting-whatsapp-enable');
  const whatsappPhone = document.getElementById('setting-whatsapp-phone');
  const whatsappApiKey = document.getElementById('setting-whatsapp-apikey');
  const interval = parseInt(intervalInput?.value, 10) || 60;
  
  currentSettings = {
    checkInterval: Math.max(45, interval),
    enableDiscord: discordEnable?.checked || false,
    discordWebhookUrl: discordWebhook?.value.trim() || '',
    enableWhatsApp: whatsappEnable?.checked || false,
    callMeBotPhone: whatsappPhone?.value.trim() || '',
    callMeBotApiKey: whatsappApiKey?.value.trim() || ''
  };
  
  try {
    await saveSettings(currentSettings);
    chrome.alarms.create('checkPrices', {
      periodInMinutes: Math.max(45, currentSettings.checkInterval)
    });
    showStatus('Ayarlar kaydedildi.', 'success');
  } catch (error) {
    showStatus('Ayarlar veritabanına yazılamadı: ' + error.message, 'error');
  }
}

async function handleTestDiscord() {
  if (!currentSettings.discordWebhookUrl) {
    showStatus('Önce Discord Webhook URL girin ve kaydedin.', 'error');
    return;
  }
  
  try {
    const payload = {
      content: "Akakçe Price Tracker test message."
    };
    await fetch(currentSettings.discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    showStatus('Discord test mesajı gönderildi.', 'success');
  } catch (e) {
    showStatus('Discord hatası: ' + e.message, 'error');
  }
}

async function handleTestWhatsApp() {
  if (!currentSettings.callMeBotPhone || !currentSettings.callMeBotApiKey) {
    showStatus('Önce WhatsApp ayarlarını girin ve kaydedin.', 'error');
    return;
  }
  
  try {
    const text = "Akakçe Price Tracker test message.";
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(currentSettings.callMeBotPhone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(currentSettings.callMeBotApiKey)}`;
    await fetch(url);
    showStatus('WhatsApp test mesajı gönderildi.', 'success');
  } catch (e) {
    showStatus('WhatsApp hatası: ' + e.message, 'error');
  }
}

function handleExport() {
  closeTrackedOverflowMenu();
  const data = {
    settings: currentSettings,
    trackedProducts: trackedProducts
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `akakce-tracker-export-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showStatus('Dışa aktarıldı.', 'success');
}

function handleImport(e) {
  closeTrackedOverflowMenu();
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (evt) => {
    try {
      const data = JSON.parse(evt.target.result);
      if (data.settings) {
        currentSettings = { ...currentSettings, ...data.settings };
        await saveSettings(currentSettings);
        initSettings();
      }
      if (data.trackedProducts && Array.isArray(data.trackedProducts)) {
        data.trackedProducts.forEach(newP => {
          if (!trackedProducts.find(p => p.id === newP.id || p.url === newP.url)) {
            trackedProducts.push(newP);
          }
        });
        await saveTrackedProducts(trackedProducts);
        renderTrackedProducts();
      }
      showStatus('İçe aktarıldı.', 'success');
    } catch (err) {
      showStatus('Geçersiz dosya formatı.', 'error');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}
