(function () {
  'use strict';
  const X = window.Xscan;
  const $ = (id) => document.getElementById(id);

  const S = {
    vol: null, stats: null, tLo: 0, tHi: 1, isHU: false,
    cur: [0, 0, 0], win: [0, 1], slab: 1, slabMode: 'avg', invert: false, crosshair: true, tool: 'pointer',
    series: [], mode: 2, thr: 0.5
  };

  /* ---------- helpers ---------- */
  const fmt = (v) => (Math.abs(v) >= 100 || Number.isInteger(v) ? Math.round(v).toString() : v.toFixed(2));
  const norm = (v) => (v - S.tLo) / Math.max(S.tHi - S.tLo, 1e-9);
  const raf = (() => { let q = new Set(), p = false; return (fn) => { q.add(fn); if (!p) { p = true; requestAnimationFrame(() => { p = false; const f = [...q]; q.clear(); f.forEach((x) => x()); }); } }; })();

  let renderer = null;
  try { renderer = new X.Renderer($('cv3d')); } catch (e) { console.warn(e); }
  const views = {};
  const handlers = {
    getState: () => S,
    getTool: () => S.tool,
    getCursor: () => S.cur,
    onPick(name, ih, iv) {
      const d = X.SLICE_DEFS[name];
      S.cur[d.h] = ih; S.cur[d.v] = iv;
      refreshSlices(name);
    },
    onScroll(name, dir) {
      const d = X.SLICE_DEFS[name];
      const n = S.vol.dims[d.n];
      S.cur[d.n] = Math.max(0, Math.min(n - 1, S.cur[d.n] + dir));
      refreshSlices();
    },
    onHover(name, idx) {
      if (!S.vol) return;
      if (!idx) { $('status').innerHTML = '&nbsp;'; return; }
      const d = X.SLICE_DEFS[name];
      const p = S.cur.slice(); p[d.h] = idx[0]; p[d.v] = idx[1];
      const [nx, ny] = S.vol.dims, sp = S.vol.spacing;
      const val = S.vol.data[(p[2] * ny + p[1]) * nx + p[0]];
      const unit = S.isHU ? ' HU' : '';
      $('status').textContent = `${name}  ·  voxel (${p[0]}, ${p[1]}, ${p[2]})  ·  ${(p[0] * sp[0]).toFixed(1)}, ${(p[1] * sp[1]).toFixed(1)}, ${(p[2] * sp[2]).toFixed(1)} mm  ·  value ${fmt(val)}${unit}`;
    }
  };
  [['axial', 'cvAxial'], ['coronal', 'cvCoronal'], ['sagittal', 'cvSagittal']].forEach(([n, id]) => { views[n] = new X.SliceView($(id), n, handlers); });

  /* ---------- busy / errors ---------- */
  function busy(msg, p) {
    $('busy').hidden = false;
    $('busyMsg').textContent = msg;
    $('busyBar').style.width = (p == null ? 8 : Math.round(p * 100)) + '%';
  }
  const unbusy = () => ($('busy').hidden = true);
  function fail(err) {
    console.error(err);
    unbusy();
    $('scanInfo').innerHTML = '';
    const m = document.createElement('div');
    m.className = 'error';
    m.textContent = err && err.message ? err.message : String(err);
    $('scanInfo').appendChild(m);
    $('grpScan').open = true;
    if (!S.vol) $('empty').hidden = false;
    alert(m.textContent);
  }

  /* ---------- loading ---------- */
  async function loadFiles(files) {
    if (!files || !files.length) return;
    busy('Reading files…');
    try {
      const series = await X.scanFiles(files, (m) => busy(m));
      if (!series.length) throw new Error('No readable scan found in those files. Supported: DICOM (.dcm or extension-less), NIfTI (.nii/.nii.gz), zips of those, and PNG/JPG images.');
      S.series = series;
      const sel = $('seriesSel');
      sel.innerHTML = '';
      series.forEach((s, i) => {
        const o = document.createElement('option');
        o.value = i;
        const size = s.rows ? ` ${s.cols}×${s.rows}` : '';
        o.textContent = `${s.title || 'Series'} — ${s.count ? s.count + ' slices' : s.modality}${size}`;
        sel.appendChild(o);
      });
      $('seriesRow').hidden = series.length < 2;
      await openSeries(0);
    } catch (e) { fail(e); }
  }

  async function openSeries(i) {
    busy('Building volume…', 0);
    await new Promise((r) => setTimeout(r, 20));
    try {
      const vol = await S.series[i].build((p, m) => busy(m, p));
      await setVolume(vol);
      $('seriesSel').value = i;
    } catch (e) { fail(e); return; }
    unbusy();
  }

  async function setVolume(vol) {
    busy('Analysing…', 0.9);
    await new Promise((r) => setTimeout(r, 10));
    S.vol = vol;
    S.stats = X.computeStats(vol);
    const st = S.stats;
    S.tLo = st.pct(0.002);
    S.tHi = st.pct(0.9996);
    if (S.tHi - S.tLo < 1e-6) { S.tLo = st.min; S.tHi = st.max > st.min ? st.max : st.min + 1; }
    S.isHU = !!vol.calibrated && st.min < -300;
    const [nx, ny, nz] = vol.dims;
    S.cur = [nx >> 1, ny >> 1, nz >> 1];
    const is2d = nz === 1;
    document.body.classList.toggle('is2d', is2d);
    $('grid').classList.remove('max');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('maxed'));

    // sliders
    for (const id of ['rThr']) { $(id).min = S.tLo; $(id).max = S.tHi; }
    $('rLvl').min = S.tLo; $('rLvl').max = S.tHi;
    $('rWid').min = Math.max((S.tHi - S.tLo) / 400, 1e-6); $('rWid').max = (S.tHi - S.tLo) * 1.5;
    $('rSlab').max = Math.max(1, Math.min(120, Math.floor(Math.max(nx, ny, nz) / 3)));
    $('rSlab').value = 1; S.slab = 1; $('oSlab').textContent = '1 slice';
    const dims = [nx, ny, nz];
    for (const [name, d] of Object.entries(X.SLICE_DEFS)) {
      const el = $('sl' + name[0].toUpperCase() + name.slice(1));
      el.min = 0; el.max = dims[d.n] - 1;
    }

    // views
    for (const v of Object.values(views)) v.setVolume(vol);
    applyWindowPreset('auto', true);

    // 3D
    if (!is2d && renderer) {
      busy('Preparing 3D…', 0.95);
      await new Promise((r) => setTimeout(r, 10));
      const rv = X.makeRenderVolume(vol, S.tLo, S.tHi, 30e6);
      try {
        renderer.setVolume(rv, vol);
      } catch (e) { console.warn(e); }
      resetCrop();
      applySurfPreset('bone', true);
      setMode(2, true);
    } else if (!is2d && !renderer) {
      $('hint3d').textContent = 'WebGL2 not available - 3D view disabled';
    }

    // info
    const i = vol.info || {};
    const sp = vol.spacing;
    $('scanInfo').textContent =
      `${i.title || 'Scan'}\n${nx} × ${ny} × ${nz} voxels\nVoxel ${sp.map((s) => +s.toFixed(3)).join(' × ')} mm\n` +
      `Size ${(nx * sp[0]).toFixed(0)} × ${(ny * sp[1]).toFixed(0)} × ${(nz * sp[2]).toFixed(0)} mm` +
      (i.studyDesc ? `\n${i.studyDesc}` : '') + (i.studyDate ? `  ${i.studyDate}` : '');
    $('scanInfo').classList.remove('muted');
    const note = $('scanNote');
    note.hidden = !i.note;
    note.textContent = i.note || '';

    $('empty').hidden = true;
    $('btnShot').disabled = is2d || !renderer;
    refreshSlices();
    requestAnimationFrame(() => { refreshSlices(); renderer && renderer.invalidate(); });
  }

  /* ---------- window / slices ---------- */
  function setWin(lo, hi, fromPreset) {
    if (hi - lo < (S.tHi - S.tLo) / 400) hi = lo + (S.tHi - S.tLo) / 400;
    S.win = [lo, hi];
    const level = (lo + hi) / 2, width = hi - lo;
    $('rLvl').value = level; $('rWid').value = width;
    $('oLvl').textContent = fmt(level); $('oWid').textContent = fmt(width);
    if (!fromPreset) $('winPreset').value = '';
    if (renderer) { renderer.params.win = [norm(lo), norm(hi)]; renderer.invalidate(); }
    refreshSlices();
  }

  function applyWindowPreset(name, silent) {
    const st = S.stats, R = S.tHi - S.tLo, lo = S.tLo;
    let w;
    if (name === 'auto') w = [st.pct(0.4), st.pct(0.999)];
    else if (name === 'wide') w = [S.tLo, S.tHi];
    else if (S.isHU) w = { bone: [0, 2200], teeth: [600, 3000], soft: [-160, 240] }[name];
    else w = { bone: [lo + 0.25 * R, lo + 0.9 * R], teeth: [lo + 0.5 * R, S.tHi], soft: [lo, lo + 0.5 * R] }[name];
    if (w[1] - w[0] < R / 400) w = [S.tLo, S.tHi];
    $('winPreset').value = name;
    setWin(w[0], w[1], true);
  }

  let rafPending = false;
  function refreshSlices(except) {
    if (!S.vol) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const dims = S.vol.dims;
      for (const [name, v] of Object.entries(views)) {
        if (document.body.classList.contains('is2d') && name !== 'axial') continue;
        v.render();
        const d = X.SLICE_DEFS[name], cap = name[0].toUpperCase() + name.slice(1);
        $('sl' + cap).value = S.cur[d.n];
        $('lbl' + cap).textContent = dims[d.n] > 1 ? `${S.cur[d.n] + 1} / ${dims[d.n]}` : '';
      }
    });
  }

  /* ---------- 3D controls ---------- */
  function setMode(m, silent) {
    S.mode = m;
    document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.mode === m));
    document.querySelectorAll('[data-modes]').forEach((el) => {
      el.hidden = !el.dataset.modes.split(' ').includes(String(m));
    });
    if (renderer) { renderer.params.mode = m; renderer.invalidate(); }
  }

  function setThr(v) {
    S.thr = v;
    $('rThr').value = v; $('oThr').textContent = fmt(v) + (S.isHU ? ' HU' : '');
    if (renderer) { renderer.params.thr = norm(v); renderer.invalidate(); }
  }

  function applySurfPreset(name) {
    const R = S.tHi - S.tLo;
    const t = S.isHU ? { skin: -300, bone: 300, teeth: 1500 } : { skin: S.tLo + 0.2 * R, bone: S.tLo + 0.45 * R, teeth: S.tLo + 0.7 * R };
    $('surfPreset').value = name;
    setThr(Math.min(S.tHi, Math.max(S.tLo, t[name])));
  }

  function resetCrop() {
    document.querySelectorAll('#cropBox input').forEach((el) => (el.value = el.dataset.end === 'hi' ? 1000 : 0));
    syncCrop();
  }
  function syncCrop() {
    if (!renderer) return;
    const lo = [0, 0, 0], hi = [1, 1, 1];
    document.querySelectorAll('#cropBox input').forEach((el) => {
      const a = +el.dataset.axis, v = el.value / 1000;
      if (el.dataset.end === 'lo') lo[a] = v; else hi[a] = v;
    });
    for (let a = 0; a < 3; a++) if (lo[a] > hi[a] - 0.01) lo[a] = Math.max(0, hi[a] - 0.01);
    renderer.params.clipLo = lo; renderer.params.clipHi = hi;
    renderer.invalidate();
  }
  (function buildCrop() {
    const box = $('cropBox');
    ['X (left–right)', 'Y (front–back)', 'Z (bottom–top)'].forEach((label, a) => {
      const l = document.createElement('span'); l.textContent = 'XYZ'[a]; l.title = label;
      const dual = document.createElement('div'); dual.className = 'dual';
      ['lo', 'hi'].forEach((end) => {
        const r = document.createElement('input');
        r.type = 'range'; r.min = 0; r.max = 1000; r.value = end === 'hi' ? 1000 : 0;
        r.dataset.axis = a; r.dataset.end = end; r.setAttribute('aria-label', `Crop ${label} ${end === 'lo' ? 'start' : 'end'}`);
        r.addEventListener('input', syncCrop);
        dual.appendChild(r);
      });
      box.appendChild(l); box.appendChild(dual);
    });
  })();

  /* ---------- 3D pointer interaction ---------- */
  (function bind3d() {
    const cv = $('cv3d'), ptrs = new Map();
    let lastPinch = 0;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (!renderer) return;
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.button === 1 || e.shiftKey });
      renderer.interacting = true;
      if (ptrs.size === 2) lastPinch = pinchDist();
    });
    const pinchDist = () => { const p = [...ptrs.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
    cv.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p || !renderer) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1) {
        if (p.pan) renderer.pan(dx, dy); else renderer.rotate(dx, dy);
      } else if (ptrs.size === 2) {
        const d = pinchDist();
        if (lastPinch) renderer.zoom(lastPinch / d);
        lastPinch = d;
        renderer.pan(dx / 2, dy / 2);
      }
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (!ptrs.size && renderer) { renderer.interacting = false; renderer.invalidate(); }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      if (!renderer) return;
      e.preventDefault();
      renderer.interacting = true;
      renderer.zoom(Math.exp(e.deltaY * 0.0012));
      clearTimeout(cv._wt);
      cv._wt = setTimeout(() => { renderer.interacting = false; renderer.invalidate(); }, 160);
    }, { passive: false });
    cv.addEventListener('dblclick', () => renderer && renderer.resetCamera());
  })();

  /* ---------- UI wiring ---------- */
  const on = (id, ev, fn) => $(id).addEventListener(ev, fn);

  document.querySelectorAll('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(+b.dataset.mode)));
  on('surfPreset', 'change', (e) => applySurfPreset(e.target.value));
  on('rThr', 'input', (e) => setThr(+e.target.value));
  on('rOpa', 'input', (e) => { $('oOpa').textContent = (+e.target.value).toFixed(2); if (renderer) { renderer.params.opacity = +e.target.value; renderer.invalidate(); } });
  on('rBri', 'input', (e) => { $('oBri').textContent = (+e.target.value).toFixed(2); if (renderer) { renderer.params.bright = +e.target.value; renderer.invalidate(); } });
  on('cInv3d', 'change', (e) => { if (renderer) { renderer.params.invert = e.target.checked ? 1 : 0; renderer.invalidate(); } });
  on('cGrey', 'change', (e) => { if (renderer) { renderer.params.grey = e.target.checked ? 1 : 0; renderer.invalidate(); } });
  on('qual', 'change', (e) => { if (renderer) { renderer.params.quality = +e.target.value; renderer.invalidate(); } });
  document.querySelectorAll('.viewbtns button').forEach((b) => b.addEventListener('click', () => renderer && renderer.setView(b.dataset.view)));
  on('btnCropReset', 'click', resetCrop);
  $('oOpa').textContent = '0.90'; $('oBri').textContent = '1.00';

  on('winPreset', 'change', (e) => e.target.value && S.vol && applyWindowPreset(e.target.value));
  const levelWidth = () => { const l = +$('rLvl').value, w = +$('rWid').value; setWin(l - w / 2, l + w / 2); };
  on('rLvl', 'input', levelWidth);
  on('rWid', 'input', levelWidth);
  on('rSlab', 'input', (e) => {
    S.slab = +e.target.value | 1; // keep odd
    if (S.slab % 2 === 0) S.slab += 1;
    const mm = S.slab * Math.min(...S.vol.spacing);
    $('oSlab').textContent = S.slab === 1 ? '1 slice' : `${S.slab} slices (~${mm.toFixed(1)} mm)`;
    refreshSlices();
  });
  on('slabMode', 'change', (e) => { S.slabMode = e.target.value; refreshSlices(); });
  on('cInvImg', 'change', (e) => { S.invert = e.target.checked; refreshSlices(); });
  on('cCross', 'change', (e) => { S.crosshair = e.target.checked; refreshSlices(); });
  document.querySelectorAll('#toolSeg button').forEach((b) => b.addEventListener('click', () => {
    S.tool = b.dataset.tool;
    document.querySelectorAll('#toolSeg button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pb canvas').forEach((c) => { if (c.id !== 'cv3d') c.style.cursor = S.tool === 'ruler' ? 'crosshair' : ''; });
  }));
  on('btnClearRuler', 'click', () => { Object.values(views).forEach((v) => { v.measures = []; v.pending = null; v.draw(); }); });

  for (const name of Object.keys(views)) {
    const cap = name[0].toUpperCase() + name.slice(1);
    on('sl' + cap, 'input', (e) => { S.cur[X.SLICE_DEFS[name].n] = +e.target.value; refreshSlices(); });
  }

  document.querySelectorAll('.panel .mx, .panel .ph').forEach((el) => {
    const evt = el.classList.contains('mx') ? 'click' : 'dblclick';
    el.addEventListener(evt, (e) => {
      if (e.target.tagName === 'INPUT') return;
      const panel = el.closest('.panel');
      const grid = $('grid');
      const maxed = !panel.classList.contains('maxed');
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('maxed'));
      grid.classList.toggle('max', maxed);
      if (maxed) panel.classList.add('maxed');
      requestAnimationFrame(() => { refreshSlices(); renderer && renderer.invalidate(); });
    });
  });

  // file opening
  const pick = (input) => () => input.click();
  on('btnFiles', 'click', pick($('fileInput'))); on('btnFiles2', 'click', pick($('fileInput')));
  on('btnFolder', 'click', pick($('folderInput'))); on('btnFolder2', 'click', pick($('folderInput')));
  for (const id of ['fileInput', 'folderInput']) {
    on(id, 'change', (e) => { const f = [...e.target.files]; e.target.value = ''; loadFiles(f); });
  }
  const demo = async () => {
    busy('Generating demo jaw…', 0.2);
    await new Promise((r) => setTimeout(r, 30));
    S.series = [];
    $('seriesRow').hidden = true;
    try { await setVolume(X.makePhantom()); } catch (e) { fail(e); return; }
    unbusy();
  };
  on('btnDemo', 'click', demo); on('btnDemo2', 'click', demo);
  on('btnHelp', 'click', () => $('dlgHelp').showModal());
  on('seriesSel', 'change', (e) => openSeries(+e.target.value));
  on('btnShot', 'click', async () => {
    if (!renderer) return;
    const blob = await renderer.snapshot();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xscan-3d.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  // drag & drop (files or whole folders)
  async function filesFromDrop(dt) {
    const items = [...(dt.items || [])].filter((i) => i.kind === 'file');
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return [...dt.files];
    const out = [];
    const walk = async (e) => {
      if (e.isFile) {
        const f = await new Promise((res, rej) => e.file(res, rej));
        out.push({ name: e.fullPath.replace(/^\//, ''), size: f.size, read: () => f.arrayBuffer() });
      } else if (e.isDirectory) {
        const r = e.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => r.readEntries(res, rej));
          for (const c of batch) await walk(c);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e);
    return out;
  }
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0; $('drop').hidden = true;
    busy('Reading dropped files…');
    try { loadFiles(await filesFromDrop(e.dataTransfer)); } catch (err) { fail(err); }
  });

  window.addEventListener('resize', () => { refreshSlices(); renderer && renderer.invalidate(); });
  if (window.ResizeObserver) new ResizeObserver(() => { refreshSlices(); renderer && renderer.invalidate(); }).observe($('grid'));

  if (!renderer) {
    $('hint3d').textContent = 'WebGL2 not available - 3D view disabled';
  }
  window.Xscan.app = { S, loadFiles, setVolume, renderer, views };
})();
