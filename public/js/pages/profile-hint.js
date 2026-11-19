// Overview tab: a small hint when the pack's profile has suggested settings the
// user has not reviewed yet. Silent on any error, and absent for other servers.
const hint = document.querySelector('[data-prof-hint]');
if (hint) init(hint);

async function init(el) {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(el.dataset.profHint)}/profile`);
    if (!res.ok) return;
    const data = await res.json();
    const state = data?.review?.state;
    if (data?.profile && (state === 'new' || state === 'new-presets')) {
      el.classList.remove('hidden');
      el.classList.add('flex');
    }
  } catch {
    // Optional hint: leave it hidden.
  }
}
