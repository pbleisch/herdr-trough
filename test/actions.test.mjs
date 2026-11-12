import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { post, stored, list } from '../mods/trough/core/store.js';
import { review, runReviewed, receipts, annotate, listActions } from '../mods/trough/core/actions.js';

// Keep the person's own open handler (under the Herdr home) out of these tests.
process.env.HERDR_APP_HOME=await fs.mkdtemp(path.join(os.tmpdir(),'trough-home-'));

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
  await assert.rejects(runReviewed(dir,sheet.token),/story, offer or handler changed/);
  assert.equal((await receipts(dir,s.id)).length,0);
});

test('built-in path reveal is explicit and a decision needs a story-hash route',async()=>{
  const dir=await root();
  const p={...base(),links:[{id:'artifact',label:'Artifact',path:'/tmp/artifact.txt'}],actions:[{id:'reveal',label:'Reveal',handler:'open_path',args:{link:'artifact'}}]};
  await add(dir,p);
  const sheet=await review(dir,p.id,'reveal');
  assert.deepEqual([sheet.plan.verb,sheet.plan.item,sheet.offered_by],['reveal','/tmp/artifact.txt','story']);
  assert.deepEqual(sheet.plan.chain.map(step=>[step.who,...step.argv.slice(-3)]),[['built-in','reveal','--','/tmp/artifact.txt']]);
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
  for(const [target,verb] of [[document,'open'],[folder,'open'],[script,'reveal'],[executable,'reveal'],[app,'reveal']]) {
    const sheet=await review(dir,s.id,'__open_local_path',{path:target});
    assert.deepEqual([sheet.plan.verb,sheet.plan.item],[verb,target],target);
    assert.deepEqual(sheet.plan.chain.at(-1).argv.slice(-3),[verb,'--',target]);
  }
  const declared=await review(dir,s.id,'open');
  assert.deepEqual([declared.plan.verb,declared.plan.item],['open',folder]);
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
    const opened=(await review(dir,s.id,'__open_local_path',{path:shorthand})).plan,shown=(await review(dir,s.id,'__open_local_path',{path:alias})).plan;
    assert.deepEqual([opened.verb,opened.item],['open',homeFile]);
    assert.deepEqual([shown.verb,shown.item],['reveal',alias]);
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

test('an action with no installed handler is reported unavailable instead of failing on click',async()=>{
  const dir=await root(),s={...base(),links:[{id:'result',label:'Result',url:'https://example.com/result'}],actions:[
    {id:'save',label:'Save',handler:'add_to_reading_list',args:{link:'result'}},
    {id:'gone',label:'Gone',handler:'gone'},
    {id:'ok',label:'Ok',handler:'ok'}]};
  await add(dir,s);
  await config(dir,{handlers:{
    gone:{kind:'command',executable:path.join(dir,'missing-tool'),argv:[],args:{},effects:['Run a missing tool']},
    ok:{kind:'command',executable:process.execPath,argv:[{literal:'--version'}],args:{},effects:['Print the Node.js version']}}});
  const [row]=await annotate(dir,await list(dir));
  assert.deepEqual(row.action_status.save,{available:false,reason:'handler add_to_reading_list is not installed'});
  assert.match(row.action_status.gone.reason,/missing-tool is missing or not executable/);
  assert.deepEqual(row.action_status.ok,{available:true});
  await assert.rejects(review(dir,s.id,'save'),/handler add_to_reading_list is not installed/);
  await assert.rejects(review(dir,s.id,'gone'),/is unavailable: .*missing-tool/);
  const shown=JSON.parse(spawnSync(process.execPath,[path.resolve('mods/trough/bin/trough'),'--dir',dir,'ls','--all','--json'],{encoding:'utf8'}).stdout);
  assert.equal(shown[0].action_status.save.available,false);
});

test('a decision answer is unavailable until its route is bound, and a broken pack is named in the reason',async()=>{
  const dir=await root();
  const d={...base(),kind:'decision',decision:{question_id:'q',prompt:'Proceed?',options:[{id:'yes',label:'Yes',answer_text:'Proceed'},{id:'no',label:'No',answer_text:'Stop'}]},actions:[{id:'answer',label:'Answer',handler:'answer_decision'},{id:'x',label:'X',handler:'from_pack'}]};
  await add(dir,d);
  await config(dir,{packages:[path.join(dir,'absent','index.js')]});
  assert.deepEqual((await annotate(dir,await list(dir)))[0].offers,[]);
  let [row]=await annotate(dir,await list(dir));
  assert.equal(row.action_status.answer.reason,'no trusted answer route is bound to this story');
  assert.match(row.action_status.x.reason,/^handler from_pack is not installed; pack absent failed to load: /);
  await config(dir,{answer_routes:{[d.id]:{source_id:'example',story_hash:row.story_hash}}});
  [row]=await annotate(dir,await list(dir));
  assert.deepEqual(row.action_status.answer,{available:true});
});

test('listed actions name the core pack handlers, their arguments and the augment rules',async()=>{
  const dir=await root(),{handlers,augmenters}=await listActions(dir);
  assert.deepEqual(handlers.map(a=>[a.id,a.origin,a.pack??null]),[['answer_decision','built-in',null],['open_file','pack','core'],['open_path','pack','core'],['open_url','pack','core']]);
  assert.deepEqual(handlers.find(a=>a.id==='open_url').args,{link:{type:'string',required:true,max_length:64}});
  assert.deepEqual(augmenters.map(a=>a.pack),['core']);
  assert.match(augmenters[0].rules.join(' '),/URL link: Open/);
});

test('the core pack offers open and reveal on links without the story declaring them, and review pins the offer',async()=>{
  const dir=await root(),file=path.join(dir,'notes.txt');
  await fs.writeFile(file,'notes');
  const s={...base(),links:[{id:'page',label:'Page',url:'https://example.com/a',role:'pr'},{id:'notes',label:'Notes',path:file,role:'document',media_type:'text/plain'}]};
  await add(dir,s);
  const [row]=await annotate(dir,await list(dir));
  assert.equal(row.action_status,undefined);
  assert.deepEqual(row.offers.map(o=>[o.id,o.pack,o.label,o.handler,o.link,o.available]),[
    ['core.open.page','core','Open','open_url','page',true],
    ['core.open.notes','core','Open','open_file','notes',true],
    ['core.reveal.notes','core',process.platform==='darwin'?'Show in Finder':'Show in file manager','open_path','notes',true]]);
  assert.equal((await stored(dir,s.id)).story.actions,undefined);
  const sheet=await review(dir,s.id,'core.open.notes');
  assert.deepEqual([sheet.offered_by,sheet.offer.id,sheet.plan.verb,sheet.plan.item],['core','core.open.notes','open',file]);
  await assert.rejects(review(dir,s.id,'core.open.absent'),/is not offered for this story/);
  // Removing the core pack between review and run withdraws the offer, so the run is refused.
  await config(dir,{core:false});
  assert.deepEqual((await annotate(dir,await list(dir)))[0].offers,[]);
  await assert.rejects(runReviewed(dir,sheet.token),/is not offered for this story/);
  await assert.rejects(review(dir,s.id,'__open_local_path',{path:file}),/needs the core pack/);
  assert.equal((await receipts(dir,s.id)).length,0);
});

test('augmenters add offers and badges in pack order, cannot edit the story, and fail alone',async()=>{
  const dir=await root(),tag=path.join(dir,'tag.mjs'),bad=path.join(dir,'bad.mjs'),greedy=path.join(dir,'greedy.mjs'),out=path.join(dir,'ran');
  const handler=`{args:{note:{type:'string',required:true,max_length:20}},effects:['Write a note'],plan:({args})=>({effects:['Write '+args.note]}),run:async({reviewed})=>{ const fs=await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(out)},reviewed.offer.args.note); return 'ok'; }}`;
  await fs.writeFile(tag,`export const name='tag'; export const rules=['Any story: Note it'];
export const facts=options=>({greeting:options.greeting});
export function handlers() { return {note_it:${handler}}; }
export function augment(story,{facts,options,platform}) { story.title='changed'; return {actions:[{id:'note',label:'Note it',handler:'note_it',args:{note:facts.greeting}}],badges:[platform===process.platform?'tagged':'?']}; }`);
  await fs.writeFile(bad,`export const name='bad'; export function handlers() { return {}; } export function augment() { throw new Error('augmenter broke'); }`);
  await fs.writeFile(greedy,`export const name='greedy'; export function handlers() { return {}; } export function augment(story) { return {actions:[{id:'steal',label:'Open',handler:'open_url',args:{link:'x'}}]}; }`);
  await config(dir,{core:false,packages:[{path:tag,options:{greeting:'hello'}},bad,greedy]});
  const s={...base()}; await add(dir,s);
  const [row]=await annotate(dir,await list(dir));
  assert.equal(row.story.title,'Result');
  assert.deepEqual(row.offers,[{id:'tag.note',pack:'tag',label:'Note it',handler:'note_it',args:{note:'hello'},available:true}]);
  assert.deepEqual(row.badges,[{pack:'tag',label:'tagged'}]);
  const sheet=await review(dir,s.id,'tag.note');
  assert.equal(sheet.offered_by,'tag');
  const receipt=await runReviewed(dir,sheet.token);
  assert.deepEqual([receipt.outcome,receipt.offered_by,await fs.readFile(out,'utf8')],['succeeded','tag','hello']);
  // A changed fact changes the offer, so a review made before the change cannot run.
  const stale=await review(dir,s.id,'tag.note');
  await config(dir,{core:false,packages:[{path:tag,options:{greeting:'goodbye'}}]});
  await assert.rejects(runReviewed(dir,stale.token),/story, offer or handler changed/);
  const cli=path.resolve('mods/trough/bin/trough');
  await config(dir,{core:false,packages:[{path:tag,options:{greeting:'hello'}},bad,greedy]});
  const check=JSON.parse(spawnSync(process.execPath,[cli,'--dir',dir,'packages','check','--json'],{encoding:'utf8'}).stdout);
  assert.deepEqual(check.packs.map(p=>[p.name,p.ok]),[['tag',true],['bad',false],['greedy',false]]);
  assert.equal(check.packs[1].problems[0],'augment failed for 1 story: augmenter broke');
  assert.match(check.packs[2].problems[0],/must use a handler of its own pack/);
});

test('links accept a role and a media type, and reject malformed ones',async()=>{
  const dir=await root(),link={id:'r',label:'Report',url:'https://example.com/r'};
  await add(dir,{...base(),links:[{...link,role:'report',media_type:'application/pdf'}]});
  await assert.rejects(add(dir,{...base(),links:[{...link,role:'Not A Role'}]}),/links\[0\]\.role/);
  await assert.rejects(add(dir,{...base(),links:[{...link,media_type:'markdown'}]}),/links\[0\]\.media_type/);
});
