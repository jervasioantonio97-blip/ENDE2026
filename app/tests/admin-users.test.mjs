// Testes do cliente da Edge Function `admin-users` (sem rede).
//
// O que se verifica aqui é o contrato do navegador com a função:
//   * só envia o JWT da sessão (nunca chave de serviço);
//   * monta o payload certo para cada acção;
//   * propaga a mensagem de erro que a função devolveu.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAdminUsers } from '../src/admin-users.js';

const URL_ = 'https://exemplo.supabase.co';
const KEY = 'sb_publishable_teste';
const TOKEN = 'jwt-do-utilizador';

/** Grava cada chamada e devolve a resposta do `handler`. */
function recorder(handler) {
  const calls = [];
  return {
    calls,
    fetchFn: async (path, options = {}) => {
      const call = {
        path,
        options,
        method: options.method || 'GET',
        body: safeParse(options.body),
        headers: options.headers || {},
      };
      calls.push(call);
      return handler(call);
    },
  };
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeClient(handler, { token = TOKEN } = {}) {
  const { calls, fetchFn } = recorder(handler);
  const admin = createAdminUsers({
    url: URL_,
    anonKey: KEY,
    getToken: () => token,
    fetchFn,
  });
  return { calls, admin };
}

// ── construção ───────────────────────────────────────────────────────────────

test('exige url e anonKey', () => {
  assert.throws(() => createAdminUsers({ url: '', anonKey: KEY }), /obrigatórios/);
  assert.throws(() => createAdminUsers({ url: URL_, anonKey: '' }), /obrigatórios/);
});

test('acrescenta /functions/v1/admin-users à base da URL', async () => {
  const { calls, admin } = makeClient(() => json(200, { users: [] }));
  await admin.list();
  assert.equal(calls[0].path, `${URL_}/functions/v1/admin-users`);
});

// ── credenciais enviadas ─────────────────────────────────────────────────────

test('envia só apikey, JWT do utilizador e content-type — sem chave de serviço', async () => {
  const { calls, admin } = makeClient(() => json(200, { users: [] }));
  await admin.list();

  const h = calls[0].headers;
  assert.equal(h.apikey, KEY, 'apikey tem de ser a publishable');
  assert.equal(h.Authorization, `Bearer ${TOKEN}`, 'o token é o da sessão');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h.apikey.startsWith('sb_secret'), false, 'nunca chave de serviço');
});

test('sem token recusa antes de fazer o pedido', async () => {
  const { calls, admin } = makeClient(() => json(200, { users: [] }), { token: null });
  await assert.rejects(() => admin.list(), /Sessão expirada/);
  assert.equal(calls.length, 0, 'nenhum pedido sai sem sessão');
});

// ── payload por acção ────────────────────────────────────────────────────────

test('list envia action: list', async () => {
  const { calls, admin } = makeClient(() => json(200, { users: [] }));
  await admin.list();
  assert.deepEqual(calls[0].body, { action: 'list' });
  assert.equal(calls[0].method, 'POST');
});

test('create monta o payload com email, nome, papel e password opcional', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  await admin.create({
    email: ' operador@exemplo.com ',
    fullName: '  Ana Operadora ',
    role: 'operador',
    password: 'senha1234',
  });
  assert.deepEqual(calls[0].body, {
    action: 'create',
    email: 'operador@exemplo.com',
    full_name: 'Ana Operadora',
    role: 'operador',
    password: 'senha1234',
  });
});

test('create sem password não inclui o campo (a função gera uma)', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  await admin.create({ email: 'x@exemplo.com', fullName: 'X', role: 'admin' });
  assert.equal('password' in calls[0].body, false);
});

test('create sem role leva operador por omissão', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  await admin.create({ email: 'x@exemplo.com' });
  assert.equal(calls[0].body.role, 'operador');
});

test('create de cliente inclui client_id no payload', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  const clientId = '3ebc0f9a-9827-41e9-abeb-dfd828f015c3';
  await admin.create({
    email: 'cliente@exemplo.com',
    fullName: 'Cliente Teste',
    role: 'cliente',
    clientId,
  });
  assert.deepEqual(calls[0].body, {
    action: 'create',
    email: 'cliente@exemplo.com',
    full_name: 'Cliente Teste',
    role: 'cliente',
    client_id: clientId,
  });
});

test('create sem clientId não envia client_id (papéis admin/operador)', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  await admin.create({ email: 'op@exemplo.com', role: 'operador', clientId: '' });
  assert.equal('client_id' in calls[0].body, false);
});

test('reset envia action e user_id', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  const id = 'b79ab832-7a7d-49d2-bd3b-c666a1ea10d6';
  await admin.reset(id);
  assert.deepEqual(calls[0].body, { action: 'reset', user_id: id });
});

test('revoke envia action e user_id', async () => {
  const { calls, admin } = makeClient(() => json(200, {}));
  const id = 'b79ab832-7a7d-49d2-bd3b-c666a1ea10d6';
  await admin.revoke(id);
  assert.deepEqual(calls[0].body, { action: 'revoke', user_id: id });
});

// ── propagação de erros ──────────────────────────────────────────────────────

test('a mensagem de erro da função chega intacta, com o status', async () => {
  const { admin } = makeClient(() => json(403, { error: 'Apenas administradores.' }));
  await assert.rejects(
    () => admin.list(),
    (err) => {
      assert.equal(err.message, 'Apenas administradores.');
      assert.equal(err.status, 403);
      return true;
    },
  );
});

test('404 explica que a função não está publicada', async () => {
  const { admin } = makeClient(() => new Response('not found', { status: 404 }));
  await assert.rejects(() => admin.list(), /não publicada/);
});

test('resposta sem corpo usa o status como mensagem', async () => {
  const { admin } = makeClient(() => new Response('', { status: 500 }));
  await assert.rejects(
    () => admin.list(),
    (err) => {
      assert.equal(err.message, 'Falha no pedido (500).');
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('JSON inválido na resposta não lança de forma obscura', async () => {
  const { admin } = makeClient(() => new Response('<html>erro</html>', { status: 502 }));
  await assert.rejects(() => admin.list(), /Falha no pedido \(502\)/);
});

// ── sucesso ──────────────────────────────────────────────────────────────────

test('devolve o corpo da função nas quatro acções', async () => {
  const { admin } = makeClient((call) => {
    const action = call.body?.action;
    if (action === 'list') return json(200, { users: [{ id: '1', email: 'a@b.c' }] });
    if (action === 'create') return json(200, { id: '2', email: 'a@b.c', password: 'gerada123' });
    if (action === 'reset') return json(200, { id: '1', password: 'nova123' });
    return json(200, { id: '1', revoked: true });
  });

  assert.deepEqual(await admin.list(), { users: [{ id: '1', email: 'a@b.c' }] });
  assert.equal((await admin.create({ email: 'a@b.c' })).password, 'gerada123');
  assert.equal((await admin.reset('1')).password, 'nova123');
  assert.equal((await admin.revoke('1')).revoked, true);
});
