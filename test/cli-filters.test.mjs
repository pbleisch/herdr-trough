import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { post, setState } from '../mods/trough/core/store.js';

const cli=path.resolve('mods/trough/bin/trough');
const run=(dir,...args)=>spawnSync(process.execPath,[cli,'--dir',dir,'ls','--json',...args],{encoding:'utf8'});
const ids=(dir,...args)=>{
  const result=run(dir,...args);
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout).map(row=>row.story.title).sort();
};
const make=(title,source,actions=false)=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:source,label:source},kind:'report',title,summary:'Ready',occurred_at:new Date().toISOString(),severity:'notice',subject:{type:'project',key:'build',label:'Build'},...(actions?{links:[{id:'site',label:'Site',url:'https://example.com'}],actions:[{id:'open',label:'Open',handler:'open_url',args:{link:'site'}}]}:{})});

test('trough ls composes state flags, repeated field values, and search',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trough-cli-filters-'));
  const a=make('Build agent','agent',true),b=make('Build monitor','monitor',true),c=make('Read agent','agent',true),d=make('No action','agent');
  for(const story of [a,b,c,d]) await post(dir,Buffer.from(JSON.stringify(story)+'\n'));
  await setState(dir,c.id,'read');
  await setState(dir,d.id,'done');
  assert.deepEqual(ids(dir,'--unread','--needs-action','--source','agent','--subject','build','--search','build'),['Build agent']);
  assert.deepEqual(ids(dir,'--unread','--needs-action','--source','agent','--source','monitor'),['Build agent','Build monitor']);
  assert.deepEqual(ids(dir,'--done'),['No action']);
  assert.deepEqual(ids(dir,'--all','--source','agent'),['Build agent','No action','Read agent']);
  assert.deepEqual(ids(dir,'--inbox'),['Build agent','Build monitor','Read agent']);
  assert.deepEqual(ids(dir,'--inbox','--source','agent','--search','Read agent'),['Read agent']);
  assert.deepEqual(ids(dir),['Build agent','Build monitor','Read agent']);
  const conflict=run(dir,'--inbox','--unread');
  assert.notEqual(conflict.status,0);
  assert.match(conflict.stderr,/--inbox cannot be combined/);
  assert.match(run(dir,'--inbox','--all').stderr,/--inbox cannot be combined/);
});
