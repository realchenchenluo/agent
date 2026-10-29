import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAN_PROMPT,ANSWER_PROMPT,preflightReviewPlan,applyPlan,answerFacts,validateAnswer} from '../integration/public-chat/shared.mjs';
import {buildModelRequest} from '../integration/public-chat/model.mjs';
import {PROMPT_VERSION} from '../integration/public-chat/trace.mjs';

const state=()=>({actual:[{name:'产品甲',kind:'unresolved',amount_cents:250000},{name:'产品乙',kind:'unresolved',amount_cents:150000}],previous_actual:[],version:1,actual_tool:null,metadata:{as_of:'2026-10-29',currency:'CNY',basis:'current_value'}});
const write=()=>({operation:'correct_holdings',changes:[{name:'产品甲',kind:'unresolved',amount:'8',unit:'万'}],transfer:null});
const field=(value,evidence=value)=>({value,evidence});
const context=()=>({question:'请复盘持仓风险',operation:'analyze',...state(),actual_tool:{total_cents:400000,rows:[{name:'产品甲',amount_cents:250000,weight_pct:62.5},{name:'产品乙',amount_cents:150000,weight_pct:37.5}]},screenshot_details:{source:'USER_CONFIRMED_SCREENSHOT',confirmed:true,as_of:'2026-10-29',currency:'CNY',rows:[{name:field('产品甲'),code:field('600000'),quantity:field('200','200股'),cost:field('13.10'),current_price:field('12.50'),market_value:field('2500.00'),pnl:field('-120.00'),pnl_percent:field('-4.58%'),weight:field('25%')},{name:field('产品乙'),code:field(null),quantity:field(null),cost:field(null),current_price:field(null),market_value:field('1500.00'),pnl:field('20.00'),pnl_percent:field(null),weight:field(null)}],warnings:[]},financial_facts:{source:'USER_CONFIRMED_SCREENSHOT_NOT_LIVE',currency:'CNY',as_of:'2026-10-29',coverage:'UPLOADED_ROWS_ONLY',reviewed_rows:2,unusable_rows:0,reported_pnl_total:'-100.00',reported_pnl_coverage:'COMPLETE_UPLOADED_ROWS',sector_concentration:'UNKNOWN',historical_risk:'UNKNOWN',live_market:'UNKNOWN',news_earnings:'UNKNOWN'}});

test('planner contract distinguishes actual statements, market questions, reviews, adjustment ideas and risk questions',()=>{
 for(const phrase of ['actual holding statements','market questions','portfolio reviews','adjustment ideas','risk questions','NEVER establish actual holdings','choose clarify','A price per share is not a position'])assert.ok(PLAN_PROMPT.includes(phrase),phrase);
 for(const operation of ['set_holdings','correct_holdings','simulate_transfer','analyze','explain','compare_snapshots','confirm_baseline','execute_plan','clarify'])assert.ok(PLAN_PROMPT.includes(operation));
 assert.equal(PROMPT_VERSION,'finance-semantics-20261029-r2');
});

test('misplanned hypothetical or desired holdings cannot become actual data',()=>{
 for(const text of ['假如产品甲是8万元，帮我复盘','如果产品甲市值是8万元呢？','我计划加仓产品甲至8万元','考虑调仓，产品甲8万元']){
  const original=state(),plan=preflightReviewPlan(text,write(),original),result=applyPlan(original,plan);
  assert.equal(plan.operation,'clarify',text);assert.match(plan.question,/真实持仓|假设|计划/);assert.deepEqual(result.next,original);assert.equal(result.rows,null);
 }
});

test('market price and percentage cannot be grounded as position value',()=>{
 for(const text of ['产品甲当前价8元','产品甲每股8元','产品甲收盘价8元','产品甲净值8元','产品甲涨了8%','产品甲上涨8万元']){
  const plan=preflightReviewPlan(text,write(),state());assert.equal(plan.operation,'clarify',text);assert.deepEqual(applyPlan(state(),plan).next.actual,state().actual);
 }
});

test('explicit actual correction remains supported without expanding write permissions',()=>{
 const original=state(),plan=preflightReviewPlan('产品甲当前市值更正为8万元。',write(),original),result=applyPlan(original,plan);
 assert.equal(plan.operation,'correct_holdings');assert.deepEqual(result.next.actual.map(r=>r.amount_cents),[8000000,150000]);assert.equal(result.next.version,2);assert.deepEqual(original.actual,state().actual);
});

test('read-only financial questions never change actual holdings even when the user mentions market numbers',()=>{
 for(const [text,operation]of [['今天市场跌了5%，我的风险高吗？','analyze'],['公司财报会影响产品甲吗？','explain'],['我想减仓，先帮我分析','explain']]){
  const original=state(),plan=preflightReviewPlan(text,{operation,changes:[],transfer:null},original),result=applyPlan(original,plan);
  assert.equal(plan.operation,operation);assert.deepEqual(result.next.actual,original.actual);assert.equal(result.next.version,original.version);
 }
});

test('simulation transfers are hypothetical and conserve the existing total',()=>{
 const original=state(),plan=preflightReviewPlan('假设从产品甲移到产品乙500元',{operation:'simulate_transfer',transfer:{from:'产品甲',to:'产品乙',amount:'500',unit:'元'}},original),result=applyPlan(original,plan);
 assert.equal(result.simulation,true);assert.deepEqual(result.next.actual,original.actual);assert.deepEqual(result.next.scenario.rows.map(r=>r.amount_cents),[200000,200000]);assert.equal(result.next.scenario.rows.reduce((n,r)=>n+r.amount_cents,0),400000);
});

test('answer facts carry confirmed screenshot fields and unknown external facts without assuming live data',()=>{
 const input=context(),facts=answerFacts(input);
 assert.deepEqual(facts.screenshot_details,input.screenshot_details);assert.deepEqual(facts.financial_facts,input.financial_facts);assert.equal(facts.original_holdings.total_yuan,4000);assert.equal(facts.execution_allowed,false);assert.match(facts.source_note,/非实时行情|未识别不代表零/);
});

test('financial prompt requires evidence groups, plain terminology and missing-data handling',()=>{
 const prompt=ANSWER_PROMPT(context());
 for(const required of ['【客观行情事实】','【合理推演猜想】','【未知信息】','仅为分析参考，不构成投资建议','有歧义先确认','截图提取表先于后续分析','【识别失败，待人工补充】','信息不足','行业占比','财报','术语首次出现','不承诺保本','不冒充行情'])assert.ok(prompt.includes(required),required);
 assert.match(prompt,/不能编造实时价格、新闻内容或涨跌原因/);assert.match(prompt,/不能与工具权重混用|不得与工具权重混用/);
});

test('confirmed screenshot numbers require the matching asset and explicit field label',()=>{
 const c=context();
 for(const text of ['产品甲持仓数量200股。','产品甲当前价12.50元。','**产品甲**当前价12.50元。','产品甲持仓成本13.10元。','产品甲盈亏金额-120元。','产品甲盈亏比例-4.58%。','截图产品甲持仓占比25%。','已上传持仓合计盈亏-100元。','产品甲市值2500元。'])assert.doesNotThrow(()=>validateAnswer(text,c),text);
 for(const text of ['产品甲当前价13.10元。','产品乙当前价12.50元。','产品甲盈亏金额120元。','产品甲盈亏比例4.58%。','产品甲当前价900元。','产品甲当前价12.50%。','产品甲持仓数量200份。','产品甲为12.50元。','任意金额13.10元。','未知行业占比25%。'])assert.throws(()=>validateAnswer(text,c),{code:'MODEL_UNGROUNDED_NUMBER'},text);
});

test('screenshot weights cannot silently replace the imported-rows denominator',()=>{
 const c=context();assert.doesNotThrow(()=>validateAnswer('截图产品甲持仓占比25%。',c));assert.doesNotThrow(()=>validateAnswer('产品甲占比62.5%。',c));assert.throws(()=>validateAnswer('产品甲占比25%。',c),{code:'MODEL_UNGROUNDED_NUMBER'});
});

test('unconfirmed or incomplete screenshot data cannot authorize new figures',()=>{
 let c=context();c.screenshot_details.confirmed=false;assert.throws(()=>validateAnswer('产品甲当前价12.50元。',c),{code:'MODEL_UNGROUNDED_NUMBER'});
 c=context();c.financial_facts.reported_pnl_coverage='INCOMPLETE';assert.throws(()=>validateAnswer('已上传持仓合计盈亏-100元。',c),{code:'MODEL_UNGROUNDED_NUMBER'});
 c=context();c.screenshot_details.rows[0].current_price.value=null;assert.throws(()=>validateAnswer('产品甲当前价12.50元。',c),{code:'MODEL_UNGROUNDED_NUMBER'});
});

test('confirmed fields do not weaken existing entity amount, weight, historical metric or execution guards',()=>{
 const c=context();
 for(const text of ['产品甲市值1500元。','产品甲占比37.5%。','最大回撤25%。','已经买入产品甲。'])assert.throws(()=>validateAnswer(text,c));
 assert.doesNotThrow(()=>validateAnswer('无法计算最大回撤：缺少历史价格与资金流水。',c));
});

test('confirmed original screenshot values cannot override a scenario market value',()=>{
 const c=context();c.scenario={rows:[{name:'产品甲',amount_cents:200000,weight_pct:50},{name:'产品乙',amount_cents:200000,weight_pct:50}]};c.simulation=true;
 assert.doesNotThrow(()=>validateAnswer('模拟产品甲市值2000元。',c));assert.throws(()=>validateAnswer('模拟产品甲市值2500元。',c),{code:'MODEL_UNGROUNDED_NUMBER'});
});

test('guaranteed-return claims fail and action advice requires the requested opening label',()=>{
 for(const text of ['这能保证收益。','一定保本。','这样稳赚。'])assert.throws(()=>validateAnswer(text,context()),{code:'MODEL_FINANCIAL_PROMISE_INVALID'});
 assert.doesNotThrow(()=>validateAnswer('不能保证收益，也不能承诺保本。',context()));
 assert.throws(()=>validateAnswer('建议你加仓。',context()),{code:'MODEL_ADVICE_LABEL_REQUIRED'});
 assert.doesNotThrow(()=>validateAnswer('仅为分析参考，不构成投资建议。若核实风险承受力后，可以考虑减仓。',context()));
});

test('expanded prompts remain inside existing request limits for a normal screenshot analysis',()=>{
 assert.doesNotThrow(()=>buildModelRequest('plan',{message:'分析持仓风险',state:state(),history:[]}));
 const answer=buildModelRequest('answer',context());assert.equal(answer.clipping.current_facts_clipped,false);assert.equal(answer.messages.length,2);assert.ok(JSON.stringify(answer.messages).length<12000);
});
