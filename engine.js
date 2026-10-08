/* PowerSizer: deterministic, dependency-free screening calculations.
 * Units: MW, MWh, hours, MWdc, and percentages as indicated.
 * Exposes PowerSizerEngine in the browser and CommonJS for node:test.
 */
(function (root, factory) {
  const engine = factory();
  if (typeof module === 'object' && module.exports) module.exports = engine;
  root.PowerSizerEngine = engine;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.4.0';
  const DEFAULTS = Object.freeze({
    project: '10 MW IT data center — concept', mode: 'it', loadMW: 10, pue: 1.3,
    criticalPct: 100, loadProfile: 'flat', customProfile: Array(24).fill(1).join(', '),
    gridLimitMW: 15, gridBridgeHours: 2, peakWindowHours: 2,
    genBridgeMinutes: 15, genUnitMW: 2.5, genDeratePct: 90,
    genReservePct: 15, genRedundancy: 1, genMinLoadPct: 30,
    solarMWdc: 6, solarYieldKWhPerKWDay: 4, pvDcAcRatio: 1.2,
    batteryPreset: 'mp2', unitPowerMW: 1.927, unitEnergyMWh: 3.854,
    bessHeadroomPct: 10, bessPowerDeratePct: 100, socWindowPct: 80,
    dischargeEffPct: 95, chargeEffPct: 95, eolRetentionPct: 80,
    gasHeatRateMMBtuPerMWh: 9
  });
  const ARCH = [
    { id: 'grid', title: 'Grid + Battery', short: 'Grid-tied bridge & peak management' },
    { id: 'gas', title: 'Gas + Battery', short: 'Firm islanded generation' },
    { id: 'hybrid', title: 'Solar + Gas + Battery', short: 'Hybrid islanded microgrid' }
  ];
  const PRESETS = {
    mp2: { unitPowerMW: 1.927, unitEnergyMWh: 3.854, batteryPreset: 'mp2' },
    mp4: { unitPowerMW: 0.979, unitEnergyMWh: 3.916, batteryPreset: 'mp4' },
    custom: { batteryPreset: 'custom' }
  };
  function numeric(raw, name, min, max, errors) {
    if (raw === '' || raw === null || raw === undefined) { errors.push(name + ' is required.'); return NaN; }
    const val = Number(raw);
    if (!Number.isFinite(val) || val < min || val > max) {
      errors.push(name + ' must be between ' + min + ' and ' + max + '.');
    }
    return val;
  }
  function parseProfile(s) {
    const arr = Array.isArray(s) ? s : String(s).split(/[\s,;]+/).filter(Boolean);
    if (arr.length !== 24) throw Error('Custom load profile must contain exactly 24 hourly multipliers.');
    const values = arr.map(Number);
    if (values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) {
      throw Error('Load multipliers must each be between 0 and 1.');
    }
    return values;
  }
  function validate(input) {
    const errors = [];
    const v = { ...DEFAULTS, ...input };
    const ranges = {
      loadMW: [0.01, 10000], pue: [1, 3], criticalPct: [1, 100],
      gridLimitMW: [0, 10000], gridBridgeHours: [0.01, 168], peakWindowHours: [0.01, 24],
      genBridgeMinutes: [0.1, 1440], genUnitMW: [0.01, 200], genDeratePct: [1, 100],
      genReservePct: [0, 100], genRedundancy: [0, 3], genMinLoadPct: [0, 100],
      solarMWdc: [0, 10000], solarYieldKWhPerKWDay: [0, 12], pvDcAcRatio: [0.5, 3],
      unitPowerMW: [0.001, 100], unitEnergyMWh: [0.001, 1000],
      bessHeadroomPct: [0, 100], bessPowerDeratePct: [1, 100],
      socWindowPct: [1, 100], dischargeEffPct: [1, 100], chargeEffPct: [1, 100],
      eolRetentionPct: [1, 100], gasHeatRateMMBtuPerMWh: [0.01, 30]
    };
    for (const [name, [min, max]] of Object.entries(ranges)) v[name] = numeric(v[name], name, min, max, errors);
    if (!['it', 'facility'].includes(v.mode)) errors.push('Load mode must be IT or facility.');
    if (!['flat', 'day', 'night', 'custom'].includes(v.loadProfile)) errors.push('Invalid load profile.');
    if (!Number.isInteger(v.genRedundancy)) errors.push('Spare generator count must be an integer.');
    if (!Number.isInteger(v.genRedundancy) || v.genRedundancy < 0) errors.push('Invalid redundancy.');
    if (String(v.project).length > 120) errors.push('Project name is too long.');
    try { v.hourlyMultipliers = loadFactors(v.loadProfile, v.customProfile); }
    catch (e) { errors.push(e.message); }
    if (v.genMinLoadPct > 100) errors.push('Minimum generator load cannot exceed 100%.');
    return { values: v, errors };
  }
  function loadFactors(mode, custom) {
    if (mode === 'custom') return parseProfile(custom);
    if (mode === 'day') return Array.from({ length: 24 }, (_, h) => h >= 8 && h < 19 ? 1 : 0.65);
    if (mode === 'night') return Array.from({ length: 24 }, (_, h) => h >= 20 || h < 7 ? 1 : 0.65);
    return Array(24).fill(1);
  }
  function solarCurve(v) {
    // Deliberately generic, normalized clear-day silhouette; not weather or TMY data.
    const weights = Array.from({ length: 24 }, (_, h) => Math.max(0, Math.sin(Math.PI * (h + 0.5 - 6) / 12)));
    const sum = weights.reduce((a, b) => a + b, 0);
    const dailyACMWh = v.solarMWdc * v.solarYieldKWhPerKWDay; // kWh/kW = MWh/MW
    const inverterACMW = v.solarMWdc / v.pvDcAcRatio;
    return weights.map(w => Math.min(inverterACMW, dailyACMWh * w / sum)); // 1-hour timestep
  }
  function gridCapCycle(v, loadMW, chargeCapMW) {
    // Sequent-peak reservoir sizing on a repeating day: smallest stored (DC-side, usable)
    // energy that serves every hour above the import cap, recharging only from spare import.
    // Two passes over the day capture deficits that wrap past midnight.
    const etaD = v.dischargeEffPct / 100, etaC = v.chargeEffPct / 100;
    let deficitACMWh = 0, rechargeStoredMWh = 0, k = 0, storedMWh = 0;
    for (let i = 0; i < 48; i++) {
      const net = loadMW[i % 24] - v.gridLimitMW;
      const draw = net > 0 ? net / etaD : -Math.min(-net, chargeCapMW) * etaC;
      if (i < 24) { deficitACMWh += Math.max(0, net); rechargeStoredMWh += Math.max(0, -draw); }
      k = Math.max(0, k + draw);
      storedMWh = Math.max(storedMWh, k);
    }
    const feasible = deficitACMWh / etaD <= rechargeStoredMWh + 1e-9;
    return { deficitACMWh, rechargeStoredMWh, feasible,
      storedMWh: feasible ? storedMWh : NaN,
      // AC-equivalent so batteryRequirement's ÷(SOC × η_dis × EOL) yields the nominal MWh.
      acEquivalentMWh: feasible ? storedMWh * etaD : 0 };
  }
  function batteryRequirement(v, criticalMW, durationHours, extra = null) {
    const headroom = 1 + v.bessHeadroomPct / 100;
    const denom = (v.socWindowPct / 100) * (v.dischargeEffPct / 100) * (v.eolRetentionPct / 100);
    const needPowerMW = Math.max(criticalMW * headroom, extra ? extra.powerMW * headroom : 0);
    // Mutually exclusive events, not a simultaneous contingency combination.
    const bases = [['Outage bridge', criticalMW * durationHours]];
    if (extra) bases.push(['Peak-cap window', extra.energyMWh]);
    if (extra && extra.cycleMWh) bases.push(['Daily grid-cap cycle', extra.cycleMWh]);
    const [energyBasis, supportEnergyMWh] = bases.reduce((a, b) => b[1] > a[1] + 1e-9 ? b : a);
    const needNominalMWh = supportEnergyMWh / denom;
    const unitDeratedMW = v.unitPowerMW * v.bessPowerDeratePct / 100;
    const powerUnits = Math.ceil(needPowerMW / unitDeratedMW - 1e-10);
    const energyUnits = Math.ceil(needNominalMWh / v.unitEnergyMWh - 1e-10);
    const units = Math.max(1, powerUnits, energyUnits);
    return {
      requiredPowerMW: needPowerMW, requiredNominalMWh: needNominalMWh,
      requiredACSupportMWh: supportEnergyMWh, energyBasis,
      powerUnits, energyUnits, bindingConstraint: powerUnits >= energyUnits ? 'Power' : 'Energy',
      units, installedACMW: units * unitDeratedMW,
      installedNominalMWh: units * v.unitEnergyMWh,
      deliverableEOLMWh: units * v.unitEnergyMWh * denom,
      runtimeAtCriticalHours: criticalMW > 0 ? units * v.unitEnergyMWh * denom / criticalMW : Infinity,
      effectivePerUnitACMW: unitDeratedMW
    };
  }
  function generatorRequirement(v, facilityPeakMW) {
    const deratedUnitMW = v.genUnitMW * v.genDeratePct / 100;
    const neededMW = facilityPeakMW * (1 + v.genReservePct / 100);
    const firmUnits = Math.ceil(neededMW / deratedUnitMW - 1e-10);
    const installedUnits = firmUnits + v.genRedundancy;
    return {
      deratedUnitMW, firmRequiredMW: neededMW, firmUnits,
      installedUnits, spareUnits: v.genRedundancy,
      installedDeratedMW: installedUnits * deratedUnitMW,
      remainingFirmMW: (installedUnits - v.genRedundancy) * deratedUnitMW,
      spareCasePass: ((installedUnits - v.genRedundancy) * deratedUnitMW + 1e-8) >= neededMW,
      minOnlineMW: deratedUnitMW * v.genMinLoadPct / 100
    };
  }
  function dispatchGrid(v, loadMW, bess) {
    // Charge from unused grid capacity; no tariff/time-of-use optimization.
    // Day 1 starts full at end-of-life usable capacity and is a warm-up; day 2 is reported,
    // so a repeating cycle (e.g. night deficits spanning midnight) is judged from its own
    // steady state rather than from an arbitrary full battery at 00:00.
    const maxUsableDC = bess.installedNominalMWh * v.eolRetentionPct / 100 * v.socWindowPct / 100;
    let stored = maxUsableDC, startStored = maxUsableDC;
    let rows = [];
    for (let i = 0; i < 48; i++) {
      const h = i % 24;
      if (i === 24) { startStored = stored; rows = []; }
      const demand = loadMW[h];
      const directGrid = Math.min(v.gridLimitMW, demand);
      const deficit = demand - directGrid;
      let dischargeMW = 0, chargeMW = 0, unservedMW = 0;
      if (deficit > 0) {
        dischargeMW = Math.min(deficit, bess.installedACMW, stored * v.dischargeEffPct / 100);
        stored -= dischargeMW / (v.dischargeEffPct / 100);
        unservedMW = deficit - dischargeMW;
      } else {
        const spareGrid = Math.max(0, v.gridLimitMW - directGrid);
        chargeMW = Math.min(spareGrid, bess.installedACMW,
          (maxUsableDC - stored) / (v.chargeEffPct / 100));
        stored += chargeMW * v.chargeEffPct / 100;
      }
      stored = Math.max(0, Math.min(maxUsableDC, stored));
      rows.push({ hour: h, loadMW: demand, gridMW: directGrid + chargeMW,
        generatorMW: 0, pvPotentialMW: 0, pvUsedMW: 0, pvCurtailedMW: 0,
        bessChargeMW: chargeMW, bessDischargeMW: dischargeMW,
        unservedMW, generatorsOnline: 0, storedUsableMWh: stored });
    }
    return { rows, fullUsableMWh: maxUsableDC, startStoredMWh: startStored, endStoredMWh: stored };
  }
  function dispatchGeneration(v, loadMW, gen, isHybrid) {
    const solar = isHybrid ? solarCurve(v) : Array(24).fill(0);
    const rows = [];
    for (let h = 0; h < 24; h++) {
      const demand = loadMW[h], available = solar[h];
      const targetGen = Math.max(0, demand - available);
      const maxOnline = gen.firmUnits; // spare(s) assumed unavailable
      const generatorsOnline = Math.min(maxOnline, Math.max(1, Math.ceil(targetGen / gen.deratedUnitMW - 1e-10)));
      const generatorMinMW = generatorsOnline * gen.minOnlineMW;
      const pvUsedMW = Math.max(0, Math.min(available, demand - generatorMinMW));
      const generatorMW = Math.max(generatorMinMW, demand - pvUsedMW);
      const unservedMW = Math.max(0, generatorMW - generatorsOnline * gen.deratedUnitMW);
      // unservedMW signals firm power gap; minimum-load overproduction is separate.
      rows.push({ hour: h, loadMW: demand, gridMW: 0,
        generatorMW: Math.min(generatorMW, generatorsOnline * gen.deratedUnitMW),
        pvPotentialMW: available, pvUsedMW, pvCurtailedMW: available - pvUsedMW,
        bessChargeMW: 0, bessDischargeMW: 0,
        unservedMW, generatorsOnline, storedUsableMWh: null,
        minimumLoadExcessMW: Math.max(0, generatorMinMW - demand) });
    }
    return { rows };
  }
  function sum(rows, key) { return rows.reduce((acc, r) => acc + (r[key] || 0), 0); }
  function analyze(input) {
    const { values: v, errors } = validate(input);
    if (errors.length) return { ok: false, version: VERSION, errors };
    const facilityPeakMW = v.loadMW * (v.mode === 'it' ? v.pue : 1);
    const criticalPeakMW = facilityPeakMW * v.criticalPct / 100;
    const profile = v.hourlyMultipliers.map(f => facilityPeakMW * f);
    const base = { facilityPeakMW, criticalPeakMW, dailyDemandMWh: profile.reduce((a,b) => a + b, 0) };
    const generator = generatorRequirement(v, facilityPeakMW);
    const gridGapMW = Math.max(0, facilityPeakMW - v.gridLimitMW);
    // Charging is capped at the required AC power, a lower bound on what gets installed.
    const gridChargeCapMW = Math.max(criticalPeakMW, gridGapMW) * (1 + v.bessHeadroomPct / 100);
    const gridCycle = gridCapCycle(v, profile, gridChargeCapMW);
    const gridBattery = batteryRequirement(v, criticalPeakMW, v.gridBridgeHours,
      { powerMW: gridGapMW, energyMWh: gridGapMW * v.peakWindowHours, cycleMWh: gridCycle.acEquivalentMWh });
    const genBattery = batteryRequirement(v, criticalPeakMW, v.genBridgeMinutes / 60);
    const gridDispatch = dispatchGrid(v, profile, gridBattery);
    const gasDispatch = dispatchGeneration(v, profile, generator, false);
    const hybridDispatch = dispatchGeneration(v, profile, generator, true);
    const scenarios = ARCH.map(a => {
      const battery = a.id === 'grid' ? gridBattery : genBattery;
      const dispatch = a.id === 'grid' ? gridDispatch : (a.id === 'gas' ? gasDispatch : hybridDispatch);
      const rows = dispatch.rows;
      const warnings = [];
      const unservedMWh = sum(rows, 'unservedMW');
      const minimumLoadExcessMWh = sum(rows, 'minimumLoadExcessMW');
      const pvAvailableMWh = sum(rows, 'pvPotentialMW');
      const pvUsedMWh = sum(rows, 'pvUsedMW');
      const pvCurtailedMWh = sum(rows, 'pvCurtailedMW');
      const generationMWh = sum(rows, 'generatorMW');
      const isGrid = a.id === 'grid';
      const isHybrid = a.id === 'hybrid';
      let status = 'Screened';
      if (isGrid) {
        if (v.gridLimitMW < facilityPeakMW)
          warnings.push('Grid connection is below the design peak. The battery is sized for one repeating sample day only; verify multi-day, seasonal and contingency recharge or add firm generation.');
        if (!gridCycle.feasible)
          warnings.push('Daily energy above the import cap exceeds what spare import can recharge, so no battery size can sustain this profile. Raise the import limit, reduce load, or add firm generation.');
        if (unservedMWh > 1e-7) warnings.push('24-hour grid-cap simulation has unmet load after battery energy/power limits.');
        if (gridDispatch.endStoredMWh < gridDispatch.startStoredMWh - 1e-6)
          warnings.push('The battery ends the sample day below its starting state. The modeled dispatch is not sustainable as a repeating 24-hour cycle.');
        if (!gridCycle.feasible || unservedMWh > 1e-7 || gridDispatch.endStoredMWh < gridDispatch.startStoredMWh - 1e-6)
          status = 'Constraint';
      } else {
        if (!generator.spareCasePass) warnings.push('Generator firm capacity under spare-unit contingency is inadequate.');
        if (unservedMWh > 1e-7) warnings.push('Generator output capacity cannot meet a modeled hour.');
        if (minimumLoadExcessMWh > 1e-7) warnings.push('Some hours fall below the minimum loading of one online generator. Revise unit sizes/controls.');
        if (isHybrid) {
          warnings.push('PV production is generic, not site/weather based; solar receives zero firm capacity credit for night/N+1 sizing.');
          if (pvCurtailedMWh > 1e-7) warnings.push('Solar production is curtailed due to AC clipping or minimum generator loading.');
        }
        if (unservedMWh > 1e-7 || minimumLoadExcessMWh > 1e-7) status = 'Constraint';
      }
      if (battery.runtimeAtCriticalHours + 1e-8 < (isGrid ? v.gridBridgeHours : v.genBridgeMinutes/60)) {
        warnings.push('Battery deliverable energy is insufficient for the nominated support duration.');
        status = 'Constraint';
      }
      const summary = {
        ...base, batteryUnits: battery.units, batteryMW: battery.installedACMW,
        batteryMWh: battery.installedNominalMWh, batteryRuntimeHours: battery.runtimeAtCriticalHours,
        generatorUnits: isGrid ? 0 : generator.installedUnits,
        generatorInstalledDeratedMW: isGrid ? 0 : generator.installedDeratedMW,
        generatorFirmMW: isGrid ? 0 : generator.remainingFirmMW,
        pvMWdc: isHybrid ? v.solarMWdc : 0,
        pvAvailableMWh, pvUsedMWh, pvCurtailedMWh,
        generatorEnergyMWh: generationMWh, unservedMWh,
        genFuelMMBtuDay: isGrid ? 0 : generationMWh * v.gasHeatRateMMBtuPerMWh,
        minimumLoadExcessMWh,
        batterySizingBasis: isGrid ? `Grid outage ${v.gridBridgeHours} h; peak cap ${v.peakWindowHours} h; daily cap cycle (noncoincident) — ${battery.energyBasis} governs` : `Full critical-load bridge ${v.genBridgeMinutes} minutes`,
        gridCapDeficitMWh: isGrid ? gridCycle.deficitACMWh : 0,
        gridCapCycleStoredMWh: isGrid ? gridCycle.storedMWh : 0,
        gridCapCycleFeasible: isGrid ? gridCycle.feasible : null
      };
      return { ...a, status, summary, battery, generator: isGrid ? null : generator, warnings, rows };
    });
    return {
      ok: true, version: VERSION, inputs: Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, v[k]])),
      project: String(v.project), base, scenarios,
      methodology: {
        grade: 'Concept/pre-feasibility only; not stamped engineering or an equipment guarantee.',
        timestepHours: 1,
        batteries: 'Count = max(ceil(AC power demand / derated unit AC power), ceil(AC energy demand / (unit MWh × SOC window × discharge efficiency × EOL retention))). EOL retained energy and SOC used once.',
        firmGeneration: 'Unit count = ceil(peak facility MW × (1 + reserve) / derated unit MW) + standby spare units. PV = 0 firm credit.',
        grid: 'Grid-cap energy = max(user peak window, sequent-peak storage for the repeating 24-h profile, recharging only from spare import at required BESS power). 24 x 1-hour dispatch after a warm-up day that starts at top of usable EOL SOC window; reported day is flagged if ending SOC is below its own start.',
        solar: 'Generic normalized 06:00–18:00 profile, user AC yield in kWh/kWdc/day, capped by DC/AC inverter ratio; not site-specific/weather-derived.',
        exclusions: 'Not modeled: motor/load steps, harmonic distortion, fault current, voltage and frequency stability, interconnection, kVA/PF, short-circuit, islanding/black start, actual genset fuel curves, weather and multi-day dispatch, power controls, installation constraints, emissions, tariffs or CAPEX.'
      }
    };
  }
  return { VERSION, DEFAULTS, PRESETS, ARCH, validate, analyze, solarCurve, generatorRequirement, batteryRequirement, gridCapCycle };
});
