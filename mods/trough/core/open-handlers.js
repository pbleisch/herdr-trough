// The handler chain behind the core pack's open and reveal actions.
//
// A handler is a program called with separate arguments, never through a shell string:
//   HANDLER VERB -- ITEM
//   open -- PATH       open the file or folder
//   reveal -- PATH     show it in the file manager
//   open-url -- URL    open an http or https link
// It exits 0 when done, 10 (NOT_HANDLED) to leave the action to the next handler, and anything
// else to fail; the first line of stderr is shown. The chain is the person's own handler, only
// after they turned it on, then the built-in handler for this platform (../handlers/).
//
// The person's handler lives outside the mod's folder, at <Herdr home>/trough/handler
// (handler.ps1 on Windows). Turning it on records its real path and SHA-256 in trust.json beside
// it. It is checked again before every plan and every run; a handler that changed, moved or
// became writable by someone else is not run until the person turns it on again.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { replaceAtomic } from './store.js';

export const NOT_HANDLED=10;
export const TIMEOUT_MS=15000;
export const VERBS=['open','reveal','open-url'];
const PWSH_ARGS=['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File'];
const HANDLERS=fileURLToPath(new URL('../handlers/',import.meta.url));
const first=text=>String(text??'').trim().split('\n')[0].slice(0,300);

export const platformName=(platform=process.platform)=>platform==='darwin'?'macos':platform==='linux'?'linux':platform==='win32'?'windows':null;
export const appHome=()=>process.env.HERDR_APP_HOME||path.join(os.homedir(),'.config','herdr-app');
export const userLocation=()=>path.join(appHome(),'trough',platformName()==='windows'?'handler.ps1':'handler');
const trustFile=()=>path.join(appHome(),'trough','trust.json');
export const builtInFile=()=>{ const name=platformName(); return name?path.join(HANDLERS,name==='windows'?'windows.ps1':`${name}.sh`):null; };

async function onPath(name) {
  const extensions=process.platform==='win32'?(process.env.PATHEXT??'.EXE').split(';'):[''];
  for(const dir of (process.env.PATH??'').split(path.delimiter)) for(const ext of extensions) {
    if(!dir) continue;
    try { await fs.access(path.join(dir,name+ext),constants.X_OK); return true; } catch {}
  }
  return false;
}

// Owned by this user (or, for a folder, also root) and not writable by group or others.
async function mineAlone(file,rootToo) {
  const stat=await fs.stat(file),me=process.getuid();
  return (stat.uid===me||(rootToo&&stat.uid===0))&&!(stat.mode&0o022);
}
async function foldersSafe(dir) {
  for(let at=dir;;at=path.dirname(at)) {
    if(!await mineAlone(at,true)) return `${at} can be changed by another user`;
    if(at===path.dirname(at)) return null;
  }
}
async function checkPosix(location) {
  const exists=async file=>fs.lstat(file).then(()=>true,()=>false);
  if(!await exists(location)) return {status:'missing'};
  const refused=why=>({status:'refused',why});
  let at=location;
  for(let hops=0;(await fs.lstat(at)).isSymbolicLink();hops++) {
    if(hops>=20) return refused(`${location} is a loop of links`);
    const dir=await fs.realpath(path.dirname(at)),unsafe=await foldersSafe(dir);
    if(unsafe) return refused(unsafe);
    const target=await fs.readlink(at);
    at=path.isAbsolute(target)?target:path.join(dir,target);
    if(!await exists(at)) return refused(`${location} leads to ${at}, which does not exist`);
  }
  const dir=await fs.realpath(path.dirname(at)),real=path.join(dir,path.basename(at));
  if(!(await fs.lstat(real)).isFile()) return refused(`${real} is not a regular file`);
  if(!await mineAlone(real,false)) return refused(`${real} is not yours alone (another user owns it, or group or others can write it)`);
  const unsafe=await foldersSafe(dir);
  if(unsafe) return refused(unsafe);
  try { await fs.access(real,constants.X_OK); } catch { return refused(`${real} is not executable (chmod +x)`); }
  return {status:'ok',real,sha256:crypto.createHash('sha256').update(await fs.readFile(real)).digest('hex')};
}
function checkWindows(location) {
  const r=spawnSync('pwsh',[...PWSH_ARGS,path.join(HANDLERS,'check-handler.ps1'),location],{encoding:'utf8',shell:false,timeout:TIMEOUT_MS});
  if(r.error||r.status!==0) return {status:'refused',why:`the handler could not be checked: ${first(r.error?.message??r.stderr)||'PowerShell 7 (pwsh) is needed'}`};
  const [status,a,b]=r.stdout.trim().split('\t');
  return status==='ok'?{status,real:a,sha256:b}:status==='missing'?{status}:{status:'refused',why:a||'the handler could not be checked'};
}
// {status:'ok',real,sha256} | {status:'missing'} | {status:'refused',why}
export async function checkHandler(location=userLocation()) {
  try { return platformName()==='windows'?checkWindows(location):await checkPosix(location); }
  catch(error) { return {status:'refused',why:first(error.message)}; }
}

async function readTrust() {
  try {
    const raw=JSON.parse(await fs.readFile(trustFile(),'utf8')),h=raw?.v===1?raw.handler:null;
    return h&&typeof h.path==='string'&&path.isAbsolute(h.path)&&/^[0-9a-f]{64}$/.test(h.sha256??'')?{path:h.path,sha256:h.sha256,at:typeof h.at==='string'?h.at:null}:null;
  } catch { return null; }
}
async function writeTrust(handler) {
  const dir=path.dirname(trustFile());
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  await replaceAtomic(dir,path.basename(trustFile()),Buffer.from(JSON.stringify({v:1,handler},null,2)+'\n'));
}
// state: off (not turned on), on (runs first), or stopped (turned on, but it changed or no longer
// passes the checks, so it is not run until the person turns it on again; `why` says what happened).
export async function userHandler() {
  const location=userLocation(),trust=await readTrust(),found=await checkHandler(location);
  const base={location,present:found.status!=='missing',built_in:builtInFile()};
  if(!trust) return {...base,state:'off',...(found.status==='refused'?{why:found.why}:{})};
  if(found.status==='ok'&&found.real===trust.path&&found.sha256===trust.sha256) return {...base,state:'on',path:found.real,sha256:found.sha256,at:trust.at};
  const why=found.status==='missing'?`there is no handler at ${location} any more`:found.status==='refused'?found.why:
    found.real!==trust.path?`${location} now leads to ${found.real}, not the ${trust.path} you turned on`:`${found.real} changed since you turned it on`;
  return {...base,state:'stopped',why};
}
export async function turnOn() {
  const location=userLocation(),found=await checkHandler(location);
  if(found.status==='missing') throw new Error(`there is no handler at ${location}`);
  if(found.status==='refused') throw new Error(`handler refused: ${found.why}`);
  await writeTrust({path:found.real,sha256:found.sha256,at:new Date().toISOString()});
  return userHandler();
}
export async function turnOff() { await writeTrust(null); return userHandler(); }

// Why open and reveal cannot work on this computer right now, or null.
export async function unavailableReason(id) {
  const name=platformName();
  if(!name) return `${id} has no handler for ${process.platform}`;
  if((await userHandler()).state==='on') return null;
  if(name==='linux'&&!await onPath('xdg-open')) return 'xdg-open is not installed (it comes with xdg-utils)';
  if(name==='windows'&&!await onPath('pwsh')) return 'PowerShell 7 (pwsh) is not installed';
  return null;
}

// The exact programs an action will run, in order, for the review sheet and the run.
export async function openPlan(verb,item,description) {
  if(!VERBS.includes(verb)) throw new Error(`unknown handler verb ${verb}`);
  const name=platformName(),file=builtInFile();
  if(!name) throw new Error(`there is no open handler for ${process.platform}`);
  const user=await userHandler(),tail=[verb,'--',item],chain=[],effects=[description];
  if(user.state==='on') {
    chain.push(name==='windows'?{who:'user',command:'pwsh',argv:[...PWSH_ARGS,user.path,...tail],path:user.path,sha256:user.sha256}
      :{who:'user',command:user.path,argv:tail,path:user.path,sha256:user.sha256});
    effects.push(`Run your handler ${JSON.stringify([chain[0].command,...chain[0].argv])} (SHA-256 ${user.sha256.slice(0,12)})`);
  } else if(user.state==='stopped') effects.push(`Your handler is not used: ${user.why}`);
  const builtIn=name==='windows'?{who:'built-in',command:'pwsh',argv:[...PWSH_ARGS,file,...tail]}:{who:'built-in',command:'/bin/sh',argv:[file,...tail]};
  chain.push(builtIn);
  effects.push(`${user.state==='on'?'If it leaves this alone, run':'Run'} ${JSON.stringify([builtIn.command,...builtIn.argv])}`);
  return {verb,item,chain,effects};
}
export async function runChain(plan) {
  for(const step of plan.chain) {
    if(step.who==='user') {
      const user=await userHandler();
      if(user.state!=='on'||user.path!==step.path||user.sha256!==step.sha256) throw new Error(`your handler changed since this review${user.why?`: ${user.why}`:''}`);
    }
    const r=spawnSync(step.command,step.argv,{encoding:'utf8',shell:false,timeout:TIMEOUT_MS,maxBuffer:65536});
    if(r.error) throw new Error(r.error.code==='ETIMEDOUT'?`${step.who==='user'?'your handler':'the built-in handler'} took over ${TIMEOUT_MS/1000} s`:r.error.message);
    if(r.status===0) return `${step.who==='user'?'your handler':'built-in handler'}: ${plan.verb} done`;
    if(r.status!==NOT_HANDLED) throw new Error(first(r.stderr)||first(r.stdout)||`${step.who==='user'?'your handler':'the built-in handler'} exited ${r.status}`);
  }
  throw new Error(`no handler handled ${plan.verb}`);
}
