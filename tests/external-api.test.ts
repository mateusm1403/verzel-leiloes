import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchProducts } from '../apps/api/src/external-api';

afterEach(() => vi.unstubAllGlobals());

describe('integração com DummyJSON', () => {
  it('preserva a busca de produtos e filtra dados pessoais de reviews', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ products: [{ id: 92, title: 'Relógio de teste', description: 'Descrição', category: 'watches', thumbnail: 'https://cdn.dummyjson.com/watch.jpg', images: [], reviews: [{ reviewerEmail: 'privado@example.test' }] }], total: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const result = await searchProducts(`relógio-${Date.now()}`);
    expect(result.products).toHaveLength(1);
    expect(result.products[0]).not.toHaveProperty('reviews');
    expect(result.products[0]?.thumbnail).toContain('https://');
  });

  it('devolve erro controlado se a API externa estiver indisponível', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(searchProducts(`indisponivel-${Date.now()}`)).rejects.toMatchObject({ status: 503, code: 'UPSTREAM_UNAVAILABLE' });
  });
});
