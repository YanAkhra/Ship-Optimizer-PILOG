import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, LineChart, Line } from "recharts";

// ─── CONSTANTS ───────────────────────────────────────────────
const STATES = {
  waiting:      { label: "Antri Dermaga",   color: "#E24B4A", short: "ANTRI"   },
  loading:      { label: "Muat",            color: "#3B6D11", short: "MUAT"    },
  sailing_out:  { label: "Layar Berangkat", color: "#185FA5", short: "LAYAR↑"  },
  unloading:    { label: "Bongkar",         color: "#BA7517", short: "BONGKAR" },
  sailing_back: { label: "Layar Kembali",   color: "#0F6E56", short: "LAYAR↓"  },
  idle:         { label: "Idle",            color: "#B4B2A9", short: "IDLE"    },
};

const INIT_SHIPS = [
  { id:"GC-01", type:"gc",     cap:7000,  route:"semarang",         active:true },
  { id:"GC-02", type:"gc",     cap:7000,  route:"cilacap",          active:true },
  { id:"GC-03", type:"gc",     cap:7000,  route:"semarang",         active:true },
  { id:"GC-04", type:"gc",     cap:7000,  route:"cilacap",          active:true },
  { id:"GC-05", type:"gc",     cap:7000,  route:"semarang",         active:true },
  { id:"GC-06", type:"gc",     cap:11000, route:"semarang",         active:true },
  { id:"GT-01", type:"tanker", cap:5700,  route:"palembang-gresik", active:true },
  { id:"GT-02", type:"tanker", cap:13200, route:"bontang-gresik",   active:true },
];

// ─── SIMULATION ENGINE ────────────────────────────────────────
function simulate(cfg, ships) {
  let seed = cfg.seed;
  const rng  = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };
  const ri   = (a, b) => a + Math.floor(rng() * (b - a + 1));

  // Interval-scheduling berth allocator
  const slots = Array.from({ length: cfg.berths }, () => []);
  function allocate(fromDay, dur) {
    let bi = 0, bt = Infinity;
    for (let i = 0; i < slots.length; i++) {
      let t = fromDay;
      for (const s of slots[i]) {
        if (s.end <= t) continue;
        if (s.start >= t + dur) break;
        t = s.end;
      }
      if (t < bt) { bt = t; bi = i; }
    }
    slots[bi].push({ start: bt, end: bt + dur });
    slots[bi].sort((a, b) => a.start - b.start);
    return { berthIdx: bi, startDay: bt, endDay: bt + dur };
  }

  // 1) Pre-schedule external ships (sorted by arrival — first-come first-served)
  const extArr = [];
  for (let m = 0; m < Math.ceil(cfg.simDays / 30); m++) {
    const n = ri(Math.max(0, Math.floor(cfg.extPerMonth) - 1), Math.ceil(cfg.extPerMonth) + 1);
    for (let i = 0; i < n; i++) {
      const day = m * 30 + ri(0, 27);
      if (day < cfg.simDays) {
        const cap = ri(cfg.extCapMin, cfg.extCapMax);
        extArr.push({ day, cap, loadDays: Math.max(1, Math.ceil(cap / cfg.loadRate)) });
      }
    }
  }
  extArr.sort((a, b) => a.day - b.day);
  const extEvents = extArr.map((e, i) => {
    const { berthIdx, startDay, endDay } = allocate(e.day, e.loadDays);
    return { id:`EXT-${i}`, arrDay:e.day, berthIdx, startDay, endDay, cap:e.cap };
  });

  // 2) Schedule owned ships (staggered start, then iterative round-trips)
  const activeShips = ships.filter(s => s.active);
  const shipResults = activeShips.map((ship, idx) => {
    const events = [];
    let day = idx * cfg.stagger;
    let voyages = 0;
    const sums = { waiting:0, loading:0, sailing_out:0, unloading:0, sailing_back:0, idle:0 };

    while (day < cfg.simDays) {
      // Load duration
      let lMin, lMax;
      if (ship.type === "gc") {
        [lMin, lMax] = ship.cap <= 7000
          ? [cfg.gcSmMin, cfg.gcSmMax]
          : [cfg.gcLgMin, cfg.gcLgMax];
      } else {
        const b = ship.cap / cfg.loadRate;
        [lMin, lMax] = [Math.max(2, Math.floor(b)), Math.ceil(b) + 1];
      }
      const loadDur = ri(lMin, lMax);
      const { startDay, endDay: loadEnd } = allocate(day, loadDur);

      if (startDay > day) {
        events.push({ type:"waiting", start:day, end:startDay });
        sums.waiting += startDay - day;
      }
      events.push({ type:"loading", start:startDay, end:loadEnd });
      sums.loading += loadDur;

      const sOut = ship.route === "bontang-gresik" ? cfg.sailBontang : cfg.sailOut;
      events.push({ type:"sailing_out", start:loadEnd, end:loadEnd + sOut });
      sums.sailing_out += sOut;

      const uDur = ri(cfg.unloadMin, cfg.unloadMax);
      events.push({ type:"unloading", start:loadEnd + sOut, end:loadEnd + sOut + uDur });
      sums.unloading += uDur;

      const sBack = ship.route === "bontang-gresik" ? cfg.sailBontang : cfg.sailBack;
      const backEnd = loadEnd + sOut + uDur + sBack;
      events.push({ type:"sailing_back", start:loadEnd + sOut + uDur, end:backEnd });
      sums.sailing_back += sBack;

      voyages++;
      day = backEnd;
    }

    const covered = Object.values(sums).reduce((a, b) => a + b, 0);
    sums.idle = Math.max(0, cfg.simDays - covered);
    const prod = sums.loading + sums.sailing_out + sums.unloading + sums.sailing_back;

    return { ...ship, events, voyages, sums, util: prod / cfg.simDays, nonProd: sums.idle + sums.waiting };
  });

  return {
    ships: shipResults,
    extEvents,
    metrics: {
      avgUtil:      shipResults.reduce((s, r) => s + r.util, 0) / shipResults.length,
      totalNonProd: shipResults.reduce((s, r) => s + r.nonProd, 0),
      totalVoyages: shipResults.reduce((s, r) => s + r.voyages, 0),
      totalCargo:   shipResults.reduce((s, r) => s + r.voyages * r.cap, 0),
    },
  };
}

// ─── GANTT SVG ────────────────────────────────────────────────
function Gantt({ ships, simDays }) {
  const RH = 34, LW = 66;
  const DW = Math.max(4, Math.min(18, 960 / simDays));
  const W  = LW + simDays * DW + 50;
  const H  = ships.length * RH + 36;
  const marks = [];
  for (let d = 0; d <= simDays; d += 7) marks.push(d);

  return (
    <div style={{ overflowX:"auto", border:"0.5px solid var(--color-border-tertiary)", borderRadius:8 }}>
      <svg width={W} height={H} style={{ display:"block", minWidth:W }}>
        {marks.map(d => (
          <g key={d}>
            <line x1={LW+d*DW} y1={22} x2={LW+d*DW} y2={H} stroke="var(--color-border-tertiary)" strokeWidth={0.5}/>
            <text x={LW+d*DW} y={14} textAnchor="middle" fontSize={9} fill="var(--color-text-tertiary)">D{d}</text>
          </g>
        ))}
        {ships.map((ship, si) => {
          const y = 22 + si * RH;
          return (
            <g key={ship.id}>
              <text x={LW-6} y={y+RH/2} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)"
                fill="var(--color-text-secondary)" dominantBaseline="central">{ship.id}</text>
              <rect x={LW} y={y+2} width={simDays*DW} height={RH-4}
                fill={si%2===0?"var(--color-background-secondary)":"var(--color-background-tertiary)"} rx={2}/>
              {ship.events.map((e, ei) => {
                if (e.start >= simDays) return null;
                const end = Math.min(e.end, simDays);
                const x = LW + e.start * DW;
                const w = Math.max(2, (end - e.start) * DW - 1);
                return (
                  <g key={ei}>
                    <rect x={x} y={y+5} width={w} height={RH-10} fill={STATES[e.type]?.color||"#888"} rx={2} opacity={0.88}/>
                    {w > 22 && (
                      <text x={x+w/2} y={y+RH/2} textAnchor="middle" dominantBaseline="central"
                        fontSize={8} fill="#fff" opacity={0.95}>{STATES[e.type]?.short}</text>
                    )}
                  </g>
                );
              })}
              <text x={LW+simDays*DW+6} y={y+RH/2} fontSize={9} fontFamily="var(--font-mono)"
                fill={ship.util>0.75?"var(--color-text-success)":ship.util>0.5?"var(--color-text-warning)":"var(--color-text-danger)"}
                dominantBaseline="central">{Math.round(ship.util*100)}%</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── INPUT HELPERS ────────────────────────────────────────────
const lbl  = { fontSize:10, color:"var(--color-text-secondary)", textTransform:"uppercase", letterSpacing:"0.4px", display:"block", marginBottom:2 };
const grp  = { marginBottom:9 };
const card = { border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:14, background:"var(--color-background-primary)", marginBottom:12 };
const ct   = { fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.5px", color:"var(--color-text-secondary)", marginBottom:10 };
const sec  = { fontSize:10, fontWeight:500, textTransform:"uppercase", letterSpacing:"1px", color:"var(--color-text-secondary)", borderBottom:"0.5px solid var(--color-border-tertiary)", padding:"8px 0 4px", marginBottom:8 };

function SliderRow({ label, k, min, max, step=1, cfg, upd, unit="" }) {
  return (
    <div style={grp}>
      <span style={lbl}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={cfg[k]} style={{ width:"100%" }}
        onChange={e => upd(k, +e.target.value)}/>
      <div style={{ textAlign:"right", fontSize:11, fontFamily:"var(--font-mono)", color:"var(--color-text-info)", marginTop:1 }}>
        {cfg[k]}{unit}
      </div>
    </div>
  );
}

function NumRow({ label, k, min=1, max=20, cfg, upd }) {
  return (
    <div style={grp}>
      <span style={lbl}>{label}</span>
      <input type="number" min={min} max={max} value={cfg[k]} style={{ width:"100%", fontFamily:"var(--font-mono)", fontSize:12 }}
        onChange={e => upd(k, +e.target.value)}/>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────
export default function App() {
  const [cfg, setCfg] = useState({
    simDays:90, berths:2, loadRate:2000, stagger:3,
    gcSmMin:2, gcSmMax:3, gcLgMin:3, gcLgMax:4,
    unloadMin:4, unloadMax:5,
    sailOut:3, sailBack:3, sailBontang:3,
    extPerMonth:4.5, extCapMin:5000, extCapMax:7000,
    seed:42,
  });
  const [ships, setShips]     = useState(INIT_SHIPS);
  const [result, setResult]   = useState(null);
  const [tab, setTab]         = useState("gantt");
  const [optCurve, setOpt]    = useState(null);
  const [busy, setBusy]       = useState(false);

  const upd      = (k, v) => setCfg(c => ({ ...c, [k]: v }));
  const updShip  = (i, k, v) => setShips(s => s.map((sh, j) => j===i ? { ...sh, [k]:v } : sh));

  const run = () => {
    setBusy(true);
    setTimeout(() => { setResult(simulate(cfg, ships)); setBusy(false); }, 50);
  };

  const autoOpt = () => {
    setBusy(true);
    setTimeout(() => {
      let best = { stagger:1, idle:Infinity };
      const pts = [];
      for (let s = 1; s <= 15; s++) {
        const r = simulate({ ...cfg, stagger:s, seed:42 }, ships);
        pts.push({ stagger:s, nonProd:Math.round(r.metrics.totalNonProd), util:Math.round(r.metrics.avgUtil*100) });
        if (r.metrics.totalNonProd < best.idle) best = { stagger:s, idle:r.metrics.totalNonProd };
      }
      setCfg(c => ({ ...c, stagger:best.stagger }));
      setOpt({ ...best, pts });
      setResult(simulate({ ...cfg, stagger:best.stagger, seed:42 }, ships));
      setBusy(false);
    }, 60);
  };

  // Tab button style
  const tabSty = (active) => ({
    padding:"7px 16px", fontSize:12, fontWeight:500, cursor:"pointer",
    color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
    background:"none", outline:"none",
    borderTop:"none", borderLeft:"none", borderRight:"none",
    borderBottom: active ? "2px solid var(--color-text-primary)" : "2px solid transparent",
  });

  // KPI card
  const Kpi = ({ label, val, sub, color }) => (
    <div style={{ padding:"10px 12px", borderRadius:8, background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-tertiary)" }}>
      <div style={{ fontSize:10, textTransform:"uppercase", letterSpacing:"0.5px", color:"var(--color-text-secondary)" }}>{label}</div>
      <div style={{ fontSize:24, fontWeight:500, lineHeight:1.15, marginTop:3, fontFamily:"var(--font-mono)", color }}>{val}</div>
      <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2 }}>{sub}</div>
    </div>
  );

  return (
    <div style={{ display:"flex", height:"100vh", fontFamily:"var(--font-sans)", fontSize:13 }}>

      {/* ── SIDEBAR ── */}
      <div style={{ width:264, minWidth:264, borderRight:"0.5px solid var(--color-border-tertiary)", overflowY:"auto", padding:12, background:"var(--color-background-secondary)" }}>

        {/* Decision Variables */}
        <div style={{ border:"0.5px solid var(--color-border-info)", borderRadius:8, padding:10, marginBottom:12, background:"var(--color-background-info)" }}>
          <div style={{ ...sec, color:"var(--color-text-info)", borderColor:"var(--color-border-info)" }}>🎯 Variabel Keputusan</div>
          <SliderRow label="Stagger interval (hari)" k="stagger" min={1} max={15} cfg={cfg} upd={upd} unit=" hari" />

          <span style={lbl}>Rute & status tiap kapal</span>
          {ships.map((sh, i) => (
            <div key={sh.id} style={{ display:"flex", alignItems:"center", gap:5, marginBottom:4 }}>
              <span style={{ fontFamily:"var(--font-mono)", fontSize:10, minWidth:44, color:"var(--color-text-secondary)" }}>{sh.id}</span>
              <select value={sh.route} style={{ flex:1, fontSize:11 }} onChange={e => updShip(i, "route", e.target.value)}>
                {sh.type==="gc"
                  ? <><option value="semarang">→ Semarang</option><option value="cilacap">→ Cilacap</option></>
                  : <><option value="palembang-gresik">PLM→GRS</option><option value="bontang-gresik">BTN→GRS</option></>
                }
              </select>
              <input type="checkbox" checked={sh.active} onChange={e => updShip(i, "active", e.target.checked)} title="Aktifkan kapal"/>
            </div>
          ))}
        </div>

        {/* Simulation Params */}
        <div style={sec}>⚙ Parameter Simulasi</div>
        <SliderRow label="Durasi simulasi" k="simDays" min={30} max={365} step={30} cfg={cfg} upd={upd} unit=" hari" />
        <SliderRow label="Kapal luar per bulan" k="extPerMonth" min={0} max={10} step={0.5} cfg={cfg} upd={upd} unit=" kapal" />

        {/* Port Params */}
        <div style={sec}>🏭 Port Palembang</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          <NumRow label="Jumlah dermaga" k="berths" min={1} max={4} cfg={cfg} upd={upd} />
          <NumRow label="Rate muat (t/hr)" k="loadRate" min={500} max={5000} cfg={cfg} upd={upd} />
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          <NumRow label="Kap. ext min (t)" k="extCapMin" min={1000} max={10000} cfg={cfg} upd={upd} />
          <NumRow label="Kap. ext max (t)" k="extCapMax" min={1000} max={15000} cfg={cfg} upd={upd} />
        </div>

        {/* Timing */}
        <div style={sec}>⏱ Waktu Operasional (hari)</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
          {[["gcSmMin","GC-7K Muat Min"],["gcSmMax","GC-7K Muat Max"],
            ["gcLgMin","GC-11K Muat Min"],["gcLgMax","GC-11K Muat Max"],
            ["unloadMin","Bongkar Min"],["unloadMax","Bongkar Max"],
            ["sailOut","Layar Berangkat"],["sailBack","Layar Kembali"],
          ].map(([k, label]) => (
            <div key={k} style={grp}>
              <span style={lbl}>{label}</span>
              <input type="number" min={1} max={20} value={cfg[k]} style={{ width:"100%", fontFamily:"var(--font-mono)", fontSize:12 }}
                onChange={e => upd(k, +e.target.value)}/>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div style={{ marginTop:10 }}>
          <button style={{ width:"100%", padding:"9px 0", borderRadius:6, border:"none", background:"var(--color-text-primary)", color:"var(--color-background-primary)", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:6, opacity: busy ? 0.6 : 1 }}
            onClick={run} disabled={busy}>
            {busy ? "⟳ Simulasi berjalan..." : "▶ Jalankan Simulasi"}
          </button>
          <button style={{ width:"100%", padding:"8px 0", borderRadius:6, border:"0.5px solid var(--color-border-secondary)", background:"none", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:6, opacity: busy ? 0.6 : 1 }}
            onClick={autoOpt} disabled={busy}>
            ✦ Cari Stagger Optimal (1–15)
          </button>
          {optCurve && (
            <div style={{ fontSize:11, padding:"8px 10px", borderRadius:6, background:"var(--color-background-success)", color:"var(--color-text-success)", border:"0.5px solid var(--color-border-success)" }}>
              ✓ Stagger optimal: <strong>{optCurve.stagger} hari</strong><br/>
              ✓ Min non-produktif: {Math.round(optCurve.idle)} kapal-hari
            </div>
          )}
        </div>

        <div style={{ ...grp, marginTop:10 }}>
          <span style={lbl}>Random seed</span>
          <input type="number" value={cfg.seed} style={{ width:"100%", fontFamily:"var(--font-mono)", fontSize:12 }} onChange={e => upd("seed", +e.target.value)}/>
        </div>
      </div>

      {/* ── MAIN AREA ── */}
      <div style={{ flex:1, overflowY:"auto", padding:16 }}>
        {!result ? (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", height:"80%", color:"var(--color-text-tertiary)", textAlign:"center", gap:12 }}>
            <div style={{ fontSize:52 }}>⚓</div>
            <div style={{ fontSize:17, fontWeight:500, color:"var(--color-text-primary)" }}>Maritime Supply Chain Optimization</div>
            <div style={{ fontSize:13, maxWidth:380, lineHeight:1.7 }}>
              Atur parameter di panel kiri — terutama <strong>stagger interval</strong> dan rute kapal — lalu klik <strong>Jalankan Simulasi</strong>. Gunakan <strong>Cari Stagger Optimal</strong> untuk otomasi.
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginTop:16, textAlign:"left", maxWidth:480 }}>
              {[
                ["8 Kapal Milik","5 GC-7000 · 1 GC-11000 · 2 Gas Tanker"],
                ["2 Dermaga Aktif","Port-II & Port-V Palembang"],
                ["Tiga Rute Utama","Semarang · Cilacap · Gresik"],
              ].map(([t,s]) => (
                <div key={t} style={{ padding:"10px 12px", border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, background:"var(--color-background-secondary)" }}>
                  <div style={{ fontWeight:500, fontSize:12 }}>{t}</div>
                  <div style={{ fontSize:11, color:"var(--color-text-secondary)", marginTop:3 }}>{s}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* KPIs */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:14 }}>
              <Kpi label="Avg Utilisasi" val={`${Math.round(result.metrics.avgUtil*100)}%`} sub={`dari ${cfg.simDays} hari`} color={result.metrics.avgUtil>0.75?"var(--color-text-success)":"var(--color-text-warning)"} />
              <Kpi label="Total Non-Produktif" val={Math.round(result.metrics.totalNonProd)} sub="kapal-hari idle+antri" color="var(--color-text-danger)" />
              <Kpi label="Total Voyage" val={result.metrics.totalVoyages} sub={`dalam ${cfg.simDays} hari`} color="var(--color-text-info)" />
              <Kpi label="Total Cargo" val={`${(result.metrics.totalCargo/1000).toFixed(0)}K`} sub="ton muatan terangkut" color="var(--color-text-primary)" />
            </div>

            {/* Tabs */}
            <div style={{ display:"flex", borderBottom:"0.5px solid var(--color-border-tertiary)", marginBottom:14 }}>
              {[["gantt","Gantt Chart"],["overview","Overview"],["ships","Detail Kapal"],["port","Analisis Port"],["optimize","Kurva Optimasi"]].map(([id, label]) => (
                <button key={id} style={tabSty(tab===id)} onClick={() => setTab(id)}>{label}</button>
              ))}
            </div>

            {tab==="gantt"     && <GanttTab     result={result} cfg={cfg} />}
            {tab==="overview"  && <OverviewTab  result={result} cfg={cfg} />}
            {tab==="ships"     && <ShipsTab     result={result} cfg={cfg} />}
            {tab==="port"      && <PortTab      result={result} cfg={cfg} />}
            {tab==="optimize"  && <OptimizeTab  optCurve={optCurve} />}
          </>
        )}
      </div>
    </div>
  );
}

// ─── TAB: GANTT ───────────────────────────────────────────────
function GanttTab({ result, cfg }) {
  return (
    <div style={card}>
      <div style={ct}>Jadwal Kapal — Gantt Chart ({cfg.simDays} Hari Simulasi)</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:10, marginBottom:12 }}>
        {Object.entries(STATES).map(([k, v]) => (
          <div key={k} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11, color:"var(--color-text-secondary)" }}>
            <div style={{ width:12, height:12, borderRadius:2, background:v.color, flexShrink:0 }}/>
            {v.label}
          </div>
        ))}
      </div>
      <Gantt ships={result.ships} simDays={cfg.simDays} />
      <div style={{ marginTop:10, fontSize:11, color:"var(--color-text-tertiary)" }}>
        % di kanan = utilisasi produktif (muat + layar + bongkar) · Scroll horizontal untuk melihat keseluruhan timeline
      </div>
    </div>
  );
}

// ─── TAB: OVERVIEW ────────────────────────────────────────────
function OverviewTab({ result, cfg }) {
  const barData = result.ships.map(ship => {
    const d = { name: ship.id };
    Object.keys(STATES).forEach(k => { d[k] = Math.round(ship.sums[k] || 0); });
    return d;
  });

  const totals = {};
  Object.keys(STATES).forEach(k => {
    totals[k] = Math.round(result.ships.reduce((s, sh) => s + (sh.sums[k] || 0), 0));
  });
  const pieData = Object.entries(totals).filter(([,v]) => v > 0)
    .map(([k, v]) => ({ name: STATES[k].label, value: v, color: STATES[k].color }));

  const cycleGcSm = `${cfg.gcSmMin+cfg.sailOut+cfg.unloadMin+cfg.sailBack}–${cfg.gcSmMax+cfg.sailOut+cfg.unloadMax+cfg.sailBack}`;
  const cycleGcLg = `${cfg.gcLgMin+cfg.sailOut+cfg.unloadMin+cfg.sailBack}–${cfg.gcLgMax+cfg.sailOut+cfg.unloadMax+cfg.sailBack}`;

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"3fr 2fr", gap:12 }}>
        <div style={card}>
          <div style={ct}>Breakdown Waktu per Kapal (hari)</div>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={barData} margin={{ top:0, right:8, bottom:0, left:-22 }}>
              <XAxis dataKey="name" tick={{ fontSize:10, fontFamily:"var(--font-mono)" }} />
              <YAxis tick={{ fontSize:10 }} />
              <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} />
              <Legend formatter={v => <span style={{ fontSize:10 }}>{STATES[v]?.label}</span>} />
              {Object.entries(STATES).map(([k, v]) => (
                <Bar key={k} dataKey={k} stackId="a" fill={v.color} name={k} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={card}>
          <div style={ct}>Komposisi Waktu Keseluruhan</div>
          <ResponsiveContainer width="100%" height={230}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}
                label={({ percent }) => `${Math.round(percent*100)}%`} labelLine={false} fontSize={10}>
                {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie>
              <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} formatter={v => [`${v} hari`]} />
              <Legend formatter={v => <span style={{ fontSize:10 }}>{v}</span>} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={card}>
        <div style={ct}>Parameter Model Optimasi Aktif</div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
          {[
            ["Stagger interval", `${cfg.stagger} hari`],
            ["Cycle time GC-7000", `${cycleGcSm} hari`],
            ["Cycle time GC-11000", `${cycleGcLg} hari`],
            ["Dermaga aktif", `${cfg.berths} (Port-II & V)`],
            ["Rate muat total", `${cfg.loadRate * cfg.berths} ton/hari`],
            ["Prod. Palembang", "5.400 ton/hari"],
            ["Kapal luar/bln", cfg.extPerMonth],
            ["Durasi simulasi", `${cfg.simDays} hari`],
          ].map(([k, v]) => (
            <div key={k} style={{ padding:"8px 10px", background:"var(--color-background-secondary)", borderRadius:6 }}>
              <div style={{ fontSize:10, textTransform:"uppercase", color:"var(--color-text-secondary)", marginBottom:2 }}>{k}</div>
              <div style={{ fontFamily:"var(--font-mono)", fontWeight:500, fontSize:13 }}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── TAB: SHIPS ───────────────────────────────────────────────
function ShipsTab({ result, cfg }) {
  const th = { padding:"6px 10px", textAlign:"left", fontSize:10, textTransform:"uppercase", color:"var(--color-text-secondary)", borderBottom:"0.5px solid var(--color-border-tertiary)", whiteSpace:"nowrap" };
  const td = (extra={}) => ({ padding:"8px 10px", fontFamily:"var(--font-mono)", fontSize:12, ...extra });

  return (
    <div>
      <div style={{ ...card, overflowX:"auto" }}>
        <div style={ct}>Performa Kapal — {cfg.simDays} Hari Simulasi</div>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr>{["Kapal","Tipe","Kapasitas","Rute","Voyage","Muat","Layar","Bongkar","Antri","Idle","Utilisasi"].map(h => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {result.ships.map((ship, i) => (
              <tr key={ship.id} style={{ background: i%2===0?"transparent":"var(--color-background-secondary)" }}>
                <td style={td({ fontWeight:500 })}>{ship.id}</td>
                <td style={{ padding:"8px 10px" }}>
                  <span style={{ fontSize:10, padding:"2px 7px", borderRadius:4,
                    background: ship.type==="gc"?"var(--color-background-info)":"var(--color-background-success)",
                    color: ship.type==="gc"?"var(--color-text-info)":"var(--color-text-success)" }}>
                    {ship.type==="gc"?"GC":"TANKER"}
                  </span>
                </td>
                <td style={td()}>{ship.cap.toLocaleString()}</td>
                <td style={{ ...td(), fontSize:11, color:"var(--color-text-secondary)" }}>{ship.route}</td>
                <td style={td({ color:"var(--color-text-success)", fontWeight:500 })}>{ship.voyages}</td>
                <td style={td()}>{Math.round(ship.sums.loading)}</td>
                <td style={td()}>{Math.round((ship.sums.sailing_out||0)+(ship.sums.sailing_back||0))}</td>
                <td style={td()}>{Math.round(ship.sums.unloading)}</td>
                <td style={td({ color: (ship.sums.waiting||0)>0?"var(--color-text-danger)":"inherit" })}>{Math.round(ship.sums.waiting||0)}</td>
                <td style={td({ color:"var(--color-text-secondary)" })}>{Math.round(ship.sums.idle)}</td>
                <td style={{ padding:"8px 10px", minWidth:110 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <div style={{ flex:1, height:5, background:"var(--color-background-tertiary)", borderRadius:3, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${Math.round(ship.util*100)}%`, borderRadius:3,
                        background: ship.util>0.75?"var(--color-text-success)":ship.util>0.5?"var(--color-text-warning)":"var(--color-text-danger)" }}/>
                    </div>
                    <span style={{ fontFamily:"var(--font-mono)", fontSize:11, minWidth:32 }}>{Math.round(ship.util*100)}%</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        <div style={card}>
          <div style={ct}>Cargo per Kapal (ton)</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={result.ships.map(s => ({ name:s.id, cargo:s.voyages*s.cap }))}>
              <XAxis dataKey="name" tick={{ fontSize:10, fontFamily:"var(--font-mono)" }} />
              <YAxis tick={{ fontSize:10 }} />
              <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} formatter={v => [v.toLocaleString()+" ton"]} />
              <Bar dataKey="cargo" name="Cargo" fill="#185FA5" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div style={card}>
          <div style={ct}>Utilisasi per Kapal (%)</div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={result.ships.map(s => ({ name:s.id, util:Math.round(s.util*100), nonProd:Math.round(s.nonProd) }))}>
              <XAxis dataKey="name" tick={{ fontSize:10, fontFamily:"var(--font-mono)" }} />
              <YAxis tick={{ fontSize:10 }} domain={[0,100]} />
              <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} formatter={v => [v+"%"]} />
              <Bar dataKey="util" name="Utilisasi %" fill="#3B6D11" radius={[3,3,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// ─── TAB: PORT ────────────────────────────────────────────────
function PortTab({ result, cfg }) {
  const months = Math.ceil(cfg.simDays / 30);
  const monthData = Array.from({ length: months }, (_, m) => {
    const from = m * 30, to = Math.min(from + 30, cfg.simDays);
    let owned = 0, ext = 0;
    for (const sh of result.ships)
      for (const e of sh.events)
        if (e.type === "loading") owned += Math.max(0, Math.min(e.end, to) - Math.max(e.start, from));
    for (const e of result.extEvents)
      ext += Math.max(0, Math.min(e.endDay, to) - Math.max(e.startDay, from));
    const idle = Math.max(0, cfg.berths * (to - from) - owned - ext);
    return { name:`Bln ${m+1}`, owned:Math.round(owned), external:Math.round(ext), idle:Math.round(idle) };
  });

  const queueItems = result.ships.flatMap(sh =>
    sh.events.filter(e => e.type==="waiting" && e.end > e.start)
      .map(e => ({ ship:sh.id, start:e.start, days:e.end-e.start }))
  );

  const totalBerthDays = cfg.berths * cfg.simDays;
  const usedBerthDays  = monthData.reduce((s, m) => s + m.owned + m.external, 0);

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:12 }}>
        {[
          ["Utilisasi Dermaga Total", `${Math.round(usedBerthDays/totalBerthDays*100)}%`, "dari kapasitas dermaga-hari"],
          ["Kapal Luar Masuk", result.extEvents.length, `dalam ${cfg.simDays} hari`],
          ["Kejadian Antrian", queueItems.length, `total ${queueItems.reduce((s,q)=>s+q.days,0).toFixed(1)} hari antri`],
        ].map(([l, v, s]) => (
          <div key={l} style={{ padding:"10px 12px", borderRadius:8, background:"var(--color-background-secondary)", border:"0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ fontSize:10, textTransform:"uppercase", color:"var(--color-text-secondary)", marginBottom:3 }}>{l}</div>
            <div style={{ fontSize:22, fontWeight:500, fontFamily:"var(--font-mono)" }}>{v}</div>
            <div style={{ fontSize:11, color:"var(--color-text-tertiary)", marginTop:2 }}>{s}</div>
          </div>
        ))}
      </div>

      <div style={card}>
        <div style={ct}>Utilisasi Dermaga per Bulan (Dermaga-Hari)</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={monthData} margin={{ top:0, right:10, bottom:0, left:-20 }}>
            <XAxis dataKey="name" tick={{ fontSize:10 }} />
            <YAxis tick={{ fontSize:10 }} />
            <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} />
            <Legend formatter={v => <span style={{ fontSize:10 }}>{v==="owned"?"Kapal Milik":v==="external"?"Kapal Luar":"Dermaga Idle"}</span>} />
            <Bar dataKey="owned"    stackId="a" fill="#185FA5" name="owned" />
            <Bar dataKey="external" stackId="a" fill="#BA7517" name="external" />
            <Bar dataKey="idle"     stackId="a" fill="#D3D1C7" name="idle" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
        <div style={card}>
          <div style={ct}>Daftar Kejadian Antrian Kapal Milik</div>
          {queueItems.length === 0
            ? <div style={{ fontSize:12, color:"var(--color-text-success)", padding:"4px 0" }}>✓ Tidak ada antrian kapal milik pada simulasi ini</div>
            : (
              <table style={{ width:"100%", fontSize:11, borderCollapse:"collapse" }}>
                <thead><tr>{["Kapal","Mulai antri (hari)","Lama antri"].map(h => <th key={h} style={{ padding:"4px 8px", textAlign:"left", fontSize:10, color:"var(--color-text-secondary)", borderBottom:"0.5px solid var(--color-border-tertiary)" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {queueItems.map((q, i) => (
                    <tr key={i} style={{ background: i%2===0?"transparent":"var(--color-background-secondary)" }}>
                      <td style={{ padding:"5px 8px", fontFamily:"var(--font-mono)", fontWeight:500 }}>{q.ship}</td>
                      <td style={{ padding:"5px 8px", fontFamily:"var(--font-mono)" }}>Hari {q.start}</td>
                      <td style={{ padding:"5px 8px", fontFamily:"var(--font-mono)", color:"var(--color-text-danger)" }}>{q.days.toFixed(1)} hari</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          }
        </div>
        <div style={card}>
          <div style={ct}>Info Port Palembang</div>
          <table style={{ width:"100%", fontSize:12 }}>
            <tbody>
              {[
                ["Dermaga", `${cfg.berths} (Port-II & Port-V)`],
                ["Rate muat per dermaga", `${cfg.loadRate.toLocaleString()} ton/hari`],
                ["Rate muat total", `${(cfg.loadRate*cfg.berths).toLocaleString()} ton/hari`],
                ["Kapasitas produksi", "5.400 ton/hari"],
                ["Jam operasi dermaga", "20 jam/hari · 100 ton/jam"],
                ["Kapal luar rata-rata", `${cfg.extPerMonth}/bulan (${cfg.extCapMin.toLocaleString()}–${cfg.extCapMax.toLocaleString()} ton)`],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding:"5px 0", color:"var(--color-text-secondary)" }}>{k}</td>
                  <td style={{ padding:"5px 0", textAlign:"right", fontFamily:"var(--font-mono)", fontWeight:500 }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── TAB: OPTIMIZE ────────────────────────────────────────────
function OptimizeTab({ optCurve }) {
  if (!optCurve) return (
    <div style={{ ...card, textAlign:"center", padding:40 }}>
      <div style={{ fontSize:40, marginBottom:12 }}>📊</div>
      <div style={{ fontWeight:500, marginBottom:6 }}>Belum ada data kurva optimasi</div>
      <div style={{ fontSize:12, color:"var(--color-text-secondary)" }}>Klik <strong>Cari Stagger Optimal</strong> di panel kiri untuk menjalankan analisis sensitivitas stagger 1–15 hari</div>
    </div>
  );

  return (
    <div>
      <div style={{ ...card, border:"0.5px solid var(--color-border-success)", background:"var(--color-background-success)" }}>
        <div style={{ display:"flex", gap:24, flexWrap:"wrap" }}>
          <div>
            <div style={{ fontSize:10, textTransform:"uppercase", color:"var(--color-text-success)", letterSpacing:"0.5px" }}>Stagger Optimal Ditemukan</div>
            <div style={{ fontSize:28, fontWeight:500, fontFamily:"var(--font-mono)", color:"var(--color-text-success)", marginTop:2 }}>{optCurve.stagger} hari</div>
          </div>
          <div>
            <div style={{ fontSize:10, textTransform:"uppercase", color:"var(--color-text-success)", letterSpacing:"0.5px" }}>Min. Total Non-Produktif</div>
            <div style={{ fontSize:28, fontWeight:500, fontFamily:"var(--font-mono)", color:"var(--color-text-success)", marginTop:2 }}>{Math.round(optCurve.idle)} kapal-hari</div>
          </div>
        </div>
      </div>

      <div style={card}>
        <div style={ct}>Kurva Sensitivitas: Total Non-Produktif vs Stagger Interval</div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={optCurve.pts} margin={{ top:5, right:20, bottom:5, left:0 }}>
            <XAxis dataKey="stagger" tick={{ fontSize:11 }} label={{ value:"Stagger (hari)", position:"insideBottom", offset:-2, fontSize:11 }} />
            <YAxis tick={{ fontSize:11 }} />
            <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} formatter={(v, n) => [v, n==="nonProd"?"Non-Produktif (hari)":"Utilisasi (%)"]} />
            <Legend formatter={v => <span style={{ fontSize:10 }}>{v==="nonProd"?"Non-Produktif (hari)":"Utilisasi (%)"}</span>} />
            <Line type="monotone" dataKey="nonProd" stroke="#E24B4A" strokeWidth={2} dot={{ r:4 }} name="nonProd"
              label={{ position:"top", fontSize:9, fill:"var(--color-text-secondary)" }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={card}>
        <div style={ct}>Utilisasi Rata-rata vs Stagger Interval</div>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={optCurve.pts} margin={{ top:5, right:20, bottom:5, left:0 }}>
            <XAxis dataKey="stagger" tick={{ fontSize:11 }} label={{ value:"Stagger (hari)", position:"insideBottom", offset:-2, fontSize:11 }} />
            <YAxis tick={{ fontSize:11 }} domain={[0,100]} unit="%" />
            <Tooltip contentStyle={{ fontSize:11, borderRadius:6 }} formatter={v => [v+"%", "Utilisasi"]} />
            <Line type="monotone" dataKey="util" stroke="#185FA5" strokeWidth={2} dot={{ r:4 }} name="util" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={card}>
        <div style={ct}>Tabel Lengkap Sensitivitas</div>
        <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
          <thead>
            <tr>{["Stagger (hari)","Non-Produktif (kapal-hari)","Utilisasi (%)","Status"].map(h => (
              <th key={h} style={{ padding:"6px 10px", textAlign:"left", fontSize:10, textTransform:"uppercase", color:"var(--color-text-secondary)", borderBottom:"0.5px solid var(--color-border-tertiary)" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {optCurve.pts.map((pt, i) => (
              <tr key={i} style={{ background: pt.stagger===optCurve.stagger?"var(--color-background-success)":i%2===0?"transparent":"var(--color-background-secondary)" }}>
                <td style={{ padding:"7px 10px", fontFamily:"var(--font-mono)", fontWeight:500 }}>{pt.stagger}</td>
                <td style={{ padding:"7px 10px", fontFamily:"var(--font-mono)", color:"var(--color-text-danger)" }}>{pt.nonProd}</td>
                <td style={{ padding:"7px 10px", fontFamily:"var(--font-mono)" }}>{pt.util}%</td>
                <td style={{ padding:"7px 10px" }}>
                  {pt.stagger===optCurve.stagger
                    ? <span style={{ fontSize:10, padding:"2px 8px", borderRadius:4, background:"var(--color-background-success)", color:"var(--color-text-success)" }}>✓ Optimal</span>
                    : <span style={{ fontSize:10, color:"var(--color-text-tertiary)" }}>—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
