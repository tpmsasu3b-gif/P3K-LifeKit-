/**
 * ============================================================
 * P3K STOCK MANAGER - MAIN APPLICATION (FIXED VERSION)
 * Progressive Web App with offline support
 * ============================================================
 * Fixed: 2026-04-12
 * Changes:
 * - Better error handling
 * - Fixed DOM element caching
 * - Improved event binding
 * - Added null checks
 * - Fixed function references
 */

'use strict';

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
    APP_NAME: 'P3K Stock Manager',
    VERSION: '2.0.1',
    DB_NAME: 'P3KDatabase',
    DB_VERSION: 1,
    STORE_NAME: 'inventory',
    SYNC_STORE: 'syncQueue',
    GOOGLE_SHEETS_URL: localStorage.getItem('p3k_sheets_url') || '',
    SYNC_INTERVAL: 5 * 60 * 1000, // 5 minutes
    ITEMS_PER_PAGE: 20
};

// ============================================================
// STATE MANAGEMENT
// ============================================================

const state = {
    inventory: [],
    filteredInventory: [],
    currentFilter: 'all',
    searchQuery: '',
    isOnline: navigator.onLine,
    isSyncing: false,
    currentView: 'home',
    editingId: null,
    deleteId: null,
    deferredInstall: null,
    db: null
};

// ============================================================
// DOM ELEMENTS CACHE
// ============================================================

const elements = {};

function cacheElements() {
    // Main containers
    elements.inventoryList = document.getElementById('inventory-list');
    elements.emptyState = document.getElementById('empty-state');
    elements.alertContainer = document.getElementById('alert-container');
    elements.toast = document.getElementById('toast');
    elements.loadingScreen = document.getElementById('loading-screen');
    
    // Stats
    elements.statTotal = document.getElementById('stat-total');
    elements.statExpiring = document.getElementById('stat-expiring');
    elements.statExpired = document.getElementById('stat-expired');
    
    // Buttons
    elements.addBtn = document.getElementById('add-btn');
    elements.syncBtn = document.getElementById('sync-btn');
    elements.menuBtn = document.getElementById('menu-btn');
    
    // Modal
    elements.itemModal = document.getElementById('item-modal');
    elements.deleteModal = document.getElementById('delete-modal');
    elements.itemForm = document.getElementById('item-form');
    elements.modalTitle = document.getElementById('modal-title');
    
    // Form elements
    elements.itemId = document.getElementById('item-id');
    elements.itemName = document.getElementById('item-name');
    elements.itemCategory = document.getElementById('item-category');
    elements.itemQuantity = document.getElementById('item-quantity');
    elements.itemExpiry = document.getElementById('item-expiry');
    elements.itemNotes = document.getElementById('item-notes');
    
    // Search & Filter
    elements.searchInput = document.getElementById('search-input');
    elements.filterChips = document.getElementById('filter-chips');
    
    // Connection status
    elements.connectionStatus = document.getElementById('connection-status');
    
    // Install prompt
    elements.installPrompt = document.getElementById('install-prompt');
    elements.installBtn = document.getElementById('install-btn');
    elements.dismissInstall = document.getElementById('dismiss-install');
    
    // Quantity buttons in modal
    elements.qtyMinus = document.querySelector('.qty-btn.minus');
    elements.qtyPlus = document.querySelector('.qty-btn.plus');
    
    // Debug: log missing elements
    Object.keys(elements).forEach(key => {
        if (!elements[key]) {
            console.warn(`[P3K] Element not found: ${key}`);
        }
    });
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('[P3K] Initializing application...');
        
        // Cache DOM elements first
        cacheElements();
        
        // Bind events
        bindEvents();
        
        // Initialize database
        await initDatabase();
        
        // Load inventory data
        await loadInventory();
        
        // Update UI
        updateUI();
        checkExpiringItems();
        
        // Hide loading screen
        setTimeout(() => {
            if (elements.loadingScreen) {
                elements.loadingScreen.classList.add('hidden');
            }
        }, 500);
        
        // Setup periodic sync
        setInterval(() => {
            if (state.isOnline && CONFIG.GOOGLE_SHEETS_URL) {
                syncWithGoogleSheets();
            }
        }, CONFIG.SYNC_INTERVAL);
        
        console.log('[P3K] Application initialized successfully');
        
    } catch (error) {
        console.error('[P3K] Initialization failed:', error);
        showToast('Gagal memuat aplikasi: ' + error.message, 'error');
    }
});

// ============================================================
// DATABASE (IndexedDB)
// ============================================================

function initDatabase() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            console.warn('[P3K] IndexedDB not supported, using localStorage fallback');
            state.db = null;
            resolve(null);
            return;
        }
        
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = () => {
            console.error('[P3K] Database error:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            state.db = request.result;
            console.log('[P3K] Database opened successfully');
            resolve(state.db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // Main inventory store
            if (!database.objectStoreNames.contains(CONFIG.STORE_NAME)) {
                const store = database.createObjectStore(CONFIG.STORE_NAME, { keyPath: 'id' });
                store.createIndex('category', 'category', { unique: false });
                store.createIndex('expiry', 'expiry', { unique: false });
                console.log('[P3K] Created inventory store');
            }
            
            // Sync queue store
            if (!database.objectStoreNames.contains(CONFIG.SYNC_STORE)) {
                database.createObjectStore(CONFIG.SYNC_STORE, { keyPath: 'timestamp' });
                console.log('[P3K] Created sync queue store');
            }
        };
    });
}

function dbOperation(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
        if (!state.db) {
            // Fallback to localStorage
            resolve(handleLocalStorageFallback(storeName, operation));
            return;
        }
        
        try {
            const transaction = state.db.transaction([storeName], mode);
            const store = transaction.objectStore(storeName);
            const request = operation(store);
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        } catch (error) {
            reject(error);
        }
    });
}

function handleLocalStorageFallback(storeName, operation) {
    // Simple localStorage fallback for unsupported browsers
    const key = `p3k_${storeName}`;
    const data = JSON.parse(localStorage.getItem(key) || '[]');
    return data;
}

async function saveItemToDB(item) {
    try {
        await dbOperation(CONFIG.STORE_NAME, 'readwrite', (store) => store.put(item));
    } catch (error) {
        console.error('[P3K] Save to DB failed:', error);
        // Fallback to localStorage
        const key = `p3k_${CONFIG.STORE_NAME}`;
        const data = JSON.parse(localStorage.getItem(key) || '[]');
        const index = data.findIndex(i => i.id === item.id);
        if (index >= 0) {
            data[index] = item;
        } else {
            data.push(item);
        }
        localStorage.setItem(key, JSON.stringify(data));
    }
}

async function deleteItemFromDB(id) {
    try {
        await dbOperation(CONFIG.STORE_NAME, 'readwrite', (store) => store.delete(id));
    } catch (error) {
        console.error('[P3K] Delete from DB failed:', error);
        const key = `p3k_${CONFIG.STORE_NAME}`;
        const data = JSON.parse(localStorage.getItem(key) || '[]');
        const filtered = data.filter(i => i.id !== id);
        localStorage.setItem(key, JSON.stringify(filtered));
    }
}

async function getAllItemsFromDB() {
    try {
        return await dbOperation(CONFIG.STORE_NAME, 'readonly', (store) => store.getAll());
    } catch (error) {
        console.error('[P3K] Get all from DB failed:', error);
        const key = `p3k_${CONFIG.STORE_NAME}`;
        return JSON.parse(localStorage.getItem(key) || '[]');
    }
}

async function addToSyncQueue(action) {
    const queueItem = {
        timestamp: Date.now(),
        action: action,
        retries: 0
    };
    
    try {
        await dbOperation(CONFIG.SYNC_STORE, 'readwrite', (store) => store.put(queueItem));
    } catch (error) {
        console.error('[P3K] Add to sync queue failed:', error);
        const key = `p3k_${CONFIG.SYNC_STORE}`;
        const queue = JSON.parse(localStorage.getItem(key) || '[]');
        queue.push(queueItem);
        localStorage.setItem(key, JSON.stringify(queue));
    }
}

async function getSyncQueue() {
    try {
        return await dbOperation(CONFIG.SYNC_STORE, 'readonly', (store) => store.getAll());
    } catch (error) {
        const key = `p3k_${CONFIG.SYNC_STORE}`;
        return JSON.parse(localStorage.getItem(key) || '[]');
    }
}

async function removeFromSyncQueue(timestamp) {
    try {
        await dbOperation(CONFIG.SYNC_STORE, 'readwrite', (store) => store.delete(timestamp));
    } catch (error) {
        const key = `p3k_${CONFIG.SYNC_STORE}`;
        const queue = JSON.parse(localStorage.getItem(key) || '[]');
        const filtered = queue.filter(item => item.timestamp !== timestamp);
        localStorage.setItem(key, JSON.stringify(filtered));
    }
}

// ============================================================
// EVENT BINDING
// ============================================================

function bindEvents() {
    console.log('[P3K] Binding events...');
    
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            const view = e.currentTarget.dataset.view;
            if (view) switchView(view);
        });
    });
    
    // Add button
    if (elements.addBtn) {
        elements.addBtn.addEventListener('click', openModal);
    }
    
    // Sync button
    if (elements.syncBtn) {
        elements.syncBtn.addEventListener('click', () => syncWithGoogleSheets());
    }
    
    // Modal close buttons
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', closeAllModals);
    });
    
    // Form submission
    if (elements.itemForm) {
        elements.itemForm.addEventListener('submit', handleFormSubmit);
    }
    
    // Quantity buttons in modal
    if (elements.qtyMinus) {
        elements.qtyMinus.addEventListener('click', () => changeQuantity(-1));
    }
    if (elements.qtyPlus) {
        elements.qtyPlus.addEventListener('click', () => changeQuantity(1));
    }
    
    // Search
    if (elements.searchInput) {
        elements.searchInput.addEventListener('input', debounce(handleSearch, 300));
    }
    
    // Filter chips
    if (elements.filterChips) {
        elements.filterChips.addEventListener('click', handleFilterClick);
    }
    
    // Delete confirmation
    const confirmDeleteBtn = document.getElementById('confirm-delete');
    if (confirmDeleteBtn) {
        confirmDeleteBtn.addEventListener('click', confirmDelete);
    }
    
    // Online/Offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    // Install prompt
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    
    if (elements.installBtn) {
        elements.installBtn.addEventListener('click', installApp);
    }
    if (elements.dismissInstall) {
        elements.dismissInstall.addEventListener('click', dismissInstallPrompt);
    }
    
    // Keyboard shortcuts
    document.addEventListener('keydown', handleKeyboard);
    
    // Close modal on overlay click
    if (elements.itemModal) {
        elements.itemModal.addEventListener('click', (e) => {
            if (e.target === elements.itemModal || e.target.classList.contains('modal-overlay')) {
                closeAllModals();
            }
        });
    }
    if (elements.deleteModal) {
        elements.deleteModal.addEventListener('click', (e) => {
            if (e.target === elements.deleteModal || e.target.classList.contains('modal-overlay')) {
                closeAllModals();
            }
        });
    }
}

// ============================================================
// EVENT HANDLERS
// ============================================================

function handleOnline() {
    state.isOnline = true;
    updateConnectionStatus();
    showToast('Koneksi online', 'success');
    syncWithGoogleSheets();
}

function handleOffline() {
    state.isOnline = false;
    updateConnectionStatus();
    showToast('Mode offline - data disimpan lokal', 'warning');
}

function handleBeforeInstallPrompt(e) {
    e.preventDefault();
    state.deferredInstall = e;
    if (elements.installPrompt) {
        elements.installPrompt.hidden = false;
    }
}

function handleKeyboard(e) {
    if (e.key === 'Escape') {
        closeAllModals();
    }
    if (e.ctrlKey && e.key === 'n') {
        e.preventDefault();
        openModal();
    }
}

function changeQuantity(delta) {
    if (!elements.itemQuantity) return;
    
    let value = parseInt(elements.itemQuantity.value) || 0;
    value = Math.max(0, Math.min(9999, value + delta));
    elements.itemQuantity.value = value;
}

// ============================================================
// INVENTORY MANAGEMENT
// ============================================================

async function loadInventory() {
    try {
        console.log('[P3K] Loading inventory...');
        state.inventory = await getAllItemsFromDB();
        console.log(`[P3K] Loaded ${state.inventory.length} items`);
        applyFilters();
    } catch (error) {
        console.error('[P3K] Failed to load inventory:', error);
        showToast('Gagal memuat data', 'error');
        state.inventory = [];
    }
}

function applyFilters() {
    let filtered = [...state.inventory];
    
    // Category filter
    if (state.currentFilter !== 'all') {
        filtered = filtered.filter(item => item.category === state.currentFilter);
    }
    
    // Search filter
    if (state.searchQuery) {
        const query = state.searchQuery.toLowerCase();
        filtered = filtered.filter(item => 
            item.name && item.name.toLowerCase().includes(query) ||
            (item.notes && item.notes.toLowerCase().includes(query))
        );
    }
    
    // Sort by expiry (expired first), then by name
    filtered.sort((a, b) => {
        const statusA = getExpiryStatus(a.expiry).sortOrder;
        const statusB = getExpiryStatus(b.expiry).sortOrder;
        if (statusA !== statusB) return statusA - statusOrder;
        return (a.name || '').localeCompare(b.name || '');
    });
    
    state.filteredInventory = filtered;
    renderInventory();
    updateStats();
}

function renderInventory() {
    if (!elements.inventoryList) return;
    
    if (state.filteredInventory.length === 0) {
        elements.inventoryList.innerHTML = '';
        if (elements.emptyState) {
            elements.emptyState.hidden = false;
        }
        return;
    }
    
    if (elements.emptyState) {
        elements.emptyState.hidden = true;
    }
    
    elements.inventoryList.innerHTML = state.filteredInventory.map(item => {
        const status = getExpiryStatus(item.expiry);
        const categoryIcon = getCategoryIcon(item.category);
        
        return `
            <article class="item-card status-${status.class}" data-id="${escapeHtml(item.id)}" role="listitem">
                <div class="item-header">
                    <div class="item-main">
                        <h3 class="item-name">
                            <span aria-hidden="true">${categoryIcon}</span>
                            ${escapeHtml(item.name || 'Unnamed')}
                        </h3>
                        <span class="item-category">${escapeHtml(item.category || 'Lainnya')}</span>
                        ${item.notes ? `<p style="font-size: 0.875rem; color: #6B7280; margin-top: 4px;">${escapeHtml(item.notes)}</p>` : ''}
                    </div>
                    <div class="item-quantity">
                        <button type="button" class="qty-btn-sm minus" onclick="window.app.updateQuantity('${escapeHtml(item.id)}', -1)" aria-label="Kurangi jumlah">−</button>
                        <span class="qty-value" aria-label="Jumlah: ${item.quantity || 0}">${item.quantity || 0}</span>
                        <button type="button" class="qty-btn-sm plus" onclick="window.app.updateQuantity('${escapeHtml(item.id)}', 1)" aria-label="Tambah jumlah">+</button>
                    </div>
                </div>
                <div class="item-footer">
                    <div class="item-meta">
                        ${item.expiry ? `
                            <span class="expiry-badge status-${status.class}">
                                <span aria-hidden="true">${status.icon}</span>
                                ${escapeHtml(status.text)}
                            </span>
                        ` : '<span class="expiry-badge status-good">♾️ Tidak ada expired</span>'}
                    </div>
                    <div class="item-actions">
                        <button type="button" class="action-btn" onclick="window.app.editItem('${escapeHtml(item.id)}')" aria-label="Edit ${escapeHtml(item.name || 'item')}">
                            ✏️
                        </button>
                        <button type="button" class="action-btn delete" onclick="window.app.confirmDeleteItem('${escapeHtml(item.id)}')" aria-label="Hapus ${escapeHtml(item.name || 'item')}">
                            🗑️
                        </button>
                    </div>
                </div>
            </article>
        `;
    }).join('');
}

function getExpiryStatus(expiry) {
    if (!expiry) {
        return { class: 'good', text: 'Tidak ada expired', icon: '♾️', sortOrder: 3 };
    }
    
    const now = new Date();
    const exp = new Date(expiry);
    const diff = exp - now;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (days < 0) {
        return { 
            class: 'danger', 
            text: `Expired ${Math.abs(days)} hari lalu`, 
            icon: '⚠️',
            sortOrder: 1 
        };
    } else if (days < 30) {
        return { 
            class: 'warning', 
            text: `Expired dalam ${days} hari`, 
            icon: '⏰',
            sortOrder: 2 
        };
    } else {
        return { 
            class: 'good', 
            text: `Expired ${formatDate(expiry)}`, 
            icon: '✓',
            sortOrder: 3 
        };
    }
}

function getCategoryIcon(category) {
    const icons = {
        'Obat': '💊',
        'Perban': '🩹',
        'Alat': '🔧',
        'Antiseptik': '🧼',
        'Lainnya': '📦'
    };
    return icons[category] || '📦';
}

// ============================================================
// CRUD OPERATIONS
// ============================================================

async function handleFormSubmit(e) {
    e.preventDefault();
    
    if (!elements.itemName || !elements.itemCategory) {
        showToast('Form tidak lengkap', 'error');
        return;
    }
    
    const item = {
        id: elements.itemId?.value || 'p3k_' + Date.now(),
        name: elements.itemName.value.trim(),
        category: elements.itemCategory.value,
        quantity: parseInt(elements.itemQuantity?.value) || 0,
        expiry: elements.itemExpiry?.value || null,
        notes: elements.itemNotes?.value?.trim() || '',
        updatedAt: new Date().toISOString(),
        synced: false
    };
    
    if (!item.name) {
        showToast('Nama item wajib diisi', 'error');
        return;
    }
    
    try {
        console.log('[P3K] Saving item:', item.id);
        await saveItemToDB(item);
        
        // Update local state
        const existingIndex = state.inventory.findIndex(i => i.id === item.id);
        if (existingIndex >= 0) {
            state.inventory[existingIndex] = item;
        } else {
            state.inventory.push(item);
        }
        
        // Add to sync queue
        await addToSyncQueue({
            type: existingIndex >= 0 ? 'UPDATE' : 'CREATE',
            data: item
        });
        
        applyFilters();
        closeAllModals();
        showToast(existingIndex >= 0 ? 'Item diperbarui' : 'Item ditambahkan', 'success');
        
        // Sync if online
        if (state.isOnline && CONFIG.GOOGLE_SHEETS_URL) {
            syncWithGoogleSheets();
        }
    } catch (error) {
        console.error('[P3K] Save failed:', error);
        showToast('Gagal menyimpan: ' + error.message, 'error');
    }
}

async function updateQuantity(id, change) {
    const item = state.inventory.find(i => i.id === id);
    if (!item) {
        console.warn('[P3K] Item not found:', id);
        return;
    }
    
    const newQty = (item.quantity || 0) + change;
    if (newQty < 0) return;
    
    item.quantity = newQty;
    item.updatedAt = new Date().toISOString();
    item.synced = false;
    
    try {
        await saveItemToDB(item);
        await addToSyncQueue({
            type: 'UPDATE',
            data: { id: item.id, quantity: item.quantity, updatedAt: item.updatedAt }
        });
        
        applyFilters();
        
        if (state.isOnline && CONFIG.GOOGLE_SHEETS_URL) {
            syncWithGoogleSheets();
        }
    } catch (error) {
        console.error('[P3K] Update quantity failed:', error);
        showToast('Gagal update jumlah', 'error');
    }
}

function editItem(id) {
    const item = state.inventory.find(i => i.id === id);
    if (!item) {
        console.warn('[P3K] Item not found for edit:', id);
        return;
    }
    
    if (elements.itemId) elements.itemId.value = item.id;
    if (elements.itemName) elements.itemName.value = item.name || '';
    if (elements.itemCategory) elements.itemCategory.value = item.category || 'Lainnya';
    if (elements.itemQuantity) elements.itemQuantity.value = item.quantity || 0;
    if (elements.itemExpiry) elements.itemExpiry.value = item.expiry || '';
    if (elements.itemNotes) elements.itemNotes.value = item.notes || '';
    if (elements.modalTitle) elements.modalTitle.textContent = 'Edit Item';
    
    openModal();
}

function confirmDeleteItem(id) {
    state.deleteId = id;
    if (elements.deleteModal) {
        elements.deleteModal.hidden = false;
    }
}

async function confirmDelete() {
    if (!state.deleteId) return;
    
    try {
        console.log('[P3K] Deleting item:', state.deleteId);
        await deleteItemFromDB(state.deleteId);
        await addToSyncQueue({
            type: 'DELETE',
            data: { id: state.deleteId }
        });
        
        state.inventory = state.inventory.filter(i => i.id !== state.deleteId);
        applyFilters();
        closeAllModals();
        showToast('Item dihapus', 'success');
        
        if (state.isOnline && CONFIG.GOOGLE_SHEETS_URL) {
            syncWithGoogleSheets();
        }
    } catch (error) {
        console.error('[P3K] Delete failed:', error);
        showToast('Gagal menghapus: ' + error.message, 'error');
    } finally {
        state.deleteId = null;
    }
}

// ============================================================
// UI HELPERS
// ============================================================

function openModal() {
    if (elements.itemModal) {
        elements.itemModal.hidden = false;
    }
    if (elements.itemName) {
        setTimeout(() => elements.itemName.focus(), 100);
    }
}

function closeAllModals() {
    if (elements.itemModal) elements.itemModal.hidden = true;
    if (elements.deleteModal) elements.deleteModal.hidden = true;
    if (elements.itemForm) elements.itemForm.reset();
    if (elements.itemId) elements.itemId.value = '';
    if (elements.modalTitle) elements.modalTitle.textContent = 'Tambah Item';
    state.editingId = null;
    state.deleteId = null;
}

function handleSearch(e) {
    state.searchQuery = e.target.value || '';
    applyFilters();
}

function handleFilterClick(e) {
    if (!e.target.classList.contains('chip')) return;
    
    document.querySelectorAll('.chip').forEach(chip => {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
    });
    
    e.target.classList.add('active');
    e.target.setAttribute('aria-pressed', 'true');
    
    state.currentFilter = e.target.dataset.category || 'all';
    applyFilters();
}

function switchView(view) {
    state.currentView = view;
    
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === view);
    });
    
    // TODO: Implement view switching logic
    console.log('[P3K] Switched to view:', view);
}

function updateStats() {
    if (!elements.statTotal || !elements.statExpiring || !elements.statExpired) return;
    
    const now = new Date();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    
    let expiring = 0;
    let expired = 0;
    
    state.inventory.forEach(item => {
        if (item.expiry) {
            const exp = new Date(item.expiry);
            const diff = exp - now;
            if (diff < 0) expired++;
            else if (diff < thirtyDays) expiring++;
        }
    });
    
    elements.statTotal.textContent = state.inventory.length;
    elements.statExpiring.textContent = expiring;
    elements.statExpired.textContent = expired;
    
    // Show alert if needed
    if (elements.alertContainer) {
        if (expired > 0 || expiring > 0) {
            elements.alertContainer.innerHTML = `
                <div class="alert ${expired > 0 ? 'alert-danger' : 'alert-warning'}">
                    <span class="alert-icon" aria-hidden="true">⚠️</span>
                    <div class="alert-content">
                        <div class="alert-title">Perhatian!</div>
                        <div class="alert-text">
                            ${expired > 0 ? `${expired} item expired. ` : ''}
                            ${expiring > 0 ? `${expiring} item akan expired dalam 30 hari.` : ''}
                        </div>
                    </div>
                </div>
            `;
        } else {
            elements.alertContainer.innerHTML = '';
        }
    }
}

function updateConnectionStatus() {
    if (!elements.connectionStatus) return;
    
    const iconEl = elements.connectionStatus.querySelector('.status-icon');
    const textEl = elements.connectionStatus.querySelector('.status-text');
    
    if (state.isOnline) {
        elements.connectionStatus.className = 'connection-status online';
        if (textEl) textEl.textContent = 'Online';
    } else {
        elements.connectionStatus.className = 'connection-status offline';
        if (textEl) textEl.textContent = 'Offline';
    }
}

function updateUI() {
    updateStats();
    updateConnectionStatus();
}

function showToast(message, type = 'default') {
    if (!elements.toast) {
        alert(message); // Fallback
        return;
    }
    
    const iconEl = elements.toast.querySelector('.toast-icon');
    const messageEl = elements.toast.querySelector('.toast-message');
    
    // Set icon based on type
    const icons = {
        success: '✓',
        error: '✕',
        warning: '⚠️',
        default: 'ℹ️'
    };
    if (iconEl) iconEl.textContent = icons[type] || icons.default;
    if (messageEl) messageEl.textContent = message;
    
    elements.toast.className = `toast ${type}`;
    elements.toast.hidden = false;
    
    // Trigger reflow
    elements.toast.offsetHeight;
    elements.toast.classList.add('show');
    
    // Auto hide
    setTimeout(() => {
        elements.toast.classList.remove('show');
        setTimeout(() => {
            elements.toast.hidden = true;
        }, 300);
    }, 3000);
}

function checkExpiringItems() {
    // Check every hour
    setInterval(() => {
        updateStats();
    }, 3600000);
}

// ============================================================
// GOOGLE SHEETS SYNC
// ============================================================

async function syncWithGoogleSheets() {
    if (!CONFIG.GOOGLE_SHEETS_URL) {
        console.log('[P3K] Google Sheets URL not configured');
        return;
    }
    if (!state.isOnline) {
        console.log('[P3K] Cannot sync: offline');
        return;
    }
    if (state.isSyncing) {
        console.log('[P3K] Sync already in progress');
        return;
    }
    
    state.isSyncing = true;
    if (elements.syncBtn) {
        elements.syncBtn.classList.add('syncing');
    }
    
    try {
        console.log('[P3K] Starting sync...');
        
        // Get sync queue
        const queue = await getSyncQueue();
        console.log(`[P3K] Processing ${queue.length} queued items`);
        
        // Process queue
        for (const item of queue) {
            try {
                await syncItem(item);
                await removeFromSyncQueue(item.timestamp);
            } catch (error) {
                console.error('[P3K] Sync failed for item:', item, error);
                // Continue with next item
            }
        }
        
        // Fetch updates from server
        await fetchUpdates();
        
        showToast('Sinkronisasi berhasil', 'success');
    } catch (error) {
        console.error('[P3K] Sync error:', error);
        showToast('Gagal sinkronisasi: ' + error.message, 'error');
    } finally {
        state.isSyncing = false;
        if (elements.syncBtn) {
            elements.syncBtn.classList.remove('syncing');
        }
    }
}

async function syncItem(queueItem) {
    const response = await fetch(CONFIG.GOOGLE_SHEETS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            action: queueItem.action.type.toLowerCase(),
            data: queueItem.action.data
        })
    });
    
    if (!response.ok) throw new Error('HTTP ' + response.status);
    
    const result = await response.json();
    if (!result.success) throw new Error(result.message);
}

async function fetchUpdates() {
    const response = await fetch(`${CONFIG.GOOGLE_SHEETS_URL}?action=getAll`);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    
    const result = await response.json();
    if (!result.success) throw new Error(result.message);
    
    // Merge server data with local
    const serverData = result.data || [];
    for (const serverItem of serverData) {
        const localItem = state.inventory.find(i => i.id === serverItem.id);
        if (!localItem || new Date(serverItem.updatedAt) > new Date(localItem.updatedAt)) {
            await saveItemToDB({ ...serverItem, synced: true });
        }
    }
    
    await loadInventory();
}

// ============================================================
// EXPORT/IMPORT & UTILITIES
// ============================================================

function exportData() {
    if (state.inventory.length === 0) {
        showToast('Tidak ada data untuk diekspor', 'warning');
        return;
    }
    
    const data = {
        app: CONFIG.APP_NAME,
        version: CONFIG.VERSION,
        exportedAt: new Date().toISOString(),
        items: state.inventory
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `p3k_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    showToast('Data berhasil diekspor', 'success');
}

function showExpiring() {
    state.currentFilter = 'all';
    state.searchQuery = '';
    if (elements.searchInput) elements.searchInput.value = '';
    
    // Sort by expiry date
    state.filteredInventory.sort((a, b) => {
        if (!a.expiry) return 1;
        if (!b.expiry) return -1;
        return new Date(a.expiry) - new Date(b.expiry);
    });
    
    renderInventory();
    showToast('Diurutkan berdasarkan tanggal expired', 'success');
}

function showChecklist() {
    showToast('Fitur checklist akan segera hadir', 'success');
}

function showGuide() {
    showToast('Fitur panduan akan segera hadir', 'success');
}

async function installApp() {
    if (!state.deferredInstall) {
        showToast('Install tidak tersedia di browser ini', 'warning');
        return;
    }
    
    state.deferredInstall.prompt();
    const { outcome } = await state.deferredInstall.userChoice;
    
    if (outcome === 'accepted') {
        showToast('Aplikasi berhasil diinstall', 'success');
    }
    
    state.deferredInstall = null;
    if (elements.installPrompt) {
        elements.installPrompt.hidden = true;
    }
}

function dismissInstallPrompt() {
    if (elements.installPrompt) {
        elements.installPrompt.hidden = true;
    }
}

// ============================================================
// UTILITIES
// ============================================================

function escapeHtml(text) {
    if (text === null || text === undefined) return '';
    const str = String(text);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function formatDate(dateStr) {
    try {
        return new Date(dateStr).toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'short',
            year: 'numeric'
        });
    } catch (e) {
        return dateStr;
    }
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func.apply(this, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// ============================================================
// EXPOSE PUBLIC API
// ============================================================

window.P3KApp = {
    // State
    getState: () => ({ ...state }),
    getConfig: () => ({ ...CONFIG }),
    
    // Methods
    refresh: loadInventory,
    sync: syncWithGoogleSheets,
    export: exportData,
    showExpiring,
    showChecklist,
    showGuide,
    
    // CRUD
    updateQuantity,
    editItem,
    confirmDeleteItem,
    openModal,
    closeAllModals
};

// Legacy global access for onclick handlers
window.app = window.P3KApp;

console.log('[P3K] Application script loaded');
