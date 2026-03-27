# B2B Giardini Validator — App Shopify

App Shopify Plus per la validazione degli ordini B2B di **i Giardini di Giulia**.

## Funzionalità

- **Blocco checkout** sotto importo minimo configurabile (default €400)
- **Spese di imballaggio** automatiche a percentuale crescente (2,5% fino a €1.000, 2% oltre)
- **Pannello admin** per modificare tutte le impostazioni senza toccare il codice
- **Messaggio personalizzabile** mostrato al cliente quando l'ordine non raggiunge il minimo

## Setup Railway

### 1. Variabili d'ambiente su Railway
Imposta queste variabili nel pannello Railway → Variables:

```
SHOPIFY_API_KEY=your_api_key_here
SHOPIFY_API_SECRET=your_api_secret_here
SESSION_SECRET=b2bgiardini-session-secret-2025-xyz
APP_URL=https://TUO-PROGETTO.railway.app
PORT=3000
```

### 2. Shopify Partners — URL da configurare
Dopo il deploy su Railway, aggiorna nel pannello Shopify Partners:
- **URL app**: `https://TUO-PROGETTO.railway.app`
- **URL di reindirizzamento consentiti**: `https://TUO-PROGETTO.railway.app/auth/callback`

### 3. Installa l'app sullo store
Vai su: `https://TUO-PROGETTO.railway.app/auth?shop=b2bgiardini.myshopify.com`

## Pannello Admin
Accessibile su: `https://TUO-PROGETTO.railway.app/admin`

## API
- `GET /api/settings` — Restituisce le impostazioni correnti (usabile dal tema Liquid)
