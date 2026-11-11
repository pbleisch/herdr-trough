export const STATES=['unread','needs action','done','snoozed'];
const active=(r,now)=>!r.state.snoozed_until || Date.parse(r.state.snoozed_until)<=now;
export function visible(rows,filters,now=Date.now()) {
  const q=(filters.text??'').toLowerCase();
  const states=filters.states??[];
  return rows.filter(r=>{
    const s=r.story,st=r.state;
    if (!states.length && !filters.all && (st.done_at||!active(r,now))) return false;
    if (states.includes('unread') && st.read_at) return false;
    if (states.includes('needs action') && (!s.actions?.length||st.done_at)) return false;
    if (states.includes('done') && !st.done_at) return false;
    if (states.includes('snoozed') && active(r,now)) return false;
    for (const field of ['source','kind','severity','subject']) {
      const value=field==='source'?s.source.id:field==='subject'?s.subject?.key:s[field];
      const selected=filters[field];
      if (selected && (Array.isArray(selected)?selected.length&&!selected.includes(value):value!==selected)) return false;
    }
    if (q && ![s.title,s.summary,s.source.label,s.kind,s.subject?.label,s.subject?.key,s.severity].some(x=>x?.toLowerCase().includes(q))) return false;
    return true;
  });
}
export function groups(rows) {
  const map=new Map();
  for (const row of rows) {
    const s=row.story;
    const key=s.group_key ? JSON.stringify([s.source.id,s.kind,s.group_key]) : s.id;
    if (!map.has(key)) map.set(key,{key,items:[],source:s.source.label,kind:s.kind});
    map.get(key).items.push(row);
  }
  const order={info:0,notice:1,warning:2,critical:3};
  return [...map.values()].map(g=>({...g,severity:g.items.reduce((best,r)=>order[r.story.severity]>order[best]?r.story.severity:best,'info'),outstanding:g.items.filter(r=>r.story.actions?.length&&!r.state.done_at).length}));
}
export const choices=(rows,field)=>[null,...new Set(rows.map(r=>field==='source'?r.story.source.id:field==='subject'?r.story.subject?.key:r.story[field]).filter(Boolean))].sort((a,b)=>a===null?-1:b===null?1:a.localeCompare(b));
