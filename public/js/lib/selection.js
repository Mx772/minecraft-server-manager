// Row multi-select for a table: native checkboxes, Shift+click range select,
// and a header select-all that shows an indeterminate state when partial.
//
//   const sel = createSelection({
//     table, rowSelector: '[data-file-row]', checkboxSelector: '[data-file-select]',
//     selectAll: headerCheckbox, onChange: (count) => {},
//   });
//   sel.selected();   // -> row elements that are checked
//   sel.clear(); sel.selectAll(); sel.remove(rowEl); sel.refresh();

export function createSelection({ table, rowSelector, checkboxSelector, selectAll = null, onChange = () => {} }) {
  let anchor = null;

  const rows = () => [...table.querySelectorAll(rowSelector)];
  const boxOf = (row) => row.querySelector(checkboxSelector);
  const selected = () => rows().filter((r) => boxOf(r)?.checked);

  function refresh() {
    const all = rows();
    const count = all.filter((r) => boxOf(r)?.checked).length;
    if (selectAll) {
      selectAll.checked = all.length > 0 && count === all.length;
      selectAll.indeterminate = count > 0 && count < all.length;
      selectAll.disabled = all.length === 0;
    }
    onChange(count);
  }

  table.addEventListener('click', (e) => {
    const box = e.target.closest(checkboxSelector);
    if (!box || !table.contains(box)) return;
    const row = box.closest(rowSelector);
    if (!row) return;
    if (e.shiftKey && anchor && anchor.isConnected && anchor !== row) {
      const all = rows();
      const a = all.indexOf(anchor);
      const b = all.indexOf(row);
      if (a !== -1 && b !== -1) {
        // The click already toggled this box; apply its new state to the span.
        const [from, to] = a < b ? [a, b] : [b, a];
        for (let i = from; i <= to; i++) {
          const cb = boxOf(all[i]);
          if (cb) cb.checked = box.checked;
        }
      }
    }
    anchor = row;
    refresh();
  });

  function setAll(checked) {
    for (const r of rows()) {
      const cb = boxOf(r);
      if (cb) cb.checked = checked;
    }
    anchor = null;
    refresh();
  }

  selectAll?.addEventListener('change', () => setAll(selectAll.checked));

  return {
    selected,
    refresh,
    clear() {
      setAll(false);
    },
    selectAll() {
      setAll(true);
    },
    remove(row) {
      if (anchor === row) anchor = null;
      row.remove();
      refresh();
    },
  };
}
