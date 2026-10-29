const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const enterSends=(event,isComposing)=>event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!isComposing&&event.keyCode!==229;
let csrf='',current=null,history=[],source=null,nearBottom=true,submitting=false,selecting=false,viewRevision=0,historyRevision=0,composing=false;
let snapshots=[],draft=null,draftConversation=null,draftVersion=null,record=null,recordMode='',reviewBusy=false;
const screenshotFields=[
 {key:'name',label:'标的名称'},
 {key:'code',label:'代码'},
 {key:'quantity',label:'持仓数量'},
 {key:'cost',label:'持仓成本'},
 {key:'current_price',label:'当前价'},
 {key:'market_value',label:'市值'},
 {key:'pnl',label:'盈亏金额'},
 {key:'pnl_percent',label:'盈亏比例'},
 {key:'weight',label:'持仓占比'}
];
const screenshotState={file:null,objectUrl:'',extraction:null,conversationId:null,viewRevision:null,baseVersion:null,busy:false,worker:null,job:0};
const screenshotFailure='【识别失败，待人工补充】';
const money=c=>(c/100).toLocaleString('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:0});
const beijingDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const dateLabel=s=>s||'日期未提供';
const reviewData=r=>r?.output||r||{};
const reviewRows=r=>reviewData(r).tool?.output?.rows||reviewData(r).chart||reviewData(r).rows||[];
const rowsOf=c=>reviewRows(c?.state?.review).length?reviewRows(c.state.review):(c?.state?.actual_tool?.output?.rows||c?.state?.actual_tool?.rows||c?.state?.actual||[]);
export function normalizeMoneyInput(value){
 const text=String(value??'').trim().replaceAll('，',',');
 if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text))throw Error('金额以元填写，最多两位小数；千分位必须每组三位，例如30,000');
 return text.replaceAll(',','');
}
export function parseHoldingTable(text){
 const delimiter=text.includes('\t')?'\t':',',rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<=text.length;i++){const c=text[i]??'\n';if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else throw Error('引号格式不正确');}
  else if(!quoted&&(c===delimiter||c==='\n')){row.push(cell.trim().replace(/\r$/,''));cell='';if(c==='\n'){if(row.some(Boolean))rows.push(row);row=[];}}else cell+=c;
 }if(quoted)throw Error('表格有未闭合的引号');
 if(rows[0]&&/^(?:名称|资产|资产名称|持仓|持仓名称)$/.test(rows[0][0])){
  const header=rows[0],normalized=(header[1]||'').replace(/[\s（）()]/g,'');
  const allowed=['当前市值元','现值元','金额元','当前市值CNY','现值CNY','金额CNY','当前市值人民币元','现值人民币元','金额人民币元'];
  if(header.length<2||header.length>3||!allowed.includes(normalized)||(header[2]&&!['类型','资产类型'].includes(header[2])))throw Error('表头请使用“名称、当前市值（元）、类型（可选）”。成本、份额、外币或含日期的列不能直接导入；请统一为同一日期的人民币当前市值，并单独填写数据日期。');
  rows.shift();
 }
 if(!rows.length||rows.length>30)throw Error('请粘贴1至30行持仓，每行包含名称和现值（元）');
 return rows.map((cells,i)=>{if(cells.length<2||cells.length>3)throw Error(`第${i+1}行需要名称、金额，可选类型；千分位金额请用引号包住`);const name=cells[0],amount=normalizeMoneyInput(cells[1]);if(!name||name.length>80||!/^\d+(?:\.\d{1,2})?$/.test(amount))throw Error(`第${i+1}行金额请用元填写，最多两位小数`);if(cells[2]&&!['cash','现金','unresolved','资产','股票','基金'].includes(cells[2]))throw Error(`第${i+1}行第三列请填写现金或资产；千分位金额请用引号包住`);const kind=cells[2]==='cash'||cells[2]==='现金'?'cash':'unresolved';return {name,amount,kind};});
}
export function reviewPayload(value,version){
 if(!Number.isInteger(version)||version<0)throw Error('请先重新载入当前对话');
 if(!value.rows.length||value.rows.length>30)throw Error('请填写1至30项持仓');
 const names=new Set();const rows=value.rows.map(r=>{const name=r.name.trim(),amount=normalizeMoneyInput(r.amount);if(!name||names.has(name)||!/^\d+(?:\.\d{1,2})?$/.test(amount))throw Error('请检查重复名称或金额；金额以元填写，最多两位小数');names.add(name);return {name,amount,kind:r.kind==='cash'?'cash':'unresolved'};});
 if(value.as_of&&!/^\d{4}-\d{2}-\d{2}$/.test(value.as_of))throw Error('请填写有效的数据日期');
 return {base_version:version,rows,metadata:{currency:'CNY',basis:'current_value',source:'USER_TABLE',as_of:value.as_of||null,demo:value.demo===true},mode:'correct'};
}
export function answerPresentation(t){
 const rejected=['MODEL_UNGROUNDED_NUMBER','MODEL_STATE_CLAIM_INVALID','MODEL_UNSUPPORTED_CLAIM'].includes(t.error?.code);
 return {text:rejected?'':String(t.assistant||''),statusLabel:t.status==='RUNNING'?(t.assistant?'正在生成，数字待核对':t.phase||'正在处理'):t.status!=='COMPLETE'&&t.assistant&&!rejected?'回复未完成，以上文字尚未完成核对':''};
}
export function historicalState(t,version){
 const basis=t.simulation?(t.context?.scenario?.base_version??t.committed_version):(t.review?.version??t.context?.review?.version??t.committed_version);
 const stale=t.review_stale===true||t.review?.stale===true||(Number.isInteger(basis)&&basis<version);
 return {stale,label:stale?(t.simulation?'历史模拟 · 原始数据已变化，须重新校验。':'历史结论 · 数据已更正，请以当前核对为准。'):''};
}
function inline(s){return esc(s).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');}
function markdown(text){const lines=String(text||'').split('\n');let out='',list=false,ordered=false,code=false,paragraph=[];
 const flush=()=>{if(paragraph.length){out+='<p>'+paragraph.map(inline).join('<br>')+'</p>';paragraph=[];}};
 for(let i=0;i<lines.length;i++){const line=lines[i];if(line.startsWith('```')){flush();if(list){out+=ordered?'</ol>':'</ul>';list=false;}out+=code?'</code></pre>':'<pre><code>';code=!code;continue;}if(code){out+=esc(line)+'\n';continue;}
  if(line.includes('|')&&/^\s*\|?\s*:?-{3}/.test(lines[i+1]||'')){flush();const cells=l=>l.trim().replace(/^\||\|$/g,'').split('|');out+='<div class="table-wrap"><table><thead><tr>'+cells(line).map(x=>'<th>'+inline(x.trim())+'</th>').join('')+'</tr></thead><tbody>';i++;while(lines[i+1]?.includes('|'))out+='<tr>'+cells(lines[++i]).map(x=>'<td>'+inline(x.trim())+'</td>').join('')+'</tr>';out+='</tbody></table></div>';continue;}
  const bullet=/^\s*(?:[-*+] |\d+\. )(.+)/.exec(line),heading=/^(#{1,3})\s+(.+)/.exec(line);
  if(bullet){flush();const type=/^\s*\d/.test(line);if(list&&type!==ordered){out+=ordered?'</ol>':'</ul>';list=false;}if(!list){ordered=type;out+=ordered?'<ol>':'<ul>';list=true;}out+='<li>'+inline(bullet[1])+'</li>';continue;}
  if(list){out+=ordered?'</ol>':'</ul>';list=false;}if(heading){flush();out+=`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;}else if(!line.trim())flush();else paragraph.push(line);
 }flush();if(list)out+=ordered?'</ol>':'</ul>';if(code)out+='</code></pre>';return out;}
async function api(path,body){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const r=await fetch('/api/local'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal});const data=await r.json();if(!r.ok)throw Error(data.error?.message||data.error?.code||'REQUEST_FAILED');return data;}finally{clearTimeout(timer);}}
function screenshotStatus(text=''){
 const node=$('holdings-ocr-status');if(node){node.textContent=text;node.hidden=!text;}
}
function setScreenshotOpen(open){
 const section=$('holdings-screenshot'),button=$('open-holdings-screenshot');if(!section||!button)return;
 section.hidden=!open;button.setAttribute('aria-expanded',String(open));
 if(open){section.scrollIntoView({block:'start',behavior:'smooth'});$('holdings-screenshot-title')?.focus({preventScroll:true});}
}
function screenshotFieldValue(field){const value=field?.value;return value==null?'':String(value).trim();}
function screenshotRows(extraction){
 return Array.isArray(extraction?.rows)?extraction.rows.map(row=>{
  const out={};for(const field of screenshotFields){const raw=row?.[field.key];out[field.key]={value:screenshotFieldValue(raw),evidence:raw?.evidence==null?'':String(raw.evidence)};}return out;
 }):[];
}
function screenshotExtractionHTML(extraction){
 const rows=screenshotRows(extraction),warnings=Array.isArray(extraction?.warnings)?extraction.warnings:[];
 const date=extraction?.as_of&&/^\d{4}-\d{2}-\d{2}$/.test(extraction.as_of)?extraction.as_of:'';
 return '<div class="extraction-heading"><div><p class="eyebrow">OCR 结果 · 逐字段核对</p><h3>识别到 '+rows.length+' 行持仓</h3></div><span class="tag">尚未写入持仓</span></div>'+
  (warnings.length?'<div class="screenshot-warnings" role="alert"><strong>请留意：</strong>'+warnings.map(item=>'<span>'+esc(item)+'</span>').join('')+'</div>':'')+
  '<form id="holdings-extraction-form"><div class="table-wrap screenshot-table-wrap" tabindex="0" aria-label="可左右滚动的持仓识别表"><table class="screenshot-table"><thead><tr><th>行</th>'+screenshotFields.map(field=>'<th>'+field.label+'</th>').join('')+'</tr></thead><tbody>'+
  rows.map((row,index)=>'<tr data-screenshot-row="'+index+'"><th scope="row">'+(index+1)+'</th>'+screenshotFields.map(field=>{
   const item=row[field.key]||{value:'',evidence:''},value=String(item.value||''),evidence=String(item.evidence||'');
   return '<td><label class="sr-only" for="screenshot-'+index+'-'+field.key+'">第'+(index+1)+'行'+field.label+'</label><input id="screenshot-'+index+'-'+field.key+'" name="'+field.key+'" value="'+esc(value)+'" data-original="'+esc(value)+'" data-evidence="'+esc(evidence)+'" placeholder="'+screenshotFailure+'" maxlength="80" inputmode="'+(['market_value','quantity'].includes(field.key)?'decimal':'text')+'"><small class="screenshot-missing"'+(value?' hidden':'')+'>'+screenshotFailure+'</small><details class="screenshot-evidence"><summary>识别依据</summary>'+esc(evidence||'没有可核实 OCR 证据')+'</details></td>';
  }).join('')+'</tr>').join('')+
  '</tbody></table></div><p class="screenshot-table-help">表格可左右滚动。可以修正每一格；空白字段保持识别失败，缺少名称或市值的行不会导入。</p><div class="screenshot-confirm-meta"><label>数据日期<input type="date" name="screenshot-as-of" value="'+esc(date)+'" required></label><label>币种<select name="screenshot-currency" required><option value="">请核对币种</option><option value="CNY"'+(extraction?.currency==='CNY'?' selected':'')+'>CNY / 人民币</option><option value="OTHER"'+(extraction?.currency&&extraction.currency!=='CNY'?' selected':'')+'>其他币种（不可导入）</option></select></label></div><p class="screenshot-confirm-note">请核对日期、币种和每项当前市值。这里只导入人民币当前市值（元）；成本、数量、当前价和占比不会代替市值，也不会反推缺失字段。比例请带 %，金额填元。导入会替换本对话原始持仓，未导入的行不参与分析。</p><label class="check-label screenshot-confirm-check"><input type="checkbox" name="screenshot-confirmed" required>我已对照截图核对，确认日期、人民币市值与导入范围；缺失信息仍保留为未知</label><div class="action-row"><button class="primary" type="submit"'+(!rows.length?' disabled':'')+'>确认并写入当前持仓</button><button class="quiet-button" type="button" data-clear-extraction>重新识别</button></div><div class="inline-notice" role="status"></div></form>';
}
function renderScreenshotExtraction(extraction){
 const panel=$('holdings-extraction');if(!panel)return;panel.hidden=false;panel.innerHTML=screenshotExtractionHTML(extraction);
 const form=$('holdings-extraction-form');
 form?.addEventListener('input',()=>{for(const input of form.querySelectorAll('input[data-original]')){input.classList.toggle('is-edited',input.value.trim()!==input.dataset.original);input.parentElement.querySelector('.screenshot-missing').hidden=!!input.value.trim();}form.querySelector('[name="screenshot-confirmed"]').checked=false;});
 // The confirmation checkbox must remain checked after the user ticks it.
 form?.querySelector('[name="screenshot-confirmed"]')?.addEventListener('input',event=>event.stopPropagation());
 form?.addEventListener('submit',event=>{event.preventDefault();confirmScreenshotExtraction(form).catch(error=>{const note=form.querySelector('.inline-notice');if(note)note.textContent='未完成：'+error.message+'。识别表格仍保留在本机。';});});
 form?.addEventListener('click',event=>{if(event.target.closest('[data-clear-extraction]')&&!screenshotState.busy){screenshotState.extraction=null;panel.hidden=true;screenshotStatus('核对表已清除，可重新识别图片。');}});
}
export function filterOcrText(result){
 const data=result?.data||{},blocks=Array.isArray(data.blocks)?data.blocks:[];
 const lines=Array.isArray(data.lines)?data.lines:blocks.flatMap(block=>(block.paragraphs||[]).flatMap(paragraph=>paragraph.lines||[]));
 if(!lines.length)return '';
 return lines.map(line=>{const words=Array.isArray(line.words)?line.words:[],confidence=Number(line.confidence??(words.length?words.reduce((sum,word)=>sum+Number(word.confidence||0),0)/words.length:NaN));return Number.isFinite(confidence)&&confidence>=70?String(line.text||''):'';}).filter(Boolean).join('\n').trim();
}
async function imageDimensions(file){
 if(typeof createImageBitmap==='function'){const bitmap=await createImageBitmap(file);const dimensions={width:bitmap.width,height:bitmap.height};bitmap.close?.();return dimensions;}
 return await new Promise((resolve,reject)=>{const url=URL.createObjectURL(file),image=new Image();image.onload=()=>{URL.revokeObjectURL(url);resolve({width:image.naturalWidth,height:image.naturalHeight});};image.onerror=()=>{URL.revokeObjectURL(url);reject(Error('图片尺寸读取失败'));};image.src=url;});
}
async function validateScreenshotFile(file){
 if(!file)throw Error('请先选择持仓截图');if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw Error('仅支持 PNG、JPEG 或 WebP 图片');if(file.size>5*1024*1024)throw Error('图片不能超过 5 MB');
 const {width,height}=await imageDimensions(file);if(!width||!height)throw Error('图片尺寸读取失败');if(width*height>10_000_000)throw Error('图片像素不能超过 1,000 万');return {width,height};
}
function screenshotControls(){
 for(const id of ['choose-holdings-image','run-holdings-ocr','clear-holdings-image']){const button=$(id);if(button)button.disabled=screenshotState.busy;}
 const form=$('holdings-extraction-form');if(form)for(const input of form.querySelectorAll('input,select,button'))input.disabled=screenshotState.busy;
}
function clearScreenshotFile(){
 screenshotState.job++;screenshotState.worker?.terminate?.().catch(()=>{});screenshotState.worker=null;
 if(screenshotState.objectUrl)URL.revokeObjectURL(screenshotState.objectUrl);
 Object.assign(screenshotState,{file:null,objectUrl:'',extraction:null,conversationId:null,viewRevision:null,baseVersion:null,busy:false});
 $('holdings-image-file').value='';$('holdings-image').removeAttribute('src');$('holdings-image-preview').hidden=true;$('holdings-extraction').hidden=true;$('holdings-extraction').innerHTML='';$('holdings-ocr-progress').hidden=true;screenshotStatus('');screenshotControls();
}
function resetScreenshotForChat(){if(!$('holdings-screenshot'))return;clearScreenshotFile();setScreenshotOpen(false);}
async function chooseScreenshotFile(file){
 if(screenshotState.busy)return;const job=++screenshotState.job;
 try{const dimensions=await validateScreenshotFile(file);if(job!==screenshotState.job)return;clearScreenshotFile();screenshotState.file=file;screenshotState.objectUrl=URL.createObjectURL(file);$('holdings-image').src=screenshotState.objectUrl;$('holdings-image-name').textContent=file.name+' · '+dimensions.width+'×'+dimensions.height;$('holdings-image-preview').hidden=false;screenshotStatus('图片已准备好，可开始本机 OCR。');}
 catch(error){if(job!==screenshotState.job)return;clearScreenshotFile();screenshotStatus(error.message);}
}
async function runScreenshotOCR(){
 if(screenshotState.busy)return;if(!screenshotState.file)throw Error('请先选择持仓截图');if(active()||submitting||selecting||reviewBusy)throw Error('请先停止或等待当前任务完成，再识别截图');if(!window.Tesseract?.createWorker)throw Error('本机 OCR 组件尚未加载，请刷新后重试');
 if(!current)await newChat(true);
 const job=++screenshotState.job,cid=current.id,revision=viewRevision,file=screenshotState.file;
 if(!file)throw Error('新对话已准备好，请重新选择截图');
 Object.assign(screenshotState,{busy:true,conversationId:cid,viewRevision:revision,baseVersion:current.state.version});
 const progress=$('holdings-ocr-progress'),meter=$('holdings-ocr-meter'),label=$('holdings-ocr-progress-label');progress.hidden=false;meter.value=0;screenshotControls();screenshotStatus('正在本机读取图片……');let worker=null;
 try{
  worker=await window.Tesseract.createWorker('chi_sim+eng',1,{workerPath:'/ocr/worker.min.js',corePath:'/ocr/core',langPath:'/ocr/lang',workerBlobURL:false,logger:info=>{
   if(job!==screenshotState.job)return;const value=Number(info?.progress);if(Number.isFinite(value))meter.value=Math.max(0,Math.min(1,value));const statusLabels={'loading tesseract core':'正在加载识别引擎','initializing tesseract':'正在准备识别','loading language traineddata':'正在加载中文和英文','initializing api':'正在初始化','recognizing text':'正在识别文字'};label.textContent=(statusLabels[info?.status]||'正在准备识别')+(Number.isFinite(value)?' · '+Math.round(value*100)+'%':'');
  }});
  if(job!==screenshotState.job){await worker.terminate();return;}screenshotState.worker=worker;
  const result=await worker.recognize(file,{}, {text:true,blocks:true});if(job!==screenshotState.job)return;
  const filtered=filterOcrText(result);if(!filtered)throw Error('没有得到置信度达到 70% 的可用文字，请选择更清晰的截图或手动录入');
  screenshotStatus('本机识别完成，正在通过现有模型服务整理文字……');const response=await api('/holdings/extract',{text:filtered});
  if(job!==screenshotState.job)return;if(revision!==viewRevision||current?.id!==cid)throw Error('当前对话已切换，请重新识别截图');
  screenshotState.extraction=response.extraction||{rows:[],as_of:null,currency:null,warnings:['服务未返回可编辑结果']};renderScreenshotExtraction(screenshotState.extraction);screenshotStatus('已展示全部识别字段。缺少字段保留为识别失败，请对照截图逐项核对。');
 }finally{
  try{await worker?.terminate?.();}catch{}if(job===screenshotState.job){screenshotState.worker=null;screenshotState.busy=false;progress.hidden=true;screenshotControls();}
 }
}
function screenshotDisplayTable(details){
 if(!details?.rows?.length)return '';
 return '<details class="details screenshot-saved-details"><summary>查看已确认截图的全部字段</summary><div class="table-wrap"><table class="screenshot-saved-table"><thead><tr>'+screenshotFields.map(field=>'<th>'+field.label+'</th>').join('')+'</tr></thead><tbody>'+details.rows.map(row=>'<tr>'+screenshotFields.map(field=>'<td>'+esc(screenshotFieldValue(row[field.key])||screenshotFailure)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div><p class="scope-note">用户确认的截图记录，非实时行情。未识别字段保持未知；行业、历史风险、财报和新闻仍需额外数据核验。</p></details>';
}
function screenshotConfirmedRows(rows){
 return rows.map((row,index)=>Object.fromEntries(screenshotFields.map(field=>{
  const original=row[field.key]||{},text=screenshotFieldValue(original);if(!text)return [field.key,{value:null,evidence:null}];if(text.length>80)throw Error('第'+(index+1)+'行'+field.label+'不能超过80字');
  if(['name','code'].includes(field.key))return [field.key,{value:text,evidence:original.evidence||null}];
  const normalized=text.normalize('NFKC').replace(/\s+/g,'').replaceAll(',','').replace('−','-').replace(/^[¥￥]/,'').replace(/[元股份]$/,'');
  const percent=['pnl_percent','weight'].includes(field.key),negative=['pnl','pnl_percent'].includes(field.key),pattern=percent?/^[+-]?\d+(?:\.\d+)?%$/:/^[+-]?\d+(?:\.\d+)?$/;
  if(!pattern.test(normalized)||(!negative&&Number(normalized.replace('%',''))<0)||!Number.isFinite(Number(normalized.replace('%','')))||Math.abs(Number(normalized.replace('%','')))>1e12)throw Error('第'+(index+1)+'行'+field.label+'格式不明确，请按原图核对'+(percent?'并填写百分号':'；不要以成本或数量代替市值'));
  return [field.key,{value:normalized.replace(/^\+/,''),evidence:original.evidence||null}];
 })));
}
function screenshotPlainAmount(value){
 const text=String(value??'').trim().replace(/^[¥￥]\s*/,'');
 try{return normalizeMoneyInput(text);}catch{return null;}
}
function readScreenshotForm(form){
 const rows=[...form.querySelectorAll('tr[data-screenshot-row]')].map(row=>{const output={};for(const field of screenshotFields){const input=row.querySelector('[name="'+field.key+'"]'),value=input?.value.trim()||null,original=input?.dataset.original||'';output[field.key]={value,evidence:value&&value===original?(input.dataset.evidence||null):null};}return output;});
 return {rows,as_of:form.querySelector('[name="screenshot-as-of"]').value,currency:form.querySelector('[name="screenshot-currency"]').value,warnings:Array.isArray(screenshotState.extraction?.warnings)?screenshotState.extraction.warnings:[],confirmed:form.querySelector('[name="screenshot-confirmed"]').checked};
}
export function screenshotReviewPayload(value,version){
 if(!Number.isInteger(version)||version<0)throw Error('当前对话尚未准备好，请重新选择对话');if(!value.confirmed)throw Error('请先对照截图核对并勾选确认');if(value.currency!=='CNY')throw Error('当前只允许确认 CNY / 人民币持仓');if(!/^\d{4}-\d{2}-\d{2}$/.test(value.as_of)||Number.isNaN(Date.parse(value.as_of+'T00:00:00Z'))||new Date(value.as_of+'T00:00:00Z').toISOString().slice(0,10)!==value.as_of)throw Error('请确认有效的数据日期');
 const rows=[],skipped=[],names=new Set(),confirmedRows=screenshotConfirmedRows(value.rows);let incomplete=false;
 for(const row of confirmedRows){const name=screenshotFieldValue(row.name),amount=screenshotPlainAmount(row.market_value?.value);if(screenshotFields.some(field=>!screenshotFieldValue(row[field.key])))incomplete=true;if(!name||amount==null){skipped.push(name||'未命名行');continue;}if(names.has(name))throw Error('存在重复名称，请核对或为不同标的补上代码');if(name.length>80)throw Error('标的名称不能超过80字');names.add(name);rows.push({name,amount,kind:'unresolved'});}
 if(!rows.length||rows.length>30)throw Error('请确认1至30行同时包含标的名称和当前市值（元）的持仓');
 return {base_version:version,rows,metadata:{currency:'CNY',basis:'current_value',source:'USER_TABLE',as_of:value.as_of,demo:false},screenshot_details:{rows:confirmedRows,as_of:value.as_of,currency:value.currency,warnings:value.warnings,source:'USER_CONFIRMED_SCREENSHOT',confirmed:true,skipped_rows:skipped,incomplete}};
}
async function confirmScreenshotExtraction(form){
 if(screenshotState.busy||reviewBusy)return;if(active()||submitting||selecting)throw Error('请先停止或等待当前任务完成');if(!current||current.id!==screenshotState.conversationId||viewRevision!==screenshotState.viewRevision)throw Error('当前对话已切换，请重新识别截图');if(current.state.version!==screenshotState.baseVersion)throw Error('识别期间持仓已改变，请重新识别或重新核对当前持仓');
 const value=readScreenshotForm(form),payload=screenshotReviewPayload(value,current.state.version),cid=current.id,revision=viewRevision,job=screenshotState.job;
 payload.mode=current.state.actual?.length?'correct':'new';screenshotState.busy=true;reviewBusy=true;screenshotControls();controls();
 try{
  const response=await api('/chats/'+cid+'/review',payload);
  if(current?.id===cid&&viewRevision===revision){current=response.conversation;draft=null;render();const skipped=payload.screenshot_details.skipped_rows.length;notice('已将 '+payload.rows.length+' 行已确认市值写入当前持仓。'+(skipped?'另有 '+skipped+' 行缺少名称或市值，未纳入分析。':'')+(payload.screenshot_details.incomplete?'部分字段仍未知，当前分析范围不完整。':''));clearScreenshotFile();setScreenshotOpen(false);}
  await refreshHistory();
 }finally{reviewBusy=false;if(job===screenshotState.job)screenshotState.busy=false;screenshotControls();controls();}
}
function notice(text=''){$('notice').textContent=text;$('notice').hidden=!text;}
function active(){return current?.turns.find(t=>t.status==='RUNNING');}
function controls(){const running=!!active();$('send').hidden=running;$('send').disabled=submitting||selecting||reviewBusy;$('stop').hidden=!running;}
function stick(){if(nearBottom)$('scroll-area').scrollTop=$('scroll-area').scrollHeight;$('to-bottom').hidden=nearBottom;}
function historyView(){$('history').innerHTML=history.map(c=>`<button data-chat="${esc(c.id)}" aria-current="${c.id===current?.id}" title="${esc(c.title)}">${esc(c.title)}</button>`).join('');}
function table(t){if(!t.tool||!t.tool.output.rows.length)return '';const o=t.tool.output,old=historicalState(t,current.state.version);return `${!old.stale&&t.context?.previous_scenario_stale?'<p class="plan-update">原始持仓已更正，旧方案已失效。以下方案已按最新持仓重新计算并重新检查操作范围；请确认要保存的模拟方案。</p>':''}<p class="tool-label">${t.simulation?(old.stale?'历史模拟 · 基于当时的原始数据':'模拟方案 · 原始持仓未变'):(old.stale?'当时的原始持仓':'原始持仓 · 按录入金额计算')} · 合计 ¥${money(o.total_cents)}</p>${holdingsTable(o.rows)}${t.simulation&&t.context?.actual?.length?`<p class="original-note">${old.stale?'当时的原始持仓':'原始持仓'}：${(t.context?.actual||[]).map(r=>esc(r.name)+' '+money(r.amount_cents)+'元').join(' · ')}</p>`:''}<p class="scope-note">来源：${(t.review?.metadata?.source||t.context?.review?.metadata?.source)==='USER_TABLE'?'用户表格':'用户录入'}；数据日期 ${esc(dateLabel(t.review?.metadata?.as_of||t.context?.review?.metadata?.as_of))}；标的属性和实时行情未核验。</p>`;}
function turnHTML(t){const latest=t===current.turns.at(-1),s=current.state.scenario,answer=answerPresentation(t),old=historicalState(t,current.state.version);
 return `<article class="turn" data-turn="${esc(t.id)}"><div class="user">${esc(t.user)}</div><div class="assistant-head"><span class="symbol">◈</span>Personal AI Fund Manager</div>${old.stale?`<p class="superseded">${esc(old.label)}</p>`:''}<div class="assistant-body">${markdown(answer.text)}</div><div class="${t.status==='RUNNING'?'phase':'partial-note'}" ${!answer.statusLabel?'hidden':''}>${esc(answer.statusLabel)}</div><div class="tool-result">${table(t)}</div>${t.error?`<div class="error">${esc(t.error.message)}${latest?`<br><button class="retry" data-retry="${esc(t.id)}">重试这条消息</button>`:''}</div>`:''}${s?.requires_confirmation&&t.context?.scenario?.id===s.id&&s.base_version===current.state.version&&t.status==='COMPLETE'&&['ALLOW','REVIEW'].includes(t.risk?.result?.decision)?`<button class="confirm" data-confirm="${esc(s.id)}">确认保存此模拟方案</button><p class="scope-note">确认后仍不会交易，也不会改动原始持仓。</p>`:''}<details class="details"><summary>查看依据与处理记录</summary>${t.error?`<p>处理标识：${esc(t.error.code)}</p>${t.error.numeric_diagnostic?`<p>未通过校验的数字：${esc(t.error.numeric_diagnostic.value)} ${esc(t.error.numeric_diagnostic.unit)}；对应工具值 ${esc(t.error.numeric_diagnostic.expected??"无匹配")}；检查项 ${esc(t.error.numeric_diagnostic.reason)}</p>`:""}${t.plan?.changes?.length?`<p>本次识别的输入（尚未完成核对）</p><pre>${esc(JSON.stringify(t.plan.changes.map(({name,amount,unit,kind})=>({名称:name,金额:amount,单位:unit,类型:kind})),null,2))}</pre>`:""}`:""}<p>${t.source==='SERVER_CONFIRMATION'?'服务端模拟确认':t.source==='SERVER_DATA_REVIEW'?'已按确认数据重新核对，未调用模型':t.receipts?.length?'真实模型：'+esc(t.receipts.at(-1).model):'尚无完整模型回执'}${t.risk?' · 风控 '+esc(t.risk.result.decision):''}</p>${(t.events||[]).map(e=>'<div>'+esc(e.message)+' · '+new Date(e.at).toLocaleTimeString('zh-CN')+'</div>').join('')}<p>${t.tool?'计算工具：'+esc(t.tool.tool_name)+' · '+esc(t.tool.calculated_at):'解释或澄清不强制调用持仓计算。'}</p>${t.trace_id?`<p>本轮核对编号：${esc(t.trace_id)}</p>`:''}<p>各对话的原始持仓相互隔离。主动保存的持仓记录可在本浏览器的其他对话中载入。</p></details></article>`;
}
function render(){const all=current?.turns||[],retried=new Set(all.map(t=>t.retry_of).filter(Boolean)),turns=all.filter(t=>!retried.has(t.id));$('welcome').hidden=turns.length>0||rowsOf(current).length>0;$('messages').innerHTML=turns.map(turnHTML).join('');historyView();renderReview();controls();stick();}
async function refreshHistory(){const revision=++historyRevision,result=await api('/chats');if(revision!==historyRevision)return;history=result.conversations;historyView();}
function closeSidebar(){document.body.classList.remove('show-history');$('shade').hidden=true;$('menu').setAttribute('aria-expanded','false');}
async function openChat(id){resetScreenshotForChat();const revision=++viewRevision;selecting=true;source?.close();controls();try{const selected=await api('/chats/'+id);if(revision!==viewRevision)return;current=selected;localStorage.setItem('fund-current-chat',id);nearBottom=true;render();closeSidebar();if(active())subscribe(active().id);}finally{if(revision===viewRevision){selecting=false;controls();}}}
async function newChat(preserveScreenshot=false){if(!preserveScreenshot)resetScreenshotForChat();const revision=++viewRevision;selecting=true;source?.close();controls();try{const selected=await api('/chats',{});if(revision!==viewRevision)return;current=selected;localStorage.setItem('fund-current-chat',current.id);$('question').value='';nearBottom=true;await refreshHistory();if(revision!==viewRevision)return;render();closeSidebar();$('question').focus();}finally{if(revision===viewRevision){selecting=false;controls();}}}
function subscribe(tid){source?.close();const cid=current.id,revision=viewRevision,stream=new EventSource(`/api/local/chats/${cid}/turns/${tid}/events`);source=stream;
 const selected=()=>current?.id===cid&&viewRevision===revision&&source===stream;
 stream.onmessage=async event=>{if(!selected())return;const data=JSON.parse(event.data),t=current.turns.find(t=>t.id===tid);if(!t)return;if(data.type==='delta'){
  t.assistant+=data.text;const body=document.querySelector(`[data-turn="${tid}"] .assistant-body`);if(body)body.innerHTML=markdown(t.assistant);const phase=document.querySelector(`[data-turn="${tid}"] .phase`);if(phase){phase.hidden=false;phase.textContent='正在生成，数字待核对';}stick();
 }else if(data.type==='turn'){Object.assign(t,data.turn);render();if(t.status!=='RUNNING'){stream.close();try{const updated=await api('/chats/'+cid);if(selected()){current=updated;render();}await refreshHistory();}catch(error){if(selected())notice('回复已结束，但最新记录暂未载入。请重新选择本对话或刷新后核对：'+error.message);}}}
 };stream.onerror=()=>{if(selected())notice('连接暂时中断，正在恢复同一条回复；不会重新提交模型请求。');};stream.onopen=()=>{if(selected())notice();};}
async function send(text,retry){if(submitting||selecting||active())return;submitting=true;controls();notice();const revision=viewRevision;let destination=current;try{
 if(!destination){destination=await api('/chats',{});if(revision===viewRevision){current=destination;localStorage.setItem('fund-current-chat',current.id);}}
 const cid=destination.id,request={request_id:crypto.randomUUID(),...(retry?{retry_turn_id:retry}:{text})};
 // Bind the submission to its originating conversation even if selection changes.
 localStorage.setItem('fund-pending',JSON.stringify({cid,request}));
 const t=await api('/chats/'+cid+'/turns',request);localStorage.removeItem('fund-pending');
 if(!selecting&&current?.id===cid){const existing=current.turns.find(turn=>turn.id===t.id);if(existing)Object.assign(existing,t);else current.turns.push(t);$('question').value='';nearBottom=true;render();subscribe(t.id);}await refreshHistory();
 }catch(e){if(revision===viewRevision)notice('消息尚未确认提交：'+e.message+'。输入已保留；点击发送可恢复原请求。');}finally{submitting=false;controls();}}
function holdingsTable(rows){return `<div class="table-wrap"><table><thead><tr><th>名称</th><th>当前市值（元）</th><th>占比</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.name)}</td><td>${money(r.amount_cents)}</td><td>${r.weight_pct==null?'—':esc(r.weight_pct)+'%'}</td></tr>`).join('')}</tbody></table></div>`;}
function totalOf(r){return reviewData(r).tool?.output?.total_cents??reviewData(r).total_cents;}
export function evidenceText(e){if(typeof e!=='object'||e===null)return String(e??'');const facts=[];
 if(e.name)facts.push(e.name);if(e.amount_cents!=null)facts.push('该项当前市值 '+money(e.amount_cents)+' 元');if(e.cash_cents!=null)facts.push('已录入现金 '+money(e.cash_cents)+' 元');if(e.cash_known===false)facts.push('本次未录入现金条目');if(e.total_cents!=null)facts.push('已列合计 '+money(e.total_cents)+' 元');if(e.weight_pct!=null)facts.push('占比 '+e.weight_pct+'%');if(e.unresolved_names?.length)facts.push('尚待核实：'+e.unresolved_names.join('、'));if(e.source)facts.push('来源：'+(e.source==='USER_TABLE'?'用户表格':'用户录入'));if('as_of'in e)facts.push('数据日期：'+dateLabel(e.as_of));if(e.basis==='current_value')facts.push('口径：人民币当前市值');if(e.demo)facts.push('演示数据');return facts.join('；');
}
function formulaText(text){return String(text||'').replaceAll('cash_weight_pct','现金占比').replaceAll('sum(cash.amount_cents)','已录入现金金额').replaceAll('sum(amount_cents)','各项当前市值相加').replaceAll('weight_pct','该项占比').replaceAll('amount_cents','该项当前市值').replaceAll('total_cents','已列持仓合计');}
function reviewSummary(review){const r=reviewData(review),rows=reviewRows(r),total=totalOf(r);
 return `${total!=null?`<div class="review-total"><span>已列持仓合计</span><strong>¥${money(total)}</strong><small>人民币 · 当前市值</small></div>`:''}${holdingsTable(rows)}${r.chart?.length?`<div class="allocation" aria-label="持仓占比">${r.chart.map(x=>`<div class="allocation-row"><span>${esc(x.name)}</span><progress class="allocation-track" max="100" value="${Math.max(0,Math.min(100,Number(x.weight_pct)||0))}" aria-label="${esc(x.name)}${x.weight_pct==null?'占比未计算':'占比 '+esc(x.weight_pct)+'%'}"></progress><b>${x.weight_pct==null?'—':esc(x.weight_pct)+'%'}</b></div>`).join('')}</div>`:''}<div class="findings">${(r.findings||[]).slice(0,3).map(f=>`<article><h3>${esc(f.title)}</h3><p>${esc(f.summary)}</p><details class="details"><summary>依据与边界</summary>${[['计算依据',evidenceText(f.evidence)],['计算方式',formulaText(f.formula)],['尚缺资料',f.missing],['对判断的影响',f.impact],['可以补充',f.next]].filter(([,v])=>v!=null&&String(v).length).map(([label,value])=>`<p><strong>${label}</strong> ${esc(Array.isArray(value)?value.join('；'):typeof value==='object'?JSON.stringify(value):value)}</p>`).join('')}</details></article>`).join('')}</div><p class="scope-note">${r.metadata?.demo?'演示数据 · ':''}来源：${r.metadata?.source==='USER_TABLE'?'用户表格':'用户录入'} · 数据日期：${esc(dateLabel(r.metadata?.as_of))}。未经实时行情核验。</p>${r.unavailable?.length?`<details class="details"><summary>当前不能判断什么</summary><ul>${r.unavailable.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}`;
}
function makeDraft(rows,metadata={}){return {rows:rows.map(r=>({name:r.name,amount:String(r.amount_cents/100),kind:r.kind==='cash'?'cash':'unresolved'})),as_of:metadata.as_of||'',demo:metadata.demo===true};}
function editRow(r,i){return `<div class="edit-row" data-row="${i}"><label><span class="sr-only">第${i+1}项名称</span><input name="asset-name" value="${esc(r.name)}" maxlength="80" placeholder="资产名称" required></label><label><span class="sr-only">第${i+1}项现值（元）</span><input name="asset-amount" value="${esc(r.amount)}" inputmode="decimal" placeholder="现值（元）" required></label><label><span class="sr-only">第${i+1}项类型</span><select name="asset-kind"><option value="unresolved" ${r.kind!=='cash'?'selected':''}>资产（属性未核实）</option><option value="cash" ${r.kind==='cash'?'selected':''}>现金</option></select></label><button type="button" data-remove="${i}" aria-label="删除第${i+1}项">×</button></div>`;}
function editorHTML(value,scope='review'){return `<p class="scope-note">填写人民币当前市值，不是份额或买入成本。留空的日期不会自动补成今天。</p><div class="edit-table">${value.rows.map(editRow).join('')}</div><button type="button" class="quiet-button" data-add-row>＋ 添加一项</button><div class="edit-meta"><label>数据日期<input type="date" name="as-of" value="${esc(value.as_of)}"></label><label class="check-label"><input type="checkbox" name="demo" ${value.demo?'checked':''}>这是演示数据</label></div><details class="paste"><summary>粘贴表格</summary><label class="sr-only" for="${scope}-paste-table">粘贴持仓表格</label><textarea id="${scope}-paste-table" name="paste-table" rows="3" placeholder="名称&#9;当前市值（元）&#10;股票A&#9;60000&#10;现金&#9;20000"></textarea><p class="scope-note">支持制表符或 CSV，两列：名称、金额（元）；可选第三列“现金”。粘贴内容会替换上表。</p><button type="button" class="quiet-button" data-parse>填入表格</button></details>`;}
function readEditor(container){return {rows:[...container.querySelectorAll('.edit-row')].map(el=>({name:el.querySelector('[name="asset-name"]').value,amount:el.querySelector('[name="asset-amount"]').value,kind:el.querySelector('[name="asset-kind"]').value})),as_of:container.querySelector('[name="as-of"]').value,demo:container.querySelector('[name="demo"]').checked};}
function renderReview(){const panel=$('current-review'),r=current?.state?.review;if(draft&&draftConversation===current?.id&&panel.querySelector('#review-editor'))return;if(draftConversation!==current?.id)draft=null;
 if(!r&&!draft){panel.hidden=true;return;}panel.hidden=false;
 if(draft){panel.innerHTML=`<div class="review-heading"><div><p class="eyebrow">核对原始持仓</p><h2>把数据改对，再看结论</h2></div></div><form id="review-editor">${editorHTML(draft)}<div class="action-row"><button type="submit" class="primary">确认数据并重新核对</button><button type="button" class="quiet-button" data-cancel-edit>取消修改</button></div><div class="inline-notice" role="status"></div></form>`;return;}
 panel.innerHTML=`<div class="review-heading"><div><p class="eyebrow">当前对话 · 最新核对</p><h2>先核对金额，再看结构</h2></div><span class="date-pill">${esc(dateLabel(r.metadata?.as_of))}</span></div>${reviewSummary(r)}${screenshotDisplayTable(current.state.screenshot_details)}${current.state.comparison_unavailable?`<p class="scope-note">${esc(current.state.comparison_unavailable.message)}</p>`:''}${current.state.comparison?`<details class="current-comparison" open><summary>与已保存记录比较</summary>${current.state.comparison.stale?'<p class="scope-note">基准或当前数据已变化，请重新选择记录比较。</p>':comparisonHTML(current.state.comparison)}</details>`:''}<div class="action-row"><button class="primary" data-save-record>保存为一份新记录</button><button class="quiet-button" data-edit-review>修改金额或日期</button><button class="quiet-button" data-compare-current ${!snapshots.length?'disabled':''}>与已保存记录比较</button></div><div id="save-record-form"></div>${r.followups?.length?`<div class="followups"><p>继续聊这份持仓</p>${r.followups.slice(0,3).map(q=>`<button data-question="${esc(q)}">${esc(q)} ↗</button>`).join('')}</div>`:''}`;
}
async function startEditor(){if(active())return notice('请先停止或等待当前回复完成，再修改原始持仓。');if(!current)await newChat();draft=makeDraft(rowsOf(current),current.state.metadata||current.state.review?.metadata);if(!draft.rows.length)draft.rows=[{name:'',amount:'',kind:'unresolved'}];draftConversation=current.id;draftVersion=current.state.version;renderReview();$('current-review').scrollIntoView({block:'start'});}
async function refreshSnapshots(){const result=await api('/snapshots');snapshots=result.snapshots||[];renderSnapshots();}
async function refreshCurrent(){if(!current)return;const cid=current.id,revision=viewRevision;const updated=await api('/chats/'+cid);if(current?.id===cid&&viewRevision===revision){current=updated;render();}}
function renderSnapshots(){$('snapshot-count').textContent=snapshots.length;$('snapshots').innerHTML=snapshots.length?snapshots.map(s=>`<button class="snapshot-item" data-snapshot="${esc(s.id)}"><strong>${esc(s.name||'持仓记录')}</strong><span>${esc(dateLabel(s.metadata?.as_of))} · 修订 ${esc(s.revision)}</span><small>¥${money(s.total_cents||0)} · ${esc(s.rows_count)}项</small></button>`).join(''):'<p class="empty-records">核对持仓后，确认保存，记录会出现在这里。</p>';$('compare-records').disabled=!snapshots.length;}
function recordNotice(text=''){$('record-notice').textContent=text;}
function showDialog(title,html){$('record-title').textContent=title;$('record-content').innerHTML=html;recordNotice();if(!$('record-dialog').open)$('record-dialog').showModal();}
async function openRecord(id){const data=await api('/snapshots/'+id);record=data.snapshot;recordMode='view';showRecord();}
function showRecord(){showDialog(record.name||'持仓记录',`<p class="scope-note">持仓日期 ${esc(dateLabel(record.metadata?.as_of))} · 修订 ${esc(record.revision)} · 保存于 ${esc(new Date(record.updated_at||record.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}))}（北京时间）</p>${reviewSummary(record.review)}<div class="action-row"><button class="primary" data-record-restore>载入当前对话核对</button><button class="quiet-button" data-record-edit>更正这份已保存记录</button><button class="danger-button" data-record-delete>删除记录</button></div><div id="record-confirmation"></div><p class="scope-note">更正会增加修订版本；新的日期请保存为一份新记录，方便比较变化。</p>`);}
// Preselection is a convenience, never a new baseline or a write. Do not infer
// that two unrelated conversations represent the same portfolio.
export function comparisonDefaults(saved,conversation){
 const date=s=>s?.metadata?.as_of;
 const eligible=s=>s?.metadata?.currency==='CNY'&&s.metadata.basis==='current_value'&&/^\d{4}-\d{2}-\d{2}$/.test(date(s)||'');
 const ordered=saved.filter(eligible).slice().sort((a,b)=>date(b).localeCompare(date(a))||String(b.created_at||'').localeCompare(String(a.created_at||'')));
 const state=conversation?.state,hasCurrent=!!state?.actual?.length;
 const currentData={id:'current',metadata:state?.metadata||state?.review?.metadata,source_conversation_id:conversation?.id};
 const baseline=ordered.find(s=>s.id===state?.baseline_snapshot_id);
 const matching=hasCurrent&&state.review_hash?ordered.find(s=>s.content_hash===state.review_hash&&(s.source_conversation_id===conversation.id||s.id===baseline?.id)):null;
 const after=hasCurrent?(matching||currentData):ordered[0];
 if(!after)return {before:'',after:''};
 if(!eligible(after))return {before:'',after:after.id};
 const prior=ordered.filter(s=>s.id!==after.id&&date(s)<date(after)&&s.metadata.demo===after.metadata.demo);
 const explicit=prior.find(s=>s.id===baseline?.id);
 const sameConversation=prior.filter(s=>s.source_conversation_id&&s.source_conversation_id===after.source_conversation_id);
 // Multiple records on the same nearest date need a user's choice.
 const nearest=sameConversation[0];
 const before=explicit||(nearest&&sameConversation.filter(s=>date(s)===date(nearest)).length===1?nearest:null);
 return {before:before?.id||'',after:after.id};
}
function compareDialog(){if(snapshots.length<2&&!current?.state?.actual?.length){notice('请先录入当前持仓，或保存第二份记录，再比较变化。');return;}
 const defaults=comparisonDefaults(snapshots,current),options=snapshots.map(s=>`<option value="${esc(s.id)}">${esc(dateLabel(s.metadata?.as_of))} · ${esc(s.name||'持仓记录')} · 修订${esc(s.revision)}${s.metadata?.demo?' · 演示':''}</option>`).join('');
 showDialog('比较两份持仓',`<p class="scope-note">比较金额和占比的变化；差额不等于投资收益，也不能据此区分涨跌、买卖和资金流入流出。</p><p class="scope-note">${defaults.before?'已按已选基准或同一对话的持仓日期预选两期，请核对后查看变化。':'请选定较早的基准记录；不会自动把不同对话或演示与真实记录当成同一份持仓。'}</p><form id="compare-form"><div class="compare-select"><label>基准记录<select name="before"><option value="">请选择较早的记录</option>${options}</select></label><label>对比对象<select name="after"><option value="">请选择对比对象</option>${current?.state?.actual?.length?'<option value="current">当前对话持仓</option>':''}${options}</select></label></div><button class="primary" type="submit">查看变化</button></form><div id="comparison-result"></div>`);
 $('compare-form').querySelector('[name="before"]').value=defaults.before;$('compare-form').querySelector('[name="after"]').value=defaults.after;
}
const signedMoney=n=>n==null?'—':(n>0?'+':'')+money(n),signedPct=n=>n==null?'—':(n>0?'+':'')+Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
function comparisonHTML(c){return `<div class="comparison-heading"><span>${esc(dateLabel(c.before?.as_of))} → ${esc(dateLabel(c.after?.as_of))}${c.after?.id==='current'?' · 当前对话':''}</span><h3>已列持仓总额变化 ¥${signedMoney(c.total_delta_cents)}</h3>${c.total_change_pct==null?'':`<p>相对基准金额变化 ${signedPct(c.total_change_pct)}% · 不等于投资收益率</p>`}</div><div class="table-wrap"><table><thead><tr><th>资产</th><th>原金额</th><th>新金额</th><th>金额变化（元）</th><th>占比变化（百分点）</th></tr></thead><tbody>${(c.changes||[]).map(x=>`<tr><td>${esc(x.name)} ${x.status==='added'?'<small class="tag">新增</small>':x.status==='removed'?'<small class="tag">移除</small>':''}</td><td>${money(x.before_cents)}</td><td>${money(x.after_cents)}</td><td>${signedMoney(x.delta_cents)}</td><td>${signedPct(x.weight_delta_pp)}</td></tr>`).join('')}</tbody></table></div><p class="scope-note">${esc(Array.isArray(c.limitations)?c.limitations.join('；'):c.limitations||'金额变化不等于投资收益；未核实价格变化、交易或资金流入流出的归因。')}</p>`;}
const platformLabels={bank:'银行',fund:'基金/证券',wallet:'支付钱包',credit_card:'信用卡',ledger:'手工账本'};
const accountStatusLabel=s=>s==='DEMO'?'合成数据':s==='CONFIRMED'?'已确认':'待确认';
function accountMoney(value){return money(Number(value)||0);}
function yuanToCents(value){const normalized=normalizeMoneyInput(value),[whole,fraction='']=normalized.split('.'),cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));if(cents>10_000_000_000_000n)throw Error('金额不能超过1000亿元');return Number(cents);}
function accountHubHTML(data){
 const hub=data?.hub||data||{},summary=hub.summary||{},accounts=Array.isArray(hub.accounts)?hub.accounts:[],quality=summary.data_quality||{},due=summary.upcoming_obligations||[];
 const cards=[['资产总额',accountMoney(summary.total_assets_cents)],['可用金额',accountMoney(summary.available_cents)],['待付款',accountMoney(summary.obligations_cents)],['净资产',accountMoney(summary.net_worth_cents)]];
 $('account-summary').innerHTML=cards.map(([label,value])=>`<div class="account-stat"><span>${label}</span><strong>¥${value}</strong><small>${label==='待付款'?(due[0]?`最近 ${esc(due[0].due_on)}`:'暂未填写日期'):label==='净资产'?'资产减去待还金额':`已汇总 ${quality.account_count||0} 个来源`}</small></div>`).join('');
 $('account-list').innerHTML=accounts.length?`<div class="account-list-head"><span>已接入来源</span><small>${quality.confirmed_account_count||0} 个已确认 · ${quality.pending_account_count||0} 个待确认</small></div><div class="account-cards">${accounts.map(account=>`<article class="account-card"><div class="account-card-head"><div><span class="account-platform">${esc(platformLabels[account.platform]||account.platform)}</span><h3>${esc(account.display_name)}</h3></div><span class="account-status ${account.source?.data_status==='DEMO'?'demo':''}">${accountStatusLabel(account.source?.data_status)}</span></div><div class="account-card-values"><div><span>账户金额</span><strong>¥${accountMoney(account.balance_cents)}</strong></div><div><span>可用金额</span><strong>¥${accountMoney(account.available_cents)}</strong></div>${account.liability_cents?`<div><span>待还金额</span><strong>¥${accountMoney(account.liability_cents)}</strong></div>`:''}</div><p class="account-source">来源：${esc(account.source?.label||'未标注')} · ${esc(account.source?.as_of||'日期未提供')}</p>${account.entries?.length?`<details><summary>查看 ${account.entries.length} 条明细</summary><ul>${account.entries.map(entry=>`<li><span>${esc(entry.label)}</span><b>¥${accountMoney(entry.amount_cents)}</b>${entry.due_on?`<small> ${esc(entry.due_on)}</small>`:''}</li>`).join('')}</ul></details>`:''}</article>`).join('')}</div>`:'<p class="account-empty">还没有账户来源。可以先点“试用合成数据”，也可以手动添加一项。</p>';
 if(!accounts.length)$('account-plan-result').hidden=true;
 return hub;
}
async function refreshAccountHub(){const data=await api('/accounts');accountHubHTML(data);return data;}
function accountNotice(text=''){$('account-notice').textContent=text;$('account-notice').hidden=!text;}
function accountPlanHTML(plan){return `<div class="plan-card"><div class="plan-card-heading"><span>建议先做</span><strong>${esc(plan.title)}</strong></div><p>${esc(plan.reason)}</p><p class="scope-note">这一步只做整理和预览，不连接真实账户，也不会执行交易。</p><div class="plan-inputs"><strong>需要补充</strong>${plan.suggested_inputs.map(item=>`<span>${esc(item)}</span>`).join('')}</div><button type="button" class="quiet-button" data-account-question="${esc(plan.question)}">把这件事交给对话继续</button></div>`;}
async function boot(){
$('open-holdings-screenshot').onclick=()=>{setScreenshotOpen(true);};
$('close-holdings-screenshot').onclick=()=>{clearScreenshotFile();setScreenshotOpen(false);$('open-holdings-screenshot').focus();};
$('choose-holdings-image').onclick=()=>$('holdings-image-file').click();
$('holdings-image-file').addEventListener('change',event=>{const file=event.target.files?.[0];if(file)chooseScreenshotFile(file);});
$('clear-holdings-image').onclick=()=>clearScreenshotFile();
$('run-holdings-ocr').onclick=()=>runScreenshotOCR().catch(error=>screenshotStatus('识别未完成：'+error.message+'。不会自动填补缺失数据。'));
window.addEventListener('beforeunload',()=>{screenshotState.worker?.terminate?.().catch(()=>{});if(screenshotState.objectUrl)URL.revokeObjectURL(screenshotState.objectUrl);});
$('start-table').onclick=()=>startEditor().catch(e=>notice(e.message));
$('account-demo').onclick=async()=>{try{$('account-demo').disabled=true;const result=await api('/accounts/demo',{idempotency_key:'account-hub-demo-v1',request_id:'demo-seed-v1'});accountHubHTML(result.hub);accountNotice(result.notice||'合成数据已载入。');}catch(error){accountNotice('账户数据未载入：'+error.message);}finally{$('account-demo').disabled=false;}};
$('account-refresh').onclick=()=>refreshAccountHub().then(()=>accountNotice('账户汇总已刷新。')).catch(error=>accountNotice('刷新失败：'+error.message));
$('account-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.target,button=form.querySelector('[type="submit"]');try{button.disabled=true;const balance=yuanToCents(form.elements.balance_yuan.value),available=form.elements.available_yuan.value.trim()?yuanToCents(form.elements.available_yuan.value):balance;const result=await api('/accounts',{request_id:crypto.randomUUID(),idempotency_key:'account-'+crypto.randomUUID(),account:{display_name:form.elements.display_name.value.trim(),platform:form.elements.platform.value,account_type:form.elements.platform.value,balance_cents:balance,available_cents:available,source:{channel:'USER_ENTERED',label:'用户手工录入',as_of:beijingDate(),confirmed:false}}});accountHubHTML(result.hub);accountNotice('已加入统一账户目录。当前来源待确认，后续可继续补充明细。');form.reset();}catch(error){accountNotice('未加入：'+error.message);}finally{button.disabled=false;}});
$('account-plan-form').addEventListener('submit',async event=>{event.preventDefault();const question=$('account-question').value.trim();if(!question)return accountNotice('请先写下想核对的事情。');const button=event.target.querySelector('[type="submit"]');try{button.disabled=true;const result=await api('/accounts/plan',{question});$('account-plan-result').innerHTML=accountPlanHTML(result.plan);$('account-plan-result').hidden=false;}catch(error){accountNotice('暂时不能生成处理建议：'+error.message);}finally{button.disabled=false;}});
$('account-plan-result').onclick=event=>{const button=event.target.closest('[data-account-question]');if(!button)return;$('question').value=button.dataset.accountQuestion;$('question').dispatchEvent(new Event('input'));$('question').focus();$('scroll-area').scrollTo({top:$('messages').offsetTop,behavior:'smooth'});};
$('close-record').onclick=()=>$('record-dialog').close();
$('snapshots').onclick=e=>{const b=e.target.closest('[data-snapshot]');if(b)openRecord(b.dataset.snapshot).catch(e=>notice(e.message));};
$('compare-records').onclick=compareDialog;
$('current-review').addEventListener('input',()=>{const form=$('review-editor');if(form&&draft)draft=readEditor(form);});
const editControls=e=>{const box=e.target.closest('#review-editor,#record-editor');if(!box)return false;const value=readEditor(box),remove=e.target.closest('[data-remove]');if(remove){value.rows.splice(Number(remove.dataset.remove),1);box.querySelector('.edit-table').innerHTML=value.rows.map(editRow).join('');}else if(e.target.closest('[data-add-row]')){value.rows.push({name:'',amount:'',kind:'unresolved'});box.querySelector('.edit-table').innerHTML=value.rows.map(editRow).join('');}else if(e.target.closest('[data-parse]')){try{value.rows=parseHoldingTable(box.querySelector('[name="paste-table"]').value);box.querySelector('.edit-table').innerHTML=value.rows.map(editRow).join('');box.querySelector('.inline-notice').textContent='已填入表格，请核对名称、金额和类型后确认。';}catch(err){box.querySelector('.inline-notice').textContent=err.message;}}else return false;if(box.id==='review-editor')draft=value;return true;};
$('current-review').onclick=async e=>{if(editControls(e))return;const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-question'))return send(b.dataset.question);
 if(b.hasAttribute('data-edit-review'))return startEditor().catch(err=>notice(err.message));
 if(b.hasAttribute('data-cancel-edit')){draft=null;renderReview();return;}
 if(b.hasAttribute('data-compare-current'))return compareDialog();
 if(b.hasAttribute('data-save-record')){$('save-record-form').innerHTML=`<form id="save-confirmation" class="inline-confirmation"><h3>保存一份可回看的记录</h3><p>只保存你确认的原始持仓。模拟方案不会写入这份记录。</p><div class="edit-meta"><label>记录名称<input name="snapshot-name" maxlength="60" value="持仓记录"></label><label>持仓对应日期<input type="date" name="snapshot-date" value="${esc(current.state.review?.metadata?.as_of||'')}" required></label></div><label class="check-label"><input type="checkbox" required>我已核对金额、日期，确认保存为新记录</label><div class="action-row"><button type="submit" class="primary">确认保存新记录</button><button type="button" class="quiet-button" data-cancel-save>暂不保存</button></div><div class="inline-notice" role="status"></div></form>`;return;}
 if(b.hasAttribute('data-cancel-save'))$('save-record-form').innerHTML='';
};
$('current-review').addEventListener('submit',async e=>{e.preventDefault();if(reviewBusy)return;const form=e.target,cid=current.id,revision=viewRevision;reviewBusy=true;const button=form.querySelector('[type="submit"]');button.disabled=true;try{
 if(active())throw Error('请先停止或等待当前回复完成');
 if(form.id==='review-editor'){const value=readEditor(form),payload=reviewPayload(value,draftVersion);payload.mode=current.state.actual.length?'correct':'new';const r=await api('/chats/'+cid+'/review',payload);if(current?.id===cid&&viewRevision===revision){current=r.conversation;draft=null;render();await refreshHistory();}}
 else if(form.id==='save-confirmation'){const date=form.querySelector('[name="snapshot-date"]').value,name=form.querySelector('[name="snapshot-name"]').value.trim();if(!date)throw Error('保存记录前请填写数据日期');if(date!==current.state.metadata?.as_of){const value=makeDraft(rowsOf(current),current.state.metadata);value.as_of=date;const updated=await api('/chats/'+cid+'/review',reviewPayload(value,current.state.version));if(current?.id!==cid||viewRevision!==revision)return;current=updated.conversation;}
 const result=await api('/snapshots',{conversation_id:cid,base_version:current.state.version,base_hash:current.state.review_hash,confirmed:true,name});if(current?.id===cid&&viewRevision===revision){if(result.conversation)current=result.conversation;render();notice('已保存持仓记录。下次可以在左侧选择记录，直接比较变化。');}await refreshSnapshots();$('saved-section').open=true;}
 }catch(err){form.querySelector('.inline-notice').textContent='未完成：'+err.message+'。填写内容已保留。';}finally{reviewBusy=false;button.disabled=false;}});
$('record-content').onclick=async e=>{if(editControls(e))return;const b=e.target.closest('button');if(!b)return;
 if(b.hasAttribute('data-record-edit')){recordMode='edit';showDialog('更正这份已保存记录',`<p class="scope-note">正在更正“${esc(record.name||'持仓记录')}”修订 ${esc(record.revision)}；新的日期持仓请另存新记录。</p><form id="record-editor">${editorHTML(makeDraft(record.rows,record.metadata),'record')}<label class="check-label"><input type="checkbox" required>确认更正这份记录，保留修订标识</label><div class="action-row"><button type="submit" class="primary">确认更正记录</button><button type="button" class="quiet-button" data-record-cancel>取消</button></div><div class="inline-notice" role="status"></div></form>`);return;}
 if(b.hasAttribute('data-record-cancel'))return showRecord();
 if(b.hasAttribute('data-record-delete')){$('record-confirmation').innerHTML='<div class="inline-confirmation"><p>删除后这份保存记录将不可选择。已有对话中的副本仍会保留。</p><button class="danger-button" data-do-delete>确认删除这份记录</button><button class="quiet-button" data-record-cancel>取消</button></div>';return;}
 if(b.hasAttribute('data-record-restore')){$('record-confirmation').innerHTML='<div class="inline-confirmation"><p>载入会替换当前对话的原始持仓并重新核对，原有模拟方案需要重新校验。保存记录本身不会改变。</p><button class="primary" data-do-restore>确认载入当前对话</button><button class="quiet-button" data-record-cancel>取消</button></div>';return;}
 if(!b.hasAttribute('data-do-delete')&&!b.hasAttribute('data-do-restore'))return;if(reviewBusy)return;reviewBusy=true;b.disabled=true;try{if(b.hasAttribute('data-do-delete')){const result=await api('/snapshots/'+record.id+'/delete',{revision:record.revision});await refreshSnapshots();await refreshCurrent();showDialog('记录已删除',`<p>${esc(result.notice||'已删除保存记录；已有对话历史中的副本仍保留。')}</p>`);}else{if(active())throw Error('请先停止或等待当前回复完成');if(!current)await newChat();const cid=current.id,revision=viewRevision;const result=await api('/snapshots/'+record.id+'/restore',{conversation_id:cid,base_version:current.state.version,revision:record.revision});if(current?.id===cid&&revision===viewRevision){current=result.conversation;draft=null;render();$('record-dialog').close();closeSidebar();notice('已载入记录并重新核对；保存记录本身未改变。');}await refreshHistory();}}catch(err){recordNotice('未完成：'+err.message);}finally{reviewBusy=false;b.disabled=false;}
};
$('record-content').addEventListener('submit',async e=>{e.preventDefault();const form=e.target;if(reviewBusy)return;reviewBusy=true;const button=form.querySelector('[type="submit"]');button.disabled=true;try{
 if(form.id==='record-editor'){const value=readEditor(form),payload=reviewPayload(value,0);if(!value.as_of)throw Error('保存记录必须填写数据日期');const result=await api('/snapshots/'+record.id+'/update',{revision:record.revision,rows:payload.rows,metadata:payload.metadata,confirmed:true});record=result.snapshot;await refreshSnapshots();await refreshCurrent();showRecord();recordNotice('更正已保存，记录修订已更新。');}
 else if(form.id==='compare-form'){const before=snapshots.find(s=>s.id===form.querySelector('[name="before"]').value),after=form.querySelector('[name="after"]').value;if(!before)throw Error('请选择基准记录');if(before.id===after)throw Error('请选择两份不同的记录');const payload={revision:before.revision};if(after==='current'){if(!current?.state?.actual?.length)throw Error('当前对话尚无持仓');Object.assign(payload,{conversation_id:current.id,base_version:current.state.version});}else{const other=snapshots.find(s=>s.id===after);if(!other)throw Error('请选择对比对象');Object.assign(payload,{other_id:other.id,other_revision:other.revision});}const result=await api('/snapshots/'+before.id+'/compare',payload);$('comparison-result').innerHTML=comparisonHTML(result.comparison);if(result.conversation?.id===current?.id){current=result.conversation;render();}recordNotice();}
 }catch(err){if(form.querySelector('.inline-notice'))form.querySelector('.inline-notice').textContent='未完成：'+err.message+'。填写内容已保留。';else recordNotice(err.message);}finally{reviewBusy=false;button.disabled=false;}});
$('composer').addEventListener('submit',async e=>{e.preventDefault();if(selecting||composing)return;const pending=localStorage.getItem('fund-pending');if(pending){const revision=viewRevision;try{const p=JSON.parse(pending),t=await api('/chats/'+p.cid+'/turns',p.request);localStorage.removeItem('fund-pending');if(revision!==viewRevision)return;await openChat(p.cid);if(current?.id===p.cid&&t.status==='RUNNING')subscribe(t.id);notice();}catch(e){if(revision===viewRevision)notice('恢复请求失败：'+e.message);}return;}const text=$('question').value.trim();if(text)send(text);});
$('question').addEventListener('compositionstart',()=>{composing=true;});
$('question').addEventListener('compositionend',()=>{composing=false;});
$('question').addEventListener('keydown',e=>{if(enterSends(e,composing)){e.preventDefault();$('composer').requestSubmit();}});
$('question').addEventListener('input',()=>{const q=$('question');q.style.height='auto';q.style.height=Math.min(180,q.scrollHeight)+'px';});
$('stop').onclick=async()=>{const t=active();if(!t)return;try{await api(`/chats/${current.id}/turns/${t.id}/stop`,{});}catch(e){notice('停止请求未确认，请重试：'+e.message);}};
$('new-chat').onclick=()=>newChat().catch(e=>notice(e.message));
$('history').onclick=e=>{const button=e.target.closest('[data-chat]');if(button)openChat(button.dataset.chat).catch(e=>notice(e.message));};
$('examples').onclick=e=>{const button=e.target.closest('button');if(button)send(button.dataset.example==='holdings'?`这是演示数据：截至${beijingDate()}，我有股票A当前市值6万元，基金B当前市值2万元，现金2万元，均为人民币。帮我核对持仓。`:'什么是持仓集中度？');};
$('messages').onclick=async e=>{const retry=e.target.closest('[data-retry]'),confirm=e.target.closest('[data-confirm]');if(retry)send('',retry.dataset.retry);if(confirm){const cid=current.id,revision=viewRevision;try{const s=current.state.scenario;const r=await api(`/chats/${cid}/confirm`,{plan_id:s.id,base_hash:s.base_hash});if(current?.id===cid&&revision===viewRevision){current=r.conversation;render();}}catch(e){if(current?.id===cid&&revision===viewRevision)notice('方案需要重新核对：'+e.message);}}};
$('scroll-area').addEventListener('scroll',()=>{const s=$('scroll-area');nearBottom=s.scrollHeight-s.scrollTop-s.clientHeight<100;$('to-bottom').hidden=nearBottom;});
$('to-bottom').onclick=()=>{nearBottom=true;stick();};$('menu').onclick=()=>{document.body.classList.add('show-history');$('shade').hidden=false;$('menu').setAttribute('aria-expanded','true');$('close-sidebar').focus();};$('close-sidebar').onclick=()=>{closeSidebar();$('menu').focus();};$('shade').onclick=closeSidebar;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&document.body.classList.contains('show-history'))closeSidebar();});
window.addEventListener('offline',()=>notice('网络已断开。输入内容仍在本机；恢复连接后可继续发送或恢复原请求。'));
window.addEventListener('online',()=>{notice('网络已恢复，正在核对当前对话状态。');refreshCurrent().then(()=>notice()).catch(()=>notice('网络已恢复，但状态尚未载入。请刷新后核对。'));});
const viewport=window.visualViewport;function fitViewport(){document.documentElement.style.setProperty('--app-height',`${Math.round(viewport?.height||window.innerHeight)}px`);}fitViewport();viewport?.addEventListener('resize',fitViewport);window.addEventListener('resize',fitViewport);
try{csrf=(await(await fetch('/api/session')).json()).csrf;await refreshAccountHub().catch(error=>accountNotice('账户中心暂时不可用：'+error.message));await refreshHistory();await refreshSnapshots();const id=localStorage.getItem('fund-current-chat');if(history.some(c=>c.id===id))await openChat(id);else render();if(localStorage.getItem('fund-pending'))notice('有一条消息的提交状态尚未确认。点击发送恢复原请求，不会创建重复任务。');}catch(e){notice('暂时无法载入对话，请刷新重试。'+e.message);}

}
if(typeof document!=='undefined')boot();
