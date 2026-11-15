/* Pure allocation helpers: preserve historical prices, discounts and stock across unpaid orders. */
export function allocate(total, weights, caps = weights.map(() => total)) {
  if (!Number.isSafeInteger(total) || total < 0 || caps.reduce((n, x) => n + x, 0) < total) throw new Error('Không thể phân bổ giảm giá cho các đơn mới. Hãy đổi cách chia món.');
  const out = weights.map(() => 0);
  let left = total;
  while (left > 0) {
    const active = weights.map((_, i) => i).filter(i => out[i] < caps[i]);
    const sum = active.reduce((n, i) => n + Math.max(0, weights[i]), 0);
    let used = 0;
    for (const i of active) {
      const share = Math.min(caps[i] - out[i], Math.floor(left * (sum ? Math.max(0, weights[i]) / sum : 1 / active.length)));
      out[i] += share; used += share;
    }
    left -= used;
    if (left) for (const i of active) { if (left && out[i] < caps[i]) { out[i]++; left--; } }
  }
  return out;
}

export function splitHistorical(source, groups, usageFor) {
  if (!Array.isArray(groups) || groups.length < 2 || groups.length > 8) throw new Error('Tách thành từ 2 đến 8 đơn.');
  const original = source.items, used = original.map(() => 0);
  const parts = groups.map(group => {
    if (!Array.isArray(group) || !group.length || group.length > 40) throw new Error('Mỗi đơn mới cần từ 1 đến 40 dòng món.');
    const seen = new Set();
    return group.map(x => {
      if (!Number.isInteger(x.line) || !original[x.line] || seen.has(x.line) || !Number.isInteger(x.quantity) || x.quantity < 1) throw new Error('Món hoặc số lượng tách không hợp lệ.');
      seen.add(x.line); used[x.line] += x.quantity;
      return {...original[x.line], quantity: x.quantity, _line: x.line};
    });
  });
  if (used.some((n, i) => n !== original[i].quantity)) throw new Error('Phải chia đủ số lượng của từng món, không được thừa hoặc thiếu.');
  // Allocate the stored line total, including pack-price rounding, instead of re-pricing from today's menu.
  original.forEach((item, line) => {
    const rows = parts.flatMap(items => items.filter(x => x._line === line));
    const amounts = allocate(item.lineTotal, rows.map(x => x.quantity));
    rows.forEach((x, i) => { x.lineTotal = amounts[i]; delete x._line; });
  });
  const first = source.audit[0] || {}, weights = parts.map(items => items.reduce((n, x) => n + x.lineTotal, 0));
  const redeemed = allocate(first.redeemed || 0, weights, weights.map(x => Math.floor(x * 0.5 / 1000)));
  const pointDiscounts = redeemed.map(x => x * 1000);
  const promo = allocate(first.promoDiscount || 0, weights, weights.map((x, i) => x - pointDiscounts[i]));
  const manual = allocate(first.manualDiscount || 0, weights, weights.map((x, i) => x - pointDiscounts[i] - promo[i]));
  const stock = parts.map(() => ({})), actual = parts.map(items => usageFor(items));
  const before = first.stockUsage || usageFor(original);
  for (const [id, quantity] of Object.entries(before)) {
    const units = Math.round(quantity * 100);
    if (units < 0) throw new Error('Định lượng kho của đơn không hợp lệ.');
    const raw = actual.map(x => x[id] || 0), stockWeights = raw.some(Boolean) ? raw : weights;
    allocate(units, stockWeights).forEach((n, i) => { if (n) stock[i][id] = n / 100; });
  }
  const costs = allocate(source.cogs || 0, weights);
  return parts.map((items, i) => ({items, total: weights[i] - pointDiscounts[i] - promo[i] - manual[i], cogs: costs[i],
    first: {...first, subtotal: weights[i], redeemed: redeemed[i], discount: pointDiscounts[i], promoDiscount: promo[i], manualDiscount: manual[i], stockUsage: stock[i]}}));
}

export function mergeHistorical(sources, usageFor) {
  const first = {...sources[0].audit[0]}, items = sources.flatMap(x => x.items);
  if (items.length > 40) throw new Error('Đơn sau khi gộp vượt 40 dòng món.');
  const phones = sources.map(x => String((x.audit[0] || {}).phone || ''));
  if (new Set(phones).size > 1) throw new Error('Chỉ gộp các đơn có cùng số điện thoại tích điểm (hoặc cùng để trống).');
  for (const field of ['subtotal', 'redeemed', 'discount', 'promoDiscount', 'manualDiscount']) first[field] = sources.reduce((n, x) => n + (Number((x.audit[0] || {})[field]) || 0), 0);
  first.subtotal = items.reduce((n, x) => n + x.lineTotal, 0);
  first.stockUsage = {};
  for (const source of sources) for (const [id, qty] of Object.entries(source.audit[0].stockUsage || usageFor(source.items))) first.stockUsage[id] = Math.round(((first.stockUsage[id] || 0) + qty) * 100) / 100;
  first.promoName = [...new Set(sources.map(x => x.audit[0].promoName).filter(Boolean))].join(' + ');
  first.promoId = '';
  first.discountReason = [...new Set(sources.map(x => x.audit[0].discountReason).filter(Boolean))].join('; ');
  return {items, total: sources.reduce((n, x) => n + x.total, 0), cogs: sources.reduce((n, x) => n + (x.cogs || 0), 0), first};
}
