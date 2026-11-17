// Relatórios do ENDE CONTROL — funções puras, sem rede nem DOM.
//
// Âmbito (scope), escolhido pelo utilizador:
//   { kind: 'all' }                     -> todo o período (omissão)
//   { kind: 'year', year: 2026 }        -> ano inteiro
//   { kind: 'month', month: '11/2026' } -> um mês exacto, via calendário
//
// Adiantamento = DERIVADO, sem campo novo: um pagamento conta como
// adiantamento quando o seu período é posterior ao mês corrente.
//
// Balanço mensal (ganhos e perdas):
//   ganhos = pagamentos Confirmados no mês; perdas = cobranças emitidas no mês;
//   balanço = recebido − cobrado (positivo = ganho, negativo = perda).

const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const num = (v) => Number(v) || 0;
// Aceita ano de 4 dígitos (11/2026) e de 2 (12/26, dado legado -> 2026).
const PERIOD_RE = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/;

/** '11/2026' -> 2026*12+10 (índice ordenável); null quando o período é inválido. */
export function periodIndex(period) {
  const m = PERIOD_RE.exec(String(period ?? '').trim());
  if (!m) return null;
  const yy = m[2];
  const year = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
  return year * 12 + (Number(m[1]) - 1);
}

/** '11/2026' -> 'Novembro 2026'; texto original quando não parseia. */
export function periodLabel(period) {
  const idx = periodIndex(period);
  if (idx == null) return String(period ?? '');
  return `${MONTHS_PT[idx % 12]} ${Math.floor(idx / 12)}`;
}

/** '11/2026' -> 'Novembro'; '' quando inválido. */
export function monthName(period) {
  const idx = periodIndex(period);
  return idx == null ? '' : MONTHS_PT[idx % 12];
}

/**
 * Período usado para agrupar: prefere o campo `period` (MM/AAAA ou MM/AA);
 * quando é texto livre (dados antigos), cai para a data do registo — `date`
 * em pagamentos, `issue`/`due` em cobranças — para não perder linhas.
 */
export function rowPeriod(row) {
  if (periodIndex(row?.period) != null) return String(row.period).trim();
  const iso = /^(\d{4})-(\d{2})/.exec(String(row?.date ?? row?.issue ?? row?.due ?? ''));
  return iso ? `${iso[2]}/${iso[1]}` : '';
}

/** Adiantamento: período do registo posterior ao mês de `today`. */
export function isAdvance(row, today = new Date()) {
  const idx = periodIndex(rowPeriod(row));
  if (idx == null) return false;
  return idx > today.getFullYear() * 12 + today.getMonth();
}

/** O registo pertence ao âmbito escolhido? */
export function inScope(row, scope, today = new Date()) {
  if (!scope || scope.kind === 'all') return true;
  const idx = periodIndex(rowPeriod(row));
  if (idx == null) return false;
  if (scope.kind === 'year') return Math.floor(idx / 12) === Number(scope.year);
  if (scope.kind === 'month') return idx === periodIndex(scope.month);
  return true;
}

/** Rótulo curto do âmbito, para nomes de ficheiro. */
export function scopeLabel(scope) {
  if (!scope || scope.kind === 'all') return 'todo-o-periodo';
  if (scope.kind === 'year') return String(scope.year);
  return String(scope.month).replace('/', '-');
}

const livePays = (payments) => payments.filter((p) => p && !p.deleted_at);
const liveBills = (bills) => bills.filter((b) => b && !b.deleted_at && b.status !== 'Anulada');

/**
 * Constrói o relatório completo para um âmbito.
 *
 * @param {{ payments?: object[], bills?: object[], scope?: object, today?: Date }} input
 */
export function buildReport({ payments = [], bills = [], scope = { kind: 'all' }, today = new Date() } = {}) {
  const ps = livePays(payments).filter((p) => inScope(p, scope, today));
  const bs = liveBills(bills).filter((b) => inScope(b, scope, today));

  const received = ps.filter((p) => p.status === 'Confirmado').reduce((s, p) => s + num(p.amount), 0);
  const pending = ps.filter((p) => p.status === 'Pendente').reduce((s, p) => s + num(p.amount), 0);
  const rejected = ps.filter((p) => p.status === 'Rejeitado').reduce((s, p) => s + num(p.amount), 0);
  const advance = ps.filter((p) => isAdvance(p, today)).reduce((s, p) => s + num(p.amount), 0);
  const billed = bs.reduce((s, b) => s + num(b.amount) + num(b.late_fee), 0);
  const open = bs
    .filter((b) => b.status === 'Em aberto' || b.status === 'Parcial')
    .reduce((s, b) => s + num(b.amount), 0);

  // Balanço mensal: recebido vs cobrado, ordenado por período.
  const monthMap = new Map();
  const touch = (key) => {
    if (!key) return null;
    if (!monthMap.has(key)) monthMap.set(key, { month: key, received: 0, billed: 0, balance: 0 });
    return monthMap.get(key);
  };
  for (const p of ps) {
    if (p.status !== 'Confirmado') continue;
    const e = touch(rowPeriod(p));
    if (e) e.received += num(p.amount);
  }
  for (const b of bs) {
    const e = touch(rowPeriod(b));
    if (e) e.billed += num(b.amount) + num(b.late_fee);
  }
  const months = [...monthMap.values()]
    .map((e) => ({ ...e, balance: e.received - e.billed }))
    .sort((a, b) => (periodIndex(a.month) ?? 0) - (periodIndex(b.month) ?? 0));

  // Por cliente (só quem tem movimento no âmbito).
  const clientMap = new Map();
  const client = (row) => {
    const key = String(row.client_id ?? row.ref ?? row.name ?? '');
    if (!clientMap.has(key)) {
      clientMap.set(key, { ref: row.ref ?? '', name: row.name ?? '', billed: 0, received: 0, pending: 0, balance: 0 });
    }
    return clientMap.get(key);
  };
  for (const b of bs) client(b).billed += num(b.amount) + num(b.late_fee);
  for (const p of ps) {
    const e = client(p);
    if (p.status === 'Confirmado') e.received += num(p.amount);
    else if (p.status === 'Pendente') e.pending += num(p.amount);
  }
  const clients = [...clientMap.values()]
    .map((e) => ({ ...e, balance: e.received - e.billed }))
    .sort((a, b) => b.balance - a.balance || String(a.name).localeCompare(String(b.name)));

  // Por método (só pagamentos confirmados).
  const methodMap = new Map();
  for (const p of ps) {
    if (p.status !== 'Confirmado') continue;
    const key = p.method || 'Outro';
    const e = methodMap.get(key) ?? { method: key, count: 0, total: 0 };
    e.count += 1;
    e.total += num(p.amount);
    methodMap.set(key, e);
  }
  const methods = [...methodMap.values()].sort((a, b) => b.total - a.total);

  return {
    scope,
    totals: { billed, received, pending, rejected, advance, open, balance: received - billed },
    months,
    clients,
    methods,
    payments: ps,
    bills: bs,
  };
}

/** CSV com `;`, aspas dobradas e BOM (abre certo no Excel). */
export function toCSV(headers, rows) {
  const cell = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  return '\ufeff' + [headers, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');
}

const money2 = (n) => (Math.round(num(n) * 100) / 100).toFixed(2).replace('.', ',');

/** CSV do tipo de relatório escolhido (`resumo` | `pagamentos` | ...). */
export function reportCSV(type, r) {
  if (type === 'pagamentos') {
    return toCSV(
      ['data', 'cliente', 'referencia', 'periodo', 'valor_kz', 'metodo', 'comprovativo', 'funcionario', 'estado', 'tipo', 'validado_por'],
      r.payments.map((p) => [
        p.date, p.name, p.ref, rowPeriod(p), money2(p.amount), p.method,
        p.receipt, p.staff, p.status, isAdvance(p) ? 'Adiantamento' : 'Normal', p.validated_by,
      ]),
    );
  }
  if (type === 'cobrancas') {
    return toCSV(
      ['periodo', 'cliente', 'referencia', 'emissao', 'vencimento', 'valor_kz', 'multa_kz', 'estado', 'corte'],
      r.bills.map((b) => [
        rowPeriod(b), b.name, b.ref, b.issue, b.due, money2(b.amount),
        money2(b.late_fee), b.status, b.cut ? 'Sim' : 'Não',
      ]),
    );
  }
  if (type === 'clientes') {
    return toCSV(
      ['referencia', 'nome', 'cobrado_kz', 'recebido_kz', 'pendente_kz', 'balanco_kz'],
      r.clients.map((c) => [c.ref, c.name, money2(c.billed), money2(c.received), money2(c.pending), money2(c.balance)]),
    );
  }
  if (type === 'metodos') {
    return toCSV(['metodo', 'n_pagamentos', 'total_kz'], r.methods.map((m) => [m.method, m.count, money2(m.total)]));
  }
  if (type === 'meses') {
    return toCSV(
      ['periodo', 'ganhos_recebido_kz', 'perdas_cobrado_kz', 'balanco_kz'],
      r.months.map((m) => [m.month, money2(m.received), money2(m.billed), money2(m.balance)]),
    );
  }
  // resumo (omissão)
  return toCSV(['indicador', 'valor_kz'], [
    ['Cobrado (perdas)', money2(r.totals.billed)],
    ['Recebido (ganhos)', money2(r.totals.received)],
    ['Balanço (recebido - cobrado)', money2(r.totals.balance)],
    ['Pendente de validação', money2(r.totals.pending)],
    ['Rejeitado', money2(r.totals.rejected)],
    ['Adiantamentos', money2(r.totals.advance)],
    ['Em aberto por cliente', money2(r.totals.open)],
    ['Movimentos de pagamento', r.payments.length],
    ['Cobranças emitidas', r.bills.length],
  ]);
}
