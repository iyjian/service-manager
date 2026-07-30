const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  SQL_API_BASE_URLS,
  SQL_SCHEMA_TABLE_BATCH_SIZE,
  SqlRuntime,
  buildSqlSchemaColumnsStatement,
  hashSqlPassword,
} = require('../dist/main/sqlRuntime');

function response(data, options = {}) {
  return new Response(JSON.stringify({ err: options.err ?? 0, errMsg: options.errMsg, data }), {
    status: options.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function credentialStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    has: (environment) => values.has(environment),
    reveal: async (environment) => {
      const value = values.get(environment);
      if (!value) throw new Error('missing');
      return value;
    },
    save: async (environment, value) => { values.set(environment, value); },
    remove: async (environment) => { values.delete(environment); },
    flush: async () => {},
    values,
  };
}

test('SQL runtime follows sd-pc-front login, keeps endpoints fixed, and returns only the current user records', async () => {
  const calls = [];
  const credentialsStore = credentialStore();
  const runtime = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, init });
      if (parsed.pathname.endsWith('/auth/users/login')) {
        const body = JSON.parse(init.body);
        assert.deepEqual(body, {
          userName: 'owner@example.test',
          passwd: createHash('md5').update('secret').digest('hex'),
        });
        assert.equal(init.redirect, 'manual');
        return response({ token: 'private-token' });
      }
      if (parsed.pathname.endsWith('/user/detail')) {
        assert.equal(init.headers.token, 'private-token');
        return response({ id: 7, name: 'Owner', userName: 'owner@example.test' });
      }
      if (parsed.pathname.endsWith('/sqlQuery')) {
        assert.equal(parsed.searchParams.get('creatorId'), '7');
        return response({
          count: 2,
          rows: [
            { id: 1, name: 'Mine', sql: 'select 1', creatorId: 7 },
            { id: 2, name: 'Other', sql: 'select 2', creatorId: 9 },
          ],
        });
      }
      throw new Error(`Unexpected request ${parsed.pathname}`);
    },
  });

  const auth = await runtime.login({
    environment: 'production',
    userName: 'owner@example.test',
    password: 'secret',
  });
  assert.deepEqual(auth.user, { id: 7, name: 'Owner', userName: 'owner@example.test' });
  assert.equal(auth.hasSavedCredentials, true);
  assert.deepEqual((await runtime.listQueries('production')).map((record) => record.name), ['Mine']);
  assert.equal(calls[0].url.origin + '/api', SQL_API_BASE_URLS.production);
  assert.equal(calls.every((call) => call.url.origin === 'https://sd-pc.tiusolution.com'), true);
});

test('SQL password hashing matches the byte-oriented jcjy-components login behavior', () => {
  assert.equal(hashSqlPassword('secret'), createHash('md5').update('secret').digest('hex'));
  assert.equal(hashSqlPassword('密碼'), createHash('md5').update(Buffer.from('密碼', 'latin1')).digest('hex'));
});

test('SQL login failures use login-specific safe messages without changing query errors', async () => {
  const unavailable = new SqlRuntime({
    credentialsStore: credentialStore(),
    fetchImpl: async () => response(undefined, { status: 502 }),
  });
  await assert.rejects(
    unavailable.login({ environment: 'production', userName: 'owner', password: 'secret' }),
    /Login failed \(502\)\./,
  );

  const offline = new SqlRuntime({
    credentialsStore: credentialStore(),
    fetchImpl: async () => { throw new Error('private network detail'); },
  });
  await assert.rejects(
    offline.login({ environment: 'development', userName: 'owner', password: 'secret' }),
    /Login failed\./,
  );

  const credentialsStore = credentialStore();
  const queryFailure = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/users/login')) return response({ token: 'token' });
      if (pathname.endsWith('/user/detail')) return response({ id: 7, name: 'Owner', userName: 'owner' });
      return response(undefined, { status: 502 });
    },
  });
  await queryFailure.login({ environment: 'production', userName: 'owner', password: 'secret' });
  await assert.rejects(
    queryFailure.execute('production', 'select 1'),
    /The SQL request failed \(502\)\./,
  );
});

test('SQL runtime performs one saved-credential relogin and replays a request once after err 401', async () => {
  const saved = { userName: 'owner', passwd: 'c'.repeat(32) };
  const credentialsStore = credentialStore({ production: saved });
  let loginCount = 0;
  let executeCount = 0;
  const runtime = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/users/login')) {
        loginCount += 1;
        return response({ token: `token-${loginCount}` });
      }
      if (pathname.endsWith('/user/detail')) {
        return response({ id: 3, name: 'Owner', userName: 'owner' });
      }
      if (pathname.endsWith('/system/profile')) {
        executeCount += 1;
        assert.equal(init.headers.token, executeCount === 1 ? 'token-1' : 'token-2');
        if (executeCount === 1) return response(undefined, { err: 401, errMsg: 'expired' });
        return response([{ ok: 1 }]);
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  assert.equal((await runtime.getAuthState('production')).status, 'signed-in');
  const result = await runtime.execute('production', 'select 1');
  assert.deepEqual(result.value, [{ ok: 1 }]);
  assert.equal(Number.isFinite(result.durationMs), true);
  assert.equal(result.durationMs >= 0, true);
  assert.equal(loginCount, 2);
  assert.equal(executeCount, 2);

  const signedOut = await runtime.logout('production');
  assert.equal(signedOut.status, 'signed-out');
  assert.equal(signedOut.hasSavedCredentials, false);
  assert.equal(credentialsStore.values.has('production'), false);
});

test('SQL runtime renames an owned record with a name-only patch', async () => {
  const credentialsStore = credentialStore({ development: { userName: 'dev', passwd: 'd'.repeat(32) } });
  const patchBodies = [];
  let currentName = 'Before';
  const runtime = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/users/login')) return response({ token: 'dev-token' });
      if (pathname.endsWith('/user/detail')) return response({ id: 4, name: 'Dev', userName: 'dev' });
      if (pathname.endsWith('/sqlQuery/8') && (init.method ?? 'GET') === 'GET') {
        return response({ id: 8, name: currentName, sql: 'select 8', creatorId: 4 });
      }
      if (pathname.endsWith('/sqlQuery/8') && init.method === 'PATCH') {
        const body = JSON.parse(init.body);
        patchBodies.push(body);
        currentName = body.name;
        return response(null);
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  await runtime.getAuthState('development');
  const renamed = await runtime.renameQuery('development', 8, '  After  ');
  assert.equal(renamed.name, 'After');
  assert.equal(renamed.sql, 'select 8');
  assert.deepEqual(patchBodies, [{ name: 'After' }]);
  await assert.rejects(runtime.renameQuery('development', 8, '   '), /valid query name/i);
});

test('SQL runtime does not loop when the replay is also unauthorized', async () => {
  const credentialsStore = credentialStore({ development: { userName: 'dev', passwd: 'd'.repeat(32) } });
  let loginCount = 0;
  let executeCount = 0;
  const runtime = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/users/login')) {
        loginCount += 1;
        return response({ token: `dev-token-${loginCount}` });
      }
      if (pathname.endsWith('/user/detail')) return response({ id: 4, name: 'Dev', userName: 'dev' });
      if (pathname.endsWith('/system/profile')) {
        executeCount += 1;
        return response(undefined, { err: 401, errMsg: 'expired' });
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  await runtime.getAuthState('development');
  await assert.rejects(runtime.execute('development', 'select 1'), /session expired/i);
  assert.equal(loginCount, 2);
  assert.equal(executeCount, 2);
});

test('SQL schema loading is bounded, batched, deduplicated, cached, and detached', async () => {
  const credentialsStore = credentialStore({ production: { userName: 'owner', passwd: 'a'.repeat(32) } });
  const tableNames = Array.from({ length: SQL_SCHEMA_TABLE_BATCH_SIZE + 1 }, (_value, index) => `t_${index}`);
  const schemaStatements = [];
  const runtime = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/users/login')) return response({ token: 'schema-token' });
      if (pathname.endsWith('/user/detail')) {
        return response({ id: 7, name: 'Owner', userName: 'owner' });
      }
      if (pathname.endsWith('/system/profile')) {
        const { statement } = JSON.parse(init.body);
        schemaStatements.push(statement);
        if (/from information_schema\.tables/i.test(statement)) {
          return response(tableNames.map((tableName) => ({ tableName })));
        }
        const names = [...statement.matchAll(/'((?:''|\\\\|[^'])+)'/g)]
          .map((match) => match[1].replace(/''/g, "'").replace(/\\\\/g, '\\'));
        return response(names.map((tableName) => ({
          tableName,
          columnName: `${tableName}_id`,
          dataType: 'bigint',
        })));
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  await runtime.getAuthState('production');
  const [left, right] = await Promise.all([
    runtime.getSchema('production'),
    runtime.getSchema('production'),
  ]);

  assert.deepEqual(left, right);
  assert.equal(left.tables.length, tableNames.length);
  assert.equal(schemaStatements.length, 3);
  assert.equal(schemaStatements.filter((statement) => /information_schema\.columns/i.test(statement)).length, 2);
  left.tables[0].name = 'mutated';
  left.tables[0].columns[0].name = 'mutated';
  const cached = await runtime.getSchema('production');
  assert.equal(cached.tables[0].name, 't_0');
  assert.equal(cached.tables[0].columns[0].name, 't_0_id');
  assert.equal(schemaStatements.length, 3);
});

test('SQL schema column statements quote server-owned names and enforce the batch bound', () => {
  const statement = buildSqlSchemaColumnsStatement(["ordinary", "quote'name", 'slash\\name']);
  assert.match(statement, /table_name in \('ordinary', 'quote''name', 'slash\\\\name'\)/);
  assert.throws(
    () => buildSqlSchemaColumnsStatement(
      Array.from({ length: SQL_SCHEMA_TABLE_BATCH_SIZE + 1 }, (_value, index) => `t_${index}`),
    ),
    /schema table batch is invalid/i,
  );
});

test('SQL schema cache is environment-session scoped and cleared by explicit sign out', async () => {
  const credentialsStore = credentialStore();
  let schemaTableRequests = 0;
  let loginCount = 0;
  const runtime = new SqlRuntime({
    credentialsStore,
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/auth/users/login')) {
        loginCount += 1;
        return response({ token: `token-${loginCount}` });
      }
      if (pathname.endsWith('/user/detail')) {
        return response({ id: 7, name: 'Owner', userName: 'owner' });
      }
      if (pathname.endsWith('/system/profile')) {
        const { statement } = JSON.parse(init.body);
        if (/from information_schema\.tables/i.test(statement)) {
          schemaTableRequests += 1;
          return response([{ tableName: 't_user' }]);
        }
        return response([{ tableName: 't_user', columnName: 'id', dataType: 'bigint' }]);
      }
      throw new Error(`Unexpected request ${pathname}`);
    },
  });

  await runtime.login({
    environment: 'production',
    userName: 'owner',
    password: 'first-password',
  });
  await runtime.getSchema('production');
  await runtime.logout('production');
  await runtime.login({
    environment: 'production',
    userName: 'owner',
    password: 'second-password',
  });
  await runtime.getSchema('production');

  assert.equal(schemaTableRequests, 2);
});
