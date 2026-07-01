import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { authSpaRoutes } from '../nextjsOnlyRoutes';

/**
 * Guards the three parallel route lists that must stay in sync for an auth-SPA
 * route to actually work end-to-end:
 *
 *   1. `authSpaRoutes` (nextjsOnlyRoutes.ts) — tells the middleware to rewrite
 *      the path to the auth SPA.
 *   2. `config.matcher` in `src/proxy.ts` — Next only RUNS the middleware on
 *      matched paths ("required to be literal", so it can't import the array).
 *   3. `isPublicRoute` in define-config.ts — anonymous-reachable auth pages
 *      must be listed or the better-auth middleware session-gates them.
 *
 * A route present in (1) but missing from (2) silently 404s in production —
 * exactly what happened to the team-mode `/join` landing on first deploy.
 */
describe('proxy route lists stay in sync', () => {
  const proxySource = readFileSync(join(__dirname, '../../../proxy.ts'), 'utf8');
  const defineConfigSource = readFileSync(join(__dirname, 'define-config.ts'), 'utf8');

  it('every authSpaRoutes entry is covered by the src/proxy.ts config.matcher', () => {
    for (const route of authSpaRoutes) {
      const covered =
        proxySource.includes(`'${route}(.*)'`) || proxySource.includes(`'${route}'`);
      expect(covered, `matcher in src/proxy.ts is missing '${route}(.*)'`).toBe(true);
    }
  });

  it('anonymous auth-SPA landings are public routes in define-config', () => {
    // Routes an anonymous visitor must reach (signup flow + invite landing).
    const anonymousRoutes = ['/signin', '/signup', '/join'];
    for (const route of anonymousRoutes) {
      const covered =
        defineConfigSource.includes(`'${route}(.*)'`) || defineConfigSource.includes(`'${route}'`);
      expect(covered, `isPublicRoute in define-config.ts is missing '${route}'`).toBe(true);
    }
  });
});
