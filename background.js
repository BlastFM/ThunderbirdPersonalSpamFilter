console.log("[Thunderbird OpenAI Spam Detector] Background service worker initialized.");

// Message IDs we are moving ourselves. Used to stop our own moves from
// re-triggering messages.onUpdated -> processIncomingMessages, which
// previously caused every spam-classified (or restored) email to be
// reclassified a second time.
// NOTE: on some account types (notably IMAP) a message can be assigned a
// new id after being moved, so this guard is a best-effort de-duplication,
// not a hard guarantee. It eliminates the common case (local folders/POP,
// and the immediate re-fire that IMAP servers also usually produce).
const pendingProgrammaticMoves = new Set();

async function moveMessageTracked(messageId, destinationFolder) {
  pendingProgrammaticMoves.add(messageId);
  try {
    // messages.move expects a MailFolderId (string), not a MailFolder
    // object, in current Thunderbird MV3 schemas.
    await messenger.messages.move([messageId], destinationFolder.id);
  } finally {
    // Safety net: if onUpdated never fires (or fires with a different id),
    // don't let the Set grow forever.
    setTimeout(() => pendingProgrammaticMoves.delete(messageId), 5000);
  }
}

function setupContextMenus() {
  messenger.menus.removeAll().then(() => {
    messenger.menus.create({
      id: "mark-as-spam",
      title: "Mark as Spam (Train AI)",
      contexts: ["message_list"],
      icons: {
        "16": "icons/spam-red.png",
        "32": "icons/spam-red.png"
      }
    });

    messenger.menus.create({
      id: "mark-as-not-spam",
      title: "Mark as Not Spam (Train AI)",
      contexts: ["message_list"],
      icons: {
        "16": "icons/not-spam-green.png",
        "32": "icons/not-spam-green.png"
      }
    });
  }).catch(err => console.error("[Thunderbird OpenAI Spam Detector] Context Menu error:", err));
}

// One-time migration: the API key used to live in storage.sync, which
// syncs to every Thunderbird profile signed into the same account. Move
// it to storage.local so the secret stays on this machine only.
async function migrateApiKeyToLocalStorage() {
  try {
    const syncData = await messenger.storage.sync.get(['apiKey']);
    if (!syncData.apiKey) return;

    const localData = await messenger.storage.local.get(['apiKey']);
    if (!localData.apiKey) {
      await messenger.storage.local.set({ apiKey: syncData.apiKey });
    }
    await messenger.storage.sync.remove('apiKey');
    console.log("[Thunderbird OpenAI Spam Detector] Migrated API key from sync to local storage.");
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] API key migration failed:", err);
  }
}

messenger.runtime.onInstalled.addListener(() => {
  setupContextMenus();
  migrateApiKeyToLocalStorage();
});

messenger.runtime.onStartup.addListener(() => {
  setupContextMenus();
  migrateApiKeyToLocalStorage();
});

// Lets the options page's "Mark as Not Spam" log button reuse this file's
// folder-resolution + tracked-move logic instead of re-implementing it.
messenger.runtime.onMessage.addListener((request) => {
  if (request && request.action === 'restoreMessage' && request.messageId) {
    return manualMarkAsNotSpam(request.messageId, request.headerMessageId);
  }
});

// Surfaces a failure to the user via a system notification. Background
// context-menu actions have no popup/status bar to report to, so without
// this a failed move/log (e.g. no destination folder could be found) was
// previously visible only in the Error Console, making it look like the
// button silently did nothing.
async function notifyActionFailure(title, err) {
  try {
    await messenger.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message: (err && err.message) || "An unknown error occurred. See the Error Console for details"
    });
  } catch (notifyErr) {
    console.error("[Thunderbird OpenAI Spam Detector] Could not show failure notification:", notifyErr);
  }
}

messenger.menus.onClicked.addListener(async (info, tab) => {
  const selectedMessages = info.selectedMessages && info.selectedMessages.messages;
  if (!selectedMessages || selectedMessages.length === 0) {
    console.warn("[Thunderbird OpenAI Spam Detector] No message was selected for the context-menu action.");
    await notifyActionFailure(
      "Spam Detector: Action Failed",
      new Error("No message was selected. Select a message in the list, then try again")
    );
    return;
  }

  for (let message of selectedMessages) {
    try {
      if (info.menuItemId === "mark-as-spam") {
        const fullMessage = await messenger.messages.get(message.id);
        const bodyText = await getPlainTextBodyForAction(message.id);
        await handleSpamMessage(fullMessage, bodyText, 'local_ai_spam');
      } else if (info.menuItemId === "mark-as-not-spam") {
        await manualMarkAsNotSpam(message.id, message.headerMessageId);
      }
    } catch (err) {
      console.error(
        `[Thunderbird OpenAI Spam Detector] Context-menu action failed for message ${message.id}:`,
        err
      );
      await notifyActionFailure("Spam Detector: Action Failed", err);
    }
  }
});

messenger.messages.onNewMailReceived.addListener(async (folder, messages) => {
  await processIncomingMessages(messages.messages || []);
});

if (messenger.messages.onUpdated) {
  messenger.messages.onUpdated.addListener(async (message, changedProperties) => {
    if (!changedProperties.folder) return;

    // Skip re-classification for moves we triggered ourselves (spam moves
    // and "not spam" restores both change the folder and would otherwise
    // cause this listener to fire again immediately).
    if (pendingProgrammaticMoves.has(message.id)) {
      pendingProgrammaticMoves.delete(message.id);
      return;
    }

    await processIncomingMessages([message]);
  });
}

// Helper: Convert wildcard string (* and ?) to RegExp
function globToRegex(pattern) {
  const escaped = pattern.trim().toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexString = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
  return new RegExp(regexString);
}

// Helper: Extract full email address from author string
function getSenderEmail(authorString) {
  if (!authorString) return '';
  const match = authorString.match(/<([^>]+)>/) || [null, authorString];
  return (match[1] || authorString).trim().toLowerCase();
}

// Helper: Match sender email or domain against wildcard rules
function matchesDomainPattern(senderEmail, patternList) {
  if (!patternList || patternList.length === 0) return false;

  const senderDomain = senderEmail.split('@').pop() || '';

  return patternList.some(pattern => {
    const cleanPattern = pattern.trim().toLowerCase();
    if (!cleanPattern) return false;

    // Wildcard matching (* or ?)
    if (cleanPattern.includes('*') || cleanPattern.includes('?')) {
      const regex = globToRegex(cleanPattern);
      return regex.test(senderEmail) || regex.test(senderDomain);
    }

    // Exact domain or subdomain match (e.g. "stripe.com" matches "sub.stripe.com")
    return senderDomain === cleanPattern || senderDomain.endsWith('.' + cleanPattern);
  });
}

async function processIncomingMessages(messageList) {
  const { model, customPrompt, whitelist = '', blacklist = '', targetFolder } =
    await messenger.storage.sync.get(['model', 'customPrompt', 'whitelist', 'blacklist', 'targetFolder']);
  const { apiKey } = await messenger.storage.local.get(['apiKey']);

  const safePatterns = whitelist.split(',').map(d => d.trim()).filter(Boolean);
  const blockedPatterns = blacklist.split(',').map(d => d.trim()).filter(Boolean);

  const activeModel = model || 'gpt-4o-mini';
  const { falsePositives, spamLog: confirmedSpamLog } =
    await messenger.storage.local.get({ falsePositives: [], spamLog: [] });

  const resolvedTargetFolder = targetFolder || 'trash';
  // Cache the resolved spam destination per account for this batch. This
  // avoids a redundant accounts.get()/Local Folders lookup per message and,
  // more importantly, lets us detect messages that are already sitting in
  // the spam destination (see the guard below).
  const destinationCache = new Map();

  for (let message of messageList) {
    try {
      const fullMessage = await messenger.messages.get(message.id);
      const senderEmail = getSenderEmail(fullMessage.author);

      // Guard against reclassifying messages that are already in the spam
      // destination. This matters most for the "Local Folders / AI Filtered
      // Spam" destination: moving a message there from a different account
      // is a copy+delete under the hood, and Thunderbird can surface the
      // copy as "new mail", which would otherwise re-trigger the AI call
      // and append a duplicate log entry for a message we already handled.
      if (fullMessage.folder) {
        const currentDestination = await resolveSpamDestinationFolder(
          fullMessage.folder.accountId, resolvedTargetFolder, destinationCache
        );
        if (currentDestination && currentDestination.id === fullMessage.folder.id) {
          continue;
        }
      }

      // Fast-Path 1: Whitelist Match (Skip AI & Stay in Inbox)
      if (matchesDomainPattern(senderEmail, safePatterns)) {
        console.log(`[Thunderbird OpenAI Spam Detector] Whitelisted pattern match (${senderEmail}): Skipping classification.`);
        continue;
      }

      // Fast-Path 2: Blacklist Match (Skip AI & Move to Spam)
      if (matchesDomainPattern(senderEmail, blockedPatterns)) {
        console.log(`[Thunderbird OpenAI Spam Detector] Blacklisted pattern match (${senderEmail}): Moving to spam.`);
        await handleSpamMessage(fullMessage, "Blacklisted Sender Pattern Match");
        continue;
      }

      // AI Analysis Path
      if (!apiKey) {
        console.warn("[Thunderbird OpenAI Spam Detector] Skipping classification: No API key configured.");
        continue; // was `return` - that aborted the whole batch, not just this message
      }

      const bodyText = await getPlainTextBody(message.id);

      const isSpam = await classifyEmailWithOpenAI({
        author: fullMessage.author,
        subject: fullMessage.subject,
        body: bodyText.substring(0, 1500),
        apiKey,
        model: activeModel,
        customPrompt,
        falsePositives,
        confirmedSpam: confirmedSpamLog
      });

      if (isSpam) {
        console.log(`[Thunderbird OpenAI Spam Detector] Spam detected: "${fullMessage.subject}"`);
        await handleSpamMessage(fullMessage, bodyText);
      }
    } catch (err) {
      console.error("[Thunderbird OpenAI Spam Detector] Error processing message:", err);
    }
  }
}

// Resolves (and caches, per batch) the MailFolder that a given account's
// spam should currently land in for the configured destination setting.
// 'local_ai_spam' is still cached per-account (not globally) because the
// actual destination can differ per account: profiles with a Local Folders
// account share one folder there, but accounts on a profile without Local
// Folders instead fall back to a folder created under that same account.
// Thunderbird MV3 replaced MailAccount.folders (a flat array of top-level
// folders) with MailAccount.rootFolder, whose .subFolders must be
// explicitly requested via includeSubFolders, and only then contains the
// (recursively nested) folder tree. This helper fetches an account with
// that flag set and returns the equivalent top-level folder array so the
// rest of this file (findFolderByType/findFolderByName, which both expect
// an array and recurse via .subFolders) doesn't need to change.
async function getAccountFolders(accountId) {
  const account = await messenger.accounts.get(accountId, true);
  return account && account.rootFolder ? account.rootFolder.subFolders : [];
}

async function resolveSpamDestinationFolder(accountId, resolvedTargetFolder, cache) {
  if (!cache.has(accountId)) {
    try {
      let folder;
      if (resolvedTargetFolder === 'local_ai_spam') {
        folder = await getOrCreateAISpamFolder(accountId);
      } else {
        const accountFolders = await getAccountFolders(accountId);
        folder = resolvedTargetFolder === 'junk'
          ? findFolderByType(accountFolders, 'junk')
          : findFolderByType(accountFolders, 'trash');
      }
      cache.set(accountId, folder);
    } catch (err) {
      cache.set(accountId, null);
    }
  }
  return cache.get(accountId);
}

// Shared helper: fetch a message's body and return plain, HTML-stripped text.
// Centralizes logic that was previously duplicated in three places.
async function getPlainTextBody(messageId) {
  const messageBody = await messenger.messages.getFull(messageId);
  let bodyText = extractTextFromParts(messageBody.parts || []);
  if (!bodyText.trim() && messageBody.body) {
    bodyText = messageBody.body;
  }
  return stripHtmlTags(bodyText);
}

async function getPlainTextBodyForAction(messageId) {
  try {
    return await getPlainTextBody(messageId);
  } catch (err) {
    // Body access is useful for the log snippet, but must not prevent a
    // manual spam action from moving and recording the selected message.
    console.warn(
      `[Thunderbird OpenAI Spam Detector] Could not read message body for ${messageId}; continuing without a snippet:`,
      err
    );
    return "";
  }
}

// Prefers the first text/plain part found anywhere in the MIME tree; only
// falls back to text/html if no plain-text part exists at all. (Previously
// a text/html part appearing before a text/plain part in the tree would
// get concatenated with the plain-text part instead of being skipped.)
function extractTextFromParts(parts) {
  const plain = findPartBody(parts, "text/plain");
  if (plain && plain.trim()) return plain;

  const html = findPartBody(parts, "text/html");
  return html || "";
}

function findPartBody(parts, contentType) {
  for (let part of parts) {
    if (part.contentType === contentType && part.body) {
      return part.body;
    }
    if (part.parts) {
      const nested = findPartBody(part.parts, contentType);
      if (nested) return nested;
    }
  }
  return "";
}

function stripHtmlTags(str) {
  return (str || "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>?/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function classifyEmailWithOpenAI({ author, subject, body, apiKey, model, customPrompt, falsePositives, confirmedSpam }) {
  let fpContext = "";
  if (falsePositives && falsePositives.length > 0) {
    // Most-recent examples are the most relevant training signal, and
    // capping the count keeps the prompt (and token cost) bounded even
    // though storage can hold up to 50 entries.
    const recentFalsePositives = falsePositives.slice(0, 20);
    fpContext = "\n\nCRITICAL OVERRIDE RULE - The user marked these similar emails as NOT SPAM. Treat emails with similar patterns as HAM:\n" +
      recentFalsePositives.map(fp => `- From: "${fp.author}", Subject: "${fp.subject}"`).join("\n");
  }

  let spamContext = "";
  if (confirmedSpam && confirmedSpam.length > 0) {
    const recentConfirmedSpam = confirmedSpam.slice(0, 20);
    spamContext = "\n\nThe user previously confirmed these emails as SPAM. Treat emails with similar senders, subjects, or patterns as SPAM too:\n" +
      recentConfirmedSpam.map(entry => `- From: "${entry.author}", Subject: "${entry.subject}"`).join("\n");
  }

  const systemPrompt = `You are an expert email spam classifier running inside Thunderbird. Analyze the email and respond strictly with JSON: {"isSpam": true} or {"isSpam": false}. Do not include markdown formatting or commentary.${spamContext}${fpContext}${customPrompt ? `\n\nCustom User Rules:\n${customPrompt}` : ""}`;

  const userContent = `From: ${author}\nSubject: ${subject}\nBody Snippet:\n${body}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      console.error("[Thunderbird OpenAI Spam Detector] OpenAI API error status:", response.status);
      return false;
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);
    return !!result.isSpam;
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] Classification failed:", err);
    return false;
  }
}

async function clearSourceFolderSelection(folderId) {
  if (!folderId || !messenger.mailTabs || !messenger.tabs) return;

  const mailTabs = await messenger.tabs.query({ type: "mail" });
  await Promise.all(mailTabs.map(async tab => {
    try {
      const selectedFolder = await messenger.mailTabs.getSelectedFolder(tab.id);
      if (selectedFolder && selectedFolder.id === folderId) {
        await messenger.mailTabs.setSelectedMessages(tab.id, []);
      }
    } catch (err) {
      // A mail tab can close while asynchronous classification is running.
      console.warn(
        `[Thunderbird OpenAI Spam Detector] Could not clear selection in mail tab ${tab.id}:`,
        err
      );
    }
  }));
}

async function handleSpamMessage(messageHeader, fullBody, destinationOverride = null) {
  const { spamLog = [] } = await messenger.storage.local.get(['spamLog']);
  const { targetFolder } = await messenger.storage.sync.get({ targetFolder: 'trash' });
  const selectedTargetFolder = destinationOverride || targetFolder;

  try {
    if (!messageHeader.folder) {
      throw new Error("The message has no source folder.");
    }

    const accountId = messageHeader.folder.accountId;
    let destinationFolder = null;

    if (selectedTargetFolder === 'junk') {
      destinationFolder = findFolderByType(await getAccountFolders(accountId), 'junk');
    } else if (selectedTargetFolder === 'local_ai_spam') {
      destinationFolder = await getOrCreateAISpamFolder(accountId);
    } else {
      destinationFolder = findFolderByType(await getAccountFolders(accountId), 'trash');
    }

    const alreadyInDestination = destinationFolder && destinationFolder.id === messageHeader.folder.id;

    if (alreadyInDestination) {
      console.log("[Thunderbird OpenAI Spam Detector] Message is already in the configured spam folder.");
    } else if (destinationFolder) {
      await moveMessageTracked(messageHeader.id, destinationFolder);
    } else {
      throw new Error("No destination folder was found for the spam action.");
    }

    // If the message was already sitting in the destination folder, its
    // current folder isn't a meaningful "original" location to restore to
    // later, so leave originFolderId unset (manualMarkAsNotSpam already
    // falls back to Inbox when it is missing).
    const originFolderId = alreadyInDestination ? null : messageHeader.folder.id;

    const newEntry = {
      id: messageHeader.id,
      headerMessageId: messageHeader.headerMessageId || null,
      author: messageHeader.author,
      subject: messageHeader.subject,
      bodySnippet: (fullBody || "").substring(0, 120).replace(/\s+/g, ' '),
      dateAdded: new Date().toISOString(),
      originFolderId: originFolderId
    };

    // Only record the classification after Thunderbird confirms the move.
    // De-dupe against any existing entry for the same message (matched by
    // id or, as a fallback for IMAP ids that can change after a move, by
    // headerMessageId) so repeated actions on the same message update its
    // entry in place instead of growing the log with duplicates.
    const dedupedLog = spamLog.filter(item =>
      item.id !== newEntry.id &&
      !(newEntry.headerMessageId && item.headerMessageId === newEntry.headerMessageId)
    );
    const updatedLog = [newEntry, ...dedupedLog].slice(0, 50);
    await messenger.storage.local.set({ spamLog: updatedLog });
    await clearSourceFolderSelection(messageHeader.folder.id);
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] Could not move email to target spam folder:", err);
    throw err;
  }
}

// Thunderbird's numeric MessageHeader.id is not a stable identifier: it is
// reassigned every time a message is moved to a different folder (and does
// not survive a Thunderbird restart either). Spam log entries are acted on
// well after the message they describe was moved into the spam folder, so
// the id recorded at detection time is expected to be stale by the time
// "Mark as Not Spam" runs against it -- looking it up with that id would
// silently fail to find the message (and thus never move/log anything).
// The RFC822 Message-ID header does not change across moves, so prefer
// resolving the message via messages.query({ headerMessageId }) whenever
// we have one, and only fall back to the possibly-stale id.
async function resolveCurrentMessage(messageId, headerMessageId) {
  if (headerMessageId) {
    try {
      const result = await messenger.messages.query({ headerMessageId });
      if (result && result.messages && result.messages.length > 0) {
        return result.messages[0];
      }
    } catch (err) {
      console.warn("[Thunderbird OpenAI Spam Detector] headerMessageId lookup failed, falling back to stored id:", err);
    }
  }
  return messenger.messages.get(messageId);
}

async function manualMarkAsNotSpam(messageId, headerMessageId = null) {
  try {
    const messageHeader = await resolveCurrentMessage(messageId, headerMessageId);
    const bodyText = await getPlainTextBodyForAction(messageHeader.id);

    const { spamLog = [], falsePositives = [] } =
      await messenger.storage.local.get(['spamLog', 'falsePositives']);

    const logItem = spamLog.find(item =>
      item.id === messageId ||
      item.id === messageHeader.id ||
      (messageHeader.headerMessageId &&
        item.headerMessageId === messageHeader.headerMessageId)
    );
    let targetFolder = null;

    if (logItem && logItem.originFolderId) {
      try {
        targetFolder = await messenger.folders.get(logItem.originFolderId);
      } catch (e) {
        console.warn("[Thunderbird OpenAI Spam Detector] Origin folder unavailable, falling back to Inbox.");
      }
    }

    if (!targetFolder) {
      targetFolder = findFolderByType(await getAccountFolders(messageHeader.folder.accountId), 'inbox');
    }

    const newFP = {
      id: messageHeader.id,
      headerMessageId: messageHeader.headerMessageId || null,
      author: messageHeader.author,
      subject: messageHeader.subject,
      bodySnippet: (bodyText || "").substring(0, 120).replace(/\s+/g, ' '),
      dateAdded: new Date().toISOString()
    };

    // De-dupe the same way handleSpamMessage does, so repeatedly restoring
    // the same message doesn't grow the training data with duplicates.
    const dedupedFP = falsePositives.filter(item =>
      item.id !== newFP.id &&
      !(newFP.headerMessageId && item.headerMessageId === newFP.headerMessageId)
    );
    const updatedFP = [newFP, ...dedupedFP].slice(0, 20);
    const updatedSpamLog = spamLog.filter(item => item !== logItem);

    if (!targetFolder) {
      throw new Error("No destination folder was found for restoring the message.");
    }

    await moveMessageTracked(messageHeader.id, targetFolder);

    // Only update training history after Thunderbird confirms the restore.
    await messenger.storage.local.set({
      falsePositives: updatedFP,
      spamLog: updatedSpamLog
    });
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] Error marking message as not spam:", err);
    throw err;
  }
}

function findFolderByType(folders, typeName) {
  for (let f of folders || []) {
    // Thunderbird MV3 replaced MailFolder.type (a single string) with
    // specialUse (an array of strings, e.g. a folder can be both "trash"
    // and "junk" in unusual configurations), so check membership instead
    // of equality. f.type is still checked for older Thunderbird releases
    // that predate this rename.
    if ((f.specialUse && f.specialUse.includes(typeName)) || f.type === typeName) return f;
    const lowerName = (f.name || "").toLowerCase();
    if (typeName === 'trash' && (lowerName === 'trash' || lowerName === 'deleted' || lowerName === 'deleted items' || lowerName === 'bin')) return f;
    if (typeName === 'junk' && (lowerName === 'junk' || lowerName === 'spam' || lowerName === 'bulk')) return f;
    if (typeName === 'inbox' && lowerName === 'inbox') return f;

    if (f.subFolders && f.subFolders.length > 0) {
      const found = findFolderByType(f.subFolders, typeName);
      if (found) return found;
    }
  }
  return null;
}

// Resolves the "AI Filtered Spam" destination folder. Prefers a single
// shared folder under the Local Folders account (so all accounts land in
// one place); if no Local Folders account exists on this profile (common
// on pure-IMAP setups with no local storage configured), falls back to a
// top-level "AI Filtered Spam" folder created directly under the message's
// own account so the feature still works instead of silently doing nothing.
async function getOrCreateAISpamFolder(fallbackAccountId) {
  try {
    // includeSubFolders is required in current Thunderbird MV3 schemas;
    // without it, accounts.list() returns MailAccounts whose rootFolder
    // has no populated subFolders and every folder lookup below would
    // silently find nothing.
    const accounts = await messenger.accounts.list(true);
    // Thunderbird MV3 renamed the local-account MailAccount.type value
    // from "none" to "local"; accept both for compatibility across
    // Thunderbird versions.
    const localAccount = accounts.find(a => a.type === "local" || a.type === "none" || a.name === "Local Folders");

    if (localAccount) {
      let targetFolder = findFolderByName(localAccount.rootFolder.subFolders, "AI Filtered Spam");
      if (!targetFolder) {
        // folders.create expects the parent folder's id (a MailFolderId),
        // not a MailFolder/MailAccount object. Passing the account's root
        // folder id creates "AI Filtered Spam" as a top-level folder of
        // Local Folders, rather than nesting it under an arbitrary
        // existing folder.
        targetFolder = await messenger.folders.create(localAccount.rootFolder.id, "AI Filtered Spam");
      }
      return targetFolder;
    }

    if (!fallbackAccountId) return null;

    const account = accounts.find(a => a.id === fallbackAccountId) || await messenger.accounts.get(fallbackAccountId, true);
    if (!account) return null;

    let targetFolder = findFolderByName(account.rootFolder.subFolders, "AI Filtered Spam");
    if (!targetFolder) {
      targetFolder = await messenger.folders.create(account.rootFolder.id, "AI Filtered Spam");
    }
    return targetFolder;
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] Could not find or create the AI Filtered Spam folder:", err);
    return null;
  }
}

function findFolderByName(folders, folderName) {
  for (let folder of folders || []) {
    if (folder.name === folderName) return folder;
    const nested = findFolderByName(folder.subFolders, folderName);
    if (nested) return nested;
  }
  return null;
}
