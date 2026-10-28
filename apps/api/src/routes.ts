import { randomBytes, randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import type { Server as SocketServer } from 'socket.io';
import { pool, transaction, cents } from './db.js';
import { config } from './config.js';
import { clearSessionCookie, optionalAuth, requireAuth, requireRole, setSessionCookie, type SessionUser } from './auth.js';
import { HttpError } from './errors.js';
import { getProduct, searchProducts } from './external-api.js';
import { signHead, verifyAudit, ZERO_HASH } from './audit.js';
import { placeBid, publishLotUpdate } from './auction-service.js';
import { lotState } from './auction-rules.js';

const uuidSchema = z.string().uuid();
const userSchema = z.object({ displayName: z.string().trim().min(2).max(80), email: z.string().trim().email().max(254), password: z.string().min(10).max(100) }).strict();
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(100) });
const lotSchema = z.object({
  productId: z.number().int().positive(),
  title: z.string().trim().min(3).max(180).optional(),
  description: z.string().trim().max(4000).optional(),
  imageUrl: z.string().url().max(1000).optional(),
  startingCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  incrementCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
});
const depositSchema = z.object({ amountCents: z.number().int().min(100).max(10_000_000) });
const bidSchema = z.object({ amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

function asUser(row: any): SessionUser {
  return { id: row.id, publicId: row.public_id, displayName: row.display_name, email: row.email, role: row.role };
}

function centsFields(row: any) {
  return {
    startingCents: cents(row.starting_cents),
    incrementCents: cents(row.increment_cents),
    currentBidCents: cents(row.current_bid_cents),
    finalCents: cents(row.final_cents),
  };
}

function validate<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Dados inválidos.', 'VALIDATION_ERROR');
  return result.data;
}

function uuidParam(req: Request, name: string) {
  const value = req.params[name];
  if (typeof value !== 'string' || !uuidSchema.safeParse(value).success) throw new HttpError(404, 'Lote não encontrado.', 'LOT_NOT_FOUND');
  return value;
}

function randomPublicId() {
  return `L-${randomBytes(5).toString('hex').toUpperCase()}`;
}

export function createRouter(io: SocketServer) {
  const router = Router();
  router.use(optionalAuth);

  router.get('/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'verzel-leiloes', time: new Date().toISOString() });
  });

  router.post('/auth/register', async (req, res) => {
    const data = validate(userSchema, req.body);
    const id = randomUUID();
    const hash = await bcrypt.hash(data.password, 12);
    const publicId = randomPublicId();
    try {
      await transaction(async (client) => {
        await client.query("INSERT INTO users (id,public_id,display_name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,'BIDDER')", [id, publicId, data.displayName, data.email.toLowerCase(), hash]);
        await client.query('INSERT INTO wallets (user_id) VALUES ($1)', [id]);
      });
    } catch (error: any) {
      if (error?.code === '23505') throw new HttpError(409, 'Já existe uma conta com este e-mail.', 'EMAIL_EXISTS');
      throw error;
    }
    const user = { id, publicId, displayName: data.displayName, email: data.email.toLowerCase(), role: 'BIDDER' } as SessionUser;
    setSessionCookie(res, user);
    res.status(201).json({ user });
  });

  router.post('/auth/login', async (req, res) => {
    const data = validate(loginSchema, req.body);
    const { rows: [row] } = await pool.query('SELECT * FROM users WHERE email=$1', [data.email.toLowerCase()]);
    if (!row || !(await bcrypt.compare(data.password, row.password_hash))) throw new HttpError(401, 'E-mail ou senha inválidos.', 'INVALID_CREDENTIALS');
    const user = asUser(row);
    setSessionCookie(res, user);
    res.json({ user });
  });

  router.post('/auth/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

  router.get('/auth/me', async (req, res) => {
    if (!req.user) return res.json({ user: null });
    const { rows: [row] } = await pool.query('SELECT id,public_id,display_name,email,role FROM users WHERE id=$1', [req.user.id]);
    if (!row) { clearSessionCookie(res); return res.json({ user: null }); }
    res.json({ user: asUser(row) });
  });

  router.get('/lots', async (req, res) => {
    const { rows } = await pool.query(`SELECT l.*, u.public_id AS seller_public_id, r.winner_id, r.final_cents, r.receipt_token, w.public_id AS winner_public_id
      FROM lots l JOIN users u ON u.id=l.seller_id LEFT JOIN auction_results r ON r.lot_id=l.id LEFT JOIN users w ON w.id=r.winner_id
      WHERE l.cancelled_at IS NULL ORDER BY l.starts_at ASC, l.created_at DESC`);
    const now = new Date();
    res.json({ lots: rows.map((row) => ({
      id: row.id, title: row.title, description: row.description, imageUrl: row.image_url, item: row.item_snapshot,
      status: lotState({ startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), cancelledAt: row.cancelled_at, settledAt: row.settled_at }, now),
      startsAt: row.starts_at, endsAt: row.ends_at, sellerPublicId: row.seller_public_id,
      ...centsFields(row), winnerPublicId: row.winner_public_id,
      receiptToken: row.receipt_token,
    })) });
  });

  router.get('/lots/:id', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { rows: [row] } = await pool.query(`SELECT l.*,s.public_id AS seller_public_id,s.display_name AS seller_name,
        EXISTS (SELECT 1 FROM bids own_bid WHERE own_bid.lot_id=l.id AND own_bid.bidder_id=$2::uuid) AS user_has_bid,
        r.winner_id,r.final_cents,r.receipt_token,w.public_id AS winner_public_id
      FROM lots l JOIN users s ON s.id=l.seller_id LEFT JOIN auction_results r ON r.lot_id=l.id
      LEFT JOIN users w ON w.id=r.winner_id WHERE l.id=$1`, [id, req.user?.role === 'BIDDER' ? req.user.id : null]);
    if (!row) throw new HttpError(404, 'Lote não encontrado.', 'LOT_NOT_FOUND');
    const { rows: bids } = await pool.query(`SELECT b.id,b.sequence,b.amount_cents,b.created_at,u.public_id
      FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.lot_id=$1 ORDER BY b.sequence DESC LIMIT 100`, [row.id]);
    res.json({ lot: {
      id: row.id, title: row.title, description: row.description, imageUrl: row.image_url, item: row.item_snapshot,
      status: lotState({ startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), cancelledAt: row.cancelled_at, settledAt: row.settled_at }),
      startsAt: row.starts_at, endsAt: row.ends_at, sellerPublicId: row.seller_public_id,
      sellerName: row.seller_name, ...centsFields(row), winnerPublicId: row.winner_public_id, receiptToken: row.receipt_token,
      userHasBid: Boolean(row.user_has_bid),
      bids: bids.map((bid) => ({ id: bid.id, sequence: bid.sequence, amountCents: cents(bid.amount_cents), createdAt: bid.created_at, bidderPublicId: bid.public_id })),
    } });
  });

  router.post('/lots/:id/bids', requireAuth, requireRole('BIDDER'), async (req, res) => {
    const id = uuidParam(req, 'id');
    const { amountCents } = validate(bidSchema, req.body);
    const result = await placeBid(id, req.user!.id, amountCents, config.auditSecret);
    await publishLotUpdate(io, id);
    res.status(201).json({ accepted: true, extended: result.extended, endsAt: result.endsAt, bid: {
      id: result.bid.id, sequence: result.bid.sequence, amountCents: cents(result.bid.amount_cents), createdAt: result.bid.created_at, bidderPublicId: result.bid.public_id,
    } });
  });

  router.get('/lots/:id/audit', async (req, res) => {
    const id = uuidParam(req, 'id');
    const { rows: [lot] } = await pool.query('SELECT id,title,starts_at,ends_at FROM lots WHERE id=$1', [id]);
    if (!lot) throw new HttpError(404, 'Lote não encontrado.', 'LOT_NOT_FOUND');
    const [{ rows: events }, { rows: [head] }] = await Promise.all([
      pool.query(`SELECT b.lot_id,b.sequence,b.bidder_id,b.amount_cents,b.created_at,b.previous_hash,b.event_hash,u.public_id
        FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.lot_id=$1 ORDER BY b.sequence ASC`, [lot.id]),
      pool.query('SELECT lot_id,sequence,final_hash,signature FROM audit_heads WHERE lot_id=$1', [lot.id]),
    ]);
    const audit = verifyAudit(events.map((event) => ({ lotId: event.lot_id, sequence: Number(event.sequence), userId: event.bidder_id,
      amountCents: event.amount_cents, createdAt: event.created_at, previousHash: String(event.previous_hash).trim(), eventHash: String(event.event_hash).trim() })),
      head ? { lotId: head.lot_id, sequence: Number(head.sequence), finalHash: String(head.final_hash).trim(), signature: String(head.signature).trim() } : null,
      config.auditSecret);
    res.json({ lot: { id: lot.id, title: lot.title, startsAt: lot.starts_at, endsAt: lot.ends_at }, audit,
      bids: events.map((event) => ({ sequence: Number(event.sequence), bidderPublicId: event.public_id, amountCents: cents(event.amount_cents), createdAt: event.created_at })) });
  });

  router.get('/receipts/:token', async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string' || !uuidSchema.safeParse(token).success) throw new HttpError(404, 'Comprovante não encontrado.', 'RECEIPT_NOT_FOUND');
    const { rows: [row] } = await pool.query(`SELECT r.receipt_token,r.final_cents,r.closed_at,r.winner_id,w.public_id AS winner_public_id,
      l.id AS lot_id,l.title,l.description,l.image_url,l.item_snapshot,s.public_id AS seller_public_id
      FROM auction_results r JOIN lots l ON l.id=r.lot_id JOIN users s ON s.id=l.seller_id
      LEFT JOIN users w ON w.id=r.winner_id WHERE r.receipt_token=$1`, [token]);
    if (!row) throw new HttpError(404, 'Comprovante não encontrado.', 'RECEIPT_NOT_FOUND');
    res.json({ receipt: { token: row.receipt_token, lotId: row.lot_id, title: row.title, description: row.description,
      imageUrl: row.image_url, item: row.item_snapshot, sellerPublicId: row.seller_public_id,
      winnerPublicId: row.winner_public_id, finalCents: cents(row.final_cents), closedAt: row.closed_at,
      noWinner: row.winner_id === null } });
  });

  router.get('/wallet', requireAuth, requireRole('BIDDER'), async (req, res) => {
    const [{ rows: [wallet] }, { rows: transactions }] = await Promise.all([
      pool.query(`SELECT w.balance_cents,COALESCE(SUM(h.amount_cents),0)::text AS committed_cents
        FROM wallets w LEFT JOIN wallet_holds h ON h.bidder_id=w.user_id WHERE w.user_id=$1 GROUP BY w.user_id`, [req.user!.id]),
      pool.query('SELECT id,kind,amount_cents,balance_after_cents,created_at,lot_id FROM wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20', [req.user!.id]),
    ]);
    if (!wallet) throw new HttpError(404, 'Carteira não encontrada.', 'WALLET_NOT_FOUND');
    const totalCents = cents(wallet.balance_cents)!;
    const committedCents = cents(wallet.committed_cents)!;
    res.json({ wallet: { totalCents, committedCents, availableCents: totalCents - committedCents }, transactions: transactions.map((row) => ({
      id: row.id, kind: row.kind, amountCents: cents(row.amount_cents), balanceAfterCents: cents(row.balance_after_cents), createdAt: row.created_at, lotId: row.lot_id,
    })) });
  });

  router.post('/wallet/deposits', requireAuth, requireRole('BIDDER'), async (req, res) => {
    const { amountCents } = validate(depositSchema, req.body);
    const balance = await transaction(async (client) => {
      const { rows: [wallet] } = await client.query('SELECT balance_cents FROM wallets WHERE user_id=$1 FOR UPDATE', [req.user!.id]);
      if (!wallet) throw new HttpError(404, 'Carteira não encontrada.', 'WALLET_NOT_FOUND');
      const newBalance = cents(wallet.balance_cents)! + amountCents;
      if (!Number.isSafeInteger(newBalance)) throw new HttpError(400, 'O saldo ultrapassaria o limite permitido.', 'BALANCE_LIMIT');
      await client.query('UPDATE wallets SET balance_cents=$2,updated_at=NOW() WHERE user_id=$1', [req.user!.id, newBalance]);
      await client.query(`INSERT INTO wallet_transactions (id,user_id,kind,amount_cents,balance_after_cents) VALUES ($1,$2,'DEPOSIT',$3,$4)`, [randomUUID(), req.user!.id, amountCents, newBalance]);
      return newBalance;
    });
    res.status(201).json({ totalCents: balance });
  });

  router.get('/me/activity', requireAuth, requireRole('BIDDER'), async (req, res) => {
    const { rows } = await pool.query(`SELECT l.id,l.title,l.image_url,l.starts_at,l.ends_at,l.current_bid_cents,l.leader_id,l.settled_at,
      MAX(b.amount_cents) AS my_max_bid,r.final_cents,r.closed_at,r.receipt_token,r.winner_id,
      EXISTS (SELECT 1 FROM wallet_holds h WHERE h.lot_id=l.id AND h.bidder_id=$1) AS held
      FROM bids b JOIN lots l ON l.id=b.lot_id LEFT JOIN auction_results r ON r.lot_id=l.id
      WHERE b.bidder_id=$1 GROUP BY l.id,r.final_cents,r.closed_at,r.receipt_token,r.winner_id ORDER BY MAX(b.created_at) DESC`, [req.user!.id]);
    res.json({ lots: rows.map((row) => ({ id: row.id, title: row.title, imageUrl: row.image_url, startsAt: row.starts_at, endsAt: row.ends_at,
      currentBidCents: cents(row.current_bid_cents), myMaxBidCents: cents(row.my_max_bid), status: lotState({ startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), settledAt: row.settled_at }),
      leading: row.leader_id === req.user!.id && !row.settled_at, won: row.winner_id === req.user!.id,
      finalCents: cents(row.final_cents), closedAt: row.closed_at, receiptToken: row.receipt_token, committedCents: row.held ? cents(row.current_bid_cents) : 0,
    })) });
  });

  router.get('/seller/products', requireAuth, requireRole('SELLER'), async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(await searchProducts(query));
  });

  router.get('/seller/lots', requireAuth, requireRole('SELLER'), async (req, res) => {
    const { rows } = await pool.query(`SELECT l.*,r.winner_id,r.final_cents,r.closed_at,r.receipt_token,
      (SELECT COUNT(*) FROM bids b WHERE b.lot_id=l.id) AS bid_count,w.public_id AS winner_public_id
      FROM lots l LEFT JOIN auction_results r ON r.lot_id=l.id LEFT JOIN users w ON w.id=r.winner_id
      WHERE l.seller_id=$1 ORDER BY l.created_at DESC`, [req.user!.id]);
    res.json({ lots: rows.map((row) => ({ id: row.id, title: row.title, imageUrl: row.image_url, item: row.item_snapshot,
      status: row.cancelled_at ? 'cancelled' : lotState({ startsAt: new Date(row.starts_at), endsAt: new Date(row.ends_at), settledAt: row.settled_at }),
      startsAt: row.starts_at, endsAt: row.ends_at, bidCount: Number(row.bid_count), canCancel: !row.cancelled_at && !row.settled_at && Number(row.bid_count) === 0,
      ...centsFields(row), winnerPublicId: row.winner_public_id, receiptToken: row.receipt_token,
    })) });
  });

  router.get('/seller/summary', requireAuth, requireRole('SELLER'), async (req, res) => {
    const { rows: [row] } = await pool.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE l.settled_at IS NULL AND l.cancelled_at IS NULL AND l.starts_at <= NOW() AND l.ends_at > NOW())::int AS active,
      COUNT(*) FILTER (WHERE l.settled_at IS NOT NULL OR (l.cancelled_at IS NULL AND l.ends_at <= NOW()))::int AS closed,
      COALESCE(SUM(r.final_cents),0)::text AS received_cents
      FROM lots l LEFT JOIN auction_results r ON r.lot_id=l.id WHERE l.seller_id=$1`, [req.user!.id]);
    res.json({ total: Number(row.total), active: Number(row.active), closed: Number(row.closed), receivedCents: cents(row.received_cents)! });
  });

  router.post('/seller/lots', requireAuth, requireRole('SELLER'), async (req, res) => {
    const data = validate(lotSchema, req.body);
    const start = new Date(data.startsAt);
    const end = new Date(data.endsAt);
    if (start.getTime() < Date.now() + 30_000) throw new HttpError(400, 'O início do lote precisa estar pelo menos 30 segundos no futuro.', 'INVALID_SCHEDULE');
    if (end <= start || end.getTime() - start.getTime() > 30 * 24 * 60 * 60 * 1000) throw new HttpError(400, 'Escolha um encerramento posterior ao início, em até 30 dias.', 'INVALID_SCHEDULE');
    const product = await getProduct(data.productId);
    const title = data.title ?? product.title;
    const imageUrl = data.imageUrl ?? product.thumbnail;
    if (new URL(imageUrl).protocol !== 'https:') throw new HttpError(400, 'A imagem precisa usar HTTPS.', 'INVALID_IMAGE');
    const description = data.description ?? product.description;
    const id = randomUUID();
    const snapshot = { ...product, title, description, thumbnail: imageUrl };
    await transaction(async (client) => {
      await client.query(`INSERT INTO lots (id,seller_id,source_name,source_item_id,item_snapshot,title,description,image_url,starting_cents,increment_cents,starts_at,ends_at)
        VALUES ($1,$2,'DummyJSON',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, req.user!.id, String(product.id), snapshot, title, description, imageUrl, data.startingCents, data.incrementCents, start, end]);
      await client.query('INSERT INTO audit_heads (lot_id,sequence,final_hash,signature) VALUES ($1,0,$2,$3)', [id, ZERO_HASH, signHead(id, 0, ZERO_HASH, config.auditSecret)]);
    });
    res.status(201).json({ lot: { id, title, description, imageUrl, item: snapshot, startingCents: data.startingCents,
      incrementCents: data.incrementCents, startsAt: start, endsAt: end, status: 'scheduled' } });
  });

  router.delete('/seller/lots/:id', requireAuth, requireRole('SELLER'), async (req, res) => {
    const id = uuidParam(req, 'id');
    await transaction(async (client) => {
      const { rows: [lot] } = await client.query('SELECT * FROM lots WHERE id=$1 FOR UPDATE', [id]);
      if (!lot || lot.seller_id !== req.user!.id) throw new HttpError(404, 'Lote não encontrado.', 'LOT_NOT_FOUND');
      if (lot.settled_at || lot.cancelled_at) throw new HttpError(409, 'Este lote já foi encerrado ou cancelado.', 'LOT_CLOSED');
      const { rows: [count] } = await client.query('SELECT COUNT(*)::int AS count FROM bids WHERE lot_id=$1', [lot.id]);
      if (Number(count.count) > 0) throw new HttpError(409, 'Só é possível cancelar um lote sem lances.', 'LOT_HAS_BIDS');
      await client.query('UPDATE lots SET cancelled_at=NOW() WHERE id=$1', [lot.id]);
    });
    await publishLotUpdate(io, id);
    res.json({ ok: true });
  });

  return router;
}
