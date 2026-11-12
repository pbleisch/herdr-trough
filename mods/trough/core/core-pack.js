// The default "core" pack: open and reveal actions for story links, offered on every link by type.
// It is loaded unless the operator removes it (`trough packages remove core`). The actions run the
// handler chain in open-handlers.js: the person's own handler if they turned it on, then the
// built-in handler for this platform.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openPlan, runChain, unavailableReason, chainFingerprint } from './open-handlers.js';

export const name='core';
export const rules=[
  'URL link: Open (open_url)',
  'Path link: Open (open_file), and Show in file manager (open_path)'
];

const fail=reason=>{throw new Error(reason);};
const RUNS=new Set(['com','lnk','js','jse','wsf','hta','reg','cpl','msc','pif','app','command','tool','terminal','workflow','action','pkg','mpkg','dmg','jar','scpt','scptd','applescript','osax','prefpane','saver','kext','plugin','bundle','framework','xpc','appex','webloc','inetloc','fileloc','afploc','ftploc','url','mobileconfig','configprofile','sh','bash','zsh','csh','tcsh','ksh','fish','py','pyw','rb','pl','php','lua','tcl','ps1','bat','cmd','exe','msi','vbs','scr']);
const extension=file=>path.extname(file).slice(1).toLowerCase();
// Documents and folders open; anything that could run is shown in the file manager instead.
export async function localOpenPlan(target) {
  if(typeof target!=='string'||!(target.startsWith('/')&&!target.startsWith('//')||target.startsWith('~/')||/^[A-Za-z]:[\\/]/.test(target))) fail('expected an absolute or ~ local path');
  const file=target.startsWith('~/')?path.join(os.homedir(),target.slice(2)):target;
  let stat,real;
  try {stat=await fs.stat(file);real=await fs.realpath(file);}
  catch(e) {if(e.code==='ENOENT'||e.code==='ENOTDIR') fail(`Path does not exist: ${file}`);throw e;}
  if(!stat.isFile()&&!stat.isDirectory()) fail(`Path is not a file or folder: ${file}`);
  const couldRun=(stat.isFile()&&Boolean(stat.mode&0o111))||RUNS.has(extension(file))||RUNS.has(extension(real))||(stat.isDirectory()&&Boolean(extension(file)||extension(real)));
  return openPlan(couldRun?'reveal':'open',file,`${couldRun?'Show':'Open'} path ${file}${couldRun?' in the file manager, because it could run':''}`);
}

const linkFor=(story,args,want)=>{
  const link=story.links?.find(item=>item.id===args.link);
  if(!link) fail('action references a missing link');
  if(!link[want]) fail(`action requires a ${want} link`);
  return link;
};
const linkArg={link:{type:'string',required:true,max_length:64}};
// Local and low-risk, so the operator may always allow them; the approval follows the handler chain.
const handler=(id,effect,plan)=>({args:linkArg,effects:[effect],always_allow:true,fingerprint:chainFingerprint,unavailable:()=>unavailableReason(id),plan,run:({reviewed})=>runChain(reviewed.plan)});

export function handlers() {
  return {
    open_url:handler('open_url','Open the linked URL in the default browser',({story,args})=>{ const l=linkFor(story,args,'url'); return openPlan('open-url',l.url,`Open URL ${l.url}`); }),
    open_path:handler('open_path','Show the linked path in the file manager',({story,args})=>{ const l=linkFor(story,args,'path'); return openPlan('reveal',l.path,`Show path ${l.path} in the file manager`); }),
    open_file:handler('open_file','Open the linked file or folder, or show it in the file manager if it could run',({story,args})=>localOpenPlan(linkFor(story,args,'path').path))
  };
}

export function augment(story) {
  return {actions:(story.links??[]).flatMap(link=>link.url
    ?[{id:`open.${link.id}`,label:'Open',handler:'open_url',args:{link:link.id},link:link.id}]
    :[{id:`open.${link.id}`,label:'Open',handler:'open_file',args:{link:link.id},link:link.id},
      {id:`reveal.${link.id}`,label:process.platform==='darwin'?'Show in Finder':'Show in file manager',handler:'open_path',args:{link:link.id},link:link.id}])};
}
