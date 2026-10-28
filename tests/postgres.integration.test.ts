import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = process.env.RUN_DATABASE_TESTS === 'true';
const integration = enabled ? describe : describe.skip;

integration('integração PostgreSQL: concorrência, liquidação, permissões e recibo', () => {
  const secret = 'integration-audit-secret-long-enough-for-hmac-tests';
  const jwtSecret = 'integration-jwt-secret-long-enough-for-cookie-tests';
  const testPassword = 'IntegrationPass#2026';
  const ids = { lot: randomUUID(), emptyLot: randomUUID(), seller: randomUUID(), foreignSeller: randomUUID(), bidderA: randomUUID(), bidderB: randomUUID() };
  let pool: any;
  let httpServer: ReturnType<typeof createServer>;
  let socketServer: any;
  let origin = '';
  let receiptToken = '';
  let registeredUserId: string | null = null;
  let socketClient: any;

  async function login(email: string) {
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: testPassword }) });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie');
    if (!setCookie) throw new Error('Login não retornou o cookie de sessão.');
    return setCookie.split(';', 1)[0]!;
  }

  function timeout<T>(promise: Promise<T>, milliseconds: number, label: string) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tempo excedido aguardando ${label}.`)), milliseconds);
      promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_TEST_URL) throw new Error('RUN_DATABASE_TESTS exige DATABASE_TEST_URL apontando para um banco PostgreSQL de teste isolado.');
    process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
    process.env.AUDIT_SECRET = secret;
    process.env.JWT_SECRET = jwtSecret;
    const db = await import('../apps/api/src/db');
    pool = db.pool;
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
    const { signHead, ZERO_HASH } = await import('../apps/api/src/audit');
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(testPassword, 10);
    const now = new Date();
    const startsAt = new Date(now.getTime() - 60_000);
    const endsAt = new Date(now.getTime() + 3_600_000);
    await pool.query(`INSERT INTO users (id,public_id,display_name,email,password_hash,role) VALUES
      ($1,$2,'Seller Test',$3,$4,'SELLER'),($5,$6,'Foreign Seller',$7,$8,'SELLER'),
      ($9,$10,'Bidder A',$11,$12,'BIDDER'),($13,$14,'Bidder B',$15,$16,'BIDDER')`, [
      ids.seller, `T-${ids.seller.slice(0,8)}`, `${ids.seller}@integration.test`, passwordHash,
      ids.foreignSeller, `T-${ids.foreignSeller.slice(0,8)}`, `${ids.foreignSeller}@integration.test`, passwordHash,
      ids.bidderA, `T-${ids.bidderA.slice(0,8)}`, `${ids.bidderA}@integration.test`, passwordHash,
      ids.bidderB, `T-${ids.bidderB.slice(0,8)}`, `${ids.bidderB}@integration.test`, passwordHash,
    ]);
    await pool.query('INSERT INTO wallets (user_id,balance_cents) VALUES ($1,0),($2,100000),($3,100000)', [ids.seller, ids.bidderA, ids.bidderB]);
    await pool.query(`INSERT INTO lots (id,seller_id,source_name,source_item_id,item_snapshot,title,description,image_url,starting_cents,increment_cents,starts_at,ends_at)
      VALUES ($1,$2,'DummyJSON','test-1','{}'::jsonb,'Lot Integration Test','Fixture','https://example.test/img.jpg',10000,1000,$3,$4)`, [ids.lot, ids.seller, startsAt, endsAt]);
    await pool.query('INSERT INTO audit_heads (lot_id,sequence,final_hash,signature) VALUES ($1,0,$2,$3)', [ids.lot, ZERO_HASH, signHead(ids.lot, 0, ZERO_HASH, secret)]);
    await pool.query(`INSERT INTO lots (id,seller_id,source_name,source_item_id,item_snapshot,title,description,image_url,starting_cents,increment_cents,starts_at,ends_at)
      VALUES ($1,$2,'DummyJSON','test-empty','{}'::jsonb,'Empty Integration Test','Fixture','https://example.test/img.jpg',5000,500,$3,$4)`, [ids.emptyLot, ids.seller, startsAt, endsAt]);
    await pool.query('INSERT INTO audit_heads (lot_id,sequence,final_hash,signature) VALUES ($1,0,$2,$3)', [ids.emptyLot, ZERO_HASH, signHead(ids.emptyLot, 0, ZERO_HASH, secret)]);

    const [{ createRouter }, { attachAuctionSockets }, cookie, { io: connectSocket }] = await Promise.all([
      import('../apps/api/src/routes'), import('../apps/api/src/realtime'), import('cookie-parser'), import('socket.io-client'),
    ]);
    const app = express();
    app.use(express.json());
    app.use(cookie.default());
    httpServer = createServer(app);
    const { Server } = await import('socket.io');
    socketServer = new Server(httpServer);
    app.use('/api', createRouter(socketServer));
    app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } }));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (address && typeof address !== 'string') origin = `http://127.0.0.1:${address.port}`;
    socketClient = connectSocket(origin, { autoConnect: false, reconnection: true });
    attachAuctionSockets(socketServer);
  }, 20_000);

  afterAll(async () => {
    socketClient?.disconnect();
    if (origin) await new Promise<void>((resolve) => socketServer.close(() => resolve()));
    if (pool) {
      if (registeredUserId) {
        await pool.query('DELETE FROM wallets WHERE user_id=$1', [registeredUserId]);
        await pool.query('DELETE FROM users WHERE id=$1', [registeredUserId]);
      }
      await pool.query('DELETE FROM auction_results WHERE lot_id=$1', [ids.lot]);
      await pool.query('DELETE FROM auction_results WHERE lot_id=$1', [ids.emptyLot]);
      await pool.query('DELETE FROM audit_heads WHERE lot_id=$1', [ids.lot]);
      await pool.query('DELETE FROM audit_heads WHERE lot_id=$1', [ids.emptyLot]);
      await pool.query('DELETE FROM wallet_transactions WHERE user_id=ANY($1::uuid[])', [[ids.seller, ids.foreignSeller, ids.bidderA, ids.bidderB]]);
      await pool.query('DELETE FROM wallet_holds WHERE lot_id=$1', [ids.lot]);
      await pool.query('DELETE FROM wallet_holds WHERE lot_id=$1', [ids.emptyLot]);
      await pool.query('DELETE FROM bids WHERE lot_id=$1', [ids.lot]);
      await pool.query('DELETE FROM bids WHERE lot_id=$1', [ids.emptyLot]);
      await pool.query('DELETE FROM lots WHERE id=$1', [ids.lot]);
      await pool.query('DELETE FROM lots WHERE id=$1', [ids.emptyLot]);
      await pool.query('DELETE FROM wallets WHERE user_id=ANY($1::uuid[])', [[ids.seller, ids.foreignSeller, ids.bidderA, ids.bidderB]]);
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ids.seller, ids.foreignSeller, ids.bidderA, ids.bidderB]]);
      await pool.end();
    }
  }, 20_000);

  it('não permite que o cadastro público crie uma conta de leiloeiro', async () => {
    const email = `register-${randomUUID()}@integration.test`;
    const attemptedSeller = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Public User', email, password: testPassword, role: 'SELLER' }) });
    expect(attemptedSeller.status).toBe(400);

    const response = await fetch(`${origin}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Public User', email, password: testPassword }) });
    expect(response.status).toBe(201);
    const created = await response.json();
    registeredUserId = created.user.id;
    expect(created.user.role).toBe('BIDDER');
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    expect(cookie).toBeTruthy();
    const sellerRoute = await fetch(`${origin}/api/seller/summary`, { headers: { Cookie: cookie! } });
    expect(sellerRoute.status).toBe(403);
  });

  it('serializa dois lances, liquida uma única vez e entrega comprovante público', async () => {
    const { settleLot } = await import('../apps/api/src/auction-service');
    const bidderACookie = await login(`${ids.bidderA}@integration.test`);
    const bidderBCookie = await login(`${ids.bidderB}@integration.test`);
    const sellerCookie = await login(`${ids.seller}@integration.test`);
    for (const cookie of [bidderACookie, bidderBCookie]) {
      const deposit = await fetch(`${origin}/api/wallet/deposits`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ amountCents: 50_000 }) });
      expect(deposit.status).toBe(201);
    }
    const walletResponse = await fetch(`${origin}/api/wallet`, { headers: { Cookie: bidderACookie } });
    expect((await walletResponse.json()).wallet).toMatchObject({ totalCents: 150_000, committedCents: 0, availableCents: 150_000 });

    const initialState = new Promise<any>((resolve, reject) => {
      socketClient.once('lot:update', resolve);
      socketClient.once('connect_error', reject);
      socketClient.on('connect', () => socketClient.emit('lot:join', ids.lot));
    });
    socketClient.connect();
    expect((await timeout(initialState, 8_000, 'estado inicial')).lotId).toBe(ids.lot);
    const pushedBid = new Promise<any>((resolve) => {
      const handler = (state: any) => { if (state.currentBidCents === 10_000) { socketClient.off('lot:update', handler); resolve(state); } };
      socketClient.on('lot:update', handler);
    });
    const makeBid = (cookie: string) => fetch(`${origin}/api/lots/${ids.lot}/bids`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ amountCents: 10_000 }) });
    const attempts = await Promise.all([makeBid(bidderACookie), makeBid(bidderBCookie)]);
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await timeout(pushedBid, 8_000, 'atualização do lance')).currentBidCents).toBe(10_000);
    const { rows: [firstLeader] } = await pool.query('SELECT leader_id,current_bid_cents FROM lots WHERE id=$1', [ids.lot]);
    expect(Number(firstLeader.current_bid_cents)).toBe(10_000);
    expect([ids.bidderA, ids.bidderB]).toContain(firstLeader.leader_id);
    const { rows: [hold] } = await pool.query('SELECT bidder_id,amount_cents FROM wallet_holds WHERE lot_id=$1', [ids.lot]);
    expect(hold.bidder_id).toBe(firstLeader.leader_id);
    expect(Number(hold.amount_cents)).toBe(10_000);

    const formerLeaderCookie = firstLeader.leader_id === ids.bidderA ? bidderACookie : bidderBCookie;
    const newLeaderCookie = firstLeader.leader_id === ids.bidderA ? bidderBCookie : bidderACookie;
    const outbidState = new Promise<any>((resolve) => {
      const handler = (state: any) => { if (state.currentBidCents === 11_000) { socketClient.off('lot:update', handler); resolve(state); } };
      socketClient.on('lot:update', handler);
    });
    const belowMinimum = await fetch(`${origin}/api/lots/${ids.lot}/bids`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newLeaderCookie }, body: JSON.stringify({ amountCents: 10_000 }) });
    expect(belowMinimum.status).toBe(409);
    const acceptedOutbid = await fetch(`${origin}/api/lots/${ids.lot}/bids`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: newLeaderCookie }, body: JSON.stringify({ amountCents: 11_000 }) });
    expect(acceptedOutbid.status).toBe(201);
    expect((await timeout(outbidState, 8_000, 'atualização do lance superado')).currentBidCents).toBe(11_000);
    const formerWallet = await fetch(`${origin}/api/wallet`, { headers: { Cookie: formerLeaderCookie } }).then((response) => response.json());
    const newLeaderWallet = await fetch(`${origin}/api/wallet`, { headers: { Cookie: newLeaderCookie } }).then((response) => response.json());
    expect(formerWallet.wallet).toMatchObject({ totalCents: 150_000, committedCents: 0, availableCents: 150_000 });
    expect(newLeaderWallet.wallet).toMatchObject({ totalCents: 150_000, committedCents: 11_000, availableCents: 139_000 });
    const { rows: [lot] } = await pool.query('SELECT leader_id,current_bid_cents FROM lots WHERE id=$1', [ids.lot]);
    expect(Number(lot.current_bid_cents)).toBe(11_000);
    expect(lot.leader_id).not.toBe(firstLeader.leader_id);
    const { rows: [newHold] } = await pool.query('SELECT bidder_id,amount_cents FROM wallet_holds WHERE lot_id=$1', [ids.lot]);
    expect(newHold.bidder_id).toBe(lot.leader_id);
    expect(Number(newHold.amount_cents)).toBe(11_000);

    const cancelWithBid = await fetch(`${origin}/api/seller/lots/${ids.lot}`, { method: 'DELETE', headers: { Cookie: sellerCookie } });
    expect(cancelWithBid.status).toBe(409);

    const auditUrl = `${origin}/api/lots/${ids.lot}/audit`;
    expect((await (await fetch(auditUrl)).json()).audit.status).toBe('verified');
    const { rows: [storedBid] } = await pool.query('SELECT * FROM bids WHERE lot_id=$1', [ids.lot]);
    await pool.query('UPDATE bids SET amount_cents=amount_cents+1 WHERE id=$1', [storedBid.id]);
    expect((await (await fetch(auditUrl)).json()).audit.status).toBe('compromised');
    await pool.query('UPDATE bids SET amount_cents=$2 WHERE id=$1', [storedBid.id, storedBid.amount_cents]);
    await pool.query('DELETE FROM bids WHERE id=$1', [storedBid.id]);
    expect((await (await fetch(auditUrl)).json()).audit.status).toBe('compromised');
    await pool.query(`INSERT INTO bids (id,lot_id,sequence,bidder_id,amount_cents,created_at,previous_hash,event_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [storedBid.id, storedBid.lot_id, storedBid.sequence, storedBid.bidder_id, storedBid.amount_cents, storedBid.created_at, storedBid.previous_hash, storedBid.event_hash]);
    const fakeSequence = Number((await pool.query('SELECT sequence FROM audit_heads WHERE lot_id=$1', [ids.lot])).rows[0].sequence) + 1;
    await pool.query(`INSERT INTO bids (id,lot_id,sequence,bidder_id,amount_cents,created_at,previous_hash,event_hash)
      VALUES ($1,$2,$3,$4,20000,NOW(),$5,$6)`, [randomUUID(), ids.lot, fakeSequence, ids.bidderB, '0'.repeat(64), 'f'.repeat(64)]);
    expect((await (await fetch(auditUrl)).json()).audit.status).toBe('compromised');
    await pool.query('DELETE FROM bids WHERE lot_id=$1 AND sequence=$2', [ids.lot, fakeSequence]);

    await pool.query('UPDATE lots SET ends_at=NOW()-INTERVAL \'1 second\' WHERE id=$1', [ids.lot]);
    const settlements = await Promise.all([settleLot(ids.lot), settleLot(ids.lot)]);
    expect(settlements.filter(Boolean)).toHaveLength(1);
    const result = settlements.find(Boolean)!;
    receiptToken = result.token;
    const { rows: [resultRow] } = await pool.query('SELECT COUNT(*)::int AS count FROM auction_results WHERE lot_id=$1', [ids.lot]);
    expect(Number(resultRow.count)).toBe(1);
    const { rows: [sellerWallet] } = await pool.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [ids.seller]);
    const { rows: [winnerWallet] } = await pool.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [lot.leader_id]);
    expect(Number(sellerWallet.balance_cents)).toBe(11_000);
    expect(Number(winnerWallet.balance_cents)).toBe(139_000);
    const { rows: [holdCount] } = await pool.query('SELECT COUNT(*)::int AS count FROM wallet_holds WHERE lot_id=$1', [ids.lot]);
    expect(Number(holdCount.count)).toBe(0);

    const receiptResponse = await fetch(`${origin}/api/receipts/${receiptToken}`);
    expect(receiptResponse.status).toBe(200);
    expect((await receiptResponse.json()).receipt.finalCents).toBe(11_000);
    const forbiddenBid = await fetch(`${origin}/api/lots/${ids.lot}/bids`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sellerCookie }, body: JSON.stringify({ amountCents: 20_000 }) });
    expect(forbiddenBid.status).toBe(403);
    const foreignSellerCookie = await login(`${ids.foreignSeller}@integration.test`);
    const forbiddenCancel = await fetch(`${origin}/api/seller/lots/${ids.lot}`, { method: 'DELETE', headers: { Cookie: foreignSellerCookie } });
    expect(forbiddenCancel.status).toBe(404);
  }, 30_000);

  it('encerra um lote sem lances, cria resultado sem vencedor e não transfere saldo', async () => {
    const { settleLot } = await import('../apps/api/src/auction-service');
    const { rows: [before] } = await pool.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [ids.seller]);
    await pool.query('UPDATE lots SET ends_at=NOW()-INTERVAL \'1 second\' WHERE id=$1', [ids.emptyLot]);
    const result = await settleLot(ids.emptyLot);
    expect(result).toMatchObject({ lotId: ids.emptyLot, winnerId: null, finalCents: null });
    const { rows: [after] } = await pool.query('SELECT balance_cents FROM wallets WHERE user_id=$1', [ids.seller]);
    expect(after.balance_cents).toBe(before.balance_cents);
    const receiptResponse = await fetch(`${origin}/api/receipts/${result!.token}`);
    expect(receiptResponse.status).toBe(200);
    expect((await receiptResponse.json()).receipt.noWinner).toBe(true);
  });
});
