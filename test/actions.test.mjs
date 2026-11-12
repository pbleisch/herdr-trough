import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { post, stored } from '../mods/trough/core/store.js';
import { review, runReviewed, receipts } from '../mods/trough/core/actions.js';

const root=()=>fs.mkdtemp(path.join(os.tmpdir(),'trough-actions-'));
const base=(id=crypto.randomBytes(16).toString('hex'))=>({v:1,id,source:{id:'example',label:'Example'},kind:'report',title:'Result',summary:'Ready',occurred_at:'2026-11-11T18:00:00Z',severity:'notice'});
const add=(dir,s)=>post(dir,Buffer.from(JSON.stringify(s)+'\n'));
const config=(dir,x)=>fs.writeFile(path.join(dir,'handlers.json'),JSON.stringify({v:1,...x}));

test('command handler requires review, uses typed argv without interpolation, and runs once',async()=>{
  const dir=await root(),out=path.join(dir,'argv.json'),script=path.join(dir,'capture.mjs');
  await fs.writeFile(script,`import fs from 'node:fs'; fs.appendFileSync(process.argv[2],JSON.stringify(process.argv.slice(3))+'\\n');`);
  const s={...base(),actions:[{id:'capture',label:'Capture',handler:'capture',args:{message:'$(touch /tmp/never-executed)'}}]};
  await add(dir,s);
  await config(dir,{handlers:{capture:{kind:'command',executable:process.execPath,argv:[{literal:script},{literal:out},{arg:'message'}],args:{message:{type:'string',required:true,max_length:100}},effects:['Write the approved message to a test file']}}});
  const sheet=await review(dir,s.id,'capture');
  assert.equal(sheet.plan.argv.at(-1),s.actions[0].args.message);
  await assert.rejects(fs.access(out));
  assert.equal((await runReviewed(dir,sheet.token)).outcome,'succeeded');
  assert.deepEqual(JSON.parse((await fs.readFile(out,'utf8')).trim()),[s.actions[0].args.message]);
  assert.equal((await runReviewed(dir,sheet.token)).outcome,'succeeded');
  assert.equal((await fs.readFile(out,'utf8')).trim().split('\n').length,1);
  assert.equal((await receipts(dir,s.id)).length,1);
});

test('changed registry invalidates a reviewed action',async()=>{
  const dir=await root(),s={...base(),actions:[{id:'a',label:'A',handler:'test'}]}; await add(dir,s);
  await config(dir,{handlers:{test:{kind:'command',executable:'/usr/bin/true',argv:[],args:{},effects:['Do a thing']}}});
  const sheet=await review(dir,s.id,'a');
  await config(dir,{handlers:{test:{kind:'command',executable:'/usr/bin/false',argv:[],args:{},effects:['Do a different thing']}}});
  await assert.rejects(runReviewed(dir,sheet.token),/story or handler changed/);
  assert.equal((await receipts(dir,s.id)).length,0);
});

test('built-in path reveal is explicit and a decision needs a story-hash route',async()=>{
  const dir=await root();
  const p={...base(),links:[{id:'artifact',label:'Artifact',path:'/tmp/artifact.txt'}],actions:[{id:'reveal',label:'Reveal',handler:'open_path',args:{link:'artifact'}}]};
  await add(dir,p);
  const sheet=await review(dir,p.id,'reveal');
  assert.deepEqual([sheet.plan.command,...sheet.plan.argv],['/usr/bin/open','-R','/tmp/artifact.txt']);
  const d={...base(),kind:'decision',decision:{question_id:'q',prompt:'Proceed?',options:[{id:'yes',label:'Yes',answer_text:'Proceed'},{id:'no',label:'No',answer_text:'Stop'}]},actions:[{id:'answer',label:'Answer',handler:'answer_decision'}]};
  await add(dir,d);
  await assert.rejects(review(dir,d.id,'answer',{option:'yes'}),/trusted answer route/);
  await config(dir,{answer_routes:{[d.id]:{source_id:'example',story_hash:(await stored(dir,d.id)).hash}}});
  const reviewed=await review(dir,d.id,'answer',{option:'yes'});
  assert.equal((await runReviewed(dir,reviewed.token)).outcome,'succeeded');
  const answer=JSON.parse(await fs.readFile(path.join(dir,'answers','example',`${reviewed.token}.json`),'utf8'));
  assert.equal(answer.answer_text,'Proceed');
  await fs.rename(path.join(dir,'answers','example',`${reviewed.token}.json`),path.join(dir,'answers','example','handled',`${reviewed.token}.json`));
  const second=await review(dir,d.id,'answer',{option:'no'});
  assert.equal((await runReviewed(dir,second.token)).outcome,'failed');
});

test('local open plans open documents and folders but reveal runnable paths',async()=>{
  const dir=await root(),folder=path.join(dir,'folder'),document=path.join(dir,'report.pdf');
  await fs.mkdir(folder);
  await fs.writeFile(document,'report');
  const script=path.join(dir,'build.sh'),executable=path.join(dir,'binary'),app=path.join(dir,'Example.app');
  await fs.writeFile(script,'echo hi');
  await fs.writeFile(executable,'binary',{mode:0o755});
  await fs.mkdir(app);
  const s={...base(),summary:`Read ${document} or ${script}.`,links:[{id:'folder',label:'Folder',path:folder},{id:'binary',label:'Binary',path:executable},{id:'app',label:'App',path:app}],actions:[{id:'open',label:'Open folder',handler:'open_file',args:{link:'folder'}}]};
  await add(dir,s);
  for(const [target,argv] of [[document,[document]],[folder,[folder]],[script,['-R',script]],[executable,['-R',executable]],[app,['-R',app]]]) {
    const sheet=await review(dir,s.id,'__open_local_path',{path:target});
    assert.deepEqual(sheet.plan.argv,argv,target);
  }
  assert.deepEqual((await review(dir,s.id,'open')).plan.argv,[folder]);
  await assert.rejects(review(dir,s.id,'__open_local_path',{path:path.join(dir,'other')}),/not present in this story/);
  await fs.unlink(document);
  await assert.rejects(review(dir,s.id,'__open_local_path',{path:document}),/Path does not exist/);
});

test('local open expands home paths and checks symlink targets',async()=>{
  const dir=await root(),homeFile=path.join(os.homedir(),`.trough-open-${crypto.randomBytes(8).toString('hex')}.txt`);
  const script=path.join(dir,'script.sh'),alias=path.join(dir,'alias.txt');
  try {
    await fs.writeFile(homeFile,'note');
    await fs.writeFile(script,'echo hi');
    await fs.symlink(script,alias);
    const shorthand=`~/${path.basename(homeFile)}`;
    const s={...base(),kind:'decision',summary:`Open ${shorthand}`,decision:{question_id:'q',prompt:`Review ${alias}?`,options:[]}}; await add(dir,s);
    assert.deepEqual((await review(dir,s.id,'__open_local_path',{path:shorthand})).plan.argv,[homeFile]);
    assert.deepEqual((await review(dir,s.id,'__open_local_path',{path:alias})).plan.argv,['-R',alias]);
  } finally {await fs.unlink(homeFile);}
});

test('CLI review and run are separate operations with a receipt',async()=>{
  const dir=await root(),s={...base(),actions:[{id:'a',label:'A',handler:'noop'}]}; await add(dir,s);
  await config(dir,{handlers:{noop:{kind:'command',executable:'/usr/bin/true',argv:[],args:{},effects:['Run the local noop']}}});
  const cli=path.resolve('mods/trough/bin/trough');
  const invoke=(...args)=>spawnSync(process.execPath,[cli,'--dir',dir,...args],{encoding:'utf8'});
  const first=invoke('review',s.id,'a'); assert.equal(first.status,0);
  assert.equal((await receipts(dir,s.id)).length,0);
  const second=invoke('run',JSON.parse(first.stdout).token); assert.equal(second.status,0);
  assert.equal(JSON.parse(second.stdout).outcome,'succeeded');
  assert.equal((await receipts(dir,s.id)).length,1);
});

test('reading-list handoff is unavailable without rl and plans separate argv when installed',async()=>{
  const dir=await root(),s={...base(),links:[{id:'result',label:'Result',url:'https://example.com/result'}],actions:[{id:'save',label:'Save',handler:'add_to_reading_list',args:{link:'result',note:'Read this'}}]};
  await add(dir,s);
  const old=process.env.PATH;
  try {
    process.env.PATH='';
    await assert.rejects(review(dir,s.id,'save'),/rl is unavailable/);
    const tools=path.join(dir,'tools'); await fs.mkdir(tools);
    const fake=path.join(tools,'rl'); await fs.writeFile(fake,'#!/bin/sh\nexit 0\n',{mode:0o755});
    process.env.PATH=tools;
    const sheet=await review(dir,s.id,'save');
    assert.deepEqual(sheet.plan.argv,['add','https://example.com/result','--from','Trough','--if-new','--note','Read this']);
    assert.equal((await runReviewed(dir,sheet.token)).outcome,'succeeded');
  } finally {process.env.PATH=old;}
});
