import { View, div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { exec, watchFolder, theme, home, appHome, props, nextCommand } from 'herdr';
import { VIEWS, visible, groups, choices } from './feed.js';

const fmt=iso=>{ try { return new Date(iso).toLocaleString(); } catch { return iso; } };
const cycle=(all,current)=>all[(all.indexOf(current)+1)%all.length];
const palette=(severity,t)=>severity==='critical'?t.blocked:severity==='warning'?t.working:severity==='notice'?t.accent:t.muted;

export default class Trough extends View {
  init(_props,cx) {
    this.dir=props()?.dir || `${home()}/.local/state/trough`;
    this.cli=`${appHome()}/mods/trough/bin/trough`;
    this.handle=cx.focus_handle(); this.rows=[]; this.rejected=0; this.sel=null; this.view='all'; this.filter={source:null,kind:null,severity:null,subject:null};
    this.detail=false; this.search=false; this.typing=false; this.error=null; this.pick=null; this.review=null; this.receipts=[];
    this.input=InputState.new({placeholder:'Search stories'});
    this.commentInput=InputState.new({placeholder:'Optional comment'});
    this.commentInput.on('focus',(_e,cx)=>{this.commentTyping=true;cx.notify();});
    this.commentInput.on('blur',(_e,cx)=>{this.commentTyping=false;cx.notify();});
    this.input.on('change',(_e,cx)=>{this.alignSelection();this.review=null;this.pick=null;cx.notify();});
    this.input.on('submit',(_e,cx)=>{this.handle.focus();cx.notify();});
    this.input.on('focus',(_e,cx)=>{this.typing=true;cx.notify();});
    this.input.on('blur',(_e,cx)=>{this.typing=false;cx.notify();});
    cx.spawn(async cx=>{
      await this.reload(cx);
      for (;;) { try { await watchFolder(this.dir); await this.reload(cx); } catch { break; /* timer remains the fallback */ } }
    });
    cx.timer.every(10000,cx=>this.reload(cx));
    cx.spawn(async cx=>{for (;;) { const cmd=await nextCommand(); if(cmd==='focus') this.handle.focus(); cx.notify(); }});
  }
  async call(args) { const r=await exec('node',[this.cli,'--dir',this.dir,...args],{timeout:30000}); if(r.code!==0) throw new Error(r.stderr.trim()||`trough exited ${r.code}`); return r.stdout; }
  async reload(cx) {
    if(this.loading) return; this.loading=true;
    try { this.rows=JSON.parse(await this.call(['ls','--all','--json'])); this.receipts=JSON.parse(await this.call(['receipts'])); this.rejected=JSON.parse(await this.call(['rejections'])).length; this.error=null; this.alignSelection(); }
    catch(e) { this.error=e.message; }
    finally { this.loading=false; cx.notify(); }
  }
  act(command,cx,extra=[]) {
    const id=this.selected()?.story.id; if(!id) return;
    cx.spawn(async cx=>{try {await this.call([command,id,...extra]); await this.reload(cx);} catch(e){this.error=e.message;cx.notify();}});
  }
  actionReview(action,cx,option) {
    const storyId=this.sel;
    cx.spawn(async cx=>{
      try {
        const args=['review',storyId,action.id]; if(option) args.push('--option',option);
        if(option && this.commentInput.value()) args.push('--comment',this.commentInput.value());
        const sheet=JSON.parse(await this.call(args));
        if(this.sel===storyId) {this.review=sheet;this.pick=null;this.error=null;}
      } catch(e) {this.error=e.message;}
      cx.notify();
    });
  }
  runReview(cx) {
    if(!this.review || this.review.story_id!==this.selected()?.story.id || this.running) return;
    const token=this.review.token; this.running=true;
    cx.spawn(async cx=>{
      try { const receipt=JSON.parse(await this.call(['run',token])); this.review=null; this.receipts=[receipt,...this.receipts.filter(r=>r.receipt_id!==receipt.receipt_id)]; this.error=receipt.outcome==='failed'?receipt.result:null; }
      catch(e) {this.error=e.message;}
      finally {this.running=false;cx.notify();}
    });
  }
  filtered() { return visible(this.rows,{...this.filter,view:this.view,text:this.input.value()}); }
  alignSelection() { const shown=this.filtered(); if(!shown.some(r=>r.story.id===this.sel)) this.sel=shown[0]?.story.id??null; }
  selected() { return this.filtered().find(r=>r.story.id===this.sel); }
  move(delta,cx) { const rows=this.filtered(); if(!rows.length) return; const index=rows.findIndex(r=>r.story.id===this.sel); this.sel=rows[Math.max(0,Math.min(rows.length-1,index+delta))].story.id; cx.notify(); }
  keys(e,cx) {
    if(this.typing||this.commentTyping) { if(e.key==='escape'){this.handle.focus();cx.notify();} return; }
    const k=e.key;
    if(k==='j'||k==='down') this.move(1,cx);
    else if(k==='k'||k==='up') this.move(-1,cx);
    else if(k==='g'||k==='home') {this.sel=this.filtered()[0]?.story.id??null;cx.notify();}
    else if(k==='shift-g'||k==='end') {this.sel=this.filtered().at(-1)?.story.id??null;cx.notify();}
    else if(k==='/') {this.search=true;this.input.focus();cx.notify();}
    else if(k==='f') {this.view=cycle(VIEWS,this.view);this.alignSelection();this.review=null;this.pick=null;cx.notify();}
    else if(k==='enter') {this.detail=!this.detail;cx.notify();}
    else if(k==='escape') {this.detail=false;this.search=false;this.review=null;this.pick=null;cx.notify();}
    else if(k==='r') this.act(this.selected()?.state.read_at?'unread':'read',cx);
    else if(k==='d') this.act(this.selected()?.state.done_at?'undo':'done',cx);
    else if(k==='z') this.act('snooze',cx,['--until',new Date(Date.now()+3600000).toISOString()]);
    else if(k==='a') {const action=this.selected()?.story.actions?.[0];if(action){this.detail=true;if(action.handler==='answer_decision'){this.pick=action;cx.notify();}else this.actionReview(action,cx);}}
  }
  button(id,label,fn,t,on=false) { return div().id(id).px(8).py(5).rounded(5).cursor_pointer().bg(on?t.selected:t.raised).text_color(on?t.foreground:t.muted).hover(s=>s.bg(t.hover)).on_click((_e,cx)=>fn(cx)).child(label); }
  render(cx) {
    const t=theme(),shown=this.filtered(),g=groups(shown),selected=this.selected(),unread=this.rows.filter(r=>!r.state.read_at&&!r.state.done_at).length;
    const groupNodes=[];
    for(const group of g) {
      if(group.items.length>1) groupNodes.push(h_flex().px(10).py(5).gap(6).bg(t.chrome).text_size(11).text_color(t.muted)
        .child(`${group.source} · ${group.kind} · ${group.items.length} stories · ${group.outstanding} actions`));
      for(const row of group.items) {
        const s=row.story,st=row.state,on=this.sel===s.id;
        groupNodes.push(v_flex().id(`story-${s.id}`).px(10).py(8).gap(3).bg(on?t.selected:t.surface).border_b(1).border_color(t.border).cursor_pointer().hover(el=>el.bg(t.hover))
          .on_click((_e,cx)=>{this.sel=s.id;this.detail=true;this.review=null;this.pick=null;this.handle.focus();cx.notify();})
          .child(h_flex().gap(6).items_center().child(div().text_size(10).text_color(palette(s.severity,t)).child(s.severity.toUpperCase()))
            .child(div().flex_1().truncate().font_semibold().text_color(st.read_at?t.muted:t.foreground).child(s.title))
            .child(div().text_size(10).text_color(t.dim).child(fmt(s.occurred_at))))
          .child(div().text_size(11).text_color(t.muted).child(`${s.source.label} · ${s.kind}${s.outcome?` · ${s.outcome}`:''}${st.done_at?' · done':''}`))
          .child(div().text_size(11).text_color(t.muted).truncate().child(s.summary)));
      }
    }
    const filterButton=(field)=>{const vals=choices(this.rows,field);return this.button(`filter-${field}`,`${field}: ${this.filter[field]??'all'}`,cx=>{this.filter[field]=cycle(vals,this.filter[field]);this.alignSelection();this.review=null;this.pick=null;cx.notify();},t,Boolean(this.filter[field]));};
    const header=v_flex().px(10).py(8).gap(7).bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(6).child(div().flex_1().font_semibold().text_size(15).text_color(t.foreground).child('Trough'))
        .child(div().text_size(11).text_color(t.muted).child(`${unread} unread`))
        .when(this.rejected>0,el=>el.child(div().text_size(11).text_color(t.blocked).child(`${this.rejected} rejected`)))
        .child(this.button('refresh','↻',cx=>this.reload(cx),t)))
      .child(h_flex().gap(5).children(VIEWS.map(v=>this.button(`view-${v}`,v,cx=>{this.view=v;this.alignSelection();this.review=null;this.pick=null;cx.notify();},t,this.view===v))))
      .child(h_flex().gap(5).children(['source','kind','severity','subject'].map(filterButton)))
      .when(this.search||this.input.value(),el=>el.child(h_flex().h(27).bg(t.background).rounded(5).px(6).child(Input.new(this.input).flex_1().min_w(0).text_size(12).text_color(t.foreground))));
    const latest=this.receipts.find(r=>r.story_id===selected?.story.id);
    const detail=selected&&this.detail?v_flex().px(12).py(10).gap(8).bg(t.background).border_t(1).border_color(t.border)
      .child(h_flex().justify_between().child(div().font_semibold().text_color(t.foreground).child(selected.story.title))
        .child(this.button('detail-close','×',cx=>{this.detail=false;cx.notify();},t)))
      .child(div().text_size(11).text_color(t.muted).child(`${selected.story.source.label} · ${fmt(selected.story.occurred_at)} · ${selected.story.id}`))
      .child(div().text_size(12).text_color(t.foreground).child(selected.story.summary))
      .when(Boolean(selected.story.decision),el=>el.child(div().text_color(t.accent).child(selected.story.decision.prompt)))
      .children((selected.story.links??[]).map(l=>div().text_size(11).text_color(t.muted).child(`${l.label}: ${l.url??l.path}`)))
      .when(Boolean(latest),el=>el.child(div().text_size(11).text_color(latest.outcome==='failed'?t.blocked:t.muted).child(`Last action: ${latest.outcome}${latest.result?` · ${latest.result}`:''}`)))
      .when(Boolean(selected.story.actions?.length),el=>el.child(h_flex().gap(5).children(selected.story.actions.map(a=>this.button(`action-${a.id}`,a.label,cx=>{
        this.review=null;
        if(a.handler==='answer_decision'){this.pick=a;cx.notify();} else this.actionReview(a,cx);
      },t)))))
      .when(Boolean(this.pick&&selected.story.decision),el=>el.child(v_flex().gap(4)
        .child(div().text_color(t.muted).child('Choose an answer to review:'))
        .when(Boolean(selected.story.decision.allow_comment),el=>el.child(h_flex().h(27).bg(t.surface).rounded(5).px(6).child(Input.new(this.commentInput).flex_1().min_w(0).text_size(12).text_color(t.foreground))))
        .children(selected.story.decision.options.map(o=>this.button(`option-${o.id}`,`${o.label}: ${o.answer_text}`,cx=>this.actionReview(this.pick,cx,o.id),t)))))
      .when(Boolean(this.review),el=>el.child(v_flex().gap(5).p(10).rounded(6).border(1).border_color(t.accent).bg(t.raised)
        .child(div().font_semibold().text_color(t.foreground).child('Review action'))
        .child(div().text_size(11).text_color(t.muted).child(`Source claim: ${this.review.source.label} · ${this.review.source.id}`))
        .children(this.review.plan.effects.map((effect,i)=>div().text_size(11).text_color(t.foreground).child(`${i+1}. ${effect}`)))
        .child(h_flex().gap(6)
          .child(this.button('confirm-action',this.running?'Running…':'Confirm action',cx=>this.runReview(cx),t,true))
          .child(this.button('cancel-action','Cancel',cx=>{this.review=null;cx.notify();},t)))))
      .child(h_flex().gap(6)
        .child(this.button('mark-read',selected.state.read_at?'Unread':'Read',cx=>this.act(selected.state.read_at?'unread':'read',cx),t))
        .child(this.button('mark-done',selected.state.done_at?'Undo':'Done',cx=>this.act(selected.state.done_at?'undo':'done',cx),t))
        .child(this.button('snooze','Snooze 1h',cx=>this.act('snooze',cx,['--until',new Date(Date.now()+3600000).toISOString()]),t))):null;
    return v_flex().id('trough-root').track_focus(this.handle).size_full().min_h(0).bg(t.background).text_size(12)
      .on_key_down((e,cx)=>this.keys(e,cx)).on_mouse_down('left',()=>this.handle.focus())
      .child(header)
      .when(Boolean(this.error),el=>el.child(div().px(10).py(6).text_color(t.blocked).child(this.error)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(groupNodes.length?groupNodes:[div().p(12).text_color(t.muted).child('No stories in this view')]))
      .when(Boolean(detail),el=>el.child(detail))
      .child(div().px(10).py(5).text_size(10).text_color(t.dim).child('j/k move · Enter detail · / search · f filter · r read · d done · z snooze · a review action'));
  }
}
