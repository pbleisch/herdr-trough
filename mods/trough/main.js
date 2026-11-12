import { View, div } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input } from 'gpui-base';
import { exec, watchFolder, theme, home, appHome, props, nextCommand } from 'herdr';
import { STATES, visible, groups, choices } from './feed.js';
import { ProducerSchedule } from './producer-schedule.js';
import { localTime, relativeTime } from './time.js';
import { severityLabel } from './severity-label.js';
import { isHttpUrl, splitDetailLinks, actionLink } from './links.js';

const palette=(severity,t)=>severity==='critical'?t.blocked:severity==='warning'?t.working:severity==='notice'?t.accent:t.muted;

export default class Trough extends View {
  init(_props,cx) {
    this.dir=props()?.dir || `${home()}/.local/state/trough`;
    this.cli=`${appHome()}/mods/trough/bin/trough`;
    this.handle=cx.focus_handle(); this.rows=[]; this.rejected=0; this.sel=null; this.filter={inbox:true,states:[],source:[],kind:[],severity:[],subject:[]}; this.filterPicker=false; this.filterField='source';
    this.detail=false; this.search=false; this.typing=false; this.error=null; this.pick=null; this.review=null; this.receipts=[]; this.deleteConfirm=null; this.deleting=false;
    // Standing approvals: the list, whether its panel is open, and the review sheet's checkbox.
    this.allowed=[]; this.allowView=false; this.alwaysAllow=false;
    this.resetSearchInput(cx);
    this.commentInput=InputState.new({placeholder:'Optional comment'});
    this.commentInput.on('focus',(_e,cx)=>{this.commentTyping=true;cx.notify();});
    this.commentInput.on('blur',(_e,cx)=>{this.commentTyping=false;cx.notify();});
    cx.spawn(async cx=>{
      await this.reload(cx);
      for (;;) { try { await watchFolder(this.dir); await this.reload(cx); } catch { break; /* timer remains the fallback */ } }
    });
    cx.timer.every(10000,cx=>this.reload(cx));
    cx.timer.every(15000,cx=>cx.notify());
    this.producers=[]; this.producerHealth=new Map(); this.producerSetupError=null; this.packs=[];
    cx.spawn(async cx=>{
      try {
        this.producers=JSON.parse(await this.call(['producers']));
        this.producerSchedule=new ProducerSchedule(this.producers);
        for(const item of this.producers) this.producerHealth.set(item.id,item.status);
        this.pollProducers(cx);
      } catch(error) { this.producerSetupError=error.message; }
      cx.notify();
    });
    cx.timer.every(1000,cx=>this.pollProducers(cx));
    this.pruning=false;
    this.prune(cx);
    cx.timer.every(3600000,cx=>this.prune(cx));
    cx.spawn(async cx=>{for (;;) { const cmd=await nextCommand(); if(cmd==='focus') this.handle.focus(); cx.notify(); }});
  }
  async call(args) { const r=await exec('node',[this.cli,'--dir',this.dir,...args],{timeout:args[0]==='produce'?120000:30000}); if(r.code!==0) throw new Error(r.stderr.trim()||`trough exited ${r.code}`); return r.stdout; }
  resetSearchInput(cx) {
    this.input=InputState.new({placeholder:'Search stories'});
    this.input.on('change',(_e,cx)=>{this.alignSelection();this.review=null;this.pick=null;cx.notify();});
    this.input.on('submit',(_e,cx)=>{this.handle.focus();cx.notify();});
    this.input.on('focus',(_e,cx)=>{this.typing=true;cx.notify();});
    this.input.on('blur',(_e,cx)=>{this.typing=false;cx.notify();});
  }
  pollProducers(cx) {
    for(const item of this.producerSchedule?.due(Date.now())??[]) {
      cx.spawn(async cx=>{
        try {
          const result=JSON.parse(await this.call(['produce',item.id]));
          if(!result.busy) this.producerHealth.set(item.id,result.status);
        } catch(error) {
          this.producerHealth.set(item.id,{last_run:new Date().toISOString(),last_error:error.message});
        } finally { this.producerSchedule.complete(item.id); cx.notify(); }
      });
    }
  }
  prune(cx) {
    if(this.pruning) return;
    this.pruning=true;
    cx.spawn(async cx=>{
      try { await this.call(['prune']); await this.reload(cx); }
      catch(error) { this.error=error.message; cx.notify(); }
      finally { this.pruning=false; }
    });
  }
  async reload(cx) {
    if(this.loading) return; this.loading=true;
    try { this.rows=JSON.parse(await this.call(['ls','--all','--json'])); this.receipts=JSON.parse(await this.call(['receipts'])); this.rejected=JSON.parse(await this.call(['rejections'])).length; this.packs=JSON.parse(await this.call(['packages','list','--json'])); this.allowed=JSON.parse(await this.call(['allow','list','--json'])); this.error=null; this.alignSelection(); }
    catch(e) { this.error=e.message; }
    finally { this.loading=false; cx.notify(); }
  }
  act(command,cx,extra=[]) {
    const id=this.selected()?.story.id; if(!id) return;
    cx.spawn(async cx=>{try {await this.call([command,id,...extra]); await this.reload(cx);} catch(e){this.error=e.message;cx.notify();}});
  }
  confirmDelete(cx) {
    const id=this.selected()?.story.id;
    if(!id) return;
    this.detail=true; this.deleteConfirm=id; this.review=null; this.pick=null; cx.notify();
  }
  deleteSelected(cx) {
    const id=this.selected()?.story.id;
    if(!id||this.deleteConfirm!==id||this.deleting) return;
    this.deleting=true;
    cx.spawn(async cx=>{
      try { await this.call(['delete',id]); this.deleteConfirm=null; await this.reload(cx); }
      catch(e) { this.error=e.message; cx.notify(); }
      finally { this.deleting=false; cx.notify(); }
    });
  }
  actionReview(action,cx,option) {
    const storyId=this.sel;
    cx.spawn(async cx=>{
      try {
        const args=['review',storyId,action.id]; if(option) args.push('--option',option);
        if(option && this.commentInput.value()) args.push('--comment',this.commentInput.value());
        const sheet=JSON.parse(await this.call(args));
        if(this.sel===storyId) this.showReview(sheet);
      } catch(e) {this.error=e.message;}
      cx.notify();
    });
  }
  // The checkbox starts ticked only when the person already allowed this kind of action and its handler changed since.
  showReview(sheet) { this.review=sheet; this.alwaysAllow=sheet.always_allow?.state==='changed'; this.pick=null; this.error=null; }
  showReceipt(receipt) { this.receipts=[receipt,...this.receipts.filter(r=>r.receipt_id!==receipt.receipt_id)]; this.error=receipt.outcome==='failed'?receipt.result:null; }
  // A pack offer: runs at once when the person always allows it, otherwise opens the review sheet.
  offerAct(offer,cx) {
    const storyId=this.sel;
    if(this.acting) return;
    this.acting=true; this.review=null; this.pick=null;
    cx.spawn(async cx=>{
      try {
        const result=JSON.parse(await this.call(['act',storyId,offer.id]));
        if(result.receipt) this.showReceipt(result.receipt);
        else if(this.sel===storyId) this.showReview(result.review);
      } catch(e) {this.error=e.message;}
      finally {this.acting=false;cx.notify();}
    });
  }
  runReview(cx) {
    if(!this.review || this.review.story_id!==this.selected()?.story.id || this.running) return;
    const token=this.review.token,standing=this.review.always_allow,keep=Boolean(standing&&this.alwaysAllow); this.running=true;
    cx.spawn(async cx=>{
      try {
        // Unticking the box on an approval whose handler changed withdraws the approval.
        if(standing?.state==='changed'&&!keep) await this.call(['allow','revoke',standing.key]);
        const receipt=JSON.parse(await this.call(['run',token,...(keep?['--always-allow']:[])])); this.review=null; this.showReceipt(receipt);
        if(standing) this.allowed=JSON.parse(await this.call(['allow','list','--json']));
      }
      catch(e) {this.error=e.message;}
      finally {this.running=false;cx.notify();}
    });
  }
  revokeAllowed(key,cx) {
    cx.spawn(async cx=>{try {await this.call(['allow','revoke',key]); await this.reload(cx);} catch(e){this.error=e.message;cx.notify();}});
  }
  openLocalPath(target,cx) {
    const storyId=this.sel;
    cx.spawn(async cx=>{
      try {
        this.showReceipt(JSON.parse(await this.call(['open',storyId,target])));
      } catch(e) {this.error=e.message;}
      cx.notify();
    });
  }
  filtered() { return visible(this.rows,{...this.filter,text:this.input.value()}); }
  changeFilter(field,value,cx) {
    const selected=this.filter[field];
    if(field==='states') this.filter.inbox=false;
    this.filter[field]=selected.includes(value)?selected.filter(item=>item!==value):[...selected,value];
    this.alignSelection();this.review=null;this.pick=null;cx.notify();
  }
  selectView(inbox,cx) {
    this.filter.inbox=inbox;this.filter.states=[];
    this.alignSelection();this.review=null;this.pick=null;cx.notify();
  }
  clearFilters(cx) {
    for(const field of ['states','source','kind','severity','subject']) this.filter[field]=[];
    this.filter.inbox=true;
    this.resetSearchInput(cx);this.search=false;this.typing=false;this.alignSelection();this.review=null;this.pick=null;cx.notify();
  }
  filterSummary() {
    const parts=this.filter.inbox?['Inbox (unread OR needs action)']:this.filter.states.length?[...this.filter.states]:['Active unfinished'];
    for(const field of ['source','kind','severity','subject']) if(this.filter[field].length) parts.push(`${field}: ${this.filter[field].map(value=>field==='severity'?severityLabel(value):value).join(', ')}`);
    if(this.input.value()) parts.push(`search: ${this.input.value()}`);
    return parts.join(' · ');
  }
  alignSelection() { const shown=this.filtered(); if(!shown.some(r=>r.story.id===this.sel)) this.sel=shown[0]?.story.id??null; if(this.deleteConfirm!==this.sel) this.deleteConfirm=null; }
  selected() { return this.filtered().find(r=>r.story.id===this.sel); }
  move(delta,cx) { const rows=this.filtered(); if(!rows.length) return; const index=rows.findIndex(r=>r.story.id===this.sel); this.sel=rows[Math.max(0,Math.min(rows.length-1,index+delta))].story.id; this.deleteConfirm=null; cx.notify(); }
  keys(e,cx) {
    if(this.typing||this.commentTyping) { if(e.key==='escape'){this.handle.focus();cx.notify();} return; }
    const k=e.key;
    if(k==='j'||k==='down') this.move(1,cx);
    else if(k==='k'||k==='up') this.move(-1,cx);
    else if(k==='g'||k==='home') {this.sel=this.filtered()[0]?.story.id??null;cx.notify();}
    else if(k==='shift-g'||k==='end') {this.sel=this.filtered().at(-1)?.story.id??null;cx.notify();}
    else if(k==='/') {this.search=true;this.input.focus();cx.notify();}
    else if(k==='f') {this.filterPicker=!this.filterPicker;cx.notify();}
    else if(k==='x') this.clearFilters(cx);
    else if(this.filterPicker && ['1','2','3','4'].includes(k)) this.changeFilter('states',STATES[Number(k)-1],cx);
    else if(k==='enter') {this.detail=!this.detail;cx.notify();}
    else if(k==='escape') {this.detail=false;this.search=false;this.filterPicker=false;this.allowView=false;this.review=null;this.pick=null;this.deleteConfirm=null;cx.notify();}
    else if(k==='r') this.act(this.selected()?.state.read_at?'unread':'read',cx);
    else if(k==='d') this.act(this.selected()?.state.done_at?'undo':'done',cx);
    else if(k==='shift-d') this.confirmDelete(cx);
    else if(k==='z') this.act('snooze',cx,['--until',new Date(Date.now()+3600000).toISOString()]);
    else if(k==='a') {const row=this.selected(),action=row?.story.actions?.find(item=>!this.actionBlocked(row,item))??row?.offers?.find(item=>item.available);if(action){this.detail=true;if(action.handler==='answer_decision'||action.choice){this.pick=action;cx.notify();}else if(action.pack) this.offerAct(action,cx);else this.actionReview(action,cx);}}
  }
  // The CLI reports why an action cannot run (handler not installed, tool missing); such an action is shown but cannot be clicked.
  actionBlocked(row,action) { const status=row.action_status?.[action.id]; return status&&!status.available?status.reason||'unavailable':null; }
  // Your own open handler changed or stopped passing its checks: it is not run until you decide.
  handlerDecision(command,cx) {
    cx.spawn(async cx=>{try {await this.call(['handler',command]); await this.reload(cx);} catch(e){this.error=e.message;cx.notify();}});
  }
  // An action a pack offers for this story (not declared by the story itself).
  offerButton(offer,t) {
    return offer.available?this.button(`offer-${offer.id}`,offer.label,cx=>this.offerAct(offer,cx),t)
      :this.disabledButton(`offer-${offer.id}`,offer.label,t);
  }
  // An action the story declares itself.
  actionButton(row,action,t) {
    return this.actionBlocked(row,action)?this.disabledButton(`action-${action.id}`,action.label,t):this.button(`action-${action.id}`,action.label,cx=>{
      this.review=null;
      if(action.handler==='answer_decision'||action.choice){this.pick=action;cx.notify();} else this.actionReview(action,cx);
    },t);
  }
  // One wrapping row of action buttons (story-declared ones and pack offers), with a line under it for each that cannot run.
  // min_w(0) lets a label longer than the pane wrap inside its button instead of running off the edge.
  actionRow(row,items,t) {
    const blocked=items.map(item=>[item.label,item.pack?(item.available?null:item.reason):this.actionBlocked(row,item)]).filter(([,reason])=>reason);
    return v_flex().gap(3)
      .child(h_flex().flex_wrap().gap(5).children(items.map(item=>(item.pack?this.offerButton(item,t):this.actionButton(row,item,t)).min_w(0))))
      .children(blocked.map(([label,reason])=>div().text_size(10).text_color(t.dim).child(`${label} is unavailable: ${reason}`)));
  }
  checkbox(id,label,on,fn,t) {
    return h_flex().id(id).gap(6).items_center().cursor_pointer().on_click((_e,cx)=>fn(cx))
      .child(div().w(13).h(13).flex_none().rounded(3).border(1).border_color(on?t.accent:t.muted).bg(on?t.accent:t.surface).flex().items_center().justify_center().text_size(10).text_color(t.background).child(on?'✓':''))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).child(label));
  }
  disabledButton(id,label,t) { return div().id(id).px(8).py(5).rounded(5).border(1).border_color(t.border).text_color(t.dim).child(label); }
  button(id,label,fn,t,on=false) { return div().id(id).px(8).py(5).rounded(5).cursor_pointer().bg(on?t.selected:t.raised).text_color(on?t.foreground:t.muted).hover(s=>s.bg(t.hover)).on_click((_e,cx)=>fn(cx)).child(label); }
  // Text only wraps once its box may be narrower than the text: a flex item needs min_w(0) for that.
  detailText(text,size,color,t) {
    return h_flex().flex_wrap().text_size(size).text_color(color).children(splitDetailLinks(text).map(part=>{
      const span=div().min_w(0).child(part.text);
      return part.url||part.path?span.text_color(t.accent).underline().cursor_pointer()
        .on_click((_e,cx)=>{cx.stop_propagation();if(part.path) this.openLocalPath(part.path,cx); else if(isHttpUrl(part.url)) cx.open_url(part.url);}):span;
    }));
  }
  detailLink(row,link,t) {
    const destination=link.url??link.path;
    const value=div().min_w(0).child(destination);
    if(link.path||isHttpUrl(destination)) value.text_color(t.accent).underline().cursor_pointer()
      .on_click((_e,cx)=>{cx.stop_propagation();if(link.path) this.openLocalPath(link.path,cx); else cx.open_url(destination);});
    // What packs offer on this link, then what the story itself declares for it.
    const actions=[...(row.offers??[]).filter(offer=>offer.link===link.id),...(row.story.actions??[]).filter(action=>actionLink(action,row.story)===link.id)];
    return v_flex().gap(3)
      .child(h_flex().flex_wrap().text_size(11).text_color(t.muted)
        .child(div().min_w(0).child(`${link.label}${link.role?` (${link.role})`:''}: `)).child(value))
      .when(Boolean(actions.length),el=>el.child(this.actionRow(row,actions,t).text_size(11)));
  }
  render(cx) {
    const t=theme(),shown=this.filtered(),g=groups(shown),selected=this.selected(),unread=this.rows.filter(r=>!r.state.read_at).length;
    const groupNodes=[];
    for(const group of g) {
      if(group.items.length>1) groupNodes.push(h_flex().px(10).py(5).gap(6).bg(t.chrome).text_size(11).text_color(t.muted)
        .child(`${group.source} · ${group.kind} · ${group.items.length} stories · ${group.outstanding} actions`));
      for(const row of group.items) {
        const s=row.story,st=row.state,on=this.sel===s.id;
        groupNodes.push(v_flex().id(`story-${s.id}`).px(10).py(8).gap(3).bg(on?t.selected:t.surface).border_b(1).border_color(t.border).cursor_pointer().hover(el=>el.bg(t.hover))
          .on_click((_e,cx)=>{this.sel=s.id;this.detail=true;this.review=null;this.pick=null;this.deleteConfirm=null;this.handle.focus();cx.notify();})
          .child(h_flex().gap(6).items_center().child(div().w(34).text_size(10).text_color(palette(s.severity,t)).child(severityLabel(s.severity)))
            .child(div().flex_1().truncate().font_semibold().text_color(st.read_at?t.muted:t.foreground).child(s.title))
            .child(div().text_size(10).text_color(t.dim).child(relativeTime(s.occurred_at))))
          .child(div().text_size(11).text_color(t.muted).child(`${s.source.label} · ${s.kind}${s.outcome?` · ${s.outcome}`:''}${st.done_at?' · done':''}${(row.badges??[]).map(badge=>` · ${badge.label}`).join('')}`))
          .child(div().text_size(11).text_color(t.muted).truncate().child(s.summary)));
      }
    }
    const filterChoices=choices(this.rows,this.filterField).filter(Boolean);
    const filterPicker=this.filterPicker?v_flex().gap(5)
      .child(h_flex().gap(5).children([
        this.button('view-inbox','Inbox',cx=>this.selectView(true,cx),t,this.filter.inbox),
        this.button('view-active','Active unfinished',cx=>this.selectView(false,cx),t,!this.filter.inbox&&!this.filter.states.length)
      ]))
      .child(div().text_size(10).text_color(t.dim).child('States (AND): 1–4 toggle'))
      .child(h_flex().gap(5).children(STATES.map((state,i)=>this.button(`state-${i}`,`${i+1} ${state}`,cx=>this.changeFilter('states',state,cx),t,this.filter.states.includes(state)))))
      .child(h_flex().gap(5).children(['source','kind','severity','subject'].map(field=>this.button(`field-${field}`,`${field}${this.filter[field].length?` (${this.filter[field].length})`:''}`,cx=>{this.filterField=field;cx.notify();},t,this.filterField===field))))
      .child(v_flex().h(120).overflow_y_scrollbar().gap(3).children(filterChoices.length?filterChoices.map(value=>this.button(`filter-${this.filterField}-${value}`,this.filterField==='severity'?severityLabel(value):value,cx=>this.changeFilter(this.filterField,value,cx),t,this.filter[this.filterField].includes(value))):[div().text_size(10).text_color(t.dim).child('No values yet')])):null;
    const header=v_flex().px(10).py(8).gap(7).bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().items_center().gap(6).child(div().flex_1().font_semibold().text_size(15).text_color(t.foreground).child('Trough'))
        .child(div().text_size(11).text_color(t.muted).child(`${unread} unread`))
        .when(this.rejected>0,el=>el.child(div().text_size(11).text_color(t.blocked).child(`${this.rejected} rejected`)))
        .child(this.button('allow-toggle',`Always allowed${this.allowed.length?` (${this.allowed.length})`:''}`,cx=>{this.allowView=!this.allowView;cx.notify();},t,this.allowView))
        .child(this.button('refresh','↻',cx=>this.reload(cx),t)))
      .child(h_flex().gap(5).items_center()
        .child(this.button('filter-toggle','f Filters',cx=>{this.filterPicker=!this.filterPicker;cx.notify();},t,this.filterPicker))
        .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(this.filterSummary()))
        .child(this.button('filter-clear','x Clear',cx=>this.clearFilters(cx),t)))
      .when(Boolean(filterPicker),el=>el.child(filterPicker))
      .when(this.allowView,el=>el.child(v_flex().gap(5).p(8).rounded(6).border(1).border_color(t.border).bg(t.surface)
        .child(div().text_size(10).text_color(t.dim).child(this.allowed.length?'These actions run without a review sheet, for every story. Each run still leaves a receipt.':'No action is always allowed. Tick "Always allow" on the review sheet of an action a pack offers.'))
        .children(this.allowed.map(item=>h_flex().gap(6).items_center()
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(div().text_size(11).text_color(t.foreground).child(item.effects[0]??item.label??item.key))
            .child(div().text_size(10).text_color(item.state==='active'?t.dim:t.working).child(`${item.key}${item.at?` · allowed ${relativeTime(item.at)}`:''}${item.state==='active'?'':` · asks again: ${item.reason}`}`)))
          .child(this.button(`allow-revoke-${item.key}`,'Revoke',cx=>this.revokeAllowed(item.key,cx),t))))))
      .when(Boolean(this.producers.length||this.producerSetupError),el=>el.child(div().text_size(10).text_color(this.producerSetupError?t.blocked:t.dim)
        .child(this.producerSetupError?`Producer: ${this.producerSetupError}`:this.producers.map(item=>{
          const status=this.producerHealth.get(item.id);
          return `${item.name}: ${status?.last_run?`last ${relativeTime(status.last_run)}`:'waiting'}${status?.last_error?` · error: ${status.last_error}`:''}`;
        }).join('  ·  '))))
      .children(this.packs.flatMap(pack=>pack.user_handler?.state==='stopped'?[]:pack.problems.map(problem=>div().text_size(10).text_color(t.blocked).child(`Pack ${pack.name}: ${problem}`))))
      .children(this.packs.filter(pack=>pack.user_handler?.state==='stopped').map(pack=>v_flex().gap(4)
        .child(div().text_size(10).text_color(t.blocked).child(`Your open handler is not used: ${pack.user_handler.why}`))
        .child(h_flex().gap(5).text_size(11)
          .child(this.button('handler-on','Use it',cx=>this.handlerDecision('on',cx),t))
          .child(this.button('handler-off','Turn off',cx=>this.handlerDecision('off',cx),t)))))
      .when(this.search||this.input.value(),el=>el.child(h_flex().h(27).bg(t.background).rounded(5).px(6).child(Input.new(this.input).flex_1().min_w(0).text_size(12).text_color(t.foreground))));
    const latest=this.receipts.find(r=>r.story_id===selected?.story.id);
    // Actions that belong to no link; the others sit under their link.
    const loose=selected&&[...(selected.story.actions??[]).filter(action=>!actionLink(action,selected.story)),...(selected.offers??[]).filter(offer=>!offer.link)];
    const detail=selected&&this.detail?v_flex().px(12).py(10).gap(8).bg(t.background).border_t(1).border_color(t.border)
      .child(h_flex().items_start().gap(6).child(div().flex_1().min_w(0).font_semibold().text_color(t.foreground).child(selected.story.title))
        .child(this.button('detail-close','×',cx=>{this.detail=false;cx.notify();},t).flex_none()))
      .child(div().text_size(11).text_color(t.muted).child(`${severityLabel(selected.story.severity)} · ${selected.story.source.label} · ${localTime(selected.story.occurred_at)} · ${selected.story.id}`))
      .child(this.detailText(selected.story.summary,12,t.foreground,t))
      .when(Boolean(selected.story.decision),el=>el.child(this.detailText(selected.story.decision.prompt,12,t.accent,t)))
      .children((selected.story.links??[]).map(l=>this.detailLink(selected,l,t)))
      .when(Boolean(latest),el=>el.child(div().text_size(11).text_color(latest.outcome==='failed'?t.blocked:t.muted).child(`Last action: ${latest.outcome}${latest.result?` · ${latest.result}`:''}`)))
      .when(Boolean(loose?.length),el=>el.child(this.actionRow(selected,loose,t)))
      .when(Boolean(this.pick&&selected.story.decision),el=>el.child(v_flex().gap(4)
        .child(div().text_color(t.muted).child('Choose an answer to review:'))
        .when(Boolean(selected.story.decision.allow_comment),el=>el.child(h_flex().h(27).bg(t.surface).rounded(5).px(6).child(Input.new(this.commentInput).flex_1().min_w(0).text_size(12).text_color(t.foreground))))
        .children(selected.story.decision.options.map(o=>this.button(`option-${o.id}`,`${o.label}: ${o.answer_text}`,cx=>this.actionReview(this.pick,cx,o.id),t)))))
      .when(Boolean(this.review),el=>el.child(v_flex().gap(5).p(10).rounded(6).border(1).border_color(t.accent).bg(t.raised)
        .child(div().font_semibold().text_color(t.foreground).child('Review action'))
        .child(div().text_size(11).text_color(t.muted).child(`Source claim: ${this.review.source.label} · ${this.review.source.id}`))
        .child(div().text_size(11).text_color(t.muted).child(this.review.offered_by==='story'?'Action declared by the story':`Action offered by pack ${this.review.offered_by}${this.review.offer?`: ${this.review.offer.label}`:''}`))
        .children(this.review.plan.effects.map((effect,i)=>div().text_size(11).text_color(t.foreground).child(`${i+1}. ${effect}`)))
        .when(Boolean(this.review.always_allow),el=>el
          .when(this.review.always_allow.state==='changed',el=>el.child(div().text_size(11).text_color(t.working).child('You always allowed this, but its handler changed since. Confirm to keep allowing it.')))
          .child(this.checkbox('always-allow',`Always allow: ${this.review.always_allow.effects[0]??this.review.offer?.label}`,this.alwaysAllow,cx=>{this.alwaysAllow=!this.alwaysAllow;cx.notify();},t))
          .child(div().pl(19).text_size(10).text_color(t.dim).child(`Later clicks run at once, for every story (${this.review.always_allow.key}). Revoke under Always allowed.`)))
        .child(h_flex().gap(6)
          .child(this.button('confirm-action',this.running?'Running…':'Confirm action',cx=>this.runReview(cx),t,true))
          .child(this.button('cancel-action','Cancel',cx=>{this.review=null;cx.notify();},t)))))
      .when(this.deleteConfirm===selected.story.id,el=>el.child(v_flex().gap(5).p(10).rounded(6).border(1).border_color(t.blocked).bg(t.raised)
        .child(div().font_semibold().text_color(t.foreground).child('Delete this story from Trough?'))
        .child(div().text_size(11).text_color(t.muted).child('Its story, state, reviews, and receipts will be removed. The same ID is blocked from reappearing for 365 days.'))
        .when(selected.story.kind==='decision'&&Boolean(selected.story.decision?.options.length),el=>el.child(div().text_size(11).text_color(t.muted).child('Deleting this open decision only hides it from Trough; it does not answer the decision.')))
        .child(h_flex().gap(6)
          .child(this.button('confirm-delete',this.deleting?'Deleting…':'Delete story',cx=>this.deleteSelected(cx),t,true))
          .child(this.button('cancel-delete','Cancel',cx=>{this.deleteConfirm=null;cx.notify();},t)))))
      .child(h_flex().gap(6)
        .child(this.button('mark-read',selected.state.read_at?'Unread':'Read',cx=>this.act(selected.state.read_at?'unread':'read',cx),t))
        .child(this.button('mark-done',selected.state.done_at?'Undo':'Done',cx=>this.act(selected.state.done_at?'undo':'done',cx),t))
        .child(this.button('snooze','Snooze 1h',cx=>this.act('snooze',cx,['--until',new Date(Date.now()+3600000).toISOString()]),t))
        .child(this.button('delete-story','Delete',cx=>this.confirmDelete(cx),t))):null;
    return v_flex().id('trough-root').track_focus(this.handle).size_full().min_h(0).bg(t.background).text_size(12)
      .on_key_down((e,cx)=>this.keys(e,cx)).on_mouse_down('left',()=>this.handle.focus())
      .child(header)
      .when(Boolean(this.error),el=>el.child(div().px(10).py(6).text_color(t.blocked).child(this.error)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().children(groupNodes.length?groupNodes:[div().p(12).text_color(t.muted).child('No stories in this view')]))
      .when(Boolean(detail),el=>el.child(detail))
      .child(div().px(10).py(5).text_size(10).text_color(t.dim).child('j/k move · Enter detail · / search · f filters · x clear · r read · d done · D delete · z snooze · a review action'));
  }
}
