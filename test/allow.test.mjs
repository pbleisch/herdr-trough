import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { post, stored } from '../mods/trough/core/store.js';
import { review, act, runReviewed, receipts, listAllowed, revokeAllowed } from '../mods/trough/core/actions.js';
import { turnOn, turnOff, userLocation } from '../mods/trough/core/open-handlers.js';

const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const cli=path.join(project,'mods','trough','bin','trough');
// Keep the person's own open handler (under the Herdr home) out of these tests.
const emptyHome=await fs.mkdtemp(path.join(os.tmpdir(),'trough-home-'));
process.env.HERDR_APP_HOME=emptyHome;

const root=async()=>fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'trough-allow-')));
const base=(extra={})=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:'example',label:'Example'},kind:'report',title:'Result',summary:'Ready',occurred_at:'2026-11-11T18:00:00Z',severity:'notice',...extra});
const add=async(dir,s)=>{ await post(dir,Buffer.from(JSON.stringify(s)+'\n')); return s; };
const config=(dir,x)=>fs.writeFile(path.join(dir,'handlers.json'),JSON.stringify({v:1,...x}));
const allowFile=dir=>fs.readFile(path.join(dir,'allow.json'),'utf8').then(JSON.parse);
const invoke=(dir,...args)=>spawnSync(process.execPath,[cli,'--dir',dir,...args],{encoding:'utf8'});

// A pack that offers two actions on every story: `note_it` accepts a standing approval and appends
// a line to a log; `send_prompt` stands in for an action that messages an agent and does not.
async function notesPack(dir,{effect='Append a note'}={}) {
  const file=path.join(dir,'notes.mjs'),log=path.join(dir,'notes.log');
  const run=`async({reviewed})=>{ const fs=await import('node:fs/promises'); await fs.appendFile(${JSON.stringify(log)},reviewed.story_id+'\\n'); return 'noted'; }`;
  await fs.writeFile(file,`export const name='notes';
export function handlers(options) { return {
  note_it:{args:{},effects:[${JSON.stringify(effect)}],always_allow:true,fingerprint:()=>({tool:options.tool??null}),plan:({story})=>({effects:['Append '+story.id]}),run:${run}},
  send_prompt:{args:{},effects:['Queue a prompt for an agent'],plan:()=>({effects:['Queue a prompt']}),run:${run}}
}; }
export function augment() { return {actions:[{id:'note',label:'Note it',handler:'note_it'},{id:'prompt',label:'Send prompt',handler:'send_prompt'}]}; }`);
  return {file,log,lines:async()=>(await fs.readFile(log,'utf8').catch(()=>'')).split('\n').filter(Boolean)};
}

test('ticking always allow records a standing approval, and later clicks skip the sheet but still write a receipt',async()=>{
  const dir=await root(),pack=await notesPack(dir);
  await config(dir,{core:false,packages:[pack.file]});
  const first=await add(dir,base()),second=await add(dir,base());
  // Not approved yet: a click only returns the sheet, which says the action may be always allowed.
  const clicked=await act(dir,first.id,'notes.note');
  assert.equal(clicked.receipt,undefined);
  assert.deepEqual(clicked.review.always_allow,{key:'notes/note_it',state:'new',effects:['Append a note']});
  assert.deepEqual(await pack.lines(),[]);
  await assert.rejects(allowFile(dir),{code:'ENOENT'});
  // A plain confirm runs once and approves nothing.
  assert.equal((await runReviewed(dir,clicked.review.token)).outcome,'succeeded');
  assert.equal((await act(dir,first.id,'notes.note')).review.always_allow.state,'new');
  // Confirming with "Always allow" records the approval for the pack's handler, not for the story.
  const sheet=await review(dir,first.id,'notes.note');
  const granted=await runReviewed(dir,sheet.token,{alwaysAllow:true});
  assert.deepEqual([granted.outcome,granted.approval],['succeeded',undefined]);
  const saved=await allowFile(dir);
  assert.deepEqual(Object.keys(saved.allowed),['notes/note_it']);
  assert.deepEqual([saved.allowed['notes/note_it'].pack,saved.allowed['notes/note_it'].handler,saved.allowed['notes/note_it'].label],['notes','note_it','Note it']);
  assert.deepEqual((await listAllowed(dir)).map(row=>[row.key,row.state]),[['notes/note_it','active']]);
  // The next click, on another story, runs at once and leaves a receipt that says why no sheet was shown.
  const ran=await act(dir,second.id,'notes.note');
  assert.equal(ran.review,undefined);
  assert.deepEqual([ran.receipt.outcome,ran.receipt.result,ran.receipt.approval,ran.receipt.allow_key,ran.receipt.story_id],['succeeded','noted','always-allow','notes/note_it',second.id]);
  assert.deepEqual(ran.receipt.effects,[`Append ${second.id}`]);
  assert.deepEqual(await pack.lines(),[first.id,first.id,second.id]);
  const stored=await receipts(dir,second.id);
  assert.deepEqual(stored.map(r=>[r.receipt_id,r.outcome,r.approval]),[[ran.receipt.receipt_id,'succeeded','always-allow']]);
  // The same holds through the CLI, which is what the pane calls.
  const cliRun=JSON.parse(invoke(dir,'act',second.id,'notes.note').stdout);
  assert.deepEqual([cliRun.receipt.outcome,cliRun.receipt.approval],['succeeded','always-allow']);
  assert.equal((await receipts(dir,second.id)).length,2);
  // The pack's other handler is not covered by the approval.
  assert.equal((await act(dir,second.id,'notes.prompt')).receipt,undefined);
});

test('a standing approval is listed and can be revoked, after which the sheet returns',async()=>{
  const dir=await root(),pack=await notesPack(dir);
  await config(dir,{core:false,packages:[pack.file]});
  const s=await add(dir,base());
  assert.match(invoke(dir,'allow').stdout,/^No action is always allowed/);
  const sheet=JSON.parse(invoke(dir,'review',s.id,'notes.note').stdout);
  assert.equal(JSON.parse(invoke(dir,'run',sheet.token,'--always-allow').stdout).outcome,'succeeded');
  assert.match(invoke(dir,'allow','list').stdout,/^notes\/note_it\tactive\tAppend a note\tsince /);
  assert.deepEqual(JSON.parse(invoke(dir,'allow','--json').stdout).map(row=>[row.key,row.pack,row.handler,row.state]),[['notes/note_it','notes','note_it','active']]);
  assert.ok((await act(dir,s.id,'notes.note')).receipt);
  const unknown=invoke(dir,'allow','revoke','notes/send_prompt');
  assert.deepEqual([unknown.status,unknown.stderr.trim()],[1,'trough: notes/send_prompt is not always allowed']);
  assert.deepEqual(JSON.parse(invoke(dir,'allow','revoke','notes/note_it').stdout),{revoked:['notes/note_it']});
  assert.deepEqual(await listAllowed(dir),[]);
  const before=(await pack.lines()).length,clicked=await act(dir,s.id,'notes.note');
  assert.deepEqual([clicked.receipt,clicked.review.always_allow.state],[undefined,'new']);
  assert.equal((await pack.lines()).length,before);
  // A run that was started on an approval is refused if the approval is gone by then.
  const again=await review(dir,s.id,'notes.note');
  await runReviewed(dir,again.token,{alwaysAllow:true});
  const pendingSheet=await review(dir,s.id,'notes.note');
  assert.deepEqual(await revokeAllowed(dir,'all'),{revoked:['notes/note_it']});
  await assert.rejects(runReviewed(dir,pendingSheet.token,{standing:true}),/not always allowed any more/);
  await assert.rejects(revokeAllowed(dir,'../handlers'),/revoke needs PACK\/HANDLER/);
});

test('decision answers, prompt deliveries and actions a story declares cannot be always allowed',async()=>{
  const dir=await root(),pack=await notesPack(dir);
  const decision=await add(dir,base({kind:'decision',decision:{question_id:'q',prompt:'Proceed?',options:[{id:'yes',label:'Yes',answer_text:'Proceed'},{id:'no',label:'No',answer_text:'Stop'}]},
    links:[{id:'artifact',label:'Artifact',path:'/tmp/artifact.txt'}],
    actions:[{id:'answer',label:'Answer',handler:'answer_decision'},{id:'reveal',label:'Reveal',handler:'open_path',args:{link:'artifact'}},{id:'prompt',label:'Steer',handler:'send_prompt'},{id:'note',label:'Note',handler:'note_it'}]}));
  await config(dir,{packages:[pack.file],answer_routes:{[decision.id]:{source_id:'example',story_hash:(await stored(dir,decision.id)).hash}}});
  const refuse=async(actionId,choice,why)=>{
    const clicked=await act(dir,decision.id,actionId,choice);
    assert.equal(clicked.receipt,undefined,actionId);
    assert.equal(clicked.review.always_allow,undefined,actionId);
    await assert.rejects(runReviewed(dir,clicked.review.token,{alwaysAllow:true}),why,actionId);
    // Nothing ran and nothing was approved.
    await assert.rejects(fs.access(path.join(dir,'receipts',`${clicked.review.token}.json`)),actionId);
    await assert.rejects(allowFile(dir),{code:'ENOENT'},actionId);
  };
  // A decision answer, and every action the story itself declares, even one that uses an eligible handler.
  await refuse('answer',{option:'yes'},/cannot be always allowed: the story declares this action/);
  await refuse('reveal',{},/cannot be always allowed: the story declares this action/);
  await refuse('prompt',{},/cannot be always allowed: the story declares this action/);
  await refuse('note',{},/cannot be always allowed: the story declares this action/);
  // A pack offer whose handler did not opt in, such as one that messages an agent.
  await refuse('notes.prompt',{},/cannot be always allowed: handler send_prompt of pack notes does not accept a standing approval/);
  assert.deepEqual(await pack.lines(),[]);
  // An approval of the eligible handler does not reach the story-declared action that names it.
  const offer=await review(dir,decision.id,'notes.note');
  await runReviewed(dir,offer.token,{alwaysAllow:true});
  assert.ok((await act(dir,decision.id,'notes.note')).receipt);
  assert.equal((await act(dir,decision.id,'note')).receipt,undefined);
  // An approval file that names a handler which does not accept one never lets it run.
  const forged=await allowFile(dir);
  forged.allowed['notes/send_prompt']={...forged.allowed['notes/note_it'],handler:'send_prompt'};
  await fs.writeFile(path.join(dir,'allow.json'),JSON.stringify(forged));
  assert.equal((await act(dir,decision.id,'notes.prompt')).receipt,undefined);
  assert.equal((await listAllowed(dir)).find(row=>row.key==='notes/send_prompt').state,'changed');
  const cliRefused=invoke(dir,'run',(await review(dir,decision.id,'answer',{option:'yes'})).token,'--always-allow');
  assert.equal(cliRefused.status,1);
  assert.match(cliRefused.stderr,/cannot be always allowed/);
});

test('a changed pack handler asks for confirmation once, then the approval holds again',async()=>{
  const dir=await root(),pack=await notesPack(dir);
  await config(dir,{core:false,packages:[{path:pack.file,options:{tool:'/usr/bin/one'}}]});
  const s=await add(dir,base());
  await runReviewed(dir,(await review(dir,s.id,'notes.note')).token,{alwaysAllow:true});
  assert.ok((await act(dir,s.id,'notes.note')).receipt);
  // What the handler reports about itself changed (here through its options).
  await config(dir,{core:false,packages:[{path:pack.file,options:{tool:'/usr/bin/two'}}]});
  let clicked=await act(dir,s.id,'notes.note');
  assert.deepEqual([clicked.receipt,clicked.review.always_allow.state],[undefined,'changed']);
  assert.deepEqual((await listAllowed(dir)).map(row=>[row.state,row.reason]),[['changed','the handler changed since you allowed it; the next run asks you to confirm']]);
  // Confirming without the box runs once and leaves the approval stale.
  await runReviewed(dir,clicked.review.token);
  clicked=await act(dir,s.id,'notes.note');
  assert.equal(clicked.review.always_allow.state,'changed');
  // One confirmation with the box restores it.
  await runReviewed(dir,clicked.review.token,{alwaysAllow:true});
  assert.equal((await act(dir,s.id,'notes.note')).receipt.approval,'always-allow');
  // So does a change to the pack's module file, or to the handler's declared effects.
  await fs.appendFile(pack.file,'\n// edited\n');
  assert.equal((await act(dir,s.id,'notes.note')).review.always_allow.state,'changed');
  // A pack that is gone leaves the approval listed, and nothing to run.
  await config(dir,{core:false});
  assert.deepEqual((await listAllowed(dir)).map(row=>[row.state,row.reason]),[['changed','pack notes is not installed or offers no actions']]);
  await assert.rejects(act(dir,s.id,'notes.note'),/is not offered for this story/);
});

test('core open actions can be always allowed, and turning your handler on, off or editing it asks again',{skip:process.platform==='win32'},async t=>{
  // The person's handler must sit below folders nobody else can write, which rules out a shared /tmp.
  const home=await fs.mkdtemp(path.join(await fs.realpath(os.homedir()),'.trough-allow-test-'));
  t.after(async()=>{ process.env.HERDR_APP_HOME=emptyHome; await fs.rm(home,{recursive:true,force:true}); });
  process.env.HERDR_APP_HOME=home;
  await fs.mkdir(path.join(home,'trough'),{mode:0o700});
  const log=path.join(home,'handler.log'),dir=path.join(home,'data'),file=path.join(home,'notes.txt');
  const write=extra=>fs.writeFile(userLocation(),`#!/bin/sh\n${extra}\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nexit 0\n`,{mode:0o755});
  await fs.writeFile(file,'notes');
  await write(''); await turnOn();
  const s=await add(dir,base({links:[{id:'page',label:'Page',url:'https://example.com/a'},{id:'file',label:'File',path:file}]}));
  const sheet=await review(dir,s.id,'core.reveal.file');
  assert.deepEqual(sheet.always_allow,{key:'core/open_path',state:'new',effects:['Show the linked path in the file manager']});
  assert.equal((await runReviewed(dir,sheet.token,{alwaysAllow:true})).outcome,'succeeded');
  // Approved for reveal only: opening a URL or a file is a different handler and still shows the sheet.
  const ran=await act(dir,s.id,'core.reveal.file');
  assert.deepEqual([ran.receipt.outcome,ran.receipt.result,ran.receipt.approval],['succeeded','your handler: reveal done','always-allow']);
  assert.equal((await act(dir,s.id,'core.open.page')).review.always_allow.state,'new');
  assert.equal((await act(dir,s.id,'core.open.file')).review.always_allow.state,'new');
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),['reveal','--',file,'reveal','--',file]);
  // Editing the handler stops it and stales the approval; nothing runs on the old approval.
  await write('# edited');
  assert.equal((await act(dir,s.id,'core.reveal.file')).review.always_allow.state,'changed');
  // Approving the edited handler is a change of the chain too: one more confirmation, then it holds.
  await turnOn();
  const changed=await act(dir,s.id,'core.reveal.file');
  assert.deepEqual([changed.receipt,changed.review.always_allow.state],[undefined,'changed']);
  assert.match(changed.review.plan.effects[1],/^Run your handler /);
  assert.equal((await runReviewed(dir,changed.review.token,{alwaysAllow:true})).outcome,'succeeded');
  assert.equal((await act(dir,s.id,'core.reveal.file')).receipt.approval,'always-allow');
  // Turning the handler off changes what runs, so the sheet comes back once more.
  await turnOff();
  assert.equal((await act(dir,s.id,'core.reveal.file')).review.always_allow.state,'changed');
  assert.equal((await fs.readFile(log,'utf8')).trim().split('\n').length,12);
});

test('a damaged approvals file blocks nothing but always-allowed runs, and says how to recover',async()=>{
  const dir=await root(),pack=await notesPack(dir);
  await config(dir,{core:false,packages:[pack.file]});
  const s=await add(dir,base());
  await fs.writeFile(path.join(dir,'allow.json'),'{"v":1,"allowed":{"notes/note_it":{"pack":"other","handler":"note_it","fingerprint":"x"}}}');
  await assert.rejects(act(dir,s.id,'notes.note'),/invalid allow\.json; fix it, or delete it/);
  await assert.rejects(listAllowed(dir),/invalid allow\.json/);
  assert.deepEqual(await pack.lines(),[]);
  // Actions that can never be always allowed do not read the file.
  assert.equal((await review(dir,s.id,'notes.prompt')).always_allow,undefined);
});
