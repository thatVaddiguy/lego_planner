(() => {
  'use strict';

  const CONFIG = window.PLANNER_CONFIG;
  const BUILTIN = CONFIG.palette;
  const MAX_DIM = CONFIG.maxDimension;
  const STORAGE_KEY = 'lego-planner:v1';

  const $ = (id) => document.getElementById(id);
  const els = {
    dropzone: $('dropzone'), image: $('image'), thumb: $('thumb'),
    fileName: $('file-name'), fileDims: $('file-dims'),
    width: $('width'), height: $('height'), lock: $('lock-btn'), sizeInfo: $('size-info'),
    showAll: $('show-all'), setAllValue: $('setall-value'), setAllBtn: $('setall-btn'),
    inventoryList: $('inventory-list'), inventoryEmpty: $('inventory-empty'),
    customForm: $('custom-form'), customColor: $('custom-color'), customName: $('custom-name'),
    jsonDetails: $('json-details'), jsonBox: $('json-box'), jsonApply: $('json-apply'),
    jsonCopy: $('json-copy'), reset: $('reset-btn'),
    meter: $('meter'), meterLabel: $('meter-label'), meterNumbers: $('meter-numbers'), meterFill: $('meter-fill'),
    planBtn: $('plan-btn'), planHint: $('plan-hint'), message: $('message'),
    toolbar: $('stage-toolbar'), exportBtn: $('export-btn'), stage: $('stage'),
    emptyState: $('empty-state'), loading: $('loading'),
    preview: $('preview'), original: $('original'), mosaicWrap: $('mosaic-wrap'),
    rowHighlight: $('row-highlight'), cellTip: $('cell-tip'), stats: $('stats'),
    resultGrid: $('result-grid'), partsBody: $('parts-body'),
    rowPrev: $('row-prev'), rowNext: $('row-next'), rowInput: $('row-input'), rowTotal: $('row-total'),
    rowStrip: $('row-strip'), runs: $('runs'),
  };

  const state = {
    custom: {},          // name -> [r, g, b]
    inventory: { ...CONFIG.inventory },
    file: null,
    fileUrl: null,
    aspect: null,        // image height / width
    locked: true,
    result: null,        // last /api/plan response + derived grid
    snapshot: null,      // inventory + custom palette used for the last plan
    view: 'mosaic',
    row: 0,
  };

  // ───────── Helpers ─────────
  const fmt = (n) => Number(n).toLocaleString();
  const palette = () => ({ ...BUILTIN, ...state.custom });
  const rgbCss = (rgb) => `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const prettyName = (name) => name.replace(/_/g, ' ');

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function swatch(rgb) {
    const s = document.createElement('span');
    s.className = 'swatch';
    s.style.background = rgbCss(rgb);
    return s;
  }

  function setMessage(text, kind = '') {
    els.message.className = `message ${kind}`;
    els.message.textContent = text;
  }

  function clampDim(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_DIM);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        inventory: state.inventory,
        custom: state.custom,
        width: els.width.value,
        height: els.height.value,
        locked: state.locked,
        showAll: els.showAll.checked,
      }));
    } catch (_) { /* storage unavailable — fine */ }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      if (saved.custom && typeof saved.custom === 'object') state.custom = saved.custom;
      if (saved.inventory && typeof saved.inventory === 'object') state.inventory = saved.inventory;
      if (saved.width) els.width.value = saved.width;
      if (saved.height) els.height.value = saved.height;
      if (typeof saved.locked === 'boolean') state.locked = saved.locked;
      els.showAll.checked = !!saved.showAll;
    } catch (_) { /* ignore corrupt storage */ }
  }

  // ───────── Image ─────────
  function loadFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setMessage('That file is not an image. Try a PNG or JPEG.', 'error');
      return;
    }
    if (state.fileUrl) URL.revokeObjectURL(state.fileUrl);
    state.file = file;
    state.fileUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      state.aspect = img.naturalHeight / img.naturalWidth;
      els.thumb.src = state.fileUrl;
      els.fileName.textContent = file.name;
      els.fileDims.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
      els.dropzone.querySelector('.dz-empty').hidden = true;
      els.dropzone.querySelector('.dz-loaded').hidden = false;
      if (state.locked) syncHeight();
      setMessage('');
      update();
    };
    img.onerror = () => setMessage('Could not read that image.', 'error');
    img.src = state.fileUrl;
  }

  els.image.addEventListener('change', () => loadFile(els.image.files[0]));
  ['dragenter', 'dragover'].forEach((t) => els.dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((t) => els.dropzone.addEventListener(t, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('dragging');
  }));
  els.dropzone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
  // Allow pasting an image straight from the clipboard.
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadFile(item.getAsFile());
  });

  // ───────── Size ─────────
  function syncHeight() {
    if (!state.aspect) return;
    els.height.value = clampDim(clampDim(els.width.value) * state.aspect);
  }
  function syncWidth() {
    if (!state.aspect) return;
    els.width.value = clampDim(clampDim(els.height.value) / state.aspect);
  }

  els.width.addEventListener('input', () => { if (state.locked) syncHeight(); update(); });
  els.height.addEventListener('input', () => { if (state.locked) syncWidth(); update(); });
  [els.width, els.height].forEach((input) => input.addEventListener('blur', () => {
    input.value = clampDim(input.value);
    update();
  }));

  els.lock.addEventListener('click', () => {
    state.locked = !state.locked;
    if (state.locked) syncHeight();
    update();
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => btn.addEventListener('click', () => {
    els.width.value = btn.dataset.preset;
    if (state.locked) syncHeight();
    update();
  }));

  // ───────── Inventory ─────────
  function renderInventory() {
    const pal = palette();
    const names = Object.keys(pal);
    const showAll = els.showAll.checked;
    els.inventoryList.textContent = '';

    let shown = 0;
    for (const name of names) {
      const count = Number(state.inventory[name] || 0);
      if (!showAll && count <= 0 && !(name in state.custom)) continue;
      shown += 1;

      const li = document.createElement('li');
      li.classList.toggle('zero', count <= 0);

      const label = document.createElement('span');
      label.className = 'color-name';
      label.textContent = prettyName(name);
      label.title = `${name} · rgb(${pal[name].join(', ')})`;

      const extra = document.createElement('span');
      if (name in state.custom) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'custom';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-btn';
        remove.setAttribute('aria-label', `Remove ${prettyName(name)}`);
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
          delete state.custom[name];
          if (!(name in BUILTIN)) delete state.inventory[name];
          renderInventory();
          update();
        });
        extra.append(badge, remove);
      }

      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.value = count;
      input.dataset.name = name;
      input.setAttribute('aria-label', `${prettyName(name)} count`);
      input.addEventListener('input', () => {
        const n = Math.max(0, Math.floor(Number(input.value) || 0));
        state.inventory[name] = n;
        li.classList.toggle('zero', n <= 0);
        update();
      });

      li.append(swatch(pal[name]), label, extra, input);
      els.inventoryList.appendChild(li);
    }
    els.inventoryList.hidden = shown === 0;
    els.inventoryEmpty.hidden = shown !== 0;
  }

  els.showAll.addEventListener('change', () => { renderInventory(); save(); });

  els.setAllBtn.addEventListener('click', () => {
    const raw = els.setAllValue.value.trim();
    if (raw === '') { els.setAllValue.focus(); return; }
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    els.inventoryList.querySelectorAll('input[data-name]').forEach((input) => {
      state.inventory[input.dataset.name] = n;
    });
    renderInventory();
    update();
  });

  els.customForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.customName.value.trim().toLowerCase().replace(/\s+/g, '_');
    if (!name) {
      setMessage('Give your custom color a name.', 'error');
      els.customName.focus();
      return;
    }
    const existed = name in palette();
    state.custom[name] = hexToRgb(els.customColor.value);
    if (!(name in state.inventory)) state.inventory[name] = 0;
    els.customName.value = '';
    renderInventory();
    update();
    setMessage(existed ? `Updated “${prettyName(name)}”.` : `Added “${prettyName(name)}”. Enter how many you have.`, 'success');
    const input = els.inventoryList.querySelector(`input[data-name="${CSS.escape(name)}"]`);
    if (input) { input.focus(); input.select(); }
  });

  // JSON import / export
  function currentJson() {
    const inventory = Object.fromEntries(Object.entries(state.inventory).filter(([, c]) => Number(c) > 0));
    const body = Object.keys(state.custom).length ? { inventory, custom_palette: state.custom } : inventory;
    return JSON.stringify(body, null, 2);
  }

  els.jsonDetails.addEventListener('toggle', () => {
    if (els.jsonDetails.open) els.jsonBox.value = currentJson();
  });

  els.jsonApply.addEventListener('click', () => {
    try {
      const parsed = JSON.parse(els.jsonBox.value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON must be an object.');
      const isFull = parsed.inventory && typeof parsed.inventory === 'object';
      const inventory = isFull ? parsed.inventory : parsed;
      const custom = isFull && parsed.custom_palette ? parsed.custom_palette : {};

      for (const [name, rgb] of Object.entries(custom)) {
        if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
          throw new Error(`Custom color “${name}” must be [r, g, b] with values 0–255.`);
        }
      }
      const pal = { ...BUILTIN, ...custom };
      for (const [name, count] of Object.entries(inventory)) {
        if (!(name in pal)) throw new Error(`Unknown color “${name}”. Add it as a custom color first.`);
        if (!Number.isFinite(Number(count)) || Number(count) < 0) throw new Error(`Count for “${name}” must be 0 or more.`);
      }

      state.custom = custom;
      state.inventory = Object.fromEntries(Object.entries(inventory).map(([k, v]) => [k, Math.floor(Number(v))]));
      renderInventory();
      update();
      els.jsonBox.value = currentJson();
      setMessage('Inventory updated from JSON.', 'success');
    } catch (err) {
      setMessage(err instanceof SyntaxError ? `Invalid JSON: ${err.message}` : err.message, 'error');
    }
  });

  els.jsonCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.jsonBox.value);
      setMessage('Copied to clipboard.', 'success');
    } catch (_) {
      els.jsonBox.select();
      setMessage('Press Ctrl+C to copy.', '');
    }
  });

  els.reset.addEventListener('click', () => {
    if (!confirm('Reset your inventory and custom colors to the defaults?')) return;
    state.inventory = { ...CONFIG.inventory };
    state.custom = {};
    renderInventory();
    update();
    els.jsonBox.value = currentJson();
    setMessage('Inventory reset.', 'success');
  });

  // ───────── Meter + general refresh ─────────
  function update() {
    const w = clampDim(els.width.value);
    const h = clampDim(els.height.value);
    const needed = w * h;
    const available = Object.entries(state.inventory)
      .filter(([name]) => name in palette())
      .reduce((sum, [, c]) => sum + Math.max(0, Number(c) || 0), 0);

    els.lock.setAttribute('aria-pressed', String(state.locked));
    const cm = CONFIG.studSizeCm;
    els.sizeInfo.textContent = `${fmt(needed)} bricks · about ${(w * cm).toFixed(1)} × ${(h * cm).toFixed(1)} cm`;
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', Number(b.dataset.preset) === w));

    const short = available < needed;
    els.meter.classList.toggle('short', short);
    els.meter.classList.toggle('ok', !short);
    els.meterLabel.textContent = short ? `Short by ${fmt(needed - available)} bricks` : 'Enough bricks';
    els.meterNumbers.textContent = `${fmt(needed)} needed / ${fmt(available)} owned`;
    els.meterFill.style.width = `${Math.min(100, available ? (needed / available) * 100 : 100)}%`;

    els.planBtn.disabled = !state.file || short;
    els.planHint.textContent = !state.file ? 'Choose an image in step 1 to get started.'
      : short ? 'Add more bricks in step 3 or make the mosaic smaller.' : '';
    save();
  }

  // ───────── Generate ─────────
  els.planBtn.addEventListener('click', async () => {
    if (!state.file) return;
    setMessage('');
    els.planBtn.disabled = true;
    els.loading.hidden = false;

    const inventory = Object.fromEntries(
      Object.entries(state.inventory).filter(([name, c]) => Number(c) > 0 && name in palette()),
    );
    const custom = { ...state.custom };

    try {
      const fd = new FormData();
      fd.append('image', state.file);
      fd.append('width', clampDim(els.width.value));
      fd.append('height', clampDim(els.height.value));
      fd.append('inventory', JSON.stringify(inventory));
      fd.append('custom_palette', JSON.stringify(custom));

      const res = await fetch('/api/plan', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to generate the mosaic.');

      data.grid = Array.from({ length: data.height }, () => new Array(data.width));
      for (const a of data.assignments) data.grid[a.y][a.x] = a.assigned_color;

      state.result = data;
      state.snapshot = { inventory, custom };
      state.row = 0;
      showResult();
      setMessage(`Mosaic ready: ${fmt(data.width * data.height)} bricks placed.`, 'success');
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      els.loading.hidden = true;
      update();
    }
  });

  function showResult() {
    const r = state.result;
    els.preview.src = `data:image/png;base64,${r.preview_base64}`;
    els.original.src = state.fileUrl;
    els.original.style.aspectRatio = `${r.width} / ${r.height}`;
    els.emptyState.hidden = true;
    els.toolbar.hidden = false;
    els.stats.hidden = false;
    els.resultGrid.hidden = false;
    setView(state.view);
    renderStats();
    renderParts();
    renderRow();
  }

  function renderStats() {
    const r = state.result;
    const used = r.summary.filter((s) => s.used > 0).length;
    const avg = r.assignments.reduce((s, a) => s + a.distance, 0) / r.assignments.length;
    const quality = avg < 40 ? 'Excellent' : avg < 80 ? 'Good' : avg < 140 ? 'Fair' : 'Rough';
    const cm = CONFIG.studSizeCm;
    const items = [
      ['Size', `${r.width} × ${r.height}`],
      ['Bricks', fmt(r.width * r.height)],
      ['Colors used', `${used} / ${r.summary.length}`],
      ['Physical size', `${(r.width * cm).toFixed(0)} × ${(r.height * cm).toFixed(0)} cm`],
      ['Color match', quality],
    ];
    els.stats.textContent = '';
    for (const [k, v] of items) {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v;
      div.append(dt, dd);
      els.stats.appendChild(div);
    }
  }

  function renderParts() {
    const r = state.result;
    const rows = [...r.summary].sort((a, b) => b.used - a.used);
    els.partsBody.textContent = '';
    for (const row of rows) {
      const rgb = r.palette[row.color];
      const tr = document.createElement('tr');
      if (row.used === 0) tr.className = 'unused';

      const nameTd = document.createElement('td');
      const nameWrap = document.createElement('div');
      nameWrap.className = 'name-cell';
      const label = document.createElement('span');
      label.textContent = prettyName(row.color);
      nameWrap.append(swatch(rgb), label);
      nameTd.appendChild(nameWrap);

      const usageTd = document.createElement('td');
      const usage = document.createElement('div');
      usage.className = 'usage';
      const text = document.createElement('span');
      text.append(document.createTextNode(fmt(row.used)));
      const of = document.createElement('small');
      of.textContent = ` of ${fmt(row.available)}`;
      text.appendChild(of);
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${row.available ? (row.used / row.available) * 100 : 0}%`;
      fill.style.background = rgbCss(rgb);
      bar.appendChild(fill);
      usage.append(text, bar);
      usageTd.appendChild(usage);

      const leftTd = document.createElement('td');
      leftTd.className = 'num';
      leftTd.textContent = fmt(row.remaining);

      tr.append(nameTd, usageTd, leftTd);
      els.partsBody.appendChild(tr);
    }
  }

  // ───────── Build guide ─────────
  function renderRow() {
    const r = state.result;
    if (!r) return;
    const y = state.row;
    const row = r.grid[y];

    els.rowInput.max = r.height;
    els.rowInput.value = y + 1;
    els.rowTotal.textContent = `of ${r.height}`;
    els.rowPrev.disabled = y === 0;
    els.rowNext.disabled = y === r.height - 1;

    els.rowStrip.style.gridTemplateColumns = `repeat(${r.width}, minmax(0, 1fr))`;
    els.rowStrip.textContent = '';
    for (const color of row) {
      const cell = document.createElement('span');
      cell.style.background = rgbCss(r.palette[color]);
      cell.title = prettyName(color);
      els.rowStrip.appendChild(cell);
    }

    els.runs.textContent = '';
    let start = 0;
    while (start < row.length) {
      let end = start;
      while (end + 1 < row.length && row[end + 1] === row[start]) end += 1;
      const li = document.createElement('li');
      const b = document.createElement('b');
      b.textContent = `${end - start + 1}×`;
      const label = document.createElement('span');
      label.textContent = prettyName(row[start]);
      li.title = start === end ? `Column ${start + 1}` : `Columns ${start + 1}–${end + 1}`;
      li.append(swatch(r.palette[row[start]]), b, label);
      els.runs.appendChild(li);
      start = end + 1;
    }

    els.rowHighlight.hidden = false;
    els.rowHighlight.style.top = `calc(${(y / r.height) * 100}% - 2px)`;
    els.rowHighlight.style.height = `calc(${100 / r.height}% + 4px)`;
  }

  function goToRow(y) {
    if (!state.result) return;
    state.row = Math.max(0, Math.min(state.result.height - 1, y));
    renderRow();
  }

  els.rowPrev.addEventListener('click', () => goToRow(state.row - 1));
  els.rowNext.addEventListener('click', () => goToRow(state.row + 1));
  els.rowInput.addEventListener('change', () => goToRow(Number(els.rowInput.value) - 1));
  document.addEventListener('keydown', (e) => {
    if (!state.result || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { goToRow(state.row + 1); e.preventDefault(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { goToRow(state.row - 1); e.preventDefault(); }
  });

  // Hover tooltip + click-to-select row on the mosaic.
  function cellAt(e) {
    const r = state.result;
    const rect = els.preview.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * r.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * r.height);
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
    return { x, y, rect };
  }

  els.preview.addEventListener('mousemove', (e) => {
    if (!state.result) return;
    const cell = cellAt(e);
    if (!cell) { els.cellTip.hidden = true; return; }
    const color = state.result.grid[cell.y][cell.x];
    els.cellTip.textContent = '';
    const text = document.createElement('span');
    text.textContent = `Row ${cell.y + 1}, col ${cell.x + 1} · ${prettyName(color)}`;
    els.cellTip.append(swatch(state.result.palette[color]), text);
    els.cellTip.style.left = `${e.clientX - cell.rect.left}px`;
    els.cellTip.style.top = `${e.clientY - cell.rect.top}px`;
    els.cellTip.hidden = false;
  });
  els.preview.addEventListener('mouseleave', () => { els.cellTip.hidden = true; });
  els.preview.addEventListener('click', (e) => {
    const cell = state.result && cellAt(e);
    if (cell) goToRow(cell.y);
  });

  // ───────── View switcher ─────────
  function setView(view) {
    state.view = view;
    els.stage.dataset.view = view;
    document.querySelectorAll('.segmented [data-view]').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.view === view));
    });
    if (!state.result) return;
    els.stage.querySelector('.view-mosaic').hidden = view === 'original';
    els.stage.querySelector('.view-original').hidden = view === 'mosaic';
  }
  document.querySelectorAll('.segmented [data-view]').forEach((b) => {
    b.addEventListener('click', () => setView(b.dataset.view));
  });

  // ───────── Export ─────────
  els.exportBtn.addEventListener('click', async () => {
    if (!state.result || !state.snapshot) return;
    els.exportBtn.disabled = true;
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          width: state.result.width,
          height: state.result.height,
          assignments: state.result.assignments,
          inventory: state.snapshot.inventory,
          custom_palette: state.snapshot.custom,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Export failed.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'lego_mosaic_plan.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('Build files downloaded.', 'success');
    } catch (err) {
      setMessage(err.message, 'error');
    } finally {
      els.exportBtn.disabled = false;
    }
  });

  // ───────── Init ─────────
  els.width.max = MAX_DIM;
  els.height.max = MAX_DIM;
  restore();
  renderInventory();
  update();
})();
