/* selfheal-tests.js — Phase 1 test + before/after metrics harness.
 * Runs in-browser. Pure-logic tests use DOMParser docs; layout-dependent tests (visibility/overlay/
 * hit-test) mount fixtures into the live document. Verified this session via Chrome injection
 * (concatenated after selfheal-core.js); also runnable by opening selfheal-tests.html.
 *
 * Honesty: hermetic tests prove the MECHANISMS; aggregate heal-rate numbers come from the LIVE runs
 * (E7, run separately on github.com / the iOS gist). false-heal is the metric that gates "done".
 */
function runAll(){
  const S = window.SELFHEAL;
  const {WEB, buildFromEx, verdict, captureStep, matchStep, resolveScope, diagnose, verifyEffect, bestLocator} = S;

  // ---- micro test framework ----
  const cases=[]; let passed=0, failed=0;
  function test(name, fn){ try{ fn(); cases.push({name, ok:true}); passed++; } catch(e){ cases.push({name, ok:false, err:String(e.message||e)}); failed++; } }
  function ok(c,m){ if(!c) throw new Error(m||'expected truthy'); }
  function eq(a,b,m){ if(a!==b) throw new Error((m||'')+` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

  // ---- helpers ----
  const tok = s => (s==null?'':String(s)).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  // the ORIGINAL fuzzy (pre-fix) — substring boost unconditional. For before/after comparison only.
  function fuzzyOrig(a,b){ if(a==null||b==null)return 0; a=String(a);b=String(b); if(a===b)return 1;
    const A=new Set(tok(a)),B=new Set(tok(b)); if(!A.size||!B.size)return 0; let i=0;A.forEach(x=>{if(B.has(x))i++;});
    const u=new Set([...A,...B]).size; const c=(a.toLowerCase().includes(b.toLowerCase())||b.toLowerCase().includes(a.toLowerCase()))?0.85:0; return Math.max(i/u,c); }
  function mvWith(fz,k,cv,sv){ return (k==='name'||k==='cls')?fz(cv,sv):(cv!=null&&String(cv)===String(sv))?1:0; }
  function scoreWith(fz,ex,desc){ let n=0,d=0; for(const k in desc.signals){ const{value,stability}=desc.signals[k]; n+=mvWith(fz,k,ex[k],value)*stability; d+=stability; } return d?n/d:0; }
  function rankWith(fz,root,desc){ return WEB.candidates(root).map(el=>{ const ex=WEB.extract(el,root); return {el,ex,conf:scoreWith(fz,ex,desc)}; }).sort((a,b)=>b.conf-a.conf); }
  function verdictOf(ranked){ return verdict(ranked); }
  const parse = h => new DOMParser().parseFromString(h,'text/html');
  function mount(h){ const d=document.createElement('div'); d.style.cssText='position:absolute;left:0;top:0'; d.innerHTML=h; document.body.appendChild(d); return d; }
  function unmount(d){ d&&d.remove(); }
  const metrics={};

  // ===================================================================== E1 capture
  test('E1.capture-schema: full §9 shape emitted', ()=>{
    const doc=parse(`<form action="/s"><button data-testid="go" name="commit" type="submit">Go</button></form>`);
    const step=captureStep(doc.querySelector('button'), doc, {stepId:'s1', action:'click'});
    ['stepId','intent','action','value','target','scope','reveal','framePath','actionability','verify','flag'].forEach(k=>ok(k in step,'missing '+k));
    ['descriptor','bestLocator','uniqueAtRecord','confidence'].forEach(k=>ok(k in step.target,'missing target.'+k));
    ok(step.target.descriptor.testid && 'v' in step.target.descriptor.testid && 'st' in step.target.descriptor.testid,'descriptor not {v,st}');
    ['requireVisible','requireTopmostAtPoint','requireFiniteBox'].forEach(k=>ok(k in step.actionability,'missing actionability.'+k));
  });
  test('E1.capture-flag: flags no-anchor / weak-identity / anchored / ambiguous', ()=>{
    const a=parse(`<button><svg width=10 height=10></svg></button>`); eq(captureStep(a.querySelector('button'),a).flag,'no-anchor');   // icon button, no name/id
    const w=parse(`<a href="/x">Just text</a>`); eq(captureStep(w.querySelector('a'),w).flag,'weak-identity');                       // role+name only
    const b=parse(`<button data-testid="t1">Ok</button>`); eq(captureStep(b.querySelector('button'),b).flag,null);                  // strong anchor
    const c=parse(`<div><button data-testid="dup">A</button><button data-testid="dup">B</button></div>`); eq(captureStep(c.querySelector('button'),c).flag,'ambiguous');
  });
  test('E1.bestlocator-pick: testid > stable-id > role+name', ()=>{
    const t=parse(`<button data-testid="x" id="abc">Q</button>`); eq(bestLocator(WEB.extract(t.querySelector('button'),t)).tier,'testid');
    const i=parse(`<button id="login-submit">Q</button>`); eq(bestLocator(WEB.extract(i.querySelector('button'),i)).tier,'stable-id');
    const n=parse(`<a href="/p">Pricing</a>`); eq(bestLocator(WEB.extract(n.querySelector('a'),n)).tier,'role+name');
  });
  // schema coverage metric
  {
    const doc=parse(`<button data-testid="go">Go</button>`); const step=captureStep(doc.querySelector('button'),doc);
    const req=['stepId','intent','action','value','target','scope','reveal','framePath','actionability','verify','flag'];
    const cov=Math.round(100*req.filter(k=>k in step).length/req.length);
    metrics.E1_schemaCoverage={before:0, after:cov, unit:'% of §9 keys emitted'};
    const flags=[parse(`<button><svg width=10 height=10></svg></button>`),parse(`<a href="/x">Just text</a>`),parse(`<button data-testid="t">Ok</button>`),parse(`<div><button data-testid="d">A</button><button data-testid="d">B</button></div>`)]
      .map(d=>captureStep(d.querySelector('button')||d.querySelector('a'),d).flag);
    const want=['no-anchor','weak-identity',null,'ambiguous']; const correct=flags.filter((f,i)=>f===want[i]).length;
    metrics.E1_flagCorrectness={before:0, after:Math.round(100*correct/flags.length), unit:'% flags correct'};
  }

  // ===================================================================== E2 hardened fuzzy
  test('E2.fuzzy-unit: substring boost gated on token overlap', ()=>{
    eq(S.fuzzy('scoD','vscode'),0,'coincidental substring must score 0');
    ok(S.fuzzy('Sign in','Sign in to GitHub')>0,'shared-token substring must still boost');
    ok(fuzzyOrig('scoD','vscode')===0.85,'orig fuzzy did give 0.85 (the bug)');
  });
  test('E2.substring-trap: orig false-heals, hardened abstains', ()=>{
    const replay=parse(`<nav><a href=/1>scoD</a><a href=/2>edocsv</a><a href=/3>gnicirp</a></nav>`);
    const desc=buildFromEx({role:'link',tag:'a',name:'vscode'});
    const vo=verdictOf(rankWith(fuzzyOrig,replay,desc));   // before
    const vh=verdictOf(rankWith(S.fuzzy,replay,desc));     // after
    eq(vo.v,'heal'); eq(WEB.nameOf(vo.best.el,replay),'scoD');   // orig heals to WRONG element
    eq(vh.v,'abstain');                                          // hardened declines
  });
  test('E2.margin-recovery: hardened recovers a correct-heal orig abstained on', ()=>{
    const replay=parse(`<nav><button>Settings</button><button>ngs</button><button>Help</button></nav>`); // "ngs" ⊂ "settings"
    const desc=buildFromEx({role:'button',tag:'button',name:'Settings'});
    const vo=verdictOf(rankWith(fuzzyOrig,replay,desc));
    const vh=verdictOf(rankWith(S.fuzzy,replay,desc));
    eq(vo.v,'abstain','orig margin compressed by spurious ngs match');
    eq(vh.v,'heal'); eq(WEB.nameOf(vh.best.el,replay),'Settings');
  });
  {
    // metric: false-heal (substring-trap) + correct-heal recovered (margin-recovery)
    const trap=parse(`<nav><a href=/1>scoD</a><a href=/2>edocsv</a></nav>`); const dTrap=buildFromEx({role:'link',tag:'a',name:'vscode'});
    const fhO=verdictOf(rankWith(fuzzyOrig,trap,dTrap)).v==='heal'?1:0;
    const fhH=verdictOf(rankWith(S.fuzzy,trap,dTrap)).v==='heal'?1:0;
    metrics.E2_falseHeal={before:fhO, after:fhH, unit:'false-heals on substring-trap'};
    const rec=parse(`<nav><button>Settings</button><button>ngs</button></nav>`); const dRec=buildFromEx({role:'button',tag:'button',name:'Settings'});
    const chO=verdictOf(rankWith(fuzzyOrig,rec,dRec)).v==='heal'?1:0;
    const chH=verdictOf(rankWith(S.fuzzy,rec,dRec)).v==='heal'?1:0;
    metrics.E2_correctHealRecovered={before:chO, after:chH, unit:'correct-heals on margin-recovery'};
  }

  // ===================================================================== E3 scope.visibleOnly
  test('E3.scope-dup: hidden twin excluded; visible twin heals', ()=>{
    const d=mount(`<div><button data-testid="save" style="display:none">Save</button><button data-testid="save">Save</button></div>`);
    try{
      const step=captureStep(d.querySelector('button[data-testid=save]:not([style])')||d.querySelectorAll('button')[1], d);
      const before=matchStep(d, step, {scopeVisible:false, gate:false});  // both twins -> tie -> abstain
      const after =matchStep(d, step, {scopeVisible:true,  gate:false});  // hidden filtered -> heal
      eq(before.verdict,'abstain','duplicates should tie -> abstain'); eq(before.diagnosis,'ambiguous');
      eq(after.verdict,'heal'); ok(S.isShown(after.best.el),'healed to the visible twin');
    } finally { unmount(d); }
  });
  {
    const d=mount(`<div><button data-testid="save" style="display:none">Save</button><button data-testid="save">Save</button></div>`);
    let bV,aV; try{ const step=captureStep(d.querySelectorAll('button')[1],d);
      bV=matchStep(d,step,{scopeVisible:false,gate:false}).verdict; aV=matchStep(d,step,{scopeVisible:true,gate:false}).verdict; } finally{ unmount(d); }
    metrics.E3_dupHeal={before:(bV==='heal'?1:0), after:(aV==='heal'?1:0), unit:'correct-heal on duplicate (visible+hidden)'};
  }

  // ===================================================================== E4 actionability gate
  test('E4.gate-overlay: identity matches but covered -> blocked', ()=>{
    const d=mount(`<div><button data-testid="ovb" style="position:absolute;left:40px;top:40px;width:120px;height:40px">Continue</button>
      <div style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,.6);z-index:99999">cookie wall</div></div>`);
    try{ const step=captureStep(d.querySelector('button'),d);
      eq(matchStep(d,step,{gate:false}).verdict,'heal','without gate it would act into covered element');
      const g=matchStep(d,step,{gate:true}); eq(g.verdict,'abstain'); eq(g.diagnosis,'blocked-by-overlay');
    } finally { unmount(d); }
  });
  test('E4.gate-offscreen: finite box but off-viewport -> blocked', ()=>{
    const d=mount(`<div><button data-testid="osb" style="position:absolute;left:-9999px;top:0;width:80px;height:30px">Hidden</button></div>`);
    try{ const step=captureStep(d.querySelector('button'),d);
      eq(matchStep(d,step,{gate:false}).verdict,'heal');
      const g=matchStep(d,step,{gate:true}); eq(g.verdict,'abstain'); eq(g.diagnosis,'off-screen');
    } finally { unmount(d); }
  });
  {
    // metric: % of found-but-unusable correctly blocked
    let blockedBefore=0, blockedAfter=0; const N=2;
    [`<div><button data-testid="ovb" style="position:absolute;left:40px;top:40px;width:120px;height:40px">Continue</button><div style="position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(0,0,0,.6);z-index:99999">x</div></div>`,
     `<div><button data-testid="osb" style="position:absolute;left:-9999px;top:0;width:80px;height:30px">Hidden</button></div>`].forEach(h=>{
      const d=mount(h); try{ const step=captureStep(d.querySelector('button'),d);
        if(matchStep(d,step,{gate:false}).verdict!=='heal') blockedBefore++;   // before: gate off -> not blocked (acts)
        if(matchStep(d,step,{gate:true }).verdict!=='heal') blockedAfter++;
      } finally{ unmount(d); } });
    metrics.E4_unusableBlocked={before:Math.round(100*blockedBefore/N), after:Math.round(100*blockedAfter/N), unit:'% found-but-unusable blocked'};
  }

  // ===================================================================== E5 verify-by-effect
  test('E5.verify-pass: real effect confirms', ()=>{
    ok(verifyEffect({url:'/a',domHash:1},{url:'/b',domHash:2},{type:'urlChange'})===true);
    ok(verifyEffect({domHash:1},{domHash:2},{type:'domChange'})===true);
    ok(verifyEffect({has:true},{has:false},{type:'elementGone'})===true);
  });
  test('E5.verify-catch: no effect -> wrong heal caught', ()=>{
    ok(verifyEffect({url:'/a',domHash:7},{url:'/a',domHash:7},{type:'domChange'})===false,'no dom change must fail verify');
    ok(verifyEffect({url:'/a'},{url:'/a'},{type:'urlChange'})===false);
  });
  {
    const before={url:'/a',domHash:7}, afterNoEffect={url:'/a',domHash:7};
    const caughtBefore=0; // before: no verify -> wrong heal persists (0 caught)
    const caughtAfter = verifyEffect(before,afterNoEffect,{type:'domChange'})===false ? 1 : 0;
    metrics.E5_wrongHealCaught={before:caughtBefore, after:caughtAfter, unit:'wrong-heal caught (1=yes)'};
  }

  // ===================================================================== E6 diagnose taxonomy
  test('E6.diagnose-not-ready: empty page', ()=>{ const d=mount(`<div></div>`); try{
    const step=captureStep(parse(`<button data-testid=z>Z</button>`).querySelector('button'),parse(`<button data-testid=z>Z</button>`));
    eq(matchStep(d,step,{gate:false}).diagnosis,'not-ready'); } finally{ unmount(d); } });
  test('E6.diagnose-ambiguous: strong but tied', ()=>{ const r=parse(`<div><button>Gamma</button><button>Gamma</button></div>`);
    const desc=buildFromEx({role:'button',tag:'button',name:'Gamma'}); const v=verdictOf(rankWith(S.fuzzy,r,desc)); eq(v.v,'abstain'); eq(diagnose(rankWith(S.fuzzy,r,desc),v),'ambiguous'); });
  test('E6.diagnose-no-identity: anchors unmatched -> low conf', ()=>{ const r=parse(`<button>Different</button>`);
    const desc=buildFromEx({role:'button',tag:'button',name:'Save',testid:'save',nameAttr:'commit'}); const ranked=rankWith(S.fuzzy,r,desc); const v=verdictOf(ranked);
    ok(v.v!=='heal','should not heal on unmatched anchors'); eq(diagnose(ranked,v),'no-identity'); });
  {
    // metric: % of non-heals carrying a specific named reason (5 representative non-heal cases)
    const reasons=[];
    { const d=mount(`<div></div>`); const st=captureStep(parse(`<button data-testid=z>Z</button>`).querySelector('button'),parse(`<button data-testid=z>Z</button>`)); reasons.push(matchStep(d,st,{gate:false}).diagnosis); unmount(d); }
    { const r=parse(`<div><button>Gamma</button><button>Gamma</button></div>`); const desc=buildFromEx({role:'button',tag:'button',name:'Gamma'}); reasons.push(diagnose(rankWith(S.fuzzy,r,desc),verdictOf(rankWith(S.fuzzy,r,desc)))); }
    { const r=parse(`<button>Different</button>`); const desc=buildFromEx({role:'button',tag:'button',name:'Save',testid:'save'}); const rk=rankWith(S.fuzzy,r,desc); reasons.push(diagnose(rk,verdictOf(rk))); }
    { const d=mount(`<div><button data-testid=o style="position:absolute;left:40px;top:40px;width:100px;height:30px">C</button><div style="position:fixed;inset:0;z-index:99999;background:#000">x</div></div>`); const st=captureStep(d.querySelector('button'),d); reasons.push(matchStep(d,st,{gate:true}).diagnosis); unmount(d); }
    { const d=mount(`<div><button data-testid=o style="position:absolute;left:-9999px;top:0;width:80px;height:30px">H</button></div>`); const st=captureStep(d.querySelector('button'),d); reasons.push(matchStep(d,st,{gate:true}).diagnosis); unmount(d); }
    const named=reasons.filter(r=>r&&r!=='').length;
    metrics.E6_namedReasons={before:0, after:Math.round(100*named/reasons.length), unit:'% non-heals with a named reason', reasons};
  }

  // ===================================================================== E8 matchAndEmit ambiguity firewall (2026-09-09)
  // Regression for the D5 finding: matchStep picks the correct winner, but the
  // winner's extracted features include a testid inherited from a shared
  // component-library primitive that also lives on siblings. bestLocator(ex)
  // would emit that testid unconditionally; the OLD path shipped it to the
  // caller and Playwright's strict-mode throws on click. matchAndEmit must
  // downgrade to abstain with diagnosis 'ambiguous-emit'.
  test('E8.matchAndEmit-ambiguous: winner testid also on sibling -> abstain', ()=>{
    // Record: a button with a unique testid at record-time.
    const rec = parse(`<div><button data-testid="mine" aria-label="Menu">Menu</button></div>`);
    const step = captureStep(rec.querySelector('button'), rec, {stepId:'s1', action:'click'});
    // Live DOM: our testid is gone; the winner still carries a SHARED testid
    // (as if the underlying component-library primitive supplied one).
    const live = mount(`<div>
      <button data-testid="shared" aria-label="Menu">Menu</button>
      <button data-testid="shared" aria-label="More tools">More</button>
    </div>`);
    try {
      const r = S.matchAndEmit(live, step, {gate:true});
      eq(r.verdict, 'abstain', 'must abstain — emitted selector is ambiguous');
      eq(r.diagnosis, 'ambiguous-emit');
      eq(r.bestLocator, "[data-testid='shared']", 'exposes the ambiguous selector');
      eq(r.emitCount, 2, 'reports how many the emitted selector matched');
    } finally { unmount(live); }
  });
  test('E8.matchAndEmit-unique: winner testid unique -> heal', ()=>{
    const rec = parse(`<div><button data-testid="save" aria-label="Save">Save</button></div>`);
    const step = captureStep(rec.querySelector('button'), rec, {stepId:'s1', action:'click'});
    const live = mount(`<div><button data-testid="save" aria-label="Save">Save</button><button data-testid="cancel">Cancel</button></div>`);
    try {
      const r = S.matchAndEmit(live, step, {gate:true});
      eq(r.verdict, 'heal');
      eq(r.bestLocator, "[data-testid='save']");
      eq(r.diagnosis, null);
    } finally { unmount(live); }
  });

  return {passed, failed, total:passed+failed, cases, metrics};
}

// ===================================================================== E7.2 mobile (iOS XCUITest) — real fixture, core adapter
async function runMobile(){
  const S=window.SELFHEAL; const {IOS, buildFromEx, scoreEx, verdict} = S;
  let xml; try{ xml = await fetch('ios_pagesource.xml').then(r=>r.text()); }catch(e){ return {error:'fetch failed: '+e}; }
  const parseX = () => new DOMParser().parseFromString(xml,'application/xml');
  const accId = (name,label)=>{ if(!name||/\s/.test(name))return false; if(label&&name===label)return false; return /^[A-Za-z][A-Za-z0-9_]*$/.test(name)&&(/_/.test(name)||/[a-z][A-Z]/.test(name)||name.length>=6); };
  const rev = s => s.replace(/[A-Za-z0-9]+/g,w=>w.split('').reverse().join(''));
  const mutate = (d,mode)=>{ d.querySelectorAll('*').forEach(el=>{ if(mode==='drop-id'){ const n=el.getAttribute('name'),l=el.getAttribute('label'); if(accId(n,l))el.removeAttribute('name'); }
    ['label','value'].forEach(a=>{ const v=el.getAttribute(a); if(v&&v.trim())el.setAttribute(a,rev(v)); }); const n2=el.getAttribute('name'); if(n2&&/\s/.test(n2))el.setAttribute('name',rev(n2)); }); return d; };
  const byName = (d,n)=>[...d.querySelectorAll('*')].find(el=>el.getAttribute('name')===n);
  const rankM = (d,desc)=>IOS.candidates(d).map(el=>({el,ex:IOS.extract(el),conf:scoreEx(IOS.extract(el),desc)})).sort((a,b)=>b.conf-a.conf);
  const TARGETS=['PairDevice_PairNowButton','Toolbar_TitleLabel','PairDevice_PairInfoLabel'];
  const od=parseX(); const REC={}; TARGETS.forEach(n=>REC[n]=buildFromEx(IOS.extract(byName(od,n))));
  const run = d => { const o={}; for(const n of TARGETS){ const r=rankM(d,REC[n]); const {v,best}=verdict(r); o[n]={verdict:v, correct:(v==='heal'&&best.ex.testid===n)}; } return o; };
  const A=run(parseX()), B=run(mutate(parseX(),'localize')), C=run(mutate(parseX(),'drop-id'));
  const gateImg=IOS.actionable(IOS.extract(byName(od,'PairDevice_KeepImage')));
  const gateBtn=IOS.actionable(IOS.extract(byName(od,'PairDevice_PairNowButton')));
  const cases=[]; const expect=(name,cond)=>cases.push({name, ok:!!cond});
  expect('M.A round-trip: 3/3 heal correct via core IOS adapter', TARGETS.every(n=>A[n].correct));
  expect('M.B localize + keep accessibilityId: 3/3 heal via accId (the 380-failure rescue)', TARGETS.every(n=>B[n].correct));
  expect('M.C drop accessibilityId + localize: 3/3 safe abstain (0 false-heal)', TARGETS.every(n=>C[n].verdict!=='heal'));
  expect('M.gate: invisible element blocked, visible button passes', gateImg.usable===false && gateBtn.usable===true);
  const passed=cases.filter(c=>c.ok).length;
  return {passed, failed:cases.length-passed, cases, scenarios:{A,B,C},
    metrics:{ M_gate_invisibleBlocked:{before:0, after:(gateImg.usable===false?100:0), unit:'% identified-but-invisible blocked'} }};
}
if (typeof window!=='undefined'){ window.runAll = runAll; window.runMobile = runMobile; }
