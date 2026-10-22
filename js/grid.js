/* 화물 격자 읽기: 화면 프레임(오른쪽 절반, 높이 720 기준 회색조)에서 상인 화물 격자를 찾는다.
   고정 좌표를 쓰지 않고 얇은 밝은 선(칸 테두리)을 찾아 간격(칸 크기)을 추정한다. */
(function (root) {
  "use strict";
  function lineMaps(g, w, h) {
    const V = new Uint8Array(w * h), H = new Uint8Array(w * h);
    for (let y = 3; y < h - 3; y++) for (let x = 3; x < w - 3; x++) {
      const i = y * w + x, v = g[i]; if (v < 28) continue;
      const l = Math.max(g[i - 2], g[i - 3]) , r = Math.max(g[i + 2], g[i + 3]);
      if (v - l >= 18 && v - r >= 18 && g[i - 1] < v + 40) V[i] = 1;
      const u = Math.max(g[i - 2 * w], g[i - 3 * w]), d = Math.max(g[i + 2 * w], g[i + 3 * w]);
      if (v - u >= 18 && v - d >= 18) H[i] = 1;
    }
    return { V, H };
  }
  function peaks(p, thr) { const out = []; for (let i = 1; i < p.length - 1; i++) if (p[i] >= thr && p[i] >= p[i - 1] && p[i] > p[i + 1]) out.push(i); return out; }
  // 등간격으로 이어지는 가장 긴 선 묶음
  function chain(pk, pmin, pmax, fixedP) {
    let best = null;
    for (let a = 0; a < pk.length; a++) for (let b = a + 1; b < pk.length; b++) {
      const p = pk[b] - pk[a]; if (p < pmin) continue; if (p > pmax) break;
      if (fixedP && Math.abs(p - fixedP) > 2.5) continue;
      const seq = [pk[a], pk[b]]; let last = pk[b], step = p;
      let gaps = 0, n = 1;
      for (;;) { let f = -1, k = 1; for (; k <= 2 && f < 0; k++) { const want = last + step * k; for (const q of pk) if (Math.abs(q - want) <= 2.5) { f = q; break; } } if (f < 0) break; k--; if (k > 1) { gaps++; if (gaps > 2) break; } n += k; seq.push(f); step = (f - seq[0]) / n; last = f; }
      seq.n = n; if (!best || n > best.n || (n === best.n && seq.length > best.length)) best = seq;
    }
    if (!best || best.length < 3) return null;
    const p = (best[best.length - 1] - best[0]) / best.n;
    return { start: best[0], p, n: best.n };
  }
  function frac(M, w, x0, x1, y0, y1, horiz) { // 선 존재 비율 (±2 px 허용)
    let hit = 0, tot = 0;
    if (!horiz) { for (let y = y0; y < y1; y++) { tot++; let f = 0; for (let x = x0 - 2; x <= x0 + 2; x++) if (M[y * w + x]) { f = 1; break; } hit += f; } }
    else { for (let x = x0; x < x1; x++) { tot++; let f = 0; for (let y = y0 - 2; y <= y0 + 2; y++) if (M[y * w + x]) { f = 1; break; } hit += f; } }
    return tot ? hit / tot : 0;
  }
  function fill(g, w, x0, x1, y0, y1, t) { let s = 0, n = 0; for (let y = y0 | 0; y < y1; y++) for (let x = x0 | 0; x < x1; x++) { if (g[y * w + x] >= t) s++; n++; } return n ? s / n : 0; }
  function mean(g, w, x0, x1, y0, y1) { let s = 0, n = 0; for (let y = y0 | 0; y < y1; y++) for (let x = x0 | 0; x < x1; x++) { s += g[y * w + x]; n++; } return n ? s / n : 0; }

  function detect(g, w, h) {
    const { V, H } = lineMaps(g, w, h);
    const S = h / 720, pmin = 26 * S, pmax = 70 * S;
    const col = new Float32Array(w); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) col[x] += V[y * w + x];
    const cx = chain(peaks(col, h * 0.1), pmin, pmax); if (!cx || cx.n < 4) return null;
    const refine = (proj, st, pp, n) => { let bo = 0, bs = -1; for (let o = -4; o <= 4; o++) { let sc = 0; for (let k = 0; k <= n; k++) { const q = Math.round(st + o + k * pp); if (q >= 0 && q < proj.length) sc += proj[q]; } if (sc > bs) { bs = sc; bo = o; } } return st + bo; };
    cx.start = refine(col, cx.start, cx.p, cx.n);
    const p = cx.p, gx0 = Math.round(cx.start), gx1 = Math.round(cx.start + cx.n * p);
    const row = new Float32Array(h); for (let y = 0; y < h; y++) { let s = 0; for (let x = gx0; x < gx1; x++) s += H[y * w + x]; row[y] = s; }
    const cy = chain(peaks(row, (gx1 - gx0) * 0.25), pmin, pmax, p); if (!cy || cy.n < 2) return null;
    cy.start = refine(row, cy.start, cy.p, cy.n);
    let r0 = 0, r1 = cy.n; const band = r => { let ok = 0; for (let c = 0; c <= cx.n; c++) if (frac(V, w, Math.round(cx.start + c * p), 0, Math.round(cy.start + r * cy.p + 4), Math.round(cy.start + (r + 1) * cy.p - 4), false) > 0.6) ok++; return ok >= 3; };
    while (r0 < r1 && !band(r0)) r0++; while (r1 > r0 && !band(r1 - 1)) r1--; if (r1 - r0 < 2) return null;
    const ncol = cx.n, nrow = r1 - r0, py = cy.p, gy0 = cy.start + r0 * cy.p;
    const X = c => Math.round(gx0 + c * p), Y = r => Math.round(gy0 + r * py);
    const val = [], occ = [];
    // 빈 칸은 거의 검정(4~5), 화물 칸은 회색(15~17). 글자/채팅이 겹쳐도 되도록 '밝은 픽셀 비율'로 판단
    for (let r = 0; r < nrow; r++) for (let c = 0; c < ncol; c++) { const v = fill(g, w, X(c) + p * .15, X(c + 1) - p * .15, Y(r) + py * .15, Y(r + 1) - py * .15, 10); val.push(v); occ.push(v >= 0.55); }
    // 테두리 선이 없으면 같은 화물
    const par = val.map((_, i) => i); const find = i => par[i] === i ? i : (par[i] = find(par[i]));
    for (let r = 0; r < nrow; r++) for (let c = 0; c < ncol; c++) {
      const i = r * ncol + c; if (!occ[i]) continue;
      if (c + 1 < ncol && occ[i + 1] && frac(V, w, X(c + 1), 0, Math.round(Y(r) + py * .15), Math.round(Y(r + 1) - py * .15), false) < 0.35) par[find(i + 1)] = find(i);
      if (r + 1 < nrow && occ[i + ncol] && frac(H, w, Math.round(X(c) + p * .15), Math.round(X(c + 1) - p * .15), Y(r + 1), 0, true) < 0.35) par[find(i + ncol)] = find(i);
    }
    const comps = new Map();
    for (let i = 0; i < val.length; i++) if (occ[i]) { const k = find(i), c = i % ncol, r = (i / ncol) | 0; const o = comps.get(k) || { c0: c, c1: c, r0: r, r1: r, n: 0 }; o.c0 = Math.min(o.c0, c); o.c1 = Math.max(o.c1, c); o.r0 = Math.min(o.r0, r); o.r1 = Math.max(o.r1, r); o.n++; comps.set(k, o); }
    const cargos = [...comps.values()].map(o => ({ c: o.c0, r: o.r0, w: o.c1 - o.c0 + 1, h: o.r1 - o.r0 + 1, rect: o.n === (o.c1 - o.c0 + 1) * (o.r1 - o.r0 + 1), edge: o.r0 === 0 || o.r1 === nrow - 1 }));
    const dark = [], text = [];
    for (let r = 0; r < nrow; r++) for (let c = 0; c < ncol; c++) { dark.push(fill(g, w, X(c) + 3, X(c + 1) - 3, Y(r) + 3, Y(r + 1) - 3, 13) ); text.push(fill(g, w, X(c) + 3, X(c + 1) - 3, Y(r) + 3, Y(r + 1) - 3, 150)); }
    for (let i = 0; i < dark.length; i++) dark[i] = 1 - dark[i];
    // 스크롤 추적용 세로 프로필
    const prof = new Float32Array(h); for (let y = 0; y < h; y++) { let s = 0; for (let x = gx0; x < gx1; x += 2) s += g[y * w + x]; prof[y] = s / ((gx1 - gx0) / 2); }
    return { gx0, gy0, p, py, ncol, nrow, occ, val, dark, text, cargos, prof, w, h };
  }

  // 여러 프레임을 하나의 전체 격자로 합침 (스크롤 추적 + 프레임 투표로 깜빡임 제거)
  class GridTracker {
    constructor() { this.reset(); }
    reset() { this.cells = new Map(); this.obs = new Map(); this.manual = new Map(); this.items = new Map(); this.base = null; this.scroll = 0; this.prev = null; this.ncol = 0; this.hover = null; this.hoverT = -1e9; this.drag = null; this.dragT = -1e9; this.lostT = null; this.lastOff = undefined; this.bad = 0; this.changedScreen = false; this.frames = 0; this.seen = 0; this._list = null; }
    shift(a, b, y0, y1) {
      const span = y1 - y0, lim = Math.round(span * 0.75); let best = 0, bs = 1e9;
      for (let d = -lim; d <= lim; d++) { let s = 0, n = 0; for (let y = y0; y < y1; y += 1) { const z = y + d; if (z < y0 || z >= y1) continue; s += Math.abs(a[y] - b[z]); n++; } if (n < span * 0.3) continue; const m = s / n + Math.abs(d) * 0.002; if (m < bs) { bs = m; best = d; } }
      return best;
    }
    stableOcc(key) { const o = this.cells.get(key); return o ? o.s > 1.5 : false; }
    push(det, t, g) {
      this.frames++;
      if (!det) { if (this.lostT === null) this.lostT = t; this.prev = null; return null; }
      // 화물창이 5초 넘게 안 보였다가 다시 나오면 새 화물창으로 보고 자동 초기화 (수동 기록이 없을 때만)
      if (this.lostT !== null && t - this.lostT > 5 && !this.manual.size && !this.items.size) this.reset();
      this.lostT = null; this.seen++;
      const pv = this.prev;
      if (pv && Math.abs(pv.p - det.p) < 2 && Math.abs(pv.gx0 - det.gx0) < 4 && pv.ncol === det.ncol) {
        const y0 = Math.max(0, Math.round(Math.min(det.gy0, pv.gy0))), y1 = Math.min(det.h - 2, Math.round(Math.max(det.gy0 + det.nrow * det.py, pv.gy0 + pv.nrow * pv.py)));
        // 칸 경계 위치가 같으면(스크롤 안 함) 0, 아니면 프로필 비교
        this.scroll -= this.shift(pv.prof, det.prof, y0, y1);
      } else if (pv === null && this.base !== null && (this.ncol !== det.ncol)) this.reset();
      if (this.base === null) { this.base = det.gy0; this.scroll = 0; }
      this.ncol = Math.max(this.ncol, det.ncol);
      const est = Math.round((det.gy0 + this.scroll - this.base) / det.py);
      // 정수 줄 오프셋 확정: 이미 기록된 칸과 가장 잘 맞는 위치 (스크롤 안 했으면 이전 위치 우대)
      let still = est; if (pv && this.lastOff !== undefined) still = this.lastOff + Math.round((det.gy0 - pv.gy0) / det.py);
      let off = est, bestSc = -1e9, bestMis = 0, bestN = 0; const [lo, hi] = this.rows(); this._sn = 0; this._sm = 0;
      for (let k = lo - det.nrow + 2; k <= hi - 1; k++) {
        let sc = 0, n = 0, mis = 0;
        for (let r = 0; r < det.nrow; r++) for (let c = 0; c < det.ncol; c++) { const o = this.cells.get((r + k) + "," + c); if (!o || Math.abs(o.s) < 2) continue; const now = !!det.occ[r * det.ncol + c]; if (o.s < 0 && !now) { sc += 0.1; continue; } n++; if ((o.s > 0) === now) sc++; else { sc--; mis++; } }
        if (k === still) { this._sn = n; this._sm = mis; }
        sc += (k === still ? 3 : 0) + (k === est ? 1.5 : 0);
        if (sc > bestSc) { bestSc = sc; off = k; bestMis = mis; bestN = n; }
      }
      if (lo > hi) off = est;
      // 화면이 바뀜(다른 상인/판매 화면): 기록과 크게 어긋나는 프레임이 이어지면 초기화
      if ((bestN >= 10 && bestMis / bestN > 0.4) || (this._sn >= 10 && this._sm / this._sn > 0.4 && (est === still || bestN < this._sn * 0.5))) { this.bad = (this.bad || 0) + 1; if (this.bad >= 3) { if (!this.manual.size && !this.items.size) { this.reset(); return this.push(det, t, g); } this.changedScreen = true; } this.prev = det; return det; }
      // 칸이 다 차 있어도 화물 나뉨(크기·위치)이 기록과 많이 다르면 다른 화면
      { let same = 0, diff = 0; for (const k of det.cargos) { if (k.rect === false || k.edge) continue; const r = k.r + off; let hit = false, clash = false; for (const q of this.obs.values()) { if (q.n < 4) continue; if (q.c === k.c && q.r === r && q.w === k.w && q.h === k.h) hit = true; else if (q.c < k.c + k.w && k.c < q.c + q.w && q.r < r + k.h && r < q.r + q.h) clash = true; } if (hit) same++; else if (clash) diff++; }
        if (diff >= 5 && diff > same) { this.bad = (this.bad || 0) + 1; if (this.bad >= 3) { if (!this.manual.size && !this.items.size) { this.reset(); return this.push(det, t, g); } this.changedScreen = true; } this.prev = det; return det; } }
      this.bad = 0; this.changedScreen = false;
      this.scroll += (off - est) * det.py; this.lastOff = off;
      det.rowOff = off; this.prev = det;
      // 1) 바뀐 칸 찾기: 전에 화물이던 칸이 지금 어두움 → 툴팁에 가려졌거나 드래그로 비었음
      const changed = [], ncol = det.ncol; let txt = 0;
      for (let r = 0; r < det.nrow; r++) for (let c = 0; c < ncol; c++) { const i = r * ncol + c, key = (r + off) + "," + c; if (!det.occ[i] && this.stableOcc(key)) { changed.push([c, r]); txt += det.text[i]; } }
      let hoverCell = null, dragged = null;
      if (changed.length) {
        if (txt / changed.length > 0.015 && g) hoverCell = this.cursorCell(det, changed, g);
        else { // 글자 없이 화물 하나가 통째로 비면 드래그 중
          for (const k of this.list()) { const cs = []; for (let rr = k.r; rr < k.r + k.h; rr++) for (let cc = k.c; cc < k.c + k.w; cc++) cs.push([cc, rr - off]); if (cs.every(([cc, rr]) => rr >= 0 && rr < det.nrow && changed.some(x => x[0] === cc && x[1] === rr))) { dragged = k; break; } }
        }
      }
      const skip = new Set(changed.map(([c, r]) => c + "," + r));
      // 2) 칸 투표
      for (let r = 0; r < det.nrow; r++) for (let c = 0; c < ncol; c++) { if (skip.has(c + "," + r)) continue; const key = (r + off) + "," + c; const o = this.cells.get(key) || { s: 0 }; o.s = Math.max(-4, Math.min(4, o.s + (det.occ[r * ncol + c] ? 1 : -1))); this.cells.set(key, o); }
      // 3) 화물 투표 (가려진 칸이 낀 화물은 이번 프레임은 건너뜀)
      for (const k of det.cargos) {
        let hidden = false; for (let rr = k.r; rr < k.r + k.h && !hidden; rr++) for (let cc = k.c; cc < k.c + k.w; cc++) if (skip.has(cc + "," + rr)) { hidden = true; break; }
        // 직사각형이 아닌 덩어리(테두리 선을 놓쳐 이웃과 붙음)는 크기를 믿을 수 없어 버림
        if (hidden || k.rect === false) continue;
        // 보이는 범위 맨 위/아래 줄에 걸친 화물은 화면 밖으로 잘렸을 수 있음(스크롤 중 3×2가 3×1로 보이는 등) → 따로 셈
        const key = `${k.r + off},${k.c},${k.w},${k.h}`; const o = this.obs.get(key) || { c: k.c, r: k.r + off, w: k.w, h: k.h, n: 0, ni: 0 }; o.n++; if (!k.edge) o.ni++; o.t = t; this.obs.set(key, o);
        // 같은 자리에 지금 보이는 화물과 겹치는 다른 기록은 표를 깎음 (화물을 사서 바뀌었거나 다른 상인 화면 — 칸이 모두 차 있으면 화면 바뀜 감지가 안 됨)
        if (!k.edge) for (const [kk, q] of this.obs) if (kk !== key && q.c < o.c + o.w && o.c < q.c + q.w && q.r < o.r + o.h && o.r < q.r + q.h) { q.n -= 2; if (q.ni > q.n) q.ni = Math.max(0, q.n); if (q.n <= 0) this.obs.delete(kk); }
      }
      this._list = null;
      if (hoverCell) { const [cc, rr] = hoverCell; const hit = this.list().find(k => cc >= k.c && cc < k.c + k.w && rr + off >= k.r && rr + off < k.r + k.h); this.hover = hit ? hit.key : `${rr + off},${cc}`; this.hoverT = t; det.hoverCell = [cc, rr]; }
      if (dragged) { this.drag = dragged.key; this.dragT = t; det.dragged = dragged; }
      return det;
    }
    // 툴팁 왼쪽 위 모서리(=커서 끝)가 있는 칸
    cursorCell(det, changed, g) {
      const w = det.w; let c0 = 99, r0 = 99; for (const [c, r] of changed) { c0 = Math.min(c0, c); r0 = Math.min(r0, r); }
      const xa = Math.max(0, Math.round(det.gx0 + (c0 - 1) * det.p)), xb = Math.round(det.gx0 + (c0 + 1) * det.p), ya = Math.max(0, Math.round(det.gy0 + (r0 - 1) * det.py)), yb = Math.round(det.gy0 + (r0 + 1) * det.py);
      const need = det.p * 1.2;
      for (let y = ya; y < yb && y < det.h; y++) { let run = 0; for (let x = xa; x < xb + det.p * 2 && x < w; x++) { if (g[y * w + x] <= 12) { run++; if (run >= need) { const tx = x - run + 1, ty = y; return [Math.floor((tx - 3 - det.gx0) / det.p), Math.floor((ty - 3 - det.gy0) / det.py)]; } } else run = 0; } }
      return [c0, r0];
    }
    // 투표 수가 많은 화물부터 겹치지 않게 고름. 수동 지정이 항상 우선
    list() {
      if (this._list) return this._list;
      const out = [], taken = (k) => out.some(o => o.c < k.c + k.w && k.c < o.c + o.w && o.r < k.r + k.h && k.r < o.r + o.h);
      for (const m of this.manual.values()) out.push(Object.assign({ manual: true }, m));
      const allOcc = o => { for (let r = o.r; r < o.r + o.h; r++) for (let c = o.c; c < o.c + o.w; c++) { const x = this.cells.get(r + "," + c); if (!x || x.s <= 0) return false; } return true; }, cand = [...this.obs.values()].filter(o => o.n >= 4 && allOcc(o)).sort((a, b) => (b.ni >= 2) - (a.ni >= 2) || b.n - a.n || b.w * b.h - a.w * a.h);
      for (const o of cand) if (!taken(o)) out.push(Object.assign({}, o));
      out.forEach(o => { o.key = `${o.r},${o.c}`; o.item = this.items.get(o.key) || null;
        if (!o.item) for (const [k, it] of this.items) { const [r, c] = k.split(",").map(Number); if (r >= o.r && r < o.r + o.h && c >= o.c && c < o.c + o.w) { o.item = it; break; } } });
      out.sort((a, b) => a.r - b.r || a.c - b.c);
      return (this._list = out);
    }
    setManual(c, r, w, h) { this.manual.forEach((m, k) => { if (m.c < c + w && c < m.c + m.w && m.r < r + h && r < m.r + m.h) this.manual.delete(k); }); this.manual.set(`${r},${c}`, { c, r, w, h, n: 99 }); this._list = null; }
    removeManual(key) { this.manual.delete(key); this._list = null; }
    assign(key, item) { this.items.set(key, item); this._list = null; }
    // 소리가 났을 때 연결할 화물: 드래그 중인 화물 > 최근 마우스 올린 화물
    target(t, maxDrag = 2.5, maxHover = 2) { const L = this.list(); if (this.drag && t - this.dragT <= maxDrag && !(this.hover && this.hoverT > this.dragT + 0.3)) { const k = L.find(o => o.key === this.drag); if (k) return k; } if (this.hover && t - this.hoverT <= maxHover) { const k = L.find(o => o.key === this.hover); if (k) return k; const [r, c] = this.hover.split(",").map(Number); const k2 = L.find(o => r >= o.r && r < o.r + o.h && c >= o.c && c < o.c + o.w); return k2 || { key: this.hover, r, c, w: 1, h: 1, cellOnly: true }; } return null; }
    rows() { let lo = 1e9, hi = -1e9; for (const [k, o] of this.cells) { if (o.s <= -4 && !this.stableOcc(k)) { } const r = +k.split(",")[0]; lo = Math.min(lo, r); hi = Math.max(hi, r); } for (const m of this.manual.values()) { lo = Math.min(lo, m.r); hi = Math.max(hi, m.r + m.h - 1); } return lo > hi ? [0, -1] : [lo, hi]; }
  }
  // 물품 크기(가로×세로). 데이터: slot(칸 수) + orientation(正/横=가로로 김/竖=세로로 김). 상인 격자에서는 회전 없음
  const SIZE = { "1|正": [1, 1], "4|正": [2, 2], "2|横": [2, 1], "2|竖": [1, 2], "6|横": [3, 2], "6|竖": [2, 3] };
  function itemSize(it) { return SIZE[`${Number(it.slot)}|${String(it.orientation || "")}`] || null; }
  // 화물 가로·세로가 정확히 같은 후보만. 크기 정보가 없는 후보는 뒤에 붙이고 unknown 표시
  function fitCands(cands, w, h) { const ok = [], unk = []; for (const c of cands) { const s = itemSize(c); if (!s) unk.push(Object.assign({ sizeUnknown: true }, c)); else if (s[0] === w && s[1] === h) ok.push(c); } return ok.concat(unk); }
  const api = { detect, GridTracker, itemSize, fitCands };
  if (typeof module !== "undefined") module.exports = api; else root.MHGrid = api;
})(this);
