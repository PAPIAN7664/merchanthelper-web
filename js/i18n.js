/* 다국어(UI 번역). 원문은 한국어. 사전: js/i18n_dict.js (MH_I18N_DICT[lang][한국어 원문] = 번역) */
(function () {
  const LANGS = [["ko", "한국어"], ["en", "English"], ["zh-CN", "简体中文"], ["zh-TW", "繁體中文"], ["ja", "日本語"], ["ru", "Русский"], ["es", "Español"], ["pt-BR", "Português (BR)"], ["de", "Deutsch"], ["fr", "Français"], ["tr", "Türkçe"], ["th", "ไทย"], ["vi", "Tiếng Việt"], ["id", "Bahasa Indonesia"]];
  const CODES = LANGS.map(l => l[0]);
  const KEY = "mh_lang", HAN = /[가-힣]/;
  function detect() {
    const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || "en"]).map(s => String(s));
    for (const l of list) {
      const s = l.toLowerCase();
      if (s.startsWith("zh")) return /tw|hk|mo|hant/.test(s) ? "zh-TW" : "zh-CN";
      if (s.startsWith("pt")) return "pt-BR";
      const b = s.split("-")[0]; if (b === "in") return "id";
      const hit = CODES.find(c => c === b); if (hit) return hit;
    }
    return "en";
  }
  let lang; try { lang = localStorage.getItem(KEY); } catch (e) {}
  if (!CODES.includes(lang)) lang = detect();
  const norm = s => s.replace(/\s+/g, " ").trim();
  let dict = {}, tpls = [], subs = [];
  function build() {
    dict = (window.MH_I18N_DICT && window.MH_I18N_DICT[lang]) || {};
    tpls = []; subs = [];
    for (const k of Object.keys(dict)) {
      if (/\{\d+\}/.test(k)) {
        const re = new RegExp("^" + k.split(/(\{\d+\})/).map(p => /^\{\d+\}$/.test(p) ? "([\\s\\S]*?)" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
        const idx = (k.match(/\{\d+\}/g) || []).map(x => +x.slice(1, -1));
        tpls.push({ re, idx, k, lit: k.replace(/\{\d+\}/g, "").length });
      } else if (k.length >= 2 && !/<[^>]+>/.test(k)) subs.push(k);
    }
    tpls.sort((a, b) => b.lit - a.lit); subs.sort((a, b) => b.length - a.length);
  }
  function t(s) {
    if (lang === "ko" || !s || !HAN.test(s)) return s;
    const n = norm(s); if (!n) return s;
    if (dict[n] != null) return dict[n];
    for (const tp of tpls) {
      const m = n.match(tp.re); if (!m) continue;
      let out = dict[tp.k]; tp.idx.forEach((ix, g) => { out = out.split("{" + ix + "}").join(t(m[g + 1])); });
      return out;
    }
    const seg = n.split(" · ");
    if (seg.length > 1) return seg.map(t).join(" · ");
    let out = n; for (const k of subs) if (out.includes(k)) out = out.split(k).join(dict[k]);
    return out;
  }
  const INLINE = new Set(["B", "U", "EM", "A", "CODE", "I", "BR", "SMALL", "STRONG", "SPAN", "KBD", "SUP", "SUB"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "IFRAME", "SVG", "CANVAS", "VIDEO", "SELECT"]);
  function isUnit(el) {
    if (SKIP.has(el.tagName) || !el.firstElementChild) return false;
    for (const d of el.querySelectorAll("*")) if (!INLINE.has(d.tagName) || d.id || d.classList.contains("notr")) return false;
    return HAN.test(el.textContent);
  }
  const ATTRS = ["title", "placeholder", "aria-label"];
  function attrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a), st = el.__mhA || (el.__mhA = {});
      if (!st[a] || st[a].out !== cur) st[a] = { src: cur, out: null };
      const v = lang === "ko" ? st[a].src : t(st[a].src);
      st[a].out = v; if (v !== cur) el.setAttribute(a, v);
    }
  }
  function textNode(n) {
    if (n.__mhOut !== n.nodeValue) n.__mhSrc = n.nodeValue;
    const src = n.__mhSrc; if (!HAN.test(src)) { n.__mhOut = n.nodeValue; return; }
    const lead = src.match(/^\s*/)[0], trail = src.match(/\s*$/)[0];
    const v = lang === "ko" ? src : lead + t(src) + trail;
    n.__mhOut = v; if (v !== n.nodeValue) n.nodeValue = v;
  }
  function unit(el) {
    if (el.__mhOut !== el.innerHTML) el.__mhSrc = el.innerHTML;
    const src = el.__mhSrc, key = norm(src);
    if (lang === "ko") { if (el.innerHTML !== src) el.innerHTML = src; el.__mhOut = el.innerHTML; return true; }
    if (dict[key] == null) return false;
    el.innerHTML = dict[key]; el.__mhOut = el.innerHTML; return true;
  }
  function apply(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (root.parentElement && !SKIP.has(root.parentElement.tagName)) { const p = root.parentElement; if (p.__mhSrc !== undefined && p.__mhOut !== undefined && isUnitDone(p)) return; textNode(root); } return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const el = root.nodeType === 1 ? root : null;
    if (el) { if (SKIP.has(el.tagName)) { attrs(el); if (el.tagName === "SELECT") [...el.options].forEach(o => apply(o)); return; } if (el.classList.contains("notr")) return; attrs(el);
      if (isUnit(el) && unit(el)) return; }
    for (const c of [...root.childNodes]) apply(c);
  }
  function isUnitDone() { return false; }
  let busy = false;
  const obs = new Map();
  function observe(doc) {
    if (obs.has(doc)) return;
    const pend = new Set(); let sched = false;
    const mo = new MutationObserver(ms => {
      if (busy) return;
      for (const m of ms) pend.add(m.type === "characterData" ? m.target : m.type === "attributes" ? m.target : m.target);
      if (!sched) { sched = true; queueMicrotask(() => { sched = false; busy = true; try { for (const n of pend) if (n.isConnected) apply(n.nodeType === 3 ? n : n); } finally { pend.clear(); mo.takeRecords(); busy = false; } }); }
    });
    mo.observe(doc.documentElement || doc, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    obs.set(doc, mo);
    busy = true; try { apply(doc.body); if (doc.title) { doc.__mhT = doc.__mhT || doc.title; doc.title = lang === "ko" ? doc.__mhT : t(doc.__mhT); } } finally { obs.get(doc).takeRecords(); busy = false; }
    doc.documentElement.lang = lang;
  }
  function setLang(l) {
    if (!CODES.includes(l)) return; lang = l; try { localStorage.setItem(KEY, l); } catch (e) {}
    build();
    for (const [doc, mo] of obs) { busy = true; try { doc.documentElement.lang = l; apply(doc.body); if (doc.__mhT) doc.title = l === "ko" ? doc.__mhT : t(doc.__mhT); } finally { mo.takeRecords(); busy = false; } }
    document.querySelectorAll(".langSel").forEach(s => s.value = l);
    try { window.dispatchEvent(new CustomEvent("mh-lang", { detail: l })); } catch (e) {}
  }
  function selector() {
    const s = document.createElement("select"); s.className = "langSel notr"; s.title = "Language";
    for (const [c, n] of LANGS) { const o = document.createElement("option"); o.value = c; o.textContent = n; s.appendChild(o); }
    s.value = lang; s.onchange = () => setLang(s.value); return s;
  }
  // 물품 이름: ko → 한국어 음차, zh → 중국어 원문(데이터 원본), 그 외 → 영문 공식명(없으면 중국어 원문)
  function itemName(zh, NM) {
    const e = NM && NM.items && NM.items[zh];
    if (lang === "ko") return (e && e.ko) || zh;
    if (lang === "zh-CN" || lang === "zh-TW") return zh;
    return (e && e.en) || zh;
  }
  function collect(root, out) {
    out = out || new Set();
    const walkC = n => {
      if (n.nodeType === 3) { if (HAN.test(n.nodeValue)) out.add(norm(n.nodeValue)); return; }
      if (n.nodeType !== 1 || SKIP.has(n.tagName) && n.tagName !== "SELECT" || n.classList.contains("notr")) return;
      for (const a of ATTRS) { const v = n.getAttribute(a); if (v && HAN.test(v)) out.add(norm(v)); }
      if (isUnit(n)) { out.add(norm(n.innerHTML)); n.querySelectorAll("*").forEach(d => ATTRS.forEach(a => { const v = d.getAttribute(a); if (v && HAN.test(v)) out.add(norm(v)); })); }
      for (const c of n.childNodes) walkC(c);
    };
    walkC(root); return out;
  }
  build();
  window.I18N = { collect, t, get lang() { return lang; }, setLang, observe, apply, selector, itemName, LANGS, textareaT: s => lang === "ko" ? s : s.split("\n").map(l => t(l)).join("\n") };
  document.documentElement.lang = lang;
})();
