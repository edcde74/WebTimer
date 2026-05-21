const assert = require('node:assert/strict');
const { parseCooldownText, shouldConfirmInitialRead } = require('./cooldown-parser');

const cases = [
  ['reads Korean minute and second units', '1분 23초', 180, 83],
  ['reads compact Korean minute and second units', '2분05초', 300, 125],
  ['reads minute-only Korean unit', '3분', 300, 180],
  ['reads colon time', '01:23', 180, 83],
  ['reads latin unit OCR fallback', '1m 23s', 180, 83],
  ['reads compact OCR output from minute-second text', '123', 180, 83],
  ['keeps normal second-only text under a minute', '45', 180, 45],
  ['rejects invalid colon time instead of falling back to seconds fragment', '1:45', 90, null],
  ['rejects invalid separated time instead of falling back to seconds fragment', '1 45', 90, null],
  ['rejects values over the configured maximum', '9분 99초', 300, null],
];

for (const [name, rawText, maxSeconds, expected] of cases) {
  assert.equal(parseCooldownText(rawText, maxSeconds), expected, name);
}

assert.equal(shouldConfirmInitialRead(4, 90), false, 'requires confirmation for tiny first reads');
assert.equal(shouldConfirmInitialRead(5, 90), false, 'requires confirmation for five-second first reads');
assert.equal(shouldConfirmInitialRead(30, 90), true, 'accepts normal first reads immediately');

console.log('cooldown parser tests passed');
