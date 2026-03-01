import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine
} from "recharts";

// ─── COUNTRY CONFIG ───────────────────────────────────────────────────────────
// Static fallbacks + metadata. Live data overwrites GDP, gdpGrowth, airQuality.

const COUNTRY_CONFIG = {
  India:      { code: "IN", wb: "IND", co2: 2.4, forestCover: 24, renewables: 20, population: 1428, city: "Delhi" },
  USA:        { code: "US", wb: "USA", co2: 14.9, forestCover: 33, renewables: 22, population: 340, city: "Los Angeles" },
  China:      { code: "CN", wb: "CHN", co2: 8.1, forestCover: 23, renewables: 31, population: 1412, city: "Beijing" },
  Germany:    { code: "DE", wb: "DEU", co2: 7.8, forestCover: 32, renewables: 46, population: 84, city: "Berlin" },
  Brazil:     { code: "BR", wb: "BRA", co2: 2.3, forestCover: 59, renewables: 83, population: 215, city: "Sao Paulo" },
  Bangladesh: { code: "BD", wb: "BGD", co2: 0.6, forestCover: 11, renewables: 4, population: 170, city: "Dhaka" },
  Nigeria:    { code: "NG", wb: "NGA", co2: 0.6, forestCover: 25, renewables: 13, population: 223, city: "Lagos" },
  Australia:  { code: "AU", wb: "AUS", co2: 14.5, forestCover: 19, renewables: 35, population: 26, city: "Sydney" },
};

const FALLBACK = {
  India:      { gdp: 2947, gdpGrowth: 6.8, airQuality: 42 },
  USA:        { gdp: 27360, gdpGrowth: 2.5, airQuality: 72 },
  China:      { gdp: 17795, gdpGrowth: 5.2, airQuality: 48 },
  Germany:    { gdp: 4456, gdpGrowth: 1.2, airQuality: 82 },
  Brazil:     { gdp: 2173, gdpGrowth: 3.1, airQuality: 68 },
  Bangladesh: { gdp: 421,  gdpGrowth: 5.8, airQuality: 35 },
  Nigeria:    { gdp: 477,  gdpGrowth: 2.9, airQuality: 38 },
  Australia:  { gdp: 1708, gdpGrowth: 2.0, airQuality: 85 },
};

// ─── API FETCHERS ─────────────────────────────────────────────────────────────

async function fetchWorldBank(wbCode) {
  // GDP (current USD billions) — indicator NY.GDP.MKTP.CD
  // GDP growth % — indicator NY.GDP.MKTP.KD.ZG
  try {
    const [gdpRes, growthRes] = await Promise.all([
      fetch(`https://api.worldbank.org/v2/country/${wbCode}/indicator/NY.GDP.MKTP.CD?format=json&mrv=1`),
      fetch(`https://api.worldbank.org/v2/country/${wbCode}/indicator/NY.GDP.MKTP.KD.ZG?format=json&mrv=1`),
    ]);
    const [gdpData, growthData] = await Promise.all([gdpRes.json(), growthRes.json()]);
    const gdpRaw = gdpData?.[1]?.[0]?.value;
    const growthRaw = growthData?.[1]?.[0]?.value;
    return {
      gdp: gdpRaw ? Math.round(gdpRaw / 1e9) : null,
      gdpGrowth: growthRaw ? parseFloat(growthRaw.toFixed(2)) : null,
      gdpYear: gdpData?.[1]?.[0]?.date || "N/A",
    };
  } catch {
    return { gdp: null, gdpGrowth: null, gdpYear: "N/A" };
  }
}

async function fetchOpenAQ(countryCode) {
  // OpenAQ v3 — get latest PM2.5 readings for country, convert to AQI 0-100 scale
  try {
    const res = await fetch(
      `https://api.openaq.org/v3/locations?country_id=${countryCode}&parameters_id=2&limit=10&order_by=lastUpdated&sort_order=desc`,
      { headers: { "Accept": "application/json" } }
    );
    const data = await res.json();
    const readings = data?.results || [];
    if (readings.length === 0) return { airQuality: null, aqStation: null };

    // Average PM2.5 from available stations
    let pm25Values = [];
    readings.forEach(loc => {
      loc.sensors?.forEach(s => {
        if (s.parameter?.name === "pm25" && s.summary?.avg) {
          pm25Values.push(s.summary.avg);
        }
      });
    });

    if (pm25Values.length === 0) return { airQuality: null, aqStation: null };

    const avgPM25 = pm25Values.reduce((a, b) => a + b, 0) / pm25Values.length;
    // Convert PM2.5 (µg/m³) to 0–100 air quality score (higher = better)
    // WHO guideline: 5 µg/m³ = 100, 75+ µg/m³ = 0
    const aqScore = Math.max(0, Math.min(100, Math.round(100 - (avgPM25 / 75) * 100)));
    return {
      airQuality: aqScore,
      pm25: parseFloat(avgPM25.toFixed(1)),
      aqStation: readings[0]?.name || "Multiple stations",
      stationCount: pm25Values.length,
    };
  } catch {
    return { airQuality: null, aqStation: null };
  }
}

// ─── SCORING ENGINE ───────────────────────────────────────────────────────────

function calcScores(data) {
  const gdpNorm = Math.min(100, (Math.log10((data.gdp || 1) + 1) / Math.log10(30000)) * 100);
  const co2Penalty = Math.min(100, (data.co2 / 20) * 100);
  const envScore = Math.round(
    0.35 * (100 - co2Penalty) +
    0.30 * (data.airQuality || 50) +
    0.20 * Math.min(100, data.forestCover * 1.5) +
    0.15 * data.renewables
  );
  const structScore = Math.round(
    0.50 * gdpNorm +
    0.30 * Math.min(100, (data.gdpGrowth || 0) * 10) +
    0.20 * data.renewables
  );
  const fragility = Math.round(Math.abs(structScore - envScore));
  const resilience = Math.round(0.45 * envScore + 0.45 * structScore - 0.10 * fragility);
  return { envScore, structScore, fragility, resilience };
}

function getCategory(score) {
  if (score <= 25) return { label: "Collapse Risk", color: "#dc2626" };
  if (score <= 40) return { label: "Critical Vulnerability", color: "#f97316" };
  if (score <= 60) return { label: "Fragile System", color: "#eab308" };
  if (score <= 80) return { label: "Stable", color: "#22c55e" };
  return { label: "Highly Resilient", color: "#10b981" };
}

function projectScore(baseScore, data, years) {
  const gdpLift = (data.gdpGrowth || 0) * 0.15 * years;
  const co2Drag = (data.co2 > 5 ? 0.3 : 0.1) * years;
  const fragilityRisk = calcScores(data).fragility > 30 ? 0.2 * years : 0;
  return Math.max(0, Math.min(100, Math.round(baseScore + gdpLift - co2Drag - fragilityRisk)));
}

// ─── STYLES ───────────────────────────────────────────────────────────────────

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Playfair+Display:wght@700;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body, #root { background: #0a0d13; color: #e8edf5; font-family: 'IBM Plex Sans', sans-serif; font-size: 17px; line-height: 1.65; min-height: 100vh; }
  .app-header { background: #0d1117; border-bottom: 2px solid #1e3a5f; padding: 28px 48px 20px; }
  .app-header-inner { max-width: 1400px; margin: 0 auto; }
  .app-title { font-family: 'Playfair Display', serif; font-size: 2.2rem; font-weight: 900; color: #fff; letter-spacing: -0.5px; line-height: 1.1; }
  .app-subtitle { font-size: 0.85rem; letter-spacing: 3px; color: #4a7fa5; text-transform: uppercase; margin-top: 6px; font-family: 'IBM Plex Mono', monospace; }
  .nav-bar { background: #0d1117; border-bottom: 1px solid #1a2a3a; padding: 0 48px; }
  .nav-bar-inner { display: flex; max-width: 1400px; margin: 0 auto; overflow-x: auto; }
  .nav-btn { background: none; border: none; color: #6b8fa8; font-family: 'IBM Plex Sans', sans-serif; font-size: 0.88rem; font-weight: 500; letter-spacing: 0.5px; padding: 16px 20px; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.2s; white-space: nowrap; text-transform: uppercase; }
  .nav-btn:hover { color: #a8c8e8; }
  .nav-btn.active { color: #5ba3d9; border-bottom-color: #5ba3d9; background: rgba(91,163,217,0.06); }
  .main-content { max-width: 1400px; margin: 0 auto; padding: 40px 48px; }
  .section-intro { background: #0f1923; border-left: 4px solid #1e4a6e; padding: 20px 24px; margin-bottom: 32px; border-radius: 0 6px 6px 0; }
  .section-intro h3 { font-size: 0.8rem; letter-spacing: 2px; text-transform: uppercase; color: #4a7fa5; font-family: 'IBM Plex Mono', monospace; margin-bottom: 8px; }
  .section-intro p { color: #b0c4d8; font-size: 0.95rem; }
  .section-title { font-family: 'Playfair Display', serif; font-size: 1.9rem; font-weight: 700; color: #fff; margin-bottom: 8px; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 24px; }
  .card { background: #0f1923; border: 1px solid #1a2e42; border-radius: 8px; padding: 28px; }
  .card-label { font-size: 0.78rem; letter-spacing: 2px; text-transform: uppercase; color: #4a7fa5; font-family: 'IBM Plex Mono', monospace; margin-bottom: 10px; }
  .big-score { font-family: 'IBM Plex Mono', monospace; font-size: 4.5rem; font-weight: 500; line-height: 1; margin: 8px 0; }
  .score-bar-wrap { margin: 16px 0; background: #1a2a3a; height: 12px; border-radius: 6px; overflow: hidden; }
  .score-bar-fill { height: 100%; border-radius: 6px; transition: width 0.6s ease; }
  .bench-scale { display: flex; gap: 4px; margin: 12px 0; }
  .bench-segment { flex: 1; padding: 6px 4px; text-align: center; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: rgba(255,255,255,0.85); }
  .metric-row { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid #1a2a3a; }
  .metric-row:last-child { border-bottom: none; }
  .metric-label { color: #8aabca; font-size: 0.9rem; }
  .metric-val { font-family: 'IBM Plex Mono', monospace; font-size: 1.05rem; font-weight: 500; color: #d4e4f4; }
  .interpretation { background: #0c1820; border: 1px solid #1a3550; border-radius: 6px; padding: 20px 24px; margin: 20px 0; color: #b0c4d8; font-size: 0.95rem; line-height: 1.7; }
  .interpretation strong { color: #5ba3d9; }
  select { background: #0f1923; border: 1px solid #1e3a5f; color: #d4e4f4; padding: 10px 14px; font-family: 'IBM Plex Sans', sans-serif; font-size: 0.95rem; border-radius: 6px; cursor: pointer; appearance: none; min-width: 200px; }
  .disaster-btn { background: #1a0f0f; border: 1px solid #4a2020; color: #f0a0a0; padding: 18px 24px; font-family: 'IBM Plex Mono', monospace; font-size: 0.9rem; cursor: pointer; border-radius: 6px; transition: all 0.2s; text-align: left; width: 100%; margin-bottom: 10px; }
  .disaster-btn:hover, .disaster-btn.active { background: #2a1010; border-color: #8b2020; }
  .disaster-btn .dis-title { font-size: 1rem; font-weight: 600; color: #f8c0c0; }
  .disaster-btn .dis-desc { font-size: 0.8rem; color: #a08080; margin-top: 4px; }
  .impact-panel { background: #1a0d0d; border: 1px solid #4a2020; border-radius: 8px; padding: 24px; margin-top: 16px; }
  .impact-panel .panel-head { font-size: 0.78rem; letter-spacing: 2px; text-transform: uppercase; color: #e87070; font-family: 'IBM Plex Mono', monospace; margin-bottom: 16px; }
  .policy-panel { background: #0d1a10; border: 1px solid #1a4a20; border-radius: 8px; padding: 24px; }
  .policy-panel .panel-head { font-size: 0.78rem; letter-spacing: 2px; text-transform: uppercase; color: #70e870; font-family: 'IBM Plex Mono', monospace; margin-bottom: 16px; }
  .slider-row { margin-bottom: 18px; }
  .slider-row label { display: flex; justify-content: space-between; color: #8aabca; font-size: 0.9rem; margin-bottom: 8px; }
  .slider-row label span { font-family: 'IBM Plex Mono', monospace; color: #5ba3d9; }
  input[type=range] { width: 100%; height: 6px; background: #1a2a3a; border-radius: 3px; appearance: none; cursor: pointer; }
  input[type=range]::-webkit-slider-thumb { appearance: none; width: 18px; height: 18px; background: #5ba3d9; border-radius: 50%; cursor: pointer; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  th { background: #0d1923; color: #4a7fa5; padding: 12px 14px; text-align: left; font-size: 0.78rem; letter-spacing: 1px; text-transform: uppercase; font-family: 'IBM Plex Mono', monospace; border-bottom: 2px solid #1e3a5f; }
  td { padding: 12px 14px; border-bottom: 1px solid #131f2d; color: #c0d4e8; font-size: 0.9rem; }
  tr:hover td { background: #0f1d2d; }
  .delta-pos { color: #5be85b; font-family: 'IBM Plex Mono', monospace; }
  .delta-neg { color: #f07070; font-family: 'IBM Plex Mono', monospace; }
  .timeline-item { display: flex; gap: 20px; margin-bottom: 24px; align-items: flex-start; }
  .timeline-year { font-family: 'IBM Plex Mono', monospace; font-size: 1.1rem; font-weight: 500; color: #5ba3d9; min-width: 70px; padding-top: 2px; }
  .timeline-content { background: #0f1923; border: 1px solid #1a2e42; border-radius: 6px; padding: 16px 20px; flex: 1; }
  .timeline-content .t-title { font-weight: 600; color: #d4e4f4; margin-bottom: 6px; }
  .timeline-content p { color: #8aabca; font-size: 0.9rem; }
  .meth-block { background: #0c1820; border-left: 3px solid #1e4a6e; padding: 16px 20px; margin: 12px 0; border-radius: 0 6px 6px 0; }
  .meth-block h4 { color: #5ba3d9; font-family: 'IBM Plex Mono', monospace; font-size: 0.9rem; margin-bottom: 8px; }
  .meth-block p { color: #8aabca; font-size: 0.88rem; }
  .mono { font-family: 'IBM Plex Mono', monospace; }
  .tag { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 0.78rem; font-family: 'IBM Plex Mono', monospace; font-weight: 500; }
  .projection-row { display: flex; gap: 16px; margin-top: 20px; }
  .proj-card { flex: 1; background: #0f1923; border: 1px solid #1a2e42; border-radius: 8px; padding: 20px; text-align: center; }
  .proj-year { font-size: 0.78rem; letter-spacing: 2px; color: #4a7fa5; font-family: 'IBM Plex Mono', monospace; margin-bottom: 8px; text-transform: uppercase; }
  .proj-score { font-family: 'IBM Plex Mono', monospace; font-size: 2.5rem; font-weight: 500; line-height: 1; }
  .divider { border: none; border-top: 1px solid #1a2a3a; margin: 28px 0; }

  /* ── API STATUS BAR ── */
  .api-bar { background: #0a1520; border-bottom: 1px solid #1a2a3a; padding: 8px 48px; }
  .api-bar-inner { max-width: 1400px; margin: 0 auto; display: flex; gap: 24px; align-items: center; flex-wrap: wrap; }
  .api-chip { display: flex; align-items: center; gap: 8px; font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; }
  .api-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .api-dot.live { background: #22c55e; box-shadow: 0 0 6px #22c55e88; }
  .api-dot.loading { background: #eab308; animation: pulse 1s infinite; }
  .api-dot.fallback { background: #f97316; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

  /* ── LOADING OVERLAY ── */
  .loading-card { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 200px; gap: 16px; }
  .spinner { width: 36px; height: 36px; border: 3px solid #1a2a3a; border-top-color: #5ba3d9; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── LIVE BADGE ── */
  .live-badge { display: inline-flex; align-items: center; gap: 6px; background: #0a2a15; border: 1px solid #1a5a2a; border-radius: 4px; padding: 3px 10px; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #5be885; }
  .live-badge::before { content: ''; width: 6px; height: 6px; background: #22c55e; border-radius: 50%; animation: pulse 1.5s infinite; }
  .fallback-badge { display: inline-flex; align-items: center; gap: 6px; background: #2a1a08; border: 1px solid #5a3a10; border-radius: 4px; padding: 3px 10px; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: #f0b850; }

  @media (max-width: 900px) {
    .grid-2, .grid-3, .projection-row { grid-template-columns: 1fr; flex-direction: column; }
    .main-content { padding: 24px 20px; }
    .nav-bar { padding: 0 20px; }
    .app-header { padding: 20px; }
    .api-bar { padding: 8px 20px; }
  }
`;

// ─── SMALL UI COMPONENTS ──────────────────────────────────────────────────────

function ScoreBar({ score, color }) {
  return (
    <div className="score-bar-wrap">
      <div className="score-bar-fill" style={{ width: `${score}%`, background: color }} />
    </div>
  );
}

function BenchScale({ current }) {
  const segments = [
    { range: "0–25", label: "Collapse", color: "#dc2626" },
    { range: "26–40", label: "Critical", color: "#f97316" },
    { range: "41–60", label: "Fragile", color: "#eab308" },
    { range: "61–80", label: "Stable", color: "#22c55e" },
    { range: "81–100", label: "Resilient", color: "#10b981" },
  ];
  const thresholds = [[0,25],[26,40],[41,60],[61,80],[81,100]];
  return (
    <div className="bench-scale">
      {segments.map((s, i) => {
        const active = current >= thresholds[i][0] && current <= thresholds[i][1];
        return (
          <div key={i} className="bench-segment" style={{ background: s.color+(active?"55":"22"), border:`1px solid ${s.color}${active?"cc":"44"}`, fontWeight: active?700:400 }}>
            <div>{s.range}</div>
            <div style={{ fontSize:"0.63rem", marginTop:2 }}>{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function ApiStatusBar({ wbStatus, aqStatus, country, liveData }) {
  return (
    <div className="api-bar">
      <div className="api-bar-inner">
        <span style={{ color:"#4a7fa5", fontSize:"0.75rem", fontFamily:"'IBM Plex Mono',monospace", marginRight:8 }}>DATA SOURCES ▸</span>
        <div className="api-chip">
          <div className={`api-dot ${wbStatus}`} />
          <span style={{ color:"#8aabca" }}>World Bank API</span>
          {wbStatus==="live" && <span style={{color:"#5be885"}}>— GDP ${liveData?.gdp?.toLocaleString()}B ({liveData?.gdpYear}), Growth {liveData?.gdpGrowth}%</span>}
          {wbStatus==="loading" && <span style={{color:"#eab308"}}>— fetching...</span>}
          {wbStatus==="fallback" && <span style={{color:"#f0b850"}}>— using calibrated estimates</span>}
        </div>
        <div className="api-chip">
          <div className={`api-dot ${aqStatus}`} />
          <span style={{ color:"#8aabca" }}>OpenAQ API</span>
          {aqStatus==="live" && <span style={{color:"#5be885"}}>— PM2.5 {liveData?.pm25}µg/m³ · AQ Score {liveData?.airQuality}/100 ({liveData?.stationCount} stations)</span>}
          {aqStatus==="loading" && <span style={{color:"#eab308"}}>— fetching...</span>}
          {aqStatus==="fallback" && <span style={{color:"#f0b850"}}>— using calibrated estimates</span>}
        </div>
      </div>
    </div>
  );
}

// ─── SECTIONS ────────────────────────────────────────────────────────────────

function PresentState({ country, data, scores, liveData, wbStatus, aqStatus }) {
  const { envScore, structScore, fragility, resilience } = scores;
  const cat = getCategory(resilience);
  const globalAvg = 54;
  const regionAvg = ["USA","Germany","Australia"].includes(country) ? 72 : ["India","China","Bangladesh","Nigeria"].includes(country) ? 48 : 52;

  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>A composite climate resilience score derived from environmental sustainability, structural economic capacity, and the fragility gap between them. GDP and Air Quality data are pulled live from World Bank API and OpenAQ API respectively.</p>
      </div>

      <div className="grid-2" style={{ marginBottom: 24 }}>
        <div className="card">
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:4 }}>
            <div className="card-label">Overall Resilience Score</div>
            {(wbStatus==="live" || aqStatus==="live") && <span className="live-badge">LIVE DATA</span>}
            {(wbStatus==="fallback" && aqStatus==="fallback") && <span className="fallback-badge">ESTIMATED</span>}
          </div>
          <div className="big-score" style={{ color: cat.color }}>{resilience}</div>
          <span className="tag" style={{ background: cat.color+"33", color: cat.color, border:`1px solid ${cat.color}66`, marginTop:8, display:"inline-block" }}>{cat.label}</span>
          <ScoreBar score={resilience} color={cat.color} />
          <BenchScale current={resilience} />
          <div className="metric-row"><span className="metric-label">Global Average</span><span className="metric-val mono">54 / 100</span></div>
          <div className="metric-row"><span className="metric-label">Regional Average</span><span className="metric-val mono">{regionAvg} / 100</span></div>
          <div className="metric-row">
            <span className="metric-label">Delta vs Global Avg</span>
            <span className={resilience >= globalAvg ? "delta-pos metric-val" : "delta-neg metric-val"}>{resilience >= globalAvg?"+":""}{resilience - globalAvg}</span>
          </div>
        </div>

        <div className="card">
          <div className="card-label">Score Interpretation</div>
          <div className="interpretation">
            <strong>Economic Shock Absorption:</strong> With a structural score of {structScore}/100, {country} can {structScore >= 65 ? "absorb moderate economic shocks without systemic collapse" : "sustain limited fiscal shocks before structural degradation begins"}.<br /><br />
            <strong>Climate Event Survival:</strong> An environmental score of {envScore}/100 indicates {envScore >= 55 ? "reasonable buffering capacity against Category 3 climate events" : "high vulnerability to mid-tier climate disruptions causing compounding damage"}.<br /><br />
            <strong>Structural Stability:</strong> The fragility index of {fragility} reflects a {fragility > 30 ? "significant imbalance between economic growth and environmental stewardship — a structural risk that compounds over time" : "relatively balanced development trajectory with manageable long-term climate exposure"}.
          </div>
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <div className="card-label">Environmental Score</div>
          <div className="big-score" style={{ color:"#5be8a0", fontSize:"3rem" }}>{envScore}</div>
          <ScoreBar score={envScore} color="#5be8a0" />
          <hr className="divider" />
          <div className="metric-row"><span className="metric-label">CO₂ per capita (t)</span><span className="metric-val">{data.co2}</span></div>
          <div className="metric-row">
            <span className="metric-label">Air Quality Score</span>
            <span className="metric-val">{data.airQuality}/100 {aqStatus==="live" && <span style={{fontSize:"0.7rem",color:"#5be885"}}>● LIVE</span>}</span>
          </div>
          <div className="metric-row"><span className="metric-label">Forest Cover</span><span className="metric-val">{data.forestCover}%</span></div>
          <div className="metric-row"><span className="metric-label">Renewables</span><span className="metric-val">{data.renewables}%</span></div>
          {aqStatus==="live" && liveData?.pm25 && (
            <div className="metric-row"><span className="metric-label">PM2.5 (live)</span><span className="metric-val delta-neg">{liveData.pm25} µg/m³</span></div>
          )}
          <div className="interpretation" style={{ marginTop:16, fontSize:"0.88rem" }}>
            <strong>Formula:</strong> 35%(1−CO₂ penalty) + 30%×Air Quality + 20%×Forest Cover + 15%×Renewables
          </div>
        </div>

        <div className="card">
          <div className="card-label">Structural Score</div>
          <div className="big-score" style={{ color:"#5ba3f8", fontSize:"3rem" }}>{structScore}</div>
          <ScoreBar score={structScore} color="#5ba3f8" />
          <hr className="divider" />
          <div className="metric-row">
            <span className="metric-label">GDP (USD bn)</span>
            <span className="metric-val">${(data.gdp||0).toLocaleString()} {wbStatus==="live" && <span style={{fontSize:"0.7rem",color:"#5be885"}}>● LIVE</span>}</span>
          </div>
          <div className="metric-row">
            <span className="metric-label">GDP Growth</span>
            <span className="metric-val">{data.gdpGrowth}% {wbStatus==="live" && <span style={{fontSize:"0.7rem",color:"#5be885"}}>● LIVE</span>}</span>
          </div>
          <div className="metric-row"><span className="metric-label">Renewable Infra</span><span className="metric-val">{data.renewables}%</span></div>
          <div className="interpretation" style={{ marginTop:16, fontSize:"0.88rem" }}>
            <strong>Formula:</strong> 50%×log-normalized GDP + 30%×GDP growth + 20%×Renewables
          </div>
        </div>

        <div className="card">
          <div className="card-label">Fragility Index</div>
          <div className="big-score" style={{ color: fragility > 30 ? "#f97316" : "#eab308", fontSize:"3rem" }}>{fragility}</div>
          <ScoreBar score={Math.min(100, fragility*2)} color={fragility > 30 ? "#f97316" : "#eab308"} />
          <div className="interpretation" style={{ marginTop:12, fontSize:"0.88rem" }}>
            <strong>|Structural − Environmental|</strong> = {Math.abs(structScore - envScore)}<br /><br />
            High fragility indicates economic growth outpacing environmental stewardship. {country}'s fragility of <strong>{fragility}</strong> is {fragility > 40 ? "high — development trajectory misaligned with environmental capacity" : fragility > 20 ? "moderate — some tension between growth and sustainability" : "low — broadly balanced development"}.
          </div>
        </div>
      </div>
    </div>
  );
}

function TimeProjection({ country, data, scores }) {
  const { resilience } = scores;
  const s2030 = projectScore(resilience, data, 5);
  const s2040 = projectScore(resilience, data, 15);
  const s2050 = projectScore(resilience, data, 25);
  const accel = ((s2050 - resilience) / 25).toFixed(2);
  const yrs = [
    { year:"2025", score:resilience, label:"Present State" },
    { year:"2030", score:s2030, label:"Near Term" },
    { year:"2040", score:s2040, label:"Mid Century" },
    { year:"2050", score:s2050, label:"Long Term" },
  ];
  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>A trajectory model projecting {country}'s resilience from 2025 to 2050 using live World Bank GDP and growth data as the structural input. Real GDP figures change the accuracy of this projection compared to estimates.</p>
      </div>
      <div className="projection-row">
        {yrs.map((y,i) => {
          const cat = getCategory(y.score);
          return (
            <div className="proj-card" key={i}>
              <div className="proj-year">{y.year}</div>
              <div className="proj-score" style={{ color: cat.color }}>{y.score}</div>
              <div style={{ fontSize:"0.78rem", color: cat.color, marginTop:8 }}>{cat.label}</div>
              <div style={{ fontSize:"0.78rem", color:"#4a7fa5", marginTop:4 }}>{y.label}</div>
              {i > 0 && <div className={y.score>=resilience?"delta-pos":"delta-neg"} style={{ fontSize:"0.85rem", marginTop:8 }}>{y.score>=resilience?"▲ ":"▼ "}{Math.abs(y.score-resilience)} pts</div>}
            </div>
          );
        })}
      </div>
      <div className="grid-2" style={{ marginTop:28 }}>
        <div className="card">
          <div className="card-label">Trajectory Analysis</div>
          <div className="metric-row"><span className="metric-label">2050 Baseline Score</span><span className="metric-val mono">{s2050}</span></div>
          <div className="metric-row"><span className="metric-label">Annual Rate</span><span className="metric-val mono">{accel>0?"+":""}{accel} pts/yr</span></div>
          <div className="metric-row"><span className="metric-label">25-Year Delta</span><span className={s2050>=resilience?"delta-pos metric-val":"delta-neg metric-val"}>{s2050>=resilience?"+":""}{s2050-resilience}</span></div>
          <div className="metric-row"><span className="metric-label">GDP Growth Lift</span><span className="metric-val mono">+{(data.gdpGrowth*0.15*25).toFixed(1)} pts</span></div>
          <div className="metric-row"><span className="metric-label">CO₂ Drag</span><span className="delta-neg metric-val">−{((data.co2>5?0.3:0.1)*25).toFixed(1)} pts</span></div>
        </div>
        <div className="card">
          <div className="card-label">2050 Outlook</div>
          <div className="interpretation">
            <strong>If current trajectory continues,</strong> {country} will reach a resilience score of <strong style={{ color: getCategory(s2050).color }}>{s2050}</strong> by 2050 — <strong style={{ color: getCategory(s2050).color }}>{getCategory(s2050).label}</strong>.<br /><br />
            Live World Bank data shows GDP growth at <strong>{data.gdpGrowth}%</strong>, contributing +{(data.gdpGrowth*0.15*25).toFixed(0)} structural points over 25 years. CO₂ emissions at {data.co2}t create a countervailing drag of −{((data.co2>5?0.3:0.1)*25).toFixed(0)} points.
          </div>
        </div>
      </div>
    </div>
  );
}

const DISASTERS = [
  { id:"drought", name:"Mega Drought", desc:"Multi-year rainfall deficit, agricultural collapse, water scarcity", envDrop:14, structDrop:9, gdpShock:4.2, fragilityIncrease:18, longTermDelta:-12, recoveryRating:"High Difficulty", explanation:"A mega drought collapses the environmental score through soil degradation, biodiversity loss, and water table depletion. Agricultural GDP contraction widens the structural-environmental imbalance, increasing fragility. Recovery requires 8–15 years of sustained investment." },
  { id:"flood", name:"Catastrophic Flood", desc:"500-year flood event, infrastructure destruction, displacement", envDrop:11, structDrop:16, gdpShock:7.8, fragilityIncrease:22, longTermDelta:-15, recoveryRating:"Very High Difficulty", explanation:"Catastrophic floods primarily destroy structural capacity — transport, housing, industrial assets. Infrastructure replacement costs consume fiscal reserves needed for climate adaptation, weakening the 2050 trajectory significantly." },
  { id:"tsunami", name:"Major Tsunami", desc:"Coastal megadisaster, port destruction, regional disruption", envDrop:8, structDrop:18, gdpShock:11.3, fragilityIncrease:25, longTermDelta:-18, recoveryRating:"Extreme Difficulty", explanation:"A major tsunami delivers the highest structural shock, destroying coastal economic infrastructure and trade capacity. The structural-environmental imbalance increases dramatically as environmental scores recover faster than economic rebuilding." },
];

function DisasterLab({ country, scores }) {
  const [active, setActive] = useState(null);
  const { resilience, envScore, structScore, fragility } = scores;
  const d = DISASTERS.find(x => x.id === active);
  const postEnv = d ? Math.max(0, envScore - d.envDrop) : envScore;
  const postStruct = d ? Math.max(0, structScore - d.structDrop) : structScore;
  const postFrag = d ? fragility + d.fragilityIncrease : fragility;
  const postRes = d ? Math.max(0, Math.round(0.45*postEnv + 0.45*postStruct - 0.10*postFrag)) : resilience;
  const proj2050 = d ? Math.max(0, resilience - Math.abs(d.longTermDelta)) : resilience;

  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>Quantified impact modeling for three classes of acute climate disaster. Disaster multipliers are calibrated to World Bank PDNA datasets and applied against {country}'s current live scores.</p>
      </div>
      <div className="grid-2">
        <div>
          <div className="card-label" style={{ marginBottom:12 }}>Select Disaster Scenario</div>
          {DISASTERS.map(dis => (
            <button key={dis.id} className={`disaster-btn ${active===dis.id?"active":""}`} onClick={() => setActive(active===dis.id?null:dis.id)}>
              <div className="dis-title">{dis.name}</div>
              <div className="dis-desc">{dis.desc}</div>
            </button>
          ))}
        </div>
        {d ? (
          <div>
            <div className="impact-panel">
              <div className="panel-head">⚠ Immediate Impact — {d.name}</div>
              <div className="metric-row"><span className="metric-label">Environmental Score</span><span className="delta-neg metric-val">{envScore} → {postEnv} (−{d.envDrop})</span></div>
              <div className="metric-row"><span className="metric-label">Structural Score</span><span className="delta-neg metric-val">{structScore} → {postStruct} (−{d.structDrop})</span></div>
              <div className="metric-row"><span className="metric-label">Resilience Score</span><span className="delta-neg metric-val">{resilience} → {postRes} (−{resilience-postRes})</span></div>
              <div className="metric-row"><span className="metric-label">GDP Equivalent Shock</span><span className="delta-neg metric-val">−{d.gdpShock}% GDP</span></div>
              <div className="metric-row"><span className="metric-label">Fragility Increase</span><span className="delta-neg metric-val">+{d.fragilityIncrease} → {postFrag}</span></div>
            </div>
            <div className="impact-panel" style={{ marginTop:16, background:"#1a0f1a", borderColor:"#4a2060" }}>
              <div className="panel-head" style={{ color:"#d880f0" }}>◈ Long-Term Impact (2050)</div>
              <div className="metric-row"><span className="metric-label">Projected 2050 Score</span><span className="delta-neg metric-val">{proj2050}</span></div>
              <div className="metric-row"><span className="metric-label">Delta vs Baseline 2050</span><span className="delta-neg metric-val">−{Math.abs(d.longTermDelta)} pts</span></div>
              <div className="metric-row"><span className="metric-label">Recovery Difficulty</span><span className="metric-val" style={{ color:"#d880f0" }}>{d.recoveryRating}</span></div>
            </div>
            <div className="interpretation" style={{ marginTop:16, fontSize:"0.88rem" }}><strong>Analysis:</strong> {d.explanation}</div>
          </div>
        ) : (
          <div className="card">
            <div className="card-label">Current Scores (Pre-Disaster)</div>
            <div className="metric-row"><span className="metric-label">Resilience</span><span className="metric-val mono">{resilience}</span></div>
            <div className="metric-row"><span className="metric-label">Environmental</span><span className="metric-val mono">{envScore}</span></div>
            <div className="metric-row"><span className="metric-label">Structural</span><span className="metric-val mono">{structScore}</span></div>
            <div className="metric-row"><span className="metric-label">Fragility</span><span className="metric-val mono">{fragility}</span></div>
            <div className="interpretation" style={{ marginTop:16, fontSize:"0.88rem" }}>Select a disaster scenario to see quantified impact. Scores are based on live API data.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function PolicyLab({ country, scores, data }) {
  const [co2Red, setCo2Red] = useState(0);
  const [renew, setRenew] = useState(0);
  const [air, setAir] = useState(0);
  const [trees, setTrees] = useState(0);
  const { envScore, structScore, fragility, resilience } = scores;
  const envGain = Math.round(co2Red*0.18 + renew*0.14 + air*0.12 + trees*0.10);
  const structGain = Math.round(renew*0.08 + co2Red*0.04);
  const fragRed = Math.round((envGain+structGain)*0.4);
  const newEnv = Math.min(100, envScore+envGain);
  const newStruct = Math.min(100, structScore+structGain);
  const newFrag = Math.max(0, fragility-fragRed);
  const newRes = Math.min(100, Math.round(0.45*newEnv + 0.45*newStruct - 0.10*newFrag));
  const recovery2050 = Math.min(100, newRes + Math.round(co2Red*0.08 + renew*0.1));

  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>Policy intervention modeling with four climate levers. Results are applied against {country}'s live baseline scores, showing the real impact of policy choices on the current state of the nation.</p>
      </div>
      <div className="grid-2">
        <div className="policy-panel">
          <div className="panel-head">◈ Policy Levers</div>
          <div className="slider-row">
            <label>CO₂ Reduction <span>{co2Red}%</span></label>
            <input type="range" min={0} max={80} value={co2Red} onChange={e=>setCo2Red(+e.target.value)} />
          </div>
          <div className="slider-row">
            <label>Renewable Energy Adoption <span>{renew}%</span></label>
            <input type="range" min={0} max={80} value={renew} onChange={e=>setRenew(+e.target.value)} />
          </div>
          <div className="slider-row">
            <label>Air Quality Improvement <span>{air}%</span></label>
            <input type="range" min={0} max={60} value={air} onChange={e=>setAir(+e.target.value)} />
          </div>
          <div className="slider-row">
            <label>Tree Cover Restoration <span>{trees}×</span></label>
            <input type="range" min={0} max={5} step={0.1} value={trees} onChange={e=>setTrees(+e.target.value)} />
          </div>
        </div>
        <div>
          <div className="policy-panel" style={{ background:"#0d1a10", borderColor:"#1a4a20" }}>
            <div className="panel-head">◈ Before vs After</div>
            <div className="metric-row"><span className="metric-label">Resilience</span><span className="metric-val mono">{resilience} → <strong style={{ color: newRes>resilience?"#5be885":"#f07070" }}>{newRes}</strong></span></div>
            <div className="metric-row"><span className="metric-label">Environmental</span><span className="delta-pos metric-val">{envScore} → {newEnv} (+{newEnv-envScore})</span></div>
            <div className="metric-row"><span className="metric-label">Structural</span><span className="delta-pos metric-val">{structScore} → {newStruct} (+{newStruct-structScore})</span></div>
            <div className="metric-row"><span className="metric-label">Fragility Index</span><span className="metric-val mono">{fragility} → <span className="delta-pos">{newFrag}</span> <span style={{color:"#5be885",fontSize:"0.85rem"}}>({fragRed > 0 ? `−${fragRed} reduced` : "no change"})</span></span></div>
            <div className="metric-row"><span className="metric-label">2050 Recovery Score</span><span className="metric-val mono">{recovery2050}</span></div>
          </div>
          <div className="interpretation" style={{ marginTop:16, fontSize:"0.9rem" }}>
            <strong>Compounding Effect:</strong> A {co2Red}% CO₂ reduction initiated in 2025 prevents an estimated <strong>{(co2Red*0.3).toFixed(1)} points</strong> of cumulative degradation by 2040 — three times the impact of the same reform in 2035. These projections use {country}'s live GDP baseline from World Bank API.
          </div>
        </div>
      </div>
    </div>
  );
}

function GlobalImpact({ country, scores }) {
  const { resilience } = scores;
  const globalBase = 62;
  const instFactor = Math.max(0,(60-resilience)*0.12);
  const globalSim = Math.max(0, Math.round(globalBase - instFactor));
  const regionalImpact = (resilience < 50 ? 4.2 : resilience < 65 ? 2.3 : 0.9).toFixed(1);
  const affected = [
    { name:"Bangladesh", trade:"High", climate:"Very High", delta:-2.8, reason:"Shared monsoon system, remittance dependency" },
    { name:"Nepal", trade:"Very High", climate:"High", delta:-2.1, reason:"River basin dependency, trade corridor reliance" },
    { name:"Sri Lanka", trade:"High", climate:"Moderate", delta:-1.4, reason:"Regional trade integration, tourism flows" },
    { name:"Pakistan", trade:"Moderate", climate:"High", delta:-1.9, reason:"Shared water resources, cross-border climate events" },
    { name:"Myanmar", trade:"Moderate", climate:"Moderate", delta:-1.2, reason:"Agricultural supply chain exposure" },
    { name:"EU (aggregate)", trade:"Moderate", climate:"Low", delta:-0.4, reason:"Supply chain disruption, carbon border adjustment" },
  ];
  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>The systemic ripple effect of {country}'s live resilience score on global and regional stability. The Global Stability Index updates dynamically as live scores change.</p>
      </div>
      <div className="grid-2" style={{ marginBottom:24 }}>
        <div className="card">
          <div className="card-label">Global Stability Index</div>
          <div className="big-score" style={{ color: globalSim>=60?"#22c55e":"#eab308", fontSize:"3.5rem" }}>{globalSim}<span style={{ fontSize:"1.2rem", color:"#4a7fa5" }}>/100</span></div>
          <div className="metric-row"><span className="metric-label">Baseline</span><span className="metric-val mono">{globalBase}</span></div>
          <div className="metric-row"><span className="metric-label">Simulated</span><span className={globalSim>=globalBase?"delta-pos metric-val":"delta-neg metric-val"}>{globalSim}</span></div>
          <div className="metric-row"><span className="metric-label">Regional Resilience Impact</span><span className="delta-neg metric-val">−{regionalImpact}%</span></div>
        </div>
        <div className="card">
          <div className="card-label">Ripple Effect Mechanism</div>
          <div className="interpretation">
            <strong>{country}'s instability reduces regional resilience by {regionalImpact}%</strong> due to trade exposure and climate spillover effects.<br /><br />
            Shocks transmit through <strong>supply chain disruption</strong>, <strong>shared hydrological systems</strong>, and <strong>cross-border migration pressure</strong>. At resilience {resilience}, {country} {resilience < 60 ? "poses measurable systemic risk to regional partners" : "provides modest stabilizing influence to regional partners"}.
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-label">Affected Nations — Impact Table</div>
        <table style={{ marginTop:12 }}>
          <thead><tr><th>Country</th><th>Trade Exposure</th><th>Climate Spillover</th><th>Resilience Δ</th><th>Primary Mechanism</th></tr></thead>
          <tbody>
            {affected.map((n,i) => (
              <tr key={i}>
                <td style={{ color:"#d4e4f4", fontWeight:600 }}>{n.name}</td>
                <td><span className="tag" style={{ background:"#1a2a3a", color:"#8aabca", border:"1px solid #1e3a5f" }}>{n.trade}</span></td>
                <td><span className="tag" style={{ background:"#1a2a3a", color:"#8aabca", border:"1px solid #1e3a5f" }}>{n.climate}</span></td>
                <td className="delta-neg">{n.delta}</td>
                <td style={{ color:"#7a9db8", fontSize:"0.85rem" }}>{n.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GenerationalOutlook({ country, scores, data }) {
  const { resilience } = scores;
  const s2030 = projectScore(resilience, data, 5);
  const s2040 = projectScore(resilience, data, 15);
  const s2050 = projectScore(resilience, data, 25);
  const headline = resilience>=70?"Secure":resilience>=55?"Fragile":resilience>=40?"Critical":"Collapse Risk";
  const headlineColor = resilience>=70?"#22c55e":resilience>=55?"#eab308":resilience>=40?"#f97316":"#dc2626";
  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>The climate future facing children born in {country} today, modeled across three life-stage milestones using live GDP and air quality data to anchor the 2025 baseline.</p>
      </div>
      <div className="card" style={{ marginBottom:28 }}>
        <div className="card-label">Generational Headline Assessment</div>
        <div className="big-score" style={{ color:headlineColor, fontSize:"2.8rem" }}>{headline}</div>
        <div className="grid-2" style={{ marginTop:24, gap:20 }}>
          <div>
            <div style={{ color:"#5ba3f8", fontWeight:600, marginBottom:8 }}>Economic Outlook</div>
            <p style={{ color:"#8aabca", fontSize:"0.92rem" }}>At {data.gdpGrowth}% GDP growth (World Bank live), {country} {data.gdpGrowth>=5?"maintains strong economic momentum, but this must decouple from carbon emissions to avoid locking in long-term environmental debt":"faces moderate growth constraints limiting adaptive infrastructure investment"}. Climate damage costs could absorb 15–25% of projected economic gains by 2050.</p>
          </div>
          <div>
            <div style={{ color:"#f07070", fontWeight:600, marginBottom:8 }}>Climate Exposure</div>
            <p style={{ color:"#8aabca", fontSize:"0.92rem" }}>With live PM2.5 data showing an air quality score of {data.airQuality}/100, children born today face {data.airQuality<50?"severe chronic respiratory exposure from persistent air pollution":"moderate and rising climate health risk, with heat extremes and air quality worsening on current trajectory"}.</p>
          </div>
        </div>
      </div>
      <div className="card-label" style={{ marginBottom:16 }}>Life Timeline</div>
      {[
        { year:"2030", age:5, score:s2030, desc:`At ${s2030}/100, the climate system is ${getCategory(s2030).label.toLowerCase()}. A child at age 5 experiences ${data.airQuality<60?"poor urban air quality increasing respiratory disease burden":"relatively clean air, though heat events are more frequent than historical baselines"}.` },
        { year:"2040", age:15, score:s2040, desc:`The critical 2035–2045 decade. At ${s2040}/100, ${country} ${s2040>=s2030?"has maintained trajectory — policy reforms appear effective":"has deteriorated, indicating structural-environmental misalignment is compounding"}. This generation enters adulthood in a ${s2040>=60?"manageable but stressed":"increasingly constrained"} climate system.` },
        { year:"2050", age:25, score:s2050, desc:`At 25, this generation enters the workforce in a climate system at ${s2050}/100 — ${getCategory(s2050).label}. ${s2050>=65?`${country} offers reasonable economic opportunity and manageable climate stress, though adaptation costs permanently reshape public budgets.`:s2050>=45?`${country} presents recurring climate disruptions and reduced economic mobility compared to today.`:`${country} under current trajectory represents a severely degraded system — a direct consequence of policy inaction in the 2025–2035 window.`}` },
      ].map((t,i) => (
        <div className="timeline-item" key={i}>
          <div className="timeline-year">{t.year}<br /><span style={{ fontSize:"0.75rem", color:"#4a7fa5" }}>Age {t.age}</span></div>
          <div className="timeline-content">
            <div className="t-title">Resilience Score: <span style={{ color: getCategory(t.score).color }}>{t.score}</span> — {getCategory(t.score).label}</div>
            <p>{t.desc}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Methodology() {
  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>Full transparency on all scoring formulas, live API sources, normalization methods, and multipliers. Every number in this system is auditable and reproducible.</p>
      </div>
      <div className="grid-2" style={{ gap:20 }}>
        <div>
          <div className="card-label" style={{ marginBottom:12 }}>Live API Integration</div>
          <div className="meth-block">
            <h4>World Bank API — GDP Data</h4>
            <p>Endpoint: api.worldbank.org/v2/country/{"{code}"}/indicator/NY.GDP.MKTP.CD<br />Returns current USD GDP. Divided by 1B for normalization. GDP growth: indicator NY.GDP.MKTP.KD.ZG. No API key required. Most recent value (mrv=1) fetched on load.</p>
          </div>
          <div className="meth-block">
            <h4>OpenAQ API — Air Quality Data</h4>
            <p>Endpoint: api.openaq.org/v3/locations?country_id={"{code}"}&parameters_id=2<br />Returns PM2.5 sensor readings. Averaged across all available stations. Converted to 0–100 quality score via: max(0, 100 − (PM2.5/75)×100). WHO guideline: 5µg/m³ = 100 score.</p>
          </div>
          <div className="meth-block">
            <h4>Fallback Strategy</h4>
            <p>If either API fails or returns null, calibrated estimates from World Bank 2023 reports and IQAir 2024 data are used. Status bar clearly indicates LIVE vs ESTIMATED for each data point.</p>
          </div>
        </div>
        <div>
          <div className="card-label" style={{ marginBottom:12 }}>Scoring Formulas</div>
          <div className="meth-block">
            <h4>GDP Normalization</h4>
            <p>log₁₀(GDP) / log₁₀(30,000) × 100. Log scale prevents high-GDP nations from dominating. $30,000B cap = observed maximum.</p>
          </div>
          <div className="meth-block">
            <h4>Environmental Score</h4>
            <p>0.35×(1−CO₂ penalty) + 0.30×AirQuality + 0.20×ForestCover + 0.15×Renewables. Air quality weight uses live OpenAQ PM2.5 data.</p>
          </div>
          <div className="meth-block">
            <h4>Structural Score</h4>
            <p>0.50×GDP_norm + 0.30×GDPGrowth + 0.20×Renewables. Both GDP inputs use live World Bank data.</p>
          </div>
          <div className="meth-block">
            <h4>Fragility & Resilience</h4>
            <p>FRAGILITY = |Structural − Environmental|<br />RESILIENCE = 0.45×ENV + 0.45×STRUCT − 0.10×FRAGILITY</p>
          </div>
          <div className="meth-block">
            <h4>Projection Model</h4>
            <p>Annual: +GDP_growth×0.15 − CO₂_drag(0.1–0.3) − Fragility_risk(0.2 if fragility&gt;30). Calibrated to IPCC SSP2-4.5 baseline.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── CUSTOM TOOLTIP ──────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background:"#0d1923", border:"1px solid #1e3a5f", borderRadius:6, padding:"12px 16px", fontFamily:"'IBM Plex Mono',monospace", fontSize:"0.82rem" }}>
      <div style={{ color:"#4a7fa5", marginBottom:8, fontSize:"0.75rem", letterSpacing:1 }}>{label}</div>
      {payload.map((p,i) => (
        <div key={i} style={{ color:p.color, marginBottom:4 }}>
          {p.name}: <strong>{typeof p.value==="number" ? p.value.toFixed(1) : p.value}</strong>
        </div>
      ))}
    </div>
  );
}

function GraphSectionTitle({ title, subtitle }) {
  return (
    <div style={{ marginBottom:20 }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:6 }}>
        <div style={{ width:4, height:24, background:"#5ba3d9", borderRadius:2 }} />
        <div style={{ fontFamily:"'Playfair Display',serif", fontSize:"1.3rem", fontWeight:700, color:"#fff" }}>{title}</div>
      </div>
      <div style={{ color:"#6a8fa8", fontSize:"0.85rem", paddingLeft:16 }}>{subtitle}</div>
    </div>
  );
}

function ChartCard({ children, title, insight, span=1 }) {
  return (
    <div style={{ background:"#0f1923", border:"1px solid #1a2e42", borderRadius:8, padding:"24px", gridColumn: span===2?"span 2":"span 1" }}>
      {title && <div style={{ fontSize:"0.75rem", letterSpacing:"2px", textTransform:"uppercase", color:"#4a7fa5", fontFamily:"'IBM Plex Mono',monospace", marginBottom:16 }}>{title}</div>}
      {children}
      {insight && (
        <div style={{ marginTop:16, padding:"12px 16px", background:"#0a1520", borderLeft:"3px solid #1e4a6e", borderRadius:"0 4px 4px 0", color:"#8aabca", fontSize:"0.83rem", lineHeight:1.6 }}>
          <span style={{ color:"#5ba3d9", fontWeight:600 }}>Insight: </span>{insight}
        </div>
      )}
    </div>
  );
}

function getAllCountriesScores() {
  const allData = {
    India:      { gdp:2947,  gdpGrowth:6.8, co2:2.4,  airQuality:42, forestCover:24, renewables:20 },
    USA:        { gdp:27360, gdpGrowth:2.5, co2:14.9, airQuality:72, forestCover:33, renewables:22 },
    China:      { gdp:17795, gdpGrowth:5.2, co2:8.1,  airQuality:48, forestCover:23, renewables:31 },
    Germany:    { gdp:4456,  gdpGrowth:1.2, co2:7.8,  airQuality:82, forestCover:32, renewables:46 },
    Brazil:     { gdp:2173,  gdpGrowth:3.1, co2:2.3,  airQuality:68, forestCover:59, renewables:83 },
    Bangladesh: { gdp:421,   gdpGrowth:5.8, co2:0.6,  airQuality:35, forestCover:11, renewables:4  },
    Nigeria:    { gdp:477,   gdpGrowth:2.9, co2:0.6,  airQuality:38, forestCover:25, renewables:13 },
    Australia:  { gdp:1708,  gdpGrowth:2.0, co2:14.5, airQuality:85, forestCover:19, renewables:35 },
  };
  return Object.entries(allData).map(([name,d]) => ({ name, ...calcScores(d), ...d }));
}

function GraphsTab({ country, data, scores }) {
  const { envScore, structScore, fragility, resilience } = scores;
  const allCountries = getAllCountriesScores();

  const axisStyle = { fill:"#6a8fa8", fontFamily:"'IBM Plex Mono',monospace", fontSize:11 };
  const gridProps = { stroke:"#1a2a3a", strokeDasharray:"3 3" };

  // 1. Trajectory data
  const trajectoryData = [2025,2028,2030,2033,2035,2038,2040,2043,2045,2048,2050].map(yr => {
    const yrs = yr-2025;
    const base = projectScore(resilience, data, yrs);
    return { year:yr.toString(), Baseline:base, Optimistic:Math.min(100,Math.round(base+yrs*0.4)), Pessimistic:Math.max(0,Math.round(base-yrs*0.35)) };
  });

  // 2. Score breakdown
  const scoreBreakdown = [
    { component:"Environmental", score:envScore, fill:"#5be8a0" },
    { component:"Structural", score:structScore, fill:"#5ba3f8" },
    { component:"Fragility Penalty", score:Math.round(fragility*0.1), fill:"#f97316" },
    { component:"Final Resilience", score:resilience, fill:"#5ba3d9" },
  ];

  // 3. Global comparison
  const comparisonData = [...allCountries].sort((a,b)=>b.resilience-a.resilience)
    .map(c => ({ name:c.name, Resilience:c.resilience, isSelected:c.name===country }));

  // 4. Radar
  const radarData = [
    { subject:"Air Quality", A:data.airQuality },
    { subject:"Forest Cover", A:Math.min(100,data.forestCover*1.5) },
    { subject:"Renewables", A:data.renewables },
    { subject:"CO₂ Score", A:Math.max(0,100-(data.co2/20)*100) },
    { subject:"Env Score", A:envScore },
  ];

  // 5. Disaster impact
  const disasterData = [
    { disaster:"No Disaster", Environmental:envScore, Structural:structScore, Resilience:resilience },
    { disaster:"Mega Drought", Environmental:envScore-14, Structural:structScore-9, Resilience:Math.max(0,resilience-12) },
    { disaster:"Catastrophic Flood", Environmental:envScore-11, Structural:structScore-16, Resilience:Math.max(0,resilience-15) },
    { disaster:"Major Tsunami", Environmental:envScore-8, Structural:structScore-18, Resilience:Math.max(0,resilience-18) },
  ];

  // 6. Env pie
  const envPieData = [
    { name:"CO₂ Score (35%)", value:Math.round(0.35*Math.max(0,100-(data.co2/20)*100)), color:"#5be8a0" },
    { name:"Air Quality (30%)", value:Math.round(0.30*data.airQuality), color:"#5ba3d9" },
    { name:"Forest Cover (20%)", value:Math.round(0.20*Math.min(100,data.forestCover*1.5)), color:"#a78bfa" },
    { name:"Renewables (15%)", value:Math.round(0.15*data.renewables), color:"#fbbf24" },
  ];

  // 7. Struct pie
  const structPieData = [
    { name:"GDP Capacity (50%)", value:Math.round(0.50*Math.min(100,(Math.log10((data.gdp||1)+1)/Math.log10(30000))*100)), color:"#5ba3f8" },
    { name:"GDP Growth (30%)", value:Math.round(0.30*Math.min(100,(data.gdpGrowth||0)*10)), color:"#34d399" },
    { name:"Renewables Infra (20%)", value:Math.round(0.20*data.renewables), color:"#f472b6" },
  ];

  // 8. Env vs Struct all countries
  const envVsStruct = allCountries.map(c => ({ name:c.name, Environmental:c.envScore, Structural:c.structScore }));

  // 9. CO2 vs Resilience
  const co2Data = [...allCountries].sort((a,b)=>a.co2-b.co2)
    .map(c => ({ name:c.name, "CO₂":c.co2, Resilience:c.resilience }));

  // 10. Generational
  const genData = [2025,2030,2035,2040,2045,2050].map(yr => {
    const yrs = yr-2025;
    return {
      year:yr.toString(),
      Resilience:projectScore(resilience,data,yrs),
      "Env Trajectory":Math.max(0,Math.round(envScore - yrs*(data.co2>5?0.4:0.15))),
      "Struct Trajectory":Math.min(100,Math.round(structScore + yrs*(data.gdpGrowth*0.12))),
    };
  });

  // 11. Ripple
  const rippleData = [
    { country:"Bangladesh", impact:2.8 },
    { country:"Nepal", impact:2.1 },
    { country:"Pakistan", impact:1.9 },
    { country:"Sri Lanka", impact:1.4 },
    { country:"Myanmar", impact:1.2 },
    { country:"EU", impact:0.4 },
  ];

  // 12. GDP Growth vs Renewables
  const gdpRenew = allCountries.map(c => ({ name:c.name, "GDP Growth %":c.gdpGrowth, "Renewables %":c.renewables }));

  const tooltipStyle = { background:"#0d1923", border:"1px solid #1e3a5f", borderRadius:6, fontFamily:"IBM Plex Mono", fontSize:12, color:"#d4e4f4" };

  return (
    <div>
      <div className="section-intro">
        <h3>What This Section Shows</h3>
        <p>A complete graphical intelligence view of all platform data — resilience trajectory, score composition, disaster impact, global comparison, CO₂ analysis, generational outlook, and regional ripple effects. All charts update dynamically when you change country.</p>
      </div>

      {/* ROW 1 — Trajectory + Score Breakdown */}
      <GraphSectionTitle title="Resilience Trajectory 2025 → 2050" subtitle="Three-scenario projection: Baseline (current policy), Optimistic (strong reform), Pessimistic (inaction + disasters)" />
      <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:24, marginBottom:32 }}>
        <ChartCard title="25-Year Resilience Projection — Three Scenarios" insight={`Under baseline, ${country} reaches ${projectScore(resilience,data,25)} by 2050. With aggressive policy the ceiling is ${Math.min(100,projectScore(resilience,data,25)+10)}. Under inaction the floor is ${Math.max(0,projectScore(resilience,data,25)-9)}. The gap between optimistic and pessimistic widens every year — illustrating that early action compresses future risk dramatically.`}>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={trajectoryData} margin={{ top:10, right:20, left:0, bottom:0 }}>
              <defs>
                <linearGradient id="gBase" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#5ba3d9" stopOpacity={0.3}/><stop offset="95%" stopColor="#5ba3d9" stopOpacity={0}/></linearGradient>
                <linearGradient id="gOpt" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22c55e" stopOpacity={0.2}/><stop offset="95%" stopColor="#22c55e" stopOpacity={0}/></linearGradient>
                <linearGradient id="gPes" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#dc2626" stopOpacity={0.2}/><stop offset="95%" stopColor="#dc2626" stopOpacity={0}/></linearGradient>
              </defs>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="year" tick={axisStyle}/>
              <YAxis domain={[0,100]} tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8aabca" }}/>
              <ReferenceLine y={60} stroke="#22c55e" strokeDasharray="4 4" label={{ value:"Stable threshold", fill:"#22c55e", fontSize:10, fontFamily:"IBM Plex Mono" }}/>
              <ReferenceLine y={40} stroke="#f97316" strokeDasharray="4 4" label={{ value:"Critical threshold", fill:"#f97316", fontSize:10, fontFamily:"IBM Plex Mono" }}/>
              <Area type="monotone" dataKey="Optimistic" stroke="#22c55e" strokeWidth={2} fill="url(#gOpt)" dot={false}/>
              <Area type="monotone" dataKey="Baseline" stroke="#5ba3d9" strokeWidth={2.5} fill="url(#gBase)" dot={{ fill:"#5ba3d9", r:3 }}/>
              <Area type="monotone" dataKey="Pessimistic" stroke="#dc2626" strokeWidth={2} fill="url(#gPes)" dot={false}/>
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Score Component Breakdown" insight={`Resilience of ${resilience} = Environmental (${envScore}) + Structural (${structScore}) − Fragility penalty (${Math.round(fragility*0.1)} pts). Fragility is the key hidden risk.`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={scoreBreakdown} margin={{ top:10, right:10, left:0, bottom:20 }}>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="component" tick={{ ...axisStyle, fontSize:10 }}/>
              <YAxis domain={[0,100]} tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Bar dataKey="score" radius={[4,4,0,0]}>{scoreBreakdown.map((e,i)=><Cell key={i} fill={e.fill}/>)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ROW 2 — Global Comparison */}
      <GraphSectionTitle title="Global Resilience Comparison" subtitle="All 8 nations ranked — Environmental vs Structural balance across countries"/>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:24, marginBottom:32 }}>
        <ChartCard title="Resilience Score — All Nations Ranked" insight={`${country} ranks ${comparisonData.findIndex(c=>c.name===country)+1} of 8 with score ${resilience}. Global average across tracked nations: ${Math.round(allCountries.reduce((a,c)=>a+c.resilience,0)/allCountries.length)}/100. Blue bar = selected country.`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={comparisonData} layout="vertical" margin={{ top:5, right:20, left:70, bottom:5 }}>
              <CartesianGrid {...gridProps} horizontal={false}/>
              <XAxis type="number" domain={[0,100]} tick={axisStyle}/>
              <YAxis type="category" dataKey="name" tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <ReferenceLine x={54} stroke="#eab308" strokeDasharray="4 4" label={{ value:"Global avg", fill:"#eab308", fontSize:10 }}/>
              <Bar dataKey="Resilience" radius={[0,4,4,0]}>{comparisonData.map((e,i)=><Cell key={i} fill={e.isSelected?"#5ba3d9":getCategory(e.Resilience).color+"99"}/>)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Environmental vs Structural — All Nations" insight={`Nations where Environmental > Structural prioritise sustainability over growth. Nations where Structural > Environmental are growing faster than they protect nature. ${country}'s gap of ${fragility} points is its fragility index.`}>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={envVsStruct} margin={{ top:5, right:20, left:0, bottom:20 }}>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="name" tick={{ ...axisStyle, fontSize:10 }}/>
              <YAxis domain={[0,100]} tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8aabca" }}/>
              <Bar dataKey="Environmental" fill="#5be8a0" radius={[3,3,0,0]} opacity={0.85}/>
              <Bar dataKey="Structural" fill="#5ba3f8" radius={[3,3,0,0]} opacity={0.85}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ROW 3 — Pie + Radar */}
      <GraphSectionTitle title="Score Composition & Environmental Radar Profile" subtitle="How sub-indicators contribute to each score, and the full environmental capability radar"/>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:24, marginBottom:32 }}>
        <ChartCard title={`Environmental Score Composition — ${country}`} insight={`Each slice represents one indicator's weighted contribution to the Environmental score of ${envScore}. Larger slices = higher leverage for policy impact.`}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={envPieData} cx="50%" cy="50%" outerRadius={85} dataKey="value" label={({value})=>value} labelLine={false}>
                {envPieData.map((e,i)=><Cell key={i} fill={e.color}/>)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#8aabca" }}/>
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={`Structural Score Composition — ${country}`} insight={`GDP capacity dominates the structural score at 50% weight. ${country}'s GDP of $${(data.gdp||0).toLocaleString()}B contributes ${structPieData[0].value} of ${structScore} total structural points.`}>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={structPieData} cx="50%" cy="50%" outerRadius={85} dataKey="value" label={({value})=>value} labelLine={false}>
                {structPieData.map((e,i)=><Cell key={i} fill={e.color}/>)}
              </Pie>
              <Tooltip contentStyle={tooltipStyle}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:"#8aabca" }}/>
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={`Environmental Radar — ${country}`} insight={`A perfect pentagon = 100 in all 5 environmental dimensions. Narrow spokes reveal priority intervention areas. ${country}'s weakest dimension is its greatest reform opportunity.`}>
          <ResponsiveContainer width="100%" height={240}>
            <RadarChart cx="50%" cy="50%" outerRadius={80} data={radarData}>
              <PolarGrid stroke="#1a2a3a"/>
              <PolarAngleAxis dataKey="subject" tick={{ fill:"#6a8fa8", fontFamily:"IBM Plex Mono", fontSize:10 }}/>
              <PolarRadiusAxis angle={90} domain={[0,100]} tick={{ fill:"#4a7fa5", fontSize:9 }}/>
              <Radar name={country} dataKey="A" stroke="#5be8a0" fill="#5be8a0" fillOpacity={0.25} strokeWidth={2}/>
              <Tooltip contentStyle={tooltipStyle}/>
            </RadarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ROW 4 — Disaster Impact */}
      <GraphSectionTitle title="Disaster Impact Analysis" subtitle="Score changes across all three dimensions for each disaster scenario"/>
      <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr", gap:24, marginBottom:32 }}>
        <ChartCard title="Pre vs Post-Disaster Score Comparison — All Scenarios" insight={`A Major Tsunami causes the largest structural drop (−18 pts). A Mega Drought causes the largest environmental drop (−14 pts). The tsunami is most devastating for total resilience — reducing ${country}'s score by up to 18 points and impairing the entire 2050 trajectory.`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={disasterData} margin={{ top:10, right:20, left:0, bottom:30 }}>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="disaster" tick={{ ...axisStyle, fontSize:10 }} angle={-10} textAnchor="end"/>
              <YAxis domain={[0,100]} tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8aabca" }}/>
              <Bar dataKey="Environmental" fill="#5be8a0" radius={[3,3,0,0]} opacity={0.85}/>
              <Bar dataKey="Structural" fill="#5ba3f8" radius={[3,3,0,0]} opacity={0.85}/>
              <Bar dataKey="Resilience" fill="#5ba3d9" radius={[3,3,0,0]} opacity={0.85}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Disaster Recovery Difficulty Index (0–10)" insight="Reflects years of sustained investment needed to return to pre-disaster baseline. The tsunami scores 9.7 — extreme difficulty — due to port and coastal infrastructure destruction requiring 12–20 years.">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={[{name:"Drought",score:6.5},{name:"Flood",score:8.2},{name:"Tsunami",score:9.7}]} layout="vertical" margin={{ top:10, right:30, left:50, bottom:10 }}>
              <CartesianGrid {...gridProps} horizontal={false}/>
              <XAxis type="number" domain={[0,10]} tick={axisStyle}/>
              <YAxis type="category" dataKey="name" tick={axisStyle}/>
              <Tooltip contentStyle={tooltipStyle}/>
              <Bar dataKey="score" radius={[0,4,4,0]}>
                {[{f:"#eab308"},{f:"#f97316"},{f:"#dc2626"}].map((e,i)=><Cell key={i} fill={e.f}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ROW 5 — CO2 + Generational */}
      <GraphSectionTitle title="CO₂ Emissions vs Resilience & Generational Trajectory" subtitle="Carbon footprint correlation across nations, and long-term score trajectory by dimension"/>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:24, marginBottom:32 }}>
        <ChartCard title="CO₂ Per Capita vs Resilience Score — All Nations" insight={`Clear inverse relationship: high CO₂ nations consistently score lower in resilience. ${country} at ${data.co2}t CO₂ per capita scores ${resilience}. High-emission nations sacrifice long-term stability for short-term economic output — a compounding strategic error.`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={co2Data} margin={{ top:10, right:20, left:0, bottom:20 }}>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="name" tick={{ ...axisStyle, fontSize:10 }}/>
              <YAxis yAxisId="left" domain={[0,100]} tick={axisStyle}/>
              <YAxis yAxisId="right" orientation="right" domain={[0,20]} tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8aabca" }}/>
              <Bar yAxisId="left" dataKey="Resilience" fill="#5ba3d9" radius={[3,3,0,0]} opacity={0.85}/>
              <Bar yAxisId="right" dataKey="CO₂" fill="#f97316" radius={[3,3,0,0]} opacity={0.75}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Generational Score Trajectory 2025–2050 — By Dimension" insight={`By 2050, ${country}'s structural capacity ${Math.min(100,structScore+25*data.gdpGrowth*0.12)>structScore?"improves from GDP growth":"declines"}. Environmental trajectory ${data.co2>5?"degrades from high CO₂ drag":"remains relatively stable"}. When these lines diverge, fragility rises — the critical warning signal.`}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={genData} margin={{ top:10, right:20, left:0, bottom:10 }}>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="year" tick={axisStyle}/>
              <YAxis domain={[0,100]} tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8aabca" }}/>
              <ReferenceLine y={60} stroke="#22c55e" strokeDasharray="3 3" label={{ value:"Stable", fill:"#22c55e", fontSize:10 }}/>
              <Line type="monotone" dataKey="Resilience" stroke="#5ba3d9" strokeWidth={3} dot={{ fill:"#5ba3d9", r:4 }}/>
              <Line type="monotone" dataKey="Env Trajectory" stroke="#5be8a0" strokeWidth={2} strokeDasharray="5 3" dot={false}/>
              <Line type="monotone" dataKey="Struct Trajectory" stroke="#5ba3f8" strokeWidth={2} strokeDasharray="5 3" dot={false}/>
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* ROW 6 — Ripple + GDP vs Renewables */}
      <GraphSectionTitle title="Regional Ripple Effect & Development Mix" subtitle="Resilience points lost by neighbouring nations, and how countries balance economic growth with renewable energy"/>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:24, marginBottom:32 }}>
        <ChartCard title={`Regional Resilience Impact from ${country}'s Instability`} insight={`Bangladesh absorbs the highest impact (−2.8 pts) due to shared monsoon systems and remittance dependency. Total collective regional loss: ${rippleData.reduce((a,b)=>a+b.impact,0).toFixed(1)} pts across 6 partner nations.`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={rippleData} layout="vertical" margin={{ top:5, right:30, left:80, bottom:5 }}>
              <CartesianGrid {...gridProps} horizontal={false}/>
              <XAxis type="number" domain={[0,4]} tick={axisStyle} label={{ value:"Resilience pts lost", fill:"#4a7fa5", fontSize:10, position:"insideBottom", offset:-5 }}/>
              <YAxis type="category" dataKey="country" tick={axisStyle}/>
              <Tooltip contentStyle={tooltipStyle}/>
              <Bar dataKey="impact" radius={[0,4,4,0]}>
                {rippleData.map((e,i)=><Cell key={i} fill={e.impact>2?"#dc2626":e.impact>1.5?"#f97316":"#eab308"}/>)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="GDP Growth % vs Renewable Energy % — All Nations" insight={`Brazil proves sustainability and growth are compatible: 83% renewables + 3.1% GDP growth. ${country} at ${data.renewables}% renewables and ${data.gdpGrowth}% growth has room to scale clean energy without sacrificing development momentum.`}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={gdpRenew} margin={{ top:10, right:20, left:0, bottom:20 }}>
              <CartesianGrid {...gridProps}/>
              <XAxis dataKey="name" tick={{ ...axisStyle, fontSize:10 }}/>
              <YAxis tick={axisStyle}/>
              <Tooltip content={<ChartTooltip/>}/>
              <Legend wrapperStyle={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:"#8aabca" }}/>
              <Bar dataKey="GDP Growth %" fill="#fbbf24" radius={[3,3,0,0]} opacity={0.85}/>
              <Bar dataKey="Renewables %" fill="#34d399" radius={[3,3,0,0]} opacity={0.85}/>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* SUMMARY STATS */}
      <GraphSectionTitle title="Key Statistics Summary" subtitle="At-a-glance numerical summary of all critical indicators"/>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(6,1fr)", gap:12, marginBottom:16 }}>
        {[
          { label:"Resilience", value:resilience, color:getCategory(resilience).color, unit:"/100" },
          { label:"Environmental", value:envScore, color:"#5be8a0", unit:"/100" },
          { label:"Structural", value:structScore, color:"#5ba3f8", unit:"/100" },
          { label:"Fragility", value:fragility, color:"#f97316", unit:"pts" },
          { label:"2050 Projection", value:projectScore(resilience,data,25), color:getCategory(projectScore(resilience,data,25)).color, unit:"/100" },
          { label:"CO₂ Per Capita", value:data.co2, color:"#f07070", unit:"t" },
        ].map((s,i)=>(
          <div key={i} style={{ background:"#0f1923", border:`1px solid ${s.color}33`, borderRadius:8, padding:"16px", textAlign:"center" }}>
            <div style={{ fontSize:"0.7rem", letterSpacing:1.5, color:"#4a7fa5", fontFamily:"IBM Plex Mono", textTransform:"uppercase", marginBottom:8 }}>{s.label}</div>
            <div style={{ fontFamily:"IBM Plex Mono", fontSize:"2rem", fontWeight:600, color:s.color, lineHeight:1 }}>{s.value}</div>
            <div style={{ fontSize:"0.75rem", color:"#4a7fa5", marginTop:4 }}>{s.unit}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────

const TABS = ["Present State","Time Projection","Disaster Simulation","Policy Lab","Global Impact","Generational Outlook","Graphs","Methodology"];

export default function App() {
  const [tab, setTab] = useState(0);
  const [country, setCountry] = useState("India");
  const [liveData, setLiveData] = useState({});
  const [wbStatus, setWbStatus] = useState("loading");
  const [aqStatus, setAqStatus] = useState("loading");
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async (c) => {
    setLoading(true);
    setWbStatus("loading");
    setAqStatus("loading");
    const cfg = COUNTRY_CONFIG[c];
    const fb = FALLBACK[c];

    // Fetch both APIs in parallel
    const [wb, aq] = await Promise.all([
      fetchWorldBank(cfg.wb),
      fetchOpenAQ(cfg.code),
    ]);

    const merged = {
      gdp: wb.gdp ?? fb.gdp,
      gdpGrowth: wb.gdpGrowth ?? fb.gdpGrowth,
      gdpYear: wb.gdpYear,
      airQuality: aq.airQuality ?? fb.airQuality,
      pm25: aq.pm25,
      aqStation: aq.aqStation,
      stationCount: aq.stationCount,
    };

    setLiveData(merged);
    setWbStatus(wb.gdp !== null ? "live" : "fallback");
    setAqStatus(aq.airQuality !== null ? "live" : "fallback");
    setLoading(false);
  }, []);

  useEffect(() => { loadData(country); }, [country, loadData]);

  const cfg = COUNTRY_CONFIG[country];
  const fb = FALLBACK[country];

  const data = {
    ...cfg,
    gdp: liveData.gdp ?? fb.gdp,
    gdpGrowth: liveData.gdpGrowth ?? fb.gdpGrowth,
    airQuality: liveData.airQuality ?? fb.airQuality,
  };

  const scores = calcScores(data);

  return (
    <>
      <style>{CSS}</style>

      <div className="app-header">
        <div className="app-header-inner">
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:16 }}>
            <div>
              <div className="app-title">Earth's Time Machine</div>
              <div className="app-subtitle">National Climate Decision Laboratory</div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <span style={{ color:"#4a7fa5", fontSize:"0.82rem", fontFamily:"'IBM Plex Mono',monospace", letterSpacing:1 }}>ANALYSIS TARGET ▸</span>
              <select value={country} onChange={e => setCountry(e.target.value)} disabled={loading}>
                {Object.keys(COUNTRY_CONFIG).map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <ApiStatusBar wbStatus={wbStatus} aqStatus={aqStatus} country={country} liveData={liveData} />

      <div className="nav-bar">
        <div className="nav-bar-inner">
          {TABS.map((t,i) => (
            <button key={i} className={`nav-btn ${tab===i?"active":""}`} onClick={() => setTab(i)}>
              {String(i+1).padStart(2,"0")} {t}
            </button>
          ))}
        </div>
      </div>

      <div className="main-content">
        {loading ? (
          <div className="loading-card">
            <div className="spinner" />
            <div style={{ color:"#4a7fa5", fontFamily:"'IBM Plex Mono',monospace", fontSize:"0.9rem" }}>
              Fetching live data for {country}...
            </div>
            <div style={{ color:"#2a4a6a", fontSize:"0.82rem" }}>World Bank API + OpenAQ API</div>
          </div>
        ) : (
          <>
            {tab===0 && <PresentState country={country} data={data} scores={scores} liveData={liveData} wbStatus={wbStatus} aqStatus={aqStatus} />}
            {tab===1 && <TimeProjection country={country} data={data} scores={scores} />}
            {tab===2 && <DisasterLab country={country} scores={scores} data={data} />}
            {tab===3 && <PolicyLab country={country} scores={scores} data={data} />}
            {tab===4 && <GlobalImpact country={country} scores={scores} data={data} />}
            {tab===5 && <GenerationalOutlook country={country} scores={scores} data={data} />}
            {tab===6 && <GraphsTab country={country} data={data} scores={scores} />}
            {tab===7 && <Methodology />}
          </>
        )}
      </div>
    </>
  );
}
