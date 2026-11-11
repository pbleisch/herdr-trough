import test from 'node:test';
import assert from 'node:assert/strict';
import { localTime, relativeTime } from '../mods/trough/time.js';

test('relative story times use short labels and retain exact local detail time',()=>{
  const now=new Date(2026,10,11,15,0).getTime();
  const ago=milliseconds=>new Date(now-milliseconds).toISOString();
  assert.equal(relativeTime(ago(30000),now),'just now');
  assert.equal(relativeTime(ago(3*60000),now),'3m ago');
  assert.equal(relativeTime(ago(2*3600000),now),'2h ago');
  assert.equal(relativeTime(ago(25*3600000),now),'yesterday');
  assert.equal(relativeTime(ago(3*86400000),now),'3d ago');
  assert.equal(relativeTime(ago(8*86400000),now),new Date(now-8*86400000).toLocaleDateString(undefined,{month:'short',day:'numeric'}));
  assert.equal(localTime(ago(30000)),new Date(now-30000).toLocaleString());
  assert.equal(relativeTime('bad timestamp',now),'bad timestamp');
});
