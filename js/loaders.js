/* File loaders: DICOM (single/multi-frame, folders, zips), NIfTI (.nii/.nii.gz) and plain images.
 * Everything runs locally in the browser - nothing is uploaded. */
(function (global) {
  'use strict';
  const X = (global.Xscan = global.Xscan || {});

  const SKIP_EXT = new Set(['exe', 'dll', 'txt', 'xml', 'html', 'htm', 'js', 'css', 'ini', 'inf', 'db',
    'pdf', 'json', 'md', 'log', 'dat', 'bin', 'so', 'dylib', 'app', 'lnk', 'url', 'ds_store', 'rtf', 'doc', 'docx']);
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif']);

  const TS = {
    IMPLICIT_LE: '1.2.840.10008.1.2',
    EXPLICIT_LE: '1.2.840.10008.1.2.1',
    DEFLATED: '1.2.840.10008.1.2.1.99',
    EXPLICIT_BE: '1.2.840.10008.1.2.2',
    JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
    JPEG_LOSSLESS: '1.2.840.10008.1.2.4.70',
    JPEG_LOSSLESS_P14: '1.2.840.10008.1.2.4.57'
  };

  const tick = () => new Promise((r) => setTimeout(r, 0));
  const extOf = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  };
  const baseName = (n) => n.split('/').pop();

  /* ---------- entries: {name, size, read(): Promise<ArrayBuffer>} ---------- */

  function fileEntry(file) {
    return {
      name: file.webkitRelativePath || file.name,
      size: file.size,
      read: () => file.arrayBuffer()
    };
  }

  async function expandZip(entry) {
    const buf = new Uint8Array(await entry.read());
    const files = global.fflate.unzipSync(buf);
    const out = [];
    for (const path of Object.keys(files)) {
      if (path.endsWith('/')) continue;
      const bytes = files[path];
      out.push({
        name: entry.name + '/' + path,
        size: bytes.length,
        read: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      });
    }
    return out;
  }

  /* ---------- DICOM ---------- */

  function num(ds, tag, def) {
    try {
      const v = ds.floatString(tag);
      return Number.isFinite(v) ? v : def;
    } catch (e) { return def; }
  }
  function nums(ds, tag, n) {
    try {
      const out = [];
      for (let i = 0; i < n; i++) {
        const v = ds.floatString(tag, i);
        if (!Number.isFinite(v)) return null;
        out.push(v);
      }
      return out;
    } catch (e) { return null; }
  }
  function str(ds, tag, def) {
    try { const s = ds.string(tag); return s === undefined ? def : s; } catch (e) { return def; }
  }

  /** Parse a buffer as DICOM. Returns a record, or null when it is not an image DICOM. */
  function parseDicom(buffer, name) {
    if (buffer.byteLength < 140) return null;
    const bytes = new Uint8Array(buffer);
    let ds;
    try {
      ds = global.dicomParser.parseDicom(bytes);
    } catch (e) {
      // Deflated transfer syntax needs inflating the dataset first.
      try {
        const meta = global.dicomParser.parseDicom(bytes, { untilTag: 'x00020010' });
        if (meta.string('x00020010') !== TS.DEFLATED) return null;
        const inflated = global.fflate.inflateSync(bytes.subarray(meta.position));
        const merged = new Uint8Array(meta.position + inflated.length);
        merged.set(bytes.subarray(0, meta.position));
        merged.set(inflated, meta.position);
        ds = global.dicomParser.parseDicom(merged);
        buffer = merged.buffer;
      } catch (e2) { return null; }
    }
    const px = ds.elements.x7fe00010;
    const rows = ds.uint16('x00280010');
    const cols = ds.uint16('x00280011');
    if (!px || !rows || !cols) return null;

    const rec = {
      name,
      ds,
      buffer: ds.byteArray.buffer,
      byteOffset: ds.byteArray.byteOffset,
      pixel: px,
      ts: str(ds, 'x00020010', TS.IMPLICIT_LE),
      rows, cols,
      bitsAllocated: ds.uint16('x00280100') || 16,
      pixelRep: ds.uint16('x00280103') || 0,
      spp: ds.uint16('x00280002') || 1,
      photometric: str(ds, 'x00280004', 'MONOCHROME2'),
      frames: parseInt(str(ds, 'x00280008', '1'), 10) || 1,
      slope: num(ds, 'x00281053', 1),
      intercept: num(ds, 'x00281052', 0),
      pixelSpacing: nums(ds, 'x00280030', 2) || nums(ds, 'x00181164', 2),
      sliceThickness: num(ds, 'x00180050', 0),
      spacingBetween: num(ds, 'x00180088', 0),
      ipp: nums(ds, 'x00200032', 3),
      iop: nums(ds, 'x00200037', 6),
      instance: parseInt(str(ds, 'x00200013', '0'), 10) || 0,
      seriesUID: str(ds, 'x0020000e', 'unknown'),
      seriesDesc: str(ds, 'x0008103e', ''),
      seriesNumber: str(ds, 'x00200011', ''),
      modality: str(ds, 'x00080060', ''),
      studyDesc: str(ds, 'x00081030', ''),
      studyDate: str(ds, 'x00080020', ''),
      frameIpp: null
    };

    // Enhanced multi-frame: pull per-frame positions / shared spacing out of the functional groups.
    if (rec.frames > 1) {
      try {
        const shared = ds.elements.x52009229;
        if (shared && shared.items && shared.items[0]) {
          const sds = shared.items[0].dataSet;
          const pm = sds.elements.x00289110;
          if (pm && pm.items && pm.items[0]) {
            const p = nums(pm.items[0].dataSet, 'x00280030', 2);
            if (p && !rec.pixelSpacing) rec.pixelSpacing = p;
            const t = num(pm.items[0].dataSet, 'x00180050', 0);
            if (t && !rec.sliceThickness) rec.sliceThickness = t;
          }
          const po = sds.elements.x00209116;
          if (po && po.items && po.items[0] && !rec.iop) rec.iop = nums(po.items[0].dataSet, 'x00200037', 6);
        }
        const per = ds.elements.x52009230;
        if (per && per.items && per.items.length === rec.frames) {
          const pos = [];
          for (const it of per.items) {
            const pp = it.dataSet.elements.x00209113;
            const v = pp && pp.items && pp.items[0] ? nums(pp.items[0].dataSet, 'x00200032', 3) : null;
            if (!v) { pos.length = 0; break; }
            pos.push(v);
          }
          if (pos.length === rec.frames) rec.frameIpp = pos;
        }
      } catch (e) { /* optional metadata */ }
    }
    return rec;
  }

  function unsupportedTransferSyntax(ts) {
    const names = {
      '1.2.840.10008.1.2.4.90': 'JPEG 2000', '1.2.840.10008.1.2.4.91': 'JPEG 2000',
      '1.2.840.10008.1.2.5': 'RLE', '1.2.840.10008.1.2.4.80': 'JPEG-LS', '1.2.840.10008.1.2.4.81': 'JPEG-LS'
    };
    return names[ts] || ts;
  }

  /** Bytes of one compressed frame from encapsulated pixel data (handles multi-fragment frames). */
  function encapsulatedFrame(rec, frame) {
    const el = rec.pixel;
    const frags = el.fragments || [];
    const bytes = rec.ds.byteArray;
    const part = (f) => bytes.subarray(f.position, f.position + f.length);
    let list;
    if (rec.frames === 1) list = frags;
    else if (frags.length === rec.frames) list = [frags[frame]];
    else return global.dicomParser.readEncapsulatedImageFrame(rec.ds, el, frame);
    if (!list.length) throw new Error('No compressed pixel data in ' + rec.name);
    if (list.length === 1) return part(list[0]);
    const total = list.reduce((a, f) => a + f.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const f of list) { out.set(part(f), o); o += f.length; }
    return out;
  }

  /** Get raw pixel samples for one frame of a record as a typed array (8/16 bit). */
  async function frameSamples(rec, frame) {
    const { ts, rows, cols, bitsAllocated, pixelRep, spp } = rec;
    const n = rows * cols;
    if (ts === TS.JPEG_BASELINE) {
      const jpg = encapsulatedFrame(rec, frame);
      const bmp = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = cols; c.height = rows;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, cols, rows).data;
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = d[i * 4];
      return out;
    }
    if (ts === TS.JPEG_LOSSLESS || ts === TS.JPEG_LOSSLESS_P14) {
      const img = X.decodeJpegLossless(encapsulatedFrame(rec, frame));
      if (img.width !== cols || img.height !== rows) throw new Error('Decoded image size does not match DICOM header in ' + rec.name);
      let arr = img.data;
      if (img.components === 3 || spp === 3) {
        const g = new Uint8Array(n);
        for (let i = 0; i < n; i++) g[i] = (arr[i * 3] * 0.299 + arr[i * 3 + 1] * 0.587 + arr[i * 3 + 2] * 0.114) | 0;
        return g;
      }
      if (bitsAllocated === 8) return Uint8Array.from(arr);
      return pixelRep ? new Int16Array(arr.buffer, arr.byteOffset, arr.length) : arr;
    }
    if (ts !== TS.IMPLICIT_LE && ts !== TS.EXPLICIT_LE && ts !== TS.DEFLATED) {
      throw new Error('This scan is compressed with ' + unsupportedTransferSyntax(ts) +
        ' which this viewer cannot decode yet. Ask the clinic to export it as uncompressed DICOM, ' +
        'or convert it first (for example with Horos/OsiriX, 3D Slicer or "dcmdjpeg").');
    }
    const bytesPer = bitsAllocated / 8;
    if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new Error('Unsupported bit depth: ' + bitsAllocated);
    const frameBytes = n * spp * bytesPer;
    const off = rec.pixel.dataOffset + frame * frameBytes;
    const abs = rec.byteOffset + off;
    if (abs + frameBytes > rec.buffer.byteLength) throw new Error('Truncated pixel data in ' + rec.name);
    let arr;
    if (bitsAllocated === 8) {
      arr = new Uint8Array(rec.buffer, abs, n * spp);
    } else if (abs % 2 === 0) {
      arr = pixelRep ? new Int16Array(rec.buffer, abs, n * spp) : new Uint16Array(rec.buffer, abs, n * spp);
    } else {
      const copy = rec.buffer.slice(abs, abs + frameBytes);
      arr = pixelRep ? new Int16Array(copy) : new Uint16Array(copy);
    }
    if (spp === 3) { // RGB -> luminance
      const g = new Uint8Array(n);
      for (let i = 0; i < n; i++) g[i] = (arr[i * 3] * 0.299 + arr[i * 3 + 1] * 0.587 + arr[i * 3 + 2] * 0.114) | 0;
      return g;
    }
    return arr;
  }

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  /** Group DICOM records into selectable series. */
  function groupSeries(records) {
    const map = new Map();
    for (const r of records) {
      const key = [r.seriesUID, r.rows, r.cols, r.bitsAllocated, r.spp].join('|');
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    const list = [];
    for (const recs of map.values()) {
      // flatten frames
      const slices = [];
      for (const r of recs) for (let f = 0; f < r.frames; f++) slices.push({ rec: r, frame: f });
      const first = recs[0];
      list.push({
        kind: 'dicom',
        id: list.length,
        title: first.seriesDesc || ('Series ' + (first.seriesNumber || list.length + 1)),
        modality: first.modality,
        rows: first.rows, cols: first.cols,
        count: slices.length,
        slices
      });
    }
    list.sort((a, b) => b.count - a.count);
    list.forEach((s, i) => (s.id = i));
    return list;
  }

  /** Sort slices along the acquisition normal and compute z spacing. */
  function orderSlices(series) {
    const first = series.slices[0].rec;
    const iop = first.iop;
    let normal = null;
    if (iop) normal = cross(iop.slice(0, 3), iop.slice(3, 6));
    const pos = (s) => {
      const r = s.rec;
      const p = r.frameIpp ? r.frameIpp[s.frame] : r.ipp;
      return p && normal ? dot(p, normal) : null;
    };
    const items = series.slices.map((s, i) => ({ s, i, p: pos(s) }));
    const havePos = items.every((x) => x.p !== null) && items.length > 1;
    if (havePos) {
      items.sort((a, b) => a.p - b.p || a.i - b.i);
    } else {
      items.sort((a, b) => a.s.rec.instance - b.s.rec.instance || a.s.frame - b.s.frame || a.i - b.i);
    }
    let dz = 0;
    if (havePos) {
      const diffs = [];
      for (let i = 1; i < items.length; i++) diffs.push(items[i].p - items[i - 1].p);
      diffs.sort((a, b) => a - b);
      dz = Math.abs(diffs[diffs.length >> 1]);
    }
    if (!dz) dz = first.spacingBetween || first.sliceThickness || (first.pixelSpacing ? first.pixelSpacing[0] : 1);
    return { ordered: items.map((x) => x.s), dz, havePos, normal };
  }

  async function buildDicomVolume(series, onProgress) {
    const { ordered, dz, normal } = orderSlices(series);
    const first = ordered[0].rec;
    const nx = first.cols, ny = first.rows, nz = ordered.length;
    const ps = first.pixelSpacing || [1, 1];
    const slope = first.slope || 1, inter = first.intercept || 0;
    const row = first.iop ? first.iop.slice(0, 3) : [1, 0, 0];
    const col = first.iop ? first.iop.slice(3, 6) : [0, 1, 0];
    const flipX = row[0] < -0.5;
    const flipY = col[1] < -0.5;
    const nxy = nx * ny;

    // pass 1: raw range, so we can pick the leanest output array type
    const raws = new Array(nz);
    let rmin = Infinity, rmax = -Infinity;
    for (let k = 0; k < nz; k++) {
      const raw = await frameSamples(ordered[k].rec, ordered[k].frame);
      raws[k] = raw;
      for (let i = 0; i < raw.length; i++) {
        const v = raw[i];
        if (v < rmin) rmin = v;
        if (v > rmax) rmax = v;
      }
      if (k % 16 === 0) { onProgress && onProgress(k / nz * 0.5, 'Reading slices'); await tick(); }
    }
    const a = rmin * slope + inter, b = rmax * slope + inter;
    const omin = Math.min(a, b), omax = Math.max(a, b);
    const integral = slope === 1 && Number.isInteger(inter);
    let Out = Float32Array;
    if (integral && omin >= -32768 && omax <= 32767) Out = Int16Array;
    else if (integral && omin >= 0 && omax <= 65535) Out = Uint16Array;
    const data = new Out(nxy * nz);
    const invert = first.photometric === 'MONOCHROME1';

    for (let k = 0; k < nz; k++) {
      const raw = raws[k];
      const base = k * nxy;
      for (let y = 0; y < ny; y++) {
        const sy = flipY ? ny - 1 - y : y;
        const srow = sy * nx, drow = base + y * nx;
        for (let x = 0; x < nx; x++) {
          const sx = flipX ? nx - 1 - x : x;
          let v = raw[srow + sx];
          if (invert) v = rmax - v + rmin;
          data[drow + x] = v * slope + inter;
        }
      }
      raws[k] = null;
      if (k % 16 === 0) { onProgress && onProgress(0.5 + k / nz * 0.5, 'Assembling volume'); await tick(); }
    }

    let tilt = 0;
    if (normal) tilt = Math.acos(Math.min(1, Math.abs(normal[2])));
    const calibrated = first.modality === 'CT' || first.intercept !== 0 || first.slope !== 1;
    return {
      data, dims: [nx, ny, nz],
      spacing: [ps[1] || 1, ps[0] || 1, dz || 1],
      calibrated,
      info: {
        title: series.title, modality: first.modality, studyDesc: first.studyDesc, studyDate: first.studyDate,
        note: tilt > 0.35 ? 'This acquisition is not axial; orientation labels may not match anatomy.' : ''
      }
    };
  }

  /* ---------- NIfTI ---------- */

  async function loadNifti(entry) {
    let buf = new Uint8Array(await entry.read());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = global.fflate.gunzipSync(buf);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let le = true;
    if (dv.getInt32(0, true) !== 348) {
      if (dv.getInt32(0, false) === 348) le = false;
      else throw new Error('Not a valid NIfTI-1 file: ' + entry.name);
    }
    const dim = []; for (let i = 0; i < 8; i++) dim.push(dv.getInt16(40 + i * 2, le));
    const datatype = dv.getInt16(70, le);
    const pix = []; for (let i = 0; i < 8; i++) pix.push(dv.getFloat32(76 + i * 4, le));
    const voxOffset = dv.getFloat32(108, le);
    const slope = dv.getFloat32(112, le) || 1;
    const inter = dv.getFloat32(116, le) || 0;
    const nx = dim[1], ny = dim[2], nz = Math.max(1, dim[3]);
    const n = nx * ny * nz;
    const off = voxOffset >= 352 ? voxOffset : 352;
    const src = buf.buffer.slice(buf.byteOffset + off);
    const types = {
      2: [Uint8Array, 1], 4: [Int16Array, 2], 8: [Int32Array, 4], 16: [Float32Array, 4],
      64: [Float64Array, 8], 256: [Int8Array, 1], 512: [Uint16Array, 2], 768: [Uint32Array, 4]
    };
    const t = types[datatype];
    if (!t) throw new Error('Unsupported NIfTI datatype ' + datatype);
    let raw;
    if (le) raw = new t[0](src, 0, n);
    else { // big-endian: swap through DataView
      raw = new t[0](n);
      const d2 = new DataView(src);
      const getters = { 2: 'getUint8', 4: 'getInt16', 8: 'getInt32', 16: 'getFloat32', 64: 'getFloat64', 256: 'getInt8', 512: 'getUint16', 768: 'getUint32' };
      for (let i = 0; i < n; i++) raw[i] = d2[getters[datatype]](i * t[1], false);
    }
    let data = raw;
    if (slope !== 1 || inter !== 0 || raw instanceof Float64Array || raw instanceof Int32Array || raw instanceof Uint32Array) {
      data = new Float32Array(n);
      for (let i = 0; i < n; i++) data[i] = raw[i] * slope + inter;
    }
    // NIfTI is stored x fastest, +x = right (RAS-ish) and z up; flip x so left of patient shows on the right.
    // Voxel order is otherwise compatible with our layout (x fastest, z up).
    const flipped = new data.constructor(n);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      const o = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) flipped[o + x] = data[o + (nx - 1 - x)];
    }
    // NIfTI y runs posterior -> anterior; our y runs anterior -> posterior, so flip y as well.
    const out = new data.constructor(n);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) {
      out.set(flipped.subarray((z * ny + (ny - 1 - y)) * nx, (z * ny + (ny - 1 - y)) * nx + nx), (z * ny + y) * nx);
    }
    return {
      data: out, dims: [nx, ny, nz],
      spacing: [Math.abs(pix[1]) || 1, Math.abs(pix[2]) || 1, Math.abs(pix[3]) || 1],
      calibrated: false,
      info: { title: baseName(entry.name), modality: 'NIfTI', studyDesc: '', studyDate: '', note: '' }
    };
  }

  /* ---------- plain images (panoramic / bitewing exports etc.) ---------- */

  async function loadImage(entry) {
    const buf = await entry.read();
    const bmp = await createImageBitmap(new Blob([buf]));
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const out = new Uint8Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0;
    return {
      data: out, dims: [c.width, c.height, 1], spacing: [1, 1, 1], calibrated: false,
      info: { title: baseName(entry.name), modality: 'Image', studyDesc: '', studyDate: '', note: '' }
    };
  }

  /* ---------- top level ---------- */

  /**
   * Inspect a pile of files. Returns {series: [...]} where each series has a lazy build(onProgress).
   */
  async function scanFiles(files, onStatus) {
    let entries = [];
    for (const f of files) entries.push(f.read ? f : fileEntry(f));

    // expand zips
    const expanded = [];
    for (const e of entries) {
      if (extOf(e.name) === 'zip') {
        onStatus && onStatus('Unzipping ' + baseName(e.name));
        await tick();
        try { expanded.push(...(await expandZip(e))); } catch (err) { /* ignore broken zip */ }
      } else expanded.push(e);
    }
    entries = expanded;

    const dicoms = [];
    const series = [];
    const images = [];
    let scanned = 0;
    for (const e of entries) {
      const ext = extOf(e.name);
      const bn = baseName(e.name).toLowerCase();
      if (bn === 'dicomdir' || SKIP_EXT.has(ext)) continue;
      if (ext === 'nii' || (ext === 'gz' && /\.nii\.gz$/i.test(e.name))) {
        series.push({
          kind: 'nifti', title: baseName(e.name), count: 0, modality: 'NIfTI',
          build: () => loadNifti(e)
        });
        continue;
      }
      if (IMAGE_EXT.has(ext)) { images.push(e); continue; }
      scanned++;
      if (scanned % 20 === 0) { onStatus && onStatus('Scanning files (' + scanned + ')'); await tick(); }
      let buf;
      try { buf = await e.read(); } catch (err) { continue; }
      const rec = parseDicom(buf, e.name);
      if (rec) dicoms.push(rec);
    }

    const dsr = groupSeries(dicoms);
    dsr.forEach((s) => {
      s.build = (p) => buildDicomVolume(s, p);
    });
    const all = dsr.concat(series);
    if (!all.length && images.length) {
      images.forEach((e) => all.push({
        kind: 'image', title: baseName(e.name), count: 1, modality: 'Image', rows: 0, cols: 0,
        build: () => loadImage(e)
      }));
    }
    all.forEach((s, i) => (s.id = i));
    return all;
  }

  X.scanFiles = scanFiles;
})(window);
