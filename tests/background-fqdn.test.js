const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.resolve(__dirname, '..');
const backgroundSource = fs.readFileSync(path.join(repoRoot, 'background.js'), 'utf8');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function selectStorageValues(store, query) {
  if (query === null || query === undefined) {
    return clone(store);
  }

  if (Array.isArray(query)) {
    const result = {};
    for (const key of query) {
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        result[key] = clone(store[key]);
      }
    }
    return result;
  }

  if (typeof query === 'object') {
    const result = {};
    for (const [key, fallback] of Object.entries(query)) {
      result[key] = Object.prototype.hasOwnProperty.call(store, key) ? clone(store[key]) : clone(fallback);
    }
    return result;
  }

  return {};
}

function buildHarness({ sync = {}, local = {}, messages = {}, fullMessages = {}, accountFolders = [] } = {}) {
  const moved = [];
  const notifications = [];
  const fetchCalls = [];
  const storageSync = { ...sync };
  const storageLocal = { ...local };

  const folderTree = accountFolders.length > 0
    ? accountFolders
    : [
        { id: 'inbox-folder', name: 'Inbox', type: 'inbox', accountId: 'account-1', subFolders: [] },
        { id: 'trash-folder', name: 'Trash', type: 'trash', accountId: 'account-1', subFolders: [] }
      ];

  const account = {
    id: 'account-1',
    type: 'imap',
    name: 'Test Account',
    identities: [{ email: 'recipient@example.com' }],
    rootFolder: { id: 'root-folder', subFolders: folderTree }
  };

  const messenger = {
    menus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: () => {} }
    },
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      getManifest: () => ({ version: 'test' })
    },
    notifications: {
      create: async (payload) => {
        notifications.push(payload);
      }
    },
    storage: {
      sync: {
        get: async (query) => selectStorageValues(storageSync, query),
        set: async (values) => {
          Object.assign(storageSync, clone(values));
        },
        remove: async (key) => {
          delete storageSync[key];
        }
      },
      local: {
        get: async (query) => selectStorageValues(storageLocal, query),
        set: async (values) => {
          Object.assign(storageLocal, clone(values));
        },
        remove: async (key) => {
          delete storageLocal[key];
        }
      }
    },
    messages: {
      onNewMailReceived: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      get: async (id) => clone(messages[id]),
      getFull: async (id) => clone(fullMessages[id]),
      move: async (ids, destinationFolderId) => {
        moved.push({ ids: clone(ids), destinationFolderId });
      },
      query: async () => ({ messages: [] }),
      copy: async () => {},
      delete: async () => {}
    },
    accounts: {
      get: async () => clone(account),
      list: async () => [clone(account)]
    },
    folders: {
      get: async (id) => folderTree.find(folder => folder.id === id) || null,
      create: async () => ({ id: 'created-folder', name: 'AI Filtered Spam', type: 'custom', accountId: 'account-1', subFolders: [] })
    },
    tabs: {
      query: async () => []
    },
    mailTabs: {
      getSelectedFolder: async () => null,
      setSelectedMessages: async () => {}
    }
  };

  const context = {
    console,
    messenger,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"isSpam":false}' } }] }),
        text: async () => ''
      };
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
    module: { exports: {} },
    exports: {}
  };

  const instrumentedSource = `${backgroundSource}
module.exports = {
  getSenderEmail,
  getReplyToAddresses,
  getAddressValidationFailure,
  isValidEmailAddress,
  processIncomingMessages
};`;

  vm.runInNewContext(instrumentedSource, context, { filename: 'background.js' });

  return {
    api: context.module.exports,
    moved,
    notifications,
    fetchCalls,
    storageLocal,
    storageSync
  };
}

async function main() {
  {
    const harness = buildHarness({
      sync: { whitelist: 'example.com', blacklist: '', targetFolder: 'trash' },
      local: { falsePositives: [], spamLog: [] },
      messages: {
        1: {
          id: 1,
          author: '"Trusted Sender" <alerts@example.com>',
          subject: 'Statement available',
          headerMessageId: '<message-1@example.com>',
          folder: { id: 'inbox-folder', accountId: 'account-1', name: 'Inbox' }
        }
      },
      fullMessages: {
        1: {
          headers: {
            'reply-to': ['"Support" <bad..local@example.com>']
          },
          parts: [{ contentType: 'text/plain', body: 'Body text' }]
        }
      }
    });

    await harness.api.processIncomingMessages([{ id: 1 }]);
    assert.strictEqual(harness.moved.length, 1, 'invalid Reply-To should force a spam move');
    assert.strictEqual(harness.fetchCalls.length, 0, 'hard address failures must not fall through to OpenAI');
    assert.strictEqual(harness.storageLocal.spamLog.length, 1, 'hard address failures should be logged as spam');
  }

  {
    const harness = buildHarness({
      sync: { whitelist: 'example.com', blacklist: '', targetFolder: 'trash' },
      local: { falsePositives: [], spamLog: [] },
      messages: {
        2: {
          id: 2,
          author: '"Trusted Sender" <alerts@example.com>',
          subject: 'Normal update',
          headerMessageId: '<message-2@example.com>',
          folder: { id: 'inbox-folder', accountId: 'account-1', name: 'Inbox' }
        }
      },
      fullMessages: {
        2: {
          headers: {},
          parts: [{ contentType: 'text/plain', body: 'Body text' }]
        }
      }
    });

    await harness.api.processIncomingMessages([{ id: 2 }]);
    assert.strictEqual(harness.moved.length, 0, 'missing Reply-To must remain optional');
    assert.strictEqual(harness.fetchCalls.length, 0, 'whitelisted sender should still bypass OpenAI when addresses are valid');
    assert.deepStrictEqual(harness.storageLocal.spamLog, [], 'no spam log entry expected for valid whitelisted mail');
  }

  {
    const harness = buildHarness();
    assert.strictEqual(
      harness.api.getSenderEmail('"Doe, Jane" <Jane.Doe+tag@example.co.uk>'),
      'jane.doe+tag@example.co.uk',
      'quoted display names should still extract the mailbox correctly'
    );
    assert.deepStrictEqual(
      Array.from(harness.api.getReplyToAddresses({
        headers: { 'reply-to': ['"Billing, Support" <reply@example.co.uk>'] }
      })),
      ['reply@example.co.uk'],
      'quoted display names in Reply-To should parse safely'
    );
    assert.strictEqual(
      harness.api.getAddressValidationFailure('"Valid User" <"quoted local"@example.com>', ['"Ops" <reply@example.com>']),
      null,
      'quoted local parts that are RFC-style valid should not be rejected'
    );
  }

  {
    const harness = buildHarness();
    assert.strictEqual(
      harness.api.isValidEmailAddress('bad..dots@example.com'),
      false,
      'malformed local parts must be rejected'
    );
    assert.match(
      harness.api.getAddressValidationFailure('"Bad User" <bad..dots@example.com>', ''),
      /Malformed sender address/,
      'malformed sender local parts should trigger the hard validation rule'
    );
  }

  {
    const longBody = `${'A'.repeat(1600)} MALICIOUS PAYLOAD AFTER OLD LIMIT`;
    const customPrompt = 'CUSTOM RULE: treat payload marker as SPAM';
    const harness = buildHarness({
      sync: { whitelist: '', blacklist: '', targetFolder: 'trash', model: 'gpt-4o-mini' },
      local: { apiKey: 'test-key', customPrompt, falsePositives: [], spamLog: [] },
      messages: {
        3: {
          id: 3,
          author: '"Sender" <sender@example.com>',
          subject: 'Payload check',
          headerMessageId: '<message-3@example.com>',
          folder: { id: 'inbox-folder', accountId: 'account-1', name: 'Inbox' }
        }
      },
      fullMessages: {
        3: {
          headers: {
            'reply-to': ['"Support" <reply@example.com>'],
            'authentication-results': ['mx.example.com; dkim=fail; spf=softfail'],
            'return-path': ['<bounce@example.net>']
          },
          parts: [
            { contentType: 'text/plain', body: longBody },
            { contentType: 'application/pdf', name: 'invoice.pdf', size: 12345 }
          ]
        }
      }
    });

    await harness.api.processIncomingMessages([{ id: 3 }]);

    assert.strictEqual(harness.fetchCalls.length, 1, 'valid non-whitelisted mail should reach OpenAI');
    const requestBody = JSON.parse(harness.fetchCalls[0][1].body);
    assert.match(
      requestBody.messages[0].content,
      /CUSTOM RULE: treat payload marker as SPAM/,
      'custom prompt rules must be included in the OpenAI system message'
    );
    assert.match(
      requestBody.messages[1].content,
      /authentication-results: mx\.example\.com; dkim=fail; spf=softfail/,
      'relevant authentication headers should be included in the classifier evidence'
    );
    assert.match(
      requestBody.messages[1].content,
      /invoice\.pdf/,
      'attachment metadata should be included in the classifier evidence'
    );
    assert.match(
      requestBody.messages[1].content,
      /MALICIOUS PAYLOAD AFTER OLD LIMIT/,
      'classifier body excerpt should include content beyond the old 1,500-character limit'
    );
  }

  console.log('background-fqdn tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
