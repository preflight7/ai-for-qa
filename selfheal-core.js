/* selfheal-core.js — the deterministic descriptor + matcher core, as MEASURED in Phase 0.5 (2026-06-19).
 *
 * Provenance: ported verbatim from descriptor-workbench.html, then exercised live via Chrome on
 *   (1) github.com/microsoft/vscode — random-sample heal-rate (N=120),
 *   (2) GitHub 2013 (Wayback) -> 2026 — human-labelled cross-version,
 *   (3) a real Appium iOS XCUITest page-source — cross-platform adapter.
 * See self-healing-PLAN.md Appendix C for the numbers and honesty caveats.
 *
 * This is the Phase-1 seed: a reviewable single source of the matcher + the iOS adapter.
 * It includes the one calibrated change Phase 0.5 surfaced: HARDENED fuzzy (see fuzzy() note).
 * No build step; runs in any JS context with DOMParser (browser, or an Appium client that shims it).
 */

// ---------- weights (heuristic defaults; UNCALIBRATED — Phase 2 tunes these) ----------
const DEF  = {role:.9, tag:.5, name:.5, nameAttr:.85, type:.7, autocomplete:.8, testid:.95, id:.7, cls:.2, inForm:.75, formAction:.7};
const DURA = {testid:1, role:.95, nameAttr:.9, autocomplete:.9, formAction:.85, inForm:.8, type:.8, id:.8, name:.55, tag:.4, cls:.1};

// heal/abstain/fail thresholds (a priori; held fixed across all Phase-0/0.5 tests for comparability)
const TH = {heal: 0.62, margin: 0.12, abstain: 0.45};

// ---------- shared helpers ----------
const cssEsc = s => (typeof CSS!=='undefined'&&CSS.escape)?CSS.escape(s):String(s).replace(/["\\]/g,'\\$&');
const looksHashed = s => { if(!s)return false; return /[0-9a-f]{6,}/i.test(s)||/^(css-|sc-|jsx-|emotion-)/.test(s)||/:r[0-9a-z]+:/.test(s)||/__|\d{3,}/.test(s)||(/[a-z]/i.test(s)&&/\d/.test(s)&&s.length>=8&&!/[ _]/.test(s)); };
const tok = s => (s==null?'':String(s)).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);

// HARDENED fuzzy (Phase 0.5 fix): the substring-inclusion boost (0.85) only applies when the two
// strings ALREADY share a token. The original unconditionally returned 0.85 on any substring hit,
// which manufactured name matches from coincidental substrings (e.g. reversed "Docs"="scoD" is a
// substring of "vscode") and produced false-heals on name-only elements whose role+tag baseline
// already sits above the heal threshold. Gating the boost on token overlap drove false-heals 0->0
// AND raised correct-heal (35.8%->40% on the GitHub random sample) because it stopped inflating
// the confidence of WRONG candidates, which had been compressing the true element's margin.
function fuzzy(a,b){
  if(a==null||b==null) return 0; a=String(a); b=String(b); if(a===b) return 1;
  const A=new Set(tok(a)), B=new Set(tok(b)); if(!A.size||!B.size) return 0;
  let i=0; A.forEach(x=>{ if(B.has(x)) i++; }); const u=new Set([...A,...B]).size; const jac=i/u;
  const sub = (a.toLowerCase().includes(b.toLowerCase())||b.toLowerCase().includes(a.toLowerCase()));
  const c = (jac>0 && sub) ? 0.85 : 0;          // <-- jac>0 gate is the fix
  return Math.max(jac, c);
}
const mv = (k,cv,sv) => (k==='name'||k==='cls') ? fuzzy(cv,sv) : (cv!=null&&String(cv)===String(sv))?1:0;

function buildFromEx(ex){
  const sig={};
  for(const k in ex){ const v=ex[k]; if(v===null||v===undefined||v==='') continue;
    let st = DEF[k]; if(st==null) continue;
    if(k==='id'  && looksHashed(v)) st=.2;
    if(k==='cls' && looksHashed(v)) st=.08;
    sig[k]={value:v, stability:st};
  }
  return {signals:sig};
}
function scoreEx(ex, desc){ let num=0,den=0; for(const k in desc.signals){ const{value,stability}=desc.signals[k]; num+=mv(k,ex[k],value)*stability; den+=stability; } return den?num/den:0; }
function verdict(ranked){ const best=ranked[0], second=ranked[1]; const margin=best.conf-(second?second.conf:0);
  let v; if(best.conf>=TH.heal && margin>=TH.margin) v='heal'; else if(best.conf>=TH.abstain) v='abstain'; else v='fail';
  return {v, best, margin}; }
// "predicted robustness" of a descriptor (durability-weighted; still UNCALIBRATED — Phase 2).
function predicted(desc){ let n=0,t=0; for(const k in desc.signals){ const s=desc.signals[k]; let du=DURA[k]!=null?DURA[k]:.5; if(k==='id'&&looksHashed(s.value))du=.15; n+=s.stability*du; t+=s.stability; } return t?n/t:0; }

// ======================================================================
// WEB adapter (DOM / accessibility tree)
// ======================================================================
const WEB = {
  roleOf(el){ const tag=el.tagName.toLowerCase(), ty=(el.getAttribute('type')||'').toLowerCase();
    if(el.getAttribute('role')) return el.getAttribute('role');
    if(tag==='a')return'link'; if(tag==='button')return'button'; if(tag==='select')return'combobox'; if(tag==='textarea')return'textbox';
    if(tag==='input'){ if(['submit','button','reset','image'].includes(ty))return'button'; if(ty==='checkbox')return'checkbox'; if(ty==='radio')return'radio'; return'textbox'; }
    return tag; },
  nameOf(el,doc){ const a=el.getAttribute('aria-label'); if(a)return a.trim();
    const id=el.getAttribute('id'); if(id){ const lb=doc.querySelector('label[for="'+cssEsc(id)+'"]'); if(lb)return lb.textContent.trim(); }
    const v=el.getAttribute('value'); if(v)return v.trim();
    const t=(el.textContent||'').replace(/\s+/g,' ').trim(); if(t&&t.length<=40)return t;
    return (el.getAttribute('placeholder')||'').trim(); },
  // Recognized test-id attribute names in preference order. Extended 2026-09-09
  // to include 'data-test-id' (hyphenated form used by n8n, Vue apps).
  _testidAttrs: ['data-testid','data-test-id','data-test','data-qa','data-cy','data-automation'],
  testid(el){ for(const a of WEB._testidAttrs){ const v=el.getAttribute(a); if(v)return v; } return null; },
  // Which attribute the current element uses for its test-id. Returns null when
  // no recognized attribute is present. Feeds bestLocator so the emitted
  // selector uses the SAME attribute name (`data-test-id='X'` not `data-testid='X'`).
  testidAttr(el){ for(const a of WEB._testidAttrs){ if(el.getAttribute(a)!=null)return a; } return null; },
  extract(el,doc){ const f=el.closest&&el.closest('form'); return {
    role:WEB.roleOf(el), tag:el.tagName.toLowerCase(), name:WEB.nameOf(el,doc),
    nameAttr:el.getAttribute('name'), type:el.getAttribute('type'), autocomplete:el.getAttribute('autocomplete'),
    testid:WEB.testid(el), testidAttr:WEB.testidAttr(el), id:el.getAttribute('id'), cls:(el.getAttribute('class')||'').trim()||null,
    inForm:f?true:null, formAction:f?f.getAttribute('action'):null }; },
  candidates(doc){ return [...doc.querySelectorAll('input,button,a,select,textarea,[role]')].filter(el=>(el.getAttribute('type')||'')!=='hidden'); },
  // pre-act gate — "found != usable" (web). Returns a `reason` so abstain can be diagnosed precisely.
  actionable(el){ const cs=getComputedStyle(el); const r=el.getBoundingClientRect();
    const hasSize=r.width>1&&r.height>1;
    const shown=cs.display!=='none'&&cs.visibility!=='hidden'&&cs.opacity!=='0';
    const cx=r.left+r.width/2, cy=r.top+r.height/2;
    const vw=(typeof window!=='undefined'&&window.innerWidth)||1e9, vh=(typeof window!=='undefined'&&window.innerHeight)||1e9;
    const inViewport = cx>=0&&cy>=0&&cx<=vw&&cy<=vh;
    let topmost=true; try{ const hit=document.elementFromPoint(cx,cy); topmost=!!hit&&(hit===el||el.contains(hit)||hit.contains(el)); }catch(e){}
    let reason=null; if(!shown)reason='not-displayed'; else if(!hasSize)reason='zero-size'; else if(!inViewport)reason='off-screen'; else if(!topmost)reason='blocked-by-overlay';
    return {usable: shown&&hasSize&&inViewport&&topmost, hasSize, shown, inViewport, topmost, reason}; }
};

// ======================================================================
// MOBILE adapter — Appium iOS (XCUITest). Android (UIAutomator) maps identically:
//   class -> role, resource-id -> testid, text/content-desc -> name, bounds -> box, enabled/displayed -> gate.
// Validated on a real XCUITest page-source in Phase 0.5 (Appendix C, Gap 3).
// ======================================================================
const IOS_ROLE = {Button:'button',StaticText:'text',TextField:'textbox',SecureTextField:'textbox',Image:'image',NavigationBar:'navigation',Cell:'listitem',Switch:'switch',Link:'link',SearchField:'searchbox',Slider:'slider',Other:'generic',Window:'window',Application:'application',StatusBar:'status'};
// XCUITest's `name` is the accessibilityIdentifier IF the dev set one, else it falls back to the label.
// A real Appium client should read the explicit accessibilityIdentifier; lacking that in raw page-source,
// we infer it: identifier-shaped (no spaces, snake/Camel/code-like) and != the visible label.
function iosIsAccId(name,label){ if(!name||/\s/.test(name))return false; if(label&&name===label)return false;
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name)&&(/_/.test(name)||/[a-z][A-Z]/.test(name)||name.length>=6); }
const IOS = {
  roleOf(t){ const m=(t||'').replace('XCUIElementType',''); return IOS_ROLE[m]||m.toLowerCase(); },
  extract(el){ const type=el.getAttribute('type')||el.tagName; const name=el.getAttribute('name'),label=el.getAttribute('label'),value=el.getAttribute('value');
    const vis=(label&&label.trim())?label.trim():((value&&value.trim())?value.trim():null); const acc=iosIsAccId(name,label);
    return { role:IOS.roleOf(type), tag:(type||'').replace('XCUIElementType',''),
      name: vis || (!acc&&name&&name.trim()?name.trim():null),  // visible accessible name (this is what localizes)
      testid: acc?name:null,                                    // accessibilityId == the mobile test-id (strongest anchor)
      enabled: el.getAttribute('enabled')==='true', visible: el.getAttribute('visible')==='true',
      box:{x:+el.getAttribute('x'),y:+el.getAttribute('y'),w:+el.getAttribute('width'),h:+el.getAttribute('height')} }; },
  candidates(doc){ return [...doc.querySelectorAll('*')].filter(el=>{ const ex=IOS.extract(el); return ex.testid||ex.name||['button','textbox','switch','link','searchbox'].includes(ex.role); }); },
  // pre-act gate (mobile): guards the iOS-swipe D-2 off-screen / not-displayed failure
  actionable(ex){ return {usable: ex.enabled&&ex.visible&&isFinite(ex.box.x)&&ex.box.w>0&&ex.box.h>0, enabled:ex.enabled, visible:ex.visible, finiteBox:isFinite(ex.box.x)&&ex.box.w>0&&ex.box.h>0}; }
};

// ---------- generic match driver (platform-agnostic over an adapter) ----------
function rank(doc, desc, adapter){
  const cs = adapter.candidates(doc);
  return cs.map(el => ({el, ex:(adapter===WEB?adapter.extract(el,doc):adapter.extract(el)), }))
           .map(o => ({...o, conf: scoreEx(o.ex, desc)}))
           .sort((a,b)=>b.conf-a.conf);
}
function match(doc, desc, adapter){ return verdict(rank(doc, desc, adapter)); }

// ======================================================================
// §9 RECORDED-STEP PIPELINE (Phase 1):
//   capture -> scope-to-visible -> [reveal] -> match -> actionability gate -> verify-by-effect -> diagnose
// ======================================================================

// ---- bestLocator: strongest available anchor; drives heal-vs-flag ----
function bestLocator(ex){
  if(ex.testid)                       return {sel:`[${ex.testidAttr||'data-testid'}='${ex.testid}']`, tier:'testid'};
  if(ex.id && !looksHashed(ex.id))    return {sel:`#${ex.id}`,                    tier:'stable-id'};
  if(ex.id && looksHashed(ex.id)){ const m=String(ex.id).match(/[-_:]([A-Za-z]{3,}[A-Za-z0-9_-]*)$/); if(m) return {sel:`[id$='${m[0]}']`, tier:'id-fragment'}; }
  if(ex.nameAttr)                     return {sel:`[name='${ex.nameAttr}']`,       tier:'form-name'};
  if(ex.role && ex.name)              return {sel:`role=${ex.role}[name='${ex.name}']`, tier:'role+name'};
  return {sel:null, tier:'none'};
}
function flagOf(tier, unique){
  if(tier==='none')     return 'no-anchor';
  if(unique===false)    return 'ambiguous';
  if(tier==='role+name')return 'weak-identity';
  return null;
}
// emit a §9 recorded step from a live element (descriptor shape uses spec's {v,st})
function captureStep(el, doc, opts={}){
  const ex = WEB.extract(el, doc);
  const desc = buildFromEx(ex);
  const loc = bestLocator(ex);
  let unique = null;
  if(loc.sel && /^[\[#]/.test(loc.sel)){ try{ unique = doc.querySelectorAll(loc.sel).length===1; }catch(e){ unique=null; } }
  return {
    stepId: opts.stepId || null,
    intent: opts.intent || null,                 // Clue 3 (record-time AI caption) — Phase 1 leaves null
    action: opts.action || 'click',
    value:  opts.value ?? null,
    target: {
      descriptor: Object.fromEntries(Object.entries(desc.signals).map(([k,s])=>[k,{v:s.value, st:s.stability}])),
      bestLocator: loc.sel, uniqueAtRecord: unique, confidence: Math.round(predicted(desc)*100)
    },
    scope: { visibleOnly:true, container: opts.container||null, ordinal:null },
    reveal: opts.reveal || [],
    framePath: opts.framePath || [],
    actionability: { requireVisible:true, requireTopmostAtPoint:true, requireFiniteBox:true },
    verify: opts.verify || { type:null, expect:null },
    flag: flagOf(loc.tier, unique)
  };
}
const descFromStep = d => ({signals: Object.fromEntries(Object.entries(d).map(([k,o])=>[k,{value:o.v, stability:o.st}]))});

// ---- scope: resolve to the interactable instance BEFORE matching (the duplicate fix) ----
function isShown(el){ try{ const cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0; }catch(e){ return true; } }
function isEnabled(el){ return !(el.disabled || el.getAttribute('aria-disabled')==='true'); }
function resolveScope(doc, opts={}){
  let cands = WEB.candidates(doc);
  if(opts.visibleOnly !== false) cands = cands.filter(el => isShown(el) && isEnabled(el));
  if(opts.container){ const region = doc.querySelector(opts.container); if(region) cands = cands.filter(el => region.contains(el)); }
  return cands;
}

// ---- diagnose: name the abstain/fail reason (never silent) ----
function diagnose(ranked, vd){
  if(!ranked || !ranked.length) return 'not-ready';
  if(vd.v==='fail') return 'no-identity';
  if(vd.best.conf>=TH.heal && vd.margin<TH.margin) return 'ambiguous';   // strong but tied (duplicate/repeated)
  return 'no-identity';                                                  // weak signal overall
}

// ---- no-anchor veto (false-heal fix, 2026-07-02) ------------------------------------------------
// SINGLE SOURCE OF TRUTH: any caller that reuses the core's verdict() over a step-scoped descriptor
// (matchStep below, AND self-heal/pipeline/candidate-widening.js's matchStepWidened, which mirrors
// matchStep's pipeline verbatim over a widened candidate set) must route its verdict through this
// function, not just matchStep, or the exact same false-heal mechanism stays reachable there too.
//
// step.flag==='no-anchor' means bestLocator() found ZERO real identity signal at record time
// (no testid, no stable id, no name-attr, not even role+name — see bestLocator()/flagOf()).
// Such a descriptor's remaining signals (role/tag/type/cls/inForm/formAction) are pure DOM
// *context*, shared by every sibling control in the same form/container — they are durable
// (DURA scores them high) but NOT identifying. When the true target is removed, conf/margin are
// computed only over the *other, unrelated* candidates: the runner-up can score far lower on
// those same context signals for unrelated reasons (e.g. a mismatched `type`), which manufactures
// a wide RELATIVE margin even though neither candidate is a real match in absolute terms — so a
// context-only descriptor can clear TH.heal + TH.margin purely by elimination. There is no
// legitimate way to re-locate a control that never had an identifying anchor, so any such
// descriptor must never heal on score+margin alone.
//
// Unconditional w.r.t. opts.gate (NOT folded into the `opts.gate!==false` actionability check)
// because this is a correctness invariant, not an optional interactability check — and because
// self-heal/pipeline/search-and-pick.js's Phase 2 deliberately calls matchStep with {gate:false} to
// get a raw ranking before applying its OWN 'score+anchor-tier' safety check (winner's OWN locator
// tier is testid/stable-id). That check looks like independent evidence but is NOT: for a
// no-anchor descriptor there is no recorded anchor VALUE to verify the winner against, so "the
// winner happens to have some real id" says nothing about whether it's the SAME control — traced
// concretely on the exact repro below, the wrongly-healed "Continue with Google" SSO button DOES
// carry its own real, non-hashed id ("sso" -> bestLocator tier 'stable-id'), so gating only on
// opts.gate would let this exact bug back in through search-and-pick's widen path. Hence: always on.
//
// Does NOT affect descriptors with a real anchor (testid/stable-id/name-attr/role+name -> flag is
// null or 'weak-identity'), and does NOT change the already-correct pristine-tie AMBIGUITY case
// (that one already abstains via the ordinary margin check, never reaching this veto).
//
// Known, accepted tradeoff (measured against the full existing corpus, see CORE-FIX-RUN.md): a
// genuinely-unique no-anchor control that is the ONLY candidate on the page (no elimination ever
// occurs) will also abstain instead of heal. This is deliberate — false-heal=0 outweighs heal-rate
// per project rule — and was NOT observed to affect any existing case: the only two no-anchor cases
// in the whole benchmark corpus (fixtures.js T3 "eye" icon, payment-fixtures.js C5 "gear" icon)
// were ALREADY expected to abstain (AMBIGUITY) before this fix, not heal, so 0/2 regress.
//
// diagnosis:'no-anchor' is a DISTINCT code from 'no-identity' (see diagnose() above) on purpose: a
// candidate DID clear TH.heal/TH.margin here — this is a policy decline, not "nothing matched well
// enough" — change-diagnosis.js's diagnoseFailure() carries a matching, accurate branch.
function noAnchorVeto(vd, step, cands, ranked){
  if(vd.v==='heal' && step && step.flag==='no-anchor'){
    return {verdict:'abstain', best:vd.best, margin:vd.margin, noAnchor:true, diagnosis:'no-anchor', cands, ranked};
  }
  return null;
}

// ---- replay a recorded step: scope -> rank -> verdict -> gate -> diagnose ----
function matchStep(doc, step, opts={}){
  const desc = descFromStep(step.target.descriptor);
  const cands = (opts.scopeVisible===false)
    ? WEB.candidates(doc)
    : resolveScope(doc, {visibleOnly:true, container: step.scope && step.scope.container});
  if(!cands.length) return {verdict:'fail', diagnosis:'not-ready', best:null, margin:0, cands:[], ranked:[]};
  const ranked = cands.map(el=>{ const ex=WEB.extract(el,doc); return {el, ex, conf:scoreEx(ex,desc)}; }).sort((a,b)=>b.conf-a.conf);
  const vd = verdict(ranked);
  // `cands`/`ranked` are returned so callers (e.g. disambiguation) can reuse the scored set
  // instead of re-scanning the DOM and re-scoring every candidate. [perf: one scan per heal]
  const vetoed = noAnchorVeto(vd, step, cands, ranked);
  if(vetoed) return vetoed;
  if(vd.v==='heal' && opts.gate!==false){
    const act = WEB.actionable(vd.best.el);
    if(!act.usable) return {verdict:'abstain', best:vd.best, margin:vd.margin, gated:true, diagnosis: act.reason||'not-usable', cands, ranked};
  }
  if(vd.v==='heal') return {verdict:'heal', best:vd.best, margin:vd.margin, diagnosis:null, cands, ranked};
  return {verdict:vd.v, best:vd.best, margin:vd.margin, diagnosis: diagnose(ranked, vd), cands, ranked};
}

// ---- emit-with-uniqueness: single source of truth for match+serialize ----
// Bug the fix closes (2026-09-09): matchStep returns the winner element but
// callers were separately calling bestLocator(vd.best.ex) to serialize a
// selector, with NO cardinality check on the emitted string against the
// current DOM. When the winner inherits an attribute (e.g. a testid supplied
// by an underlying component-library primitive that also lives on siblings)
// the emitted selector can be ambiguous even though the matcher picked the
// right element. captureStep already checks uniqueness at record-time
// (uniqueAtRecord); this is the same invariant at match-time.
//
// Contract: same shape as matchStep + {bestLocator, tier} on the returned
// object. If verdict was 'heal' but the CSS-form emitted selector matches
// more than one element in `doc`, downgrade to abstain with
// diagnosis:'ambiguous-emit'. role= form is not CSS-selectable and is
// returned unchanged (callers use Playwright's role locator for those).
function matchAndEmit(doc, step, opts={}){
  const r = matchStep(doc, step, opts);
  if(r.verdict !== 'heal' || !r.best){
    return Object.assign({}, r, {bestLocator:null, tier:'none'});
  }
  const loc = bestLocator(r.best.ex);
  const sel = loc.sel;
  const tier = loc.tier;
  // role= form isn't querySelector-able; trust the caller's locator engine.
  const isCss = sel && /^[\[#]/.test(sel);
  if(isCss){
    let count = 0;
    try { count = doc.querySelectorAll(sel).length; } catch(e) { count = 0; }
    if(count !== 1){
      return {verdict:'abstain', best:r.best, margin:r.margin,
              bestLocator:sel, tier, diagnosis:'ambiguous-emit',
              emitCount:count, cands:r.cands, ranked:r.ranked};
    }
  }
  return Object.assign({}, r, {bestLocator:sel, tier});
}

// ---- verify-by-effect: confirm the declared effect happened (catches a WRONG heal) ----
function verifyEffect(before, after, expect){
  if(!expect || !expect.type) return true;
  switch(expect.type){
    case 'urlChange':   return before.url !== after.url;
    case 'domChange':   return before.domHash !== after.domHash;
    case 'textPresent': return (after.text||'').includes(expect.value||'');
    case 'elementGone': return before.has===true && after.has===false;
    default: return false;
  }
}

// (CommonJS-style export guard; harmless in the browser)
const SELFHEAL = {DEF,DURA,TH,fuzzy,mv,buildFromEx,scoreEx,verdict,predicted,WEB,IOS,rank,match,looksHashed,
  bestLocator,flagOf,captureStep,descFromStep,isShown,isEnabled,resolveScope,diagnose,matchStep,matchAndEmit,verifyEffect,noAnchorVeto};
if (typeof module!=='undefined' && module.exports) module.exports = SELFHEAL;
if (typeof window!=='undefined') window.SELFHEAL = SELFHEAL;
