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

const INIT_CURRENT_STATES = INIT_SHIPS.map(sh => ({
  shipId: sh.id,
  status: "idle",      // idle, waiting, loading, sailing_out, unloading, sailing_back
  startDay: 0,
  endDay: 0,
  location: "palembang", // palembang, semarang, cilacap, gresik, sea
}));

// ═══════════════════════════════════════════════════════════════
// SIMULATION ENGINE
// ═══════════════════════════════════════════════════════════════
function simulate(cfg, ships, simMode, currentDay, currentStates) {
  let seed = cfg.seed;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };
  const ri  = (a, b) => a + Math.floor(rng() * (b - a + 1));

  // Total simulation days = currentDay + forward simulation days
  const totalSimDays = currentDay + cfg.simDays;

  // ── Production downtime periods ──
  const genDowntimes = (perMonth, dMin, dMax) => {
    const dts = [];
    let dd = 0;
    while (dd < totalSimDays) {
      if (perMonth > 0 && rng() * 30 < perMonth) {
        const dur = ri(dMin, dMax);
        dts.push({ start: dd, end: Math.min(dd + dur, totalSimDays) });
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

  // ── Berth allocators ──
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

  const gcOriginA    = makeAlloc(cfg.gcBerths);
  const tankerOriginA = makeAlloc(cfg.tankerBerths);
  const semA         = makeAlloc(cfg.semBerths);
  const cilA         = makeAlloc(cfg.cilBerths);
  const grsA         = makeAlloc(cfg.grsBerths);
  const destMap      = { semarang: semA, cilacap: cilA, gresik: grsA };

  // ── Routing decision ──
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

  // ── External ships (only for forward simulation) ──
  const extArr = [];
  const startGenExt = simMode === "current" ? currentDay : 0;
  for (let m = Math.floor(startGenExt / 30); m < Math.ceil(totalSimDays / 30); m++) {
    const n = ri(Math.max(0, Math.floor(cfg.extPerMonth) - 1), Math.ceil(cfg.extPerMonth) + 1);
    for (let i = 0; i < n; i++) {
      const day = m * 30 + ri(0, 27);
      if (day >= startGenExt && day < totalSimDays) {
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

  // ── Owned ships ──
  const routingLog = [];
  const activeShips = ships.filter(s => s.active);

  const shipResults = activeShips.map((ship, idx) => {
    const events = [];
    const sums = Object.fromEntries(Object.keys(STATES).map(k => [k, 0]));
    const originPort = ship.type === "gc" ? gcOriginA : tankerOriginA;
    const portType = ship.type === "gc" ? "gc" : "tanker";

    let day = 0;
    let voyages = 0;

    // ── CURRENT STATE MODE: Pre-populate current activity ──
    if (simMode === "current") {
      const currState = currentStates.find(cs => cs.shipId === ship.id);
      if (currState && currState.status !== "idle" && currState.endDay > 0) {
        // Add current in-progress event
        events.push({
          type: currState.status,
          start: currState.startDay,
          end: currState.endDay,
          inProgress: true, // mark as ongoing
        });
        sums[currState.status] += currState.endDay - currState.startDay;

        // Block the berth if currently loading
        if (currState.status === "loading" || currState.status === "waiting" || currState.status === "prod_wait") {
          const { slot } = originPort.alloc(currState.startDay, currState.endDay - currState.startDay);
          slot.shipId = ship.id;
          slot.portType = portType;
          slot.end = currState.endDay;
        }

        // Start scheduling from when current activity finishes
        day = currState.endDay;
      } else {
        // Ship is idle, start from currentDay with stagger
        day = currentDay + idx * cfg.stagger;
      }
    } else {
      // Fresh start mode: stagger from day 0
      day = idx * cfg.stagger;
    }

    // ── MAIN SCHEDULING LOOP ──
    while (day < totalSimDays) {
      // Load duration
      let lMin, lMax;
      if (ship.type === "gc") {
        [lMin, lMax] = ship.cap <= 7000 ? [cfg.gcSmMin, cfg.gcSmMax] : [cfg.gcLgMin, cfg.gcLgMax];
      } else {
        const b = ship.cap / cfg.loadRate;
        [lMin, lMax] = [Math.max(2, Math.floor(b)), Math.ceil(b) + 1];
      }
      const nomLoad = ri(lMin, lMax);

      // Acquire berth
      const { startDay, slot } = originPort.alloc(day, nomLoad);
      slot.shipId = ship.id;
      slot.portType = portType;

      if (startDay > day) {
        events.push({ type:"waiting", start:day, end:startDay });
        sums.waiting += startDay - day;
      }

      // Loading + production downtime
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
    sums.idle = Math.max(0, totalSimDays - covered);
    const prod = sums.loading + sums.sailing_out + sums.unloading + sums.sailing_back;

    return { ...ship, events, voyages, sums, util: prod / totalSimDays,
      nonProd: sums.idle + sums.waiting + sums.anchoring + sums.prod_wait };
  });

  return {
    ships: shipResults, extEvents, gcDowntimes, tankerDowntimes, routingLog,
    gcOriginBSlots: gcOriginA.bSlots,
    tankerOriginBSlots: tankerOriginA.bSlots,
    semBSlots: semA.bSlots, cilBSlots: cilA.bSlots, grsBSlots: grsA.bSlots,
    totalSimDays,
    currentDay,
    metrics: {
      avgUtil:      shipResults.reduce((s,r)=>s+r.util,0)/shipResults.length,
      totalNonProd: shipResults.reduce((s,r)=>s+r.nonProd,0),
      totalVoyages: shipResults.reduce((s,r)=>s+r.voyages,0),
      totalCargo:   shipResults.reduce((s,r)=>s+r.voyages*r.cap,0),
      gcDownDays:   gcDowntimes.reduce((s,dt)=>s+(dt.end-dt.start),0),
      tankerDownDays: tankerDowntimes.reduce((s,dt)=>s+(dt.end-dt.start),0),
      totalAnchor:  shipResults.reduce((s,r)=>s+(r.sums.anchoring||0),0),
      rerouted:     routingLog.filter(r=>r.changed).length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// GANTT COMPONENTS
// ═══════════════════════════════════════════════════════════════
function JourneyGantt({ ships, simDays, currentDay }) {
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
        {/* Current day marker */}
        {currentDay > 0 && currentDay < simDays && (
          <g>
            <line x1={LW+currentDay*DW} y1={22} x2={LW+currentDay*DW} y2={H} stroke="#f59e0b" strokeWidth={2} opacity={0.7}/>
            <text x={LW+currentDay*DW} y={10} textAnchor="middle" fontSize={10} fill="#f59e0b" fontWeight="600">HARI INI</text>
          </g>
        )}
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
                const isInProgress = e.inProgress && currentDay >= e.start && currentDay < e.end;
                return (
                  <g key={ei}>
                    <rect x={x} y={y+5} width={w} height={RH-10} fill={STATES[e.type]?.color||"#888"} rx={2} 
                      opacity={isInProgress ? 1 : 0.88}
                      stroke={isInProgress ? "#f59e0b" : "none"}
                      strokeWidth={isInProgress ? 2 : 0}/>
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

function PortGantt({ bSlots, prodDowntimes=[], simDays, berthNames=[], title="", currentDay=0 }) {
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
          {currentDay > 0 && (
            <g>
              <line x1={LW+currentDay*DW} y1={22} x2={LW+currentDay*DW} y2={H} stroke="#f59e0b" strokeWidth={2} opacity={0.7}/>
              <text x={LW+currentDay*DW} y={10} textAnchor="middle" fontSize={9} fill="#f59e0b" fontWeight="600">TODAY</text>
            </g>
          )}
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
                  const isActive = currentDay >= slot.start && currentDay < slot.end;
                  return (
                    <g key={si}>
                      <rect x={x} y={y+5} width={w} height={RH-10} fill={color} rx={2} opacity={isActive ? 1 : 0.88}
                        stroke={isActive ? "#f59e0b" : "none"} strokeWidth={isActive ? 2 : 0}/>
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
// STYLES
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
    downPerMonth:1.5, downMin:1, downMax:3,
    tankerDownPerMonth:1.0, tankerDownMin:1, tankerDownMax:2,
    semBerths:2, cilBerths:2, grsBerths:2,
    anchorThr:2,
    seed:42,
  });
  const [ships, setShips] = useState(INIT_SHIPS);
  const [simulationMode, setSimulationMode] = useState("fresh"); // "fresh" or "current"
  const [currentDay, setCurrentDay] = useState(0);
  const [currentStates, setCurrentStates] = useState(INIT_CURRENT_STATES);
  const [showCurrentStatePanel, setShowCurrentStatePanel] = useState(false);
  
  const [result, setResult] = useState(null);
  const [tab, setTab] = useState("gantt");
  const [optCurve, setOpt] = useState(null);
  const [busy, setBusy] = useState(false);

  const upd = (k,v) => setCfg(c=>({...c,[k]:v}));
  const updShip = (i,k,v) => setShips(s=>s.map((sh,j)=>j===i?{...sh,[k]:v}:sh));
  const updCurrentState = (shipId, k, v) => setCurrentStates(cs=>cs.map(c=>c.shipId===shipId?{...c,[k]:v}:c));

  const run = () => { 
    setBusy(true); 
    setTimeout(()=>{ 
      setResult(simulate(cfg, ships, simulationMode, currentDay, currentStates)); 
      setBusy(false); 
    },50); 
  };

  const autoOpt = () => {
    setBusy(true);
    setTimeout(()=>{
      let best={stagger:1,idle:Infinity}; const pts=[];
      for(let s=1;s<=15;s++){
        const r=simulate({...cfg,stagger:s,seed:42},ships,simulationMode,currentDay,currentStates);
        pts.push({stagger:s,nonProd:Math.round(r.metrics.totalNonProd),util:Math.round(r.metrics.avgUtil*100)});
        if(r.metrics.totalNonProd<best.idle) best={stagger:s,idle:r.metrics.totalNonProd};
      }
      setCfg(c=>({...c,stagger:best.stagger}));
      setOpt({...best,pts});
      setResult(simulate({...cfg,stagger:best.stagger,seed:42},ships,simulationMode,currentDay,currentStates));
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
    ["overview","Overview"],["optimize","Kurva Optimasi"],
  ];

  return (
    <div style={{display:"flex",height:"100vh",fontFamily:"var(--font-sans)",fontSize:13}}>
      {/* SIDEBAR */}
      <div style={{width:262,minWidth:262,borderRight:"0.5px solid var(--color-border-tertiary)",overflowY:"auto",padding:12,background:"var(--color-background-secondary)"}}>
        
        {/* MODE SELECTOR */}
        <div style={{border:"0.5px solid var(--color-border-warning)",borderRadius:8,padding:10,marginBottom:12,background:"var(--color-background-warning)"}}>
          <div style={{...C.sec,color:"var(--color-text-warning)",borderColor:"var(--color-border-warning)",marginBottom:6}}>📍 Mode Simulasi</div>
          <select value={simulationMode} style={{width:"100%",padding:"6px",borderRadius:4,marginBottom:6,fontSize:12}} onChange={e=>setSimulationMode(e.target.value)}>
            <option value="fresh">🆕 Fresh Start (dari nol)</option>
            <option value="current">⏱ Dari Kondisi Saat Ini</option>
          </select>
          
          {simulationMode==="current"&&(
            <>
              <div style={{marginBottom:6}}>
                <span style={C.lbl}>Hari ini = Hari ke-</span>
                <input type="number" min={0} max={365} value={currentDay} style={{width:"100%",fontFamily:"var(--font-mono)",fontSize:12}} onChange={e=>setCurrentDay(+e.target.value)}/>
              </div>
              <button style={{width:"100%",padding:"6px",borderRadius:4,background:"var(--color-background-primary)",border:"0.5px solid var(--color-border-tertiary)",fontSize:11,cursor:"pointer"}}
                onClick={()=>setShowCurrentStatePanel(!showCurrentStatePanel)}>
                {showCurrentStatePanel?"✕ Tutup":"⚙️ Atur Posisi Kapal Saat Ini"}
              </button>
              
              {showCurrentStatePanel&&(
                <div style={{marginTop:8,maxHeight:300,overflowY:"auto",border:"0.5px solid var(--color-border-tertiary)",borderRadius:6,padding:8,background:"var(--color-background-primary)"}}>
                  {ships.filter(s=>s.active).map(ship=>{
                    const cs = currentStates.find(c=>c.shipId===ship.id);
                    return (
                      <div key={ship.id} style={{marginBottom:10,padding:6,border:"0.5px solid var(--color-border-secondary)",borderRadius:4,background:"var(--color-background-secondary)"}}>
                        <div style={{fontSize:10,fontWeight:500,marginBottom:4,color:SHIP_COLORS[ship.id]}}>{ship.id}</div>
                        <select value={cs.status} style={{width:"100%",fontSize:10,marginBottom:3}} onChange={e=>updCurrentState(ship.id,"status",e.target.value)}>
                          <option value="idle">Idle (tidak aktif)</option>
                          <option value="waiting">Antri di dermaga</option>
                          <option value="loading">Sedang muat</option>
                          <option value="sailing_out">Sedang layar ke tujuan</option>
                          <option value="unloading">Sedang bongkar</option>
                          <option value="sailing_back">Sedang layar kembali</option>
                        </select>
                        {cs.status!=="idle"&&(
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:3}}>
                            <div>
                              <span style={{fontSize:9,color:"var(--color-text-tertiary)"}}>Mulai hr</span>
                              <input type="number" min={0} value={cs.startDay} style={{width:"100%",fontSize:10}} onChange={e=>updCurrentState(ship.id,"startDay",+e.target.value)}/>
                            </div>
                            <div>
                              <span style={{fontSize:9,color:"var(--color-text-tertiary)"}}>Selesai hr</span>
                              <input type="number" min={0} value={cs.endDay} style={{width:"100%",fontSize:10}} onChange={e=>updCurrentState(ship.id,"endDay",+e.target.value)}/>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>

        {/* Decision variables */}
        <div style={{border:"0.5px solid var(--color-border-info)",borderRadius:8,padding:10,marginBottom:12,background:"var(--color-background-info)"}}>
          <div style={{...C.sec,color:"var(--color-text-info)",borderColor:"var(--color-border-info)"}}>🎯 Variabel Keputusan</div>
          <Slider label="Stagger interval (hari)" k="stagger" min={1} max={15} unit=" hari"/>
          <div style={{marginBottom:9}}>
            <span style={{...C.lbl,color:"var(--color-text-info)"}}>Rute kapal (✓ = aktif)</span>
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
          <Slider label="Ambang labuh (hari tunggu)" k="anchorThr" min={0} max={10} unit=" hari"/>
        </div>

        <div style={C.sec}>⚙ Parameter Simulasi</div>
        <Slider label="Durasi simulasi" k="simDays" min={30} max={365} step={30} unit=" hari"/>
        <Slider label="Kapal luar/bulan" k="extPerMonth" min={0} max={10} step={0.5} unit=" kapal"/>

        <div style={C.sec}>🏭 Pelabuhan & Produksi</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
          <Num label="GC Berths" k="gcBerths" min={1} max={4}/>
          <Num label="Tanker Berths" k="tankerBerths" min={1} max={4}/>
        </div>
        <Num label="Rate muat (t/hari)" k="loadRate" min={500} max={5000}/>
        
        <div style={{padding:"8px",borderRadius:6,background:"var(--color-background-secondary)",marginTop:8,marginBottom:8}}>
          <div style={{fontSize:10,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:4}}>GC DOWNTIME</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
            <Num label="/bln" k="downPerMonth" min={0} max={10}/>
            <Num label="Min" k="downMin" min={1} max={30}/>
            <Num label="Max" k="downMax" min={1} max={30}/>
          </div>
        </div>

        <div style={{padding:"8px",borderRadius:6,background:"var(--color-background-secondary)",marginBottom:8}}>
          <div style={{fontSize:10,fontWeight:500,color:"var(--color-text-secondary)",marginBottom:4}}>TANKER DOWNTIME</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:4}}>
            <Num label="/bln" k="tankerDownPerMonth" min={0} max={10}/>
            <Num label="Min" k="tankerDownMin" min={1} max={30}/>
            <Num label="Max" k="tankerDownMax" min={1} max={30}/>
          </div>
        </div>

        <div style={C.sec}>🚢 Pelabuhan Tujuan</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
          <Num label="Semarang" k="semBerths" min={1} max={6}/>
          <Num label="Cilacap" k="cilBerths" min={1} max={6}/>
          <Num label="Gresik" k="grsBerths" min={1} max={6}/>
        </div>

        <div style={C.sec}>⏱ Waktu Operasional</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
          {[["gcSmMin","GC-7K Min"],["gcSmMax","GC-7K Max"],["gcLgMin","GC-11K Min"],["gcLgMax","GC-11K Max"],
            ["unloadMin","Bongkar Min"],["unloadMax","Bongkar Max"],["sailOut","Layar Brkt"],["sailBack","Layar Balik"]
          ].map(([k,l])=><Num key={k} label={l} k={k}/>)}
        </div>

        <div style={{marginTop:10}}>
          <button style={{width:"100%",padding:"9px 0",borderRadius:6,border:"none",background:"var(--color-text-primary)",color:"var(--color-background-primary)",fontSize:12,fontWeight:500,cursor:"pointer",marginBottom:6,opacity:busy?0.6:1}} onClick={run} disabled={busy}>
            {busy?"⟳ Simulasi berjalan...":"▶ Jalankan Simulasi"}
          </button>
          <button style={{width:"100%",padding:"8px 0",borderRadius:6,border:"0.5px solid var(--color-border-secondary)",background:"none",fontSize:12,fontWeight:500,cursor:"pointer",marginBottom:6,opacity:busy?0.6:1}} onClick={autoOpt} disabled={busy}>
            ✦ Cari Stagger Optimal
          </button>
          {optCurve&&<div style={{fontSize:11,padding:"8px 10px",borderRadius:6,background:"var(--color-background-success)",color:"var(--color-text-success)",border:"0.5px solid var(--color-border-success)"}}>
            ✓ Optimal: <strong>{optCurve.stagger} hari</strong> · {Math.round(optCurve.idle)} hari non-prod
          </div>}
        </div>
        <div style={{marginTop:10}}>
          <span style={C.lbl}>Random seed</span>
          <input type="number" value={cfg.seed} style={{width:"100%",fontFamily:"var(--font-mono)",fontSize:12}} onChange={e=>upd("seed",+e.target.value)}/>
        </div>
      </div>

      {/* MAIN */}
      <div style={{flex:1,overflowY:"auto",padding:16}}>
        {!result?(
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"80%",color:"var(--color-text-tertiary)",textAlign:"center",gap:12}}>
            <div style={{fontSize:48}}>⚓</div>
            <div style={{fontSize:16,fontWeight:500,color:"var(--color-text-primary)"}}>Maritime Supply Chain Optimization System</div>
            <div style={{fontSize:13,maxWidth:460,lineHeight:1.7}}>
              <strong>✨ Fitur Utama:</strong><br/>
              • Simulasi dari kondisi real-time (posisi kapal saat ini)<br/>
              • Pelabuhan terpisah untuk GC dan Tanker<br/>
              • Production downtime independent per tipe<br/>
              • Smart routing dengan labuh otomatis
            </div>
          </div>
        ):(
          <>
            <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8,marginBottom:14}}>
              <Kpi label="Avg Utilisasi" val={`${Math.round(result.metrics.avgUtil*100)}%`} sub="target >80%" color={result.metrics.avgUtil>0.75?"var(--color-text-success)":"var(--color-text-warning)"}/>
              <Kpi label="Non-Produktif" val={Math.round(result.metrics.totalNonProd)} sub="kapal-hari" color="var(--color-text-danger)"/>
              <Kpi label="Total Voyage" val={result.metrics.totalVoyages} sub={`${result.totalSimDays}h`} color="var(--color-text-info)"/>
              <Kpi label="Cargo" val={`${(result.metrics.totalCargo/1000).toFixed(0)}K`} sub="ton" color="var(--color-text-primary)"/>
              <Kpi label="GC Down" val={`${result.metrics.gcDownDays}h`} sub={`${result.gcDowntimes.length} x`} color={result.metrics.gcDownDays>0?"var(--color-text-danger)":"var(--color-text-success)"}/>
              <Kpi label="Tanker Down" val={`${result.metrics.tankerDownDays}h`} sub={`${result.tankerDowntimes.length} x`} color={result.metrics.tankerDownDays>0?"var(--color-text-danger)":"var(--color-text-success)"}/>
            </div>

            <div style={{display:"flex",borderBottom:"0.5px solid var(--color-border-tertiary)",marginBottom:14,flexWrap:"wrap"}}>
              {TABS.map(([id,label])=><button key={id} style={tabSty(tab===id)} onClick={()=>setTab(id)}>{label}</button>)}
            </div>

            {tab==="gantt"        && <GanttTab result={result} cfg={cfg}/>}
            {tab==="port-activity" && <PortActivityTab result={result} cfg={cfg}/>}
            {tab==="ships"        && <ShipsTab result={result} cfg={cfg}/>}
            {tab==="routing"      && <RoutingTab result={result}/>}
            {tab==="overview"     && <OverviewTab result={result} cfg={cfg}/>}
            {tab==="optimize"     && <OptimizeTab optCurve={optCurve}/>}
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════
function GanttTab({ result, cfg }) {
  return (
    <div style={C.card}>
      <div style={C.ct}>Jadwal Perjalanan Kapal — Timeline {result.totalSimDays} Hari {result.currentDay>0&&`(dimulai dari hari ${result.currentDay})`}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:10,marginBottom:12}}>
        {Object.entries(STATES).map(([k,v])=>(
          <div key={k} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"var(--color-text-secondary)"}}>
            <div style={{width:12,height:12,borderRadius:2,background:v.color,flexShrink:0}}/>{v.label}
          </div>
        ))}
        {result.currentDay>0&&<div style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#f59e0b",fontWeight:500}}>
          <div style={{width:12,height:12,borderRadius:2,background:"#f59e0b",flexShrink:0}}/>HARI INI (border orange = aktifitas sedang berjalan)
        </div>}
      </div>
      <JourneyGantt ships={result.ships} simDays={result.totalSimDays} currentDay={result.currentDay}/>
      <div style={{marginTop:8,fontSize:11,color:"var(--color-text-tertiary)"}}>
        Garis vertikal orange = "Hari Ini" · Border orange pada kotak = aktivitas yang sedang berjalan saat ini
      </div>
    </div>
  );
}

function PortActivityTab({ result, cfg }) {
  return (
    <div>
      <div style={C.card}>
        <div style={C.ct}>🏭 Pelabuhan GC (Port-II & Port-V Palembang)</div>
        <PortGantt bSlots={result.gcOriginBSlots} prodDowntimes={result.gcDowntimes} simDays={result.totalSimDays} currentDay={result.currentDay}
          berthNames={["Port-II (GC)","Port-V (GC)"]}/>
      </div>
      <div style={C.card}>
        <div style={C.ct}>⛽ Pelabuhan Tanker (Port-Gas-1 & Port-Gas-2)</div>
        <PortGantt bSlots={result.tankerOriginBSlots} prodDowntimes={result.tankerDowntimes} simDays={result.totalSimDays} currentDay={result.currentDay}
          berthNames={["Port-Gas-1","Port-Gas-2"]}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        {[{label:"Semarang",bSlots:result.semBSlots},{label:"Cilacap",bSlots:result.cilBSlots},{label:"Gresik",bSlots:result.grsBSlots}].map(({label,bSlots})=>(
          <div key={label} style={C.card}>
            <div style={C.ct}>{label}</div>
            <PortGantt bSlots={bSlots} simDays={result.totalSimDays} currentDay={result.currentDay} berthNames={bSlots.map((_,i)=>`B${i+1}`)}/>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShipsTab({result,cfg}){
  return(
    <div style={{...C.card,overflowX:"auto"}}>
      <div style={C.ct}>Performa Kapal ({result.totalSimDays} hari)</div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead><tr>{["Kapal","Voyage","Muat","Layar","Bongkar","Antri","PROD↓","Labuh","Idle","Util"].map(h=><th key={h} style={C.th}>{h}</th>)}</tr></thead>
        <tbody>
          {result.ships.map((sh,i)=>(
            <tr key={sh.id} style={{background:i%2===0?"transparent":"var(--color-background-secondary)"}}>
              <td style={{...C.td,color:SHIP_COLORS[sh.id],fontWeight:500}}>{sh.id}</td>
              <td style={{...C.td,color:"var(--color-text-success)",fontWeight:500}}>{sh.voyages}</td>
              <td style={C.td}>{Math.round(sh.sums.loading)}</td>
              <td style={C.td}>{Math.round((sh.sums.sailing_out||0)+(sh.sums.sailing_back||0))}</td>
              <td style={C.td}>{Math.round(sh.sums.unloading)}</td>
              <td style={{...C.td,color:sh.sums.waiting>0?"var(--color-text-danger)":"inherit"}}>{Math.round(sh.sums.waiting||0)}</td>
              <td style={{...C.td,color:sh.sums.prod_wait>0?"var(--color-text-danger)":"inherit"}}>{Math.round(sh.sums.prod_wait||0)}</td>
              <td style={{...C.td,color:sh.sums.anchoring>0?"var(--color-text-warning)":"inherit"}}>{Math.round(sh.sums.anchoring||0)}</td>
              <td style={C.td}>{Math.round(sh.sums.idle)}</td>
              <td style={{padding:"7px 8px"}}>{Math.round(sh.util*100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RoutingTab({result}){
  const log=result.routingLog;
  return(
    <div style={{...C.card,overflowX:"auto"}}>
      <div style={C.ct}>Routing Decisions ({log.length} keputusan)</div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
        <thead><tr>{["Kapal","Voy","Hari","Rute Pref","Rute Final","Tunggu Smg","Tunggu Clp","Keputusan"].map(h=><th key={h} style={C.th}>{h}</th>)}</tr></thead>
        <tbody>
          {log.map((r,i)=>(
            <tr key={i} style={{background:i%2===0?"transparent":"var(--color-background-secondary)"}}>
              <td style={{...C.td,color:SHIP_COLORS[r.ship],fontWeight:500}}>{r.ship}</td>
              <td style={C.td}>{r.voyage}</td>
              <td style={C.td}>{r.day}</td>
              <td style={C.td}>{r.route}</td>
              <td style={{...C.td,fontWeight:500}}>{r.route}</td>
              <td style={C.td}>{r.wSem!==undefined?r.wSem:"—"}</td>
              <td style={C.td}>{r.wCil!==undefined?r.wCil:"—"}</td>
              <td style={{...C.td,fontSize:10,color:r.changed?"var(--color-text-warning)":r.anchor?"#534AB7":"var(--color-text-success)"}}>{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewTab({result,cfg}){
  const barData=result.ships.map(sh=>{const d={name:sh.id};Object.keys(STATES).forEach(k=>{d[k]=Math.round(sh.sums[k]||0);});return d;});
  return(
    <div style={C.card}>
      <div style={C.ct}>Breakdown Waktu per Kapal</div>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={barData} margin={{top:0,right:8,bottom:0,left:-22}}>
          <XAxis dataKey="name" tick={{fontSize:10,fontFamily:"var(--font-mono)"}}/>
          <YAxis tick={{fontSize:10}}/>
          <Tooltip contentStyle={{fontSize:11,borderRadius:6}}/>
          <Legend formatter={v=><span style={{fontSize:10}}>{STATES[v]?.label}</span>}/>
          {Object.entries(STATES).map(([k,v])=><Bar key={k} dataKey={k} stackId="a" fill={v.color} name={k}/>)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function OptimizeTab({optCurve}){
  if(!optCurve)return(<div style={{...C.card,textAlign:"center",padding:40}}>Klik "Cari Stagger Optimal" untuk melihat kurva sensitivitas</div>);
  return(
    <div>
      <div style={{...C.card,background:"var(--color-background-success)",border:"0.5px solid var(--color-border-success)"}}>
        <div style={{display:"flex",gap:24}}>
          <div><div style={{fontSize:10,color:"var(--color-text-success)"}}>Stagger Optimal</div><div style={{fontSize:28,fontFamily:"var(--font-mono)",color:"var(--color-text-success)"}}>{optCurve.stagger} hari</div></div>
          <div><div style={{fontSize:10,color:"var(--color-text-success)"}}>Min. Non-Prod</div><div style={{fontSize:28,fontFamily:"var(--font-mono)",color:"var(--color-text-success)"}}>{Math.round(optCurve.idle)}</div></div>
        </div>
      </div>
      <div style={C.card}>
        <div style={C.ct}>Kurva Sensitivitas</div>
        <ResponsiveContainer width="100%" height={230}>
          <LineChart data={optCurve.pts} margin={{top:5,right:20,bottom:5,left:0}}>
            <XAxis dataKey="stagger" tick={{fontSize:11}}/>
            <YAxis tick={{fontSize:11}}/>
            <Tooltip contentStyle={{fontSize:11,borderRadius:6}}/>
            <Legend/>
            <Line type="monotone" dataKey="nonProd" stroke="#E24B4A" strokeWidth={2} dot={{r:4}} name="Non-Prod"/>
            <Line type="monotone" dataKey="util" stroke="#185FA5" strokeWidth={2} dot={{r:3}} name="Util %"/>
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}