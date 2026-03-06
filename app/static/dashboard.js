/**
 * HR Dashboard JavaScript
 * Handles data fetching, filtering, and actions
 */

// ============================================
// State Management
// ============================================
const dashboardState = {
  employees: [],
  filteredEmployees: [],
  isLoading: true,
  viewedEmployees: new Set(), // Track which employees have had their details viewed
  lastFetchTime: null // Track when data was last fetched
};

// Cache settings
// VERCEL FIX: Increased cache duration to prevent data loss during cold starts
// Use shared cache key between dashboard and gallery for consistency
const CACHE_KEY = 'hrEmployeeDataCache';  // Shared with gallery.js
const CACHE_DURATION_MS = 300000; // 5 minutes - longer cache to survive Vercel cold starts
const CACHE_MAX_AGE_MS = 3600000; // 1 hour - maximum age before cache is completely invalid

// Load cached employee data from sessionStorage
function loadCachedData() {
  try {
    const cached = sessionStorage.getItem(CACHE_KEY);
    if (cached) {
      const { employees, timestamp } = JSON.parse(cached);
      const age = Date.now() - timestamp;
      
      // Use cache if within normal duration
      if (age < CACHE_DURATION_MS && employees && employees.length > 0) {
        console.log('Dashboard: Using cached data, age:', Math.round(age/1000), 'seconds');
        return employees;
      }
      
      // VERCEL FIX: For stale but not expired cache, still return it for immediate display
      // Background fetch will update it
      if (age < CACHE_MAX_AGE_MS && employees && employees.length > 0) {
        console.log('Dashboard: Using stale cached data for immediate display, age:', Math.round(age/1000), 'seconds');
        return employees;
      }
    }
  } catch (e) {
    console.warn('Dashboard: Cache read error', e);
  }
  return null;
}

// Save employee data to sessionStorage cache
function saveCachedData(employees) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({
      employees,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.warn('Dashboard: Cache write error', e);
  }
}

// Load viewed employees from sessionStorage on init
function loadViewedEmployees() {
  const stored = sessionStorage.getItem('viewedEmployees');
  if (stored) {
    try {
      dashboardState.viewedEmployees = new Set(JSON.parse(stored));
    } catch (e) {
      dashboardState.viewedEmployees = new Set();
    }
  }
}

// Save viewed employees to sessionStorage
function saveViewedEmployees() {
  sessionStorage.setItem('viewedEmployees', JSON.stringify([...dashboardState.viewedEmployees]));
}

// Check if employee details have been viewed
function hasViewedDetails(id) {
  return dashboardState.viewedEmployees.has(id);
}

// Mark employee as viewed
function markAsViewed(id) {
  dashboardState.viewedEmployees.add(id);
  saveViewedEmployees();
}

// ============================================
// DOM Elements
// ============================================
const elements = {
  loadingState: document.getElementById('loadingState'),
  tableSection: document.getElementById('tableSection'),
  employeeTableBody: document.getElementById('employeeTableBody'),
  emptyState: document.getElementById('emptyState'),
  tableCount: document.getElementById('tableCount'),
  searchInput: document.getElementById('searchInput'),
  statusFilter: document.getElementById('statusFilter'),
  positionFilter: document.getElementById('positionFilter'),
  totalCount: document.getElementById('totalCount'),
  reviewingCount: document.getElementById('reviewingCount'),
  approvedCount: document.getElementById('approvedCount'),
  sentToPOCCount: document.getElementById('sentToPOCCount'),
  detailsModal: document.getElementById('detailsModal'),
  modalBody: document.getElementById('modalBody'),
  modalFooter: document.getElementById('modalFooter'),
  closeModal: document.getElementById('closeModal'),
  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toastMessage'),
  toastIcon: document.getElementById('toastIcon'),
  viewGalleryBtn: document.getElementById('viewGalleryBtn'),
  exportDataBtn: document.getElementById('exportDataBtn'),
  refreshDataBtn: document.getElementById('refreshDataBtn'),
  approveAllBtn: document.getElementById('approveAllBtn'),
  sendToPOCsBtn: document.getElementById('sendToPOCsBtn')
};

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  console.log('Dashboard: DOMContentLoaded fired');
  try {
    // Verify critical elements exist
    const criticalElements = ['loadingState', 'tableSection', 'employeeTableBody', 'searchInput', 'statusFilter', 'positionFilter'];
    for (const el of criticalElements) {
      if (!elements[el]) {
        console.error(`Dashboard: Critical element missing: ${el}`);
      }
    }
    
    loadViewedEmployees();
    initEventListeners();
    fetchEmployeeData();
  } catch (error) {
    console.error('Dashboard: Initialization error:', error);
    // Still try to fetch data even if some initialization fails
    fetchEmployeeData();
  }
});

function initEventListeners() {
  // Search and filter - with null checks
  if (elements.searchInput) {
    elements.searchInput.addEventListener('input', debounce(filterEmployees, 300));
  }
  if (elements.statusFilter) {
    elements.statusFilter.addEventListener('change', filterEmployees);
  }
  if (elements.positionFilter) {
    elements.positionFilter.addEventListener('change', filterEmployees);
  }

  // Modal
  if (elements.closeModal) {
    elements.closeModal.addEventListener('click', closeModal);
  }
  if (elements.detailsModal) {
    elements.detailsModal.addEventListener('click', (e) => {
      if (e.target === elements.detailsModal) closeModal();
    });
  }

  // Quick actions
  if (elements.viewGalleryBtn) {
    elements.viewGalleryBtn.addEventListener('click', () => {
      window.location.href = '/hr/gallery';
    });
  }

  if (elements.exportDataBtn) {
    elements.exportDataBtn.addEventListener('click', exportData);
  }
  
  if (elements.refreshDataBtn) {
    elements.refreshDataBtn.addEventListener('click', () => {
      // Force refresh bypasses cache
      fetchEmployeeData(true);
      showToast('Data refreshed successfully', 'success');
    });
  }

  // Bulk action buttons
  if (elements.approveAllBtn) {
    elements.approveAllBtn.addEventListener('click', approveAllRendered);
  }
  
  if (elements.sendToPOCsBtn) {
    elements.sendToPOCsBtn.addEventListener('click', sendAllToPOCs);
  }

  // Escape key to close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

// ============================================
// Data Fetching
// ============================================
async function fetchEmployeeData(forceRefresh = false, retryCount = 0) {
  const MAX_RETRIES = 2;  // VERCEL FIX: Retry on cold start timeouts
  
  // VERCEL FIX: Try to use cached data first to prevent data loss on navigation
  if (!forceRefresh) {
    const cachedData = loadCachedData();
    if (cachedData) {
      dashboardState.employees = cachedData;
      dashboardState.filteredEmployees = [...cachedData];
      dashboardState.lastFetchTime = Date.now();
      updateStatusCounts();
      renderEmployeeTable();
      showLoading(false);
      // Still fetch fresh data in background to keep cache updated
      fetchEmployeeDataBackground();
      return;
    }
  }
  
  showLoading(true);

  // VERCEL FIX: Longer timeout for cold starts, shorter for retries
  const timeoutMs = retryCount === 0 ? 20000 : 15000;  // 20s first attempt, 15s retries
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log('fetchEmployeeData: Request timeout - aborting');
    controller.abort();
  }, timeoutMs);

  try {
    // VERCEL FIX: Include credentials to ensure JWT cookie is sent with request
    // Without this, serverless functions may not receive the authentication cookie
    const response = await fetch('/hr/api/employees', {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // Handle unauthorized - redirect to login
    if (response.status === 401) {
      console.log('fetchEmployeeData: Unauthorized, redirecting to login');
      window.location.href = '/hr/login';
      return;
    }
    
    const data = await response.json();

    if (data.success) {
      dashboardState.employees = data.employees || [];
      dashboardState.filteredEmployees = [...dashboardState.employees];
      dashboardState.lastFetchTime = Date.now();
      // VERCEL FIX: Cache data to sessionStorage
      saveCachedData(dashboardState.employees);
      updateStatusCounts();
      renderEmployeeTable();
    } else {
      throw new Error(data.error || 'Failed to fetch data');
    }
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('Error fetching employee data:', error);
    
    // VERCEL FIX: Retry on timeout (cold start recovery)
    if (error.name === 'AbortError' && retryCount < MAX_RETRIES) {
      console.log('fetchEmployeeData: Timeout, retrying... (attempt', retryCount + 2, ')');
      showToast('Loading... please wait (server warming up)', 'info');
      // Small delay before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchEmployeeData(forceRefresh, retryCount + 1);
    }
    
    // VERCEL FIX: Handle abort/timeout gracefully
    if (error.name === 'AbortError') {
      showToast('Request timed out. Please refresh the page.', 'error');
    } else {
      showToast('Failed to load employee data: ' + error.message, 'error');
    }
    
    // VERCEL FIX: Try to use cached data on error instead of showing empty state
    const cachedData = loadCachedData();
    if (cachedData && cachedData.length > 0) {
      console.log('Dashboard: Using cached data after fetch error');
      dashboardState.employees = cachedData;
      dashboardState.filteredEmployees = [...cachedData];
      updateStatusCounts();
      renderEmployeeTable();
      showToast('Showing cached data. Pull to refresh.', 'warning');
    } else {
      // Only set empty state if no cache available
      dashboardState.employees = [];
      dashboardState.filteredEmployees = [];
      updateStatusCounts();
      renderEmployeeTable();
    }
  } finally {
    showLoading(false);
  }
}

// Background fetch to update cache without blocking UI
async function fetchEmployeeDataBackground() {
  try {
    const response = await fetch('/hr/api/employees', {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
    
    if (response.status === 401) return;
    
    const data = await response.json();
    if (data.success && data.employees) {
      // Only update if data changed
      if (JSON.stringify(data.employees) !== JSON.stringify(dashboardState.employees)) {
        console.log('Dashboard: Background fetch found updated data');
        dashboardState.employees = data.employees;
        dashboardState.filteredEmployees = [...data.employees];
        dashboardState.lastFetchTime = Date.now();
        saveCachedData(data.employees);
        updateStatusCounts();
        renderEmployeeTable();
      }
    }
  } catch (e) {
    console.log('Dashboard: Background fetch error (non-blocking)', e);
  }
}

// ============================================
// UI Updates
// ============================================
function showLoading(show) {
  dashboardState.isLoading = show;
  elements.loadingState.style.display = show ? 'flex' : 'none';
  elements.tableSection.style.display = show ? 'none' : 'block';
}

function updateStatusCounts() {
  const employees = dashboardState.employees;
  // Exclude Removed from all counts (backend should already exclude them,
  // but this is a safety net for cached data)
  const active = employees.filter(e => e.status !== 'Removed');
  const total = active.length;
  const reviewing = active.filter(e => e.status === 'Reviewing').length;
  const approved = active.filter(e => e.status === 'Approved').length;
  const sentToPOC = active.filter(e => e.status === 'Sent to POC').length;

  animateCounter(elements.totalCount, total);
  animateCounter(elements.reviewingCount, reviewing);
  animateCounter(elements.approvedCount, approved);
  animateCounter(elements.sentToPOCCount, sentToPOC);
}

function renderEmployeeTable() {
  const employees = dashboardState.filteredEmployees;
  // Use active (non-Removed) count for total display
  const total = dashboardState.employees.filter(e => e.status !== 'Removed').length;

  // Update count
  elements.tableCount.textContent = `${employees.length} of ${total} employees`;

  // Check if empty
  if (employees.length === 0) {
    elements.employeeTableBody.innerHTML = '';
    elements.emptyState.style.display = 'flex';
    return;
  }

  elements.emptyState.style.display = 'none';

  // Render table rows
  const rows = employees.map(emp => {
    // Use photo_url (Cloudinary) if available, otherwise fall back to local path
    const photoSrc = emp.photo_url || (emp.photo_path ? `/static/${emp.photo_path}` : null);
    const photoHtml = photoSrc 
      ? `<img src="${photoSrc}" alt="${emp.employee_name}" class="employee-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="photo-placeholder" style="display:none;">👤</div>`
      : `<div class="photo-placeholder">👤</div>`;

    // AI-generated photo (new_photo_url)
    const newPhotoSrc = emp.new_photo_url;
    const newPhotoHtml = newPhotoSrc 
      ? `<img src="${newPhotoSrc}" alt="AI Photo" class="employee-photo ai-photo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><div class="photo-placeholder" style="display:none;">🤖</div>`
      : `<div class="photo-placeholder no-ai">—</div>`;

    const statusClass = emp.status.toLowerCase();
    const submittedDate = emp.date_last_modified 
      ? new Date(emp.date_last_modified).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        })
      : '-';

    // Show Render ID for Reviewing, Pending, or Submitted status
    const canRenderID = ['Reviewing', 'Pending', 'Submitted'].includes(emp.status);
    // Show Preview for Rendered, Approved, or Sent to POC status
    const canPreview = ['Rendered', 'Approved', 'Sent to POC'].includes(emp.status);
    const viewed = hasViewedDetails(emp.id);
    
    // Disable Render ID and Remove buttons until Details has been viewed
    const renderDisabled = !viewed ? 'disabled title="View details first"' : '';
    const removeDisabled = !viewed ? 'disabled title="View details first"' : '';

    return `
      <tr data-id="${emp.id}">
        <td>${photoHtml}</td>
        <td>${newPhotoHtml}</td>
        <td>
          <div class="employee-info">
            <span class="employee-name">${escapeHtml(emp.employee_name)}</span>
          </div>
        </td>
        <td><span class="employee-id-number">${escapeHtml(emp.id_number)}</span></td>
        <td><span class="employee-email">${escapeHtml(emp.email || '-')}</span></td>
        <td><span class="employee-phone">${escapeHtml(emp.personal_number || '-')}</span></td>
        <td>${escapeHtml(emp.position)}</td>
        <td>${escapeHtml(emp.location_branch || '-')}</td>
        <td><span class="status-badge ${statusClass}">${emp.status}</span></td>
        <td>${submittedDate}</td>
        <td>
          <div class="action-buttons">
            <button class="action-btn-sm view" onclick="viewDetails(${emp.id})">Details</button>
            ${canRenderID ? `<button class="action-btn-sm approve" onclick="renderAndApprove(${emp.id})" ${renderDisabled}>Render ID</button>` : ''}
            ${canPreview ? `<button class="action-btn-sm preview" onclick="previewID(${emp.id})">Preview</button>` : ''}
            <button class="action-btn-sm remove" onclick="removeEmployee(${emp.id})" ${removeDisabled}>Remove</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  elements.employeeTableBody.innerHTML = rows;
}

// ============================================
// Filtering
// ============================================
function filterEmployees() {
  const searchTerm = elements.searchInput.value.toLowerCase().trim();
  const statusFilter = elements.statusFilter.value;
  const positionFilter = elements.positionFilter.value;

  dashboardState.filteredEmployees = dashboardState.employees.filter(emp => {
    // Exclude Removed status from dashboard display
    if (emp.status === 'Removed') return false;
    
    // Search filter
    const matchesSearch = !searchTerm || 
      emp.employee_name.toLowerCase().includes(searchTerm) ||
      emp.id_number.toLowerCase().includes(searchTerm) ||
      (emp.location_branch || '').toLowerCase().includes(searchTerm) ||
      emp.position.toLowerCase().includes(searchTerm);

    // Status filter
    const matchesStatus = !statusFilter || emp.status === statusFilter;

    // Position filter
    const matchesPosition = !positionFilter || emp.position === positionFilter;

    return matchesSearch && matchesStatus && matchesPosition;
  });

  renderEmployeeTable();
}

// ============================================
// Actions
// ============================================
async function approveEmployee(id) {
  if (!confirm('Are you sure you want to approve this application?')) return;

  const emp = dashboardState.employees.find(e => e.id === id);
  showDashboardProgress('Approving Application...', emp ? emp.employee_name : '');

  try {
    const response = await fetch(`/hr/api/employees/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    const data = await response.json();

    if (data.success) {
      if (emp) emp.status = 'Approved';
      updateStatusCounts();
      filterEmployees();
      updateDashboardProgress(100, 'Approved!', '');
      setTimeout(() => {
        hideDashboardProgress();
        showToast('Application approved successfully', 'success');
      }, 600);
    } else {
      throw new Error(data.error || 'Failed to approve');
    }
  } catch (error) {
    hideDashboardProgress();
    console.error('Error approving employee:', error);
    showToast('Failed to approve application', 'error');
  }
}

async function removeEmployee(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  const empName = emp ? emp.employee_name : 'this employee';
  
  if (!confirm(`Are you sure you want to remove ${empName}'s application? This will mark it as Removed.`)) return;

  showDashboardProgress('Removing Application...', empName);

  try {
    const response = await fetch(`/hr/api/employees/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    const data = await response.json();

    if (data.success) {
      dashboardState.employees = dashboardState.employees.filter(e => e.id !== id);
      dashboardState.filteredEmployees = dashboardState.filteredEmployees.filter(e => e.id !== id);
      saveCachedData(dashboardState.employees);
      filterEmployees();
      updateStatusCounts();
      hideDashboardProgress();
      showToast(data.message || 'Application marked as Removed', 'success');
    } else {
      throw new Error(data.error || 'Failed to remove');
    }
  } catch (error) {
    hideDashboardProgress();
    console.error('Error removing employee:', error);
    showToast('Failed to remove application', 'error');
  }
}

async function removeBackground(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  if (!emp) {
    console.error('Employee not found:', id);
    return;
  }

  showDashboardProgress('Removing Background...', 'AI-powered background removal in progress');

  // Find the button by looking for it in the modal
  const button = document.querySelector('.nobg-photo-box button');
  if (button) {
    button.classList.add('loading');
    button.disabled = true;
  }

  try {
    const response = await fetch(`/hr/api/employees/${id}/remove-background?force=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    const data = await response.json();

    if (data.success) {
      emp.nobg_photo_url = data.nobg_photo_url;
      updateDashboardProgress(100, 'Background Removed!', '');
      setTimeout(() => {
        hideDashboardProgress();
        viewDetails(id);
        showToast(data.message || 'Background removed successfully', 'success');
      }, 800);
    } else {
      throw new Error(data.error || 'Failed to remove background');
    }
  } catch (error) {
    hideDashboardProgress();
    console.error('Error removing background:', error);
    showToast('Failed to remove background: ' + error.message, 'error');
    
    if (button) {
      button.classList.remove('loading');
      button.disabled = false;
    }
  }
}

function viewDetails(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  if (!emp) return;

  // Mark this employee as viewed (enables Approve/Remove buttons)
  markAsViewed(id);
  // Re-render the table to update button states
  renderEmployeeTable();

  // Original photo
  const photoSrc = emp.photo_url || (emp.photo_path ? `/static/${emp.photo_path}` : null);
  const photoHtml = photoSrc 
    ? `<img src="${photoSrc}" alt="${emp.employee_name}">`
    : '<p style="color: var(--color-text-muted);">No photo available</p>';

  // AI-generated photo
  const newPhotoHtml = emp.new_photo_url 
    ? `<img src="${emp.new_photo_url}" alt="AI Generated Photo">`
    : '<p style="color: var(--color-text-muted);">No AI photo generated</p>';

  // Background-removed photo (for ID card)
  const nobgPhotoHtml = emp.nobg_photo_url 
    ? `<img src="${emp.nobg_photo_url}" alt="ID Card Photo" style="background: linear-gradient(45deg, #e0e0e0 25%, transparent 25%), linear-gradient(-45deg, #e0e0e0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e0e0e0 75%), linear-gradient(-45deg, transparent 75%, #e0e0e0 75%); background-size: 10px 10px; background-position: 0 0, 0 5px, 5px -5px, -5px 0px;">`
    : (emp.new_photo_url 
        ? `<button class="btn btn-sm btn-primary" onclick="removeBackground(${emp.id})">🖼️ Remove Background</button>`
        : '<p style="color: var(--color-text-muted);">No AI photo available</p>');

  const signatureHtml = emp.signature_url 
    ? `<img src="${emp.signature_url}" alt="Signature" style="max-height: 60px;">`
    : '<p style="color: var(--color-text-muted);">No signature available</p>';

  elements.modalBody.innerHTML = `
    <div class="detail-photos-row">
      <div class="detail-item detail-photo">
        <span class="detail-label">Original Photo</span>
        ${photoHtml}
      </div>
      <div class="detail-item detail-photo ai-photo-box">
        <span class="detail-label">AI Photo</span>
        ${newPhotoHtml}
      </div>
      <div class="detail-item detail-photo nobg-photo-box">
        <span class="detail-label">ID Photo</span>
        ${nobgPhotoHtml}
      </div>
    </div>
    <div class="details-grid">
      <div class="detail-item">
        <span class="detail-label">Employee Name</span>
        <span class="detail-value">${escapeHtml(emp.employee_name)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">ID Nickname</span>
        <span class="detail-value">${escapeHtml(emp.id_nickname || '-')}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">ID Number</span>
        <span class="detail-value">${escapeHtml(emp.id_number)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">ID Barcode</span>
        <div class="detail-value barcode-container">
          ${generateBarcodeHtml(emp.id_number, { height: 45 })}
        </div>
      </div>
      <div class="detail-item">
        <span class="detail-label">Position</span>
        <span class="detail-value">${escapeHtml(emp.position)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Branch/Location</span>
        <span class="detail-value">${escapeHtml(emp.location_branch || '-')}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Email</span>
        <span class="detail-value">${escapeHtml(emp.email)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Phone</span>
        <span class="detail-value">${escapeHtml(emp.personal_number)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Status</span>
        <span class="detail-value">
          <span class="status-badge ${emp.status.toLowerCase()}">${emp.status}</span>
        </span>
      </div>
      <div class="detail-item full-width">
        <span class="detail-label">Signature</span>
        <div class="detail-value" style="background: white; text-align: center;">
          ${signatureHtml}
        </div>
      </div>
    </div>
  `;

  // Footer buttons based on status
  let footerHtml = `
    <button class="btn btn-danger" onclick="removeEmployee(${emp.id}); closeModal();">Remove</button>
    <button class="btn btn-secondary" onclick="closeModal()">Close</button>
  `;
  
  if (['Reviewing', 'Pending', 'Submitted', 'Rendered', 'Approved', 'Sent to POC', 'Completed'].includes(emp.status)) {
    footerHtml = `
      <button class="btn btn-danger" onclick="removeEmployee(${emp.id}); closeModal();">Remove</button>
      <button class="btn btn-secondary" onclick="closeModal()">Close</button>
      <button class="btn btn-primary" onclick="renderAndApprove(${emp.id}); closeModal();">Render ID</button>
      <button class="btn btn-primary" onclick="rerenderID(${emp.id}); closeModal();">Re-render ID</button>
      <button class="btn btn-primary" onclick="previewID(${emp.id})">Preview ID</button>
    `;
  }

  elements.modalFooter.innerHTML = footerHtml;
  elements.detailsModal.classList.add('active');
}

function closeModal() {
  elements.detailsModal.classList.remove('active');
}

/**
 * Render ID - Marks ID as rendered and redirects to gallery for preview
 * This does NOT approve the ID - approval happens in the Gallery.
 */
async function renderAndApprove(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  if (!emp) return;

  if (!confirm('Are you sure you want to render this ID and send it to Gallery for review?')) return;

  showDashboardProgress('Rendering ID Card...', emp.employee_name);

  try {
    // Mark as Rendered (NOT Approved) - actual approval happens in Gallery
    const response = await fetch(`/hr/api/employees/${id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });

    const data = await response.json();

    if (data.success) {
      // Update local state to Rendered (not Approved)
      emp.status = 'Rendered';
      
      updateStatusCounts();
      filterEmployees();
      updateDashboardProgress(100, 'ID Rendered!', 'Redirecting to Gallery...');
      
      // Redirect to gallery for preview
      setTimeout(() => {
        hideDashboardProgress();
        window.location.href = `/hr/gallery?preview=${encodeURIComponent(id)}`;
      }, 1500);
    } else {
      throw new Error(data.error || 'Failed to render');
    }
  } catch (error) {
    hideDashboardProgress();
    console.error('Error rendering employee ID:', error);
    showToast('Failed to render: ' + error.message, 'error');
  }
}

async function rerenderID(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  if (!emp) return;

  if (!confirm('Are you sure you want to re-render this ID?')) return;
  await renderAndApprove(id);
}

/**
 * Preview ID - Opens gallery to preview the rendered ID (no download)
 */
function previewID(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  if (!emp) return;

  showToast('Opening gallery for preview...', 'success');
  window.location.href = `/hr/gallery?preview=${encodeURIComponent(id)}`;
}

async function markAsSentToPOC(id) {
  const emp = dashboardState.employees.find(e => e.id === id);
  showDashboardProgress('Sending to POC...', emp ? emp.employee_name : 'Finding nearest branch');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);
    
    const response = await fetch(`/hr/api/employees/${id}/send-to-poc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const data = await response.json().catch(() => ({}));
    
    if (response.ok && data.success) {
      if (emp) emp.status = 'Sent to POC';
      updateStatusCounts();
      filterEmployees();
      
      const msgSent = data.message_sent ? '✅ Lark message sent' : '⚠️ Lark message failed';
      const testLabel = data.test_mode ? ' (TEST MODE)' : '';
      updateDashboardProgress(100, 'Sent to POC!', data.nearest_poc || '');
      setTimeout(() => {
        hideDashboardProgress();
        showToast(`Sent to POC: ${data.nearest_poc || 'Unknown'}${testLabel}. ${msgSent}`, data.message_sent ? 'success' : 'warning');
      }, 800);
    } else {
      const errorMsg = data.error || `Server error (${response.status})`;
      hideDashboardProgress();
      showToast(`Failed to send to POC: ${errorMsg}`, 'error');
    }
  } catch (error) {
    hideDashboardProgress();
    if (error.name === 'AbortError') {
      showToast('POC send timed out. The server may still be processing. Try refreshing.', 'error');
    } else {
      showToast(`Error sending to POC: ${error.message}`, 'error');
    }
    console.error('Error marking as sent to POC:', error);
  }
}

// ============================================
// Bulk Actions
// ============================================

/**
 * Approve all employees with "Rendered" status
 * Changes their status to "Approved"
 */
async function approveAllRendered() {
  const renderedEmployees = dashboardState.employees.filter(e => e.status === 'Rendered');
  
  if (renderedEmployees.length === 0) {
    showToast('No employees with "Rendered" status to approve', 'error');
    return;
  }
  
  const confirmApprove = confirm(`Are you sure you want to approve ${renderedEmployees.length} employee(s) with "Rendered" status?`);
  if (!confirmApprove) return;
  
  showDashboardProgress('Approving All Rendered...', `0 of ${renderedEmployees.length} employees`);
  
  // Disable button during operation
  if (elements.approveAllBtn) {
    elements.approveAllBtn.classList.add('loading');
    elements.approveAllBtn.disabled = true;
  }
  
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < renderedEmployees.length; i++) {
    const emp = renderedEmployees[i];
    updateDashboardProgress(
      Math.round(((i + 1) / renderedEmployees.length) * 90),
      'Approving Employees...',
      `${i + 1} of ${renderedEmployees.length} — ${emp.employee_name}`
    );
    try {
      const response = await fetch(`/hr/api/employees/${emp.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include'
      });
      
      if (response.ok) {
        emp.status = 'Approved';
        successCount++;
      } else {
        failCount++;
      }
    } catch (error) {
      console.error(`Error approving employee ${emp.id}:`, error);
      failCount++;
    }
  }
  
  // Re-enable button
  if (elements.approveAllBtn) {
    elements.approveAllBtn.classList.remove('loading');
    elements.approveAllBtn.disabled = false;
  }
  
  updateStatusCounts();
  filterEmployees();
  
  updateDashboardProgress(100, 'Complete!', `${successCount} approved${failCount ? `, ${failCount} failed` : ''}`);
  setTimeout(() => {
    hideDashboardProgress();
    if (failCount === 0) {
      showToast(`Successfully approved ${successCount} employee(s)`, 'success');
    } else {
      showToast(`Approved ${successCount}, failed ${failCount}`, 'error');
    }
  }, 800);
}

/**
 * Send all "Approved" employees to their POCs based on nearest branch
 */
async function sendAllToPOCs() {
  const approvedEmployees = dashboardState.employees.filter(e => e.status === 'Approved');
  
  if (approvedEmployees.length === 0) {
    showToast('No employees with "Approved" status to send to POCs', 'error');
    return;
  }
  
  const confirmSend = confirm(`Are you sure you want to send ${approvedEmployees.length} employee(s) to their nearest branch POCs?`);
  if (!confirmSend) return;
  
  showDashboardProgress('Sending All to POCs...', `${approvedEmployees.length} employees queued`);
  
  // Disable button during operation
  if (elements.sendToPOCsBtn) {
    elements.sendToPOCsBtn.classList.add('loading');
    elements.sendToPOCsBtn.disabled = true;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 55000);
    
    const response = await fetch('/hr/api/send-all-to-pocs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    const data = await response.json();
    
    if (data.success) {
      for (const emp of approvedEmployees) {
        emp.status = 'Sent to POC';
      }
      updateStatusCounts();
      filterEmployees();
      
      const msgInfo = data.message_sent_count !== undefined 
        ? ` (${data.message_sent_count} Lark messages sent)` 
        : '';
      const testLabel = data.test_mode ? ' [TEST MODE]' : '';
      updateDashboardProgress(100, 'All Sent!', `${data.sent_count || approvedEmployees.length} employees routed to POCs`);
      setTimeout(() => {
        hideDashboardProgress();
        showToast(`Successfully sent ${data.sent_count || approvedEmployees.length} employee(s) to POCs${testLabel}${msgInfo}`, 'success');
      }, 1000);
    } else {
      throw new Error(data.error || 'Failed to send to POCs');
    }
  } catch (error) {
    hideDashboardProgress();
    if (error.name === 'AbortError') {
      showToast('Bulk send timed out. Refresh to see current status — some may have been sent.', 'error');
    } else {
      showToast('Failed to send employees to POCs: ' + error.message, 'error');
    }
    console.error('Error sending to POCs:', error);
  }
  
  // Re-enable button
  if (elements.sendToPOCsBtn) {
    elements.sendToPOCsBtn.classList.remove('loading');
    elements.sendToPOCsBtn.disabled = false;
  }
}

// ============================================
// Quick Actions
// ============================================
function exportData() {
  const employees = dashboardState.filteredEmployees;
  
  if (employees.length === 0) {
    showToast('No data to export', 'error');
    return;
  }

  // Create CSV content
  const headers = ['Employee Name', 'ID Number', 'Branch/Location', 'Position', 'Email', 'Phone', 'Status', 'Submitted Date'];
  const rows = employees.map(emp => [
    emp.employee_name,
    emp.id_number,
    emp.location_branch || '',
    emp.position,
    emp.email,
    emp.personal_number,
    emp.status,
    emp.date_last_modified || ''
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  // Download CSV
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `employee_applications_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();

  showToast('Data exported successfully', 'success');
}

// ============================================
// Utilities
// ============================================
function showToast(message, type = 'success') {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  if (elements.toastIcon) elements.toastIcon.textContent = icons[type] || '';
  elements.toastMessage.textContent = message;
  elements.toast.className = `toast show ${type}`;

  // Longer duration for errors/warnings
  const duration = (type === 'error' || type === 'warning') ? 5000 : 3000;
  setTimeout(() => {
    elements.toast.classList.remove('show');
  }, duration);
}

// ============================================
// Progress Overlay (for async dashboard actions)
// ============================================
let dashProgressInterval = null;

function showDashboardProgress(text, subtext) {
  const overlay = document.getElementById('dashboardProgressOverlay');
  const textEl = document.getElementById('dashboardProgressText');
  const subtextEl = document.getElementById('dashboardProgressSubtext');
  const fillEl = document.getElementById('dashboardProgressBarFill');
  if (!overlay) return;

  if (textEl) textEl.textContent = text || 'Processing...';
  if (subtextEl) subtextEl.textContent = subtext || '';
  if (fillEl) fillEl.style.width = '10%';
  overlay.classList.add('active');

  // Simulate progress (accelerates then slows near 90%)
  let pct = 10;
  clearInterval(dashProgressInterval);
  dashProgressInterval = setInterval(() => {
    if (pct < 60) pct += 3;
    else if (pct < 85) pct += 1;
    else if (pct < 92) pct += 0.3;
    if (fillEl) fillEl.style.width = pct + '%';
  }, 200);
}

function updateDashboardProgress(percent, text, subtext) {
  const fillEl = document.getElementById('dashboardProgressBarFill');
  const textEl = document.getElementById('dashboardProgressText');
  const subtextEl = document.getElementById('dashboardProgressSubtext');
  clearInterval(dashProgressInterval);
  if (fillEl) fillEl.style.width = percent + '%';
  if (text && textEl) textEl.textContent = text;
  if (subtext !== undefined && subtextEl) subtextEl.textContent = subtext;
}

function hideDashboardProgress() {
  clearInterval(dashProgressInterval);
  const overlay = document.getElementById('dashboardProgressOverlay');
  if (overlay) overlay.classList.remove('active');
}

// ============================================
// Status Counter Animation
// ============================================
function animateCounter(element, target) {
  if (!element) return;
  const current = parseInt(element.textContent) || 0;
  if (current === target) { element.textContent = target; return; }
  
  const duration = 400; // ms
  const steps = 20;
  const stepTime = duration / steps;
  const increment = (target - current) / steps;
  let step = 0;
  
  element.classList.add('counting');
  const timer = setInterval(() => {
    step++;
    if (step >= steps) {
      clearInterval(timer);
      element.textContent = target;
      element.classList.remove('counting');
    } else {
      element.textContent = Math.round(current + increment * step);
    }
  }, stepTime);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Generate a barcode image URL for the given employee ID number.
 * Uses BarcodeAPI.org to generate CODE128 barcodes.
 * 
 * @param {string} idNumber - The employee ID number to encode
 * @param {Object} options - Optional configuration
 * @param {string} options.type - Barcode type: "128" (default), "qr", "39", "auto"
 * @param {number} options.height - Height in pixels for 1D barcodes (default: 40)
 * @returns {string} URL to the barcode image
 */
function getBarcodeUrl(idNumber, options = {}) {
  if (!idNumber) return '';
  
  const type = options.type || '128';  // Default to CODE128
  // BarcodeAPI settings: DPI 500, Height 10, Text None
  const height = options.height || 10;
  const dpi = options.dpi || 500;

  // URL-encode the ID number to handle special characters
  const encodedId = encodeURIComponent(idNumber);
  
  // Base URL
  let url = `https://barcodeapi.org/api/${type}/${encodedId}`;
  
  // Add parameters for 1D barcodes (not QR or DataMatrix)
  // hidetext=1&text=none removes the human-readable text from the barcode image
  if (type !== 'qr' && type !== 'dm') {
    url += `?height=${height}&dpi=${dpi}&hidetext=1&text=none`;
  }
  
  return url;
}

/**
 * Generate the HTML for a barcode image with error handling and fallback.
 * 
 * @param {string} idNumber - The employee ID number to encode
 * @param {Object} options - Barcode options (type, height)
 * @returns {string} HTML string for the barcode image
 */
function generateBarcodeHtml(idNumber, options = {}) {
  if (!idNumber) {
    return ``; // Return nothing if no ID
  }
  
  const barcodeUrl = getBarcodeUrl(idNumber, options);
  
  // Generate HTML - hide on error (no text shown)
  return `
    <img 
      src="${barcodeUrl}" 
      alt="Barcode for ${escapeHtml(idNumber)}" 
      class="barcode-image"
      onerror="this.style.display='none';"
    >
  `;
}

// Format comma-separated campaign values with proper spacing
function formatCampaignValues(campaigns) {
  if (!campaigns || campaigns === '-') return '-';
  // Split by comma, trim whitespace, and rejoin with ", "
  return campaigns.split(',').map(c => c.trim()).filter(c => c).join(', ');
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
