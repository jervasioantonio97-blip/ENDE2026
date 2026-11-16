// Modelo de dados do portal do cliente — funções puras, sem rede nem DOM.
//
// O portal é SOMENTE de leitura: aqui só se transforma o que o RLS já
// limitou às linhas DAQUELE cliente (políticas `*_read_own` da migração
// 0002) em três vistas:
//   * meses pagos, agrupados por ano;
//   * meses pendentes, com vencimento e valor;
//   * estado de multa de atraso e corte.
//
// Fontes:
//   * `bills`   — cobranças (Em aberto | Parcial | Liquidada | Anulada);
//   * `payments`— pagamentos registados (Pendente | Confirmado | Rejeitado).
//
// Um período conta como PAGO se a cobrança está Liquidada OU existe um
// pagamento Confirmado para ele. Conta como PENDENTE se há cobrança em
// aberto/parcial e ainda não está pago.

const OPEN_BILL = new Set(['Em aberto', 'Parcial']);
const PAID_BILL = new Set(['Liquidada']);

/** '11/2026' -> '2026'; devolve '' quando o período não tem ano. */
export function yearOf(period) {
  const text = String(period ?? '');
  const match = /(\d{4})\s*$/.exec(text);
  return match ? match[1] : '';
}

/** '11/2026' -> '11' (mês para ordenar dentro do ano). */
export function monthOf(period) {
  const text = String(period ?? '').trim();
  const match = /^(\d{1,2})\s*\//.exec(text);
  return match ? match[1].padStart(2, '0') : '99';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function live(rows) {
  return rows.filter((r) => r && !r.deleted_at && r.status !== 'Anulada');
}

/** Junta cobranças e pagamentos numa linha por período. */
function collect(bills, payments) {
  const byPeriod = new Map();

  function entry(period) {
    const key = String(period ?? '').trim();
    if (!key) return null;
    if (!byPeriod.has(key)) {
      byPeriod.set(key, {
        period: key,
        year: yearOf(key),
        month: monthOf(key),
        amount: 0,
        due: null,
        lateFee: 0,
        cut: false,
        paid: false,
        pending: false,
        receipt: '',
        date: '',
      });
    }
    return byPeriod.get(key);
  }

  for (const b of live(bills)) {
    const e = entry(b.period);
    if (!e) continue;
    e.amount = num(b.amount);
    e.due = b.due || null;
    e.lateFee = Math.max(e.lateFee, num(b.late_fee));
    e.cut = e.cut || Boolean(b.cut);
    if (PAID_BILL.has(b.status)) e.paid = true;
    if (OPEN_BILL.has(b.status)) e.pending = true;
  }

  for (const p of live(payments)) {
    if (p.status !== 'Confirmado') continue;
    const e = entry(p.period);
    if (!e) continue;
    e.paid = true;
    e.pending = false; // pago vence pendente
    if (!e.amount) e.amount = num(p.amount);
    e.receipt = p.receipt || e.receipt;
    e.date = p.date || e.date;
  }

  return [...byPeriod.values()];
}

function byPeriodDesc(a, b) {
  if (a.year !== b.year) return b.year.localeCompare(a.year);
  return a.month.localeCompare(b.month);
}

/**
 * Constrói a vista completa do portal.
 *
 * @param {{ bills?: object[], payments?: object[] }} input
 * @returns {{
 *   years: Array<{ year: string, months: object[], total: number }>,
 *   pending: object[],
 *   summary: {
 *     paidCount: number, pendingCount: number, paidTotal: number,
 *     pendingTotal: number, lateFee: number, cut: boolean,
 *   },
 * }}
 */
export function buildView({ bills = [], payments = [] } = {}) {
  const rows = collect(bills, payments);

  const paidRows = rows.filter((r) => r.paid).sort(byPeriodDesc);
  const pendingRows = rows.filter((r) => !r.paid && r.pending).sort(byPeriodDesc);

  // Agrupa os pagos por ano, do ano mais recente para o mais antigo.
  const years = [];
  for (const row of paidRows) {
    const year = row.year || '—';
    let group = years[years.length - 1];
    if (!group || group.year !== year) {
      group = { year, months: [], total: 0 };
      years.push(group);
    }
    group.months.push(row);
    group.total += row.amount;
  }

  const lateFee = rows
    .filter((r) => !r.paid)
    .reduce((sum, r) => sum + r.lateFee, 0);

  return {
    years,
    pending: pendingRows,
    summary: {
      paidCount: paidRows.length,
      pendingCount: pendingRows.length,
      paidTotal: paidRows.reduce((sum, r) => sum + r.amount, 0),
      pendingTotal: pendingRows.reduce((sum, r) => sum + r.amount, 0),
      lateFee,
      cut: rows.some((r) => !r.paid && r.cut),
    },
  };
}
