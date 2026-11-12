import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { post, list } from '../mods/trough/core/store.js';
import { review, runReviewed, actionStatus, listActions } from '../mods/trough/core/actions.js';
import { listPacks, checkPacks, addPack, removePack } from '../mods/trough/core/packages.js';

const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const readingList=path.join(project,'packages','reading-list','index.js');
const cli=path.join(project,'mods','trough','bin','trough');
// macOS temporary folders are reached through a symlink; packs are stored by real path.
const root=async()=>fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'trough-packages-')));
const readConfig=async dir=>JSON.parse(await fs.readFile(path.join(dir,'handlers.json'),'utf8'));
const story=()=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:'example',label:'Example'},kind:'report',title:'Result',summary:'Ready',occurred_at:'2026-11-11T18:00:00Z',severity:'info',
  links:[{id:'result',label:'Result',url:'https://example.com/result'}],actions:[{id:'save',label:'Add to reading list',handler:'add_to_reading_list',args:{link:'result',note:'Read this'}}]});
async function fakeRl(dir) {
  const tools=path.join(dir,'tools'),log=path.join(dir,'rl.log');
  await fs.mkdir(tools);
  await fs.writeFile(path.join(tools,'rl'),`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`,{mode:0o755});
  return {rl:path.join(tools,'rl'),log};
}

test('reading-list actions need the pack, are disabled with a reason without rl, and run rl with separate argv',async()=>{
  const dir=await root(),s=story();
  await post(dir,Buffer.from(JSON.stringify(s)+'\n'));
  assert.equal((await actionStatus(dir,await list(dir)))[0].action_status.save.reason,'handler add_to_reading_list is not installed');
  const missing=path.join(dir,'tools','rl');
  await addPack(dir,readingList,{rl:missing});
  assert.deepEqual((await actionStatus(dir,await list(dir)))[0].action_status.save,{available:false,reason:`${missing} is missing or not executable`});
  await assert.rejects(review(dir,s.id,'save'),/is unavailable: .*missing or not executable/);
  const listed=(await listActions(dir)).find(a=>a.id==='add_to_reading_list');
  assert.deepEqual([listed.origin,listed.pack,listed.available],['pack','reading-list',false]);
  const {rl,log}=await fakeRl(dir);
  assert.deepEqual((await actionStatus(dir,await list(dir)))[0].action_status.save,{available:true});
  const sheet=await review(dir,s.id,'save');
  assert.deepEqual([sheet.plan.command,...sheet.plan.argv],[rl,'add','https://example.com/result','--from','Trough','--if-new','--note','Read this']);
  assert.equal((await runReviewed(dir,sheet.token)).outcome,'succeeded');
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),sheet.plan.argv);
});

test('reading-list pack finds rl on PATH when no path is configured',async()=>{
  const dir=await root(),{rl}=await fakeRl(dir),old=process.env.PATH;
  await addPack(dir,path.dirname(readingList));
  try {
    process.env.PATH='';
    assert.equal((await listActions(dir)).find(a=>a.id==='add_to_reading_list').reason,'rl is not on PATH');
    process.env.PATH=path.dirname(rl);
    assert.equal((await listActions(dir)).find(a=>a.id==='add_to_reading_list').available,true);
  } finally { process.env.PATH=old; }
});

test('packages add and remove edit only the pack list and keep every other field',async()=>{
  const dir=await root(),pack=path.join(dir,'notes','index.js'),other=path.join(dir,'pulse.mjs');
  await fs.mkdir(path.dirname(pack));
  await fs.writeFile(pack,`export function handlers(options) { if(!options.target) throw new Error('notes pack needs options.target');
  return {record_note:{args:{},effects:['Record a note'],plan:()=>({effects:['Record a note in '+options.target]}),run:()=>'ok'}}; }`);
  await fs.writeFile(other,"export const name='pulse'; export function producer() { return {name:'Pulse',interval_seconds:60,run() {}}; }");
  const kept={v:1,handlers:{noop:{kind:'command',executable:'/usr/bin/true',argv:[],args:{},effects:['Run noop']}},answer_routes:{},operator_note:'kept as written'};
  await fs.writeFile(path.join(dir,'handlers.json'),JSON.stringify(kept));
  await assert.rejects(addPack(dir,pack),/did not load, so nothing was changed: notes pack needs options.target \(pass its options with --options-file FILE\)/);
  assert.deepEqual(await readConfig(dir),kept);
  assert.deepEqual(await addPack(dir,path.dirname(pack),{target:'journal'}),{added:'notes',path:pack,handlers:['record_note'],producer:false});
  assert.deepEqual(await addPack(dir,other),{added:'pulse',path:other,handlers:[],producer:true});
  assert.deepEqual(await readConfig(dir),{...kept,packages:[{path:pack,options:{target:'journal'}},other]});
  await assert.rejects(addPack(dir,other),/already listed/);
  assert.equal((await addPack(dir,pack,{target:'ledger'})).updated,'notes');
  assert.deepEqual((await readConfig(dir)).packages[0].options,{target:'ledger'});
  const packs=await listPacks(dir);
  assert.deepEqual(packs.map(p=>[p.name,p.ok,p.handlers.map(h=>h.id),p.producer?.name??null]),[['notes',true,['record_note'],null],['pulse',true,[],'Pulse']]);
  assert.equal(packs[1].producer.interval_seconds,60);
  assert.equal(packs[1].producer.last_run,null);
  await assert.rejects(removePack(dir,'absent'),/no listed pack matches absent/);
  assert.deepEqual(await removePack(dir,'notes'),{removed:'notes',path:pack});
  assert.deepEqual(await removePack(dir,other),{removed:'pulse',path:other});
  assert.deepEqual(await readConfig(dir),{...kept,packages:[]});
  assert.deepEqual((await fs.readdir(dir)).filter(n=>n.includes('.tmp')),[]);
  assert.equal((await fs.stat(path.join(dir,'handlers.json'))).mode&0o077,0);
});

test('packages add refuses a missing path and an unreadable configuration without writing',async()=>{
  const dir=await root();
  await assert.rejects(addPack(dir,path.join(dir,'nowhere')),/pack not found/);
  await assert.rejects(fs.access(path.join(dir,'handlers.json')));
  await fs.writeFile(path.join(dir,'handlers.json'),'{"v":1,');
  await assert.rejects(addPack(dir,readingList),/cannot edit handlers.json until it is valid JSON/);
  assert.equal(await fs.readFile(path.join(dir,'handlers.json'),'utf8'),'{"v":1,');
});

test('packages check reports a pack that cannot load, an overridden handler, and a failing producer',async()=>{
  const dir=await root(),first=path.join(dir,'first.mjs'),second=path.join(dir,'second.mjs'),producer=path.join(dir,'producer.mjs');
  const handler="{args:{},effects:['Do it'],plan:()=>({effects:['Do it']}),run:()=>'ok'}";
  await fs.writeFile(first,`export function handlers() { return {shared:${handler},only_first:{effects:['Incomplete']}}; }`);
  await fs.writeFile(second,`export function handlers() { return {shared:${handler}}; }`);
  await fs.writeFile(producer,"export function producer() { throw new Error('source is not configured'); }");
  await fs.writeFile(path.join(dir,'handlers.json'),JSON.stringify({v:1,packages:[first,second,producer,path.join(dir,'gone.mjs')]}));
  const result=await checkPacks(dir),[a,b,c,d]=result.packs;
  assert.equal(result.ok,false);
  assert.deepEqual(a.handlers,[{id:'only_first',available:false,reason:'invalid integration handler'},{id:'shared',available:false,reason:'overridden by pack second'}]);
  assert.deepEqual(a.problems,['handler only_first: invalid integration handler']);
  assert.deepEqual([b.ok,b.handlers],[true,[{id:'shared',available:true}]]);
  assert.deepEqual([c.ok,c.problems,c.producer],[false,['producer: source is not configured'],null]);
  assert.equal(d.ok,false);
  assert.match(d.problems[0],/Cannot find module/);
  const run=spawnSync(process.execPath,[cli,'--dir',dir,'packages','check'],{encoding:'utf8'});
  assert.equal(run.status,1);
  assert.match(run.stdout,/^first\terror\t/m);
  assert.match(run.stdout,/check failed\n$/);
});

test('CLI manages packs and lists installed actions',async()=>{
  const dir=await root(),{rl}=await fakeRl(dir),options=path.join(dir,'options.json');
  await fs.writeFile(options,JSON.stringify({rl}));
  const invoke=(...args)=>spawnSync(process.execPath,[cli,'--dir',dir,...args],{encoding:'utf8'});
  assert.equal(invoke('packages').stdout,'No packs are listed in handlers.json.\n');
  const added=invoke('packages','add',path.relative(process.cwd(),readingList),'--options-file',options);
  assert.equal(added.status,0,added.stderr);
  assert.deepEqual(JSON.parse(added.stdout),{added:'reading-list',path:readingList,handlers:['add_to_reading_list'],producer:false});
  assert.equal(invoke('packages','list').stdout,`reading-list\tok\t${readingList}\n  handlers: add_to_reading_list\n  producer: none\n`);
  assert.equal(invoke('packages','check').status,0);
  assert.deepEqual(JSON.parse(invoke('packages','check','--json').stdout).ok,true);
  const actions=JSON.parse(invoke('actions','--json').stdout);
  assert.deepEqual(actions.map(a=>a.id),['add_to_reading_list','answer_decision','open_file','open_path','open_url']);
  assert.match(invoke('actions').stdout,/^add_to_reading_list\tpack reading-list\tavailable\tlink:string note\?:string$/m);
  assert.equal(invoke('packages','remove','reading-list').status,0);
  assert.deepEqual((await readConfig(dir)).packages,[]);
  assert.equal(invoke('packages','remove','reading-list').status,1);
});
