import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{ChatSession,ChatGate} from '../integration/public-chat/worker.mjs';
import riskWorker from '../integration/public-chat/risk.mjs';
import {MODEL} from '../integration/public-chat/model.mjs';
import {HOLDING_FIELDS,validateOcrText,normalizeExtraction,confirmedScreenshot,financialFacts} from '../integration/public-chat/holdings-extraction.mjs';

// All inputs and provider replies below are synthetic test doubles, never live inference.
class Storage{
 constructor(){this.data=new Map();}
 async get(key){return structuredClone(this.data.get(key));}
 async put(key,value){for(const [k,v] of typeof key==='object'?Object.entries(key):[[key,value]])this.data.set(k,structuredClone(v));}
 async delete(key){this.data.delete(key);}
 async transaction(fn){return fn(this);}
}
const context=()=>({storage:new Storage(),pending:[],blockConcurrencyWhile:fn=>fn(),waitUntil(p){this.pending.push(p);}});
function fixture(){
 const now=Date.now(),env={PUBLIC_ORIGIN:'https://synthetic.test',SESSION_SECRET:'s'.repeat(64),RISK_HMAC_SECRET:'r'.repeat(64),
  MODEL_ENABLED:'true',MODEL_NAME:MODEL,DEMO_START_AT:new Date(now-1000).toISOString(),DEMO_END_AT:new Date(now+16*864e5).toISOString(),
  DEMO_BUDGET_CENTS:'1000',DAILY_BUDGET_CENTS:'1000'};
 const gctx=context(),g=new ChatGate(gctx,env),sessions=new Map(),replies=[];let calls=0;
 env.CHAT_GATE={idFromName:x=>x,get:()=>g};env.AMOUNT_RISK={fetch:r=>riskWorker.fetch(r,env)};
 env.ASSETS={fetch:async()=>new Response('SYNTHETIC_ASSET')};
 env.CHAT_SESSIONS={idFromName:x=>x,get:id=>{if(!sessions.has(id)){const c=context();sessions.set(id,{context:c,object:new ChatSession(c,env)});}return sessions.get(id).object;}};
 env.AI={lastRequestId:'SYNTHETIC_OCR_PROVIDER_NOT_LIVE',async run(model,input){calls++;assert.equal(model,MODEL);assert.equal(input.stream,false);return {response:JSON.stringify(replies.shift()),usage:{prompt_tokens:250,completion_tokens:80}};}};
 return {env,sessions,replies,gctx,calls:()=>calls,async visitor(){
  const r=await worker.fetch(new Request(env.PUBLIC_ORIGIN+'/api/session'),env),body=await r.json();
  const cookie=r.headers.get('set-cookie').split(';')[0];
  return {cookie,csrf:body.csrf,async call(route,body,headers={}){return worker.fetch(new Request(env.PUBLIC_ORIGIN+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':this.csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);}};
 }};
}
const metadata={as_of:'2026-10-29',currency:'CNY',basis:'current_value',source:'USER_TABLE',demo:true};
const cells=(overrides={})=>Object.fromEntries(HOLDING_FIELDS.map(f=>[f,{value:overrides[f]??null,evidence:null}]));
const details=(rows)=>({confirmed:true,source:'USER_CONFIRMED_SCREENSHOT',currency:'CNY',as_of:metadata.as_of,rows});
const output=(cells,lines=[1])=>({rows:[{lines,cells}],as_of:null,currency:null});

test('OCR input is bounded text only and empty/image/extra data is rejected before model use',()=>{
 assert.equal(validateOcrText({text:'  产品甲 100.00  '}),'产品甲 100.00');
 for(const bad of [null,{},[],{text:''},{text:'x'.repeat(4001)},{text:'text',image:'data:image/png;base64,test'}])
  assert.throws(()=>validateOcrText(bad),{code:'OCR_TEXT_INVALID'});
});
test('literal fields, leading-zero identifiers, absence and unknown date/currency remain distinct',()=>{
 const text='名称 代码 数量 成本 当前价 市值 盈亏金额 盈亏比例 持仓占比\n产品甲 000001 100 10.50 9.50 950.00 -100.00 -9.52% 19.00%';
 const r=normalizeExtraction(output(['产品甲','000001','100','10.50','9.50','950.00','-100.00','-9.52%','19.00%'],[2]),text);
 assert.deepEqual(HOLDING_FIELDS.map(f=>r.rows[0][f].value),['产品甲','000001','100','10.50','9.50','950.00','-100.00','-9.52%','19.00%']);
 assert.equal(r.as_of,null);assert.equal(r.currency,null);
 const missing=normalizeExtraction(output(['产品甲','999999','100',null,null,'9999.00',null,null,null],[2]),text);
 assert.equal(missing.rows[0].code.value,null);assert.equal(missing.rows[0].market_value.value,null);
 assert.equal(missing.rows[0].pnl.value,null);assert.ok(missing.warnings.length);
});
test('OCR evidence cannot invent percentages when percent glyph is missing',()=>{
 const r=normalizeExtraction(output(['产品甲',null,null,null,null,null,null,'9.52','19.00']),'产品甲 9.52 19.00');
 assert.equal(r.rows[0].pnl_percent.value,null);assert.equal(r.rows[0].weight.value,null);
 const invented=normalizeExtraction(output(['产品甲',null,null,null,null,null,null,'9.52%','19.00%']),'产品甲 9.52 19.00');
 assert.equal(invented.rows[0].pnl_percent.value,null);assert.equal(invented.rows[0].weight.value,null);
});
test('vertical labelled name and identifier keep their literal value and leading zeros',()=>{
 const text='名称：产品甲\n代码：000001\n市值：100.00';
 const r=normalizeExtraction(output(['产品甲','000001',null,null,null,'100.00',null,null,null],[1,2,3]),text);
 assert.equal(r.rows[0].name.value,'产品甲');assert.equal(r.rows[0].code.value,'000001');assert.equal(r.rows[0].market_value.value,'100.00');
});
test('numeric evidence cannot drop a negative sign or match only part of another number',()=>{
 const r=normalizeExtraction(output(['产品甲',null,null,null,null,null,'120.50',null,null]),'产品甲 盈亏 -120.50');
 assert.equal(r.rows[0].pnl.value,null);
 const partial=normalizeExtraction(output(['产品甲',null,null,null,null,null,'20.50',null,null]),'产品甲 盈亏 -120.50');
 assert.equal(partial.rows[0].pnl.value,null);
});
test('quantity and cost evidence cannot populate an absent market-value column',()=>{
 const r=normalizeExtraction(output(['产品甲',null,'100','10.50',null,'100',null,null,null]),'产品甲 数量100 成本10.50 市值【模糊】');
 assert.equal(r.rows[0].quantity.value,'100');assert.equal(r.rows[0].cost.value,'10.50');assert.equal(r.rows[0].market_value.value,null);
});
test('invalid, overlapping or non-contiguous evidence line ranges fail closed',()=>{
 const row={lines:[1],cells:['产品甲',null,null,null,null,null,null,null,null]};
 for(const value of [{rows:[row,{...row}]},{rows:[{...row,lines:[0]}]},{rows:[{...row,lines:[1,3]}]},{rows:[{...row,lines:[4]}]}])
  assert.throws(()=>normalizeExtraction(value,'产品甲\n产品乙\n产品丙'),{code:'OCR_RESULT_INVALID'});
 const split=normalizeExtraction({rows:[row,{lines:[2],cells:['产品乙',null,null,null,null,'100',null,null,null]}]},'产品甲 100\n产品乙 200');
 assert.equal(split.rows[1].market_value.value,null);
});
test('confirmation binds explicit confirmation, date, currency, exact market value cents and original missing fields',()=>{
 const row=cells({name:'产品甲',code:'000001',quantity:'12.5',market_value:'0.29',pnl:'-0.10'}),input=details([row]);
 const confirmed=confirmedScreenshot(input,[{name:'产品甲',amount_cents:29}],metadata);
 assert.equal(confirmed.rows[0].cost.value,null);assert.equal(confirmed.rows[0].code.value,'000001');
 assert.equal(confirmed.rows[0].market_value.value,'0.29');assert.equal(confirmed.rows[0].market_value.evidence,null);
 for(const change of [{confirmed:false},{as_of:'2026-10-28'},{currency:'USD'},{source:'MODEL_INFERRED'}])
  assert.throws(()=>confirmedScreenshot({...input,...change},[{name:'产品甲',amount_cents:29}],metadata),{code:'OCR_CONFIRMATION_INVALID'});
 assert.throws(()=>confirmedScreenshot(input,[{name:'产品甲',amount_cents:30}],metadata),{code:'OCR_CONFIRMATION_INVALID'});
 assert.throws(()=>confirmedScreenshot(details([cells({name:'产品甲',quantity:'29',cost:'0.29'})]),[{name:'产品甲',amount_cents:29}],metadata),{code:'OCR_CONFIRMATION_INVALID'});
});
test('reported P/L sums exact signed cents without manufacturing missing P/L or market/industry facts',()=>{
 const rows=[cells({name:'产品甲',market_value:'100.00',pnl:'-0.29'}),cells({name:'产品乙',market_value:'200.00',pnl:'0.10'})];
 const confirmed=confirmedScreenshot(details(rows),[{name:'产品甲',amount_cents:10000},{name:'产品乙',amount_cents:20000}],metadata);
 const f=financialFacts(confirmed);assert.equal(f.reported_pnl_total,'-0.19');assert.equal(f.reported_pnl_coverage,'COMPLETE_UPLOADED_ROWS');
 for(const field of ['sector_concentration','historical_risk','live_market','news_earnings'])assert.equal(f[field],'UNKNOWN');
 rows[1].pnl.value=null;const incomplete=financialFacts(confirmedScreenshot(details(rows),[{name:'产品甲',amount_cents:10000},{name:'产品乙',amount_cents:20000}],metadata));
 assert.equal(incomplete.reported_pnl_total,null);assert.equal(incomplete.reported_pnl_coverage,'INCOMPLETE');
});
test('extraction HTTP is session and CSRF protected, consumes one bounded model call and never writes holdings',async()=>{
 const f=fixture(),v=await f.visitor(),c=await(await v.call('/api/local/chats',{})).json();
 const before=await(await v.call('/api/local/chats/'+c.id)).json();
 f.replies.push(output(['产品甲','000001',null,null,null,'100.00',null,null,null]));
 const response=await v.call('/api/local/holdings/extract',{text:'产品甲 000001 市值100.00'});
 assert.equal(response.status,200,await response.clone().text());const result=await response.json();
 assert.equal(result.execution_allowed,false);assert.equal(result.extraction.rows[0].market_value.value,'100.00');
 assert.deepEqual((await(await v.call('/api/local/chats/'+c.id)).json()).state,before.state);
 assert.deepEqual((await(await v.call('/api/local/snapshots')).json()).snapshots,[]);assert.equal(f.calls(),1);
 assert.equal((await v.call('/api/local/holdings/extract',{text:'产品甲 100'},{'X-CSRF-Token':'forged'})).status,403);
 assert.equal(f.calls(),1);assert.equal(Object.keys((await f.gctx.storage.get('meta')).active).length,0);
});
test('invalid extraction and failed screenshot confirmation leave original state untouched',async()=>{
 const f=fixture(),v=await f.visitor(),c=await(await v.call('/api/local/chats',{})).json();
 f.replies.push({rows:[{lines:[99],cells:[]}]});
 assert.equal((await v.call('/api/local/holdings/extract',{text:'产品甲100'})).status,422);
 const row=cells({name:'产品甲',market_value:'100.00'});
 const bad=await v.call('/api/local/chats/'+c.id+'/review',{base_version:0,rows:[{name:'产品甲',amount:'101.00',kind:'unresolved'}],metadata,mode:'new',screenshot_details:details([row])});
 assert.equal(bad.status,422,await bad.clone().text());
 const current=await(await v.call('/api/local/chats/'+c.id)).json();assert.equal(current.state.version,0);assert.deepEqual(current.state.actual,[]);assert.equal(current.turns.length,0);
});
test('confirmed screenshot rows enter the existing read-only review with fields and coverage preserved',async()=>{
 const f=fixture(),v=await f.visitor(),c=await(await v.call('/api/local/chats',{})).json();
 const rows=[cells({name:'产品甲',market_value:'100.29',quantity:'10',cost:'11.00',pnl:'-9.71'}),cells({name:'未清楚标的'})];
 const response=await v.call('/api/local/chats/'+c.id+'/review',{base_version:0,rows:[{name:'产品甲',amount:'100.29',kind:'unresolved'}],metadata,mode:'new',screenshot_details:details(rows)});
 assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.execution_allowed,false);
 const current=result.conversation;assert.equal(current.state.actual[0].amount_cents,10029);assert.equal(current.state.screenshot_details.coverage,'PARTIAL');
 assert.equal(current.state.screenshot_details.rows[1].market_value.value,null);assert.equal(f.calls(),0);
 assert.equal(current.turns.at(-1).context.financial_facts.unusable_rows,1);
});
test('self-hosted OCR static paths and WASM CSP are explicit without opening arbitrary script paths',async()=>{
 const f=fixture();
 for(const route of ['/ocr/tesseract.min.js','/ocr/worker.min.js','/ocr/core/tesseract-core-lstm.wasm.js','/ocr/core/tesseract-core-simd-lstm.wasm.js','/ocr/lang/chi_sim.traineddata.gz','/ocr/lang/eng.traineddata.gz']){
  const response=await worker.fetch(new Request(f.env.PUBLIC_ORIGIN+route),f.env);assert.equal(response.status,200,route);
  assert.match(response.headers.get('content-security-policy'),/wasm-unsafe-eval/);assert.match(response.headers.get('content-security-policy'),/worker-src 'self'/);
 }
 for(const route of ['/ocr/secret.env','/ocr/evil.js','/ocr/core/evil.wasm.js'])assert.equal((await worker.fetch(new Request(f.env.PUBLIC_ORIGIN+route),f.env)).status,404);
});
