// Adaptadores de teste com a mesma semântica do PostgREST/Supabase:
// insert falha se o id já existe; update só aplica se rev === baseRev.

export function createFakeRemote({ now = () => new Date() } = {}) {
  const store = new Map();
  let seq = 0;
  let online = true;

  const key = (table, id) => `${table}:${id}`;

  const stamp = (table, row, rev, previous) => {
    const saved = {
      ...previous,
      ...row,
      rev,
      seq: ++seq,
      updated_at: now().toISOString(),
    };
    // Campos que só existem no cliente.
    delete saved.serverRev;
    delete saved.updatedAt;
    delete saved.__table;
    return { ...saved, __table: table };
  };

  const clean = (r) => {
    const { __table, ...row } = r;
    return { table: __table, row };
  };

  return {
    isOnline: () => online,
    setOnline: (v) => {
      online = v;
    },

    rows(table) {
      return [...store.values()].filter((r) => r.__table === table);
    },

    seed(table, row) {
      const saved = {
        rev: 1,
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
        ...row,
        seq: ++seq,
        __table: table,
      };
      store.set(key(table, row.id), saved);
      return saved;
    },

    async insert(table, row) {
      if (!online) throw new Error('offline');
      const existing = store.get(key(table, row.id));
      if (existing) return { ok: false, serverRow: existing };
      const saved = stamp(table, row, 1);
      store.set(key(table, row.id), saved);
      return { ok: true, row: saved };
    },

    async update(table, id, row, baseRev) {
      if (!online) throw new Error('offline');
      const current = store.get(key(table, id));
      if (!current) return { ok: false, serverRow: null };
      if (baseRev == null || current.rev !== baseRev) {
        return { ok: false, serverRow: current };
      }
      const saved = stamp(table, row, current.rev + 1, current);
      store.set(key(table, id), saved);
      return { ok: true, row: saved };
    },

    async pull(cursor, limit = 200) {
      if (!online) throw new Error('offline');
      const pending = [...store.values()]
        .filter((r) => r.seq > cursor)
        .sort((a, b) => a.seq - b.seq);
      const page = pending.slice(0, limit);
      return {
        rows: page.map(clean),
        hasMore: pending.length > limit,
      };
    },
  };
}

export function createMemoryLocal() {
  const records = new Map();
  const outbox = [];
  const conflicts = [];
  let cursor = 0;

  const key = (table, id) => `${table}:${id}`;

  return {
    async getRecord(table, id) {
      return records.get(key(table, id)) ?? null;
    },
    async putRecord(table, row) {
      records.set(key(table, row.id), row);
    },
    async getPending(table, id) {
      return outbox.find((o) => o.table === table && o.recordId === id) ?? null;
    },
    async enqueue(entry) {
      const i = outbox.findIndex(
        (o) => o.table === entry.table && o.recordId === entry.recordId,
      );
      if (i >= 0) {
        outbox[i] = { ...entry, baseRev: outbox[i].baseRev };
      } else {
        outbox.push(entry);
      }
    },
    async listOutbox() {
      return [...outbox];
    },
    async removeOutbox(id) {
      const i = outbox.findIndex((o) => o.id === id);
      if (i >= 0) outbox.splice(i, 1);
    },
    async getCursor() {
      return cursor;
    },
    async setCursor(n) {
      cursor = n;
    },
    async logConflict(entry) {
      conflicts.push(entry);
    },

    // Apenas para os testes.
    debug: { records, outbox, conflicts },
  };
}
