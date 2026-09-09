/** Filter groups rather than splitting a parent's children across pages. */
export function siteListPage(rows, { type = 'all', status = 'all', sort = 'asc', page = 1, perPage = 10 } = {}) {
  const groups = [];
  for (const row of rows) {
    if (row.depth === 0 || groups.length === 0) groups.push([]);
    groups.at(-1).push(row);
  }
  const matches = (row) => (type === 'all' || row.domain.targetType === type)
    && (status === 'all' || row.domain.state === status);
  const filtered = groups.map((group) => {
    const keep = new Set();
    const stack = [];
    for (const row of group) {
      stack.length = row.depth;
      stack[row.depth] = row.domain.id;
      if (matches(row)) for (const id of stack) if (id) keep.add(id);
    }
    return group.filter((row) => keep.has(row.domain.id)).map((row) => ({ ...row, contextOnly: !matches(row) }));
  }).filter((group) => group.length);
  if (sort === 'desc') filtered.reverse();
  const size = Number.isInteger(perPage) && perPage >= 1 && perPage <= 50 ? perPage : 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / size));
  const currentPage = Math.min(pageCount, Math.max(1, Number.isInteger(page) ? page : 1));
  return { rows: filtered.slice((currentPage - 1) * size, currentPage * size).flat(), page: currentPage, pageCount, totalGroups: filtered.length, totalMatches: rows.filter(matches).length };
}
