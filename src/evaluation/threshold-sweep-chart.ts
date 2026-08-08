/**
 * Read data/threshold-sweep/sweep.csv and emit line-chart SVG.
 * Usage: npx ts-node --transpile-only src/evaluation/threshold-sweep-chart.ts
 */
import fs from 'fs';
import path from 'path';

const csv = fs.readFileSync('data/threshold-sweep/sweep.csv', 'utf8').trim().split('\n');
const header = csv[0].split(',');
const rows = csv.slice(1).map((line) => {
  const cols = line.split(',');
  const obj: Record<string, number> = {};
  for (let i = 0; i < header.length; i++) obj[header[i]] = parseFloat(cols[i]);
  return obj;
}).sort((a, b) => a.threshold - b.threshold);

const W = 800, H = 500, pad = 60;
const xs = rows.map((r) => r.threshold);
const xMin = Math.min(...xs), xMax = Math.max(...xs);

const mapX = (t: number) => pad + ((t - xMin) / (xMax - xMin)) * (W - 2 * pad);
const mapY = (v: number) => H - pad - v * (H - 2 * pad);

function linePath(series: keyof (typeof rows)[number], color: string): string {
  const pts = rows.map((r) => `${mapX(r.threshold)},${mapY(Number(r[series]))}`).join(' ');
  return `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>`;
}

const lines = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" font-size="12">`,
  `<rect width="${W}" height="${H}" fill="white"/>`,
  // axes
  `<line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="black"/>`,
  `<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="black"/>`,
  // y-axis ticks 0, 0.2, 0.4, 0.6, 0.8, 1.0
  ...([0, 0.2, 0.4, 0.6, 0.8, 1.0].map((v) => `<g><line x1="${pad - 5}" y1="${mapY(v)}" x2="${pad}" y2="${mapY(v)}" stroke="black"/><text x="${pad - 10}" y="${mapY(v) + 4}" text-anchor="end">${v.toFixed(1)}</text><line x1="${pad}" y1="${mapY(v)}" x2="${W - pad}" y2="${mapY(v)}" stroke="#eee"/></g>`)),
  // x-axis ticks every 5
  ...(xs.filter((x) => x % 5 === 0).map((x) => `<g><line x1="${mapX(x)}" y1="${H - pad}" x2="${mapX(x)}" y2="${H - pad + 5}" stroke="black"/><text x="${mapX(x)}" y="${H - pad + 18}" text-anchor="middle">${x}</text></g>`)),
  // series
  linePath('precision', 'red'),
  linePath('recall', 'blue'),
  linePath('f1', 'green'),
  // data points
  ...rows.flatMap((r) => [
    `<circle cx="${mapX(r.threshold)}" cy="${mapY(r.precision)}" r="2" fill="red"/>`,
    `<circle cx="${mapX(r.threshold)}" cy="${mapY(r.recall)}" r="2" fill="blue"/>`,
    `<circle cx="${mapX(r.threshold)}" cy="${mapY(r.f1)}" r="2" fill="green"/>`,
  ]),
  // labels
  `<text x="${W / 2}" y="${H - 15}" text-anchor="middle">MATCH_THRESHOLD (%)</text>`,
  `<text x="20" y="${H / 2}" text-anchor="middle" transform="rotate(-90 20 ${H / 2})">score</text>`,
  `<text x="${W / 2}" y="20" text-anchor="middle" font-size="14" font-weight="bold">Threshold sweep: precision / recall / f1</text>`,
  // legend
  `<g transform="translate(${W - 150}, ${pad + 20})">`,
  `<rect x="-5" y="-5" width="135" height="70" fill="white" stroke="black"/>`,
  `<line x1="0" y1="10" x2="20" y2="10" stroke="red" stroke-width="2"/><text x="25" y="14">precision</text>`,
  `<line x1="0" y1="30" x2="20" y2="30" stroke="blue" stroke-width="2"/><text x="25" y="34">recall</text>`,
  `<line x1="0" y1="50" x2="20" y2="50" stroke="green" stroke-width="2"/><text x="25" y="54">f1</text>`,
  `</g>`,
  // best f1 marker
  (() => {
    const best = rows.reduce((a, b) => (b.f1 > a.f1 ? b : a));
    return `<g><circle cx="${mapX(best.threshold)}" cy="${mapY(best.f1)}" r="6" fill="none" stroke="gold" stroke-width="2"/><text x="${mapX(best.threshold) + 10}" y="${mapY(best.f1)}" font-weight="bold" fill="darkgoldenrod">★ best f1=${best.f1.toFixed(3)} @ t=${best.threshold}</text></g>`;
  })(),
  `</svg>`,
];
const outPath = 'data/threshold-sweep/sweep.svg';
fs.writeFileSync(outPath, lines.join('\n'));
console.log('[chart] →', path.resolve(outPath));

// Print table
console.log('threshold | precision | recall | f1');
console.log('---------:|----------:|-------:|------:');
for (const r of rows) {
  console.log([r.threshold, r.precision.toFixed(4), r.recall.toFixed(4), r.f1.toFixed(4)].join(' | '));
}
const best = rows.reduce((a, b) => (b.f1 > a.f1 ? b : a));
console.log(`\nBest f1 = ${best.f1.toFixed(4)} @ threshold=${best.threshold} (p=${best.precision.toFixed(4)}, r=${best.recall.toFixed(4)})`);
