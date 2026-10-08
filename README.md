# PowerSizer

**Open-source early-stage screening** for U.S. battery-backed industrial loads, data centers, and hybrid microgrids. Designed to be understandable, forkable, and deployable on GitHub Pages in minutes, with no accounts, API keys or backend.

## Run / publish

1. Open `index.html` locally in a browser (or `python3 -m http.server 8000` and visit `http://localhost:8000`).
2. Create a public repository on GitHub and upload `index.html`, `styles.css`, `engine.js`, `app.js` (and optionally the other files) to the **repository root**.
3. Go to **Settings → Pages → Build and deployment** and select **Deploy from a branch**, `main`, `/ (root)`.
4. Use the published `https://<username>.github.io/<repo>/` URL.

**Testing:** `node --test tests/engine.test.cjs` (Node.js 18+; no dependencies). `engine.js` is testable through Node and the browser.

## Three architectures

| Architecture | Continuity assumptions | Battery sizing | Firm generation |
| --- | --- | --- | --- |
| Grid + BESS | A user-entered grid import limit; 24-hour illustrative charge / discharge dispatch | Worst of full critical-load outage bridge, a user grid-cap window, and the profile-derived repeating-day grid-cap cycle | Grid is unavailable during the outage; BESS is time-limited. Grid capacity may be insufficient for repeated-day operation. |
| Gas + BESS | Gas units must serve the full facility peak (not merely critical load) | Full critical-load bridge for an editable number of minutes | N, N+1, N+2, N+3 capacity cases, reserve and net site derating |
| PV + Gas + BESS | Generator fleet supports nighttime full facility peak; PV reduces daytime fuel | Same critical-load bridge as gas | PV has **zero firm capacity credit** and cannot replace generator nighttime adequacy |

## Calculation conventions

- `P_facility = P_IT × PUE` (only when IT mode).
- `P_critical = P_facility × critical_fraction`.
- `P_BESS_required = max(critical bridge MW, temporary grid-cap deficit MW) × (1 + AC power headroom)`.
- `E_BESS_nominal_required = max(critical MW × bridge hours, grid-cap deficit MW × peak-duration hours, E_cycle × discharge efficiency) / (SOC window × discharge efficiency × end-of-life capacity retention)`.
- `E_cycle` (grid case) = sequent-peak storage for the 24-hour profile repeated daily: per hour, draw = (load − cap)/η_dis when above the cap, otherwise −min(cap − load, required BESS AC MW) × η_chg; `E_cycle` = largest cumulative net drawdown over two consecutive days (so deficits that span midnight count as one event). If daily deficit / η_dis exceeds daily recharge, the cap is flagged as unsustainable at any battery size. Charging is limited to the *required* AC MW, a lower bound on installed MW, which is slightly conservative.
- `BESS_unit_count = max(ceil(required AC MW / derated unit AC MW), ceil(required nominal MWh / unit nameplate MWh))`.
- `P_gen_firm_required = P_facility_peak × (1 + generator reserve)`.
- `Generator_units = ceil(P_gen_firm_required / (unit nameplate MW × site derating)) + spare unit count`.
- PV daily AC potential = user-entered MWdc × user-entered kWh/kWdc/day. A generic normalized 6 am–6 pm bell-shaped profile distributes the energy, subject to an AC inverter capacity ceiling `MWdc / DC:AC ratio`.
- Generator units are turned on/off instantaneously each simulation hour to follow load less available PV while remaining above specified per-unit minimum online output; excess PV is curtailed. This **is not** a dynamic frequency or load-step model.
- Grid simulation uses a 1-hour time step and runs two identical days: day 1 starts at the top of the usable SOC window at EOL as a warm-up, and day 2 is reported. It charges with available import headroom, and flags unmet load and day-2 SOC decline (a *non-cyclic* day). This is not a dispatch optimization or site resource model.
- Indicative gas fuel energy (MMBtu/day) = generated electricity (MWh/day) × a **constant user-input** heat rate (MMBtu/MWh). Not a manufacturer's part-load fuel curve and not a validated fuel supply estimate.
- Round-trip efficiency is not directly used in the energy equation. Separate discharge and charge efficiencies apply. **Check energy rating definition** before applying additional EOL/SOC margins to a vendor-guaranteed *usable* MWh figure.

## Assumptions and diligence

The starting values are **illustrative placeholders**, not universal engineering recommendations. All must be checked for the selected site, equipment and operational profile.

- New-build data center planning example: PUE 1.30, flat 24/7 load. Actual measured PUE and critical load should replace the assumption.
- Gensets: 2.5 MW/unit, 90% site derating, 15% reserve, one spare unit, 30% minimum loading, and full critical load battery bridge for 15 minutes. These are not the basis for selecting a specific machine. **Check ISO/standby/prime/continuous rating, altitude, temperature, kVA, PF, reactive power, dynamics, fuel pressure, emissions restrictions and the gas utility.**
- Battery: Tesla's public Megapack design page lists **2-hour: 1,927 kW / 3,854 kWh** and **4-hour: 979 kW / 3,916 kWh** per Megapack. Do not infer grid-forming or black-start capability from these values. The 80% SOC window, 95% assumed one-way efficiencies, 80% EOL energy retention, 10% AC power headroom, and 100% PCS power availability are editable calculation inputs, not Tesla operating instructions.
- PV: 6 MWdc example, 4 kWh/kWdc/day and DC/AC ratio 1.2. **Do not use** generic daily yield for site-specific generation or for multi-day fuel assurance. Get TMY/8760 site data from PVWatts/SAM or another bankable model, and assess cloudy-day contingencies and curtailment.

**Not included:** electric fault current, reactive power, transformers, feeder ratings, grounding, protection coordination, NFPA/NEC compliance, relay logic, islanded synchronization, transfer and startup times, generator transient response, high-frequency / high-ramp data-center load dynamics, battery grid-forming controls, gas pipeline limits, energy tariffs, emissions, actual meteorology, multiday autonomy, capex, O&M, life-cycle costs, or warranty limits. **Do not use tool output for procurement, sign-off, or energization without site-specific design review.**

## Export / collaborate

- **Share link:** assumptions encoded into the URL fragment; anyone can open and edit a design. No information is sent to a server by this app; third-party browser/URL handling is outside its control.
- **JSON:** input assumptions, version, constraint calculations, warnings, and hourly results; can be imported back into the page.
- **Comparison CSV:** three architecture equipment summaries.
- **Hourly CSV:** all three 24-hour time series for engineering review.
- **Print / Save PDF:** browser-generated report with selected design detail, comparison and method notes.

## Public references

- Tesla Megapack public design specifications: https://www.tesla.com/megapack/design
- NREL REopt distributed energy/resilience methodology: https://www.nrel.gov/reopt/
- NREL PVWatts, site-specific solar yield: https://pvwatts.nrel.gov/
- Caterpillar genset screening / site adjustment factors: https://www.cat.com/en_US/by-industry/electric-power/electric-power-resources/genset-sizing.html

Not affiliated with, approved by, or endorsed by Tesla, Caterpillar or NREL. Commercial applications of their product names/specifications require independent checking. MIT license.
