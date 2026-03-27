require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE (lowdb - file JSON) =====
// Ensure config directory exists (required for Railway deployment)
const configDir = path.join(__dirname, '../config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}
const adapter = new FileSync(path.join(configDir, 'settings.json'));
const db = low(adapter);
db.defaults({
  settings: {
    min_order_amount: 400,
    packaging_rate_low: 2.5,
    packaging_rate_high: 2.0,
    packaging_threshold: 1000,
    warning_message: "Il valore minimo per evadere un ordine B2B è di €400,00. Aggiungi altri prodotti per raggiungere il minimo richiesto.",
    enabled: true
  },
  installations: {}
}).write();

// ===== MIDDLEWARE =====
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'b2bgiardini-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(express.static(path.join(__dirname, '../public')));
app.set('view engine', 'html');

// ===== SHOPIFY CONFIG =====
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES = 'read_validations,write_validations,read_checkout_branding_settings,write_checkout_branding_settings,write_checkouts,read_checkouts,read_orders,write_orders';
const APP_URL = process.env.APP_URL || 'https://localhost:3000';

// ===== OAUTH =====
app.get('/auth', (req, res) => {
  const shop = req.query.shop || 'b2bgiardini.myshopify.com';
  const state = crypto.randomBytes(16).toString('hex');
  req.session.state = state;
  req.session.shop = shop;

  const redirectUri = `${APP_URL}/auth/callback`;
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req, res) => {
  const { shop, state, code, hmac } = req.query;

  // Verifica HMAC
  const params = Object.keys(req.query)
    .filter(k => k !== 'hmac')
    .sort()
    .map(k => `${k}=${req.query[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(params).digest('hex');

  if (digest !== hmac) {
    return res.status(400).send('HMAC validation failed');
  }

  // Scambia code per access token
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      })
    });
    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      // Salva token
      db.set(`installations.${shop.replace(/\./g, '_')}`, {
        shop,
        access_token: tokenData.access_token,
        installed_at: new Date().toISOString()
      }).write();

      req.session.shop = shop;
      req.session.access_token = tokenData.access_token;

      // Installa Cart Validation via Shopify API
      await installCartValidation(shop, tokenData.access_token);

      res.redirect(`/admin?shop=${shop}&installed=1`);
    } else {
      res.status(400).send('Errore durante l\'autenticazione: ' + JSON.stringify(tokenData));
    }
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Errore server durante OAuth');
  }
});

// ===== INSTALLA CART VALIDATION =====
async function installCartValidation(shop, accessToken) {
  const settings = db.get('settings').value();
  const minCents = Math.round(settings.min_order_amount * 100);

  const mutation = `
    mutation validationCreate($input: ValidationCreateInput!) {
      validationCreate(input: $input) {
        validation {
          id
          title
          enabled
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      title: "B2B Ordine Minimo",
      enabled: settings.enabled,
      functionId: null,
      blockOnFailure: true,
      metafields: [
        {
          namespace: "b2b_validator",
          key: "min_order_cents",
          value: String(minCents),
          type: "number_integer"
        },
        {
          namespace: "b2b_validator",
          key: "warning_message",
          value: settings.warning_message,
          type: "single_line_text_field"
        }
      ]
    }
  };

  try {
    const response = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken
      },
      body: JSON.stringify({ query: mutation, variables })
    });
    const data = await response.json();
    console.log('Cart Validation installed:', JSON.stringify(data, null, 2));
    return data;
  } catch (err) {
    console.error('Error installing cart validation:', err);
  }
}

// ===== PANNELLO ADMIN =====
app.get('/admin', (req, res) => {
  const shop = req.query.shop || req.session.shop;
  const installed = req.query.installed;
  const settings = db.get('settings').value();

  const html = `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>B2B Giardini — Pannello Validazione Ordini</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f6f6f7; color: #202223; }
    .header { background: #1a1a2e; color: white; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header .badge { background: #6B7B3A; color: white; padding: 3px 10px; border-radius: 20px; font-size: 12px; }
    .container { max-width: 900px; margin: 32px auto; padding: 0 24px; }
    .card { background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 24px; overflow: hidden; }
    .card-header { padding: 16px 20px; border-bottom: 1px solid #e1e3e5; display: flex; align-items: center; gap: 10px; }
    .card-header h2 { font-size: 15px; font-weight: 600; }
    .card-body { padding: 20px; }
    .form-group { margin-bottom: 20px; }
    .form-group label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #3d4a2a; }
    .form-group input, .form-group textarea { width: 100%; padding: 10px 14px; border: 1px solid #c9cccf; border-radius: 6px; font-size: 14px; transition: border-color 0.2s; }
    .form-group input:focus, .form-group textarea:focus { outline: none; border-color: #6B7B3A; box-shadow: 0 0 0 2px rgba(107,123,58,0.15); }
    .form-group textarea { height: 80px; resize: vertical; }
    .form-group .hint { font-size: 12px; color: #6d7175; margin-top: 4px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 14px 0; border-bottom: 1px solid #f1f2f3; }
    .toggle-row:last-child { border-bottom: none; }
    .toggle-label { font-size: 14px; font-weight: 500; }
    .toggle-desc { font-size: 12px; color: #6d7175; margin-top: 2px; }
    .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: #c9cccf; border-radius: 24px; transition: 0.3s; }
    .slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.3s; }
    input:checked + .slider { background: #6B7B3A; }
    input:checked + .slider:before { transform: translateX(20px); }
    .btn { padding: 10px 24px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .btn-primary { background: #6B7B3A; color: white; }
    .btn-primary:hover { background: #556530; }
    .btn-danger { background: #d82c0d; color: white; }
    .btn-danger:hover { background: #b52a0b; }
    .alert { padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
    .alert-success { background: #e3f1df; border: 1px solid #6B7B3A; color: #3d4a2a; }
    .alert-info { background: #e8f4fd; border: 1px solid #2c6fad; color: #1a3d5c; }
    .preview-box { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 14px 18px; font-size: 14px; color: #5a4000; }
    .preview-box strong { display: block; font-size: 15px; margin-bottom: 4px; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
    .stat-card { background: #f6f6f7; border-radius: 6px; padding: 16px; text-align: center; }
    .stat-card .value { font-size: 28px; font-weight: 700; color: #6B7B3A; }
    .stat-card .label { font-size: 12px; color: #6d7175; margin-top: 4px; }
    .icon { font-size: 18px; }
    @media (max-width: 600px) { .form-row { grid-template-columns: 1fr; } .stats-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="header">
    <span class="icon">🌿</span>
    <h1>i Giardini di Giulia — B2B Validator</h1>
    <span class="badge">Shopify Plus</span>
  </div>

  <div class="container">
    ${installed ? '<div class="alert alert-success">✅ App installata con successo su <strong>' + shop + '</strong>! La validazione ordine minimo è ora attiva.</div>' : ''}

    <div class="card">
      <div class="card-header">
        <span class="icon">📊</span>
        <h2>Stato Attuale</h2>
      </div>
      <div class="card-body">
        <div class="stats-grid">
          <div class="stat-card">
            <div class="value">€${settings.min_order_amount}</div>
            <div class="label">Ordine Minimo</div>
          </div>
          <div class="stat-card">
            <div class="value">${settings.packaging_rate_low}%</div>
            <div class="label">Imballaggio (€400-€${settings.packaging_threshold})</div>
          </div>
          <div class="stat-card">
            <div class="value">${settings.packaging_rate_high}%</div>
            <div class="label">Imballaggio (>€${settings.packaging_threshold})</div>
          </div>
        </div>
      </div>
    </div>

    <form action="/admin/save" method="POST">
      <input type="hidden" name="shop" value="${shop || ''}">

      <div class="card">
        <div class="card-header">
          <span class="icon">🛒</span>
          <h2>Ordine Minimo</h2>
        </div>
        <div class="card-body">
          <div class="toggle-row">
            <div>
              <div class="toggle-label">Validazione attiva</div>
              <div class="toggle-desc">Blocca il checkout se l'ordine non raggiunge il minimo</div>
            </div>
            <label class="toggle">
              <input type="checkbox" name="enabled" value="1" ${settings.enabled ? 'checked' : ''}>
              <span class="slider"></span>
            </label>
          </div>

          <div class="form-group" style="margin-top:16px">
            <label>Importo minimo ordine (€)</label>
            <input type="number" name="min_order_amount" value="${settings.min_order_amount}" min="0" step="10" required>
            <div class="hint">Il cliente non potrà procedere al checkout se il totale è inferiore a questo importo</div>
          </div>

          <div class="form-group">
            <label>Messaggio di avviso al cliente</label>
            <textarea name="warning_message">${settings.warning_message}</textarea>
            <div class="hint">Questo messaggio appare nel checkout quando l'ordine non raggiunge il minimo</div>
          </div>

          <div class="form-group">
            <label>Anteprima avviso</label>
            <div class="preview-box">
              <strong>⚠️ Ordine minimo non raggiunto</strong>
              <span id="preview-msg">${settings.warning_message}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="icon">📦</span>
          <h2>Spese di Imballaggio</h2>
        </div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label>Percentuale imballaggio (€400 – €${settings.packaging_threshold})</label>
              <input type="number" name="packaging_rate_low" value="${settings.packaging_rate_low}" min="0" max="20" step="0.1" required>
              <div class="hint">Es: 2.5 = 2,5%</div>
            </div>
            <div class="form-group">
              <label>Percentuale imballaggio (oltre €${settings.packaging_threshold})</label>
              <input type="number" name="packaging_rate_high" value="${settings.packaging_rate_high}" min="0" max="20" step="0.1" required>
              <div class="hint">Es: 2.0 = 2,0%</div>
            </div>
          </div>
          <div class="form-group">
            <label>Soglia cambio percentuale (€)</label>
            <input type="number" name="packaging_threshold" value="${settings.packaging_threshold}" min="0" step="100" required>
            <div class="hint">Sopra questa soglia si applica la percentuale ridotta</div>
          </div>
        </div>
      </div>

      <div style="display:flex; gap:12px; justify-content:flex-end; margin-bottom:32px;">
        <button type="submit" class="btn btn-primary">💾 Salva Impostazioni</button>
      </div>
    </form>

    <div class="card">
      <div class="card-header">
        <span class="icon">🔗</span>
        <h2>Installazione</h2>
      </div>
      <div class="card-body">
        <div class="alert alert-info">
          <strong>Store collegato:</strong> ${shop || 'b2bgiardini.myshopify.com'}<br>
          <strong>URL App:</strong> ${APP_URL}
        </div>
        <a href="/auth?shop=${shop || 'b2bgiardini.myshopify.com'}" class="btn btn-primary">🔄 Reinstalla / Aggiorna permessi</a>
      </div>
    </div>
  </div>

  <script>
    document.querySelector('[name="warning_message"]').addEventListener('input', function() {
      document.getElementById('preview-msg').textContent = this.value;
    });
  </script>
</body>
</html>`;

  res.send(html);
});

// ===== SALVA IMPOSTAZIONI =====
app.post('/admin/save', async (req, res) => {
  const { shop, min_order_amount, packaging_rate_low, packaging_rate_high, packaging_threshold, warning_message, enabled } = req.body;

  db.set('settings', {
    min_order_amount: parseFloat(min_order_amount) || 400,
    packaging_rate_low: parseFloat(packaging_rate_low) || 2.5,
    packaging_rate_high: parseFloat(packaging_rate_high) || 2.0,
    packaging_threshold: parseFloat(packaging_threshold) || 1000,
    warning_message: warning_message || 'Il valore minimo per evadere un ordine B2B è di €400,00.',
    enabled: enabled === '1'
  }).write();

  // Aggiorna la Cart Validation su Shopify se abbiamo il token
  const shopKey = (shop || 'b2bgiardini.myshopify.com').replace(/\./g, '_');
  const installation = db.get(`installations.${shopKey}`).value();
  if (installation && installation.access_token) {
    await updateCartValidation(installation.shop, installation.access_token);
  }

  res.redirect(`/admin?shop=${shop || 'b2bgiardini.myshopify.com'}&saved=1`);
});

// ===== AGGIORNA CART VALIDATION =====
async function updateCartValidation(shop, accessToken) {
  const settings = db.get('settings').value();
  const minCents = Math.round(settings.min_order_amount * 100);

  // Prima ottieni l'ID della validation esistente
  const listQuery = `{
    validations(first: 10) {
      nodes {
        id
        title
        enabled
      }
    }
  }`;

  try {
    const listRes = await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: listQuery })
    });
    const listData = await listRes.json();
    const validations = listData?.data?.validations?.nodes || [];
    const existing = validations.find(v => v.title === 'B2B Ordine Minimo');

    if (existing) {
      const updateMutation = `
        mutation validationUpdate($id: ID!, $input: ValidationUpdateInput!) {
          validationUpdate(id: $id, input: $input) {
            validation { id title enabled }
            userErrors { field message }
          }
        }
      `;
      await fetch(`https://${shop}/admin/api/2024-10/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({
          query: updateMutation,
          variables: {
            id: existing.id,
            input: {
              enabled: settings.enabled,
              metafields: [
                { namespace: "b2b_validator", key: "min_order_cents", value: String(minCents), type: "number_integer" },
                { namespace: "b2b_validator", key: "warning_message", value: settings.warning_message, type: "single_line_text_field" }
              ]
            }
          }
        })
      });
    }
  } catch (err) {
    console.error('Error updating cart validation:', err);
  }
}

// ===== WEBHOOK: ORDERS CREATE (per validazione ordine minimo) =====
app.post('/webhooks/orders/create', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const body = req.body;

  const digest = crypto.createHmac('sha256', SHOPIFY_API_SECRET).update(body).digest('base64');
  if (digest !== hmac) {
    return res.status(401).send('Unauthorized');
  }

  const order = JSON.parse(body);
  const settings = db.get('settings').value();
  const minCents = Math.round(settings.min_order_amount * 100);

  console.log(`Nuovo ordine: #${order.order_number}, totale: ${order.total_price_set?.shop_money?.amount}`);

  res.status(200).send('OK');
});

// ===== API: OTTIENI IMPOSTAZIONI (per uso dal tema) =====
app.get('/api/settings', (req, res) => {
  const settings = db.get('settings').value();
  res.json({
    min_order_amount: settings.min_order_amount,
    min_order_cents: Math.round(settings.min_order_amount * 100),
    packaging_rate_low: settings.packaging_rate_low,
    packaging_rate_high: settings.packaging_rate_high,
    packaging_threshold: settings.packaging_threshold,
    warning_message: settings.warning_message,
    enabled: settings.enabled
  });
});

// ===== HOME =====
app.get('/', (req, res) => {
  res.redirect('/admin?shop=b2bgiardini.myshopify.com');
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🌿 B2B Giardini Validator avviato su porta ${PORT}`);
  console.log(`📦 Pannello admin: http://localhost:${PORT}/admin`);
});
