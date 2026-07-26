import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';


const batch = {
  batch: { id: 1, batch_no: '20260722-001', internal_order: 'TEST-1', source_filename: 'source.xlsx' },
  summary: { packages: 0, packed: 0, remaining: 8, over: 0 },
  packages: [],
  skus: [
    { id: 11, display_label: '001 T恤 A001 黑色 XL', warehouse: 'A-01', planned_qty: 5, packed_qty: 0, remaining_qty: 5 },
    { id: 12, display_label: '002 T恤 A002 白色 M', warehouse: 'A-02', planned_qty: 3, packed_qty: 0, remaining_qty: 3 },
  ],
};


async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待前端状态超时');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}


async function boot(fetchImpl, { mobile = false } = {}) {
  const rawHtml = await readFile(new URL('../templates/index.html', import.meta.url), 'utf8');
  const html = rawHtml.replace(/<script src=.*?<\/script>/s, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  window.matchMedia = query => ({
    matches: mobile && query === '(max-width: 640px)', media: query,
    addEventListener() {}, removeEventListener() {},
  });
  window.scrollTo = () => {};
  window.confirm = () => true;
  for (const dialog of window.document.querySelectorAll('dialog')) {
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  }
  window.fetch = fetchImpl;
  const script = await readFile(new URL('../static/app.js', import.meta.url), 'utf8');
  window.eval(script);
  await waitFor(() => !window.document.getElementById('workspace').hidden);
  return window;
}


test('款色尺码支持点击展开、多关键词匹配、选择、扣减和返还', async () => {
  const window = await boot(async url => {
    const path = String(url);
    const body = path === '/api/batches?q='
      ? [{ id: 1, batch_no: '20260722-001' }]
      : path === '/api/batches/1'
        ? batch
        : [];
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });

  const input = window.document.getElementById('skuSearch');
  input.dispatchEvent(new window.Event('focus'));
  assert.equal(window.document.querySelectorAll('[data-sku-index]').length, 2);
  assert.equal(input.getAttribute('aria-expanded'), 'true');

  input.value = '001 xl';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const matched = window.document.querySelectorAll('[data-sku-index]');
  assert.equal(matched.length, 1);
  assert.match(matched[0].textContent, /001.*XL/);

  matched[0].dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(input.value, '001 T恤 A001 黑色 XL');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.match(window.document.getElementById('qtyReference').textContent, /5 件/);

  window.document.getElementById('skuQty').value = '2';
  window.document.getElementById('addSku').click();
  assert.match(window.document.getElementById('itemRows').textContent, /001 T恤 A001 黑色 XL/);
  assert.equal(window.document.getElementById('boxTotal').textContent, '2');
  assert.equal(window.document.getElementById('suggestions').hidden, true);
  assert.equal(input.getAttribute('aria-expanded'), 'false');

  input.dispatchEvent(new window.Event('focus'));
  assert.match(window.document.getElementById('suggestions').textContent, /当前参考库存 3/);

  window.removeItem(0);
  assert.equal(window.document.getElementById('boxTotal').textContent, '0');
  assert.match(window.document.getElementById('suggestions').textContent, /当前参考库存 5/);
});


test('手机端用独立选择面板搜索、滚动和整行点选款色尺码', async () => {
  const css = await readFile(new URL('../static/tweaks.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /\.sku-entry > \.search-wrap \{ grid-column: 1 \/ -1; \}/);
  assert.match(css, /max-height: min\(46vh, 360px\)/);
  assert.match(css, /-webkit-overflow-scrolling: touch/);
  assert.match(css, /\.suggestions \.suggestion \{ min-height: 50px;/);
  assert.match(css, /input,select,textarea \{ min-width: 0; font-size: 16px; \}/);
  assert.match(css, /\.mobile-sku-dialog \{ height: min\(88dvh, 720px\)/);
  assert.match(css, /\.mobile-sku-options \{ flex: 1 1 auto;/);

  const window = await boot(async url => {
    const body = String(url) === '/api/batches?q='
      ? [{ id: 1, batch_no: '20260722-001' }]
      : String(url) === '/api/batches/1' ? batch : [];
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  }, { mobile: true });
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
  const input = window.document.getElementById('skuSearch');
  assert.equal(input.readOnly, true);
  input.click();
  assert.equal(window.document.getElementById('mobileSkuDialog').open, true);
  assert.match(window.document.getElementById('mobileSkuSummary').textContent, /找到 2 项/);
  assert.equal(window.document.querySelectorAll('#mobileSuggestions [data-option-index]').length, 2);

  const pickerSearch = window.document.getElementById('mobileSkuSearch');
  pickerSearch.value = '001 xl';
  pickerSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(window.document.querySelectorAll('#mobileSuggestions [data-option-index]').length, 1);
  const option = window.document.querySelector('#mobileSuggestions [data-option-index]');
  option.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(window.document.getElementById('mobileSkuDialog').open, false);
  assert.equal(input.value, '001 T恤 A001 黑色 XL');
  assert.equal(window.document.activeElement.id, 'skuQty');
  assert.equal(window.document.getElementById('clearSkuSelection').hidden, false);
  window.document.getElementById('clearSkuSelection').click();
  assert.equal(input.value, '');
  assert.equal(window.document.getElementById('clearSkuSelection').hidden, true);
});


test('批次只在点击查询后搜索历史，并显示大包缺失重量', async () => {
  const calls = [];
  const oldBatch = structuredClone(batch);
  oldBatch.batch = { id: 2, batch_no: '20260720-001', internal_order: 'OLD-ORDER', source_filename: 'old.xlsx' };
  oldBatch.packages = [{
    id: 21, package_no: 1, package_label: '1#', item_count: 1, total_qty: 2,
    length_cm: null, width_cm: null, height_cm: null, weight_kg: null,
  }];
  oldBatch.summary.packages = 1;
  const window = await boot(async url => {
    const path = String(url);
    calls.push(path);
    const body = path === '/api/batches?q='
      ? [{ id: 1, batch_no: '20260722-001' }]
      : path === '/api/batches/1'
        ? batch
        : path === '/api/batches?q=20260720'
          ? [{ id: 2, batch_no: '20260720-001' }]
          : path === '/api/batches/2'
            ? oldBatch
            : [];
    return { ok: true, status: 200, json: async () => structuredClone(body) };
  });

  const search = window.document.getElementById('batchSearch');
  const exportLink = window.document.getElementById('exportBtn');
  assert.equal(exportLink.getAttribute('href'), '/api/batches/1/export');
  assert.equal(exportLink.getAttribute('download'), '发货清单_20260722-001.xlsx');
  search.value = '20260720';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(calls.includes('/api/batches?q=20260720'), false);
  window.document.getElementById('batchSearchBtn').click();
  await waitFor(() => window.document.getElementById('batchMeta').textContent.includes('OLD-ORDER'));
  assert.equal(calls.includes('/api/batches?q=20260720'), true);
  assert.match(window.document.getElementById('packageList').textContent, /体重未填/);
  assert.match(window.document.getElementById('packageList').textContent, /长未填/);
  assert.match(window.document.getElementById('packageList').textContent, /体积未算/);
});


test('长宽高自动计算体积，自动配比先预览再确认生成', async () => {
  let previewPayload;
  let commitPayload;
  const allocated = structuredClone(batch);
  allocated.packages = [
    { id: 31, package_no: 1, package_label: '1#', item_count: 2, total_qty: 4, volume_m3: null },
    { id: 32, package_no: 2, package_label: '2#', item_count: 2, total_qty: 4, volume_m3: null },
  ];
  allocated.summary = { ...allocated.summary, packages: 2, packed: 8, remaining: 0 };
  const window = await boot(async (url, options={}) => {
    const path = String(url);
    if (path === '/api/batches?q=') return { ok: true, status: 200, json: async () => [{ id: 1, batch_no: '20260722-001' }] };
    if (path === '/api/batches/1') return { ok: true, status: 200, json: async () => structuredClone(batch) };
    if (path.endsWith('/auto-allocation/preview')) {
      previewPayload = JSON.parse(options.body);
      return { ok: true, status: 200, json: async () => ({
        mode:'balanced', start_package_no:1, package_count:2, selected_total:8,
        unallocated:0, min_package_quantity:4, max_package_quantity:4, preview_token:'token-1',
        packages:[
          { package_no:1, package_label:'1#', total_quantity:4, items:[{ sku_id:11, label:batch.skus[0].display_label, quantity:3 },{ sku_id:12, label:batch.skus[1].display_label, quantity:1 }] },
          { package_no:2, package_label:'2#', total_quantity:4, items:[{ sku_id:11, label:batch.skus[0].display_label, quantity:2 },{ sku_id:12, label:batch.skus[1].display_label, quantity:2 }] },
        ],
      }) };
    }
    if (path.endsWith('/auto-allocation/commit')) {
      commitPayload = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ created:['1#','2#'], data:structuredClone(allocated) }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  for (const [id,value] of [['lengthCm','50'],['widthCm','40'],['heightCm','30']]) {
    const input = window.document.getElementById(id); input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles:true }));
  }
  assert.equal(window.document.getElementById('volumeM3').value, '0.0600');
  window.document.getElementById('heightCm').value = '';
  window.document.getElementById('heightCm').dispatchEvent(new window.Event('input', { bubbles:true }));
  assert.equal(window.document.getElementById('volumeM3').value, '');

  window.document.getElementById('autoAllocationBtn').click();
  assert.equal(window.document.querySelectorAll('[data-auto-sku-id]').length, 2);
  window.document.getElementById('autoPackageCount').value = '2';
  window.document.getElementById('previewAutoAllocation').click();
  await waitFor(() => previewPayload);
  assert.deepEqual(previewPayload.selected_sku_ids, [11,12]);
  assert.equal(previewPayload.mode, 'balanced');
  await waitFor(() => !window.document.getElementById('autoPreview').hidden);
  assert.match(window.document.getElementById('autoPreview').textContent, /所选 8 件.*每包 4–4 件.*未分配 0/s);
  window.document.getElementById('commitAutoAllocation').click();
  await waitFor(() => commitPayload);
  assert.equal(commitPayload.preview_token, 'token-1');
  await waitFor(() => !window.document.getElementById('autoAllocationDialog').open);
  assert.equal(window.document.getElementById('autoAllocationDialog').open, false);
  assert.equal(window.document.getElementById('mPackages').textContent, '2');
});


test('配比与款色尺码聚合搜索，悬停明细并按中包数量加入', async () => {
  const ratioBatch = structuredClone(batch);
  ratioBatch.ratios = [{
    id: 51,
    name: '配比1',
    detail: '配比1：001 T恤 A001 黑色 XL×2；002 T恤 A002 白色 M×1',
    units_per_pack: 3,
    items: [
      { sku_id: 11, label: '001 T恤 A001 黑色 XL', quantity: 2 },
      { sku_id: 12, label: '002 T恤 A002 白色 M', quantity: 1 },
    ],
  }];
  let savedPayload;
  const window = await boot(async (url, options={}) => {
    const path = String(url);
    if (path === '/api/batches?q=') return { ok: true, status: 200, json: async () => [{ id: 1, batch_no: '20260722-001' }] };
    if (path === '/api/batches/1') return { ok: true, status: 200, json: async () => structuredClone(ratioBatch) };
    if (path === '/api/batches/1/packages') {
      savedPayload = JSON.parse(options.body);
      return { ok: true, status: 201, json: async () => ({ data: structuredClone(ratioBatch), created: ['1#'] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const input = window.document.getElementById('skuSearch');
  input.value = '配比1';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const option = window.document.querySelector('[data-option-index]');
  assert.match(option.textContent, /配比1.*3件\/中包/);
  assert.match(option.querySelector('.ratio-hover-detail').textContent, /黑色 XL×2.*白色 M×1/);
  assert.equal(option.querySelectorAll('.ratio-hover-detail .ratio-detail-lines > span').length, 3);
  option.dispatchEvent(new window.Event('pointerdown', { bubbles: true, cancelable: true }));
  assert.equal(input.value, '配比1');
  assert.match(window.document.getElementById('qtyReference').textContent, /最多 2 个中包/);

  window.document.getElementById('skuQty').value = '2';
  window.document.getElementById('addSku').click();
  assert.match(window.document.getElementById('itemRows').textContent, /3件\/中包 × 2中包/);
  assert.equal(window.document.querySelectorAll('#itemRows .ratio-detail-lines > span').length, 3);
  assert.equal(window.document.getElementById('boxTotal').textContent, '6');

  const quantityInput = window.document.querySelector('#itemRows [data-item-index="0"]');
  quantityInput.value = '3';
  quantityInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(window.document.getElementById('boxTotal').textContent, '9');

  window.document.getElementById('packageNo').value = '1#';
  window.document.getElementById('savePackage').click();
  await waitFor(() => savedPayload);
  assert.deepEqual(savedPayload.entries, [{ entry_id: null, entry_type: 'ratio', sku_id: null, ratio_id: 51, pack_count: 3 }]);
});
