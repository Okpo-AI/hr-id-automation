/**
 * ID Gallery JavaScript
 * Handles gallery display and ID card downloads
 * Shows only IDs generated from the ID Preview on Employee portal
 */

// ============================================
// Name Fit Utility (shared with app.js)
// ============================================
/**
 * Auto-shrink font size so the name element fits within maxLines lines.
 * @param {HTMLElement} el        - The name element to auto-fit
 * @param {number}      maxFontPx - Starting (maximum) font size in px
 * @param {number}      minFontPx - Floor font size in px (never go smaller)
 * @param {number}      maxLines  - Maximum number of lines allowed (default 2)
 * @param {number}      lineHeight- CSS line-height multiplier (default 1.05)
 */
function fitNameToLines(el, maxFontPx, minFontPx, maxLines, lineHeight) {
  if (!el) return;
  maxLines = maxLines || 2;
  lineHeight = lineHeight || parseFloat(window.getComputedStyle(el).lineHeight) / parseFloat(window.getComputedStyle(el).fontSize) || 1.1;
  el.style.fontSize = maxFontPx + 'px';
  var maxHeight = maxFontPx * lineHeight * maxLines + 2;
  var currentSize = maxFontPx;
  var step = 0.5;
  while (el.scrollHeight > maxHeight && currentSize > minFontPx) {
    currentSize -= step;
    el.style.fontSize = currentSize + 'px';
    maxHeight = currentSize * lineHeight * maxLines + 2;
  }
  if (el.scrollHeight > maxHeight) {
    el.style.fontSize = minFontPx + 'px';
  }
}

// ============================================
// State Management
// ============================================
const galleryState = {
  employees: [],
  filteredEmployees: [],
  isLoading: true,
  currentEmployee: null,
  lastFetchTime: null,
  autoDownloadId: null,
  autoDownloadAttempted: false
};

// If navigated from Dashboard "Render ID" or "Preview", auto-trigger preview once data loads.
try {
  const params = new URLSearchParams(window.location.search);
  const previewParam = params.get('preview');
  if (previewParam) {
    const parsed = Number(previewParam);
    if (Number.isFinite(parsed)) {
      galleryState.autoDownloadId = parsed; // Reuse the field for auto-preview
    }
  }
} catch (e) {
  // no-op
}

function maybeAutoDownloadFromQuery() {
  if (galleryState.autoDownloadAttempted) return;
  if (!galleryState.autoDownloadId) return;
  galleryState.autoDownloadAttempted = true;

  const emp = galleryState.employees.find(e => e.id === galleryState.autoDownloadId);
  if (!emp) {
    showToast('Employee not found in gallery yet.', 'error');
    return;
  }

  // Remove the query param so refresh doesn't re-preview
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('preview');
    window.history.replaceState({}, document.title, url.pathname + url.search);
  } catch (e) {
    // no-op
  }

  // Auto-open preview modal instead of downloading
  previewID(emp.id);
}

// ============================================
// PDF Export Configuration - ID Card Dimensions
// ============================================
// Preview Dimensions: 512px × 800px (97% scale display)
// Final PDF: 2.13" width × 3.33" height at 300 DPI
// Aspect Ratio: 2.13:3.33 (locked)
const PDF_CONFIG = {
  // Preview canvas dimensions (pixels)
  PREVIEW_WIDTH_PX: 512,
  PREVIEW_HEIGHT_PX: 800,
  DISPLAY_SCALE: 0.97,  // 97% scale factor
  
  // Final dimensions in inches
  WIDTH_INCHES: 2.13,
  HEIGHT_INCHES: 3.33,  // 3.43" × 0.97 = 3.3271" ≈ 3.33"
  
  // Original design reference
  ORIGINAL_HEIGHT_INCHES: 3.43,
  SCALE_FACTOR: 0.97,
  
  // Print quality DPI
  PRINT_DPI: 300,
  SCREEN_DPI: 96,
  
  // Calculated dimensions in mm (for jsPDF)
  get WIDTH_MM() { return this.WIDTH_INCHES * 25.4; },  // 54.102mm
  get HEIGHT_MM() { return this.HEIGHT_INCHES * 25.4; }, // 84.582mm
  
  // Pixel dimensions at 300 DPI for rendering
  get RENDER_WIDTH_PX() { return Math.round(this.WIDTH_INCHES * this.PRINT_DPI); },  // 639px
  get RENDER_HEIGHT_PX() { return Math.round(this.HEIGHT_INCHES * this.PRINT_DPI); }, // 999px
  
  // html2canvas scale factor - 2x for good quality while keeping file size under 10MB
  // Higher scale = larger file size. Cloudinary free tier has 10MB limit.
  CANVAS_SCALE: 2,
  
  // JPEG quality for PDF images (0.0-1.0)
  // Lower = smaller file, higher = better quality. 0.85 is good balance.
  JPEG_QUALITY: 0.85
};

// Landscape PDF Config for Field Officer templates
// PDF Dimensions: 3.33" width × 2.13" height (landscape orientation)
// Card Preview: 512px × 319px (matches .id-card-field-office)
const PDF_CONFIG_LANDSCAPE = {
  // Landscape dimensions (credit card aspect ratio)
  WIDTH_INCHES: 3.33,
  HEIGHT_INCHES: 2.13,  // Exact 3.33:2.13 ratio as requested
  
  // Preview canvas dimensions for landscape (pixels) - MUST match CSS
  PREVIEW_WIDTH_PX: 512,
  PREVIEW_HEIGHT_PX: 319,
  
  // Print quality DPI
  PRINT_DPI: 300,
  SCREEN_DPI: 96,
  
  // Calculated dimensions in mm (for jsPDF)
  get WIDTH_MM() { return this.WIDTH_INCHES * 25.4; },  // 84.582mm
  get HEIGHT_MM() { return this.HEIGHT_INCHES * 25.4; }, // 54.102mm
  
  // Pixel dimensions at 300 DPI for rendering
  get RENDER_WIDTH_PX() { return Math.round(this.WIDTH_INCHES * this.PRINT_DPI); },  // 999px
  get RENDER_HEIGHT_PX() { return Math.round(this.HEIGHT_INCHES * this.PRINT_DPI); }, // 639px
  
  // html2canvas scale factor - 2x for good quality while keeping file size under 10MB
  CANVAS_SCALE: 2,
  
  // JPEG quality for PDF images (0.0-1.0)
  JPEG_QUALITY: 0.85
};

// Cache settings - MUST match dashboard.js for shared cache
// VERCEL FIX: Use shared cache key with dashboard so both pages see the same data
const GALLERY_CACHE_KEY = 'hrEmployeeDataCache';  // Shared with dashboard.js
const GALLERY_CACHE_DURATION_MS = 300000; // 5 minutes - matches dashboard
const GALLERY_CACHE_MAX_AGE_MS = 3600000; // 1 hour - matches dashboard

// Load cached employee data from sessionStorage
function loadGalleryCachedData() {
  try {
    const cached = sessionStorage.getItem(GALLERY_CACHE_KEY);
    if (cached) {
      const { employees, timestamp } = JSON.parse(cached);
      const age = Date.now() - timestamp;
      
      // Use cache if within normal duration
      if (age < GALLERY_CACHE_DURATION_MS && employees && employees.length > 0) {
        console.log('Gallery: Using cached data, age:', Math.round(age/1000), 'seconds');
        return employees;
      }
      
      // VERCEL FIX: For stale but not expired cache, still return it for immediate display
      if (age < GALLERY_CACHE_MAX_AGE_MS && employees && employees.length > 0) {
        console.log('Gallery: Using stale cached data for immediate display, age:', Math.round(age/1000), 'seconds');
        return employees;
      }
    }
  } catch (e) {
    console.warn('Gallery: Cache read error', e);
  }
  return null;
}

// Save employee data to sessionStorage cache
function saveGalleryCachedData(employees) {
  try {
    sessionStorage.setItem(GALLERY_CACHE_KEY, JSON.stringify({
      employees,
      timestamp: Date.now()
    }));
  } catch (e) {
    console.warn('Gallery: Cache write error', e);
  }
}

// ============================================
// DOM Elements (initialized after DOM loads)
// ============================================
let elements = {};

// ============================================
// Initialization
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  // Initialize elements after DOM is fully loaded
  elements = {
    loadingState: document.getElementById('loadingState'),
    gallerySection: document.getElementById('gallerySection'),
    galleryGrid: document.getElementById('galleryGrid'),
    emptyState: document.getElementById('emptyState'),
    searchInput: document.getElementById('searchInput'),
    positionFilter: document.getElementById('positionFilter'),
    totalRendered: document.getElementById('totalRendered'),
    totalApproved: document.getElementById('totalApproved'),
    totalSentToPOC: document.getElementById('totalSentToPOC'),
    previewModal: document.getElementById('previewModal'),
    modalBody: document.getElementById('modalBody'),
    closeModal: document.getElementById('closeModal'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    approveAllBtn: document.getElementById('approveAllBtn'),
    sendToPOCsBtn: document.getElementById('sendToPOCsBtn'),
    toast: document.getElementById('toast'),
    toastMessage: document.getElementById('toastMessage')
  };
  
  console.log('Gallery DOM elements initialized:', Object.keys(elements).filter(k => elements[k] !== null));
  
  initEventListeners();
  fetchGalleryData();
});

function initEventListeners() {
  // Search and filter - add null checks
  if (elements.searchInput) {
    elements.searchInput.addEventListener('input', debounce(filterGallery, 300));
  }
  if (elements.positionFilter) {
    elements.positionFilter.addEventListener('change', filterGallery);
  }

  // Modal - add null checks
  if (elements.closeModal) {
    elements.closeModal.addEventListener('click', closePreviewModal);
  }
  if (elements.previewModal) {
    elements.previewModal.addEventListener('click', (e) => {
      if (e.target === elements.previewModal) closePreviewModal();
    });
  }

  if (elements.downloadBtn) {
    elements.downloadBtn.addEventListener('click', () => {
      if (galleryState.currentEmployee) {
        downloadIDPdf(galleryState.currentEmployee);
      }
    });
  }

  // Download All button
  if (elements.downloadAllBtn) {
    elements.downloadAllBtn.addEventListener('click', downloadAllPdfs);
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
    if (e.key === 'Escape') closePreviewModal();
  });
}

// ============================================
// Data Fetching
// ============================================
async function fetchGalleryData(forceRefresh = false, retryCount = 0) {
  const MAX_RETRIES = 2;  // VERCEL FIX: Retry on cold start timeouts
  
  console.log('fetchGalleryData: Starting data fetch... (attempt', retryCount + 1, ')');
  console.log('fetchGalleryData: Current URL:', window.location.href);
  
  // VERCEL FIX: Try to use cached data first to prevent data loss on navigation
  if (!forceRefresh) {
    const cachedData = loadGalleryCachedData();
    if (cachedData) {
      // Filter Rendered, Approved and Sent to POC IDs from cache
      galleryState.employees = cachedData.filter(
        emp => emp.status === 'Rendered' || emp.status === 'Approved' || emp.status === 'Sent to POC'
      );
      galleryState.filteredEmployees = [...galleryState.employees];
      galleryState.lastFetchTime = Date.now();
      updateStats();
      renderGallery();
      maybeAutoDownloadFromQuery();
      showLoading(false);
      
      // Show/hide Download All button based on whether there are IDs
      if (elements.downloadAllBtn) {
        elements.downloadAllBtn.style.display = galleryState.employees.length > 0 ? 'flex' : 'none';
      }
      
      // Still fetch fresh data in background to keep cache updated
      fetchGalleryDataBackground();
      return;
    }
  }
  
  showLoading(true);

  // VERCEL FIX: Longer timeout for cold starts, shorter for retries
  const timeoutMs = retryCount === 0 ? 20000 : 15000;  // 20s first attempt, 15s retries
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.log('fetchGalleryData: Request timeout - aborting');
    controller.abort();
  }, timeoutMs);

  try {
    // VERCEL FIX: Include credentials to ensure JWT cookie is sent with request
    // Without this, serverless functions may not receive the authentication cookie
    const apiUrl = '/hr/api/employees';
    console.log('fetchGalleryData: Fetching from', apiUrl);
    
    const response = await fetch(apiUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    console.log('fetchGalleryData: Response status:', response.status);
    console.log('fetchGalleryData: Response headers:', Object.fromEntries(response.headers.entries()));
    
    // Handle unauthorized - redirect to login
    if (response.status === 401) {
      console.log('fetchGalleryData: Unauthorized, redirecting to login');
      window.location.href = '/hr/login';
      return;
    }
    
    // Handle other error status codes
    if (!response.ok) {
      const errorText = await response.text();
      console.error('fetchGalleryData: HTTP error', response.status, errorText);
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const data = await response.json();
    console.log('fetchGalleryData: Response data:', data);
    console.log('fetchGalleryData: Success:', data.success);
    console.log('fetchGalleryData: Employee array length:', data.employees?.length);

    if (data.success) {
      // Filter Rendered, Approved and Sent to POC IDs
      const allEmployees = data.employees || [];
      console.log('fetchGalleryData: Total employees:', allEmployees.length);
      
      // VERCEL FIX: Cache all employees data
      saveGalleryCachedData(allEmployees);
      galleryState.lastFetchTime = Date.now();
      
      galleryState.employees = allEmployees.filter(
        emp => emp.status === 'Rendered' || emp.status === 'Approved' || emp.status === 'Sent to POC'
      );
      console.log('fetchGalleryData: Filtered employees (Rendered/Approved/Sent to POC):', galleryState.employees.length);
      
      galleryState.filteredEmployees = [...galleryState.employees];
      updateStats();
      renderGallery();
      maybeAutoDownloadFromQuery();
      
      // Show/hide Download All button based on whether there are IDs
      if (elements.downloadAllBtn) {
        elements.downloadAllBtn.style.display = galleryState.employees.length > 0 ? 'flex' : 'none';
      }
    } else {
      console.error('fetchGalleryData: API returned error:', data.error);
      throw new Error(data.error || 'Failed to fetch data');
    }
  } catch (error) {
    clearTimeout(timeoutId);
    console.error('fetchGalleryData: Error occurred:', error);
    
    // VERCEL FIX: Retry on timeout (cold start recovery)
    if (error.name === 'AbortError' && retryCount < MAX_RETRIES) {
      console.log('fetchGalleryData: Timeout, retrying... (attempt', retryCount + 2, ')');
      showToast('Loading... please wait (server warming up)', 'info');
      // Small delay before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchGalleryData(forceRefresh, retryCount + 1);
    }
    
    // VERCEL FIX: Handle abort/timeout gracefully
    if (error.name === 'AbortError') {
      showToast('Request timed out. Please refresh the page.', 'error');
    } else {
      showToast('Failed to load gallery data: ' + error.message, 'error');
    }
    
    // VERCEL FIX: Try to use cached data on error instead of showing empty state
    const cachedData = loadGalleryCachedData();
    if (cachedData && cachedData.length > 0) {
      console.log('Gallery: Using cached data after fetch error');
      galleryState.employees = cachedData.filter(
        emp => emp.status === 'Rendered' || emp.status === 'Approved' || emp.status === 'Sent to POC'
      );
      galleryState.filteredEmployees = [...galleryState.employees];
      updateStats();
      renderGallery();
      showToast('Showing cached data. Pull to refresh.', 'warning');
    } else {
      // Only set empty state if no cache available
      galleryState.employees = [];
      galleryState.filteredEmployees = [];
      updateStats();
      renderGallery();
    }
  } finally {
    console.log('fetchGalleryData: Hiding loading state');
    // VERCEL FIX: Always hide loading state, even on error
    showLoading(false);
  }
}

// Background fetch to update cache without blocking UI
async function fetchGalleryDataBackground() {
  try {
    const response = await fetch('/hr/api/employees', {
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Cache-Control': 'no-cache'
      }
    });
    
    if (response.status === 401) return;
    if (!response.ok) return;
    
    const data = await response.json();
    if (data.success && data.employees) {
      const allEmployees = data.employees;
      const filteredNew = allEmployees.filter(
        emp => emp.status === 'Rendered' || emp.status === 'Approved' || emp.status === 'Sent to POC'
      );
      
      // Only update if data changed
      if (JSON.stringify(filteredNew) !== JSON.stringify(galleryState.employees)) {
        console.log('Gallery: Background fetch found updated data');
        saveGalleryCachedData(allEmployees);
        galleryState.employees = filteredNew;
        galleryState.filteredEmployees = [...filteredNew];
        galleryState.lastFetchTime = Date.now();
        updateStats();
        renderGallery();
        
        if (elements.downloadAllBtn) {
          elements.downloadAllBtn.style.display = filteredNew.length > 0 ? 'flex' : 'none';
        }
      }
    }
  } catch (e) {
    console.log('Gallery: Background fetch error (non-blocking)', e);
  }
}

// ============================================
// UI Updates
// ============================================
function showLoading(show) {
  console.log('showLoading:', show);
  galleryState.isLoading = show;
  
  // VERCEL FIX: Use try-catch to prevent any DOM errors from blocking UI updates
  try {
    if (elements.loadingState) {
      elements.loadingState.style.display = show ? 'flex' : 'none';
      console.log('showLoading: loadingState display =', elements.loadingState.style.display);
    } else {
      console.warn('showLoading: loadingState element not found');
    }
    
    if (elements.gallerySection) {
      elements.gallerySection.style.display = show ? 'none' : 'block';
      console.log('showLoading: gallerySection display =', elements.gallerySection.style.display);
    } else {
      console.warn('showLoading: gallerySection element not found');
    }
  } catch (e) {
    console.error('showLoading: Error updating UI', e);
  }
}

function updateStats() {
  const rendered = galleryState.employees.filter(e => e.status === 'Rendered').length;
  const approved = galleryState.employees.filter(e => e.status === 'Approved').length;
  const sentToPOC = galleryState.employees.filter(e => e.status === 'Sent to POC' || e.status === 'Completed').length;
  
  // Update each counter separately
  if (elements.totalRendered) {
    elements.totalRendered.textContent = rendered;
  }
  if (elements.totalApproved) {
    elements.totalApproved.textContent = approved;
  }
  if (elements.totalSentToPOC) {
    elements.totalSentToPOC.textContent = sentToPOC;
  }
}

function renderGallery() {
  console.log('renderGallery: Starting render...');
  const employees = galleryState.filteredEmployees;
  console.log('renderGallery: Employee count:', employees.length);

  if (employees.length === 0) {
    console.log('renderGallery: No employees, showing empty state');
    if (elements.galleryGrid) elements.galleryGrid.innerHTML = '';
    if (elements.emptyState) {
      elements.emptyState.style.display = 'flex';
      console.log('renderGallery: emptyState display = flex');
    }
    return;
  }

  if (elements.emptyState) {
    elements.emptyState.style.display = 'none';
    console.log('renderGallery: emptyState display = none');
  }

  const cards = employees.map(emp => {
    const statusClass = emp.status.toLowerCase().replace(/\s+/g, '-');
    const isFieldOfficer = emp.position === 'Field Officer';
    
    // Determine button based on status
    // Rendered -> Approve button
    // Approved -> Send to POC button
    // Sent to POC / Completed -> Completed (disabled)
    const isRendered = emp.status === 'Rendered';
    const isApproved = emp.status === 'Approved';
    const isSentOrCompleted = emp.status === 'Sent to POC' || emp.status === 'Completed';
    
    // Dual template badge for ALL Field Officers
    const dualBadge = isFieldOfficer 
      ? '<span class="dual-template-badge" title="This employee has 2 ID templates (Portrait + Landscape)">2 Templates</span>' 
      : '';
    
    // Determine wrapper class for proper scaling
    // Show portrait template in gallery grid for all Field Officers
    const wrapperClass = 'id-card-image-wrapper';
    
    // Generate action button based on status
    let actionButton = '';
    if (isRendered) {
      actionButton = `
        <button class="btn-approve" onclick="window.approveAndSaveID(${emp.id})">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M13.5 4.5L6 12L2.5 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Approve
        </button>`;
    } else if (isApproved) {
      actionButton = `
        <button class="btn-send-poc" onclick="window.sendToPOC(${emp.id})">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M1 4l7 4 7-4M1 4v8h14V4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Send to POC
        </button>`;
    } else if (isSentOrCompleted) {
      actionButton = `
        <button class="btn-completed" disabled>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
            <path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Completed
        </button>`;
    }

    return `
      <div class="id-gallery-card${isFieldOfficer ? ' field-officer-card' : ''}" data-id="${emp.id}">
        <div class="${wrapperClass}" onclick="window.previewID(${emp.id})">
          ${generateIDCardHtml(emp)}
        </div>
        <div class="id-gallery-card-footer">
          <div class="id-card-info-row">
            <span class="id-card-emp-name">${escapeHtml(emp.employee_name)}</span>
            <div class="id-card-badges">
              ${dualBadge}
              <span class="status-badge ${statusClass}">${emp.status}</span>
            </div>
          </div>
          <div class="id-card-meta">
            <span>${escapeHtml(emp.id_number)}</span>
            <span>•</span>
            <span>${escapeHtml(emp.location_branch || '-')}</span>
          </div>
          <div class="id-card-actions">
            <button class="btn-preview" onclick="window.previewID(${emp.id})">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 3C4.5 3 1.7 5.5 1 8c.7 2.5 3.5 5 7 5s6.3-2.5 7-5c-.7-2.5-3.5-5-7-5z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                <circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.5"/>
              </svg>
              Preview
            </button>
            ${actionButton}
          </div>
        </div>
      </div>
    `;
  }).join('');

  if (elements.galleryGrid) {
    elements.galleryGrid.innerHTML = cards;
    // Auto-fit name text to 2 lines on all rendered cards
    // Defer until fonts are loaded and layout is computed (same as modal preview)
    const fitAllNames = () => {
      requestAnimationFrame(() => {
        elements.galleryGrid.querySelectorAll('.id-fullname').forEach(el => {
          fitNameToLines(el, 38.4, 19.2, 2, 1.05);
        });
      });
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitAllNames);
    } else {
      setTimeout(fitAllNames, 150);
    }
  }
}

// Generate the ID card HTML for display - matches the exact design from form.html id-preview-section
// Now supports different templates based on position and field_officer_type
// Template selection source-of-truth:
// - Freelancer, Intern, Others: Portrait template (512x800)
// - Field Officer (Others): Landscape Field Office template (512x319)
// - Field Officer (Repossessor/Shared): DUAL templates (Portrait + Landscape) - shown in grid as portrait
function generateIDCardHtml(emp) {
  // Check if this is a Field Officer - Repossessor/Shared (needs dual templates)
  const isFieldOfficer = emp.position === 'Field Officer';
  const isRepossessorOrShared = isFieldOfficer && (emp.field_officer_type === 'Repossessor' || emp.field_officer_type === 'Reprocessor' || emp.field_officer_type === 'Shared');
  
  // For Repossessor/Shared: In gallery grid, show portrait template (original) as primary card
  // The dual preview is shown in modal and PDF will include both
  if (isRepossessorOrShared) {
    return generateRegularIDCardHtml(emp);
  }
  
  // For Field Officers (Others only), use the Field Office template (landscape)
  if (isFieldOfficer) {
    return generateFieldOfficeIDCardHtml(emp);
  }
  
  // For non-Field Officers, use the regular template
  return generateRegularIDCardHtml(emp);
}

/**
 * Generate OKPo URL slug from employee object name parts.
 * Format: full first word of first name + first letter of each subsequent word in first name
 *         + first letter of last name + middle initial letter (all lowercase, no spaces).
 * Example: first_name="Jan Joshua Kendrick", last_name="Dela Paz", middle_initial="A"
 *          → "janjkda"
 * @param {Object} emp - Employee object with first_name, last_name, middle_initial
 * @returns {string} Lowercase slug for OKPo URL
 */
function generateOkpoSlugGallery(emp) {
  let slug = '';
  const firstName = emp.first_name || emp.employee_name?.split(' ')[0] || '';
  if (firstName) {
    const parts = firstName.trim().toLowerCase().split(/\s+/);
    slug += parts[0] || '';
    for (let i = 1; i < parts.length; i++) {
      if (parts[i]) slug += parts[i].charAt(0);
    }
  }
  if (emp.last_name) {
    slug += emp.last_name.trim().charAt(0).toLowerCase();
  }
  if (emp.middle_initial) {
    const mi = emp.middle_initial.replace('.', '').trim();
    if (mi) slug += mi.charAt(0).toLowerCase();
  }
  return slug;
}

// Build full name from separate fields: FirstName + MiddleInitial + LastName + Suffix
// If middle_initial exists, format as single uppercase letter with period
// Falls back to employee_name if separate fields are not available
function buildFullName(emp) {
  // Check if we have the separate name fields
  if (emp.first_name || emp.last_name) {
    let fullName = '';
    if (emp.first_name) fullName += emp.first_name;
    if (emp.middle_initial) {
      // Ensure middle initial is just one uppercase letter with period
      const mi = emp.middle_initial.trim().replace('.', '').charAt(0).toUpperCase();
      if (mi) fullName += ' ' + mi + '.';
    }
    if (emp.last_name) fullName += ' ' + emp.last_name;
    if (emp.suffix) fullName += ' ' + emp.suffix;
    return fullName.trim();
  }
  // Fallback to employee_name
  return emp.employee_name;
}

// Build full name with HTML line break for long names on ID cards:
// Format: "FirstName SecondName M.I.<br>LastName Suffix"
function buildFullNameHtml(emp) {
  if (emp.first_name || emp.last_name) {
    let line1 = '';
    let line2 = '';
    if (emp.first_name) line1 += emp.first_name;
    if (emp.middle_initial) {
      const mi = emp.middle_initial.trim().replace('.', '').charAt(0).toUpperCase();
      if (mi) line1 += ' ' + mi + '.';
    }
    if (emp.last_name) line2 = emp.last_name;
    if (emp.suffix) line2 += (line2 ? ' ' : '') + emp.suffix;
    if (line1 && line2) return line1 + '<br>' + line2;
    return (line1 || line2).trim();
  }
  return escapeHtml(emp.employee_name);
}

/**
 * Apply Cloudinary e_trim transformation to a signature URL.
 * This auto-crops whitespace/transparency around the signature strokes,
 * so small signatures are effectively "zoomed in" and large ones are properly bounded.
 * The result is a tightly-cropped signature image that fills the container better.
 * 
 * @param {string} signatureUrl - Cloudinary URL of the signature image
 * @returns {string} Transformed URL with trim applied
 */
function applySignatureTrim(signatureUrl) {
  if (!signatureUrl) return '';
  // Apply e_trim to remove surrounding whitespace/transparency
  // Then c_fit to scale to container dimensions (2x for sharpness)
  // This ensures small signatures are enlarged and large ones are contained
  if (signatureUrl.includes('/upload/')) {
    return signatureUrl.replace('/upload/', '/upload/e_trim/c_fit,w_300,h_130/');
  }
  return signatureUrl;
}

/**
 * Dynamic signature scaling - called onload for signature images.
 * Adjusts the image transform if the natural dimensions indicate
 * the signature needs scaling up or down relative to the container.
 * 
 * @param {HTMLImageElement} img - The loaded signature image element
 */
function dynamicSignatureScale(img) {
  if (!img || !img.naturalWidth || !img.naturalHeight) return;
  
  const container = img.closest('.id-signature-area') || img.closest('.id-fo-signature-container');
  if (!container) return;
  
  const containerW = container.offsetWidth || 150;
  const containerH = container.offsetHeight || 65;
  
  const natW = img.naturalWidth;
  const natH = img.naturalHeight;
  
  // Calculate the scale ratio - how much of the container the signature fills
  const scaleX = containerW / natW;
  const scaleY = containerH / natH;
  const fitScale = Math.min(scaleX, scaleY);
  
  // If the signature is very small (fills less than 40% of container), scale it up
  if (fitScale > 2.5) {
    // Very small signature - scale to fill ~80% of container
    const targetScale = fitScale * 0.8;
    img.style.transform = `scale(${Math.min(targetScale, 3.0)})`;
    img.style.transformOrigin = 'center center';
  }
  // If the signature is too large (would overflow), ensure contain behavior
  // This is already handled by object-fit: contain, no extra action needed
}

// Make dynamicSignatureScale available globally for onload handlers
window.dynamicSignatureScale = dynamicSignatureScale;

/**
 * Determine CSS size class for id-fullname based on total name length.
 * Longer names get smaller font sizes to prevent pushing barcode/ID off the card.
 */
function getFullNameSizeClass(emp) {
  const fullName = buildFullName(emp);
  const len = fullName.length;
  if (len > 35) return 'id-fullname-xs';   // Very long names: ~1.2rem
  if (len > 25) return 'id-fullname-sm';   // Long names: ~1.6rem
  if (len > 18) return 'id-fullname-md';   // Medium names: ~2.0rem
  return '';  // Default 2.4rem for short names
}

// Ensure render pipeline uses a no-background image.
// Tries cached nobg first, then forces backend background removal.
async function ensureNoBackgroundPhoto(emp) {
  if (emp.nobg_photo_url) return true;
  if (!emp.new_photo_url) return false;

  try {
    const resp = await fetch(`/hr/api/employees/${emp.id}/remove-background?force=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    const data = await resp.json();

    if (resp.ok && data.success && data.nobg_photo_url && data.nobg_photo_url !== emp.new_photo_url) {
      emp.nobg_photo_url = data.nobg_photo_url;
      return true;
    }

    return false;
  } catch (e) {
    console.error('ensureNoBackgroundPhoto failed:', e);
    return false;
  }
}

// Generate Regular ID Card HTML (for Freelancer, Intern, Others)
// Image source rule: Uses AI-generated photo (nobg_photo_url preferred)
// For Repossessor Portrait Template: Uses AI photo
// Expiration rule: Only show for Freelancer and Intern positions
function generateRegularIDCardHtml(emp) {
  // Use AI-generated photo (nobg_photo_url or new_photo_url) for portrait template
  const idPhotoUrl = emp.nobg_photo_url || emp.new_photo_url || emp.photo_url;
  const photoHasImage = idPhotoUrl ? 'has-image' : '';
  const photoHtml = idPhotoUrl 
    ? `<img src="${idPhotoUrl}" alt="${escapeHtml(emp.employee_name)}" crossorigin="anonymous">`
    : `<span class="id-photo-placeholder">AI Image</span>`;

  const signatureHasImage = emp.signature_url ? 'has-image' : '';
  // Apply Cloudinary e_trim transformation to auto-crop whitespace from signature
  // This dynamically scales small signatures up (by removing surrounding blank space)
  // and keeps large signatures properly contained within the ID card area
  const trimmedSignatureUrl = emp.signature_url 
    ? applySignatureTrim(emp.signature_url)
    : '';
  const signatureHtml = trimmedSignatureUrl 
    ? `<img src="${trimmedSignatureUrl}" alt="Signature" crossorigin="anonymous" onload="dynamicSignatureScale(this)">`
    : `<span class="id-signature-placeholder">Signature</span>`;

  // Calculate expiration date (1 year from now) - only for Freelancer/Intern
  const showExpiration = emp.position === 'Freelancer' || emp.position === 'Intern';
  let expirationHtml = '';
  if (showExpiration) {
    const expDate = new Date();
    expDate.setFullYear(expDate.getFullYear() + 1);
    const expDateStr = expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    expirationHtml = `
        <!-- Expiration Date -->
        <div class="id-expiration">
          <span class="id-exp-label">Expiration Date:</span>
          <span class="id-exp-date">${expDateStr}</span>
        </div>`;
  }

  // Get nickname or use first name - always capitalize (first letter uppercase, rest lowercase)
  const rawNickname = emp.id_nickname || (emp.first_name || emp.employee_name.split(' ')[0]);
  const nickname = rawNickname ? rawNickname.charAt(0).toUpperCase() + rawNickname.slice(1).toLowerCase() : '';
  
  // Generate dynamic back-side URL using OKPo slug format:
  // Full first word of first name + first letter of each subsequent word
  // + first letter of last name + middle initial (all lowercase, no spaces)
  // Example: Jan Joshua Kendrick, Dela Paz, A → www.okpo.com/spm/janjkda
  const backDynamicUrl = `www.okpo.com/spm/${generateOkpoSlugGallery(emp)}`;
  const frontStaticUrl = 'www.spmadrid.com';

  return `
    <div class="id-card gallery-id-card">
      <!-- Photo Section with Blue Sidebar -->
      <div class="id-card-top">
        <!-- Blue vertical sidebar -->
        <div class="id-sidebar">
          <span class="id-nickname-vertical">${escapeHtml(nickname)}</span>
        </div>

        <!-- Photo area -->
        <div class="id-photo-section">
          <!-- Header with Logo -->
          <div class="id-header">
            <img src="/static/images/SPM%20Logo%201.png" alt="SPM Logo" class="id-logo-image" crossorigin="anonymous">
          </div>
          
          <!-- Photo placeholder with geometric background -->
          <div class="id-photo-container ${photoHasImage}">
            ${photoHtml}
            <!-- Signature overlay at lower-right of photo -->
            <div class="id-signature-area ${signatureHasImage}">
              ${signatureHtml}
            </div>
          </div>
        </div>
      </div>

      <!-- Bottom Info Section -->
      <div class="id-card-bottom">
        <div class="id-info-container">
          <!-- Left side - Name, Title, Barcode -->
          <div class="id-info-left">
            <h1 class="id-fullname ${getFullNameSizeClass(emp)}">${buildFullNameHtml(emp)}</h1>
            
            ${emp.position !== 'Others' ? `<div class="id-position-dept">
              <span>${emp.position === 'Field Officer' ? 'Legal Officer' : escapeHtml(emp.position)}</span>
            </div>` : ''}

            <!-- Barcode area -->
            <div class="id-barcode-area">
              <div class="id-barcode-container">
                ${generateBarcodeHtml(emp.id_number, 'id-barcode-image', { width: 500, height: 55 })}
              </div>
              <p class="id-number-text">${escapeHtml(emp.id_number)}</p>
            </div>
          </div>
        </div>

        <!-- Website icon and URL -->
        <div class="id-website-strip">
          <p class="id-website-url">${escapeHtml(frontStaticUrl)}</p>
          <svg class="id-globe-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
        </div>

        ${expirationHtml}
      </div>
    </div>
  `;
}

// Generate Field Office ID Card HTML (for Field Officers)
// Image source rule: Prefer no-background image for rendering consistency.
function generateFieldOfficeIDCardHtml(emp) {
  const idPhotoUrl = emp.nobg_photo_url || emp.chroma_photo_url || emp.new_photo_url || emp.photo_url;
  const photoHasImage = idPhotoUrl ? 'has-image' : '';
  const photoHtml = idPhotoUrl 
    ? `<img src="${idPhotoUrl}" alt="${escapeHtml(emp.employee_name)}" crossorigin="anonymous" style="background:#ffffff;">`
    : `<span class="id-fo-photo-placeholder">Photo</span>`;

  // Apply Cloudinary e_trim transformation to signature for dynamic sizing
  const trimmedFoSignatureUrl = emp.signature_url
    ? applySignatureTrim(emp.signature_url)
    : '';
  const signatureHtml = trimmedFoSignatureUrl 
    ? `<img src="${trimmedFoSignatureUrl}" alt="Signature" crossorigin="anonymous" onload="dynamicSignatureScale(this)">`
    : `<span class="id-fo-signature-placeholder"></span>`;

  // Parse name for multi-line display
  // Use buildFullNameHtml for consistent name formatting across all cards
  const displayName = buildFullNameHtml(emp);
  
  // Position display - ALWAYS show "LEGAL OFFICER" regardless of field_officer_type
  // The placeholder label should never change to "REPOSSESSOR"
  const positionDisplay = 'LEGAL OFFICER';
  
  // Field clearance (default to Level 5)
  const clearanceLevel = emp.field_clearance || 'Level 5';

  return `
    <div class="id-card-field-office gallery-id-card-field-office">
      <div class="id-field-office-content">
        <!-- Photo Section with border -->
        <div class="id-fo-photo-section">
          <div class="id-fo-photo-container ${photoHasImage}" style="background:#ffffff;">
            ${photoHtml}
          </div>
        </div>

        <!-- Signature Section -->
        <div class="id-fo-signature-section">
          <div class="id-fo-signature-container ${emp.signature_url ? 'has-image' : ''}">
            ${signatureHtml}
          </div>
        </div>

        <!-- Employee Name -->
        <div class="id-fo-name-section">
          <h1 class="id-fo-name">${displayName}</h1>
        </div>

        <!-- Position -->
        <div class="id-fo-position-section">
          <span class="id-fo-position">${escapeHtml(positionDisplay)}</span>
        </div>

        <!-- Field Clearance Level -->
        <div class="id-fo-clearance-section">
          <span class="id-fo-clearance-label">FIELD CLEARANCE:</span>
          <span class="id-fo-clearance-level">${escapeHtml(clearanceLevel)}</span>
        </div>

        <!-- Barcode - Above ID Number -->
        <!-- Container is 180x40, so with width=500 we need height≈111 to fill the container -->
        <div class="id-fo-barcode-section">
          <div class="id-fo-barcode-container">
            ${generateBarcodeHtml(emp.id_number, 'id-fo-barcode-image', { width: 500, height: 111 })}
          </div>
        </div>

        <!-- ID Number - Below Barcode -->
        <div class="id-fo-idnumber-section">
          <span class="id-fo-idnumber">${escapeHtml(emp.id_number)}</span>
        </div>
      </div>
    </div>
  `;
}

// Generate Field Office ID Card Back HTML
function generateFieldOfficeIDCardBackHtml(emp) {
  return `
    <div class="id-card-field-office-back gallery-id-card-field-office-back">
      <!-- Back side uses 4.png as background - no editable content -->
    </div>
  `;
}

// Generate ID Card Backside HTML
function generateIDCardBackHtml(emp) {
  // Get username from nickname or first name
  const nickname = emp.id_nickname || (emp.first_name || emp.employee_name.split(' ')[0]);
  const username = nickname.toLowerCase().replace(/\s+/g, '');
  
  // Generate dynamic URL using OKPo slug format:
  // Full first word of first name + first letter of each subsequent word
  // + first letter of last name + middle initial (all lowercase, no spaces)
  // Example: Jan Joshua Kendrick, Dela Paz, A → www.okpo.com/spm/janjkda
  const dynamicUrl = `www.okpo.com/spm/${generateOkpoSlugGallery(emp)}`;
  const fullWebUrl = `https://${dynamicUrl}`;
  const contactLabel = `${emp.first_name || emp.employee_name.split(' ')[0] || ''}'s Contact`;
  
  // Emergency contact details
  const emergencyName = emp.emergency_name || 'Not provided';
  const emergencyContact = emp.emergency_contact || 'Not provided';
  const emergencyAddress = emp.emergency_address || 'Not provided';
  
  // Generate vCard for contact QR code
  const vCardData = generateVCard(emp);

  return `
    <div class="id-card id-card-back gallery-id-card-back">
      <!-- Overlay Pattern -->
      <div class="id-back-overlay"></div>
      
      <!-- Header Section - Logo and Address -->
      <div class="id-back-header">
        <div class="id-back-header-content">
          <div class="id-back-logo-row">
            <img src="/static/images/Logo.png" alt="SPM Logo" class="id-back-spm-logo" crossorigin="anonymous">
          </div>
          <div class="id-back-address">
            17th Floor Chatham House Valero, Cor V.A. Rufino<br>
            St. Lgry, Makati City Metro Manila
          </div>
        </div>
      </div>

      <!-- QR Code Section - vCard Contact QR -->
      <div class="id-back-qr-section">
        <div class="id-back-qr-code">
          ${generateQRCodeHtml(vCardData, 'id-back-qr-image', { size: 120, ecLevel: 'M' })}
        </div>
        <div class="id-back-vcard-row">
          <div class="id-back-vcard-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
              <circle cx="12" cy="7" r="4"></circle>
            </svg>
          </div>
          <span class="id-back-vcard-label">${escapeHtml(contactLabel)}</span>
        </div>
      </div>

      <!-- Emergency Contact Card -->
      <div class="id-back-emergency-card">
        <div class="id-back-emergency-title">In case of emergency:</div>
        <div class="id-back-emergency-list">
          <!-- Person Name -->
          <div class="id-back-emergency-row">
            <div class="id-back-emergency-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
              </svg>
            </div>
            <span class="id-back-emergency-value">${escapeHtml(emergencyName)}</span>
          </div>
          <!-- Phone -->
          <div class="id-back-emergency-row">
            <div class="id-back-emergency-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
              </svg>
            </div>
            <span class="id-back-emergency-value">${escapeHtml(emergencyContact)}</span>
          </div>
          <!-- Address -->
          <div class="id-back-emergency-row address-row">
            <div class="id-back-emergency-icon address-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
            </div>
            <span class="id-back-emergency-value">${escapeHtml(emergencyAddress)}</span>
          </div>
        </div>
      </div>

      <!-- Bottom QR and Website - Website URL QR with OKPO logo overlay -->
      <div class="id-back-bottom">
        <div class="id-back-bottom-qr">
          ${generateQRCodeHtml(fullWebUrl, 'id-back-bottom-qr-image', { 
            size: 200, 
            ecLevel: 'H', 
            centerImageUrl: 'https://239dc453931a663c0cfa3bb867f1aaae.cdn.bubble.io/cdn-cgi/image/w=,h=,f=auto,dpr=1,fit=contain/f1727917655428x617042099316169600/okpologo.jpg',
            centerImageSizeRatio: 0.25
          })}
        </div>
        <div class="id-back-website-row">
          <div class="id-back-website-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="2" y1="12" x2="22" y2="12"></line>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
            </svg>
          </div>
          <span class="id-back-website-url">${escapeHtml(dynamicUrl)}</span>
        </div>
      </div>
    </div>
  `;
}

// Generate appropriate back HTML based on employee type
function getBackHtml(emp) {
  const isFieldOfficer = emp.position === 'Field Officer';
  if (isFieldOfficer) {
    return generateFieldOfficeIDCardBackHtml(emp);
  }
  return generateIDCardBackHtml(emp);
}

// Generate single template preview HTML (for Others/non-Field Officers)
function generateSingleTemplatePreviewHtml(emp, isFieldOfficer) {
  return `
    <!-- Flip Toggle Buttons -->
    <div class="id-flip-toggle">
      <button type="button" class="flip-btn active" data-side="front" onclick="showPreviewSide('front')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <circle cx="9" cy="10" r="2"/>
          <path d="M15 8h2M15 12h2M7 16h10"/>
        </svg>
        Front
      </button>
      <button type="button" class="flip-btn" data-side="back" onclick="showPreviewSide('back')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <path d="M7 7h10v10H7z"/>
          <path d="M12 11v4M12 7v1"/>
        </svg>
        Back
      </button>
    </div>
    
    <div class="id-preview-wrapper">
      <div id="previewFront">
        ${generateIDCardHtml(emp)}
      </div>
      <div id="previewBack" style="display: none;">
        ${getBackHtml(emp)}
      </div>
    </div>
  `;
}

// Generate dual template preview HTML (for Repossessor - shows both SPMC and Field Office templates)
function generateDualTemplatePreviewHtml(emp) {
  return `
    <div class="dual-template-grid gallery-dual-template-grid">
      <!-- SPMC Template (Portrait) -->
      <div class="dual-template-card">
        <h3 class="dual-template-title">SPMC ID Card</h3>
        <div class="id-flip-toggle dual-flip-toggle">
          <button type="button" class="flip-btn active" data-side="front" data-template="original" onclick="showDualPreviewSide('original', 'front')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="9" cy="10" r="2"/>
              <path d="M15 8h2M15 12h2M7 16h10"/>
            </svg>
            Front
          </button>
          <button type="button" class="flip-btn" data-side="back" data-template="original" onclick="showDualPreviewSide('original', 'back')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M7 7h10v10H7z"/>
              <path d="M12 11v4M12 7v1"/>
            </svg>
            Back
          </button>
        </div>
        <div class="id-preview-wrapper dual-preview-wrapper">
          <div id="dualOriginalFront">
            ${generateRegularIDCardHtml(emp)}
          </div>
          <div id="dualOriginalBack" style="display: none;">
            ${generateIDCardBackHtml(emp)}
          </div>
        </div>
      </div>
      
      <!-- Field Office Template (Landscape) -->
      <div class="dual-template-card">
        <h3 class="dual-template-title">Field Office ID Card</h3>
        <div class="id-flip-toggle dual-flip-toggle">
          <button type="button" class="flip-btn active" data-side="front" data-template="repossessor" onclick="showDualPreviewSide('repossessor', 'front')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="9" cy="10" r="2"/>
              <path d="M15 8h2M15 12h2M7 16h10"/>
            </svg>
            Front
          </button>
          <button type="button" class="flip-btn" data-side="back" data-template="repossessor" onclick="showDualPreviewSide('repossessor', 'back')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <path d="M7 7h10v10H7z"/>
              <path d="M12 11v4M12 7v1"/>
            </svg>
            Back
          </button>
        </div>
        <div class="id-preview-wrapper dual-preview-wrapper">
          <div id="dualRepossessorFront">
            ${generateFieldOfficeIDCardHtml(emp)}
          </div>
          <div id="dualRepossessorBack" style="display: none;">
            ${generateFieldOfficeIDCardBackHtml(emp)}
          </div>
        </div>
      </div>
    </div>
  `;
}

// Generate employee information HTML for preview modal
// Shows all employee data including Field Officer fields for HR visibility
function generateEmployeeInfoHtml(emp) {
  // Determine if employee is Field Officer (for conditional display text)
  const isFieldOfficer = emp.position === 'Field Officer';
  
  // Build the FO-specific fields section - show for ALL employees to allow HR to see source-of-truth data
  // Display hyphen (-) when values are empty or not applicable
  const foFieldsHtml = `
        <div class="preview-info-item">
          <span class="label">Field Clearance</span>
          <span class="value">${escapeHtml('Level 5')}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Division</span>
          <span class="value">${escapeHtml(emp.fo_division || '-')}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Department</span>
          <span class="value">${escapeHtml(emp.fo_department || '-')}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Campaign</span>
          <span class="value">${escapeHtml(formatCampaignValues(emp.fo_campaign))}</span>
        </div>
        ${isFieldOfficer ? `
        <div class="preview-info-item">
          <span class="label">FO Type</span>
          <span class="value">${escapeHtml(emp.field_officer_type || '-')}</span>
        </div>` : ''}
  `;
  
  return `
    <div class="id-preview-details">
      <h3>Employee Information</h3>
      <div class="preview-info-grid">
        <div class="preview-info-item">
          <span class="label">Full Name</span>
          <span class="value">${escapeHtml(emp.employee_name)}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">ID Number</span>
          <span class="value">${escapeHtml(emp.id_number)}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Position</span>
          <span class="value">${escapeHtml(emp.position)}${emp.field_officer_type ? ' - ' + escapeHtml(emp.field_officer_type) : ''}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Branch/Location</span>
          <span class="value">${escapeHtml(emp.location_branch || '-')}</span>
        </div>
        ${foFieldsHtml}
        <div class="preview-info-item">
          <span class="label">Email</span>
          <span class="value">${escapeHtml(emp.email)}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Phone</span>
          <span class="value">${escapeHtml(emp.personal_number)}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Emergency Contact</span>
          <span class="value">${escapeHtml(emp.emergency_name || 'Not provided')}</span>
        </div>
        <div class="preview-info-item">
          <span class="label">Status</span>
          <span class="value"><span class="status-badge ${emp.status.toLowerCase()}">${emp.status}</span></span>
        </div>
      </div>
    </div>
  `;
}

// Show/hide sides in dual template preview mode (for gallery modal)
function showDualPreviewSide(template, side) {
  const templatePrefix = template === 'original' ? 'dualOriginal' : 'dualRepossessor';
  const frontCard = document.getElementById(`${templatePrefix}Front`);
  const backCard = document.getElementById(`${templatePrefix}Back`);
  
  // Update button states for this template only
  const templateCards = document.querySelectorAll('.dual-template-card');
  const templateCard = template === 'original' ? templateCards[0] : templateCards[1];
  
  if (templateCard) {
    const flipBtns = templateCard.querySelectorAll('.flip-btn');
    flipBtns.forEach(btn => {
      if (btn.dataset.side === side) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }
  
  // Show/hide cards
  if (side === 'front') {
    if (frontCard) frontCard.style.display = 'block';
    if (backCard) backCard.style.display = 'none';
  } else {
    if (frontCard) frontCard.style.display = 'none';
    if (backCard) backCard.style.display = 'block';
  }
}

// Make showDualPreviewSide available globally
window.showDualPreviewSide = showDualPreviewSide;

// ============================================
// Filtering
// ============================================
function filterGallery() {
  const searchTerm = elements.searchInput ? elements.searchInput.value.toLowerCase().trim() : '';
  const positionFilter = elements.positionFilter ? elements.positionFilter.value : '';

  galleryState.filteredEmployees = galleryState.employees.filter(emp => {
    const matchesSearch = !searchTerm || 
      emp.employee_name.toLowerCase().includes(searchTerm) ||
      emp.id_number.toLowerCase().includes(searchTerm) ||
      (emp.location_branch || '').toLowerCase().includes(searchTerm);

    const matchesPosition = !positionFilter || emp.position === positionFilter;

    return matchesSearch && matchesPosition;
  });

  renderGallery();
}

// ============================================
// Preview & Download
// ============================================
function previewID(id) {
  const emp = galleryState.employees.find(e => e.id == id);
  
  if (!emp) {
    showToast('Employee not found', 'error');
    return;
  }

  galleryState.currentEmployee = emp;

  if (!elements.modalBody) {
    console.error('Modal body element not found');
    return;
  }

  // Check if this is a Field Officer (needs dual template display - both portrait and landscape)
  const isFieldOfficer = emp.position === 'Field Officer';
  
  // Generate the appropriate preview HTML
  let previewHtml = '';
  
  if (isFieldOfficer) {
    // Dual template preview for ALL Field Officers (shows both SPMC portrait + Field Office landscape)
    previewHtml = generateDualTemplatePreviewHtml(emp);
  } else {
    // Single template preview for non-Field Officers (Freelancer, Intern, Others)
    previewHtml = generateSingleTemplatePreviewHtml(emp, isFieldOfficer);
  }
  
  elements.modalBody.innerHTML = previewHtml + generateEmployeeInfoHtml(emp);

  if (elements.previewModal) {
    elements.previewModal.classList.add('active');
    
    // Ensure modal scrolls to top and fit names to 2 lines
    const fitModalNames = () => {
      elements.modalBody.scrollTop = 0;
      const dualGrid = elements.modalBody.querySelector('.gallery-dual-template-grid');
      if (dualGrid) {
        dualGrid.scrollTop = 0;
      }
      // Auto-fit name text to 2 lines in preview modal
      requestAnimationFrame(() => {
        elements.modalBody.querySelectorAll('.id-fullname').forEach(el => {
          fitNameToLines(el, 38.4, 19.2, 2, 1.05);
        });
      });
    };
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(fitModalNames);
    } else {
      setTimeout(fitModalNames, 150);
    }
  }
}

// Toggle between front and back preview in modal
function showPreviewSide(side) {
  const frontPreview = document.getElementById('previewFront');
  const backPreview = document.getElementById('previewBack');
  const flipBtns = document.querySelectorAll('.id-flip-toggle .flip-btn');
  
  // Update button states
  flipBtns.forEach(btn => {
    if (btn.dataset.side === side) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Show/hide cards
  if (side === 'front') {
    if (frontPreview) frontPreview.style.display = 'block';
    if (backPreview) backPreview.style.display = 'none';
  } else {
    if (frontPreview) frontPreview.style.display = 'none';
    if (backPreview) backPreview.style.display = 'block';
  }
}

function closePreviewModal() {
  if (elements.previewModal) {
    elements.previewModal.classList.remove('active');
  }
  galleryState.currentEmployee = null;
}

// ============================================
// Direct PNG Card Image Capture & Upload
// ============================================
// Captures high-resolution PNG images of each card face and uploads them
// to the backend for direct bot message delivery (skips PDF→PNG conversion).
// This produces significantly higher quality images for the OkPo bot messages.
//
// PNG Capture Config:
// - Scale: 4x (2048×3200px for portrait, 2048×1276px for landscape)
// - Format: PNG (lossless, no JPEG compression artifacts)
// - Purpose: Direct delivery in Lark Interactive Card messages

const PNG_CAPTURE_SCALE = 4; // 4x scale for high-res PNG (512×4 = 2048px width)

async function captureAndUploadCardImages(emp) {
  const hasNoBg = await ensureNoBackgroundPhoto(emp);
  if (!hasNoBg) {
    throw new Error('Cannot render card images: no-background photo is required.');
  }

  const isFieldOfficer = emp.position === 'Field Officer';
  const foType = emp.field_officer_type || '';
  const isRepoShared = isFieldOfficer && ['Repossessor', 'Reprocessor', 'Shared'].includes(foType);
  
  // Determine which card faces to capture (must match send_to_poc page_specs)
  let captureSpecs = [];
  
  if (isRepoShared) {
    // 4 images: SPMC front+back + SPMA front+back
    captureSpecs = [
      { label: 'SPMC ID - Front', htmlFn: () => generateRegularIDCardHtml(emp), width: 512, height: 800 },
      { label: 'SPMC ID - Back', htmlFn: () => generateIDCardBackHtml(emp), width: 512, height: 800 },
      { label: 'SPMA ID - Front', htmlFn: () => generateFieldOfficeIDCardHtml(emp), width: 512, height: 319 },
      { label: 'SPMA ID - Back', htmlFn: () => generateFieldOfficeIDCardBackHtml(emp), width: 512, height: 319 },
    ];
  } else if (isFieldOfficer) {
    // 2 images: SPMA front+back only
    captureSpecs = [
      { label: 'SPMA ID - Front', htmlFn: () => generateFieldOfficeIDCardHtml(emp), width: 512, height: 319 },
      { label: 'SPMA ID - Back', htmlFn: () => generateFieldOfficeIDCardBackHtml(emp), width: 512, height: 319 },
    ];
  } else {
    // 2 images: SPMC front+back
    captureSpecs = [
      { label: 'SPMC ID - Front', htmlFn: () => generateIDCardHtml(emp), width: 512, height: 800 },
      { label: 'SPMC ID - Back', htmlFn: () => getBackHtml(emp), width: 512, height: 800 },
    ];
  }
  
  console.log(`[PNG Capture] Starting high-res PNG capture for ${emp.employee_name} (${captureSpecs.length} images at ${PNG_CAPTURE_SCALE}x scale)`);
  
  // Create temp container for rendering
  const tempContainer = document.createElement('div');
  tempContainer.style.position = 'absolute';
  tempContainer.style.left = '-9999px';
  tempContainer.style.top = '0';
  tempContainer.style.width = '600px';
  tempContainer.style.background = '#ffffff';
  document.body.appendChild(tempContainer);
  
  const cardImages = [];
  
  try {
    for (const spec of captureSpecs) {
      try {
        console.log(`[PNG Capture] Capturing ${spec.label} at ${spec.width}x${spec.height} @ ${PNG_CAPTURE_SCALE}x...`);
        
        const canvas = await captureCardCanvas(
          tempContainer,
          spec.htmlFn(),
          spec.width,
          spec.height,
          PNG_CAPTURE_SCALE, // 4x scale for high resolution
          1500 // Wait time for images to load
        );
        
        // Convert to PNG (lossless) — no JPEG compression artifacts
        const pngDataUrl = canvas.toDataURL('image/png');
        const base64Data = pngDataUrl.split(',')[1]; // Remove "data:image/png;base64," prefix
        
        const estimatedSize = Math.round(base64Data.length * 0.75 / 1024);
        console.log(`[PNG Capture] ${spec.label}: ${canvas.width}x${canvas.height}px, ~${estimatedSize}KB`);
        
        cardImages.push({
          label: spec.label,
          data: base64Data
        });
      } catch (captureErr) {
        console.error(`[PNG Capture] Failed to capture ${spec.label}:`, captureErr);
      }
    }
  } finally {
    document.body.removeChild(tempContainer);
  }
  
  if (cardImages.length === 0) {
    console.warn('[PNG Capture] No images captured successfully');
    return false;
  }
  
  // Upload to backend
  console.log(`[PNG Capture] Uploading ${cardImages.length} PNG images to backend...`);
  
  try {
    const uploadResponse = await fetch(`/hr/api/employees/${emp.id}/upload-card-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_images: cardImages }),
      credentials: 'include'
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error('[PNG Capture] Upload failed:', uploadResponse.status, errorText);
      return false;
    }
    
    const result = await uploadResponse.json();
    console.log('[PNG Capture] Upload result:', result);
    
    if (result.success) {
      console.log(`[PNG Capture] ✅ ${result.total_uploaded}/${result.total_requested} PNG images uploaded successfully`);
      return true;
    } else {
      console.error('[PNG Capture] Upload response indicates failure:', result.error);
      return false;
    }
  } catch (uploadErr) {
    console.error('[PNG Capture] Upload error:', uploadErr);
    return false;
  }
}

// Download single ID as PDF
function downloadSinglePdf(id) {
  const emp = galleryState.employees.find(e => e.id == id);
  
  if (!emp) {
    showToast('Employee not found', 'error');
    return;
  }
  downloadIDPdf(emp);
}

// Helper function to capture a card canvas for PDF generation
async function captureCardCanvas(tempContainer, cardHtml, designWidth, designHeight, scaleToFit, waitTime = 1000) {
  tempContainer.innerHTML = `
    <div class="pdf-id-card-wrapper" style="width: ${designWidth}px; padding: 0; margin: 0; background: white; display: inline-block;">
      ${cardHtml}
    </div>
  `;

  // Try to find the card element - could be .id-card or .id-card-field-office or .id-card-back
  let cardEl = tempContainer.querySelector('.id-card');
  if (!cardEl) {
    cardEl = tempContainer.querySelector('.id-card-field-office');
  }
  if (!cardEl) {
    cardEl = tempContainer.querySelector('.id-card-field-office-back');
  }
  if (!cardEl) {
    cardEl = tempContainer.querySelector('[class*="id-card"]');
  }
  
  // Guard against null element
  if (!cardEl) {
    console.error('captureCardCanvas: No card element found in HTML');
    throw new Error('Card element not found for PDF capture');
  }

  // Set exact dimensions - prevents any scaling during capture
  cardEl.style.width = `${designWidth}px`;
  cardEl.style.height = `${designHeight}px`;
  cardEl.style.minWidth = `${designWidth}px`;
  cardEl.style.minHeight = `${designHeight}px`;
  cardEl.style.maxWidth = `${designWidth}px`;
  cardEl.style.maxHeight = `${designHeight}px`;
  cardEl.style.transform = 'none';
  cardEl.style.transformOrigin = 'top left';
  cardEl.style.margin = '0';
  cardEl.style.overflow = 'hidden';
  
  // Apply high-quality image rendering to all images BEFORE capture
  const allImages = cardEl.querySelectorAll('img');
  allImages.forEach(img => {
    img.style.imageRendering = 'high-quality'; // Best quality rendering
    img.style.webkitBackfaceVisibility = 'hidden';
    img.style.backfaceVisibility = 'hidden';
    // Force image to re-render
    img.style.willChange = 'transform';
  });

  // Initial wait for DOM to settle
  await new Promise(resolve => setTimeout(resolve, waitTime));
  
  // Auto-fit name text to 2 lines before capture
  const nameEls = tempContainer.querySelectorAll('.id-fullname');
  nameEls.forEach(el => fitNameToLines(el, 38.4, 19.2, 2, 1.05));
  
  // Wait for all images to fully load with better error handling
  const images = tempContainer.querySelectorAll('img');
  console.log(`  Waiting for ${images.length} images to load...`);
  
  await Promise.all(Array.from(images).map((img, index) => {
    return new Promise(resolve => {
      // Check if already loaded
      if (img.complete && img.naturalHeight !== 0 && img.naturalWidth !== 0) {
        console.log(`  Image ${index + 1} already loaded: ${img.src.substring(0, 50)}...`);
        return resolve();
      }
      
      const timeoutId = setTimeout(() => {
        console.warn(`  Image ${index + 1} timeout after 8s: ${img.src.substring(0, 50)}...`);
        resolve();
      }, 8000);
      
      img.onload = () => {
        clearTimeout(timeoutId);
        console.log(`  Image ${index + 1} loaded: ${img.naturalWidth}x${img.naturalHeight}`);
        resolve();
      };
      
      img.onerror = (e) => {
        clearTimeout(timeoutId);
        console.error(`  Image ${index + 1} failed to load:`, e);
        resolve();
      };
    });
  }));
  
  // Additional wait after images load to ensure rendering is complete
  await new Promise(resolve => setTimeout(resolve, 500));
  
  console.log(`  Starting html2canvas capture at scale ${scaleToFit}...`);

  return await html2canvas(cardEl, {
    scale: scaleToFit,
    useCORS: true,
    allowTaint: false,
    backgroundColor: '#ffffff',
    width: designWidth,
    height: designHeight,
    scrollY: 0,
    scrollX: 0,
    logging: false,
    // High quality image rendering settings
    imageTimeout: 15000,         // Wait for images
    removeContainer: false,      // Keep container for accurate rendering
    letterRendering: true,       // Better text rendering
    foreignObjectRendering: false, // More compatible rendering mode
    windowWidth: designWidth,    // Match window to design width
    windowHeight: designHeight,  // Match window to design height
    // Preserve image quality in cloned document
    onclone: function(clonedDoc, clonedElement) {
      // Apply high-quality image rendering to all images
      const clonedImages = clonedElement.querySelectorAll('img');
      clonedImages.forEach(img => {
        // Use 'high-quality' for best rendering
        img.style.imageRendering = 'high-quality';
        // Fallback for browsers that don't support high-quality
        img.style.imageRendering = '-webkit-optimize-contrast';
        // Ensure images display properly
        img.style.objectFit = 'cover';
        // GPU acceleration for crisp rendering
        img.style.transform = 'translateZ(0)';
        img.style.webkitTransform = 'translateZ(0)';
      });
      
      // Ensure card element maintains exact dimensions
      clonedElement.style.width = `${designWidth}px`;
      clonedElement.style.height = `${designHeight}px`;
    }
  });
}

// Download ID card as PDF using jsPDF and html2canvas - includes both front and back
// PDF Dimensions: 2.13" × 3.33" (97% of 3.43" original) at 300 DPI
// For ALL Field Officers: generates 4-page PDF (Portrait SPMC + Landscape Field Office templates)
async function downloadIDPdf(emp) {
  const hasNoBg = await ensureNoBackgroundPhoto(emp);
  if (!hasNoBg) {
    showToast('Background removal is required before rendering ID. Please remove background first.', 'error');
    return;
  }

  const isFieldOfficer = emp.position === 'Field Officer';
  const pageCount = isFieldOfficer ? 4 : 2;
  
  showToast(`Generating ${pageCount}-page print-quality PDF (2.13" × 3.33" at 300 DPI)...`, 'success');

  try {
    // Log PDF configuration for debugging
    console.log('PDF Config:', {
      dimensions: `${PDF_CONFIG.WIDTH_INCHES}" × ${PDF_CONFIG.HEIGHT_INCHES}"`,
      dimensionsMm: `${PDF_CONFIG.WIDTH_MM.toFixed(2)}mm × ${PDF_CONFIG.HEIGHT_MM.toFixed(2)}mm`,
      renderPx: `${PDF_CONFIG.RENDER_WIDTH_PX}px × ${PDF_CONFIG.RENDER_HEIGHT_PX}px`,
      dpi: PDF_CONFIG.PRINT_DPI,
      scale: PDF_CONFIG.CANVAS_SCALE.toFixed(3),
      isFieldOfficer: isFieldOfficer,
      pageCount: pageCount
    });

    // Create a temporary container - position off-screen but rendered
    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '0';
    tempContainer.style.width = `${PDF_CONFIG.RENDER_WIDTH_PX + 20}px`;
    tempContainer.style.background = '#ffffff';
    document.body.appendChild(tempContainer);
    
    // Use actual ID card dimensions (512×800) - matches preview exactly
    const designWidth = PDF_CONFIG.PREVIEW_WIDTH_PX;   // 512px
    const designHeight = PDF_CONFIG.PREVIEW_HEIGHT_PX; // 800px
    const scaleToFit = PDF_CONFIG.CANVAS_SCALE;        // ~3.125 for 300 DPI
    
    // Use exact PDF dimensions from config (2.13" × 3.33")
    const pdfWidthMm = PDF_CONFIG.WIDTH_MM;
    const pdfHeightMm = PDF_CONFIG.HEIGHT_MM;
    
    // Create PDF with exact ID card dimensions
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [pdfWidthMm, pdfHeightMm],
      compress: true
    });

    if (isFieldOfficer) {
      // 4-page PDF for ALL Field Officers: Original Portrait (front/back) + Field Office Landscape (front/back)
      console.log('Generating 4-page PDF for Field Officer...');
      
      // Page 1: Original template front
      console.log('Capturing Original template front...');
      const originalFrontCanvas = await captureCardCanvas(
        tempContainer, 
        generateRegularIDCardHtml(emp), 
        designWidth, 
        designHeight, 
        scaleToFit, 
        1500
      );
      const originalFrontImgData = originalFrontCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY);
      pdf.addImage(originalFrontImgData, 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
      
      // Page 2: Original template back
      console.log('Capturing Original template back...');
      pdf.addPage([pdfWidthMm, pdfHeightMm], 'portrait');
      const originalBackCanvas = await captureCardCanvas(
        tempContainer, 
        generateIDCardBackHtml(emp), 
        designWidth, 
        designHeight, 
        scaleToFit, 
        1000
      );
      const originalBackImgData = originalBackCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY);
      pdf.addImage(originalBackImgData, 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
      
      // Page 3: Field Officer template front (LANDSCAPE page - 3.33" × 2.13")
      // Maintains original template dimensions for maximum quality - NO resizing
      console.log('Capturing Field Officer template front (landscape)...');
      
      // Landscape page dimensions (matching template aspect ratio exactly)
      const landscapeWidthMm = PDF_CONFIG_LANDSCAPE.WIDTH_MM;   // 3.33" = 84.582mm
      const landscapeHeightMm = PDF_CONFIG_LANDSCAPE.HEIGHT_MM; // 2.13" = 54.102mm
      
      // Capture dimensions (landscape design) - matches CSS exactly
      const landscapeDesignWidth = PDF_CONFIG_LANDSCAPE.PREVIEW_WIDTH_PX;  // 512px
      const landscapeDesignHeight = PDF_CONFIG_LANDSCAPE.PREVIEW_HEIGHT_PX; // 319px
      
      // Scale 3 for landscape - best balance of quality and file size
      // Scale 2 was blurry, scale 4 was 20MB, scale 3 gives sharp quality at ~7-8MB total
      const landscapeScale = 3;
      
      // Add LANDSCAPE page with correct dimensions
      pdf.addPage([landscapeWidthMm, landscapeHeightMm], 'landscape');
      
      // Capture the landscape card at high resolution
      const foFrontCanvas = await captureCardCanvas(
        tempContainer, 
        generateFieldOfficeIDCardHtml(emp), 
        landscapeDesignWidth, 
        landscapeDesignHeight, 
        landscapeScale, 
        2000 // Longer wait for images to fully load
      );
      
      // Use JPEG with 92% quality - high quality with reasonable file size
      // 92% preserves sharpness while keeping each page under 2MB
      const foFrontImgData = foFrontCanvas.toDataURL('image/jpeg', 0.92);
      
      console.log(`  Landscape page: ${landscapeWidthMm.toFixed(2)}mm × ${landscapeHeightMm.toFixed(2)}mm (3.33" × 2.13")`);
      console.log(`  Canvas captured: ${foFrontCanvas.width}px × ${foFrontCanvas.height}px`);
      
      // Add image at FULL page size - SLOW compression for better quality
      pdf.addImage(foFrontImgData, 'JPEG', 0, 0, landscapeWidthMm, landscapeHeightMm, undefined, 'SLOW');
      
      // Page 4: Field Officer template back (LANDSCAPE page - same dimensions)
      console.log('Capturing Field Officer template back (landscape)...');
      pdf.addPage([landscapeWidthMm, landscapeHeightMm], 'landscape');
      
      const foBackCanvas = await captureCardCanvas(
        tempContainer, 
        generateFieldOfficeIDCardBackHtml(emp), 
        landscapeDesignWidth, 
        landscapeDesignHeight, 
        landscapeScale, 
        1500
      );
      
      // Use JPEG with 92% quality - matches front side
      const foBackImgData = foBackCanvas.toDataURL('image/jpeg', 0.92);
      
      // Add image at FULL page size - SLOW compression for better quality
      pdf.addImage(foBackImgData, 'JPEG', 0, 0, landscapeWidthMm, landscapeHeightMm, undefined, 'SLOW');
      
    } else {
      // Standard 2-page PDF for non-Field Officer employees (Freelancer, Intern, Others)
      // Uses portrait template only
      console.log('Generating 2-page PDF (portrait)...');
      
      // Non-Field Officer - Use portrait dimensions
      // Page 1: Front side (uses position-aware template)
      console.log('Capturing front side...');
      const frontCanvas = await captureCardCanvas(
        tempContainer, 
        generateIDCardHtml(emp), 
        designWidth, 
        designHeight, 
        scaleToFit, 
        1500
      );
      const frontImgData = frontCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY);
      pdf.addImage(frontImgData, 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
      
      // Page 2: Back side (uses position-aware template)
      console.log('Capturing back side...');
      pdf.addPage([pdfWidthMm, pdfHeightMm], 'portrait');
      const backCanvas = await captureCardCanvas(
        tempContainer, 
        getBackHtml(emp), 
        designWidth, 
        designHeight, 
        scaleToFit, 
        1000
      );
      const backImgData = backCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY);
      pdf.addImage(backImgData, 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
    }
    
    console.log('PDF Output:', {
      dimensions: `${pdfWidthMm.toFixed(2)}mm × ${pdfHeightMm.toFixed(2)}mm`,
      inches: `${PDF_CONFIG.WIDTH_INCHES}" × ${PDF_CONFIG.HEIGHT_INCHES}"`,
      scaleFactor: `${PDF_CONFIG.SCALE_FACTOR * 100}% of ${PDF_CONFIG.ORIGINAL_HEIGHT_INCHES}"`,
      pages: pageCount
    });
    
    // Get PDF as binary blob for backend upload
    const pdfBlob = pdf.output('blob');
    console.log('PDF blob size:', pdfBlob.size, 'bytes');
    
    // Check file size - Cloudinary free tier limit is 10MB
    const maxFileSizeMB = 10;
    const fileSizeMB = pdfBlob.size / (1024 * 1024);
    console.log(`PDF size: ${fileSizeMB.toFixed(2)} MB (max: ${maxFileSizeMB} MB)`);
    
    if (fileSizeMB > maxFileSizeMB) {
      document.body.removeChild(tempContainer);
      showToast(`❌ PDF too large: ${fileSizeMB.toFixed(1)}MB (max: ${maxFileSizeMB}MB). Try again.`, 'error');
      console.error(`PDF size ${fileSizeMB.toFixed(2)}MB exceeds Cloudinary limit of ${maxFileSizeMB}MB`);
      return;
    }
    
    // Upload PDF to backend for Cloudinary and LarkBase sync
    // CRITICAL: Only allow download AFTER backend confirms upload success
    let pdfUrl = null;
    let larkSynced = false;
    let uploadSuccess = false;
    
    try {
      showToast('Uploading PDF to cloud storage and LarkBase...', 'success');
      console.log('Uploading PDF to backend for employee:', emp.id);
      
      const uploadResponse = await fetch(`/hr/api/employees/${emp.id}/upload-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/pdf'
        },
        body: pdfBlob,
        credentials: 'include'
      });
      
      if (!uploadResponse.ok) {
        const errorText = await uploadResponse.text();
        console.error('Upload failed with status:', uploadResponse.status, errorText);
        throw new Error(`Upload failed: ${uploadResponse.status} - ${errorText}`);
      }
      
      const uploadResult = await uploadResponse.json();
      console.log('PDF upload result:', uploadResult);
      
      if (uploadResult.success && uploadResult.pdf_url) {
        pdfUrl = uploadResult.pdf_url;
        larkSynced = uploadResult.lark_synced || false;
        uploadSuccess = true;
        console.log('PDF uploaded successfully:', pdfUrl, 'LarkBase synced:', larkSynced);
        
        // Verify LarkBase sync was successful
        if (!larkSynced) {
          console.warn('⚠️ PDF uploaded but LarkBase id_card update failed');
          showToast('⚠️ PDF uploaded but LarkBase update failed. Retrying...', 'warning');
          
          // Retry LarkBase update via dedicated endpoint if available
          // For now, we'll proceed but warn the user
        }
      } else {
        console.error('Upload response indicates failure:', uploadResult.error || 'Unknown error');
        throw new Error(uploadResult.error || 'Upload failed - no URL returned');
      }
    } catch (uploadError) {
      console.error('Error uploading PDF to backend:', uploadError);
      
      // CRITICAL: Do NOT proceed with download if upload failed
      // Cleanup and show error
      document.body.removeChild(tempContainer);
      showToast(`❌ PDF upload failed: ${uploadError.message}. Download blocked.`, 'error');
      return; // Exit without downloading
    }
    
    // ONLY proceed with download if upload was successful
    if (!uploadSuccess || !pdfUrl) {
      document.body.removeChild(tempContainer);
      showToast('❌ Cannot download - PDF was not uploaded successfully', 'error');
      return;
    }
    
    // Capture and upload high-res PNG card images for direct bot delivery
    // This runs in parallel with the PDF download - non-blocking
    // Direct PNGs skip the PDF→PNG conversion and deliver higher quality to POCs
    let pngUploadSuccess = false;
    try {
      console.log('[PNG Capture] Starting high-res PNG capture for bot message delivery...');
      pngUploadSuccess = await captureAndUploadCardImages(emp);
      if (pngUploadSuccess) {
        console.log('[PNG Capture] ✅ Direct PNG images ready for bot delivery');
      } else {
        console.warn('[PNG Capture] ⚠️ PNG capture/upload failed - bot will fall back to PDF-derived images');
      }
    } catch (pngErr) {
      console.warn('[PNG Capture] ⚠️ PNG capture error (non-critical):', pngErr);
    }
    
    // Download the PDF locally with descriptive filename
    // This is now AFTER successful backend upload
    const suffix = isFieldOfficer ? '_dual_templates' : '';
    const filename = `ID_${emp.id_number}_${emp.employee_name.replace(/\s+/g, '_')}${suffix}.pdf`;
    
    console.log('✅ Backend upload confirmed. Starting local download:', filename);
    pdf.save(filename);

    // Cleanup
    document.body.removeChild(tempContainer);
    
    // Update local state to reflect "Sent to POC" status
    if (emp.status === 'Approved') {
      emp.status = 'Sent to POC';
      renderGallery();
      // updateStats() refreshes the status counts in the sidebar
      if (typeof updateStats === 'function') {
        updateStats();
      }
    }

    // Show success message with cloud upload and LarkBase status
    let message = isFieldOfficer 
      ? `4-page PDF downloaded (Portrait + Landscape at ${PDF_CONFIG.PRINT_DPI} DPI)`
      : `PDF downloaded (${PDF_CONFIG.WIDTH_INCHES}" × ${PDF_CONFIG.HEIGHT_INCHES}" at ${PDF_CONFIG.PRINT_DPI} DPI)`;
    
    if (larkSynced) {
      message += ' ✅ Saved to LarkBase';
    } else if (pdfUrl) {
      message += ' ⚠️ Cloud uploaded (LarkBase pending)';
    }
    if (pngUploadSuccess) {
      message += ' 📸 HD images ready';
    }
    showToast(message, 'success');
  } catch (error) {
    console.error('Error generating PDF:', error);
    showToast(`Failed to generate PDF: ${error.message}`, 'error');
  }
}

// Download all IDs as PDFs (front and back) - captures full content
// For ALL Field Officer employees: generates 4-page PDFs (Portrait + Landscape templates)
async function downloadAllPdfs() {
  const employees = galleryState.filteredEmployees;
  
  if (employees.length === 0) {
    showToast('No IDs to download', 'error');
    return;
  }

  // Count Field Officer employees for accurate messaging
  const fieldOfficerCount = employees.filter(emp => 
    emp.position === 'Field Officer'
  ).length;
  const regularCount = employees.length - fieldOfficerCount;
  
  let message = `Generating ${employees.length} print-quality PDFs`;
  if (fieldOfficerCount > 0) {
    message += ` (${fieldOfficerCount} dual-template, ${regularCount} standard)`;
  }
  showToast(message + '...', 'success');
  
  elements.downloadAllBtn.disabled = true;
  elements.downloadAllBtn.innerHTML = `
    <svg class="spin" width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="31.4" stroke-dashoffset="10"/>
    </svg>
    Downloading...
  `;

  try {
    // Use actual ID card dimensions (512×800) - matches preview exactly
    const designWidth = PDF_CONFIG.PREVIEW_WIDTH_PX;   // 512px
    const designHeight = PDF_CONFIG.PREVIEW_HEIGHT_PX; // 800px
    const scaleToFit = PDF_CONFIG.CANVAS_SCALE;        // ~3.125 for 300 DPI
    
    // Create a temporary container
    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '0';
    tempContainer.style.width = `${PDF_CONFIG.RENDER_WIDTH_PX + 20}px`;
    tempContainer.style.background = '#ffffff';
    document.body.appendChild(tempContainer);

    const { jsPDF } = window.jspdf;
    
    // Use exact PDF dimensions (2.13" × 3.33")
    const pdfWidthMm = PDF_CONFIG.WIDTH_MM;
    const pdfHeightMm = PDF_CONFIG.HEIGHT_MM;

    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];
      const isFieldOfficer = emp.position === 'Field Officer';

      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: [pdfWidthMm, pdfHeightMm],
        compress: true
      });
      
      // Landscape config for Field Officer templates
      const landscapeWidthMm = PDF_CONFIG_LANDSCAPE.WIDTH_MM;  // 3.33" = 84.582mm
      const landscapeHeightMm = PDF_CONFIG_LANDSCAPE.HEIGHT_MM; // 2.13" = 54.102mm
      const landscapeDesignWidth = PDF_CONFIG_LANDSCAPE.PREVIEW_WIDTH_PX;  // 512px
      const landscapeDesignHeight = PDF_CONFIG_LANDSCAPE.PREVIEW_HEIGHT_PX; // 319px
      const landscapeScale = PDF_CONFIG_LANDSCAPE.CANVAS_SCALE;
      
      if (isFieldOfficer) {
        // 4-page PDF for ALL Field Officers: Portrait (front/back) + Landscape (front/back)
        
        // Page 1: Original template front (portrait 2.13" x 3.33")
        const originalFrontCanvas = await captureCardCanvas(
          tempContainer, 
          generateRegularIDCardHtml(emp), 
          designWidth, 
          designHeight, 
          scaleToFit, 
          800
        );
        pdf.addImage(originalFrontCanvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
        
        // Page 2: Original template back (portrait 2.13" x 3.33")
        pdf.addPage([pdfWidthMm, pdfHeightMm], 'portrait');
        const originalBackCanvas = await captureCardCanvas(
          tempContainer, 
          generateIDCardBackHtml(emp), 
          designWidth, 
          designHeight, 
          scaleToFit, 
          500
        );
        pdf.addImage(originalBackCanvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
        
        // Page 3: Field Officer template front (landscape 3.33" x 2.13")
        pdf.addPage([landscapeWidthMm, landscapeHeightMm], 'landscape');
        const foFrontCanvas = await captureCardCanvas(
          tempContainer, 
          generateFieldOfficeIDCardHtml(emp), 
          landscapeDesignWidth, 
          landscapeDesignHeight, 
          landscapeScale, 
          500
        );
        pdf.addImage(foFrontCanvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, landscapeWidthMm, landscapeHeightMm, undefined, 'FAST');
        
        // Page 4: Field Officer template back (landscape 3.33" x 2.13")
        pdf.addPage([landscapeWidthMm, landscapeHeightMm], 'landscape');
        const foBackCanvas = await captureCardCanvas(
          tempContainer, 
          generateFieldOfficeIDCardBackHtml(emp), 
          landscapeDesignWidth, 
          landscapeDesignHeight, 
          landscapeScale, 
          500
        );
        pdf.addImage(foBackCanvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, landscapeWidthMm, landscapeHeightMm, undefined, 'FAST');
        
        pdf.save(`ID_${emp.id_number}_${emp.employee_name.replace(/\s+/g, '_')}_dual_templates.pdf`);
        
      } else {
        // Standard 2-page PORTRAIT PDF for Freelancer/Intern/Others - 2.13" x 3.33"
        
        // Page 1: Front side (uses position-aware template)
        const frontCanvas = await captureCardCanvas(
          tempContainer, 
          generateIDCardHtml(emp), 
          designWidth, 
          designHeight, 
          scaleToFit, 
          800
        );
        pdf.addImage(frontCanvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
        
        // Page 2: Back side (uses position-aware template)
        pdf.addPage([pdfWidthMm, pdfHeightMm], 'portrait');
        const backCanvas = await captureCardCanvas(
          tempContainer, 
          getBackHtml(emp), 
          designWidth, 
          designHeight, 
          scaleToFit, 
          500
        );
        pdf.addImage(backCanvas.toDataURL('image/png', 1.0), 'PNG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
        
        pdf.save(`ID_${emp.id_number}_${emp.employee_name.replace(/\s+/g, '_')}_2.13x3.33in.pdf`);
      }

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    document.body.removeChild(tempContainer);
    
    let successMessage = `Downloaded ${employees.length} PDFs`;
    if (fieldOfficerCount > 0) {
      successMessage += ` (${fieldOfficerCount} with dual templates)`;
    }
    showToast(successMessage, 'success');
  } catch (error) {
    console.error('Error downloading PDFs:', error);
    showToast('Failed to download some PDFs. Please try again.', 'error');
  } finally {
    elements.downloadAllBtn.disabled = false;
    elements.downloadAllBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 2v8M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 12v2h12v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Download All PDFs
    `;
  }
}

async function markAsSentToPOC(id) {
  try {
    const response = await fetch(`/hr/api/employees/${id}/send-to-poc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      const emp = galleryState.employees.find(e => e.id === id);
      if (emp) emp.status = 'Sent to POC';
      updateStats();
      renderGallery();
    }
  } catch (error) {
    console.error('Error marking as sent to POC:', error);
  }
}

// ============================================
// Utilities
// ============================================
function showToast(message, type = 'success') {
  if (!elements.toastMessage || !elements.toast) {
    console.log('Toast:', type, message);
    return;
  }
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toastIcon = document.getElementById('toastIcon');
  if (toastIcon) toastIcon.textContent = icons[type] || '';
  elements.toastMessage.textContent = message;
  elements.toast.className = `toast show ${type}`;

  const duration = (type === 'error' || type === 'warning') ? 5000 : 3000;
  setTimeout(() => {
    elements.toast.classList.remove('show');
  }, duration);
}

// ============================================
// Progress Overlay (for async gallery actions)
// ============================================
let galleryProgressInterval = null;

function showGalleryProgress(text, subtext) {
  const overlay = document.getElementById('galleryProgressOverlay');
  const textEl = document.getElementById('galleryProgressText');
  const subtextEl = document.getElementById('galleryProgressSubtext');
  const fillEl = document.getElementById('galleryProgressBarFill');
  if (!overlay) return;

  if (textEl) textEl.textContent = text || 'Processing...';
  if (subtextEl) subtextEl.textContent = subtext || '';
  if (fillEl) fillEl.style.width = '10%';
  overlay.classList.add('active');

  let pct = 10;
  clearInterval(galleryProgressInterval);
  galleryProgressInterval = setInterval(() => {
    if (pct < 60) pct += 2;
    else if (pct < 85) pct += 0.8;
    else if (pct < 92) pct += 0.2;
    if (fillEl) fillEl.style.width = pct + '%';
  }, 250);
}

function updateGalleryProgress(percent, text, subtext) {
  const fillEl = document.getElementById('galleryProgressBarFill');
  const textEl = document.getElementById('galleryProgressText');
  const subtextEl = document.getElementById('galleryProgressSubtext');
  clearInterval(galleryProgressInterval);
  if (fillEl) fillEl.style.width = percent + '%';
  if (text && textEl) textEl.textContent = text;
  if (subtext !== undefined && subtextEl) subtextEl.textContent = subtext;
}

function hideGalleryProgress() {
  clearInterval(galleryProgressInterval);
  const overlay = document.getElementById('galleryProgressOverlay');
  if (overlay) overlay.classList.remove('active');
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Generate a barcode image URL for the given employee ID number.
 * Uses QuickChart.io Barcode API to generate Code 128 barcodes.
 * API Documentation: https://quickchart.io/documentation/barcode-api/
 * 
 * @param {string} idNumber - The employee ID number to encode
 * @param {Object} options - Optional configuration
 * @param {number} options.width - Width in pixels (default: 500)
 * @param {number} options.height - Height in pixels (default: 50)
 * @returns {string} URL to the barcode image
 * 
 * @example
 * getBarcodeUrl('EMP-12345')
 * // Returns: 'https://quickchart.io/barcode?type=code128&text=EMP-12345&width=500&height=50&format=png'
 */
function getBarcodeUrl(idNumber, options = {}) {
  if (!idNumber) return '';
  
  // Default dimensions - width=500 for high quality, height=50 for scan reliability
  const width = options.width || 500;
  const height = options.height || 50;
  
  // URL-encode the ID number to handle special characters
  const encodedId = encodeURIComponent(idNumber);
  
  // QuickChart Barcode API URL
  // type=code128: Code 128 barcode (alphanumeric)
  // Note: Omitting includeText parameter = no human-readable text (BWIPP default behavior)
  // format=png: PNG output format
  const url = `https://quickchart.io/barcode?type=code128&text=${encodedId}&width=${width}&height=${height}&format=png`;
  
  return url;
}

/**
 * Generate the HTML for a barcode image with error handling and fallback.
 * If the barcode fails to load, shows the ID number as text.
 * 
 * @param {string} idNumber - The employee ID number to encode
 * @param {string} cssClass - CSS class for the barcode image
 * @param {Object} options - Barcode options (type, height)
 * @returns {string} HTML string for the barcode image
 */
function generateBarcodeHtml(idNumber, cssClass = 'id-barcode-image', options = {}) {
  if (!idNumber) {
    return ``; // Return nothing if no ID
  }
  
  const barcodeUrl = getBarcodeUrl(idNumber, options);
  
  // Generate HTML - hide both image and fallback on error (no text shown)
  return `
    <img 
      src="${barcodeUrl}" 
      alt="Barcode for ${escapeHtml(idNumber)}" 
      class="${cssClass}"
      crossorigin="anonymous"
      onerror="this.style.display='none';"
    >
  `;
}

/**
 * Generate a QR code image URL using QuickChart.io QR API.
 * API Documentation: https://quickchart.io/documentation/qr-codes/
 * 
 * @param {string} data - The data to encode in the QR code (URL, vCard, etc.)
 * @param {Object} options - Optional configuration
 * @param {number} options.size - Size in pixels (default: 150)
 * @param {string} options.ecLevel - Error correction level: L, M, Q, H (default: M)
 * @param {string} options.format - Output format: png, svg (default: png)
 * @param {string} options.centerImageUrl - URL to embed in center of QR (for logo)
 * @param {number} options.centerImageSizeRatio - Size ratio for center image (default: 0.25)
 * @returns {string} URL to the QR code image
 * 
 * @example
 * getQRCodeUrl('https://example.com')
 * // Returns: 'https://quickchart.io/qr?text=https%3A%2F%2Fexample.com&size=150&format=png'
 */
function getQRCodeUrl(data, options = {}) {
  if (!data) return '';
  
  // Default settings
  const size = options.size || 150;
  const ecLevel = options.ecLevel || 'M';
  const format = options.format || 'png';
  
  // URL-encode the data
  const encodedData = encodeURIComponent(data);
  
  // QuickChart QR API URL
  let url = `https://quickchart.io/qr?text=${encodedData}&size=${size}&ecLevel=${ecLevel}&format=${format}&margin=1`;
  
  // Add center image (logo) if provided
  if (options.centerImageUrl) {
    const encodedLogoUrl = encodeURIComponent(options.centerImageUrl);
    const sizeRatio = options.centerImageSizeRatio || 0.25;
    url += `&centerImageUrl=${encodedLogoUrl}&centerImageSizeRatio=${sizeRatio}`;
  }
  
  return url;
}

/**
 * Generate a vCard string for QR code encoding.
 * 
 * @param {Object} emp - Employee object
 * @returns {string} vCard formatted string
 */
function generateVCard(emp) {
  const fullName = emp.employee_name || '';
  const firstName = emp.first_name || fullName.split(' ')[0] || '';
  const lastName = emp.last_name || (fullName.split(' ').slice(1).join(' ')) || '';
  const email = emp.email || '';
  const phone = emp.personal_number || '';
  const position = emp.position || '';
  const company = 'S.P. Madrid & Co.';
  
  // vCard 3.0 format
  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${fullName}`,
    `N:${lastName};${firstName};;;`,
    `ORG:${company}`,
    `TITLE:${position}`,
    email ? `EMAIL:${email}` : '',
    phone ? `TEL:${phone}` : '',
    'END:VCARD'
  ].filter(line => line).join('\n');
  
  return vcard;
}

/**
 * Generate the HTML for a QR code image with error handling.
 * 
 * @param {string} data - The data to encode (URL or vCard string)
 * @param {string} cssClass - CSS class for the QR image
 * @param {Object} options - QR code options (size, ecLevel)
 * @returns {string} HTML string for the QR code image
 */
function generateQRCodeHtml(data, cssClass = 'id-qr-image', options = {}) {
  if (!data) {
    return `<span class="qr-placeholder">QR Code</span>`;
  }
  
  const qrUrl = getQRCodeUrl(data, options);
  
  return `
    <img 
      src="${qrUrl}" 
      alt="QR Code" 
      class="${cssClass}"
      crossorigin="anonymous"
      onerror="this.parentElement.innerHTML='<span class=\\'qr-placeholder\\'>QR</span>';"
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

// ============================================
// Global Window Exports for onclick handlers
// Must be at the END after all functions are defined
// ============================================
window.showPreviewSide = showPreviewSide;
window.previewID = previewID;
window.closePreviewModal = closePreviewModal;
window.approveAndSaveID = approveAndSaveID;
window.sendToPOC = sendToPOC;

/**
 * Send a single employee to POC - Changes status from Approved to Sent to POC
 * Uses the same backend endpoint as bulk send
 */
async function sendToPOC(id) {
  const emp = galleryState.employees.find(e => e.id == id);
  
  if (!emp) {
    showToast('Employee not found', 'error');
    return;
  }

  if (emp.status !== 'Approved') {
    showToast('Only approved IDs can be sent to POC', 'error');
    return;
  }

  if (!confirm(`Send ${emp.employee_name}'s ID to their nearest POC branch?`)) return;

  showGalleryProgress('Sending to POC...', emp.employee_name);

  try {
    const response = await fetch(`/hr/api/employees/${id}/send-to-poc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
      throw new Error(data.error || `Failed to send to POC (HTTP ${response.status})`);
    }
    
    emp.status = 'Sent to POC';
    updateStats();
    renderGallery();
    
    updateGalleryProgress(100, 'Sent to POC!', data.nearest_poc || '');
    setTimeout(() => {
      hideGalleryProgress();
      showToast(`Sent to POC: ${data.nearest_poc || 'Unknown branch'}`, 'success');
    }, 800);
  } catch (error) {
    hideGalleryProgress();
    console.error('Error sending to POC:', error);
    showToast(`Failed to send to POC: ${error.message}`, 'error');
  }
}

/**
 * Approve ID - Generates PDF, uploads to LarkBase, then changes status from Rendered → Approved
 * This is the source of truth for approval - bulk approve uses the same helper function
 * 
 * FLOW:
 * 1. Generate ID Card PDF(s) using the existing renderer
 * 2. Upload PDF to Cloudinary via /upload-pdf
 * 3. Update LarkBase id_card field with PDF URL
 * 4. Change status to Approved via /approve
 * 5. UI shows "Send to POC" button
 */
async function approveAndSaveID(id) {
  const emp = galleryState.employees.find(e => e.id == id);
  
  if (!emp) {
    showToast('Employee not found', 'error');
    return;
  }

  if (emp.status !== 'Rendered') {
    showToast('Only rendered IDs can be approved', 'error');
    return;
  }

  if (!confirm(`Approve ${emp.employee_name}'s ID? This will generate and upload the PDF.`)) return;

  const isFieldOfficer = emp.position === 'Field Officer';
  const pageCount = isFieldOfficer ? 4 : 2;
  
  showGalleryProgress('Generating & Uploading PDF...', `${pageCount}-page ID card for ${emp.employee_name}`);

  try {
    const result = await generateUploadAndApprove(emp);
    
    if (result.success) {
      emp.status = 'Approved';
      updateStats();
      renderGallery();
      
      updateGalleryProgress(100, 'Approved!', result.larkSynced ? 'PDF uploaded to LarkBase' : 'LarkBase sync pending');
      setTimeout(() => {
        hideGalleryProgress();
        if (result.larkSynced) {
          showToast(`${emp.employee_name} approved with PDF uploaded to LarkBase`, 'success');
        } else {
          showToast(`${emp.employee_name} approved (LarkBase sync pending)`, 'warning');
        }
      }, 800);
    } else {
      throw new Error(result.error || 'Failed to approve');
    }
  } catch (error) {
    hideGalleryProgress();
    console.error('Error approving ID:', error);
    showToast(`Failed to approve: ${error.message}`, 'error');
  }
}

// ============================================
// Bulk Actions
// ============================================

// OKPO logo URL for QR codes (used in bulk PDF generation)
const OKPO_LOGO_URL = 'https://239dc453931a663c0cfa3bb867f1aaae.cdn.bubble.io/cdn-cgi/image/w=,h=,f=auto,dpr=1,fit=contain/f1727917655428x617042099316169600/okpologo.jpg';

/**
 * Helper function to generate PDF for an employee
 * Reusable by both single approve and bulk approve
 * @param {Object} emp - Employee object
 * @returns {Promise<Blob>} - PDF blob or throws error
 */
async function generatePDFForEmployee(emp) {
  const hasNoBg = await ensureNoBackgroundPhoto(emp);
  if (!hasNoBg) {
    throw new Error('No-background photo is required before PDF generation.');
  }

  const isFieldOfficer = emp.position === 'Field Officer';
  
  // Create temp container
  const tempContainer = document.createElement('div');
  tempContainer.style.position = 'absolute';
  tempContainer.style.left = '-9999px';
  tempContainer.style.top = '0';
  tempContainer.style.width = `${PDF_CONFIG.RENDER_WIDTH_PX + 20}px`;
  tempContainer.style.background = '#ffffff';
  document.body.appendChild(tempContainer);
  
  try {
    const designWidth = PDF_CONFIG.PREVIEW_WIDTH_PX;
    const designHeight = PDF_CONFIG.PREVIEW_HEIGHT_PX;
    const scaleToFit = PDF_CONFIG.CANVAS_SCALE;
    const pdfWidthMm = PDF_CONFIG.WIDTH_MM;
    const pdfHeightMm = PDF_CONFIG.HEIGHT_MM;
    
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: [pdfWidthMm, pdfHeightMm],
      compress: true
    });

    if (isFieldOfficer) {
      // 4-page PDF
      const originalFrontCanvas = await captureCardCanvas(tempContainer, generateRegularIDCardHtml(emp), designWidth, designHeight, scaleToFit, 1500);
      pdf.addImage(originalFrontCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY), 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
      
      pdf.addPage([pdfWidthMm, pdfHeightMm], 'portrait');
      const originalBackCanvas = await captureCardCanvas(tempContainer, generateIDCardBackHtml(emp), designWidth, designHeight, scaleToFit, 1000);
      pdf.addImage(originalBackCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY), 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
      
      const landscapeWidthMm = PDF_CONFIG_LANDSCAPE.WIDTH_MM;
      const landscapeHeightMm = PDF_CONFIG_LANDSCAPE.HEIGHT_MM;
      const landscapeDesignWidth = PDF_CONFIG_LANDSCAPE.PREVIEW_WIDTH_PX;
      const landscapeDesignHeight = PDF_CONFIG_LANDSCAPE.PREVIEW_HEIGHT_PX;
      const landscapeScale = 3;
      
      pdf.addPage([landscapeWidthMm, landscapeHeightMm], 'landscape');
      const foFrontCanvas = await captureCardCanvas(tempContainer, generateFieldOfficeIDCardHtml(emp), landscapeDesignWidth, landscapeDesignHeight, landscapeScale, 2000);
      pdf.addImage(foFrontCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, landscapeWidthMm, landscapeHeightMm, undefined, 'SLOW');
      
      pdf.addPage([landscapeWidthMm, landscapeHeightMm], 'landscape');
      const foBackCanvas = await captureCardCanvas(tempContainer, generateFieldOfficeIDCardBackHtml(emp), landscapeDesignWidth, landscapeDesignHeight, landscapeScale, 1500);
      pdf.addImage(foBackCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, landscapeWidthMm, landscapeHeightMm, undefined, 'SLOW');
    } else {
      // 2-page PDF
      const frontCanvas = await captureCardCanvas(tempContainer, generateIDCardHtml(emp), designWidth, designHeight, scaleToFit, 1500);
      pdf.addImage(frontCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY), 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
      
      pdf.addPage([pdfWidthMm, pdfHeightMm], 'portrait');
      const backCanvas = await captureCardCanvas(tempContainer, getBackHtml(emp), designWidth, designHeight, scaleToFit, 1000);
      pdf.addImage(backCanvas.toDataURL('image/jpeg', PDF_CONFIG.JPEG_QUALITY), 'JPEG', 0, 0, pdfWidthMm, pdfHeightMm, undefined, 'FAST');
    }
    
    return pdf.output('blob');
  } finally {
    document.body.removeChild(tempContainer);
  }
}

/**
 * Helper function to generate PDF, upload, and approve an employee
 * Used by both single approve and bulk approve
 * @param {Object} emp - Employee object
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function generateUploadAndApprove(emp) {
  try {
    // Step 1: Generate PDF
    const pdfBlob = await generatePDFForEmployee(emp);
    
    // Check size
    if (pdfBlob.size > 10 * 1024 * 1024) {
      throw new Error('PDF too large (>10MB)');
    }
    
    // Step 2: Upload
    const uploadResponse = await fetch(`/hr/api/employees/${emp.id}/upload-pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBlob,
      credentials: 'include'
    });
    
    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      throw new Error(`Upload failed: ${uploadResponse.status}`);
    }
    
    const uploadResult = await uploadResponse.json();
    if (!uploadResult.success) {
      throw new Error(uploadResult.error || 'Upload failed');
    }
    
    // Step 3: Approve
    const approveResponse = await fetch(`/hr/api/employees/${emp.id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    
    const approveData = await approveResponse.json();
    if (!approveData.success) {
      throw new Error(approveData.error || 'Approval failed');
    }
    
    return { success: true, larkSynced: uploadResult.lark_synced && approveData.lark_synced };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Approve all employees with "Rendered" status (respects current filters)
 * Uses the same generate+upload+approve flow as individual approvals
 * Includes concurrency limiting, retries, and progress tracking
 * 
 * NOTE: Each approval generates a PDF, which is slower than just status change.
 * Concurrency is limited to 2 to avoid browser memory issues.
 */
async function approveAllRendered() {
  const renderedEmployees = galleryState.filteredEmployees.filter(e => e.status === 'Rendered');
  
  if (renderedEmployees.length === 0) {
    showToast('No employees with "Rendered" status to approve in current view', 'error');
    return;
  }
  
  const confirmApprove = confirm(`Are you sure you want to approve ${renderedEmployees.length} employee(s)?\n\nThis will generate and upload PDFs for each, which may take a few minutes.`);
  if (!confirmApprove) return;
  
  showGalleryProgress('Bulk Approving...', `0 of ${renderedEmployees.length} employees`);
  
  if (elements.approveAllBtn) {
    elements.approveAllBtn.classList.add('loading');
    elements.approveAllBtn.disabled = true;
  }
  
  const MAX_CONCURRENT = 2;
  const MAX_RETRIES = 1;
  
  let successCount = 0;
  let failCount = 0;
  const failures = [];
  
  const queue = [...renderedEmployees];
  const processing = [];
  
  async function processEmployee(emp) {
    let lastError = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await generateUploadAndApprove(emp);
        
        if (result.success) {
          emp.status = 'Approved';
          successCount++;
          updateGalleryProgress(
            Math.round(((successCount + failCount) / renderedEmployees.length) * 90),
            'Bulk Approving...',
            `${successCount + failCount} of ${renderedEmployees.length} — ${emp.employee_name}`
          );
          return true;
        } else {
          lastError = result.error || 'Unknown error';
        }
      } catch (error) {
        lastError = error.message;
        console.error(`Error approving employee ${emp.id} (attempt ${attempt + 1}):`, error);
      }
      
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    
    failCount++;
    failures.push({ id: emp.id, name: emp.employee_name, error: lastError });
    return false;
  }
  
  while (queue.length > 0 || processing.length > 0) {
    while (queue.length > 0 && processing.length < MAX_CONCURRENT) {
      const emp = queue.shift();
      const promise = processEmployee(emp).finally(() => {
        const index = processing.indexOf(promise);
        if (index > -1) processing.splice(index, 1);
      });
      processing.push(promise);
    }
    
    if (processing.length > 0) {
      await Promise.race(processing);
    }
  }
  
  if (elements.approveAllBtn) {
    elements.approveAllBtn.classList.remove('loading');
    elements.approveAllBtn.disabled = false;
  }
  
  updateStats();
  renderGallery();
  
  updateGalleryProgress(100, 'Complete!', `${successCount} approved${failCount ? `, ${failCount} failed` : ''}`);
  setTimeout(() => {
    hideGalleryProgress();
    if (failCount === 0) {
      showToast(`Successfully approved ${successCount} employee(s) with PDFs uploaded`, 'success');
    } else {
      console.error('Bulk approve failures:', failures);
      showToast(`Approved ${successCount}, failed ${failCount}. Check console for details.`, 'error');
    }
  }, 800);
}

/**
 * Send all "Approved" employees to their POCs based on nearest branch
 */
async function sendAllToPOCs() {
  const approvedEmployees = galleryState.employees.filter(e => e.status === 'Approved');
  
  if (approvedEmployees.length === 0) {
    showToast('No employees with "Approved" status to send to POCs', 'error');
    return;
  }
  
  const confirmSend = confirm(`Are you sure you want to send ${approvedEmployees.length} employee(s) to their nearest branch POCs?`);
  if (!confirmSend) return;
  
  showGalleryProgress('Sending All to POCs...', `${approvedEmployees.length} employees queued`);
  
  if (elements.sendToPOCsBtn) {
    elements.sendToPOCsBtn.classList.add('loading');
    elements.sendToPOCsBtn.disabled = true;
  }
  
  try {
    const response = await fetch('/hr/api/send-all-to-pocs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    
    const data = await response.json();
    
    if (!response.ok || !data.success) {
      throw new Error(data.error || `Failed to send to POCs (HTTP ${response.status})`);
    }
    
    for (const emp of approvedEmployees) {
      emp.status = 'Sent to POC';
    }
    updateStats();
    renderGallery();
    
    updateGalleryProgress(100, 'All Sent!', `${data.sent_count} employees routed to POCs`);
    setTimeout(() => {
      hideGalleryProgress();
      let message = `Sent ${data.sent_count} employee(s) to POCs`;
      if (data.failed_count > 0) {
        message += ` (${data.failed_count} failed)`;
        showToast(message, 'warning');
      } else {
        showToast(message, 'success');
      }
    }, 1000);
  } catch (error) {
    hideGalleryProgress();
    console.error('Error sending to POCs:', error);
    showToast('Failed to send employees to POCs: ' + error.message, 'error');
  }
  
  if (elements.sendToPOCsBtn) {
    elements.sendToPOCsBtn.classList.remove('loading');
    elements.sendToPOCsBtn.disabled = false;
  }
}
