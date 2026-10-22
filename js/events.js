/* 연속 소리 인식: 짧은 창(1초)을 계속 훑어서 효과음이 '언제' 났는지(at)를 찾고, 같은 소리의 겹친 검출은 하나로 합친다.
   트리거 간격 제한 없이 빠르게 연달아 드래그해도 소리마다 따로 잡히고, 같은 화물의 여러 소리는 점수를 모은다. */
(function (root) {
  "use strict";
  class EventScanner {
    constructor(o = {}) { this.minScore = o.minScore || 85; this.merge = o.merge || 0.15; this.keep = o.keep || 4; this.events = []; this.seq = 0; }
    // rows: matcher 결과(점수순), winStart: 창 시작 시각(초), now: 창 끝 시각
    process(rows, winStart, now) {
      const out = []; const seen = new Set();
      for (const r of rows || []) {
        if (r.score < this.minScore || seen.has(r.key)) continue; seen.add(r.key);
        const at = winStart + (r.offset_seconds || 0);
        let ev = this.events.find(e => e.key === r.key && Math.abs(e.at - at) < this.merge);
        if (ev) { if (r.score > ev.score) { ev.score = r.score; ev.row = r; ev.rows = rows; ev.updated = true; out.push(ev); } continue; }
        // 같은 시각(±merge)에 더 높은 다른 소리 그룹이 이미 있으면 그건 같은 소리의 다른 해석 → 버림
        if (this.events.some(e => e.key !== r.key && Math.abs(e.at - at) < this.merge && e.score >= r.score)) continue;
        ev = { id: ++this.seq, key: r.key, at, score: r.score, row: r, rows, found: now, updated: false }; this.events.push(ev); out.push(ev);
      }
      this.events = this.events.filter(e => now - e.at < this.keep);
      return out;
    }
  }
  // 화물별 점수 모으기: 같은 화물에서 난 소리 여러 번 → 소리 그룹별 점수 평균(안 나온 그룹은 0점으로 셈)
  class CargoVotes {
    constructor() { this.map = new Map(); }
    add(cargoKey, eventId, rows) {
      let v = this.map.get(cargoKey); if (!v) { v = { ev: new Map() }; this.map.set(cargoKey, v); }
      v.ev.set(eventId, rows); return this.rows(cargoKey);
    }
    rows(cargoKey) {
      const v = this.map.get(cargoKey); if (!v) return [];
      const n = v.ev.size, acc = new Map();
      for (const rows of v.ev.values()) for (const r of rows) { const a = acc.get(r.key) || { row: r, s: 0 }; a.s += r.score; if (r.score > a.row.score) a.row = r; acc.set(r.key, a); }
      return [...acc.values()].map(a => Object.assign({}, a.row, { score: Math.round(a.s / n), votes: n })).sort((a, b) => b.score - a.score);
    }
    count(cargoKey) { const v = this.map.get(cargoKey); return v ? v.ev.size : 0; }
    clear(cargoKey) { if (cargoKey === undefined) this.map.clear(); else this.map.delete(cargoKey); }
  }
  const api = { EventScanner, CargoVotes };
  if (typeof module !== "undefined") module.exports = api; else root.MHEvents = api;
})(this);
