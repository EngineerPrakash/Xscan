/* Volume helpers: statistics, GPU-sized resampling, and a synthetic demo jaw phantom. */
(function (global) {
  'use strict';
  const X = (global.Xscan = global.Xscan || {});

  function computeStats(vol) {
    const d = vol.data, n = d.length;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = d[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const BINS = 4096;
    const hist = new Uint32Array(BINS);
    const scale = (BINS - 1) / Math.max(mx - mn, 1e-9);
    for (let i = 0; i < n; i++) hist[((d[i] - mn) * scale) | 0]++;
    const pct = (p) => {
      const target = p * n;
      let cum = 0;
      for (let b = 0; b < BINS; b++) {
        cum += hist[b];
        if (cum >= target) return mn + b / scale;
      }
      return mx;
    };
    return { min: mn, max: mx, hist, bins: BINS, pct };
  }

  /**
   * Box-filter downsample to at most maxVox voxels and normalise into 0..1 using [lo, hi].
   */
  function makeRenderVolume(vol, lo, hi, maxVox) {
    const [nx, ny, nz] = vol.dims;
    const total = nx * ny * nz;
    let f = total > maxVox ? Math.cbrt(total / maxVox) : 1;
    const tx = Math.max(1, Math.round(nx / f));
    const ty = Math.max(1, Math.round(ny / f));
    const tz = Math.max(1, Math.round(nz / Math.max(1, Math.min(f, nz))));
    const src = vol.data;
    const out = new Float32Array(tx * ty * tz);
    const inv = 1 / Math.max(hi - lo, 1e-9);
    const xr = [], yr = [];
    for (let i = 0; i < tx; i++) xr.push([Math.floor(i * nx / tx), Math.max(Math.floor(i * nx / tx) + 1, Math.floor((i + 1) * nx / tx))]);
    for (let i = 0; i < ty; i++) yr.push([Math.floor(i * ny / ty), Math.max(Math.floor(i * ny / ty) + 1, Math.floor((i + 1) * ny / ty))]);
    let o = 0;
    for (let k = 0; k < tz; k++) {
      const z0 = Math.floor(k * nz / tz), z1 = Math.max(z0 + 1, Math.floor((k + 1) * nz / tz));
      for (let j = 0; j < ty; j++) {
        const [y0, y1] = yr[j];
        for (let i = 0; i < tx; i++) {
          const [x0, x1] = xr[i];
          let sum = 0, cnt = 0;
          for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) {
            let idx = (z * ny + y) * nx + x0;
            for (let x = x0; x < x1; x++, idx++) { sum += src[idx]; cnt++; }
          }
          const v = (sum / cnt - lo) * inv;
          out[o++] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
      }
    }
    return { data: out, dims: [tx, ty, tz] };
  }

  /** Synthetic CBCT-like scan of a jaw: soft tissue, mandible + maxilla, 28 teeth, one implant. */
  function makePhantom() {
    const nx = 200, ny = 200, nz = 150;
    const data = new Int16Array(nx * ny * nz);
    const cx = 100, cy = 105, Rx = 58, Ry = 52;
    const teeth = [];
    // tooth positions along the arch (angle measured from +x, anterior = -y)
    for (let i = 0; i < 14; i++) {
      const th = (-0.12 + (i / 13) * (Math.PI + 0.24)); // 0 .. pi, passing through the anterior
      const px = cx + Math.cos(th) * Rx * 0.82;
      const py = cy - Math.sin(th) * Ry * 0.82;
      const molar = i < 3 || i > 10;
      teeth.push({ x: px, y: py, rx: molar ? 6.5 : 4.2, ry: molar ? 6.2 : 3.6, th });
    }
    const hash = (i) => { let h = i * 2654435761 >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; return ((h >>> 8) & 0xffff) / 65535 - 0.5; };
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const dx = (x - cx) / Rx, dy = (y - cy) / Ry;
          const r = Math.sqrt(dx * dx + dy * dy);
          const anterior = y < cy + 14;
          const env = ((x - cx) / 86) ** 2 + ((y - cy) / 76) ** 2 + ((z - 75) / 76) ** 2;
          let v = -1000;
          if (env < 1) v = 35;                    // cheeks / lips / skin
          if (r < 0.7 && z > 62 && z < 106) v = -1000;                   // oral cavity
          if (r < 0.7 && z <= 62 && z > 20) v = 25;                      // tongue
          // mandible (z 12..60) and maxilla (z 108..140)
          const rOut = 1.02 - 0.16 * Math.pow(Math.abs(z - 36) / 24, 2);
          const ring = r > 0.68 && r < rOut && anterior;
          if (ring && z > 12 && z < 60) {
            const edge = Math.min(r - 0.68, rOut - r, z - 12, 60 - z);
            v = edge < 0.05 || (z - 12 < 3) ? 1250 : 520;
          }
          const rOutU = 1.02 - 0.16 * Math.pow(Math.abs(z - 122) / 20, 2);
          if (z >= 104 && z < 142 && r < rOutU && anterior) {
            const pal = r < 0.68;
            if (pal && z < 118) v = 700;                                  // hard palate
            else if (!pal) v = (rOutU - r < 0.05) ? 1200 : 480;
          }
          // teeth
          for (let t = 0; t < teeth.length; t++) {
            const T = teeth[t];
            const ex = (x - T.x) / T.rx, ey = (y - T.y) / T.ry;
            const e2 = ex * ex + ey * ey;
            if (e2 > 1.6) continue;
            // lower tooth: z 44..88 ; upper tooth: z 92..134
            const lz0 = 44, lz1 = 88, uz0 = 92, uz1 = 134;
            const taperL = 1 - 0.55 * Math.max(0, (66 - z) / 22), taperU = 1 - 0.55 * Math.max(0, (z - 112) / 22);
            if (z >= lz0 && z <= lz1 && e2 < taperL * taperL) v = (z > 70 ? 2650 : 1750) + (e2 < 0.04 && z < 76 && z > 50 ? -1500 : 0);
            if (z >= uz0 && z <= uz1 && e2 < taperU * taperU) v = (z < 110 ? 2650 : 1750) + (e2 < 0.04 && z > 106 && z < 126 ? -1500 : 0);
          }
          // implant (lower right molar region)
          {
            const T = teeth[11];
            const ix = x - (T.x + 1), iy = y - (T.y + 1);
            if (z >= 28 && z <= 64 && ix * ix + iy * iy < 7.5 && Math.sin(z * 1.7) > -0.2) v = 3300;
            if (z > 64 && z <= 76 && ix * ix + iy * iy < 6 ) v = 3300;
          }
          data[(z * ny + y) * nx + x] = v + (v > -900 ? hash(x + y * 313 + z * 77777) * 60 : 0);
        }
      }
    }
    return {
      data, dims: [nx, ny, nz], spacing: [0.4, 0.4, 0.4], calibrated: true,
      info: { title: 'Demo phantom (synthetic jaw)', modality: 'CT', studyDesc: 'Synthetic data - not a real scan', studyDate: '', note: '' }
    };
  }

  X.computeStats = computeStats;
  X.makeRenderVolume = makeRenderVolume;
  X.makePhantom = makePhantom;
})(window);
