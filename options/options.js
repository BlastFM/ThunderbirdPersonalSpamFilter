document.addEventListener('DOMContentLoaded', async () => {
  const api = typeof messenger !== 'undefined' ? messenger : browser;

  // Non-secret settings live in storage.sync (so they roam with the
  // profile); the API key lives in storage.local only, so it never leaves
  // this machine.
  const { model, targetFolder, customPrompt, whitelist, blacklist } =
    await api.storage.sync.get(['model', 'targetFolder', 'customPrompt', 'whitelist', 'blacklist']);
  const { apiKey } = await api.storage.local.get(['apiKey']);

  if (apiKey) document.getElementById('apiKey').value = apiKey || '';
  if (model) document.getElementById('model').value = model || 'gpt-4o-mini';
  if (targetFolder) document.getElementById('targetFolder').value = targetFolder || 'trash';
  if (whitelist) document.getElementById('whitelist').value = whitelist || '';
  if (blacklist) document.getElementById('blacklist').value = blacklist || '';
  if (customPrompt) document.getElementById('customPrompt').value = customPrompt || '';

  // 2. Initial logs render
  await loadLogs();

  // 3. Storage change listener
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local') {
      if (changes.spamLog || changes.falsePositives) {
        loadLogs();
      }
    }
  });

  // 4. Attach Backup & Restore handlers
  setupBackupHandlers();
  setupDynamicSaveStatus();
  renderFooterVersion(api);
});

// Reads the installed version straight from the manifest so the footer
// never drifts out of sync with an actual release.
function renderFooterVersion(api) {
  const footerText = document.getElementById('footerVersionText');
  if (!footerText) return;

  const version = api.runtime.getManifest().version;
  footerText.innerHTML = `OpenAI Spam Detector ${escapeHtml(version)} is offered FREE by <strong>BlastFM Limited</strong>.`;
}

function setupDynamicSaveStatus() {
  const fields = ['apiKey', 'model', 'targetFolder', 'whitelist', 'blacklist', 'customPrompt'];
  fields.forEach((id) => {
    document.getElementById(id).addEventListener('input', markSettingsDirty);
    document.getElementById(id).addEventListener('change', markSettingsDirty);
  });
}

let settingsDirty = false;
let headerStatusTimeout = null;

function markSettingsDirty() {
  settingsDirty = true;
  setHeaderStatus('Unsaved changes', 'dirty');
}

function setHeaderStatus(text, state = 'ready') {
  const textElement = document.getElementById('headerStatusText');
  const status = document.querySelector('.header-status');
  if (!textElement || !status) return;
  if (headerStatusTimeout) clearTimeout(headerStatusTimeout);
  textElement.textContent = text;
  status.className = `header-status ${state}`;
  status.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');

  if (state !== 'dirty' && state !== 'ready') {
    headerStatusTimeout = setTimeout(() => {
      const resetState = settingsDirty ? 'dirty' : 'ready';
      const resetText = settingsDirty ? 'Unsaved changes' : 'Ready to protect';
      setHeaderStatus(resetText, resetState);
    }, 5000);
  }
}

// --- LOG LOADING & RENDERING ---

async function loadLogs() {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  const { spamLog = [], falsePositives = [] } =
    await api.storage.local.get(['spamLog', 'falsePositives']);

  renderLog('spamLogContainer', spamLog, 'No spam detected yet.');
  renderLog('falsePositivesContainer', falsePositives, 'No false positives recorded.');
  updateExportBackupState(spamLog, falsePositives);
}

// Exporting a backup with no spam log and no training memory would only
// contain settings and (optionally) the API key, so disable the button
// until there's actually something worth backing up.
function updateExportBackupState(spamLog, falsePositives) {
  const exportBtn = document.getElementById('exportBackup');
  if (!exportBtn) return;

  const hasLogs = (spamLog && spamLog.length > 0) || (falsePositives && falsePositives.length > 0);
  exportBtn.disabled = !hasLogs;
  exportBtn.title = hasLogs
    ? ''
    : 'No spam log or training memory entries to back up yet';
}

function renderLog(containerId, list, emptyMessage) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!list || list.length === 0) {
    container.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
    return;
  }

  const isSpamLog = containerId === 'spamLogContainer';
  const isFP = containerId === 'falsePositivesContainer';

  container.innerHTML = list.map((item, index) => {
    const isNewest = index === 0;
    const iconPath = isSpamLog ? '../icons/spam-red.png' : '../icons/not-spam-green.png';
    const author = item.author || item.sender || 'Unknown Sender';
    const subject = item.subject || 'No Subject';
    const dateRaw = item.dateAdded || item.timestamp || item.date;
    const formattedDate = dateRaw ? new Date(dateRaw).toLocaleDateString() + ' ' + new Date(dateRaw).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '';

    return `
      <div class="log-card-item ${isNewest ? 'newest-entry' : ''}">
        <div class="log-card-header">
          <div class="log-author-wrap">
            <img src="${iconPath}" alt="Status" style="width:14px; height:14px; flex-shrink:0;">
            <span class="log-author">${escapeHtml(author)}</span>
          </div>
          <div class="log-meta">
            ${isNewest ? '<span class="entry-badge">Latest</span>' : ''}
            <span class="log-date">${formattedDate}</span>
          </div>
        </div>
        <div class="log-subject">${escapeHtml(subject)}</div>
        <div class="log-snippet">${escapeHtml(item.bodySnippet || '')}</div>
        <div class="log-footer${isSpamLog ? ' log-footer-end' : ''}">
          ${isSpamLog ? `
            <button class="btn btn-green-outline btn-sm mark-not-spam-btn" data-index="${index}">Mark as Not Spam</button>
          ` : ''}
          ${isFP ? `
            <span class="training-badge">Active Training Prompt</span>
            <button class="btn btn-orange-outline btn-sm remove-fp-btn" data-index="${index}">Remove</button>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  if (isSpamLog) {
    container.querySelectorAll('.mark-not-spam-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        await markLogItemAsNotSpam(idx);
      });
    });
  }

  if (isFP) {
    container.querySelectorAll('.remove-fp-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        await removeFalsePositive(idx);
      });
    });
  }

  container.scrollTop = 0;
}

// --- LOG ACTION HANDLERS ---

async function markLogItemAsNotSpam(index) {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  const { spamLog } = await api.storage.local.get({ spamLog: [] });
  const item = spamLog[index];
  if (!item || !item.id) return;

  // Delegate entirely to the background script's manualMarkAsNotSpam: it
  // already updates falsePositives/spamLog AND moves the message with the
  // tracked-move guard that prevents an immediate reclassification once it
  // lands back in the origin folder. Duplicating that bookkeeping here
  // previously caused the log entry to be recorded twice.
  try {
    await api.runtime.sendMessage({
      action: 'restoreMessage',
      messageId: item.id,
      headerMessageId: item.headerMessageId || null
    });
    showStatus('Message restored and added to AI Training Memory', 'success');
  } catch (err) {
    console.warn('Could not move physical message:', err);
    showStatus('Message was not restored. ' + getErrorMessage(err), 'error');
  }
}

async function removeFalsePositive(index) {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  try {
    const { falsePositives } = await api.storage.local.get({ falsePositives: [] });
    falsePositives.splice(index, 1);
    await api.storage.local.set({ falsePositives });
    showStatus('Training example removed from AI Training Memory', 'success');
  } catch (err) {
    showStatus('Training example could not be removed. ' + getErrorMessage(err), 'error');
  }
}

// --- SETTINGS FORM & API TESTING ---

document.getElementById('save').addEventListener('click', async () => {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('model').value;
  const targetFolder = document.getElementById('targetFolder').value;
  const whitelist = document.getElementById('whitelist').value.trim();
  const blacklist = document.getElementById('blacklist').value.trim();
  const customPrompt = document.getElementById('customPrompt').value.trim();

  if (!apiKey) {
    showStatus('Enter an OpenAI API key before saving settings', 'error');
    return;
  }

  try {
    setHeaderStatus('Saving...', 'saving');
    // Secret stays local-only; everything else can roam via sync.
    await api.storage.local.set({ apiKey });
    await api.storage.sync.set({ model, targetFolder, whitelist, blacklist, customPrompt });
    settingsDirty = false;
    showStatus('Settings saved. New messages will use these rules', 'success');
  } catch (err) {
    showStatus('Settings could not be saved. ' + getErrorMessage(err), 'error');
  }
});

document.getElementById('testKey').addEventListener('click', async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const testBtn = document.getElementById('testKey');
  const spinner = testBtn.querySelector('.btn-spinner');

  if (!apiKey) {
    showStatus('Enter an OpenAI API key before testing the connection', 'error');
    return;
  }

  testBtn.disabled = true;
  spinner.classList.remove('hidden');
  setHeaderStatus('Testing connection...', 'saving');
  showStatus('Testing the OpenAI connection...', 'info');

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (response.ok) {
      showStatus('OpenAI connection successful. The API key is valid', 'success');
    } else {
      const errData = await response.json().catch(() => ({}));
      const msg = errData.error?.message || `HTTP ${response.status}`;
      showStatus(`OpenAI rejected the request: ${msg}`, 'error');
    }
  } catch (err) {
    showStatus('Could not reach OpenAI. Check your network connection and try again', 'error');
  } finally {
    testBtn.disabled = false;
    spinner.classList.add('hidden');
  }
});

function requestClearConfirmation(title, message) {
  const dialog = document.getElementById('confirmDialog');
  const titleElement = document.getElementById('confirmDialogTitle');
  const messageElement = document.getElementById('confirmDialogMessage');
  const confirmButton = document.getElementById('confirmDialogConfirm');
  const cancelButton = document.getElementById('confirmDialogCancel');
  const backdrop = dialog.querySelector('[data-confirm-cancel]');

  titleElement.textContent = title;
  messageElement.textContent = message;
  dialog.classList.remove('hidden');
  confirmButton.focus();

  return new Promise(resolve => {
    const close = confirmed => {
      dialog.classList.add('hidden');
      confirmButton.removeEventListener('click', confirmAction);
      cancelButton.removeEventListener('click', cancelAction);
      backdrop.removeEventListener('click', cancelAction);
      dialog.removeEventListener('keydown', keydownAction);
      resolve(confirmed);
    };
    const confirmAction = () => close(true);
    const cancelAction = () => close(false);
    const keydownAction = event => {
      if (event.key === 'Escape') close(false);
    };

    confirmButton.addEventListener('click', confirmAction);
    cancelButton.addEventListener('click', cancelAction);
    backdrop.addEventListener('click', cancelAction);
    dialog.addEventListener('keydown', keydownAction);
  });
}

document.getElementById('clearSpamLog').addEventListener('click', async () => {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  const confirmed = await requestClearConfirmation(
    'Clear Detected Spam Log?',
    'All recorded spam entries will be permanently removed. This action cannot be undone'
  );
  if (!confirmed) return;

  try {
    await api.storage.local.set({ spamLog: [], spamExamples: [] });
    showStatus('Detected Spam Log cleared', 'success');
  } catch (err) {
    showStatus('Detected Spam Log could not be cleared. ' + getErrorMessage(err), 'error');
  }
});

document.getElementById('clearFPLog').addEventListener('click', async () => {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  const confirmed = await requestClearConfirmation(
    'Clear AI Training Memory?',
    'All learned not-spam examples will be permanently removed. This action cannot be undone'
  );
  if (!confirmed) return;

  try {
    await api.storage.local.set({ falsePositives: [] });
    showStatus('AI Training Memory cleared', 'success');
  } catch (err) {
    showStatus('AI Training Memory could not be cleared. ' + getErrorMessage(err), 'error');
  }
});

// --- BACKUP & RESTORE MODULE ---

function populateFormFields(settings, credentials) {
  if (settings) {
    document.getElementById('model').value = settings.model || 'gpt-4o-mini';
    document.getElementById('targetFolder').value = settings.targetFolder || 'trash';
    document.getElementById('whitelist').value = settings.whitelist || '';
    document.getElementById('blacklist').value = settings.blacklist || '';
    document.getElementById('customPrompt').value = settings.customPrompt || '';
  }
  if (credentials && Object.prototype.hasOwnProperty.call(credentials, 'apiKey')) {
    document.getElementById('apiKey').value = credentials.apiKey || '';
  }
}

function setupBackupHandlers() {
  const exportBtn = document.getElementById('exportBackup');
  const importFileInput = document.getElementById('importFileInput');
  const importBackupBtn = document.getElementById('importBackupBtn');

  if (importBackupBtn && importFileInput) {
    importBackupBtn.addEventListener('click', () => importFileInput.click());
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const confirmed = confirm(
        "This backup will contain your OpenAI API key in PLAIN TEXT, " +
        "along with your rules, spam log, and training data. Continue?"
      );
      if (!confirmed) return;

      try {
        const api = typeof messenger !== 'undefined' ? messenger : browser;
        const syncData = await api.storage.sync.get(null);
        const localData = await api.storage.local.get(null);
        const { apiKey, ...logsAndTraining } = localData;
        const manifestVersion = api.runtime && api.runtime.getManifest ? api.runtime.getManifest().version : '1.4.6';

        const fullBackup = {
          version: manifestVersion,
          exportedAt: new Date().toISOString(),
          type: "full_backup",
          settings: syncData,
          credentials: { apiKey: apiKey || '' },
          logsAndTraining
        };

        downloadJson(fullBackup, `openai_spam_detector_backup_${new Date().toISOString().slice(0, 10)}.json`);
        showStatus("Full backup downloaded. Keep the file secure because it contains your API key", "success");
      } catch (err) {
        showStatus("Backup export failed. " + getErrorMessage(err), "error");
      }
    });
  }

  if (importFileInput) {
    importFileInput.addEventListener('change', (e) => {
      handleImportFile(e, async (importedData, api) => {
        if (importedData.settings) {
          // Back-compat: older backups put apiKey inside "settings".
          const hasLegacyApiKey = Object.prototype.hasOwnProperty.call(importedData.settings, 'apiKey');
          const { apiKey: legacyApiKey, ...syncSettings } = importedData.settings;
          const credentials = importedData.credentials ||
            (hasLegacyApiKey ? { apiKey: legacyApiKey } : null);

          await api.storage.sync.set(syncSettings);
          if (credentials && Object.prototype.hasOwnProperty.call(credentials, 'apiKey')) {
            if (credentials.apiKey) {
              await api.storage.local.set({ apiKey: credentials.apiKey });
            } else {
              await api.storage.local.remove('apiKey');
            }
          }
          if (importedData.logsAndTraining) {
            await api.storage.local.set(importedData.logsAndTraining);
          }
          populateFormFields(syncSettings, credentials);
        } else {
          await api.storage.local.set(importedData);
        }

        await loadLogs();
        showStatus("Full backup restored. Settings, logs, and training memory are now active", "success");
      });
    });
  }
}

function handleImportFile(event, restoreCallback) {
  const api = typeof messenger !== 'undefined' ? messenger : browser;
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (uploadEvent) => {
    try {
      const importedData = JSON.parse(uploadEvent.target.result);
      if (typeof importedData !== "object" || importedData === null) {
        throw new Error("Invalid JSON structure");
      }
      await restoreCallback(importedData, api);
    } catch (err) {
      console.error("Import error:", err);
      showStatus("Backup import failed " + getErrorMessage(err), "error");
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file);
}

function downloadJson(dataObject, filename) {
  const jsonStr = JSON.stringify(dataObject, null, 2);
  const blob = new Blob([jsonStr], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  try {
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
  } finally {
    setTimeout(() => {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 150);
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getErrorMessage(error) {
  const message = error && error.message ? error.message.trim() : '';
  return message || 'Please try again.';
}

function showStatus(text, type) {
  const state = type === 'success' ? 'success' : type === 'error' ? 'error' : 'info';
  setHeaderStatus(text, state);
}
