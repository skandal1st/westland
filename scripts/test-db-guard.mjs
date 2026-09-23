/** Only the disposable Compose database is permitted in integration tests. */
export function assertTestDatabase(env = process.env) {
  const fail = () => { throw new Error('Refusing test database access: use docker-compose.test.yml, AXIMA_TEST_DATABASE=1, and the axima_test role / axima_commerce_test database on loopback:55432 or postgres-test:5432.'); };
  if (env.AXIMA_TEST_DATABASE !== '1' || !env.DATABASE_URL) fail();
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { fail(); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port === '55432';
  const container = url.hostname === 'postgres-test' && url.port === '5432';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !(local || container)
    || url.username !== 'axima_test' || url.pathname !== '/axima_commerce_test' || url.hash) fail();
  for (const [key, value] of url.searchParams) {
    if (key !== 'schema' || value !== 'public') fail();
  }
}
