/**
 * STUDIO CARIFI COMMERCIALISTA — ORDINE DEI DOTTORI COMMERCIALISTI DI NOLA
 * Gestionale v4 — Sicurezza Massima Zero-Knowledge:
 *  - Protezione con Codice Numerico a 6 cifre + Crittografia Reale AES-256-GCM (PBKDF2-SHA256 310.000 iterazioni)
 *  - Archivio precaricato cifrato (ZERO dati clienti o PIN in chiaro nel codice sorgente)
 *  - Memoria locale cifrata AES-256-GCM + Sincronizzazione Cloud PC <-> iOS cifrata End-to-End (E2EE)
 *  - Anti-Brute-Force persistente, Blocco Automatico Inattività, Blocco Rapido e Privacy Blur
 *  - Routine di Notifiche personalizzabili e avvisi istantanei su iOS e PC
 */

const STORAGE_KEY_VAULT = 'studio_carifi_vault_v4';
const STORAGE_KEY_LOCKOUT = 'studio_carifi_lockout_v4';
const NTFY_ROOT_URL = 'https://ntfy.sh';
const PBKDF2_DEFAULT_ITER = 310000;

// Identificativo univoco della sessione dispositivo corrente
const DEVICE_SESSION_ID = 'dev-' + Math.random().toString(36).substring(2, 10);
const BASE_DOCUMENT_TITLE = document.title;

// Stato Sicurezza (TENUTO SOLO IN RAM — mai salvato in chiaro in storage!)
let isAppUnlocked = false;
let vaultCryptoKey = null;
let vaultSaltB64 = null;
let vaultIter = PBKDF2_DEFAULT_ITER;
let vaultDatasetVersion = null;
let initialItemsRamCache = null;
let vaultWriteChain = Promise.resolve();

let pinBuffer = '';
let isVerifyingPin = false;
let lockoutCountdownTimer = null;
let inactivityLockTimer = null;
let appBootstrapped = false;

// Stato globale dell'applicazione
let items = [];
let deletedIds = {};
let currentFilter = 'all';
let currentViewMode = 'cards'; // 'cards' | 'table' | 'calendar'
let visibleLimit = 30;
let selectedCalendarDate = null; // 'YYYY-MM-DD' oppure null
let calendarCursor = new Date();

let cloudEventSource = null;
let audioCtx = null;
let wakeLockSentinel = null;
let tabBlinkTimer = null;
let tabBlinkState = false;
let searchDebounceTimer = null;
let lastFilteredItems = [];

// Stato Importatore Excel
let excelWorkbook = null;
let excelCurrentRows = [];
let excelHeaders = [];

// Canale broadcast tra schede aperte sullo stesso dispositivo
const localBroadcast = ('BroadcastChannel' in window) ? new BroadcastChannel('studio_carifi_sync_v4') : null;

// Routine di notifiche predefinite dello Studio Carifi (modificabili ed estendibili dall'app)
const DEFAULT_ROUTINES = [
  {
    id: 'routine-studio-carifi',
    name: 'Routine Studio Carifi (7gg, 3gg, poi 11:30 e 16:30)',
    intensity: 'high',
    preAlertDays: [
      { daysBefore: 7, time: '09:30' },
      { daysBefore: 3, time: '09:30' }
    ],
    dailyFromDays: 2,
    dailyTimes: ['11:30', '16:30'],
    minutesBeforeDue: 0
  },
  {
    id: 'routine-appuntamento-studio',
    name: 'Appuntamento Studio (1gg prima + 09:00 + 30m prima)',
    intensity: 'medium',
    preAlertDays: [
      { daysBefore: 1, time: '16:30' }
    ],
    dailyFromDays: 0,
    dailyTimes: ['09:00'],
    minutesBeforeDue: 30
  },
  {
    id: 'routine-urgenza-massima',
    name: 'Urgenza Massima (3gg, 1gg + 09:00, 11:30, 16:30)',
    intensity: 'high',
    preAlertDays: [
      { daysBefore: 3, time: '09:30' }
    ],
    dailyFromDays: 2,
    dailyTimes: ['09:00', '11:30', '16:30'],
    minutesBeforeDue: 60
  }
];

function createDefaultConfig() {
  return {
    syncTopic: '',
    pushEnabled: true,
    pushTopic: '',
    pushSchedule72h: true,
    soundProfile: 'institutional',
    tabBlink: true,
    vibrate: true,
    wakeLock: false,
    setupBannerDismissed: false,
    autoLockMinutes: 10,
    privacyPushMode: false,
    privacyBlurOnHide: true,
    defaultRoutineId: 'routine-studio-carifi',
    routines: JSON.parse(JSON.stringify(DEFAULT_ROUTINES))
  };
}

let appConfig = createDefaultConfig();

// ============================================================================
// MOTORE CRITTOGRAFICO ZERO-KNOWLEDGE (WEB CRYPTO API: AES-256-GCM + PBKDF2)
// ============================================================================
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveVaultKey(pin, saltB64, iterations = PBKDF2_DEFAULT_ITER) {
  const enc = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(String(pin)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltB64),
      iterations: Number(iterations) || PBKDF2_DEFAULT_ITER,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveSecretChannels(pin, saltB64) {
  const enc = new TextEncoder();
  const digest = await window.crypto.subtle.digest(
    'SHA-256',
    enc.encode(`studio-carifi-v4-channels:${pin}:${saltB64}`)
  );
  const hex = bytesToHex(new Uint8Array(digest));
  return {
    syncTopic: `sc-v4-s-${hex.slice(0, 24)}`,
    pushTopic: `sc-v4-p-${hex.slice(24, 48)}`
  };
}

async function encryptObjectWithKey(obj, cryptoKey) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const plainBytes = new TextEncoder().encode(JSON.stringify(obj));
  const ctBuf = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    plainBytes
  );
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ctBuf))
  };
}

async function decryptObjectWithKey(encObj, cryptoKey) {
  const plainBuf = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(encObj.iv) },
    cryptoKey,
    base64ToBytes(encObj.ct)
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

function purgeLegacyPlaintextStorage() {
  const legacyKeys = [
    'studio_carifi_items_v1',
    'studio_carifi_items_v2',
    'studio_carifi_items_v3',
    'studio_carifi_deleted_v2',
    'studio_carifi_deleted_v3',
    'studio_carifi_config_v1',
    'studio_carifi_config_v2',
    'studio_carifi_config_v3',
    'studio_carifi_v3_clean_reset_done',
    'studio_carifi_dataset_ver'
  ];
  legacyKeys.forEach((k) => {
    try { localStorage.removeItem(k); } catch (_) {}
  });
}

// ============================================================================
// SCHERMATA DI BLOCCO PIN (6 CIFRE) & PROTEZIONE ANTI-BRUTE-FORCE
// ============================================================================
function getLockoutState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_LOCKOUT);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return { fails: 0, lockedUntil: 0 };
}

function setLockoutState(state) {
  try {
    localStorage.setItem(STORAGE_KEY_LOCKOUT, JSON.stringify(state));
  } catch (_) {}
}

function updatePinDotsUI(state = 'normal') {
  const dots = document.querySelectorAll('#pinDotsContainer .pin-dot');
  dots.forEach((dot, idx) => {
    dot.classList.remove('filled', 'error', 'success');
    if (state === 'error') {
      dot.classList.add('error');
    } else if (state === 'success') {
      dot.classList.add('success');
    } else if (idx < pinBuffer.length) {
      dot.classList.add('filled');
    }
  });
}

function setPinStatusMessage(msg, isSuccess = false) {
  const el = document.getElementById('pinStatusMessage');
  if (!el) return;
  el.textContent = msg || '';
  el.className = `text-xs font-semibold min-h-[1.25rem] ${isSuccess ? 'text-emerald-300' : 'text-red-300'}`;
}

function checkLockoutCountdownUI() {
  const st = getLockoutState();
  const remainingMs = (st.lockedUntil || 0) - Date.now();
  const keypad = document.getElementById('pinKeypadGrid');

  if (remainingMs > 0) {
    if (keypad) keypad.classList.add('opacity-40', 'pointer-events-none');
    const sec = Math.ceil(remainingMs / 1000);
    setPinStatusMessage(`Troppi tentativi errati. Riprova tra ${sec}s.`);
    if (!lockoutCountdownTimer) {
      lockoutCountdownTimer = setInterval(() => {
        checkLockoutCountdownUI();
      }, 500);
    }
    return true;
  }

  if (lockoutCountdownTimer) {
    clearInterval(lockoutCountdownTimer);
    lockoutCountdownTimer = null;
  }
  if (keypad) keypad.classList.remove('opacity-40', 'pointer-events-none');
  if (!isVerifyingPin) setPinStatusMessage('');
  return false;
}

function handlePinDigit(digit) {
  if (isAppUnlocked || isVerifyingPin) return;
  if (checkLockoutCountdownUI()) return;
  if (pinBuffer.length >= 6) return;

  pinBuffer += String(digit);
  updatePinDotsUI('normal');
  setPinStatusMessage('');

  if (pinBuffer.length === 6) {
    attemptPinUnlock(pinBuffer);
  }
}

function backspacePinEntry() {
  if (isAppUnlocked || isVerifyingPin) return;
  if (pinBuffer.length === 0) return;
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDotsUI('normal');
}

function clearPinEntry() {
  if (isAppUnlocked || isVerifyingPin) return;
  pinBuffer = '';
  updatePinDotsUI('normal');
  setPinStatusMessage('');
}

async function attemptPinUnlock(pin) {
  if (!window.crypto || !window.crypto.subtle) {
    setPinStatusMessage('Web Crypto richiede HTTPS (Vercel) o localhost.');
    pinBuffer = '';
    updatePinDotsUI('normal');
    return;
  }

  if (checkLockoutCountdownUI()) return;
  isVerifyingPin = true;
  setPinStatusMessage('Verifica crittografica AES-256-GCM...', true);

  try {
    const preloadedVault = window.STUDIO_CARIFI_ENCRYPTED_VAULT || null;
    let storedVault = null;
    try {
      const rawStored = localStorage.getItem(STORAGE_KEY_VAULT);
      if (rawStored) storedVault = JSON.parse(rawStored);
    } catch (_) {}

    let decryptedItems = null;
    let decryptedDeleted = {};
    let decryptedConfig = null;
    let activeKey = null;
    let activeSalt = null;
    let activeIter = PBKDF2_DEFAULT_ITER;
    let activeDatasetVer = preloadedVault?.datasetVersion || 'v4';
    let needsInitialPersist = false;

    const useStoredVault = Boolean(
      storedVault &&
      storedVault.salt &&
      storedVault.iv &&
      storedVault.ct &&
      (!preloadedVault || storedVault.datasetVersion === preloadedVault.datasetVersion)
    );

    if (useStoredVault) {
      activeSalt = storedVault.salt;
      activeIter = storedVault.iter || PBKDF2_DEFAULT_ITER;
      activeKey = await deriveVaultKey(pin, activeSalt, activeIter);
      const data = await decryptObjectWithKey(storedVault, activeKey);
      decryptedItems = Array.isArray(data.items) ? data.items : [];
      decryptedDeleted = data.deletedIds || {};
      decryptedConfig = { ...createDefaultConfig(), ...(data.config || {}) };
      activeDatasetVer = storedVault.datasetVersion || activeDatasetVer;

      // Prova a decifrare anche il dataset precaricato in RAM per l'eventuale pulsante "Ricarica Scadenziario"
      if (preloadedVault && preloadedVault.ct) {
        try {
          const preKey = preloadedVault.salt === activeSalt
            ? activeKey
            : await deriveVaultKey(pin, preloadedVault.salt, preloadedVault.iter);
          const preDec = await decryptObjectWithKey(preloadedVault, preKey);
          initialItemsRamCache = Array.isArray(preDec.items) ? preDec.items : null;
        } catch (_) {
          initialItemsRamCache = null;
        }
      }
    } else if (preloadedVault && preloadedVault.ct) {
      activeSalt = preloadedVault.salt;
      activeIter = preloadedVault.iter || PBKDF2_DEFAULT_ITER;
      activeKey = await deriveVaultKey(pin, activeSalt, activeIter);
      const preDec = await decryptObjectWithKey(preloadedVault, activeKey);
      decryptedItems = Array.isArray(preDec.items) ? preDec.items : [];
      initialItemsRamCache = JSON.parse(JSON.stringify(decryptedItems));
      decryptedDeleted = {};
      decryptedConfig = createDefaultConfig();
      activeDatasetVer = preloadedVault.datasetVersion || 'v4';
      needsInitialPersist = true;
    } else {
      throw new Error('Vault non disponibile');
    }

    // Decifratura riuscita! Sblocca il gestionale
    setLockoutState({ fails: 0, lockedUntil: 0 });
    purgeLegacyPlaintextStorage();

    vaultCryptoKey = activeKey;
    vaultSaltB64 = activeSalt;
    vaultIter = activeIter;
    vaultDatasetVersion = activeDatasetVer;

    // Deriva canali crittografici riservati se non ancora impostati
    const derived = await deriveSecretChannels(pin, activeSalt);
    if (!decryptedConfig.syncTopic) decryptedConfig.syncTopic = derived.syncTopic;
    if (!decryptedConfig.pushTopic) decryptedConfig.pushTopic = derived.pushTopic;
    if (!Array.isArray(decryptedConfig.routines) || decryptedConfig.routines.length === 0) {
      decryptedConfig.routines = JSON.parse(JSON.stringify(DEFAULT_ROUTINES));
    }
    if (!decryptedConfig.defaultRoutineId || !decryptedConfig.routines.some((r) => r.id === decryptedConfig.defaultRoutineId)) {
      decryptedConfig.defaultRoutineId = decryptedConfig.routines[0].id;
    }

    appConfig = decryptedConfig;
    deletedIds = decryptedDeleted;
    items = decryptedItems.filter((it) => it && it.id && !deletedIds[it.id]);

    updatePinDotsUI('success');
    setPinStatusMessage('Accesso autorizzato • Archivio decifrato', true);

    if (needsInitialPersist) {
      await persistEncryptedVault(false);
    }

    setTimeout(() => {
      isAppUnlocked = true;
      isVerifyingPin = false;
      pinBuffer = '';
      document.getElementById('securityLockOverlay')?.classList.add('hidden');
      document.getElementById('appShell')?.classList.remove('hidden');
      document.body.classList.remove('privacy-blur-active');
      bootstrapUnlockedApp();
    }, 220);
  } catch (err) {
    // Codice errato (fallimento autenticazione AES-GCM)
    isVerifyingPin = false;
    const st = getLockoutState();
    const fails = (st.fails || 0) + 1;
    let lockedUntil = 0;
    if (fails >= 9) lockedUntil = Date.now() + 10 * 60 * 1000;
    else if (fails >= 7) lockedUntil = Date.now() + 2 * 60 * 1000;
    else if (fails >= 5) lockedUntil = Date.now() + 30 * 1000;

    setLockoutState({ fails, lockedUntil });
    updatePinDotsUI('error');

    const dotsBox = document.getElementById('pinDotsContainer');
    if (dotsBox) {
      dotsBox.classList.remove('animate-pin-shake');
      void dotsBox.offsetWidth;
      dotsBox.classList.add('animate-pin-shake');
    }

    setTimeout(() => {
      pinBuffer = '';
      updatePinDotsUI('normal');
      if (!checkLockoutCountdownUI()) {
        const left = Math.max(0, 5 - fails);
        setPinStatusMessage(
          left > 0
            ? `Codice errato (${left} ${left === 1 ? 'tentativo rimasto' : 'tentativi rimasti'} prima del blocco)`
            : 'Codice errato.'
        );
      }
    }, 450);
  }
}

function lockAppNow(reason = '') {
  if (!isAppUnlocked) return;
  isAppUnlocked = false;
  vaultCryptoKey = null;
  items = [];
  deletedIds = {};
  initialItemsRamCache = null;
  pinBuffer = '';

  if (cloudEventSource) {
    try { cloudEventSource.close(); } catch (_) {}
    cloudEventSource = null;
  }
  if (inactivityLockTimer) {
    clearTimeout(inactivityLockTimer);
    inactivityLockTimer = null;
  }
  updateTabBlinking(0);
  releaseWakeLock();

  // Svuota DOM da qualsiasi dato sensibile
  const itemsEl = document.getElementById('itemsContainer');
  if (itemsEl) itemsEl.innerHTML = '';
  const calEl = document.getElementById('calendarGrid');
  if (calEl) calEl.innerHTML = '';

  ['itemModal', 'planModal', 'settingsModal', 'excelImportModal', 'routineModal'].forEach((id) => {
    const m = document.getElementById(id);
    if (m) { m.classList.add('hidden'); m.classList.remove('flex'); }
  });

  document.getElementById('appShell')?.classList.add('hidden');
  document.getElementById('securityLockOverlay')?.classList.remove('hidden');
  document.body.classList.remove('privacy-blur-active');
  updatePinDotsUI('normal');
  setPinStatusMessage(reason || 'Sessione bloccata in sicurezza', Boolean(reason));
  if (window.lucide) window.lucide.createIcons();
}

function resetInactivityTimer() {
  if (!isAppUnlocked) return;
  if (inactivityLockTimer) clearTimeout(inactivityLockTimer);
  const mins = Number(appConfig.autoLockMinutes ?? 10);
  if (mins > 0) {
    inactivityLockTimer = setTimeout(() => {
      lockAppNow(`Blocco automatico dopo ${mins} minuti di inattività`);
    }, mins * 60 * 1000);
  }
}

async function changeSecurityPin(e) {
  e.preventDefault();
  if (!isAppUnlocked || !vaultCryptoKey) return;

  const currentPin = (document.getElementById('pinCurrentInput')?.value || '').trim();
  const newPin = (document.getElementById('pinNewInput')?.value || '').trim();
  const confirmPin = (document.getElementById('pinConfirmInput')?.value || '').trim();

  if (!/^\d{6}$/.test(newPin)) {
    showToast('Il nuovo codice deve essere esattamente di 6 cifre numeriche.', 'warning');
    return;
  }
  if (newPin !== confirmPin) {
    showToast('I due nuovi codici non coincidono.', 'error');
    return;
  }

  // Verifica il PIN attuale tentando la decifratura del vault salvato
  try {
    const storedVault = JSON.parse(localStorage.getItem(STORAGE_KEY_VAULT) || 'null');
    if (!storedVault || !storedVault.salt) throw new Error('Vault mancante');
    const checkKey = await deriveVaultKey(currentPin, storedVault.salt, storedVault.iter || PBKDF2_DEFAULT_ITER);
    await decryptObjectWithKey(storedVault, checkKey);
  } catch (_) {
    showToast('PIN attuale errato! Modifica annullata.', 'error');
    return;
  }

  try {
    const newSalt = bytesToBase64(window.crypto.getRandomValues(new Uint8Array(16)));
    const newKey = await deriveVaultKey(newPin, newSalt, PBKDF2_DEFAULT_ITER);
    vaultCryptoKey = newKey;
    vaultSaltB64 = newSalt;
    vaultIter = PBKDF2_DEFAULT_ITER;

    await persistEncryptedVault(false);

    document.getElementById('pinCurrentInput').value = '';
    document.getElementById('pinNewInput').value = '';
    document.getElementById('pinConfirmInput').value = '';

    showToast('Codice PIN aggiornato e Vault ricifrato in AES-256-GCM!', 'success');
  } catch (err) {
    console.error(err);
    showToast('Errore durante la ricifratura del Vault.', 'error');
  }
}

// ============================================================================
// INIZIALIZZAZIONE PAGINA (SCHERMATA BLOCCATA FINO A VERIFICA PIN)
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  initServiceWorker();
  if (window.lucide) window.lucide.createIcons();
  checkLockoutCountdownUI();

  // Supporto tastiera fisica su PC per il tastierino PIN
  document.addEventListener('keydown', (e) => {
    if (isAppUnlocked) {
      resetInactivityTimer();
      return;
    }
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      handlePinDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      backspacePinEntry();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearPinEntry();
    }
  });

  // Reset timer inattività su qualsiasi interazione
  ['pointerdown', 'touchstart', 'scroll'].forEach((ev) => {
    document.addEventListener(ev, () => {
      if (isAppUnlocked) resetInactivityTimer();
    }, { passive: true });
  });

  // Privacy Blur quando si cambia scheda o app
  window.addEventListener('blur', () => {
    if (isAppUnlocked && appConfig.privacyBlurOnHide) {
      document.body.classList.add('privacy-blur-active');
    }
  });
  window.addEventListener('focus', () => {
    document.body.classList.remove('privacy-blur-active');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (isAppUnlocked && appConfig.privacyBlurOnHide) {
        document.body.classList.add('privacy-blur-active');
      }
    } else if (document.visibilityState === 'visible') {
      document.body.classList.remove('privacy-blur-active');
      if (isAppUnlocked) {
        pullCloudHistoryAndMerge(false);
        checkAndDispatchNotifications();
        if (appConfig.wakeLock) acquireWakeLock();
      }
    }
  });
});

function bootstrapUnlockedApp() {
  setupAudioAutoUnlock();
  setupExcelDropzone();
  updateDeviceNotificationUI();
  updatePushLinksUI();
  resetInactivityTimer();

  // Avvia la sincronizzazione Cloud Delta Realtime Cifrata End-to-End PC <-> iOS
  initAutoCloudSync();

  if (!appBootstrapped) {
    appBootstrapped = true;

    updateLiveClock();
    setInterval(updateLiveClock, 1000);

    setInterval(() => {
      if (isAppUnlocked) checkAndDispatchNotifications();
    }, 5000);

    setInterval(() => {
      if (isAppUnlocked) scheduleUpcomingDirectPushes();
    }, 15 * 60 * 1000);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (isAppUnlocked && event.data && event.data.type === 'NOTIFICATION_ACTION') {
          handleNotificationAction(event.data.action, event.data.itemId);
        }
      });
    }

    if (localBroadcast) {
      localBroadcast.onmessage = async (event) => {
        if (isAppUnlocked && event.data && event.data.type === 'VAULT_UPDATED') {
          await reloadVaultFromStorage();
          renderAll();
          checkAndDispatchNotifications();
        }
      };
    }

    window.addEventListener('hashchange', () => {
      if (isAppUnlocked) handleUrlHashActions();
    });
  }

  checkAndDispatchNotifications();
  scheduleUpcomingDirectPushes();
  handleUrlHashActions();
  if (appConfig.wakeLock) acquireWakeLock();
  renderAll();
}

function reloadPreloadedScadenziario() {
  if (!isAppUnlocked) return;
  if (!Array.isArray(initialItemsRamCache) || initialItemsRamCache.length === 0) {
    showToast('Per ripristinare lo scadenziario originale usa il PIN iniziale oppure importa il file Excel.', 'warning');
    return;
  }
  if (!confirm(`Ripristinare le ${initialItemsRamCache.length} scadenze ufficiali da "SCADENZIARIO AGG..xlsx"? Le modifiche locali non salvate in backup verranno sostituite.`)) {
    return;
  }
  items = JSON.parse(JSON.stringify(initialItemsRamCache));
  deletedIds = {};
  saveItemsLocally();
  closeSettingsModal();
  renderAll();
  checkAndDispatchNotifications();
  scheduleUpcomingDirectPushes();
  showToast(`Ripristinate ${items.length} scadenze da SCADENZIARIO AGG..xlsx!`, 'success');
}

function handleUrlHashActions() {
  const hash = window.location.hash || '';
  if (!hash) return;

  if (hash === '#new-item') {
    openItemModal();
    history.replaceState(null, '', window.location.pathname);
  } else if (hash === '#import-excel') {
    openExcelImportModal();
    history.replaceState(null, '', window.location.pathname);
  } else if (hash.startsWith('#ack=')) {
    const id = decodeURIComponent(hash.slice(5));
    acknowledgeItem(id);
    history.replaceState(null, '', window.location.pathname);
  } else if (hash.startsWith('#snooze15=')) {
    const id = decodeURIComponent(hash.slice(10));
    snoozeItem(id, 15);
    history.replaceState(null, '', window.location.pathname);
  } else if (hash.startsWith('#item-')) {
    const id = decodeURIComponent(hash.slice(6));
    focusItemCard(id);
  }
}

function handleNotificationAction(action, itemId) {
  if (!itemId) return;
  if (action === 'ack') {
    acknowledgeItem(itemId);
  } else if (action === 'snooze15') {
    snoozeItem(itemId, 15);
  } else {
    focusItemCard(itemId);
  }
}

function focusItemCard(itemId) {
  const el = document.getElementById(`item-${itemId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('highlight-item-flash');
    setTimeout(() => el.classList.remove('highlight-item-flash'), 3000);
  }
}

// ============================================================================
// REGISTRAZIONE SERVICE WORKER, AUDIO UNLOCK E WAKE LOCK
// ============================================================================
function initServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      reg.update().catch(() => {});
    }).catch((err) => {
      console.warn('Registrazione Service Worker non riuscita:', err);
    });
  }
}

function setupAudioAutoUnlock() {
  const unlock = () => {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      if (!audioCtx) audioCtx = new AudioContextClass();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    } catch (_) {}
    document.removeEventListener('pointerdown', unlock);
    document.removeEventListener('keydown', unlock);
  };
  document.addEventListener('pointerdown', unlock, { passive: true });
  document.addEventListener('keydown', unlock, { passive: true });
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    }
  } catch (_) {}
}

async function releaseWakeLock() {
  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch (_) {}
}

function updateLiveClock() {
  const el = document.getElementById('liveClock');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleDateString('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }) + ' • ' + now.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// ============================================================================
// PERSISTENZA LOCALE CIFRATA AES-256-GCM (ZERO DATI IN CHIARO IN LOCALSTORAGE)
// ============================================================================
function persistEncryptedVault(broadcast = true) {
  if (!vaultCryptoKey || !vaultSaltB64) return Promise.resolve();

  const snapshot = {
    items,
    deletedIds,
    config: appConfig
  };

  vaultWriteChain = vaultWriteChain.then(async () => {
    try {
      const enc = await encryptObjectWithKey(snapshot, vaultCryptoKey);
      const envelope = {
        v: 4,
        datasetVersion: vaultDatasetVersion || 'v4',
        alg: 'AES-256-GCM',
        iter: vaultIter || PBKDF2_DEFAULT_ITER,
        salt: vaultSaltB64,
        iv: enc.iv,
        ct: enc.ct
      };
      localStorage.setItem(STORAGE_KEY_VAULT, JSON.stringify(envelope));
      if (broadcast && localBroadcast) {
        localBroadcast.postMessage({ type: 'VAULT_UPDATED' });
      }
    } catch (e) {
      console.warn('Errore cifratura Vault locale:', e);
      showToast('Spazio locale quasi pieno: esporta un backup Excel o JSON.', 'warning');
    }
  });

  return vaultWriteChain;
}

async function reloadVaultFromStorage() {
  if (!vaultCryptoKey) return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VAULT);
    if (!raw) return;
    const envelope = JSON.parse(raw);
    const data = await decryptObjectWithKey(envelope, vaultCryptoKey);
    if (data.config) appConfig = { ...createDefaultConfig(), ...data.config };
    deletedIds = data.deletedIds || {};
    items = Array.isArray(data.items)
      ? data.items.filter((it) => it && it.id && !deletedIds[it.id])
      : [];
  } catch (e) {
    console.warn('Errore ricaricamento Vault cifrato:', e);
  }
}

function saveConfig() {
  persistEncryptedVault(true);
}

function saveItemsLocally(broadcast = true) {
  persistEncryptedVault(broadcast);
}

// ============================================================================
// SINCRONIZZAZIONE CLOUD DELTA REALTIME CIFRATA END-TO-END (E2EE AES-256-GCM)
// ============================================================================
function getCloudSyncBaseUrl() {
  const topic = (appConfig.syncTopic || '').trim();
  if (!topic) return '';
  return `${NTFY_ROOT_URL}/${encodeURIComponent(topic)}`;
}

async function initAutoCloudSync() {
  if (!isAppUnlocked || !vaultCryptoKey || !getCloudSyncBaseUrl()) return;
  setSyncStatusUI('connecting');
  await pullCloudHistoryAndMerge(false);
  connectCloudRealtimeStream();
}

function setSyncStatusUI(state) {
  const statusBadge = document.getElementById('syncStatusText');
  const syncDot = document.getElementById('syncDot');
  const modalBadge = document.getElementById('cloudModalBadge');

  if (state === 'connected') {
    if (statusBadge) statusBadge.textContent = 'Cloud E2EE Attivo (PC ↔ iOS)';
    if (syncDot) syncDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    if (modalBadge) {
      modalBadge.textContent = 'Connesso • Cifrato E2EE';
      modalBadge.className = 'px-3 py-0.5 rounded-full text-xs font-extrabold bg-emerald-600 text-white';
    }
  } else if (state === 'connecting') {
    if (statusBadge) statusBadge.textContent = 'Connessione Cloud E2EE...';
    if (syncDot) syncDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
  } else {
    if (statusBadge) statusBadge.textContent = 'Riconnessione Cloud...';
    if (syncDot) syncDot.className = 'w-2 h-2 rounded-full bg-amber-400';
  }
}

async function decodeIncomingCloudMessage(rawMsg) {
  if (!vaultCryptoKey) return null;
  const parsed = JSON.parse(rawMsg);
  if (parsed && parsed.enc === 1 && parsed.iv && parsed.ct) {
    return await decryptObjectWithKey(parsed, vaultCryptoKey);
  }
  return null; // Ignora qualsiasi messaggio non cifrato o non autenticato con la chiave AES-256-GCM!
}

async function pullCloudHistoryAndMerge(notifyUser = false) {
  const baseUrl = getCloudSyncBaseUrl();
  if (!isAppUnlocked || !vaultCryptoKey || !baseUrl) return;

  try {
    const res = await fetch(`${baseUrl}/json?poll=1&since=all`, {
      cache: 'no-store'
    });
    if (!res.ok) return;

    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.trim().length > 0);

    let changed = false;
    for (const line of lines) {
      try {
        const envelope = JSON.parse(line);
        if (envelope.event === 'message' && envelope.message) {
          const payload = await decodeIncomingCloudMessage(envelope.message);
          if (payload && mergeIncomingDeltaPayload(payload)) {
            changed = true;
          }
        }
      } catch (_) {}
    }

    if (changed) {
      saveItemsLocally(false);
      renderAll();
      checkAndDispatchNotifications();
    }

    setSyncStatusUI('connected');
    if (notifyUser) {
      showToast('Sincronizzazione cifrata PC ↔ iOS completata!', 'success');
    }
  } catch (err) {
    console.warn('Errore lettura stato Cloud E2EE:', err);
  }
}

function connectCloudRealtimeStream() {
  if (cloudEventSource) {
    try { cloudEventSource.close(); } catch (_) {}
  }

  const baseUrl = getCloudSyncBaseUrl();
  if (!isAppUnlocked || !vaultCryptoKey || !baseUrl) return;

  try {
    cloudEventSource = new EventSource(`${baseUrl}/sse`);

    cloudEventSource.onopen = () => {
      setSyncStatusUI('connected');
    };

    cloudEventSource.onmessage = async (event) => {
      if (!isAppUnlocked || !vaultCryptoKey) return;
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.event === 'message' && envelope.message) {
          const payload = await decodeIncomingCloudMessage(envelope.message);
          if (!payload || payload.senderId === DEVICE_SESSION_ID) return;

          if (mergeIncomingDeltaPayload(payload)) {
            saveItemsLocally(true);
            renderAll();
            checkAndDispatchNotifications();
          }
        }
      } catch (_) {}
    };

    cloudEventSource.onerror = () => {
      if (!isAppUnlocked) return;
      setSyncStatusUI('reconnecting');
      setTimeout(() => {
        if (isAppUnlocked && (!cloudEventSource || cloudEventSource.readyState === EventSource.CLOSED)) {
          connectCloudRealtimeStream();
        }
      }, 5000);
    };
  } catch (e) {
    console.warn('SSE non disponibile:', e);
  }
}

function mergeIncomingDeltaPayload(payload) {
  if (!payload || payload.app !== 'STUDIO_CARIFI_V3') return false;
  let hasChanges = false;

  if (payload.op === 'CLEAR_ALL' && payload.clearedAllAt) {
    const clearMs = new Date(payload.clearedAllAt).getTime();
    const before = items.length;
    items = items.filter((item) => new Date(item.updatedAt || 0).getTime() > clearMs);
    if (items.length !== before) hasChanges = true;
  }

  if (payload.op === 'DELETE_ITEM' && payload.id) {
    const delTime = payload.deletedAt || new Date().toISOString();
    if (!deletedIds[payload.id] || new Date(delTime) > new Date(deletedIds[payload.id])) {
      deletedIds[payload.id] = delTime;
      const before = items.length;
      items = items.filter((i) => i.id !== payload.id);
      if (items.length !== before) hasChanges = true;
    }
  }

  if (payload.op === 'UPSERT_ITEM' && payload.item) {
    if (upsertIncomingItem(payload.item)) hasChanges = true;
  }

  if (payload.op === 'UPSERT_BATCH' && Array.isArray(payload.items)) {
    for (const incoming of payload.items) {
      if (upsertIncomingItem(incoming)) hasChanges = true;
    }
  }

  if (payload.op === 'SYNC_PUSH_TOPIC' && payload.pushTopic) {
    if (payload.pushTopic !== appConfig.pushTopic) {
      appConfig.pushTopic = payload.pushTopic;
      updatePushLinksUI();
      hasChanges = true;
    }
  }

  if (payload.op === 'SYNC_ROUTINES' && Array.isArray(payload.routines)) {
    appConfig.routines = payload.routines;
    if (payload.defaultRoutineId) appConfig.defaultRoutineId = payload.defaultRoutineId;
    hasChanges = true;
  }

  return hasChanges;
}

function upsertIncomingItem(incoming) {
  if (!incoming || !incoming.id) return false;
  if (deletedIds[incoming.id] && new Date(deletedIds[incoming.id]) >= new Date(incoming.updatedAt || 0)) {
    return false;
  }

  const idx = items.findIndex((i) => i.id === incoming.id);
  if (idx === -1) {
    items.push(incoming);
    return true;
  }
  const localTime = new Date(items[idx].updatedAt || 0).getTime();
  const remoteTime = new Date(incoming.updatedAt || 0).getTime();
  if (remoteTime > localTime) {
    items[idx] = incoming;
    return true;
  }
  return false;
}

async function sendCloudDelta(payload) {
  const baseUrl = getCloudSyncBaseUrl();
  if (!isAppUnlocked || !vaultCryptoKey || !baseUrl) return;

  const fullPayload = {
    app: 'STUDIO_CARIFI_V3',
    senderId: DEVICE_SESSION_ID,
    sentAt: new Date().toISOString(),
    ...payload
  };

  try {
    const enc = await encryptObjectWithKey(fullPayload, vaultCryptoKey);
    const wireBody = JSON.stringify({ v: 4, enc: 1, iv: enc.iv, ct: enc.ct });

    await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: wireBody
    });
    setSyncStatusUI('connected');
  } catch (err) {
    console.warn('Errore invio delta Cloud E2EE:', err);
  }
}

/**
 * Invia un elenco di appuntamenti in micro-blocchi sicuri (< 2.2 KB in chiaro -> < 3.1 KB cifrato AES-256)
 * per supportare anche importazioni da 630+ righe senza superare i limiti di payload.
 */
async function syncItemsInBatches(itemsList) {
  if (!Array.isArray(itemsList) || itemsList.length === 0) return;

  const MAX_CHUNK_BYTES = 2200;
  let currentChunk = [];
  let currentBytes = 120;
  const chunks = [];

  for (const item of itemsList) {
    const compact = {
      id: item.id,
      category: item.category,
      client: item.client,
      title: item.title,
      amount: item.amount,
      installmentRef: item.installmentRef,
      phone: item.phone,
      dueDate: item.dueDate,
      leadMinutes: item.leadMinutes,
      notifyStartAt: item.notifyStartAt,
      preAlerts: item.preAlerts,
      intensity: item.intensity,
      repeatMinutes: item.repeatMinutes,
      acknowledged: item.acknowledged,
      completed: item.completed,
      notes: item.notes,
      updatedAt: item.updatedAt
    };
    const itemSize = JSON.stringify(compact).length + 2;
    if (currentChunk.length > 0 && currentBytes + itemSize > MAX_CHUNK_BYTES) {
      chunks.push(currentChunk);
      currentChunk = [compact];
      currentBytes = 120 + itemSize;
    } else {
      currentChunk.push(compact);
      currentBytes += itemSize;
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk);

  // Sincronizza fino a 25 blocchi in background per evitare rate-limit; per import enormi
  // l'utente può comunque trasferire via Backup JSON/Excel se necessario.
  const maxOnlineChunks = Math.min(chunks.length, 40);
  for (let i = 0; i < maxOnlineChunks; i++) {
    await sendCloudDelta({ op: 'UPSERT_BATCH', items: chunks[i] });
    if (i < maxOnlineChunks - 1) {
      await new Promise((r) => setTimeout(r, 180));
    }
  }
}

async function forceCloudSyncNow() {
  await pullCloudHistoryAndMerge(true);
  const recent = [...items]
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, 60);
  await syncItemsInBatches(recent);
}

// ============================================================================
// MOTORE NOTIFICHE ISTANTANEE (iOS + PC) & CANALE PUSH DIRETTO (ZERO BOT)
// ============================================================================
function isIosDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function updateDeviceNotificationUI() {
  const btnHeader = document.getElementById('btnPermissionNotice');
  const headerText = document.getElementById('headerNotifStatusText');
  const modalPill = document.getElementById('nativeNotifStatusPill');
  const iosBox = document.getElementById('iosInstallHintBox');
  const setupBanner = document.getElementById('deviceAlertSetupBanner');
  const setupText = document.getElementById('deviceAlertSetupText');
  const setupBtn = document.getElementById('deviceAlertSetupActionBtn');

  const onIos = isIosDevice();
  const standalone = isStandalonePwa();
  const hasNotifApi = 'Notification' in window;
  const perm = hasNotifApi ? Notification.permission : 'unsupported';

  if (iosBox) {
    if (onIos && !standalone) iosBox.classList.remove('hidden');
    else iosBox.classList.add('hidden');
  }

  if (perm === 'granted') {
    if (btnHeader) { btnHeader.classList.add('hidden'); btnHeader.classList.remove('inline-flex'); }
    if (headerText) headerText.textContent = appConfig.pushEnabled ? 'Notifiche iOS & PC Attive' : 'Notifiche Dispositivo Attive';
    if (modalPill) {
      modalPill.textContent = '🟢 Attive su questo dispositivo';
      modalPill.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300';
    }
    if (setupBanner) setupBanner.classList.add('hidden');
  } else if (onIos && !standalone) {
    if (btnHeader) { btnHeader.classList.remove('hidden'); btnHeader.classList.add('inline-flex'); }
    if (headerText) headerText.textContent = 'Aggiungi a Home iPhone per avvisi';
    if (modalPill) {
      modalPill.textContent = '📱 Aggiungi a Schermata Home iOS';
      modalPill.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300';
    }
    if (setupBanner && !appConfig.setupBannerDismissed) {
      setupBanner.classList.remove('hidden');
      if (setupText) {
        setupText.innerHTML = '<strong>iPhone rilevato:</strong> tocca <strong>Condividi ↑ → Aggiungi alla schermata Home</strong> per attivare le notifiche iOS, oppure collega il <strong>Push a schermo bloccato</strong> in 1 tap.';
      }
      if (setupBtn) setupBtn.classList.add('hidden');
    }
  } else if (perm === 'denied') {
    if (btnHeader) { btnHeader.classList.add('hidden'); btnHeader.classList.remove('inline-flex'); }
    if (headerText) headerText.textContent = 'Notifiche bloccate nel browser';
    if (modalPill) {
      modalPill.textContent = '🔴 Bloccate dal Browser (riabilita dal lucchetto URL)';
      modalPill.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-red-100 text-carifi-crimson border border-red-300';
    }
  } else {
    if (btnHeader) { btnHeader.classList.remove('hidden'); btnHeader.classList.add('inline-flex'); }
    if (headerText) headerText.textContent = 'Clicca per attivare notifiche';
    if (modalPill) {
      modalPill.textContent = '🟡 Da attivare (1 clic)';
      modalPill.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300';
    }
    if (setupBanner && !appConfig.setupBannerDismissed) {
      setupBanner.classList.remove('hidden');
      if (setupText) {
        setupText.innerHTML = '<strong>Notifiche istantanee pronte:</strong> attiva gli avvisi su questo dispositivo per ricevere suoni e notifiche desktop/iOS in tempo reale.';
      }
      if (setupBtn) setupBtn.classList.remove('hidden');
    }
  }
}

function dismissSetupBanner() {
  appConfig.setupBannerDismissed = true;
  saveConfig();
  const setupBanner = document.getElementById('deviceAlertSetupBanner');
  if (setupBanner) setupBanner.classList.add('hidden');
}

async function requestDeviceNotifications() {
  if (isIosDevice() && !isStandalonePwa()) {
    openSettingsModal();
    showToast('Su iPhone: tocca Condividi → Aggiungi alla schermata Home, poi apri l\'app dall\'icona Studio Carifi.', 'warning');
    return;
  }

  if (!('Notification' in window)) {
    showToast('Questo browser non supporta le notifiche desktop. Usa il Canale Push Diretto in Impostazioni.', 'warning');
    openSettingsModal();
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    updateDeviceNotificationUI();
    if (permission === 'granted') {
      showToast('Notifiche istantanee attivate con successo!', 'success');
      triggerTestNotification();
    } else if (permission === 'denied') {
      showToast('Permesso negato: puoi riattivarlo dall\'icona del lucchetto vicino all\'indirizzo.', 'error');
    }
  } catch (e) {
    showToast('Impossibile richiedere il permesso notifiche.', 'error');
  }
}

/**
 * Invia una notifica Push Istantanea (o programmata fino a 72h) via ntfy.sh JSON API
 * Zero Bot Telegram, supporto pieno UTF-8 / Emoji / Accenti italiani, funzionamento a schermo bloccato iOS & PC!
 */
async function sendDirectPushAlert({ title, message, priority = 4, tags = ['bell'], delayUnixSec = null }) {
  if (!appConfig.pushEnabled || !appConfig.pushTopic) return false;

  const payload = {
    topic: appConfig.pushTopic.trim(),
    title: title,
    message: message,
    priority: priority,
    tags: tags
  };

  if (delayUnixSec) {
    payload.delay = String(delayUnixSec);
  }

  try {
    const res = await fetch(NTFY_ROOT_URL, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return res.ok;
  } catch (err) {
    console.warn('Errore invio Push Diretto:', err);
    return false;
  }
}

// ============================================================================
// MOTORE ROUTINE DI NOTIFICHE (CALCOLO SLOT ESATTI & PROGRAMMAZIONE PUSH 72H)
// ============================================================================
function getRoutineById(routineId) {
  if (!routineId || routineId === 'manual') return null;
  return (appConfig.routines || []).find((r) => r.id === routineId) || null;
}

function getDefaultRoutine() {
  return getRoutineById(appConfig.defaultRoutineId) || (appConfig.routines || [])[0] || DEFAULT_ROUTINES[0];
}

function formatRoutineSummary(routine) {
  if (!routine) return 'Regola manuale';
  const parts = [];
  const preDays = [...(routine.preAlertDays || [])]
    .sort((a, b) => Number(b.daysBefore) - Number(a.daysBefore));
  if (preDays.length > 0) {
    parts.push(preDays.map((p) => `${p.daysBefore}gg (${p.time})`).join(', '));
  }
  const times = (routine.dailyTimes || []).filter(Boolean);
  if (times.length > 0 && Number(routine.dailyFromDays) >= 0) {
    const labelDays = Number(routine.dailyFromDays) === 0
      ? 'giorno scad.'
      : `ultimi ${routine.dailyFromDays}gg`;
    parts.push(`${labelDays}: ${times.join(' & ')}`);
  }
  if (Number(routine.minutesBeforeDue) > 0) {
    parts.push(`-${routine.minutesBeforeDue}m`);
  }
  return parts.join(' • ') || 'Nessuno slot attivo';
}

function parseHHMM(timeStr, fallbackH = 9, fallbackM = 30) {
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: fallbackH, min: fallbackM };
  return { h: Math.min(23, Math.max(0, Number(m[1]))), min: Math.min(59, Math.max(0, Number(m[2]))) };
}

/**
 * Calcola tutti gli slot cronologici esatti di notifica per un appuntamento/scadenza
 * in base alla sua Routine (e all'eventuale data/ora iniziale customFirstAlertAt).
 */
function computeRoutineNotificationSlots(item, overrideRoutine = null) {
  const dueDate = new Date(item.dueDate);
  if (Number.isNaN(dueDate.getTime())) return [];

  const routine = overrideRoutine !== null ? overrideRoutine : getRoutineById(item.routineId);
  if (!routine) return [];

  const dueY = dueDate.getFullYear();
  const dueM = dueDate.getMonth();
  const dueD = dueDate.getDate();

  const slots = [];
  const seenMinuteKeys = new Set();

  const pushSlot = (key, dateObj, label) => {
    if (Number.isNaN(dateObj.getTime())) return;
    const minKey = Math.floor(dateObj.getTime() / 60000);
    if (seenMinuteKeys.has(minKey)) return;
    seenMinuteKeys.add(minKey);
    slots.push({ key, atMs: dateObj.getTime(), atIso: dateObj.toISOString(), label });
  };

  let customStartMs = null;
  if (item.customFirstAlertAt) {
    const cDate = new Date(item.customFirstAlertAt);
    if (!Number.isNaN(cDate.getTime())) {
      customStartMs = cDate.getTime();
      pushSlot('custom-start', cDate, 'Avviso Iniziale Programmato');
    }
  }

  // 1. Preavvisi nei giorni precedenti (es. 7 giorni prima alle 09:30, 3 giorni prima alle 09:30)
  for (const pre of (routine.preAlertDays || [])) {
    const days = Number(pre.daysBefore);
    if (!Number.isFinite(days) || days <= 0) continue;
    const { h, min } = parseHHMM(pre.time, 9, 30);
    const d = new Date(dueY, dueM, dueD - days, h, min, 0, 0);
    if (customStartMs !== null && d.getTime() < customStartMs) continue;
    pushSlot(`pre-${days}d-${pre.time}`, d, `Preavviso ${days} giorni prima`);
  }

  // 2. Avvisi giornalieri da quando mancano N giorni fino al giorno di scadenza (es. -2gg, -1gg, 0gg alle 11:30 e 16:30)
  const dailyFrom = Number(routine.dailyFromDays);
  const dailyTimes = (routine.dailyTimes || []).filter(Boolean);
  if (Number.isFinite(dailyFrom) && dailyFrom >= 0 && dailyTimes.length > 0) {
    for (let dayOffset = dailyFrom; dayOffset >= 0; dayOffset--) {
      for (const tStr of dailyTimes) {
        const { h, min } = parseHHMM(tStr, 11, 30);
        const d = new Date(dueY, dueM, dueD - dayOffset, h, min, 0, 0);
        if (customStartMs !== null && d.getTime() < customStartMs) continue;
        const dayLabel = dayOffset === 0
          ? `Scadenza OGGI (${tStr})`
          : dayOffset === 1
          ? `Scade DOMANI (${tStr})`
          : `Mancano ${dayOffset} giorni (${tStr})`;
        pushSlot(`daily-${dayOffset}d-${tStr}`, d, dayLabel);
      }
    }
  }

  // 3. Eventuale avviso extra prima dell'orario esatto (per appuntamenti orari)
  const minsBefore = Number(routine.minutesBeforeDue || 0);
  if (minsBefore > 0) {
    const d = new Date(dueDate.getTime() - minsBefore * 60 * 1000);
    if (customStartMs === null || d.getTime() >= customStartMs) {
      pushSlot(`before-${minsBefore}m`, d, `Tra ${minsBefore} minuti`);
    }
  }

  slots.sort((a, b) => a.atMs - b.atMs);
  return slots;
}

function getNextScheduledSlot(item, nowMs = Date.now()) {
  const slots = computeRoutineNotificationSlots(item);
  if (slots.length === 0) return null;
  const fired = item.firedSlots || {};
  return slots.find((s) => !fired[s.key] && s.atMs >= nowMs - 60000) || slots.find((s) => s.atMs > nowMs) || slots[slots.length - 1];
}

/**
 * Programma automaticamente sul server Push (fino a 70h in anticipo) gli slot esatti delle routine
 * raggruppati per minuto esatto — così ad es. domani 25/11 alle 13:00 arriva UN solo Push pulito e completo
 * con tutte le scadenze del 30/11 su iPhone e PC anche a schermo bloccato!
 */
async function scheduleUpcomingDirectPushes() {
  if (!appConfig.pushEnabled || !appConfig.pushSchedule72h || !appConfig.pushTopic) return;

  const nowMs = Date.now();
  const minDelayMs = 20 * 1000; // minimo 20 secondi nel futuro
  const maxDelayMs = 70 * 60 * 60 * 1000; // massimo 70 ore nel futuro (limite ntfy = 72h)

  // Raggruppa gli slot imminenti per minuto esatto
  const buckets = new Map();

  for (const item of items) {
    if (item.completed) continue;

    const routineSlots = computeRoutineNotificationSlots(item);
    if (routineSlots.length > 0) {
      if (!item.scheduledPushSlots) item.scheduledPushSlots = {};
      for (const slot of routineSlots) {
        const diff = slot.atMs - nowMs;
        if (diff >= minDelayMs && diff <= maxDelayMs && !item.scheduledPushSlots[slot.key]) {
          const minuteBucket = Math.floor(slot.atMs / 60000) * 60;
          if (!buckets.has(minuteBucket)) buckets.set(minuteBucket, []);
          buckets.get(minuteBucket).push({ item, slot });
        }
      }
    } else if (item.notifyStartAt && !item.acknowledged) {
      const targetMs = new Date(item.notifyStartAt).getTime();
      const diff = targetMs - nowMs;
      if (diff >= minDelayMs && diff <= maxDelayMs && item.scheduledPushFor !== item.notifyStartAt) {
        const minuteBucket = Math.floor(targetMs / 60000) * 60;
        if (!buckets.has(minuteBucket)) buckets.set(minuteBucket, []);
        buckets.get(minuteBucket).push({
          item,
          slot: { key: '__manual__', atMs: targetMs, atIso: item.notifyStartAt, label: 'Promemoria Scadenza' }
        });
      }
    }
  }

  let updated = false;
  let scheduledRequests = 0;
  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);

  for (const [unixSec, entries] of sortedBuckets) {
    if (scheduledRequests >= 12) break;

    let title;
    let message;
    let priority = 4;
    let tags = ['bell', 'calendar'];

    if (appConfig.privacyPushMode) {
      title = `Studio Carifi — ${entries.length} ${entries.length === 1 ? 'Scadenza' : 'Scadenze'} in Avviso`;
      message = `Hai ${entries.length} ${entries.length === 1 ? 'impegno' : 'impegni'} in avviso (${entries[0].slot.label}). Apri il gestionale con il tuo codice per visualizzare i dettagli.`;
      priority = entries.some((e) => e.item.intensity === 'high') ? 5 : 4;
      tags = ['lock', 'bell'];
    } else if (entries.length === 1) {
      const { item, slot } = entries[0];
      const amountStr = item.amount ? ` (€ ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })})` : '';
      title = `Studio Carifi — ${slot.label}`;
      message = `${item.client}: ${item.title}${amountStr}\nScadenza: ${formatDateTimeIT(item.dueDate)}`;
      priority = item.intensity === 'high' ? 5 : item.intensity === 'medium' ? 4 : 3;
      tags = item.intensity === 'high' ? ['rotating_light', 'calendar'] : ['bell', 'calendar'];
    } else {
      const totalAmt = entries.reduce((acc, e) => acc + (Number(e.item.amount) || 0), 0);
      const totalStr = totalAmt > 0 ? ` — Tot. € ${totalAmt.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : '';
      title = `Studio Carifi — ${entries.length} Scadenze (${entries[0].slot.label})`;
      const lines = entries.slice(0, 12).map(({ item }) => {
        const amt = item.amount ? ` (€ ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })})` : '';
        return `• ${item.client}: ${item.title}${amt}`;
      });
      if (entries.length > 12) lines.push(`... e altre ${entries.length - 12} scadenze`);
      message = `${entries.length} impegni in avviso${totalStr}\n\n${lines.join('\n')}`;
      priority = entries.some((e) => e.item.intensity === 'high') ? 5 : 4;
      tags = ['rotating_light', 'calendar'];
    }

    const ok = await sendDirectPushAlert({ title, message, priority, tags, delayUnixSec: unixSec });
    if (ok) {
      for (const { item, slot } of entries) {
        if (slot.key === '__manual__') {
          item.scheduledPushFor = item.notifyStartAt;
        } else {
          if (!item.scheduledPushSlots) item.scheduledPushSlots = {};
          item.scheduledPushSlots[slot.key] = new Date().toISOString();
        }
      }
      updated = true;
      scheduledRequests++;
    }
  }

  if (updated) {
    saveItemsLocally(false);
  }
}

function checkAndDispatchNotifications() {
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const activeAlarms = [];
  const dueEventsToFire = [];
  let stateChanged = false;
  const MAX_CATCHUP_MS = 6 * 60 * 60 * 1000; // non suona vecchi slot di giorni passati

  for (const item of items) {
    if (item.completed) continue;

    if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > nowMs) {
      continue;
    }

    const dueMs = new Date(item.dueDate).getTime();
    if (Number.isNaN(dueMs)) continue;

    const routineSlots = computeRoutineNotificationSlots(item);

    if (routineSlots.length > 0) {
      // Gestione basata su Routine a orari esatti (es. Routine Studio Carifi)
      if (!item.firedSlots) item.firedSlots = {};

      let hasTriggeredUnacked = false;
      for (const slot of routineSlots) {
        if (slot.atMs <= nowMs) {
          if (!item.firedSlots[slot.key]) {
            item.firedSlots[slot.key] = nowIso;
            item.lastNotifiedAt = nowIso;
            item.acknowledged = false; // ogni nuovo slot programmato richiede attenzione finché confermato
            item.updatedAt = nowIso;
            stateChanged = true;

            if ((nowMs - slot.atMs) <= MAX_CATCHUP_MS) {
              dueEventsToFire.push({ item, label: slot.label, slotKey: slot.key });
            }
          }
          if (!item.acknowledged && (nowMs - slot.atMs) <= 24 * 60 * 60 * 1000) {
            hasTriggeredUnacked = true;
          }
        }
      }

      if (hasTriggeredUnacked) {
        activeAlarms.push(item);
      }
    } else {
      // Gestione classica manuale
      const notifyStartMs = new Date(item.notifyStartAt).getTime();
      if (Number.isNaN(notifyStartMs)) continue;

      if (!item.preAlertsFired) item.preAlertsFired = {};

      if (item.preAlerts?.d7 && !item.preAlertsFired.d7) {
        const d7Ms = dueMs - 7 * 24 * 60 * 60 * 1000;
        if (nowMs >= d7Ms && nowMs < dueMs) {
          item.preAlertsFired.d7 = true;
          item.updatedAt = nowIso;
          stateChanged = true;
          dueEventsToFire.push({ item, label: 'Preavviso 7 giorni prima', slotKey: 'manual-d7' });
        }
      }

      if (item.preAlerts?.d3 && !item.preAlertsFired.d3) {
        const d3Ms = dueMs - 3 * 24 * 60 * 60 * 1000;
        if (nowMs >= d3Ms && nowMs < dueMs) {
          item.preAlertsFired.d3 = true;
          item.updatedAt = nowIso;
          stateChanged = true;
          dueEventsToFire.push({ item, label: 'Preavviso 3 giorni prima', slotKey: 'manual-d3' });
        }
      }

      if (item.preAlerts?.morning && !item.preAlertsFired.morning) {
        const dueDayMorning = new Date(item.dueDate);
        dueDayMorning.setHours(9, 0, 0, 0);
        if (nowMs >= dueDayMorning.getTime() && nowMs <= dueMs) {
          item.preAlertsFired.morning = true;
          item.updatedAt = nowIso;
          stateChanged = true;
          dueEventsToFire.push({ item, label: 'Promemoria Mattutino', slotKey: 'manual-morning' });
        }
      }

      if (nowMs >= notifyStartMs && !item.acknowledged) {
        activeAlarms.push(item);

        const lastMs = item.lastNotifiedAt ? new Date(item.lastNotifiedAt).getTime() : 0;
        const repeatIntervalMs = (Number(item.repeatMinutes) || 60) * 60 * 1000;

        if (item.intensity === 'low') {
          if (!item.lastNotifiedAt) {
            item.lastNotifiedAt = nowIso;
            item.updatedAt = nowIso;
            stateChanged = true;
            dueEventsToFire.push({ item, label: 'Promemoria Studio', slotKey: 'manual-low' });
          }
        } else if (!lastMs || (nowMs - lastMs) >= repeatIntervalMs) {
          item.lastNotifiedAt = nowIso;
          item.updatedAt = nowIso;
          stateChanged = true;
          const label = item.intensity === 'high' ? '🚨 ALLARME STUDIO' : '🔔 Sollecito Periodico';
          dueEventsToFire.push({ item, label, slotKey: 'manual-repeat' });
        }
      }
    }
  }

  // Dispatch intelligente: singolo se 1-2 scadenze, riepilogo pulito se 3+ nello stesso istante
  if (dueEventsToFire.length > 0 && dueEventsToFire.length <= 2) {
    for (const ev of dueEventsToFire) {
      dispatchInstantAlert(ev.item, ev.label, ev.slotKey);
    }
  } else if (dueEventsToFire.length >= 3) {
    dispatchBatchDigestAlert(dueEventsToFire);
  }

  updateActiveAlarmBanner(activeAlarms);
  updateTabBlinking(activeAlarms.length);

  if (stateChanged) {
    saveItemsLocally(false);
    renderAll();
  }
}

function dispatchBatchDigestAlert(events) {
  const isUrgent = events.some((e) => e.item.intensity === 'high');
  const totalAmount = events.reduce((acc, e) => acc + (Number(e.item.amount) || 0), 0);
  const totalStr = totalAmount > 0 ? ` — Totale € ${totalAmount.toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : '';
  const title = `🚨 Studio Carifi — ${events.length} Scadenze in Avviso`;
  const previewClients = events.slice(0, 4).map((e) => e.item.client).join(', ');
  const moreStr = events.length > 4 ? ` e altri ${events.length - 4}` : '';
  const shortBody = `${events[0].label}${totalStr}\nClienti: ${previewClients}${moreStr}`;

  playAlertSound(isUrgent ? 'urgent' : appConfig.soundProfile);
  if (appConfig.vibrate && navigator.vibrate) {
    navigator.vibrate([350, 120, 350, 120, 500]);
  }
  showToast(`${title}${totalStr}`, 'error');
  sendSystemNotification(title, shortBody, events[0].item.id, true);

  // Invia Push immediato solo se questi slot non erano già stati schedulati su ntfy
  const anyUnscheduled = events.some((e) => !(e.item.scheduledPushSlots && e.item.scheduledPushSlots[e.slotKey]));
  if (appConfig.pushEnabled && anyUnscheduled) {
    if (appConfig.privacyPushMode) {
      sendDirectPushAlert({
        title: `Studio Carifi — ${events.length} Scadenze in Avviso`,
        message: `Hai ${events.length} scadenze in avviso (${events[0].label}). Apri il gestionale con il tuo codice per visualizzare i dettagli.`,
        priority: isUrgent ? 5 : 4,
        tags: ['lock', 'bell']
      });
    } else {
      const detailLines = events.slice(0, 15).map(({ item }) => {
        const amt = item.amount ? ` (€ ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })})` : '';
        return `• ${item.client}: ${item.title}${amt}`;
      });
      if (events.length > 15) detailLines.push(`... e altre ${events.length - 15} scadenze`);
      sendDirectPushAlert({
        title,
        message: `${events[0].label}${totalStr}\n\n${detailLines.join('\n')}`,
        priority: isUrgent ? 5 : 4,
        tags: ['rotating_light', 'calendar']
      });
    }
  }
}

function updateActiveAlarmBanner(activeAlarms) {
  const banner = document.getElementById('activeAlarmBanner');
  const countBadge = document.getElementById('activeAlarmCountBadge');
  const desc = document.getElementById('activeAlarmDescription');
  if (!banner) return;

  if (activeAlarms.length === 0) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  if (countBadge) countBadge.textContent = String(activeAlarms.length);
  if (desc) {
    const titles = activeAlarms.slice(0, 2).map((a) => `${a.client} (${a.title})`).join(' • ');
    desc.textContent = activeAlarms.length > 2
      ? `${titles} e altre ${activeAlarms.length - 2} scadenze in attesa di conferma.`
      : `${titles} — Premi "Conferma Presa in Carico" per silenziare.`;
  }
}

function updateTabBlinking(alarmCount) {
  if (alarmCount > 0 && appConfig.tabBlink) {
    if (!tabBlinkTimer) {
      tabBlinkTimer = setInterval(() => {
        tabBlinkState = !tabBlinkState;
        document.title = tabBlinkState
          ? `🚨 (${alarmCount}) AVVISO STUDIO CARIFI!`
          : BASE_DOCUMENT_TITLE;
      }, 1200);
    }
  } else {
    if (tabBlinkTimer) {
      clearInterval(tabBlinkTimer);
      tabBlinkTimer = null;
    }
    document.title = BASE_DOCUMENT_TITLE;
  }
}

function dispatchInstantAlert(item, prefixLabel, slotKey = null) {
  const amountStr = item.amount
    ? ` — € ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`
    : '';
  const dueFormatted = formatDateTimeIT(item.dueDate);
  const title = `${prefixLabel}: ${item.client}`;
  const body = `${item.title}${amountStr}\nScadenza: ${dueFormatted}`;

  // 1. Suono immediato
  playAlertSound(item.intensity === 'high' ? 'urgent' : appConfig.soundProfile);

  // 2. Vibrazione mobile
  if (appConfig.vibrate && navigator.vibrate) {
    navigator.vibrate(item.intensity === 'high' ? [350, 120, 350, 120, 500] : [200, 100, 200]);
  }

  // 3. Toast visivo in pagina
  showToast(`${title} — ${item.title}`, item.intensity === 'high' ? 'error' : 'warning');

  // 4. Notifica Nativa di Sistema (PC Windows / iOS PWA)
  sendSystemNotification(title, body, item.id, item.intensity === 'high');

  // 5. Push Istantaneo Diretto (evita duplicato se quello slot era già schedulato su ntfy)
  const alreadyScheduledSlot = Boolean(slotKey && item.scheduledPushSlots && item.scheduledPushSlots[slotKey]);
  const alreadyScheduledManual = item.scheduledPushFor === item.notifyStartAt &&
    Math.abs(Date.now() - new Date(item.notifyStartAt).getTime()) < 90 * 1000 &&
    !prefixLabel.includes('ALLARME');

  if (appConfig.pushEnabled && !alreadyScheduledSlot && !alreadyScheduledManual) {
    if (appConfig.privacyPushMode) {
      sendDirectPushAlert({
        title: `Studio Carifi — ${prefixLabel}`,
        message: `Hai una scadenza in avviso (${dueFormatted}). Apri l'app con il tuo codice per i dettagli.`,
        priority: item.intensity === 'high' ? 5 : item.intensity === 'medium' ? 4 : 3,
        tags: ['lock', 'bell']
      });
    } else {
      sendDirectPushAlert({
        title: `Studio Carifi — ${prefixLabel}`,
        message: `${item.client}: ${item.title}${amountStr}\nScadenza: ${dueFormatted}`,
        priority: item.intensity === 'high' ? 5 : item.intensity === 'medium' ? 4 : 3,
        tags: item.intensity === 'high' ? ['rotating_light', 'bell'] : ['bell', 'calendar']
      });
    }
  }
}

async function sendSystemNotification(title, body, itemId, isUrgent = false) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const options = {
    body,
    icon: './logo.jpg',
    badge: './icon.svg',
    vibrate: isUrgent ? [300, 120, 300, 120, 450] : [200, 100, 200],
    tag: itemId ? `carifi-${itemId}-${Date.now()}` : `carifi-test-${Date.now()}`,
    renotify: true,
    requireInteraction: isUrgent,
    data: { itemId },
    actions: itemId
      ? [
          { action: 'ack', title: '✓ Preso in Carico' },
          { action: 'snooze15', title: '⏰ Posponi 15m' }
        ]
      : []
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return;
      }
    }
    const notif = new Notification(title, {
      body: options.body,
      icon: options.icon,
      tag: options.tag,
      requireInteraction: options.requireInteraction
    });
    notif.onclick = () => {
      window.focus();
      if (itemId) focusItemCard(itemId);
      notif.close();
    };
  } catch (e) {
    console.warn('Impossibile mostrare notifica nativa:', e);
  }
}

function playAlertSound(profile = 'institutional') {
  const activeProfile = profile || appConfig.soundProfile || 'institutional';
  if (activeProfile === 'silent') return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    let notes;
    let wave = 'sine';
    let gainPeak = 0.25;

    if (activeProfile === 'urgent') {
      notes = [880, 1174.66, 880, 1174.66, 1318.51];
      wave = 'triangle';
      gainPeak = 0.34;
    } else if (activeProfile === 'soft') {
      notes = [523.25, 659.25];
      wave = 'sine';
      gainPeak = 0.16;
    } else {
      notes = [587.33, 880, 1174.66];
      wave = 'sine';
      gainPeak = 0.24;
    }

    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = wave;
      osc.frequency.setValueAtTime(freq, now + idx * 0.16);

      gain.gain.setValueAtTime(0.001, now + idx * 0.16);
      gain.gain.exponentialRampToValueAtTime(gainPeak, now + idx * 0.16 + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.16 + 0.15);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(now + idx * 0.16);
      osc.stop(now + idx * 0.16 + 0.16);
    });
  } catch (e) {
    console.warn('Audio bloccato fino al primo tocco:', e);
  }
}

async function triggerTestNotification() {
  playAlertSound(appConfig.soundProfile === 'silent' ? 'institutional' : appConfig.soundProfile);
  if (appConfig.vibrate && navigator.vibrate) {
    navigator.vibrate([250, 100, 250]);
  }
  showToast('Test Avviso Istantaneo eseguito (Suono + Notifica Dispositivo)!', 'success');

  sendSystemNotification(
    '🔔 Studio Carifi Commercialista — Test Istantaneo',
    'Le notifiche istantanee su PC e iOS sono attive e funzionanti!',
    null,
    true
  );

  if (appConfig.pushEnabled && appConfig.pushTopic) {
    await sendDirectPushAlert({
      title: 'Studio Carifi — Test Push Istantaneo',
      message: 'Connessione Push iOS & PC verificata con successo!',
      priority: 4,
      tags: ['white_check_mark', 'bell']
    });
  }
}

async function sendTestDirectPush() {
  saveNotificationPreferences();
  if (!appConfig.pushTopic) {
    showToast('Inserisci prima un codice canale Push.', 'warning');
    return;
  }
  const prevEnabled = appConfig.pushEnabled;
  appConfig.pushEnabled = true;
  const ok = await sendDirectPushAlert({
    title: 'Studio Carifi Commercialista — Prova Push',
    message: 'Avviso istantaneo ricevuto correttamente su iPhone e PC!',
    priority: 5,
    tags: ['rotating_light', 'white_check_mark']
  });
  appConfig.pushEnabled = prevEnabled;

  if (ok) {
    showToast('Push istantaneo inviato! Controlla iPhone / PC.', 'success');
  } else {
    showToast('Errore di rete durante l\'invio Push.', 'error');
  }
}

// ============================================================================
// AZIONI SULLE SCADENZE (CONFERMA, SNOOZE, COMPLETAMENTO, RATA SUCC., WHATSAPP, ICS)
// ============================================================================
function acknowledgeItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.acknowledged = true;
  item.snoozedUntil = null;
  item.updatedAt = new Date().toISOString();
  saveItemsLocally();
  sendCloudDelta({ op: 'UPSERT_ITEM', item });
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Allarme silenziato: "${item.client}" preso in carico.`, 'success');
}

function snoozeItem(id, minutes = 15) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  item.updatedAt = new Date().toISOString();
  saveItemsLocally();
  sendCloudDelta({ op: 'UPSERT_ITEM', item });
  renderAll();
  checkAndDispatchNotifications();
  showToast(`"${item.client}" posticipato di ${minutes} minuti.`, 'warning');
}

function acknowledgeAllActiveAlarms() {
  const nowMs = Date.now();
  const modified = [];
  items.forEach((item) => {
    if (!item.completed && !item.acknowledged && new Date(item.notifyStartAt).getTime() <= nowMs) {
      item.acknowledged = true;
      item.snoozedUntil = null;
      item.updatedAt = new Date().toISOString();
      modified.push(item);
    }
  });
  saveItemsLocally();
  syncItemsInBatches(modified);
  renderAll();
  checkAndDispatchNotifications();
  showToast(`${modified.length} avvisi confermati e presi in carico.`, 'success');
}

function snoozeAllActiveAlarms(minutes = 15) {
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const nowMs = Date.now();
  const modified = [];
  items.forEach((item) => {
    if (!item.completed && !item.acknowledged && new Date(item.notifyStartAt).getTime() <= nowMs) {
      item.snoozedUntil = until;
      item.updatedAt = new Date().toISOString();
      modified.push(item);
    }
  });
  saveItemsLocally();
  syncItemsInBatches(modified);
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Allarmi posticipati di ${minutes} minuti.`, 'warning');
}

function toggleCompleteItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.completed = !item.completed;
  if (item.completed) {
    item.acknowledged = true;
    item.snoozedUntil = null;
  }
  item.updatedAt = new Date().toISOString();
  saveItemsLocally();
  sendCloudDelta({ op: 'UPSERT_ITEM', item });
  renderAll();
  checkAndDispatchNotifications();
  showToast(
    item.completed
      ? `Completato: ${item.client} — ${item.title}`
      : `Riaperto: ${item.client}`,
    'success'
  );
}

function deleteItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (!confirm(`Eliminare definitivamente "${item.title}" del cliente ${item.client}?`)) return;
  const deletedAt = new Date().toISOString();
  deletedIds[id] = deletedAt;
  items = items.filter((i) => i.id !== id);
  saveItemsLocally();
  sendCloudDelta({ op: 'DELETE_ITEM', id, deletedAt });
  renderAll();
  checkAndDispatchNotifications();
  showToast('Impegno eliminato su PC e iOS.', 'info');
}

function duplicateNextInstallment(id) {
  const source = items.find((i) => i.id === id);
  if (!source) return;

  const nextDue = new Date(source.dueDate);
  nextDue.setMonth(nextDue.getMonth() + 1);

  const routineId = source.routineId || appConfig.defaultRoutineId;
  const slots = computeRoutineNotificationSlots({ dueDate: nextDue.toISOString(), routineId });
  const leadMin = source.leadMinutes === 'custom' ? 1440 : Number(source.leadMinutes || 1440);
  const nextNotifyStart = slots.length > 0
    ? new Date(slots[0].atMs)
    : new Date(nextDue.getTime() - leadMin * 60 * 1000);

  const newItem = {
    ...source,
    id: 'carifi-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    title: source.title.replace(/(\d+)ª/g, (_, n) => `${Number(n) + 1}ª`),
    installmentRef: source.installmentRef
      ? source.installmentRef.replace(/Rata\s+(\d+)/i, (_, n) => `Rata ${Number(n) + 1}`)
      : '',
    dueDate: nextDue.toISOString(),
    routineId,
    customFirstAlertAt: null,
    notifyStartAt: nextNotifyStart.toISOString(),
    preAlertsFired: {},
    firedSlots: {},
    scheduledPushSlots: {},
    scheduledPushFor: null,
    acknowledged: false,
    completed: false,
    lastNotifiedAt: null,
    snoozedUntil: null,
    updatedAt: new Date().toISOString()
  };

  items.push(newItem);
  saveItemsLocally();
  sendCloudDelta({ op: 'UPSERT_ITEM', item: newItem });
  scheduleUpcomingDirectPushes();
  renderAll();
  showToast(`Creata rata successiva per ${newItem.client} (${formatDateTimeIT(newItem.dueDate)})`, 'success');
}

function notifyClientWhatsApp(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const amountText = item.amount
    ? ` di € ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`
    : '';
  const msg =
    `Gentile *${item.client}*,\n` +
    `lo *Studio Carifi Commercialista* Le ricorda il seguente impegno:\n\n` +
    `📌 *${item.title}*${amountText}\n` +
    (item.installmentRef ? `🔢 Riferimento: ${item.installmentRef}\n` : '') +
    `📅 Data e ora: *${formatDateTimeIT(item.dueDate)}*\n\n` +
    `Restiamo a disposizione in studio per qualsiasi chiarimento.\nCordiali saluti,\n*Studio Carifi Commercialista*`;

  const cleanPhone = (item.phone || '').replace(/[^\d+]/g, '');
  const phoneWithPrefix = cleanPhone
    ? (cleanPhone.startsWith('+') || cleanPhone.startsWith('39') ? cleanPhone : '39' + cleanPhone)
    : '';

  const url = phoneWithPrefix
    ? `https://wa.me/${phoneWithPrefix}?text=${encodeURIComponent(msg)}`
    : `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}

// ============================================================================
// ESPORTAZIONE CALENDARIO NATIVO iOS / MAC / WINDOWS (.ICS)
// ============================================================================
function formatIcsDateUTC(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) + 'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

function escapeIcsText(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function buildIcsContent(itemsList) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Studio Carifi Commercialista//Agenda v3//IT',
    'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Studio Carifi Commercialista'
  ];

  for (const item of itemsList) {
    const start = new Date(item.dueDate);
    if (Number.isNaN(start.getTime())) continue;
    const end = new Date(start.getTime() + 45 * 60 * 1000);
    const amountTxt = item.amount ? ` (€ ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })})` : '';

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${item.id}@studiocarifi.nola`);
    lines.push(`DTSTAMP:${formatIcsDateUTC(new Date())}`);
    lines.push(`DTSTART:${formatIcsDateUTC(start)}`);
    lines.push(`DTEND:${formatIcsDateUTC(end)}`);
    lines.push(`SUMMARY:${escapeIcsText(`${item.client} — ${item.title}${amountTxt}`)}`);
    lines.push(`DESCRIPTION:${escapeIcsText([item.installmentRef, item.phone ? `Tel: ${item.phone}` : '', item.notes].filter(Boolean).join('\n'))}`);
    lines.push('BEGIN:VALARM');
    lines.push('TRIGGER:-PT30M');
    lines.push('ACTION:DISPLAY');
    lines.push(`DESCRIPTION:${escapeIcsText(`Promemoria Studio Carifi: ${item.client}`)}`);
    lines.push('END:VALARM');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportSingleItemToICS(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const ics = buildIcsContent([item]);
  downloadFile(ics, `studio_carifi_${item.client.replace(/[^a-z0-9]/gi, '_')}.ics`, 'text/calendar;charset=utf-8');
  showToast('File Calendario .ICS scaricato (compatibile iPhone, Mac e Windows)!', 'success');
}

function exportAllToICS() {
  const list = lastFilteredItems.length > 0 ? lastFilteredItems : items.filter((i) => !i.completed);
  if (list.length === 0) {
    showToast('Nessun appuntamento da esportare nel calendario.', 'warning');
    return;
  }
  const ics = buildIcsContent(list);
  downloadFile(ics, `agenda_studio_carifi_${new Date().toISOString().slice(0, 10)}.ics`, 'text/calendar;charset=utf-8');
  showToast(`Esportati ${list.length} impegni in formato Calendario (.ics)!`, 'success');
}

// ============================================================================
// RENDERING INTERFACCIA, KPI, VISTE (CARD / ELENCO / CALENDARIO) E PAGINAZIONE
// ============================================================================
function renderAll() {
  renderKPIs();
  renderClientFilterOptions();
  if (currentViewMode === 'calendar') {
    renderCalendarView();
  }
  renderItems();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderClientFilterOptions() {
  const sel = document.getElementById('clientFilter');
  if (!sel) return;
  const currentVal = sel.value || 'all';
  const counts = {};
  for (const it of items) {
    if (currentFilter !== 'completed' && it.completed) continue;
    if (currentFilter === 'completed' && !it.completed) continue;
    const name = (it.client || '').trim();
    if (!name) continue;
    counts[name] = (counts[name] || 0) + 1;
  }

  const sortedClients = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'it'));
  sel.innerHTML = `<option value="all">Cliente: Tutti (${sortedClients.length})</option>` +
    sortedClients.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)} (${counts[c]})</option>`).join('');

  if (sortedClients.includes(currentVal)) {
    sel.value = currentVal;
  } else {
    sel.value = 'all';
  }
}

function renderKPIs() {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const next7End = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const activeItems = items.filter((i) => !i.completed);
  const dueTodayOrOverdue = activeItems.filter((i) => new Date(i.dueDate) <= endOfToday).length;
  const highIntensityCount = activeItems.filter((i) => i.intensity === 'high').length;

  const installmentItems = activeItems.filter((i) => ['rateizzo', 'f24', 'rottamazione'].includes(i.category));
  const totalAmount = installmentItems.reduce((acc, cur) => acc + (Number(cur.amount) || 0), 0);

  const appointmentItems = activeItems.filter((i) => i.category === 'appuntamento');
  const next7Count = appointmentItems.filter((i) => {
    const d = new Date(i.dueDate);
    return d >= now && d <= next7End;
  }).length;

  document.getElementById('kpiDueToday').textContent = String(dueTodayOrOverdue);
  document.getElementById('kpiHighIntensity').textContent = String(highIntensityCount);
  document.getElementById('kpiInstallments').textContent = String(installmentItems.length);
  document.getElementById('kpiInstallmentsAmount').textContent =
    '€ ' + totalAmount.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('kpiAppointments').textContent = String(appointmentItems.length);
  const next7El = document.getElementById('kpiNext7Days');
  if (next7El) next7El.textContent = `${next7Count} nei prossimi 7gg`;
}

function setQuickFilter(filter) {
  currentFilter = filter;
  visibleLimit = 30;
  document.querySelectorAll('.filter-tab').forEach((btn) => {
    if (btn.dataset.filter === filter) {
      btn.className = 'filter-tab px-3.5 py-2 rounded-xl text-xs font-bold bg-carifi-navy text-white shadow-xs whitespace-nowrap transition';
    } else {
      btn.className = 'filter-tab px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 whitespace-nowrap transition';
    }
  });
  renderAll();
}

function setViewMode(mode) {
  currentViewMode = mode;
  document.querySelectorAll('.view-btn').forEach((btn) => {
    if (btn.dataset.view === mode) {
      btn.className = 'view-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-white text-carifi-navy shadow-xs transition';
    } else {
      btn.className = 'view-btn inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-carifi-navy transition';
    }
  });

  const calSection = document.getElementById('calendarViewSection');
  if (mode === 'calendar') {
    calSection.classList.remove('hidden');
  } else {
    calSection.classList.add('hidden');
  }

  renderAll();
}

function handleSearchInput() {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('btnClearSearch');
  if (clearBtn) {
    if (input.value.trim()) clearBtn.classList.remove('hidden');
    else clearBtn.classList.add('hidden');
  }

  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    visibleLimit = 30;
    renderItems();
  }, 120);
}

function clearSearchInput() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  const clearBtn = document.getElementById('btnClearSearch');
  if (clearBtn) clearBtn.classList.add('hidden');
  visibleLimit = 30;
  renderItems();
}

function resetPaginationAndRender() {
  visibleLimit = 30;
  renderAll();
}

function loadMoreItems(step = 30) {
  visibleLimit += step;
  renderItems();
}

function loadAllItems() {
  visibleLimit = Math.max(items.length, 5000);
  renderItems();
}

function getFilteredAndSortedItems() {
  const searchQuery = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
  const sortMode = document.getElementById('sortSelect')?.value || 'due_asc';
  const periodMode = document.getElementById('periodFilter')?.value || 'all';
  const clientMode = document.getElementById('clientFilter')?.value || 'all';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const endOfWeek = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
  const endOf30 = new Date(startOfToday.getTime() + 30 * 24 * 60 * 60 * 1000);

  const filtered = items.filter((item) => {
    if (currentFilter === 'completed') {
      if (!item.completed) return false;
    } else {
      if (item.completed) return false;
      if (currentFilter === 'appuntamento' && item.category !== 'appuntamento') return false;
      if (currentFilter === 'rateizzo' && !['rateizzo', 'f24', 'rottamazione'].includes(item.category)) return false;
      if (currentFilter === 'urgent' && new Date(item.dueDate) > endOfToday) return false;
      if (currentFilter === 'high_intensity' && item.intensity !== 'high') return false;
    }

    if (clientMode !== 'all' && (item.client || '').trim() !== clientMode) {
      return false;
    }

    const dueDateObj = new Date(item.dueDate);

    if (selectedCalendarDate) {
      if (toDateKey(dueDateObj) !== selectedCalendarDate) return false;
    }

    if (periodMode === 'today') {
      if (dueDateObj < startOfToday || dueDateObj > endOfToday) return false;
    } else if (periodMode === 'week') {
      if (dueDateObj < startOfToday || dueDateObj > endOfWeek) return false;
    } else if (periodMode === 'month') {
      if (dueDateObj.getMonth() !== now.getMonth() || dueDateObj.getFullYear() !== now.getFullYear()) return false;
    } else if (periodMode === 'next30') {
      if (dueDateObj < startOfToday || dueDateObj > endOf30) return false;
    } else if (periodMode === 'overdue') {
      if (dueDateObj >= now) return false;
    }

    if (searchQuery) {
      const haystack = `${item.client} ${item.title} ${item.installmentRef || ''} ${item.phone || ''} ${item.notes || ''}`.toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sortMode === 'due_asc') return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    if (sortMode === 'due_desc') return new Date(b.dueDate).getTime() - new Date(a.dueDate).getTime();
    if (sortMode === 'intensity_desc') {
      const rank = { high: 3, medium: 2, low: 1 };
      return (rank[b.intensity] || 0) - (rank[a.intensity] || 0) || (new Date(a.dueDate) - new Date(b.dueDate));
    }
    if (sortMode === 'client_asc') return (a.client || '').localeCompare(b.client || '');
    if (sortMode === 'amount_desc') return (Number(b.amount) || 0) - (Number(a.amount) || 0);
    return 0;
  });

  return filtered;
}

function renderItems() {
  const container = document.getElementById('itemsContainer');
  const emptyState = document.getElementById('emptyState');
  const paginationBar = document.getElementById('paginationBar');
  const resultsCounter = document.getElementById('resultsCounter');
  const btnLoadMoreText = document.getElementById('btnLoadMoreText');

  const filtered = getFilteredAndSortedItems();
  lastFilteredItems = filtered;

  if (filtered.length === 0) {
    container.innerHTML = '';
    container.className = 'grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5';
    emptyState.classList.remove('hidden');
    paginationBar.classList.add('hidden');
    if (resultsCounter) {
      resultsCounter.textContent = items.length === 0
        ? '0 elementi in agenda'
        : `0 risultati su ${items.length} elementi totali`;
    }
    const emptyTitle = document.getElementById('emptyStateTitle');
    const emptyDesc = document.getElementById('emptyStateDesc');
    if (items.length > 0 && emptyTitle && emptyDesc) {
      emptyTitle.textContent = 'NESSUN RISULTATO CON I FILTRI SELEZIONATI';
      emptyDesc.textContent = 'Prova a modificare la ricerca, il periodo oppure a rimuovere il filtro del giorno selezionato.';
    } else if (emptyTitle && emptyDesc) {
      emptyTitle.textContent = 'AGENDA PULITA — PRONTA PER I NUOVI APPUNTAMENTI';
      emptyDesc.innerHTML = 'Tutti gli appuntamenti precedenti sono stati rimossi. Puoi inserire un nuovo impegno oppure <strong>importare il tuo file Excel (anche da 630+ righe)</strong>.';
    }
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  emptyState.classList.add('hidden');
  const slice = filtered.slice(0, visibleLimit);
  const remaining = filtered.length - slice.length;

  if (resultsCounter) {
    const filteredAmount = filtered.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);
    const amountSuffix = filteredAmount > 0
      ? ` • Totale selezione: € ${filteredAmount.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '';
    resultsCounter.textContent = remaining > 0
      ? `Mostrati ${slice.length} di ${filtered.length} impegni (${items.length} totali)${amountSuffix}`
      : `${filtered.length} ${filtered.length === 1 ? 'impegno' : 'impegni'} visualizzati${amountSuffix}`;
  }

  if (remaining > 0) {
    paginationBar.classList.remove('hidden');
    if (btnLoadMoreText) {
      btnLoadMoreText.textContent = `Carica altri ${Math.min(30, remaining)} (${remaining} rimanenti)`;
    }
  } else {
    paginationBar.classList.add('hidden');
  }

  const nowMs = Date.now();

  if (currentViewMode === 'table') {
    container.className = 'carifi-card rounded-2xl overflow-hidden';
    container.innerHTML = renderCompactTableHtml(slice, nowMs);
  } else {
    container.className = 'grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-5';
    container.innerHTML = slice.map((item) => renderItemCardHtml(item, nowMs)).join('');
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderItemCardHtml(item, nowMs) {
  const dueMs = new Date(item.dueDate).getTime();
  const routine = getRoutineById(item.routineId);
  const nextSlot = routine ? getNextScheduledSlot(item, nowMs) : null;
  const displayNotifyIso = nextSlot ? nextSlot.atIso : item.notifyStartAt;
  const notifyStartMs = new Date(displayNotifyIso || item.notifyStartAt).getTime();
  const isOverdue = !item.completed && dueMs < nowMs;
  const hasFiredRecentSlot = Boolean(routine && Object.values(item.firedSlots || {}).some((ts) => (nowMs - new Date(ts).getTime()) <= 24 * 60 * 60 * 1000));
  const isAlarmRinging = !item.completed && !item.acknowledged && (routine ? hasFiredRecentSlot : nowMs >= notifyStartMs);

  const categoryMeta = getCategoryBadgeMeta(item.category);
  const intensityMeta = getIntensityBadgeMeta(item.intensity, item.repeatMinutes, routine);
  const countdownText = getRelativeTimeLabel(dueMs, nowMs, item.completed);

  return `
    <article id="item-${item.id}" class="carifi-card rounded-2xl p-5 flex flex-col justify-between relative overflow-hidden ${
      isAlarmRinging && item.intensity === 'high'
        ? 'urgent-card-active border-2 border-carifi-crimson bg-red-50/15'
        : isOverdue
        ? 'border-carifi-crimson/50'
        : ''
    }">
      <div class="absolute top-0 left-0 w-1.5 h-full ${
        item.intensity === 'high' ? 'bg-carifi-crimson' : 'bg-carifi-navy'
      }"></div>

      <div class="pl-2">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold ${categoryMeta.classes}">
              ${categoryMeta.label}
            </span>
            <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold ${intensityMeta.classes}">
              ${intensityMeta.label}
            </span>
          </div>

          ${
            item.amount
              ? `<div class="text-right">
                   <span class="text-base font-extrabold text-carifi-navy bg-slate-100 px-3 py-1 rounded-xl border border-slate-200">
                     € ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                   </span>
                 </div>`
              : ''
          }
        </div>

        <div class="space-y-1">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-extrabold uppercase tracking-wider text-carifi-crimson">
              ${escapeHtml(item.client)}
            </span>
            ${
              item.installmentRef
                ? `<span class="text-xs font-semibold text-carifi-navy bg-slate-100 px-2.5 py-0.5 rounded-md border border-slate-200">
                     ${escapeHtml(item.installmentRef)}
                   </span>`
                : ''
            }
          </div>
          <h3 class="text-base font-bold text-carifi-navy leading-snug ${item.completed ? 'line-through text-slate-400' : ''}">
            ${escapeHtml(item.title)}
          </h3>
        </div>

        <div class="mt-3.5 p-3 rounded-xl bg-slate-50 border border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div class="flex items-center gap-2.5">
            <i data-lucide="calendar-clock" class="w-4 h-4 ${isOverdue ? 'text-carifi-crimson' : 'text-carifi-navy'} shrink-0"></i>
            <div>
              <span class="text-[11px] text-slate-500 block">Data e Ora:</span>
              <span class="font-bold ${isOverdue ? 'text-carifi-crimson' : 'text-carifi-navy'}">
                ${formatDateTimeIT(item.dueDate)}
              </span>
              <span class="block text-[11px] font-semibold ${isOverdue ? 'text-carifi-crimson' : 'text-slate-600'}">
                ${countdownText}
              </span>
            </div>
          </div>

          <div class="flex items-center gap-2.5">
            <i data-lucide="bell-ring" class="w-4 h-4 ${isAlarmRinging ? 'text-carifi-crimson animate-bell' : 'text-carifi-navy'} shrink-0"></i>
            <div>
              <span class="text-[11px] text-slate-500 block">${routine ? 'Prossimo Avviso (Routine):' : 'Inizio Avvisi:'}</span>
              <span class="font-semibold text-carifi-navy">
                ${formatDateTimeIT(displayNotifyIso)}
              </span>
              <span class="block text-[11px] ${item.acknowledged ? 'text-emerald-700 font-semibold' : 'text-slate-500'}">
                ${
                  item.completed
                    ? '✅ Pratica Conclusa'
                    : item.acknowledged
                    ? '✔ Preso in carico'
                    : isAlarmRinging
                    ? '🚨 IN ALLERTA — In attesa di conferma!'
                    : routine
                    ? escapeHtml(formatRoutineSummary(routine))
                    : 'In programma'
                }
              </span>
            </div>
          </div>
        </div>

        ${
          item.notes
            ? `<p class="mt-3 text-xs text-slate-600 bg-slate-50 border-l-2 border-carifi-crimson pl-3 py-1.5 rounded-r-lg">
                 ${escapeHtml(item.notes)}
               </p>`
            : ''
        }
      </div>

      <div class="mt-4 pt-3 pl-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 no-print">
        <div class="flex flex-wrap items-center gap-1.5">
          ${
            isAlarmRinging && !item.acknowledged
              ? `<button onclick="acknowledgeItem('${item.id}')" class="btn-carifi-crimson inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold">
                   <i data-lucide="bell-off" class="w-3.5 h-3.5"></i>
                   <span>Conferma</span>
                 </button>
                 <button onclick="snoozeItem('${item.id}', 15)" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-amber-100 hover:bg-amber-200 text-amber-900 transition">
                   <span>+15m</span>
                 </button>`
              : ''
          }

          <button onclick="toggleCompleteItem('${item.id}')" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold ${
            item.completed
              ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
              : 'btn-carifi-navy text-white'
          } transition">
            <i data-lucide="${item.completed ? 'rotate-ccw' : 'check-circle-2'}" class="w-3.5 h-3.5"></i>
            <span>${item.completed ? 'Riapri' : (item.category === 'appuntamento' ? 'Completato' : 'Pagato')}</span>
          </button>

          ${
            ['rateizzo', 'rottamazione', 'f24'].includes(item.category)
              ? `<button onclick="duplicateNextInstallment('${item.id}')" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-carifi-navy transition" title="Crea la rata del mese successivo">
                   <i data-lucide="copy-plus" class="w-3.5 h-3.5"></i>
                   <span>+ Rata</span>
                 </button>`
              : ''
          }
        </div>

        <div class="flex items-center gap-1">
          <button onclick="exportSingleItemToICS('${item.id}')" class="p-2 rounded-xl text-carifi-navy hover:bg-slate-100 transition" title="Aggiungi al Calendario iPhone / PC (.ics)">
            <i data-lucide="calendar-plus" class="w-4 h-4"></i>
          </button>
          <button onclick="notifyClientWhatsApp('${item.id}')" class="p-2 rounded-xl text-emerald-700 hover:bg-emerald-50 transition" title="Invia promemoria WhatsApp al cliente">
            <i data-lucide="message-circle" class="w-4 h-4"></i>
          </button>
          <button onclick="openItemModal('${item.id}')" class="p-2 rounded-xl text-carifi-navy hover:bg-slate-100 transition" title="Modifica">
            <i data-lucide="pencil" class="w-4 h-4"></i>
          </button>
          <button onclick="deleteItem('${item.id}')" class="p-2 rounded-xl text-carifi-crimson hover:bg-red-50 transition" title="Elimina">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
    </article>
  `;
}

function renderCompactTableHtml(slice, nowMs) {
  const rowsHtml = slice.map((item) => {
    const dueMs = new Date(item.dueDate).getTime();
    const isOverdue = !item.completed && dueMs < nowMs;
    const cat = getCategoryBadgeMeta(item.category);
    const amountStr = item.amount
      ? `€ ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })}`
      : '—';

    return `
      <tr id="item-${item.id}" class="hover:bg-slate-50 transition ${isOverdue ? 'bg-red-50/30' : ''}">
        <td class="px-4 py-3 whitespace-nowrap">
          <div class="font-bold text-xs ${isOverdue ? 'text-carifi-crimson' : 'text-carifi-navy'}">${formatDateTimeIT(item.dueDate)}</div>
          <div class="text-[11px] ${isOverdue ? 'text-carifi-crimson font-semibold' : 'text-slate-500'}">${getRelativeTimeLabel(dueMs, nowMs, item.completed)}</div>
        </td>
        <td class="px-4 py-3">
          <div class="text-xs font-extrabold uppercase text-carifi-crimson">${escapeHtml(item.client)}</div>
          <div class="text-xs font-bold text-carifi-navy ${item.completed ? 'line-through text-slate-400' : ''}">${escapeHtml(item.title)}</div>
          ${item.notes ? `<div class="text-[11px] text-slate-500 truncate max-w-xs">${escapeHtml(item.notes)}</div>` : ''}
        </td>
        <td class="px-4 py-3 whitespace-nowrap">
          <span class="px-2 py-0.5 rounded-md text-[11px] font-bold ${cat.classes}">${cat.label}</span>
        </td>
        <td class="px-4 py-3 whitespace-nowrap text-xs font-bold text-carifi-navy">${amountStr}</td>
        <td class="px-4 py-3 whitespace-nowrap text-right no-print">
          <div class="inline-flex items-center gap-1">
            <button onclick="toggleCompleteItem('${item.id}')" class="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50" title="${item.completed ? 'Riapri' : 'Completa'}">
              <i data-lucide="${item.completed ? 'rotate-ccw' : 'check-circle-2'}" class="w-4 h-4"></i>
            </button>
            <button onclick="exportSingleItemToICS('${item.id}')" class="p-1.5 rounded-lg text-carifi-navy hover:bg-slate-100" title="Calendario .ics">
              <i data-lucide="calendar-plus" class="w-4 h-4"></i>
            </button>
            <button onclick="notifyClientWhatsApp('${item.id}')" class="p-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50" title="WhatsApp">
              <i data-lucide="message-circle" class="w-4 h-4"></i>
            </button>
            <button onclick="openItemModal('${item.id}')" class="p-1.5 rounded-lg text-carifi-navy hover:bg-slate-100" title="Modifica">
              <i data-lucide="pencil" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteItem('${item.id}')" class="p-1.5 rounded-lg text-carifi-crimson hover:bg-red-50" title="Elimina">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  return `
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead class="bg-carifi-navy text-white text-[11px] uppercase tracking-wider">
          <tr>
            <th class="px-4 py-3">Data e Ora</th>
            <th class="px-4 py-3">Cliente & Oggetto</th>
            <th class="px-4 py-3">Tipologia</th>
            <th class="px-4 py-3">Importo</th>
            <th class="px-4 py-3 text-right no-print">Azioni</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

// ============================================================================
// VISTA CALENDARIO MENSILE INTERATTIVA
// ============================================================================
function renderCalendarView() {
  const grid = document.getElementById('calendarGrid');
  const label = document.getElementById('calendarMonthLabel');
  if (!grid || !label) return;

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();

  label.textContent = new Date(year, month, 1).toLocaleDateString('it-IT', {
    month: 'long',
    year: 'numeric'
  });

  // Conta impegni per giorno nel mese corrente
  const countMap = {};
  for (const item of items) {
    if (currentFilter !== 'completed' && item.completed) continue;
    if (currentFilter === 'completed' && !item.completed) continue;
    const d = new Date(item.dueDate);
    if (d.getFullYear() === year && d.getMonth() === month) {
      const key = toDateKey(d);
      if (!countMap[key]) countMap[key] = { total: 0, urgent: 0 };
      countMap[key].total++;
      if (item.intensity === 'high') countMap[key].urgent++;
    }
  }

  const firstDay = new Date(year, month, 1);
  const startWeekday = (firstDay.getDay() + 6) % 7; // 0 = Lunedì
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = toDateKey(new Date());

  let cellsHtml = '';
  for (let i = 0; i < startWeekday; i++) {
    cellsHtml += `<div class="rounded-xl bg-slate-50/50 border border-transparent"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const stats = countMap[key];
    const isToday = key === todayKey;
    const isSelected = key === selectedCalendarDate;

    cellsHtml += `
      <button type="button" onclick="selectCalendarDate('${key}')" class="cal-day-cell rounded-xl border p-1.5 sm:p-2 text-left flex flex-col justify-between ${
        isSelected ? 'cal-day-selected' : isToday ? 'cal-day-today' : 'border-slate-200 bg-white'
      }">
        <span class="text-xs font-extrabold ${isToday ? 'text-carifi-crimson' : 'text-carifi-navy'}">${day}</span>
        ${
          stats
            ? `<div class="flex flex-wrap items-center gap-1 mt-1">
                 <span class="px-1.5 py-0.5 rounded-md text-[10px] font-extrabold ${
                   stats.urgent > 0 ? 'bg-carifi-crimson text-white' : 'bg-carifi-navy text-white'
                 }">${stats.total}</span>
               </div>`
            : ''
        }
      </button>
    `;
  }

  grid.innerHTML = cellsHtml;
}

function selectCalendarDate(dateKey) {
  selectedCalendarDate = selectedCalendarDate === dateKey ? null : dateKey;
  visibleLimit = 30;
  updateSelectedDateChip();
  renderAll();
}

function clearSelectedCalendarDate() {
  selectedCalendarDate = null;
  updateSelectedDateChip();
  renderAll();
}

function updateSelectedDateChip() {
  const chip = document.getElementById('selectedDateChip');
  const text = document.getElementById('selectedDateChipText');
  if (!chip || !text) return;

  if (selectedCalendarDate) {
    const [y, m, d] = selectedCalendarDate.split('-');
    text.textContent = `Giorno: ${d}/${m}/${y}`;
    chip.classList.remove('hidden');
  } else {
    chip.classList.add('hidden');
  }
}

function changeCalendarMonth(delta) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + delta, 1);
  renderCalendarView();
}

function goToCurrentMonth() {
  calendarCursor = new Date();
  renderCalendarView();
}

// ============================================================================
// POPOLAMENTO SELETTORI ROUTINE (MODALE 1, MODALE 2, IMPORT EXCEL)
// ============================================================================
function populateRoutineDropdown(selectId, selectedId = null, includeManual = false) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const defId = appConfig.defaultRoutineId || (appConfig.routines[0]?.id || 'routine-studio-carifi');
  let html = (appConfig.routines || []).map((rt) => {
    const star = rt.id === defId ? '⭐ ' : '';
    return `<option value="${escapeHtml(rt.id)}">${star}${escapeHtml(rt.name)}</option>`;
  }).join('');
  if (includeManual) {
    html += `<option value="manual">⚙️ Personalizzata (Manuale)</option>`;
  }
  sel.innerHTML = html;

  const target = selectedId || defId;
  if ([...sel.options].some((o) => o.value === target)) {
    sel.value = target;
  } else if (sel.options.length > 0) {
    sel.selectedIndex = 0;
  }
}

// ============================================================================
// MODALE 1: CREA / MODIFICA SINGOLO APPUNTAMENTO O RATEIZZO
// ============================================================================
function openItemModal(editId = null) {
  const modal = document.getElementById('itemModal');
  const titleEl = document.getElementById('itemModalTitle');
  const form = document.getElementById('itemForm');
  form.reset();

  if (editId) {
    const item = items.find((i) => i.id === editId);
    if (!item) return;
    titleEl.textContent = 'Modifica Appuntamento / Scadenza';
    document.getElementById('itemId').value = item.id;
    document.getElementById('itemCategory').value = item.category;
    document.getElementById('itemClient').value = item.client;
    document.getElementById('itemTitle').value = item.title;
    document.getElementById('itemAmount').value = item.amount ?? '';
    document.getElementById('itemInstallmentRef').value = item.installmentRef || '';
    document.getElementById('itemPhone').value = item.phone || '';
    document.getElementById('itemDueDate').value = toLocalDatetimeInputValue(item.dueDate);

    const assignedRoutine = item.routineId && getRoutineById(item.routineId) ? item.routineId : 'manual';
    populateRoutineDropdown('itemRoutineId', assignedRoutine, true);
    document.getElementById('itemCustomFirstAlertAt').value = item.customFirstAlertAt
      ? toLocalDatetimeInputValue(item.customFirstAlertAt)
      : '';

    document.getElementById('itemLeadTime').value = String(item.leadMinutes ?? '30');
    if (item.leadMinutes === 'custom') {
      document.getElementById('customNotifyWrapper').classList.remove('hidden');
      document.getElementById('itemCustomNotifyAt').value = toLocalDatetimeInputValue(item.notifyStartAt);
    } else {
      document.getElementById('customNotifyWrapper').classList.add('hidden');
    }

    document.getElementById('preAlert7d').checked = Boolean(item.preAlerts?.d7);
    document.getElementById('preAlert3d').checked = Boolean(item.preAlerts?.d3);
    document.getElementById('preAlertMorning').checked = Boolean(item.preAlerts?.morning);

    const radio = document.querySelector(`input[name="intensityLevel"][value="${item.intensity || 'high'}"]`);
    if (radio) radio.checked = true;

    document.getElementById('itemRepeatMinutes').value = String(item.repeatMinutes || 60);
    document.getElementById('itemNotes').value = item.notes || '';
  } else {
    titleEl.textContent = 'Nuovo Appuntamento o Scadenza';
    document.getElementById('itemId').value = '';
    const defaultDue = selectedCalendarDate
      ? new Date(`${selectedCalendarDate}T18:00:00`)
      : new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    if (!selectedCalendarDate) defaultDue.setHours(18, 0, 0, 0);
    document.getElementById('itemDueDate').value = toLocalDatetimeInputValue(defaultDue.toISOString());

    const defRoutine = getDefaultRoutine();
    populateRoutineDropdown('itemRoutineId', defRoutine?.id || 'routine-studio-carifi', true);
    document.getElementById('itemCustomFirstAlertAt').value = '';
    document.getElementById('itemLeadTime').value = '30';
    document.getElementById('customNotifyWrapper').classList.add('hidden');

    const radio = document.querySelector(`input[name="intensityLevel"][value="${defRoutine?.intensity || 'high'}"]`);
    if (radio) radio.checked = true;
  }

  handleRoutineSelectChange();
  handleIntensityChange();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (window.lucide) window.lucide.createIcons();
}

function closeItemModal() {
  const modal = document.getElementById('itemModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function handleRoutineSelectChange() {
  const routineId = document.getElementById('itemRoutineId')?.value || 'manual';
  const previewBox = document.getElementById('routinePreviewBox');
  const manualBox = document.getElementById('manualNotifRulesWrapper');

  if (routineId === 'manual') {
    if (previewBox) previewBox.classList.add('hidden');
    if (manualBox) manualBox.classList.remove('hidden');
  } else {
    if (previewBox) previewBox.classList.remove('hidden');
    if (manualBox) manualBox.classList.add('hidden');
    const rt = getRoutineById(routineId);
    if (rt && rt.intensity) {
      const radio = document.querySelector(`input[name="intensityLevel"][value="${rt.intensity}"]`);
      if (radio) radio.checked = true;
    }
  }
  updatePreviewNotifyTime();
}

function editSelectedRoutine() {
  const routineId = document.getElementById('itemRoutineId')?.value;
  if (!routineId || routineId === 'manual') {
    openRoutineManagerModal(false);
  } else {
    openRoutineManagerModal(false, routineId);
  }
}

function handleLeadTimeChange() {
  const val = document.getElementById('itemLeadTime').value;
  const wrapper = document.getElementById('customNotifyWrapper');
  if (val === 'custom') {
    wrapper.classList.remove('hidden');
    const dueVal = document.getElementById('itemDueDate').value;
    if (dueVal && !document.getElementById('itemCustomNotifyAt').value) {
      document.getElementById('itemCustomNotifyAt').value = dueVal;
    }
  } else {
    wrapper.classList.add('hidden');
  }
  updatePreviewNotifyTime();
}

function handleIntensityChange() {
  const selected = document.querySelector('input[name="intensityLevel"]:checked')?.value || 'medium';
  const repeatWrapper = document.getElementById('repeatIntervalWrapper');
  const repeatSelect = document.getElementById('itemRepeatMinutes');
  if (!repeatWrapper || !repeatSelect) return;

  if (selected === 'low') {
    repeatWrapper.classList.add('opacity-50', 'pointer-events-none');
  } else {
    repeatWrapper.classList.remove('opacity-50', 'pointer-events-none');
    if (selected === 'high' && Number(repeatSelect.value) > 30) {
      repeatSelect.value = '15';
    }
  }
}

function handleCategoryChange() {
  const cat = document.getElementById('itemCategory').value;
  if (['rateizzo', 'rottamazione', 'f24', 'contratto'].includes(cat)) {
    const intensityHigh = document.querySelector('input[name="intensityLevel"][value="high"]');
    if (intensityHigh) intensityHigh.checked = true;
    handleIntensityChange();
  }
}

function updatePreviewNotifyTime() {
  const badge = document.getElementById('previewNotifyBadge');
  const dueVal = document.getElementById('itemDueDate')?.value;
  if (!dueVal) {
    if (badge) badge.textContent = '';
    return;
  }

  const routineId = document.getElementById('itemRoutineId')?.value || 'manual';
  const customFirst = document.getElementById('itemCustomFirstAlertAt')?.value || '';

  if (routineId !== 'manual') {
    const rt = getRoutineById(routineId);
    const summaryEl = document.getElementById('routineSummaryText');
    const slotsEl = document.getElementById('routinePreviewSlots');
    if (summaryEl) summaryEl.textContent = formatRoutineSummary(rt);

    const previewItem = {
      dueDate: new Date(dueVal).toISOString(),
      routineId,
      customFirstAlertAt: customFirst ? new Date(customFirst).toISOString() : null
    };
    const slots = computeRoutineNotificationSlots(previewItem, rt);
    if (badge) {
      badge.textContent = slots.length > 0
        ? `1° Avviso: ${formatDateTimeIT(slots[0].atIso)} (${slots.length} avvisi totali)`
        : 'Nessun avviso';
    }
    if (slotsEl) {
      slotsEl.innerHTML = slots.map((s) => `
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-100 border border-slate-200 text-carifi-navy font-semibold">
          <span>🔔</span>
          <span>${formatDateTimeIT(s.atIso)}</span>
        </span>
      `).join('') || '<span class="text-slate-400">Nessun avviso configurato</span>';
    }
    return;
  }

  const leadVal = document.getElementById('itemLeadTime').value;
  let notifyDate;
  if (leadVal === 'custom') {
    const customVal = document.getElementById('itemCustomNotifyAt').value;
    notifyDate = customVal ? new Date(customVal) : new Date(dueVal);
  } else {
    notifyDate = new Date(new Date(dueVal).getTime() - Number(leadVal || 0) * 60 * 1000);
  }
  if (badge) badge.textContent = `1° Avviso: ${formatDateTimeIT(notifyDate.toISOString())}`;
}

function saveItemForm(e) {
  e.preventDefault();
  const id = document.getElementById('itemId').value;
  const category = document.getElementById('itemCategory').value;
  const client = document.getElementById('itemClient').value.trim();
  const title = document.getElementById('itemTitle').value.trim();
  const amountRaw = document.getElementById('itemAmount').value;
  const amount = amountRaw !== '' ? Number(amountRaw) : null;
  const installmentRef = document.getElementById('itemInstallmentRef').value.trim();
  const phone = document.getElementById('itemPhone').value.trim();
  const dueDateLocal = document.getElementById('itemDueDate').value;
  const routineId = document.getElementById('itemRoutineId').value || 'manual';
  const customFirstRaw = document.getElementById('itemCustomFirstAlertAt').value;
  const customFirstAlertAt = (routineId !== 'manual' && customFirstRaw)
    ? new Date(customFirstRaw).toISOString()
    : null;
  const leadTimeVal = document.getElementById('itemLeadTime').value;
  const intensity = document.querySelector('input[name="intensityLevel"]:checked')?.value || 'high';
  const repeatMinutes = Number(document.getElementById('itemRepeatMinutes').value || 60);
  const notes = document.getElementById('itemNotes').value.trim();

  const dueDateObj = new Date(dueDateLocal);
  let notifyStartObj;
  if (routineId !== 'manual') {
    const slots = computeRoutineNotificationSlots({
      dueDate: dueDateObj.toISOString(),
      routineId,
      customFirstAlertAt
    });
    notifyStartObj = slots.length > 0 ? new Date(slots[0].atMs) : dueDateObj;
  } else if (leadTimeVal === 'custom') {
    const customVal = document.getElementById('itemCustomNotifyAt').value;
    notifyStartObj = customVal ? new Date(customVal) : dueDateObj;
  } else {
    notifyStartObj = new Date(dueDateObj.getTime() - Number(leadTimeVal || 0) * 60 * 1000);
  }

  const preAlerts = {
    d7: document.getElementById('preAlert7d').checked,
    d3: document.getElementById('preAlert3d').checked,
    morning: document.getElementById('preAlertMorning').checked
  };

  const itemData = {
    id: id || ('carifi-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6)),
    category,
    client,
    title,
    amount,
    installmentRef,
    phone,
    dueDate: dueDateObj.toISOString(),
    routineId: routineId === 'manual' ? null : routineId,
    customFirstAlertAt,
    leadMinutes: leadTimeVal,
    notifyStartAt: notifyStartObj.toISOString(),
    preAlerts,
    preAlertsFired: {},
    firedSlots: {},
    scheduledPushSlots: {},
    scheduledPushFor: null,
    intensity,
    repeatMinutes,
    acknowledged: false,
    completed: false,
    lastNotifiedAt: null,
    snoozedUntil: null,
    notes,
    updatedAt: new Date().toISOString()
  };

  if (id) {
    const idx = items.findIndex((i) => i.id === id);
    if (idx >= 0) items[idx] = itemData;
  } else {
    items.push(itemData);
  }

  saveItemsLocally();
  sendCloudDelta({ op: 'UPSERT_ITEM', item: itemData });
  scheduleUpcomingDirectPushes();
  closeItemModal();
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Salvato e sincronizzato: ${client} — ${title}`, 'success');
}

// ============================================================================
// MODALE 2: GENERATORE AUTOMATICO PIANO RATEIZZI
// ============================================================================
function openInstallmentPlanModal() {
  const modal = document.getElementById('planModal');
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  nextWeek.setHours(18, 0, 0, 0);
  document.getElementById('planFirstDate').value = toLocalDatetimeInputValue(nextWeek.toISOString());
  populateRoutineDropdown('planRoutineId', appConfig.defaultRoutineId, false);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeInstallmentPlanModal() {
  const modal = document.getElementById('planModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function generateInstallmentPlan(e) {
  e.preventDefault();
  const client = document.getElementById('planClient').value.trim();
  const baseTitle = document.getElementById('planTitle').value.trim();
  const count = Math.min(120, Math.max(2, Number(document.getElementById('planCount').value || 8)));
  const freq = document.getElementById('planFrequency').value;
  const amountVal = document.getElementById('planAmount').value;
  const amount = amountVal !== '' ? Number(amountVal) : null;
  const firstDateStr = document.getElementById('planFirstDate').value;
  const intensity = document.getElementById('planIntensity').value;
  const routineId = document.getElementById('planRoutineId').value || appConfig.defaultRoutineId;

  const firstDate = new Date(firstDateStr);
  const monthStep = freq === 'quarterly' ? 3 : freq === 'bimonthly' ? 2 : 1;
  const created = [];

  for (let i = 1; i <= count; i++) {
    const due = new Date(firstDate);
    due.setMonth(due.getMonth() + (i - 1) * monthStep);
    const slots = computeRoutineNotificationSlots({ dueDate: due.toISOString(), routineId });
    const notifyStart = slots.length > 0 ? new Date(slots[0].atMs) : new Date(due.getTime() - 7 * 24 * 60 * 60 * 1000);

    const newItem = {
      id: `carifi-plan-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 5)}`,
      category: 'rateizzo',
      client,
      title: `${baseTitle} (${i}ª Rata)`,
      amount,
      installmentRef: `Rata ${i} di ${count}`,
      phone: '',
      dueDate: due.toISOString(),
      routineId,
      customFirstAlertAt: null,
      leadMinutes: '10080',
      notifyStartAt: notifyStart.toISOString(),
      preAlerts: { d7: true, d3: true, morning: true },
      preAlertsFired: {},
      firedSlots: {},
      scheduledPushSlots: {},
      scheduledPushFor: null,
      intensity,
      repeatMinutes: 60,
      acknowledged: false,
      completed: false,
      lastNotifiedAt: null,
      snoozedUntil: null,
      notes: `Piano rateizzo generato automaticamente (${count} rate).`,
      updatedAt: new Date().toISOString()
    };

    items.push(newItem);
    created.push(newItem);
  }

  saveItemsLocally();
  syncItemsInBatches(created);
  scheduleUpcomingDirectPushes();
  closeInstallmentPlanModal();
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Generato e sincronizzato piano di ${count} rate per ${client}!`, 'success');
}

// ============================================================================
// MODALE 5: GESTORE ROUTINE DI NOTIFICHE (CREA / MODIFICA / PREDEFINITA / ELIMINA)
// ============================================================================
function openRoutineManagerModal(createNew = false, editRoutineId = null) {
  renderRoutineListUI();
  if (createNew) {
    startNewRoutine();
  } else {
    const targetId = editRoutineId || appConfig.defaultRoutineId || appConfig.routines[0]?.id;
    if (targetId) selectRoutineForEdit(targetId);
    else startNewRoutine();
  }

  const modal = document.getElementById('routineModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (window.lucide) window.lucide.createIcons();
}

function closeRoutineManagerModal() {
  const modal = document.getElementById('routineModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  // Aggiorna eventuali dropdown aperti nelle altre modali
  const itemModal = document.getElementById('itemModal');
  if (itemModal && !itemModal.classList.contains('hidden')) {
    const currentSel = document.getElementById('itemRoutineId')?.value;
    populateRoutineDropdown('itemRoutineId', currentSel || appConfig.defaultRoutineId, true);
    handleRoutineSelectChange();
  }
}

function renderRoutineListUI() {
  const container = document.getElementById('routineListContainer');
  if (!container) return;
  const activeEditId = document.getElementById('rtId')?.value;

  container.innerHTML = (appConfig.routines || []).map((rt) => {
    const isDef = rt.id === appConfig.defaultRoutineId;
    const isSelected = rt.id === activeEditId;
    return `
      <div onclick="selectRoutineForEdit('${escapeHtml(rt.id)}')" class="p-3 rounded-xl border-2 cursor-pointer transition ${
        isSelected
          ? 'border-carifi-navy bg-blue-50/50'
          : 'border-slate-200 bg-white hover:border-slate-300'
      }">
        <div class="flex items-start justify-between gap-2">
          <span class="text-xs font-extrabold text-carifi-navy leading-snug">${escapeHtml(rt.name)}</span>
          ${isDef ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-carifi-crimson text-white shrink-0">Predefinita</span>' : ''}
        </div>
        <p class="text-[11px] text-slate-600 mt-1">${escapeHtml(formatRoutineSummary(rt))}</p>
      </div>
    `;
  }).join('');
}

function selectRoutineForEdit(routineId) {
  const rt = getRoutineById(routineId);
  if (!rt) return;

  document.getElementById('rtId').value = rt.id;
  document.getElementById('rtName').value = rt.name;
  document.getElementById('rtIntensity').value = rt.intensity || 'high';
  document.getElementById('rtDailyFromDays').value = String(rt.dailyFromDays ?? 2);
  document.getElementById('rtMinutesBeforeDue').value = String(rt.minutesBeforeDue || 0);
  document.getElementById('rtSetAsDefault').checked = rt.id === appConfig.defaultRoutineId;
  document.getElementById('routineEditorTitle').textContent = 'Modifica Routine Selezionata';

  const delBtn = document.getElementById('btnDeleteRoutine');
  if (delBtn) {
    if ((appConfig.routines || []).length > 1) delBtn.classList.remove('hidden');
    else delBtn.classList.add('hidden');
  }

  const preList = document.getElementById('rtPreAlertsList');
  preList.innerHTML = '';
  (rt.preAlertDays || []).forEach((p) => addRoutinePreAlertRow(p.daysBefore, p.time));

  const timesList = document.getElementById('rtDailyTimesList');
  timesList.innerHTML = '';
  (rt.dailyTimes || []).forEach((t) => addRoutineDailyTimeRow(t));

  renderRoutineListUI();
}

function startNewRoutine() {
  document.getElementById('rtId').value = '';
  document.getElementById('rtName').value = '';
  document.getElementById('rtIntensity').value = 'high';
  document.getElementById('rtDailyFromDays').value = '2';
  document.getElementById('rtMinutesBeforeDue').value = '0';
  document.getElementById('rtSetAsDefault').checked = false;
  document.getElementById('routineEditorTitle').textContent = 'Crea Nuova Routine di Notifiche';

  const delBtn = document.getElementById('btnDeleteRoutine');
  if (delBtn) delBtn.classList.add('hidden');

  document.getElementById('rtPreAlertsList').innerHTML = '';
  addRoutinePreAlertRow(7, '09:30');
  addRoutinePreAlertRow(3, '09:30');

  document.getElementById('rtDailyTimesList').innerHTML = '';
  addRoutineDailyTimeRow('11:30');
  addRoutineDailyTimeRow('16:30');

  renderRoutineListUI();
  document.getElementById('rtName').focus();
}

function addRoutinePreAlertRow(days = 5, time = '09:30') {
  const list = document.getElementById('rtPreAlertsList');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'rt-pre-row flex items-center gap-2 bg-slate-50 p-2 rounded-xl border border-slate-200';
  row.innerHTML = `
    <input type="number" min="1" max="90" value="${Number(days) || 1}" class="rt-pre-days w-16 px-2 py-1 text-xs font-bold text-center rounded-lg border border-slate-300 bg-white" />
    <span class="text-xs text-slate-600 font-medium">giorni prima alle</span>
    <input type="time" value="${escapeHtml(time || '09:30')}" class="rt-pre-time px-2 py-1 text-xs font-bold rounded-lg border border-slate-300 bg-white" />
    <button type="button" onclick="this.parentElement.remove()" class="ml-auto p-1 text-carifi-crimson hover:bg-red-50 rounded-lg" title="Rimuovi">✕</button>
  `;
  list.appendChild(row);
}

function addRoutineDailyTimeRow(time = '11:30') {
  const list = document.getElementById('rtDailyTimesList');
  if (!list) return;
  const pill = document.createElement('div');
  pill.className = 'rt-time-pill inline-flex items-center gap-1.5 bg-slate-100 px-2.5 py-1 rounded-xl border border-slate-300';
  pill.innerHTML = `
    <input type="time" value="${escapeHtml(time || '11:30')}" class="rt-daily-time bg-transparent text-xs font-extrabold text-carifi-navy focus:outline-none" />
    <button type="button" onclick="this.parentElement.remove()" class="text-carifi-crimson hover:text-red-800 text-xs font-bold" title="Rimuovi orario">✕</button>
  `;
  list.appendChild(pill);
}

function saveRoutineForm(e) {
  e.preventDefault();
  const id = document.getElementById('rtId').value || ('routine-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6));
  const name = document.getElementById('rtName').value.trim();
  if (!name) return;

  const intensity = document.getElementById('rtIntensity').value || 'high';
  const dailyFromDays = Math.max(0, Number(document.getElementById('rtDailyFromDays').value || 0));
  const minutesBeforeDue = Math.max(0, Number(document.getElementById('rtMinutesBeforeDue').value || 0));
  const setAsDefault = document.getElementById('rtSetAsDefault').checked;

  const preAlertDays = [];
  document.querySelectorAll('#rtPreAlertsList .rt-pre-row').forEach((row) => {
    const d = Number(row.querySelector('.rt-pre-days')?.value || 0);
    const t = row.querySelector('.rt-pre-time')?.value || '09:30';
    if (d > 0) preAlertDays.push({ daysBefore: d, time: t });
  });

  const dailyTimes = [];
  document.querySelectorAll('#rtDailyTimesList .rt-daily-time').forEach((inp) => {
    if (inp.value) dailyTimes.push(inp.value);
  });

  const routineObj = {
    id,
    name,
    intensity,
    preAlertDays,
    dailyFromDays,
    dailyTimes: [...new Set(dailyTimes)].sort(),
    minutesBeforeDue
  };

  const idx = (appConfig.routines || []).findIndex((r) => r.id === id);
  if (idx >= 0) appConfig.routines[idx] = routineObj;
  else appConfig.routines.push(routineObj);

  if (setAsDefault) {
    appConfig.defaultRoutineId = id;
  }

  saveConfig();
  sendCloudDelta({
    op: 'SYNC_ROUTINES',
    routines: appConfig.routines,
    defaultRoutineId: appConfig.defaultRoutineId
  });

  // Aggiorna la preview e riprogramma eventuali push 72h delle scadenze collegate a questa routine
  items.forEach((it) => {
    if (it.routineId === id && !it.completed) {
      it.scheduledPushSlots = {};
      const slots = computeRoutineNotificationSlots(it);
      if (slots.length > 0) it.notifyStartAt = slots[0].atIso;
    }
  });
  saveItemsLocally(false);
  scheduleUpcomingDirectPushes();

  selectRoutineForEdit(id);
  renderAll();

  // Se la modale Nuovo Impegno era aperta dietro, seleziona subito la routine appena salvata
  const itemModal = document.getElementById('itemModal');
  if (itemModal && !itemModal.classList.contains('hidden')) {
    populateRoutineDropdown('itemRoutineId', id, true);
    handleRoutineSelectChange();
  }

  showToast(`Routine "${name}" salvata e sincronizzata!`, 'success');
}

function deleteEditingRoutine() {
  const id = document.getElementById('rtId').value;
  if (!id || (appConfig.routines || []).length <= 1) return;
  const rt = getRoutineById(id);
  if (!confirm(`Eliminare la routine "${rt?.name || ''}"?`)) return;

  appConfig.routines = appConfig.routines.filter((r) => r.id !== id);
  if (appConfig.defaultRoutineId === id) {
    appConfig.defaultRoutineId = appConfig.routines[0].id;
  }
  saveConfig();
  sendCloudDelta({
    op: 'SYNC_ROUTINES',
    routines: appConfig.routines,
    defaultRoutineId: appConfig.defaultRoutineId
  });
  selectRoutineForEdit(appConfig.routines[0].id);
  renderAll();
  showToast('Routine eliminata.', 'info');
}

// ============================================================================
// MODALE 3: CENTRO SICUREZZA, NOTIFICHE ISTANTANEE (iOS & PC) & SYNC
// ============================================================================
function openSettingsModal() {
  document.getElementById('cfgAutoLockMinutes').value = String(appConfig.autoLockMinutes ?? 10);
  document.getElementById('cfgPrivacyPush').checked = Boolean(appConfig.privacyPushMode);
  document.getElementById('cfgPrivacyBlur').checked = appConfig.privacyBlurOnHide !== false;

  document.getElementById('cfgSoundProfile').value = appConfig.soundProfile || 'institutional';
  document.getElementById('cfgTabBlink').checked = Boolean(appConfig.tabBlink);
  document.getElementById('cfgVibrate').checked = Boolean(appConfig.vibrate);
  document.getElementById('cfgWakeLock').checked = Boolean(appConfig.wakeLock);
  document.getElementById('cfgPushEnabled').checked = Boolean(appConfig.pushEnabled);
  document.getElementById('cfgPushTopic').value = appConfig.pushTopic || '';
  document.getElementById('cfgPushSchedule72h').checked = Boolean(appConfig.pushSchedule72h);

  const roomLabel = document.getElementById('syncRoomLabel');
  if (roomLabel) roomLabel.textContent = 'Canale Sync E2EE: protetto e derivato crittograficamente (AES-256-GCM)';

  updateDeviceNotificationUI();
  updatePushLinksUI();

  const modal = document.getElementById('settingsModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (window.lucide) window.lucide.createIcons();
}

function closeSettingsModal() {
  const modal = document.getElementById('settingsModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function updatePushLinksUI() {
  const topic = encodeURIComponent((appConfig.pushTopic || '').trim());
  const iosBtn = document.getElementById('btnOpenNtfyIos');
  const webBtn = document.getElementById('btnOpenNtfyWeb');
  if (iosBtn) iosBtn.href = topic ? `ntfy://ntfy.sh/${topic}` : '#';
  if (webBtn) webBtn.href = topic ? `${NTFY_ROOT_URL}/${topic}` : '#';
}

function saveNotificationPreferences() {
  const prevTopic = appConfig.pushTopic;
  appConfig.autoLockMinutes = Number(document.getElementById('cfgAutoLockMinutes')?.value ?? 10);
  appConfig.privacyPushMode = Boolean(document.getElementById('cfgPrivacyPush')?.checked);
  appConfig.privacyBlurOnHide = Boolean(document.getElementById('cfgPrivacyBlur')?.checked);

  appConfig.soundProfile = document.getElementById('cfgSoundProfile').value;
  appConfig.tabBlink = document.getElementById('cfgTabBlink').checked;
  appConfig.vibrate = document.getElementById('cfgVibrate').checked;
  appConfig.wakeLock = document.getElementById('cfgWakeLock').checked;
  appConfig.pushEnabled = document.getElementById('cfgPushEnabled').checked;
  appConfig.pushTopic = (document.getElementById('cfgPushTopic').value || appConfig.pushTopic || '').trim().replace(/\s+/g, '-');
  appConfig.pushSchedule72h = document.getElementById('cfgPushSchedule72h').checked;

  saveConfig();
  resetInactivityTimer();
  updateDeviceNotificationUI();
  updatePushLinksUI();

  if (appConfig.wakeLock) acquireWakeLock();
  else releaseWakeLock();

  if (prevTopic !== appConfig.pushTopic && appConfig.pushTopic) {
    sendCloudDelta({ op: 'SYNC_PUSH_TOPIC', pushTopic: appConfig.pushTopic });
  }
  scheduleUpcomingDirectPushes();
  showToast('Impostazioni di sicurezza e notifiche salvate!', 'success');
}

function copyPushTopic() {
  const topic = (appConfig.pushTopic || '').trim();
  if (!topic) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(topic).then(() => {
      showToast('Codice canale riservato copiato negli appunti!', 'success');
    });
  } else {
    showToast(`Codice canale: ${topic}`, 'info');
  }
}

function regeneratePushTopic() {
  if (!confirm('Generare un nuovo codice canale Push crittografico? Dovrai ricollegarlo su iPhone.')) return;
  const randBytes = window.crypto.getRandomValues(new Uint8Array(12));
  const newTopic = `sc-v4-p-${bytesToHex(randBytes)}`;
  document.getElementById('cfgPushTopic').value = newTopic;
  saveNotificationPreferences();
}

// ============================================================================
// MODALE 4: IMPORTATORE / ESPORTATORE EXCEL (.XLSX / .XLS / .CSV) — 630+ RIGHE
// ============================================================================
function openExcelImportModal() {
  populateRoutineDropdown('importDefaultRoutineId', appConfig.defaultRoutineId, false);
  const modal = document.getElementById('excelImportModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (window.lucide) window.lucide.createIcons();
}

function closeExcelImportModal() {
  const modal = document.getElementById('excelImportModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function setupExcelDropzone() {
  const dz = document.getElementById('excelDropzone');
  if (!dz) return;

  ['dragenter', 'dragover'].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('drag-over');
    });
  });

  dz.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) processExcelFile(file);
  });
}

function handleExcelFileSelected(event) {
  const file = event.target.files?.[0];
  if (file) processExcelFile(file);
  event.target.value = '';
}

function processExcelFile(file) {
  if (typeof XLSX === 'undefined') {
    showToast('Libreria Excel non caricata: verifica la connessione internet.', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      excelWorkbook = XLSX.read(data, { type: 'array', cellDates: false });

      const sheetSelect = document.getElementById('excelSheetSelect');
      sheetSelect.innerHTML = excelWorkbook.SheetNames.map(
        (name, idx) => `<option value="${escapeHtml(name)}" ${idx === 0 ? 'selected' : ''}>${escapeHtml(name)}</option>`
      ).join('');

      const infoEl = document.getElementById('excelFileInfo');
      infoEl.textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      infoEl.classList.remove('hidden');

      document.getElementById('excelMappingSection').classList.remove('hidden');
      onExcelSheetChange();
    } catch (err) {
      console.error(err);
      showToast('Impossibile leggere il file Excel. Verifica che sia un .xlsx, .xls o .csv valido.', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function onExcelSheetChange() {
  if (!excelWorkbook) return;
  const sheetName = document.getElementById('excelSheetSelect').value;
  const sheet = excelWorkbook.Sheets[sheetName];
  if (!sheet) return;

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const monthRegex = /^(GENNAIO|FEBBRAIO|MARZO|APRILE|MAGGIO|GIUGNO|LUGLIO|AGOSTO|SETTEMBRE|OTTOBRE|NOVEMBRE|DICEMBRE)\b/i;
  const yearRegex = /^20\d{2}$/;

  // Rilevamento automatico formato "SCADENZIARIO AGG" Studio Carifi:
  // Col A = Mese / Anno / RATEIZZO / SCADENZA, Col B = Cliente, Col C = Data, Col D = Importo, Col E = Rata, Col F = Note
  const sampleRows = matrix.slice(0, 15);
  const isCarifiScadenziarioFormat = sampleRows.some((row) => {
    const a = String(row?.[0] ?? '').trim().toUpperCase();
    const b = String(row?.[1] ?? '').trim();
    const c = row?.[2];
    return (a === 'RATEIZZO' || a === 'SCADENZA') && b.length > 0 && c !== '' && c !== undefined;
  });

  if (isCarifiScadenziarioFormat) {
    excelHeaders = [
      'Col A — Tipologia (Rateizzo/Scadenza)',
      'Col B — Cliente / Ragione Sociale',
      'Col C — Data Scadenza',
      'Col D — Importo (€)',
      'Col E — Numero Rata',
      'Col F — Note / Dettaglio Tributo'
    ];
    excelCurrentRows = matrix.filter((row) => {
      if (!Array.isArray(row)) return false;
      const a = String(row[0] ?? '').trim();
      const b = String(row[1] ?? '').trim();
      const c = String(row[2] ?? '').trim();
      if (!b && !c && (monthRegex.test(a) || yearRegex.test(a))) return false;
      return b !== '' && c !== '';
    });

    populateColumnMappingSelects();
    document.getElementById('mapColCategory').value = '0';
    document.getElementById('mapColClient').value = '1';
    document.getElementById('mapColDate').value = '2';
    document.getElementById('mapColAmount').value = '3';
    document.getElementById('mapColTitle').value = '4';
    document.getElementById('mapColNotes').value = '5';
    document.getElementById('mapColTime').value = '-1';
    document.getElementById('mapColPhone').value = '-1';
    document.getElementById('importDefaultCategory').value = 'rateizzo';
    document.getElementById('importDefaultIntensity').value = 'high';
    populateRoutineDropdown('importDefaultRoutineId', appConfig.defaultRoutineId, false);
    refreshExcelPreview();
    showToast('Formato "Scadenziario Studio Carifi" riconosciuto automaticamente!', 'success');
    return;
  }

  // Formato tabellare standard con intestazione
  let headerRowIndex = 0;
  for (let r = 0; r < Math.min(matrix.length, 15); r++) {
    const nonEmpty = (matrix[r] || []).filter((c) => String(c ?? '').trim() !== '').length;
    if (nonEmpty >= 2) {
      headerRowIndex = r;
      break;
    }
  }

  const rawHeaders = matrix[headerRowIndex] || [];
  excelHeaders = rawHeaders.map((h, i) => String(h ?? '').trim() || `Colonna ${i + 1}`);
  excelCurrentRows = matrix.slice(headerRowIndex + 1).filter((row) =>
    Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== '')
  );

  populateColumnMappingSelects();
  autoDetectExcelColumns();
  refreshExcelPreview();
}

function populateColumnMappingSelects() {
  const optionsHtml = `<option value="-1">— Non mappata —</option>` +
    excelHeaders.map((h, idx) => `<option value="${idx}">${escapeHtml(h)}</option>`).join('');

  document.querySelectorAll('.excel-col-map').forEach((sel) => {
    sel.innerHTML = optionsHtml;
  });
}

function autoDetectExcelColumns() {
  const findCol = (patterns) => {
    for (const regex of patterns) {
      const idx = excelHeaders.findIndex((h) => regex.test(h.toLowerCase()));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  document.getElementById('mapColClient').value = String(findCol([
    /cliente/, /ragione/, /nominativ/, /cognome/, /nome/, /azienda/, /ditta/, /soggetto/, /contribuent/
  ]));
  document.getElementById('mapColTitle').value = String(findCol([
    /oggetto/, /motivo/, /descriz/, /appuntament/, /pratica/, /titolo/, /causale/, /servizio/, /attivita|attività/
  ]));
  document.getElementById('mapColDate').value = String(findCol([
    /^data/, /scadenza/, /giorno/, /date/, /quando/
  ]));
  document.getElementById('mapColTime').value = String(findCol([
    /^ora/, /orario/, /time/, /inizio/
  ]));
  document.getElementById('mapColPhone').value = String(findCol([
    /tel/, /cell/, /phone/, /whatsapp/, /contatto/, /numero/
  ]));
  document.getElementById('mapColAmount').value = String(findCol([
    /importo/, /euro/, /totale/, /rata/, /somma/, /€/, /valore/
  ]));
  document.getElementById('mapColNotes').value = String(findCol([
    /note/, /annotaz/, /dettagl/, /osservaz/, /comment/
  ]));
  document.getElementById('mapColCategory').value = String(findCol([
    /categ/, /tipolog/, /^tipo/
  ]));
}

function parseExcelRowToItem(row, mapping, defaults) {
  const getVal = (idx) => (idx >= 0 && idx < row.length ? row[idx] : '');

  const rawClient = String(getVal(mapping.client) ?? '').trim();
  const rawTitle = String(getVal(mapping.title) ?? '').trim();
  const rawDate = getVal(mapping.date);
  const rawTime = getVal(mapping.time);
  const rawPhone = String(getVal(mapping.phone) ?? '').trim();
  const rawAmount = getVal(mapping.amount);
  const rawNotes = String(getVal(mapping.notes) ?? '').trim();
  const rawCat = String(getVal(mapping.category) ?? '').trim().toLowerCase();

  const parsedDate = parseFlexibleDateAndTime(rawDate, rawTime);
  if (!parsedDate) return null;

  const EXCEL_CLIENT_NORMALIZE = {
    'SICIGNANO IMMACOLATO': 'SICIGNANO IMMACOLATA',
    'SICIGNANO IMMACOLTA': 'SICIGNANO IMMACOLATA',
    'AGRICOL SANA': 'AGRICOLA SANA',
    'MUTLISERVICE': 'MULTISERVICE',
    'ANIGIA': 'ANIGIA COSTRUZIONI SRLS',
    'TONIA CARIFI': 'ANTONIA CARIFI',
    'NIMA': 'NIMA COSTRUZIONI'
  };
  const isContractRow = rawCat === 'scadenza' || /contratto\s+di\s+locazione|scadenza\s+contratto/i.test(rawClient);
  const normalizedClient = EXCEL_CLIENT_NORMALIZE[rawClient.toUpperCase()] || rawClient;
  const client = isContractRow ? 'CONTRATTO DI LOCAZIONE' : (normalizedClient || rawTitle || 'Cliente Studio');
  const title = isContractRow
    ? rawClient
    : rawCat === 'rateizzo'
    ? (rawTitle ? `Rateizzo Fiscale — ${rawTitle}` : 'Rateizzo Fiscale')
    : (rawTitle || (rawClient ? 'Appuntamento Studio' : 'Impegno in Agenda'));
  const installmentRef = rawCat === 'rateizzo' ? rawTitle : '';

  // Rilevamento intelligente categoria
  let category = defaults.category;
  const combinedText = `${rawCat} ${title} ${rawNotes}`.toLowerCase();
  if (isContractRow) category = 'contratto';
  else if (/rottamaz|definizione agevol/.test(combinedText)) category = 'rottamazione';
  else if (rawCat === 'rateizzo' || /rateizz|rata\s*\d|dilaz/.test(combinedText)) category = 'rateizzo';
  else if (/f24|tribut|iva|irpef|dichiaraz/.test(combinedText)) category = 'f24';
  else if (/appuntam|incontr|riunion|consulen|chiamat/.test(combinedText)) category = 'appuntamento';

  const amount = parseItalianAmount(rawAmount);
  const routineId = defaults.routineId || appConfig.defaultRoutineId;
  const slots = computeRoutineNotificationSlots({ dueDate: parsedDate.toISOString(), routineId });
  const notifyStart = slots.length > 0 ? new Date(slots[0].atMs) : new Date(parsedDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  const isPast = parsedDate.getTime() < Date.now();
  const completed = defaults.autoCompletePast && isPast;

  return {
    id: 'carifi-xls-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8),
    category,
    client,
    title,
    amount,
    installmentRef,
    phone: rawPhone,
    dueDate: parsedDate.toISOString(),
    routineId,
    customFirstAlertAt: null,
    leadMinutes: '10080',
    notifyStartAt: notifyStart.toISOString(),
    preAlerts: { d7: true, d3: true, morning: true },
    preAlertsFired: isPast ? { d7: true, d3: true, morning: true } : {},
    firedSlots: {},
    scheduledPushSlots: {},
    scheduledPushFor: null,
    intensity: defaults.intensity,
    repeatMinutes: 60,
    acknowledged: isPast,
    completed,
    lastNotifiedAt: isPast ? new Date().toISOString() : null,
    snoozedUntil: null,
    notes: rawNotes,
    updatedAt: new Date().toISOString()
  };
}

function parseFlexibleDateAndTime(rawDate, rawTime) {
  if (rawDate === '' || rawDate === null || rawDate === undefined) return null;

  let dateObj = null;
  let hasExplicitTime = false;

  if (typeof rawDate === 'number' && rawDate > 20000 && rawDate < 90000) {
    // Numero seriale Excel (base 30 Dicembre 1899)
    const utcMs = Math.round((rawDate - 25569) * 86400 * 1000);
    const tmp = new Date(utcMs);
    dateObj = new Date(
      tmp.getUTCFullYear(),
      tmp.getUTCMonth(),
      tmp.getUTCDate(),
      tmp.getUTCHours(),
      tmp.getUTCMinutes(),
      0,
      0
    );
    hasExplicitTime = (rawDate % 1) > 0.0001;
  } else if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    dateObj = new Date(rawDate);
    hasExplicitTime = dateObj.getHours() !== 0 || dateObj.getMinutes() !== 0;
  } else {
    const str = String(rawDate).trim();
    // Formato italiano: GG/MM/AAAA [HH:mm] (con correzione sicura di giorni fuori range es. 39/04 -> 30/04)
    const itMatch = str.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})(?:[\s,T]+(\d{1,2})[:\.](\d{2}))?/);
    if (itMatch) {
      let year = Number(itMatch[3]);
      if (year < 100) year += 2000;
      const month = Number(itMatch[2]) - 1;
      const maxDay = new Date(year, month + 1, 0).getDate();
      const day = Math.min(Number(itMatch[1]), maxDay);
      const h = itMatch[4] !== undefined ? Number(itMatch[4]) : 9;
      const m = itMatch[5] !== undefined ? Number(itMatch[5]) : 0;
      hasExplicitTime = itMatch[4] !== undefined;
      dateObj = new Date(year, month, day, h, m, 0, 0);
    } else {
      // Formato ISO: AAAA-MM-GG [HH:mm]
      const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[\sT]+(\d{1,2}):(\d{2}))?/);
      if (isoMatch) {
        const h = isoMatch[4] !== undefined ? Number(isoMatch[4]) : 9;
        const m = isoMatch[5] !== undefined ? Number(isoMatch[5]) : 0;
        hasExplicitTime = isoMatch[4] !== undefined;
        dateObj = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]), h, m, 0, 0);
      } else {
        const fallback = new Date(str);
        if (!Number.isNaN(fallback.getTime())) {
          dateObj = fallback;
          hasExplicitTime = fallback.getHours() !== 0 || fallback.getMinutes() !== 0;
        }
      }
    }
  }

  if (!dateObj || Number.isNaN(dateObj.getTime())) return null;

  // Applica eventuale colonna Ora separata
  if (rawTime !== '' && rawTime !== null && rawTime !== undefined) {
    if (typeof rawTime === 'number' && rawTime >= 0 && rawTime < 1) {
      const totalMinutes = Math.round(rawTime * 24 * 60);
      dateObj.setHours(Math.floor(totalMinutes / 60), totalMinutes % 60, 0, 0);
      hasExplicitTime = true;
    } else {
      const tMatch = String(rawTime).trim().match(/(\d{1,2})[:\.h](\d{2})/);
      if (tMatch) {
        dateObj.setHours(Number(tMatch[1]), Number(tMatch[2]), 0, 0);
        hasExplicitTime = true;
      }
    }
  }

  if (!hasExplicitTime) {
    dateObj.setHours(9, 30, 0, 0);
  }

  return dateObj;
}

function parseItalianAmount(raw) {
  if (raw === '' || raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).replace(/[€\s]/g, '').trim();
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const num = Number(s);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function getCurrentExcelMapping() {
  return {
    client: Number(document.getElementById('mapColClient').value),
    title: Number(document.getElementById('mapColTitle').value),
    date: Number(document.getElementById('mapColDate').value),
    time: Number(document.getElementById('mapColTime').value),
    phone: Number(document.getElementById('mapColPhone').value),
    amount: Number(document.getElementById('mapColAmount').value),
    notes: Number(document.getElementById('mapColNotes').value),
    category: Number(document.getElementById('mapColCategory').value)
  };
}

function refreshExcelPreview() {
  const mapping = getCurrentExcelMapping();
  const defaults = {
    category: document.getElementById('importDefaultCategory').value,
    intensity: document.getElementById('importDefaultIntensity').value,
    routineId: document.getElementById('importDefaultRoutineId')?.value || appConfig.defaultRoutineId,
    autoCompletePast: document.getElementById('importAutoCompletePast').checked
  };

  let validCount = 0;
  let invalidCount = 0;
  const previewRows = [];

  for (const row of excelCurrentRows) {
    const parsed = parseExcelRowToItem(row, mapping, defaults);
    if (parsed) {
      validCount++;
      if (previewRows.length < 8) previewRows.push(parsed);
    } else {
      invalidCount++;
    }
  }

  document.getElementById('excelRowStats').textContent =
    `${excelCurrentRows.length} righe lette • ${validCount} valide • ${invalidCount} senza data valida`;
  document.getElementById('excelPreviewSummary').textContent =
    `Prime ${previewRows.length} di ${validCount} righe importabili`;

  const tbody = document.getElementById('excelPreviewBody');
  tbody.innerHTML = previewRows.map((it) => `
    <tr>
      <td class="px-3 py-2 font-bold text-carifi-navy whitespace-nowrap">${formatDateTimeIT(it.dueDate)}</td>
      <td class="px-3 py-2 font-bold text-carifi-crimson">${escapeHtml(it.client)}</td>
      <td class="px-3 py-2 text-slate-700">${escapeHtml(it.title)}</td>
      <td class="px-3 py-2 whitespace-nowrap">${it.amount ? '€ ' + it.amount.toLocaleString('it-IT', { minimumFractionDigits: 2 }) : '—'}</td>
      <td class="px-3 py-2 whitespace-nowrap">${escapeHtml(it.phone || '—')}</td>
      <td class="px-3 py-2 text-slate-500 max-w-xs truncate">${escapeHtml(it.notes || '—')}</td>
    </tr>
  `).join('');

  const confirmBtn = document.getElementById('btnConfirmExcelImport');
  const confirmText = document.getElementById('btnConfirmExcelImportText');
  confirmBtn.disabled = validCount === 0;
  confirmText.textContent = validCount > 0
    ? `Importa ${validCount} Appuntamenti`
    : 'Seleziona almeno Colonna Data';
}

async function executeExcelImport() {
  const mapping = getCurrentExcelMapping();
  const replaceExisting = document.getElementById('importReplaceExisting').checked;
  const skipDuplicates = document.getElementById('importSkipDuplicates').checked;
  const defaults = {
    category: document.getElementById('importDefaultCategory').value,
    intensity: document.getElementById('importDefaultIntensity').value,
    routineId: document.getElementById('importDefaultRoutineId')?.value || appConfig.defaultRoutineId,
    autoCompletePast: document.getElementById('importAutoCompletePast').checked
  };

  if (replaceExisting) {
    const nowIso = new Date().toISOString();
    items.forEach((i) => { deletedIds[i.id] = nowIso; });
    items = [];
    await sendCloudDelta({ op: 'CLEAR_ALL', clearedAllAt: nowIso });
  }

  const existingKeys = new Set(
    items.map((i) => `${(i.client || '').toLowerCase()}|${(i.title || '').toLowerCase()}|${i.dueDate}`)
  );

  const imported = [];
  let duplicatesSkipped = 0;

  for (const row of excelCurrentRows) {
    const parsed = parseExcelRowToItem(row, mapping, defaults);
    if (!parsed) continue;
    const key = `${parsed.client.toLowerCase()}|${parsed.title.toLowerCase()}|${parsed.dueDate}`;
    if (skipDuplicates && existingKeys.has(key)) {
      duplicatesSkipped++;
      continue;
    }
    existingKeys.add(key);
    items.push(parsed);
    imported.push(parsed);
  }

  saveItemsLocally();
  closeExcelImportModal();
  renderAll();
  checkAndDispatchNotifications();
  scheduleUpcomingDirectPushes();

  const dupMsg = duplicatesSkipped > 0 ? ` (${duplicatesSkipped} duplicati saltati)` : '';
  showToast(`Importati ${imported.length} appuntamenti da Excel${dupMsg}!`, 'success');

  // Sincronizza in background verso l'altro dispositivo
  syncItemsInBatches(imported);
}

function exportItemsListToExcel(list, filePrefix) {
  if (typeof XLSX === 'undefined') {
    showToast('Libreria Excel non disponibile.', 'error');
    return;
  }
  if (!list || list.length === 0) {
    showToast('Nessun dato da esportare in Excel.', 'warning');
    return;
  }

  const rows = list.map((it) => {
    const d = new Date(it.dueDate);
    return {
      Data: d.toLocaleDateString('it-IT'),
      Ora: d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
      Cliente: it.client,
      Oggetto: it.title,
      Tipologia: it.category,
      Importo: it.amount ?? '',
      'Rif. Rata': it.installmentRef || '',
      Telefono: it.phone || '',
      Intensità: getIntensityLabel(it.intensity),
      Stato: it.completed ? 'Completato' : 'Attivo',
      Note: it.notes || ''
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Agenda Studio Carifi');
  XLSX.writeFile(wb, `${filePrefix}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(`Esportati ${rows.length} record in Excel (.xlsx)!`, 'success');
}

function exportFilteredToExcel() {
  exportItemsListToExcel(lastFilteredItems, 'agenda_filtrata_studio_carifi');
}

function exportAllToExcel() {
  exportItemsListToExcel(items, 'agenda_completa_studio_carifi');
}

// ============================================================================
// BACKUP JSON & SVUOTAMENTO AGENDA
// ============================================================================
function exportDataJson() {
  downloadFile(
    JSON.stringify(items, null, 2),
    `backup_studio_carifi_${new Date().toISOString().slice(0, 10)}.json`,
    'application/json'
  );
  showToast(`Backup JSON esportato (${items.length} record).`, 'success');
}

function importDataJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imported = JSON.parse(e.target.result);
      if (Array.isArray(imported)) {
        items = imported;
        saveItemsLocally();
        syncItemsInBatches(items);
        scheduleUpcomingDirectPushes();
        renderAll();
        showToast(`Ripristinati ${imported.length} impegni dal backup JSON!`, 'success');
      }
    } catch (_) {
      showToast('File JSON non valido.', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

async function clearAllItems() {
  if (!confirm('Vuoi rimuovere definitivamente tutti gli appuntamenti e rateizzi su PC e iOS?')) return;
  const nowIso = new Date().toISOString();
  items.forEach((i) => { deletedIds[i.id] = nowIso; });
  items = [];
  saveItemsLocally();
  await sendCloudDelta({ op: 'CLEAR_ALL', clearedAllAt: nowIso });
  renderAll();
  checkAndDispatchNotifications();
  closeSettingsModal();
  showToast('Agenda completamente svuotata su tutti i dispositivi.', 'info');
}

// ============================================================================
// UTILITÀ DI FORMATTAZIONE E UI
// ============================================================================
function getCategoryBadgeMeta(cat) {
  switch (cat) {
    case 'rateizzo':
      return { label: '💳 Rateizzo Fiscale', classes: 'bg-slate-100 text-carifi-navy border border-slate-200' };
    case 'f24':
      return { label: '📄 Scadenza F24 / Tributi', classes: 'bg-blue-50 text-carifi-navyMid border border-blue-200' };
    case 'rottamazione':
      return { label: '⚖️ Rottamazione AdER', classes: 'bg-red-50 text-carifi-crimson border border-red-200' };
    case 'contratto':
      return { label: '📜 Scadenza Contratto', classes: 'bg-amber-50 text-amber-900 border border-amber-200' };
    case 'appuntamento':
      return { label: '📅 Appuntamento Studio', classes: 'bg-emerald-50 text-emerald-800 border border-emerald-200' };
    default:
      return { label: '📌 Promemoria Studio', classes: 'bg-slate-100 text-slate-800 border border-slate-200' };
  }
}

function getIntensityBadgeMeta(intensity, repeatMin, routine = null) {
  const shortRoutine = routine
    ? routine.name.split('(')[0].trim()
    : null;
  if (intensity === 'high') {
    return {
      label: shortRoutine ? `🔴 ${escapeHtml(shortRoutine)}` : `🔴 Alta (ogni ${repeatMin || 15} min)`,
      classes: 'bg-red-50 text-carifi-crimson border border-red-300'
    };
  }
  if (intensity === 'medium') {
    return {
      label: shortRoutine ? `🔵 ${escapeHtml(shortRoutine)}` : `🔵 Media (ogni ${repeatMin || 60} min)`,
      classes: 'bg-slate-100 text-carifi-navy border border-slate-300'
    };
  }
  return {
    label: shortRoutine ? `🟢 ${escapeHtml(shortRoutine)}` : '🟢 Bassa (Singolo)',
    classes: 'bg-emerald-50 text-emerald-700 border border-emerald-200'
  };
}

function getIntensityLabel(intensity) {
  if (intensity === 'high') return 'ALTA / INSISTENTE';
  if (intensity === 'medium') return 'MEDIA';
  return 'BASSA';
}

function getRelativeTimeLabel(dueMs, nowMs, completed) {
  if (completed) return 'Completato';
  const diffMin = Math.round((dueMs - nowMs) / 60000);
  if (diffMin < 0) {
    const absMin = Math.abs(diffMin);
    if (absMin < 60) return `⚠️ Scaduto da ${absMin} min`;
    const hours = Math.floor(absMin / 60);
    if (hours < 24) return `⚠️ Scaduto da ${hours} ore`;
    return `⚠️ Scaduto da ${Math.floor(hours / 24)} giorni`;
  }
  if (diffMin < 60) return `⏳ Tra ${diffMin} minuti`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `⏳ Tra ${hours} ore`;
  const days = Math.ceil(hours / 24);
  return `Mancano ${days} giorni`;
}

function formatDateTimeIT(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }) + ' ore ' + d.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit'
  });
}

function toDateKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalDatetimeInputValue(isoStr) {
  const d = isoStr ? new Date(isoStr) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const colors = {
    success: 'bg-carifi-navy text-white border-emerald-400',
    warning: 'bg-carifi-navyMid text-white border-amber-400',
    error: 'bg-carifi-crimson text-white border-white',
    info: 'bg-carifi-navy text-white border-carifi-crimson'
  };

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto px-4 py-3 rounded-xl shadow-xl border-l-4 text-xs font-bold flex items-center justify-between gap-3 transition-all duration-300 ${colors[type] || colors.info}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4500);
}
