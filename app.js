/* Browser-only interface; mathematical model lives in engine.js. */
(() => {
  'use strict';
  const E = window.PowerSizerEngine;
  const $ = id => document.getElementById(id);
  const inputKeys = Object.keys(E.DEFAULTS);
  let selected = 'grid', current = null;
  const fmt = (x, places = 2) => Number.isFinite(x)
    ? x.toLocaleString(undefined, { maximumFractionDigits: places }) : '—';
  const mw = x => fmt(x) + ' MW';
  const mwh = x => fmt(x) + ' MWh';
  const escape = x => String(x).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const clean = x => String(x || 'design').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'design';
  function readForm() {
    return Object.fromEntries(inputKeys.map(key => [key, $(key).value]));
  }
  function applyValues(input) {
    const values = { ...E.DEFAULTS, ...input };
    for (const key of inputKeys) {
      if (values[key] === undefined || values[key] === null) continue;
      $(key).value = Array.isArray(values[key]) ? values[key].join(', ') : values[key];
    }
    showConditional();
    rerender();
  }
  function showConditional() {
    $('customWrap').hidden = $('loadProfile').value !== 'custom';
    $('pue').disabled = $('mode').value !== 'it';
  }
  function status(text) { $('statusMessage').textContent = text; }
  function rerender() {
    const next = E.analyze(readForm());
    const errorBox = $('errorBox');
    current = next.ok ? next : null;
    errorBox.hidden = next.ok;
    errorBox.textContent = next.ok ? '' : next.errors.join('\n');
    if (!next.ok) {
      $('headline').replaceChildren();
      $('comparison').replaceChildren();
      $('metrics').replaceChildren();
      $('checks').replaceChildren();
      $('breakdown').replaceChildren();
      $('chart').replaceChildren();
      $('flags').replaceChildren();
      return;
    }
    const b = next.base;
    $('headline').innerHTML = [
      ['Facility peak', mw(b.facilityPeakMW)],
      ['Critical bridge load', mw(b.criticalPeakMW)],
      ['24-h site energy', mwh(b.dailyDemandMWh)]
    ].map(([title,val]) => `<div class="item"><span class="cap">${title}</span><strong>${val}</strong></div>`).join('');
    $('comparison').innerHTML = next.scenarios.map(s => {
      const q = s.summary;
      const bad = s.status === 'Constraint';
      return `<button type="button" class="scenario ${s.id === selected ? 'active' : ''}" data-scenario="${s.id}" aria-pressed="${s.id === selected}">
        <div class="sc-heading"><div><div class="sc-title">${escape(s.title)}</div><div class="sc-sub">${escape(s.short)}</div></div><span class="status ${bad?'warn':''}">${bad?'Constraint':'Screened'}</span></div>
        <div class="architecture-values"><div><span class="mini-label">BESS units</span><span class="mini-number">${fmt(q.batteryUnits,0)} · ${fmt(q.batteryMW,1)} MW</span></div><div><span class="mini-label">BESS nameplate</span><span class="mini-number">${fmt(q.batteryMWh,1)} MWh</span></div><div><span class="mini-label">Gas generator units</span><span class="mini-number">${q.generatorUnits ? fmt(q.generatorUnits,0) : '—'}</span></div><div><span class="mini-label">PV installed (DC)</span><span class="mini-number">${q.pvMWdc ? fmt(q.pvMWdc,1)+' MW' : '—'}</span></div></div>
        <div class="scenario-foot">${escape(q.batterySizingBasis)}</div>
      </button>`;
    }).join('');
    document.querySelectorAll('[data-scenario]').forEach(btn => btn.addEventListener('click', () => { selected = btn.dataset.scenario; rerender(); }));
    const s = next.scenarios.find(x => x.id === selected) || next.scenarios[0];
    renderDetails(s);
  }
  function renderDetails(s) {
    const q=s.summary, bat=s.battery, gen=s.generator;
    $('selectedTitle').textContent=s.title;
    $('selectedSubtitle').textContent=s.short;
    $('selectedStatus').textContent=s.status;
    $('selectedStatus').className='status '+(s.status==='Constraint'?'warn':'');
    const metricList=[
      ['Battery quantity',fmt(q.batteryUnits,0)+' units'],
      ['Installed BESS power',mw(q.batteryMW)],
      ['BESS nameplate energy',mwh(q.batteryMWh)],
      [s.id==='grid'?'EOL critical-load runtime':'Installed genset capacity', s.id==='grid'?fmt(q.batteryRuntimeHours,2)+' h':mw(q.generatorInstalledDeratedMW)]
    ];
    $('metrics').innerHTML=metricList.map(([label,value])=>`<div class="metric"><span>${escape(label)}</span><strong>${escape(value)}</strong></div>`).join('');
    const checks=[
      [true,'BESS real-power requirement',`${mw(bat.requiredPowerMW)} required; ${mw(bat.installedACMW)} installed derated`],
      [true,'BESS end-of-life AC energy',`${mwh(bat.requiredACSupportMWh)} needed; ${mwh(bat.deliverableEOLMWh)} available`],
      [true,'Battery sizing constraint',`${escape(bat.bindingConstraint)} / ${bat.powerUnits} power units vs ${bat.energyUnits} energy units; energy basis: ${escape(bat.energyBasis)}`]
    ];
    if(gen) checks.push(
      [gen.spareCasePass,'Generator N+'+gen.spareUnits+' capacity',`${mw(gen.remainingFirmMW)} survives specified spare outages vs ${mw(gen.firmRequiredMW)} required`],
      [q.minimumLoadExcessMWh<1e-7,'Minimum generator loading',q.minimumLoadExcessMWh<1e-7?'No steady-state violation in profile':mwh(q.minimumLoadExcessMWh)+' excessive minimum production']
    );
    else checks.push(
      [q.gridCapCycleFeasible, 'Daily recharge under import cap', q.gridCapCycleFeasible
        ? `${mwh(q.gridCapDeficitMWh)}/day above cap is recoverable from spare import`
        : `${mwh(q.gridCapDeficitMWh)}/day above cap cannot be recharged at any battery size`],
      [q.unservedMWh<1e-7, '24 h grid-limit energy coverage', q.unservedMWh<1e-7 ? 'No unserved sample-hour energy' : mwh(q.unservedMWh)+' unserved']);
    const checked = s.status==='Constraint';
    $('checks').innerHTML=checks.map(([ok, title, detail])=>`<div class="check"><span class="check-icon ${ok?'':'warn'}">${ok?'✓':'!'}</span><span><strong>${title}</strong><small>${detail}</small></span></div>`).join('');
    const list=[
      ['Required BESS AC power',mw(bat.requiredPowerMW)],
      ['Required BESS nameplate energy',mwh(bat.requiredNominalMWh)],
      ['BESS EOL deliverable AC energy',mwh(bat.deliverableEOLMWh)],
      ['Critical-load duration at EOL',fmt(bat.runtimeAtCriticalHours,2)+' h'],
      ['Power / energy unit constraints',`${bat.powerUnits} / ${bat.energyUnits}`]
    ];
    if(gen) list.push(
      ['Genset installed / firm units',`${gen.installedUnits} / ${gen.firmUnits}`],
      ['Derated unit rating',mw(gen.deratedUnitMW)],
      ['Firm MW under spare contingency',mw(gen.remainingFirmMW)],
      ['24 h generator energy',mwh(q.generatorEnergyMWh)],
      ['Indicative fuel energy / day',fmt(q.genFuelMMBtuDay,1)+' MMBtu']
    );
    else list.push(['Grid import limit',mw(Number(current.inputs.gridLimitMW))],
      ['Daily energy above import cap',mwh(q.gridCapDeficitMWh)],
      ['Repeating-day storage needed (usable)',q.gridCapCycleFeasible?mwh(q.gridCapCycleStoredMWh):'Not achievable'],
      ['Unserved energy in sample day',mwh(q.unservedMWh)]);
    if(s.id==='hybrid')list.push(['PV potential / used',mwh(q.pvAvailableMWh)+' / '+mwh(q.pvUsedMWh)], ['PV curtailed',mwh(q.pvCurtailedMWh)]);
    $('breakdown').innerHTML=list.map(([label, value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('');
    $('flags').innerHTML=s.warnings.length?s.warnings.map(w=>`<div class="flag">${escape(w)}</div>`).join('')
      :'<div class="flag ok">No violations detected in the modeled screening checks. This is not verification of site operability or code compliance.</div>';
    $('chart').innerHTML=chartSVG(s.rows);
    $('chartCaption').textContent=s.id==='grid'
      ?'One-hour dispatch against the specified import cap, shown for the second of two identical days (day 1 starts full at end-of-life usable capacity) so the repeating cycle is visible. Does not simulate the separate grid outage bridge event or peak demand tariffs.'
      :'One-hour steady-state generation dispatch. Generator units may switch on/off every hour; start times, ramp rates, BESS transient response and gas supply are not modeled. BESS is held in reserve.';
  }
  function chartSVG(rows) {
    const w=810,h=255,p={l:48,r:16,t:16,b:34};
    const graphW=w-p.l-p.r, graphH=h-p.t-p.b;
    const ys=rows.flatMap(r=>[r.loadMW,r.generatorMW,r.pvUsedMW,r.gridMW,r.bessDischargeMW]);
    const max=Math.max(1,...ys)*1.14;
    const x=i=>p.l+graphW*i/23;
    const y=n=>p.t+graphH*(1-n/max);
    const lines=[
      ['loadMW','#374e5a',2.5,''],['generatorMW','#d38a45',2,''],
      ['pvUsedMW','#62a87e',2,''],['gridMW','#5a92c6',2,''],
      ['bessDischargeMW','#9d83bf',2,'']
    ];
    let svg=`<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">`;
    for(let i=0;i<=4;i++){
      const v=max*i/4,Y=y(v);
      svg+=`<line x1="${p.l}" x2="${w-p.r}" y1="${Y}" y2="${Y}" stroke="#dbe5eb" stroke-dasharray="3 4"/><text x="${p.l-7}" y="${Y+4}" text-anchor="end" fill="#688092" font-size="11">${fmt(v,1)}</text>`;
    }
    for(const hour of [0,6,12,18,23])svg+=`<text x="${x(hour)}" y="${h-11}" text-anchor="middle" fill="#688092" font-size="11">${String(hour).padStart(2,'0')}:00</text>`;
    for(const [field,color,sw] of lines){
      if(!rows.some(r=>(r[field]||0)>0.001))continue;
      svg+=`<polyline fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" points="${rows.map((r,i)=>x(i).toFixed(1)+','+y(r[field]||0).toFixed(1)).join(' ')}"/>`;
    }
    return svg+`<text x="6" y="13" fill="#688092" font-size="11">MW</text></svg>`;
  }
  function downloadFile(filename, contents, mime) {
    const blob = new Blob([contents], { type:mime });
    const uri = URL.createObjectURL(blob);
    const a=document.createElement('a');a.href=uri;a.download=filename;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(uri),2000);
  }
  function cell(value) {
    let v=String(value ?? '');
    // Prevent exported human-input strings being executed as spreadsheet formulas.
    if (/^[\s]*[=+@\-\t\r]/.test(v) && !Number.isFinite(Number(v))) v="'"+v;
    return '"'+v.replace(/"/g,'""')+'"';
  }
  function csv(rows) {return rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';}
  function assure() {if(!current){status('Please correct invalid design inputs before exporting.');return false;}return true;}
  function exportJSON() {
    if(!assure())return;
    const payload={ schemaVersion:'0.4', exportedAt:new Date().toISOString(), selectedArchitecture:selected, ...current };
    downloadFile(clean(current.project)+'.json',JSON.stringify(payload,null,2),'application/json;charset=utf-8');
    status('Design JSON exported with inputs, equations, constraints and hourly results.');
  }
  function exportComparison() {
    if(!assure())return;
    const headings=['architecture','screening_status','facility_peak_MW','critical_bridge_MW','battery_units','battery_installed_AC_MW','battery_installed_MWh','battery_eol_deliverable_MWh','battery_required_AC_MW','battery_required_nominal_MWh','battery_energy_basis','grid_cap_deficit_MWh_day','grid_cap_cycle_feasible','generator_units','generator_firm_MW','solar_MWdc','solar_used_MWh_day','generator_MWh_day','indicative_fuel_MMBtu_day','unserved_MWh_day','flags'];
    const rows=[headings,...current.scenarios.map(s=>[s.title,s.status,s.summary.facilityPeakMW,s.summary.criticalPeakMW,s.battery.units,s.battery.installedACMW,s.battery.installedNominalMWh,s.battery.deliverableEOLMWh,s.battery.requiredPowerMW,s.battery.requiredNominalMWh,s.battery.energyBasis,s.summary.gridCapDeficitMWh,s.summary.gridCapCycleFeasible??'',s.summary.generatorUnits,s.summary.generatorFirmMW,s.summary.pvMWdc,s.summary.pvUsedMWh,s.summary.generatorEnergyMWh,s.summary.genFuelMMBtuDay,s.summary.unservedMWh,s.warnings.join(' | ')])];
    downloadFile(clean(current.project)+'-architectures.csv',csv(rows),'text/csv;charset=utf-8');
    status('Architecture comparison CSV exported.');
  }
  function exportHourly(){
    if(!assure())return;
    const labels=['architecture','hour','load_MW','grid_MW','gas_MW','pv_potential_MW','pv_used_MW','pv_curtailed_MW','bess_charge_MW','bess_discharge_MW','unserved_MW','gas_units_online','stored_usable_MWh'];
    const rows=[labels];
    for(const s of current.scenarios)for(const r of s.rows)rows.push([s.title,r.hour,r.loadMW,r.gridMW,r.generatorMW,r.pvPotentialMW,r.pvUsedMW,r.pvCurtailedMW,r.bessChargeMW,r.bessDischargeMW,r.unservedMW,r.generatorsOnline,r.storedUsableMWh]);
    downloadFile(clean(current.project)+'-hourly.csv',csv(rows),'text/csv;charset=utf-8');
    status('72 hourly rows (three architectures × 24 hours) exported.');
  }
  function encUTF8(str){
    const bytes=new TextEncoder().encode(str);
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function decUTF8(str){
    const s=str.replace(/-/g,'+').replace(/_/g,'/');
    const binary=atob(s);
    return new TextDecoder().decode(Uint8Array.from(binary,c=>c.charCodeAt(0)));
  }
  async function share(){
    if(!assure())return;
    const link=location.href.split('#')[0]+'#design='+encUTF8(JSON.stringify({selected,inputs:current.inputs}));
    try{await navigator.clipboard.writeText(link);status('Shareable design link copied (all assumptions encoded in the URL).');}
    catch{status('Clipboard unavailable. Copy this link: '+link);}
  }
  function importData(payload){
    const input=payload?.inputs||payload;
    if(typeof input!=='object'||input===null||Array.isArray(input))throw Error('JSON must have an inputs object.');
    selected=['grid','gas','hybrid'].includes(payload.selectedArchitecture)?payload.selectedArchitecture:'grid';
    applyValues(input);
    if(!current)throw Error('Imported design contains invalid inputs.');
  }
  function restoreLink(){
    if(!location.hash.startsWith('#design='))return;
    try { const payload=JSON.parse(decUTF8(location.hash.slice(8)));importData(payload);status('Shared design restored.'); }
    catch(e){status('Unable to restore shared link: '+e.message);}
  }
  for(const key of inputKeys){
    $(key).addEventListener('input',()=>{
      if(key==='unitPowerMW'||key==='unitEnergyMWh')$('batteryPreset').value='custom';
      if(key==='batteryPreset'&&E.PRESETS[$('batteryPreset').value]) {
        const p=E.PRESETS[$('batteryPreset').value];
        for(const item of ['unitPowerMW','unitEnergyMWh']) if(p[item]!==undefined)$(item).value=p[item];
      }
      showConditional();rerender();
    });
  }
  $('reset').addEventListener('click',()=>{history.replaceState(null,'',location.pathname+location.search);selected='grid';applyValues(E.DEFAULTS);status('Design reset.');});
  $('json').addEventListener('click',exportJSON);
  $('csv').addEventListener('click',exportComparison);
  $('hourly').addEventListener('click',exportHourly);
  $('share').addEventListener('click',share);
  $('print').addEventListener('click',()=>{if(assure())window.print();});
  $('importButton').addEventListener('click',()=>$('importFile').click());
  $('importFile').addEventListener('change',async e=>{
    const f=e.target.files?.[0]; if(!f)return;
    try{if(f.size>2_000_000)throw Error('Design JSON is too large (2 MB max).');importData(JSON.parse(await f.text()));status('Design JSON imported successfully.');}
    catch(err){status('Import failed: '+err.message);} finally{e.target.value='';}
  });
  showConditional();rerender();restoreLink();
})();
