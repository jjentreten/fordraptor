require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;

const BRUTALCASH_PUBLIC_KEY = (process.env.BRUTALCASH_PUBLIC_KEY || '').trim();
const BRUTALCASH_SECRET_KEY = (process.env.BRUTALCASH_SECRET_KEY || '').trim();
const SITE_URL              = (process.env.SITE_URL || '').replace(/\/$/, '');
const UTMIFY_TOKEN          = (process.env.UTMIFY_API_TOKEN || '').trim();

const BRUTALCASH_CREATE_URL = 'https://api.brutalcash.com/v1/payment-transaction/create';
const BRUTALCASH_GET_URL    = 'https://api.brutalcash.com/v1/payment-transaction';
const UTMIFY_URL            = 'https://api.utmify.com.br/api-credentials/orders';
const PENDING_FILE          = path.join(__dirname, 'data', 'pending-utmify-orders.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ─── Utmify helpers ───────────────────────────────────────────────────────────
function ensureDataDir() {
  const dir = path.join(__dirname, 'data');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readPending() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')) || []; }
  catch (_) { return []; }
}

function writePending(list) {
  ensureDataDir();
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list), 'utf8');
}

function toUtc(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getUTCFullYear()
    + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
    + '-' + String(d.getUTCDate()).padStart(2, '0')
    + ' ' + String(d.getUTCHours()).padStart(2, '0')
    + ':' + String(d.getUTCMinutes()).padStart(2, '0')
    + ':' + String(d.getUTCSeconds()).padStart(2, '0');
}

function buildUtmifyPayload({ orderId, status, createdAt, approvedDate, customer, amountCents, qty, utms }) {
  const gatewayFee       = Math.round(amountCents * 0.01);
  const userCommission   = Math.max(1, amountCents - gatewayFee);
  return {
    orderId:       String(orderId),
    platform:      'MoedaMilionaria',
    paymentMethod: 'pix',
    status,
    createdAt,
    approvedDate:  approvedDate || null,
    refundedAt:    null,
    customer: {
      name:     customer.name,
      email:    customer.email,
      phone:    customer.phone  || null,
      document: customer.document || null,
      country:  'BR',
      ip:       customer.ip || '0.0.0.0',
    },
    products: [{
      id:          'ford-raptor-dos-sonhos',
      name:        'Ford Raptor dos Sonhos',
      planId:      null,
      planName:    null,
      quantity:    qty,
      priceInCents: amountCents,
    }],
    trackingParameters: {
      src:          utms?.src          ?? null,
      sck:          utms?.sck          ?? null,
      utm_source:   utms?.utm_source   ?? null,
      utm_campaign: utms?.utm_campaign ?? null,
      utm_medium:   utms?.utm_medium   ?? null,
      utm_content:  utms?.utm_content  ?? null,
      utm_term:     utms?.utm_term     ?? null,
    },
    commission: {
      totalPriceInCents:    amountCents,
      gatewayFeeInCents:    gatewayFee,
      userCommissionInCents: userCommission,
    },
  };
}

async function sendUtmify(payload) {
  if (!UTMIFY_TOKEN) return;
  try {
    const res = await fetch(UTMIFY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-token': UTMIFY_TOKEN },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.error('[Utmify] Erro', res.status, await res.text());
    else console.log(`[Utmify] orderId=${payload.orderId} status=${payload.status}`);
  } catch (err) {
    console.error('[Utmify] Falha:', err.message);
  }
}

function clientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || req.ip || '0.0.0.0';
  return raw.replace(/^::ffff:/, '');
}

// ─── Criar transação PIX ──────────────────────────────────────────────────────
app.post('/api/criar-pix', async (req, res) => {
  const { name, cpf, email, phone, qty, total, utms } = req.body;

  if (!name || !cpf || !email || !phone || !qty || !total) {
    return res.status(400).json({ success: false, error: 'Dados incompletos' });
  }
  if (!BRUTALCASH_PUBLIC_KEY || !BRUTALCASH_SECRET_KEY) {
    return res.status(500).json({ success: false, error: 'Gateway não configurado no servidor' });
  }

  const auth         = 'Basic ' + Buffer.from(`${BRUTALCASH_PUBLIC_KEY}:${BRUTALCASH_SECRET_KEY}`).toString('base64');
  const amountCents  = Math.round(parseFloat(total) * 100);
  const cpfDigits    = cpf.replace(/\D/g, '');
  const phoneDigits  = '55' + phone.replace(/\D/g, '');
  const postback_url = SITE_URL ? `${SITE_URL}/api/webhook-brutalcash` : undefined;

  const payload = {
    payment_method: 'pix',
    customer: {
      document: { type: 'cpf', number: cpfDigits },
      name, email, phone: phoneDigits,
    },
    items: [{ title: 'Ford Raptor dos Sonhos', unit_price: amountCents, quantity: 1 }],
    amount: amountCents,
    postback_url,
    metadata: { provider_name: 'Ford Raptor dos Sonhos' },
  };

  try {
    const response = await fetch(BRUTALCASH_CREATE_URL, {
      method:  'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const result = await response.json();

    if (!result.success) {
      const msgs   = result.error_messages;
      const errMsg = (Array.isArray(msgs) && msgs[0]) || result.inner_exception || 'Erro ao criar PIX';
      console.error('[BrutalCash] Falha:', JSON.stringify(result, null, 2));
      return res.status(400).json({ success: false, error: String(errMsg) });
    }

    const { id, pix } = result.data;
    const createdAt   = toUtc(new Date());
    console.log(`[PIX] Criado: ${id}`);

    // Envia waiting_payment para Utmify
    if (UTMIFY_TOKEN) {
      const utmPayload = buildUtmifyPayload({
        orderId: id, status: 'waiting_payment', createdAt, approvedDate: null,
        customer: { name, email, phone: phoneDigits, document: cpfDigits, ip: clientIp(req) },
        amountCents, qty: parseInt(qty), utms: utms || {},
      });
      await sendUtmify(utmPayload);

      // Salva para atualizar quando o webhook confirmar o pagamento
      const pending = readPending();
      pending.push({ transactionId: id, createdAt, utmPayload });
      writePending(pending);
    }

    return res.json({
      success:         true,
      transaction_id:  id,
      qr_code:         pix.qr_code,
      expiration_date: pix.expiration_date,
      amount:          result.data.amount,
    });

  } catch (err) {
    console.error('[Server] Erro:', err.message);
    return res.status(500).json({ success: false, error: 'Erro interno do servidor' });
  }
});

// ─── Webhook BrutalCash ───────────────────────────────────────────────────────
app.post('/api/webhook-brutalcash', (req, res) => {
  const body   = req.body;
  const id     = body.Id     || body.id;
  const status = (body.Status || body.status || '').toUpperCase();
  console.log(`[Webhook] id=${id} status=${status}`);

  if (status === 'PAID' && id) {
    const pending = readPending();
    const idx     = pending.findIndex(p => String(p.transactionId) === String(id));
    if (idx !== -1) {
      const row         = pending[idx];
      const approvedDate = body.PaidAt ? toUtc(new Date(body.PaidAt)) : toUtc(new Date());
      const paidPayload  = { ...row.utmPayload, status: 'paid', approvedDate };
      sendUtmify(paidPayload).then(() => {
        pending.splice(idx, 1);
        writePending(pending);
        console.log(`[Utmify] orderId=${id} atualizado para paid`);
      });
    }
  }
  res.status(200).send('OK');
});

// ─── Consultar status da transação ───────────────────────────────────────────
app.get('/api/pix-status/:transactionId', async (req, res) => {
  const { transactionId } = req.params;
  if (!transactionId) return res.status(400).json({ status: 'unknown' });

  const auth = 'Basic ' + Buffer.from(`${BRUTALCASH_PUBLIC_KEY}:${BRUTALCASH_SECRET_KEY}`).toString('base64');
  try {
    const response = await fetch(`${BRUTALCASH_GET_URL}/${encodeURIComponent(transactionId)}`, {
      headers: { Authorization: auth },
    });
    const raw    = response.ok ? await response.json() : null;
    const data   = raw?.data || raw;
    const status = (data?.status || data?.Status || 'unknown').toUpperCase();
    return res.json({ status: status === 'PAID' ? 'paid' : 'pending' });
  } catch (err) {
    console.error('[pix-status]', err.message);
    return res.status(500).json({ status: 'unknown' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  if (!BRUTALCASH_PUBLIC_KEY || !BRUTALCASH_SECRET_KEY) {
    console.warn('AVISO: BRUTALCASH_* não configurados no .env');
  } else {
    console.log('BrutalCash: ativo');
  }
  if (UTMIFY_TOKEN) {
    console.log('Utmify: ativo — pedidos serão enviados ao painel');
  } else {
    console.warn('AVISO: UTMIFY_API_TOKEN não configurado — tracking desativado');
  }
  if (SITE_URL) {
    console.log(`Webhook: ${SITE_URL}/api/webhook-brutalcash`);
  } else {
    console.warn('AVISO: SITE_URL não configurado — postback desativado (ok para dev local)');
  }
});
