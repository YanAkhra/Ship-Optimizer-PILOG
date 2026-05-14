import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, LineChart, Line } from "recharts";
 
// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════
const STATES = {
  waiting:      { label:"Antri Dermaga",   color:"#E24B4A", short:"ANTRI"   },
  prod_wait:    { label:"Tunggu Produksi", color:"#991F1F", short:"PROD↓"   },
  loading:      { label:"Muat",            color:"#3B6D11", short:"MUAT"    },
  sailing_out:  { label:"Layar Berangkat", color:"#185FA5", short:"LAYAR↑"  },
  anchoring:    { label:"Labuh Tujuan",    color:"#534AB7", short:"LABUH"   },
  unloading:    { label:"Bongkar",         color:"#BA7517", short:"BONGKAR" },
  sailing_back: { label:"Layar Kembali",   color:"#0F6E56", short:"LAYAR↓"  },
  idle:         { label:"Idle",            color:"#B4B2A9", short:"IDLE"    },
};
 
const SHIP_COLORS = {
  "GC-01":"#185FA5","GC-02":"#3B6D11","GC-03":"#BA7517","GC-04":"#534AB7",
  "GC-05":"#0F6E56","GC-06":"#993556","GT-01":"#854F0B","GT-02":"#A32D2D",
};
const EXT_COLOR = "#D4537E";
 
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
 
// ═══════════════════════════════════════════════════════════════
// SIMULATION ENGINE
// ═══════════════════════════════════════════════════════════════
function simulate(cfg, ships) {
  let seed = cfg.seed;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };
  const ri  = (a, b) => a + Math.floor(rng() * (b - a + 1));
 
  // ── Production downtime periods (SEPARATE for GC and Tanker) ──
  const genDowntimes = (perMonth, dMin, dMax) => {
    const dts = [];
    let dd = 0;
    while (dd < cfg.simDays) {
      if (perMonth > 0 && rng() * 30 < perMonth) {
        const dur = ri(dMin, dMax);
        dts.push({ start: dd, end: Math.min(dd + dur, cfg.simDays) });
        dd += dur + ri(3, 8);
      } else { dd++; }
    }
    return dts;
  };
 
  const gcDowntimes = genDowntimes(cfg.downPerMonth, cfg.downMin, cfg.downMax);
  const tankerDowntimes = genDowntimes(cfg.tankerDownPerMonth, cfg.tankerDownMin, cfg.tankerDownMax);
 
  const isProdDown = (day, shipType) => {
    const dts = shipType === "gc" ? gcDowntimes : tankerDowntimes;
    return dts.some(dt => day >= dt.start && day < dt.end);
  };
 
  // Compute loading events split by downtime
  function computeLoadEvents(startDay, nomDays, shipType) {
    const evts = [];
    let day = startDay, prog = 0, segStart = null, segType = null;
    const flush = (t, end) => { if (segStart !== null && end > segStart) evts.push({ type:t, start:segStart, end }); };
    while (prog < nomDays) {
      const ct = isProdDown(day, shipType) ? "prod_wait" : "loading";
      if (ct !== segType) { flush(segType, day); segStart = day; segType = ct; }
      if (ct === "loading") prog++;
      day++;
    }
    flush(segType, day);
    return { evts, endDay: day };
  }
 
  // ── Generic interval-scheduling berth allocator ───────────────
  function makeAlloc(n) {
    const bSlots = Array.from({ length: n }, () => []);
    return {
      bSlots,
      alloc(fromDay, dur) {
        let bi = 0, bt = Infinity;
        for (let i = 0; i < bSlots.length; i++) {
          let t = fromDay;
          for (const s of bSlots[i]) {
            if (s.end <= t) continue;
            if (s.start >= t + dur) break;
            t = s.end;
          }
          if (t < bt) { bt = t; bi = i; }
        }
        const slot = { start: bt, end: bt + dur, shipId: "", portType: "" };
        bSlots[bi].push(slot);
        bSlots[bi].sort((a, b) => a.start - b.start);
        return { bi, startDay: bt, endDay: bt + dur, slot };
      },
      earliest(fromDay, dur) {
        let bt = Infinity;
        for (let i = 0; i < bSlots.length; i++) {
          let t = fromDay;
          for (const s of bSlots[i]) {
            if (s.end <= t) continue;
            if (s.start >= t + dur) break;
            t = s.end;
          }
          if (t < bt) bt = t;
        }
        return bt;
      },
    };
  }
 
  // SEPARATE PORT ALLOCATORS for GC and Tanker
  const gcOriginA    = makeAlloc(cfg.gcBerths);      // Port-II, Port-V for General Cargo
  const tankerOriginA = makeAlloc(cfg.tankerBerths); // Port-Gas-1, Port-Gas-2 for Tankers
  const semA         = makeAlloc(cfg.semBerths);
  const cilA         = makeAlloc(cfg.cilBerths);
  const grsA         = makeAlloc(cfg.grsBerths);
  const destMap      = { semarang: semA, cilacap: cilA, gresik: grsA };
 
  // ── Routing decision ─────────────────────────────────────────
  function decideRoute(prefRoute, depDay, nomUnload) {
    if (prefRoute !== "semarang" && prefRoute !== "cilacap")
      return { route: prefRoute, reason:"Rute tanker (tetap)", changed:false };
    const arrT  = depDay + cfg.sailOut;
    const wSem  = semA.earliest(arrT, nomUnload) - arrT;
    const wCil  = cilA.earliest(arrT, nomUnload) - arrT;
    const thr   = cfg.anchorThr;
    if (prefRoute === "semarang") {
      if (wSem <= thr)  return { route:"semarang", reason:"Preferensi Semarang OK",          changed:false, wSem, wCil };
      if (wCil < wSem)  return { route:"cilacap",  reason:"Dialihkan → Cilacap lebih longgar",changed:true,  wSem, wCil };
      if (wSem > thr*2) return { route:"semarang", reason:"⚓ Labuh dahulu — Semarang padat", changed:false, anchor:true, wSem, wCil };
      return              { route:"semarang", reason:"Tetap Semarang (antrian wajar)",       changed:false, wSem, wCil };
    } else {
      if (wCil <= thr)  return { route:"cilacap",  reason:"Preferensi Cilacap OK",           changed:false, wSem, wCil };
      if (wSem < wCil)  return { route:"semarang", reason:"Dialihkan → Semarang lebih longgar",changed:true, wSem, wCil };
      if (wCil > thr*2) return { route:"cilacap",  reason:"⚓ Labuh dahulu — Cilacap padat", changed:false, anchor:true, wSem, wCil };
      return              { route:"cilacap",  reason:"Tetap Cilacap (antrian wajar)",        changed:false, wSem, wCil };
    }
  }
 
  // ── External ships (GC ports only — assume all external are GC type) ─
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
    const { bi, startDay, endDay, slot } = gcOriginA.alloc(e.day, e.loadDays);
    slot.shipId = `EXT-${i+1}`;
    slot.portType = "gc";
    return { id:`EXT-${i+1}`, arrDay:e.day, berthIdx:bi, startDay, endDay, cap:e.cap, portType:"gc" };
  });
 
  // ── Owned ships ───────────────────────────────────────────────
  const routingLog = [];
  const activeShips = ships.filter(s => s.active);
 
  const shipResults = activeShips.map((ship, idx) => {
    const events = [];
    let day = idx * cfg.stagger, voyages = 0;
    const sums = Object.fromEntries(Object.keys(STATES).map(k => [k, 0]));
 
    // Select correct port based on ship type
    const originPort = ship.type === "gc" ? gcOriginA : tankerOriginA;
    const portType = ship.type === "gc" ? "gc" : "tanker";
 
    while (day < cfg.simDays) {
      // Load duration
      let lMin, lMax;
      if (ship.type === "gc") {
        [lMin, lMax] = ship.cap <= 7000 ? [cfg.gcSmMin, cfg.gcSmMax] : [cfg.gcLgMin, cfg.gcLgMax];
      } else {
        const b = ship.cap / cfg.loadRate;
        [lMin, lMax] = [Math.max(2, Math.floor(b)), Math.ceil(b) + 1];
      }
      const nomLoad = ri(lMin, lMax);
 
      // Acquire berth at correct port
      const { startDay, slot } = originPort.alloc(day, nomLoad);
      slot.shipId = ship.id;
      slot.portType = portType;
 
      if (startDay > day) {
        events.push({ type:"waiting", start:day, end:startDay });
        sums.waiting += startDay - day;
      }
 
      // Loading + production downtime (type-specific)
      const { evts: loadEvts, endDay: loadEnd } = computeLoadEvents(startDay, nomLoad, ship.type);
      slot.end = loadEnd;
      for (const e of loadEvts) { events.push(e); sums[e.type] += e.end - e.start; }
 
      // Routing decision (GC only)
      let fr = ship.route;
      if (ship.type === "gc") {
        const nomUnload = (cfg.unloadMin + cfg.unloadMax) / 2;
        const dec = decideRoute(ship.route, loadEnd, nomUnload);
        routingLog.push({ ship:ship.id, voyage:voyages+1, day:Math.round(loadEnd), ...dec });
        fr = dec.route;
      }
 
      const sOut = (fr === "bontang-gresik" || fr === "palembang-gresik") ? cfg.sailBontang : cfg.sailOut;
      events.push({ type:"sailing_out", start:loadEnd, end:loadEnd+sOut });
      sums.sailing_out += sOut;
 
      // Destination berth
      const dk = (fr === "bontang-gresik" || fr === "palembang-gresik") ? "gresik" : fr;
      const uDur = ri(cfg.unloadMin, cfg.unloadMax);
      const arrD = loadEnd + sOut;
      const { startDay: uStart, endDay: uEnd, slot: dSlot } = destMap[dk].alloc(arrD, uDur);
      dSlot.shipId = ship.id;
 
      if (uStart > arrD) {
        events.push({ type:"anchoring", start:arrD, end:uStart });
        sums.anchoring += uStart - arrD;
      }
      events.push({ type:"unloading", start:uStart, end:uEnd, dest:dk });
      sums.unloading += uDur;
 
      const sBack = (fr === "bontang-gresik" || fr === "palembang-gresik") ? cfg.sailBontang : cfg.sailBack;
      events.push({ type:"sailing_back", start:uEnd, end:uEnd+sBack });
      sums.sailing_back += sBack;
 
      voyages++;
      day = uEnd + sBack;
    }
 
    const covered = Object.values(sums).reduce((a, b) => a + b, 0);
    sums.idle = Math.max(0, cfg.simDays - covered);
    const prod = sums.loading + sums.sailing_out + sums.unloading + sums.sailing_back;
 
    return { ...ship, events, voyages, sums, util: prod / cfg.simDays,
      nonProd: sums.idle + sums.waiting + sums.anchoring + sums.prod_wait };
  });
 
  return {
    ships: shipResults, extEvents, gcDowntimes, tankerDowntimes, routingLog,
    gcOriginBSlots: gcOriginA.bSlots,
    tankerOriginBSlots: tankerOriginA.bSlots,
    semBSlots: semA.bSlots, cilBSlots: cilA.bSlots, grsBSlots: grsA.bSlots,
    metrics: {
      avgUtil:      shipResults.reduce((s,r)=>s+r.util,0)/shipResults.length,
      totalNonProd: shipResults.reduce((s,r)=>s+r.nonProd,0),
      totalVoyages: shipResults.reduce((s,r)=>s+r.voyages,0),
      totalCargo:   shipResults.reduce((s,r)=>s+r.voyages*r.cap,0),
      gcDownDays:   gcDowntimes.reduce((s,dt)=>s+(dt.end-dt.start),0),
      tankerDownDays: tankerDowntimes.reduce((s,dt)=>s+(dt.end-dt.start),0),
      totalAnchor:  shipResults.reduce((s,r)=>s+(r.sums.anchoring||0),0),
      rerouted:     0,
    },
  };
}
 
// ═══════════════════════════════════════════════════════════════
// GANTT: SHIP JOURNEY (owned ships)
// ═══════════════════════════════════════════════════════════════
function JourneyGantt({ ships, simDays }) {
  const RH=34, LW=66, DW=Math.max(4,Math.min(18,960/simDays));
  const W=LW+simDays*DW+50, H=ships.length*RH+36;
  const marks=[]; for(let d=0;d<=simDays;d+=7) marks.push(d);
  return (
    <div style={{overflowX:"auto",border:"0.5px solid var(--color-border-tertiary)",borderRadius:8}}>
      <svg width={W} height={H} style={{display:"block",minWidth:W}}>
        {marks.map(d=>(
          <g key={d}>
            <line x1={LW+d*DW} y1={22} x2={LW+d*DW} y2={H} stroke="var(--color-border-tertiary)" strokeWidth={0.5}/>
            <text x={LW+d*DW} y={14} textAnchor="middle" fontSize={9} fill="var(--color-text-tertiary)">D{d}</text>
          </g>
        ))}
        {ships.map((ship,si)=>{
          const y=22+si*RH;
          return (
            <g key={ship.id}>
              <text x={LW-6} y={y+RH/2} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)"
                fill="var(--color-text-secondary)" dominantBaseline="central">{ship.id}</text>
              <rect x={LW} y={y+2} width={simDays*DW} height={RH-4}
                fill={si%2===0?"var(--color-background-secondary)":"var(--color-background-tertiary)"} rx={2}/>
              {ship.events.map((e,ei)=>{
                if(e.start>=simDays) return null;
                const end=Math.min(e.end,simDays), x=LW+e.start*DW, w=Math.max(2,(end-e.start)*DW-1);
                return (
                  <g key={ei}>
                    <rect x={x} y={y+5} width={w} height={RH-10} fill={STATES[e.type]?.color||"#888"} rx={2} opacity={0.88}/>
                    {w>22&&<text x={x+w/2} y={y+RH/2} textAnchor="middle" dominantBaseline="central" fontSize={8} fill="#fff" opacity={0.95}>{STATES[e.type]?.short}</text>}
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
 
// ═══════════════════════════════════════════════════════════════
// GANTT: PORT BERTH VIEW (owned + external + downtime overlay)
// ═══════════════════════════════════════════════════════════════
function PortGantt({ bSlots, prodDowntimes=[], simDays, berthNames=[], title="" }) {
  const RH=34, LW=90, DW=Math.max(4,Math.min(18,920/simDays));
  const W=LW+simDays*DW+20, H=bSlots.length*RH+36;
  const marks=[]; for(let d=0;d<=simDays;d+=7) marks.push(d);
  return (
    <div>
      {title && <div style={{fontSize:11,fontWeight:500,marginBottom:8,color:"var(--color-text-secondary)"}}>{title}</div>}
      <div style={{overflowX:"auto",border:"0.5px solid var(--color-border-tertiary)",borderRadius:8}}>
        <svg width={W} height={H} style={{display:"block",minWidth:W}}>
          {marks.map(d=>(
            <g key={d}>
              <line x1={LW+d*DW} y1={22} x2={LW+d*DW} y2={H} stroke="var(--color-border-tertiary)" strokeWidth={0.5}/>
              <text x={LW+d*DW} y={14} textAnchor="middle" fontSize={9} fill="var(--color-text-tertiary)">D{d}</text>
            </g>
          ))}
          {bSlots.map((slotArr,bi)=>{
            const y=22+bi*RH, label=berthNames[bi]||`Dermaga ${bi+1}`;
            return (
              <g key={bi}>
                <text x={LW-6} y={y+RH/2} textAnchor="end" fontSize={10} fontFamily="var(--font-mono)"
                  fill="var(--color-text-secondary)" dominantBaseline="central">{label}</text>
                <rect x={LW} y={y+2} width={simDays*DW} height={RH-4}
                  fill={bi%2===0?"var(--color-background-secondary)":"var(--color-background-tertiary)"} rx={2}/>
                {slotArr.filter(s=>s.shipId&&s.start<simDays).map((slot,si)=>{
                  const end=Math.min(slot.end,simDays), x=LW+slot.start*DW, w=Math.max(2,(end-slot.start)*DW-1);
                  const isExt=slot.shipId.startsWith("EXT");
                  const color=isExt?EXT_COLOR:(SHIP_COLORS[slot.shipId]||"#185FA5");
                  return (
                    <g key={si}>
                      <rect x={x} y={y+5} width={w} height={RH-10} fill={color} rx={2} opacity={0.88}/>
                      {w>24&&<text x={x+w/2} y={y+RH/2} textAnchor="middle" dominantBaseline="central" fontSize={8} fill="#fff">{slot.shipId}</text>}
                    </g>
                  );
                })}
                {prodDowntimes.filter(dt=>dt.start<simDays).map((dt,i)=>(
                  <rect key={i} x={LW+dt.start*DW} y={y+2} width={(Math.min(dt.end,simDays)-dt.start)*DW} height={RH-4}
                    fill="#E24B4A" opacity={0.2} rx={1}/>
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
 
// ═══════════════════════════════════════════════════════════════
// STYLE HELPERS
// ═══════════════════════════════════════════════════════════════
const C = {
  card: { border:"0.5px solid var(--color-border-tertiary)", borderRadius:8, padding:14, background:"var(--color-background-primary)", marginBottom:12 },
  ct:   { fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.5px", color:"var(--color-text-secondary)", marginBottom:10 },
  lbl:  { fontSize:10, color:"var(--color-text-secondary)", textTransform:"uppercase", letterSpacing:"0.4px", display:"block", marginBottom:2 },
  sec:  { fontSize:10, fontWeight:500, textTransform:"uppercase", letterSpacing:"1px", color:"var(--color-text-secondary)", borderBottom:"0.5px solid var(--color-border-tertiary)", padding:"8px 0 4px", marginBottom:8 },
  th:   { padding:"6px 8px", textAlign:"left", fontSize:10, textTransform:"uppercase", color:"var(--color-text-secondary)", borderBottom:"0.5px solid var(--color-border-tertiary)", whiteSpace:"nowrap" },
  td:   { padding:"7px 8px", fontFamily:"var(--font-mono)", fontSize:11 },
};
 
// ═══════════════════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════════════════
export default function App() {
  const [cfg, setCfg] = useState({
    simDays:90, gcBerths:2, tankerBerths:2, loadRate:2000, stagger:3,
    gcSmMin:2, gcSmMax:3, gcLgMin:3, gcLgMax:4,
    unloadMin:4, unloadMax:5,
    sailOut:3, sailBack:3, sailBontang:3,
    extPerMonth:4.5, extCapMin:5000, extCapMax:7000,
    // GC production downtime
    downPerMonth:1.5, downMin:1, downMax:3,
    // Tanker production downtime (separate)
    tankerDownPerMonth:1.0, tankerDownMin:1, tankerDownMax:2,
    // destination ports
    semBerths:2, cilBerths:2, grsBerths:2,
    anchorThr:2,
    seed:42,
  });
  const [ships, setShips] = useState(INIT_SHIPS);
  const [result, setResult] = useState(null);
  const [tab, setTab]       = useState("gantt");
  const [optCurve, setOpt]  = useState(null);
  const [busy, setBusy]     = useState(false);
 
  const upd     = (k,v) => setCfg(c=>({...c,[k]:v}));
  const updShip = (i,k,v) => setShips(s=>s.map((sh,j)=>j===i?{...sh,[k]:v}:sh));
 
  const run = () => { setBusy(true); setTimeout(()=>{ setResult(simulate(cfg,ships)); setBusy(false); },50); };
  const autoOpt = () => {
    setBusy(true);
    setTimeout(()=>{
      let best={stagger:1,idle:Infinity}; const pts=[];
      for(let s=1;s<=15;s++){
        const r=simulate({...cfg,stagger:s,seed:42},ships);
        pts.push({stagger:s,nonProd:Math.round(r.metrics.totalNonProd),util:Math.round(r.metrics.avgUtil*100)});
        if(r.metrics.totalNonProd<best.idle) best={stagger:s,idle:r.metrics.totalNonProd};
      }
      setCfg(c=>({...c,stagger:best.stagger}));
      setOpt({...best,pts});
      setResult(simulate({...cfg,stagger:best.stagger,seed:42},ships));
      setBusy(false);
    },60);
  };
 
  const tabSty = (a) => ({
    padding:"7px 14px", fontSize:12, fontWeight:500, cursor:"pointer",
    color:a?"var(--color-text-primary)":"var(--color-text-secondary)", background:"none", outline:"none",
    borderTop:"none", borderLeft:"none", borderRight:"none",
    borderBottom:a?"2px solid var(--color-text-primary)":"2px solid transparent",
  });
  const Kpi=({label,val,sub,color})=>(
    <div style={{padding:"10px 12px",borderRadius:8,background:"var(--color-background-secondary)",border:"0.5px solid var(--color-border-tertiary)"}}>
      <div style={{fontSize:10,textTransform:"uppercase",letterSpacing:"0.5px",color:"var(--color-text-secondary)"}}>{label}</div>
      <div style={{fontSize:22,fontWeight:500,lineHeight:1.2,marginTop:3,fontFamily:"var(--font-mono)",color}}>{val}</div>
      <div style={{fontSize:11,color:"var(--color-text-tertiary)",marginTop:2}}>{sub}</div>
    </div>
  );
  const Slider=({label,k,min,max,step=1,unit=""})=>(
    <div style={{marginBottom:9}}>
      <span style={C.lbl}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={cfg[k]} style={{width:"100%"}} onChange={e=>upd(k,+e.target.value)}/>
      <div style={{textAlign:"right",fontSize:11,fontFamily:"var(--font-mono)",color:"var(--color-text-info)",marginTop:1}}>{cfg[k]}{unit}</div>
    </div>
  );
  const Num=({label,k,min=1,max=20})=>(
    <div style={{marginBottom:9}}>
      <span style={C.lbl}>{label}</span>
      <input type="number" min={min} max={max} value={cfg[k]} style={{width:"100%",fontFamily:"var(--font-mono)",fontSize:12}} onChange={e=>upd(k,+e.target.value)}/>
    </div>
  );
 
  const TABS = [
    ["gantt","Gantt Kapal"],["port-activity","Aktivitas Port"],
    ["ships","Detail Kapal"],["routing","Routing Decision"],
    ["overview","Overview"],["optimize","Kurva Optimasi"],["recommend","Rekomendasi Sistem"],
  ];
 
  return (
    <div style={{display:"flex",height:"100vh",fontFamily:"var(--font-sans)",fontSize:13}}>
 
      {/* ─── SIDEBAR ─────────────────────────────────────────── */}
      <div style={{width:262,minWidth:262,borderRight:"0.5px solid var(--color-border-tertiary)",overflowY:"auto",padding:12,background:"var(--color-background-secondary)"}}>
 
        {/* Decision variables */}
        <div style={{border:"0.5px solid var(--color-border-info)",borderRadius:8,padding:10,marginBottom:12,background:"var(--color-background-info)"}}>
          <div style={{...C.sec,color:"var(--color-text-info)",borderColor:"var(--color-border-info)"}}>🎯 Variabel Keputusan</div>
          <Slider label="Stagger interval (hari)" k="stagger" min={1} max={15} unit=" hari"/>
          <div style={{marginBottom:9}}>
            <span style={{...C.lbl,color:"var(--color-text-info)"}}>Rute kapal (centang = aktif)</span>
            {ships.map((sh,i)=>(
              <div key={sh.id} style={{display:"flex",alignItems:"center",gap:5,marginBottom:4}}>
                <span style={{fontFamily:"var(--font-mono)",fontSize:10,minWidth:44,color:"var(--color-text-secondary)"}}>{sh.id}</span>
                <select value={sh.route} style={{flex:1,fontSize:11}} onChange={e=>updShip(i,"route",e.target.value)}>
                  {sh.type==="gc"
                    ?<><option value="semarang">→ Semarang</option><option value="cilacap">→ Cilacap</option></>
                    :<><option value="palembang-gresik">PLM→GRS</option><option value="bontang-gresik">BTN→GRS</option></>
                  }
                </select>
                <input type="checkbox" checked={sh.active} onChange={e=>updShip(i,"active",e.target.checked)}/>
              </div>
            ))}
          </div>
          <Slider label="Ambang labuh tujuan (hari tunggu)" k="anchorThr" min={0} max={10} unit=" hari"/>
        </div>
 
        {/* Sim params */}
        <div style={C.sec}>⚙ Parameter Simulasi</div>
        <Slider label="Durasi simulasi" k="simDays" min={30} max={365} step={30} unit=" hari"/>
        <Slider label="Kapal luar/bulan" k="extPerMonth" min={0} max={10} step={0.5} unit=" kapal"/>
 
        {/* Ports & Production */}
        <div style={C.sec}>🏭 Pelabuhan & Produksi</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
          <Num label="GC Berths (PLM)" k="gcBerths" min={1} max={4}/>
          <Num label="Tanker Berths" k="tankerBerths" min={1} max={4}/>
        </div>
        <Num label="Rate muat (t/hari)" k="loadRate" min={500} max={5000}/>
        
        {/* GC downtime */}
        <div style={{padding:"8px",borderRadius:6,background:"var(--color-background-secondary)",marginTop:8,marginBottom:8}}>
          <div style={{fontSize:10,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:4}}>GC PRODUCTION DOWNTIME</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
            <Num label="/bulan" k="downPerMonth" min={0} max={10}/>
            <Num label="Min (hr)" k="downMin" min={1} max={30}/>
            <Num label="Max (hr)" k="downMax" min={1} max={30}/>
          </div>
        </div>
 
        {/* Tanker downtime */}
        <div style={{padding:"8px",borderRadius:6,background:"var(--color-background-secondary)",marginBottom:8}}>
          <div style={{fontSize:10,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:4}}>TANKER PRODUCTION DOWNTIME</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
            <Num label="/bulan" k="tankerDownPerMonth" min={0} max={10}/>
            <Num label="Min (hr)" k="tankerDownMin" min={1} max={30}/>
            <Num label="Max (hr)" k="tankerDownMax" min={1} max={30}/>
          </div>
        </div>
 
        {/* Destination ports */}
        <div style={C.sec}>🚢 Pelabuhan Tujuan (Dermaga)</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
          <Num label="Semarang" k="semBerths" min={1} max={6}/>
          <Num label="Cilacap" k="cilBerths" min={1} max={6}/>
          <Num label="Gresik" k="grsBerths" min={1} max={6}/>
        </div>
 
        {/* Timing */}
        <div style={C.sec}>⏱ Waktu Operasional (hari)</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
          {[["gcSmMin","GC-7K Min"],["gcSmMax","GC-7K Max"],["gcLgMin","GC-11K Min"],["gcLgMax","GC-11K Max"],
            ["unloadMin","Bongkar Min"],["unloadMax","Bongkar Max"],["sailOut","Layar Brkt"],["sailBack","Layar Balik"]
          ].map(([k,l])=><Num key={k} label={l} k={k}/>)}
        </div>
 
        {/* Actions */}
        <div style={{marginTop:10}}>
          <button style={{width:"100%",padding:"9px 0",borderRadius:6,border:"none",background:"var(--color-text-primary)",color:"var(--color-background-primary)",fontSize:12,fontWeight:500,cursor:"pointer",marginBottom:6,opacity:busy?0.6:1}} onClick={run} disabled={busy}>
            {busy?"⟳ Simulasi berjalan...":"▶ Jalankan Simulasi"}
          </button>
          <button style={{width:"100%",padding:"8px 0",borderRadius:6,border:"0.5px solid var(--color-border-secondary)",background:"none",fontSize:12,fontWeight:500,cursor:"pointer",marginBottom:6,opacity:busy?0.6:1}} onClick={autoOpt} disabled={busy}>
            ✦ Cari Stagger Optimal
          </button>
          {optCurve&&<div style={{fontSize:11,padding:"8px 10px",borderRadius:6,background:"var(--color-background-success)",color:"var(--color-text-success)",border:"0.5px solid var(--color-border-success)"}}>
            ✓ Stagger optimal: <strong>{optCurve.stagger} hari</strong><br/>✓ Min non-produktif: {Math.round(optCurve.idle)} hari
          </div>}
        </div>
        <div style={{marginTop:10,marginBottom:9}}>
          <span style={C.lbl}>Random seed</span>
          <input type="number" value={cfg.seed} style={{width:"100%",fontFamily:"var(--font-mono)",fontSize:12}} onChange={e=>upd("seed",+e.target.value)}/>
        </div>
      </div>
 
      {/* ─── MAIN ─────────────────────────────────────────────── */}
      <div style={{flex:1,overflowY:"auto",padding:16}}>
        {!result?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"80%",color:"var(--color-text-tertiary)",textAlign:"center",gap:12}}>
            <div style={{fontSize:48}}>⚓</div>
            <div style={{fontSize:16,fontWeight:500,color:"var(--color-text-primary)"}}>Maritime Supply Chain Optimization System v2.0</div>
            <div style={{fontSize:13,maxWidth:420,lineHeight:1.7}}>
              <strong>✨ Fitur Baru:</strong><br/>
              • Pelabuhan muat terpisah untuk GC dan Tanker<br/>
              • Downtime produksi independent per tipe kapal<br/>
              • Gantt chart kapal luar + analisis lengkap<br/>
              • Routing decision engine dengan labuh otomatis
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginTop:16,textAlign:"left",maxWidth:480}}>
              {[
                ["🏭 Port-II & Port-V","General Cargo (milik + eksternal)"],
                ["⛽ Port-Gas-1 & Port-Gas-2","Gas Tanker (loading terpisah)"],
                ["📉 Production Downtime","Simulasi gangguan per tipe produk"],
                ["🔀 Smart Routing","Auto reroute Semarang ↔ Cilacap"],
              ].map(([t,s])=>(
                <div key={t} style={{padding:"10px 12px",border:"0.5px solid var(--color-border-tertiary)",borderRadius:8,background:"var(--color-background-secondary)"}}>
                  <div style={{fontWeight:500,fontSize:12}}>{t}</div>
                  <div style={{fontSize:11,color:"var(--color-text-secondary)",marginTop:3}}>{s}</div>
                </div>
              ))}
            </div>
          </div>
        ):(
          <>
            {/* KPIs */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8,marginBottom:14}}>
              <Kpi label="Avg Utilisasi" val={`${Math.round(result.metrics.avgUtil*100)}%`} sub={`dari ${cfg.simDays} hari`} color={result.metrics.avgUtil>0.75?"var(--color-text-success)":"var(--color-text-warning)"}/>
              <Kpi label="Non-Produktif" val={Math.round(result.metrics.totalNonProd)} sub="kapal-hari" color="var(--color-text-danger)"/>
              <Kpi label="Total Voyage" val={result.metrics.totalVoyages} sub={`dalam ${cfg.simDays}h`} color="var(--color-text-info)"/>
              <Kpi label="Total Cargo" val={`${(result.metrics.totalCargo/1000).toFixed(0)}K`} sub="ton terangkut" color="var(--color-text-primary)"/>
              <Kpi label="GC Down" val={`${result.metrics.gcDownDays}h`} sub={`${result.gcDowntimes.length} kejadian`} color={result.metrics.gcDownDays>0?"var(--color-text-danger)":"var(--color-text-success)"}/>
              <Kpi label="Tanker Down" val={`${result.metrics.tankerDownDays}h`} sub={`${result.tankerDowntimes.length} kejadian`} color={result.metrics.tankerDownDays>0?"var(--color-text-danger)":"var(--color-text-success)"}/>
            </div>
 
            {/* Tabs */}
            <div style={{display:"flex",borderBottom:"0.5px solid var(--color-border-tertiary)",marginBottom:14,flexWrap:"wrap"}}>
              {TABS.map(([id,label])=><button key={id} style={tabSty(tab===id)} onClick={()=>setTab(id)}>{label}</button>)}
            </div>
 
            {tab==="gantt"        && <GanttTab       result={result} cfg={cfg}/>}
            {tab==="port-activity" && <PortActivityTab result={result} cfg={cfg}/>}
            {tab==="ships"        && <ShipsTab        result={result} cfg={cfg}/>}
            {tab==="routing"      && <RoutingTab      result={result}/>}
            {tab==="overview"     && <OverviewTab     result={result} cfg={cfg}/>}
            {tab==="optimize"     && <OptimizeTab     optCurve={optCurve}/>}
            {tab==="recommend"    && <RecommendTab    cfg={cfg}/>}
          </>
        )}
      </div>
    </div>
  );
}
 
// ═══════════════════════════════════════════════════════════════
// TABS (using placeholder implementations - keep existing from previous)
// ═══════════════════════════════════════════════════════════════
function GanttTab({ result, cfg }) {
  return (
    <div style={C.card}>
      <div style={C.ct}>Jadwal Perjalanan Kapal Milik — {cfg.simDays} Hari</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:10,marginBottom:12}}>
        {Object.entries(STATES).map(([k,v])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"var(--color-text-secondary)"}}>
            <div style={{width:12,height:12,borderRadius:2,background:v.color,flexShrink:0}}/>{v.label}
          </div>
        ))}
      </div>
      <JourneyGantt ships={result.ships} simDays={cfg.simDays}/>
      <div style={{marginTop:8,fontSize:11,color:"var(--color-text-tertiary)"}}>% kanan = utilisasi produktif · PROD↓ = downtime pabrik · LABUH = tunggu berth tujuan</div>
    </div>
  );
}
 
function PortActivityTab({ result, cfg }) {
  const Legend = ({ items }) => (
    <div style={{display:"flex",flexWrap:"wrap",gap:10,marginBottom:10}}>
      {items.map(([label,color])=>(
        <div key={label} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"var(--color-text-secondary)"}}>
          <div style={{width:12,height:12,borderRadius:2,background:color,flexShrink:0}}/>{label}
        </div>
      ))}
    </div>
  );
 
  const shipLegend = Object.entries(SHIP_COLORS).map(([id,c])=>[id,c]);
  shipLegend.push(["Kapal Luar", EXT_COLOR]);
 
  return (
    <div>
      {/* GC Port Gantt */}
      <div style={C.card}>
        <div style={C.ct}>🏭 Pelabuhan General Cargo (Port-II & Port-V Palembang)</div>
        <Legend items={[...shipLegend.filter(([id])=>id.startsWith("GC")||id==="Kapal Luar"),["🔴 Downtime GC","#E24B4A33"]]}/>
        <PortGantt
          bSlots={result.gcOriginBSlots}
          prodDowntimes={result.gcDowntimes}
          simDays={cfg.simDays}
          berthNames={["Port-II (GC)","Port-V (GC)",...Array.from({length:Math.max(0,result.gcOriginBSlots.length-2)},(_,i)=>`GC-${i+3}`)]}
          title=""
        />
        <div style={{marginTop:8,fontSize:11,color:"var(--color-text-tertiary)"}}>
          Port-II dan Port-V khusus untuk loading General Cargo (milik + kapal luar eksternal)
        </div>
      </div>
 
      {/* Tanker Port Gantt */}
      <div style={C.card}>
        <div style={C.ct}>⛽ Pelabuhan Gas Tanker (Port-Gas-1 & Port-Gas-2)</div>
        <Legend items={[...shipLegend.filter(([id])=>id.startsWith("GT")),["🔴 Downtime Tanker","#E24B4A33"]]}/>
        <PortGantt
          bSlots={result.tankerOriginBSlots}
          prodDowntimes={result.tankerDowntimes}
          simDays={cfg.simDays}
          berthNames={["Port-Gas-1","Port-Gas-2",...Array.from({length:Math.max(0,result.tankerOriginBSlots.length-2)},(_,i)=>`Gas-${i+3}`)]}
          title=""
        />
        <div style={{marginTop:8,fontSize:11,color:"var(--color-text-tertiary)"}}>
          Port-Gas terpisah untuk loading gas tanker — produksi gas independent dari GC
        </div>
      </div>
 
      {/* Destination ports */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        {[
          {label:"Pelabuhan Semarang",bSlots:result.semBSlots},
          {label:"Pelabuhan Cilacap", bSlots:result.cilBSlots},
          {label:"Pelabuhan Gresik",  bSlots:result.grsBSlots},
        ].map(({label,bSlots})=>(
          <div key={label} style={C.card}>
            <div style={C.ct}>{label}</div>
            <PortGantt bSlots={bSlots} simDays={cfg.simDays} berthNames={bSlots.map((_,i)=>`Brth ${i+1}`)}/>
          </div>
        ))}
      </div>
 
      {/* External ships table */}
      <div style={C.card}>
        <div style={C.ct}>Daftar Kapal Luar (General Cargo) — {result.extEvents.length} Kunjungan</div>
        <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
            <thead><tr>
              {["ID","Tiba (hari)","Dermaga","Mulai Muat","Selesai","Durasi","Kapasitas"].map(h=><th key={h} style={C.th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {result.extEvents.map((e,i)=>(
                <tr key={i} style={{background:i%2===0?"transparent":"var(--color-background-secondary)"}}>
                  <td style={{...C.td,color:EXT_COLOR,fontWeight:500}}>{e.id}</td>
                  <td style={C.td}>D{e.arrDay}</td>
                  <td style={C.td}>{e.berthIdx===0?"Port-II":"Port-V"}</td>
                  <td style={C.td}>D{e.startDay}</td>
                  <td style={C.td}>D{e.endDay}</td>
                  <td style={{...C.td,color:e.startDay>e.arrDay?"var(--color-text-warning)":"inherit"}}>{e.endDay-e.startDay}hr {e.startDay>e.arrDay?`(+${e.startDay-e.arrDay}h antri)`:""}</td>
                  <td style={C.td}>{e.cap.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
