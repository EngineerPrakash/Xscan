/* JPEG Lossless (ITU-T T.81 process 14, SOF3) decoder - DICOM transfer syntaxes 1.2.840.10008.1.2.4.57 / .70.
 * Returns {width, height, components, precision, data: Uint16Array (interleaved)} */
(function (global) {
  'use strict';
  const X = (global.Xscan = global.Xscan || {});

  function buildTable(counts, symbols) {
    // 16-bit lookup: table[peek16] = (len << 8) | symbol, 0 = invalid
    const table = new Uint16Array(65536);
    let code = 0, k = 0;
    for (let len = 1; len <= 16; len++) {
      for (let i = 0; i < counts[len - 1]; i++, k++) {
        const start = code << (16 - len);
        const end = (code + 1) << (16 - len);
        const val = (len << 8) | symbols[k];
        table.fill(val, start, end);
        code++;
      }
      code <<= 1;
    }
    return table;
  }

  function decode(bytes) {
    let p = 0;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Not a JPEG stream');
    p = 2;
    const tables = {};
    let frame = null, dri = 0;
    let scan = null;
    while (p < bytes.length) {
      if (bytes[p] !== 0xff) { p++; continue; }
      const m = bytes[p + 1];
      if (m === 0xff) { p++; continue; }
      p += 2;
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0) continue;
      if (m === 0xd9) break;
      const len = (bytes[p] << 8) | bytes[p + 1];
      const seg = p + 2;
      if (m === 0xc3) { // lossless, Huffman
        frame = {
          precision: bytes[seg],
          height: (bytes[seg + 1] << 8) | bytes[seg + 2],
          width: (bytes[seg + 3] << 8) | bytes[seg + 4],
          comps: []
        };
        const n = bytes[seg + 5];
        for (let i = 0; i < n; i++) frame.comps.push({ id: bytes[seg + 6 + i * 3], hv: bytes[seg + 7 + i * 3] });
      } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        throw new Error('JPEG is not lossless (SOF' + (m - 0xc0) + ')');
      } else if (m === 0xc4) {
        let q = seg;
        while (q < p + len) {
          const id = bytes[q++];
          const counts = bytes.subarray(q, q + 16); q += 16;
          let total = 0; for (let i = 0; i < 16; i++) total += counts[i];
          tables[id & 15] = buildTable(counts, bytes.subarray(q, q + total));
          q += total;
        }
      } else if (m === 0xdd) {
        dri = (bytes[seg] << 8) | bytes[seg + 1];
      } else if (m === 0xda) {
        const ns = bytes[seg];
        const comps = [];
        for (let i = 0; i < ns; i++) comps.push({ id: bytes[seg + 1 + i * 2], td: bytes[seg + 2 + i * 2] >> 4 });
        const o = seg + 1 + ns * 2;
        scan = { comps, predictor: bytes[o], pt: bytes[o + 2] & 15, start: p + len };
        break;
      }
      p += len;
    }
    if (!frame || !scan) throw new Error('Incomplete lossless JPEG');

    const { width: W, height: H, precision: P } = frame;
    const nc = scan.comps.length;
    const out = new Uint16Array(W * H * nc);
    const pt = scan.pt, sel = scan.predictor;
    const defaultPred = 1 << (P - pt - 1);
    const mask = 0xffff;
    const tabs = scan.comps.map((c) => {
      const t = tables[c.td];
      if (!t) throw new Error('Missing Huffman table');
      return t;
    });

    let pos = scan.start, bitBuf = 0, bitCnt = 0;
    const n = bytes.length;
    function fill() {
      while (bitCnt <= 24) {
        let b = 0;
        if (pos < n) {
          b = bytes[pos];
          if (b === 0xff) {
            const nx = bytes[pos + 1];
            if (nx === 0) pos += 2;
            else b = 0; // marker: feed zeros, do not advance
          } else pos++;
        }
        bitBuf = ((bitBuf << 8) | b) >>> 0;
        bitCnt += 8;
      }
    }
    function readDiff(table) {
      if (bitCnt < 16) fill();
      const e = table[(bitBuf >>> (bitCnt - 16)) & 0xffff];
      const len = e >> 8;
      if (!len) throw new Error('Corrupt Huffman data');
      bitCnt -= len;
      bitBuf &= bitCnt ? (0xffffffff >>> (32 - bitCnt)) : 0;
      const s = e & 0xff;
      if (s === 0) return 0;
      if (s === 16) return 32768;
      if (bitCnt < s) fill();
      let v = (bitBuf >>> (bitCnt - s)) & ((1 << s) - 1);
      bitCnt -= s;
      bitBuf &= bitCnt ? (0xffffffff >>> (32 - bitCnt)) : 0;
      if (v < (1 << (s - 1))) v -= (1 << s) - 1;
      return v;
    }

    const stride = W * nc;
    let mcu = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (dri && mcu > 0 && mcu % dri === 0) {
          // restart marker: realign
          bitCnt = 0; bitBuf = 0;
          while (pos < n - 1 && !(bytes[pos] === 0xff && bytes[pos + 1] >= 0xd0 && bytes[pos + 1] <= 0xd7)) pos++;
          pos += 2;
          scan.restartRow = y; scan.restartX = x;
        }
        const firstOfInterval = dri && scan.restartRow === y && x === scan.restartX && mcu > 0;
        for (let c = 0; c < nc; c++) {
          const diff = readDiff(tabs[c]);
          const i = y * stride + x * nc + c;
          let pred;
          if ((y === 0 && x === 0) || firstOfInterval) pred = defaultPred;
          else if (y === 0 || (dri && scan.restartRow === y && !(x === 0))) pred = out[i - nc] >> pt << 0;
          else if (x === 0) pred = out[i - stride] >> pt;
          else {
            const ra = out[i - nc] >> pt, rb = out[i - stride] >> pt, rc = out[i - stride - nc] >> pt;
            switch (sel) {
              case 0: pred = 0; break;
              case 1: pred = ra; break;
              case 2: pred = rb; break;
              case 3: pred = rc; break;
              case 4: pred = ra + rb - rc; break;
              case 5: pred = ra + ((rb - rc) >> 1); break;
              case 6: pred = rb + ((ra - rc) >> 1); break;
              case 7: pred = (ra + rb) >> 1; break;
              default: throw new Error('Bad predictor ' + sel);
            }
          }
          out[i] = ((pred + diff) & mask) << pt;
        }
        mcu++;
      }
    }
    return { width: W, height: H, components: nc, precision: P, data: out };
  }

  X.decodeJpegLossless = decode;
})(typeof window !== 'undefined' ? window : globalThis);
