// Gráficos SVG desenhados à mão — offline-first, sem CDN nem canvas.
//
// balanceChart: barras duplas por mês (recebido = ganhos, cobrado = perdas)
// e a linha do balanço (recebido − cobrado). Devolve uma string SVG pronta a
// injectar no DOM; responsiva via viewBox.

const num = (v) => Number(v) || 0;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Arredonda o topo do eixo para um máximo «bonito». */
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Rótulo compacto do eixo: 1,2 M / 850 k / 42. */
export function axisLabel(v) {
  const a = Math.abs(num(v));
  const sign = num(v) < 0 ? '-' : '';
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (a >= 1e3) return sign + Math.round(a / 1e3) + ' k';
  return sign + String(Math.round(a));
}

/**
 * Gráfico de balanço mensal.
 *
 * @param {Array<{month: string, received: number, billed: number, balance: number}>} series
 * @param {{width?: number, height?: number}} [opts]
 * @returns {string} SVG (viewBox) ou estado vazio legível.
 */
export function balanceChart(series = [], opts = {}) {
  const width = Math.max(320, num(opts.width) || 860);
  const height = Math.max(200, num(opts.height) || 300);
  const pl = 66, pr = 14, pt = 30, pb = 54;
  const iw = width - pl - pr;
  const ih = height - pt - pb;

  const rows = Array.isArray(series) ? series : [];
  const values = rows.flatMap((d) => [num(d.received), num(d.billed), num(d.balance)]);
  const hi = niceMax(Math.max(1, ...values));
  const lo = Math.min(0, ...values);
  const span = hi - lo || 1;
  const y = (v) => pt + ih - ((num(v) - lo) / span) * ih;

  const parts = [];

  // Grelha e eixo Y (5 passos entre o mínimo e o máximo).
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span / 4) * i;
    const yy = y(v);
    const zero = Math.abs(v) < span / 1000;
    parts.push(
      `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${width - pr}" y2="${yy.toFixed(1)}" ` +
      `stroke="${zero ? 'rgba(255,255,255,.38)' : 'rgba(255,255,255,.12)'}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${pl - 8}" y="${yy + 4}" text-anchor="end" font-size="10.5" ` +
      `fill="rgba(238,246,255,.66)">${esc(axisLabel(v))}</text>`,
    );
  }

  if (!rows.length) {
    parts.push(
      `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-size="14" ` +
      `fill="rgba(238,246,255,.6)">Sem dados no âmbito escolhido</text>`,
    );
  }

  const n = rows.length || 1;
  const slot = iw / n;
  const barW = Math.max(4, Math.min(26, slot * 0.3));
  const labelStep = Math.ceil(rows.length / 14);
  const linePts = [];

  rows.forEach((d, i) => {
    const cx = pl + slot * i + slot / 2;
    const rec = num(d.received);
    const bil = num(d.billed);
    const hRec = Math.max(0, pt + ih - y(rec));
    const hBil = Math.max(0, pt + ih - y(bil));
    const x1 = cx - barW - 2;
    const x2 = cx + 2;

    parts.push(
      `<rect x="${x1.toFixed(1)}" y="${y(rec).toFixed(1)}" width="${barW.toFixed(1)}" height="${hRec.toFixed(1)}" ` +
      `rx="3" fill="url(#gGain)"><title>${esc(d.month)} — recebido ${axisLabel(rec)}</title></rect>`,
    );
    parts.push(
      `<rect x="${x2.toFixed(1)}" y="${y(bil).toFixed(1)}" width="${barW.toFixed(1)}" height="${hBil.toFixed(1)}" ` +
      `rx="3" fill="url(#gLoss)"><title>${esc(d.month)} — cobrado ${axisLabel(bil)}</title></rect>`,
    );

    linePts.push(`${cx.toFixed(1)},${y(num(d.balance)).toFixed(1)}`);

    if (i % labelStep === 0) {
      parts.push(
        `<text x="${cx.toFixed(1)}" y="${pt + ih + 18}" text-anchor="middle" font-size="10.5" ` +
        `fill="rgba(238,246,255,.72)">${esc(d.month)}</text>`,
      );
    }
  });

  if (linePts.length > 1) {
    parts.push(
      `<polyline points="${linePts.join(' ')}" fill="none" stroke="#eef6ff" stroke-width="2" ` +
      `stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="1 6"/>`,
    );
  }
  for (const pt2 of linePts) {
    const [cx, cy] = pt2.split(',');
    parts.push(`<circle cx="${cx}" cy="${cy}" r="3.4" fill="#06201f" stroke="#eef6ff" stroke-width="2"/>`);
  }

  // Legenda (topo à direita).
  const legendY = 14;
  parts.push(`<rect x="${width - pr - 176}" y="${legendY - 9}" width="11" height="11" rx="3" fill="url(#gGain)"/>`);
  parts.push(
    `<text x="${width - pr - 160}" y="${legendY}" font-size="11" fill="rgba(238,246,255,.85)">Recebido (ganhos)</text>`,
  );
  parts.push(`<rect x="${width - pr - 60}" y="${legendY - 9}" width="11" height="11" rx="3" fill="url(#gLoss)"/>`);
  parts.push(
    `<text x="${width - pr - 44}" y="${legendY}" font-size="11" fill="rgba(238,246,255,.85)">Cobrado (perdas)</text>`,
  );

  const grads = `
    <defs>
      <linearGradient id="gGain" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2dd4bf"/><stop offset="1" stop-color="#14b8a6"/>
      </linearGradient>
      <linearGradient id="gLoss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e8a94a"/><stop offset="1" stop-color="#a8641a"/>
      </linearGradient>
    </defs>`;

  return (
    `<svg viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-label="Balanço mensal de ganhos e perdas" preserveAspectRatio="xMidYMid meet">` +
    grads + parts.join('') + '</svg>'
  );
}
