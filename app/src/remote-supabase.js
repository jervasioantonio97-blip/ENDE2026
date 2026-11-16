// Adaptador Remoto contra o PostgREST do Supabase.
//
// Implementa o contrato de `remote` exigido por sync-engine.js:
//   insert(table, row)                -> { ok: true, row } | { ok: false, serverRow }
//   update(table, id, row, baseRev)   -> { ok: true, row } | { ok: false, serverRow }
//   pull(cursor, limit)               -> { rows: [{ table, row }], hasMore }
//
// Notas de desenho:
//   * As colunas enviadas são só as de negócio (COLUMNS). `rev`, `seq`,
//     `created_at` e `updated_at` são escritos pelos triggers `touch_sync` no
//     servidor: o cliente nunca os impõe.
//   * O bloqueio optimista usa o próprio PostgREST — o PATCH filtra
//     `?id=eq.X&rev=eq.N`. Zero linhas afectadas = revisão obsoleta.
//   * `org_id` é obrigatório: as políticas RLS fazem `with check` contra
//     `current_org_id()`, por isso sem org o INSERT é rejeitado (403).

export const COLUMNS = Object.freeze({
  clients: Object.freeze([
    'org_id', 'ref', 'name', 'contact', 'whatsapp', 'iban', 'year', 'deleted_at',
  ]),
  payments: Object.freeze([
    'org_id', 'client_id', 'ref', 'name', 'period', 'date', 'amount', 'method',
    'receipt', 'staff', 'notes', 'status', 'validated_by', 'validated_at',
    'deleted_at',
  ]),
  bills: Object.freeze([
    'org_id', 'client_id', 'ref', 'name', 'period', 'issue', 'due', 'amount',
    'late_fee', 'cut', 'origin', 'status', 'notes', 'deleted_at',
  ]),
});

const INTEGER_COLUMNS = new Set(['year']);
const NUMERIC_COLUMNS = new Set(['amount', 'late_fee']);
const DATE_COLUMNS = new Set(['date', 'issue', 'due']);

/** Converte uma coluna do modelo local para o tipo que o PostgREST espera. */
export function coerce(column, value) {
  const raw = value === undefined ? null : value;
  if (raw === null) return null;
  // Colunas não-texto: vazio não é valor, é ausência. Texto aceita '' porque
  // as colunas de contacto são `not null default ''`.
  if (INTEGER_COLUMNS.has(column)) return raw === '' ? null : Math.trunc(Number(raw));
  if (NUMERIC_COLUMNS.has(column)) return raw === '' ? null : Number(raw);
  if (DATE_COLUMNS.has(column)) return raw === '' ? null : String(raw).slice(0, 10);
  return raw;
}

const NOT_NULL = new Set(['date', 'amount', 'late_fee', 'year', 'org_id']);

/** projecta a linha local nas colunas que o servidor aceita. */
export function toServer(table, row, orgId) {
  const cols = COLUMNS[table];
  if (!cols) throw new Error(`Tabela desconhecida: ${table}`);

  const out = {};
  for (const col of cols) {
    if (col === 'org_id') {
      out.org_id = row.org_id ?? orgId;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(row, col)) {
      const value = coerce(col, row[col]);
      // Coluna NOT NULL a null: omitir, para o servidor reclamar em vez de
      // receber um null enganoso (e, em PATCH, apagar o valor sem querer).
      if (value === null && NOT_NULL.has(col)) continue;
      out[col] = value;
    }
  }
  if (!out.org_id) delete out.org_id;
  return out;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function messageOf(payload, fallback) {
  if (payload && typeof payload === 'object') {
    return payload.message || payload.details || payload.hint || fallback;
  }
  if (typeof payload === 'string' && payload.trim()) return payload;
  return fallback;
}

export function createSupabaseRemote({
  url,
  anonKey,
  getToken,
  getOrgId,
  fetchFn = (...args) => fetch(...args),
  tables = ['clients', 'payments', 'bills'],
}) {
  if (!url || !anonKey) throw new Error('url e anonKey são obrigatórios');

  const base = String(url).replace(/\/$/, '');

  async function request(path, options = {}) {
    const token = await getToken();
    if (!token) throw new Error('Sessão expirada: entre novamente.');

    const res = await fetchFn(`${base}${path}`, {
      ...options,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    return { res, body: await readBody(res) };
  }

  async function fetchById(table, id) {
    const { res, body } = await request(
      `/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=*`,
    );
    if (!res.ok) throw new Error(messageOf(body, `Leitura falhou (${res.status})`));
    return Array.isArray(body) && body.length > 0 ? body[0] : null;
  }

  function conflictError(status, body, hint) {
    const err = new Error(
      `${hint} (servidor ${status}: ${messageOf(body, 'conflito')})`,
    );
    err.status = status;
    err.duplicate = status === 409;
    return err;
  }

  async function insert(table, row) {
    // O `id` é gerado ANTES de haver rede. O servidor tem de o aceitar tal
    // como chega, senão local e servidor ficam com identidades diferentes e o
    // pull entrega a mesma conta duas vezes (e as FKs de payments/bills falham).
    const body = { ...toServer(table, row, getOrgId()) };
    if (row.id) body.id = row.id;

    const { res, body: created } = await request(`/rest/v1/${table}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(body),
    });

    if (res.ok && Array.isArray(created) && created.length > 0) {
      return { ok: true, row: created[0] };
    }
    if (res.status === 409) {
      // Referência única (clients_org_ref_live) ou id repetido.
      throw conflictError(409, created, 'O servidor já tem este registo');
    }
    throw conflictError(res.status, created, `Não foi possível guardar em ${table}`);
  }

  async function update(table, id, row, baseRev) {
    const filters = [`id=eq.${encodeURIComponent(id)}`];
    if (baseRev != null) filters.push(`rev=eq.${Number(baseRev)}`);

    const { res, body } = await request(`/rest/v1/${table}?${filters.join('&')}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(toServer(table, row, getOrgId())),
    });

    if (res.ok) {
      if (Array.isArray(body) && body.length > 0) return { ok: true, row: body[0] };

      // Nada foi afectado: ou a revisão mudou, ou o registo ainda não existe.
      const current = await fetchById(table, id);
      if (current) return { ok: false, serverRow: current };
      return insert(table, row); // ainda não sincronizado ou removido: cria
    }

    if (res.status === 409) {
      throw conflictError(409, body, 'O servidor já tem este registo');
    }
    throw conflictError(res.status, body, `Não foi possível actualizar em ${table}`);
  }

  async function pull(cursor, limit = 200) {
    const perTable = [];
    let safeCursor = null;

    for (const table of tables) {
      const { res, body } = await request(
        `/rest/v1/${table}?seq=gt.${Number(cursor) || 0}` +
          `&order=seq.asc&limit=${limit}&select=*`,
      );
      if (!res.ok) throw new Error(messageOf(body, `Pull falhou em ${table} (${res.status})`));

      const rows = Array.isArray(body) ? body : [];
      const maxSeq = rows.length > 0 ? Number(rows[rows.length - 1].seq) : null;
      const saturated = rows.length >= limit;

      if (saturated && maxSeq != null) {
        safeCursor = safeCursor == null ? maxSeq : Math.min(safeCursor, maxSeq);
      }
      perTable.push({ table, rows });
    }

    // Se alguma tabela encheu a página, há potencialmente registos por ler com
    // seq acima do mínimo devolvido: travar o cursor aí e voltar a pedir.
    // Entregar linhas duas vezes é inofensivo (o pull é idempotente); perdê-las não.
    let flat = [];
    for (const { table, rows } of perTable) {
      for (const row of rows) flat.push({ table, row });
    }

    const hasMore = safeCursor != null;
    if (hasMore) flat = flat.filter((r) => Number(r.row.seq) <= safeCursor);

    flat.sort((a, b) => Number(a.row.seq) - Number(b.row.seq));
    return { rows: flat, hasMore };
  }

  return { insert, update, pull };
}
