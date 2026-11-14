import { View, div, svg, image } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input, TextView, Popover, ScrollHandle } from 'gpui-base';
import { exec, watchFolder, theme, home, appHome, props, nextCommand } from 'herdr';
import { STATES, visible, cards, choices } from './feed.js';
import { ProducerSchedule } from './producer-schedule.js';
import { localTime, relativeTime } from './time.js';
import { severityLabel } from './severity-label.js';
import { isHttpUrl, splitDetailLinks, actionLink, linkTarget } from './links.js';
import { safeMarkdown } from './markdown.js';

const palette=(severity,t)=>severity==='critical'?t.blocked:severity==='warning'?t.working:severity==='notice'?t.accent:t.muted;
// Herdr rewrites this prefix when the mod is cloned under another name.
const ICONS='mods/trough/icons';
const ROLE_ICON={report:'doc',document:'doc',source:'doc',log:'log',pr:'pr',issue:'pr',screenshot:'image'};
// The summary is clamped to two lines of LINE pixels, so the cut always falls between lines.
// line_height takes a length string: a bare number is a multiplier of the text size.
const LINE=17,LINE_HEIGHT=`${LINE}px`,LEDE_LINES=2;
const THUMB_W=64,THUMB_H=44,IMAGE_MAX_H=220;
const isChoice=action=>action.handler==='answer_decision'||Boolean(action.choice);
const message=error=>String(error?.message??error).slice(0,300);

export default class Trough extends View {
  init(_props,cx) {
    this.dir=props()?.dir || `${home()}/.local/state/trough`;
    this.cli=`${appHome()}/mods/trough/bin/trough`;
    this.handle=cx.focus_handle(); this.scroll=ScrollHandle.new(); this.rows=[]; this.rejected=0; this.sel=null; this.filter={inbox:true,states:[],source:[],kind:[],severity:[],subject:[]}; this.filterPicker=false; this.filterField='source';
    this.search=false; this.typing=false; this.error=null; this.pick=null; this.review=null; this.receipts=[]; this.deleteConfirm=null; this.deleting=false;
    // Cards: which are open, which groups show their earlier stories, which card the pointer is on,
    // the open menu ({id, link?}) and its keyboard row, and each summary's natural height.
    this.expanded=new Set(); this.groupOpen=new Set(); this.hovered=null; this.menu=null; this.menuIndex=0; this.measured=new Map(); this.width=420;
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
  // --app-home tells the CLI which Herdr home this pane loads images from.
  async call(args) { const r=await exec('node',[this.cli,'--dir',this.dir,'--app-home',appHome(),...args],{timeout:args[0]==='produce'?120000:30000}); if(r.code!==0) throw new Error(r.stderr.trim()||`trough exited ${r.code}`); return r.stdout; }
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
    this.deleteConfirm=id; this.review=null; this.pick=null; cx.notify();
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
  // A destination written out in full: a path opens through `trough open` (with a receipt), a web link in the browser.
  openLink(link,cx) {
    if(link.path) this.openLocalPath(link.path,cx);
    else if(isHttpUrl(link.url)) cx.open_url(link.url);
  }
  // A link chip or a picture runs the core pack's Open offer for that link: at once when it is always
  // allowed, else through the review sheet. Without the offer (the core pack is off) it opens as written.
  openChip(row,link,cx) {
    const offer=(row.offers??[]).find(item=>item.link===link.id&&['open_url','open_file'].includes(item.handler));
    this.choose(row.story.id);
    if(offer?.available) this.offerAct(offer,cx); else this.openLink(link,cx);
  }
  // A link inside a story body. Only web links and absolute paths open; the CLI checks the path is in the story.
  openBodyLink(id,url,cx) {
    const target=linkTarget(url);
    this.choose(id);
    if(target?.url) cx.open_url(target.url);
    else if(target?.path) this.openLocalPath(target.path,cx);
    else { this.error=`Trough opens only web links and absolute paths, not ${url.slice(0,200)}`; cx.notify(); }
  }
  filtered() { return visible(this.rows,{...this.filter,text:this.input.value()}); }
  cardList() { return cards(this.filtered(),this.groupOpen); }
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
  // The selection is always a card on screen; a story inside a closed group gives way to the first card.
  alignSelection() {
    const shown=this.cardList();
    if(!shown.some(c=>c.row.story.id===this.sel)) this.sel=shown[0]?.row.story.id??null;
    if(this.deleteConfirm!==this.sel) this.deleteConfirm=null;
    if(this.menu&&!shown.some(c=>c.row.story.id===this.menu.id)) this.menu=null;
  }
  selected() { return this.filtered().find(r=>r.story.id===this.sel); }
  // Selecting another card drops the sheets that belonged to the last one.
  choose(id) {
    if(this.sel!==id) { this.sel=id; this.review=null; this.pick=null; this.deleteConfirm=null; }
    if(this.menu&&this.menu.id!==id) this.menu=null;
  }
  move(delta,cx) {
    const list=this.cardList(); if(!list.length) return;
    const index=list.findIndex(c=>c.row.story.id===this.sel);
    const next=Math.max(0,Math.min(list.length-1,index+delta));
    this.choose(list[next].row.story.id); this.scroll.scroll_to_item(next); cx.notify();
  }
  jump(index,cx) { const list=this.cardList(); if(!list.length) return; const i=index<0?list.length-1:0; this.choose(list[i].row.story.id); this.scroll.scroll_to_item(i); cx.notify(); }
  toggleExpand(id,cx) { if(!id) return; this.expanded.has(id)?this.expanded.delete(id):this.expanded.add(id); cx.notify(); }
  toggleGroup(key,cx) { this.groupOpen.has(key)?this.groupOpen.delete(key):this.groupOpen.add(key); this.alignSelection(); cx.notify(); }
  primaryAction(story) { return (story.actions??[]).find(action=>!isChoice(action))??null; }
  choiceAction(row) { return (row.story.actions??[]).find(action=>isChoice(action)&&!this.actionBlocked(row,action))??(row.story.actions??[]).find(isChoice)??null; }
  // `a`: the story's first action that can run, declared first, then offered.
  reviewFirst(cx) {
    const row=this.selected(),action=row?.story.actions?.find(item=>!this.actionBlocked(row,item))??row?.offers?.find(item=>item.available);
    if(!action) return;
    if(isChoice(action)) { this.pick=action; cx.notify(); }
    else if(action.pack) this.offerAct(action,cx);
    else this.actionReview(action,cx);
  }
  answer(row,index,cx) {
    const action=this.choiceAction(row),option=row.story.decision?.options[index];
    if(!action||!option||this.actionBlocked(row,action)) return;
    this.choose(row.story.id); this.review=null; this.actionReview(action,cx,option.id);
  }
  keys(e,cx) {
    if(this.typing||this.commentTyping) { if(e.key==='escape'){this.handle.focus();cx.notify();} return; }
    const k=e.key;
    if(this.menu) {
      const items=this.menuItems(),usable=items.map((item,i)=>item.sep?-1:i).filter(i=>i>=0);
      const at=usable.indexOf(this.menuIndex);
      if(k==='j'||k==='down') { this.menuIndex=usable[Math.min(usable.length-1,at+1)]??0; cx.notify(); return; }
      if(k==='k'||k==='up') { this.menuIndex=usable[Math.max(0,at-1)]??0; cx.notify(); return; }
      if(k==='enter') { const item=items[this.menuIndex]; this.menu=null; if(item&&!item.sep&&!item.disabled) item.run(cx); cx.notify(); return; }
      this.menu=null;
      if(k==='escape') { cx.notify(); return; }
    }
    if(k==='j'||k==='down') this.move(1,cx);
    else if(k==='k'||k==='up') this.move(-1,cx);
    else if(k==='g'||k==='home') this.jump(0,cx);
    else if(k==='shift-g'||k==='end') this.jump(-1,cx);
    else if(k==='/') {this.search=true;this.input.focus();cx.notify();}
    else if(k==='f') {this.filterPicker=!this.filterPicker;cx.notify();}
    else if(k==='x') this.clearFilters(cx);
    else if(this.filterPicker && ['1','2','3','4'].includes(k)) this.changeFilter('states',STATES[Number(k)-1],cx);
    else if(/^[1-9]$/.test(k)) { const row=this.selected(); if(row?.story.decision) this.answer(row,Number(k)-1,cx); }
    else if(k==='enter') this.toggleExpand(this.sel,cx);
    else if(k==='.') { if(this.sel) this.openMenu({id:this.sel},cx); }
    else if(k==='o') { const row=this.selected(),links=row?.story.links??[],link=links.find(l=>l.id!==row?.media?.link)??links[0]; if(link) this.openChip(row,link,cx); }
    else if(k==='escape') {
      const open=Boolean(this.review||this.pick||this.deleteConfirm||this.filterPicker||this.search||this.allowView);
      this.search=false;this.filterPicker=false;this.allowView=false;this.review=null;this.pick=null;this.deleteConfirm=null;
      if(!open) this.expanded.delete(this.sel);
      cx.notify();
    }
    else if(k==='r') this.act(this.selected()?.state.read_at?'unread':'read',cx);
    else if(k==='d') this.act(this.selected()?.state.done_at?'undo':'done',cx);
    else if(k==='shift-d') this.confirmDelete(cx);
    else if(k==='z') this.act('snooze',cx,['--until',new Date(Date.now()+3600000).toISOString()]);
    else if(k==='a') this.reviewFirst(cx);
  }
  // The CLI reports why an action cannot run (handler not installed, tool missing); such an action is shown but cannot be clicked.
  actionBlocked(row,action) { if(action.pack) return action.available?null:action.reason||'unavailable'; const status=row.action_status?.[action.id]; return status&&!status.available?status.reason||'unavailable':null; }
  // Your own open handler changed or stopped passing its checks: it is not run until you decide.
  handlerDecision(command,cx) {
    cx.spawn(async cx=>{try {await this.call(['handler',command]); await this.reload(cx);} catch(e){this.error=e.message;cx.notify();}});
  }

  // ---- menus: the story's ⋯ menu and each link chip's ▾ menu, as rows the keyboard can walk
  openMenu(menu,cx) {
    this.choose(menu.id); this.menu=menu;
    this.menuIndex=Math.max(0,this.menuItems().findIndex(item=>!item.sep&&!item.disabled)); cx.notify();
  }
  runDeclared(row,action,cx) { this.choose(row.story.id); this.review=null; if(isChoice(action)) { this.pick=action; cx.notify(); } else this.actionReview(action,cx); }
  runOffer(row,offer,cx) { this.choose(row.story.id); this.offerAct(offer,cx); }
  linkItems(row,linkId) {
    const s=row.story;
    return [...(row.offers??[]).filter(offer=>offer.link===linkId).map(offer=>({label:offer.label,disabled:this.actionBlocked(row,offer),run:cx=>this.runOffer(row,offer,cx)})),
      ...(s.actions??[]).filter(action=>actionLink(action,s)===linkId).map(action=>({label:action.label,disabled:this.actionBlocked(row,action),run:cx=>this.runDeclared(row,action,cx)}))];
  }
  storyItems(row) {
    const s=row.story,st=row.state,primary=this.primaryAction(s),items=[];
    const declared=(s.actions??[]).filter(action=>action!==primary&&!isChoice(action)&&!actionLink(action,s));
    for(const action of declared) items.push({label:action.label,disabled:this.actionBlocked(row,action),run:cx=>this.runDeclared(row,action,cx)});
    for(const link of s.links??[]) for(const item of this.linkItems(row,link.id)) items.push({...item,label:`${item.label}: ${link.label}`});
    for(const offer of (row.offers??[]).filter(offer=>!offer.link)) items.push({label:offer.label,disabled:this.actionBlocked(row,offer),run:cx=>this.runOffer(row,offer,cx)});
    if(items.length) items.push({sep:true});
    const at=(command,extra)=>cx=>{this.choose(s.id);this.act(command,cx,extra);};
    items.push({label:st.read_at?'Mark unread':'Mark read',hint:'r',run:at(st.read_at?'unread':'read')},
      {label:st.done_at?'Undo done':'Done',hint:'d',run:at(st.done_at?'undo':'done')},
      {label:'Snooze 1 hour',hint:'z',run:at('snooze',['--until',new Date(Date.now()+3600000).toISOString()])},
      {label:'Delete…',hint:'D',run:cx=>{this.choose(s.id);this.confirmDelete(cx);}});
    return items;
  }
  menuItems() {
    const row=this.menu&&this.filtered().find(r=>r.story.id===this.menu.id);
    return !row?[]:this.menu.link?this.linkItems(row,this.menu.link):this.storyItems(row);
  }
  menuContent(t) {
    const items=this.menuItems();
    return v_flex().min_w(200).max_w(320).p(4).gap(1).rounded(7).border(1).border_color(t.border).bg(t.popover).text_size(12)
      .children(items.map((item,i)=>item.sep?div().h(1).my(3).mx(2).bg(t.border):v_flex().id(`menu-row-${i}`).px(8).py(4).rounded(4)
        .when(i===this.menuIndex&&!item.disabled,el=>el.bg(t.hover))
        .when(!item.disabled,el=>el.cursor_pointer().hover(s=>s.bg(t.hover)).on_click((_e,cx)=>{cx.stop_propagation();this.menu=null;item.run(cx);this.handle.focus();cx.notify();}))
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).text_color(item.disabled?t.dim:t.foreground).child(item.label))
          .when(Boolean(item.hint),el=>el.child(div().text_size(10).text_color(t.dim).child(item.hint))))
        .when(Boolean(item.disabled),el=>el.child(div().text_size(10).text_color(t.dim).child(`Unavailable: ${item.disabled}`)))));
  }
  // A controlled Popover. The keyboard stays with the pane, which walks the rows itself.
  menuPopover(menu,trigger,anchor,t) {
    const open=Boolean(this.menu&&this.menu.id===menu.id&&(this.menu.link??null)===(menu.link??null));
    return Popover.new(`menu-${menu.id}-${menu.link??'story'}`).anchor(anchor).track_focus(this.handle).open(open)
      .on_open_change((value,cx)=>{ if(value) this.openMenu(menu,cx); else { if(open) this.menu=null; cx.notify(); } })
      .trigger(trigger).content(open?this.menuContent(t):div());
  }

  // ---- pieces of a card
  checkbox(id,label,on,fn,t) {
    return h_flex().id(id).gap(6).items_center().cursor_pointer().on_click((_e,cx)=>fn(cx))
      .child(div().w(13).h(13).flex_none().rounded(3).border(1).border_color(on?t.accent:t.muted).bg(on?t.accent:t.surface).flex().items_center().justify_center().text_size(10).text_color(t.background).child(on?'✓':''))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.foreground).child(label));
  }
  disabledButton(id,label,t) { return div().id(id).px(8).py(5).rounded(5).border(1).border_color(t.border).text_color(t.dim).child(label); }
  button(id,label,fn,t,on=false) { return div().id(id).px(8).py(5).rounded(5).cursor_pointer().bg(on?t.selected:t.raised).text_color(on?t.foreground:t.muted).hover(s=>s.bg(t.hover)).on_click((_e,cx)=>fn(cx)).child(label); }
  // An icon is tinted with the text color around it unless a color is given.
  icon(name,size,color) { const el=svg(`${ICONS}/${name}.svg`).w(size).h(size).flex_none(); return color?el.text_color(color):el; }
  iconButton(id,name,label,fn,t) {
    return div().id(id).w(20).h(20).flex().flex_none().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
      .hover(s=>s.bg(t.hover).text_color(t.foreground)).tooltip(label).accessibility_label(label)
      .on_click((_e,cx)=>{cx.stop_propagation();this.handle.focus();fn(cx);cx.notify();}).child(svg(`${ICONS}/${name}.svg`).w(14).h(14));
  }
  // Text only wraps once its box may be narrower than the text: a flex item needs min_w(0) for that.
  // A click on a path selects the card first: `trough open` checks the path against the selected story.
  detailText(text,size,color,t,id) {
    return h_flex().flex_wrap().text_size(size).text_color(color).children(splitDetailLinks(text).map(part=>{
      const span=div().min_w(0).child(part.text);
      return part.url||part.path?span.text_color(t.accent).underline().cursor_pointer()
        .on_click((_e,cx)=>{cx.stop_propagation();this.choose(id);if(part.path) this.openLocalPath(part.path,cx); else if(isHttpUrl(part.url)) cx.open_url(part.url);cx.notify();}):span;
    }));
  }
  // Done, Snooze, Read and ⋯: in the header line, in place of the time, while the card is hovered or selected.
  filing(row,t) {
    const s=row.story,st=row.state,at=(command,extra)=>cx=>{this.choose(s.id);this.act(command,cx,extra);};
    return h_flex().flex_none().gap(1).items_center()
      .child(this.iconButton(`done-${s.id}`,'check',st.done_at?'Undo done (d)':'Done (d)',at(st.done_at?'undo':'done'),t))
      .child(this.iconButton(`snooze-${s.id}`,'clock','Snooze 1 hour (z)',at('snooze',['--until',new Date(Date.now()+3600000).toISOString()]),t))
      .child(this.iconButton(`read-${s.id}`,'mail',st.read_at?'Mark unread (r)':'Mark read (r)',at(st.read_at?'unread':'read'),t))
      .child(this.menuPopover({id:s.id},div().id(`more-${s.id}`).w(20).h(20).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
        .hover(x=>x.bg(t.hover).text_color(t.foreground)).tooltip('More (.)').accessibility_label('More actions').child(svg(`${ICONS}/more.svg`).w(14).h(14)),'top_right',t));
  }
  // A link: its role's icon and label. A click opens it; ▾ lists what can be done with it.
  chip(row,link,t) {
    const id=row.story.id,items=this.linkItems(row,link.id),destination=link.url??link.path;
    const body=h_flex().id(`chip-${id}-${link.id}`).min_w(0).h(20).gap(4).items_center().pl(6).pr(items.length?4:6).cursor_pointer().tooltip(destination)
      .on_click((_e,cx)=>{cx.stop_propagation();this.openChip(row,link,cx);cx.notify();})
      .child(this.icon(ROLE_ICON[link.role]??(link.url?'link':'doc'),12)).child(div().min_w(0).truncate().child(link.label));
    const caret=div().id(`chip-menu-${id}-${link.id}`).h(20).px(3).flex().items_center().border_l(1).border_color(t.border).cursor_pointer().hover(x=>x.bg(t.hover))
      .tooltip(`Actions for ${link.label}`).accessibility_label(`Actions for ${link.label}`).child(svg(`${ICONS}/chevron-down.svg`).w(12).h(12));
    return h_flex().min_w(0).max_w(260).rounded(5).bg(t.raised).text_size(11).text_color(t.muted).hover(x=>x.text_color(t.foreground))
      .child(body).when(Boolean(items.length),el=>el.child(this.menuPopover({id,link:link.id},caret,'top_left',t)));
  }
  thumbnail(row,link,t) {
    const m=row.media,scale=Math.min(1,THUMB_W/m.width,THUMB_H/m.height);
    return div().id(`thumb-${row.story.id}`).flex_none().w(THUMB_W).h(THUMB_H).rounded(5).border(1).border_color(t.border).bg(t.background).overflow_hidden()
      .flex().items_center().justify_center().cursor_pointer().tooltip(link?.label??'Image')
      .on_click((_e,cx)=>{cx.stop_propagation();if(link) this.openChip(row,link,cx);cx.notify();})
      .child(image(m.src).w(Math.max(1,Math.round(m.width*scale))).h(Math.max(1,Math.round(m.height*scale))));
  }
  fullImage(row,link,inner,t) {
    const m=row.media,width=Math.max(40,Math.min(inner,m.width,IMAGE_MAX_H*m.width/m.height)),height=width*m.height/m.width;
    return div().id(`image-${row.story.id}`).flex_none().rounded(6).overflow_hidden().border(1).border_color(t.border).cursor_pointer().tooltip(`${link?.label??'Image'}: click to open`)
      .on_click((_e,cx)=>{cx.stop_propagation();if(link) this.openChip(row,link,cx);cx.notify();})
      .child(image(m.src).w(Math.round(width)).h(Math.round(height)));
  }
  decisionBlock(row,on,t) {
    const s=row.story,d=s.decision,action=this.choiceAction(row),blocked=action&&this.actionBlocked(row,action);
    const options=action?d.options:[];
    return v_flex().gap(5).p(8).rounded(6).bg(t.raised)
      .child(this.detailText(d.prompt,12,t.accent,t,s.id).line_height(LINE_HEIGHT))
      .when(Boolean(on&&action&&!blocked&&d.allow_comment),el=>el.child(h_flex().h(27).bg(t.surface).rounded(5).px(6).child(Input.new(this.commentInput).flex_1().min_w(0).text_size(12).text_color(t.foreground))))
      .when(Boolean(options.length),el=>el.child(h_flex().flex_wrap().gap(5).children(options.map((option,i)=>{
        const label=`${on&&i<9?`${i+1}  `:''}${option.label}`;
        return blocked?div().id(`option-${s.id}-${option.id}`).px(7).py(3).rounded(5).border(1).border_color(t.border).text_size(11.5).text_color(t.dim).child(label)
          :div().id(`option-${s.id}-${option.id}`).px(7).py(3).rounded(5).bg(t.surface).border(1).border_color(t.border).text_size(11.5).text_color(t.foreground).cursor_pointer()
            .hover(x=>x.bg(t.hover)).tooltip(option.answer_text).on_click((_e,cx)=>{cx.stop_propagation();this.answer(row,i,cx);});
      }))))
      .when(Boolean(blocked),el=>el.child(div().text_size(10).text_color(t.dim).child(`${action.label} is unavailable: ${blocked}`)))
      .when(Boolean(on&&this.pick&&options.length&&!blocked),el=>el.child(div().text_size(10).text_color(t.dim).child(`Press 1-${Math.min(9,options.length)} or click an answer to review it.`)));
  }
  reviewSheet(t) {
    return v_flex().gap(5).p(10).rounded(6).border(1).border_color(t.accent).bg(t.raised)
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
        .child(this.button('cancel-action','Cancel',cx=>{this.review=null;cx.notify();},t)));
  }
  deleteSheet(story,t) {
    return v_flex().gap(5).p(10).rounded(6).border(1).border_color(t.blocked).bg(t.raised)
      .child(div().font_semibold().text_color(t.foreground).child('Delete this story from Trough?'))
      .child(div().text_size(11).text_color(t.muted).child('Its story, state, reviews, and receipts will be removed. The same ID is blocked from reappearing for 365 days.'))
      .when(story.kind==='decision'&&Boolean(story.decision?.options.length),el=>el.child(div().text_size(11).text_color(t.muted).child('Deleting this open decision only hides it from Trough; it does not answer the decision.')))
      .child(h_flex().gap(6)
        .child(this.button('confirm-delete',this.deleting?'Deleting…':'Delete story',cx=>this.deleteSelected(cx),t,true))
        .child(this.button('cancel-delete','Cancel',cx=>{this.deleteConfirm=null;cx.notify();},t)));
  }
  // The full destination of each link, shown in an open card. Paths and web links are clickable.
  linkLine(link,id,t) {
    const destination=link.url??link.path,value=div().min_w(0).child(destination);
    if(link.path||isHttpUrl(destination)) value.text_color(t.accent).underline().cursor_pointer().on_click((_e,cx)=>{cx.stop_propagation();this.choose(id);this.openLink(link,cx);cx.notify();});
    return h_flex().flex_wrap().text_size(11).text_color(t.muted).child(div().min_w(0).child(`${link.label}${link.role?` (${link.role})`:''}: `)).child(value);
  }
  card(entry,latest,t) {
    const row=entry.row,s=row.story,st=row.state,id=s.id;
    const on=this.sel===id,open=this.expanded.has(id),hot=on||this.hovered===id||this.menu?.id===id;
    const snoozed=Boolean(st.snoozed_until&&Date.parse(st.snoozed_until)>Date.now());
    const imageLink=row.media?(s.links??[]).find(link=>link.id===row.media.link):null;
    const primary=this.primaryAction(s),blocked=primary&&this.actionBlocked(row,primary);
    const extra=(s.actions??[]).filter(action=>action!==primary&&!isChoice(action)).length;
    const inner=this.width-16-22-2-(entry.nested?16:0);
    const clamp=LINE*LEDE_LINES,cut=!open&&(this.measured.get(id)??0)>clamp+1;
    const meta=`${s.source.label} · ${s.kind}${s.subject?` · ${s.subject.label||s.subject.key}`:''}${s.outcome?` · ${s.outcome}`:''}${st.done_at?' · done':''}${snoozed?' · snoozed':''}${(row.badges??[]).map(badge=>` · ${badge.label}`).join('')}`;
    const header=h_flex().h(20).gap(6).items_center()
      .child(div().flex_none().text_size(10).font_semibold().text_color(palette(s.severity,t)).child(severityLabel(s.severity)))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(meta))
      .child(hot?this.filing(row,t):div().id(`time-${id}`).flex_none().text_size(10).text_color(t.dim).tooltip(localTime(s.occurred_at)).child(relativeTime(s.occurred_at)));
    const title=h_flex().items_start().gap(6)
      .when(!st.read_at,el=>el.child(div().flex_none().mt(6).w(6).h(6).rounded_full().bg(t.accent)))
      .child(div().flex_1().min_w(0).font_semibold().text_size(13).line_height(LINE_HEIGHT).text_color(st.read_at?t.muted:t.foreground).child(s.title));
    // The summary keeps its natural height inside a clipped box, and reports it, so the pane knows whether it was cut.
    const lede=v_flex().relative().overflow_hidden().when(!open,el=>el.max_h(clamp))
      .child(v_flex().id(`lede-${id}`).flex_none().on_size_change((size,cx)=>{ if(Math.abs((this.measured.get(id)??0)-size.height)>0.5) { this.measured.set(id,size.height); cx.notify(); } })
        .child(this.detailText(s.summary,12,open?t.foreground:t.muted,t,id).line_height(LINE_HEIGHT)))
      // An element background takes one color, not a gradient: a cut summary ends in an ellipsis over its last line.
      .when(cut,el=>el.child(div().absolute().right(0).bottom(0).h(LINE).pl(6).bg(t.surface).text_size(12).line_height(LINE_HEIGHT).text_color(t.muted).child('…')));
    const text=h_flex().items_start().gap(8)
      .child(v_flex().flex_1().min_w(0).gap(3).child(title).child(lede))
      .when(Boolean(row.media&&!open),el=>el.child(this.thumbnail(row,imageLink,t)));
    const chips=(s.links??[]).filter(link=>!(row.media&&link.id===row.media.link)).map(link=>this.chip(row,link,t));
    // The last line: link chips, then the primary action, then the caret, always in the bottom-right corner.
    const actionLine=h_flex().min_h(22).gap(6).items_center()
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(4).children(chips))
      .when(Boolean(primary),el=>el.child(h_flex().id(`primary-${id}`).flex_none().h(22).px(9).gap(5).items_center().rounded(5).border(1)
        .border_color(blocked?t.border:t.accent).text_size(11.5).text_color(blocked?t.dim:t.accent)
        .child(this.icon('bolt',12)).child(primary.label)
        .when(Boolean(blocked),el=>el.tooltip(`Unavailable: ${blocked}`))
        .when(!blocked,el=>el.cursor_pointer().hover(x=>x.bg(t.hover)).tooltip('Review this action (a)').on_click((_e,cx)=>{cx.stop_propagation();this.runDeclared(row,primary,cx);}))))
      .when(extra>0,el=>el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`+${extra} in ⋯`)))
      .child(div().id(`expand-${id}`).flex_none().w(22).h(22).flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.muted)
        .hover(x=>x.bg(t.hover).text_color(t.foreground)).tooltip(open?'Show less (Enter)':'Show more (Enter)').accessibility_label(open?'Show less':'Show more')
        .on_click((_e,cx)=>{cx.stop_propagation();this.choose(id);this.handle.focus();this.toggleExpand(id,cx);})
        .child(svg(`${ICONS}/${open?'chevron-up':'chevron-down'}.svg`).w(14).h(14)));
    return v_flex().id(`story-${id}`).relative().flex_none().mx(8).when(entry.nested,el=>el.ml(24)).pl(12).pr(10).pt(5).pb(6).gap(4)
      .rounded(8).bg(t.surface).border(1).border_color(on?t.accent:t.border).when(Boolean(st.done_at||snoozed),el=>el.opacity(0.6))
      .on_hover((hovered,cx)=>{ const next=hovered?id:this.hovered===id?null:this.hovered; if(next!==this.hovered) { this.hovered=next; cx.notify(); } })
      .on_click((_e,cx)=>{this.choose(id);this.handle.focus();cx.notify();})
      .when(s.severity!=='info',el=>el.child(div().absolute().left(0).top(0).bottom(0).w(3).rounded_l(7).bg(palette(s.severity,t))))
      .child(header).child(text)
      .when(open&&Boolean(s.body),el=>el.child(TextView.markdown(`body-${id}`,safeMarkdown(s.body)).selectable(true).w_full().text_size(12).text_color(t.foreground)
        .on_link_click((url,cx)=>this.openBodyLink(id,url,cx))))
      .when(open&&Boolean(row.media),el=>el.child(this.fullImage(row,imageLink,inner,t)))
      .when(open&&Boolean(row.media_error),el=>el.child(div().text_size(10).text_color(t.dim).child(`Image not shown: ${row.media_error}`)))
      .when(open,el=>el.children((s.links??[]).map(link=>this.linkLine(link,id,t)))
        .child(div().text_size(10).text_color(t.dim).child(`${severityLabel(s.severity)} · ${s.source.label} · ${localTime(s.occurred_at)} · ${id}`)))
      .when(Boolean(s.decision),el=>el.child(this.decisionBlock(row,on,t)))
      .when(entry.earlier>0,el=>el.child(h_flex().id(`group-${id}`).gap(4).items_center().cursor_pointer().text_size(11).text_color(t.muted).hover(x=>x.text_color(t.foreground))
        .on_click((_e,cx)=>{cx.stop_propagation();this.toggleGroup(entry.key,cx);})
        .child(svg(`${ICONS}/${this.groupOpen.has(entry.key)?'chevron-down':'chevron-right'}.svg`).w(12).h(12))
        .child(`${entry.earlier} earlier${entry.outstanding?` · ${entry.outstanding} need action`:''}`)))
      .when(Boolean(latest),el=>el.child(div().min_w(0).truncate().text_size(10.5).text_color(latest.outcome==='failed'?t.blocked:t.muted).child(`Last action: ${latest.outcome}${latest.result?` · ${latest.result}`:''}`)))
      .child(actionLine)
      .when(Boolean(blocked),el=>el.child(div().text_size(10).text_color(t.dim).child(`${primary.label} is unavailable: ${blocked}`)))
      .when(on&&Boolean(this.review)&&this.review?.story_id===id,el=>el.child(this.reviewSheet(t)))
      .when(on&&this.deleteConfirm===id,el=>el.child(this.deleteSheet(s,t)));
  }
  // The kit throws while an element is built when a value has the wrong type. Building each card and the
  // header on its own keeps one bad value to the piece it is in, instead of the whole pane.
  guarded(build,fallback) { try { return build(); } catch(error) { return fallback(error); } }
  brokenCard(entry,error,t) {
    const story=entry?.row?.story,id=typeof story?.id==='string'?story.id:'',title=typeof story?.title==='string'&&story.title?story.title:id||'Story';
    return v_flex().id(`story-${id}`).flex_none().mx(8).pl(12).pr(10).py(6).gap(2).rounded(8).bg(t.surface).border(1).border_color(this.sel===id?t.accent:t.blocked)
      .on_click((_e,cx)=>{this.choose(id);this.handle.focus();cx.notify();})
      .child(div().min_w(0).truncate().font_semibold().text_size(13).text_color(t.foreground).child(title))
      .child(div().text_size(10).text_color(t.blocked).child(`This card could not be drawn: ${message(error)}`));
  }
  headerBar(t) {
    const unread=this.rows.filter(r=>!r.state.read_at).length;
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
    return v_flex().px(10).py(8).gap(7).bg(t.chrome).border_b(1).border_color(t.border)
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
  }
  render(cx) {
    const t=theme(),list=this.cardList();
    const latest=new Map(); for(const receipt of this.receipts) if(!latest.has(receipt.story_id)) latest.set(receipt.story_id,receipt);
    const header=this.guarded(()=>this.headerBar(t),error=>div().px(10).py(8).bg(t.chrome).border_b(1).border_color(t.border).text_size(11).text_color(t.blocked).child(`The header could not be drawn: ${message(error)}`));
    return v_flex().id('trough-root').track_focus(this.handle).size_full().min_h(0).bg(t.background).text_size(12)
      .on_size_change((size,cx)=>{ if(this.width!==size.width) { this.width=size.width; cx.notify(); } })
      .on_key_down((e,cx)=>this.keys(e,cx)).on_mouse_down('left',()=>this.handle.focus())
      .child(header)
      .when(Boolean(this.error),el=>el.child(div().px(10).py(6).text_color(t.blocked).child(this.error)))
      .child(v_flex().id('feed').flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).bg(t.canvas).py(8).gap(6)
        .children(list.length?list.map(entry=>this.guarded(()=>this.card(entry,latest.get(entry.row.story.id),t),error=>this.brokenCard(entry,error,t))):[div().p(12).text_color(t.muted).child('No stories in this view')]))
      .child(div().px(10).py(5).text_size(10).text_color(t.dim).border_t(1).border_color(t.border).child('j/k move · Enter open · a action · . menu · o open link · r read · d done · z snooze · D delete · / search · f filters · x clear'));
  }
}
