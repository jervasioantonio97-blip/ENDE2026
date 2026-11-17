// Testes do módulo de relatórios (funções puras, sem rede nem DOM).
//
// Cobre: períodos (parse + rótulos), adiantamento derivado, âmbitos
// (todo o período / ano / mês), o construtor do relatório e a saída CSV.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  periodIndex,
  periodLabel,
  monthName,
  rowPeriod,
  isAdvance,
  inScope,
  scopeLabel,
  buildReport,
  toCSV,
  reportCSV,
} from '../src/report.js';

// «Hoje» fixo para não depender da data da máquina: Novembro de 2026.
const TODAY = new Date(2026, 10, 17);

const payment = (over = {}) => ({
  id: 'p1',
  client_id: 'c1',
  ref: '123',
  name: 'jervasio',
  period: '11/2026',
  date: '2026-11-10',
  amount: 5000,
  method: 'Numerário',
  receipt: 'REC-1',
  staff: 'Jervasio',
  status: 'Confirmado',
  validated_by: '',
  deleted_at: null,
  ...over,
});

const bill = (over = {}) => ({
  id: 'b1',
  client_id: 'c1',
  ref: '123',
  name: 'jervasio',
  period: '11/2026',
  amount: 5000,
  late_fee: 0,
  cut: false,
  status: 'Em aberto',
  deleted_at: null,
  ...over,
});

test('periodIndex converte MM/AAAA para um índice ordenável', () => {
  assert.equal(periodIndex('01/2026'), 2026 * 12 + 0);
  assert.equal(periodIndex('12/2026'), 2026 * 12 + 11);
  assert.ok(periodIndex('12/2026') > periodIndex('11/2026'));
});

test('periodIndex rejeita períodos inválidos', () => {
  assert.equal(periodIndex('13/2026'), null);
  assert.equal(periodIndex('00/2026'), null);
  assert.equal(periodIndex('11-2026'), null);
  assert.equal(periodIndex('texto livre'), null);
  assert.equal(periodIndex(''), null);
  assert.equal(periodIndex(null), null);
});

test('periodIndex aceita ano de 2 dígitos (dado legado 12/26 -> 2026)', () => {
  assert.equal(periodIndex('12/26'), 2026 * 12 + 11);
  assert.equal(periodIndex('11/26'), periodIndex('11/2026'));
  assert.equal(periodIndex('01/99'), 2099 * 12 + 0);
});

test('periodLabel e monthName traduzem o período para português', () => {
  assert.equal(periodLabel('11/2026'), 'Novembro 2026');
  assert.equal(monthName('11/2026'), 'Novembro');
  assert.equal(monthName('02/2027'), 'Fevereiro');
  // texto livre devolve-se intacto (dados antigos)
  assert.equal(periodLabel('16 de Novembro de 2026'), '16 de Novembro de 2026');
  assert.equal(monthName('16 de Novembro de 2026'), '');
});

test('rowPeriod prefere o campo period e cai para a data quando é texto livre', () => {
  assert.equal(rowPeriod(payment()), '11/2026');
  // dado real em produção: period em texto livre, date em ISO
  assert.equal(rowPeriod(payment({ period: '16 de Novembro de 2026', date: '2026-12-16' })), '12/2026');
  assert.equal(rowPeriod(payment({ period: '', date: '2026-07-03' })), '07/2026');
  assert.equal(rowPeriod(payment({ period: '', date: '' })), '');
  // cobrança sem `date`: usa a emissão
  assert.equal(rowPeriod(bill({ period: '11/26 a 12/26', issue: '2026-11-16' })), '11/2026');
  assert.equal(rowPeriod(bill({ period: '12/26' })), '12/26'); // ano de 2 dígitos parseia
});

test('isAdvance: período futuro conta como adiantamento', () => {
  assert.equal(isAdvance(payment({ period: '12/2026' }), TODAY), true);
  assert.equal(isAdvance(payment({ period: '01/2027' }), TODAY), true);
  assert.equal(isAdvance(payment({ period: '11/2026' }), TODAY), false); // mês corrente
  assert.equal(isAdvance(payment({ period: '10/2026' }), TODAY), false);
  assert.equal(isAdvance(payment({ period: 'texto', date: '2027-03-01' }), TODAY), true);
  assert.equal(isAdvance(payment({ period: '', date: '' }), TODAY), false);
});

test('inScope filtra por todo o período, ano e mês', () => {
  const row = payment({ period: '11/2026' });
  assert.equal(inScope(row, { kind: 'all' }, TODAY), true);
  assert.equal(inScope(row, { kind: 'year', year: 2026 }, TODAY), true);
  assert.equal(inScope(row, { kind: 'year', year: 2025 }, TODAY), false);
  assert.equal(inScope(row, { kind: 'month', month: '11/2026' }, TODAY), true);
  assert.equal(inScope(row, { kind: 'month', month: '10/2026' }, TODAY), false);
  // sem período parseável fica de fora dos âmbitos específicos
  assert.equal(inScope(payment({ period: '', date: '' }), { kind: 'year', year: 2026 }, TODAY), false);
});

test('scopeLabel gera o rótulo do âmbito (para nomes de ficheiro)', () => {
  assert.equal(scopeLabel({ kind: 'all' }), 'todo-o-periodo');
  assert.equal(scopeLabel({ kind: 'year', year: 2026 }), '2026');
  assert.equal(scopeLabel({ kind: 'month', month: '11/2026' }), '11-2026');
  assert.equal(scopeLabel(null), 'todo-o-periodo');
});

test('buildReport soma totais e exclui apagados/anulados', () => {
  const r = buildReport({
    today: TODAY,
    payments: [
      payment(),
      payment({ id: 'p2', status: 'Pendente', amount: 1000 }),
      payment({ id: 'p3', status: 'Rejeitado', amount: 500 }),
      payment({ id: 'p4', period: '12/2026', amount: 2000 }), // adiantamento
      payment({ id: 'p5', deleted_at: '2026-11-01' }), // apagado
    ],
    bills: [
      bill(),
      bill({ id: 'b2', amount: 700, late_fee: 300, status: 'Em aberto' }),
      bill({ id: 'b3', status: 'Anulada' }), // anulada
      bill({ id: 'b4', period: '12/2026', amount: 100 }),
    ],
  });

  assert.equal(r.totals.received, 7000); // 5000 + 2000 (apagado excluído)
  assert.equal(r.totals.pending, 1000);
  assert.equal(r.totals.rejected, 500);
  assert.equal(r.totals.advance, 2000);
  assert.equal(r.totals.billed, 6100); // 5000 + 700+300 + 100 (anulada excluída)
  assert.equal(r.totals.balance, 900); // 7000 − 6100
  assert.equal(r.payments.length, 4);
  assert.equal(r.bills.length, 3);
});

test('buildReport agrupa o balanço mensal por período, ordenado', () => {
  const r = buildReport({
    today: TODAY,
    payments: [
      payment({ period: '10/2026', amount: 1000 }),
      payment({ period: '12/2026', amount: 3000 }),
      payment({ period: '11/2026', amount: 5000 }),
      payment({ id: 'px', period: '11/2026', status: 'Pendente', amount: 999 }), // não é ganho
    ],
    bills: [
      bill({ period: '11/2026', amount: 2000, late_fee: 500 }),
      bill({ period: '10/2026', amount: 4000 }),
    ],
  });

  assert.deepEqual(r.months.map((m) => m.month), ['10/2026', '11/2026', '12/2026']);
  assert.equal(r.months[0].received, 1000);
  assert.equal(r.months[0].billed, 4000);
  assert.equal(r.months[0].balance, -3000);
  assert.equal(r.months[1].received, 5000);
  assert.equal(r.months[1].billed, 2500); // multa incluída
  assert.equal(r.months[1].balance, 2500);
  assert.equal(r.months[2].received, 3000);
  assert.equal(r.months[2].billed, 0);
});

test('buildReport limita o âmbito ao escolhido', () => {
  const payments = [
    payment({ period: '10/2026', amount: 1000 }),
    payment({ period: '11/2026', amount: 5000 }),
    payment({ period: '11/2025', amount: 700 }),
  ];
  const bills = [
    bill({ period: '11/2026', amount: 2000 }),
    bill({ period: '11/2025', amount: 300 }),
  ];

  const ano = buildReport({ today: TODAY, payments, bills, scope: { kind: 'year', year: 2026 } });
  assert.equal(ano.totals.received, 6000);
  assert.equal(ano.totals.billed, 2000);

  const mes = buildReport({ today: TODAY, payments, bills, scope: { kind: 'month', month: '11/2026' } });
  assert.equal(mes.totals.received, 5000);
  assert.equal(mes.totals.billed, 2000);
  assert.equal(mes.months.length, 1);

  const tudo = buildReport({ today: TODAY, payments, bills });
  assert.equal(tudo.totals.received, 6700);
  assert.equal(tudo.totals.billed, 2300);
});

test('buildReport agrega clientes e métodos de pagamento', () => {
  const r = buildReport({
    today: TODAY,
    payments: [
      payment({ amount: 6000 }),
      payment({ id: 'p2', ref: '456', name: 'outro', client_id: 'c2', amount: 1000, method: 'Transferência' }),
      payment({ id: 'p3', ref: '456', name: 'outro', client_id: 'c2', status: 'Pendente', amount: 250 }),
    ],
    bills: [bill({ ref: '456', name: 'outro', client_id: 'c2', amount: 5000 })],
  });

  assert.equal(r.clients.length, 2);
  // ordenado por balanço decrescente: c1 = 6000, c2 = 1000 − 5000
  assert.equal(r.clients[0].ref, '123');
  assert.equal(r.clients[0].balance, 6000);
  assert.equal(r.clients[1].ref, '456');
  assert.equal(r.clients[1].balance, -4000);
  assert.equal(r.clients[1].pending, 250);

  assert.deepEqual(r.methods.map((m) => m.method), ['Numerário', 'Transferência']);
  assert.equal(r.methods[0].count, 1);
  assert.equal(r.methods[0].total, 6000);
});

test('toCSV usa ponto e vírgula, aspas dobradas e BOM', () => {
  const csv = toCSV(['a', 'b'], [['x', 'com "aspas"'], ['y', 'com; ponto e vírgula']]);
  assert.ok(csv.startsWith('\ufeff'), 'começa com BOM');
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"a";"b"');
  assert.equal(lines[1], '"x";"com ""aspas"""');
  assert.equal(lines[2], '"y";"com; ponto e vírgula"');
});

test('reportCSV cobre os 6 tipos de relatório', () => {
  const r = buildReport({ today: TODAY, payments: [payment()], bills: [bill()] });

  const resumo = reportCSV('resumo', r);
  assert.ok(resumo.includes('"Cobrado (perdas)"'));
  assert.ok(resumo.includes('"Adiantamentos"'));

  const pagamentos = reportCSV('pagamentos', r);
  assert.ok(pagamentos.startsWith('\ufeff"data";"cliente"'));
  assert.ok(pagamentos.includes('"Confirmado"'));

  const cobrancas = reportCSV('cobrancas', r);
  assert.ok(cobrancas.startsWith('\ufeff"periodo";"cliente"'));
  assert.ok(cobrancas.includes('"Em aberto"'));

  const clientes = reportCSV('clientes', r);
  assert.ok(clientes.includes('"balanco_kz"'));

  const metodos = reportCSV('metodos', r);
  assert.ok(metodos.includes('"Numerário"'));

  const meses = reportCSV('meses', r);
  assert.ok(meses.includes('"ganhos_recebido_kz"'));
  assert.ok(meses.includes('"11/2026"'));
});
