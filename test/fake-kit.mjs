// A stand-in for Herdr's `gpui-kit`, `gpui-base` and `herdr` modules, so a test can build the pane's
// element tree in Node. It is not a test file itself: the runner picks up *.test.mjs only.
//
// Every builder call is checked the way the real kit checks it when the element is built: a style
// argument is null, a boolean, a number, a string or a function; ids, tooltips and colors are strings;
// a child is an element, a string or a number. Two checks go further than the kit, because the kit
// accepts the value and the layout comes out wrong: a length must be a finite number, and line_height
// must be a length string, since a bare number there is a multiplier of the text size.
import { registerHooks } from 'node:module';

const ELEMENT=Symbol('element');
const fail=(method,why)=>{ throw new TypeError(`${method}: ${why}`); };
const primitive=value=>value===null||['boolean','number','string','function'].includes(typeof value);
const isElement=value=>Boolean(value?.[ELEMENT]);
const STRING_ARGS=new Set(['id','tooltip','accessibility_label','bg','text_color','border_color','text_bg']);
const LENGTHS=/^(w|h|size|min_w|max_w|min_h|max_h|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap_x|gap_y|left|right|top|bottom|inset|rounded|rounded_[a-z]+|border|border_[lrtbxy]|text_size)$/;

function checkChild(method,value) {
  if(isElement(value)||typeof value==='string'||typeof value==='number') return;
  fail(method,`expects an element, a string or a number, got ${value===null?'null':typeof value}`);
}
function checkArgs(method,args) {
  if(STRING_ARGS.has(method)&&typeof args[0]!=='string') fail(method,`expects a string, got ${args[0]===null?'null':typeof args[0]}`);
  if(['bg','text_color','border_color','text_bg'].includes(method)&&!/^#[0-9a-f]{3,8}$/i.test(args[0])) fail(method,`expects a #color, got ${args[0]}`);
  if(LENGTHS.test(method)&&args.length&&!(typeof args[0]==='string'||Number.isFinite(args[0]))) fail(method,`expects a finite length, got ${args[0]}`);
  if(method==='line_height'&&typeof args[0]!=='string') fail(method,`expects a length string; a bare number (${args[0]}) is a multiplier of the text size`);
  if(method==='opacity'&&!Number.isFinite(args[0])) fail(method,`expects a number, got ${args[0]}`);
  for(const value of args) if(!primitive(value)) fail(method,'unsupported argument type; expected null, boolean, number, string or function');
}

// An element: a record of its calls and children, built through chainable methods. Its own fields
// start with _ so they never hide a builder method such as children().
export function element(kind,...args) {
  const node={_kind:kind,_args:args,_calls:[],_children:[],[ELEMENT]:true};
  const proxy=new Proxy(node,{get(target,name) {
    if(name in target||typeof name==='symbol') return target[name];
    return (...args)=>{
      if(name==='child') { checkChild(name,args[0]); node._children.push(args[0]); return proxy; }
      if(name==='children') { if(!Array.isArray(args[0])) fail(name,'expects an array'); for(const child of args[0]) checkChild('child',child); node._children.push(...args[0]); return proxy; }
      if(name==='when') { if(typeof args[1]!=='function') fail(name,'expects a function'); return args[0]?args[1](proxy):proxy; }
      // Hover styles are built on a style of their own, with the same checks.
      if(name==='hover') { if(typeof args[0]!=='function') fail(name,'expects a function'); args[0](element('style')); node._calls.push([name]); return proxy; }
      // Handles the kit takes as objects.
      if(['track_focus','track_scroll'].includes(name)) { node._calls.push([name]); return proxy; }
      if(['trigger','content'].includes(name)) { checkChild(name,args[0]); node._children.push(args[0]); return proxy; }
      checkArgs(name,args);
      node._calls.push([name,...args]);
      return proxy;
    };
  }});
  return proxy;
}

// What the test sets: the props, the theme and what exec answers.
export const host={props:{},theme:{},exec:async()=>({code:0,stdout:'[]',stderr:''})};

// gpui-kit
export class View {}
export const div=()=>element('div');
export const svg=path=>{ if(typeof path!=='string') fail('svg','expects a path string'); return element('svg',path); };
export const image=path=>{ if(typeof path!=='string') fail('image','expects a path string'); return element('image',path); };
// The real Background builds a native value that only paint_path takes; an element's bg rejects it.
export const Background={linear_gradient:(...args)=>({background:args}),stop:(...args)=>({stop:args}),solid:color=>({background:[color]})};

// gpui-base
export const v_flex=()=>element('v_flex');
export const h_flex=()=>element('h_flex');
export const InputState={new:()=>{ let text=''; return {on(){},value:()=>text,set:value=>{text=value;},focus(){}}; }};
export const Input={new:()=>element('input')};
export const TextView={markdown:(id,text)=>{ if(typeof id!=='string'||typeof text!=='string') fail('TextView.markdown','expects an id and a string'); return element('markdown',id,text); }};
export const Popover={new:id=>{ if(typeof id!=='string') fail('Popover.new','expects a string id'); return element('popover',id); }};
export const ScrollHandle={new:()=>({scroll_to_item(){}})};

// herdr
export const exec=(...args)=>host.exec(...args);
export const watchFolder=()=>new Promise(()=>{});
export const nextCommand=()=>new Promise(()=>{});
export const theme=()=>host.theme;
export const props=()=>host.props;
export const home=()=>'/nonexistent-home';
export const appHome=()=>'/nonexistent-app-home';

// A Context that runs nothing in the background: the test drives the view itself.
export const cx={focus_handle:()=>({focus(){}}),spawn(){},timer:{every(){}},notify(){},stop_propagation(){},open_url(){}};

// Every theme color the herdr module documents, as distinct colors.
host.theme=Object.fromEntries(['background','surface','canvas','chrome','popover','raised','hover','selected','border','input','foreground','muted','dim','accent','accent_foreground','solid','solid_foreground','selection','working','blocked','done','idle','unknown']
  .map((name,i)=>[name,`#${(0x101010+i*0x070503).toString(16).padStart(6,'0')}`]));

const here=new URL('./fake-kit.mjs',import.meta.url).href;
registerHooks({resolve(specifier,context,next) {
  return ['gpui-kit','gpui-base','herdr'].includes(specifier)?{url:here,shortCircuit:true}:next(specifier,context);
}});

// Depth-first walk of a built tree.
export function* walk(node) {
  yield node;
  for(const child of node._children) if(isElement(child)) yield* walk(child);
}
export const call=(node,name)=>node._calls.find(([method])=>method===name)?.slice(1);
export const text=node=>[...walk(node)].flatMap(n=>n._children.filter(c=>typeof c==='string')).join(' ');
