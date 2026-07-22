const $ = id => document.getElementById(id);
const state = { batches: [], data: null, items: [], selectedSku: null, matches: [], matchIndex: 0, editingId: null, editingOriginal: {}, pendingPayload: null, duplicateId: null, batchSearchToken: 0 };
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

function toast(message, error=false){ const el=$('toast'); el.textContent=message; el.style.background=error?'#b83243':'#17324d'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2600); }
async function api(url, options={}){ const method=String(options.method||'GET').toUpperCase();if(['POST','PUT','PATCH','DELETE'].includes(method)){options.headers={...(options.headers||{}),'X-CSRF-Token':csrfToken};}const res=await fetch(url,options); const body=await res.json().catch(()=>({})); if(!res.ok){ const err=new Error(body.error||'操作失败'); err.status=res.status; err.body=body; throw err; } return body; }
function openImport(){ $('importDialog').showModal(); }
window.openImport=openImport;

async function loadBatches(preferred,query=''){
  state.batches=await api(`/api/batches?q=${encodeURIComponent(query)}`);
  if(!state.batches.length){ $('emptyState').hidden=false; $('workspace').hidden=true; return; }
  $('emptyState').hidden=true; $('workspace').hidden=false;
  $('batchSelect').innerHTML=state.batches.map(b=>`<option value="${b.id}">${b.batch_no}</option>`).join('');
  const preferredId=Number(preferred);const id=state.batches.some(b=>b.id===preferredId)?preferredId:state.batches[0].id;$('batchSelect').value=id;await loadBatch(id);
}
async function loadBatch(id){ state.data=await api(`/api/batches/${id}`); state.items=[]; state.editingId=null; resetEditor(false); renderAll(); }
function renderAll(){
  const {batch,summary}=state.data; $('batchMeta').textContent=`内部单号：${batch.internal_order||'未填写'} · ${batch.source_filename}`;
  $('mPackages').textContent=summary.packages; $('mPacked').textContent=summary.packed; $('mRemaining').textContent=summary.remaining; $('mOver').textContent=summary.over;
  $('exportBtn').href=`/api/batches/${batch.id}/export`; renderPackages(); renderDiff(); renderItems();
}
function renderPackages(){
  const list=$('packageList'); $('packageHint').textContent=`${state.data.packages.length}个大包`;
  list.innerHTML=state.data.packages.length?state.data.packages.map(p=>`<div class="package-card"><b>${p.package_label}</b><div class="meta">${p.item_count}款 · ${p.total_qty}件<br>${packageMeasureHtml(p)}</div><button onclick="viewPackage(${p.id})">查看</button><button onclick="editPackage(${p.id})">修改</button><button class="delete" onclick="deletePackage(${p.id},'${p.package_label}')">清空</button></div>`).join(''):'<div class="placeholder">还没有保存大包</div>';
}
function packageMeasureHtml(p){const dims=[['长',p.length_cm],['宽',p.width_cm],['高',p.height_cm]].map(([label,value])=>value==null?`<span class="missing">${label}未填</span>`:`${label}${value}cm`).join(' · ');const weight=p.weight_kg==null?'<span class="missing">体重未填</span>':`${Number(p.weight_kg).toFixed(2)}kg`;return `${dims} · ${weight}`;}
function diffStatus(s){ const d=s.packed_qty-s.planned_qty; if(s.packed_qty===0)return['未开始','zero']; if(d<0)return['未装完','warn']; if(d===0)return['已匹配','ok']; return['已超装','over']; }
function renderDiff(){
  const words=normalize($('diffSearch').value).split(' ').filter(Boolean);
  $('diffRows').innerHTML=state.data.skus.filter(s=>words.every(w=>normalize(s.display_label).includes(w))).map(s=>{const [label,cls]=diffStatus(s),inventory=s.planned_qty-s.packed_qty;return `<tr><td>${escapeHtml(s.display_label)}</td><td>${escapeHtml(s.warehouse)}</td><td>${s.planned_qty}</td><td>${s.packed_qty}</td><td>${inventory}</td><td><span class="status ${cls}">${label}</span></td></tr>`}).join('');
}
function renderItems(){
  $('itemRows').innerHTML=state.items.length?state.items.map((item,i)=>`<tr><td>${escapeHtml(item.label)}</td><td><input class="item-qty" type="number" min="1" value="${item.quantity}" onchange="changeQty(${i},this.value)"></td><td><button class="remove" onclick="removeItem(${i})">×</button></td></tr>`).join(''):'<tr class="placeholder"><td colspan="3">搜索款色尺码，按回车选中</td></tr>';
  $('boxTotal').textContent=state.items.reduce((a,b)=>a+Number(b.quantity),0);
}
window.changeQty=(i,v)=>{const qty=Number(v);if(Number.isInteger(qty)&&qty>0){state.items[i].quantity=qty;}else{toast('数量请输入大于0的整数',true);}renderItems();refreshQuantityReference();if(!$('suggestions').hidden)searchSku($('skuSearch').value);};
window.removeItem=i=>{state.items.splice(i,1);renderItems();refreshQuantityReference();if(!$('suggestions').hidden)searchSku($('skuSearch').value);};
function normalize(value){ return String(value||'').toLowerCase().replace(/[;；,，/\\|]+/g,' ').replace(/\s+/g,' ').trim(); }
function cloneMultiplier(){return state.editingId?1:Math.max(1,Number($('cloneCount').value)||1)}
function pendingQty(skuId){const current=state.items.find(item=>item.sku_id===skuId)?.quantity||0;return current*cloneMultiplier()}
function referenceRemaining(sku){return sku.remaining_qty+(state.editingOriginal[sku.id]||0)-pendingQty(sku.id)}
function searchSku(query){
  const words=normalize(query).split(' ').filter(Boolean);
  state.matches=state.data.skus.map((s,index)=>{const text=normalize(s.display_label);const tokens=text.split(' ');const matched=words.every(w=>text.includes(w));const score=words.reduce((sum,w)=>sum+(tokens.includes(w)?10:0),0);return{s,index,matched,score}}).filter(x=>x.matched).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,50).map(x=>x.s); state.matchIndex=0; renderSuggestions();
}
function renderSuggestions(){
  const box=$('suggestions');const input=$('skuSearch');
  if(!state.matches.length){box.innerHTML='<div class="suggestion empty-option">当前批次没有匹配结果</div>';box.hidden=false;input.setAttribute('aria-expanded','true');return;}
  box.hidden=false;input.setAttribute('aria-expanded','true');box.innerHTML=state.matches.map((s,i)=>{const remaining=referenceRemaining(s);return `<button type="button" class="suggestion ${i===state.matchIndex?'active':''}" data-sku-index="${i}" role="option" aria-selected="${i===state.matchIndex}">${escapeHtml(s.display_label)}<small>仓位 ${escapeHtml(s.warehouse||'-')} · 清单 ${s.planned_qty} · 已保存 ${s.packed_qty} · 当前参考库存 ${remaining}</small></button>`}).join('');
}
function refreshQuantityReference(){if(!state.selectedSku){$('qtyReference').textContent='';$('skuQty').placeholder='先选择款色尺码';return;}const remaining=referenceRemaining(state.selectedSku);$('qtyReference').textContent=`参考剩余 ${remaining} 件`;$('skuQty').placeholder=`参考：${remaining}`;}
function closeSuggestions(){$('suggestions').hidden=true;$('skuSearch').setAttribute('aria-expanded','false');}
window.chooseSku=i=>{if(!Number.isInteger(i)||i<0||i>=state.matches.length)return;state.selectedSku=state.matches[i];$('skuSearch').value=state.selectedSku.display_label;closeSuggestions();refreshQuantityReference();$('skuQty').focus();$('skuQty').select();};
function addSelected(){
  if(!state.selectedSku){toast('请先选择款色尺码',true);$('skuSearch').focus();return;}
  const qty=Number($('skuQty').value); if(!Number.isInteger(qty)||qty<1){toast('数量请输入大于0的整数',true);$('skuQty').focus();return;}
  const old=state.items.find(x=>x.sku_id===state.selectedSku.id); if(old)old.quantity+=qty;else state.items.push({sku_id:state.selectedSku.id,label:state.selectedSku.display_label,quantity:qty});
  state.selectedSku=null;$('skuSearch').value='';$('skuQty').value='';renderItems();refreshQuantityReference();searchSku('');$('skuSearch').focus();
}
function packagePayload(force=false){ return {package_no:$('packageNo').value,clone_count:state.editingId?1:$('cloneCount').value,length_cm:$('lengthCm').value,width_cm:$('widthCm').value,height_cm:$('heightCm').value,weight_kg:$('weightKg').value,items:state.items.map(({sku_id,quantity})=>({sku_id,quantity})),force}; }
async function save(force=false){
  if(!force&&!state.pendingPayload&&!state.editingId&&Number($('cloneCount').value)>100&&!confirm(`将一次生成 ${$('cloneCount').value} 个大包，确定继续吗？`))return;
  const payload=state.pendingPayload?{...state.pendingPayload,force}:packagePayload(force); const url=state.editingId?`/api/packages/${state.editingId}`:`/api/batches/${state.data.batch.id}/packages`; const method=state.editingId?'PUT':'POST';
  try{ const result=await api(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}); state.pendingPayload=null;$('overDialog').close();state.data=result.data;const created=result.created?.join('、');const nextStart=result.created?.length?Number(result.created[result.created.length-1].replace('#',''))+1:null;toast(created?`已生成大包 ${created}`:'大包修改成功');resetEditor(true,nextStart);renderAll(); }
  catch(err){ if(err.status===409){state.pendingPayload=payload;showOver(err.body.overages);return;} toast(err.message,true); }
}
function showOver(overages){ $('overList').innerHTML=overages.map(o=>`<div class="over-item"><b>${escapeHtml(o.label)}</b><br>清单 ${o.planned} · 已装 ${o.before} · 本次 ${o.added} · 保存后 ${o.after} · <strong>超出 ${o.over}</strong></div>`).join('');$('overDialog').showModal(); }
function updateCloneHint(){ const start=Number(String($('packageNo').value).replace('#',''));const count=Number($('cloneCount').value)||1;const hint=$('cloneHint');if(count<=1){hint.textContent='填1只保存当前大包；大于1会完整复制本大包，并让大包号连续递增。';}else if(start>0){hint.innerHTML=`将生成 <strong>${start}# 至 ${start+count-1}#</strong>，共${count}个大包；商品、数量、长宽高重全部相同。`;}else{hint.textContent=`将生成${count}个连续大包号；商品、数量、长宽高重全部相同。`;}refreshQuantityReference();if(!$('suggestions').hidden)searchSku($('skuSearch').value);}
function resetEditor(suggest,nextStart=null){ const previous=Number($('packageNo').value.replace('#','')); state.items=[];state.selectedSku=null;state.editingId=null;state.editingOriginal={};state.pendingPayload=null;state.duplicateId=null;['skuSearch','skuQty','lengthCm','widthCm','heightCm','weightKg'].forEach(id=>$(id).value='');$('cloneCount').value=1;$('editorTitle').textContent='录入新大包';$('cancelEdit').hidden=true;$('cloneCount').disabled=false;if(suggest&&(nextStart||previous)){let candidate=nextStart||previous+1;const used=new Set(state.data.packages.map(p=>p.package_no));while(used.has(candidate))candidate+=1;$('packageNo').value=`${candidate}#`;}else if(!suggest)$('packageNo').value='';renderItems();updateCloneHint();$('packageNo').focus(); }
window.viewPackage=async id=>{const p=await api(`/api/packages/${id}`);const lines=p.items.map(i=>{const sku=state.data.skus.find(s=>s.id===i.sku_id);return `<li>${escapeHtml(sku.display_label)} × ${i.quantity}</li>`}).join('');$('viewTitle').textContent=`查看大包 ${p.package_label}`;$('viewContent').innerHTML=`<b>大包内商品</b><ul>${lines}</ul><div>共 ${p.items.reduce((sum,i)=>sum+i.quantity,0)} 件</div><div>${packageMeasureHtml(p)}</div>`;$('viewDialog').showModal();};
window.editPackage=async id=>{ const p=await api(`/api/packages/${id}`);state.editingId=id;state.duplicateId=null;state.editingOriginal=Object.fromEntries(p.items.map(i=>[i.sku_id,i.quantity]));state.items=p.items.map(i=>{const sku=state.data.skus.find(s=>s.id===i.sku_id);return{sku_id:i.sku_id,quantity:i.quantity,label:sku.display_label}});$('packageNo').value=p.package_no;$('lengthCm').value=p.length_cm??'';$('widthCm').value=p.width_cm??'';$('heightCm').value=p.height_cm??'';$('weightKg').value=p.weight_kg??'';$('cloneCount').value=1;$('cloneCount').disabled=true;$('editorTitle').textContent=`修改大包 ${p.package_label}`;$('cancelEdit').hidden=false;renderItems();updateCloneHint();window.scrollTo({top:0,behavior:'smooth'}); };
window.deletePackage=async(id,label)=>{if(!confirm(`确定清空并删除 ${label} 吗？`))return;try{const r=await api(`/api/packages/${id}`,{method:'DELETE'});state.data=r.data;renderAll();toast(`${label} 已清空`);}catch(e){toast(e.message,true)}};
function escapeHtml(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}

$('newBatchBtn').onclick=openImport;$('batchSelect').onchange=e=>{if(e.target.value)loadBatch(Number(e.target.value))};$('savePackage').onclick=()=>save(false);$('forceSave').onclick=()=>save(true);$('addSku').onclick=addSelected;$('cancelEdit').onclick=()=>resetEditor(false);$('diffSearch').oninput=renderDiff;
async function searchBatches(){const query=$('batchSearch').value.trim();if(!query){await loadBatches(state.data?.batch?.id);return;}const token=++state.batchSearchToken;const rows=await api(`/api/batches?q=${encodeURIComponent(query)}`);if(token!==state.batchSearchToken)return;if(!rows.length){toast('没有找到匹配的历史批次',true);return;}state.batches=rows;$('batchSelect').innerHTML=rows.map(b=>`<option value="${b.id}">${b.batch_no}</option>`).join('');$('batchSelect').value=rows[0].id;await loadBatch(rows[0].id);toast(`找到 ${rows.length} 个历史批次`);}
$('batchSearchBtn').onclick=()=>searchBatches().catch(e=>toast(e.message,true));$('batchSearch').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();searchBatches().catch(err=>toast(err.message,true));}};
$('skuSearch').oninput=e=>{state.selectedSku=null;refreshQuantityReference();searchSku(e.target.value)};
$('skuSearch').onfocus=e=>searchSku(e.target.value);
$('skuSearch').onclick=e=>searchSku(e.target.value);
$('skuSearch').onkeydown=e=>{if(e.key==='ArrowDown'){e.preventDefault();state.matchIndex=Math.min(state.matches.length-1,state.matchIndex+1);renderSuggestions()}else if(e.key==='ArrowUp'){e.preventDefault();state.matchIndex=Math.max(0,state.matchIndex-1);renderSuggestions()}else if(e.key==='Enter'&&state.matches.length){e.preventDefault();chooseSku(state.matchIndex)}else if(e.key==='Escape'){closeSuggestions()}};
$('suggestions').addEventListener('pointerdown',e=>{const option=e.target.closest('[data-sku-index]');if(!option)return;e.preventDefault();chooseSku(Number(option.dataset.skuIndex));});
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.search-wrap'))closeSuggestions();});
$('skuQty').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();addSelected()}};
$('packageNo').oninput=updateCloneHint;$('cloneCount').oninput=updateCloneHint;
$('packageNo').onblur=e=>{const match=String(e.target.value).match(/^\s*(\d+)\s*#?\s*$/);if(!match){if(e.target.value)toast('大包号只需输入大于0的数字',true);return;}const n=Number(match[1]);if(n<1){toast('大包号必须大于0',true);return;}e.target.value=`${n}#`;updateCloneHint();const existing=state.data.packages.find(p=>p.package_no===n&&p.id!==state.editingId);if(existing){state.duplicateId=existing.id;$('duplicateText').textContent=`大包 ${existing.package_label} 已经保存，不能重复新建。你可以查看原记录或进入修改。`;$('duplicateDialog').showModal();}};
$('viewExisting').onclick=()=>{const id=state.duplicateId;$('duplicateDialog').close();if(id)viewPackage(id)};
$('editExisting').onclick=()=>{const id=state.duplicateId;$('duplicateDialog').close();if(id)editPackage(id)};
$('overDialog').addEventListener('close',()=>{state.pendingPayload=null;});
$('importForm').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button[type=submit]');button.disabled=true;button.textContent='正在导入…';try{const result=await api('/api/import',{method:'POST',body:new FormData(e.target)});$('importDialog').close();e.target.reset();await loadBatches(result.batch.id);toast(`批次 ${result.batch.batch_no} 已创建`);}catch(err){toast(err.message,true)}finally{button.disabled=false;button.textContent='导入并开始装箱'}};
loadBatches().catch(e=>toast(e.message,true));
