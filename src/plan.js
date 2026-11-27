export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

const TRACKING_PARAM = /^(utm_.*|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_ga|_gl|ref_src)$/i;

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          color: { type: 'string', enum: COLORS },
          tabs: { type: 'array', items: { type: 'integer' } },
        },
        required: ['name', 'color', 'tabs'],
        additionalProperties: false,
      },
    },
    duplicates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keep: { type: 'integer' },
          close: { type: 'array', items: { type: 'integer' } },
        },
        required: ['keep', 'close'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups', 'duplicates'],
  additionalProperties: false,
};

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function normalizeUrl(url) {
  const u = parseUrl(url);
  if (!u) return String(url ?? '');
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  }
  u.searchParams.sort();
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '';
  const query = u.searchParams.toString();
  return `${u.protocol}//${u.host.toLowerCase()}${path}${query ? `?${query}` : ''}`;
}

export function promptUrl(url, sendFullUrls) {
  if (sendFullUrls) return url;
  const u = parseUrl(url);
  if (!u) return '';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol}//${u.host}${u.pathname}`;
  return `${u.origin}${u.pathname}`;
}

function recency(tab) {
  return tab.active ? Infinity : tab.lastAccessed ?? 0;
}

function keeperOf(ids, tabsById) {
  return ids.reduce((best, id) => (recency(tabsById.get(id)) > recency(tabsById.get(best)) ? id : best));
}

// Merges overlapping clusters of tab ids and picks the most recently active tab in each as the keeper.
export function resolveDuplicates(clusters, tabs) {
  const tabsById = new Map(tabs.map((t) => [t.id, t]));
  const merged = [];
  for (const cluster of clusters) {
    let ids = new Set(cluster.filter((id) => tabsById.has(id)));
    for (const other of [...merged]) {
      if ([...other].some((id) => ids.has(id))) {
        ids = new Set([...ids, ...other]);
        merged.splice(merged.indexOf(other), 1);
      }
    }
    if (ids.size > 1) merged.push(ids);
  }
  return merged.map((ids) => {
    const list = [...ids];
    const keep = keeperOf(list, tabsById);
    return { keep, close: list.filter((id) => id !== keep).sort((a, b) => a - b) };
  });
}

export function findExactDuplicateClusters(tabs) {
  const byUrl = new Map();
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    if (!key) continue;
    byUrl.set(key, [...(byUrl.get(key) ?? []), tab.id]);
  }
  return [...byUrl.values()].filter((ids) => ids.length > 1);
}

const DAY_MS = 86_400_000;

// Tabs not used for at least `days` days, least recently used first. The active and pinned tabs are never stale.
export function findStaleTabs(tabs, { days, now }) {
  if (!(days > 0)) return [];
  const cutoff = now - days * DAY_MS;
  return tabs
    .filter((t) => !t.active && !t.pinned && t.lastAccessed !== undefined && t.lastAccessed <= cutoff)
    .sort((a, b) => a.lastAccessed - b.lastAccessed);
}

const SYSTEM = `You organize a web browser's tabs into tab groups by topic.
You receive numbered tabs with their title and URL. Reply with JSON only, matching this shape:
{"groups":[{"name":string,"color":string,"tabs":[number]}],"duplicates":[{"keep":number,"close":[number]}]}

Rules for groups:
- Group tabs by topic or task (for example "Trip to Lisbon", "React docs", "Shopping"). Names are 1-3 words, at most 20 characters.
- color is one of: ${COLORS.join(', ')}. Give different groups different colors where possible.
- Each tab number appears in at most one group. Leave a tab out of every group if it fits no topic.
- Never create a group with only one tab unless it joins an existing group.
- When an existing group fits, reuse its exact name.

Rules for duplicates:
- List tabs that show the same page or content under different URLs (for example a mobile and desktop URL, or the same article on an AMP page).
- Do not list tabs that are merely on the same site or topic. When unsure, leave it out.
- Use an empty list when there are none.`;

function tabLine(index, tab, sendFullUrls) {
  return `${index}. ${JSON.stringify(tab.title ?? '')} ${promptUrl(tab.url, sendFullUrls)}`;
}

function maxGroupsLine(maxGroups) {
  return maxGroups > 0 ? `\nUse at most ${maxGroups} groups in total.` : '';
}

// Full regroup: every non-pinned tab in the window is indexed and movable.
export function buildFullPrompt({ tabs, existingGroupTitles, maxGroups, sendFullUrls }) {
  const tabIndex = new Map(tabs.map((tab, i) => [i + 1, tab.id]));
  const titles = existingGroupTitles.filter(Boolean);
  const user = [
    titles.length ? `Existing group names (reuse where they fit): ${titles.map((t) => JSON.stringify(t)).join(', ')}` : 'There are no existing groups.',
    '',
    'Tabs:',
    ...tabs.map((tab, i) => tabLine(i + 1, tab, sendFullUrls)),
  ].join('\n') + maxGroupsLine(maxGroups);
  return { system: SYSTEM, user, tabIndex, movable: new Set(tabIndex.keys()) };
}

// Incremental: only the ungrouped tabs may be grouped; sample tabs of existing groups are indexed
// so the model can flag a new tab as a near-duplicate of one, but they never move.
export function buildIncrementalPrompt({ newTabs, groups, maxGroups, sendFullUrls }) {
  const tabIndex = new Map();
  const lines = [];
  let next = 1;
  const add = (tab) => {
    tabIndex.set(next, tab.id);
    lines.push(tabLine(next, tab, sendFullUrls));
    next += 1;
  };
  const sections = [];
  for (const group of groups) {
    lines.length = 0;
    group.samples.forEach(add);
    sections.push(`Existing group ${JSON.stringify(group.title)}:\n${lines.join('\n')}`);
  }
  const firstNew = next;
  lines.length = 0;
  newTabs.forEach(add);
  const movable = new Set([...tabIndex.keys()].filter((i) => i >= firstNew));
  const user = [
    sections.length ? sections.join('\n\n') : 'There are no existing groups.',
    '',
    `Ungrouped tabs (only these may be placed in groups; put each in an existing group by its exact name, in a new group with other ungrouped tabs on the same topic, or leave it out):`,
    lines.join('\n'),
  ].join('\n') + maxGroupsLine(maxGroups);
  return { system: SYSTEM, user, tabIndex, movable };
}

function toIndex(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(n) ? n : null;
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 40) : '';
}

function cleanColor(value) {
  const c = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (c === 'gray') return 'grey';
  return COLORS.includes(c) ? c : 'grey';
}

// Boundary between the model's raw reply and the rest of the extension. Everything after this trusts the Plan.
export function parsePlan(raw, { tabIndex, movable }) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const rawGroups = Array.isArray(obj.groups) ? obj.groups : [];
  const rawDuplicates = Array.isArray(obj.duplicates) ? obj.duplicates : [];

  const claimed = new Set();
  const byName = new Map();
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const name = cleanName(g.name);
    const tabIds = [];
    for (const value of Array.isArray(g.tabs) ? g.tabs : []) {
      const index = toIndex(value);
      if (index === null || !movable.has(index) || claimed.has(index)) continue;
      claimed.add(index);
      tabIds.push(tabIndex.get(index));
    }
    if (tabIds.length === 0) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) existing.tabIds.push(...tabIds);
    else byName.set(key, { name, color: cleanColor(g.color), tabIds });
  }

  const duplicateClusters = [];
  for (const d of rawDuplicates) {
    if (!d || typeof d !== 'object') continue;
    const indices = [toIndex(d.keep), ...(Array.isArray(d.close) ? d.close.map(toIndex) : [])];
    const ids = [...new Set(indices.filter((i) => i !== null && tabIndex.has(i)).map((i) => tabIndex.get(i)))];
    if (ids.length > 1) duplicateClusters.push(ids);
  }

  return { groups: [...byName.values()], duplicateClusters };
}

// Tolerant extraction for providers that wrap JSON in prose or code fences.
export function extractJson(text) {
  const s = String(text ?? '').trim();
  try {
    return JSON.parse(s);
  } catch {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  return null;
}
