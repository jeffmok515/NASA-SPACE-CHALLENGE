const CANDIDATE_SITES = [
  { name: "Shackleton Rim (Artemis III)", lat: -89.8, lon: 0.0, slope: 4.8, illum: 86.2 },
  { name: "Connecting Ridge (Artemis III)", lat: -89.4, lon: 137.4, slope: 6.1, illum: 82.5 },
  { name: "Malapert Massif (CLPS / Relay)", lat: -86.0, lon: 0.0, slope: 7.4, illum: 78.0 },
  { name: "IM-1 Odysseus / Malapert A", lat: -80.1, lon: 1.4, slope: 5.2, illum: 61.4 },
  { name: "Haworth Crater Floor (Ice PSR)", lat: -87.5, lon: -5.2, slope: 3.1, illum: 0.0 }
];

function evaluateSite(lat, lon, lunarDay = 7.4, illumPct = null, slopeDeg = null) {
  const latRad = (lat * Math.PI) / 180;
  const librationLon = 7.9 * Math.sin((2 * Math.PI * lunarDay) / 27.32);
  const librationLat = 6.7 * Math.cos((2 * Math.PI * lunarDay) / 27.21);
  const effLonRad = ((lon - librationLon) * Math.PI) / 180;
  const effLatRad = ((lat - librationLat) * Math.PI) / 180;

  const sinEarthElev = Math.cos(effLatRad) * Math.cos(effLonRad);
  const earthElevDeg = (Math.asin(Math.max(-1, Math.min(1, sinEarthElev))) * 180) / Math.PI;

  let dteStatus = "";
  let dteBadgeColor = "";
  let earthsetInfo = "";

  if (earthElevDeg > 4.5) {
    dteStatus = "CONTINUOUS DTE LOCK";
    dteBadgeColor = "#22c55e";
    earthsetInfo = "No Earthset (Permanent Near-Side View)";
  } else if (earthElevDeg >= -4.5) {
    dteStatus = "LIBRATION FRINGE (INTERMITTENT)";
    dteBadgeColor = "#f59e0b";
    const daysToEarthset = Math.max(0.5, ((earthElevDeg + 4.5) / 9.0) * 13.6).toFixed(1);
    earthsetInfo = `Est. ~${daysToEarthset} Earth days before Earthset`;
  } else {
    dteStatus = "RELAY SATELLITE REQUIRED";
    dteBadgeColor = "#ef4444";
    earthsetInfo = "Earth below horizon (Far-Side blocked)";
  }

  const sunLon = ((lunarDay / 29.53) * 360) - 180;
  const sunAlign = Math.cos(((lon - sunLon) * Math.PI) / 180);
  const p = illumPct !== null ? illumPct / 100 : Math.max(0, Math.min(1, 0.5 + 0.35 * Math.cos(latRad)));

  const maxSunAngle = 1.54 + (90 - Math.abs(lat)) * 0.85;
  const solarElevDeg = p < 0.05 ? -2.5 : Number((maxSunAngle * sunAlign * (0.4 + 0.6 * p)).toFixed(2));

  let sunsetText = "";
  if (p < 0.05) {
    sunsetText = "Permanent Shadow (0 hrs sunlight)";
  } else if (p > 0.80) {
    sunsetText = "Peak of Eternal Light (~85%+ cycle uptime)";
  } else if (solarElevDeg > 0) {
    const remainingDays = Math.max(0.4, ((sunAlign + 1) / 2) * 14.7).toFixed(1);
    sunsetText = `Sunlit — Sunset in ~${remainingDays} Earth days`;
  } else {
    const daysToSunrise = Math.max(0.4, ((-sunAlign) / 1) * 14.7).toFixed(1);
    sunsetText = `Lunar Night — Sunrise in ~${daysToSunrise} Earth days`;
  }

  const yieldKwh = solarElevDeg <= 0 && p <= 0.80
    ? 0.0
    : Number((Math.max(0.15, p) * (solarElevDeg > 0 ? 7.8 : 4.2)).toFixed(2));

  return {
    lat: Number(lat.toFixed(2)),
    lon: Number(lon.toFixed(2)),
    slope: slopeDeg !== null ? `${slopeDeg.toFixed(1)}°` : "6.2° (Est.)",
    earthElevDeg: Number(earthElevDeg.toFixed(1)),
    dteStatus,
    dteBadgeColor,
    earthsetInfo,
    solarElevDeg,
    sunsetText,
    yieldKwh
  };
}

function initMissionEvaluator() {
  if (document.getElementById("dte-mission-panel")) return;

  const panel = document.createElement("aside");
  panel.id = "dte-mission-panel";
  panel.style.cssText = `
    position: fixed;
    bottom: 18px;
    right: 18px;
    width: 320px;
    background: rgba(11, 16, 28, 0.90);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(96, 165, 250, 0.35);
    border-radius: 12px;
    padding: 14px 16px;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12.5px;
    z-index: 9999;
    box-shadow: 0 10px 30px rgba(0,0,0,0.55);
  `;

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <strong style="font-size:13px;letter-spacing:0.4px;color:#93c5fd;">SITE & DTE COMMS EVALUATOR</strong>
      <button id="dte-collapse-btn" style="background:none;border:1px solid #475569;color:#cbd5e1;border-radius:6px;padding:1px 7px;cursor:pointer;font-size:11px;">Hide</button>
    </div>

    <div id="dte-panel-body">
      <label style="display:block;font-size:11px;color:#94a3b8;margin-bottom:3px;">Candidate Landing Site Preset</label>
      <select id="dte-site-select" style="width:100%;padding:6px 8px;border-radius:6px;background:#1e293b;color:#f8fafc;border:1px solid #334155;margin-bottom:8px;font-size:12px;">
        ${CANDIDATE_SITES.map((s, i) => `<option value="${i}">${s.name}</option>`).join("")}
      </select>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
        <div>
          <span style="font-size:10px;color:#94a3b8;">Lat (°S)</span>
          <input id="dte-lat-input" type="number" step="0.1" min="-90" max="-65" value="-89.8" style="width:100%;padding:4px 6px;border-radius:5px;background:#1e293b;color:#fff;border:1px solid #334155;font-size:12px;">
        </div>
        <div>
          <span style="font-size:10px;color:#94a3b8;">Lon (°E)</span>
          <input id="dte-lon-input" type="number" step="0.5" min="-180" max="180" value="0.0" style="width:100%;padding:4px 6px;border-radius:5px;background:#1e293b;color:#fff;border:1px solid #334155;font-size:12px;">
        </div>
        <div>
          <span style="font-size:10px;color:#94a3b8;">Lunar Day</span>
          <input id="dte-day-input" type="number" step="0.5" min="0" max="29.5" value="7.4" style="width:100%;padding:4px 6px;border-radius:5px;background:#1e293b;color:#fff;border:1px solid #334155;font-size:12px;">
        </div>
      </div>

      <div style="background:rgba(15,23,42,0.85);border:1px solid #1e293b;border-radius:8px;padding:9px 10px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span style="color:#94a3b8;font-size:11px;">Direct-to-Earth (DTE)</span>
          <span id="dte-badge" style="font-weight:700;font-size:10.5px;padding:2px 6px;border-radius:4px;background:#22c55e;color:#052e16;">CONTINUOUS DTE LOCK</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:2px;">
          <span>Earth Horizon Angle:</span>
          <strong id="dte-earth-angle" style="color:#60a5fa;">+6.8° (Near Side 0°E)</strong>
        </div>
        <div id="dte-earthset-text" style="font-size:11px;color:#cbd5e1;">No Earthset (Permanent Near-Side View)</div>
      </div>

      <div style="background:rgba(15,23,42,0.85);border:1px solid #1e293b;border-radius:8px;padding:9px 10px;">
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px;">
          <span>Solar Elevation Angle:</span>
          <strong id="dte-sun-angle" style="color:#fbbf24;">+1.6°</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px;">
          <span>Instant Solar Yield:</span>
          <strong id="dte-yield" style="color:#34d399;">6.72 kWh/m²/day</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px;">
          <span>Terrain Slope:</span>
          <strong id="dte-slope">4.8°</strong>
        </div>
        <div id="dte-sunset-text" style="font-size:11px;color:#fde68a;margin-top:4px;">Peak of Eternal Light (~85%+ cycle uptime)</div>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  const selectEl = document.getElementById("dte-site-select");
  const latEl = document.getElementById("dte-lat-input");
  const lonEl = document.getElementById("dte-lon-input");
  const dayEl = document.getElementById("dte-day-input");
  const collapseBtn = document.getElementById("dte-collapse-btn");
  const bodyEl = document.getElementById("dte-panel-body");

  let activeIllum = CANDIDATE_SITES[0].illum;
  let activeSlope = CANDIDATE_SITES[0].slope;

  function refreshReadout() {
    const lat = parseFloat(latEl.value) || -89.8;
    const lon = parseFloat(lonEl.value) || 0.0;
    const day = parseFloat(dayEl.value) || 0.0;
    const res = evaluateSite(lat, lon, day, activeIllum, activeSlope);

    const badge = document.getElementById("dte-badge");
    badge.textContent = res.dteStatus;
    badge.style.background = res.dteBadgeColor;
    badge.style.color = res.dteBadgeColor === "#ef4444" ? "#fff" : "#052e16";

    const sign = res.earthElevDeg >= 0 ? "+" : "";
    const hemi = Math.abs(lon) <= 90 ? "Near Side" : "Far Side";
    document.getElementById("dte-earth-angle").textContent = `${sign}${res.earthElevDeg}° (${hemi})`;
    document.getElementById("dte-earthset-text").textContent = res.earthsetInfo;

    const sunSign = res.solarElevDeg >= 0 ? "+" : "";
    document.getElementById("dte-sun-angle").textContent = `${sunSign}${res.solarElevDeg}°`;
    document.getElementById("dte-yield").textContent = `${res.yieldKwh} kWh/m²/day`;
    document.getElementById("dte-slope").textContent = res.slope;
    document.getElementById("dte-sunset-text").textContent = res.sunsetText;
  }

  selectEl.addEventListener("change", () => {
    const site = CANDIDATE_SITES[parseInt(selectEl.value, 10)];
    latEl.value = site.lat;
    lonEl.value = site.lon;
    activeIllum = site.illum;
    activeSlope = site.slope;
    refreshReadout();
  });

  [latEl, lonEl].forEach((input) =>
    input.addEventListener("input", () => {
      activeIllum = null;
      activeSlope = null;
      refreshReadout();
    })
  );
  dayEl.addEventListener("input", refreshReadout);

  collapseBtn.addEventListener("click", () => {
    const hidden = bodyEl.style.display === "none";
    bodyEl.style.display = hidden ? "block" : "none";
    collapseBtn.textContent = hidden ? "Hide" : "Show";
  });

  refreshReadout();
}

if (document.readyState === "loading") {document.addEventListener("DOMContentLoaded", initMissionEvaluator);
} else {
initMissionEvaluator();
}
