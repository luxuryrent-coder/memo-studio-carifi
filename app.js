/**
 * STUDIO CARIFI COMMERCIALISTA — ORDINE DEI DOTTORI COMMERCIALISTI DI NOLA
 * Motore Applicativo:
 *  - Sincronizzazione Cloud Automatica e Istantanea Zero-Config (PC Windows <-> iPhone iOS)
 *  - Collegamento Guidato Automatico Bot Telegram (Generazione Link Diretto + Rilevamento Chat ID)
 *  - Gestione Appuntamenti, Scadenzario Rateizzi e Notifiche ad Intensità Variabile
 */

const STORAGE_KEY_ITEMS = 'studio_carifi_items_v2';
const STORAGE_KEY_DELETED = 'studio_carifi_deleted_v2';
const STORAGE_KEY_CONFIG = 'studio_carifi_config_v2';

// Canale Cloud Realtime dedicato allo Studio Carifi (Zero-Config, attivo subito su PC e iPhone)
const CLOUD_SYNC_TOPIC = 'studio_carifi_nola_v2_sync_8390af28';
const CLOUD_SYNC_BASE_URL = `https://ntfy.sh/${CLOUD_SYNC_TOPIC}`;

// Identificativo univoco della sessione dispositivo corrente
const DEVICE_SESSION_ID = 'dev-' + Math.random().toString(36).substring(2, 10);

// Stato globale dell'applicazione
let items = [];
let deletedIds = {}; // mappa { [itemId]: isoTimestamp } per sincronizzare le cancellazioni tra PC e Mobile
let currentFilter = 'all';
let cloudEventSource = null;
let audioCtx = null;
let telegramPollTimer = null;

// Canale broadcast per sincronizzazione istantanea tra schede aperte sullo stesso dispositivo
const localBroadcast = ('BroadcastChannel' in window) ? new BroadcastChannel('studio_carifi_sync') : null;

// Configurazione persistente
let appConfig = {
  telegramToken: '',
  telegramChatId: '',
  telegramBotUsername: ''
};

// ============================================================================
// INIZIALIZZAZIONE APPLICAZIONE
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadItems();
  initServiceWorker();
  checkNotificationPermissionUI();

  // Avvia subito la sincronizzazione Cloud Automatica PC <-> Mobile
  initAutoCloudSync();

  // Orologio in tempo reale nell'header
  updateLiveClock();
  setInterval(updateLiveClock, 1000);

  // Motore di controllo scadenze e notifiche (controllo ogni 10 secondi)
  checkAndDispatchNotifications();
  setInterval(checkAndDispatchNotifications, 10000);

  // Ascolto messaggi dal Service Worker (click sulle notifiche push)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'NOTIFICATION_ACTION') {
        const itemId = event.data.itemId;
        if (itemId) {
          acknowledgeItem(itemId);
        }
      }
    });
  }

  // Ascolto sincronizzazione locale tra schede dello stesso browser
  if (localBroadcast) {
    localBroadcast.onmessage = (event) => {
      if (event.data && event.data.type === 'ITEMS_UPDATED') {
        loadItems();
        loadConfig();
        renderAll();
      }
    };
  }

  // Quando l'app su iPhone o PC torna in primo piano, riallinea subito dal Cloud
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      pullCloudHistoryAndMerge(false);
    }
  });

  renderAll();
  updateTelegramUIState();
});

// ============================================================================
// REGISTRAZIONE SERVICE WORKER (PWA WINDOWS & iOS)
// ============================================================================
function initServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Registrazione Service Worker non riuscita:', err);
    });
  }
}

function updateLiveClock() {
  const el = document.getElementById('liveClock');
  if (!el) return;
  const now = new Date();
  const formatted = now.toLocaleDateString('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }) + ' • ' + now.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  el.textContent = formatted;
}

// ============================================================================
// GESTIONE DATI LOCALI (NESSUN DATO DI PROVA)
// ============================================================================
function loadConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_CONFIG) || localStorage.getItem('studio_carifi_config_v1');
    if (saved) {
      appConfig = { ...appConfig, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Errore lettura configurazione:', e);
  }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY_CONFIG, JSON.stringify(appConfig));
}

function loadItems() {
  try {
    // Pulizia vecchia chiave v1 se conteneva demo
    const savedDeleted = localStorage.getItem(STORAGE_KEY_DELETED);
    if (savedDeleted) {
      deletedIds = JSON.parse(savedDeleted) || {};
    }

    const saved = localStorage.getItem(STORAGE_KEY_ITEMS) || localStorage.getItem('studio_carifi_items_v1');
    if (saved) {
      const parsed = JSON.parse(saved);
      items = Array.isArray(parsed)
        ? parsed.filter((item) => item && item.id && !String(item.id).startsWith('demo-') && !deletedIds[item.id])
        : [];
      saveItemsLocally(false);
    } else {
      items = [];
      saveItemsLocally(false);
    }
  } catch (e) {
    console.error('Errore caricamento promemoria:', e);
    items = [];
  }
}

function saveItemsLocally(broadcast = true) {
  localStorage.setItem(STORAGE_KEY_ITEMS, JSON.stringify(items));
  localStorage.setItem(STORAGE_KEY_DELETED, JSON.stringify(deletedIds));
  if (broadcast && localBroadcast) {
    localBroadcast.postMessage({ type: 'ITEMS_UPDATED' });
  }
}

// ============================================================================
// SINCRONIZZAZIONE CLOUD AUTOMATICA ISTANTANEA (ZERO-CONFIG PC <-> MOBILE)
// ============================================================================
async function initAutoCloudSync() {
  setSyncStatusUI('connecting');
  await pullCloudHistoryAndMerge(false);
  connectCloudRealtimeStream();
}

function setSyncStatusUI(state) {
  const statusBadge = document.getElementById('syncStatusText');
  const syncDot = document.getElementById('syncDot');
  const modalBadge = document.getElementById('cloudModalBadge');

  if (state === 'connected') {
    if (statusBadge) statusBadge.textContent = 'Cloud Istantaneo Attivo (PC ↔ Mobile)';
    if (syncDot) syncDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    if (modalBadge) {
      modalBadge.textContent = 'Connesso in Tempo Reale';
      modalBadge.className = 'px-3 py-1 rounded-full text-xs font-extrabold bg-emerald-600 text-white shadow-xs';
    }
  } else if (state === 'connecting') {
    if (statusBadge) statusBadge.textContent = 'Connessione Cloud in corso...';
    if (syncDot) syncDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-pulse';
  } else {
    if (statusBadge) statusBadge.textContent = 'Riconnessione automatica...';
    if (syncDot) syncDot.className = 'w-2 h-2 rounded-full bg-amber-400';
  }
}

/**
 * Scarica lo storico recente dal canale Cloud e unisce gli appuntamenti/rateizzi
 * usando il timestamp updatedAt e la lista deletedIds (Last-Write-Wins)
 */
async function pullCloudHistoryAndMerge(notifyUser = false) {
  try {
    const res = await fetch(`${CLOUD_SYNC_BASE_URL}/json?poll=1&since=all`, {
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
          const payload = JSON.parse(envelope.message);
          if (mergeIncomingCloudPayload(payload)) {
            changed = true;
          }
        }
      } catch (_) {
        // Ignora righe non JSON
      }
    }

    if (changed) {
      saveItemsLocally(false);
      saveConfig();
      renderAll();
      updateTelegramUIState();
    }

    setSyncStatusUI('connected');
    if (notifyUser) {
      showToast('Sincronizzazione PC ↔ Mobile completata!', 'success');
    }
  } catch (err) {
    console.warn('Errore lettura stato Cloud:', err);
  }
}

/**
 * Apre il canale Server-Sent Events (SSE) per ricevere in < 0.5 secondi
 * qualsiasi nuovo appuntamento o modifica effettuata da PC o da iPhone
 */
function connectCloudRealtimeStream() {
  if (cloudEventSource) {
    try {
      cloudEventSource.close();
    } catch (_) {}
  }

  try {
    cloudEventSource = new EventSource(`${CLOUD_SYNC_BASE_URL}/sse`);

    cloudEventSource.onopen = () => {
      setSyncStatusUI('connected');
    };

    cloudEventSource.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.event === 'message' && envelope.message) {
          const payload = JSON.parse(envelope.message);
          // Ignora i messaggi inviati da questa stessa scheda dispositivo
          if (payload.senderId === DEVICE_SESSION_ID) return;

          if (mergeIncomingCloudPayload(payload)) {
            saveItemsLocally(true);
            saveConfig();
            renderAll();
            updateTelegramUIState();
            checkAndDispatchNotifications();
          }
        }
      } catch (e) {
        console.warn('Errore elaborazione evento Realtime:', e);
      }
    };

    cloudEventSource.onerror = () => {
      setSyncStatusUI('reconnecting');
      setTimeout(() => {
        if (!cloudEventSource || cloudEventSource.readyState === EventSource.CLOSED) {
          connectCloudRealtimeStream();
        }
      }, 5000);
    };
  } catch (e) {
    console.warn('SSE non disponibile:', e);
  }
}

/**
 * Unisce un pacchetto ricevuto dal Cloud con lo stato locale
 */
function mergeIncomingCloudPayload(payload) {
  if (!payload || payload.type !== 'STUDIO_CARIFI_STATE') return false;
  let hasChanges = false;

  // 1. Se è stato inviato un comando di svuotamento totale più recente
  if (payload.clearedAllAt) {
    const clearTime = new Date(payload.clearedAllAt).getTime();
    const beforeCount = items.length;
    items = items.filter((item) => new Date(item.updatedAt || 0).getTime() > clearTime);
    if (items.length !== beforeCount) hasChanges = true;
  }

  // 2. Unisci le cancellazioni (tombstones)
  if (payload.deletedIds && typeof payload.deletedIds === 'object') {
    for (const [delId, delTime] of Object.entries(payload.deletedIds)) {
      if (!deletedIds[delId] || new Date(delTime) > new Date(deletedIds[delId])) {
        deletedIds[delId] = delTime;
        const prevLen = items.length;
        items = items.filter((i) => i.id !== delId);
        if (items.length !== prevLen) hasChanges = true;
      }
    }
  }

  // 3. Unisci gli appuntamenti e rateizzi
  if (Array.isArray(payload.items)) {
    for (const incoming of payload.items) {
      if (!incoming || !incoming.id || String(incoming.id).startsWith('demo-')) continue;

      // Se l'elemento è stato cancellato successivamente, ignoralo
      if (deletedIds[incoming.id] && new Date(deletedIds[incoming.id]) >= new Date(incoming.updatedAt || 0)) {
        continue;
      }

      const existingIdx = items.findIndex((i) => i.id === incoming.id);
      if (existingIdx === -1) {
        items.push(incoming);
        hasChanges = true;
      } else {
        const localTime = new Date(items[existingIdx].updatedAt || 0).getTime();
        const remoteTime = new Date(incoming.updatedAt || 0).getTime();
        if (remoteTime > localTime) {
          items[existingIdx] = incoming;
          hasChanges = true;
        }
      }
    }
  }

  // 4. Sincronizza anche i dati del Bot Telegram tra PC e iPhone
  if (payload.telegram && payload.telegram.token) {
    if (payload.telegram.token !== appConfig.telegramToken || payload.telegram.chatId !== appConfig.telegramChatId) {
      appConfig.telegramToken = payload.telegram.token;
      if (payload.telegram.chatId) appConfig.telegramChatId = payload.telegram.chatId;
      if (payload.telegram.botUsername) appConfig.telegramBotUsername = payload.telegram.botUsername;
      hasChanges = true;
    }
  }

  return hasChanges;
}

/**
 * Invia istantaneamente lo stato aggiornato al Cloud affinché compaia subito
 * sull'altro dispositivo (PC Windows o iPhone)
 */
async function broadcastStateToCloud(extraFields = {}) {
  const payload = {
    type: 'STUDIO_CARIFI_STATE',
    senderId: DEVICE_SESSION_ID,
    sentAt: new Date().toISOString(),
    items: items,
    deletedIds: deletedIds,
    telegram: {
      token: appConfig.telegramToken || '',
      chatId: appConfig.telegramChatId || '',
      botUsername: appConfig.telegramBotUsername || ''
    },
    ...extraFields
  };

  try {
    await fetch(CLOUD_SYNC_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8'
      },
      body: JSON.stringify(payload)
    });
    setSyncStatusUI('connected');
  } catch (err) {
    console.warn('Errore invio aggiornamento Cloud:', err);
  }
}

async function forceCloudSyncNow() {
  await pullCloudHistoryAndMerge(true);
  await broadcastStateToCloud();
}

// ============================================================================
// COLLEGAMENTO AUTOMATICO BOT TELEGRAM (GENERA LINK + RILEVA CHAT ID DA SOLO)
// ============================================================================
function updateTelegramUIState() {
  const pill = document.getElementById('telegramStatusPill');
  const linkBox = document.getElementById('botDirectLinkBox');
  const linkAnchor = document.getElementById('botDirectLinkAnchor');
  const linkText = document.getElementById('botDirectLinkText');

  if (appConfig.telegramBotUsername && linkBox && linkAnchor && linkText) {
    linkBox.classList.remove('hidden');
    linkAnchor.href = `https://t.me/${appConfig.telegramBotUsername}?start=studiocarifi`;
    linkText.textContent = `Apri @${appConfig.telegramBotUsername} su Telegram`;
  }

  if (!pill) return;
  if (appConfig.telegramToken && appConfig.telegramChatId) {
    pill.textContent = appConfig.telegramBotUsername
      ? `🟢 Attivo (@${appConfig.telegramBotUsername})`
      : '🟢 Bot Telegram Collegato';
    pill.className = 'px-3 py-0.5 rounded-full text-[11px] font-extrabold bg-emerald-100 text-emerald-800 border border-emerald-300';
  } else if (appConfig.telegramToken) {
    pill.textContent = '🟡 Premi "Avvia" sul link del tuo Bot';
    pill.className = 'px-3 py-0.5 rounded-full text-[11px] font-extrabold bg-amber-100 text-amber-800 border border-amber-300';
  } else {
    pill.textContent = 'In attesa di collegamento';
    pill.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-700';
  }
}

/**
 * Verifica il Token incollato dall'utente, genera automaticamente il Link Diretto
 * al suo Bot (https://t.me/NomeBot?start=studiocarifi) e resta in ascolto
 * finché l'utente preme "Avvia" su Telegram per catturare in automatico il Chat ID!
 */
async function autoConnectTelegramBot() {
  const tokenInput = document.getElementById('cfgTelegramToken');
  const token = (tokenInput?.value || '').trim();
  if (!token || !token.includes(':')) {
    showToast('Incolla un Token valido ricevuto da @BotFather (es. 7123456:AAH...).', 'warning');
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok || !data.result?.username) {
      showToast('Token non riconosciuto da Telegram. Verifica di averlo copiato per intero.', 'error');
      return;
    }

    const botUsername = data.result.username;
    appConfig.telegramToken = token;
    appConfig.telegramBotUsername = botUsername;
    saveConfig();
    updateTelegramUIState();
    broadcastStateToCloud();

    showToast(`Bot @${botUsername} verificato! Ora clicca sul pulsante azzurro per aprirlo su Telegram.`, 'success');

    // Avvia il rilevamento automatico del Chat ID non appena l'utente clicca sul link e preme "Avvia"
    startAutoDetectTelegramChatId(token, botUsername);
  } catch (err) {
    showToast('Errore di rete durante la verifica del Token Telegram.', 'error');
  }
}

function startAutoDetectTelegramChatId(token, botUsername) {
  if (telegramPollTimer) clearInterval(telegramPollTimer);

  let attempts = 0;
  const checkUpdates = async () => {
    attempts++;
    if (attempts > 60) {
      clearInterval(telegramPollTimer);
      return;
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=10`);
      const data = await res.json();
      if (data.ok && Array.isArray(data.result) && data.result.length > 0) {
        // Prende l'ultimo messaggio inviato al bot
        const latestUpdate = data.result[data.result.length - 1];
        const chat =
          latestUpdate.message?.chat ||
          latestUpdate.my_chat_member?.chat ||
          latestUpdate.channel_post?.chat;

        if (chat && chat.id) {
          clearInterval(telegramPollTimer);
          const detectedId = String(chat.id);
          appConfig.telegramChatId = detectedId;
          const chatInput = document.getElementById('cfgTelegramChatId');
          if (chatInput) chatInput.value = detectedId;

          saveConfig();
          updateTelegramUIState();
          broadcastStateToCloud();

          const hint = document.getElementById('botDetectionHint');
          if (hint) {
            hint.textContent = `✅ Collegato automaticamente a ${chat.first_name || chat.title || 'Telegram'} (ID: ${detectedId})!`;
          }

          await sendTelegramMessage(
            `🏛 *STUDIO CARIFI COMMERCIALISTA*\n` +
            `✅ *Collegamento Automatico Completato!*\n\n` +
            `Da questo momento riceverai qui in tempo reale tutte le notifiche di appuntamenti e rateizzi impostati su PC e iPhone.`
          );

          showToast('Bot Telegram collegato automaticamente con successo!', 'success');
        }
      }
    } catch (_) {}
  };

  checkUpdates();
  telegramPollTimer = setInterval(checkUpdates, 2500);
}

// ============================================================================
// MOTORE DELLE NOTIFICHE AD INTENSITÀ VARIABILE + ALLARME SONORO + TELEGRAM
// ============================================================================
function checkNotificationPermissionUI() {
  const btn = document.getElementById('btnPermissionNotice');
  if (!btn) return;
  if ('Notification' in window && Notification.permission !== 'granted') {
    btn.classList.remove('hidden');
    btn.classList.add('inline-flex');
  } else {
    btn.classList.add('hidden');
    btn.classList.remove('inline-flex');
  }
}

async function requestBrowserNotifications() {
  if (!('Notification' in window)) {
    showToast('Sul tuo iPhone aggiungi prima questa app alla Schermata Home da Safari per sbloccare le notifiche push iOS.', 'warning');
    return;
  }
  const permission = await Notification.requestPermission();
  checkNotificationPermissionUI();
  if (permission === 'granted') {
    showToast('Notifiche del dispositivo attivate con successo!', 'success');
    triggerTestNotification();
  } else {
    showToast('Permesso notifiche negato dal browser.', 'error');
  }
}

function checkAndDispatchNotifications() {
  const now = new Date();
  const nowMs = now.getTime();
  let activeAlarms = [];
  let stateChanged = false;

  for (const item of items) {
    if (item.completed) continue;

    if (item.snoozedUntil && new Date(item.snoozedUntil).getTime() > nowMs) {
      continue;
    }

    const dueMs = new Date(item.dueDate).getTime();
    const notifyStartMs = new Date(item.notifyStartAt).getTime();

    if (!item.preAlertsFired) item.preAlertsFired = {};

    if (item.preAlerts?.d7 && !item.preAlertsFired.d7) {
      const d7Ms = dueMs - 7 * 24 * 60 * 60 * 1000;
      if (nowMs >= d7Ms && nowMs < dueMs) {
        item.preAlertsFired.d7 = true;
        item.updatedAt = now.toISOString();
        stateChanged = true;
        dispatchMultiChannelAlert(item, 'Preavviso 7 giorni prima');
      }
    }

    if (item.preAlerts?.d3 && !item.preAlertsFired.d3) {
      const d3Ms = dueMs - 3 * 24 * 60 * 60 * 1000;
      if (nowMs >= d3Ms && nowMs < dueMs) {
        item.preAlertsFired.d3 = true;
        item.updatedAt = now.toISOString();
        stateChanged = true;
        dispatchMultiChannelAlert(item, 'Preavviso 3 giorni prima');
      }
    }

    if (item.preAlerts?.morning && !item.preAlertsFired.morning) {
      const dueDayMorning = new Date(item.dueDate);
      dueDayMorning.setHours(9, 0, 0, 0);
      if (nowMs >= dueDayMorning.getTime() && nowMs <= dueMs) {
        item.preAlertsFired.morning = true;
        item.updatedAt = now.toISOString();
        stateChanged = true;
        dispatchMultiChannelAlert(item, 'Promemoria Mattutino del giorno di scadenza');
      }
    }

    if (nowMs >= notifyStartMs && !item.acknowledged) {
      activeAlarms.push(item);

      const lastMs = item.lastNotifiedAt ? new Date(item.lastNotifiedAt).getTime() : 0;
      const repeatIntervalMs = (Number(item.repeatMinutes) || 60) * 60 * 1000;

      if (item.intensity === 'low') {
        if (!item.lastNotifiedAt) {
          item.lastNotifiedAt = now.toISOString();
          item.updatedAt = now.toISOString();
          stateChanged = true;
          dispatchMultiChannelAlert(item, 'Promemoria Scadenza');
        }
      } else {
        if (!lastMs || (nowMs - lastMs) >= repeatIntervalMs) {
          item.lastNotifiedAt = now.toISOString();
          item.updatedAt = now.toISOString();
          stateChanged = true;
          const label = item.intensity === 'high' ? '🚨 ALLARME INSISTENTE STUDIO' : '🔔 Sollecito Periodico';
          dispatchMultiChannelAlert(item, label);
        }
      }
    }
  }

  updateActiveAlarmBanner(activeAlarms);

  if (stateChanged) {
    saveItemsLocally(false);
    renderAll();
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
      : `${titles} — Premi "Conferma Presa in Carico" per silenziare i solleciti.`;
  }
}

function dispatchMultiChannelAlert(item, prefixLabel) {
  const amountStr = item.amount ? ` — € ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2 })}` : '';
  const dueFormatted = formatDateTimeIT(item.dueDate);
  const title = `${prefixLabel}: ${item.client}`;
  const body = `${item.title}${amountStr}\nScadenza: ${dueFormatted}`;

  playAlertSound(item.intensity === 'high' ? 'urgent' : 'standard');
  showToast(`${title} — ${item.title}`, item.intensity === 'high' ? 'error' : 'warning');
  sendSystemNotification(title, body, item.id, item.intensity === 'high');

  if (appConfig.telegramToken && appConfig.telegramChatId) {
    sendTelegramMessage(
      `🏛 *STUDIO CARIFI COMMERCIALISTA*\n` +
      `*${prefixLabel}*\n\n` +
      `👤 *Cliente:* ${item.client}\n` +
      `📌 *Oggetto:* ${item.title}${amountStr}\n` +
      (item.installmentRef ? `🔢 *Rif. Rata:* ${item.installmentRef}\n` : '') +
      `⏰ *Scadenza:* ${dueFormatted}\n` +
      `🔥 *Intensità:* ${getIntensityLabel(item.intensity)}`
    );
  }
}

async function sendSystemNotification(title, body, itemId, isUrgent = false) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const options = {
    body: body,
    icon: './logo.jpg',
    badge: './logo.jpg',
    tag: itemId ? `carifi-${itemId}-${Date.now()}` : `carifi-test-${Date.now()}`,
    requireInteraction: isUrgent,
    data: { itemId }
  };

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return;
      }
    }
    new Notification(title, options);
  } catch (e) {
    console.warn('Impossibile mostrare notifica nativa:', e);
  }
}

function playAlertSound(mode = 'standard') {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!audioCtx) audioCtx = new AudioContextClass();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const now = audioCtx.currentTime;
    const notes = mode === 'urgent'
      ? [880, 1174.66, 880, 1174.66, 1318.51]
      : [587.33, 880];

    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = mode === 'urgent' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.18);

      gain.gain.setValueAtTime(0.001, now + idx * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.28, now + idx * 0.18 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.18 + 0.16);

      osc.connect(gain);
      gain.connect(audioCtx.destination);

      osc.start(now + idx * 0.18);
      osc.stop(now + idx * 0.18 + 0.17);
    });
  } catch (e) {
    console.warn('Audio non riproducibile prima di un click utente:', e);
  }
}

function triggerTestNotification() {
  playAlertSound('urgent');
  showToast('Test Allarme Studio Carifi eseguito! Suono + Notifica inviati.', 'success');
  sendSystemNotification(
    '🔔 Studio Carifi Commercialista — Test Notifica',
    'Il sistema di avvisi su PC Windows e iOS funziona correttamente!',
    null,
    true
  );
  if (appConfig.telegramToken && appConfig.telegramChatId) {
    sendTelegramMessage('✅ *Studio Carifi Commercialista*: Test notifica istantanea eseguito con successo!');
  }
}

// ============================================================================
// AZIONI SULLE SCADENZE (CONFERMA PRESA IN CARICO, SNOOZE, COMPLETAMENTO, RATA SUCCESSIVA)
// ============================================================================
function acknowledgeItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.acknowledged = true;
  item.updatedAt = new Date().toISOString();
  saveItemsLocally();
  broadcastStateToCloud();
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Allarme silenziato: "${item.client}" preso in carico.`, 'success');
}

function acknowledgeAllActiveAlarms() {
  const nowMs = Date.now();
  let count = 0;
  items.forEach((item) => {
    if (!item.completed && !item.acknowledged && new Date(item.notifyStartAt).getTime() <= nowMs) {
      item.acknowledged = true;
      item.updatedAt = new Date().toISOString();
      count++;
    }
  });
  saveItemsLocally();
  broadcastStateToCloud();
  renderAll();
  checkAndDispatchNotifications();
  showToast(`${count} avvisi confermati e presi in carico.`, 'success');
}

function snoozeAllActiveAlarms(minutes = 15) {
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const nowMs = Date.now();
  items.forEach((item) => {
    if (!item.completed && !item.acknowledged && new Date(item.notifyStartAt).getTime() <= nowMs) {
      item.snoozedUntil = until;
      item.updatedAt = new Date().toISOString();
    }
  });
  saveItemsLocally();
  broadcastStateToCloud();
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
  }
  item.updatedAt = new Date().toISOString();
  saveItemsLocally();
  broadcastStateToCloud();
  renderAll();
  checkAndDispatchNotifications();
  showToast(
    item.completed
      ? `Completato / Pagato: ${item.client} — ${item.title}`
      : `Riaperto: ${item.client}`,
    'success'
  );
}

function deleteItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  if (!confirm(`Eliminare definitivamente "${item.title}" del cliente ${item.client}?`)) return;
  deletedIds[id] = new Date().toISOString();
  items = items.filter((i) => i.id !== id);
  saveItemsLocally();
  broadcastStateToCloud();
  renderAll();
  checkAndDispatchNotifications();
  showToast('Promemoria eliminato su PC e Mobile.', 'info');
}

function duplicateNextInstallment(id) {
  const source = items.find((i) => i.id === id);
  if (!source) return;

  const nextDue = new Date(source.dueDate);
  nextDue.setMonth(nextDue.getMonth() + 1);

  const leadMin = source.leadMinutes === 'custom' ? 1440 : Number(source.leadMinutes || 1440);
  const nextNotifyStart = new Date(nextDue.getTime() - leadMin * 60 * 1000);

  const newItem = {
    ...source,
    id: 'carifi-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
    title: source.title.replace(/(\d+)ª/g, (_, n) => `${Number(n) + 1}ª`),
    installmentRef: source.installmentRef
      ? source.installmentRef.replace(/Rata\s+(\d+)/i, (_, n) => `Rata ${Number(n) + 1}`)
      : '',
    dueDate: nextDue.toISOString(),
    notifyStartAt: nextNotifyStart.toISOString(),
    preAlertsFired: {},
    acknowledged: false,
    completed: false,
    lastNotifiedAt: null,
    snoozedUntil: null,
    updatedAt: new Date().toISOString()
  };

  items.push(newItem);
  saveItemsLocally();
  broadcastStateToCloud();
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
    `lo *Studio Carifi Commercialista* Le ricorda la seguente scadenza:\n\n` +
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
// RENDERING INTERFACCIA E KPI
// ============================================================================
function renderAll() {
  renderKPIs();
  renderItems();
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function renderKPIs() {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const activeItems = items.filter((i) => !i.completed);

  const dueTodayOrOverdue = activeItems.filter((i) => new Date(i.dueDate) <= endOfToday).length;
  const highIntensityCount = activeItems.filter((i) => i.intensity === 'high').length;

  const installmentItems = activeItems.filter((i) =>
    ['rateizzo', 'f24', 'rottamazione'].includes(i.category)
  );
  const totalAmount = installmentItems.reduce((acc, cur) => acc + (Number(cur.amount) || 0), 0);

  const appointmentCount = activeItems.filter((i) => i.category === 'appuntamento').length;

  document.getElementById('kpiDueToday').textContent = String(dueTodayOrOverdue);
  document.getElementById('kpiHighIntensity').textContent = String(highIntensityCount);
  document.getElementById('kpiInstallments').textContent = String(installmentItems.length);
  document.getElementById('kpiInstallmentsAmount').textContent =
    '€ ' + totalAmount.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('kpiAppointments').textContent = String(appointmentCount);
}

function setQuickFilter(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-tab').forEach((btn) => {
    if (btn.dataset.filter === filter) {
      btn.className = 'filter-tab px-4 py-2 rounded-xl text-xs font-bold bg-carifi-navy text-white shadow-xs whitespace-nowrap transition';
    } else {
      btn.className = 'filter-tab px-4 py-2 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 whitespace-nowrap transition';
    }
  });
  renderItems();
}

function renderItems() {
  const container = document.getElementById('itemsContainer');
  const emptyState = document.getElementById('emptyState');
  const searchQuery = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();
  const sortMode = document.getElementById('sortSelect')?.value || 'due_asc';

  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  let filtered = items.filter((item) => {
    if (currentFilter === 'completed') {
      if (!item.completed) return false;
    } else {
      if (item.completed) return false;
      if (currentFilter === 'appuntamento' && item.category !== 'appuntamento') return false;
      if (currentFilter === 'rateizzo' && !['rateizzo', 'f24', 'rottamazione'].includes(item.category)) return false;
      if (currentFilter === 'urgent' && new Date(item.dueDate) > endOfToday) return false;
      if (currentFilter === 'high_intensity' && item.intensity !== 'high') return false;
    }

    if (searchQuery) {
      const haystack = `${item.client} ${item.title} ${item.installmentRef || ''} ${item.notes || ''}`.toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (sortMode === 'due_asc') {
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
    }
    if (sortMode === 'intensity_desc') {
      const rank = { high: 3, medium: 2, low: 1 };
      return (rank[b.intensity] || 0) - (rank[a.intensity] || 0) || (new Date(a.dueDate) - new Date(b.dueDate));
    }
    if (sortMode === 'client_asc') {
      return (a.client || '').localeCompare(b.client || '');
    }
    if (sortMode === 'amount_desc') {
      return (Number(b.amount) || 0) - (Number(a.amount) || 0);
    }
    return 0;
  });

  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');
  const nowMs = now.getTime();

  container.innerHTML = filtered.map((item) => {
    const dueMs = new Date(item.dueDate).getTime();
    const notifyStartMs = new Date(item.notifyStartAt).getTime();
    const isOverdue = !item.completed && dueMs < nowMs;
    const isAlarmRinging = !item.completed && !item.acknowledged && nowMs >= notifyStartMs;

    const categoryMeta = getCategoryBadgeMeta(item.category);
    const intensityMeta = getIntensityBadgeMeta(item.intensity, item.repeatMinutes);
    const countdownText = getRelativeTimeLabel(dueMs, nowMs, item.completed);

    return `
      <article id="item-${item.id}" class="carifi-card rounded-2xl p-5 flex flex-col justify-between relative overflow-hidden ${
        isAlarmRinging && item.intensity === 'high'
          ? 'urgent-card-active border-2 border-carifi-crimson bg-red-50/15'
          : isOverdue
          ? 'border-carifi-crimson/50'
          : ''
      }">
        <!-- Barra laterale identificativa Navy/Crimson -->
        <div class="absolute top-0 left-0 w-1.5 h-full ${
          item.intensity === 'high' ? 'bg-carifi-crimson' : 'bg-carifi-navy'
        }"></div>

        <div class="pl-2">
          <!-- Riga Superiore: Categoria, Intensità Notifica e Importo -->
          <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold ${categoryMeta.classes}">
                ${categoryMeta.label}
              </span>
              <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold ${intensityMeta.classes}" title="Frequenza di ripetizione delle notifiche">
                ${intensityMeta.label}
              </span>
            </div>

            ${
              item.amount
                ? `<div class="text-right">
                     <span class="text-base sm:text-lg font-extrabold text-carifi-navy bg-slate-100 px-3 py-1 rounded-xl border border-slate-200">
                       € ${Number(item.amount).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                     </span>
                   </div>`
                : ''
            }
          </div>

          <!-- Cliente e Titolo Scadenza -->
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

          <!-- Box Data Scadenza e Orario Inizio Notifiche -->
          <div class="mt-4 p-3.5 rounded-xl bg-slate-50 border border-slate-200/80 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div class="flex items-center gap-2.5">
              <i data-lucide="calendar-clock" class="w-4 h-4 ${isOverdue ? 'text-carifi-crimson' : 'text-carifi-navy'} shrink-0"></i>
              <div>
                <span class="text-[11px] text-slate-500 block">Scadenza Fissata:</span>
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
                <span class="text-[11px] text-slate-500 block">Inizio Notifiche:</span>
                <span class="font-semibold text-carifi-navy">
                  ${formatDateTimeIT(item.notifyStartAt)}
                </span>
                <span class="block text-[11px] ${item.acknowledged ? 'text-emerald-700 font-semibold' : 'text-slate-500'}">
                  ${
                    item.completed
                      ? '✅ Pratica Conclusa'
                      : item.acknowledged
                      ? '✔ Preso in carico (Allarme silenziato)'
                      : isAlarmRinging
                      ? '🚨 IN ALLERTA — In attesa di conferma!'
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

        <!-- Barra Azioni Card -->
        <div class="mt-4 pt-3 pl-2 border-t border-slate-100 flex flex-wrap items-center justify-between gap-2 no-print">
          <div class="flex flex-wrap items-center gap-1.5">
            ${
              isAlarmRinging && !item.acknowledged
                ? `<button onclick="acknowledgeItem('${item.id}')" class="btn-carifi-crimson inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold">
                     <i data-lucide="bell-off" class="w-3.5 h-3.5"></i>
                     <span>Conferma Presa in Carico</span>
                   </button>`
                : ''
            }

            <button onclick="toggleCompleteItem('${item.id}')" class="inline-flex items-center gap-1 px-3.5 py-1.5 rounded-xl text-xs font-bold ${
              item.completed
                ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                : 'btn-carifi-navy text-white'
            } transition">
              <i data-lucide="${item.completed ? 'rotate-ccw' : 'check-circle-2'}" class="w-3.5 h-3.5"></i>
              <span>${item.completed ? 'Riapri' : (item.category === 'appuntamento' ? 'Completato' : 'Segna Pagato')}</span>
            </button>

            ${
              ['rateizzo', 'rottamazione', 'f24'].includes(item.category)
                ? `<button onclick="duplicateNextInstallment('${item.id}')" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-carifi-navy transition" title="Genera subito la rata del mese successivo">
                     <i data-lucide="copy-plus" class="w-3.5 h-3.5"></i>
                     <span>+ Rata Succ.</span>
                   </button>`
                : ''
            }
          </div>

          <div class="flex items-center gap-1">
            <button onclick="notifyClientWhatsApp('${item.id}')" class="p-2 rounded-xl text-emerald-700 hover:bg-emerald-50 border border-transparent hover:border-emerald-200 transition" title="Invia promemoria WhatsApp al cliente">
              <i data-lucide="message-circle" class="w-4 h-4"></i>
            </button>
            <button onclick="openItemModal('${item.id}')" class="p-2 rounded-xl text-carifi-navy hover:bg-slate-100 transition" title="Modifica scadenza o intensità notifiche">
              <i data-lucide="pencil" class="w-4 h-4"></i>
            </button>
            <button onclick="deleteItem('${item.id}')" class="p-2 rounded-xl text-carifi-crimson hover:bg-red-50 transition" title="Elimina">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </article>
    `;
  }).join('');

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// ============================================================================
// MODALE CREAZIONE / MODIFICA SINGOLO APPUNTAMENTO O RATEIZZO
// ============================================================================
function openItemModal(editId = null) {
  const modal = document.getElementById('itemModal');
  const titleEl = document.getElementById('itemModalTitle');
  const form = document.getElementById('itemForm');
  form.reset();

  if (editId) {
    const item = items.find((i) => i.id === editId);
    if (!item) return;
    titleEl.textContent = 'Modifica Scadenza / Appuntamento';
    document.getElementById('itemId').value = item.id;
    document.getElementById('itemCategory').value = item.category;
    document.getElementById('itemClient').value = item.client;
    document.getElementById('itemTitle').value = item.title;
    document.getElementById('itemAmount').value = item.amount ?? '';
    document.getElementById('itemInstallmentRef').value = item.installmentRef || '';
    document.getElementById('itemPhone').value = item.phone || '';
    document.getElementById('itemDueDate').value = toLocalDatetimeInputValue(item.dueDate);
    document.getElementById('itemLeadTime').value = String(item.leadMinutes ?? '1440');

    if (item.leadMinutes === 'custom') {
      document.getElementById('customNotifyWrapper').classList.remove('hidden');
      document.getElementById('itemCustomNotifyAt').value = toLocalDatetimeInputValue(item.notifyStartAt);
    } else {
      document.getElementById('customNotifyWrapper').classList.add('hidden');
    }

    document.getElementById('preAlert7d').checked = Boolean(item.preAlerts?.d7);
    document.getElementById('preAlert3d').checked = Boolean(item.preAlerts?.d3);
    document.getElementById('preAlertMorning').checked = Boolean(item.preAlerts?.morning);

    const radio = document.querySelector(`input[name="intensityLevel"][value="${item.intensity || 'medium'}"]`);
    if (radio) radio.checked = true;

    document.getElementById('itemRepeatMinutes').value = String(item.repeatMinutes || 60);
    document.getElementById('itemNotes').value = item.notes || '';
  } else {
    titleEl.textContent = 'Nuovo Appuntamento o Rateizzo';
    document.getElementById('itemId').value = '';
    const defaultDue = new Date(Date.now() + 24 * 60 * 60 * 1000);
    defaultDue.setHours(10, 0, 0, 0);
    document.getElementById('itemDueDate').value = toLocalDatetimeInputValue(defaultDue.toISOString());
    document.getElementById('itemLeadTime').value = '1440';
    document.getElementById('customNotifyWrapper').classList.add('hidden');
  }

  handleIntensityChange();
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeItemModal() {
  const modal = document.getElementById('itemModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
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
}

function handleIntensityChange() {
  const selected = document.querySelector('input[name="intensityLevel"]:checked')?.value || 'medium';
  const repeatWrapper = document.getElementById('repeatIntervalWrapper');
  const repeatSelect = document.getElementById('itemRepeatMinutes');

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
  const intensityHigh = document.querySelector('input[name="intensityLevel"][value="high"]');
  if (['rateizzo', 'rottamazione', 'f24'].includes(cat) && intensityHigh) {
    intensityHigh.checked = true;
    handleIntensityChange();
  }
}

function updatePreviewNotifyTime() {}

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
  const leadTimeVal = document.getElementById('itemLeadTime').value;
  const intensity = document.querySelector('input[name="intensityLevel"]:checked')?.value || 'medium';
  const repeatMinutes = Number(document.getElementById('itemRepeatMinutes').value || 60);
  const notes = document.getElementById('itemNotes').value.trim();

  const dueDateObj = new Date(dueDateLocal);
  let notifyStartObj;

  if (leadTimeVal === 'custom') {
    const customVal = document.getElementById('itemCustomNotifyAt').value;
    notifyStartObj = customVal ? new Date(customVal) : dueDateObj;
  } else {
    const leadMin = Number(leadTimeVal || 0);
    notifyStartObj = new Date(dueDateObj.getTime() - leadMin * 60 * 1000);
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
    leadMinutes: leadTimeVal,
    notifyStartAt: notifyStartObj.toISOString(),
    preAlerts,
    preAlertsFired: {},
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
  broadcastStateToCloud();
  closeItemModal();
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Salvato e sincronizzato: ${client} — ${title}`, 'success');
}

// ============================================================================
// GENERATORE AUTOMATICO PIANO RATEIZZI (MENSILE / TRIMESTRALE / BIMESTRALE)
// ============================================================================
function openInstallmentPlanModal() {
  const modal = document.getElementById('planModal');
  const nextMonth = new Date();
  nextMonth.setDate(nextMonth.getDate() + 7);
  nextMonth.setHours(9, 30, 0, 0);
  document.getElementById('planFirstDate').value = toLocalDatetimeInputValue(nextMonth.toISOString());
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
  const leadMinutes = Number(document.getElementById('planLeadMinutes').value || 4320);

  const firstDate = new Date(firstDateStr);
  const monthStep = freq === 'quarterly' ? 3 : freq === 'bimonthly' ? 2 : 1;

  for (let i = 1; i <= count; i++) {
    const due = new Date(firstDate);
    due.setMonth(due.getMonth() + (i - 1) * monthStep);
    const notifyStart = new Date(due.getTime() - leadMinutes * 60 * 1000);

    const newItem = {
      id: `carifi-plan-${Date.now()}-${i}`,
      category: 'rateizzo',
      client,
      title: `${baseTitle} (${i}ª Rata)`,
      amount,
      installmentRef: `Rata ${i} di ${count}`,
      phone: '',
      dueDate: due.toISOString(),
      leadMinutes: String(leadMinutes),
      notifyStartAt: notifyStart.toISOString(),
      preAlerts: { d7: true, d3: true, morning: true },
      preAlertsFired: {},
      intensity,
      repeatMinutes: intensity === 'high' ? 15 : 60,
      acknowledged: false,
      completed: false,
      lastNotifiedAt: null,
      snoozedUntil: null,
      notes: `Piano rateizzo generato automaticamente (${count} rate).`,
      updatedAt: new Date().toISOString()
    };

    items.push(newItem);
  }

  saveItemsLocally();
  broadcastStateToCloud();
  closeInstallmentPlanModal();
  renderAll();
  checkAndDispatchNotifications();
  showToast(`Generato e sincronizzato piano di ${count} rate per ${client}!`, 'success');
}

// ============================================================================
// MODALE IMPOSTAZIONI TELEGRAM & SYNC
// ============================================================================
function openSettingsModal() {
  document.getElementById('cfgTelegramToken').value = appConfig.telegramToken || '';
  document.getElementById('cfgTelegramChatId').value = appConfig.telegramChatId || '';
  updateTelegramUIState();

  const modal = document.getElementById('settingsModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeSettingsModal() {
  if (telegramPollTimer) clearInterval(telegramPollTimer);
  const modal = document.getElementById('settingsModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function saveTelegramConfig() {
  appConfig.telegramToken = document.getElementById('cfgTelegramToken').value.trim();
  appConfig.telegramChatId = document.getElementById('cfgTelegramChatId').value.trim();
  saveConfig();
  updateTelegramUIState();
  broadcastStateToCloud();
  showToast('Configurazione Bot Telegram salvata e sincronizzata su tutti i dispositivi!', 'success');
}

async function sendTelegramMessage(text) {
  if (!appConfig.telegramToken || !appConfig.telegramChatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${appConfig.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: appConfig.telegramChatId,
        text: text,
        parse_mode: 'Markdown'
      })
    });
    return res.ok;
  } catch (e) {
    console.warn('Errore invio Telegram:', e);
    return false;
  }
}

async function testTelegramNotification() {
  saveTelegramConfig();
  if (!appConfig.telegramToken || !appConfig.telegramChatId) {
    showToast('Incolla prima il Token e premi "Genera Link & Collega Bot".', 'warning');
    return;
  }
  const ok = await sendTelegramMessage(
    `🏛 *STUDIO CARIFI COMMERCIALISTA*\n✅ Notifica di prova inviata con successo su iPhone e PC!`
  );
  if (ok) {
    showToast('Notifica Telegram inviata! Controlla il tuo iPhone/PC.', 'success');
  } else {
    showToast('Errore nell\'invio a Telegram. Premi "Avvia" sul tuo Bot.', 'error');
  }
}

// ============================================================================
// ESPORTAZIONE / IMPORTAZIONE E PULIZIA DATI
// ============================================================================
function exportDataJson() {
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `backup_studio_carifi_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
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
        broadcastStateToCloud();
        renderAll();
        showToast(`Importati e sincronizzati ${imported.length} promemoria!`, 'success');
      }
    } catch (err) {
      showToast('File JSON non valido.', 'error');
    }
  };
  reader.readAsText(file);
}

async function clearAllItems() {
  if (!confirm('Vuoi cancellare tutti gli appuntamenti e rateizzi presenti in agenda su tutti i dispositivi?')) return;
  const nowIso = new Date().toISOString();
  items.forEach((i) => {
    deletedIds[i.id] = nowIso;
  });
  items = [];
  saveItemsLocally();
  await broadcastStateToCloud({ clearedAllAt: nowIso });
  renderAll();
  checkAndDispatchNotifications();
  closeSettingsModal();
  showToast('Agenda svuotata su tutti i dispositivi.', 'info');
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
    case 'appuntamento':
      return { label: '📅 Appuntamento Studio', classes: 'bg-emerald-50 text-emerald-800 border border-emerald-200' };
    default:
      return { label: '📌 Promemoria Studio', classes: 'bg-slate-100 text-slate-800 border border-slate-200' };
  }
}

function getIntensityBadgeMeta(intensity, repeatMin) {
  if (intensity === 'high') {
    return {
      label: `🔴 Alta Intensità (ogni ${repeatMin || 15} min)`,
      classes: 'bg-red-50 text-carifi-crimson border border-red-300'
    };
  }
  if (intensity === 'medium') {
    return {
      label: `🔵 Media Intensità (ogni ${repeatMin || 60} min)`,
      classes: 'bg-slate-100 text-carifi-navy border border-slate-300'
    };
  }
  return {
    label: '🟢 Bassa (Avviso singolo)',
    classes: 'bg-emerald-50 text-emerald-700 border border-emerald-200'
  };
}

function getIntensityLabel(intensity) {
  if (intensity === 'high') return 'ALTA / INSISTENTE';
  if (intensity === 'medium') return 'MEDIA (Periodica)';
  return 'BASSA (Avviso Singolo)';
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
  if (diffMin < 60) return `⏳ Scade tra ${diffMin} minuti`;
  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `⏳ Scade tra ${hours} ore`;
  const days = Math.ceil(hours / 24);
  return `Mancano ${days} giorni`;
}

function formatDateTimeIT(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }) + ' ore ' + d.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit'
  });
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
