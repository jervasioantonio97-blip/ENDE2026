// Testes do modelo de dados do portal do cliente (sem rede, sem DOM).
//
// O portal é só de leitura: verifica-se aqui que a vista resultante agrupa
// os pagos por ano, distingue pendentes, reflecte multa e corte, e ignora
// linhas apagadas/anuladas.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildView, yearOf, monthOf, periodIndex, isAdvance, mapCSV } from '../../portal/src/portal-data.js';

const bill = (over = {}) => ({
  period: '11/2026',
  status: 'Em aberto',
  amount: 5000,
  late_fee: 0,
  cut: false,
  due: '2026-11-20',
  deleted_at: null,
  ...over,
});

const payment = (over = {}) => ({
  period: '11/2026',
  date: '2026-11-10',
  amount: 5000,
  status: 'Confirmado',
  receipt: 'REC-1',
  deleted_at: null,
  ...over,
});

// ── extracção de período ─────────────────────────────────────────────────────

test('yearOf e monthOf leem o período MM/AAAA', () => {
  assert.equal(yearOf('11/2026'), '2026');
  assert.equal(yearOf('11/26'), '2026', 'ano de 2 dígitos do dado legado');
  assert.equal(monthOf('11/2026'), '11');
  assert.equal(monthOf('3/2026'), '03');
});

test('período sem ano não inventa um', () => {
  assert.equal(yearOf('sem-ano'), '');
  assert.equal(yearOf(undefined), '');
  assert.equal(monthOf('x'), '99');
});

// ── meses pagos ──────────────────────────────────────────────────────────────

test('cobrança Liquidada conta como pago e entra no ano certo', () => {
  const view = buildView({ bills: [bill({ status: 'Liquidada' })] });
  assert.equal(view.summary.paidCount, 1);
  assert.equal(view.years[0].year, '2026');
  assert.equal(view.years[0].months[0].period, '11/2026');
  assert.equal(view.summary.pendingCount, 0);
});

test('pagamento Confirmado marca o período como pago mesmo com cobrança em aberto', () => {
  const view = buildView({
    bills: [bill({ status: 'Em aberto' })],
    payments: [payment()],
  });
  assert.equal(view.summary.paidCount, 1);
  assert.equal(view.summary.pendingCount, 0, 'pago não pode aparecer também como pendente');
});

test('pagamento Pendente ou Rejeitado NÃO conta como pago', () => {
  for (const status of ['Pendente', 'Rejeitado']) {
    const view = buildView({ payments: [payment({ status })] });
    assert.equal(view.summary.paidCount, 0, `${status} não é pagamento`);
  }
});

// ── agrupamento por ano ──────────────────────────────────────────────────────

test('pagos são agrupados por ano, do mais recente para o mais antigo', () => {
  const view = buildView({
    bills: [
      bill({ period: '01/2025', status: 'Liquidada' }),
      bill({ period: '03/2026', status: 'Liquidada' }),
      bill({ period: '12/2025', status: 'Liquidada' }),
      bill({ period: '02/2026', status: 'Liquidada' }),
    ],
  });
  assert.deepEqual(view.years.map((g) => g.year), ['2026', '2025']);
  assert.deepEqual(view.years[0].months.map((m) => m.period), ['02/2026', '03/2026']);
  assert.deepEqual(view.years[1].months.map((m) => m.period), ['01/2025', '12/2025']);
});

test('cada ano acumula o total dos seus meses', () => {
  const view = buildView({
    bills: [
      bill({ period: '01/2026', status: 'Liquidada', amount: 1000 }),
      bill({ period: '02/2026', status: 'Liquidada', amount: 2500 }),
      bill({ period: '03/2025', status: 'Liquidada', amount: 700 }),
    ],
  });
  assert.equal(view.years[0].total, 3500);
  assert.equal(view.years[1].total, 700);
});

// ── pendentes ────────────────────────────────────────────────────────────────

test('cobrança em aberto aparece como pendente com vencimento', () => {
  const view = buildView({ bills: [bill({ status: 'Em aberto', due: '2026-11-20' })] });
  assert.equal(view.summary.pendingCount, 1);
  assert.equal(view.pending[0].due, '2026-11-20');
  assert.equal(view.pending[0].amount, 5000);
});

test('cobrança Parcial também é pendente', () => {
  const view = buildView({ bills: [bill({ status: 'Parcial' })] });
  assert.equal(view.summary.pendingCount, 1);
});

test('cobrança Anulada e linha apagada não contam nem como paga nem como pendente', () => {
  const view = buildView({
    bills: [
      bill({ status: 'Anulada' }),
      bill({ period: '10/2026', deleted_at: '2026-11-01T00:00:00Z' }),
    ],
    payments: [payment({ period: '09/2026', deleted_at: '2026-11-01T00:00:00Z' })],
  });
  assert.equal(view.summary.paidCount, 0);
  assert.equal(view.summary.pendingCount, 0);
  assert.equal(view.years.length, 0);
});

// ── multa de atraso e corte ──────────────────────────────────────────────────

test('multa de atraso soma nos pendentes e reflecte no resumo', () => {
  const view = buildView({
    bills: [
      bill({ late_fee: 1500 }),
      bill({ period: '10/2026', late_fee: 500 }),
      bill({ period: '09/2026', status: 'Liquidada', late_fee: 900 }),
    ],
  });
  assert.equal(view.summary.lateFee, 2000, 'multa de um mês pago não entra');
  assert.equal(view.summary.pendingCount, 2);
});

test('corte detectado numa cobrança pendente', () => {
  const view = buildView({ bills: [bill({ cut: true })] });
  assert.equal(view.summary.cut, true);
});

test('corte de mês já pago não assinala alerta nos pendentes', () => {
  const view = buildView({ bills: [bill({ status: 'Liquidada', cut: true })] });
  assert.equal(view.summary.cut, false);
});

// ── totais e casos limite ────────────────────────────────────────────────────

test('resumo soma valores pagos e pendentes', () => {
  const view = buildView({
    bills: [
      bill({ status: 'Liquidada', amount: 3000 }),
      bill({ period: '10/2026', status: 'Em aberto', amount: 1200 }),
    ],
  });
  assert.equal(view.summary.paidTotal, 3000);
  assert.equal(view.summary.pendingTotal, 1200);
});

test('sem registos devolve vista vazia e zeros', () => {
  const view = buildView();
  assert.deepEqual(view.years, []);
  assert.deepEqual(view.pending, []);
  assert.equal(view.summary.paidCount, 0);
  assert.equal(view.summary.lateFee, 0);
  assert.equal(view.summary.cut, false);
});

test('valor não numérico não lança: conta como zero', () => {
  const view = buildView({ bills: [bill({ amount: 'abc', late_fee: null })] });
  assert.equal(view.summary.pendingTotal, 0);
  assert.equal(view.summary.lateFee, 0);
});

// ── adiantamentos (período futuro, derivado) ─────────────────────────────────

// «Hoje» fixo: Novembro de 2026.
const TODAY = new Date(2026, 10, 17);

test('periodIndex e isAdvance: período posterior ao mês corrente', () => {
  assert.equal(periodIndex('11/2026'), 2026 * 12 + 10);
  assert.equal(periodIndex('12/26'), 2026 * 12 + 11, 'ano de 2 dígitos');
  assert.equal(periodIndex('13/2026'), null);
  assert.equal(isAdvance('12/2026', TODAY), true);
  assert.equal(isAdvance('12/26', TODAY), true);
  assert.equal(isAdvance('11/2026', TODAY), false);
  assert.equal(isAdvance('10/2026', TODAY), false);
  assert.equal(isAdvance('texto livre', TODAY), false);
});

test('pagamento Confirmado de período futuro marca a linha como adiantamento', () => {
  const view = buildView({
    today: TODAY,
    payments: [
      payment({ period: '12/2026' }), // futuro
      payment({ period: '11/2026', date: '2026-11-10' }), // corrente
    ],
    bills: [],
  });
  const rows = view.years.flatMap((g) => g.months);
  assert.equal(rows.length, 2);
  const futura = rows.find((m) => m.period === '12/2026');
  const actual = rows.find((m) => m.period === '11/2026');
  assert.equal(futura.advance, true);
  assert.equal(actual.advance, false);
  assert.equal(view.summary.advanceCount, 1);
});

test('período em texto livre com data futura também conta como adiantamento', () => {
  // dado real em produção: period "16 de Novembro de 2026", date 2026-12-16
  const view = buildView({
    today: TODAY,
    payments: [payment({ period: '16 de Novembro de 2026', date: '2026-12-16' })],
    bills: [],
  });
  const rows = view.years.flatMap((g) => g.months);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].advance, true);
  assert.equal(view.summary.advanceCount, 1);
});

// ── mapa de conta em CSV ─────────────────────────────────────────────────────

test('mapCSV emite BOM, ponto e vírgula e uma linha por período', () => {
  const view = buildView({
    today: TODAY,
    bills: [
      bill({ status: 'Liquidada', amount: 3000, due: '2026-11-20' }),
      bill({ period: '10/2026', status: 'Em aberto', amount: 1200, late_fee: 200 }),
    ],
    payments: [payment({ period: '12/2026', amount: 5000, receipt: 'REC-9' })],
  });
  const csv = mapCSV(view);

  assert.ok(csv.startsWith('\ufeff"periodo"'));
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 4, 'cabeçalho + 3 períodos');
  // pagos por ano em ordem ascendente dentro do ano: 11/2026, 12/2026
  assert.ok(lines[1].includes('"11/2026"'));
  assert.ok(lines[1].includes('"Pago"'));
  assert.ok(lines[1].includes('"Normal"'));
  assert.ok(lines[2].includes('"12/2026"'));
  assert.ok(lines[2].includes('"Adiantamento"'));
  assert.ok(lines[2].includes('"REC-9"'));
  assert.ok(lines[3].includes('"10/2026"'));
  assert.ok(lines[3].includes('"Pendente"'));
  assert.ok(lines.some((l) => l.includes('"1200,00"')));
});

test('mapCSV de vista vazia só tem o cabeçalho', () => {
  const csv = mapCSV(buildView({ today: TODAY }));
  assert.equal(csv.slice(1).split('\r\n').length, 1);
});
