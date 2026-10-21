import test from 'node:test';import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { prepareOwnedLoginPage, LOGIN_PAGE_STATE, LOGIN_QR_STATE } from '../../packages/ima-runtime/src/login-page.mjs';

const main={targetId:'synthetic-main',type:'page',url:'about:blank'};
const qr={targetId:'synthetic-qr',type:'iframe',url:'https://open.weixin.qq.com/connect/qrconnect?state=SYNTHETIC_SECRET'};
const ready={official:true,pageReady:true,visible:true,entry:{x:200,y:36},panelVisible:false,accountPresent:false};
function fixture({pages=[main],states=[ready,{...ready,entry:null,panelVisible:true,qrFrameVisible:true}],navigation={frameId:'synthetic-frame'},qrTarget=qr,qrStates=[false,true],sameSiteFrame=false}={}){
 const requests=[];let stateIndex=0,qrIndex=0,clicked=false;
 return{requests,pipe:{async send(method,params={},sessionId){requests.push({method,params,sessionId});
  if(method==='Target.getTargets')return{targetInfos:clicked&&!sameSiteFrame?[...pages,qrTarget]:pages};
  if(method==='Target.attachToTarget')return{sessionId:params.targetId==='synthetic-qr'?'synthetic-qr-session':'synthetic-main-session'};
  if(method==='Page.navigate')return navigation;
  if(method==='Page.getFrameTree')return{frameTree:{frame:{id:'main-frame',url:'https://ima.qq.com/'},childFrames:[{frame:{id:'qr-frame',url:qrTarget.url}}]}};
  if(method==='Page.createIsolatedWorld')return{executionContextId:42};
  if(method==='Input.dispatchMouseEvent'){if(params.type==='mouseReleased')clicked=true;return{};}
  if(method==='Runtime.evaluate'){
   if(params.expression===LOGIN_PAGE_STATE)return{result:{value:states[Math.min(stateIndex++,states.length-1)]}};
   assert.equal(params.expression,LOGIN_QR_STATE);return{result:{value:{expected:true,ready:qrStates[Math.min(qrIndex++,qrStates.length-1)]}}};
  }
  return{};
 }}};
}
const options=()=>({signal:new AbortController().signal,pollMs:1,timeoutMs:200});
test('one startup tab navigates, hydrates, opens the official login panel once, and waits for its loaded QR image',async()=>{
 const f=fixture({states:[{...ready,pageReady:false,entry:null},{...ready,entry:null},ready,{...ready,entry:null,panelVisible:true,qrFrameVisible:true}]});
 const phases=[],result=await prepareOwnedLoginPage(f.pipe,{...options(),onProgress:p=>phases.push(p)});
 assert.equal(result.qrReady,true);assert.equal(result.sessionId,'synthetic-main-session');
 assert.deepEqual(phases,['opening_official_page','opening_login_panel']);
 assert.equal(f.requests.filter(r=>r.method==='Target.createTarget').length,0);
 assert.equal(f.requests.filter(r=>r.method==='Input.dispatchMouseEvent').length,3);
 assert.equal(f.requests.filter(r=>r.params.expression===LOGIN_QR_STATE).length,2);
 assert.equal(f.requests.filter(r=>r.method==='Target.activateTarget').length,2);
 const before=m=>f.requests.findIndex(r=>r.method===m);
 assert.ok(before('Network.setBlockedURLs')<before('Page.navigate'));
 assert.equal(f.requests.find(r=>r.method==='Page.navigate').params.url,'https://ima.qq.com/');
});
test('failed navigation cannot announce that QR login is ready or attempt a click',async()=>{
 const f=fixture({navigation:{errorText:'SYNTHETIC_SECRET'}}),phases=[];
 await assert.rejects(prepareOwnedLoginPage(f.pipe,{...options(),onProgress:p=>phases.push(p)}),e=>e.code==='login_navigation_failed'&&!String(e).includes('SECRET'));
 assert.deepEqual(phases,['opening_official_page']);assert.equal(f.requests.some(r=>r.method==='Runtime.evaluate'),false);
});
test('same-site cross-origin QR is checked in its own isolated context without a separate target or universal access',async()=>{
 const f=fixture({sameSiteFrame:true});const result=await prepareOwnedLoginPage(f.pipe,options());assert.equal(result.qrReady,true);
 const world=f.requests.find(r=>r.method==='Page.createIsolatedWorld');
 assert.equal(world.params.frameId,'qr-frame');assert.equal(Object.hasOwn(world.params,'grantUniveralAccess'),false);
 assert.ok(f.requests.some(r=>r.params.expression===LOGIN_QR_STATE&&r.params.contextId===42));
 assert.equal(f.requests.filter(r=>r.method==='Target.attachToTarget').length,1);
});
test('switching back to Agent instructions does not make an otherwise loaded official QR time out',async()=>{
 const f=fixture({states:[{...ready,visible:false},{...ready,visible:false,entry:null,panelVisible:true,qrFrameVisible:true}]});
 const result=await prepareOwnedLoginPage(f.pipe,options());assert.equal(result.qrReady,true);
 assert.equal(f.requests.filter(r=>r.method==='Input.dispatchMouseEvent').length,3);
 assert.equal(f.requests.at(-2).method,'Target.activateTarget');
});
test('actual page observation waits for a hydrated, reachable entry and never emits stored credentials',()=>{
 const entry={disabled:false,onclick:null,getBoundingClientRect:()=>({x:10,y:10,width:80,height:34}),textContent:'登录',contains:e=>e===entry};
 const document={readyState:'complete',visibilityState:'hidden',querySelectorAll:selector=>selector==='.ant-modal'?[]:[entry],elementFromPoint:()=>entry};
 const globals={location:{origin:'https://ima.qq.com'},document,innerWidth:800,innerHeight:600,getComputedStyle:()=>({visibility:'visible',display:'block'}),
  localStorage:{getItem:()=>JSON.stringify({userId:'SYNTHETIC_ID',token:'SYNTHETIC_TOKEN',refreshToken:'SYNTHETIC_REFRESH'})}};
 let result=runInNewContext(LOGIN_PAGE_STATE,globals);assert.equal(result.entry,null);assert.equal(result.accountPresent,true);
 entry.onclick=()=>{};result=runInNewContext(LOGIN_PAGE_STATE,globals);assert.equal(result.entry.x,50);assert.equal(result.visible,false);
 assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC|TOKEN|REFRESH/);
});
test('actual QR observation checks a loaded image without reading its URL, query, pixels or content',()=>{
 const image={complete:false,naturalWidth:224,naturalHeight:224,getBoundingClientRect:()=>({width:180}),get src(){throw Error('must_not_read_private_qr_url');}};
 const globals={location:{origin:'https://open.weixin.qq.com',pathname:'/connect/qrconnect',get href(){throw Error('must_not_read_login_link');}},document:{readyState:'complete',querySelectorAll:()=>[image]}};
 assert.equal(runInNewContext(LOGIN_QR_STATE,globals).ready,false);image.complete=true;
 const result=runInNewContext(LOGIN_QR_STATE,globals);assert.equal(result.ready,true);assert.deepEqual(Object.keys(result).sort(),['expected','ready']);
});
test('ambiguous startup tabs are refused rather than adding or guessing another tab',async()=>{
 const f=fixture({pages:[main,{...main,targetId:'another'}]});
 await assert.rejects(prepareOwnedLoginPage(f.pipe,options()),{code:'login_browser_startup_ambiguous'});
 assert.equal(f.requests.some(r=>r.method==='Target.attachToTarget'),false);
});
test('unchanged blank, foreign navigation and unhydrated login entry never become scan-ready',async()=>{
 for(const [state,code]of[[{official:false,blank:true},'login_page_not_ready'],[{official:false,blank:false},'login_navigation_origin_changed'],[{...ready,entry:null},'login_page_not_ready']]){
  const f=fixture({states:[state]});await assert.rejects(prepareOwnedLoginPage(f.pipe,{...options(),timeoutMs:15}),{code});
  assert.equal(f.requests.some(r=>r.method==='Input.dispatchMouseEvent'),false);
 }
});
test('an unloaded or foreign QR iframe does not authorize the waiting-for-scan stage',async()=>{
 for(const settings of[{qrStates:[false]},{qrTarget:{...qr,url:'https://evil.invalid/connect/qrconnect'}}]){
  const f=fixture(settings);await assert.rejects(prepareOwnedLoginPage(f.pipe,{...options(),timeoutMs:20}),e=>['login_qr_not_ready','login_page_not_ready'].includes(e.code));
  if(settings.qrTarget)assert.equal(f.requests.some(r=>r.params.expression===LOGIN_QR_STATE),false);
 }
});
test('existing visible login UI is not toggled closed; a fast human login proceeds to strict credential capture',async()=>{
 for(const state of[{...ready,entry:null,panelVisible:true,inlineQRReady:true},{...ready,accountPresent:true}]){
  const f=fixture({states:[state]});const result=await prepareOwnedLoginPage(f.pipe,options());
  assert.equal(result.qrReady,!state.accountPresent);assert.equal(f.requests.some(r=>r.method==='Input.dispatchMouseEvent'),false);
 }
});
test('readiness is cancelled promptly without a fallback page or URL',async()=>{
 const f=fixture({states:[{official:false,blank:true}]}),controller=new AbortController();
 const promise=prepareOwnedLoginPage(f.pipe,{...options(),signal:controller.signal});setTimeout(()=>controller.abort(),5);
 await assert.rejects(promise,{code:'login_cancelled'});assert.equal(f.requests.some(r=>r.method==='Target.createTarget'),false);
});
