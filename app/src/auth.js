// Sessão do utilizador contra o GoTrue do Supabase.
//
// O PostgREST só devolve linhas a quem envia `Authorization: Bearer <JWT do
// utilizador>`; a chave anon sozinha dá o papel `anon` e o RLS devolve zero.
// Por isso a sessão é pré-requisito de qualquer leitura.

const STORAGE_KEY = 'ende.session';
const REFRESH_MARGIN_MS = 60_000;

function defaultStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function createAuth({
  url,
  anonKey,
  storage = defaultStorage(),
  fetchFn = (...args) => fetch(...args),
  now = () => Date.now(),
}) {
  const base = String(url).replace(/\/$/, '');
  const listeners = new Set();
  let session = read();

  function read() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function write(next) {
    session = next;
    if (storage) {
      if (next) storage.setItem(STORAGE_KEY, JSON.stringify(next));
      else storage.removeItem(STORAGE_KEY);
    }
    for (const fn of listeners) {
      try {
        fn(next);
      } catch {
        /* um ouvinte a falhar não pode impedir os restantes */
      }
    }
  }

  async function post(path, body, token) {
    const res = await fetchFn(`${base}${path}`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!res.ok) {
      const message =
        (payload && (payload.msg || payload.message || payload.error_description)) ||
        `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  function normalise(raw) {
    const expiresAt =
      typeof raw.expires_at === 'number'
        ? raw.expires_at
        : Math.floor(now() / 1000) + (raw.expires_in ?? 3600);
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: expiresAt,
      user: raw.user ?? null,
    };
  }

  return {
    getSession() {
      return session;
    },

    getAccessToken() {
      return session?.access_token ?? null;
    },

    getUser() {
      return session?.user ?? null;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async signIn({ email, password }) {
      const raw = await post('/auth/v1/token?grant_type=password', { email, password });
      write(normalise(raw));
      return session;
    },

    async refresh() {
      if (!session?.refresh_token) throw new Error('Sem sessão para renovar.');
      const raw = await post('/auth/v1/token?grant_type=refresh_token', {
        refresh_token: session.refresh_token,
      });
      write(normalise(raw));
      return session;
    },

    /** Renova o token se estiver a terminar. Devolve o token válido ou null. */
    async getFreshAccessToken() {
      if (!session) return null;
      const remaining = session.expires_at * 1000 - now();
      if (remaining > REFRESH_MARGIN_MS) return session.access_token;
      try {
        await this.refresh();
        return session.access_token;
      } catch (err) {
        if (err?.status === 400 || err?.status === 401) {
          write(null);
          return null;
        }
        throw err; // falha de rede: mantém a sessão e deixa o chamador repetir
      }
    },

    async signOut() {
      const token = session?.access_token;
      write(null);
      if (!token) return;
      try {
        await post('/auth/v1/logout', {}, token);
      } catch {
        /* sessão local já limpa; logout do servidor é best-effort */
      }
    },

    /** Criar conta. O Supabase pode exigir confirmação de e-mail. */
    async signUp({ email, password, data }) {
      return post('/auth/v1/signup', { email, password, data: data ?? {} });
    },
  };
}
