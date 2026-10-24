/* 행상 도우미 웹 — UI · 캡처 · 트리거 (원본 main.py / recorder.py / ui.py 의 --no-vision 경로를 옮김) */
(function () {
  "use strict";
  const _els = {}; document.querySelectorAll("[id]").forEach(e => { _els[e.id] = e; });
  // 요소를 미니 창으로 옮겨도 같은 노드를 계속 가리키도록 시작 시 캐시 (document.getElementById 는 옮긴 뒤 null)
  const $ = id => _els[id] || (_els[id] = document.getElementById(id));
  // 원본 기본값 (main.parse_args / recorder.py)
  const WINDOW_SECONDS = 1.5, UPDATE_SECONDS = 0.18, SETTLE = 0.14, RETRY = 3, RETRY_DELAY = 0.28, LISTEN_MAX = 2.0;
  let MIN_INTERVAL = 0.9; const GOOD_ENOUGH_SCORE = 85, LIMIT = 5, MAX_CARDS = 20;
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
  let sampleClock = 0, waiters = [], meterAcc = 0, levelRms = 0, tgtAcc = 0;
  // 감도 1~7 (4 = 기본값, 녹화로 맞춘 값). 높을수록 작은 소리에도 반응. 트리거 기준(배경 배수·상승 비율·최소 크기)과 트리거 간격을 함께 바꿈
  const SENS = [null,
    { bgMul: 6, ratio: 3, floor: 0.004, gap: 0.9 }, { bgMul: 5, ratio: 2.6, floor: 0.0025, gap: 0.9 }, { bgMul: 4.2, ratio: 2.3, floor: 0.0017, gap: 0.9 },
    { bgMul: 3.5, ratio: 2, floor: 0.0012, gap: 0.9 }, { bgMul: 2.8, ratio: 1.8, floor: 0.0008, gap: 0.7 }, { bgMul: 2.2, ratio: 1.6, floor: 0.0005, gap: 0.6 }, { bgMul: 1.8, ratio: 1.4, floor: 0.0003, gap: 0.5 }];
  const GAINS = [1, 2, 4, 8];
  let sens = 4, gainIdx = 0; try { const st = JSON.parse(localStorage.getItem("mh_audio") || "{}"); if (SENS[st.sens]) sens = st.sens; if (GAINS[st.gain] !== undefined) gainIdx = st.gain; } catch (e) {}
  let curThr = 0.0012;
  function applySens() { MIN_INTERVAL = SENS[sens].gap; try { localStorage.setItem("mh_audio", JSON.stringify({ sens, gain: gainIdx })); } catch (e) {}
    document.querySelectorAll(".sensVal").forEach(e => e.textContent = sens); document.querySelectorAll(".gainVal").forEach(e => e.textContent = "×" + GAINS[gainIdx]); drawMeter(); }
  document.querySelectorAll(".sensDn,.sensUp,.gainDn,.gainUp").forEach(b => b.addEventListener("click", () => { // 버튼마다 붙임: 작은 창(PiP)으로 옮겨도 동작
    if (b.classList.contains("sensDn")) sens = Math.max(1, sens - 1); else if (b.classList.contains("sensUp")) sens = Math.min(7, sens + 1);
    else if (b.classList.contains("gainDn")) gainIdx = Math.max(0, gainIdx - 1); else gainIdx = Math.min(GAINS.length - 1, gainIdx + 1);
    applySens(); setStatus(`감도 ${sens}/7 · 증폭 ×${GAINS[gainIdx]} (빨간 선 = 소리 감지 기준. 화물 소리 때 막대가 선을 넘어야 인식 시작)`); }));
  let active = false, busy = false, lastAudioTrigger = 0, prevPeak = 0, levelPeak = 0, levelNow = 0, heardT = -1e9;

  function resetRing() { if (ring) ring.fill(0); ringPos = 0; ringFilled = 0; sinceUpdate = 0; latest = null; prevPeak = 0; }
  function ringWindow() { const n = ring.length; if (ringFilled < n) return ring.slice(0, ringFilled); const out = new Float32Array(n); out.set(ring.subarray(ringPos)); out.set(ring.subarray(0, ringPos), n - ringPos); return out; }
  function onBlock(block) {
    const gn = GAINS[gainIdx]; if (gn !== 1) for (let i = 0; i < block.length; i++) block[i] *= gn; // 증폭
    { let s2 = 0; for (const v of block) s2 += v * v; const r = Math.sqrt(s2 / Math.max(1, block.length)); levelRms = Math.max(levelRms * 0.8, r); }
    let pk = 0; for (const v of block) { const a = Math.abs(v); if (a > pk) pk = a; } levelPeak = Math.max(levelPeak * 0.85, pk);
    sampleClock += block.length;
    if (waiters.length) { const due = waiters.filter(w => w.at <= sampleClock); waiters = waiters.filter(w => w.at > sampleClock); due.forEach(w => w.r()); }
    meterAcc += block.length; if (meterAcc >= sr * 0.1) { meterAcc = 0; drawMeter(); }
    tgtAcc += block.length; if (tgtAcc >= sr * 0.05) { tgtAcc = 0; if (active) recordTarget(); } // 50ms마다 대상 화물 기록 (빠른 연속 드래그 구분용)
    if (ST.on) ST.feed(block);
    if (!active) return; // 원본: 감시 중이 아니면 오디오를 쌓지 않음
    const n = ring.length;
    for (let i = 0; i < block.length; i++) { ring[ringPos] = block[i]; ringPos = (ringPos + 1) % n; }
    ringFilled = Math.min(n, ringFilled + block.length); sinceUpdate += block.length;
    if (ringFilled < n || sinceUpdate < UPDATE_SECONDS * sr) return;
    sinceUpdate = 0;
    const win = ringWindow(), bg = MH.backgroundLevel(win, sr);
    latest = { win, bg, t: performance.now() };
    $("bgVal").textContent = bg.toFixed(5);
    if ($("optAutoTrigger").checked && !scanning) scanLoop();
  }
  // main.AudioFeed._maybe_audio_trigger
  // 새로 들어온 0.18초 구간이 바로 앞 0.5초보다 확 커지면 트리거.
  // (예전: 1.5초 창 전체 최대값끼리 비교 → 배경 잡음 봉우리가 기준의 60%만 넘어도 조용한 화물 소리를 막았음)
  function framePeak(w, a, b, fr) { let pk = 0; for (let i = Math.max(0, a); i + fr <= b; i += fr) { let s = 0; for (let j = 0; j < fr; j++) { const v = w[i + j]; s += v * v; } pk = Math.max(pk, Math.sqrt(s / fr)); } return pk; }
  function audioOnset(w, bg, sr) { const fr = Math.round(sr / 50), n = w.length, nw = Math.round(UPDATE_SECONDS * sr), ob = Math.round(0.5 * sr);
    const S = SENS[sens], now = framePeak(w, n - nw, n, fr), before = framePeak(w, n - nw - ob, n - nw, fr), thr = Math.max(S.floor, bg * S.bgMul); curThr = thr;
    return { now, before, thr, hit: now >= thr && now >= before * S.ratio }; }
  function maybeAudioTrigger(w, bg) {
    const now = performance.now() / 1000;
    const o = audioOnset(w, bg, sr); levelNow = o.now;
    if (now - lastAudioTrigger < MIN_INTERVAL || !o.hit) return;
    lastAudioTrigger = now; heardT = now;
    handleTrigger("소리 감지");
  }

  // ---------- 연속 소리 인식 (간격 제한 없음) ----------
  // 0.2초마다(매칭이 더 걸리면 끝나는 대로) 마지막 1초를 매칭 → 소리가 '언제' 났는지 찾음. 같은 소리의 겹친 검출은 합치고,
  // 그 시각에 마우스/드래그 중이던 화물에 붙임. 같은 화물에서 여러 번 나면 점수를 모음(평균)
  const SCAN_WIN = 1.0, SCAN_PERIOD = 0.2;
  const scanner = new MHEvents.EventScanner({ minScore: GOOD_ENOUGH_SCORE }), votes = new MHEvents.CargoVotes();
  let scanning = false, tgtHist = [], votesEpoch = -1, flash = { key: "", t: -1e9 };
  const audioNow = () => sampleClock / sr;
  function recordTarget() { const t = audioNow(); tgtHist.push({ t, tgt: GRID.targetNow() }); while (tgtHist.length && t - tgtHist[0].t > 5) tgtHist.shift(); }
  function targetAt(at) { let best = null; for (const h of tgtHist) { if (h.t <= at + 0.12) best = h; else break; } return best ? best.tgt : null; } // 소리 시작 직후까지의 대상
  function lastSeconds(sec) { const n = ring.length, k = Math.min(ringFilled, Math.round(sec * sr)), out = new Float32Array(k); let p = (ringPos - k + n) % n; for (let i = 0; i < k; i++) { out[i] = ring[p]; p = (p + 1) % n; } return out; }
  async function scanLoop() {
    scanning = true;
    try {
      while (active && ctx && $("optAutoTrigger").checked) {
        const t0 = audioNow();
        if (ringFilled >= SCAN_WIN * sr) {
          const w = lastSeconds(SCAN_WIN), bg = latest ? latest.bg : MH.backgroundLevel(w, sr), S = SENS[sens];
          const fr = Math.round(sr / 50); const pk = framePeak(w, 0, w.length, fr), thr = Math.max(S.floor, bg * S.bgMul); curThr = thr; levelNow = pk;
          if (pk >= thr) {
            const tm = performance.now(); const r = await match(w, sr, MH.backgroundLevel(w, sr), false);
            for (const ev of scanner.process(r.rows || [], t0 - SCAN_WIN, t0)) onSoundEvent(ev, r.reason, performance.now() - tm);
          }
        }
        await new Promise(res => { const at = sampleClock + Math.round(SCAN_PERIOD * sr); waiters.push({ at, r: res }); });
        if (audioNow() - t0 < SCAN_PERIOD * 0.5) await new Promise(res => setTimeout(res, 50));
      }
    } catch (e) { setStatus("연속 인식 오류: " + e.message); }
    finally { scanning = false; }
  }
  function onSoundEvent(ev, reason, ms) {
    if (GRID.tracker.epoch !== votesEpoch) { votes.clear(); votesEpoch = GRID.tracker.epoch; } // 화물 배치가 바뀌면 모은 점수도 버림
    heardT = performance.now() / 1000;
    const tgt = targetAt(ev.at), ck = tgt && !tgt.cellOnly ? tgt.key : "_none";
    const rows = ck === "_none" ? ev.rows : votes.add(ck, ev.id, ev.rows);
    const lat = audioNow() - ev.at;
    pendingTarget = tgt;
    if (ck !== "_none") flash = { key: ck, t: performance.now() / 1000 };
    renderRecent(rows, tgt, lat, ck !== "_none" ? votes.count(ck) : 1);
    showRows(rows, reason, `소리 ${ev.updated ? "보강" : "감지"} · 소리 시작부터 ${lat.toFixed(2)}초${ck !== "_none" && votes.count(ck) > 1 ? ` · 같은 화물 소리 ${votes.count(ck)}번 모음` : ""}`);
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

  // 소리 소스: "display" = 화면 공유 시스템 오디오, "device" = 입력 장치 직접 선택 (화면(격자)은 화면 공유에서 따로)
  let SRC = { mode: "display", deviceId: "", label: "" }; try { Object.assign(SRC, JSON.parse(localStorage.getItem("mh_src") || "{}")); } catch (e) {}
  const LIKELY = /stereo ?mix|스테레오 ?믹스|cable output|vb-?audio|voicemeeter|loopback|루프백|what u hear|wave ?out|elgato|avermedia|live gamer|usb video|cam ?link|hdmi|capture|캡처|캡쳐|game ?capture|ezcap|magewell/i;
  const MICLIKE = /mic|마이크|microphone|headset|헤드셋|webcam|array/i;
  const isMic = l => !!l && MICLIKE.test(l) && !LIKELY.test(l);
  function saveSrc() { try { localStorage.setItem("mh_src", JSON.stringify(SRC)); } catch (e) {} }
  function syncSrcUI() { document.querySelectorAll('input[name="srcMode"]').forEach(r => { r.checked = r.value === SRC.mode; }); $("devRow").hidden = SRC.mode !== "device";
    const l = SRC.deviceId && $("devSelect").selectedOptions[0] ? $("devSelect").selectedOptions[0].dataset.label || "" : "";
    $("devWarn").textContent = SRC.mode === "device" && isMic(l) ? "⚠️ 마이크로 보이는 장치입니다 — 목소리·키보드 소리도 소리로 잡힙니다. 게임 소리가 들어오는 장치(스테레오 믹스, CABLE Output, 오인페 루프백, 캡처카드)를 고르세요." : ""; }
  document.querySelectorAll('input[name="srcMode"]').forEach(r => r.addEventListener("change", () => { SRC.mode = r.value; saveSrc(); syncSrcUI(); if (SRC.mode === "device") refreshDevices(true); }));
  async function getDeviceAudio() {
    const id = $("devSelect").value || SRC.deviceId; if (!id) throw new Error("입력 장치를 먼저 고르세요. 이름이 안 보이면 「장치 목록 새로고침」을 누르세요.");
    return navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } });
  }
  const devLabel = () => { const o = $("devSelect").selectedOptions[0]; return (o && o.value && (o.dataset.label || o.textContent)) || SRC.label || "입력 장치"; };
  let srcInfo = { mode: "", label: "" };
  $("btnDisplay").onclick = async () => {
    try {
      const wantGrid = $("optGrid").checked, dev = SRC.mode === "device";
      const s = await navigator.mediaDevices.getDisplayMedia({ video: wantGrid ? { frameRate: { ideal: 10, max: 15 }, width: { ideal: 2560 }, height: { ideal: 1440 } } : { frameRate: 1, width: 320, height: 180 }, audio: dev ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false }, systemAudio: dev ? "exclude" : "include", selfBrowserSurface: "exclude", surfaceSwitching: "exclude" });
      if (dev) { let a; try { a = await getDeviceAudio(); } catch (e) { s.getTracks().forEach(t => t.stop()); throw e; }
        s.getAudioTracks().forEach(t => { t.stop(); s.removeTrack(t); }); const ms = new MediaStream([...s.getVideoTracks(), ...a.getAudioTracks()]);
        srcInfo = { mode: "device", label: devLabel() }; await attach(ms, `입력 장치: ${devLabel()} (+ 화면 공유)`); }
      else { srcInfo = { mode: "display", label: "시스템 오디오" }; await attach(s, "시스템 소리 (화면 공유)"); }
    } catch (e) { if (/오디오 트랙/.test(e.message)) ST.noAudio(); setStatus("소리 연결 실패: " + e.message); }
  };
  async function refreshDevices(askPermission) {
    try {
      if (askPermission) { const t = await navigator.mediaDevices.getUserMedia({ audio: true }); t.getTracks().forEach(x => x.stop()); } // 권한을 먼저 받아야 장치 이름이 보임
      const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput" && d.deviceId !== "communications");
      const sel = $("devSelect"), cur = sel.value || SRC.deviceId; sel.innerHTML = '<option value="">입력 장치 선택 (스테레오 믹스, 가상 케이블, 캡처카드 등)</option>';
      list.sort((a, b) => LIKELY.test(b.label) - LIKELY.test(a.label));
      list.forEach((d, i) => { const o = document.createElement("option"); o.value = d.deviceId; o.dataset.label = d.label || `입력 장치 ${i + 1}`;
        o.textContent = (LIKELY.test(d.label) ? "★ " : isMic(d.label) ? "🎤 " : "") + o.dataset.label + (LIKELY.test(d.label) ? "  (추천: 게임 소리 경로)" : isMic(d.label) ? "  (마이크 — 비추천)" : ""); if (LIKELY.test(d.label)) o.className = "likely"; sel.appendChild(o); });
      sel.value = list.some(d => d.deviceId === cur) ? cur : ""; syncSrcUI();
    } catch (e) { setStatus("장치 목록을 가져오지 못했습니다: " + e.message); }
  }
  $("devSelect").addEventListener("change", () => { SRC.deviceId = $("devSelect").value; SRC.label = devLabel(); saveSrc(); syncSrcUI(); });
  $("btnDevRefresh").onclick = () => refreshDevices(true);
  $("btnDevice").onclick = async () => { // 소리만 (화면 없이)
    try { const s = await getDeviceAudio(); SRC.mode = "device"; SRC.deviceId = $("devSelect").value || SRC.deviceId; SRC.label = devLabel(); saveSrc(); syncSrcUI(); srcInfo = { mode: "device", label: devLabel() }; await attach(s, devLabel()); }
    catch (e) { setStatus("장치 연결 실패: " + e.message); }
  };
  syncSrcUI();

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

  // ---------- 방금 난 소리 (큰 화면 패널) ----------
  function renderRecent(rows, tgt, lat, nVotes) {
    let cands = engine.resolve(rows); const sized = tgt && !tgt.cellOnly && tgt.w && tgt.h;
    if (sized) cands = cands.filter(c => { const z = MHGrid.itemSize(c); return z && z[0] === tgt.w && z[1] === tgt.h; });
    const tot = cands.reduce((a, c) => a + Math.max(1, c.score), 0) || 1;
    $("recentHead").textContent = `${new Date().toLocaleTimeString("ko-KR", { hour12: false })} · 소리 시작부터 ${lat.toFixed(2)}초 · ${sized ? `${tgt.w}×${tgt.h} 화물 (${tgt.c + 1}열) 크기만` : "화물 크기 모름 · 모든 크기"}${nVotes > 1 ? ` · 같은 화물 소리 ${nVotes}번 모음` : ""}`;
    const box = $("recentCards"); box.innerHTML = "";
    if (!cands.length) { box.innerHTML = `<div class="muted">${sized ? `${tgt.w}×${tgt.h} 크기 후보가 없습니다.` : "후보 없음"}</div>`; return; }
    for (const c of cands.slice(0, 8)) {
      const col = QUALITY_COLOR[c.quality] || "#8a93a3", z = MHGrid.itemSize(c);
      const el = document.createElement("div"); el.className = "rcard"; el.style.borderColor = col;
      el.innerHTML = `<img alt=""><div class="rn"></div><div class="rm"></div><div class="rs"></div>`;
      const im = el.querySelector("img"); im.src = "assets/images/" + encodeURIComponent(c.image); im.onerror = () => { im.style.visibility = "hidden"; };
      el.querySelector(".rn").textContent = koName(c.name); el.querySelector(".rn").style.color = col;
      el.querySelector(".rm").textContent = `${ko(QUALITY_KO, c.quality)} · ${z ? z[0] + "×" + z[1] : c.slot + "칸"}`;
      el.querySelector(".rs").textContent = `${c.score}점 · ${Math.round(100 * Math.max(1, c.score) / tot)}%`;
      box.appendChild(el);
    }
  }
  function doFullReset() { votes.clear(); listSize = null; allCands = []; lastSig = ""; rebuildCombos(); applyFilter(); $("recentCards").innerHTML = '<div class="muted">아직 소리 없음</div>'; $("recentHead").textContent = "전체 리셋됨"; GRID.fullReset(); }
  document.querySelectorAll(".btnFullReset").forEach(b => b.addEventListener("click", () => doFullReset()));

  // ---------- 결과 표시 (ui.Panel) ----------
  let allCands = [], lastSig = "", history = [], pendingTarget = null;
  // 후보 목록을 거를 화물 크기 {w,h,src}. 소리 난 화물·고른 화물·크기 버튼에서 정해짐. ✕로 해제
  let listSize = null;
  function setListSize(w, h, src) { listSize = w && h ? { w, h, src } : null; applyFilter(); }
  function showRows(rows, reason, trace) {
    const cands = engine.resolve(rows);
    const tgt = pendingTarget; pendingTarget = null;
    if (cands.length && tgt && !tgt.cellOnly && tgt.w && tgt.h) listSize = { w: tgt.w, h: tgt.h, src: tgt.manualPick ? "고른 화물" : tgt.dragged ? "드래그한 화물" : "마우스 올린 화물" }, lastSig = ""; // 크기가 바뀌면 목록 다시 그림
    // 점수가 낮은 결과(말소리·음악을 억지로 맞춘 것)는 격자 화물에 붙이지 않음
    if (cands.length && cands[0].score >= 60) GRID.onResult(cands, tgt);
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
  $("btnClear").onclick = () => { allCands = []; lastSig = ""; listSize = null; votes.clear(); rebuildCombos(); applyFilter(); };
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
    keepAlive(); applySens();
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
      const det = MHGrid.detect(gray, dw, dh, tracker.level); tracker.push(det, now(), gray); frames++; lastDet = det;
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
      const total = pool.reduce((a, c) => a + Math.max(1, c.score), 0), red = pool.some(c => c.quality === "红色");
      // 이름표 규칙: 1위 소리 그룹(정확한 크기 후보 중)에 빨강이 딱 1개면 그 빨강(소리로 특정됨). 아니면 빨강을 뺀 최상위(금색 등), 빨강 가능성은 빨간 테두리로
      const g0 = pool[0].sound_key, reds = pool.filter(c => c.sound_key === g0 && c.quality === "红色");
      const top = reds.length === 1 ? reds[0] : (pool.find(c => c.quality !== "红色") || pool[0]), uniqRed = reds.length === 1;
      const item = { w: tgt.w, h: tgt.h, name: top.name, ko: koName(top.name), quality: top.quality, price: top.reference_value_text || top.reference_value || "-", conf: Math.round(100 * Math.max(1, top.score) / total), image: top.image, n: pool.length, red, uniqRed, sure: !!tgt.dragged || !!tgt.manualPick, fit, sizeUnknown: !!top.sizeUnknown, all: pool.slice(0, 5).map(c => koName(c.name)) };
      tracker.assign(tgt.key, item); item.checkedAt = Date.now();
      checked.set(tgt.key, { key: tgt.key, r: tgt.r, c: tgt.c, w: tgt.w, h: tgt.h, item, t: new Date(), epoch: tracker.epoch, ok: true });
      checkLog.unshift({ t: new Date(), r: tgt.r, c: tgt.c, w: tgt.w, h: tgt.h, ko: item.ko, quality: item.quality, red, uniqRed, image: item.image }); if (checkLog.length > 50) checkLog.pop(); renderCheckLog();
      if (tgt.manualPick) pick = null; render();
      info(`${tgt.w}×${tgt.h} 화물 → ${item.ko} ${item.conf}%${fit ? "" : " (가로×세로가 맞는 후보가 없어 전체 후보 기준)"}`);
    }
    function priceText(p) { const n = Number(String(p).replace(/[^\d]/g, "")); return n ? (n >= 10000 ? Math.round(n / 1000) / 10 + "만" : n.toLocaleString("ko-KR")) : String(p); }
    // 확인한 화물 이름표: 스크롤·다른 화물 소리·기록 교체에도 사라지지 않음. 같은 화물을 다시 확인할 때만 바뀜
    const checked = new Map(), checkLog = [];
    function syncChecked(L) {
      for (const [k, e] of checked) {
        if (e.epoch !== tracker.epoch) { e.epoch = tracker.epoch; e.ok = false; } // 구매·재배치 리셋: 같은 자리·크기가 다시 보일 때만 살림
        const m = L.find(o => o.key === k);
        if (m && m.w === e.w && m.h === e.h) { e.ok = true; if (!m.item) tracker.assign(k, e.item); }
        else if (L.some(o => o.r < e.r + e.h && e.r < o.r + o.h && o.c < e.c + e.w && e.c < o.c + o.w)) checked.delete(k); // 그 자리에 다른 화물 → 지움
      }
    }
    function renderCheckLog() { const box = $("checkLog"); if (!box) return; box.innerHTML = checkLog.length ? "" : '<div class="muted">아직 확인한 화물 없음</div>';
      for (const e of checkLog.slice(0, 30)) { const d = document.createElement("div"); d.className = "clrow" + (e.red ? " red" : "");
        d.innerHTML = '<img alt=""><span></span>'; const im = d.querySelector("img"); im.src = "assets/images/" + encodeURIComponent(e.image || ""); im.onerror = () => { im.style.visibility = "hidden"; };
        d.querySelector("span").textContent = `${e.t.toLocaleTimeString("ko-KR", { hour12: false })} · ${e.c + 1}열 ${e.r + 1}줄 · ${e.w}×${e.h} · ${e.ko}${e.uniqRed ? " (빨강 확정)" : e.red ? " · 빨강 가능" : ""}`;
        d.querySelector("span").style.color = QUALITY_COLOR[e.quality] || ""; box.appendChild(d); } }
    let lastSig = "";
    function render() {
      const L0 = tracker.list(); syncChecked(L0); const ghosts = [...checked.values()].filter(e => e.ok && !L0.some(o => o.key === e.key) && !L0.some(o => o.r < e.r + e.h && e.r < o.r + o.h && o.c < e.c + e.w && e.c < o.c + o.w)).map(e => ({ key: e.key, r: e.r, c: e.c, w: e.w, h: e.h, item: e.item, ghost: true }));
      const L = L0.concat(ghosts), [r0, r1raw] = tracker.rows(), ncol = tracker.ncol || 9, r1 = Math.max(r1raw, r0 + 5);
      const tg = tracker.target(now()), tkey = tg ? tg.key : "";
      const tnow = performance.now() / 1000, lkey = pick || tkey, listening = !!(active && scanning && lkey), flashKey = tnow - flash.t < 1.2 ? flash.key : "";
      const sig = JSON.stringify([L.map(k => [k.key, k.w, k.h, k.item && [k.item.name, k.item.conf, k.item.sure, k.item.checkedAt], votes.count(k.key), !!k.ghost, checked.has(k.key)]), r0, r1, ncol, tkey, pick, size, listening, flashKey]);
      if (lastDet) info(`화물창 인식: ${lastDet.ncol}열 · 화물 ${L.length}개 · 기록된 줄 ${r1raw - r0 + 1}줄${tg ? ` · 대상 ${tg.c + 1}열 ${tg.r - r0 + 1}줄` : ""}`);
      else if (running && frames > FPS * 2) info(`화면 읽는 중… 상인 화물창이 보이지 않습니다. (기록 ${L.length}개 유지)`);
      if (sig === lastSig) return; lastSig = sig;
      const box = $("gridMap"); box.innerHTML = "";
      const g = document.createElement("div"); g.className = "g"; g.style.width = `calc(var(--cs) * ${ncol})`; g.style.height = `calc(var(--cs) * ${r1 - r0 + 1})`;
      const pos = (el, c, r, w, h) => { el.style.left = `calc(var(--cs) * ${c})`; el.style.top = `calc(var(--cs) * ${r - r0})`; el.style.width = `calc(var(--cs) * ${w})`; el.style.height = `calc(var(--cs) * ${h})`; };
      for (let r = r0; r <= r1; r++) for (let c = 0; c < ncol; c++) { const el = document.createElement("div"); el.className = "cell"; el.dataset.c = c; el.dataset.r = r; pos(el, c, r, 1, 1); g.appendChild(el); }
      for (const k of L) {
        const el = document.createElement("div"); el.className = "cargo" + (k.manual ? " manual" : "") + (k.key === tkey ? " tgt" : "") + (k.key === pick ? " pick" : "") + (listening && k.key === lkey ? " listen" : "") + (k.key === flashKey ? " flash" : "");
        el.dataset.c = k.c; el.dataset.r = k.r; el.dataset.key = k.key; pos(el, k.c, k.r, k.w, k.h);
        const it = k.item || (checked.get(k.key) && checked.get(k.key).w === k.w && checked.get(k.key).h === k.h ? checked.get(k.key).item : null); if (k.ghost) el.classList.add("ghost");
        if (it) { const col = QUALITY_COLOR[it.quality] || "#8a93a3"; el.style.background = col + "33"; el.style.borderColor = col; if (it.red) el.classList.add("red");
          el.title = `${it.ko} (${ko(QUALITY_KO, it.quality)})${it.sizeUnknown ? " · 크기 정보 없음" : ""}\n참고 가치 ${it.price}\n후보 ${it.n}개: ${it.all.join(", ")}`;
          const pct = (it.n === 1 ? "100%" : it.conf + "%") + (it.sure ? " ✓" : "");
          el.innerHTML = `<img class="gi" alt=""><span class="pr"></span><span class="pc"></span><div class="nm"></div>`;
          const im = el.querySelector("img"); im.src = "assets/images/" + encodeURIComponent(it.image || ""); im.onerror = () => { im.replaceWith(Object.assign(document.createElement("span"), { className: "q", textContent: "?" })); };
          if (!(it.sure || it.n === 1)) el.classList.add("dim");
          if (k.w * k.h === 1) el.classList.add("one");
          el.querySelector(".nm").textContent = it.ko; el.querySelector(".pr").textContent = priceText(it.price); el.querySelector(".pc").textContent = pct; el.querySelector(".pc").style.background = col; }
        else { el.title = "아직 모름 — 드래그하면 소리로 맞힙니다"; el.innerHTML = `<span class="q">?</span>`; }
        if (checked.has(k.key) && it) { el.classList.add("checked"); const cb = document.createElement("span"); cb.className = "cbadge"; cb.title = "확인한 화물 — 다시 드래그하면 새 결과로 바뀝니다"; cb.textContent = it.uniqRed ? "✓빨강" : "✓"; el.appendChild(cb); }
        const sz = document.createElement("span"); sz.className = "sz"; sz.textContent = `${k.w}×${k.h}`; el.appendChild(sz);
        if (listening && k.key === lkey) { const b = document.createElement("span"); b.className = "lbadge"; b.textContent = "듣는 중"; el.appendChild(b); }
        const nv = votes.count(k.key); if (nv) { const b = document.createElement("span"); b.className = "nbadge"; b.title = `이 화물에서 모은 소리 ${nv}번`; b.textContent = `🔊${nv}`; el.appendChild(b); }
        g.appendChild(el);
      }
      box.appendChild(g);
      const pk = pick && L.find(o => o.key === pick), bar = $("cargoBar");
      if (pk) { bar.hidden = false; $("cargoBarText").textContent = `고른 화물: ${pk.c + 1}열 ${pk.r - r0 + 1}줄 · ${pk.w}×${pk.h}${pk.item ? " · " + pk.item.ko : ""}${votes.count(pk.key) ? ` · 소리 ${votes.count(pk.key)}번` : ""}`; } else bar.hidden = true;
    }
    // 이 화물만 리셋: 이름표·모은 소리 점수·직접 지정 크기·그 자리 기록을 지워 다시 인식하게 함
    function resetCargo(key) { checked.delete(key); tracker.items.delete(key); tracker.manual.delete(key); for (const [kk, o] of tracker.obs) if (`${o.r},${o.c}` === key) tracker.obs.delete(kk); votes.clear(key); tracker._list = null; pick = null; lastSig = ""; render(); info("이 화물을 리셋했습니다. 다시 드래그하면 새로 인식합니다."); }
    $("btnCargoReset").onclick = () => { if (pick) resetCargo(pick); };
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
    function refresh() { lastSig = ""; render(); }
    function fullReset() { checked.clear(); checkLog.length = 0; renderCheckLog(); tracker.reset(); pick = null; size = null; $("gridBox").querySelectorAll("[data-size]").forEach(x => x.classList.remove("sel")); lastSig = ""; render(); info("전체 리셋: 격자 기록·이름표·모은 소리 점수·크기 필터를 모두 비웠습니다."); }
    render();
    return { start, stop, onResult, targetNow, info, tracker, refresh, fullReset, checked, checkLog, setPick: k => { pick = k; refresh(); } };
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
    // dB 눈금(-60~0 dB): 화물 소리는 -45~-35 dB 정도로 작아서 직선 눈금이면 막대가 안 보였음
    const db = levelRms > 0 ? 20 * Math.log10(levelRms) : -99, w = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + "%"; $("meterBar").style.width = w; $("miniMeterBar").style.width = w;
    const heard = performance.now() / 1000 - heardT < 1.2;
    const tdb = 20 * Math.log10(curThr), tl = Math.max(0, Math.min(99, (tdb + 60) / 60 * 100)) + "%"; document.querySelectorAll(".thrLine").forEach(e => { e.style.left = tl; e.title = `소리 감지 기준 ${tdb.toFixed(0)} dB`; });
    $("meterBar").style.background = $("miniMeterBar").style.background = heard ? "#ffd84a" : "";
    $("miniLevel").textContent = ctx ? `입력 ${db > -99 ? db.toFixed(0) : "-∞"} dB · ${ctx.state !== "running" ? "오디오 " + ctx.state : heard ? "🔔 소리 들림 (인식 중)" : db < -70 ? "소리가 안 들어옴 — 공유 창에서 「시스템 오디오 공유」 확인" : "오디오 들어오는 중"}` : "소리 소스 없음";
  }
  setInterval(() => { if (!ctx || ctx.state !== "running") drawMeter(); }, 500);
  applySens(); // 저장된 감도·증폭 표시
  // 탭이 숨겨지거나 포커스를 잃어도 AudioContext 를 계속 깨워 둠
  function keepAlive() { if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {}); }
  document.addEventListener("visibilitychange", keepAlive); window.addEventListener("blur", keepAlive);

  // ---------- 사운드 테스트 (창고에서) — 격자 없이 소리 경로만 단계별 점검 ----------
  const STEP2_TIPS = [
    "① 게임에서 아무 소리나 나게 해 보세요(메뉴 클릭, 아이템 옮기기).",
    "② Windows 설정 > 시스템 > 소리 > 「앱 볼륨 및 장치 기본 설정」에서 게임의 출력 장치가 「기본값」 또는 Windows 기본 출력과 같은지 확인하세요.",
    "③ 오디오 인터페이스(오인페) 사용: 오인페 프로그램에서 루프백(Loopback)을 켜고, 위 「소리 소스」를 「입력 장치 직접 선택」으로 바꿔 오인페의 루프백 입력(또는 스테레오 믹스)을 고르세요.",
    "④ Voicemeeter / VB-Cable 사용: 게임 소리가 가는 버스에 맞춰 「VoiceMeeter Out B1」 또는 「CABLE Output」을 입력 장치로 고르세요.",
    "⑤ 캡처카드(콘솔·다른 PC 게임): 「입력 장치 직접 선택」에서 캡처카드 오디오(Elgato, AVerMedia, USB Video, Cam Link, HDMI 등)를 고르세요.",
    "⑥ 블루투스 헤드셋·HDMI 모니터 스피커로 들을 때: 그 장치가 Windows 기본 출력이어야 화면 공유로 잡힙니다. 아니면 「스테레오 믹스」를 켜고 입력 장치로 고르세요.",
    "⑦ 화면 공유 모드라면 공유를 다시 하고 「전체 화면」 + 「시스템 오디오도 공유」를 켜세요."];
  { const hl = document.getElementById("helpTips"); if (hl) hl.innerHTML = STEP2_TIPS.map(t => `<li>${t.replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c])}</li>`).join(""); }
  const STEP2_GUIDE = () => (SRC.mode === "device" ? `지금 고른 입력 장치 「${srcInfo.label}」에 게임 소리가 안 들어옵니다.\n` : "화면 공유 시스템 오디오는 Windows 「기본 출력 장치」의 소리만 가져옵니다. 게임이 다른 장치로 나가면 무음입니다.\n") + STEP2_TIPS.join("\n");
  const ST = (() => {
    const N_SILENT = 6, N_WAIT = 30;
    let on = false, buf = null, bpos = 0, bfill = 0, t = 0, tStart = 0, timer = null, sMatch = null;
    let T1 = 0, T2 = 0, HIT = {}, s = {}, lvl = { max: -99, sum: 0, n: 0, loud: 0 }, hist = [], near = 0, over = 0, ticks = 0, lastHit = -9, tries = [], noAudioErr = false, matching = false;
    const ua = navigator.userAgent, isFF = /Firefox\//.test(ua), isSafari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
    const browser = (ua.match(/(Edg|Whale|OPR|Chrome|Firefox|Version)\/([\d]+)/) || [, "?", ""]).slice(1).join(" ").replace("Version", "Safari") + (/Windows/.test(ua) ? " · Windows" : /Mac OS/.test(ua) ? " · macOS" : /Linux/.test(ua) ? " · Linux" : "");
    const STEPS = ["화면 공유 + 시스템 오디오", "소리가 들어오는지", "아이템을 옮길 때 소리가 기준선을 넘는지", "소리가 물품 소리 그룹과 맞는지"];
    function feed(b) { if (!buf || buf.length !== Math.round(sr * 1.5)) { buf = new Float32Array(Math.round(sr * 1.5)); bpos = 0; bfill = 0; } for (let i = 0; i < b.length; i++) { buf[bpos] = b[i]; bpos = (bpos + 1) % buf.length; } bfill = Math.min(buf.length, bfill + b.length); }
    function last(sec) { const n = buf.length, k = Math.min(bfill, Math.round(sec * sr)), o = new Float32Array(k); let p = (bpos - k + n) % n; for (let i = 0; i < k; i++) { o[i] = buf[p]; p = (p + 1) % n; } return o; }
    const dB = v => v > 0 ? 20 * Math.log10(v) : -99, f0 = v => v > -99 ? v.toFixed(0) : "-∞";
    function set(i, st, msg, hint) { s[i] = { st, msg, hint: hint || "" }; }
    function reset() { s = {}; STEPS.forEach((_, i) => set(i, "wait", "대기")); lvl = { max: -99, sum: 0, n: 0, loud: 0 }; hist = []; near = 0; over = 0; ticks = 0; lastHit = -9; tries = []; sMatch = null; T1 = T2 = 0; HIT = {}; }
    async function start() {
      reset(); on = true; tStart = performance.now() / 1000; buf = null;
      $("stPanel").classList.add("running"); $("stPanel").scrollIntoView({ behavior: "smooth", block: "start" });
      if (SRC.mode === "device" && !stream) { set(0, "run", "입력 장치 모드: 장치에서 소리를 가져옵니다 (화면은 격자용으로만 공유)."); render(); try { await ($("optGrid").checked ? $("btnDisplay") : $("btnDevice")).onclick(); } catch (e) {} }
      else if (isFF || isSafari || !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) set(0, "fail", `이 브라우저(${browser})는 화면 공유로 시스템 소리를 못 가져옵니다.`, "Windows의 Chrome 또는 Edge로 이 페이지를 여세요. (Firefox·Safari는 시스템 오디오 공유가 안 됩니다.) 다른 방법: 「스테레오 믹스」나 가상 오디오 케이블을 입력 장치로 고르고 「이 장치 사용」.");
      else if (!stream) { set(0, "run", "화면 공유 창을 띄웠습니다. 「전체 화면」 탭 → 화면 선택 → 「시스템 오디오도 공유」를 켜고 「공유」를 누르세요."); render(); noAudioErr = false; try { await $("btnDisplay").onclick(); } catch (e) {} }
      if (!timer) timer = setInterval(tick, 200); tick();
    }
    function stop() { on = false; if (timer) clearInterval(timer); timer = null; $("stPanel").classList.remove("running"); render(); }
    function tick() {
      if (!on) return; const now = performance.now() / 1000; ticks++;
      // 1. 공유 + 오디오 트랙
      if (s[0].st !== "fail" || stream) {
        if (!stream) { if (noAudioErr || now - tStart > 4) set(0, "fail", noAudioErr ? "화면은 공유됐지만 소리(오디오 트랙)가 없습니다." : "아직 소리 소스가 연결되지 않았습니다.", "「화면 공유로 시스템 소리 가져오기」를 다시 누르고, 공유 창에서 「전체 화면」 탭 → 화면 선택 → 아래 「시스템 오디오도 공유」 스위치를 켠 뒤 공유하세요. 「창」 탭이나 다른 「Chrome 탭」을 고르면 게임 소리가 안 옵니다."); }
        else { const vt = stream.getVideoTracks()[0], at = stream.getAudioTracks()[0], surf = vt && vt.getSettings ? vt.getSettings().displaySurface : "";
          if (!at || at.readyState === "ended") set(0, "fail", "오디오 트랙이 끊겼습니다.", "공유를 중지하고 다시 공유하세요. 「시스템 오디오도 공유」를 켜야 합니다.");
          else if (srcInfo.mode === "device") set(0, isMic(srcInfo.label) ? "warn" : "ok", `입력 장치 「${srcInfo.label}」 사용 · ${sr} Hz${vt ? " · 화면은 격자용" : ""}`, isMic(srcInfo.label) ? "마이크로 보이는 장치입니다. 목소리·키보드 소리도 잡혀서 오인식됩니다. 게임 소리 경로(스테레오 믹스·CABLE Output·루프백·캡처카드)를 고르세요." : "");
          else if (surf === "browser") set(0, "fail", "브라우저 탭만 공유됐습니다 — 그 탭의 소리만 오고 게임 소리는 안 옵니다.", "공유를 다시 하고 「전체 화면」 탭을 고른 뒤 「시스템 오디오도 공유」를 켜세요.");
          else if (surf === "window") set(0, "warn", "창 공유는 소리가 안 올 수 있습니다.", "「전체 화면」 공유 + 「시스템 오디오도 공유」를 권장합니다. 아래 2단계가 통과하면 그대로 써도 됩니다.");
          else set(0, "ok", vt ? `화면 공유(${surf || "화면"}) + 오디오 트랙 있음 · ${sr} Hz` : `입력 장치(${$("srcName").textContent}) 사용 · ${sr} Hz`); }
      }
      if (!stream || !ctx || !buf || bfill < sr * 0.5) { render(); return; }
      // 2. 소리가 들어오는지
      const w02 = last(0.2), fr = Math.round(sr / 50), pk = framePeak(w02, 0, w02.length, fr), d = dB(pk);
      lvl.max = Math.max(lvl.max, d); lvl.sum += d; lvl.n++; if (d > -70) lvl.loud++;
      if (!T1) T1 = now;
      if (ctx.state !== "running") set(1, "fail", `오디오가 멈춰 있습니다 (${ctx.state}).`, "이 페이지를 한 번 클릭하세요. 탭을 백그라운드로 보내지 말고 작은 창(항상 위)을 쓰세요.");
      else if (lvl.loud >= 2) set(1, "ok", `소리 들어옴 · 지금 ${f0(d)} dB · 최대 ${f0(lvl.max)} dB`);
      else if (now - T1 > N_SILENT) set(1, "fail", `${N_SILENT}초 동안 소리가 전혀 없습니다 (최대 ${f0(lvl.max)} dB).`, STEP2_GUIDE());
      else set(1, "run", `소리를 기다리는 중… 지금 ${f0(d)} dB`);
      if (s[1].st !== "ok") { render(); return; }
      // 3. 창고에서 아이템 드래그 → 기준선 넘는지
      const S = SENS[sens], w = last(1.5), bg = MH.backgroundLevel(w, sr), thr = Math.max(S.floor, bg * S.bgMul), before = framePeak(w, w.length - Math.round(0.7 * sr), w.length - w02.length, fr);
      curThr = thr; const isOver = pk >= thr; hist.push(isOver ? 1 : 0); if (hist.length > 25) hist.shift(); if (isOver) over++;
      const overFrac = hist.reduce((a, b) => a + b, 0) / hist.length, onset = pk >= before * S.ratio;
      if (!T2) T2 = now;
      if (isOver && onset && now - lastHit > 0.6) { lastHit = now; sMatch = now + 0.45; HIT.d = d; HIT.thr = dB(thr); HIT.last = d; }
      else if (!isOver && onset && pk >= thr / 4 && d > -75) near = Math.max(near, d - dB(thr));
      const tdb = f0(dB(thr));
      if (HIT.d !== undefined) set(2, "ok", `소리 감지됨 · ${f0(HIT.d)} dB (기준선 ${f0(HIT.thr)} dB) · 감도 ${sens}/7 · 증폭 ×${GAINS[gainIdx]}`, hist.length >= 25 && overFrac > 0.6 ? "※ 배경 소리가 계속 기준선 근처입니다. 음악·보이스챗·TTS·마이크 소리를 줄이세요." : "");
      else if (hist.length >= 25 && overFrac > 0.6) set(2, "warn", `소리가 계속 기준선(${tdb} dB) 위에 있습니다 — 잡음이 너무 큽니다.`, "게임 배경음악·보이스챗·디스코드·TTS·마이크 모니터링을 끄거나 줄이세요. 감도를 1~2 낮추면 덜 민감해집니다. 그다음 다시 아이템을 옮겨 보세요.");
      else if (now - T2 > N_WAIT) set(2, "fail", `${N_WAIT}초 동안 기준선(${tdb} dB)을 넘는 소리가 없었습니다.${near ? ` 가장 가까웠던 소리는 기준선보다 ${(-near).toFixed(0)} dB 작았습니다.` : ""}`, "소리가 너무 작습니다: 감도(+)를 올리거나 증폭(×2, ×4)을 올리세요. 게임 설정에서 효과음(SFX) 볼륨을 올리고 배경음악·음성은 내리세요. 창고에서 아이템을 마우스로 집어 다른 칸에 놓아 보세요.");
      else set(2, "run", `창고(stash)에서 아무 아이템이나 마우스로 집어 다른 칸에 옮겨 보세요… (지금 ${f0(d)} dB, 기준선 ${tdb} dB${near ? `, 가까웠던 소리 ${near.toFixed(0)} dB` : ""})`);
      // 4. 매칭
      if (sMatch && now >= sMatch && !matching) { sMatch = null; matching = true; const x = last(1.2);
        match(x, sr, MH.backgroundLevel(x, sr), true).then(r => { tries.push({ rows: (r.rows && r.rows.length ? r.rows : r.weak || []).slice(0, 5), strong: !!(r.rows && r.rows.length), at: new Date(), db: HIT.last }); if (tries.length > 30) tries.shift(); judge(); }).catch(e => set(3, "fail", "인식 오류: " + e.message)).finally(() => { matching = false; render(); }); }
      if (HIT.d === undefined && !tries.length) set(3, "wait", "3단계를 기다리는 중");
      render();
    }
    function picked() { const v = $("stItem").value.trim(); if (!v) return null; const all = db.items.concat(db.special_items); return all.find(i => koName(i.name) === v || i.name === v || enName(i.name).toLowerCase() === v.toLowerCase()) || null; }
    function rankOf(rows, it) { if (!it) return -1; return rows.findIndex(r => r.key === it.sound_type || r.key === it.name || (r.items || []).some(x => x.name === it.name)); }
    function judge() {
      const tr = tries[tries.length - 1]; if (!tr) return; const top = tr.rows[0], it = picked(), rk = rankOf(tr.rows, it);
      if (!top) set(3, "fail", "소리는 들렸지만 어떤 물품 소리와도 맞지 않았습니다.", "아이템 소리 말고 다른 소리(발소리·UI 클릭·음악)였을 수 있습니다. 배경음악·음성을 줄이고 아이템을 한 번만 옮긴 뒤 1초 기다리세요. 잘 안 되면 감도를 1 낮추세요.");
      else if (!tr.strong) set(3, "warn", `약하게만 맞았습니다: ${sndName(top.key)} ${top.score}점 (기준 ${GOOD_ENOUGH_SCORE}점 미만)`, "잡음이 섞였거나 소리가 작습니다. 효과음 볼륨을 올리고 음악·음성을 줄인 뒤 다시 옮겨 보세요.");
      else if (it && rk < 0) set(3, "warn", `맞은 소리: ${sndName(top.key)} ${top.score}점 — 고른 「${koName(it.name)}」의 소리 그룹은 상위 ${tr.rows.length}개에 없음`, "옮긴 아이템을 정확히 골랐는지 확인하고 한 번 더 옮겨 보세요. 계속 다르면 아래 진단 글을 방송인에게 보내 주세요.");
      else set(3, "ok", `맞은 소리: ${sndName(top.key)} ${top.score}점${it ? ` · 고른 「${koName(it.name)}」 ${rk + 1}위${rk === 0 ? " ✔" : ""}` : ""}`, it ? "" : "아래 그림 중에 방금 옮긴 아이템이 있으면 정상입니다. (선택: 옮긴 아이템 이름을 입력하면 몇 위인지 보여줍니다)");
    }
    const ICON = { ok: "✅", fail: "❌", warn: "⚠️", run: "⏳", wait: "·" };
    function render() {
      const ol = $("stSteps"); ol.innerHTML = "";
      STEPS.forEach((nm, i) => { const x = s[i] || { st: "wait", msg: "대기" }; const li = document.createElement("li"); li.className = "st-" + x.st;
        li.innerHTML = `<span class="sti"></span> <b></b><div class="stm"></div>${x.hint ? '<div class="sth"></div>' : ""}`;
        li.querySelector(".sti").textContent = ICON[x.st]; li.querySelector("b").textContent = `${i + 1}. ${nm}`; li.querySelector(".stm").textContent = x.msg; if (x.hint) li.querySelector(".sth").textContent = "→ " + x.hint; ol.appendChild(li); });
      const tr = tries[tries.length - 1], box = $("stMatch"); box.innerHTML = "";
      if (tr) { const it = picked(), rk = rankOf(tr.rows, it);
        tr.rows.forEach((r, i) => { const cands = engine.resolve([r]).slice(0, 6), el = document.createElement("div"); el.className = "stgrp" + (i === rk ? " hit" : "");
          el.innerHTML = `<div class="stgh"></div><div class="stimgs"></div>`; el.querySelector(".stgh").textContent = `${i + 1}위 · ${sndName(r.key)} · ${r.score}점${i === rk ? " ← 고른 아이템" : ""}`;
          for (const c of cands) { const im = document.createElement("img"); im.src = "assets/images/" + encodeURIComponent(c.image); im.title = koName(c.name); im.style.borderColor = QUALITY_COLOR[c.quality] || "#8a93a3"; im.onerror = () => { im.style.visibility = "hidden"; }; el.querySelector(".stimgs").appendChild(im); }
          box.appendChild(el); }); }
      const lg = $("stLog"); lg.innerHTML = tries.length ? "" : '<div class="muted">아직 감지된 소리 없음 — 창고에서 아이템을 옮겨 보세요.</div>';
      for (const t of tries.slice().reverse().slice(0, 12)) { const cands = engine.resolve(t.rows).slice(0, 8), tot = cands.reduce((a, c) => a + Math.max(1, c.score), 0) || 1, row = document.createElement("div"); row.className = "stlog";
        row.innerHTML = '<div class="stlh"></div><div class="recentcards"></div>'; row.querySelector(".stlh").textContent = `${t.at.toLocaleTimeString("ko-KR", { hour12: false })} · ${f0(t.db === undefined ? -99 : t.db)} dB · ${t.rows[0] ? sndName(t.rows[0].key) + " " + t.rows[0].score + "점" : "맞는 소리 없음"}${t.strong ? "" : " (약함)"} · 모든 크기 후보 ${engine.resolve(t.rows).length}개`;
        for (const c of cands) { const col = QUALITY_COLOR[c.quality] || "#8a93a3", z = MHGrid.itemSize(c), el = document.createElement("div"); el.className = "rcard"; el.style.borderColor = col;
          el.innerHTML = '<img alt=""><div class="rn"></div><div class="rm"></div><div class="rs"></div>'; const im = el.querySelector("img"); im.src = "assets/images/" + encodeURIComponent(c.image); im.onerror = () => { im.style.visibility = "hidden"; };
          el.querySelector(".rn").textContent = koName(c.name); el.querySelector(".rn").style.color = col; el.querySelector(".rm").textContent = `${ko(QUALITY_KO, c.quality)} · ${z ? z[0] + "×" + z[1] : c.slot + "칸"}`; el.querySelector(".rs").textContent = `${c.score}점 · ${Math.round(100 * Math.max(1, c.score) / tot)}%`; row.querySelector(".recentcards").appendChild(el); }
        lg.appendChild(row); }
      const sts = STEPS.map((_, i) => (s[i] || {}).st), done = sts.every(x => x === "ok"), bad = sts.indexOf("fail");
      $("stSummary").className = "stsum " + (done ? "ok" : bad >= 0 ? "fail" : sts.includes("warn") ? "warn" : "");
      $("stSummary").textContent = done ? "✅ 통과: 소리 인식이 정상입니다. 상인 화면에서 화물을 드래그하면 됩니다." : bad >= 0 ? `❌ ${bad + 1}단계에서 막혔습니다 — 위 → 안내대로 고친 뒤 다시 해 보세요.` : on ? "진행 중…" : "「사운드 테스트 시작」을 누르세요.";
      $("stDiag").value = diag(); const mini = $("stMini"); if (mini) mini.textContent = on || tries.length ? "사운드 테스트: " + sts.map(x => ICON[x || "wait"]).join("") : "";
      $("btnStStart").textContent = on ? "다시 시작" : "사운드 테스트 시작";
    }
    function diag() {
      const tr = tries[tries.length - 1], it = picked(), vt = stream && stream.getVideoTracks()[0], surf = vt && vt.getSettings ? vt.getSettings().displaySurface : "";
      return [`[행상도우미 사운드테스트] ${new Date().toLocaleString("ko-KR", { hour12: false })}`, `브라우저 ${browser}`,
        `소리모드 ${SRC.mode === "device" ? "입력장치" : "화면공유 시스템오디오"} · 장치 ${srcInfo.label || SRC.label || "-"}${isMic(srcInfo.label) ? " (마이크?)" : ""}`, `소스 ${stream ? (vt ? "화면공유(" + (surf || "?") + ")" : "장치만") : "없음"} · 오디오트랙 ${stream && stream.getAudioTracks().length ? "있음" : "없음"} · ${ctx ? sr + "Hz " + ctx.state : "-"}`,
        `레벨 최대 ${f0(lvl.max)}dB 평균 ${lvl.n ? f0(lvl.sum / lvl.n) : "-"}dB · 기준선 ${f0(dB(curThr))}dB · 넘은비율 ${hist.length ? Math.round(100 * hist.reduce((a, b) => a + b, 0) / hist.length) : 0}%`,
        `감도 ${sens}/7 · 증폭 ×${GAINS[gainIdx]}`, `단계 ${STEPS.map((_, i) => `${i + 1}${{ ok: "O", fail: "X", warn: "!", run: "…", wait: "-" }[(s[i] || {}).st || "wait"]}`).join(" ")}`,
        `매칭 ${tries.length}회${tr ? ": " + tr.rows.slice(0, 3).map(r => `${sndName(r.key)} ${r.score}`).join(", ") + (tr.strong ? "" : " (약함)") : ""}${it ? ` · 옮긴 아이템 ${koName(it.name)} ${rankOf(tr ? tr.rows : [], it) + 1 || "순위밖"}위` : ""}`].join("\n");
    }
    reset();
    const dl = $("stItems"); for (const i of db.items.concat(db.special_items)) { const o = document.createElement("option"); o.value = koName(i.name); dl.appendChild(o); }
    $("btnStStart").onclick = () => { setMode(true); start(); }; $("btnStStop").onclick = () => stop();
    function setMode(v) { $("optTestMode").checked = v; $("stBody").hidden = !v; $("stPanel").classList.toggle("open", v); document.body.classList.toggle("testmode", v); if (!v) stop(); }
    $("optTestMode").addEventListener("change", e => { setMode(e.target.checked); if (e.target.checked) start(); });
    $("stItem").addEventListener("change", () => { judge(); render(); });
    $("btnStCopy").onclick = async () => { const tx = diag(); try { await navigator.clipboard.writeText(tx); $("btnStCopy").textContent = "복사됨 ✔"; } catch (e) { $("stDiag").select(); document.execCommand("copy"); $("btnStCopy").textContent = "복사됨"; } setTimeout(() => { $("btnStCopy").textContent = "진단 글 복사"; }, 1500); };
    document.querySelectorAll(".btnSoundTest").forEach(b => b.addEventListener("click", () => { try { window.focus(); } catch (e) {} setMode(true); start(); }));
    render();
    return { get on() { return on; }, feed, start, setMode, stop, noAudio: () => { noAudioErr = true; }, state: () => ({ steps: STEPS.map((_, i) => s[i]), tries, diag: diag() }) };
  })();

  // 테스트용 훅 (콘솔): 원본 효과음을 오프라인으로 인식
  window.MH_TEST = { ST, match: (x, s, bg) => match(x, s, bg || 0, false), engine, showRows, b64ToBuf, GRID, setTarget: t => { pendingTarget = t; },
    // 테스트용: 감시 상태 흉내 + 소리 사건 주입
    sim: { listen: v => { active = v; scanning = v; GRID.refresh(); }, event: (rows, id) => { sampleClock = Math.max(sampleClock, 48000 * 10); sr = sr || 48000; tgtHist.push({ t: audioNow() - 0.3, tgt: GRID.targetNow() }); onSoundEvent({ id: id || Math.random(), key: rows[0].key, at: audioNow() - 0.3, score: rows[0].score, rows, updated: false }, "테스트", 0); GRID.refresh(); }, votes } };
})();
