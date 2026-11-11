require('dotenv').config();
const express = require('express');
const path = require('path');
const { chat } = require('./agent');
const pay = require('./paypal');

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (_req, res) => res.json({ paypal: pay.isMock() ? 'mock' : 'sandbox', ai: !!process.env.ANTHROPIC_API_KEY }));

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId = 'default', message, image } = req.body;
    res.json(await chat({ sessionId, message, image }));
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: `Something went wrong: ${e.message}`, links: [] });
  }
});

// Simple pages so mock-mode links land somewhere sensible.
app.get('/mock/invoice/:id', (req, res) => res.send(`<body style="font-family:sans-serif;padding:2rem"><h2>Mock invoice ${req.params.id}</h2><p>Add PayPal sandbox keys to .env to create real sandbox invoices.</p>`));
app.get('/mock/checkout', (_req, res) => res.send('<body style="font-family:sans-serif;padding:2rem"><h2>Mock checkout</h2><p>Add PayPal sandbox keys to .env to get a real PayPal approval page.</p>'));

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`Running on http://localhost:${port}  (PayPal: ${pay.isMock() ? 'MOCK' : 'sandbox'})`));
module.exports = app;
