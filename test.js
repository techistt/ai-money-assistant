// Offline smoke test: runs the tool handlers in mock mode and checks the split math.
delete process.env.PAYPAL_CLIENT_ID;
delete process.env.PAYPAL_CLIENT_SECRET;
const assert = require('assert');
const { handlers, computeSplit } = require('./agent');

(async () => {
  // split math: $96 dinner, 8.5% tax, 18% tip, 3 people equal
  const people = [{ name: 'Me', email: 'me@example.com' }, { name: 'Sam', email: 'sam@example.com' }, { name: 'Alex', email: 'alex@example.com' }];
  const s = computeSplit({ items: [{ name: 'Dinner', price: 96, assigned_to: ['Me', 'Sam', 'Alex'] }], tax: 8.16, tip: 17.28, people });
  assert.strictEqual(s.bill_total, 121.44);
  assert.strictEqual(Number(s.shares.reduce((a, x) => a + x.total, 0).toFixed(2)), 121.44);

  // uneven split
  const u = computeSplit({ items: [{ name: 'Steak', price: 40, assigned_to: ['Me'] }, { name: 'Salad', price: 10, assigned_to: ['Sam'] }], tax: 5, tip: 0, people: people.slice(0, 2) });
  assert.strictEqual(u.shares[0].total, 44);
  assert.strictEqual(u.shares[1].total, 11);

  // handlers in mock mode
  const inv = await handlers.create_invoice({ recipient_email: 'x@example.com', items: [{ description: 'Design', quantity: 3, unit_price: 80 }] });
  assert.strictEqual(inv.amount, '240.00');
  const overdue = await handlers.list_invoices({ status: 'overdue' });
  assert.ok(overdue.length >= 2);
  const rem = await handlers.send_reminder({ invoice_id: overdue[0].id, note: 'Hi!' });
  assert.ok(rem.reminded);
  const found = await handlers.search_products({ query: 'headphones', max_price: 70 });
  assert.strictEqual(found[0].sku, 'hp-100');
  const co = await handlers.create_checkout({ items: [{ sku: 'hp-100', quantity: 1 }] });
  assert.strictEqual(co.total, '59.00');
  const tx = await handlers.get_transactions({ days: 30 });
  assert.ok(tx.length > 5);
  const split = await handlers.split_bill({ merchant: 'Bistro', items: [{ name: 'Dinner', price: 96, assigned_to: ['Me', 'Sam', 'Alex'] }], tax: 8.16, tip: 17.28, people });
  assert.strictEqual(split.requests.length, 3);
  console.log('All tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
