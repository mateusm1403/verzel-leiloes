import { HttpError } from './errors.js';

const API = 'https://dummyjson.com/products';
const cache = new Map<string, { expiresAt: number; value: unknown }>();
const CACHE_MS = 60_000;

export interface ProductSnapshot {
  id: number;
  title: string;
  description: string;
  category: string;
  brand: string | null;
  price: number;
  rating: number | null;
  stock: number | null;
  tags: string[];
  images: string[];
  thumbnail: string;
  warrantyInformation?: string;
  shippingInformation?: string;
  returnPolicy?: string;
}

function normalizeProduct(input: any): ProductSnapshot {
  const image = typeof input?.thumbnail === 'string' ? input.thumbnail : '';
  if (!Number.isInteger(input?.id) || typeof input?.title !== 'string' || typeof input?.description !== 'string' || !image) {
    throw new HttpError(502, 'A API externa retornou um produto incompleto.', 'UPSTREAM_INVALID');
  }
  return {
    id: input.id,
    title: String(input.title).slice(0, 180),
    description: String(input.description).slice(0, 4000),
    category: String(input.category ?? 'sem categoria').slice(0, 80),
    brand: typeof input.brand === 'string' ? input.brand.slice(0, 100) : null,
    price: Number.isFinite(Number(input.price)) ? Number(input.price) : 0,
    rating: Number.isFinite(Number(input.rating)) ? Number(input.rating) : null,
    stock: Number.isInteger(input.stock) ? input.stock : null,
    tags: Array.isArray(input.tags) ? input.tags.filter((tag: unknown) => typeof tag === 'string').slice(0, 20) : [],
    images: Array.isArray(input.images) ? input.images.filter((url: unknown) => typeof url === 'string').slice(0, 12) : [image],
    thumbnail: image,
    ...(typeof input.warrantyInformation === 'string' ? { warrantyInformation: input.warrantyInformation.slice(0, 200) } : {}),
    ...(typeof input.shippingInformation === 'string' ? { shippingInformation: input.shippingInformation.slice(0, 200) } : {}),
    ...(typeof input.returnPolicy === 'string' ? { returnPolicy: input.returnPolicy.slice(0, 200) } : {}),
  };
}

async function requestJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch {
    throw new HttpError(503, 'A busca de novos itens está indisponível agora. Tente novamente em instantes.', 'UPSTREAM_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const item = cache.get(key);
  if (item && item.expiresAt > Date.now()) return item.value as T;
  const value = await load();
  cache.set(key, { expiresAt: Date.now() + CACHE_MS, value });
  return value;
}

export async function searchProducts(query: string) {
  const term = query.trim().slice(0, 80);
  if (term.length < 2) throw new HttpError(400, 'Digite pelo menos 2 caracteres para pesquisar.', 'INVALID_SEARCH');
  return cached(`search:${term.toLowerCase()}`, async () => {
    const data = await requestJson(`${API}/search?q=${encodeURIComponent(term)}&limit=24`);
    return { products: Array.isArray(data.products) ? data.products.map(normalizeProduct) : [], total: Number(data.total ?? 0) };
  });
}

export async function getProduct(id: number): Promise<ProductSnapshot> {
  return cached(`product:${id}`, async () => normalizeProduct(await requestJson(`${API}/${id}`)));
}
