export type LotState = 'scheduled' | 'live' | 'closed' | 'cancelled';

export function lotState(lot: { startsAt: Date; endsAt: Date; cancelledAt?: Date | null; settledAt?: Date | null }, now = new Date()): LotState {
  if (lot.cancelledAt) return 'cancelled';
  if (lot.settledAt || lot.endsAt.getTime() <= now.getTime()) return 'closed';
  if (lot.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

export function minimumBid(startingCents: number, currentCents: number | null, incrementCents: number): number {
  return currentCents === null ? startingCents : currentCents + incrementCents;
}

export function antiSnipingEnd(endsAt: Date, acceptedAt: Date): Date {
  return endsAt.getTime() - acceptedAt.getTime() <= 120_000
    ? new Date(acceptedAt.getTime() + 120_000)
    : endsAt;
}

export function availableCents(balanceCents: number, committedCents: number): number {
  return balanceCents - committedCents;
}

export interface BidRuleInput {
  now: Date;
  startsAt: Date;
  endsAt: Date;
  cancelledAt?: Date | null;
  settledAt?: Date | null;
  role: string;
  bidderId: string;
  leaderId?: string | null;
  amountCents: number;
  minimumCents: number;
}

export function bidRuleRejection(input: BidRuleInput): { code: string; message: string } | null {
  if (input.cancelledAt) return { code: 'LOT_CANCELLED', message: 'Este lote foi cancelado.' };
  if (input.settledAt || input.endsAt.getTime() <= input.now.getTime()) return { code: 'LOT_CLOSED', message: 'Este lote já foi encerrado.' };
  if (input.startsAt.getTime() > input.now.getTime()) return { code: 'LOT_NOT_STARTED', message: 'Este lote ainda não começou.' };
  if (input.role !== 'BIDDER') return { code: 'ROLE_FORBIDDEN', message: 'Somente licitantes podem dar lances.' };
  if (input.leaderId === input.bidderId) return { code: 'ALREADY_LEADING', message: 'Você já está liderando este lote.' };
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 1) return { code: 'INVALID_BID', message: 'Informe um valor de lance válido.' };
  if (input.amountCents < input.minimumCents) return { code: 'BID_TOO_LOW', message: `O lance mínimo agora é R$ ${(input.minimumCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.` };
  return null;
}

export function fundsRejection(amountCents: number, availableAmountCents: number) {
  return amountCents > availableAmountCents
    ? { code: 'INSUFFICIENT_FUNDS', message: `Saldo disponível insuficiente. Você tem R$ ${(availableAmountCents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} disponíveis.` }
    : null;
}
