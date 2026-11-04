/* 소리 시작(onset) 판정 — 기존 전대역 판정 + 저역(약 300Hz 이하, 바람·웅웅 소리) 차단 대역 판정 */
(function (root) {
  "use strict";
  // 300Hz 2차 버터워스 고역통과 계수(sr 별 캐시), 두 번 직렬 = 4차
  const cache = {};
  function coef(sr, fc) { const k = sr + "|" + fc; if (cache[k]) return cache[k];
    const w = Math.tan(Math.PI * fc / sr), q = Math.SQRT1_2, n = 1 / (1 + w / q + w * w);
    return (cache[k] = [n, -2 * n, n, 2 * (w * w - 1) * n, (1 - w / q + w * w) * n]); }
  // 바람 저역 차단 기준: 300/700/1000Hz 비교에서 1000Hz가 가장 좋았고(바람 2배 기준 4→9→12개 인식), matcher의 1kHz 하이패스와도 맞춤
  function hp(x, sr, fc = 1000) { const [b0, b1, b2, a1, a2] = coef(sr, fc); let y = x;
    for (let pass = 0; pass < 2; pass++) { const o = new Float32Array(y.length); let z0 = 0, z1 = 0;
      for (let i = 0; i < y.length; i++) { const xi = y[i], yi = b0 * xi + z0; z0 = b1 * xi - a1 * yi + z1; z1 = b2 * xi - a2 * yi; o[i] = yi; } y = o; }
    return y; }
  function framePeak(w, a, b, fr) { let pk = 0; for (let i = Math.max(0, a); i + fr <= b; i += fr) { let s = 0; for (let j = 0; j < fr; j++) { const v = w[i + j]; s += v * v; } pk = Math.max(pk, Math.sqrt(s / fr)); } return pk; }
  function q20(w, fr) { const n = Math.floor(w.length / fr); if (!n) return 0; const lv = []; for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < fr; j++) { const v = w[i * fr + j]; s += v * v; } lv.push(Math.sqrt(s / fr)); } lv.sort((a, b) => a - b); return lv[Math.floor(0.2 * (n - 1))]; }
  // 학습용: 저역 차단 신호의 배경 크기
  function bandBg(x, sr) { return q20(hp(x, sr), Math.round(sr / 50)); }
  // w: 최근 창, S: 감도({bgMul,ratio,floor}), bg: 전대역 배경, banded: 새 대역 판정 사용, nw: 새 구간 길이(샘플), learnedBg: 학습한 대역 배경
  function onset(w, sr, S, bg, banded, nw, learnedBg) {
    const fr = Math.round(sr / 50), n = w.length, ob = Math.round(0.5 * sr);
    const now = framePeak(w, n - nw, n, fr), before = framePeak(w, n - nw - ob, n - nw, fr), thr = Math.max(S.floor, bg * S.bgMul);
    const full = now >= thr && now >= before * S.ratio;
    const r = { now, before, thr, hit: full, full, band: false };
    if (!banded || full) return r;
    // 대역 판정: 앞부분 0.05초는 필터 과도응답이라 제외
    const y = hp(w, sr), cut = Math.round(0.05 * sr), yy = y.subarray(cut);
    const bgB = Math.max(q20(yy, fr), learnedBg || 0), m = yy.length;
    const nowB = framePeak(yy, m - nw, m, fr), befB = framePeak(yy, m - nw - ob, m - nw, fr), thrB = Math.max(S.floor * 0.5, bgB * S.bgMul);
    r.band = nowB >= thrB && nowB >= befB * S.ratio; r.hit = r.band; r.nowB = nowB; r.thrB = thrB;
    return r;
  }
  // 연속 인식(scanLoop) 게이트: w = 매칭할 최근 1초, bgFull = 1.5초 창 전대역 배경
  // 전대역 기준을 넘으면 통과(기존과 동일). banded 이면 저역 차단 신호로 한 번 더 판정
  function gate(w, sr, S, bgFull, banded, learnedBg, bandMul) {
    const fr = Math.round(sr / 50), pk = framePeak(w, 0, w.length, fr), thr = Math.max(S.floor, bgFull * S.bgMul);
    const r = { pk, thr, hit: pk >= thr, band: false };
    if (r.hit || !banded) return r;
    const y = hp(w, sr).subarray(Math.round(0.05 * sr));
    const bgB = learnedBg > 0 ? learnedBg : q20(y, fr), pkB = framePeak(y, 0, y.length, fr), thrB = Math.max(S.floor * 0.5, bgB * S.bgMul * (bandMul || 1));
    r.pkB = pkB; r.thrB = thrB; r.band = r.hit = pkB >= thrB; return r;
  }
  const api = { hp, onset, gate, bandBg, framePeak };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.MHOnset = api;
})(typeof self !== "undefined" ? self : this);
