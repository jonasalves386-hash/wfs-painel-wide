const express = require('express');
const cors    = require('cors');
const { getVoos } = require('./services/malhaService');

const app = express();

// ─── CORS ────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://project-0nqla.vercel.app',       // Vercel
  'https://jonasalves386-hash.github.io',    // GitHub Pages
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // Postman, curl, etc.
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS bloqueado para a origem: ${origin}`));
  },
  methods: ['GET'],
}));

// ─── ROTAS ───────────────────────────────────

app.get('/voos', async (req, res) => {
  try {
    const voos = await getVoos();
    res.json(voos);
  } catch (err) {
    res.status(500).json({
      erro: 'Erro ao carregar voos',
      mensagem: err.message,
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = app;