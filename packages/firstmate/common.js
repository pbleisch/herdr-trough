import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { replaceAtomic, stored } from '../../mods/trough/core/store.js';

export const slug = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const storyId = (home, type, identity) => sha(JSON.stringify([home,type,identity])).slice(0,32);
export const integrationDir = (root,home) => path.join(root,'integrations','firstmate',sha(home).slice(0,16));
export const source = home => ({id:`firstmate_${sha(home).slice(0,12)}`,label:'Firstmate',instance:path.basename(home).slice(0,128)});
export const iso = epoch => new Date(epoch*1000).toISOString();
export const limited = (value,max) => String(value??'').slice(0,max);

export function configuredHome(options) {
  if (!options || typeof options.home!=='string' || !path.isAbsolute(options.home)) throw new Error('Firstmate package requires an absolute options.home');
  return path.resolve(options.home);
}

export function command(home,name,args,extraEnv={}) {
  const script=path.join(home,'bin',name);
  const result=spawnSync('bash',[script,...args],{
    encoding:'utf8',shell:false,timeout:30000,maxBuffer:16*1024*1024,
    env:{...process.env,FM_HOME:home,FM_CREW_STATE_NO_FORGE:'1',...extraEnv}
  });
  if (result.error) throw result.error;
  return result;
}

export function requireCommand(home,name,args,extraEnv={}) {
  const result=command(home,name,args,extraEnv);
  if (result.status!==0) throw new Error(`${name}: ${limited(result.stderr||result.stdout||`exit ${result.status}`,1000).trim()}`);
  return result.stdout;
}

export async function backlog(home) {
  const parsed=JSON.parse(requireCommand(home,'fm-fleet-snapshot.sh',['--contribution-input']));
  if (!Array.isArray(parsed?.backlog?.records)) throw new Error('Firstmate contribution snapshot has no backlog.records');
  return parsed.backlog.records;
}

export async function taskMeta(home,taskId) {
  if (!slug.test(taskId)) throw new Error('invalid Firstmate task id');
  const file=path.join(home,'state',`${taskId}.meta`);
  let info;
  try { info=await fs.lstat(file); } catch (error) { if (error.code==='ENOENT') throw new Error('Firstmate task is gone'); throw error; }
  if (!info.isFile()) throw new Error('Firstmate task metadata is not a regular file');
  const body=await fs.readFile(file,'utf8'),meta={};
  for (const line of body.split('\n')) {
    const cut=line.indexOf('=');
    if (cut>0) meta[line.slice(0,cut)]=line.slice(cut+1);
  }
  if (meta.endpoint_task_id && meta.endpoint_task_id!==taskId) throw new Error('Firstmate task metadata identity changed');
  if (!meta.spawn_gen || !meta.backend) throw new Error('Firstmate task metadata lacks spawn generation or backend');
  if (meta.remote_host) throw new Error('remote Firstmate task delivery is unavailable');
  return meta;
}

export async function liveTask(home,taskId,spawnGen) {
  const meta=await taskMeta(home,taskId);
  if (meta.spawn_gen!==spawnGen) throw new Error('Firstmate task was replaced');
  const current=requireCommand(home,'fm-crew-state.sh',[taskId]).trim();
  const match=/^state: ([a-z_-]+) · source: ([a-z_-]+)/.exec(current);
  if (!match || match[1]!=='working') throw new Error(`Firstmate task is unavailable for asynchronous steering: ${limited(current,240)}`);
  return meta;
}

export function holdIdentity(home,taskId) {
  if (!slug.test(taskId)) throw new Error('invalid Firstmate task id');
  const result=command(home,'fm-captain-hold.sh',['open',taskId,'--identity']);
  if (result.status===1 || result.status===3) return null;
  if (result.status!==0) throw new Error(`cannot read Firstmate captain hold: ${limited(result.stderr||result.stdout,600)}`);
  const identity=result.stdout.trim();
  if (!identity) throw new Error('Firstmate captain hold has no lifecycle identity');
  return identity;
}

export async function writeJson(dir,name,value) {
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  await replaceAtomic(dir,name,Buffer.from(JSON.stringify(value,null,2)+'\n'));
}

export async function storyHash(root,id) {
  return (await stored(root,id)).hash;
}
