// Next.js routes that must NOT go to SPA catch-all.
// Shared between middleware (define-config.ts) and the client Link adapter.
export const nextjsOnlyRoutes = ['/discover'];

// Routes served by the standalone auth SPA (/spa-auth). The main SPA must
// hard-navigate to them (cross-app), so the Link adapter treats them like
// nextjsOnlyRoutes.
export const authSpaRoutes = [
  '/signin',
  '/signup',
  // Team mode (fork): public invite landing. `/join`, NOT `/invite` — upstream
  // reserves `/invite/*` for its cloud workspace invites.
  '/join',
  '/auth-error',
  '/reset-password',
  '/verify-email',
  '/oauth',
  '/market-auth-callback',
];
