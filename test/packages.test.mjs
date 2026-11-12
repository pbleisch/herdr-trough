import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { post, list } from '../mods/trough/core/store.js';
import { review, runReviewed, annotate, listActions } from '../mods/trough/core/actions.js';
import { listPacks, checkPacks, addPack, removePack } from '../mods/trough/core/packages.js';
import { rules as readingListRules } from '../packages/reading-list/index.js';

// Keep the person's own open handler (under the Herdr home) out of these tests.
process.env.HERDR_APP_HOME=await fs.mkdtemp(path.join(os.tmpdir(),'trough-home-'));
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
  assert.equal((await annotate(dir,await list(dir)))[0].action_status.save.reason,'handler add_to_reading_list is not installed');
  const missing=path.join(dir,'tools','rl');
  await addPack(dir,readingList,{rl:missing});
  assert.deepEqual((await annotate(dir,await list(dir)))[0].action_status.save,{available:false,reason:`${missing} is missing or not executable`});
  await assert.rejects(review(dir,s.id,'save'),/is unavailable: .*missing or not executable/);
  const listed=(await listActions(dir)).handlers.find(a=>a.id==='add_to_reading_list');
  assert.deepEqual([listed.origin,listed.pack,listed.available],['pack','reading-list',false]);
  const {rl,log}=await fakeRl(dir);
  assert.deepEqual((await annotate(dir,await list(dir)))[0].action_status.save,{available:true});
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
    assert.equal((await listActions(dir)).handlers.find(a=>a.id==='add_to_reading_list').reason,'rl is not on PATH');
    process.env.PATH=path.dirname(rl);
    assert.equal((await listActions(dir)).handlers.find(a=>a.id==='add_to_reading_list').available,true);
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
  const [core,...packs]=await listPacks(dir);
  assert.deepEqual([core.name,core.built_in,core.ok,core.handlers.map(h=>h.id),core.user_handler.state],['core',true,true,['open_file','open_path','open_url'],'off']);
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
  const result=await checkPacks(dir),[a,b,c,d]=result.packs.slice(1);
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
  assert.match(invoke('packages').stdout,/^core\tok\t\(built in\)\n  handlers: open_file, open_path, open_url\n  your handler: off\n  augments: URL link: Open/);
  const added=invoke('packages','add',path.relative(process.cwd(),readingList),'--options-file',options);
  assert.equal(added.status,0,added.stderr);
  assert.deepEqual(JSON.parse(added.stdout),{added:'reading-list',path:readingList,handlers:['add_to_reading_list'],producer:false});
  assert.ok(invoke('packages','list').stdout.endsWith(`reading-list\tok\t${readingList}\n  handlers: add_to_reading_list\n  augments: ${readingListRules[0]}\n  producer: none\n`));
  assert.equal(invoke('packages','check').status,0);
  assert.deepEqual(JSON.parse(invoke('packages','check','--json').stdout).ok,true);
  const actions=JSON.parse(invoke('actions','--json').stdout);
  assert.deepEqual(actions.augmenters.map(a=>a.pack),['core','reading-list']);
  assert.match(invoke('actions').stdout,/^augment\tpack reading-list\tLink with role report or document/m);
  assert.deepEqual(actions.handlers.map(a=>a.id),['add_to_reading_list','answer_decision','open_file','open_path','open_url']);
  assert.match(invoke('actions').stdout,/^add_to_reading_list\tpack reading-list\tavailable\tlink:string note\?:string$/m);
  assert.equal(invoke('packages','remove','reading-list').status,0);
  assert.deepEqual((await readConfig(dir)).packages,[]);
  assert.equal(invoke('packages','remove','reading-list').status,1);
  // The core pack is built in: removing it is recorded, and adding it back clears the record.
  assert.deepEqual(JSON.parse(invoke('packages','remove','core').stdout),{removed:'core'});
  assert.equal((await readConfig(dir)).core,false);
  assert.deepEqual(JSON.parse(invoke('actions','--json').stdout).handlers.map(a=>a.id),['answer_decision']);
  assert.deepEqual(JSON.parse(invoke('packages','add','core').stdout),{added:'core'});
  assert.equal(Object.hasOwn(await readConfig(dir),'core'),false);
});

test('the reading-list pack offers its action on report, document and readable links only',async()=>{
  const dir=await root(),{rl}=await fakeRl(dir);
  await fs.writeFile(path.join(dir,'handlers.json'),JSON.stringify({v:1,core:false}));
  await addPack(dir,readingList,{rl});
  const s={...story(),actions:undefined,links:[
    {id:'report',label:'Report',path:'/srv/reports/weekly.md',role:'report'},
    {id:'pdf',label:'Paper',url:'https://example.com/paper.pdf',media_type:'application/pdf'},
    {id:'pr',label:'Pull request',url:'https://example.com/pull/1',role:'pr'},
    {id:'shot',label:'Screenshot',path:'/srv/shots/a.png',role:'screenshot',media_type:'image/png'}]};
  delete s.actions;
  await post(dir,Buffer.from(JSON.stringify(s)+'\n'));
  const [row]=await annotate(dir,await list(dir));
  assert.deepEqual(row.offers.map(o=>[o.id,o.label,o.link,o.available]),[['reading-list.add.report','Add to reading list','report',true],['reading-list.add.pdf','Add to reading list','pdf',true]]);
  const sheet=await review(dir,s.id,'reading-list.add.report');
  assert.deepEqual([sheet.offered_by,...sheet.plan.argv],['reading-list','add','/srv/reports/weekly.md','--from','Trough','--if-new']);
  assert.equal((await runReviewed(dir,sheet.token)).outcome,'succeeded');
  // A story that already declares the action for a link is not offered it twice.
  const declared={...story(),links:[{id:'result',label:'Result',url:'https://example.com/result',role:'report'}]};
  await post(dir,Buffer.from(JSON.stringify(declared)+'\n'));
  assert.deepEqual((await annotate(dir,await list(dir))).find(r=>r.story.id===declared.id).offers,[]);
  await addPack(dir,readingList,{rl,roles:['screenshot']});
  assert.deepEqual((await annotate(dir,await list(dir))).find(r=>r.story.id===s.id).offers.map(o=>o.link),['pdf','shot']);
});

test('the documented example pack loads, offers its action and runs it',async()=>{
  const dir=await root(),notes=path.join(dir,'notes.txt');
  await assert.rejects(addPack(dir,path.join(project,'docs','example-pack')),/notes pack needs an absolute options.file/);
  await addPack(dir,path.join(project,'docs','example-pack'),{file:notes});
  const s={...story(),title:'Nightly build',links:[{id:'log',label:'Log',url:'https://example.com/log',role:'log'},{id:'pr',label:'Change',url:'https://example.com/pr',role:'pr'}]};
  delete s.actions;
  await post(dir,Buffer.from(JSON.stringify(s)+'\n'));
  const [row]=await annotate(dir,await list(dir));
  assert.deepEqual(row.offers.filter(o=>o.pack==='notes').map(o=>[o.id,o.link]),[['notes.save.log','log']]);
  assert.deepEqual(row.badges,[{pack:'notes',label:'has log'}]);
  const sheet=await review(dir,s.id,'notes.save.log');
  assert.deepEqual(sheet.plan.effects,[`Append to ${notes}: Nightly build: https://example.com/log`]);
  assert.equal((await runReviewed(dir,sheet.token)).outcome,'succeeded');
  assert.equal(await fs.readFile(notes,'utf8'),'Nightly build: https://example.com/log\n');
});
