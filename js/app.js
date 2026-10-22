/* 행상 도우미 웹 — UI · 캡처 · 트리거 (원본 main.py / recorder.py / ui.py 의 --no-vision 경로를 옮김) */
(function () {
  "use strict";
  const _els = {}; document.querySelectorAll("[id]").forEach(e => { _els[e.id] = e; });
  // 요소를 미니 창으로 옮겨도 같은 노드를 계속 가리키도록 시작 시 캐시 (document.getElementById 는 옮긴 뒤 null)
  const $ = id => _els[id] || (_els[id] = document.getElementById(id));
  // 원본 기본값 (main.parse_args / recorder.py)
  const WINDOW_SECONDS = 1.5, UPDATE_SECONDS = 0.18, SETTLE = 0.14, RETRY = 3, RETRY_DELAY = 0.28, LISTEN_MAX = 2.0;
  const MIN_INTERVAL = 0.9, GOOD_ENOUGH_SCORE = 85, LIMIT = 5, MAX_CARDS = 20;
  const QUALITY_KO = { "金色": "금색", "红色": "빨강", "紫色": "보라" };
  const QUALITY_COLOR = { "金色": "#d4af37", "红色": "#d9534f", "紫色": "#a06cd5" };
  const CATEGORY_KO = { "收藏品": "수집품", "生活用品": "생활용품", "电子产品": "전자제품", "军用杂物": "군용 잡화", "电脑配件": "컴퓨터 부품", "仪器仪表": "계측기", "医用杂物": "의료 잡화", "医疗杂物": "의료 잡화(医疗)", "工具": "공구", "易燃物品": "인화성 물품", "纸制品": "종이 제품", "能源物品": "에너지 물품", "建筑材料": "건축 자재" };
  const ORIENT_KO = { "正": "정사각/기본", "横": "가로", "竖": "세로" };
  const ko = (map, v) => (map[v] ? `${map[v]}` : v || "-");

  const NM = window.MH_NAMES || { items: {}, sounds: {} };
  const koName = zh => (NM.items[zh] && NM.items[zh].ko) || zh;          // 못 찾은 이름은 중국어 원문 유지
  const enName = zh => (NM.items[zh] && NM.items[zh].en) || "";
  const sndName = k => NM.sounds[k] || (NM.items[k] && NM.items[k].ko) || k;
  const db = window.MH_DATA.database;
  const engine = new MH.CandidateEngine(db);

  // ---------- 매처: Worker(가능하면) 또는 메인 스레드 ----------
  let worker = null, localMatcher = null, reqId = 0; const pending = new Map();
  function b64ToBuf(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; }
  const wavList = () => Object.entries(window.MH_DATA.sounds).map(([file, b64]) => ({ file, buffer: b64ToBuf(b64) }));
  function initMatcher() {
    try {
      const src = `const MHW=(${MH_FACTORY.toString()})();let m=null;\nonmessage=e=>{const d=e.data;try{if(d.type==='init'){m=new MHW.SoundMatcher(d.db).loadTemplates(d.wavs);postMessage({id:d.id,ok:true,n:m.templates.length,errors:m.errors});}else if(d.type==='match'){const rows=m.match(d.x,d.sr,d.limit,d.bg);let weak=[];if(!rows.length&&d.weak)weak=m.weakCandidates(d.x,d.sr,d.limit,d.bg);postMessage({id:d.id,rows,reason:m.lastReason,weak});}}catch(err){postMessage({id:d.id,error:String(err)});}};`;
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      worker.onmessage = e => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
      worker.onerror = () => { if (worker) { worker = null; fallbackLocal(); } };
      return call({ type: "init", db, wavs: wavList() }).then(r => { if (r.error) throw new Error(r.error); return r; }).catch(() => { worker = null; return fallbackLocal(); });
    } catch (e) { return fallbackLocal(); }
  }
  function fallbackLocal() { localMatcher = new MH.SoundMatcher(db).loadTemplates(wavList()); return Promise.resolve({ n: localMatcher.templates.length, errors: localMatcher.errors, local: true }); }
  function call(msg) { return new Promise(res => { const id = ++reqId; msg.id = id; pending.set(id, res); worker.postMessage(msg); }); }
  function match(x, sr, bg, weak) {
    if (worker) return call({ type: "match", x, sr, bg, limit: LIMIT, weak });
    const rows = localMatcher.match(x, sr, LIMIT, bg);
    return Promise.resolve({ rows, reason: localMatcher.lastReason, weak: !rows.length && weak ? localMatcher.weakCandidates(x, sr, LIMIT, bg) : [] });
  }

  // ---------- 캡처 ----------
  let ctx = null, stream = null, srcNode = null, procNode = null, sinkNode = null, sr = 48000;
  let ring = null, ringPos = 0, ringFilled = 0, sinceUpdate = 0, latest = null; // latest = {win, bg, t}
  let sampleClock = 0, waiters = [], meterAcc = 0;
  let active = false, busy = false, lastAudioTrigger = 0, prevPeak = 0, levelPeak = 0;

  function resetRing() { if (ring) ring.fill(0); ringPos = 0; ringFilled = 0; sinceUpdate = 0; latest = null; prevPeak = 0; }
  function ringWindow() { const n = ring.length; if (ringFilled < n) return ring.slice(0, ringFilled); const out = new Float32Array(n); out.set(ring.subarray(ringPos)); out.set(ring.subarray(0, ringPos), n - ringPos); return out; }
  function onBlock(block) {
    let pk = 0; for (const v of block) { const a = Math.abs(v); if (a > pk) pk = a; } levelPeak = Math.max(levelPeak * 0.85, pk);
    sampleClock += block.length;
    if (waiters.length) { const due = waiters.filter(w => w.at <= sampleClock); waiters = waiters.filter(w => w.at > sampleClock); due.forEach(w => w.r()); }
    meterAcc += block.length; if (meterAcc >= sr * 0.1) { meterAcc = 0; drawMeter(); }
    if (!active) return; // 원본: 감시 중이 아니면 오디오를 쌓지 않음
    const n = ring.length;
    for (let i = 0; i < block.length; i++) { ring[ringPos] = block[i]; ringPos = (ringPos + 1) % n; }
    ringFilled = Math.min(n, ringFilled + block.length); sinceUpdate += block.length;
    if (ringFilled < n || sinceUpdate < UPDATE_SECONDS * sr) return;
    sinceUpdate = 0;
    const win = ringWindow(), bg = MH.backgroundLevel(win, sr);
    latest = { win, bg, t: performance.now() };
    $("bgVal").textContent = bg.toFixed(5);
    if ($("optAutoTrigger").checked) maybeAudioTrigger(win, bg);
  }
  // main.AudioFeed._maybe_audio_trigger
  function maybeAudioTrigger(w, bg) {
    const now = performance.now() / 1000;
    if (now - lastAudioTrigger < MIN_INTERVAL) return;
    const fr = Math.round(sr / 50), nf = Math.floor(w.length / fr); let peak = 0;
    for (let i = 0; i < nf; i++) { let s = 0; for (let j = 0; j < fr; j++) { const v = w[i * fr + j]; s += v * v; } peak = Math.max(peak, Math.sqrt(s / fr)); }
    const thr = Math.max(0.0012, bg * 3.5);
    if (peak < thr) { prevPeak = peak; return; }
    if (prevPeak >= thr * 0.6) { prevPeak = peak; return; }
    prevPeak = peak; lastAudioTrigger = now;
    handleTrigger("소리 감지");
  }

  const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0];if(c&&c.length){const n=c[0].length,o=new Float32Array(n);for(const ch of c)for(let k=0;k<n;k++)o[k]+=ch[k]/c.length;this.port.postMessage(o,[o.buffer]);}return true;}}registerProcessor('mh-tap',P);`;
  async function attach(newStream, label) {
    detach();
    stream = newStream;
    const at = stream.getAudioTracks();
    if (!at.length) { stream.getTracks().forEach(t => t.stop()); stream = null; throw new Error("오디오 트랙이 없습니다. 공유 창에서 「시스템 오디오도 공유」를 켰는지 확인하세요."); }
    ctx = new AudioContext({ latencyHint: "interactive" }); sr = ctx.sampleRate;
    srcNode = ctx.createMediaStreamSource(new MediaStream(at));
    sinkNode = ctx.createGain(); sinkNode.gain.value = 0; sinkNode.connect(ctx.destination);
    try {
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
      procNode = new AudioWorkletNode(ctx, "mh-tap", { numberOfOutputs: 1 });
      procNode.port.onmessage = e => onBlock(e.data);
    } catch (e) {
      procNode = ctx.createScriptProcessor(1024, 2, 1);
      procNode.onaudioprocess = ev => { const b = ev.inputBuffer, n = b.length, o = new Float32Array(n); for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let k = 0; k < n; k++) o[k] += d[k] / b.numberOfChannels; } onBlock(o); };
    }
    srcNode.connect(procNode); procNode.connect(sinkNode);
    ring = new Float32Array(Math.round(sr * WINDOW_SECONDS)); resetRing(); sampleClock = 0; waiters = [];
    ctx.onstatechange = () => { drawMeter(); if (ctx && ctx.state === "suspended") keepAlive(); };
    at[0].addEventListener("ended", () => { setStatus("소리 공유가 끝났습니다. 다시 연결하세요."); detach(); });
    $("srcName").textContent = label; $("srcRate").textContent = sr + " Hz";
    const vt = stream.getVideoTracks()[0]; if (vt && $("optGrid").checked) GRID.start(vt); else GRID.info(vt ? "「화면도 읽기」가 꺼져 있어 격자는 직접 지정만 됩니다." : "화면이 없는 소스라 격자는 직접 지정만 됩니다.");
    $("btnToggle").disabled = false; $("btnNow").disabled = false;
    setStatus("소리 소스 연결됨. 시작(F8)을 누르세요.");
  }
  function detach() {
    waiters.forEach(w => w.r()); waiters = [];
    if (active) setActive(false);
    GRID.stop();
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { ctx && ctx.close(); } catch (e) {}
    ctx = stream = srcNode = procNode = sinkNode = null;
    $("srcName").textContent = "없음"; $("srcRate").textContent = "-";
    $("btnToggle").disabled = true; $("btnNow").disabled = true;
  }

  $("btnDisplay").onclick = async () => {
    try {
      const wantGrid = $("optGrid").checked;
      const s = await navigator.mediaDevices.getDisplayMedia({ video: wantGrid ? { frameRate: { ideal: 10, max: 15 }, width: { ideal: 2560 }, height: { ideal: 1440 } } : { frameRate: 1, width: 320, height: 180 }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }, systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "exclude" });
      await attach(s, "시스템 소리 (화면 공유)");
    } catch (e) { setStatus("화면 공유 실패: " + e.message); }
  };
  async function refreshDevices(askPermission) {
    try {
      if (askPermission) { const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach(x => x.stop()); }
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
      const sel = $("devSelect"), cur = sel.value; sel.innerHTML = '<option value="">입력 장치 선택 (스테레오 믹스, 가상 케이블 등)</option>';
      list.forEach((d, i) => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || `입력 장치 ${i + 1}`; sel.appendChild(o); });
      sel.value = cur;
    } catch (e) { setStatus("장치 목록을 가져오지 못했습니다: " + e.message); }
  }
  $("btnDevRefresh").onclick = () => refreshDevices(true);
  $("btnDevice").onclick = async () => {
    const id = $("devSelect").value; if (!id) { setStatus("먼저 입력 장치를 고르세요. 이름이 안 보이면 「장치 목록 새로고침」을 누르세요."); return; }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
      await attach(s, $("devSelect").selectedOptions[0].textContent);
    } catch (e) { setStatus("장치 연결 실패: " + e.message); }
  };

  // ---------- 감시 시작/정지 ----------
  function setActive(on) {
    if (on && !ctx) { setStatus("먼저 소리 소스를 연결하세요."); return; }
    active = on; resetRing();
    if (ctx && on && ctx.state === "suspended") ctx.resume();
    const b = $("btnToggle"); b.textContent = on ? "■ 감시 정지 (F8)" : "▶ 감시 시작 (F8)"; b.classList.toggle("on", on);
    badge(on ? "on" : "off", on ? "감시 중" : "대기");
    setStatus(on ? "감시 중: 신비 화물을 드래그하면 소리를 듣고 후보를 보여줍니다." : "감시 정지: 소리를 읽지 않습니다. 시작을 누르거나 F8을 누르세요.");
  }
  $("btnToggle").onclick = () => setActive(!active);
  $("btnNow").onclick = () => { if (!active) setActive(true); handleTrigger("수동"); };
  function onKey(e) { if (e.key === "F8") { e.preventDefault(); if (ctx) setActive(!active); else setStatus("먼저 소리 소스를 연결하세요."); } }
  window.addEventListener("keydown", onKey);

  // ---------- 트리거 처리 (main.handle_trigger, --no-vision 경로) ----------
  // 오디오 샘플 수로 기다림: 메인 탭이 숨겨져 타이머가 1초 이상으로 묶여도 오디오 블록은 계속 들어옴
  const sleep = s => new Promise(r => { if (ctx && procNode) waiters.push({ at: sampleClock + Math.round(s * sr), r }); else setTimeout(r, s * 1000); });
  async function attempt() {
    if (!latest) return null;
    const { win, bg } = latest; const cands = [["raw", win, bg]];
    const gaps = MH.zeroGapCount(win, sr);
    if (gaps > 0) { const seg = MH.longestNonzeroSegment(win, sr); if (seg && seg.length >= 128) cands.push(["segment", seg, MH.backgroundLevel(seg, sr)]); }
    let best = null;
    for (const [path, x, bg2] of cands) {
      const r = await match(x, sr, bg2, false); const ss = r.rows.length ? r.rows[0].score : 0;
      const key = [r.rows.length ? 1 : 0, -gaps, ss];
      if (!best || cmpKey(key, best.key) > 0) best = { rows: r.rows, reason: r.reason, score: ss, path, key };
    }
    return best;
  }
  const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  async function handleTrigger(src) {
    if (busy || !active) return; busy = true; badge("busy", "인식 중…");
    pendingTarget = GRID.targetNow();
    const t0 = performance.now();
    try {
      await sleep(SETTLE);
      if (!latest) { setStatus("오디오가 아직 준비되지 않았습니다 (첫 1.5초 대기 중)."); return; }
      let best = await attempt(); const deadline = performance.now() + LISTEN_MAX * 1000; let tries = 0;
      while (best && best.score < GOOD_ENOUGH_SCORE) {
        if (tries >= RETRY) { if (performance.now() >= deadline) break; if (best.score > 0 && tries >= RETRY * 2) break; }
        tries++; await sleep(RETRY_DELAY); if (!active) break;
        const b2 = await attempt(); if (b2 && cmpKey(b2.key, best.key) > 0) best = b2;
      }
      let rows = best ? best.rows : [], reason = best ? best.reason : "";
      const minS = Number($("fMin").value) || 0;
      if (rows.length && minS > 0) { const kept = rows.filter(r => r.score >= minS); if (!kept.length) { reason = `가장 비슷한 것은 ${sndName(rows[0].key)} (${rows[0].score}점)인데, 설정한 최소 점수 ${minS}보다 낮습니다.`; } rows = kept; }
      if (!rows.length && $("optWeak").checked && latest) {
        const r = await match(latest.win, sr, latest.bg, true);
        if (r.weak && r.weak.length) { rows = r.weak; reason = "기준 미달(0.88/0.85/0.82/0.78, 차이 0.045). 가장 비슷한 후보와 점수를 참고로만 보여줍니다. " + reason; }
      }
      showRows(rows, reason, `${src} · ${((performance.now() - t0) / 1000).toFixed(2)}초`);
    } catch (e) { setStatus("인식 오류: " + e.message); }
    finally { busy = false; if (active) badge("on", "감시 중"); else badge("off", "대기"); }
  }

  // ---------- 결과 표시 (ui.Panel) ----------
  let allCands = [], lastSig = "", history = [], pendingTarget = null;
  // 후보 목록을 거를 화물 크기 {w,h,src}. 소리 난 화물·고른 화물·크기 버튼에서 정해짐. ✕로 해제
  let listSize = null;
  function setListSize(w, h, src) { listSize = w && h ? { w, h, src } : null; applyFilter(); }
  function showRows(rows, reason, trace) {
    const cands = engine.resolve(rows);
    const tgt = pendingTarget; pendingTarget = null;
    if (cands.length && tgt && !tgt.cellOnly && tgt.w && tgt.h) listSize = { w: tgt.w, h: tgt.h, src: tgt.manualPick ? "고른 화물" : tgt.dragged ? "드래그한 화물" : "마우스 올린 화물" }, lastSig = ""; // 크기가 바뀌면 목록 다시 그림
    if (cands.length) GRID.onResult(cands, tgt);
    if (!cands.length && allCands.length) { setStatus(`이번에는 소리를 찾지 못해 이전 후보를 유지합니다. (${reason || "결과 없음"}) · ${trace}`); return; } // 원본의 '粘滞'
    setStatus((reason || (cands.length ? "" : "후보 없음")) + " · " + trace);
    const sig = JSON.stringify(cands.map(c => [c.name, c.score]));
    if (sig !== lastSig) {
      lastSig = sig; allCands = cands;
      if (cands.length) { history.push({ time: new Date().toLocaleTimeString("ko-KR", { hour12: false }), items: cands }); if (history.length > 50) history.shift(); renderHistory(); }
      rebuildCombos(); applyFilter();
    }
  }
  function distinct(field) { const v = []; for (const c of allCands) if (c[field] && !v.includes(c[field])) v.push(c[field]); return v; }
  function rebuildCombos() {
    [["fQuality", "quality", "품질", QUALITY_KO], ["fCategory", "category", "분류", CATEGORY_KO], ["fOrient", "orientation", "방향", ORIENT_KO]].forEach(([id, f, label, map]) => {
      const sel = $(id), cur = sel.value; sel.innerHTML = `<option value="">${label}: 전체</option>`;
      for (const v of distinct(f)) { const o = document.createElement("option"); o.value = v; o.textContent = ko(map, v); sel.appendChild(o); }
      sel.value = distinct(f).includes(cur) ? cur : "";
    });
  }
  function applyFilter() {
    const q = ($("fSearch").value || "").trim().toLowerCase().replace(/\s+/g, "");
    const norm = t => String(t || "").toLowerCase().replace(/\s+/g, "");
    const shown = engine.filter(allCands, $("fQuality").value, $("fCategory").value, $("fOrient").value, Number($("fMin").value) || 0)
      .filter(c => !q || [koName(c.name), enName(c.name), c.name, sndName(c.sound_key)].some(t => norm(t).includes(q)))
      .filter(c => { if (!listSize) return true; const z = MHGrid.itemSize(c); return !!z && z[0] === listSize.w && z[1] === listSize.h; });
    // 확률은 지금 보이는 후보끼리 나눔 (크기로 거른 뒤)
    const tot = shown.reduce((a, c) => a + Math.max(1, c.score), 0);
    const box = $("cards"); box.innerHTML = "";
    for (const c of shown.slice(0, MAX_CARDS)) {
      const color = QUALITY_COLOR[c.quality] || "#8a93a3";
      const el = document.createElement("div"); el.className = "card";
      el.innerHTML = `<div class="stripe" style="background:${color}"></div><img class="thumb" alt=""><div class="cinfo"><div class="cname"><span class="n"></span><span class="qbadge" style="background:${color}"></span></div><div class="cmeta" style="color:${color}"></div><div class="cextra"></div></div><div class="score"></div>`;
      const img = el.querySelector("img"); img.src = "assets/images/" + encodeURIComponent(c.image); img.onerror = () => { img.style.visibility = "hidden"; };
      el.querySelector(".n").textContent = koName(c.name);
      el.querySelector(".cname").title = `중국어 원문: ${c.name}`;
      const en = enName(c.name); if (en) { const e2 = document.createElement("span"); e2.className = "en"; e2.textContent = en; el.querySelector(".cname").appendChild(e2); }
      el.querySelector(".qbadge").textContent = ko(QUALITY_KO, c.quality);
      el.querySelector(".cmeta").textContent = `${ko(QUALITY_KO, c.quality)} · ${ko(CATEGORY_KO, c.category)} · ${c.slot}칸${c.orientation ? ` (${ko(ORIENT_KO, c.orientation)})` : ""}`;
      el.querySelector(".cextra").textContent = `참고 가치 ${c.reference_value_text || "-"} · 소리 그룹 ${sndName(c.sound_key)}${c.special ? " · 특수" : ""}`;
      el.querySelector(".score").textContent = c.score; el.querySelector(".score").title = `이 목록 안 확률 ${Math.round(100 * Math.max(1, c.score) / tot)}%`;
      const pctEl = document.createElement("div"); pctEl.className = "small muted"; pctEl.textContent = `${Math.round(100 * Math.max(1, c.score) / tot)}%`; el.querySelector(".score").appendChild(pctEl);
      box.appendChild(el);
    }
    const sm = $("summary"); sm.textContent = `후보 ${allCands.length}개 / 표시 ${Math.min(shown.length, MAX_CARDS)}개 · `;
    const tag = document.createElement("span"); tag.className = "sizetag" + (listSize ? " on" : "");
    if (listSize) { tag.textContent = `${listSize.w}×${listSize.h} 화물 기준 (${listSize.src}) — 이 크기 물품만 표시 `; const x = document.createElement("button"); x.textContent = "✕ 크기 해제"; x.onclick = () => setListSize(null); tag.appendChild(x); }
    else tag.textContent = "화물 크기를 몰라 모든 크기를 표시 중 (화물에 마우스를 올리고 드래그하거나, 격자에서 화물·크기 버튼을 누르면 그 크기만 보여요)";
    sm.appendChild(tag);
    if (!shown.length) box.innerHTML = allCands.length && listSize ? `<div class="muted small">${listSize.w}×${listSize.h} 크기 후보가 없습니다. ✕ 크기 해제를 누르면 전체 후보를 봅니다.</div>` : '<div class="muted small">물건을 드래그하기를 기다리는 중…</div>';
  }
  ["fQuality", "fCategory", "fOrient", "fMin"].forEach(id => $(id).addEventListener("change", applyFilter));
  $("fSearch").addEventListener("input", applyFilter);
  $("btnClear").onclick = () => { allCands = []; lastSig = ""; listSize = null; rebuildCombos(); applyFilter(); };
  $("btnHistory").onclick = () => { const h = $("history"); h.hidden = !h.hidden; renderHistory(); };
  function renderHistory() { $("history").textContent = history.length ? history.slice().reverse().map((r, i) => `#${i + 1} ${r.time}  후보 ${r.items.length}개  ${r.items.slice(0, 5).map(c => koName(c.name)).join("、")}${r.items.length > 5 ? " 등" : ""}`).join("\n") : "(아직 기록 없음)"; }

  function setStatus(t) { $("status").textContent = t; }
  function badge(cls, t) { $("miniState").textContent = t; const b = $("stateBadge"); b.className = "badge " + cls; b.textContent = t; }

  // ---------- 작은 창: Document PiP(항상 위) → 실패 시 window.open 팝업 ----------
  let mini = null;
  function copyStyles(w) {
    const base = w.document.createElement("base"); base.href = document.baseURI; w.document.head.appendChild(base);
    const meta = w.document.createElement("meta"); meta.setAttribute("charset", "utf-8"); w.document.head.appendChild(meta);
    for (const ss of document.styleSheets) { try { const st = w.document.createElement("style"); st.textContent = [...ss.cssRules].map(r => r.cssText).join("\n"); w.document.head.appendChild(st); } catch (e) { if (ss.href) { const l = w.document.createElement("link"); l.rel = "stylesheet"; l.href = ss.href; w.document.head.appendChild(l); } } }
    w.document.title = "행상 도우미 후보";
  }
  function moveIn(w, kind) {
    const panel = $("results"), anchor = document.createComment("results-anchor");
    copyStyles(w); w.document.body.className = "pip";
    panel.parentNode.insertBefore(anchor, panel); w.document.body.appendChild(w.document.adoptNode(panel));
    $("miniBar").hidden = false; mini = { w, kind };
    w.addEventListener("keydown", onKey);
    const back = () => { if (!mini || mini.w !== w) return; mini = null; $("miniBar").hidden = true; anchor.parentNode.insertBefore(document.adoptNode(panel), anchor); anchor.remove(); };
    w.addEventListener("pagehide", back); w.addEventListener("unload", back);
    keepAlive(); drawMeter();
    setStatus(kind === "pip" ? "작은 창(항상 위)에 후보를 표시합니다." : "팝업 창에 후보를 표시합니다. (작은 창 미지원/실패 → 팝업으로 대체, 항상 위는 아님)");
  }
  $("btnPip").onclick = async () => {
    if (mini) { try { mini.w.focus(); } catch (e) {} return; }
    if ("documentPictureInPicture" in window) {
      try { moveIn(await documentPictureInPicture.requestWindow({ width: 380, height: 580 }), "pip"); return; } catch (e) { console.warn("Document PiP 실패, 팝업으로 대체", e); }
    }
    const w = window.open("", "mh_mini", "popup=yes,width=400,height=600");
    if (!w) { setStatus("작은 창을 열지 못했습니다. 브라우저 팝업 차단을 해제해 주세요."); return; }
    w.document.open(); w.document.write("<!doctype html><html lang='ko'><head></head><body></body></html>"); w.document.close();
    moveIn(w, "popup");
  };

  // ---------- 화물 격자 (화면 프레임 → js/grid.js) ----------
  const GRID = (() => {
    const FPS = 6, tracker = new MHGrid.GridTracker();
    let track = null, reader = null, video = null, timer = null, canvas = null, c2d = null, lastFrame = 0, running = false, found = false, pick = null, size = null, frames = 0, lastDet = null;
    const now = () => performance.now() / 1000;
    function info(t) { $("gridInfo").textContent = t; }
    function ensureCanvas(w, h) { if (!canvas) { canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas"); c2d = canvas.getContext("2d", { willReadFrequently: true }); } if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; } }
    let gray = null;
    function process(src, W, H) {
      if (!W || !H) return;
      // 화물창은 화면 오른쪽 절반. 높이 720 기준으로 줄여서 처리 (해상도와 무관)
      const sx = Math.floor(W / 2), sw = W - sx, dh = 720, dw = Math.round(sw * dh / H);
      ensureCanvas(dw, dh); c2d.drawImage(src, sx, 0, sw, H, 0, 0, dw, dh);
      const d = c2d.getImageData(0, 0, dw, dh).data; if (!gray || gray.length !== dw * dh) gray = new Uint8Array(dw * dh);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      const det = MHGrid.detect(gray, dw, dh); tracker.push(det, now(), gray); frames++; lastDet = det;
      if (det && !found) { found = true; }
      render();
    }
    async function start(vt) {
      stop(); track = vt; running = true; found = false;
      info("화면 읽는 중… 상인 화물창을 열어 주세요.");
      if (typeof MediaStreamTrackProcessor !== "undefined") {
        try { // 탭이 가려져도 프레임이 계속 들어오는 방식
          reader = new MediaStreamTrackProcessor({ track: vt }).readable.getReader();
          (async () => { while (running && reader) { const { value: f, done } = await reader.read(); if (done) break; try { const t = performance.now(); if (t - lastFrame >= 1000 / FPS) { lastFrame = t; process(f, f.displayWidth, f.displayHeight); } } catch (e) { console.warn(e); } finally { f.close(); } } })().catch(e => console.warn("프레임 읽기 종료", e));
          return;
        } catch (e) { reader = null; }
      }
      video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = new MediaStream([vt]); video.play().catch(() => {});
      timer = setInterval(() => { if (video.readyState >= 2) try { process(video, video.videoWidth, video.videoHeight); } catch (e) { console.warn(e); } }, 1000 / FPS);
    }
    function stop() { running = false; try { reader && reader.cancel(); } catch (e) {} reader = null; if (timer) clearInterval(timer); timer = null; if (video) { video.srcObject = null; video = null; } track = null; }
    function targetNow() { if (pick) { const k = tracker.list().find(o => o.key === pick); if (k) return Object.assign({ manualPick: true }, k); } const t = tracker.target(now()); return t ? Object.assign({ dragged: tracker.drag === t.key && now() - tracker.dragT < 2.5 }, t) : null; }
    // 소리 결과 → 화물 칸. 화물 크기와 칸 수가 맞는 후보만 남김
    function onResult(cands, tgt) {
      if (!tgt) { info("소리는 맞혔지만 어느 화물인지 몰라서 격자에 넣지 않았습니다. 화물에 마우스를 올린 채로 드래그하거나, 격자에서 화물을 눌러 지정하세요."); return; }
      if (tgt.cellOnly) { info("소리는 맞혔지만 화물 크기를 몰라 격자에 넣지 않았습니다. 화물에 마우스를 올린 채로 드래그하거나, 격자에서 화물을 눌러 지정하세요."); return; }
      // 화물 가로×세로와 정확히 같은 크기의 물품만. 맞는 게 없으면 넣지 않음 (다른 크기 물품을 붙이지 않음)
      let pool = MHGrid.fitCands(cands, tgt.w, tgt.h).filter(c => !c.sizeUnknown); const fit = true;
      if (!pool.length) { info(`소리 결과에 ${tgt.w}×${tgt.h} 크기 물품이 없어 격자에 넣지 않았습니다. (다른 화물 소리였을 수 있음)`); return; }
      const total = pool.reduce((a, c) => a + Math.max(1, c.score), 0), top = pool[0];
      const item = { w: tgt.w, h: tgt.h, name: top.name, ko: koName(top.name), quality: top.quality, price: top.reference_value_text || top.reference_value || "-", conf: Math.round(100 * Math.max(1, top.score) / total), image: top.image, n: pool.length, red: pool.some(c => c.quality === "红色"), sure: !!tgt.dragged || !!tgt.manualPick, fit, sizeUnknown: !!top.sizeUnknown, all: pool.slice(0, 5).map(c => koName(c.name)) };
      tracker.assign(tgt.key, item); if (tgt.manualPick) pick = null; render();
      info(`${tgt.w}×${tgt.h} 화물 → ${item.ko} ${item.conf}%${fit ? "" : " (가로×세로가 맞는 후보가 없어 전체 후보 기준)"}`);
    }
    function priceText(p) { const n = Number(String(p).replace(/[^\d]/g, "")); return n ? (n >= 10000 ? Math.round(n / 1000) / 10 + "만" : n.toLocaleString("ko-KR")) : String(p); }
    let lastSig = "";
    function render() {
      const L = tracker.list(), [r0, r1raw] = tracker.rows(), ncol = tracker.ncol || 9, r1 = Math.max(r1raw, r0 + 5);
      const tg = tracker.target(now()), tkey = tg ? tg.key : "";
      const sig = JSON.stringify([L.map(k => [k.key, k.w, k.h, k.item && [k.item.name, k.item.conf, k.item.sure]]), r0, r1, ncol, tkey, pick, size]);
      if (lastDet) info(`화물창 인식: ${lastDet.ncol}열 · 화물 ${L.length}개 · 기록된 줄 ${r1raw - r0 + 1}줄${tg ? ` · 대상 ${tg.c + 1}열 ${tg.r - r0 + 1}줄` : ""}`);
      else if (running && frames > FPS * 2) info(`화면 읽는 중… 상인 화물창이 보이지 않습니다. (기록 ${L.length}개 유지)`);
      if (sig === lastSig) return; lastSig = sig;
      const box = $("gridMap"); box.innerHTML = "";
      const g = document.createElement("div"); g.className = "g"; g.style.width = `calc(var(--cs) * ${ncol})`; g.style.height = `calc(var(--cs) * ${r1 - r0 + 1})`;
      const pos = (el, c, r, w, h) => { el.style.left = `calc(var(--cs) * ${c})`; el.style.top = `calc(var(--cs) * ${r - r0})`; el.style.width = `calc(var(--cs) * ${w})`; el.style.height = `calc(var(--cs) * ${h})`; };
      for (let r = r0; r <= r1; r++) for (let c = 0; c < ncol; c++) { const el = document.createElement("div"); el.className = "cell"; el.dataset.c = c; el.dataset.r = r; pos(el, c, r, 1, 1); g.appendChild(el); }
      for (const k of L) {
        const el = document.createElement("div"); el.className = "cargo" + (k.manual ? " manual" : "") + (k.key === tkey ? " tgt" : "") + (k.key === pick ? " pick" : "");
        el.dataset.c = k.c; el.dataset.r = k.r; el.dataset.key = k.key; pos(el, k.c, k.r, k.w, k.h);
        const it = k.item;
        if (it) { const col = QUALITY_COLOR[it.quality] || "#8a93a3"; el.style.background = col + "33"; el.style.borderColor = col; if (it.red) el.classList.add("red");
          el.title = `${it.ko} (${ko(QUALITY_KO, it.quality)})${it.sizeUnknown ? " · 크기 정보 없음" : ""}\n참고 가치 ${it.price}\n후보 ${it.n}개: ${it.all.join(", ")}`;
          const pct = (it.n === 1 ? "100%" : it.conf + "%") + (it.sure ? " ✓" : "");
          el.innerHTML = `<img class="gi" alt=""><span class="pr"></span><span class="pc"></span><div class="nm"></div>`;
          const im = el.querySelector("img"); im.src = "assets/images/" + encodeURIComponent(it.image || ""); im.onerror = () => { im.replaceWith(Object.assign(document.createElement("span"), { className: "q", textContent: "?" })); };
          if (!(it.sure || it.n === 1)) el.classList.add("dim");
          if (k.w * k.h === 1) el.classList.add("one");
          el.querySelector(".nm").textContent = it.ko; el.querySelector(".pr").textContent = priceText(it.price); el.querySelector(".pc").textContent = pct; el.querySelector(".pc").style.background = col; }
        else { el.title = "아직 모름 — 드래그하면 소리로 맞힙니다"; el.innerHTML = `<span class="q">?</span>`; }
        const sz = document.createElement("span"); sz.className = "sz"; sz.textContent = `${k.w}×${k.h}`; el.appendChild(sz);
        g.appendChild(el);
      }
      box.appendChild(g);
    }
    $("gridMap").addEventListener("click", e => {
      const el = e.target.closest("[data-c]"); if (!el) return; const c = +el.dataset.c, r = +el.dataset.r, key = el.dataset.key;
      if (size === "del") { if (key) { tracker.removeManual(key); tracker.items.delete(key); for (const [kk, o] of tracker.obs) if (`${o.r},${o.c}` === key) tracker.obs.delete(kk); tracker._list = null; } }
      else if (size) { const [w, h] = size.split("x").map(Number); tracker.setManual(c, r, w, h); }
      else if (key) { pick = pick === key ? null : key; const k = tracker.list().find(o => o.key === key); if (pick && k) setListSize(k.w, k.h, "고른 화물"); }
      lastSig = ""; render();
      if (pick && !size) info("이 화물을 골랐습니다. 다음 소리 결과를 여기에 넣습니다. (다시 누르면 해제)");
    });
    $("gridBox").querySelectorAll("[data-size]").forEach(b => b.addEventListener("click", () => { size = size === b.dataset.size ? null : b.dataset.size; $("gridBox").querySelectorAll("[data-size]").forEach(x => x.classList.toggle("sel", x.dataset.size === size)); info(size ? (size === "del" ? "지울 화물을 누르세요." : `${size.replace("x", "×")} 크기: 화물의 왼쪽 위 칸을 누르세요. (버튼을 다시 누르면 해제)`) : "직접 지정 해제"); if (size && size !== "del") { const [w, h] = size.split("x").map(Number); setListSize(w, h, "크기 버튼"); } lastSig = ""; render(); }));
    $("btnGridReset").onclick = () => { tracker.reset(); pick = null; lastSig = ""; render(); info("격자를 비웠습니다."); };
    render();
    return { start, stop, onResult, targetNow, info, tracker };
  })();

  // ---------- 시작 ----------
  setStatus("인식 템플릿을 불러오는 중…");
  initMatcher().then(r => {
    setStatus(`준비됨: 소리 템플릿 ${r.n}개, 물품 ${db.items.length + db.special_items.length}개${r.local ? " (메인 스레드 모드)" : ""}. 소리 소스를 연결하세요.`);
    if (r.errors && r.errors.length) console.warn(r.errors);
  });
  applyFilter();
  refreshDevices(false);
  function drawMeter() {
    const w = Math.min(100, levelPeak * 100) + "%"; $("meterBar").style.width = w; $("miniMeterBar").style.width = w;
    $("miniLevel").textContent = ctx ? `입력 ${levelPeak.toFixed(3)} · ${ctx.state === "running" ? "오디오 들어오는 중" : "오디오 " + ctx.state}` : "소리 소스 없음";
  }
  setInterval(() => { if (!ctx || ctx.state !== "running") drawMeter(); }, 500);
  // 탭이 숨겨지거나 포커스를 잃어도 AudioContext 를 계속 깨워 둠
  function keepAlive() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }
  document.addEventListener("visibilitychange", keepAlive); window.addEventListener("blur", keepAlive);

  // 테스트용 훅 (콘솔): 원본 효과음을 오프라인으로 인식
  window.MH_TEST = { match: (x, s, bg) => match(x, s, bg || 0, false), engine, showRows, b64ToBuf, GRID, setTarget: t => { pendingTarget = t; } };
})();
