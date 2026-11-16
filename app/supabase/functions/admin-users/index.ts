// Edge Function `admin-users` — painel administrador de contas de acesso.
//
// Porque é que isto existe aqui e não no navegador:
//   criar/listar/repor utilizadores exige a chave de serviço (service_role),
//   que contorna o RLS. Essa chave NUNCA pode entrar no cliente, por isso a
//   operação vive nesta função e o navegador só envia o seu próprio JWT.
//
// Contrato (POST JSON):
//   { action: 'list' }
//   { action: 'create', email, full_name, role, password?, client_id? }
//   { action: 'reset', user_id }
//   { action: 'revoke', user_id }
//
// Papel `cliente`: exige `client_id` (ficha de `clients` da mesma org). É a
// ligação que permite ao RLS do portal limitar a leitura às linhas dessa
// pessoa.
//
// Regras de segurança:
//   * verify_jwt está activo: o gateway já validou a assinatura do JWT.
//   * Mesmo assim, o papel é lido em `profiles` com a chave de serviço —
//     nunca se confia no que o cliente diz ser.
//   * `org_id` vem do perfil do ADMINISTRADOR que faz o pedido. O cliente não
//     o escolhe: não há como criar contas noutra organização.
//   * Os papéis aceites são os do CHECK do esquema: `admin`, `operador` e
//     `cliente` (este último exige `client_id` da mesma org).
//   * Ninguém se revoga a si próprio.

const URL_BASE = Deno.env.get('SUPABASE_URL') ?? '';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLES = new Set(['admin', 'operador', 'cliente']);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── chaves ───────────────────────────────────────────────────────────────────
// O runtime injecta `SUPABASE_SECRET_KEYS`/`SUPABASE_PUBLISHABLE_KEYS` (novos)
// e `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` (legados). Nem todas as
// projecções têm o par novo, por isso tenta as duas formas.

function candidates(envNew: string, envLegacy: string, override?: string): string[] {
  const out: string[] = [];
  if (override) out.push(override);
  const raw = Deno.env.get(envNew);
  if (raw) {
    try {
      const dict = JSON.parse(raw) as Record<string, string>;
      if (dict?.default) out.push(dict.default);
    } catch {
      /* JSON inválido: ignora e cai para o legado */
    }
  }
  const legacy = Deno.env.get(envLegacy);
  if (legacy) out.push(legacy);
  return [...new Set(out.filter(Boolean))];
}

const serviceKeys = () =>
  candidates('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY', Deno.env.get('ADMIN_SERVICE_KEY'));

const publishableKeys = () => candidates('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');

/** Chamada autenticada como serviço. Repete com a chave seguinte só em 401. */
async function serviceFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const keys = serviceKeys();
  if (keys.length === 0) return new Response('sem chave de serviço', { status: 500 });

  let last: Response | null = null;
  for (const key of keys) {
    const res = await fetch(`${URL_BASE}${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status !== 401) return res;
    last = res; // chave rejeitada: tenta a próxima candidata
  }
  return last as Response;
}

/** Devolve o id do utilizador dono do JWT recebido, ou null. */
async function callerId(authorization: string): Promise<string | null> {
  for (const key of publishableKeys()) {
    const res = await fetch(`${URL_BASE}/auth/v1/user`, {
      headers: { apikey: key, Authorization: authorization },
    });
    if (res.ok) {
      const user = await res.json();
      if (user?.id) return user.id as string;
    }
  }
  return null;
}

// ── leitura de perfil ────────────────────────────────────────────────────────

interface CallerProfile {
  org_id: string;
  role: string;
}

async function profileOf(userId: string): Promise<CallerProfile | null> {
  const res = await serviceFetch(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=org_id,role&limit=1`,
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// ── acções ───────────────────────────────────────────────────────────────────

interface GoTrueUser {
  id: string;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string;
  user_metadata?: Record<string, unknown>;
}

async function listAllUsers(): Promise<GoTrueUser[]> {
  const users: GoTrueUser[] = [];
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const res = await serviceFetch(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    if (!res.ok) throw new Error(`Falha ao listar utilizadores (${res.status})`);
    const body = await res.json();
    const batch: GoTrueUser[] = body?.users ?? [];
    users.push(...batch);
    if (batch.length < perPage) break;
  }
  return users;
}

async function actionList(orgId: string): Promise<Response> {
  const [users, profileRes, clientRes] = await Promise.all([
    listAllUsers(),
    serviceFetch(`/rest/v1/profiles?org_id=eq.${orgId}&select=id,full_name,role,client_id&limit=1000`),
    serviceFetch(`/rest/v1/clients?org_id=eq.${orgId}&select=id,name&limit=1000`),
  ]);

  if (!profileRes.ok) throw new Error(`Falha ao ler perfis (${profileRes.status})`);
  const profiles = (await profileRes.json()) as Array<{
    id: string;
    full_name: string;
    role: string;
    client_id: string | null;
  }>;
  const clients = clientRes.ok
    ? ((await clientRes.json()) as Array<{ id: string; name: string }>)
    : [];
  const clientName = new Map(clients.map((c) => [c.id, c.name]));

  // Só devolve utilizadores desta organização: quem não tem perfil na org
  // (incluindo outras orgs) não aparece no painel.
  const rows = profiles
    .map((p) => {
      const u = users.find((x) => x.id === p.id);
      return {
        id: p.id,
        email: u?.email ?? '',
        full_name: p.full_name,
        role: p.role,
        client_id: p.client_id,
        client_name: p.client_id ? clientName.get(p.client_id) ?? null : null,
        created_at: u?.created_at ?? null,
        last_sign_in_at: u?.last_sign_in_at ?? null,
      };
    })
    .filter((r) => r.email)
    .sort((a, b) => a.email.localeCompare(b.email));

  return json({ users: rows });
}

function randomPassword(length = 16): string {
  // Alfabeto sem caracteres ambígos (0/O, 1/l/I) para o administrador
  // conseguir transcrever a senha para o funcionário sem erro.
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function actionCreate(
  body: Record<string, unknown>,
  orgId: string,
): Promise<Response> {
  const email = String(body.email ?? '').trim().toLowerCase();
  const fullName = String(body.full_name ?? '').trim();
  const role = String(body.role ?? 'operador');
  const password = body.password ? String(body.password) : randomPassword();
  const clientIdRaw = body.client_id ? String(body.client_id).trim() : '';

  if (!EMAIL_RE.test(email)) return json({ error: 'E-mail inválido.' }, 400);
  if (!ROLES.has(role)) return json({ error: 'Papel inválido: use admin, operador ou cliente.' }, 400);
  if (password.length < 8) return json({ error: 'A palavra-passe precisa de 8 caracteres.' }, 400);

  // Papel `cliente` é obrigatoriamente ligado a uma ficha de clients da MESMA
  // organização — sem isso o RLS do portal não tem por onde limitar as linhas.
  let clientId: string | null = null;
  if (role === 'cliente') {
    if (!UUID_RE.test(clientIdRaw)) {
      return json({ error: 'Conta de cliente exige um client_id válido.' }, 400);
    }
    const check = await serviceFetch(
      `/rest/v1/clients?id=eq.${encodeURIComponent(clientIdRaw)}&org_id=eq.${orgId}&select=id&limit=1`,
    );
    const found = check.ok ? await check.json() : [];
    if (!Array.isArray(found) || found.length === 0) {
      return json({ error: 'Cliente não existe ou não pertence à sua organização.' }, 404);
    }
    clientId = clientIdRaw;
  } else if (clientIdRaw) {
    return json({ error: 'Só o papel cliente pode ter ficha ligada.' }, 400);
  }

  const created = await serviceFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true, // o administrador emite a conta: não há confirmação por e-mail
      user_metadata: { full_name: fullName || email },
    }),
  });

  if (!created.ok) {
    const text = await created.text();
    const duplicated = created.status === 422 || /already been registered/i.test(text);
    if (duplicated) return json({ error: 'Já existe uma conta com este e-mail.' }, 409);
    return json({ error: `Falha ao criar a conta (${created.status}).` }, 502);
  }

  const user = (await created.json()) as GoTrueUser;

  // Perfil: org_id vem do ADMINISTRADOR, nunca do pedido.
  const profile = await serviceFetch('/rest/v1/profiles', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      id: user.id,
      org_id: orgId,
      full_name: fullName || email,
      role,
      client_id: clientId,
    }),
  });

  if (!profile.ok) {
    // Sem perfil o utilizador entra e não vê nada: desfaz a criação para não
    // deixar uma conta órfã a dificultar a auditoria.
    await serviceFetch(`/auth/v1/admin/users/${user.id}`, { method: 'DELETE' });
    const text = await profile.text();
    return json({ error: `Falha ao guardar o perfil (${profile.status}): ${text.slice(0, 200)}` }, 502);
  }

  return json({ id: user.id, email, password, role, full_name: fullName, client_id: clientId });
}

async function actionReset(body: Record<string, unknown>): Promise<Response> {
  const userId = String(body.user_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: 'Identificador inválido.' }, 400);

  const password = randomPassword();
  const res = await serviceFetch(`/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) return json({ error: `Falha ao repor a palavra-passe (${res.status}).` }, 502);
  return json({ id: userId, password });
}

async function actionRevoke(body: Record<string, unknown>, caller: string, orgId: string): Promise<Response> {
  const userId = String(body.user_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return json({ error: 'Identificador inválido.' }, 400);
  if (userId === caller) return json({ error: 'Não pode revogar o seu próprio acesso.' }, 400);

  // Só utilizadores da mesma organização: um administrador de outra org
  // (se alguma vez existir) fica fora do alcance desta função.
  const target = await profileOf(userId);
  if (!target || target.org_id !== orgId) {
    return json({ error: 'Conta não pertence à sua organização.' }, 404);
  }

  // O RLS não tem política de DELETE, mas a chave de serviço contorna o RLS —
  // por isso a guarda é esta, aqui, e não no banco.
  const res = await serviceFetch(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
  if (!res.ok) return json({ error: `Falha ao revogar a conta (${res.status}).` }, 502);

  // `profiles.id` referencia `auth.users` com on delete cascade: o perfil
  // desaparece sozinho.
  return json({ id: userId, revoked: true });
}

// ── handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  if (req.method !== 'POST') {
    return json({ error: 'Use POST.' }, 405);
  }

  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.startsWith('Bearer ')) {
    return json({ error: 'Sessão necessária.' }, 401);
  }

  try {
    const userId = await callerId(authorization);
    if (!userId) return json({ error: 'Sessão inválida: entre novamente.' }, 401);

    const profile = await profileOf(userId);
    if (!profile) return json({ error: 'Sem perfil associado.' }, 403);
    if (profile.role !== 'admin') return json({ error: 'Apenas administradores.' }, 403);

    const body = (await req.json()) as Record<string, unknown>;
    const action = String(body.action ?? '');

    switch (action) {
      case 'list':
        return await actionList(profile.org_id);
      case 'create':
        return await actionCreate(body, profile.org_id);
      case 'reset':
        return await actionReset(body);
      case 'revoke':
        return await actionRevoke(body, userId, profile.org_id);
      default:
        return json({ error: `Acção desconhecida: ${action || '(vazia)'}` }, 400);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 500);
  }
});
