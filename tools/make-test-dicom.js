#!/usr/bin/env node
/* Writes the built-in demo phantom as a folder of uncompressed DICOM slices (one file per slice,
 * extension-less, like a typical dental CD export) so the DICOM loading path can be tried/tested.
 *   node tools/make-test-dicom.js out_dir [--multiframe] */
'use strict';
const fs = require('fs');
const path = require('path');
global.window = global;
require('../js/volume.js');
const vol = global.Xscan.makePhantom();
const [nx, ny, nz] = vol.dims;
const out = process.argv[2] || 'test-dicom';
const multi = process.argv.includes('--multiframe');
fs.mkdirSync(out, { recursive: true });

const pad = (b, ch) => (b.length % 2 ? Buffer.concat([b, Buffer.from([ch])]) : b);
function el(group, elem, vr, value) {
  let v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'latin1');
  v = pad(v, vr === 'UI' ? 0 : 0x20);
  const long = ['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr);
  const h = Buffer.alloc(long ? 12 : 8);
  h.writeUInt16LE(group, 0); h.writeUInt16LE(elem, 2); h.write(vr, 4, 'latin1');
  if (long) h.writeUInt32LE(v.length, 8); else h.writeUInt16LE(v.length, 6);
  return Buffer.concat([h, v]);
}
const us = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const uid = (s) => s;
const SOP = '1.2.840.10008.5.1.4.1.1.2';
const series = '1.2.826.0.1.3680043.8.498.1';

function file(sopInst, extra, pixelBytes, frames) {
  const meta = Buffer.concat([
    el(2, 1, 'OB', Buffer.from([0, 1])),
    el(2, 2, 'UI', SOP), el(2, 3, 'UI', sopInst), el(2, 0x10, 'UI', '1.2.840.10008.1.2.1')
  ]);
  const gl = el(2, 0, 'UL', (() => { const b = Buffer.alloc(4); b.writeUInt32LE(meta.length); return b; })());
  const ds = Buffer.concat([
    el(8, 0x60, 'CS', 'CT'), el(8, 0x103e, 'LO', 'Synthetic jaw'),
    ...extra.pre,
    el(0x20, 0x0e, 'UI', series), el(0x20, 0x11, 'IS', '2'),
    ...extra.mid,
    el(0x28, 2, 'US', us(1)), el(0x28, 4, 'CS', 'MONOCHROME2'),
    ...(frames ? [el(0x28, 8, 'IS', String(frames))] : []),
    el(0x28, 0x10, 'US', us(ny)), el(0x28, 0x11, 'US', us(nx)),
    el(0x28, 0x30, 'DS', '0.4\\0.4'),
    el(0x28, 0x100, 'US', us(16)), el(0x28, 0x101, 'US', us(16)), el(0x28, 0x102, 'US', us(15)), el(0x28, 0x103, 'US', us(1)),
    el(0x28, 0x1052, 'DS', '0'), el(0x28, 0x1053, 'DS', '1'),
    el(0x7fe0, 0x10, 'OW', pixelBytes)
  ]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), gl, meta, ds]);
}
const slice = (k) => Buffer.from(vol.data.buffer, vol.data.byteOffset + k * nx * ny * 2, nx * ny * 2);

if (multi) {
  const f = file('1.2.826.0.1.3680043.8.498.99', {
    pre: [el(0x18, 0x50, 'DS', '0.4'), el(0x18, 0x88, 'DS', '0.4')],
    mid: [el(0x20, 0x13, 'IS', '1')]
  }, Buffer.from(vol.data.buffer, vol.data.byteOffset, vol.data.byteLength), nz);
  fs.writeFileSync(path.join(out, 'multiframe.dcm'), f);
} else {
  // write in shuffled order with instance numbers to prove sorting by position works
  for (let k = 0; k < nz; k++) {
    const z = k * 0.4;
    const f = file('1.2.826.0.1.3680043.8.498.1.' + (k + 1), {
      pre: [el(0x18, 0x50, 'DS', '0.4')],
      mid: [el(0x20, 0x13, 'IS', String(nz - k)), el(0x20, 0x32, 'DS', `-40\\-40\\${z.toFixed(2)}`), el(0x20, 0x37, 'DS', '1\\0\\0\\0\\1\\0')]
    }, slice(k));
    fs.writeFileSync(path.join(out, 'IM' + String(k).padStart(5, '0')), f);
  }
}
console.log('wrote', multi ? 'multiframe.dcm' : nz + ' slices', 'to', out);
