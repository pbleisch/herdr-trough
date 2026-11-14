import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { post, list } from '../mods/trough/core/store.js';
import { review, runReviewed, annotate } from '../mods/trough/core/actions.js';
import { listPacks } from '../mods/trough/core/packages.js';
import { userHandler, turnOn, turnOff, checkHandler, openPlan, runChain, userLocation, builtInFile } from '../mods/trough/core/open-handlers.js';
import { posix } from './support.mjs';

// The person's handler must sit below folders nobody else can write, which rules out a shared /tmp:
// each test gets a private Herdr home under the home folder and removes it afterwards.
const project=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const cli=path.join(project,'mods','trough','bin','trough');
async function home(t) {
  const dir=await fs.mkdtemp(path.join(await fs.realpath(os.homedir()),'.trough-handler-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  process.env.HERDR_APP_HOME=dir;
  await fs.mkdir(path.join(dir,'trough'),{mode:0o700});
  return dir;
}
// A handler that records its arguments; it handles `verbs` and leaves everything else alone.
async function write(dir,verbs,extra='') {
  const log=path.join(dir,'handler.log');
  await fs.writeFile(userLocation(),`#!/bin/sh\n${extra}\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\ncase $1 in ${verbs}) exit 0 ;; esac\nexit 10\n`,{mode:0o755});
  return log;
}
const story=file=>({v:1,id:crypto.randomBytes(16).toString('hex'),source:{id:'example',label:'Example'},kind:'report',title:'Result',summary:'Ready',occurred_at:'2026-11-11T18:00:00Z',severity:'info',
  links:[{id:'page',label:'Page',url:'https://example.com/a?b=1&c=$(touch never)'},{id:'file',label:'File',path:file}]});

test('built-in handlers refuse malformed calls and leave unknown verbs alone',{skip:!posix},()=>{
  for(const name of ['macos.sh','linux.sh']) {
    const run=(...argv)=>spawnSync('/bin/sh',[path.join(project,'mods','trough','handlers',name),...argv],{encoding:'utf8'});
    assert.equal(run('preview','--','/tmp/x').status,10,name);
    assert.equal(run('open','/tmp/x').status,2,name);
    assert.equal(run('open','--','/tmp/x','extra').status,2,name);
    const link=run('open-url','--','file:///etc/passwd');
    assert.deepEqual([link.status,link.stderr.trim()],[2,'only http and https links are opened'],name);
  }
  assert.equal(path.basename(builtInFile()),process.platform==='darwin'?'macos.sh':'linux.sh');
});

// linux.sh is plain sh, so its handling of xdg-open is tested on every POSIX system: PATH holds only
// the few tools the script needs and a stand-in xdg-open that records its arguments. There is no
// gdbus on that PATH, so reveal takes the route without a file manager on D-Bus.
test('the Linux handler passes the item to xdg-open unchanged and turns its results into exit statuses and messages',{skip:!posix},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trough-linux-')),tools=path.join(dir,'tools'),log=path.join(dir,'xdg-open.log');
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(tools);
  for(const name of ['mktemp','sleep','rm','cat','dirname']) {
    const found=['/usr/bin','/bin'].map(d=>path.join(d,name)).find(f=>spawnSync('/bin/sh',['-c','test -x "$0"',f]).status===0);
    assert.ok(found,`${name} not found`);
    await fs.symlink(found,path.join(tools,name));
  }
  const run=(mode,...argv)=>spawnSync('/bin/sh',[path.join(project,'mods','trough','handlers','linux.sh'),...argv],{encoding:'utf8',env:{PATH:tools,XO_LOG:log,XO_MODE:mode}});
  const got=async()=>{ const lines=(await fs.readFile(log,'utf8')).split('\n').slice(0,-1); await fs.rm(log); return lines; };
  const file=path.join(dir,"it's a note.md"),url='https://example.com/a?b=1&c=$(touch never)#part';
  const absent='xdg-open is not installed (it comes with xdg-utils)';
  assert.deepEqual([run('ok','open','--',file).status,run('ok','open','--',file).stderr.trim()],[127,absent]);
  assert.deepEqual([run('ok','open-url','--',url).status,run('ok','reveal','--',file).stderr.trim()],[127,`no file manager answered, and ${absent}`]);
  await fs.writeFile(path.join(tools,'xdg-open'),`#!/bin/sh
printf '%s\n' "$#" "$@" >> "$XO_LOG"
case $XO_MODE in
none) echo "xdg-open: 882: www-browser: not found" >&2; exit 3 ;;
gone) echo "xdg-open: file '$1' does not exist" >&2; exit 2 ;;
ten) exit 10 ;;
slow) sleep 5 ;;
esac
exit 0
`,{mode:0o755});
  assert.equal(run('ok','open','--',file).status,0);
  assert.deepEqual(await got(),['1',file]);
  assert.equal(run('ok','open-url','--',url).status,0);
  assert.deepEqual(await got(),['1',url]);
  assert.equal(run('ok','reveal','--',file).status,0);
  assert.deepEqual(await got(),['1',dir]);
  // No program for this type: the plain reason is the first line, before xdg-open's own output.
  const none=run('none','open','--',file);
  assert.deepEqual([none.status,none.stderr.split('\n')[0]],[3,'xdg-open found no program to open it with']);
  const gone=run('gone','open','--',file);
  assert.deepEqual([gone.status,gone.stderr.trim()],[2,`xdg-open: file '${file}' does not exist`]);
  // 10 would tell Trough "not handled"; an opener that happens to exit 10 is a failure.
  assert.equal(run('ten','open','--',file).status,1);
  // An opener that stays running as long as the app it started is not waited for.
  const started=Date.now(),slow=run('slow','open','--',file);
  assert.equal(slow.status,0);
  assert.ok(Date.now()-started<4500,'returned before the opener finished');
});

// windows.ps1 runs for real here, with TROUGH_DRY_RUN=1 wherever it would start a program.
test('the Windows handler refuses what could run and what is not local, and names what it would start',{skip:posix&&'needs Windows and PowerShell 7'},async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'trough-windows-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const run=(env,...argv)=>{ const r=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',builtInFile(),...argv],{encoding:'utf8',env:{...process.env,TROUGH_DRY_RUN:'1',...env}}); return [r.status,r.stdout.trim(),r.stderr.trim()]; };
  const note=path.join(dir,"it's a nöte 日本.md"),script=path.join(dir,'build.bat'),explorer=path.join(process.env.SystemRoot,'explorer.exe');
  await fs.writeFile(note,'note'); await fs.writeFile(script,'@echo hi');
  assert.equal(path.basename(builtInFile()),'windows.ps1');
  assert.deepEqual(run({},'open','--',note),[0,`would: open ${note}`,'']);
  assert.deepEqual(run({},'reveal','--',note),[0,`would: ${explorer} /select,"${note}"`,'']);
  assert.deepEqual(run({},'reveal','--',script),[0,`would: ${explorer} /select,"${script}"`,'']);
  assert.deepEqual(run({},'open','--',script),[1,'','build.bat could run, so it is not opened']);
  assert.deepEqual(run({},'open','--',path.join(dir,'gone.txt')),[1,'',`${path.join(dir,'gone.txt')} does not exist`]);
  for(const item of ['notes.txt','\\\\server\\share\\notes.txt',note.replaceAll('\\','/'),'C:\\a" /e,C:\\Windows']) assert.deepEqual(run({},'reveal','--',item),[2,'',`not a local path: ${item}`]);
  assert.deepEqual(run({},'open-url','--','https://example.com/a?b=1&c=$(touch never)'),[0,'would: open-url https://example.com/a?b=1&c=$(touch%20never)','']);
  for(const item of ['file:///C:/Windows/System32/calc.exe','javascript:alert(1)','C:\\Windows\\System32\\calc.exe']) assert.deepEqual(run({},'open-url','--',item),[2,'','only http and https links are opened']);
  assert.deepEqual([run({},'preview','--',note)[0],run({},'open',note)[0],run({},'open','--',note,'extra')[0]],[10,2,2]);
});

test('your handler is off until turned on, runs first with separate arguments, and is stopped when it changes',{skip:!posix},async t=>{
  const dir=await home(t),root=path.join(dir,'data'),file=path.join(dir,'notes.txt');
  await fs.writeFile(file,'notes');
  const s=story(file); await post(root,Buffer.from(JSON.stringify(s)+'\n'));
  assert.deepEqual([(await userHandler()).state,(await userHandler()).present],['off',false]);
  await assert.rejects(turnOn(),/there is no handler at /);
  const log=await write(dir,'open|open-url');
  // Present but not turned on: it is not part of any plan.
  assert.deepEqual((await review(root,s.id,'core.open.page')).plan.chain.map(step=>step.who),['built-in']);
  const on=await turnOn();
  assert.deepEqual([on.state,on.path],['on',userLocation()]);
  const sheet=await review(root,s.id,'core.open.page');
  assert.deepEqual(sheet.plan.chain.map(step=>[step.who,step.command,...step.argv.slice(-3)]),[['user',userLocation(),'open-url','--',s.links[0].url],['built-in','/bin/sh','open-url','--',s.links[0].url]]);
  assert.match(sheet.plan.effects[1],/^Run your handler .* \(SHA-256 [0-9a-f]{12}\)$/);
  const receipt=await runReviewed(root,sheet.token);
  assert.deepEqual([receipt.outcome,receipt.result],['succeeded','your handler: open-url done']);
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),['open-url','--',s.links[0].url]);
  await assert.rejects(fs.access(path.join(process.cwd(),'never')));
  // Clicking a path in the story text goes through the same chain.
  const opened=JSON.parse(spawnSync(process.execPath,[cli,'--dir',root,'open',s.id,file],{encoding:'utf8'}).stdout);
  assert.deepEqual([opened.outcome,opened.result],['succeeded','your handler: open done']);
  // An edit between review and run refuses the run, and stops the handler until it is turned on again.
  const stale=await review(root,s.id,'core.open.file');
  await write(dir,'open|open-url','# edited');
  await assert.rejects(runReviewed(root,stale.token),/story, offer or handler changed/);
  const stopped=await userHandler();
  assert.deepEqual([stopped.state,stopped.why],['stopped',`${userLocation()} changed since you turned it on`]);
  const next=await review(root,s.id,'core.open.file');
  assert.deepEqual(next.plan.chain.map(step=>step.who),['built-in']);
  assert.equal(next.plan.effects[1],`Your handler is not used: ${userLocation()} changed since you turned it on`);
  const core=(await listPacks(root))[0];
  assert.deepEqual([core.ok,core.user_handler.state],[false,'stopped']);
  assert.match(core.problems[0],/^your handler is not used: .* Run `trough handler on`/);
  assert.equal(JSON.parse(spawnSync(process.execPath,[cli,'handler','on'],{encoding:'utf8'}).stdout).state,'on');
  assert.equal((await listPacks(root))[0].ok,true);
  assert.equal(JSON.parse(spawnSync(process.execPath,[cli,'handler','off'],{encoding:'utf8'}).stdout).state,'off');
  assert.deepEqual((await review(root,s.id,'core.open.file')).plan.chain.map(step=>step.who),['built-in']);
});

test('a verb your handler leaves alone falls through to the next handler, and a failure stops the chain',{skip:!posix},async t=>{
  const dir=await home(t),log=await write(dir,'open'),marker=path.join(dir,'built-in-ran');
  await turnOn();
  const plan=await openPlan('reveal','/srv/x','Show /srv/x');
  assert.deepEqual(plan.chain.map(step=>step.who),['user','built-in']);
  // The real built-in would open the file manager, so a stand-in takes its place in the chain.
  const standIn={who:'built-in',command:'/bin/sh',argv:['-c','printf "%s " "$@" > "$0"',marker,'reveal','--','/srv/x']};
  assert.equal(await runChain({...plan,chain:[plan.chain[0],standIn]}),'built-in handler: reveal done');
  assert.equal(await fs.readFile(marker,'utf8'),'reveal -- /srv/x ');
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),['reveal','--','/srv/x']);
  await assert.rejects(runChain({...plan,chain:[plan.chain[0]]}),/no handler handled reveal/);
  await write(dir,'none','echo "no viewer installed" >&2; exit 3');
  await turnOn();
  const failing=await openPlan('open','/srv/x','Open /srv/x');
  await fs.rm(marker);
  await assert.rejects(runChain({...failing,chain:[failing.chain[0],standIn]}),/^Error: no viewer installed$/);
  await assert.rejects(fs.access(marker));
});

test('a handler others could change is refused',{skip:!posix},async t=>{
  const dir=await home(t);
  await write(dir,'open');
  await fs.chmod(userLocation(),0o775);
  assert.match((await checkHandler()).why,/is not yours alone/);
  await assert.rejects(turnOn(),/handler refused: .* is not yours alone/);
  await fs.chmod(userLocation(),0o644);
  assert.match((await checkHandler()).why,/is not executable/);
  await fs.chmod(userLocation(),0o755);
  await fs.chmod(path.join(dir,'trough'),0o777);
  assert.match((await checkHandler()).why,/trough can be changed by another user/);
  await fs.chmod(path.join(dir,'trough'),0o700);
  // A link is followed, and what it leads to must pass the same checks.
  const real=path.join(dir,'real-handler'),loose=path.join(dir,'loose');
  await fs.rename(userLocation(),real);
  await fs.symlink(real,userLocation());
  assert.deepEqual(await checkHandler(),{status:'ok',real,sha256:crypto.createHash('sha256').update(await fs.readFile(real)).digest('hex')});
  await fs.mkdir(loose,{mode:0o777}); await fs.chmod(loose,0o777);
  await fs.rename(real,path.join(loose,'handler'));
  await fs.rm(userLocation()); await fs.symlink(path.join(loose,'handler'),userLocation());
  assert.match((await checkHandler()).why,/loose can be changed by another user/);
  await fs.rm(userLocation()); await fs.mkdir(userLocation());
  assert.match((await checkHandler()).why,/is not a regular file/);
  assert.equal((await annotate(path.join(dir,'data'),[]))?.length,0);
});
