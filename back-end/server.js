require('dotenv').config();

const app = require('./src/app');

const PORT = process.env.PORT || 3000;

// Only start the HTTP server when run directly (local dev).
// When imported by Vercel's serverless runtime, it uses module.exports instead.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

module.exports = app;
