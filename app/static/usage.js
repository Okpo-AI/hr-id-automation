/**
 * Usage Summary - AI Headshot Generation Tracking
 * Manages the usage summary page for HR administrators.
 */

// ============================================
// State
// ============================================
let allUsageData = [];
let filteredUsageData = [];
let pendingResetUserId = null;
const PRICE_PER_GENERATION = 2.40;

// ============================================
// DOM Elements
// ============================================
const DOM = {
  // Summary cards
  totalUsers: document.getElementById('totalUsers'),
  totalGenerations: document.getElementById('totalGenerations'),
  usageLimit: document.getElementById('usageLimit'),
  rateLimitedCount: document.getElementById('rateLimitedCount'),
  totalCost: document.getElementById('totalCost'),
  // Table
  tableSection: document.getElementById('tableSection'),
  loadingState: document.getElementById('loadingState'),
  emptyState: document.getElementById('emptyState'),
  usageTableBody: document.getElementById('usageTableBody'),
  tableCount: document.getElementById('tableCount'),
  // Search & Filter
  searchInput: document.getElementById('usageSearchInput'),
  usageFilter: document.getElementById('usageFilter'),
  // Actions
  refreshBtn: document.getElementById('refreshUsageBtn'),
  // Toast
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toastMessage'),
  toastIcon: document.getElementById('toastIcon'),
  // Progress
  progressOverlay: document.getElementById('usageProgressOverlay'),
  progressBarFill: document.getElementById('usageProgressBarFill'),
  progressText: document.getElementById('usageProgressText'),
  progressSubtext: document.getElementById('usageProgressSubtext'),
  // Reset Modal
  resetModal: document.getElementById('resetModal'),
  resetUserIdDisplay: document.getElementById('resetUserIdDisplay'),
  closeResetModal: document.getElementById('closeResetModal'),
  cancelResetBtn: document.getElementById('cancelResetBtn'),
  confirmResetBtn: document.getElementById('confirmResetBtn'),
  // Reset All Modal
  resetAllBtn: document.getElementById('resetAllBtn'),
  resetAllModal: document.getElementById('resetAllModal'),
  closeResetAllModal: document.getElementById('closeResetAllModal'),
  cancelResetAllBtn: document.getElementById('cancelResetAllBtn'),
  confirmResetAllBtn: document.getElementById('confirmResetAllBtn'),
};

// ============================================
// Progress Overlay
// ============================================
function showProgress(text, subtext) {
  DOM.progressOverlay.classList.add('active');
  DOM.progressText.textContent = text || 'Processing...';
  DOM.progressSubtext.textContent = subtext || '';
  DOM.progressBarFill.style.width = '0%';
  // Animate progress
  setTimeout(() => { DOM.progressBarFill.style.width = '40%'; }, 100);
  setTimeout(() => { DOM.progressBarFill.style.width = '70%'; }, 400);
}
function updateProgress(text, subtext, pct) {
  if (text) DOM.progressText.textContent = text;
  if (subtext) DOM.progressSubtext.textContent = subtext;
  if (pct !== undefined) DOM.progressBarFill.style.width = pct + '%';
}
function hideProgress() {
  DOM.progressBarFill.style.width = '100%';
  setTimeout(() => {
    DOM.progressOverlay.classList.remove('active');
    DOM.progressBarFill.style.width = '0%';
  }, 400);
}

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'success') {
  const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
  DOM.toastIcon.textContent = icons[type] || icons.success;
  DOM.toastMessage.textContent = message;
  DOM.toast.className = 'toast show ' + type;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    DOM.toast.classList.remove('show');
  }, type === 'error' ? 5000 : 3000);
}

// ============================================
// Animated Counter
// ============================================
function animateCounter(el, target) {
  const start = parseInt(el.textContent) || 0;
  if (start === target) { el.textContent = target; return; }
  const duration = 600;
  const startTime = performance.now();
  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ============================================
// Data Fetching
// ============================================
async function fetchUsageData() {
  DOM.loadingState.style.display = 'flex';
  DOM.tableSection.style.display = 'none';
  try {
    const res = await fetch('/hr/api/usage-summary', { credentials: 'same-origin' });
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/hr/login'; return; }
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed to fetch');
    allUsageData = json.data || [];
    // Update summary cards
    animateCounter(DOM.totalUsers, json.total_users || 0);
    animateCounter(DOM.totalGenerations, json.total_generations || 0);
    DOM.usageLimit.textContent = json.limit || 5;
    const rateLimited = allUsageData.filter(u => u.remaining <= 0).length;
    animateCounter(DOM.rateLimitedCount, rateLimited);
    // Total cost based on all-time generations
    const totalGens = json.total_generations || 0;
    DOM.totalCost.textContent = '₱' + (totalGens * PRICE_PER_GENERATION).toFixed(2);
    // Render table
    applyFilters();
  } catch (err) {
    console.error('Fetch usage error:', err);
    showToast('Failed to load usage data: ' + err.message, 'error');
  } finally {
    DOM.loadingState.style.display = 'none';
    DOM.tableSection.style.display = 'block';
  }
}

// ============================================
// Filtering & Rendering
// ============================================
function applyFilters() {
  const query = (DOM.searchInput.value || '').trim().toLowerCase();
  const filter = DOM.usageFilter.value;

  filteredUsageData = allUsageData.filter(u => {
    // Search
    if (query && !u.lark_user_id.toLowerCase().includes(query) && !(u.lark_name || '').toLowerCase().includes(query)) return false;
    // Filter
    if (filter === 'rate-limited' && u.remaining > 0) return false;
    if (filter === 'active' && u.remaining <= 0) return false;
    return true;
  });

  renderTable();
}

function renderTable() {
  const tbody = DOM.usageTableBody;
  tbody.innerHTML = '';

  if (filteredUsageData.length === 0) {
    DOM.emptyState.style.display = 'flex';
    DOM.tableCount.textContent = '0 users';
    return;
  }
  DOM.emptyState.style.display = 'none';
  DOM.tableCount.textContent = filteredUsageData.length + ' user' + (filteredUsageData.length !== 1 ? 's' : '');

  filteredUsageData.forEach(u => {
    const tr = document.createElement('tr');
    const usagePct = Math.round((u.usage_count / u.limit) * 100);
    const isLimited = u.remaining <= 0;
    const statusClass = isLimited ? 'status-rate-limited' : (u.usage_count > 0 ? 'status-active' : 'status-unused');
    const statusText = isLimited ? 'Rate Limited' : (u.usage_count > 0 ? 'Active' : 'No Usage');
    const totalGens = u.total_generations || u.usage_count;
    const userCost = (totalGens * PRICE_PER_GENERATION).toFixed(2);

    // Format date
    let lastUsedStr = '-';
    if (u.last_used) {
      try {
        const d = new Date(u.last_used);
        lastUsedStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
          ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      } catch { lastUsedStr = u.last_used; }
    }

    // Truncate user id for display
    const displayId = u.lark_user_id.length > 20
      ? u.lark_user_id.substring(0, 8) + '...' + u.lark_user_id.substring(u.lark_user_id.length - 8)
      : u.lark_user_id;

    tr.innerHTML = `
      <td>
        <span class="usage-lark-name">${u.lark_name || '<span class="usage-name-unknown">—</span>'}</span>
      </td>
      <td>
        <span class="usage-user-id" title="${u.lark_user_id}">${displayId}</span>
      </td>
      <td><strong>${u.usage_count}</strong> / ${u.limit}</td>
      <td>${totalGens}</td>
      <td>${u.remaining}</td>
      <td>₱${userCost}</td>
      <td>
        <div class="usage-bar-track">
          <div class="usage-bar-fill ${isLimited ? 'usage-bar-limited' : ''}" style="width: ${Math.min(usagePct, 100)}%"></div>
        </div>
        <span class="usage-pct">${usagePct}%</span>
      </td>
      <td>${lastUsedStr}</td>
      <td><span class="usage-status ${statusClass}">${statusText}</span></td>
      <td>
        <button class="btn-reset-limit ${!isLimited ? 'btn-reset-disabled' : ''}" 
                data-user-id="${u.lark_user_id}" 
                ${!isLimited ? 'title="User is not rate limited"' : 'title="Reset rate limit for this user"'}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M1 4v6h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M3.51 15a9 9 0 105.64-9.94L1 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Reset
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Attach reset handlers
  tbody.querySelectorAll('.btn-reset-limit:not(.btn-reset-disabled)').forEach(btn => {
    btn.addEventListener('click', () => openResetModal(btn.dataset.userId));
  });
}

// ============================================
// Reset Rate Limit
// ============================================
function openResetModal(larkUserId) {
  pendingResetUserId = larkUserId;
  DOM.resetUserIdDisplay.textContent = larkUserId;
  DOM.resetModal.classList.add('active');
}

function closeResetModal() {
  DOM.resetModal.classList.remove('active');
  pendingResetUserId = null;
}

async function confirmReset() {
  if (!pendingResetUserId) return;
  const userId = pendingResetUserId;
  closeResetModal();

  showProgress('Resetting rate limit...', 'User: ' + userId);
  try {
    const res = await fetch(`/hr/api/reset-rate-limit/${encodeURIComponent(userId)}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/hr/login'; return; }
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Reset failed');

    updateProgress('Rate limit reset!', '', 100);
    showToast('Rate limit reset successfully for user', 'success');
    // Refresh data
    await fetchUsageData();
  } catch (err) {
    console.error('Reset error:', err);
    showToast('Failed to reset: ' + err.message, 'error');
  } finally {
    hideProgress();
  }
}

// ============================================
// Reset All Rate Limits
// ============================================
function openResetAllModal() {
  DOM.resetAllModal.classList.add('active');
}

function closeResetAllModal() {
  DOM.resetAllModal.classList.remove('active');
}

async function confirmResetAll() {
  closeResetAllModal();
  showProgress('Resetting all rate limits...', 'Clearing all usage records');
  try {
    const res = await fetch('/hr/api/reset-all-rate-limits', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      if (res.status === 401) { window.location.href = '/hr/login'; return; }
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `HTTP ${res.status}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Reset failed');

    updateProgress('All rate limits reset!', `${json.deleted_count} records reset`, 100);
    showToast(`All rate limits reset — ${json.deleted_count} records reset (history preserved)`, 'success');
    await fetchUsageData();
  } catch (err) {
    console.error('Reset all error:', err);
    showToast('Failed to reset all: ' + err.message, 'error');
  } finally {
    hideProgress();
  }
}

// ============================================
// Event Listeners
// ============================================
DOM.searchInput.addEventListener('input', applyFilters);
DOM.usageFilter.addEventListener('change', applyFilters);
DOM.refreshBtn.addEventListener('click', () => fetchUsageData());
DOM.closeResetModal.addEventListener('click', closeResetModal);
DOM.cancelResetBtn.addEventListener('click', closeResetModal);
DOM.confirmResetBtn.addEventListener('click', confirmReset);
// Reset All
DOM.resetAllBtn.addEventListener('click', openResetAllModal);
DOM.closeResetAllModal.addEventListener('click', closeResetAllModal);
DOM.cancelResetAllBtn.addEventListener('click', closeResetAllModal);
DOM.confirmResetAllBtn.addEventListener('click', confirmResetAll);
DOM.resetAllModal.addEventListener('click', (e) => {
  if (e.target === DOM.resetAllModal) closeResetAllModal();
});
// Close modal on overlay click
DOM.resetModal.addEventListener('click', (e) => {
  if (e.target === DOM.resetModal) closeResetModal();
});

// ============================================
// Init
// ============================================
document.addEventListener('DOMContentLoaded', fetchUsageData);
