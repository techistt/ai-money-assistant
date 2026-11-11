// Claude tool-use agent. One assistant, four skills: invoicing, shopping checkout, insights, bill splitting.
const Anthropic = require('@anthropic-ai/sdk');
const pay = require('./paypal');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

const SYSTEM = `You are a money assistant built on PayPal (sandbox). You can:
1. INVOICING: create/send invoices from plain-English requests, list invoices, find overdue ones, send reminders.
2. SHOPPING: search the product catalog and create a PayPal checkout link. Never claim a purchase is complete; the user must approve it on PayPal.
3. INSIGHTS: analyze recent PayPal transactions (totals, categories, trends, anomalies) using get_transactions. Do the math carefully from the returned data.
4. SPLIT BILL: when given a receipt image or itemized text, read the items, then call split_bill. Tax and tip are shared in proportion to each person's subtotal.
Rules: confirm missing details (recipient email, amounts) before creating money requests. Ask for confirmation before sending reminders in bulk. Be concise. Mention when results come from mock data (mock: true). Use plain text, short paragraphs.`;

const TOOLS = [
  {
    name: 'create_invoice',
    description: 'Create (and by default send) a PayPal invoice to a recipient.',
    input_schema: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, quantity: { type: 'number' }, unit_price: { type: 'number' } }, required: ['description', 'unit_price'] } },
        currency: { type: 'string' },
        note: { type: 'string' },
        due_in_days: { type: 'number' },
        send: { type: 'boolean' },
      },
      required: ['recipient_email', 'items'],
    },
  },
  { name: 'list_invoices', description: 'List invoices. Optional status filter: SENT, PAID, DRAFT, or overdue.', input_schema: { type: 'object', properties: { status: { type: 'string' } } } },
  {
    name: 'send_reminder',
    description: 'Send a payment reminder for one invoice.',
    input_schema: { type: 'object', properties: { invoice_id: { type: 'string' }, note: { type: 'string', description: 'Polite, short reminder message' } }, required: ['invoice_id', 'note'] },
  },
  { name: 'search_products', description: 'Search the store catalog.', input_schema: { type: 'object', properties: { query: { type: 'string' }, max_price: { type: 'number' } } } },
  {
    name: 'create_checkout',
    description: 'Create a PayPal checkout order for catalog items and return the approval link.',
    input_schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, quantity: { type: 'number' } }, required: ['sku'] } } }, required: ['items'] },
  },
  { name: 'get_transactions', description: 'Fetch recent PayPal transactions (max 31 days). Positive = money in, negative = money out.', input_schema: { type: 'object', properties: { days: { type: 'number' } } } },
  {
    name: 'split_bill',
    description: 'Split an itemized bill among people and send each a PayPal payment request (invoice). Each item is assigned to one or more people (shared items are divided equally). Tax and tip are allocated proportionally.',
    input_schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string' },
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number' }, assigned_to: { type: 'array', items: { type: 'string' }, description: 'Names of people sharing this item' } }, required: ['name', 'price', 'assigned_to'] } },
        tax: { type: 'number' },
        tip: { type: 'number' },
        people: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name', 'email'] } },
        send: { type: 'boolean' },
      },
      required: ['items', 'people'],
    },
  },
];

const round = (n) => Math.round(n * 100) / 100;

// Deterministic split math (kept out of the model on purpose).
function computeSplit({ items, tax = 0, tip = 0, people }) {
  const sub = Object.fromEntries(people.map((p) => [p.name, 0]));
  for (const it of items) {
    const who = it.assigned_to.filter((n) => n in sub);
    if (!who.length) throw new Error(`Item "${it.name}" is not assigned to anyone listed in people`);
    who.forEach((n) => (sub[n] += it.price / who.length));
  }
  const subtotal = Object.values(sub).reduce((a, b) => a + b, 0);
  const shares = people.map((p) => {
    const ratio = subtotal ? sub[p.name] / subtotal : 1 / people.length;
    return { ...p, subtotal: round(sub[p.name]), tax: round(tax * ratio), tip: round(tip * ratio), total: round(sub[p.name] + tax * ratio + tip * ratio) };
  });
  // fix rounding drift on the last person so shares sum to the bill
  const bill = round(subtotal + tax + tip);
  const drift = round(bill - shares.reduce((s, x) => s + x.total, 0));
  shares[shares.length - 1].total = round(shares[shares.length - 1].total + drift);
  return { bill_total: bill, shares };
}

const handlers = {
  create_invoice: (a) => pay.createInvoice(a),
  list_invoices: (a) => pay.listInvoices(a),
  send_reminder: (a) => pay.remindInvoice(a),
  search_products: (a) => pay.searchProducts(a),
  create_checkout: (a) => pay.createCheckout(a),
  get_transactions: (a) => pay.getTransactions(a),
  async split_bill(a) {
    const { bill_total, shares } = computeSplit(a);
    const requests = [];
    for (const s of shares) {
      if (s.total <= 0) continue;
      const inv = await pay.createInvoice({
        recipient_email: s.email,
        items: [{ description: `${s.name}'s share${a.merchant ? ' at ' + a.merchant : ''} (items ${s.subtotal}, tax ${s.tax}, tip ${s.tip})`, quantity: 1, unit_price: s.total }],
        note: 'Bill split via PayPal AI assistant',
        send: a.send !== false,
      });
      requests.push({ person: s.name, amount: s.total, invoice_id: inv.id, url: inv.url, status: inv.status });
    }
    return { bill_total, requests };
  },
};

const sessions = new Map();

async function chat({ sessionId, message, image }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { reply: 'ANTHROPIC_API_KEY is not set. Add it to .env and restart the server.', links: [] };
  }
  const client = new Anthropic();
  const history = sessions.get(sessionId) || [];
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  content.push({ type: 'text', text: message || 'Please split this receipt.' });
  history.push({ role: 'user', content });

  const links = [];
  for (let turn = 0; turn < 8; turn++) {
    const res = await client.messages.create({ model: MODEL, max_tokens: 1500, system: SYSTEM, tools: TOOLS, messages: history });
    history.push({ role: 'assistant', content: res.content });
    if (res.stop_reason !== 'tool_use') {
      sessions.set(sessionId, trim(history));
      const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { reply, links, mock: pay.isMock() };
    }
    const results = [];
    for (const block of res.content.filter((b) => b.type === 'tool_use')) {
      let out, isError = false;
      try {
        out = await handlers[block.name](block.input);
        collectLinks(block.name, out, links);
      } catch (e) {
        out = { error: e.message };
        isError = true;
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out), is_error: isError });
    }
    history.push({ role: 'user', content: results });
  }
  sessions.set(sessionId, trim(history));
  return { reply: 'That took too many steps. Try a simpler request.', links };
}

function collectLinks(tool, out, links) {
  if (tool === 'create_invoice' && out.url) links.push({ label: `Invoice ${out.number} · ${out.amount} ${out.currency}`, url: out.url });
  if (tool === 'create_checkout' && out.approve_url) links.push({ label: `Pay ${out.total} ${out.currency} with PayPal`, url: out.approve_url });
  if (tool === 'split_bill') out.requests.forEach((r) => r.url && links.push({ label: `${r.person} owes ${r.amount}`, url: r.url }));
}

function trim(history) {
  // keep the last 30 messages; drop leading orphaned tool_result messages
  let h = history.slice(-30);
  while (h.length && (h[0].role !== 'user' || (Array.isArray(h[0].content) && h[0].content[0]?.type === 'tool_result'))) h = h.slice(1);
  return h;
}

module.exports = { chat, handlers, computeSplit };
