import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../next.config.mjs';

test('retired Guide redirects before rendering so browsers retain legacy anchors', async () => {
  const routes = await config.redirects();
  const redirect = routes.find(route => route.source === '/help');
  assert.deepEqual(redirect, { source: '/help', destination: '/about', permanent: true });
  assert.ok(routes.indexOf(redirect) < routes.findIndex(route => route.source === '/:path*'));
  assert.ok(!routes.some(route => route.source === '/about'), 'About must not redirect back to Guide');
});
