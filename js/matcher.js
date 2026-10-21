/*
 * MerchantHelper 웹 포트 — 오디오 매칭 엔진 (recognition.py / candidates.py / recorder.py 일부의 JS 이식)
 * 원작: 烟火 (A1Chao) https://github.com/A1Chao/MerchantHelper — 学习交流用, 禁止商业用途 (학습·교류 전용, 상업적 이용 금지)
 * 상수·임계값·분기 구조는 원본 Python 코드를 그대로 따름.
 * 브라우저(메인 스레드/Worker)와 Node 양쪽에서 동작하도록 팩토리 함수 하나로 감쌈.
 */
function MH_FACTORY() {
  "use strict";
  const SAMPLE_RATE = 16000, FFT_SIZE = 512, HOP = 64, BANDS = 64;
  const MIN_SIMILARITY = 0.88, AMBIGUITY_MARGIN = 0.045, MIN_PEAK_RMS = 0.0004, MAX_CANDIDATES = 5;
  const NOISE_OVER_SUBTRACTION = 1.35, FILTERED_MIN_SIMILARITY = 0.85;
  const ADAPTIVE_NOISE_FLOOR = 0.002, ADAPTIVE_FILTERED_MIN_SIMILARITY = 0.82, ADAPTIVE_MIN_MARGIN = 0.1;
  const GENTLE_NOISE_SUBTRACTION = 0.5, GENTLE_FILTERED_MIN_SIMILARITY = 0.78, GENTLE_MIN_MARGIN = 0.075;
  const MIXED_WAVEFORM_MIN_CORRELATION = 0.12, MIXED_WAVEFORM_MIN_MARGIN = 0.05, MIXED_WAVEFORM_FFT_SIZE = 65536;
  // scipy.signal.butter(2, 1000, fs=16000, btype="highpass", output="sos")
  const HP_SOS = [0.75707638, -1.51415275, 0.75707638, 1.0, -1.45424359, 0.57406192];

  // ---------------- FFT (radix-2, complex, in place) ----------------
  const fftCache = {};
  function fftTables(n) {
    if (fftCache[n]) return fftCache[n];
    const rev = new Uint32Array(n); let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) { let r = 0, v = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (v & 1); v >>= 1; } rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    return (fftCache[n] = { rev, cos, sin });
  }
  function fft(re, im, inverse) {
    const n = re.length, { rev, cos, sin } = fftTables(n);
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    const sg = inverse ? -1 : 1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = sg * sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  // ---------------- 작은 수치 유틸 (numpy 동작 재현) ----------------
  function quantile(arr, q) { // numpy 기본(linear)
    const s = Float64Array.from(arr).sort(); const n = s.length; if (!n) return NaN;
    const pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.min(n - 1, lo + 1);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  function median(arr) { return quantile(arr, 0.5); }
  function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
  function besselI0(x) { let s = 1, t = 1; for (let k = 1; k < 200; k++) { t *= (x / (2 * k)) * (x / (2 * k)); s += t; if (t < 1e-17 * s) break; } return s; }

  // scipy.signal.resample_poly(x, up, down) — window=('kaiser', 5.0), padtype='constant'
  const rpCache = {};
  function resamplePoly(x, srIn, srOut) {
    srIn = Math.round(srIn); if (srIn === srOut) return Float32Array.from(x);
    const g = gcd(srOut, srIn), up = srOut / g, down = srIn / g;
    const key = up + "/" + down;
    let h = rpCache[key];
    if (!h) {
      const maxRate = Math.max(up, down), fc = 1 / maxRate, halfLen = 10 * maxRate, N = 2 * halfLen + 1;
      h = new Float64Array(N); const alpha = (N - 1) / 2, beta = 5.0, i0b = besselI0(beta); let sum = 0;
      for (let i = 0; i < N; i++) {
        const m = i - alpha, xx = fc * m;
        const sinc = xx === 0 ? 1 : Math.sin(Math.PI * xx) / (Math.PI * xx);
        const r = 2 * i / (N - 1) - 1;
        const w = besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
        h[i] = fc * sinc * w; sum += h[i];
      }
      for (let i = 0; i < N; i++) h[i] = h[i] / sum * up;
      h.halfLen = halfLen; rpCache[key] = h;
    }
    const nx = x.length, nOut = Math.floor(nx * up / down) + ((nx * up) % down ? 1 : 0);
    const y = new Float32Array(nOut), N = h.length, halfLen = h.halfLen;
    for (let m = 0; m < nOut; m++) {
      const c = m * down + halfLen; // y[m] = sum_j h[j] * xup[c - j]
      let jStart = c % up; // c - j 이 up 의 배수가 되는 j
      let acc = 0;
      for (let j = jStart; j < N; j += up) {
        const idx = (c - j) / up;
        if (idx < 0) break;
        if (idx < nx) acc += h[j] * x[idx];
      }
      y[m] = acc;
    }
    return y;
  }

  function sosfilt(x) {
    const [b0, b1, b2, , a1, a2] = HP_SOS; const y = new Float32Array(x.length); let z0 = 0, z1 = 0;
    for (let i = 0; i < x.length; i++) { const xi = x[i], yi = b0 * xi + z0; z0 = b1 * xi - a1 * yi + z1; z1 = b2 * xi - a2 * yi; y[i] = yi; }
    return y;
  }
  function highpass(x) { return sosfilt(sosfilt(x)); } // 원본: 2차 버터워스 고역통과를 두 번 직렬

  // ---------------- mel 필터뱅크 / 창 ----------------
  const hzToMel = hz => 2595 * Math.log10(1 + hz / 700), melToHz = m => 700 * (Math.pow(10, m / 2595) - 1);
  const NB = FFT_SIZE / 2 + 1;
  const BANK = (() => {
    const lo = hzToMel(80), hi = hzToMel(7800), pts = [];
    for (let i = 0; i < BANDS + 2; i++) pts.push(melToHz(lo + (hi - lo) * i / (BANDS + 1)));
    const bank = []; // 행마다 [startBin, weights]
    for (let b = 0; b < BANDS; b++) {
      const [l, c, r] = [pts[b], pts[b + 1], pts[b + 2]]; const row = new Float64Array(NB); let tot = 0;
      for (let k = 0; k < NB; k++) { const hz = k * SAMPLE_RATE / FFT_SIZE; const v = Math.max(0, Math.min((hz - l) / (c - l), (r - hz) / (r - c))); row[k] = Math.fround(v); }
      for (let k = 0; k < NB; k++) tot += row[k];
      if (tot > 0) for (let k = 0; k < NB; k++) row[k] = Math.fround(row[k] / tot);
      let s = 0, e = NB - 1; while (s < NB && row[s] === 0) s++; while (e > s && row[e] === 0) e--;
      bank.push({ s, w: row.slice(s, e + 1) });
    }
    return bank;
  })();
  const WINDOW = (() => { const w = new Float64Array(FFT_SIZE); for (let i = 0; i < FFT_SIZE; i++) w[i] = Math.fround(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1))); return w; })();

  // ---------------- extract / trim / scan ----------------
  function extract(x, reduceBackground, noiseStrength) {
    const n = x.length, count = Math.max(1, Math.floor((n + HOP - 1) / HOP) + 1);
    const rawRms = new Float32Array(count), bandPower = new Float64Array(count * BANDS), spectra = new Float32Array(count * BANDS);
    const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
    for (let f = 0; f < count; f++) {
      const start = f * HOP - FFT_SIZE / 2; let ss = 0;
      for (let i = 0; i < FFT_SIZE; i++) { const j = start + i; const v = (j >= 0 && j < n) ? x[j] : 0; ss += v * v; re[i] = Math.fround(v * WINDOW[i]); im[i] = 0; }
      rawRms[f] = Math.sqrt(ss / FFT_SIZE);
      fft(re, im, false);
      const off = f * BANDS;
      for (let b = 0; b < BANDS; b++) { const { s, w } = BANK[b]; let acc = 0; for (let k = 0; k < w.length; k++) { const kk = s + k; acc += w[k] * Math.fround(re[kk] * re[kk] + im[kk] * im[kk]); } bandPower[off + b] = Math.fround(acc); }
    }
    let rms = rawRms;
    if (reduceBackground && count) {
      const quietCut = quantile(rawRms, 0.2), thr = Math.max(quietCut, 1e-9);
      const quietIdx = []; for (let f = 0; f < count; f++) if (rawRms[f] <= thr) quietIdx.push(f);
      const noiseRms = quietIdx.length ? median(quietIdx.map(f => rawRms[f])) : 0;
      rms = new Float32Array(count);
      for (let f = 0; f < count; f++) rms[f] = Math.sqrt(Math.max(rawRms[f] * rawRms[f] - noiseRms * noiseRms, 0));
      const profile = new Float64Array(BANDS);
      if (quietIdx.length) for (let b = 0; b < BANDS; b++) profile[b] = median(quietIdx.map(f => bandPower[f * BANDS + b]));
      const strength = noiseStrength == null ? NOISE_OVER_SUBTRACTION : Math.max(0, noiseStrength);
      for (let f = 0; f < count; f++) for (let b = 0; b < BANDS; b++) { const i = f * BANDS + b; bandPower[i] = Math.max(bandPower[i] - strength * profile[b], bandPower[i] * 0.025); }
    }
    const v = new Float64Array(BANDS);
    for (let f = 0; f < count; f++) {
      const off = f * BANDS; let mean = 0; for (let b = 0; b < BANDS; b++) mean += bandPower[off + b]; mean /= BANDS;
      if (mean <= 1e-24) continue;
      let m2 = 0; for (let b = 0; b < BANDS; b++) { v[b] = Math.log1p(20 * bandPower[off + b] / mean); m2 += v[b]; } m2 /= BANDS;
      let nn = 0; for (let b = 0; b < BANDS; b++) { v[b] -= m2; nn += v[b] * v[b]; } nn = Math.sqrt(nn);
      if (nn > 1e-18) for (let b = 0; b < BANDS; b++) spectra[off + b] = v[b] / nn;
    }
    let peak = 0; for (let f = 0; f < count; f++) if (rms[f] > peak) peak = rms[f];
    return { rms, spectrum: spectra, peakRms: peak, startFrame: 0 };
  }

  function trimReference(f) {
    const n = f.rms.length; if (!n) return { rms: new Float32Array(0), spectrum: new Float32Array(0), peakRms: 0, startFrame: 0 };
    let left = 0, right = n - 1; // 원본의 게이트 비교는 항상 참 → 전체 프레임
    if (right - left + 1 > 300) {
      const cs = new Float64Array(n + 1); for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + f.rms[i] * f.rms[i];
      let best = -1, bi = 0; for (let i = 0; i + 300 <= n; i++) { const s = cs[i + 300] - cs[i]; if (s > best) { best = s; bi = i; } }
      left += bi; right = left + 299;
    }
    const rms = f.rms.slice(left, right + 1), spectrum = f.spectrum.slice(left * BANDS, (right + 1) * BANDS);
    let peak = 0; for (const r of rms) if (r > peak) peak = r;
    return { rms, spectrum, peakRms: peak, startFrame: left };
  }

  function scan(ref, inp, backgroundRms) {
    const n = inp.rms.length, rn = ref.rms.length;
    if (rn < 2 || n < rn) return [0, 0];
    let refEnergy = 0, refWeight = 0, peakIdx = 0;
    for (let i = 0; i < rn; i++) { refEnergy += ref.rms[i] * ref.rms[i]; refWeight += ref.rms[i]; if (ref.rms[i] > ref.rms[peakIdx]) peakIdx = i; }
    if (refEnergy < 1e-18 || refWeight < 1e-12) return [0, 0];
    const peakGate = Math.max(1e-9, backgroundRms * 1.65, inp.peakRms * 0.025);
    const margin = Math.min(2, Math.floor(rn / 10)), maxoff = n - rn + margin, step = rn < 10 ? 2 : 4;
    let best = 0, bestOff = 0; const top = [];
    function evaluate(off) {
      const pi = off + peakIdx;
      if (pi < 0 || pi >= n || inp.rms[pi] < peakGate) return 0;
      const lo = Math.max(0, -off), hi = Math.min(rn, n - off);
      let renergy = 0, ienergy = 0, rdot = 0, imax = 0, spectral = 0, live = 0;
      for (let i = lo; i < hi; i++) {
        const ir = inp.rms[i + off]; if (!(ir > 0)) continue; live++;
        const rr = ref.rms[i];
        renergy += rr * rr; ienergy += ir * ir; rdot += rr * ir; if (ir > imax) imax = ir;
        const ro = i * BANDS, io = (i + off) * BANDS; let d = 0;
        for (let b = 0; b < BANDS; b++) d += ref.spectrum[ro + b] * inp.spectrum[io + b];
        if (d > 0) spectral += rr * d;
      }
      if (!live) return 0;
      if (renergy < refEnergy * 0.97 || ienergy < 1e-18) return 0;
      if (backgroundRms > 0 && imax < backgroundRms * 1.65) return 0;
      spectral /= refWeight;
      const rmsCorr = rdot / Math.sqrt(refEnergy * ienergy);
      const score = Math.min(1, Math.max(0, spectral * (0.65 + 0.35 * rmsCorr)));
      if (score > best) { best = score; bestOff = off; }
      return score;
    }
    for (let off = -margin; off <= maxoff; off += step) top.push([evaluate(off), off]);
    top.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
    for (const [, center] of top.slice(0, 3))
      for (let off = Math.max(-margin, center - step + 1); off <= Math.min(maxoff, center + step - 1); off++) evaluate(off);
    return [best, bestOff];
  }

  function hasBroadband(samples) {
    let n = 1; while (n < samples.length) n <<= 1;
    const re = new Float64Array(n), im = new Float64Array(n); re.set(samples); fft(re, im, false);
    const groups = new Float64Array(64); let total = 0;
    for (let i = 1; i < n / 2 + 1; i++) groups[Math.min(63, Math.floor(i * 128 / n))] += re[i] * re[i] + im[i] * im[i];
    let mx = 0; for (const g of groups) { total += g; if (g > mx) mx = g; }
    return total > 0 && mx / total < 0.8;
  }

  // ---------------- WAV 디코더 (PCM16/24/32, float32) ----------------
  function decodeWav(buf) {
    const dv = new DataView(buf); let p = 12, fmt = null, data = null;
    while (p + 8 <= dv.byteLength) {
      const id = String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3)), size = dv.getUint32(p + 4, true);
      if (id === "fmt ") fmt = { format: dv.getUint16(p + 8, true), ch: dv.getUint16(p + 10, true), sr: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
      else if (id === "data") data = { off: p + 8, size: Math.min(size, dv.byteLength - p - 8) };
      p += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error("WAV 형식을 읽을 수 없음");
    const bps = fmt.bits / 8, frames = Math.floor(data.size / (bps * fmt.ch)), y = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < fmt.ch; c++) {
        const o = data.off + (i * fmt.ch + c) * bps; let v;
        if (fmt.format === 3 && fmt.bits === 32) v = dv.getFloat32(o, true);
        else if (fmt.bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (fmt.bits === 24) { let t = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16); v = t / 8388608; }
        else if (fmt.bits === 32) v = dv.getInt32(o, true) / 2147483648;
        else if (fmt.bits === 8) v = (dv.getUint8(o) - 128) / 128;
        else throw new Error("지원하지 않는 비트 깊이");
        s += Math.fround(v);
      }
      y[i] = s / fmt.ch;
    }
    return resamplePoly(y, fmt.sr, SAMPLE_RATE);
  }

  // ---------------- SoundMatcher ----------------
  class SoundMatcher {
    constructor(database) { this.database = database; this.templates = []; this.errors = []; this.lastReason = ""; }
    // wavs: [{file, buffer(ArrayBuffer)}] — 원본과 같은 3단계 순서로 로드
    loadTemplates(wavs) {
      const byFile = new Map(wavs.map(w => [w.file, w.buffer])); const seen = new Set(), db = this.database;
      const itemNames = new Set((db.items || []).map(i => i.name)), special = new Set((db.special_items || []).map(i => i.name));
      for (const s of db.sounds || []) { const fn = s.file || (s.name + ".wav"); if (byFile.has(fn) && !seen.has(fn)) { this.addTemplate(fn, byFile.get(fn), "normal", s.name || ""); seen.add(fn); } }
      for (const it of db.special_items || []) { const fn = it.sound_file || it.sound; if (fn && byFile.has(fn) && !seen.has(fn)) { this.addTemplate(fn, byFile.get(fn), "special", it.name || ""); seen.add(fn); } }
      for (const [fn, buf] of byFile) { if (seen.has(fn)) continue; const stem = fn.replace(/\.wav$/i, ""); this.addTemplate(fn, buf, special.has(stem) ? "special" : itemNames.has(stem) ? "item" : "normal", stem); seen.add(fn); }
      return this;
    }
    addTemplate(file, buffer, kind, key) {
      try {
        const samples = decodeWav(buffer); const original = extract(samples, false), feat = trimReference(original);
        if (samples.length < 64 || feat.rms.length < 2 || original.peakRms < MIN_PEAK_RMS) return;
        const hp = highpass(samples); const filtered = trimReference(extract(hp, false));
        const broadband = hasBroadband(samples);
        let wf = Float32Array.from(hp); let mean = 0; for (const v of wf) mean += v; mean /= wf.length; for (let i = 0; i < wf.length; i++) wf[i] -= mean;
        if (wf.length > SAMPLE_RATE * 1.5) wf = wf.slice(0, SAMPLE_RATE * 1.5);
        let nn = 0; for (const v of wf) nn += v * v;
        const N = MIXED_WAVEFORM_FFT_SIZE, re = new Float64Array(N), im = new Float64Array(N); re.set(wf); fft(re, im, false);
        this.templates.push({ key, kind, name: key, file, features: feat, filteredFeatures: filtered, broadband, waveform: wf, waveformNorm: Math.sqrt(nn), wsRe: Float32Array.from(re), wsIm: Float32Array.from(im) });
      } catch (e) { this.errors.push(file + ": " + e.message); }
    }
    rank(inp, bg, filtered) {
      const best = new Map();
      for (const t of this.templates) {
        if (filtered && !t.broadband) continue;
        const ref = filtered ? t.filteredFeatures : t.features; if (ref.rms.length < 2) continue;
        const [score, off] = scan(ref, inp, bg); const k = t.kind + "|" + t.key, old = best.get(k);
        if (!old || score > old.score) best.set(k, { key: t.key, kind: t.kind, score, offset: off, offset_seconds: off * HOP / SAMPLE_RATE });
      }
      return [...best.values()].sort((a, b) => b.score - a.score);
    }
    waveformRank(samples) {
      const x = highpass(samples); let mean = 0; for (const v of x) mean += v; mean /= x.length || 1; for (let i = 0; i < x.length; i++) x[i] -= mean;
      if (!x.length) return [];
      const energy = new Float64Array(x.length + 1); for (let i = 0; i < x.length; i++) energy[i + 1] = energy[i] + x[i] * x[i];
      const N = MIXED_WAVEFORM_FFT_SIZE; const maxT = Math.max(0, ...this.templates.map(t => t.waveform.length));
      const cached = x.length <= 40000 && maxT + x.length - 1 <= N;
      let xr, xi; if (cached) { xr = new Float64Array(N); xi = new Float64Array(N); xr.set(x); fft(xr, xi, false); }
      const best = new Map(); const re = new Float64Array(N), im = new Float64Array(N);
      for (const t of this.templates) {
        const rn = t.waveform.length; if (rn < 64 || rn > x.length || t.waveformNorm <= 1e-12) continue;
        const L = x.length - rn + 1; let corr;
        if (cached) {
          for (let i = 0; i < N; i++) { const a = xr[i], b = xi[i], c = t.wsRe[i], d = -t.wsIm[i]; re[i] = a * c - b * d; im[i] = a * d + b * c; }
          fft(re, im, true); corr = re.subarray(0, L);
        } else { corr = new Float64Array(L); for (let p = 0; p < L; p++) { let s = 0; for (let j = 0; j < rn; j++) s += x[p + j] * t.waveform[j]; corr[p] = s; } }
        let pos = 0, mx = -1; for (let i = 0; i < L; i++) { const a = Math.abs(corr[i]); if (a > mx) { mx = a; pos = i; } }
        const le = Math.max(1e-20, energy[pos + rn] - energy[pos]);
        const score = mx / (Math.sqrt(le) * t.waveformNorm); const k = t.kind + "|" + t.key, old = best.get(k);
        if (!old || score > old.score) best.set(k, { key: t.key, kind: t.kind, score, offset: pos, offset_seconds: pos / SAMPLE_RATE });
      }
      return [...best.values()].sort((a, b) => b.score - a.score);
    }
    // 원본 match() — 이유 문자열은 한국어로 옮김
    match(samples, sr, limit = MAX_CANDIDATES, backgroundRms = 0) {
      let x = sr !== SAMPLE_RATE ? resamplePoly(samples, sr, SAMPLE_RATE) : Float32Array.from(samples);
      if (x.length < 128) { this.lastReason = "오디오 구간이 너무 짧습니다."; return []; }
      if (x.length > 192000) { this.lastReason = "오디오는 12초 이하 구간으로 나눠 주세요."; return []; }
      const inp = extract(x, true);
      if (inp.peakRms < MIN_PEAK_RMS) { this.lastReason = "충분히 뚜렷한 소리가 감지되지 않았습니다."; return []; }
      if (x.length >= 8000) {
        const ord = Float32Array.from(inp.rms).sort(); const q = ord[Math.min(ord.length - 1, Math.floor(ord.length / 5))];
        if (q > 0 && inp.peakRms < q * 1.8) { this.lastReason = "소리가 계속 이어지고 짧은 효과음이 뚜렷하지 않아 판단을 보류합니다."; return []; }
      }
      const lim2 = Math.max(2, limit);
      let ranked = this.rank(inp, backgroundRms, false).slice(0, lim2);
      const rawScore = ranked.length ? ranked[0].score : 0;
      let selFiltered = false, selThreshold = MIN_SIMILARITY;
      const shouldFilter = backgroundRms >= 0.0004 || rawScore < MIN_SIMILARITY;
      if (shouldFilter && x.length >= 640 && x.length <= 48000) {
        const hp = highpass(x);
        const filtered = this.rank(extract(hp, true), 0, true).slice(0, lim2);
        if (filtered.length) {
          const fs = filtered[0].score, fm = filtered.length > 1 ? fs - filtered[1].score : 1;
          const normal = fs >= FILTERED_MIN_SIMILARITY;
          const adaptive = backgroundRms >= ADAPTIVE_NOISE_FLOOR && fs >= ADAPTIVE_FILTERED_MIN_SIMILARITY && fm >= ADAPTIVE_MIN_MARGIN;
          if ((normal || adaptive) && (backgroundRms >= 0.0004 || !ranked.length || fs > rawScore)) {
            ranked = filtered; selFiltered = true; selThreshold = normal ? FILTERED_MIN_SIMILARITY : ADAPTIVE_FILTERED_MIN_SIMILARITY;
          }
        }
        if (!selFiltered && backgroundRms >= ADAPTIVE_NOISE_FLOOR) {
          const gentle = this.rank(extract(hp, true, GENTLE_NOISE_SUBTRACTION), 0, true).slice(0, lim2);
          if (gentle.length) {
            const gs = gentle[0].score, gm = gentle.length > 1 ? gs - gentle[1].score : 1;
            if (gs >= GENTLE_FILTERED_MIN_SIMILARITY && gm >= GENTLE_MIN_MARGIN) { ranked = gentle; selFiltered = true; selThreshold = GENTLE_FILTERED_MIN_SIMILARITY; }
          }
        }
      }
      if (!selFiltered) {
        const wave = this.waveformRank(x).slice(0, lim2);
        if (wave.length) {
          const wm = wave.length > 1 ? wave[0].score - wave[1].score : 1;
          if (wave[0].score >= MIXED_WAVEFORM_MIN_CORRELATION && wm >= MIXED_WAVEFORM_MIN_MARGIN) { ranked = wave; selFiltered = true; selThreshold = MIXED_WAVEFORM_MIN_CORRELATION; }
        }
      }
      const threshold = selFiltered ? selThreshold : MIN_SIMILARITY;
      if (!ranked.length || ranked[0].score < threshold) { this.lastReason = "참조 샘플과 충분히 비슷하지 않습니다. 모르는 효과음이나 배경음일 수 있습니다."; return []; }
      const ambiguous = ranked.length > 1 && ranked[0].score - ranked[1].score < AMBIGUITY_MARGIN;
      this.lastReason = ambiguous ? "여러 소리 그룹의 유사도가 비슷합니다. 아래 후보는 칸 수나 화면을 보고 판단하세요."
                                  : "소리 그룹을 찾았습니다. 그룹 안의 물건은 같은 소리를 낼 수 있고, 유사도는 출현 확률이 아닙니다.";
      return ranked.slice(0, limit).map(row => this.rowOut(row));
    }
    rowOut(row) {
      const db = this.database; let items;
      if (row.kind === "special") items = (db.special_items || []).filter(i => i.name === row.key);
      else if (row.kind === "item") items = (db.items || []).filter(i => i.name === row.key);
      else { items = (db.items || []).filter(i => i.sound_type === row.key); if (!items.length) items = [{ name: row.key, sound_type: row.key }]; }
      return { key: row.key, kind: row.kind, score: Math.trunc(row.score * 100), offset: row.offset | 0, offset_seconds: row.offset_seconds, items, reason: "매칭됨. 유사도는 출현 확률이 아닙니다." };
    }
    // main._weak_candidates (--show-weak): 임계값 미달일 때 가장 비슷한 후보 참고용
    weakCandidates(samples, sr, limit, bg) {
      const x = sr !== SAMPLE_RATE ? resamplePoly(samples, sr, SAMPLE_RATE) : Float32Array.from(samples);
      if (x.length < 128) return [];
      let rows = this.rank(extract(x, true), bg, false);
      if (x.length >= 640 && x.length <= 48000) rows = rows.concat(this.rank(extract(highpass(x), true), 0, true));
      const best = new Map(); for (const r of rows) if (!best.has(r.key) || r.score > best.get(r.key).score) best.set(r.key, r);
      return [...best.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit)).map(r => this.rowOut(r));
    }
  }

  // ---------------- candidates.py (CandidateEngine) ----------------
  const ORIENT_ALIASES = { H: "横", h: "横", "横": "横", horizontal: "横", V: "竖", v: "竖", "竖": "竖", vertical: "竖", "": "正", "正": "正", normal: "正", N: "正", n: "正" };
  const normOrient = v => { if (v == null) return ""; const t = String(v).trim(); return t in ORIENT_ALIASES ? ORIENT_ALIASES[t] : t; };
  function parseRef(raw) {
    if (raw == null) return [null, ""]; if (typeof raw === "number") return [raw, String(raw)];
    const text = String(raw).trim(); if (!text) return [null, ""];
    const cleaned = text.replace(/[,，]/g, ""); if (/^-?\d+(\.\d+)?$/.test(cleaned)) return [Number(cleaned), text];
    const m = cleaned.match(/-?\d+(?:\.\d+)?/); return [m ? Number(m[0]) : null, text];
  }
  const toInt = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d; };
  class CandidateEngine {
    constructor(db) { this.items = db.items || []; this.special = db.special_items || []; this.index = new Map(); for (const r of this.items.concat(this.special)) { const n = String(r.name || "").trim(); if (!n) continue; if (!this.index.has(n)) this.index.set(n, []); this.index.get(n).push(r); } this.history = []; }
    lookup(n) { const r = this.index.get(String(n || "").trim()); return r ? r[0] : null; }
    resolve(matchRows) { // slots=0, orientation="" (비전 없음) → 원본과 동일하게 소프트 우선순위 없음
      const raw = [];
      for (const mr of matchRows || []) {
        const score = Math.max(0, Math.min(100, toInt(mr.score)));
        for (const it of mr.items || []) {
          const name = String((it && it.name) || "").trim(); if (!name) continue;
          const row = this.lookup(name); if (!row) continue; // 일반 그룹의 자리표시자 행
          const [rv, rt] = parseRef(row.reference_value);
          raw.push({ name, quality: String(row.quality || ""), category: String(row.category || ""), slot: toInt(row.slot), orientation: String(row.orientation || ""), reference_value: rv, reference_value_text: rt, image: String(row.image || ""), score, sound_key: mr.key, special: !!row.special });
        }
      }
      const best = new Map(); for (const c of raw) { const cur = best.get(c.name); if (!cur || c.score > cur.score) best.set(c.name, c); }
      const out = [...best.values()];
      out.sort((a, b) => (b.score - a.score) || ((b.reference_value ?? -1) - (a.reference_value ?? -1)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return out;
    }
    filter(cands, quality, category, orientation, minScore) {
      const wo = orientation ? normOrient(orientation) : "";
      return cands.filter(c => (!quality || c.quality === quality) && (!category || c.category === category) && (!wo || normOrient(c.orientation) === wo) && c.score >= (minScore || 0));
    }
  }

  // ---------------- recorder.py 보조 함수 (캡처 샘플레이트 sr 기준) ----------------
  function backgroundLevel(x, sr) { const fr = Math.max(1, Math.floor(sr / 50)), n = Math.floor(x.length / fr); if (!n) return 0; const lv = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < fr; j++) { const v = x[i * fr + j]; s += v * v; } lv[i] = Math.sqrt(s / fr); } return quantile(lv, 0.2); }
  function zeroRuns(x) { const runs = []; let s = -1; for (let i = 0; i <= x.length; i++) { const z = i < x.length && x[i] === 0; if (z && s < 0) s = i; if (!z && s >= 0) { runs.push([s, i]); s = -1; } } return runs; }
  function zeroGapCount(x, sr) { let all = true; for (const v of x) if (v !== 0) { all = false; break; } if (all || !x.length) return 0; const mf = Math.max(1, Math.floor(sr * 0.006)); return zeroRuns(x).filter(([s, e]) => s > 0 && e < x.length && e - s >= mf).length; }
  function longestNonzeroSegment(x, sr) { const runs = zeroRuns(x); if (!runs.length) return null; let bl = 0, bs = 0, be = 0, cur = 0; for (const [s, e] of runs.concat([[x.length, x.length]])) { if (s > cur && s - cur > bl) { bl = s - cur; bs = cur; be = s; } cur = Math.max(cur, e); } return bl < Math.floor(sr * 0.25) ? null : x.slice(bs, be); }

  return { SAMPLE_RATE, SoundMatcher, CandidateEngine, extract, resamplePoly, highpass, decodeWav, backgroundLevel, zeroGapCount, longestNonzeroSegment, quantile };
}
if (typeof module !== "undefined" && module.exports) module.exports = MH_FACTORY();
else if (typeof self !== "undefined") self.MH = MH_FACTORY();
