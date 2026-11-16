// Shared customizations helpers for pages that need the per-server list.
// A failed fetch resolves to null so callers can quietly leave the UI out.

export async function fetchCustomizations(serverId) {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/customizations`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(data.customizations)) return null;
    return data.customizations;
  } catch {
    return null;
  }
}

// The sentence for the pack-upgrade confirmation, or '' when there is nothing
// to say (no customizations, or the count could not be fetched).
export async function upgradeNotice(serverId) {
  const list = await fetchCustomizations(serverId);
  if (!list || !list.length) return '';
  const n = list.length;
  return `Your ${n === 1 ? '1 customized file is' : `${n} customized files are`} copied back over the new pack's versions when the server starts.`;
}
