export const STATES=['unread','needs action','done','snoozed'];
const active=(r,now)=>!r.state.snoozed_until || Date.parse(r.state.snoozed_until)<=now;
export function visible(rows,filters,now=Date.now()) {
  const q=(filters.text??'').toLowerCase();
  const states=filters.states??[];
  return rows.filter(r=>{
    const s=r.story,st=r.state;
    if (filters.inbox) {
      if (st.read_at && (!s.actions?.length||st.done_at)) return false;
    } else {
      if (!states.length && !filters.all && (st.done_at||!active(r,now))) return false;
      if (states.includes('unread') && st.read_at) return false;
      if (states.includes('needs action') && (!s.actions?.length||st.done_at)) return false;
      if (states.includes('done') && !st.done_at) return false;
      if (states.includes('snoozed') && active(r,now)) return false;
    }
    for (const field of ['source','kind','severity','subject']) {
      const value=field==='source'?s.source.id:field==='subject'?s.subject?.key:s[field];
      const selected=filters[field];
      if (selected && (Array.isArray(selected)?selected.length&&!selected.includes(value):value!==selected)) return false;
    }
    if (q && ![s.title,s.summary,s.body,s.source.label,s.kind,s.subject?.label,s.subject?.key,s.severity].some(x=>x?.toLowerCase().includes(q))) return false;
    return true;
  });
}
// Stories share a group when they come from the same source and kind and name the same group_key.
export const groupKey=s=>s.group_key ? JSON.stringify([s.source.id,s.kind,s.group_key]) : s.id;
export function groups(rows) {
  const map=new Map();
  for (const row of rows) {
    const s=row.story;
    const key=groupKey(s);
    if (!map.has(key)) map.set(key,{key,items:[],source:s.source.label,kind:s.kind});
    map.get(key).items.push(row);
  }
  const order={info:0,notice:1,warning:2,critical:3};
  return [...map.values()].map(g=>({...g,severity:g.items.reduce((best,r)=>order[r.story.severity]>order[best]?r.story.severity:best,'info'),outstanding:g.items.filter(r=>r.story.actions?.length&&!r.state.done_at).length}));
}
export const choices=(rows,field)=>[null,...new Set(rows.map(r=>field==='source'?r.story.source.id:field==='subject'?r.story.subject?.key:r.story[field]).filter(Boolean))].sort((a,b)=>a===null?-1:b===null?1:a.localeCompare(b));
const outstanding=row=>Boolean(row.story.actions?.length&&!row.state.done_at);
// The cards to draw, in order. A group of two or more stories is one card showing its newest story,
// with "N earlier"; the earlier stories follow it as their own cards only while the group is open.
export function cards(rows,open=new Set()) {
  const list=[];
  for (const group of groups(rows)) {
    const [head,...earlier]=group.items;
    list.push({row:head,key:group.key,earlier:earlier.length,outstanding:earlier.filter(outstanding).length,nested:false});
    if (earlier.length && open.has(group.key)) for (const row of earlier) list.push({row,key:group.key,earlier:0,outstanding:0,nested:true});
  }
  return list;
}
