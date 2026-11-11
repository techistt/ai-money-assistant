# PayPal AI Money Assistant

One chat assistant that handles four money jobs using the **PayPal sandbox** and **Claude**:

| Skill | What it does | PayPal API |
|---|---|---|
| Invoicing | "Invoice acme@example.com for 3 hours at $80" creates and sends an invoice; finds overdue invoices and sends reminders | Invoicing v2 |
| Shopping | Searches a catalog by intent and budget, then creates a PayPal checkout link | Orders v2 |
| Insights | Analyzes the last 30 days of activity: income, spending by category, anomalies | Transaction Search (reporting) |
| Split bill | Reads a receipt photo or itemized text, splits items, tax and tip fairly, and sends each person a payment request | Invoicing v2 |

## How the AI is used

- **Model:** Claude (`claude-sonnet-5-5` by default, override with `ANTHROPIC_MODEL`) through the Anthropic SDK.
- **Tool use:** Claude decides which PayPal action to run (`agent.js`), asks for missing details, and explains results.
- **Vision:** receipt photos are read by Claude and turned into itemized line items.
- **Guardrails:** bill-split math is computed in code (not by the model) so shares always add up to the bill. Checkout never completes without the user approving on PayPal.

## Run it

Requires Node 18+.

```bash
npm install
cp .env.example .env     # then fill in keys
npm start                # http://localhost:3000
```

- `ANTHROPIC_API_KEY`: required for the chat.
- `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`: from a sandbox app at https://developer.paypal.com/dashboard/applications/sandbox. **If left blank the app runs in mock mode** with sample invoices and transactions, so you can try every flow without keys. The header badge shows `PayPal: mock` or `PayPal: sandbox`.

Try the shortcut chips in the UI, or attach a receipt photo with the camera button and tell it who shared what.

## Test

```bash
npm test
```

Runs offline in mock mode: split math, invoice creation, overdue detection, reminders, product search, checkout and transaction fetch.

## Project layout

- `server.js`: Express server and `/api/chat`
- `agent.js`: Claude tool-use loop, tool definitions, split-bill math
- `paypal.js`: PayPal sandbox client with mock fallback
- `public/index.html`: chat UI

## Notes

- Sandbox only. The Transaction Search API covers up to 31 days per request.
- Conversation history is kept in memory per browser session.

License: MIT
