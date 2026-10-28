import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ZERO_HASH = '0'.repeat(64);

export interface AuditEvent {
  lotId: string;
  sequence: number;
  userId: string;
  amountCents: number | string;
  createdAt: Date | string;
  previousHash: string;
  eventHash: string;
}

export interface AuditHead {
  lotId: string;
  sequence: number;
  finalHash: string;
  signature: string;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Data de auditoria inválida.');
  return date.toISOString();
}

export function eventHash(event: Omit<AuditEvent, 'eventHash'>): string {
  const canonical = JSON.stringify([
    event.lotId,
    event.sequence,
    event.userId,
    Number(event.amountCents),
    iso(event.createdAt),
    event.previousHash,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function signHead(lotId: string, sequence: number, finalHash: string, secret: string): string {
  return createHmac('sha256', secret).update(JSON.stringify([lotId, sequence, finalHash]), 'utf8').digest('hex');
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function verifyAudit(events: AuditEvent[], head: AuditHead | null | undefined, secret: string) {
  if (!head) return { status: 'unverifiable' as const, message: 'O histórico deste lote não está disponível para conferência.' };
  if (!equalHex(head.signature, signHead(head.lotId, head.sequence, head.finalHash, secret))) {
    return { status: 'compromised' as const, message: 'A assinatura de verificação deste lote não corresponde ao resumo dos lances armazenado. Por isso, não é possível confirmar a integridade do histórico.' };
  }
  if (head.sequence !== events.length) {
    return { status: 'compromised' as const, message: 'A quantidade de lances não corresponde ao histórico registrado.' };
  }
  let previous = ZERO_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const expectedSequence = index + 1;
    if (event.lotId !== head.lotId || event.sequence !== expectedSequence || event.previousHash !== previous) {
      return { status: 'compromised' as const, message: `Foi encontrada uma divergência no lance ${expectedSequence}.` };
    }
    const expectedHash = eventHash(event);
    if (!equalHex(event.eventHash, expectedHash)) {
      return { status: 'compromised' as const, message: `Os dados do lance ${expectedSequence} não correspondem ao histórico.` };
    }
    previous = expectedHash;
  }
  if (previous !== head.finalHash) {
    return { status: 'compromised' as const, message: 'A conferência não corresponde ao histórico apresentado.' };
  }
  return { status: 'verified' as const, message: 'Os lances foram conferidos e correspondem ao histórico registrado.' };
}
