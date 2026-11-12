// Motor de sincronização offline-first.
//
// Não conhece IndexedDB nem Supabase: recebe dois adaptadores (`local` e `remote`).
// Assim a mesma lógica corre no telemóvel, no PC e nos testes sem rede.
//
// Contrato de `local`:
//   getRecord(table, id)            -> row | null
//   putRecord(table, row)           -> void
//   getPending(table, id)           -> outboxEntry | null
//   enqueue(entry)                  -> void   (coalesce por table+recordId, mantém baseRev original)
//   listOutbox()                    -> outboxEntry[]  (ordem de criação)
//   removeOutbox(id)                -> void
//   getCursor()                     -> number
//   setCursor(n)                    -> void
//   logConflict(record)             -> void
//
// Contrato de `remote`:
//   insert(table, row)                  -> { ok: true, row } | { ok: false, serverRow }
//   update(table, id, row, baseRev)     -> { ok: true, row } | { ok: false, serverRow }
//   pull(cursor, limit)                 -> { rows: [{ table, row }], hasMore }
//
// Regras:
//   * Apagar é escrever deleted_at. Nunca há DELETE.
//   * rev detecta conflito; seq ordena o pull.
//   * Pagamento já validado no servidor é imutável: o servidor vence sempre.

import { uuid } from './ids.js';

export const TABLES = Object.freeze(['clients', 'payments', 'bills']);

// Se a edição local for mais antiga que isto, assume-se dispositivo atrasado
// e o servidor vence. Absorve pequenos desvios de relógio entre dispositivos.
const STALE_TOLERANCE_MS = 120_000;

function assertTable(table) {
  if (!TABLES.includes(table)) throw new Error(`Tabela desconhecida: ${table}`);
}

/**
 * @returns {'local' | 'server'}
 */
export function decideConflict({ table, localRow, serverRow }) {
  if (!serverRow) return 'local';

  // Pagamento já validado não aceita reescrita de operador.
  if (table === 'payments' && serverRow.status !== 'Pendente') return 'server';

  const localTime = Date.parse(localRow.updatedAt);
  const serverTime = Date.parse(serverRow.updated_at);

  if (!Number.isFinite(localTime)) return 'server';
  if (!Number.isFinite(serverTime)) return 'local';

  return localTime + STALE_TOLERANCE_MS >= serverTime ? 'local' : 'server';
}

export function createSyncEngine({ local, remote, now = () => new Date() }) {
  if (!local || !remote) throw new Error('local e remote são obrigatórios');

  const iso = () => now().toISOString();

  async function write(table, record) {
    assertTable(table);
    if (!record?.id) throw new Error('record.id é obrigatório');

    const existing = await local.getRecord(table, record.id);
    const pending = await local.getPending(table, record.id);
    const stamp = iso();

    const row = {
      ...existing,
      ...record,
      id: record.id,
      updatedAt: stamp,
      rev: (existing?.rev ?? 0) + 1,
      serverRev: existing?.serverRev ?? null,
    };

    await local.putRecord(table, row);
    await local.enqueue({
      id: uuid(),
      table,
      recordId: row.id,
      // Primeira edição pendente fixa a base; edições seguintes empilham-se nela.
      baseRev: pending ? pending.baseRev : row.serverRev,
      payload: row,
      createdAt: stamp,
      attempts: 0,
    });

    return row;
  }

  async function acceptServer(table, serverRow) {
    await local.putRecord(table, {
      ...serverRow,
      updatedAt: serverRow.updated_at,
      serverRev: serverRow.rev,
    });
  }

  async function resolve(item, serverRow) {
    const decision = decideConflict({
      table: item.table,
      localRow: item.payload,
      serverRow,
    });

    await local.logConflict({
      table: item.table,
      recordId: item.recordId,
      decision,
      at: iso(),
      localRow: item.payload,
      serverRow,
    });

    if (decision === 'server') {
      if (serverRow) await acceptServer(item.table, serverRow);
      await local.removeOutbox(item.id);
      return 'server';
    }

    // Local vence: reescreve sobre a revisão actual do servidor.
    const rebased = await remote.update(
      item.table,
      item.recordId,
      item.payload,
      serverRow ? serverRow.rev : null,
    );
    if (!rebased.ok) throw new Error('Rebase rejeitado pelo servidor');
    await local.putRecord(item.table, {
      ...item.payload,
      serverRev: rebased.row.rev,
    });
    await local.removeOutbox(item.id);
    return 'local';
  }

  async function flush() {
    const items = await local.listOutbox();
    const result = { pushed: 0, conflicts: 0, error: null, remaining: items.length };

    for (const item of items) {
      try {
        let saved;

        if (item.baseRev == null) {
          saved = await remote.insert(item.table, item.payload);
        } else {
          saved = await remote.update(
            item.table,
            item.recordId,
            item.payload,
            item.baseRev,
          );
        }

        if (saved.ok) {
          await local.putRecord(item.table, {
            ...item.payload,
            serverRev: saved.row.rev,
          });
          await local.removeOutbox(item.id);
          result.pushed++;
        } else {
          const outcome = await resolve(item, saved.serverRow);
          result.conflicts++;
          if (outcome === 'local') result.pushed++;
        }
      } catch (err) {
        // Falha de rede: para aqui. O outbox fica intacto para a próxima tentativa.
        result.error = err?.message ?? String(err);
        break;
      }
    }

    result.remaining = (await local.listOutbox()).length;
    return result;
  }

  async function pull({ limit = 200 } = {}) {
    let cursor = await local.getCursor();
    const result = { applied: 0, skipped: 0, cursor, pages: 0 };

    for (;;) {
      const page = await remote.pull(cursor, limit);
      result.pages++;

      for (const { table, row } of page.rows) {
        if (row.seq > cursor) cursor = row.seq;

        // Edição local por enviar: o push resolve o conflito, o pull não a pisa.
        if (await local.getPending(table, row.id)) {
          result.skipped++;
          continue;
        }

        await acceptServer(table, row);
        result.applied++;
      }

      await local.setCursor(cursor);

      if (!page.hasMore || page.rows.length === 0) break;
    }

    result.cursor = cursor;
    return result;
  }

  async function sync(options) {
    const push = await flush();
    const download = push.error ? null : await pull(options);
    const retry = !push.error && push.conflicts > 0 ? await flush() : null;
    return { push, pull: download, retry };
  }

  return { write, flush, pull, sync };
}
