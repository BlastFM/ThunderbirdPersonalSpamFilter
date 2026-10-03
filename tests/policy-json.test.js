const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

  assert.match(policy.customPrompt, /EMAIL SPAM CLASSIFIER \u2014 CONVENTIONAL PRODUCTION/, 'policy must contain the Conventional Production rules');
  for (const section of ['A. MALICIOUS OR FRAUDULENT', 'B. MATERIAL DECEPTION', 'C. EXPLICITLY UNSOLICITED BULK ADVERTISING', 'D. ABUSIVE BULK-PROMOTION PATTERN']) {
    assert.ok(policy.customPrompt.includes(section), 'policy must retain decision basis: ' + section);
  }
  assert.ok(policy.customPrompt.includes('Otherwise return HAM. Do not manufacture intent from uncertainty.'), 'policy must retain the evidence-based HAM default');
  assert.ok(policy.customPrompt.includes('Return exactly {"isSpam":true} or {"isSpam":false}.'), 'policy must require compatible JSON output');

  console.log('policy-json tests passed');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
