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


async function boot(fetchImpl) {
  const rawHtml = await readFile(new URL('../templates/index.html', import.meta.url), 'utf8');
  const html = rawHtml.replace(/<script src=.*?<\/script>/s, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
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
});
