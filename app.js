/**
 * ============================================================
 * P3K STOCK MANAGER - MAIN APPLICATION
 * Progressive Web App with offline support
 * ============================================================
 */

'use strict';

// Application Configuration
const CONFIG = {
    APP_NAME: 'P3K Stock Manager',
    VERSION: '2.0.0',
    DB_NAME: 'P3KDatabase',
    DB_VERSION: 1,
    STORE_NAME: 'inventory',
    SYNC_STORE: 'syncQueue',
    GOOGLE_SHEETS_URL: localStorage.getItem('p3k_sheets_url') || '',
    SYNC_INTERVAL: 5 * 60 * 1000, // 5 minutes
    ITEMS_PER_PAGE: 20
};

// State Management
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
    deferredInstall: null
};

// DOM Elements Cache
const elements = {};

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async () => {
    cacheElements();
    bindEvents();
    await initDatabase();
    await loadInventory();
    updateUI();
    checkExpiringItems();
    
    // Hide loading screen
    setTimeout(() => {
        document.getElementById('loading-screen').classList.add('hidden');
    }, 500);
    
    // Setup periodic sync
    setInterval(() => {
        if (state.isOnline) syncWithGoogleSheets();
    }, CONFIG.SYNC_INTERVAL);
});

function cacheElements() {
    // Main containers
    elements.inventoryList = document.getElementById('inventory-list');
    elements.emptyState = document.getElementById('empty-state');
    elements.alertContainer = document.getElementById('alert-container');
    elements.toast = document.getElementById('toast');
    
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
    
    // Install prompt
    elements.installPrompt = document.getElementById('install-prompt');
    elements.installBtn = document.getElementById('install-btn');
    elements.dismissInstall = document.getElementById('dismiss-install');
}

function bindEvents() {
    // Navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => switchView(e.currentTarget.dataset.view));
    });
    
    // Add button
    elements.addBtn.addEventListener('click', openModal);
    
    // Sync button
    elements.syncBtn.addEventListener('click', () => syncWithGoogleSheets());
    
    // Modal close buttons
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', closeAllModals);
    });
    
    // Form submission
    elements.itemForm.addEventListener('submit', handleFormSubmit);
    
    // Quantity buttons
    document.querySelectorAll('.qty-btn').forEach(btn => {
        btn.addEventListener('click', handleQuantityChange);
    });
    
    // Search
    elements.searchInput.addEventListener('input', debounce(handleSearch, 300));
    
    // Filter chips
    elements.filterChips.addEventListener('click', handleFilterClick);
    
    // Delete confirmation
    document.getElementById('confirm-delete').addEventListener('click', confirmDelete);
    
    // Online/Offline events
    window.addEventListener('online', () => {
        state.isOnline = true;
        updateConnectionStatus();
        showToast('Koneksi online', 'success');
        syncWithGoogleSheets();
    });
    
    window.addEventListener('offline', () => {
        state.isOnline = false;
        updateConnectionStatus();
        showToast('Mode offline - data disimpan lokal', 'warning');
    });
    
    // Install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        state.deferredInstall = e;
        elements.installPrompt.hidden = false;
    });
    
    elements.installBtn.addEventListener('click', installApp);
    elements.dismissInstall.addEventListener('click', () => {
        elements.installPrompt.hidden = true;
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAllModals();
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            openModal();
        }
    });
}

// ============================================================
// DATABASE (IndexedDB)
// ============================================================

let db = null;

function initDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // Main inventory store
            if (!database.objectStoreNames.contains(CONFIG.STORE_NAME)) {
                const store = database.createObjectStore(CONFIG.STORE_NAME, { keyPath: 'id' });
                store.createIndex('category', 'category', { unique: false });
                store.createIndex('expiry', 'expiry', { unique: false });
            }
            
            // Sync queue store
            if (!database.objectStoreNames.contains(CONFIG.SYNC_STORE)) {
                database.createObjectStore(CONFIG.SYNC_STORE, { keyPath: 'timestamp' });
            }
        };
    });
}

function dbOperation(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([storeName], mode);
        const store = transaction.objectStore(storeName);
        const request = operation(store);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveItem(item) {
    await dbOperation(CONFIG.STORE_NAME, 'readwrite', (store) => store.put(item));
}

async function deleteItemFromDB(id) {
    await dbOperation(CONFIG.STORE_NAME, 'readwrite', (store) => store.delete(id));
}

async function getAllItems() {
    return await dbOperation(CONFIG.STORE_NAME, 'readonly', (store) => store.getAll());
}

async function addToSyncQueue(action) {
    const queueItem = {
        timestamp: Date.now(),
        action: action,
        retries: 0
    };
    await dbOperation(CONFIG.SYNC_STORE, 'readwrite', (store) => store.put(queueItem));
}

async function getSyncQueue() {
    return await dbOperation(CONFIG.SYNC_STORE, 'readonly', (store) => store.getAll());
}

async function removeFromSyncQueue(timestamp) {
    await dbOperation(CONFIG.SYNC_STORE, 'readwrite', (store) => store.delete(timestamp));
}

// ============================================================
// INVENTORY MANAGEMENT
// ============================================================

async function loadInventory() {
    try {
        state.inventory = await getAllItems();
        applyFilters();
    } catch (error) {
        console.error('Failed to load inventory:', error);
        showToast('Gagal memuat data', 'error');
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
            item.name.toLowerCase().includes(query) ||
            (item.notes && item.notes.toLowerCase().includes(query))
        );
    }
    
    // Sort by expiry (expired first), then by name
    filtered.sort((a, b) => {
        const statusA = getExpiryStatus(a.expiry).sortOrder;
        const statusB = getExpiryStatus(b.expiry).sortOrder;
        if (statusA !== statusB) return statusA - statusB;
        return a.name.localeCompare(b.name);
    });
    
    state.filteredInventory = filtered;
    renderInventory();
    updateStats();
}

function renderInventory() {
    if (state.filteredInventory.length === 0) {
        elements.inventoryList.innerHTML = '';
        elements.emptyState.hidden = false;
        return;
    }
    
    elements.emptyState.hidden = true;
    
    elements.inventoryList.innerHTML = state.filteredInventory.map(item => {
        const status = getExpiryStatus(item.expiry);
        const categoryIcon = getCategoryIcon(item.category);
        
        return `
            <article class="item-card status-${status.class}" data-id="${item.id}" role="listitem">
                <div class="item-header">
                    <div class="item-main">
                        <h3 class="item-name">
                            <span aria-hidden="true">${categoryIcon}</span>
                            ${escapeHtml(item.name)}
                        </h3>
                        <span class="item-category">${item.category}</span>
                        ${item.notes ? `<p class="text-sm text-gray-600 mt-1">${escapeHtml(item.notes)}</p>` : ''}
                    </div>
                    <div class="item-quantity">
                        <button class="qty-btn-sm minus" onclick="app.updateQuantity('${item.id}', -1)" aria-label="Kurangi jumlah">−</button>
                        <span class="qty-value" aria-label="Jumlah: ${item.quantity}">${item.quantity}</span>
                        <button class="qty-btn-sm plus" onclick="app.updateQuantity('${item.id}', 1)" aria-label="Tambah jumlah">+</button>
                    </div>
                </div>
                <div class="item-footer">
                    <div class="item-meta">
                        ${item.expiry ? `
                            <span class="expiry-badge status-${status.class}">
                                <span aria-hidden="true">${status.icon}</span>
                                ${status.text}
                            </span>
                        ` : '<span class="expiry-badge status-good">♾️ Tidak ada expired</span>'}
                    </div>
                    <div class="item-actions">
                        <button class="action-btn" onclick="app.editItem('${item.id}')" aria-label="Edit ${item.name}">
                            ✏️
                        </button>
                        <button class="action-btn delete" onclick="app.confirmDeleteItem('${item.id}')" aria-label="Hapus ${item.name}">
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
    
    const item = {
        id: elements.itemId.value || 'p3k_' + Date.now(),
        name: elements.itemName.value.trim(),
        category: elements.itemCategory.value,
        quantity: parseInt(elements.itemQuantity.value) || 0,
        expiry: elements.itemExpiry.value || null,
        notes: elements.itemNotes.value.trim(),
        updatedAt: new Date().toISOString(),
        synced: false
    };
    
    try {
        await saveItem(item);
        
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
        if (state.isOnline) {
            syncWithGoogleSheets();
        }
    } catch (error) {
        console.error('Save failed:', error);
        showToast('Gagal menyimpan', 'error');
    }
}

async function updateQuantity(id, change) {
    const item = state.inventory.find(i => i.id === id);
    if (!item) return;
    
    const newQty = item.quantity + change;
    if (newQty < 0) return;
    
    item.quantity = newQty;
    item.updatedAt = new Date().toISOString();
    item.synced = false;
    
    await saveItem(item);
    await addToSyncQueue({
        type: 'UPDATE',
        data: { id: item.id, quantity: item.quantity, updatedAt: item.updatedAt }
    });
    
    applyFilters();
    
    if (state.isOnline) {
        syncWithGoogleSheets();
    }
}

function editItem(id) {
    const item = state.inventory.find(i => i.id === id);
    if (!item) return;
    
    elements.itemId.value = item.id;
    elements.itemName.value = item.name;
    elements.itemCategory.value = item.category;
    elements.itemQuantity.value = item.quantity;
    elements.itemExpiry.value = item.expiry || '';
    elements.itemNotes.value = item.notes || '';
    
    document.getElementById('modal-title').textContent = 'Edit Item';
    openModal();
}

function confirmDeleteItem(id) {
    state.deleteId = id;
    elements.deleteModal.hidden = false;
}

async function confirmDelete() {
    if (!state.deleteId) return;
    
    try {
        await deleteItemFromDB(state.deleteId);
        await addToSyncQueue({
            type: 'DELETE',
            data: { id: state.deleteId }
        });
        
        state.inventory = state.inventory.filter(i => i.id !== state.deleteId);
        applyFilters();
        closeAllModals();
        showToast('Item dihapus', 'success');
        
        if (state.isOnline) {
            syncWithGoogleSheets();
        }
    } catch (error) {
        showToast('Gagal menghapus', 'error');
    } finally {
        state.deleteId = null;
    }
}

// ============================================================
// UI HELPERS
// ============================================================

function openModal() {
    if (!elements.itemId.value) {
        // Reset form for new item
        elements.itemForm.reset();
        elements.itemId.value = '';
        document.getElementById('modal-title').textContent = 'Tambah Item';
    }
    elements.itemModal.hidden = false;
    elements.itemName.focus();
}

function closeAllModals() {
    elements.itemModal.hidden = true;
    elements.deleteModal.hidden = true;
    elements.itemForm.reset();
    elements.itemId.value = '';
    state.editingId = null;
}

function handleQuantityChange(e) {
    const input = elements.itemQuantity;
    let value = parseInt(input.value) || 0;
    
    if (e.target.classList.contains('minus')) {
        value = Math.max(0, value - 1);
    } else if (e.target.classList.contains('plus')) {
        value = Math.min(9999, value + 1);
    }
    
    input.value = value;
}

function handleSearch(e) {
    state.searchQuery = e.target.value;
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
    
    state.currentFilter = e.target.dataset.category;
    applyFilters();
}

function switchView(view) {
    state.currentView = view;
    
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === view);
    });
    
    // TODO: Implement view switching logic
    showToast(`View: ${view}`, 'success');
}

function updateStats() {
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

function updateConnectionStatus() {
    const statusEl = document.getElementById('connection-status');
    const iconEl = statusEl.querySelector('.status-icon');
    const textEl = statusEl.querySelector('.status-text');
    
    if (state.isOnline) {
        statusEl.className = 'connection-status online';
        textEl.textContent = 'Online';
    } else {
        statusEl.className = 'connection-status offline';
        textEl.textContent = 'Offline';
    }
}

function showToast(message, type = 'default') {
    const toast = elements.toast;
    toast.className = `toast ${type}`;
    toast.querySelector('.toast-message').textContent = message;
    toast.hidden = false;
    
    // Trigger reflow
    toast.offsetHeight;
    
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.hidden = true;
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
    if (!CONFIG.GOOGLE_SHEETS_URL || !state.isOnline || state.isSyncing) return;
    
    state.isSyncing = true;
    elements.syncBtn.classList.add('syncing');
    
    try {
        // Get sync queue
        const queue = await getSyncQueue();
        
        // Process queue
        for (const item of queue) {
            try {
                await syncItem(item);
                await removeFromSyncQueue(item.timestamp);
            } catch (error) {
                console.error('Sync failed for item:', item, error);
                // Retry logic could be implemented here
            }
        }
        
        // Fetch updates from server
        await fetchUpdates();
        
        showToast('Sinkronisasi berhasil', 'success');
    } catch (error) {
        console.error('Sync error:', error);
        showToast('Gagal sinkronisasi', 'error');
    } finally {
        state.isSyncing = false;
        elements.syncBtn.classList.remove('syncing');
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
    const serverData = result.data;
    for (const serverItem of serverData) {
        const localItem = state.inventory.find(i => i.id === serverItem.id);
        if (!localItem || new Date(serverItem.updatedAt) > new Date(localItem.updatedAt)) {
            await saveItem({ ...serverItem, synced: true });
        }
    }
    
    await loadInventory();
}

// ============================================================
// EXPORT/IMPORT
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
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Data berhasil diekspor', 'success');
}

function showExpiring() {
    state.currentFilter = 'all';
    // Sort by expiry
    state.filteredInventory.sort((a, b) => {
        if (!a.expiry) return 1;
        if (!b.expiry) return -1;
        return new Date(a.expiry) - new Date(b.expiry);
    });
    renderInventory();
    showToast('Menampilkan item berdasarkan tanggal expired', 'success');
}

function showChecklist() {
    showToast('Fitur checklist akan segera hadir', 'success');
}

function showGuide() {
    showToast('Fitur panduan akan segera hadir', 'success');
}

// ============================================================
// PWA INSTALL
// ============================================================

async function installApp() {
    if (!state.deferredInstall) return;
    
    state.deferredInstall.prompt();
    const { outcome } = await state.deferredInstall.userChoice;
    
    if (outcome === 'accepted') {
        showToast('Aplikasi berhasil diinstall', 'success');
        elements.installPrompt.hidden = true;
    }
    
    state.deferredInstall = null;
}

// ============================================================
// UTILITIES
// ============================================================

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr) {
    return new Date(dateStr).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
    });
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

// Expose functions globally for onclick handlers
window.app = {
    updateQuantity,
    editItem,
    confirmDeleteItem,
    openModal,
    exportData,
    showExpiring,
    showChecklist,
    showGuide
};
