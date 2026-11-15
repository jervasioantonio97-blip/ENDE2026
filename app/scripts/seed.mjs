// Semeia a organização inicial e o perfil do primeiro administrador.
//
// Sem linha em `profiles`, um utilizador autenticado vê ZERO linhas: todas as
// políticas RLS dependem de `current_org_id()`, que lê `profiles`.
//
// Uso (a chave de serviço NUNCA vai para o repositório — só por ambiente):
//
//   $env:SUPABASE_URL = 'https://<ref>.supabase.co'
//   $env:SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_... ou JWT legacy service_role'
//   $env:SEED_USER_EMAIL = 'admin@exemplo.com'
//   node scripts/seed.mjs
//
// Opcional: SEED_USER_PASSWORD cria o utilizador se ainda não existir.
// Opcional: SEED_ORG_NAME (por omissão 'ENDE'), SEED_USER_NAME.

const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const email = process.env.SEED_USER_EMAIL || '';
const password = process.env.SEED_USER_PASSWORD || '';
const orgName = process.env.SEED_ORG_NAME || 'ENDE';
const fullName = process.env.SEED_USER_NAME || 'Administrador';

if (!url || !serviceKey || !email) {
  console.error('Falta SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou SEED_USER_EMAIL.');
  process.exit(1);
}

const headers = () => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
});

async function api(path, options = {}) {
  const res = await fetch(`${url}${path}`, { ...options, headers: { ...headers(), ...options.headers } });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = typeof body === 'object' && body ? body.message || body.error_description || text : text;
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status}: ${msg}`);
  }
  return body;
}

async function ensureUser() {
  const list = await api('/auth/v1/admin/users?page=1&per_page=200');
  const found = (list.users || []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (found) {
    console.log(`Utilizador já existe: ${found.email} (${found.id})`);
    return found.id;
  }
  if (!password) {
    throw new Error(
      `Utilizador ${email} não existe. Defina SEED_USER_PASSWORD para o criar, ou crie-o no dashboard.`,
    );
  }
  const created = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  });
  console.log(`Utilizador criado e confirmado: ${created.email} (${created.id})`);
  return created.id;
}

async function ensureOrg() {
  const existing = await api('/rest/v1/orgs?select=id,name&limit=1');
  if (existing.length > 0) {
    console.log(`Organização já existe: ${existing[0].name} (${existing[0].id})`);
    return existing[0].id;
  }
  const created = await api('/rest/v1/orgs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ name: orgName }),
  });
  console.log(`Organização criada: ${created[0].name} (${created[0].id})`);
  return created[0].id;
}

async function ensureProfile(userId, orgId) {
  const existing = await api(`/rest/v1/profiles?id=eq.${userId}&select=id,org_id,role`);
  if (existing.length > 0) {
    const p = existing[0];
    if (p.org_id !== orgId || p.role !== 'admin') {
      await api(`/rest/v1/profiles?id=eq.${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ org_id: orgId, role: 'admin' }),
      });
      console.log(`Perfil corrigido para admin da organização ${orgId}`);
    } else {
      console.log(`Perfil já correcto: role=${p.role}`);
    }
    return;
  }
  await api('/rest/v1/profiles', {
    method: 'POST',
    body: JSON.stringify({ id: userId, org_id: orgId, full_name: fullName, role: 'admin' }),
  });
  console.log(`Perfil de administrador criado para ${userId}`);
}

const userId = await ensureUser();
const orgId = await ensureOrg();
await ensureProfile(userId, orgId);

const check = await api('/rest/v1/profiles?select=id,org_id,role,full_name');
console.log(`\nVerificação (service_role) — profiles: ${JSON.stringify(check)}`);
console.log('Seed concluído.');
