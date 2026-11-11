import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { post, ingest, list, stored } from '../mods/trough/core/store.js';
import { prune } from '../mods/trough/core/prune.js';

const NOW=Date.parse('2026-11-11T18:00:00Z');
const day=86400000;
const root=()=>fs.mkdtemp(path.join(os.tmpdir(),'trough-prune-'));
const story=(extra={})=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:'test',label:'Test'},kind:'report',title:'A result',summary:'Ready.',occurred_at:new Date(NOW-10*day).toISOString(),severity:'info',...extra});
const write=(file,value)=>fs.writeFile(file,JSON.stringify(value)+'\n');
async function add(dir,record,state) {
  await post(dir,Buffer.from(JSON.stringify(record)+'\n'));
  await write(path.join(dir,'state',`${record.id}.json`),{v:1,...state});
  return record.id;
}
const at=days=>new Date(NOW-days*day).toISOString();

test('age starts at the later read or done time and config can override the default',async()=>{
  const dir=await root();
  const old=await add(dir,story(),{read_at:at(5),done_at:at(4)});
  const newlyDone=await add(dir,story(),{read_at:at(5),done_at:at(2)});
  const boundary=await add(dir,story(),{read_at:at(3)});
  const result=await prune(dir,{now:NOW,dryRun:true});
  assert.deepEqual(result.ids.sort(),[old,boundary].sort());
  assert.equal((await prune(dir,{now:NOW})).count,2);
  assert.deepEqual((await list(dir)).map(row=>row.story.id),[newlyDone]);
  await write(path.join(dir,'trough.json'),{v:1,retention:{older_than:'1d'}});
  assert.deepEqual((await prune(dir,{now:NOW,dryRun:true})).ids,[newlyDone]);
  assert.rejects(prune(dir,{olderThan:'0d',now:NOW}),/older-than/);
});

test('unread, actionable, pending, uncertain and snoozed stories are retained',async()=>{
  const dir=await root(),old={read_at:at(6),done_at:at(5)};
  const unread=await add(dir,story(),{done_at:at(5)});
  const action=story({actions:[{id:'open',label:'Open',handler:'open_url',args:{link:'report'}}],links:[{id:'report',label:'Report',url:'https://example.com'}]});
  const actionable=await add(dir,action,{read_at:at(6)});
  const decision=await add(dir,story({kind:'decision',decision:{question_id:'choice',prompt:'Choose',options:[{id:'yes',label:'Yes',answer_text:'yes'},{id:'no',label:'No',answer_text:'no'}]}}),old);
  const pending=await add(dir,story({outcome:'pending'}),old);
  const snoozed=await add(dir,story(),{...old,snoozed_until:at(-1)});
  const receipt=await add(dir,story(),old);
  await write(path.join(dir,'receipts','pending.json'),{story_id:receipt,outcome:'pending'});
  const uncertain=await add(dir,story(),old);
  await write(path.join(dir,'receipts','uncertain.json'),{story_id:uncertain,outcome:'uncertain'});
  const delivery=await add(dir,story(),old);
  const deliveryDir=path.join(dir,'integrations','firstmate','home','deliveries');
  await fs.mkdir(deliveryDir,{recursive:true});
  await write(path.join(deliveryDir,'delivery.json'),{story_id:delivery,status:'queued'});
  const answer=await add(dir,story(),old);
  const answerDir=path.join(dir,'answers','test');
  await fs.mkdir(answerDir,{recursive:true});
  await write(path.join(answerDir,'answer.json'),{story_id:answer});
  assert.deepEqual((await prune(dir,{now:NOW,dryRun:true})).ids,[]);
  assert.equal((await list(dir)).length,9);
  assert.ok([unread,actionable,decision,pending,snoozed,receipt,uncertain,delivery,answer].every(Boolean));
});

test('dry run preserves files; pruning removes sidecars and tombstones block re-posting',async()=>{
  const dir=await root(),record=story(),id=await add(dir,record,{read_at:at(6),done_at:at(5)});
  await fs.mkdir(path.join(dir,'reviews'));
  await write(path.join(dir,'reviews','review.json'),{reviewed:{story_id:id}});
  await write(path.join(dir,'receipts','receipt.json'),{story_id:id,outcome:'succeeded'});
  const cli=path.resolve('mods/trough/bin/trough');
  const run=(...args)=>spawnSync(process.execPath,[cli,'--dir',dir,...args],{encoding:'utf8'});
  const preview=run('prune','--older-than','3d','--dry-run');
  assert.equal(preview.status,0,preview.stderr);
  assert.deepEqual(JSON.parse(preview.stdout).ids,[id]);
  assert.equal((await stored(dir,id)).story.id,id);
  assert.deepEqual(await fs.readdir(path.join(dir,'tombstones')),[]);
  const result=await prune(dir,{now:NOW});
  assert.deepEqual(result.ids,[id]);
  for(const file of [path.join(dir,'store',`${id}.json`),path.join(dir,'state',`${id}.json`),path.join(dir,'reviews','review.json'),path.join(dir,'receipts','receipt.json')])
    await assert.rejects(fs.access(file),{code:'ENOENT'});
  await post(dir,Buffer.from(JSON.stringify(record)+'\n'));
  assert.equal((await list(dir)).length,0);
  await write(path.join(dir,'inbox',`${id}.json`),record);
  assert.equal((await ingest(dir))[0].status,'pruned');
  assert.equal((await list(dir)).length,0);
  assert.ok((await fs.readdir(path.join(dir,'tombstones'))).includes(`${id}.json`));
  await prune(dir,{now:NOW+366*day});
  assert.deepEqual(await fs.readdir(path.join(dir,'tombstones')),[]);
});

test('delete removes a story immediately, including an open decision, and blocks re-posting',async()=>{
  const dir=await root(),record=story({kind:'decision',decision:{question_id:'choice',prompt:'Choose',options:[{id:'yes',label:'Yes',answer_text:'yes'},{id:'no',label:'No',answer_text:'no'}]}});
  const id=await add(dir,record,{});
  await fs.mkdir(path.join(dir,'reviews'));
  await write(path.join(dir,'reviews','review.json'),{reviewed:{story_id:id}});
  await write(path.join(dir,'receipts','receipt.json'),{story_id:id,outcome:'succeeded'});
  const cli=path.resolve('mods/trough/bin/trough');
  const run=(...args)=>spawnSync(process.execPath,[cli,'--dir',dir,...args],{encoding:'utf8'});
  const deleted=run('delete',id);
  assert.equal(deleted.status,0,deleted.stderr);
  assert.deepEqual(JSON.parse(deleted.stdout),{id,deleted:true});
  for(const file of [path.join(dir,'store',`${id}.json`),path.join(dir,'state',`${id}.json`),path.join(dir,'reviews','review.json'),path.join(dir,'receipts','receipt.json')])
    await assert.rejects(fs.access(file),{code:'ENOENT'});
  assert.deepEqual((await list(dir)).map(row=>row.story.id),[]);
  await post(dir,Buffer.from(JSON.stringify(record)+'\n'));
  assert.deepEqual((await list(dir)).map(row=>row.story.id),[]);
  assert.ok((await fs.readdir(path.join(dir,'tombstones'))).includes(`${id}.json`));
});

test('delete refuses effects still in flight without removing the story or sidecars',async()=>{
  const dir=await root(),cli=path.resolve('mods/trough/bin/trough');
  const run=(id)=>spawnSync(process.execPath,[cli,'--dir',dir,'delete',id],{encoding:'utf8'});
  const pending=await add(dir,story(),{});
  await write(path.join(dir,'receipts','pending.json'),{story_id:pending,outcome:'pending'});
  const uncertain=await add(dir,story(),{});
  await write(path.join(dir,'receipts','uncertain.json'),{story_id:uncertain,outcome:'uncertain'});
  const answer=await add(dir,story(),{});
  const answerDir=path.join(dir,'answers','test'); await fs.mkdir(answerDir,{recursive:true});
  await write(path.join(answerDir,'answer.json'),{story_id:answer});
  const delivery=await add(dir,story(),{});
  const deliveryDir=path.join(dir,'integrations','firstmate','home','deliveries'); await fs.mkdir(deliveryDir,{recursive:true});
  await write(path.join(deliveryDir,'delivery.json'),{story_id:delivery,status:'queued'});
  for(const [id,message] of [[pending,/pending or uncertain receipt/],[uncertain,/pending or uncertain receipt/],[answer,/answer has not been delivered/],[delivery,/delivery is pending/]]) {
    const result=run(id);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,message);
    assert.equal((await stored(dir,id)).story.id,id);
    await assert.rejects(fs.access(path.join(dir,'tombstones',`${id}.json`)),{code:'ENOENT'});
  }
  assert.equal((await fs.readdir(path.join(dir,'receipts'))).length,2);
});
