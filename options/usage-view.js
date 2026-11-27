import { PROVIDERS } from '../src/llm.js';
import { FIELDS, summarize } from '../src/usage.js';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const exact = new Intl.NumberFormat();
const tokens = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;
const dateLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

let days = 7;

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((m) => m * step).find((m) => m >= value);
}

function renderChart(byDay) {
  const W = 640;
  const H = 180;
  const pad = { top: 8, right: 8, bottom: 22, left: 40 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(...byDay.map(tokens)));
  const y = (v) => pad.top + plotH - (v / max) * plotH;
  const slot = plotW / byDay.length;
  const barW = Math.max(2, Math.min(28, slot - 2));

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Tokens per day' });
  for (const tick of [0, max / 2, max]) {
    svg.append(el('line', { x1: pad.left, x2: W - pad.right, y1: y(tick), y2: y(tick), class: tick ? 'grid' : 'baseline' }));
    svg.append(el('text', { x: pad.left - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'axis' }, compact.format(tick)));
  }
  const labelAt = new Set([0, Math.floor((byDay.length - 1) / 2), byDay.length - 1]);
  byDay.forEach((d, i) => {
    const hit = el('rect', { x: pad.left + i * slot, y: pad.top, width: slot, height: plotH, class: 'hit' });
    hit.addEventListener('mouseenter', (event) => showTooltip(event, d));
    hit.addEventListener('mousemove', moveTooltip);
    hit.addEventListener('mouseleave', () => ($('tooltip').hidden = true));
    svg.append(hit);
  });
  byDay.forEach((d, i) => {
    const x = pad.left + i * slot + (slot - barW) / 2;
    const total = tokens(d);
    if (total > 0) {
      const top = y(total);
      const r = Math.min(4, barW / 2, pad.top + plotH - top);
      const base = pad.top + plotH;
      svg.append(el('path', { class: 'bar', d: `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${base}Z` }));
    }
    if (labelAt.has(i)) svg.append(el('text', { x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' }, dateLabel(d.day)));
  });
  $('chart').replaceChildren(svg);
}

function showTooltip(event, d) {
  const rows = [['Input', d.input], ['Output', d.output], ['Cache read', d.cacheRead], ['Cache write', d.cacheWrite]];
  $('tooltip').innerHTML = '';
  const head = document.createElement('div');
  head.className = 'tt-head';
  head.textContent = `${dateLabel(d.day)} · ${exact.format(tokens(d))} tokens · ${d.calls} request${d.calls === 1 ? '' : 's'}`;
  $('tooltip').append(head);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    row.append(Object.assign(document.createElement('span'), { textContent: label }), Object.assign(document.createElement('span'), { textContent: exact.format(value) }));
    $('tooltip').append(row);
  }
  $('tooltip').hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const card = $('chart').parentElement.getBoundingClientRect();
  const tip = $('tooltip');
  const left = Math.min(event.clientX - card.left + 12, card.width - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${event.clientY - card.top + 12}px`;
}

function renderTable(byModel) {
  const body = $('usage-table').tBodies[0];
  body.replaceChildren(
    ...byModel.map((row) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.append(
        Object.assign(document.createElement('div'), { className: 'model', textContent: row.model, title: row.model }),
        Object.assign(document.createElement('div'), { className: 'provider', textContent: PROVIDERS[row.provider]?.label ?? row.provider }),
      );
      tr.append(name, ...FIELDS.map((f) => Object.assign(document.createElement('td'), { textContent: exact.format(row[f]) })));
      return tr;
    }),
  );
  $('usage-table').hidden = byModel.length === 0;
  $('usage-empty').hidden = byModel.length > 0;
}

async function render() {
  const { usage = {} } = await chrome.storage.local.get('usage');
  const summary = summarize(usage, { days, now: Date.now() });
  for (const f of FIELDS) {
    $(`t-${f}`).textContent = compact.format(summary.totals[f]);
    $(`t-${f}`).title = exact.format(summary.totals[f]);
  }
  renderChart(summary.byDay);
  renderTable(summary.byModel);
  for (const b of $('period').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.days === String(days ?? '')));
}

function showView() {
  const view = location.hash === '#usage' ? 'usage' : 'settings';
  $('view-settings').hidden = view !== 'settings';
  $('view-usage').hidden = view !== 'usage';
  for (const a of document.querySelectorAll('.tabs a')) a.setAttribute('aria-current', String(a.dataset.view === view));
  if (view === 'usage') render();
}

$('period').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  days = button.dataset.days ? Number(button.dataset.days) : null;
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usage && !$('view-usage').hidden) render();
});
window.addEventListener('hashchange', showView);
showView();
