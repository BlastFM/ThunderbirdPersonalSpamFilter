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

function normalizeHeaderValue(headerValue) {
  if (Array.isArray(headerValue)) {
    return headerValue
      .filter(value => value !== null && value !== undefined)
      .map(value => String(value))
      .join(', ');
  }
  return headerValue === null || headerValue === undefined ? '' : String(headerValue);
}

function splitMailboxList(headerValue) {
  const normalized = normalizeHeaderValue(headerValue).trim();
  if (!normalized) return [];

  const tokens = [];
  let current = '';
  let inQuotes = false;
  let escapeNext = false;
  let angleDepth = 0;
  let commentDepth = 0;

  for (const char of normalized) {
    if (escapeNext) {
      current += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inQuotes) {
      current += char;
      escapeNext = true;
      continue;
    }

    if (char === '"' && commentDepth === 0) {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '<') {
        angleDepth += 1;
      } else if (char === '>' && angleDepth > 0) {
        angleDepth -= 1;
      } else if (char === '(') {
        commentDepth += 1;
      } else if (char === ')' && commentDepth > 0) {
        commentDepth -= 1;
      }
    }

    if (!inQuotes && angleDepth === 0 && commentDepth === 0 && (char === ',' || char === ';')) {
      if (current.trim()) tokens.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) tokens.push(current.trim());
  return tokens;
}

function stripHeaderComments(value) {
  let result = '';
  let inQuotes = false;
  let escapeNext = false;
  let commentDepth = 0;

  for (const char of value) {
    if (escapeNext) {
      if (commentDepth === 0) result += char;
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inQuotes) {
      if (commentDepth === 0) result += char;
      escapeNext = true;
      continue;
    }

    if (char === '"' && commentDepth === 0) {
      inQuotes = !inQuotes;
      result += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '(') {
        commentDepth += 1;
        continue;
      }
      if (char === ')' && commentDepth > 0) {
        commentDepth -= 1;
        continue;
      }
    }

    if (commentDepth === 0) result += char;
  }

  return result.trim();
}

function extractAddressSpec(mailboxEntry) {
  const trimmed = stripHeaderComments((mailboxEntry || '').trim());
  if (!trimmed) return '';

  const bracketMatch = trimmed.match(/<\s*([^<>]+?)\s*>/);
  if (bracketMatch) {
    return bracketMatch[1].trim().toLowerCase();
  }

  return trimmed.includes('@') ? trimmed.trim().toLowerCase() : '';
}

function parseMailboxEntries(headerValue) {
  return splitMailboxList(headerValue).map(entry => ({
    raw: entry,
    address: extractAddressSpec(entry)
  }));
}

// Helper: Extract full email address from author string
function getSenderEmail(authorString) {
  const entries = parseMailboxEntries(authorString);
  return entries.length > 0 ? entries[0].address : '';
}

function getReplyToHeader(messageBody) {
  return messageBody && messageBody.headers ? messageBody.headers['reply-to'] : '';
}

function getReplyToAddresses(messageBody) {
  return parseMailboxEntries(getReplyToHeader(messageBody))
    .map(entry => entry.address)
    .filter(Boolean);
}

const UNQUOTED_LOCAL_PART_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;

function isQuotedLocalPart(localPart) {
  return localPart.length >= 2 && localPart.startsWith('"') && localPart.endsWith('"');
}

function isValidQuotedLocalPart(localPart) {
  if (!isQuotedLocalPart(localPart)) return false;

  let escapeNext = false;
  for (let i = 1; i < localPart.length - 1; i += 1) {
    const char = localPart[i];
    const code = char.charCodeAt(0);

    if (escapeNext) {
      if (code < 32 || code === 127) return false;
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"' || code < 32 || code === 127) {
      return false;
    }
  }

  return !escapeNext;
}

function isValidLocalPart(localPart) {
  if (!localPart || localPart.length > 64) return false;

  if (isQuotedLocalPart(localPart)) {
    return isValidQuotedLocalPart(localPart);
  }

  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
    return false;
  }

  return UNQUOTED_LOCAL_PART_RE.test(localPart);
}

function isIpv4Address(value) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;

  return value.split('.').every(part => {
    const numeric = Number(part);
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 255;
  });
}

function isIpv6Address(value) {
  return value.includes(':');
}

function isIpAddressDomain(domain) {
  const unwrapped = domain.replace(/^\[|\]$/g, '');
  if (/^ipv6:/i.test(unwrapped)) return true;
  return isIpv4Address(unwrapped) || isIpv6Address(unwrapped);
}

function isValidDomainLabel(label) {
  if (!label || label.length > 63) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;

  if (/^[a-z0-9-]+$/i.test(label)) return true;

  return /^[^\s@<>\[\]\(\),;:"'\\\/]+$/u.test(label);
}

function isValidPublicDomain(domain) {
  if (!domain) return false;

  const normalized = domain.trim().toLowerCase().replace(/\.+$/, '');
  if (!normalized) return false;
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return false;
  if (normalized.includes('..') || normalized.startsWith('.')) return false;
  if (normalized.includes('_')) return false;
  if (isIpAddressDomain(normalized)) return false;

  const labels = normalized.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(isValidDomainLabel)) return false;

  const topLevel = labels[labels.length - 1];
  if (/^\d+$/.test(topLevel)) return false;

  return true;
}

function isValidEmailAddress(address) {
  const normalized = (address || '').trim();
  if (!normalized) return false;

  const firstAt = normalized.indexOf('@');
  const lastAt = normalized.lastIndexOf('@');
  if (firstAt <= 0 || firstAt !== lastAt || lastAt === normalized.length - 1) {
    return false;
  }

  const localPart = normalized.slice(0, firstAt);
  const domain = normalized.slice(firstAt + 1);

  return isValidLocalPart(localPart) && isValidPublicDomain(domain);
}

function getAddressValidationFailure(authorString, replyToHeaderValue) {
  const normalizedAuthor = normalizeHeaderValue(authorString).trim();
  if (normalizedAuthor) {
    const senderEntries = parseMailboxEntries(authorString);
    if (senderEntries.length === 0 || !senderEntries[0].address) {
      return 'Malformed sender address';
    }
    if (!isValidEmailAddress(senderEntries[0].address)) {
      return `Malformed sender address: ${senderEntries[0].address}`;
    }
  }

  const normalizedReplyTo = normalizeHeaderValue(replyToHeaderValue).trim();
  if (!normalizedReplyTo) {
    return null;
  }

  const replyToEntries = parseMailboxEntries(replyToHeaderValue);
  if (replyToEntries.length === 0) {
    return 'Malformed Reply-To address';
  }

  for (const entry of replyToEntries) {
    if (!entry.address) {
      return `Malformed Reply-To address: ${entry.raw}`;
    }
    if (!isValidEmailAddress(entry.address)) {
      return `Malformed Reply-To address: ${entry.address}`;
    }
  }

  return null;
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
  const { model, customPrompt: syncedCustomPrompt, whitelist = '', blacklist = '', targetFolder } =
    await messenger.storage.sync.get(['model', 'customPrompt', 'whitelist', 'blacklist', 'targetFolder']);
  const { apiKey, customPrompt: localCustomPrompt } = await messenger.storage.local.get(['apiKey', 'customPrompt']);
  const customPrompt = localCustomPrompt || syncedCustomPrompt || '';

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

      // Guard against re-spamming a message the user just manually
      // restored with "Mark as Not Spam". Restoring out of the shared
      // "Local Folders / AI Filtered Spam" folder back to a different
      // account is also a copy+delete, which assigns the restored copy a
      // new id and can make Thunderbird surface it as "new mail" in the
      // destination folder, re-triggering this very function for it
      // almost immediately -- before pendingProgrammaticMoves (which is
      // keyed by the pre-move id) has any chance of matching. Without this
      // guard, the AI could reclassify the message as spam again and
      // immediately bounce it right back into the spam folder, undoing
      // the user's action. falsePositives is only ever appended to by an
      // explicit user action (this restore, or the options page's
      // "Mark as Not Spam" log button), so matching against it here is a
      // hard override, not just AI training context.
      if (falsePositives.some(fp =>
        (fullMessage.headerMessageId && fp.headerMessageId === fullMessage.headerMessageId) ||
        fp.id === fullMessage.id
      )) {
        console.log("[Thunderbird OpenAI Spam Detector] Skipping classification: message was manually marked Not Spam.");
        continue;
      }

      const messageBody = await messenger.messages.getFull(message.id);
      const senderEmail = getSenderEmail(fullMessage.author);
      const replyToAddresses = getReplyToAddresses(messageBody);
      const addressValidationFailure = getAddressValidationFailure(
        fullMessage.author,
        getReplyToHeader(messageBody)
      );

      if (addressValidationFailure) {
        console.log(
          `[Thunderbird OpenAI Spam Detector] Hard address validation failure (${addressValidationFailure}): moving to spam.`
        );
        await handleSpamMessage(fullMessage, addressValidationFailure);
        continue;
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

      const bodyText = getPlainTextBodyFromMessage(messageBody);

      const isSpam = await classifyEmailWithOpenAI({
        author: fullMessage.author,
        replyTo: replyToAddresses.length > 0 ? replyToAddresses.join(', ') : '(missing)',
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
function getPlainTextBodyFromMessage(messageBody) {
  let bodyText = extractTextFromParts(messageBody.parts || []);
  if (!bodyText.trim() && messageBody.body) {
    bodyText = messageBody.body;
  }
  return stripHtmlTags(bodyText);
}

async function getPlainTextBody(messageId) {
  const messageBody = await messenger.messages.getFull(messageId);
  return getPlainTextBodyFromMessage(messageBody);
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

async function classifyEmailWithOpenAI({ author, replyTo, subject, body, apiKey, model, customPrompt, falsePositives, confirmedSpam }) {
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

  const userContent = `From: ${author}\nReply-To: ${replyTo}\nSubject: ${subject}\nBody Snippet:\n${body}`;

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
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch (readErr) {
        errorBody = "(could not read response body)";
      }
      console.error(
        `[Thunderbird OpenAI Spam Detector] OpenAI API error status: ${response.status}. Body: ${errorBody}`
      );
      await notifyClassificationFailure(response.status, errorBody);
      return false;
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);
    return !!result.isSpam;
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] Classification failed:", err);
    await notifyClassificationFailure(null, (err && err.message) || String(err));
    return false;
  }
}

// A misconfigured/exhausted API key (invalid key, expired billing, rate
// limit, quota exceeded) makes every classification silently fail closed
// (treated as "not spam", per classifyEmailWithOpenAI's catch-all), which
// looks identical to "the AI just isn't catching much spam" from the
// options page -- there was previously no way to tell the two apart short
// of manually opening the Error Console. Surface a single notification per
// cooldown window instead of failing silently on every message.
let lastClassificationFailureNotifyAt = 0;
const CLASSIFICATION_FAILURE_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

async function notifyClassificationFailure(status, detail) {
  const now = Date.now();
  if (now - lastClassificationFailureNotifyAt < CLASSIFICATION_FAILURE_NOTIFY_COOLDOWN_MS) {
    return;
  }
  lastClassificationFailureNotifyAt = now;

  let reason = "An unknown error occurred while contacting OpenAI.";
  if (status === 401 || status === 403) {
    reason = "Your OpenAI API key was rejected (invalid or revoked). Spam detection is not running.";
  } else if (status === 429) {
    reason = "OpenAI rate limit or quota exceeded. Spam detection may be skipping messages until this clears.";
  } else if (status && status >= 500) {
    reason = `OpenAI's service returned an error (HTTP ${status}). Spam detection may be skipping messages.`;
  } else if (status) {
    reason = `OpenAI returned an error (HTTP ${status}). Spam detection may be skipping messages.`;
  } else if (detail) {
    reason = `Spam detection failed: ${detail}`;
  }

  try {
    await messenger.notifications.create({
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: "Spam Detector: Classification Failing",
      message: reason + " Check the Options page and the Error Console for details."
    });
  } catch (notifyErr) {
    console.error("[Thunderbird OpenAI Spam Detector] Could not show classification-failure notification:", notifyErr);
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
// RFC822 Message-IDs are stored canonically with angle brackets in
// MessageHeader.headerMessageId, but entries written by older versions of
// this extension (and some broken senders) may lack them. Normalise both
// sides before comparing so a bare "abc@host" still matches "<abc@host>".
function normalizeMessageId(id) {
  if (!id) return null;
  const trimmed = String(id).trim();
  const inner = trimmed.replace(/^<+|>+$/g, '');
  return inner ? `<${inner}>` : null;
}

async function resolveCurrentMessage(messageId, headerMessageId) {
  if (headerMessageId) {
    try {
      const result = await messenger.messages.query({ headerMessageId });
      if (result && result.messages && result.messages.length > 0) {
        // The same Message-ID can exist in several folders at once
        // (duplicate deliveries, or an earlier restore that left a copy
        // behind). Blindly taking the first match can resolve to a stale
        // copy in a different folder than the one the user acted on, which
        // previously turned a restore into a silent no-op (moving an Inbox
        // copy "back" to the Inbox while the spam-folder copy the user
        // clicked was never touched). Prefer the exact message the caller
        // passed in when it is among the matches; otherwise prefer a copy
        // that is NOT in the configured spam destination, since a restore
        // should act on the spam-folder copy.
        const candidates = result.messages;
        const exact = candidates.find(m => m.id === messageId);
        if (exact) return exact;
        const { targetFolder = 'trash' } = await messenger.storage.sync.get({ targetFolder: 'trash' });
        const preferred = [];
        for (const m of candidates) {
          if (!m.folder) { preferred.push(m); continue; }
          try {
            const destination = await resolveSpamDestinationFolder(m.folder.accountId, targetFolder, new Map());
            if (!destination || destination.id !== m.folder.id) preferred.push(m);
          } catch (e) {
            preferred.push(m);
          }
        }
        return preferred[0] || candidates[0];
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
    console.log(
      `[Thunderbird OpenAI Spam Detector] Not-Spam restore: resolved id=${messageHeader.id} ` +
      `(requested id=${messageId}), headerMessageId=${messageHeader.headerMessageId}, ` +
      `folder="${messageHeader.folder ? messageHeader.folder.name : '?'}" ` +
      `(account ${messageHeader.folder ? messageHeader.folder.accountId : '?'})`
    );
    const bodyText = await getPlainTextBodyForAction(messageHeader.id);

    const { spamLog = [], falsePositives = [] } =
      await messenger.storage.local.get(['spamLog', 'falsePositives']);

    const targetHeaderId = normalizeMessageId(messageHeader.headerMessageId);
    const logItem = spamLog.find(item =>
      item.id === messageId ||
      item.id === messageHeader.id ||
      (targetHeaderId &&
        normalizeMessageId(item.headerMessageId) === targetHeaderId)
    );
    let targetFolder = null;

    if (logItem && logItem.originFolderId) {
      console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: spam log entry found, origin folder id=${logItem.originFolderId}`);
      try {
        targetFolder = await messenger.folders.get(logItem.originFolderId);
      } catch (e) {
        console.warn("[Thunderbird OpenAI Spam Detector] Origin folder unavailable, falling back to Inbox.", e);
      }
    } else {
      console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: no spam log entry found for this message (spamLog has ${spamLog.length} entries).`);
    }

    if (!targetFolder) {
      // No per-message origin is recorded (the entry predates origin
      // tracking, or was already sitting in the destination when logged).
      // The To: address identifies which account received the message, so
      // match it against each account's identity email and restore to that
      // account's Inbox -- far more reliable than the profile's default
      // Inbox, which is what previously sent restores to the wrong folder.
      try {
        const recipientEmails = (messageHeader.recipients || [])
          .map(r => getSenderEmail(r))
          .filter(Boolean);
        if (recipientEmails.length > 0) {
          const accounts = await messenger.accounts.list(true);
          for (const account of accounts) {
            if (account.type === "local" || account.type === "none") continue;
            const identityEmails = (account.identities || [])
              .map(id => (id.email || "").trim().toLowerCase())
              .filter(Boolean);
            const matched = recipientEmails.some(r => identityEmails.includes(r));
            if (matched) {
              const inbox = findFolderByType(account.rootFolder ? account.rootFolder.subFolders : [], 'inbox');
              if (inbox) {
                targetFolder = inbox;
                console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: no per-message origin; matched a recipient to account "${account.name}", restoring to its Inbox.`);
                break;
              }
            }
          }
        }
      } catch (e) {
        console.warn("[Thunderbird OpenAI Spam Detector] Recipient-based account match failed.", e);
      }
    }

    if (!targetFolder) {
      // No recipient matched a known account identity. Reuse the origin
      // folder recorded by the *other* recent log entries -- for a user who
      // always filters from one account/folder, that is a much better guess
      // than the profile's default Inbox.
      const originCounts = new Map();
      for (const item of spamLog) {
        if (item !== logItem && item.originFolderId) {
          originCounts.set(item.originFolderId, (originCounts.get(item.originFolderId) || 0) + 1);
        }
      }
      let bestOriginId = null;
      let bestCount = 0;
      for (const [folderId, count] of originCounts) {
        if (count > bestCount) { bestCount = count; bestOriginId = folderId; }
      }
      if (bestOriginId) {
        try {
          targetFolder = await messenger.folders.get(bestOriginId);
          if (targetFolder) {
            console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: no per-message origin; reusing the most common origin folder from the spam log ("${targetFolder.name}", seen ${bestCount}x).`);
          }
        } catch (e) {
          console.warn("[Thunderbird OpenAI Spam Detector] Most common origin folder unavailable, falling back to Inbox.", e);
        }
      }
    }

    if (!targetFolder) {
      targetFolder = await findFallbackInboxFolder(messageHeader.folder.accountId);
    }
    console.log(
      `[Thunderbird OpenAI Spam Detector] Not-Spam restore: destination=` +
      (targetFolder ? `"${targetFolder.name}" (id=${targetFolder.id}, account ${targetFolder.accountId})` : 'NONE')
    );

    const newFP = {
      id: messageHeader.id,
      headerMessageId: normalizeMessageId(messageHeader.headerMessageId),
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

    // Persist the training history *before* moving the message. Moving a
    // message to a folder in a different account (e.g. restoring out of
    // the shared "Local Folders / AI Filtered Spam" folder back to an
    // IMAP account's Inbox) is a copy+delete under the hood and assigns
    // the message a new id, which can make Thunderbird surface the
    // restored copy as "new mail" in the destination folder. That fires
    // processIncomingMessages again almost immediately, and if this
    // false-positive entry were written only after the move, the AI could
    // reclassify the same message as spam before the override was ever
    // recorded, bouncing it straight back into the spam folder. Writing
    // the entry first means processIncomingMessages' isKnownFalsePositive
    // guard (see below) is already in place by the time that happens.
    await messenger.storage.local.set({
      falsePositives: updatedFP,
      spamLog: updatedSpamLog
    });

    try {
      await moveMessageTracked(messageHeader.id, targetFolder);
      console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: move reported success (id=${messageHeader.id}).`);
    } catch (moveErr) {
      // messages.move is unreliable for cross-account moves (e.g. out of
      // the shared "Local Folders / AI Filtered Spam" folder back into an
      // IMAP account's Inbox): it sits on nsIMsgCopyService, whose
      // cross-account behaviour has been restricted since Thunderbird 91,
      // so the move can throw and leave the message stuck in the spam
      // folder even though the training entry above was already written.
      // Fall back to the documented workaround: copy the message, verify
      // the copy actually arrived in the destination, then delete the
      // original.
      console.warn(
        "[Thunderbird OpenAI Spam Detector] Direct move failed, trying copy+delete fallback:",
        moveErr
      );
      try {
        await messenger.messages.copy([messageHeader.id], targetFolder.id);
        console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: copy to destination reported success.`);

        if (messageHeader.headerMessageId) {
          const check = await messenger.messages.query({
            headerMessageId: messageHeader.headerMessageId
          });
          const locations = (check && check.messages ? check.messages : [])
            .map(m => `"${m.folder ? m.folder.name : '?'}" (${m.folder ? m.folder.id : '?'})`);
          const arrived = check && check.messages && check.messages.some(m =>
            m.folder && m.folder.id === targetFolder.id
          );
          console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: copy verification -> arrived=${arrived}; copies found in: ${locations.join(', ') || 'none'}`);
          if (!arrived) {
            throw new Error("Copy appeared to succeed, but the message was not found in the destination folder.");
          }
        }

        await messenger.messages.delete([messageHeader.id]);
        console.log(`[Thunderbird OpenAI Spam Detector] Not-Spam restore: original deleted from spam folder.`);
      } catch (fallbackErr) {
        // The message is still in the spam folder. Put its Detected Spam
        // Log entry back so the options page keeps listing it and the
        // restore can be retried. The training entry (falsePositives) is
        // intentionally kept: it still records the user's intent and stops
        // the AI from re-spamming the message in the meantime.
        if (logItem) {
          try {
            const { spamLog: currentLog = [] } = await messenger.storage.local.get(['spamLog']);
            const alreadyListed = currentLog.some(item =>
              (logItem.headerMessageId && item.headerMessageId === logItem.headerMessageId) ||
              item.id === logItem.id
            );
            if (!alreadyListed) {
              await messenger.storage.local.set({ spamLog: [logItem, ...currentLog] });
            }
          } catch (rollbackErr) {
            console.warn("[Thunderbird OpenAI Spam Detector] Could not restore the spam log entry:", rollbackErr);
          }
        }
        throw fallbackErr;
      }
    }
  } catch (err) {
    console.error("[Thunderbird OpenAI Spam Detector] Error marking message as not spam:", err);
    throw err;
  }
}

// Falls back to an Inbox when no per-message origin folder is known (e.g.
// the spam log entry was pruned or cleared). The message's *current*
// folder's account cannot be used for this lookup: when the configured
// spam destination is "Local Folders / AI Filtered Spam", the message is
// currently sitting in the shared Local Folders account, which normally
// has no Inbox of its own -- searching there for one silently found
// nothing and left the message stuck in the spam folder. Prefer the
// profile's default account's Inbox instead, then fall back to the first
// non-local account that has one.
async function findFallbackInboxFolder(currentAccountId) {
  const isLocalAccount = (a) => a && (a.type === "local" || a.type === "none" || a.name === "Local Folders");

  try {
    const accounts = await messenger.accounts.list(true);

    // Prefer the account the message is currently sitting in, unless that
    // is the shared Local Folders account.
    const currentAccount = accounts.find(a => a.id === currentAccountId);
    if (currentAccount && !isLocalAccount(currentAccount)) {
      const inbox = findFolderByType(currentAccount.rootFolder.subFolders, 'inbox');
      if (inbox) return inbox;
    }

    const defaultAccount = await messenger.accounts.getDefault(true);
    if (defaultAccount && !isLocalAccount(defaultAccount)) {
      const inbox = findFolderByType(defaultAccount.rootFolder ? defaultAccount.rootFolder.subFolders : [], 'inbox');
      if (inbox) return inbox;
    }

    for (const account of accounts) {
      if (isLocalAccount(account)) continue;
      const inbox = findFolderByType(account.rootFolder ? account.rootFolder.subFolders : [], 'inbox');
      if (inbox) return inbox;
    }
  } catch (err) {
    console.warn("[Thunderbird OpenAI Spam Detector] Could not resolve a fallback Inbox folder:", err);
  }

  return null;
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
