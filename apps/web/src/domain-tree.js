const compare = (left, right) => left.domain.primaryDomain.localeCompare(right.domain.primaryDomain)
  || left.domain.id.localeCompare(right.domain.id);

// Return a flat view model for accessible disclosure buttons, not a recursive
// component tree. Invalid/orphaned records stay visible for diagnosis.
export function domainTreeRows(domains, { query = '', collapsed = new Set() } = {}) {
  const nodes = domains.map((domain) => ({ domain, children: [], warning: null }));
  const byId = new Map(nodes.map((node) => [node.domain.id, node]));
  const roots = [];
  for (const node of nodes) {
    const parentId = node.domain.parentDomainId ?? null;
    const parent = byId.get(parentId);
    if (parentId === null) roots.push(node);
    else if (!parent || parent === node) {
      node.warning = 'Parent relationship needs review';
      roots.push(node);
    } else parent.children.push(node);
  }
  roots.sort(compare);
  for (const node of nodes) node.children.sort(compare);

  const search = query.trim().toLowerCase();
  const included = new Set();
  if (search) {
    for (const node of nodes) {
      if (![node.domain.primaryDomain, ...(node.domain.aliases ?? [])].some((name) => name.toLowerCase().includes(search))) continue;
      let cursor = node;
      const ancestors = new Set();
      while (cursor && !ancestors.has(cursor.domain.id)) {
        ancestors.add(cursor.domain.id);
        included.add(cursor.domain.id);
        cursor = byId.get(cursor.domain.parentDomainId);
      }
    }
  }

  const rows = [];
  const visited = new Set();
  function visit(start, warning = null) {
    const stack = [{ node: start, depth: 0, hidden: false, warning }];
    while (stack.length) {
      const item = stack.pop();
      const { node, depth, hidden } = item;
      if (visited.has(node.domain.id)) continue;
      visited.add(node.domain.id);
      const expanded = Boolean(search) || !collapsed.has(node.domain.id);
      if (!hidden && (!search || included.has(node.domain.id))) {
        rows.push({ domain: node.domain, depth, childCount: node.children.length, expanded, warning: item.warning ?? node.warning });
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node.children[index], depth: depth + 1, hidden: hidden || !expanded, warning: item.warning });
      }
    }
  }
  for (const root of roots) visit(root);
  // Cycles have no root. Visit them once rather than hanging or hiding data.
  for (const node of [...nodes].sort(compare)) {
    if (!visited.has(node.domain.id)) visit(node, 'Parent relationship needs review');
  }
  return rows;
}
