// Example Trough pack: "Save to notes" on every log and document link.
// Add it with:  trough packages add docs/example-pack --options-file options.json
// where options.json is {"file": "/absolute/path/to/notes.txt"}.
import fs from 'node:fs/promises';
import path from 'node:path';

export const name='notes';

// Shown by `trough actions` and `trough packages`, so the operator can see what this pack attaches.
export const rules=['Link with role log or document: Save to notes (save_to_notes)'];

// Local facts, computed once per pass and handed to augment(). Optional.
export const facts=options=>({file:options.file});

export function handlers(options) {
  if(typeof options.file!=='string'||!path.isAbsolute(options.file)) throw new Error('notes pack needs an absolute options.file');
  return {
    save_to_notes:{
      args:{link:{type:'string',required:true,max_length:64}},
      effects:['Append a line to the notes file'],
      // Local and harmless to repeat, so the operator may tick "Always allow" for it. Leave this
      // out for anything that answers a decision, messages an agent or sends data elsewhere.
      always_allow:true,
      // What decides what will run, besides the pack's file and options. A change asks the operator again.
      fingerprint:()=>({file:options.file}),
      // The review sheet shows these effects; say exactly what will change.
      plan({story,args}) {
        const link=story.links?.find(item=>item.id===args.link);
        if(!link) throw new Error('action references a missing link');
        const line=`${story.title}: ${link.url??link.path}`;
        return {file:options.file,line,effects:[`Append to ${options.file}: ${line}`]};
      },
      async run({reviewed}) {
        await fs.appendFile(reviewed.plan.file,reviewed.plan.line+'\n');
        return 'saved';
      }
    }
  };
}

// Synchronous and pure: the same story and facts always give the same offers.
// It may only add. The story it receives is a copy; changing it changes nothing.
export function augment(story,{facts}) {
  return {
    actions:(story.links??[]).filter(link=>['log','document'].includes(link.role))
      .map(link=>({id:`save.${link.id}`,label:'Save to notes',handler:'save_to_notes',args:{link:link.id},link:link.id})),
    badges:facts.file&&story.links?.some(link=>link.role==='log')?['has log']:[]
  };
}
