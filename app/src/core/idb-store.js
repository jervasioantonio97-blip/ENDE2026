// Armazenamento local no navegador/WebView. Implementa o contrato de `local`
// exigido por sync-engine.js, mas sobre IndexedDB (não localStorage).
//
// Porque não localStorage: 5–10 MB de limite, escrita síncrona, e o Android
// pode limpá-lo. IndexedDB é transacional e não é despejado com a mesma
// facilidade; mesmo assim, mantém sempre a exportação JSON como cópia de segurança.

const DB_NAME = 'ende-control';
const DB_VERSION = 1;

const STORES = {
  records: 'records', // key: `${table}:${id}`
  outbox: 'outbox', // key: id
  meta: 'meta', // key: k
  conflicts: 'conflicts', // autoIncrement
};

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openStore(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORES.records)) {
        const s = db.createObjectStore(STORES.records, { keyPath: 'key' });
        s.createIndex('byTable', 'table');
      }
      if (!db.objectStoreNames.contains(STORES.outbox)) {
        const s = db.createObjectStore(STORES.outbox, { keyPath: 'id' });
        s.createIndex('byRecord', ['table', 'recordId']);
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains(STORES.conflicts)) {
        db.createObjectStore(STORES.conflicts, { autoIncrement: true });
      }
    };

    req.onsuccess = () => resolve(createAdapter(req.result));
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB bloqueada por outra aba'));
  });
}

function createAdapter(db) {
  const tx = (stores, mode) => db.transaction(stores, mode);

  async function get(store, key) {
    const t = tx([store], 'readonly');
    const result = await request(t.objectStore(store).get(key));
    return result ?? null;
  }

  return {
    async getRecord(table, id) {
      const entry = await get(STORES.records, `${table}:${id}`);
      return entry ? entry.row : null;
    },

    async putRecord(table, row) {
      const t = tx([STORES.records], 'readwrite');
      t.objectStore(STORES.records).put({
        key: `${table}:${row.id}`,
        table,
        id: row.id,
        row,
      });
      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },

    /** Todas as linhas de uma tabela, para a interface. */
    async listRecords(table) {
      const t = tx([STORES.records], 'readonly');
      const all = await request(
        t.objectStore(STORES.records).index('byTable').getAll(table),
      );
      return all.map((entry) => entry.row);
    },

    /** Conflitos resolvidos, para auditoria no painel. */
    async listConflicts() {
      const t = tx([STORES.conflicts], 'readonly');
      return request(t.objectStore(STORES.conflicts).getAll());
    },

    async getPending(table, id) {
      const t = tx([STORES.outbox], 'readonly');
      const idx = t.objectStore(STORES.outbox).index('byRecord');
      const entry = await request(idx.get([table, id]));
      return entry ?? null;
    },

    async enqueue(entry) {
      const existing = await this.getPending(entry.table, entry.recordId);
      const t = tx([STORES.outbox], 'readwrite');
      const store = t.objectStore(STORES.outbox);

      if (existing) {
        // Mantém a base original para o servidor conseguir detectar conflito.
        store.put({ ...entry, id: existing.id, baseRev: existing.baseRev });
      } else {
        store.put(entry);
      }

      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },

    async listOutbox() {
      const t = tx([STORES.outbox], 'readonly');
      const all = await request(t.objectStore(STORES.outbox).getAll());
      return all.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    },

    async removeOutbox(id) {
      const t = tx([STORES.outbox], 'readwrite');
      t.objectStore(STORES.outbox).delete(id);
      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },

    async getCursor() {
      const entry = await get(STORES.meta, 'cursor');
      return entry ? entry.value : 0;
    },

    async setCursor(value) {
      const t = tx([STORES.meta], 'readwrite');
      t.objectStore(STORES.meta).put({ k: 'cursor', value });
      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },

    async logConflict(entry) {
      const t = tx([STORES.conflicts], 'readwrite');
      t.objectStore(STORES.conflicts).add(entry);
      await new Promise((resolve, reject) => {
        t.oncomplete = resolve;
        t.onerror = () => reject(t.error);
      });
    },

    close() {
      db.close();
    },
  };
}
