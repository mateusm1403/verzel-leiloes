import 'dotenv/config';

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || Buffer.byteLength(value) < 32) {
    throw new Error(`${name} precisa ter pelo menos 32 bytes. Configure essa variável no ambiente.`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  appOrigin: process.env.APP_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173',
  jwtSecret: requiredSecret('JWT_SECRET'),
  auditSecret: requiredSecret('AUDIT_SECRET'),
  cookieSecure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  cookieName: 'verzel_session',
};
