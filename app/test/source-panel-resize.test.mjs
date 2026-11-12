import assert from 'node:assert/strict';
import {it} from 'node:test';
import {JSDOM} from 'jsdom';
import {sourcePanelWidths,bindResizableSourcePanels} from '../src/components/ResizablePanels.js';
import {PublicationCodeEditor} from '../src/components/PublicationCodeEditor.js';
const tick=()=>new Promise(resolve=>setTimeout(resolve,25));
function fixture({width=1200,storage}={}){
 const dom=new JSDOM('<!doctype html><body><div class="source-editor-layout"><aside></aside><div class="source-editor-main"><textarea>Unsaved source</textarea></div><section><iframe sandbox="allow-scripts"></iframe></section></div></body>',{url:'https://studio.fixture.invalid/',pretendToBeVisual:true}),shell=dom.window.document.querySelector('.source-editor-layout');
 let size=width; shell.getBoundingClientRect=()=>({width:size,height:600,left:0,top:0,right:size,bottom:600});
 if(storage!==undefined)dom.window.sessionStorage.setItem('panes',storage);
 const explorer=shell.querySelector('aside'),editor=shell.querySelector('.source-editor-main'),preview=shell.querySelector('section');
 let layouts=0;const controls=bindResizableSourcePanels({shell,explorer,editor,preview,storageKey:'panes',onResize:()=>layouts++});
 const [left,right]=shell.querySelectorAll('[role="separator"]');
 const key=(grip,key,shiftKey=false)=>grip.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true}));
 const pointer=(target,type,x,id=1)=>{const event=new dom.window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,clientX:x,pointerId:id});target.dispatchEvent(event);};
 return {dom,shell,explorer,editor,preview,controls,left,right,key,pointer,setWidth(value){size=value;controls.layout();},get layouts(){return layouts;}};
}
it('bounds all three source columns and falls back to a stack without trusting persisted values',()=>{
 for(const total of [390,704,800,1200,1800])for(const left of [-5,220,1e308,NaN])for(const right of [-3,360,1e308,Infinity]){
  const sizes=sourcePanelWidths(total,{left,right});
  if(total<704){assert.equal(sizes.stacked,true);continue;}
  assert.equal(sizes.stacked,false);assert(sizes.left>=160&&sizes.left<=480);assert(sizes.right>=240);assert(sizes.center>=280);assert.equal(sizes.left+sizes.right+sizes.center+24,total);
 }
 const preview=sourcePanelWidths(420,{left:220,right:360},{editor:false});assert.equal(preview.stacked,false);assert(preview.left>=160&&preview.right>=240);assert.equal(preview.left+preview.right+12,420);
});
it('supports bounded keyboard resizing, optional preferences and retaining source/iframe identity',async()=>{
 const f=fixture({storage:'{"left":220,"right":360}'}),textarea=f.editor.querySelector('textarea'),frame=f.preview.querySelector('iframe'),window=frame.contentWindow;
 assert.equal(f.left.getAttribute('aria-orientation'),'vertical');assert.equal(f.left.getAttribute('aria-controls'),f.explorer.id);
 f.key(f.left,'ArrowRight');assert.equal(f.left.getAttribute('aria-valuenow'),'230');
 f.key(f.right,'ArrowLeft',true);assert.equal(f.right.getAttribute('aria-valuenow'),'400');
 f.key(f.left,'Home');assert.equal(f.left.getAttribute('aria-valuenow'),'160');f.key(f.right,'End');assert.equal(f.right.getAttribute('aria-valuenow'),f.right.getAttribute('aria-valuemax'));
 assert.deepEqual(JSON.parse(f.dom.window.sessionStorage.getItem('panes')),{left:160,right:Number(f.right.getAttribute('aria-valuemax'))});
 assert.equal(f.preview.querySelector('iframe'),frame);assert.equal(frame.contentWindow,window);assert.equal(textarea.value,'Unsaved source');await tick();assert(f.layouts>0);
 f.controls.dispose();assert.equal(f.shell.querySelector('[role="separator"]'),null);f.dom.window.close();
});
it('dragging either divider respects bounds and Escape/cancellation restores the preference snapshot',()=>{
 const f=fixture();const before=f.left.getAttribute('aria-valuenow');
 f.pointer(f.left,'pointerdown',220);f.pointer(f.dom.window.document,'pointermove',300);assert.equal(f.left.getAttribute('aria-valuenow'),'300');f.key(f.left,'Escape');assert.equal(f.left.getAttribute('aria-valuenow'),before);
 f.pointer(f.right,'pointerdown',800,2);f.pointer(f.dom.window.document,'pointermove',700,2);assert.equal(f.right.getAttribute('aria-valuenow'),'460');f.pointer(f.dom.window.document,'pointerup',700,2);assert.equal(JSON.parse(f.dom.window.sessionStorage.getItem('panes')).right,460);
 f.pointer(f.left,'pointerdown',220,3);f.pointer(f.dom.window.document,'pointermove',400,3);f.setWidth(390);assert.equal(f.shell.dataset.resizeLayout,'stacked');assert(f.left.hidden&&f.right.hidden);assert(f.shell.querySelector('.source-panel-resize-shield').hidden);f.setWidth(1200);assert.equal(f.left.getAttribute('aria-valuenow'),'220');
 f.controls.dispose();f.dom.window.close();
});
it('handles hidden Explorer, Preview-only and storage denial without losing the wide-layout preferences',async()=>{
 const f=fixture();f.key(f.left,'ArrowRight',true);f.explorer.hidden=true;await tick();assert.equal(f.shell.dataset.resizeLayout,'editor-preview');assert(f.left.hidden&&!f.right.hidden);
 f.editor.hidden=true;await tick();assert.equal(f.shell.dataset.resizeLayout,'preview');assert(f.left.hidden&&f.right.hidden);
 f.explorer.hidden=false;await tick();assert.equal(f.shell.dataset.resizeLayout,'explorer-preview');assert(!f.left.hidden&&f.right.hidden);f.editor.hidden=false;await tick();assert.equal(f.left.getAttribute('aria-valuenow'),'260');
 Object.defineProperty(f.dom.window,'sessionStorage',{get(){throw Error('Storage denied');},configurable:true});f.key(f.right,'ArrowLeft');assert.equal(f.right.getAttribute('aria-valuenow'),'370');f.controls.dispose();f.dom.window.close();
});
it('resizing the actual CodeEditor surface lays out Monaco without recompiling or rereading preview source',async t=>{
 const dom=new JSDOM('<!doctype html><style>.publication-code-editor{background:rgb(255,255,255)}</style><body></body>',{url:'https://studio.fixture.invalid/',pretendToBeVisual:true});
 const globals={document:dom.window.document,MutationObserver:dom.window.MutationObserver,DOMParser:dom.window.DOMParser,getComputedStyle:dom.window.getComputedStyle.bind(dom.window),Worker:class{}};
 const before=new Map(Object.keys(globals).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));for(const[key,value]of Object.entries(globals))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
 t.after(()=>{dom.window.close();for(const[key,value]of before){if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];}});
 let compiles=0,reads=0,saves=0,layouts=0,current=null;
 const view={addCommand(){},onDidChangeCursorPosition(){},onDidChangeModelContent(){},updateOptions(){},saveViewState(){return{};},restoreViewState(){},getModel:()=>current,getValue:()=>current?.getValue()??'',setModel(value){current=value;},layout(){layouts++;},dispose(){}};
 const monaco={KeyMod:{CtrlCmd:1},KeyCode:{KeyS:2},Uri:{from:value=>value},editor:{create:()=>view,setTheme(){},createModel(value,_language,uri){return{uri,getValue:()=>value,setValue(next){value=next;},dispose(){}};}}};
 const textarea=document.createElement('textarea');textarea.value='# Retained draft';
 const code=PublicationCodeEditor({textarea,onSave(){saves++;},loadEditor:async()=>({monaco}),loadCellTools:async()=>({}),draftPreviewEnabled:true,getSourceContext:()=>({sourceRoot:'src',readFile:async()=>{reads++;return new Blob(['exact fixture']);}}),loadFramework:async()=>({renderFrameworkPreview:async({readFile})=>{compiles++;await readFile('src/data.json');return{html:'<!doctype html><p>Local preview fixture</p>',attachments:[],warnings:[]};}})});
 const shell=document.createElement('div');shell.className='source-editor-layout';shell.getBoundingClientRect=()=>({width:1200,height:600});const explorer=document.createElement('aside'),editor=document.createElement('div');editor.className='source-editor-main';editor.append(textarea,code.element,code.cells);shell.append(explorer,editor,code.preview);document.body.append(shell);
 const frame=code.preview.querySelector('iframe');
 const shellLoads=new MutationObserver(()=>{if(!frame.src)return;frame.contentWindow.postMessage=(_message,_target,ports)=>{const port=ports[0];port.onmessage=({data})=>{if(data?.kind==='render')port.postMessage({kind:'rendered',revision:data.revision});};port.postMessage('ready');};queueMicrotask(()=>frame.dispatchEvent(new dom.window.Event('load')));});shellLoads.observe(frame,{attributes:true,attributeFilter:['src']});
 const binding=bindResizableSourcePanels({shell,explorer,editor,preview:code.preview,onResize:()=>code.layout()});
 await code.open('src/index.md',textarea.value);await tick();await tick();const baseline={compiles,reads};assert(compiles>0&&reads>0);const sameFrame=frame,sameWindow=frame.contentWindow,sameModel=current;const previousLayouts=layouts;
 const [left,right]=shell.querySelectorAll('[role="separator"]');for(const grip of [left,right])for(let i=0;i<4;i++)grip.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
 const pointer=(target,type,x)=>{const event=new dom.window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,clientX:x,pointerId:19});target.dispatchEvent(event);};pointer(left,'pointerdown',220);pointer(document,'pointermove',290);pointer(document,'pointerup',290);await tick();await tick();
 assert(layouts>previousLayouts);assert.deepEqual({compiles,reads},baseline);assert.equal(frame,sameFrame);assert.equal(frame.contentWindow,sameWindow);assert.equal(current,sameModel);assert.equal(textarea.value,'# Retained draft');assert.equal(saves,0);
 shellLoads.disconnect();binding.dispose();code.dispose();
});

it('keeps the accessible fallback usable without animation-frame or storage APIs',async()=>{
 const dom=new JSDOM('<body><div><aside></aside><main></main><section></section></div></body>',{url:'https://studio.fixture.invalid/'}),shell=dom.window.document.querySelector('div');shell.getBoundingClientRect=()=>({width:1100,height:500});Object.defineProperty(dom.window,'sessionStorage',{get(){throw Error('Storage denied');}});let layouts=0;const binding=bindResizableSourcePanels({shell,explorer:shell.querySelector('aside'),editor:shell.querySelector('main'),preview:shell.querySelector('section'),onResize:()=>layouts++});await tick();assert(layouts>0);binding.dispose();dom.window.close();
});
