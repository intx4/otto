// Token usage, kept as daily totals per provider and model so storage stays small however many runs happen.
// Buckets map "YYYY-MM-DD|provider|model" to {calls, input, output, cacheRead, cacheWrite}.
export const FIELDS = ['calls', 'input', 'output', 'cacheRead', 'cacheWrite'];
const KEEP_DAYS = 400;
const DAY_MS = 86_400_000;

export function dayKey(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addUsage(buckets, { at, provider, model, usage }) {
  const key = `${dayKey(at)}|${provider}|${model}`;
  const prev = buckets[key] ?? Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const next = { ...buckets, [key]: { ...prev, calls: prev.calls + 1, ...Object.fromEntries(FIELDS.slice(1).map((f) => [f, prev[f] + usage[f]])) } };
  const oldest = dayKey(at - KEEP_DAYS * DAY_MS);
  return Object.fromEntries(Object.entries(next).filter(([k]) => k.slice(0, 10) >= oldest));
}

const zero = () => Object.fromEntries(FIELDS.map((f) => [f, 0]));
const addInto = (target, source) => FIELDS.forEach((f) => (target[f] += source[f]));

// Totals, per-model rows (largest first) and one entry per calendar day in the period, empty days included.
// `days` null means all recorded days.
export function summarize(buckets, { days, now }) {
  const entries = Object.entries(buckets).map(([key, value]) => {
    const [day, provider, model] = key.split('|');
    return { day, provider, model, value };
  });
  const first = days ? dayKey(now - (days - 1) * DAY_MS) : entries.reduce((min, e) => (e.day < min ? e.day : min), dayKey(now));
  const inPeriod = entries.filter((e) => e.day >= first);

  const totals = zero();
  const models = new Map();
  const perDay = new Map();
  for (const { day, provider, model, value } of inPeriod) {
    addInto(totals, value);
    const id = `${provider}|${model}`;
    if (!models.has(id)) models.set(id, { provider, model, ...zero() });
    addInto(models.get(id), value);
    if (!perDay.has(day)) perDay.set(day, zero());
    addInto(perDay.get(day), value);
  }

  const byDay = [];
  for (let t = new Date(`${first}T12:00:00`).getTime(); dayKey(t) <= dayKey(now); t += DAY_MS) {
    byDay.push({ day: dayKey(t), ...(perDay.get(dayKey(t)) ?? zero()) });
  }
  const tokens = (r) => r.input + r.output + r.cacheRead + r.cacheWrite;
  return { totals, byModel: [...models.values()].sort((a, b) => tokens(b) - tokens(a)), byDay };
}
