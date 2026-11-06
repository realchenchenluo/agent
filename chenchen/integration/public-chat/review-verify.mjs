// Read/write maintenance verification using synthetic public review data only.
// No AI, admin endpoint, real holdings, secrets, or transaction execution are used.
// Run seed before a release, then check after redeployment to inspect persistence.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const privateDir=path.resolve(here,'../local/.runtime/public-deploy');
const privateFile=path.join(privateDir,'review-structure-visitors.json');
const evidenceFile=path.resolve(here,'../../../docs/experience-evidence/review-cloud-structure.json');
const config=JSON.parse(fs.readFileSync(path.join(here,'wrangler.jsonc'),'utf8'));
const origin=config.vars.PUBLIC_ORIGIN;
const action=process.argv[2];
const afterRelease=process.argv.find(value=>value.startsWith('--after-release='))?.slice('--after-release='.length)||null;
if(!['seed','check'].includes(action))throw Error('Use seed or check [--after-release=release-label].');
if(new URL(origin).protocol!=='https:')throw Error('HTTPS_ORIGIN_REQUIRED');
if(afterRelease&&!/^[A-Za-z0-9._-]{1,100}$/.test(afterRelease))throw Error('INVALID_RELEASE_LABEL');
const now=()=>new Date().toISOString();
const checks=[];
const assert=(condition,code,details={})=>{checks.push({check:code,passed:Boolean(condition),...details});if(!condition)throw Object.assign(Error(code),{safe:true});};
function savePrivate(data){fs.mkdirSync(privateDir,{recursive:true,mode:0o700});const temp=privateFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.chmodSync(temp,0o600);fs.renameSync(temp,privateFile);}
function previousEvidence(){try{return JSON.parse(fs.readFileSync(evidenceFile,'utf8'));}catch{return {};}}
function saveEvidence(result){const prior=previousEvidence();const evidence={schema:1,url:origin,data_classification:'SYNTHETIC_TEST_DATA_ONLY',model_calls:0,method:'Real public HTTPS requests; two independent cookie jars. Deterministic review/snapshot APIs only, not a live model concurrency test.',units:'CNY yuan; calculations and assertions use integer cents',...(action==='check'?prior:{}),[action]:result};fs.mkdirSync(path.dirname(evidenceFile),{recursive:true});fs.writeFileSync(evidenceFile,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({action,passed:result.passed,checked_at:result.checked_at,checks:result.checks,evidence_file:evidenceFile},null,2));}
async function call(route,{visitor,body,headers={}}={}){
 // Deliberately exclude /turns, /confirm, admin, execution, and arbitrary URLs.
 if(!/^\/api\/session$|^\/api\/local\/chats(?:\/[A-Za-z0-9_-]+(?:\/review)?)?$|^\/api\/local\/snapshots(?:\/[A-Za-z0-9_-]+(?:\/(?:restore|update|delete|compare))?)?$/.test(route))throw Object.assign(Error('VERIFIER_ROUTE_NOT_ALLOWED'),{safe:true});
 const response=await fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{...(visitor?{Cookie:visitor.cookie,'X-CSRF-Token':visitor.csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json',Origin:origin}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000),redirect:'error'});
 return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function expected(label,route,args,status=200){const result=await call(route,args);assert(result.status===status,label,{http_status:result.status,expected_status:status});return result.data;}
async function visitor(label){const result=await call('/api/session');assert(result.status===200&&typeof result.cookie==='string'&&typeof result.data.csrf==='string',label,{http_status:result.status});return {cookie:result.cookie,csrf:result.data.csrf};}
const meta=date=>({as_of:date,currency:'CNY',basis:'current_value',source:'USER_TABLE',demo:true});
const amounts=values=>[{name:'基金A',kind:'unresolved',amount_cents:values[0]*100},{name:'基金B',kind:'unresolved',amount_cents:values[1]*100},{name:'现金',kind:'cash',amount_cents:values[2]*100}];
const input=(c,values,date,mode)=>({base_version:c.state.version,rows:amounts(values),metadata:meta(date),mode});
const snapshotBody=c=>({conversation_id:c.id,base_version:c.state.version,base_hash:c.state.review_hash,confirmed:true,name:'验证用合成持仓 '+c.state.metadata.as_of});
function verifyRows(label,rows,values){assert(JSON.stringify(rows.map(row=>[row.name,row.amount_cents]))===JSON.stringify(amounts(values).map(row=>[row.name,row.amount_cents])),label,{amounts_yuan:values});}
function verifyReview(label,c,values,date){const review=c.state.review;verifyRows(label+'_ROWS',c.state.actual,values);assert(review?.tool.output.total_cents===values.reduce((a,b)=>a+b,0)*100,label+'_TOTAL',{total_yuan:review?.tool.output.total_cents/100});assert(review?.metadata.as_of===date&&review.metadata.currency==='CNY'&&review.metadata.basis==='current_value'&&review.metadata.demo===true,label+'_METADATA');assert(c.turns.every(turn=>(turn.receipts||[]).length===0),label+'_NO_MODEL_RECEIPTS');}
const compareAmounts=(comparison,expectedDelta)=>comparison?.total_delta_cents===expectedDelta*100&&comparison.attribution==='NOT_DETERMINED';
let state;
try{
 if(action==='seed'){
  const a=await visitor('VISITOR_A_CREATED'),b=await visitor('VISITOR_B_CREATED');
  state={schema:1,origin,created_at:now(),status:'IN_PROGRESS',a,b};savePrivate(state);
  let c=await expected('A_CHAT_CREATED','/api/local/chats',{visitor:a,body:{}},201);state.chat_id=c.id;savePrivate(state);
  c=(await expected('FIRST_REVIEW_HTTP',`/api/local/chats/${c.id}/review`,{visitor:a,body:input(c,[60000,20000,20000],null,'new')})).conversation;
  verifyReview('FIRST_REVIEW',c,[60000,20000,20000],null);
  assert(c.state.review.chart[0].weight_pct===60&&c.state.review.findings.some(item=>item.code==='SINGLE_HOLDING_OVER_HALF'),'FIRST_REVIEW_CONCENTRATION',{largest_weight_pct:c.state.review.chart[0].weight_pct});
  c=(await expected('CORRECTION_HTTP',`/api/local/chats/${c.id}/review`,{visitor:a,body:input(c,[30000,20000,20000],'2026-10-01','correct')})).conversation;
  verifyReview('CORRECTION',c,[30000,20000,20000],'2026-10-01');
  assert(c.turns[0].review.stale===true&&!c.state.review.findings.some(item=>item.code==='SINGLE_HOLDING_OVER_HALF'),'CORRECTION_INVALIDATES_OLD_REVIEW',{largest_weight_pct:c.state.review.chart[0].weight_pct});
  const first=await expected('BASELINE_SAVED','/api/local/snapshots',{visitor:a,body:snapshotBody(c)},201);c=first.conversation;state.baseline_id=first.snapshot.id;state.baseline_revision=first.snapshot.revision;savePrivate(state);
  const duplicate=await expected('DUPLICATE_SAVE_HTTP','/api/local/snapshots',{visitor:a,body:snapshotBody(c)});
  assert(duplicate.replayed===true&&duplicate.snapshot.id===first.snapshot.id,'DUPLICATE_SAVE_SAME_RECORD');
  c=(await expected('NEW_DATE_REVIEW_HTTP',`/api/local/chats/${c.id}/review`,{visitor:a,body:input(c,[35000,25000,20000],'2026-10-24','new')})).conversation;
  verifyReview('NEW_DATE_REVIEW',c,[35000,25000,20000],'2026-10-24');
  assert(compareAmounts(c.state.comparison,10000)&&c.state.comparison.after.status==='CURRENT_INPUT_NOT_SAVED','AUTOMATIC_BASELINE_COMPARISON',{total_delta_yuan:c.state.comparison?.total_delta_cents/100,changes:c.state.comparison?.changes.map(row=>({name:row.name,delta_yuan:row.delta_cents/100,weight_delta_pp:row.weight_delta_pp}))});
  const second=await expected('SECOND_SNAPSHOT_SAVED','/api/local/snapshots',{visitor:a,body:snapshotBody(c)},201);c=second.conversation;state.current_id=second.snapshot.id;state.current_revision=second.snapshot.revision;state.current_version=c.state.version;savePrivate(state);
  const list=await expected('A_SNAPSHOTS_LIST','/api/local/snapshots',{visitor:a});assert(list.snapshots.length===2,'TWO_SNAPSHOTS_ONLY',{count:list.snapshots.length});
  const blank=await expected('BLANK_CHAT_CREATED','/api/local/chats',{visitor:a,body:{}},201);state.restored_chat_id=blank.id;savePrivate(state);
  assert(blank.state.actual.length===0&&!blank.state.review&&!blank.state.baseline_snapshot_id,'NEW_CHAT_HAS_NO_HOLDINGS');
  const restored=await expected('EXPLICIT_RESTORE_HTTP',`/api/local/snapshots/${first.snapshot.id}/restore`,{visitor:a,body:{conversation_id:blank.id,base_version:blank.state.version,revision:first.snapshot.revision}});verifyReview('RESTORED_BASELINE',restored.conversation,[30000,20000,20000],'2026-10-01');
  assert(restored.conversation.state.baseline_snapshot_id===first.snapshot.id,'RESTORE_BINDS_SELECTED_BASELINE');
  await expected('FOREIGN_CHAT_READ_DENIED',`/api/local/chats/${c.id}`,{visitor:b},404);
  const empty=await expected('B_SNAPSHOTS_LIST','/api/local/snapshots',{visitor:b});assert(empty.snapshots.length===0,'B_HAS_NO_A_SNAPSHOTS');
  await expected('FOREIGN_SNAPSHOT_READ_DENIED',`/api/local/snapshots/${first.snapshot.id}`,{visitor:b},404);
  await expected('FOREIGN_SNAPSHOT_UPDATE_DENIED',`/api/local/snapshots/${first.snapshot.id}/update`,{visitor:b,body:{revision:first.snapshot.revision,rows:amounts([1,2,3]),metadata:meta('2026-10-01'),confirmed:true}},404);
  await expected('FOREIGN_SNAPSHOT_DELETE_DENIED',`/api/local/snapshots/${first.snapshot.id}/delete`,{visitor:b,body:{revision:first.snapshot.revision}},404);
  await expected('BAD_CSRF_DENIED',`/api/local/snapshots/${first.snapshot.id}/delete`,{visitor:a,body:{revision:first.snapshot.revision},headers:{'X-CSRF-Token':'synthetic-invalid-csrf'}},403);
  await expected('WRONG_REVIEW_VERSION_DENIED',`/api/local/chats/${c.id}/review`,{visitor:a,body:{...input(c,[1,2,3],'2026-10-24','correct'),base_version:c.state.version-1}},409);
  await expected('WRONG_SNAPSHOT_REVISION_DENIED',`/api/local/snapshots/${first.snapshot.id}/compare`,{visitor:a,body:{revision:first.snapshot.revision+99,other_id:second.snapshot.id,other_revision:second.snapshot.revision}},409);
  const unchanged=await expected('CURRENT_STILL_READABLE',`/api/local/chats/${c.id}`,{visitor:a});verifyReview('CURRENT_UNCHANGED_AFTER_REJECTED_REQUESTS',unchanged,[35000,25000,20000],'2026-10-24');
  Object.assign(state,{status:'COMPLETE',completed_at:now(),expected:{current:[35000,25000,20000],baseline:[30000,20000,20000],current_date:'2026-10-24',baseline_date:'2026-10-01'}});savePrivate(state);
  saveEvidence({checked_at:now(),passed:true,checks,synthetic_current_yuan:[35000,25000,20000],synthetic_baseline_yuan:[30000,20000,20000],persistence:'Seed saved. Run check after redeployment; this seed alone does not prove post-redeployment persistence.'});
 }else{
  state=JSON.parse(fs.readFileSync(privateFile,'utf8'));assert(state.status==='COMPLETE'&&state.origin===origin,'COMPLETE_PRIVATE_SEED_REQUIRED');
  const {a,b,expected:values}=state;
  const c=await expected('PERSISTED_CURRENT_HTTP',`/api/local/chats/${state.chat_id}`,{visitor:a});verifyReview('PERSISTED_CURRENT',c,values.current,values.current_date);assert(c.state.version===state.current_version,'CURRENT_VERSION_PERSISTED',{version:c.state.version});
  const first=(await expected('PERSISTED_BASELINE_HTTP',`/api/local/snapshots/${state.baseline_id}`,{visitor:a})).snapshot;
  const second=(await expected('PERSISTED_SECOND_SNAPSHOT_HTTP',`/api/local/snapshots/${state.current_id}`,{visitor:a})).snapshot;
  verifyRows('PERSISTED_BASELINE_ROWS',first.rows,values.baseline);verifyRows('PERSISTED_SECOND_ROWS',second.rows,values.current);
  assert(first.revision===state.baseline_revision&&second.revision===state.current_revision&&first.metadata.as_of===values.baseline_date&&second.metadata.as_of===values.current_date,'SNAPSHOT_REVISIONS_AND_DATES_PERSISTED');
  const restored=await expected('PERSISTED_RESTORED_CHAT_HTTP',`/api/local/chats/${state.restored_chat_id}`,{visitor:a});verifyReview('PERSISTED_RESTORED_CHAT',restored,values.baseline,values.baseline_date);
  const comparison=(await expected('PERSISTED_SNAPSHOTS_COMPARE_HTTP',`/api/local/snapshots/${first.id}/compare`,{visitor:a,body:{revision:first.revision,other_id:second.id,other_revision:second.revision}})).comparison;
  assert(compareAmounts(comparison,10000)&&comparison.after.kind==='CONFIRMED_SNAPSHOT','PERSISTED_COMPARISON',{total_delta_yuan:comparison.total_delta_cents/100});
  const list=await expected('PERSISTED_SNAPSHOT_LIST_HTTP','/api/local/snapshots',{visitor:a});assert(list.snapshots.length===2,'PERSISTED_SNAPSHOT_COUNT',{count:list.snapshots.length});
  await expected('PERSISTED_ISOLATION_DENIED',`/api/local/snapshots/${first.id}`,{visitor:b},404);
  const bList=await expected('PERSISTED_OTHER_VISITOR_LIST','/api/local/snapshots',{visitor:b});assert(bList.snapshots.length===0,'PERSISTED_OTHER_VISITOR_EMPTY');
  saveEvidence({checked_at:now(),passed:true,checks,seed_completed_at:state.completed_at,operator_reported_release_after_redeploy:afterRelease,persistence:afterRelease?'Same private visitor identities read matching records after operator-reported redeployment. Release label is operator supplied, not inferred from the health route.':'Previously seeded records match. Without --after-release this does not independently establish that a deployment occurred.'});
 }
}catch(error){saveEvidence({checked_at:now(),passed:false,checks,error_code:error.safe?error.message:'NETWORK_STORAGE_OR_PARSE_ERROR',note:'No raw response bodies, cookies, CSRF values, or admin credentials are included. Private seed, when created, stays in ignored .runtime.'});process.exitCode=1;}
