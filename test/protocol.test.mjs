import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { post, ingest, stored, list, setState, rejections, publishExclusive } from '../mods/trough/core/store.js';
import { parseJson, validateStory } from '../mods/trough/core/schema.js';
import { prune } from '../mods/trough/core/prune.js';

const cli=path.resolve('mods/trough/bin/trough');
const root=()=>fs.mkdtemp(path.join(os.tmpdir(),'trough-test-'));
const story=(id=crypto.randomBytes(16).toString('hex'))=>({v:1,id,source:{id:'test',label:'Test'},kind:'report',title:'A result',summary:'Evidence is ready.',occurred_at:'2026-11-11T18:00:00Z',severity:'notice'});
const bytes=s=>Buffer.from(JSON.stringify(s)+'\n');
const run=(dir,...args)=>spawnSync(process.execPath,[cli,...args],{env:{...process.env,TROUGH_DIR:dir},encoding:'utf8'});

test('direct atomic file and CLI post enter the same immutable store',async()=>{
  const dir=await root(); const a=story(),b=story();
  await fs.mkdir(path.join(dir,'inbox'),{recursive:true});
  await publishExclusive(path.join(dir,'inbox'),`${a.id}.json`,bytes(a));
  const input=path.join(dir,'post.json'); await fs.writeFile(input,bytes(b));
  assert.equal(run(dir,'post','--file',input).status,0);
  const rows=await list(dir);
  assert.deepEqual(rows.map(r=>r.story.id).sort(),[a.id,b.id].sort());
  assert.deepEqual((await stored(dir,a.id)).story,a);
  assert.deepEqual((await stored(dir,b.id)).story,b);
  assert.match(rows[0].received_at,/^\d{4}-\d\d-\d\dT/);
  assert.equal((await fs.readdir(path.join(dir,'inbox'))).filter(n=>n.endsWith('.json')).length,0);
  const conflict={...a,title:'A false replacement'};
  await publishExclusive(path.join(dir,'inbox'),`${a.id}.json`,bytes(conflict));
  assert.equal((await ingest(dir))[0].status,'rejected');
  assert.equal((await stored(dir,a.id)).story.title,'A result');
  assert.match((await rejections(dir))[0].reason,/conflicting stored story id/);
  assert.equal(run(dir,'post','--file',input).status,0); // exact retry is idempotent
});

test('invalid bytes, symlinks, duplicate keys and filenames are rejected',async()=>{
  const dir=await root(),s=story(); await fs.mkdir(path.join(dir,'inbox'),{recursive:true});
  await fs.writeFile(path.join(dir,'inbox',`${s.id}.json`),`{"v":1,"v":1}`);
  assert.match((await ingest(dir))[0].reason,/duplicate JSON key/);
  await fs.symlink('/etc/passwd',path.join(dir,'inbox',`${s.id}.json`));
  assert.match((await ingest(dir))[0].reason,/symlink/);
  await fs.writeFile(path.join(dir,'inbox','bad.json'),bytes(s));
  assert.match((await ingest(dir))[0].reason,/does not match filename/);
  assert.equal((await list(dir)).length,0);
});

test('schema excludes hidden behavior and checks decision and link references',()=>{
  const s=story();
  assert.throws(()=>validateStory({...s,command:'/bin/sh'}),/unknown field/);
  assert.throws(()=>validateStory({...s,occurred_at:'2026-02-30T00:00:00Z'}),/calendar date/);
  assert.throws(()=>parseJson(Buffer.from('{"a":1,"a":2}')),/duplicate JSON key/);
  assert.doesNotThrow(()=>validateStory({...s,kind:'decision',decision:{question_id:'q',prompt:'Choose',options:[]}}));
  assert.throws(()=>validateStory({...s,kind:'decision',decision:{question_id:'q',prompt:'Choose',options:[]},actions:[{id:'answer',label:'Answer',handler:'custom',choice:true}]}),/at least two options/);
  assert.throws(()=>validateStory({...s,actions:[{id:'open',label:'Open',handler:'open_url',args:{link:'missing'}}]}),/declared link/);
});

test('operator state persists and independent changes are serialized',async()=>{
  const dir=await root(),s=story(); await post(dir,bytes(s));
  await Promise.all([setState(dir,s.id,'read'),setState(dir,s.id,'done')]);
  let row=(await list(dir))[0]; assert.ok(row.state.read_at); assert.ok(row.state.done_at);
  const until='2026-12-12T00:00:00Z';
  assert.equal(run(dir,'snooze',s.id,'--until',until).status,0);
  assert.equal((await list(dir))[0].state.snoozed_until,until);
  assert.equal(run(dir,'undo',s.id).status,0);
  row=(await list(dir))[0]; assert.equal(row.state.done_at,undefined); assert.ok(row.state.read_at);
});

test('done marks an unread story read, removes it from Inbox, and makes it prunable',async()=>{
  const dir=await root(),s=story(); await post(dir,bytes(s));
  const before=(await list(dir))[0]; assert.equal(before.state.read_at,undefined);
  assert.equal(run(dir,'ls','--inbox','--json').status,0);
  const done=run(dir,'done',s.id); assert.equal(done.status,0,done.stderr);
  const state=(await list(dir))[0].state;
  assert.equal(state.read_at,state.done_at);
  assert.deepEqual(JSON.parse(run(dir,'ls','--inbox','--json').stdout),[]);
  assert.deepEqual(JSON.parse(run(dir,'ls','--unread','--json').stdout),[]);
  assert.deepEqual((await prune(dir,{olderThan:'1d',now:Date.parse(state.done_at)+86400000})).ids,[s.id]);
});

test('simultaneous importers leave one card and no false rejection',async()=>{
  const dir=await root(),s=story(); await fs.mkdir(path.join(dir,'inbox'),{recursive:true});
  await publishExclusive(path.join(dir,'inbox'),`${s.id}.json`,bytes(s));
  await Promise.all([ingest(dir),ingest(dir),ingest(dir)]);
  assert.equal((await list(dir)).length,1);
  assert.equal((await rejections(dir)).length,0);
});
