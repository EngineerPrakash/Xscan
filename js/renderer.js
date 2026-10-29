/* WebGL2 volume ray-caster with X-ray (DRR), MIP and shaded-surface modes + orbit camera. */
(function (global) {
  'use strict';
  const X = (global.Xscan = global.Xscan || {});

  const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVol;
uniform vec3 uHalf;
uniform vec3 uCam, uFwd, uRight, uUp;
uniform vec2 uRes;
uniform float uTan;
uniform int uMode;          // 0 xray, 1 mip, 2 surface
uniform vec2 uWin;          // window in normalised value space
uniform float uThr, uOpacity, uBright, uInvert, uSteps, uGrey;
uniform vec3 uClipLo, uClipHi, uTexel;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float win(float v) { return clamp((v - uWin.x) / max(uWin.y - uWin.x, 1e-4), 0.0, 1.0); }

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - uRes) / uRes.y;
  vec3 dir = normalize(uFwd + (uRight * uv.x + uUp * uv.y) * uTan);
  vec3 bmin = -uHalf + uClipLo * 2.0 * uHalf;
  vec3 bmax = -uHalf + uClipHi * 2.0 * uHalf;
  vec3 inv = 1.0 / dir;
  vec3 t0 = (bmin - uCam) * inv, t1 = (bmax - uCam) * inv;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float tmin = max(max(tn.x, tn.y), max(tn.z, 0.0));
  float tmax = min(min(tf.x, tf.y), tf.z);

  vec3 bgSurf = vec3(0.045, 0.055, 0.075);
  vec3 bg = uMode == 2 ? bgSurf : vec3(uInvert);
  if (tmax <= tmin) { outColor = vec4(bg, 1.0); return; }

  float dt = length(2.0 * uHalf) / uSteps;
  float t = tmin + dt * hash(gl_FragCoord.xy);
  vec3 size = 2.0 * uHalf;
  float acc = 0.0;
  vec4 col = vec4(0.0);

  for (int i = 0; i < 2400; i++) {
    if (t > tmax) break;
    vec3 p = uCam + dir * t;
    vec3 tc = (p + uHalf) / size;
    float v = texture(uVol, tc).r;
    if (uMode == 0) {
      acc += win(v);
    } else if (uMode == 1) {
      acc = max(acc, v);
    } else {
      float a = smoothstep(uThr, uThr + 0.03, v);
      if (a > 0.003) {
        float aStep = 1.0 - pow(1.0 - clamp(a * uOpacity, 0.0, 0.995), dt * 70.0);
        vec3 g = vec3(
          texture(uVol, tc + vec3(uTexel.x, 0.0, 0.0)).r - texture(uVol, tc - vec3(uTexel.x, 0.0, 0.0)).r,
          texture(uVol, tc + vec3(0.0, uTexel.y, 0.0)).r - texture(uVol, tc - vec3(0.0, uTexel.y, 0.0)).r,
          texture(uVol, tc + vec3(0.0, 0.0, uTexel.z)).r - texture(uVol, tc - vec3(0.0, 0.0, uTexel.z)).r);
        float glen = length(g);
        vec3 base = mix(vec3(0.86, 0.70, 0.56), vec3(0.99, 0.97, 0.90), smoothstep(0.55, 0.8, v));
        base = mix(base, vec3(0.88), uGrey);
        vec3 c = base;
        if (glen > 1e-4) {
          vec3 n = -g / glen;
          vec3 L = normalize(-dir + 0.5 * uUp + 0.35 * uRight);
          float diff = max(dot(n, L), 0.0);
          float spec = pow(max(dot(n, normalize(L - dir)), 0.0), 40.0) * 0.35;
          c = base * (0.22 + 0.9 * diff) * uBright + vec3(spec);
        } else {
          c = base * 0.5 * uBright;
        }
        col.rgb += (1.0 - col.a) * aStep * c;
        col.a += (1.0 - col.a) * aStep;
        if (col.a > 0.97) break;
      }
    }
    t += dt;
  }

  vec3 rgb;
  if (uMode == 0) {
    float s = acc * dt * 6.0 * uBright;
    float g = 1.0 - exp(-s);
    g = mix(g, 1.0 - g, uInvert);
    rgb = vec3(g);
  } else if (uMode == 1) {
    float g = win(acc);
    g = pow(g, 1.0 / max(uBright, 0.05));
    g = mix(g, 1.0 - g, uInvert);
    rgb = vec3(g);
  } else {
    rgb = col.rgb + (1.0 - col.a) * bgSurf;
  }
  outColor = vec4(rgb, 1.0);
}`;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.gl = gl;
      this.program = this._program(VERT, FRAG);
      this.u = {};
      const names = ['uVol', 'uHalf', 'uCam', 'uFwd', 'uRight', 'uUp', 'uRes', 'uTan', 'uMode', 'uWin', 'uThr',
        'uOpacity', 'uBright', 'uInvert', 'uSteps', 'uGrey', 'uClipLo', 'uClipHi', 'uTexel'];
      names.forEach((n) => (this.u[n] = gl.getUniformLocation(this.program, n)));
      this.vao = gl.createVertexArray();
      this.tex = null;
      this.hasVolume = false;
      this.cam = { yaw: 0, pitch: 0.12, dist: 2.3, target: [0, 0, 0] };
      this.params = {
        mode: 2, win: [0.3, 0.9], thr: 0.35, opacity: 0.9, bright: 1, invert: 0, grey: 0,
        quality: 1, clipLo: [0, 0, 0], clipHi: [1, 1, 1]
      };
      this.fovTan = Math.tan(20 * Math.PI / 180);
      this.interacting = false;
      this._dirty = false;
    }

    _program(vs, fs) {
      const gl = this.gl;
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
      return p;
    }

    /** rv: {data: Float32Array 0..1, dims}, vol: {dims, spacing} */
    setVolume(rv, vol) {
      const gl = this.gl;
      if (this.tex) gl.deleteTexture(this.tex);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R16F, rv.dims[0], rv.dims[1], rv.dims[2], 0, gl.RED, gl.FLOAT, rv.data);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      this.texDims = rv.dims;
      const mm = [vol.dims[0] * vol.spacing[0], vol.dims[1] * vol.spacing[1], vol.dims[2] * vol.spacing[2]];
      const m = Math.max(mm[0], mm[1], mm[2]);
      this.half = mm.map((v) => v / m / 2);
      this.hasVolume = true;
      this.resetCamera();
    }

    clearVolume() {
      this.hasVolume = false;
      this.draw();
    }

    resetCamera() {
      this.cam = { yaw: 0, pitch: 0.12, dist: 2.3, target: [0, 0, 0] };
      this.invalidate();
    }

    setView(name) {
      const P = Math.PI;
      const views = {
        front: [0, 0], back: [P, 0], left: [-P / 2, 0], right: [P / 2, 0], top: [0, P / 2 - 0.001], bottom: [0, -P / 2 + 0.001]
      };
      const v = views[name];
      if (!v) return;
      this.cam.yaw = v[0];
      this.cam.pitch = v[1];
      this.cam.target = [0, 0, 0];
      this.invalidate();
    }

    rotate(dx, dy) {
      this.cam.yaw -= dx * 0.008;
      this.cam.pitch += dy * 0.008;
      const lim = Math.PI / 2 - 0.001;
      this.cam.pitch = Math.max(-lim, Math.min(lim, this.cam.pitch));
      this.invalidate();
    }

    zoom(factor) {
      this.cam.dist = Math.max(0.35, Math.min(8, this.cam.dist * factor));
      this.invalidate();
    }

    pan(dx, dy) {
      const f = this._frame();
      const h = this.canvas.height || 1;
      const s = (2 * this.fovTan * this.cam.dist) / h;
      for (let i = 0; i < 3; i++) this.cam.target[i] += (-f.right[i] * dx + f.up[i] * dy) * s * (global.devicePixelRatio || 1);
      this.invalidate();
    }

    _frame() {
      const { yaw, pitch, dist, target } = this.cam;
      const cp = Math.cos(pitch);
      const off = [Math.sin(yaw) * cp, -Math.cos(yaw) * cp, Math.sin(pitch)];
      const pos = [target[0] + off[0] * dist, target[1] + off[1] * dist, target[2] + off[2] * dist];
      const fwd = [-off[0], -off[1], -off[2]];
      // right = fwd x worldUp(0,0,1)
      let right = [fwd[1], -fwd[0], 0];
      const rl = Math.hypot(right[0], right[1]) || 1;
      right = [right[0] / rl, right[1] / rl, 0];
      const up = [
        right[1] * fwd[2] - right[2] * fwd[1],
        right[2] * fwd[0] - right[0] * fwd[2],
        right[0] * fwd[1] - right[1] * fwd[0]
      ];
      return { pos, fwd, right, up };
    }

    invalidate() {
      if (this._dirty) return;
      this._dirty = true;
      requestAnimationFrame(() => {
        this._dirty = false;
        this.draw();
      });
    }

    resize() {
      const dpr = Math.min(global.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.floor(this.canvas.clientWidth * dpr));
      const h = Math.max(2, Math.floor(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    }

    draw() {
      const gl = this.gl;
      this.resize();
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      if (!this.hasVolume) {
        gl.clearColor(0.04, 0.05, 0.07, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }
      const p = this.params, f = this._frame(), u = this.u;
      const baseSteps = [260, 480, 820][p.quality] || 480;
      const steps = this.interacting ? Math.max(120, baseSteps * 0.45) : baseSteps;
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.tex);
      gl.uniform1i(u.uVol, 0);
      gl.uniform3fv(u.uHalf, this.half);
      gl.uniform3fv(u.uCam, f.pos);
      gl.uniform3fv(u.uFwd, f.fwd);
      gl.uniform3fv(u.uRight, f.right);
      gl.uniform3fv(u.uUp, f.up);
      gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
      gl.uniform1f(u.uTan, this.fovTan);
      gl.uniform1i(u.uMode, p.mode);
      gl.uniform2fv(u.uWin, p.win);
      gl.uniform1f(u.uThr, p.thr);
      gl.uniform1f(u.uOpacity, p.opacity);
      gl.uniform1f(u.uBright, p.bright);
      gl.uniform1f(u.uInvert, p.invert);
      gl.uniform1f(u.uGrey, p.grey);
      gl.uniform1f(u.uSteps, steps);
      gl.uniform3fv(u.uClipLo, p.clipLo);
      gl.uniform3fv(u.uClipHi, p.clipHi);
      gl.uniform3f(u.uTexel, 1 / this.texDims[0], 1 / this.texDims[1], 1 / this.texDims[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /** Render at the current size and return a PNG blob. */
    snapshot() {
      return new Promise((resolve) => {
        const was = this.interacting;
        this.interacting = false;
        this.draw();
        this.canvas.toBlob((b) => { this.interacting = was; resolve(b); }, 'image/png');
      });
    }
  }

  X.Renderer = Renderer;
})(window);
