// Applies a validated Plan to one window. A plan group whose name matches an existing group
// (case-insensitive) joins it and keeps the user's color; otherwise a new group is created.
// Tabs that closed or moved since the model call are skipped.
export async function applyPlan(windowId, plan, { existingGroups, ungroupTabIds = [] }) {
  const byTitle = new Map(existingGroups.filter((g) => g.title).map((g) => [g.title.toLowerCase(), g]));
  const live = new Set((await chrome.tabs.query({ windowId, pinned: false })).map((t) => t.id));
  let created = 0;
  let moved = 0;

  for (const group of plan.groups) {
    const tabIds = group.tabIds.filter((id) => live.has(id));
    if (tabIds.length === 0) continue;
    const existing = byTitle.get(group.name.toLowerCase());
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds });
    } else {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: group.name, color: group.color, collapsed: false });
      byTitle.set(group.name.toLowerCase(), { id: groupId, title: group.name });
      created += 1;
    }
    moved += tabIds.length;
  }

  const toUngroup = ungroupTabIds.filter((id) => live.has(id));
  if (toUngroup.length) await chrome.tabs.ungroup(toUngroup);

  return { created, moved, ungrouped: toUngroup.length };
}
