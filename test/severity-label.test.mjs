import test from 'node:test';
import assert from 'node:assert/strict';
import { severityLabel } from '../mods/trough/severity-label.js';

test('pane severity labels are four characters',()=>{
  assert.deepEqual(['info','notice','warning','critical'].map(severityLabel),['INFO','NOTE','WARN','CRIT']);
});
