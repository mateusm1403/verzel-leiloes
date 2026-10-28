export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data?.error?.message ?? 'Não foi possível concluir a solicitação.', response.status, data?.error?.code);
  return data as T;
}

export function money(cents: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((cents ?? 0) / 100);
}

export function dateTime(value: string | Date) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function centsFromInput(value: string) {
  const amount = Number(value.replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}
