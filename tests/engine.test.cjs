const test=require('node:test');
const assert=require('node:assert/strict');
const eng=require('../engine.js');
const nearly=(a,b,eps=1e-7)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const mk=(extra={})=>eng.analyze({...eng.DEFAULTS,...extra});

test('base facility peak and critical-load conversion are correct',()=>{
  const r=mk();assert.equal(r.ok,true);nearly(r.base.facilityPeakMW,13);nearly(r.base.criticalPeakMW,13);
  nearly(r.base.dailyDemandMWh,312);
});
test('battery sizing uses BOTH power and EOL delivered-energy constraints',()=>{
  const r=mk(), g=r.scenarios[0];
  nearly(g.battery.requiredPowerMW,14.3);
  nearly(g.battery.requiredNominalMWh,26/(.8*.95*.8));
  assert.equal(g.battery.powerUnits,8);
  assert.equal(g.battery.energyUnits,12);
  assert.equal(g.battery.units,12);
  assert.ok(g.battery.deliverableEOLMWh >= 26);
});
test('the firm generator count includes derating, reserve AND N+1',()=>{
  const r=mk(),gen=r.scenarios[1].generator;
  nearly(gen.deratedUnitMW,2.25);
  nearly(gen.firmRequiredMW,14.95);
  assert.equal(gen.firmUnits,7);assert.equal(gen.installedUnits,8);
  nearly(gen.remainingFirmMW,15.75);
  assert.equal(gen.spareCasePass,true);
});
test('N vs N+1 and N+2 have predictable unit increments',()=>{
  assert.equal(mk({genRedundancy:0}).scenarios[1].summary.generatorUnits,7);
  assert.equal(mk({genRedundancy:1}).scenarios[1].summary.generatorUnits,8);
  assert.equal(mk({genRedundancy:2}).scenarios[1].summary.generatorUnits,9);
});
test('islanded BESS is sized to the 15min full critical load bridge rather than 2 hours',()=>{
  const s=mk().scenarios[1];
  assert.equal(s.battery.units,8);nearly(s.battery.requiredACSupportMWh,13*.25);
});
test('solar is not credited as firm nighttime capacity',()=>{
  const a=mk({solarMWdc:0}).scenarios[2], b=mk({solarMWdc:100}).scenarios[2];
  assert.equal(a.generator.installedUnits,b.generator.installedUnits);
  assert.equal(a.generator.remainingFirmMW,b.generator.remainingFirmMW);
  assert.ok(b.summary.pvUsedMWh>0);
});
test('solar daily energy and generator displacement approximately balance for the default case',()=>{
  const a=mk().scenarios;
  nearly(a[2].summary.pvAvailableMWh,24,1e-5);
  nearly(a[2].summary.generatorEnergyMWh+a[2].summary.pvUsedMWh,312,1e-6);
  assert.ok(a[2].summary.generatorEnergyMWh<a[1].summary.generatorEnergyMWh);
});
test('grid cap smaller than steady load is not incorrectly declared viable forever',()=>{
  const s=mk({gridLimitMW:12}).scenarios[0];
  assert.equal(s.status,'Constraint');
  assert.ok(s.warnings.some(x=>x.includes('repeating 24-hour cycle')));
});
test('a severely limited grid causes unmet load on the sample day',()=>{
  const s=mk({gridLimitMW:1}).scenarios[0];
  assert.equal(s.status,'Constraint');
  assert.ok(s.summary.unservedMWh>0);
});
test('day-biased industrial profiles reduce gas consumption against 24x peak',()=>{
  const a=mk({loadProfile:'flat'}).scenarios[1].summary.generatorEnergyMWh;
  const b=mk({loadProfile:'day'}).scenarios[1].summary.generatorEnergyMWh;
  assert.ok(b<a);
});
test('custom profile needs exactly 24 bounded hours',()=>{
  assert.equal(mk({loadProfile:'custom',customProfile:'1,1,1'}).ok,false);
  assert.equal(mk({loadProfile:'custom',customProfile:Array(24).fill(1.1).join(',')}).ok,false);
  assert.equal(mk({loadProfile:'custom',customProfile:Array(24).fill(.5).join(',')}).ok,true);
});
test('invalid, out of range, and non-finite inputs are rejected',()=>{
  assert.equal(mk({pue:.8}).ok,false);
  assert.equal(mk({unitEnergyMWh:0}).ok,false);
  assert.equal(mk({genRedundancy:1.5}).ok,false);
  assert.equal(mk({loadMW:'NaN'}).ok,false);
});
test('architecture outputs have exactly 24 coherent hourly records',()=>{
  const r=mk();
  for(const s of r.scenarios){
    assert.equal(s.rows.length,24);
    for(const row of s.rows){
      for(const key of ['loadMW','gridMW','generatorMW','pvUsedMW','bessDischargeMW','unservedMW'])
        assert.ok(Number.isFinite(row[key]) && row[key]>=-1e-8,`${key} invalid for ${s.id}`);
    }
  }
});
test('PV near-zero prevents arbitrary solar generator energy reduction',()=>{
  const r=mk({solarMWdc:0});
  nearly(r.scenarios[1].summary.generatorEnergyMWh,r.scenarios[2].summary.generatorEnergyMWh);
  nearly(r.scenarios[2].summary.pvUsedMWh,0);
});
test('facility input ignores PUE when configured as total facility MW',()=>{
  const r=mk({mode:'facility',loadMW:7,pue:2});
  nearly(r.base.facilityPeakMW,7);
});

// --- Grid-cap battery sized from the load profile (v0.4) ---
test('grid-cap energy follows the profile deficit, hand-calculated',()=>{
  // Day profile: 13 MW for 11 h (08–18), 8.45 MW otherwise; 11 MW cap → 2 MW × 11 h = 22 MWh AC.
  // Nominal = 22 / (0.8 × 0.95 × 0.8) = 36.18 MWh → ceil(36.18 / 3.854) = 10 units (power needs 8).
  const s=mk({loadProfile:'day',gridLimitMW:11,gridBridgeHours:0.25}).scenarios[0];
  nearly(s.summary.gridCapDeficitMWh,22);
  nearly(s.battery.requiredACSupportMWh,22);
  assert.equal(s.battery.energyBasis,'Daily grid-cap cycle');
  assert.equal(s.battery.energyUnits,10);assert.equal(s.battery.units,10);
  nearly(s.summary.unservedMWh,0);assert.equal(s.status,'Screened');
});
test('deficits spanning midnight are one contiguous event, not two',()=>{
  // Night profile: 1 MW above a 12 MW cap for 20:00–06:59 (11 h); split at 00:00 it would look like 7 h.
  const s=mk({loadProfile:'night',gridLimitMW:12,gridBridgeHours:0.25}).scenarios[0];
  nearly(s.battery.requiredACSupportMWh,11);
  assert.ok(!s.warnings.some(x=>x.includes('repeating 24-hour cycle')));
  assert.equal(s.status,'Screened');
});
test('an adequate battery on a night-heavy profile is not falsely flagged as unsustainable',()=>{
  const s=mk({loadProfile:'night',gridLimitMW:12,gridBridgeHours:24}).scenarios[0];
  assert.ok(s.summary.unservedMWh<1e-7);
  assert.ok(!s.warnings.some(x=>x.includes('repeating 24-hour cycle')));
  assert.equal(s.status,'Screened');
});
test('sequent-peak storage is the largest net drawdown, with partial recharge between deficits',()=>{
  const v={gridLimitMW:10,dischargeEffPct:100,chargeEffPct:100};
  const load=[12,12,9,12,12,...Array(19).fill(5)]; // drawdown 2,2,−1,2,2 → 7 MWh, not 8
  const c=eng.gridCapCycle(v,load,100);
  assert.equal(c.feasible,true);nearly(c.storedMWh,7);nearly(c.deficitACMWh,8);
});
test('charge power and efficiency limit recharge; insufficient daily recharge is infeasible',()=>{
  const load=[12,12,9,12,12,...Array(19).fill(5)];
  assert.equal(eng.gridCapCycle({gridLimitMW:10,dischargeEffPct:100,chargeEffPct:100},load,0.3).feasible,false);
  // 8 MWh deficit / 0.9 = 8.89 MWh stored; 20 h × 0.5 MW × 0.9 = 9 MWh recharge → feasible, just.
  assert.equal(eng.gridCapCycle({gridLimitMW:10,dischargeEffPct:90,chargeEffPct:90},load,0.5).feasible,true);
  assert.equal(eng.gridCapCycle({gridLimitMW:10,dischargeEffPct:90,chargeEffPct:85},load,0.5).feasible,false);
});
test('a flat load above the cap is reported as unsustainable at any battery size',()=>{
  const s=mk({gridLimitMW:12}).scenarios[0];
  assert.equal(s.summary.gridCapCycleFeasible,false);
  assert.ok(s.warnings.some(x=>x.includes('no battery size can sustain')));
  assert.equal(s.status,'Constraint');
});
test('grid cap at or above peak leaves the battery sized by the outage bridge, unchanged',()=>{
  const s=mk().scenarios[0];
  nearly(s.summary.gridCapDeficitMWh,0);
  assert.equal(s.battery.energyBasis,'Outage bridge');assert.equal(s.battery.units,12);
});
test('whenever the profile is recoverable, the sized battery passes its own repeated-day simulation',()=>{
  let seed=42;const rnd=()=>(seed=(seed*1103515245+12345)%2147483648)/2147483648;
  let feasibleCases=0;
  for(let i=0;i<300;i++){
    const prof=Array.from({length:24},()=>(0.3+0.7*rnd()).toFixed(3));
    const extra={loadProfile:'custom',customProfile:prof.join(','),gridLimitMW:+(13*(0.4+0.6*rnd())).toFixed(2),
      gridBridgeHours:0.1,peakWindowHours:0.1,chargeEffPct:85+Math.round(15*rnd()),dischargeEffPct:85+Math.round(15*rnd()),
      bessHeadroomPct:0,unitEnergyMWh:+(0.5+4*rnd()).toFixed(3)};
    const s=mk(extra).scenarios[0];
    if(!s.summary.gridCapCycleFeasible)continue;
    feasibleCases++;
    assert.ok(s.summary.unservedMWh<1e-6,`case ${i} unserved ${s.summary.unservedMWh}`);
    assert.ok(!s.warnings.some(x=>x.includes('repeating 24-hour cycle')),`case ${i} not cyclic`);
  }
  assert.ok(feasibleCases>50,`only ${feasibleCases} feasible cases exercised`);
});
