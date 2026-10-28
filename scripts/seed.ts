import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { config } from '../apps/api/src/config.js';
import { getProduct, type ProductSnapshot } from '../apps/api/src/external-api.js';
import { placeBid } from '../apps/api/src/auction-service.js';
import { signHead, ZERO_HASH } from '../apps/api/src/audit.js';

const configuredDemoPassword = process.env.DEMO_PASSWORD;
if (process.env.NODE_ENV === 'production' && !configuredDemoPassword) {
  throw new Error('DEMO_PASSWORD precisa ser configurada em produção; não use a senha padrão de desenvolvimento.');
}
const DEMO_PASSWORD = configuredDemoPassword ?? 'DemoAuction#2026';
const demoLots = [
  { id: '20000000-0000-4000-8000-000000000001', productId: 99, title: 'Echo Plus edição especial', startingCents: 100_000, incrementCents: 5_000,
    fallback: { id: 99, title: 'Echo Plus (2ª geração)', description: 'Caixa de som inteligente com assistente de voz e áudio premium.', category: 'audio', brand: 'Amazon', price: 149.99, rating: 4.7, stock: 8, tags: ['áudio', 'casa inteligente'], images: [], thumbnail: 'https://cdn.dummyjson.com/product-images/99/thumbnail.jpg' } },
  { id: '20000000-0000-4000-8000-000000000002', productId: 11, startingCents: 250_000, incrementCents: 10_000,
    fallback: { id: 11, title: 'Annibale Colombo Bed', description: 'Cama de design contemporâneo em madeira maciça.', category: 'furniture', brand: 'Annibale Colombo', price: 1899.99, rating: 4.8, stock: 5, tags: ['móveis'], images: [], thumbnail: 'https://cdn.dummyjson.com/product-images/11/thumbnail.jpg' } },
  { id: '20000000-0000-4000-8000-000000000003', productId: 14, startingCents: 150_000, incrementCents: 7_500,
    fallback: { id: 14, title: 'Knoll Saarinen Executive Conference Chair', description: 'Poltrona de conferência com acabamento premium.', category: 'furniture', brand: 'Knoll', price: 499.99, rating: 4.6, stock: 8, tags: ['móveis'], images: [], thumbnail: 'https://cdn.dummyjson.com/product-images/14/thumbnail.jpg' } },
  { id: '20000000-0000-4000-8000-000000000004', productId: 15, startingCents: 80_000, incrementCents: 5_000,
    fallback: { id: 15, title: 'Wooden Luxury Chandelier', description: 'Lustre decorativo de madeira com design elegante.', category: 'lighting', brand: 'Woodn', price: 249.99, rating: 4.5, stock: 6, tags: ['iluminação'], images: [], thumbnail: 'https://cdn.dummyjson.com/product-images/15/thumbnail.jpg' } },
] satisfies Array<{ id: string; productId: number; title?: string; startingCents: number; incrementCents: number; fallback: ProductSnapshot }>;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const accounts = [
  { email: 'leiloeiro@verzel.demo', displayName: 'Casa Verzel', role: 'SELLER', balance: 0 },
  { email: 'ana@verzel.demo', displayName: 'Ana Ribeiro', role: 'BIDDER', balance: 5_000_000 },
  { email: 'bruno@verzel.demo', displayName: 'Bruno Costa', role: 'BIDDER', balance: 5_000_000 },
] as const;

try {
  await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
  const users = new Map<string, string>();
  for (const account of accounts) {
    const existing = await pool.query('SELECT id,role FROM users WHERE email=$1', [account.email]);
    if (existing.rowCount) {
      if (existing.rows[0].role !== account.role) throw new Error(`A conta ${account.email} já existe com outro papel.`);
      users.set(account.email, existing.rows[0].id);
      continue;
    }
    const id = randomUUID();
    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
    await pool.query('INSERT INTO users (id,public_id,display_name,email,password_hash,role) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, `D-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`, account.displayName, account.email, passwordHash, account.role]);
    users.set(account.email, id);
  }

  for (const account of accounts) {
    const userId = users.get(account.email)!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [created] } = await client.query('INSERT INTO wallets (user_id,balance_cents) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id', [userId, account.balance]);
      if (created && account.balance > 0) await client.query(`INSERT INTO wallet_transactions (id,user_id,kind,amount_cents,balance_after_cents)
        VALUES ($1,$2,'DEPOSIT',$3,$3)`, [randomUUID(), userId, account.balance]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  const sellerId = users.get('leiloeiro@verzel.demo')!;
  const anaId = users.get('ana@verzel.demo')!;
  const brunoId = users.get('bruno@verzel.demo')!;
  for (const definition of demoLots) {
    const { rows: [existingLot] } = await pool.query('SELECT id FROM lots WHERE id=$1', [definition.id]);
    if (!existingLot) {
      const product = await getProduct(definition.productId).catch(() => definition.fallback);
      const title = definition.title ?? product.title;
      const description = product.description.slice(0, 3_800);
      const snapshot = { ...product, title, description };
      const startsAt = new Date(Date.now() - 5 * 60_000);
      const endsAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO lots (id,seller_id,source_name,source_item_id,item_snapshot,title,description,image_url,starting_cents,increment_cents,starts_at,ends_at)
          VALUES ($1,$2,'DummyJSON',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [definition.id, sellerId, String(product.id), snapshot, title, description, product.thumbnail, definition.startingCents, definition.incrementCents, startsAt, endsAt]);
        await client.query('INSERT INTO audit_heads (lot_id,sequence,final_hash,signature) VALUES ($1,0,$2,$3)', [definition.id, ZERO_HASH, signHead(definition.id, 0, ZERO_HASH, config.auditSecret)]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    }

    const { rows: [lot] } = await pool.query('SELECT starting_cents,increment_cents,current_bid_cents,leader_id FROM lots WHERE id=$1', [definition.id]);
    const { rows: [bidCount] } = await pool.query('SELECT COUNT(*)::int AS count FROM bids WHERE lot_id=$1', [definition.id]);
    if (Number(bidCount.count) === 0) {
      await placeBid(definition.id, anaId, definition.startingCents, config.auditSecret);
      await placeBid(definition.id, brunoId, definition.startingCents + definition.incrementCents, config.auditSecret);
    } else if (Number(bidCount.count) === 1) {
      const nextBidderId = lot.leader_id === anaId ? brunoId : anaId;
      const nextAmount = Number(lot.current_bid_cents) + Number(lot.increment_cents);
      await placeBid(definition.id, nextBidderId, nextAmount, config.auditSecret);
    }
  }
  console.log(`Seed concluído: ${demoLots.length} lotes de demonstração. Contas e saldos existentes foram preservados.`);
  console.log('A senha das contas de demonstração é definida pelo ambiente e não é exibida nos logs.');
} finally {
  await pool.end();
}
