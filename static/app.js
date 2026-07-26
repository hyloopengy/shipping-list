const $ = id => document.getElementById(id);
const state = {
  batches: [], data: null, items: [], selectedOption: null, matches: [], matchIndex: 0,
  editingId: null, editingOriginal: {}, pendingPayload: null, duplicateId: null, batchSearchToken: 0, batchLoadToken: 0,
  ratioItems: [], selectedRatioSku: null, ratioMatches: [], editingRatioId: null,
  autoSelected: new Set(), autoPreview: null,
};
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function ratioDetailHtml(value) {
  const [name, ...bodyParts] = String(value || '').split('：');
  const items = bodyParts.join('：').split(/；|\n/).map(item => item.trim()).filter(Boolean);
  return `<span class="ratio-detail-lines"><span class="ratio-detail-title">${escapeHtml(name)}：</span>${items.map(item => `<span>${escapeHtml(item)}</span>`).join('')}</span>`;
}
function normalize(value) { return String(value || '').toLowerCase().replace(/[;；,，/\\|]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function toast(message, error=false) {
  const el = $('toast'); el.textContent = message; el.style.background = error ? '#b83243' : '#17324d';
  el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2600);
}
async function api(url, options={}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (['POST','PUT','PATCH','DELETE'].includes(method)) options.headers = {...(options.headers || {}), 'X-CSRF-Token': csrfToken};
  const response = await fetch(url, options); const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error || '操作失败'); error.status = response.status; error.body = body; throw error; }
  return body;
}

function openImport() { $('importDialog').showModal(); }
window.openImport = openImport;

async function loadBatches(preferred, query='') {
  state.batches = await api(`/api/batches?q=${encodeURIComponent(query)}`);
  if (!state.batches.length) { $('emptyState').hidden = false; $('workspace').hidden = true; return; }
  $('emptyState').hidden = true; $('workspace').hidden = false;
  $('batchSelect').innerHTML = state.batches.map(batch => `<option value="${batch.id}">${batch.batch_no}</option>`).join('');
  const preferredId = Number(preferred);
  const id = state.batches.some(batch => batch.id === preferredId) ? preferredId : state.batches[0].id;
  $('batchSelect').value = id; await loadBatch(id);
}
async function loadBatch(id) {
  const token = ++state.batchLoadToken;
  const data = await api(`/api/batches/${id}`);
  if (token !== state.batchLoadToken) return;
  state.data = data; state.items = []; state.editingId = null; resetEditor(false); renderAll();
}
function renderAll() {
  const {batch, summary} = state.data;
  $('batchMeta').textContent = `内部单号：${batch.internal_order || '未填写'} · ${batch.source_filename}`;
  $('mPackages').textContent = summary.packages; $('mPacked').textContent = summary.packed;
  $('mRemaining').textContent = summary.remaining; $('mOver').textContent = summary.over;
  $('exportBtn').href = `/api/batches/${batch.id}/export`; $('exportBtn').download = `发货清单_${batch.batch_no}.xlsx`;
  renderPackages(); renderDiff(); renderItems();
}
function packageMeasureHtml(packageRow) {
  const dimensions = [['长',packageRow.length_cm],['宽',packageRow.width_cm],['高',packageRow.height_cm]]
    .map(([label,value]) => value == null ? `<span class="missing">${label}未填</span>` : `${label}${value}cm`).join(' · ');
  const weight = packageRow.weight_kg == null ? '<span class="missing">体重未填</span>' : `${Number(packageRow.weight_kg).toFixed(2)}kg`;
  const volume = packageRow.volume_m3 == null ? '<span class="missing">体积未算</span>' : `体积${Number(packageRow.volume_m3).toFixed(4)}m³`;
  return `${dimensions} · ${weight} · ${volume}`;
}

function updateVolume() {
  const values = ['lengthCm','widthCm','heightCm'].map(id => Number($(id).value));
  $('volumeM3').value = values.every(value => value > 0) ? (values.reduce((total,value) => total * value,1) / 1000000).toFixed(4) : '';
}
function renderPackages() {
  const list = $('packageList'); $('packageHint').textContent = `${state.data.packages.length}个大包`;
  list.innerHTML = state.data.packages.length ? state.data.packages.map(row =>
    `<div class="package-card"><b>${row.package_label}</b><div class="meta">${row.item_count}款 · ${row.total_qty}件<br>${packageMeasureHtml(row)}</div>` +
    `<button onclick="viewPackage(${row.id})">查看</button><button onclick="editPackage(${row.id})">修改</button>` +
    `<button class="delete" onclick="deletePackage(${row.id},'${row.package_label}')">清空</button></div>`
  ).join('') : '<div class="placeholder">还没有保存大包</div>';
}
function diffStatus(sku) {
  const delta = sku.packed_qty - sku.planned_qty;
  if (sku.packed_qty === 0) return ['未开始','zero'];
  if (delta < 0) return ['未装完','warn']; if (delta === 0) return ['已匹配','ok']; return ['已超装','over'];
}
function renderDiff() {
  const words = normalize($('diffSearch').value).split(' ').filter(Boolean);
  $('diffRows').innerHTML = state.data.skus.filter(sku => words.every(word => normalize(sku.display_label).includes(word))).map(sku => {
    const [label, cls] = diffStatus(sku); const inventory = sku.planned_qty - sku.packed_qty;
    return `<tr><td>${escapeHtml(sku.display_label)}</td><td>${escapeHtml(sku.warehouse)}</td><td>${sku.planned_qty}</td>` +
      `<td>${sku.packed_qty}</td><td>${inventory}</td><td><span class="status ${cls}">${label}</span></td></tr>`;
  }).join('');
}

function entryTotal(entry) { return Number(entry.units_per_pack) * Number(entry.pack_count); }
function renderItems() {
  $('itemRows').innerHTML = state.items.length ? state.items.map((item, index) => {
    const isRatio = item.entry_type === 'ratio';
    const badge = isRatio ? '<span class="entry-kind">配比</span>' : '';
    const detail = isRatio ? `<span class="entry-detail">${item.units_per_pack}件/中包 × ${item.pack_count}中包</span>` : '';
    const label = isRatio ? ratioDetailHtml(item.label) : escapeHtml(item.label);
    return `<tr><td>${badge}${label}${detail}</td><td><input class="item-qty" data-item-index="${index}" type="number" min="1" value="${item.pack_count}"></td>` +
      `<td class="entry-total">${entryTotal(item)}</td><td><button class="remove" onclick="removeItem(${index})">×</button></td></tr>`;
  }).join('') : '<tr class="placeholder"><td colspan="4">搜索款色尺码或配比，按回车选中</td></tr>';
  $('boxTotal').textContent = state.items.reduce((sum, item) => sum + entryTotal(item), 0);
}
function syncItemQuantities(showError=false) {
  for (const input of $('itemRows').querySelectorAll('[data-item-index]')) {
    const count = Number(input.value); const index = Number(input.dataset.itemIndex);
    if (!Number.isInteger(count) || count < 1) {
      if (showError) { toast('数量请输入大于0的整数', true); input.focus(); }
      return false;
    }
    state.items[index].pack_count = count;
    const totalCell = input.closest('tr').querySelector('.entry-total'); if (totalCell) totalCell.textContent = entryTotal(state.items[index]);
  }
  $('boxTotal').textContent = state.items.reduce((sum,item) => sum + entryTotal(item),0);
  return true;
}
window.removeItem = index => { state.items.splice(index, 1); renderItems(); refreshQuantityReference(); if (!$('suggestions').hidden) searchOptions($('skuSearch').value); };

function cloneMultiplier() { return state.editingId ? 1 : Math.max(1, Number($('cloneCount').value) || 1); }
function pendingSkuQty(skuId) {
  const perBigPackage = state.items.reduce((sum, entry) => {
    const component = entry.items.find(item => item.sku_id === skuId);
    return sum + (component ? component.quantity_per_pack * entry.pack_count : 0);
  }, 0);
  return perBigPackage * cloneMultiplier();
}
function referenceRemaining(sku) { return sku.remaining_qty + (state.editingOriginal[sku.id] || 0) - pendingSkuQty(sku.id); }
function optionSearchText(option) { return option.entry_type === 'ratio' ? `${option.name} ${option.detail}` : option.label; }
function allOptions() {
  const skus = state.data.skus.map(sku => ({
    entry_type: 'sku', sku_id: sku.id, label: sku.display_label, units_per_pack: 1,
    items: [{sku_id: sku.id, label: sku.display_label, quantity_per_pack: 1}], sku,
  }));
  const ratios = (state.data.ratios || []).map(ratio => ({
    entry_type: 'ratio', ratio_id: ratio.id, name: ratio.name, label: ratio.name,
    detail: ratio.detail, units_per_pack: ratio.units_per_pack,
    items: ratio.items.map(item => ({sku_id:item.sku_id,label:item.label,quantity_per_pack:item.quantity})), ratio,
  }));
  return [...ratios, ...skus];
}
function searchOptions(query) {
  const words = normalize(query).split(' ').filter(Boolean);
  state.matches = allOptions().map((option, index) => {
    const text = normalize(optionSearchText(option)); const tokens = text.split(' ');
    return {option,index,matched:words.every(word => text.includes(word)),score:words.reduce((sum,word) => sum + (tokens.includes(word) ? 10 : 0), 0)};
  }).filter(row => row.matched).sort((a,b) => b.score - a.score || a.index - b.index).slice(0, 50).map(row => row.option);
  state.matchIndex = 0; renderSuggestions();
}
function ratioMaxPacks(option) {
  return Math.min(...option.items.map(item => {
    const sku = state.data.skus.find(row => row.id === item.sku_id);
    return Math.floor(referenceRemaining(sku) / item.quantity_per_pack);
  }));
}
function suggestionRowsHtml(mobile=false) {
  if (!state.matches.length) return '<div class="suggestion empty-option">当前批次没有匹配结果</div>';
  return state.matches.map((option,index) => {
    if (option.entry_type === 'ratio') {
      const available = ratioMaxPacks(option);
      return `<button type="button" class="suggestion ${index === state.matchIndex ? 'active' : ''}" data-option-index="${index}" data-sku-index="${index}" role="option">` +
        `<span class="entry-kind">配比</span><b>${escapeHtml(option.name)}</b> · ${option.units_per_pack}件/中包` +
        `<small>参考最多 ${available} 个中包 · ${mobile ? '点击整行选择' : '悬停查看明细'}</small><span class="ratio-hover-detail">${ratioDetailHtml(option.detail)}</span></button>`;
    }
    const remaining = referenceRemaining(option.sku);
    return `<button type="button" class="suggestion ${index === state.matchIndex ? 'active' : ''}" data-option-index="${index}" data-sku-index="${index}" role="option">` +
      `${escapeHtml(option.label)}<small>仓位 ${escapeHtml(option.sku.warehouse || '-')} · 清单 ${option.sku.planned_qty} · 已保存 ${option.sku.packed_qty} · 当前参考库存 ${remaining}</small></button>`;
  }).join('');
}
function renderSuggestions() {
  const box = $('suggestions'); const input = $('skuSearch');
  if ($('mobileSkuDialog').open) {
    box.hidden = true; input.setAttribute('aria-expanded','false');
    $('mobileSuggestions').innerHTML = suggestionRowsHtml(true);
    $('mobileSkuSummary').textContent = state.matches.length ? `找到 ${state.matches.length} 项，可上下滑动，点击整行选择` : '请换一个关键词';
    return;
  }
  box.hidden = false; input.setAttribute('aria-expanded','true');
  box.innerHTML = suggestionRowsHtml();
}
function refreshQuantityReference() {
  $('clearSkuSelection').hidden = !state.selectedOption;
  if (!state.selectedOption) { $('qtyReference').textContent = ''; $('skuQty').placeholder = '先选择款色尺码或配比'; return; }
  if (state.selectedOption.entry_type === 'ratio') {
    const available = ratioMaxPacks(state.selectedOption); $('qtyReference').textContent = `参考最多 ${available} 个中包`; $('skuQty').placeholder = `中包数量：${available}`;
  } else {
    const remaining = referenceRemaining(state.selectedOption.sku); $('qtyReference').textContent = `参考剩余 ${remaining} 件`; $('skuQty').placeholder = `参考：${remaining}`;
  }
}
function closeSuggestions() { $('suggestions').hidden = true; $('skuSearch').setAttribute('aria-expanded','false'); }
function usesMobileSkuPicker() { return Boolean(window.matchMedia?.('(max-width: 640px)').matches); }
function syncSkuPickerMode() {
  $('skuSearch').readOnly = usesMobileSkuPicker();
  $('skuSearch').setAttribute('aria-haspopup', usesMobileSkuPicker() ? 'dialog' : 'listbox');
}
function openMobileSkuPicker() {
  if (!state.data || $('mobileSkuDialog').open) return;
  closeSuggestions(); $('mobileSkuDialog').showModal(); $('mobileSkuSearch').value = '';
  searchOptions('');
}
function clearSelectedOption() {
  state.selectedOption = null;
  $('skuSearch').value = '';
  refreshQuantityReference();
  if (usesMobileSkuPicker()) closeSuggestions(); else searchOptions('');
}
window.chooseOption = index => {
  if (!Number.isInteger(index) || index < 0 || index >= state.matches.length) return;
  state.selectedOption = state.matches[index]; $('skuSearch').value = state.selectedOption.entry_type === 'ratio' ? state.selectedOption.name : state.selectedOption.label;
  closeSuggestions(); if ($('mobileSkuDialog').open) $('mobileSkuDialog').close();
  refreshQuantityReference(); $('skuQty').focus(); $('skuQty').select();
};
function addSelected() {
  if (!state.selectedOption) { toast('请先选择款色尺码或配比', true); $('skuSearch').focus(); return; }
  const count = Number($('skuQty').value); if (!Number.isInteger(count) || count < 1) { toast('数量请输入大于0的整数', true); $('skuQty').focus(); return; }
  const option = state.selectedOption;
  const existing = state.items.find(item => !item.entry_id && item.entry_type === option.entry_type &&
    (option.entry_type === 'ratio' ? item.ratio_id === option.ratio_id : item.sku_id === option.sku_id));
  if (existing) existing.pack_count += count;
  else state.items.push({...option, pack_count: count, label: option.entry_type === 'ratio' ? option.detail : option.label});
  state.selectedOption = null; state.matches = []; $('skuSearch').value = ''; $('skuQty').value = '';
  renderItems(); refreshQuantityReference(); $('skuSearch').focus(); closeSuggestions();
}

function packagePayload(force=false) {
  return {
    package_no:$('packageNo').value, clone_count:state.editingId ? 1 : $('cloneCount').value,
    length_cm:$('lengthCm').value, width_cm:$('widthCm').value, height_cm:$('heightCm').value, weight_kg:$('weightKg').value,
    entries:state.items.map(item => ({entry_id:item.entry_id || null,entry_type:item.entry_type,sku_id:item.sku_id || null,ratio_id:item.ratio_id || null,pack_count:item.pack_count})), force,
  };
}
async function save(force=false) {
  if (!state.pendingPayload && !syncItemQuantities(true)) return;
  if (!force && !state.pendingPayload && !state.editingId && Number($('cloneCount').value) > 100 && !confirm(`将一次生成 ${$('cloneCount').value} 个大包，确定继续吗？`)) return;
  const payload = state.pendingPayload ? {...state.pendingPayload,force} : packagePayload(force);
  const url = state.editingId ? `/api/packages/${state.editingId}` : `/api/batches/${state.data.batch.id}/packages`; const method = state.editingId ? 'PUT' : 'POST';
  try {
    const result = await api(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    state.pendingPayload = null; $('overDialog').close(); state.data = result.data;
    const created = result.created?.join('、'); const nextStart = result.created?.length ? Number(result.created.at(-1).replace('#','')) + 1 : null;
    toast(created ? `已生成大包 ${created}` : '大包修改成功'); resetEditor(true,nextStart); renderAll();
  } catch (error) {
    if (error.status === 409) { state.pendingPayload = payload; showOver(error.body.overages); return; } toast(error.message,true);
  }
}
function showOver(overages) {
  $('overList').innerHTML = overages.map(item => `<div class="over-item"><b>${escapeHtml(item.label)}</b><br>清单 ${item.planned} · 已装 ${item.before} · 本次 ${item.added} · 保存后 ${item.after} · <strong>超出 ${item.over}</strong></div>`).join('');
  $('overDialog').showModal();
}
function updateCloneHint() {
  const start = Number(String($('packageNo').value).replace('#','')); const count = Number($('cloneCount').value) || 1; const total = state.items.reduce((sum,item) => sum + entryTotal(item),0) * count;
  if (count <= 1) $('cloneHint').textContent = '填1只保存当前大包；大于1会完整复制本大包，并让大包号连续递增。';
  else if (start > 0) $('cloneHint').innerHTML = `将生成 <strong>${start}# 至 ${start + count - 1}#</strong>，共${count}个大包；当前每大包${total / count}件，合计${total}件。`;
  else $('cloneHint').textContent = `将生成${count}个连续大包号；商品、配比、数量和长宽高重全部相同。`;
  refreshQuantityReference(); if (!$('suggestions').hidden) searchOptions($('skuSearch').value);
}
function resetEditor(suggest,nextStart=null) {
  const previous = Number($('packageNo').value.replace('#','')); state.items = []; state.selectedOption = null; state.editingId = null;
  state.editingOriginal = {}; state.pendingPayload = null; state.duplicateId = null;
  ['skuSearch','skuQty','lengthCm','widthCm','heightCm','weightKg','volumeM3'].forEach(id => $(id).value = ''); $('cloneCount').value = 1;
  $('editorTitle').textContent = '录入新大包'; $('cancelEdit').hidden = true; $('cloneCount').disabled = false;
  if (suggest && (nextStart || previous)) { let candidate = nextStart || previous + 1; const used = new Set(state.data.packages.map(row => row.package_no)); while (used.has(candidate)) candidate += 1; $('packageNo').value = `${candidate}#`; }
  else if (!suggest) $('packageNo').value = '';
  renderItems(); updateCloneHint(); $('packageNo').focus();
}
window.viewPackage = async id => {
  const row = await api(`/api/packages/${id}`);
  const lines = row.entries.map(entry => entry.entry_type === 'ratio'
    ? `<li>${ratioDetailHtml(entry.label)}<span class="entry-detail">${entry.units_per_pack}件/中包 × ${entry.pack_count}中包＝${entry.total_quantity}件</span></li>`
    : `<li>${escapeHtml(entry.label)} × ${entry.pack_count}</li>`).join('');
  $('viewTitle').textContent = `查看大包 ${row.package_label}`;
  $('viewContent').innerHTML = `<b>大包内商品与配比</b><ul>${lines}</ul><div>共 ${row.items.reduce((sum,item) => sum + item.quantity,0)} 件</div><div>${packageMeasureHtml(row)}</div>`;
  $('viewDialog').showModal();
};
window.editPackage = async id => {
  const row = await api(`/api/packages/${id}`); state.editingId = id; state.duplicateId = null;
  state.editingOriginal = Object.fromEntries(row.items.map(item => [item.sku_id,item.quantity])); state.items = row.entries;
  $('packageNo').value = row.package_no; $('lengthCm').value = row.length_cm ?? ''; $('widthCm').value = row.width_cm ?? '';
  $('heightCm').value = row.height_cm ?? ''; $('weightKg').value = row.weight_kg ?? ''; $('cloneCount').value = 1; $('cloneCount').disabled = true;
  updateVolume();
  $('editorTitle').textContent = `修改大包 ${row.package_label}`; $('cancelEdit').hidden = false; renderItems(); updateCloneHint(); window.scrollTo({top:0,behavior:'smooth'});
};
window.deletePackage = async (id,label) => {
  if (!confirm(`确定清空并删除 ${label} 吗？`)) return;
  try { const result = await api(`/api/packages/${id}`,{method:'DELETE'}); state.data = result.data; renderAll(); toast(`${label} 已清空`); } catch (error) { toast(error.message,true); }
};

function renderRatioList() {
  const ratios = state.data.ratios || [];
  $('ratioList').innerHTML = ratios.length ? ratios.map(ratio =>
    `<div class="ratio-card"><b>${escapeHtml(ratio.name)}</b><div>${ratio.units_per_pack}件/中包<span class="entry-detail">${ratioDetailHtml(ratio.detail)}</span></div>` +
    `<div class="actions"><button type="button" onclick="editRatio(${ratio.id})">修改</button><button type="button" class="delete" onclick="deleteRatio(${ratio.id},'${ratio.name}')">删除</button></div></div>`
  ).join('') : '<div class="placeholder">当前批次还没有配比</div>';
}
function openRatioManager() { renderRatioList(); $('ratioEditor').hidden = true; $('ratioDialog').showModal(); }
function renderRatioItems() {
  $('ratioItemRows').innerHTML = state.ratioItems.length ? state.ratioItems.map((item,index) =>
    `<tr><td>${escapeHtml(item.label)}</td><td><input class="item-qty" data-ratio-item-index="${index}" type="number" min="1" value="${item.quantity}"></td>` +
    `<td><button class="remove" onclick="removeRatioItem(${index})">×</button></td></tr>`
  ).join('') : '<tr class="placeholder"><td colspan="3">添加一个或多个款色尺码</td></tr>';
  $('ratioTotal').textContent = state.ratioItems.reduce((sum,item) => sum + Number(item.quantity),0);
}
function syncRatioItemQuantities(showError=false) {
  for (const input of $('ratioItemRows').querySelectorAll('[data-ratio-item-index]')) {
    const quantity = Number(input.value); const index = Number(input.dataset.ratioItemIndex);
    if (!Number.isInteger(quantity) || quantity < 1) {
      if (showError) { toast('每中包数量请输入大于0的整数',true); input.focus(); }
      return false;
    }
    state.ratioItems[index].quantity = quantity;
  }
  $('ratioTotal').textContent = state.ratioItems.reduce((sum,item) => sum + Number(item.quantity),0);
  return true;
}
function startRatioEdit(ratio=null) {
  state.editingRatioId = ratio?.id || null; state.ratioItems = ratio ? ratio.items.map(item => ({...item})) : []; state.selectedRatioSku = null;
  $('ratioEditorTitle').textContent = ratio ? `修改${ratio.name}` : '新建配比'; $('ratioEditor').hidden = false;
  $('ratioSkuSearch').value = ''; $('ratioSkuQty').value = ''; renderRatioItems(); $('ratioSkuSearch').focus();
}
window.editRatio = id => { const ratio = state.data.ratios.find(row => row.id === id); if (ratio) startRatioEdit(ratio); };
window.removeRatioItem = index => { state.ratioItems.splice(index,1); renderRatioItems(); };
function searchRatioSkus(query) {
  const words = normalize(query).split(' ').filter(Boolean);
  state.ratioMatches = state.data.skus.filter(sku => words.every(word => normalize(sku.display_label).includes(word))).slice(0,50);
  const box = $('ratioSuggestions'); box.hidden = false; $('ratioSkuSearch').setAttribute('aria-expanded','true');
  box.innerHTML = state.ratioMatches.length ? state.ratioMatches.map((sku,index) =>
    `<button type="button" class="suggestion" data-ratio-sku-index="${index}">${escapeHtml(sku.display_label)}<small>仓位 ${escapeHtml(sku.warehouse || '-')}</small></button>`
  ).join('') : '<div class="suggestion empty-option">没有匹配结果</div>';
}
function chooseRatioSku(index) { state.selectedRatioSku = state.ratioMatches[index]; $('ratioSkuSearch').value = state.selectedRatioSku.display_label; $('ratioSuggestions').hidden = true; $('ratioSkuSearch').setAttribute('aria-expanded','false'); $('ratioSkuQty').focus(); }
function addRatioSku() {
  if (!state.selectedRatioSku) { toast('请先选择款色尺码',true); return; }
  const quantity = Number($('ratioSkuQty').value); if (!Number.isInteger(quantity) || quantity < 1) { toast('请输入每中包数量',true); return; }
  const existing = state.ratioItems.find(item => item.sku_id === state.selectedRatioSku.id);
  if (existing) existing.quantity += quantity; else state.ratioItems.push({sku_id:state.selectedRatioSku.id,label:state.selectedRatioSku.display_label,quantity});
  state.selectedRatioSku = null; $('ratioSkuSearch').value = ''; $('ratioSkuQty').value = ''; $('ratioSuggestions').hidden = true; renderRatioItems(); $('ratioSkuSearch').focus();
}
async function saveRatio() {
  if (!syncRatioItemQuantities(true)) return;
  const payload = {items:state.ratioItems.map(item => ({sku_id:item.sku_id,quantity:item.quantity}))};
  const url = state.editingRatioId ? `/api/ratios/${state.editingRatioId}` : `/api/batches/${state.data.batch.id}/ratios`;
  try {
    const ratio = await api(url,{method:state.editingRatioId?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    state.data = await api(`/api/batches/${state.data.batch.id}`); renderAll(); renderRatioList(); $('ratioEditor').hidden = true; toast(`${ratio.name}已保存`);
  } catch (error) { toast(error.message,true); }
}
window.deleteRatio = async (id,name) => {
  if (!confirm(`确定删除${name}吗？已保存大包不受影响。`)) return;
  try { await api(`/api/ratios/${id}`,{method:'DELETE'}); state.data = await api(`/api/batches/${state.data.batch.id}`); renderAll(); renderRatioList(); toast(`${name}已删除`); } catch (error) { toast(error.message,true); }
};

function autoAllocationPayload() {
  return {
    mode:'balanced', start_package_no:$('autoStartNo').value, package_count:$('autoPackageCount').value,
    selected_sku_ids:[...state.autoSelected], preview_token:state.autoPreview?.preview_token || '',
  };
}
function invalidateAutoPreview() {
  state.autoPreview = null; $('autoPreview').hidden = true; $('commitAutoAllocation').disabled = true;
}
function filteredAutoSkus() {
  const words = normalize($('autoSkuFilter').value).split(' ').filter(Boolean);
  return state.data.skus.filter(sku => sku.remaining_qty > 0 && words.every(word => normalize(sku.display_label).includes(word)));
}
function renderAutoSkuList() {
  const rows = filteredAutoSkus();
  $('autoSkuList').innerHTML = rows.length ? rows.map(sku =>
    `<label><input type="checkbox" data-auto-sku-id="${sku.id}" ${state.autoSelected.has(sku.id) ? 'checked' : ''}>` +
    `<span>${escapeHtml(sku.display_label)}<small>剩余 ${sku.remaining_qty} 件 · 仓位 ${escapeHtml(sku.warehouse || '-')}</small></span></label>`
  ).join('') : '<div class="placeholder">没有可分配的款色尺码</div>';
  $('autoSelectAll').checked = rows.length > 0 && rows.every(sku => state.autoSelected.has(sku.id));
  const selectedRows = state.data.skus.filter(sku => state.autoSelected.has(sku.id));
  $('autoSelectedSummary').textContent = `已选 ${selectedRows.length} 款，共 ${selectedRows.reduce((sum,sku) => sum + Math.max(0,sku.remaining_qty),0)} 件`;
}
function openAutoAllocation() {
  state.autoSelected = new Set(state.data.skus.filter(sku => sku.remaining_qty > 0).map(sku => sku.id));
  state.autoPreview = null; $('autoSkuFilter').value = ''; $('autoPackageCount').value = 1;
  const used = new Set(state.data.packages.map(row => row.package_no)); let start = 1; while (used.has(start)) start += 1;
  $('autoStartNo').value = `${start}#`; invalidateAutoPreview(); renderAutoSkuList(); $('autoAllocationDialog').showModal();
}
async function previewAutoAllocation() {
  try {
    const result = await api(`/api/batches/${state.data.batch.id}/auto-allocation/preview`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(autoAllocationPayload()),
    });
    state.autoPreview = result;
    const packages = result.packages.map(row => `<details><summary><b>${row.package_label}</b> · ${row.total_quantity}件</summary><ul>${row.items.map(item => `<li>${escapeHtml(item.label)} × ${item.quantity}</li>`).join('')}</ul></details>`).join('');
    $('autoPreview').innerHTML = `<div class="auto-summary"><b>所选 ${result.selected_total} 件</b><span>${result.package_count}个大包</span><span>每包 ${result.min_package_quantity}–${result.max_package_quantity} 件</span><span>未分配 ${result.unallocated}</span></div>${packages}`;
    $('autoPreview').hidden = false; $('commitAutoAllocation').disabled = result.unallocated !== 0;
  } catch (error) { invalidateAutoPreview(); toast(error.message,true); }
}
async function commitAutoAllocation() {
  if (!state.autoPreview) return;
  const button = $('commitAutoAllocation'); button.disabled = true; button.textContent = '正在生成…';
  try {
    const result = await api(`/api/batches/${state.data.batch.id}/auto-allocation/commit`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(autoAllocationPayload()),
    });
    state.data = result.data; $('autoAllocationDialog').close(); renderAll(); resetEditor(true);
    toast(`已生成 ${result.created.length} 个大包：${result.created[0]}–${result.created.at(-1)}`);
  } catch (error) { invalidateAutoPreview(); toast(error.message,true); }
  finally { button.textContent = '确认生成这些大包'; if (state.autoPreview) button.disabled = false; }
}
function formatBytes(value) { return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
async function openBackups() {
  try {
    const rows = await api('/api/backups');
    $('backupList').innerHTML = rows.length ? rows.map(row => `<div class="backup-row"><div><b>${escapeHtml(row.filename)}</b><small>${escapeHtml(row.modified_at.replace('T',' '))} · ${formatBytes(row.size)}</small></div><a class="button ghost" href="/api/backups/${encodeURIComponent(row.filename)}" download>下载</a></div>`).join('') : '<div class="placeholder">还没有可下载的备份</div>';
    $('backupDialog').showModal();
  } catch (error) { toast(error.message,true); }
}

$('newBatchBtn').onclick = openImport; $('batchSelect').onchange = event => { if (event.target.value) loadBatch(Number(event.target.value)); };
$('savePackage').onclick = () => save(false); $('forceSave').onclick = () => save(true); $('addSku').onclick = addSelected;
$('cancelEdit').onclick = () => resetEditor(false); $('diffSearch').oninput = renderDiff; $('ratioManagerBtn').onclick = openRatioManager;
$('autoAllocationBtn').onclick = openAutoAllocation; $('closeAutoAllocation').onclick = () => $('autoAllocationDialog').close();
$('previewAutoAllocation').onclick = previewAutoAllocation; $('commitAutoAllocation').onclick = commitAutoAllocation;
$('autoSkuFilter').oninput = renderAutoSkuList;
$('autoSkuList').onchange = event => { const id = Number(event.target.dataset.autoSkuId); if (!id) return; event.target.checked ? state.autoSelected.add(id) : state.autoSelected.delete(id); invalidateAutoPreview(); renderAutoSkuList(); };
$('autoSelectAll').onchange = event => { for (const sku of filteredAutoSkus()) event.target.checked ? state.autoSelected.add(sku.id) : state.autoSelected.delete(sku.id); invalidateAutoPreview(); renderAutoSkuList(); };
$('autoStartNo').oninput = invalidateAutoPreview; $('autoPackageCount').oninput = invalidateAutoPreview;
$('backupBtn').onclick = openBackups; $('closeBackupDialog').onclick = () => $('backupDialog').close(); $('closeBackupButton').onclick = () => $('backupDialog').close();
$('closeRatioDialog').onclick = () => $('ratioDialog').close(); $('newRatioBtn').onclick = () => startRatioEdit();
$('cancelRatioEdit').onclick = () => { $('ratioEditor').hidden = true; }; $('addRatioSku').onclick = addRatioSku; $('saveRatio').onclick = saveRatio;
$('exportBtn').onclick = event => { if (!state.data) { event.preventDefault(); toast('请先选择批次',true); return; } toast(`已开始下载：${$('exportBtn').download}，请查看浏览器下载记录`); };
async function searchBatches() {
  const query = $('batchSearch').value.trim(); if (!query) { await loadBatches(state.data?.batch?.id); return; }
  const token = ++state.batchSearchToken; const rows = await api(`/api/batches?q=${encodeURIComponent(query)}`); if (token !== state.batchSearchToken) return;
  if (!rows.length) { toast('没有找到匹配的历史批次',true); return; }
  state.batches = rows; $('batchSelect').innerHTML = rows.map(row => `<option value="${row.id}">${row.batch_no}</option>`).join('');
  $('batchSelect').value = rows[0].id; await loadBatch(rows[0].id); toast(`找到 ${rows.length} 个历史批次`);
}
$('batchSearchBtn').onclick = () => searchBatches().catch(error => toast(error.message,true));
$('batchSearch').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); searchBatches().catch(error => toast(error.message,true)); } };
$('skuSearch').oninput = event => { state.selectedOption = null; refreshQuantityReference(); searchOptions(event.target.value); };
$('skuSearch').onfocus = event => usesMobileSkuPicker() ? openMobileSkuPicker() : searchOptions(event.target.value);
$('skuSearch').onclick = event => usesMobileSkuPicker() ? openMobileSkuPicker() : searchOptions(event.target.value);
$('skuSearch').onbeforeinput = event => {
  if (state.selectedOption && String(event.inputType).startsWith('deleteContent')) {
    event.preventDefault(); clearSelectedOption();
  }
};
$('skuSearch').onkeydown = event => {
  if (state.selectedOption && (event.key === 'Backspace' || event.key === 'Delete')) { event.preventDefault(); clearSelectedOption(); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); state.matchIndex = Math.min(state.matches.length - 1,state.matchIndex + 1); renderSuggestions(); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); state.matchIndex = Math.max(0,state.matchIndex - 1); renderSuggestions(); }
  else if (event.key === 'Enter' && state.matches.length) { event.preventDefault(); chooseOption(state.matchIndex); }
  else if (event.key === 'Escape') closeSuggestions();
};
$('suggestions').addEventListener('pointerdown',event => { const option = event.target.closest('[data-option-index]'); if (!option) return; event.preventDefault(); chooseOption(Number(option.dataset.optionIndex)); });
$('mobileSkuSearch').oninput = event => searchOptions(event.target.value);
$('mobileSuggestions').addEventListener('pointerdown',event => { const option = event.target.closest('[data-option-index]'); if (!option) return; event.preventDefault(); chooseOption(Number(option.dataset.optionIndex)); });
$('closeMobileSkuDialog').onclick = () => $('mobileSkuDialog').close();
$('clearSkuSelection').onclick = event => { event.preventDefault(); event.stopPropagation(); clearSelectedOption(); };
$('itemRows').addEventListener('input',event => { if (!event.target.matches('[data-item-index]')) return; if (syncItemQuantities()) { updateCloneHint(); } });
document.addEventListener('pointerdown',event => { if (!event.target.closest('.search-wrap')) { closeSuggestions(); $('ratioSuggestions').hidden = true; } });
$('skuQty').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addSelected(); } };
$('ratioSkuSearch').oninput = event => { state.selectedRatioSku = null; searchRatioSkus(event.target.value); };
$('ratioSkuSearch').onfocus = event => searchRatioSkus(event.target.value);
$('ratioSuggestions').addEventListener('pointerdown',event => { const option = event.target.closest('[data-ratio-sku-index]'); if (!option) return; event.preventDefault(); chooseRatioSku(Number(option.dataset.ratioSkuIndex)); });
$('ratioItemRows').addEventListener('input',event => { if (event.target.matches('[data-ratio-item-index]')) syncRatioItemQuantities(); });
$('ratioSkuQty').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); addRatioSku(); } };
$('packageNo').oninput = updateCloneHint; $('cloneCount').oninput = updateCloneHint;
for (const id of ['lengthCm','widthCm','heightCm']) $(id).addEventListener('input',updateVolume);
$('packageNo').onblur = event => {
  const match = String(event.target.value).match(/^\s*(\d+)\s*#?\s*$/); if (!match) { if (event.target.value) toast('大包号只需输入大于0的数字',true); return; }
  const number = Number(match[1]); if (number < 1) { toast('大包号必须大于0',true); return; }
  event.target.value = `${number}#`; updateCloneHint(); const existing = state.data.packages.find(row => row.package_no === number && row.id !== state.editingId);
  if (existing) { state.duplicateId = existing.id; $('duplicateText').textContent = `大包 ${existing.package_label} 已经保存，不能重复新建。你可以查看原记录或进入修改。`; $('duplicateDialog').showModal(); }
};
$('viewExisting').onclick = () => { const id = state.duplicateId; $('duplicateDialog').close(); if (id) viewPackage(id); };
$('editExisting').onclick = () => { const id = state.duplicateId; $('duplicateDialog').close(); if (id) editPackage(id); };
$('overDialog').addEventListener('close',() => { state.pendingPayload = null; });
$('importForm').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button[type=submit]'); button.disabled = true; button.textContent = '正在导入…';
  try { const result = await api('/api/import',{method:'POST',body:new FormData(event.target)}); $('importDialog').close(); event.target.reset(); await loadBatches(result.batch.id); toast(`批次 ${result.batch.batch_no} 已创建`); }
  catch (error) { toast(error.message,true); } finally { button.disabled = false; button.textContent = '导入并开始装箱'; }
};

syncSkuPickerMode();
window.addEventListener('resize', syncSkuPickerMode);
loadBatches().catch(error => toast(error.message,true));
