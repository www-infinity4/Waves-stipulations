/* =============================================
   Waves Stipulations — main.js
   Interactive Field Simulator
   ============================================= */

(function () {
  'use strict';

  /* ---- Constants ---- */
  const EPS0 = 8.854187817e-12;   // F/m  (permittivity of free space)
  const K    = 8.98755e9;         // N·m²/C²  (Coulomb constant)
  const E_BREAKDOWN_SEA = 3.0e6;  // V/m  (air breakdown at sea level)
  const E_BREAKDOWN_VAC = 1.0e10; // V/m  (effectively infinite in vacuum)

  /* ---- DOM refs ---- */
  const sigmaSlider  = document.getElementById('sigma');
  const radiusSlider = document.getElementById('radius');
  const altSelect    = document.getElementById('altitude');
  const sigmaVal     = document.getElementById('sigma-val');
  const radiusVal    = document.getElementById('radius-val');
  const outputDiv    = document.getElementById('sim-output');
  const canvas       = document.getElementById('field-canvas');
  const ctx          = canvas.getContext('2d');

  /* ---- Helpers ---- */
  function getSigma()  { return parseFloat(sigmaSlider.value)  * 1e-6; }  // C/m²
  function getRadius() { return parseFloat(radiusSlider.value); }          // m
  function getAltFactor() { return parseFloat(altSelect.value); }          // density ratio

  /**
   * Surface electric field of a uniformly charged sphere:
   *   E_surf = σ / ε₀
   */
  function surfaceField(sigma) {
    return sigma / EPS0;
  }

  /**
   * Field at distance r from the centre of a charged sphere of radius R:
   *   E(r) = σ·R² / (ε₀·r²)   for r ≥ R
   */
  function fieldAt(sigma, R, r) {
    if (r < R) return 0;
    return (sigma * R * R) / (EPS0 * r * r);
  }

  /**
   * Total surface charge:
   *   Q = 4π·R²·σ
   */
  function totalCharge(sigma, R) {
    return 4 * Math.PI * R * R * sigma;
  }

  /**
   * Distance at which field drops below breakdown threshold.
   * E(r) = E_breakdown  →  r = R · √(σ / (ε₀ · E_bd))
   */
  function plasmaRadius(sigma, R, altFactor) {
    const E_bd = E_BREAKDOWN_SEA * altFactor;
    if (E_bd <= 0) return Infinity;
    const eSurf = surfaceField(sigma);
    if (eSurf < E_bd) return R; // no plasma
    return R * Math.sqrt(eSurf / E_bd);
  }

  /**
   * Rough plasma frequency estimate:
   *   ω_p ≈ 56.4 · √n  (rad/s, n in m⁻³)
   * We estimate n from breakdown density (~10¹⁷ m⁻³ at sea level).
   */
  function plasmaFreqGHz(altFactor) {
    const n = 1e17 * altFactor;
    const omegaP = 56.4 * Math.sqrt(n); // rad/s
    return omegaP / (2 * Math.PI * 1e9); // GHz
  }

  /* ---- Rendering the output metrics ---- */
  function metric(label, value, unit, cssClass) {
    const cls = cssClass ? ` class="metric-value ${cssClass}"` : ' class="metric-value"';
    return `<div class="metric">
      <span class="metric-label">${label}</span>
      <span${cls}>${value}&nbsp;${unit}</span>
    </div>`;
  }

  function renderMetrics() {
    const sigma     = getSigma();
    const R         = getRadius();
    const altFactor = getAltFactor();

    const E_surf   = surfaceField(sigma);
    const Q        = totalCharge(sigma, R);
    const r_plasma = plasmaRadius(sigma, R, altFactor);
    const E_bd     = E_BREAKDOWN_SEA * altFactor;
    const plasmaActive = (E_surf >= E_bd) && altFactor > 0.01;
    const pThick   = plasmaActive ? (r_plasma - R).toFixed(2) : '0';
    const fGHz     = plasmaActive ? plasmaFreqGHz(altFactor).toFixed(1) : '—';
    const pressurePa = (EPS0 / 2) * E_surf * E_surf; // Pa

    sigmaVal.textContent  = sigmaSlider.value;
    radiusVal.textContent = radiusSlider.value;

    outputDiv.innerHTML = [
      metric('Surface field E<sub>surf</sub>', formatSI(E_surf, 'V/m'), '', E_surf >= E_bd ? 'active' : ''),
      metric('Total charge Q', formatSI(Q, 'C'), '', ''),
      metric('Electrostatic pressure', formatSI(pressurePa, 'Pa'), '', ''),
      metric('Breakdown threshold E<sub>bd</sub>', formatSI(E_bd, 'V/m'), '', 'warning'),
      metric('Plasma sheath active?', plasmaActive ? 'YES' : 'NO', '', plasmaActive ? 'active' : 'warning'),
      metric('Plasma thickness', pThick, 'm', plasmaActive ? 'active' : ''),
      metric('Plasma EM cut-off', fGHz, 'GHz', plasmaActive ? 'active' : ''),
    ].join('');
  }

  /* ---- SI prefix formatter ---- */
  function formatSI(val, unit) {
    const absVal = Math.abs(val);
    if (absVal === 0) return `0 ${unit}`;
    if (absVal >= 1e12) return (val / 1e12).toPrecision(3) + ' T' + unit;
    if (absVal >= 1e9)  return (val / 1e9).toPrecision(3)  + ' G' + unit;
    if (absVal >= 1e6)  return (val / 1e6).toPrecision(3)  + ' M' + unit;
    if (absVal >= 1e3)  return (val / 1e3).toPrecision(3)  + ' k' + unit;
    if (absVal >= 1)    return val.toPrecision(3)           + ' '  + unit;
    if (absVal >= 1e-3) return (val * 1e3).toPrecision(3)  + ' m' + unit;
    if (absVal >= 1e-6) return (val * 1e6).toPrecision(3)  + ' μ' + unit;
    if (absVal >= 1e-9) return (val * 1e9).toPrecision(3)  + ' n' + unit;
    return val.toExponential(2) + ' ' + unit;
  }

  /* ---- Canvas visualisation ---- */
  function drawField() {
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const sigma     = getSigma();
    const R         = getRadius();
    const altFactor = getAltFactor();
    const E_bd      = E_BREAKDOWN_SEA * altFactor;
    const E_surf    = surfaceField(sigma);
    const r_plasma  = plasmaRadius(sigma, R, altFactor);
    const plasmaActive = (E_surf >= E_bd) && altFactor > 0.01;

    // Map real-space radii to canvas pixels.
    // Show up to 3× hull radius or plasma radius + 20%, whichever is larger.
    const maxReal = Math.max(R * 3, r_plasma * 1.2, R + 5);
    const scale   = (W / 2) / maxReal;  // px / m

    const cx = W / 2;
    const cy = H / 2;

    // -- Draw field strength colour map (cross-section slice) --
    const imgData = ctx.createImageData(W, H);
    const E_max = E_surf > 0 ? E_surf : 1;

    for (let px = 0; px < W; px++) {
      for (let py = 0; py < H; py++) {
        const rx = (px - cx) / scale;
        const ry = (py - cy) / scale;
        const r  = Math.sqrt(rx * rx + ry * ry);
        const E  = fieldAt(sigma, R, r);
        const t  = Math.min(E / E_max, 1);

        // colour: dark blue → electric blue → white
        let red, green, blue;
        if (t < 0.5) {
          red   = 0;
          green = Math.round(t * 2 * 80);
          blue  = Math.round(40 + t * 2 * 215);
        } else {
          const s = (t - 0.5) * 2;
          red   = Math.round(s * 255);
          green = Math.round(80 + s * 175);
          blue  = 255;
        }

        const idx = (py * W + px) * 4;
        // Inside hull → dark gold
        if (r < R) {
          imgData.data[idx]     = 100;
          imgData.data[idx + 1] = 80;
          imgData.data[idx + 2] = 20;
          imgData.data[idx + 3] = 255;
        } else {
          imgData.data[idx]     = red;
          imgData.data[idx + 1] = green;
          imgData.data[idx + 2] = blue;
          imgData.data[idx + 3] = 200;
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    // -- Draw plasma boundary ring --
    if (plasmaActive && isFinite(r_plasma)) {
      const rp_px = r_plasma * scale;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, rp_px, 0, 2 * Math.PI);
      ctx.strokeStyle = 'rgba(120, 255, 180, 0.85)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '12px monospace';
      ctx.fillStyle = 'rgba(120, 255, 180, 0.9)';
      ctx.fillText('plasma boundary', cx + rp_px + 6, cy - 6);
      ctx.restore();
    }

    // -- Draw hull circle --
    const R_px = R * scale;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R_px, 0, 2 * Math.PI);
    ctx.strokeStyle = '#f0c040';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = '12px monospace';
    ctx.fillStyle = '#f0c040';
    ctx.fillText('hull', cx + 6, cy + R_px - 6);
    ctx.restore();

    // -- Legend --
    ctx.save();
    const grd = ctx.createLinearGradient(10, 0, 10 + 120, 0);
    grd.addColorStop(0,   '#00285f');
    grd.addColorStop(0.5, '#0050ff');
    grd.addColorStop(1,   '#ffffff');
    ctx.fillStyle = grd;
    ctx.fillRect(10, H - 28, 120, 14);
    ctx.strokeStyle = '#3a6aaa';
    ctx.lineWidth = 1;
    ctx.strokeRect(10, H - 28, 120, 14);
    ctx.fillStyle = '#7aaae0';
    ctx.font = '10px sans-serif';
    ctx.fillText('E: low', 12, H - 32);
    ctx.fillText('high', 110, H - 32);
    ctx.restore();
  }

  /* ---- Update everything ---- */
  function update() {
    renderMetrics();
    drawField();
  }

  /* ---- Event listeners ---- */
  [sigmaSlider, radiusSlider, altSelect].forEach(el => {
    el.addEventListener('input', update);
    el.addEventListener('change', update);
  });

  /* ---- Handle canvas resize ---- */
  function resizeCanvas() {
    const containerWidth = canvas.parentElement.clientWidth;
    const targetWidth    = Math.min(640, containerWidth - 2);
    if (canvas.width !== targetWidth) {
      canvas.width  = targetWidth;
      canvas.height = Math.round(targetWidth * 0.47);
      update();
    }
  }

  window.addEventListener('resize', resizeCanvas);

  /* ---- Initialise ---- */
  resizeCanvas();
  update();

})();
