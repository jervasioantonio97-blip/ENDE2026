// Cliente da Edge Function `admin-users`.
//
// Não tem chave nenhuma aqui: só envia o JWT da sessão. Quem tem a chave de
// serviço é a função, do outro lado do HTTPS.
//
// Contrato devolvido pela função:
//   list()                 -> { users: [{ id, email, full_name, role, ... }] }
//   create({ email, ... }) -> { id, email, password, role, full_name }
//   reset(userId)          -> { id, password }
//   revoke(userId)         -> { id, revoked: true }
//
// Todos os erros chegam como `Error` com a mensagem em português que a
// função devolveu, para a interface poder mostrá-la tal e qual.

export function createAdminUsers({
  url,
  anonKey,
  getToken,
  fetchFn = (...args) => fetch(...args),
}) {
  if (!url || !anonKey) throw new Error('url e anonKey são obrigatórios');

  const base = String(url).replace(/\/$/, '');

  async function call(payload) {
    const token = await getToken();
    if (!token) throw new Error('Sessão expirada: entre novamente.');

    const res = await fetchFn(`${base}/functions/v1/admin-users`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      const message =
        (body && body.error) ||
        (res.status === 404 && 'Painel de contas indisponível (função não publicada).') ||
        `Falha no pedido (${res.status}).`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return body;
  }

  return {
    list: () => call({ action: 'list' }),

    create({ email, fullName, role, password }) {
      return call({
        action: 'create',
        email: String(email ?? '').trim().toLowerCase(),
        full_name: String(fullName ?? '').trim(),
        role: role ?? 'operador', // o servidor valida contra ('admin','operador')
        ...(password ? { password } : {}),
      });
    },

    reset: (userId) => call({ action: 'reset', user_id: userId }),

    revoke: (userId) => call({ action: 'revoke', user_id: userId }),
  };
}
