import { describe, expect, it } from 'vitest';
import { antiSnipingEnd, availableCents, bidRuleRejection, fundsRejection, lotState, minimumBid } from '../apps/api/src/auction-rules';

const now = new Date('2026-10-26T15:00:00.000Z');
const live = { now, startsAt: new Date(now.getTime() - 60_000), endsAt: new Date(now.getTime() + 600_000), role: 'BIDDER', bidderId: 'bidder-a', amountCents: 10_000, minimumCents: 10_000 };

describe('regras do leilão', () => {
  it('aceita o lance inicial configurado e exige incremento nos próximos', () => {
    expect(minimumBid(10_000, null, 500)).toBe(10_000);
    expect(minimumBid(10_000, 10_000, 500)).toBe(10_500);
  });

  it('só considera saldo não comprometido como disponível', () => {
    expect(availableCents(50_000, 14_000)).toBe(36_000);
    expect(fundsRejection(36_001, 36_000)?.code).toBe('INSUFFICIENT_FUNDS');
    expect(fundsRejection(36_000, 36_000)).toBeNull();
  });

  it('rejeita usuário sem papel de licitante e líder que tenta cobrir seu próprio lance', () => {
    expect(bidRuleRejection({ ...live, role: 'SELLER' })?.code).toBe('ROLE_FORBIDDEN');
    expect(bidRuleRejection({ ...live, leaderId: 'bidder-a' })?.code).toBe('ALREADY_LEADING');
  });

  it('rejeita lance abaixo do mínimo, lote agendado, encerrado e cancelado', () => {
    expect(bidRuleRejection({ ...live, amountCents: 9_999 })?.code).toBe('BID_TOO_LOW');
    expect(bidRuleRejection({ ...live, startsAt: new Date(now.getTime() + 1) })?.code).toBe('LOT_NOT_STARTED');
    expect(bidRuleRejection({ ...live, endsAt: now })?.code).toBe('LOT_CLOSED');
    expect(bidRuleRejection({ ...live, cancelledAt: now })?.code).toBe('LOT_CANCELLED');
    expect(bidRuleRejection({ ...live, settledAt: now })?.code).toBe('LOT_CLOSED');
  });

  it('usa o relógio informado para determinar o estado persistido do lote', () => {
    expect(lotState({ startsAt: new Date(now.getTime() + 1), endsAt: new Date(now.getTime() + 60_000) }, now)).toBe('scheduled');
    expect(lotState({ startsAt: new Date(now.getTime() - 1), endsAt: new Date(now.getTime() + 60_000) }, now)).toBe('live');
    expect(lotState({ startsAt: new Date(now.getTime() - 60_000), endsAt: now }, now)).toBe('closed');
    expect(lotState({ startsAt: now, endsAt: now, cancelledAt: now }, now)).toBe('cancelled');
  });

  it('prorroga para dois minutos após um lance aceito dentro da janela final', () => {
    const end = new Date(now.getTime() + 120_000);
    expect(antiSnipingEnd(end, now)).toEqual(new Date(now.getTime() + 120_000));
    expect(antiSnipingEnd(new Date(now.getTime() + 121_000), now)).toEqual(new Date(now.getTime() + 121_000));
  });
});
