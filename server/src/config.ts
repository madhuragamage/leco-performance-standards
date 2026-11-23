import 'dotenv/config';

const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Environment variable ${name} must be set in production`);
  return devDefault;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret'),
  portalApiKey: required('PORTAL_API_KEY', 'dev-portal-key-change-me'),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  isProd,
};
