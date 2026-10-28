import { randomUUID } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';
import { pool, transaction, cents } from './db.js';
import { eventHash, signHead, ZERO_HASH } from './audit.js';
import { antiSnipingEnd, availableCents, bidRuleRejection, fundsRejection, minimumBid } from './auction-rules.js';
import { HttpError } from './errors.js';

export async function placeBid(lotId: string, bidderId: string, amountCents: number, auditSecret: string) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new HttpError(400, 'Informe um valor de lance válido.', 'INVALID_BID');
  const accepted = await transaction(async (client) => {
    const lotResult = await client.query('SELECT * FROM lots WHERE id = $1 FOR UPDATE', [lotId]);
    const lot = lotResult.rows[0];
    if (!lot) throw new HttpError(404, 'Lote não encontrado.', 'LOT_NOT_FOUND');
    const { rows: [clock] } = await client.query('SELECT clock_timestamp() AS now');
    const now = new Date(clock.now);
    const { rows: [bidder] } = await client.query('SELECT id, role FROM users WHERE id = $1', [bidderId]);
    const previousCents = cents(lot.current_bid_cents);
    const minCents = minimumBid(cents(lot.starting_cents)!, previousCents, cents(lot.increment_cents)!);
    const ruleError = bidRuleRejection({ now, startsAt: new Date(lot.starts_at), endsAt: new Date(lot.ends_at), cancelledAt: lot.cancelled_at,
      settledAt: lot.settled_at, role: bidder?.role ?? 'UNKNOWN', bidderId, leaderId: lot.leader_id, amountCents, minimumCents: minCents });
    if (ruleError) throw new HttpError(ruleError.code === 'ROLE_FORBIDDEN' ? 403 : ruleError.code === 'INVALID_BID' ? 400 : 409, ruleError.message, ruleError.code);

    const involvedIds = [...new Set([bidderId, ...(lot.leader_id ? [lot.leader_id as string] : [])])].sort();
    await client.query('SELECT user_id FROM wallets WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE', [involvedIds]);
    const { rows: [wallet] } = await client.query('SELECT balance_cents FROM wallets WHERE user_id = $1', [bidderId]);
    if (!wallet) throw new HttpError(409, 'Sua carteira não está disponível.', 'WALLET_NOT_FOUND');
    const { rows: [committed] } = await client.query('SELECT COALESCE(SUM(amount_cents), 0)::text AS total FROM wallet_holds WHERE bidder_id = $1', [bidderId]);
    const available = availableCents(cents(wallet.balance_cents)!, cents(committed.total)!);
    const fundsError = fundsRejection(amountCents, available);
    if (fundsError) throw new HttpError(409, fundsError.message, fundsError.code);

    const { rows: [head] } = await client.query('SELECT sequence, final_hash FROM audit_heads WHERE lot_id = $1 FOR UPDATE', [lotId]);
    if (!head) throw new HttpError(503, 'Não foi possível carregar a evidência de auditoria deste lote.', 'AUDIT_UNAVAILABLE');
    const sequence = Number(head.sequence) + 1;
    const previousHash = sequence === 1 ? ZERO_HASH : String(head.final_hash).trim();
    const eventId = randomUUID();
    const endAt = antiSnipingEnd(new Date(lot.ends_at), now);
    const timestamp = now.toISOString();
    const hash = eventHash({ lotId, sequence, userId: bidderId, amountCents, createdAt: timestamp, previousHash });

    if (lot.leader_id) {
      const { rows: [oldHold] } = await client.query('SELECT bidder_id, amount_cents FROM wallet_holds WHERE lot_id = $1 FOR UPDATE', [lotId]);
      if (!oldHold || oldHold.bidder_id !== lot.leader_id || cents(oldHold.amount_cents) !== previousCents) {
        throw new HttpError(503, 'A reserva financeira do líder está inconsistente. O lance foi cancelado.', 'HOLD_INCONSISTENT');
      }
      await client.query('DELETE FROM wallet_holds WHERE lot_id = $1', [lotId]);
      const { rows: [oldWallet] } = await client.query('SELECT balance_cents FROM wallets WHERE user_id = $1', [oldHold.bidder_id]);
      await client.query(`INSERT INTO wallet_transactions (id,user_id,lot_id,kind,amount_cents,balance_after_cents)
        VALUES ($1,$2,$3,'RELEASE',$4,$5)`, [randomUUID(), oldHold.bidder_id, lotId, oldHold.amount_cents, oldWallet.balance_cents]);
    }

    await client.query(`INSERT INTO wallet_holds (lot_id,bidder_id,amount_cents) VALUES ($1,$2,$3)
      ON CONFLICT (lot_id) DO UPDATE SET bidder_id=EXCLUDED.bidder_id, amount_cents=EXCLUDED.amount_cents, updated_at=NOW()`, [lotId, bidderId, amountCents]);
    await client.query(`INSERT INTO wallet_transactions (id,user_id,lot_id,kind,amount_cents,balance_after_cents)
      VALUES ($1,$2,$3,'HOLD',$4,$5)`, [randomUUID(), bidderId, lotId, amountCents, wallet.balance_cents]);
    await client.query(`INSERT INTO bids (id,lot_id,sequence,bidder_id,amount_cents,created_at,previous_hash,event_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId, lotId, sequence, bidderId, amountCents, now, previousHash, hash]);
    const signature = signHead(lotId, sequence, hash, auditSecret);
    await client.query(`UPDATE audit_heads SET sequence=$2, final_hash=$3, signature=$4, updated_at=NOW() WHERE lot_id=$1`, [lotId, sequence, hash, signature]);
    await client.query(`UPDATE lots SET current_bid_cents=$2, leader_id=$3, ends_at=$4 WHERE id=$1`, [lotId, amountCents, bidderId, endAt]);
    const { rows: [publicBid] } = await client.query(`SELECT b.id,b.sequence,b.amount_cents,b.created_at,u.public_id
      FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.id=$1`, [eventId]);
    return { bid: publicBid, endsAt: endAt, extended: endAt.getTime() !== new Date(lot.ends_at).getTime() };
  });
  return accepted;
}

export async function getLiveSnapshot(lotId: string) {
  const { rows: [lot] } = await pool.query(`SELECT l.id,l.title,l.current_bid_cents,l.starting_cents,l.increment_cents,l.starts_at,l.ends_at,
    l.leader_id,leader.public_id AS leader_public_id,l.cancelled_at,l.settled_at
    FROM lots l LEFT JOIN users leader ON leader.id=l.leader_id WHERE l.id=$1`, [lotId]);
  if (!lot) return null;
  const { rows: bids } = await pool.query(`SELECT b.id,b.sequence,b.amount_cents,b.created_at,u.public_id
    FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.lot_id=$1 ORDER BY b.sequence DESC LIMIT 50`, [lotId]);
  return {
    lotId: lot.id,
    currentBidCents: cents(lot.current_bid_cents),
    startingCents: cents(lot.starting_cents),
    incrementCents: cents(lot.increment_cents),
    startsAt: lot.starts_at,
    endsAt: lot.ends_at,
    leaderPublicId: lot.leader_public_id,
    state: lot.cancelled_at ? 'cancelled' : lot.settled_at || new Date(lot.ends_at).getTime() <= Date.now() ? 'closed' : new Date(lot.starts_at).getTime() > Date.now() ? 'scheduled' : 'live',
    bids: bids.map((bid) => ({ id: bid.id, sequence: bid.sequence, amountCents: cents(bid.amount_cents), createdAt: bid.created_at, bidderPublicId: bid.public_id })),
  };
}

export async function settleLot(lotId: string) {
  return transaction(async (client) => {
    const { rows: [lot] } = await client.query('SELECT * FROM lots WHERE id=$1 FOR UPDATE', [lotId]);
    if (!lot || lot.cancelled_at || lot.settled_at) return null;
    const { rows: [clock] } = await client.query('SELECT clock_timestamp() AS now');
    const closedAt = new Date(clock.now);
    if (new Date(lot.ends_at).getTime() > closedAt.getTime()) return null;

    const winnerId = lot.leader_id as string | null;
    const finalCents = cents(lot.current_bid_cents);
    if ((winnerId === null) !== (finalCents === null)) throw new HttpError(503, 'O resultado do lote está inconsistente.', 'RESULT_INCONSISTENT');
    const ids = [...new Set([lot.seller_id as string, ...(winnerId ? [winnerId] : [])])].sort();
    await client.query('SELECT user_id FROM wallets WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE', [ids]);
    const token = randomUUID();
    if (winnerId && finalCents !== null) {
      const { rows: [hold] } = await client.query('SELECT bidder_id,amount_cents FROM wallet_holds WHERE lot_id=$1 FOR UPDATE', [lotId]);
      if (!hold || hold.bidder_id !== winnerId || cents(hold.amount_cents) !== finalCents) throw new HttpError(503, 'Não foi possível liquidar: a reserva do lance vencedor está inconsistente.', 'HOLD_INCONSISTENT');
      const { rows: wallets } = await client.query('SELECT user_id,balance_cents FROM wallets WHERE user_id = ANY($1::uuid[])', [ids]);
      const balances = new Map(wallets.map((row) => [row.user_id as string, cents(row.balance_cents)!]));
      const winnerBalance = balances.get(winnerId);
      const sellerBalance = balances.get(lot.seller_id as string);
      if (winnerBalance === undefined || sellerBalance === undefined || winnerBalance < finalCents) throw new HttpError(503, 'Saldo da carteira inconsistente durante a liquidação.', 'BALANCE_INCONSISTENT');
      await client.query('UPDATE wallets SET balance_cents=balance_cents-$2, updated_at=NOW() WHERE user_id=$1', [winnerId, finalCents]);
      await client.query('UPDATE wallets SET balance_cents=balance_cents+$2, updated_at=NOW() WHERE user_id=$1', [lot.seller_id, finalCents]);
      await client.query(`INSERT INTO wallet_transactions (id,user_id,lot_id,kind,amount_cents,balance_after_cents) VALUES
        ($1,$2,$3,'AUCTION_DEBIT',$4,$5),($6,$7,$3,'SELLER_CREDIT',$4,$8)`, [randomUUID(), winnerId, lotId, finalCents, winnerBalance - finalCents, randomUUID(), lot.seller_id, sellerBalance + finalCents]);
      await client.query('DELETE FROM wallet_holds WHERE lot_id=$1', [lotId]);
    }
    await client.query(`INSERT INTO auction_results (lot_id,receipt_token,winner_id,final_cents,closed_at)
      VALUES ($1,$2,$3,$4,$5)`, [lotId, token, winnerId, finalCents, closedAt]);
    await client.query('UPDATE lots SET settled_at=$2 WHERE id=$1', [lotId, closedAt]);
    return { lotId, token, winnerId, finalCents, closedAt };
  });
}

export async function processExpiredLots(io?: SocketServer) {
  const { rows } = await pool.query(`SELECT id FROM lots WHERE ends_at<=NOW() AND settled_at IS NULL AND cancelled_at IS NULL ORDER BY ends_at LIMIT 100`);
  for (const row of rows) {
    try {
      const result = await settleLot(row.id as string);
      if (!result) continue;
      const snapshot = await getLiveSnapshot(result.lotId);
      if (snapshot) io?.to(result.lotId).emit('lot:update', snapshot);
    } catch (error) {
      console.error('Falha ao liquidar lote:', row.id, error instanceof Error ? error.message : 'erro desconhecido');
    }
  }
}

export async function publishLotUpdate(io: SocketServer, lotId: string) {
  try {
    const snapshot = await getLiveSnapshot(lotId);
    if (snapshot) io.to(lotId).emit('lot:update', snapshot);
  } catch (error) {
    console.error('Falha ao publicar atualização do lote:', error instanceof Error ? error.message : 'erro desconhecido');
  }
}
