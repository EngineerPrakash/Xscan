/* 2D multi-planar slice views (axial / coronal / sagittal) with crosshair, zoom, slab and ruler. */
(function (global) {
  'use strict';
  const X = (global.Xscan = global.Xscan || {});

  // n = axis along which we scroll, h/v = in-plane axes (0=x, 1=y, 2=z)
  const DEFS = {
    axial:    { n: 2, h: 0, v: 1, flipV: false, color: '#4da3ff', label: 'Axial',
                edges: { top: 'A', bottom: 'P', left: 'R', right: 'L' } },
    coronal:  { n: 1, h: 0, v: 2, flipV: true,  color: '#43d17a', label: 'Coronal',
                edges: { top: 'S', bottom: 'I', left: 'R', right: 'L' } },
    sagittal: { n: 0, h: 1, v: 2, flipV: true,  color: '#f5b04a', label: 'Sagittal',
                edges: { top: 'S', bottom: 'I', left: 'A', right: 'P' } }
  };
  const AXIS_COLOR = [DEFS.sagittal.color, DEFS.coronal.color, DEFS.axial.color]; // colour of plane normal to x,y,z

  class SliceView {
    constructor(canvas, name, handlers) {
      this.canvas = canvas;
      this.name = name;
      this.def = DEFS[name];
      this.h = handlers;
      this.ctx = canvas.getContext('2d');
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');
      this.zoom = 1;
      this.pan = [0, 0];
      this.measures = [];
      this.pending = null;
      this.vol = null;
      this._bind();
    }

    setVolume(vol) {
      this.vol = vol;
      this.zoom = 1;
      this.pan = [0, 0];
      this.measures = [];
      this.pending = null;
      this.imgData = null;
    }

    resetZoom() { this.zoom = 1; this.pan = [0, 0]; }

    _geom() {
      const dpr = global.devicePixelRatio || 1;
      const cw = this.canvas.width, ch = this.canvas.height;
      const { h, v } = this.def, d = this.vol.dims, sp = this.vol.spacing;
      const Wp = d[h] * sp[h], Hp = d[v] * sp[v];
      const s = Math.min(cw / Wp, ch / Hp) * this.zoom;
      const w = Wp * s, hh = Hp * s;
      return { dpr, cw, ch, Wp, Hp, s, w, hh, x0: (cw - w) / 2 + this.pan[0] * dpr, y0: (ch - hh) / 2 + this.pan[1] * dpr };
    }

    /** canvas CSS px -> fractional position (0..1) in the image */
    _toFrac(ev) {
      const r = this.canvas.getBoundingClientRect();
      const g = this._geom();
      const px = (ev.clientX - r.left) * (this.canvas.width / r.width);
      const py = (ev.clientY - r.top) * (this.canvas.height / r.height);
      return [(px - g.x0) / g.w, (py - g.y0) / g.hh];
    }

    _fracToIdx(f) {
      const { h, v, flipV } = this.def, d = this.vol.dims;
      const clamp = (x, n) => Math.max(0, Math.min(n - 1, x));
      const ih = clamp(Math.floor(f[0] * d[h]), d[h]);
      let iv = clamp(Math.floor(f[1] * d[v]), d[v]);
      if (flipV) iv = d[v] - 1 - iv;
      return [ih, iv];
    }

    _bind() {
      const c = this.canvas;
      let mode = null, last = null;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => {
        if (!this.vol) return;
        c.setPointerCapture(e.pointerId);
        last = [e.clientX, e.clientY];
        if (e.button === 1 || e.button === 2 || e.shiftKey) { mode = 'pan'; return; }
        const f = this._toFrac(e);
        if (this.h.getTool() === 'ruler') {
          mode = 'ruler';
          this.pending = { a: f, b: f, slice: this.h.getCursor()[this.def.n] };
          this.draw();
          return;
        }
        mode = 'pick';
        const [ih, iv] = this._fracToIdx(f);
        this.h.onPick(this.name, ih, iv);
      });
      c.addEventListener('pointermove', (e) => {
        if (!this.vol) return;
        const f = this._toFrac(e);
        const [ih, iv] = this._fracToIdx(f);
        const inside = f[0] >= 0 && f[0] <= 1 && f[1] >= 0 && f[1] <= 1;
        this.h.onHover(this.name, inside ? [ih, iv] : null);
        if (!mode) return;
        if (mode === 'pan') {
          this.pan[0] += e.clientX - last[0];
          this.pan[1] += e.clientY - last[1];
          last = [e.clientX, e.clientY];
          this.draw();
        } else if (mode === 'pick') {
          this.h.onPick(this.name, ih, iv);
        } else if (mode === 'ruler' && this.pending) {
          this.pending.b = f;
          this.draw();
        }
      });
      const end = () => {
        if (mode === 'ruler' && this.pending) {
          const m = this.pending;
          if (Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]) > 0.003) this.measures.push(m);
          this.pending = null;
          this.draw();
        }
        mode = null;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', () => this.h.onHover(this.name, null));
      c.addEventListener('wheel', (e) => {
        if (!this.vol) return;
        e.preventDefault();
        if (e.ctrlKey || e.metaKey || e.altKey) {
          const f0 = this._toFrac(e);
          const nz = Math.max(1, Math.min(12, this.zoom * Math.exp(-e.deltaY * 0.0025)));
          this.zoom = nz;
          // keep the point under the cursor fixed
          const f1 = this._toFrac(e);
          const g = this._geom();
          this.pan[0] += (f1[0] - f0[0]) * g.w / g.dpr;
          this.pan[1] += (f1[1] - f0[1]) * g.hh / g.dpr;
          if (nz === 1) this.pan = [0, 0];
          this.draw();
        } else {
          this.h.onScroll(this.name, (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 5 : 1));
        }
      }, { passive: false });
      c.addEventListener('dblclick', (e) => { e.stopPropagation(); this.resetZoom(); this.draw(); });
    }

    resize() {
      const dpr = global.devicePixelRatio || 1;
      const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
      const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    }

    /** Re-rasterise the slice into the off-screen canvas, then draw. */
    render() {
      if (!this.vol) return;
      const vol = this.vol, d = vol.dims, data = vol.data;
      const st = this.h.getState();
      const { n, h, v, flipV } = this.def;
      const strides = [1, d[0], d[0] * d[1]];
      const w = d[h], hh = d[v];
      if (!this.imgData || this.imgData.width !== w || this.imgData.height !== hh) {
        this.off.width = w; this.off.height = hh;
        this.imgData = this.offCtx.createImageData(w, hh);
      }
      const u32 = new Uint32Array(this.imgData.data.buffer);
      const k = (st.slab - 1) >> 1;
      const i0 = Math.max(0, st.cur[n] - k), i1 = Math.min(d[n] - 1, st.cur[n] + k);
      const cnt = i1 - i0 + 1;
      const lo = st.win[0], sc = 255 / Math.max(st.win[1] - st.win[0], 1e-6);
      const sh = strides[h], sv = strides[v], sn = strides[n];
      const inv = st.invert, useMax = st.slabMode === 'max';
      for (let r = 0; r < hh; r++) {
        const vv = flipV ? hh - 1 - r : r;
        let idx = vv * sv + i0 * sn;
        let o = r * w;
        for (let c = 0; c < w; c++, idx += sh, o++) {
          let val;
          if (cnt === 1) val = data[idx];
          else if (useMax) { val = -Infinity; for (let s = 0, j = idx; s < cnt; s++, j += sn) if (data[j] > val) val = data[j]; }
          else { let sum = 0; for (let s = 0, j = idx; s < cnt; s++, j += sn) sum += data[j]; val = sum / cnt; }
          let g = (val - lo) * sc;
          g = g < 0 ? 0 : g > 255 ? 255 : g | 0;
          if (inv) g = 255 - g;
          u32[o] = 0xff000000 | (g << 16) | (g << 8) | g;
        }
      }
      this.offCtx.putImageData(this.imgData, 0, 0);
      this.draw();
    }

    draw() {
      this.resize();
      const ctx = this.ctx, cv = this.canvas;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (!this.vol || !this.imgData) return;
      const g = this._geom(), st = this.h.getState();
      const { n, h, v, flipV } = this.def, d = this.vol.dims, sp = this.vol.spacing;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.off, g.x0, g.y0, g.w, g.hh);

      // crosshair
      if (st.crosshair && d[n] > 0 && (d[0] > 1 && d[1] > 1)) {
        const fh = (st.cur[h] + 0.5) / d[h];
        const fv = flipV ? 1 - (st.cur[v] + 0.5) / d[v] : (st.cur[v] + 0.5) / d[v];
        const px = g.x0 + fh * g.w, py = g.y0 + fv * g.hh;
        ctx.lineWidth = Math.max(1, g.dpr);
        ctx.setLineDash([]);
        ctx.strokeStyle = AXIS_COLOR[h]; // vertical line = plane normal to the horizontal axis
        ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.moveTo(px, g.y0); ctx.lineTo(px, g.y0 + g.hh); ctx.stroke();
        ctx.strokeStyle = AXIS_COLOR[v];
        ctx.beginPath(); ctx.moveTo(g.x0, py); ctx.lineTo(g.x0 + g.w, py); ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // measurements
      const all = this.measures.concat(this.pending ? [this.pending] : []);
      ctx.font = Math.round(12 * g.dpr) + 'px system-ui, sans-serif';
      for (const m of all) {
        if (m.slice !== st.cur[n]) continue;
        const ax = g.x0 + m.a[0] * g.w, ay = g.y0 + m.a[1] * g.hh;
        const bx = g.x0 + m.b[0] * g.w, by = g.y0 + m.b[1] * g.hh;
        const mm = Math.hypot((m.b[0] - m.a[0]) * g.Wp, (m.b[1] - m.a[1]) * g.Hp);
        ctx.strokeStyle = '#ffe14d'; ctx.fillStyle = '#ffe14d'; ctx.lineWidth = Math.max(1.5, 1.5 * g.dpr);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.beginPath(); ctx.arc(x, y, 3 * g.dpr, 0, 7); ctx.fill(); }
        const label = mm.toFixed(1) + ' mm';
        const tw = ctx.measureText(label).width;
        const tx = (ax + bx) / 2 + 6 * g.dpr, ty = (ay + by) / 2 - 6 * g.dpr;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(tx - 3 * g.dpr, ty - 12 * g.dpr, tw + 6 * g.dpr, 16 * g.dpr);
        ctx.fillStyle = '#ffe14d';
        ctx.fillText(label, tx, ty);
      }

      // orientation letters
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = 'bold ' + Math.round(12 * g.dpr) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const e = this.def.edges, m = 12 * g.dpr;
      ctx.fillText(e.top, g.cw / 2, m);
      ctx.fillText(e.bottom, g.cw / 2, g.ch - m);
      ctx.fillText(e.left, m, g.ch / 2);
      ctx.fillText(e.right, g.cw - m, g.ch / 2);
      ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
    }
  }

  X.SliceView = SliceView;
  X.SLICE_DEFS = DEFS;
})(window);
