// Testes do adaptador remoto contra um PostgREST simulado (sem rede).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSupabaseRemote,
  toServer,
  coerce,
  COLUMNS,
} from '../src/remote-supabase.js';

const URL_ = 'https://exemplo.supabase.co';
const KEY = 'sb_publishable_teste';
const ORG = '5361fabf-3a91-482d-abbc-c5ad5f6aa57e';

function json(status, body) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function safeParse(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Grava cada chamada e devolve a resposta do `handler`. */
function recorder(handler) {
  const calls = [];
  return {
    calls,
    fetchFn: async (path, options = {}) => {
      const call = { path, options, method: options.method || 'GET', body: safeParse(options.body) };
      calls.push(call);
      return handler(call);
    },
  };
}

function makeRemote(handler) {
  const { calls, fetchFn } = recorder(handler);
  return {
    calls,
    remote: createSupabaseRemote({
      url: URL_,
      anonKey: KEY,
      getToken: () => 'token-do-utilizador',
      getOrgId: () => ORG,
      fetchFn,
    }),
  };
}

/**
 * PostgREST simulado para GET: honra `seq=gt.N`, `order=seq.asc` e `limit`.
 * É isto que permite testar a paginação sem rede e sem motor de SQL.
 */
function fakeGet(getTables) {
  return (call) => {
    const table = /\/rest\/v1\/(\w+)\?/.exec(call.path)?.[1];
    const gt = Number(/seq=gt\.(\d+)/.exec(call.path)?.[1] ?? 0);
    const limit = Number(/limit=(\d+)/.exec(call.path)?.[1] ?? 100);
    const rows = (getTables()[table] ?? [])
      .filter((r) => r.seq > gt)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
    return json(200, rows);
  };
}

// ── toServer / coerce ────────────────────────────────────────────────────────

test('toServer envia só colunas de negócio e injecta org_id', () => {
  const row = {
    id: 'a', ref: 'L1', name: 'Ana', contact: '9xx', whatsapp: '', iban: '',
    year: '2026', rev: 9, seq: 4, updatedAt: 'x', serverRev: 3, created_at: 'y',
  };
  const out = toServer('clients', row, ORG);

  assert.deepEqual(Object.keys(out).sort(), ['contact', 'iban', 'name', 'org_id', 'ref', 'whatsapp', 'year'].sort());
  assert.equal(out.org_id, ORG);
  assert.ok(!('rev' in out), 'rev é do servidor');
  assert.ok(!('seq' in out), 'seq é do servidor');
  assert.ok(!('created_at' in out), 'created_at é do servidor');
  assert.ok(!('updatedAt' in out), 'updatedAt local não vai para o servidor');
  assert.ok(!('serverRev' in out));
  assert.strictEqual(out.contact, '9xx');
  assert.strictEqual(out.whatsapp, '', 'texto vazio é valor, não null');
});

test('coerce converte para os tipos que o PostgREST espera', () => {
  assert.strictEqual(coerce('year', '2026'), 2026);
  assert.strictEqual(coerce('amount', '1500.50'), 1500.5);
  assert.strictEqual(coerce('date', '2026-11-15T00:00:00.000Z'), '2026-11-15');
  assert.strictEqual(coerce('issue', ''), null, 'datas vazias vão a null');
  assert.strictEqual(coerce('iban', ''), '', 'texto vazio mantém-se');
  assert.strictEqual(coerce('amount', ''), null, 'número vazio não vira 0');
  assert.strictEqual(coerce('year', undefined), null);
});

test('toServer omite colunas NOT NULL que chegaram a null', () => {
  const out = toServer('payments', { org_id: ORG, client_id: 'c1', period: '11/2026', date: '', amount: null }, ORG);
  assert.ok(!('date' in out));
  assert.ok(!('amount' in out));
  assert.equal(out.period, '11/2026');
});

test('toServer recusa tabela desconhecida', () => {
  assert.throws(() => toServer('orgs', {}, ORG), /Tabela desconhecida/);
});

test('COLUMNS cobre exactamente as tabelas sincronizáveis', () => {
  assert.deepEqual(Object.keys(COLUMNS), ['clients', 'payments', 'bills']);
  for (const [table, cols] of Object.entries(COLUMNS)) {
    assert.ok(cols.includes('org_id'), `${table} precisa de org_id para passar o RLS`);
    assert.ok(!cols.includes('rev') && !cols.includes('seq'), `${table} não escreve rev/seq`);
  }
});

// ── insert ───────────────────────────────────────────────────────────────────

test('insert envia o id gerado localmente (identidade única)', async () => {
  // Regressão: sem isto o servidor gera um id novo, o pull entrega a conta
  // outra vez e o cliente vê duplicados.
  const { remote, calls } = makeRemote(() => json(201, [{ id: 'r1', rev: 1, seq: 1 }]));
  await remote.insert('clients', { id: 'r1', ref: 'L1', name: 'Ana' });
  assert.equal(calls[0].body.id, 'r1');
});

test('update NÃO reenvia o id no corpo (identidade vem do URL)', async () => {
  const { remote, calls } = makeRemote(() => json(200, [{ id: 'r1', rev: 2 }]));
  await remote.update('clients', 'r1', { id: 'r1', ref: 'L1' }, 1);
  assert.ok(!('id' in calls[0].body));
});

test('insert envia POST com Prefer: return=representation e a chave certa', async () => {
  const serverRow = { id: 'r1', rev: 1, seq: 1, org_id: ORG, ref: 'L1' };
  const { remote, calls } = makeRemote(() => json(201, [serverRow]));

  const result = await remote.insert('clients', { id: 'r1', ref: 'L1', name: 'Ana', year: '2026' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.row, serverRow);

  const call = calls[0];
  assert.equal(call.path, `${URL_}/rest/v1/clients`);
  assert.equal(call.method, 'POST');
  assert.equal(call.options.headers.Prefer, 'return=representation');
  assert.equal(call.options.headers.apikey, KEY);
  assert.equal(call.options.headers.Authorization, 'Bearer token-do-utilizador');
  assert.equal(call.body.org_id, ORG);
  assert.strictEqual(call.body.year, 2026, 'year deve ir como número');
  assert.ok(!('rev' in call.body));
});

test('insert sem sessão lança erro sem chegar à rede', async () => {
  let chamadas = 0;
  const semToken = createSupabaseRemote({
    url: URL_,
    anonKey: KEY,
    getToken: () => null,
    getOrgId: () => ORG,
    fetchFn: async () => {
      chamadas++;
      return json(201, [{}]);
    },
  });
  await assert.rejects(() => semToken.insert('clients', { ref: 'L1' }), /Sessão expirada/);
  assert.equal(chamadas, 0);
});

test('insert 409 (referência repetida) lança erro legível', async () => {
  const { remote } = makeRemote(() =>
    json(409, { code: '23505', message: 'duplicate key value violates unique constraint' }),
  );
  await assert.rejects(
    () => remote.insert('clients', { ref: 'L1', name: 'Ana' }),
    (err) => {
      assert.match(err.message, /O servidor já tem este registo/);
      assert.equal(err.duplicate, true);
      return true;
    },
  );
});

test('insert rejeitado pelo RLS (403) propaga a mensagem do servidor', async () => {
  const { remote } = makeRemote(() =>
    json(403, { code: '42501', message: 'new row violates row-level security policy' }),
  );
  await assert.rejects(() => remote.insert('clients', { ref: 'L1' }), /row-level security/);
});

// ── update ───────────────────────────────────────────────────────────────────

test('update filtra por id E rev: só assim o bloqueio optimista funciona', async () => {
  const row = { id: 'r1', rev: 7, seq: 12 };
  const { remote, calls } = makeRemote(() => json(200, [row]));

  const result = await remote.update('clients', 'r1', { ref: 'L1' }, 6);

  assert.equal(result.ok, true);
  assert.deepEqual(result.row, row);
  assert.equal(calls[0].method, 'PATCH');
  assert.match(calls[0].path, /id=eq\.r1/);
  assert.match(calls[0].path, /rev=eq\.6/);
});

test('update com rev obsoleto devolve { ok:false, serverRow }', async () => {
  const serverRow = { id: 'r1', rev: 9, seq: 20, ref: 'L1' };
  const { remote, calls } = makeRemote((call) => {
    if (call.method === 'PATCH') return json(200, []);
    return json(200, [serverRow]);
  });

  const result = await remote.update('clients', 'r1', { ref: 'L1' }, 6);

  assert.equal(result.ok, false);
  assert.deepEqual(result.serverRow, serverRow);
  assert.equal(calls.length, 2, 'PATCH sem efeito obriga a reler do servidor');
  assert.match(calls[1].path, /\/rest\/v1\/clients\?id=eq\.r1/);
});

test('update com baseRev nulo não filtra por rev (caminho de rebase)', async () => {
  const { remote, calls } = makeRemote(() => json(200, [{ id: 'r1', rev: 9 }]));
  await remote.update('clients', 'r1', { ref: 'L1' }, null);
  assert.ok(!calls[0].path.includes('rev=eq'), 'sem rev quando o chamador não o conhece');
});

test('update de registo inexistente no servidor cai para insert', async () => {
  const { remote, calls } = makeRemote((call) => {
    if (call.method === 'PATCH') return json(200, []);
    if (call.method === 'GET') return json(200, []); // não existe
    return json(201, [{ id: 'r1', rev: 1, seq: 1 }]);
  });

  const result = await remote.update('clients', 'r1', { ref: 'L1' }, 6);

  assert.equal(result.ok, true);
  assert.equal(calls.at(-1).method, 'POST', 'última chamada deve ser o insert');
  assert.equal(calls.length, 3);
});

// ── pull ─────────────────────────────────────────────────────────────────────

test('pull junta as três tabelas e ordena por seq', async () => {
  const data = {
    clients: [{ id: 'a', seq: 5 }, { id: 'b', seq: 9 }],
    payments: [{ id: 'c', seq: 7 }],
    bills: [],
  };
  const { remote, calls } = makeRemote(fakeGet(() => data));

  const page = await remote.pull(0, 100);

  assert.equal(page.hasMore, false);
  assert.deepEqual(page.rows.map((r) => r.row.seq), [5, 7, 9]);
  assert.deepEqual(page.rows.map((r) => r.table), ['clients', 'payments', 'clients']);
  assert.equal(calls.length, 3, 'uma chamada por tabela');
  assert.match(calls[0].path, /seq=gt\.0/);
  assert.match(calls[0].path, /order=seq\.asc/);
  assert.match(calls[0].path, /limit=100/);
});

test('pull sem registos devolve página vazia com hasMore false', async () => {
  const { remote } = makeRemote(fakeGet(() => ({})));
  const page = await remote.pull(42, 50);
  assert.deepEqual(page.rows, []);
  assert.equal(page.hasMore, false);
});

test('paginação: nunca salta registos com tabelas desfasadas', async () => {
  // O erro clássico seria avançar o cursor até ao máximo global e perder os
  // registos intermédios da outra tabela.
  const data = {
    clients: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, seq: n })),
    payments: [10, 11].map((n) => ({ id: `p${n}`, seq: n })),
    bills: [],
  };
  const { remote } = makeRemote(fakeGet(() => data));

  const p1 = await remote.pull(0, 2);
  assert.equal(p1.hasMore, true);
  assert.deepEqual(p1.rows.map((r) => r.row.seq), [1, 2],
    'cursor trava no mínimo dos máximos saturados, não no máximo global');

  const p2 = await remote.pull(p1.rows.at(-1).row.seq, 2);
  assert.equal(p2.hasMore, true);
  assert.deepEqual(p2.rows.map((r) => r.row.seq), [3, 4]);

  const p3 = await remote.pull(p2.rows.at(-1).row.seq, 2);
  assert.equal(p3.hasMore, true);
  assert.deepEqual(p3.rows.map((r) => r.row.seq), [5, 10, 11],
    'os registos 10 e 11 ficaram retidos e são entregues agora');

  const p4 = await remote.pull(p3.rows.at(-1).row.seq, 2);
  assert.equal(p4.hasMore, false);
  assert.deepEqual(p4.rows, []);
});

test('pull cobre todos os registos exactamente uma vez no total', async () => {
  const data = { clients: [1, 2, 3, 4, 5].map((n) => ({ id: `c${n}`, seq: n })), payments: [], bills: [] };
  const { remote } = makeRemote(fakeGet(() => data));

  const seen = new Set();
  let cursor = 0;
  for (let i = 0; i < 20; i++) {
    const page = await remote.pull(cursor, 2);
    for (const { row } of page.rows) seen.add(row.seq);
    if (!page.hasMore || page.rows.length === 0) break;
    cursor = page.rows.at(-1).row.seq;
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});
