import 'dotenv/config';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketServer } from 'socket.io';
import { config } from './config.js';
import { pool } from './db.js';
import { createRouter } from './routes.js';
import { HttpError } from './errors.js';
import { processExpiredLots } from './auction-service.js';
import { attachAuctionSockets } from './realtime.js';

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
    },
  },
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== config.appOrigin) return res.status(403).json({ error: { code: 'ORIGIN_FORBIDDEN', message: 'Origem não autorizada.' } });
  next();
});
app.use('/api', rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false }));
app.use('/api/auth/register', rateLimit({ windowMs: 60 * 60_000, limit: 6, standardHeaders: 'draft-8', legacyHeaders: false }));

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  connectionStateRecovery: { maxDisconnectionDuration: 120_000, skipMiddlewares: true },
  cors: { origin: config.appOrigin, credentials: true },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    callback(null, !origin || origin === config.appOrigin);
  },
});

attachAuctionSockets(io);

app.use('/api', createRouter(io));
app.get('/api/health', (_req, res) => res.json({ ok: true }));

const webDist = join(process.cwd(), 'dist', 'web');
if (process.env.NODE_ENV === 'production' || existsSync(webDist)) {
  app.use(express.static(webDist, { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.sendFile(join(webDist, 'index.html'));
  });
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'O corpo da solicitação contém JSON inválido.' } });
  }
  console.error('Erro não tratado na API:', error instanceof Error ? error.message : 'erro desconhecido');
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Não foi possível concluir a solicitação.' } });
});

let workerRunning = false;
async function runSettlementWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try { await processExpiredLots(io); }
  catch (error) { console.error('Falha no ciclo de liquidação:', error instanceof Error ? error.message : 'erro desconhecido'); }
  finally { workerRunning = false; }
}

httpServer.listen(config.port, () => {
  console.log(`Casa de Leilões disponível na porta ${config.port}.`);
  void pool.query('SELECT 1').then(() => runSettlementWorker()).catch((error) => {
    console.error('Banco indisponível ao iniciar:', error instanceof Error ? error.message : 'erro desconhecido');
  });
});
const settlementTimer = setInterval(() => { void runSettlementWorker(); }, 5_000);
settlementTimer.unref();

async function shutdown() {
  clearInterval(settlementTimer);
  io.close();
  httpServer.close(() => { void pool.end().finally(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
