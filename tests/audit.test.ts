import { describe, expect, it } from 'vitest';
import { eventHash, signHead, verifyAudit, ZERO_HASH, type AuditEvent } from '../apps/api/src/audit';

const secret = 'segredo-de-teste-auditoria-com-mais-de-32-bytes';
const lotId = '20000000-0000-4000-8000-000000000001';

function makeEvents(): AuditEvent[] {
  const data = [
    { userId: 'user-a', amountCents: 12_000, createdAt: new Date('2026-10-26T14:00:00.000Z') },
    { userId: 'user-b', amountCents: 13_000, createdAt: new Date('2026-10-26T14:01:00.000Z') },
    { userId: 'user-c', amountCents: 14_000, createdAt: new Date('2026-10-26T14:02:00.000Z') },
  ];
  let previousHash = ZERO_HASH;
  return data.map((event, index) => {
    const base = { lotId, sequence: index + 1, ...event, previousHash };
    const complete = { ...base, eventHash: eventHash(base) };
    previousHash = complete.eventHash;
    return complete;
  });
}

function signedHead(events: AuditEvent[]) {
  const finalHash = events.at(-1)?.eventHash ?? ZERO_HASH;
  return { lotId, sequence: events.length, finalHash, signature: signHead(lotId, events.length, finalHash, secret) };
}

describe('auditoria criptográfica do histórico', () => {
  it('confirma uma cadeia íntegra e o histórico inicial vazio', () => {
    const events = makeEvents();
    expect(verifyAudit(events, signedHead(events), secret).status).toBe('verified');
    const emptyHead = { lotId, sequence: 0, finalHash: ZERO_HASH, signature: signHead(lotId, 0, ZERO_HASH, secret) };
    expect(verifyAudit([], emptyHead, secret).status).toBe('verified');
  });

  it.each([
    ['valor', (events: AuditEvent[]) => ({ ...events[0]!, amountCents: 12_001 })],
    ['participante', (events: AuditEvent[]) => ({ ...events[0]!, userId: 'attacker' })],
    ['horário', (events: AuditEvent[]) => ({ ...events[0]!, createdAt: new Date('2026-10-26T14:00:01.000Z') })],
  ])('detecta alteração de %s em um evento', (_field, alter) => {
    const events = makeEvents(); events[0] = alter(events);
    expect(verifyAudit(events, signedHead(makeEvents()), secret).status).toBe('compromised');
  });

  it('detecta remoção de evento intermediário ou do evento mais recente', () => {
    const events = makeEvents(); const head = signedHead(events);
    expect(verifyAudit([events[0]!, events[2]!], head, secret).status).toBe('compromised');
    expect(verifyAudit(events.slice(0, 2), head, secret).status).toBe('compromised');
  });

  it('detecta inserção, mudança de sequência e alteração do encadeamento', () => {
    const events = makeEvents(); const head = signedHead(events);
    const inserted = { ...events[2]!, id: 'fake', sequence: 4 };
    expect(verifyAudit([...events, inserted], head, secret).status).toBe('compromised');
    const resequenced = events.map((event) => ({ ...event })); resequenced[1]!.sequence = 8;
    expect(verifyAudit(resequenced, head, secret).status).toBe('compromised');
    const relinked = events.map((event) => ({ ...event })); relinked[1]!.previousHash = ZERO_HASH;
    expect(verifyAudit(relinked, head, secret).status).toBe('compromised');
  });

  it('detecta a troca da cabeça e reporta ausência de evidência como inconclusiva', () => {
    const events = makeEvents(); const head = signedHead(events);
    expect(verifyAudit(events, { ...head, finalHash: ZERO_HASH }, secret).status).toBe('compromised');
    expect(verifyAudit(events, { ...head, signature: 'f'.repeat(64) }, secret)).toMatchObject({
      status: 'compromised',
      message: 'A assinatura de verificação deste lote não corresponde ao resumo dos lances armazenado. Por isso, não é possível confirmar a integridade do histórico.',
    });
    expect(verifyAudit(events, null, secret).status).toBe('unverifiable');
  });
});
