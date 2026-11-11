// Thin PayPal sandbox client. Falls back to an in-memory mock when no credentials are set,
// so the whole app can be demoed without keys.
const BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

function isMock() {
  return !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET;
}

let cached = null;
async function getToken() {
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return cached.token;
}

async function pp(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${text.slice(0, 400)}`);
  return data;
}

// ---------- mock store ----------
const mockInvoices = [
  { id: 'INV2-MOCK-0001', number: '0001', status: 'SENT', recipient: 'acme@example.com', amount: '480.00', currency: 'USD', due: daysFromNow(-6), url: `${APP_URL}/mock/invoice/INV2-MOCK-0001` },
  { id: 'INV2-MOCK-0002', number: '0002', status: 'PAID', recipient: 'studio@example.com', amount: '1200.00', currency: 'USD', due: daysFromNow(-20), url: `${APP_URL}/mock/invoice/INV2-MOCK-0002` },
  { id: 'INV2-MOCK-0003', number: '0003', status: 'SENT', recipient: 'jo@example.com', amount: '95.50', currency: 'USD', due: daysFromNow(-2), url: `${APP_URL}/mock/invoice/INV2-MOCK-0003` },
];
const mockTransactions = [
  ['Coffee Roasters', -18.4, 'Food & Drink', 1], ['Acme Corp invoice 0002', 1200, 'Income', 3], ['Cloud hosting', -42, 'Software', 4],
  ['Print Shop', -63.25, 'Office', 7], ['Studio payment', 350, 'Income', 9], ['Cloud hosting', -42, 'Software', 12],
  ['Train tickets', -76, 'Travel', 15], ['Jo refund', -25, 'Other', 18], ['Design client', 800, 'Income', 21], ['Coffee Roasters', -22.1, 'Food & Drink', 24],
].map(([name, amount, category, d]) => ({ date: daysFromNow(-d), name, amount, category, currency: 'USD' }));

function daysFromNow(n) {
  return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
}

// ---------- invoices ----------
async function createInvoice({ recipient_email, items, currency = 'USD', note, due_in_days = 14, send = true }) {
  const total = items.reduce((s, i) => s + Number(i.unit_price) * Number(i.quantity || 1), 0).toFixed(2);
  if (isMock()) {
    const id = `INV2-MOCK-${String(mockInvoices.length + 1).padStart(4, '0')}`;
    const inv = { id, number: String(mockInvoices.length + 1).padStart(4, '0'), status: send ? 'SENT' : 'DRAFT', recipient: recipient_email, amount: total, currency, due: daysFromNow(due_in_days), url: `${APP_URL}/mock/invoice/${id}` };
    mockInvoices.push(inv);
    return { mock: true, ...inv };
  }
  const { invoice_number } = await pp('POST', '/v2/invoicing/generate-next-invoice-number');
  const created = await pp('POST', '/v2/invoicing/invoices', {
    detail: {
      invoice_number,
      currency_code: currency,
      note: note || undefined,
      payment_term: { term_type: 'NET_' + ([10, 15, 30, 45, 60, 90].find((d) => d >= due_in_days) || 30) },
    },
    primary_recipients: [{ billing_info: { email_address: recipient_email } }],
    items: items.map((i) => ({
      name: i.description,
      quantity: String(i.quantity || 1),
      unit_amount: { currency_code: currency, value: Number(i.unit_price).toFixed(2) },
    })),
  });
  const id = created.href.split('/').pop();
  if (send) await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true, send_to_invoicer: false });
  const full = await pp('GET', `/v2/invoicing/invoices/${id}`);
  return {
    id, number: invoice_number, status: full.status, recipient: recipient_email, amount: total, currency,
    url: full.detail?.metadata?.recipient_view_url || full.detail?.metadata?.invoicer_view_url,
  };
}

async function listInvoices({ status } = {}) {
  let rows;
  if (isMock()) {
    rows = mockInvoices.map((i) => ({ ...i, overdue: i.status === 'SENT' && i.due < daysFromNow(0) }));
  } else {
    const r = await pp('GET', '/v2/invoicing/invoices?page=1&page_size=50&total_required=true');
    rows = (r.items || []).map((i) => ({
      id: i.id, number: i.detail.invoice_number, status: i.status,
      recipient: i.primary_recipients?.[0]?.billing_info?.email_address,
      amount: i.amount?.value, currency: i.amount?.currency_code, due: i.detail.payment_term?.due_date,
      url: i.detail?.metadata?.recipient_view_url,
      overdue: ['SENT', 'UNPAID'].includes(i.status) && i.detail.payment_term?.due_date < daysFromNow(0),
    }));
  }
  return status ? rows.filter((r) => r.status === status.toUpperCase() || (status === 'overdue' && r.overdue)) : rows;
}

async function remindInvoice({ invoice_id, note }) {
  if (isMock()) {
    const inv = mockInvoices.find((i) => i.id === invoice_id);
    if (!inv) throw new Error('Invoice not found');
    return { mock: true, invoice_id, reminded: inv.recipient, note };
  }
  await pp('POST', `/v2/invoicing/invoices/${invoice_id}/remind`, { subject: 'Friendly payment reminder', note, send_to_invoicer: false });
  return { invoice_id, reminded: true, note };
}

// ---------- checkout ----------
const CATALOG = [
  { sku: 'hp-100', name: 'Wireless Headphones', price: 59.0, category: 'electronics' },
  { sku: 'kb-210', name: 'Mechanical Keyboard', price: 89.0, category: 'electronics' },
  { sku: 'ms-050', name: 'Ergonomic Mouse', price: 34.5, category: 'electronics' },
  { sku: 'bk-007', name: 'Notebook 3-pack', price: 12.0, category: 'office' },
  { sku: 'ds-300', name: 'Standing Desk Mat', price: 45.0, category: 'office' },
  { sku: 'wb-020', name: 'Insulated Water Bottle', price: 22.0, category: 'outdoors' },
  { sku: 'bp-440', name: 'Daypack 20L', price: 64.0, category: 'outdoors' },
];

function searchProducts({ query = '', max_price }) {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  return CATALOG.filter((p) => (!max_price || p.price <= max_price) &&
    (q.length === 0 || q.some((w) => (p.name + ' ' + p.category).toLowerCase().includes(w))));
}

async function createCheckout({ items, currency = 'USD' }) {
  const lines = items.map((i) => {
    const p = CATALOG.find((c) => c.sku === i.sku);
    if (!p) throw new Error(`Unknown sku ${i.sku}`);
    return { ...p, quantity: i.quantity || 1 };
  });
  const total = lines.reduce((s, l) => s + l.price * l.quantity, 0).toFixed(2);
  if (isMock()) return { mock: true, order_id: 'ORDER-MOCK-' + Date.now(), total, currency, lines, approve_url: `${APP_URL}/mock/checkout` };
  const order = await pp('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: { currency_code: currency, value: total, breakdown: { item_total: { currency_code: currency, value: total } } },
      items: lines.map((l) => ({ name: l.name, sku: l.sku, quantity: String(l.quantity), unit_amount: { currency_code: currency, value: l.price.toFixed(2) } })),
    }],
    payment_source: { paypal: { experience_context: { return_url: `${APP_URL}/?paid=1`, cancel_url: `${APP_URL}/?cancelled=1`, user_action: 'PAY_NOW' } } },
  });
  const approve = (order.links || []).find((l) => ['payer-action', 'approve'].includes(l.rel));
  return { order_id: order.id, total, currency, lines, approve_url: approve?.href };
}

// ---------- insights ----------
async function getTransactions({ days = 30 } = {}) {
  days = Math.min(days, 31); // PayPal reporting API window limit
  if (isMock()) return mockTransactions.filter((t) => t.date >= daysFromNow(-days));
  const end = new Date(), start = new Date(Date.now() - days * 86400000);
  const r = await pp('GET', `/v1/reporting/transactions?start_date=${start.toISOString().replace(/\.\d+Z$/, '-0000')}&end_date=${end.toISOString().replace(/\.\d+Z$/, '-0000')}&fields=transaction_info,payer_info&page_size=100`);
  return (r.transaction_details || []).map((t) => ({
    date: t.transaction_info.transaction_initiation_date?.slice(0, 10),
    name: t.payer_info?.payer_name?.alternate_full_name || t.transaction_info.transaction_subject || t.transaction_info.transaction_event_code,
    amount: Number(t.transaction_info.transaction_amount?.value),
    currency: t.transaction_info.transaction_amount?.currency_code,
    category: t.transaction_info.transaction_event_code,
  }));
}

module.exports = { isMock, createInvoice, listInvoices, remindInvoice, searchProducts, createCheckout, getTransactions, CATALOG };
