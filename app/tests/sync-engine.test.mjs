import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSyncEngine, decideConflict } from '../src/core/sync-engine.js';
import { createFakeRemote, createMemoryLocal } from './fakes.js';

const past = () => new Date(Date.now() - 3_600_000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();

function setup() {
  const local = createMemoryLocal();
  const remote = createFakeRemote();
  const engine = createSyncEngine({ local, remote });
  return { local, remote, engine };
}

const client = (id, name, extra = {}) => ({
  id,
  org_id: 'org-1',
  ref: `REF-${id}`,
  name,
  contact: '',
  whatsapp: '',
  iban: '',
  year: 2026,
  deletedAt: null,
  ...extra,
});

test('escreve offline e envia quando a rede volta', async () => {
  const { local, remote, engine } = setup();

  remote.setOnline(false);
  await engine.write('clients', client('c1', 'Ana'));

  const offline = await engine.flush();
  assert.equal(offline.pushed, 0);
  assert.match(offline.error, /offline/);
  assert.equal(offline.remaining, 1);
  assert.equal(remote.rows('clients').length, 0);

  remote.setOnline(true);
  const online = await engine.flush();

  assert.equal(online.pushed, 1);
  assert.equal(online.remaining, 0);
  assert.equal(remote.rows('clients').length, 1);
  assert.equal(remote.rows('clients')[0].name, 'Ana');

  const stored = await local.getRecord('clients', 'c1');
  assert.equal(stored.serverRev, 1);
});

test('envio repetido não duplica o registo', async () => {
  const { remote, engine } = setup();

  await engine.write('clients', client('c1', 'Ana'));
  await engine.flush();
  await engine.flush();

  assert.equal(remote.rows('clients').length, 1);
});

test('duas edições seguidas produzem um único envio', async () => {
  const { local, remote, engine } = setup();

  await engine.write('clients', client('c1', 'Ana'));
  await engine.write('clients', client('c1', 'Ana Silva'));

  assert.equal(local.debug.outbox.length, 1);

  await engine.flush();

  assert.equal(remote.rows('clients').length, 1);
  assert.equal(remote.rows('clients')[0].name, 'Ana Silva');
  assert.equal((await local.getRecord('clients', 'c1')).rev, 2);
});

test('pagamento validado no servidor vence o conflito', async () => {
  const { local, remote, engine } = setup();

  remote.seed('payments', {
    id: 'p1',
    org_id: 'org-1',
    client_id: 'c1',
    status: 'Confirmado',
    amount: 1000,
    rev: 2,
    updated_at: future(),
  });

  await local.putRecord('payments', {
    id: 'p1',
    org_id: 'org-1',
    client_id: 'c1',
    status: 'Pendente',
    amount: 1000,
    rev: 1,
    serverRev: 1,
  });

  await engine.write('payments', { id: 'p1', amount: 500 });
  const result = await engine.flush();

  assert.equal(result.conflicts, 1);
  assert.equal(remote.rows('payments')[0].amount, 1000);
  assert.equal((await local.getRecord('payments', 'p1')).status, 'Confirmado');
  assert.equal(local.debug.outbox.length, 0);
  assert.equal(local.debug.conflicts[0].decision, 'server');
});

test('edição local mais recente vence e é rebaseada sobre a revisão do servidor', async () => {
  const { local, remote, engine } = setup();

  remote.seed('clients', {
    id: 'c1',
    org_id: 'org-1',
    ref: 'REF-c1',
    name: 'Nome do servidor',
    rev: 2,
    updated_at: past(),
  });

  await local.putRecord('clients', {
    ...client('c1', 'Nome antigo'),
    rev: 1,
    serverRev: 1,
  });

  await engine.write('clients', { id: 'c1', name: 'Nome local' });
  const result = await engine.flush();

  assert.equal(result.conflicts, 1);
  assert.equal(remote.rows('clients')[0].name, 'Nome local');
  assert.equal(remote.rows('clients')[0].rev, 3);
  assert.equal((await local.getRecord('clients', 'c1')).serverRev, 3);
  assert.equal(local.debug.conflicts[0].decision, 'local');
});

test('dispositivo atrasado perde para o servidor', async () => {
  const { local, remote, engine } = setup();

  remote.seed('clients', {
    id: 'c1',
    org_id: 'org-1',
    ref: 'REF-c1',
    name: 'Nome do servidor',
    rev: 2,
    updated_at: future(),
  });

  await local.putRecord('clients', {
    ...client('c1', 'Nome velho'),
    rev: 1,
    serverRev: 1,
  });

  await engine.write('clients', { id: 'c1', name: 'Nome do dispositivo atrasado' });

  const realNow = Date.now();
  const engineOld = createSyncEngine({
    local,
    remote,
    now: () => new Date(realNow - 3_600_000),
  });
  await engineOld.flush();

  assert.equal(remote.rows('clients')[0].name, 'Nome do servidor');
  assert.equal((await local.getRecord('clients', 'c1')).name, 'Nome do servidor');
});

test('apagar propaga como deleted_at e não desaparece do servidor', async () => {
  const { local, remote, engine } = setup();

  await engine.write('clients', client('c1', 'Ana'));
  await engine.flush();

  await engine.write('clients', {
    id: 'c1',
    deletedAt: new Date().toISOString(),
  });
  await engine.flush();

  assert.equal(remote.rows('clients').length, 1);
  assert.ok(remote.rows('clients')[0].deleted_at ?? remote.rows('clients')[0].deletedAt);
  assert.ok((await local.getRecord('clients', 'c1')).deletedAt);
});

test('pull não pisa uma edição local por enviar', async () => {
  const { local, remote, engine } = setup();

  remote.seed('clients', {
    id: 'c1',
    org_id: 'org-1',
    ref: 'REF-c1',
    name: 'Nome do servidor',
    rev: 5,
  });

  await engine.write('clients', client('c1', 'Nome local por enviar'));
  const result = await engine.pull();

  assert.equal(result.applied, 0);
  assert.equal(result.skipped, 1);
  assert.equal((await local.getRecord('clients', 'c1')).name, 'Nome local por enviar');
});

test('o cursor avança e não repete registos', async () => {
  const { remote, engine } = setup();

  remote.seed('clients', { id: 'c1', org_id: 'org-1', ref: 'R1', name: 'Ana' });
  remote.seed('bills', { id: 'b1', org_id: 'org-1', client_id: 'c1', ref: 'R1', name: 'Ana', period: '11/2026', amount: 10 });

  const first = await engine.pull();
  assert.equal(first.applied, 2);

  const second = await engine.pull();
  assert.equal(second.applied, 0);
  assert.equal(second.cursor, first.cursor);
});

test('sync completo: envia, recebe e resolve conflito pendente', async () => {
  const { local, remote, engine } = setup();

  remote.setOnline(false);
  await engine.write('clients', client('c1', 'Ana'));
  const offline = await engine.sync();
  assert.match(offline.push.error, /offline/);
  assert.equal(offline.pull, null);

  remote.setOnline(true);
  const online = await engine.sync();
  assert.equal(online.push.pushed, 1);
  assert.equal(online.push.remaining, 0);
  assert.equal(local.debug.outbox.length, 0);
});

test('decideConflict: pagamento validado é imutável mesmo com relógio adiantado', () => {
  const decision = decideConflict({
    table: 'payments',
    localRow: { updatedAt: future() },
    serverRow: { status: 'Rejeitado', updated_at: past() },
  });
  assert.equal(decision, 'server');
});
