// Trough pack: hands a story link to the `rl` reading-list command.
// It has no dependency on the Trough core, so it can be loaded from any absolute path.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const name='reading-list';
export const rules=['Link with role report or document, or a text, HTML or PDF media type: Add to reading list (add_to_reading_list). Set the roles with the `roles` option.'];
const ROLES=['report','document'];
const READABLE=/^(?:text\/|application\/pdf$)/;
const rolesFrom=options=>{
  const roles=options?.roles??ROLES;
  if(!Array.isArray(roles)||!roles.every(role=>typeof role==='string')) throw new Error('reading-list option roles must be an array of link roles');
  return roles;
};

// Offers the action on links worth reading later. A story that already declares it is left alone.
export function augment(story,{options}) {
  const roles=rolesFrom(options),declared=new Set((story.actions??[]).filter(a=>a.handler==='add_to_reading_list').map(a=>a.args?.link));
  return {actions:(story.links??[]).filter(link=>!declared.has(link.id)&&(roles.includes(link.role)||READABLE.test(link.media_type??'')))
    .map(link=>({id:`add.${link.id}`,label:'Add to reading list',handler:'add_to_reading_list',args:{link:link.id},link:link.id}))};
}

async function runnable(file) {
  try { await fs.access(file,constants.X_OK); return (await fs.stat(file)).isFile(); } catch { return false; }
}
async function findRl(options) {
  if(options?.rl!==undefined) {
    if(typeof options.rl!=='string'||!path.isAbsolute(options.rl)) throw new Error('reading-list option rl must be an absolute path');
    return await runnable(options.rl)?options.rl:null;
  }
  for(const dir of (process.env.PATH??'').split(path.delimiter)) {
    if(dir&&await runnable(path.join(dir,'rl'))) return path.join(dir,'rl');
  }
  return null;
}

export function handlers(options={}) {
  if(options.rl!==undefined&&(typeof options.rl!=='string'||!path.isAbsolute(options.rl))) throw new Error('reading-list option rl must be an absolute path');
  rolesFrom(options);
  return {
    add_to_reading_list:{
      args:{link:{type:'string',required:true,max_length:64},note:{type:'string',max_length:1024}},
      effects:['Add the linked URL or path to the reading list with rl'],
      async unavailable() { return await findRl(options)?null:options.rl?`${options.rl} is missing or not executable`:'rl is not on PATH'; },
      async plan({story,args}) {
        const link=story.links?.find(item=>item.id===args.link);
        if(!link) throw new Error('action references a missing link');
        const rl=await findRl(options);
        if(!rl) throw new Error('rl is unavailable');
        const target=link.url??link.path;
        const argv=['add',target,'--from','Trough','--if-new'];
        if(args.note) argv.push('--note',args.note);
        return {command:rl,argv,effects:[`Add ${target} to reading list${args.note?` with note: ${args.note}`:''}`,`Run ${JSON.stringify([rl,...argv])}`]};
      },
      async run({reviewed}) {
        const {command,argv}=reviewed.plan;
        const result=spawnSync(command,argv,{encoding:'utf8',shell:false,timeout:30000,maxBuffer:65536});
        if(result.error) throw result.error;
        if(result.status!==0) throw new Error((result.stderr||result.stdout||`exit ${result.status}`).trim().slice(0,500));
        return (result.stdout||'').trim().slice(0,500);
      }
    }
  };
}
