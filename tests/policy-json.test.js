const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Validates the downloadable Custom Classification Prompt Rules policy file:
// - it is well-formed classification_policy JSON that options.js's importer accepts
// - the rewritten V2 compact ruleset is present
// - the add-on's hard local FQDN validation rule (independent of the AI prompt)
// is documented so users testing the prompt manually understand it still applies
async function run() {
  const policyPath = path.join(__dirname, '..', 'docs', 'conservative-classification-policy.json');
  const raw = fs.readFileSync(policyPath, 'utf8');

  let policy;
  assert.doesNotThrow(() => { policy = JSON.parse(raw); }, 'policy file must be valid JSON');

  assert.strictEqual(policy.type, 'classification_policy', 'policy type must be classification_policy');
  assert.ok(typeof policy.name === 'string' && policy.name.length > 0, 'policy must have a name');
  assert.ok(Number.isInteger(policy.version) && policy.version > 0, 'policy must have an integer version');
  assert.ok(typeof policy.customPrompt === 'string' && policy.customPrompt.length > 0, 'policy must include customPrompt text');

  // options.js's import handler treats any object with a string customPrompt
  // and no logsAndTraining field as a classification-policy import.
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(policy, 'logsAndTraining'),
    false,
    'policy JSON must not include logsAndTraining, or the importer will treat it as a full backup instead of a rules import'
  );

  assert.match(
    policy.customPrompt,
    /EMAIL SPAM CLASSIFIER — V2 COMPACT PRODUCTION/,
    'policy must contain the rewritten V2 compact production ruleset header'
  );

  assert.match(
    policy.customPrompt,
    /HARD LOCAL FQDN VALIDATION \(ENFORCED BY THE ADD-ON BEFORE AI CLASSIFICATION\)/,
    'policy must document that the add-on enforces the hard FQDN validation rule locally before AI classification'
  );

  assert.match(
    policy.customPrompt,
    /if the sender address is absent, unusable, malformed, or not a normal public fully-qualified domain name \(FQDN\) email address, classify as SPAM/,
    'policy must preserve the hard sender FQDN rule text'
  );

  assert.match(
    policy.customPrompt,
    /if a Reply-To address is present and is malformed or not a normal public FQDN email address, classify as SPAM/,
    'policy must preserve the hard Reply-To FQDN rule text'
  );

  assert.match(
    policy.customPrompt,
    /a missing Reply-To address is normal and is not suspicious by itself/,
    'policy must preserve that a missing Reply-To remains allowed'
  );

  console.log('policy-json tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
