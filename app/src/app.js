// ENDE CONTROL — casca da aplicação.
//
// Liga as três peças que já existiam separadas:
//   idb-store.js      -> armazenamento local (contrato `local`)
//   remote-supabase.js-> PostgREST       (contrato `remote`)
//   sync-engine.js    -> push/pull e resolução de conflitos
//
// A interface nunca fala com a rede directamente: escreve pelo motor e o
// motor decide o que vai para o servidor e o que fica pendente.

import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_VERSION } from './config.js';
import { createAuth } from './auth.js';
import { createSupabaseRemote } from './remote-supabase.js';
import { createAdminUsers } from './admin-users.js';
import { createSyncEngine, TABLES } from './core/sync-engine.js';
import { openStore } from './core/idb-store.js';
import { uuid } from './core/ids.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s ?? '').replace(/\s+/g, '-');
const money = (n) =>
  (Number(n) || 0).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Kz';
const today = () => new Date().toISOString().slice(0, 10);

const state = {
  auth: null,
  local: null,
  engine: null,
  orgId: null,
  role: null,
  clients: [],
  payments: [],
  bills: [],
  conflicts: [],
  pending: 0,
  syncing: false,
  lastSync: null,
};

// ── autenticação ─────────────────────────────────────────────────────────────

const auth = createAuth({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
state.auth = auth;

function showNotice(kind, message) {
  const el = $('appNotice');
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.className = 'notice ' + kind;
  el.textContent = message;
  el.hidden = false;
}

function showLogin(message) {
  $('appView').hidden = true;
  $('loginView').hidden = false;
  const err = $('loginError');
  err.textContent = message || '';
  err.classList.toggle('hidden', !message);
  $('loginPassword').value = '';
}

async function loadProfile(user) {
  const token = await auth.getFreshAccessToken();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=org_id,role,full_name`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Não foi possível ler o seu perfil (HTTP ${res.status}).`);
  const rows = await res.json();
  if (!rows.length) {
    throw new Error(
      'A sua conta ainda não está associada a nenhuma organização. Peça ao administrador para criar o seu perfil.',
    );
  }
  return rows[0];
}

async function enterApp() {
  const user = auth.getUser();
  if (!user) return showLogin();

  try {
    const profile = await loadProfile(user);
    state.orgId = profile.org_id;
    state.role = profile.role;
  } catch (err) {
    showLogin(err.message);
    await auth.signOut();
    return;
  }

  // Conta de cliente: o painel de gestão não é para ela. O acesso é o portal.
  if (state.role === 'cliente') {
    await auth.signOut();
    location.href = '../portal/';
    return;
  }

  $('loginView').hidden = true;
  $('appView').hidden = false;
  $('userEmail').textContent = `${user.email} · ${state.role}`;

  // O painel de equipa só existe para administradores.
  const isAdmin = state.role === 'admin';
  $('tabEquipa').hidden = !isAdmin;
  if (!isAdmin) {
    $('equipa').classList.add('hidden');
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === 'painel');
    });
    $('painel').classList.remove('hidden');
  }

  if (!state.local) {
    state.local = await openStore('ende-control');
    const remote = createSupabaseRemote({
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      getToken: () => auth.getFreshAccessToken(),
      getOrgId: () => state.orgId,
    });
    state.engine = createSyncEngine({ local: state.local, remote });
  }

  await refresh();
  await doSync();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  try {
    await auth.signIn({
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value,
    });
    await enterApp();
  } catch (err) {
    showLogin(err.message || 'Não foi possível entrar.');
  } finally {
    btn.disabled = false;
  }
});

$('forgotBtn').addEventListener('click', async () => {
  const email = $('loginEmail').value.trim();
  if (!email) return showLogin('Escreva o e-mail antes de pedir a recuperação.');
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    // 200 mesmo quando o e-mail não existe: não revela contas.
    showLogin(res.ok
      ? 'Se o e-mail existir, recebe instruções de recuperação.'
      : 'Não foi possível enviar o e-mail de recuperação.');
  } catch {
    showLogin('Sem ligação para recuperar a palavra-passe.');
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await auth.signOut();
  state.engine = null;
  state.local = null;
  state.role = null;
  $('tabEquipa').hidden = true;
  showLogin();
});

// ── painel de equipa (só administradores) ────────────────────────────────────
//
// Fala com a Edge Function `admin-users`. O navegador envia apenas o JWT da
// sessão — quem tem a chave de serviço é a função, do outro lado do HTTPS.

let adminUsers = null;
let accountRows = [];
let lastCredentials = '';

function getAdminUsers() {
  if (!adminUsers) {
    adminUsers = createAdminUsers({
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      getToken: () => auth.getFreshAccessToken(),
    });
  }
  return adminUsers;
}

function showCredentials(text) {
  lastCredentials = text;
  $('accCredsBody').textContent = text;
  $('accCreds').classList.remove('hidden');
}

function renderAccountTable() {
  const el = $('accountTable');
  if (!accountRows.length) {
    el.innerHTML = '<p class="muted">Sem contas nesta organização.</p>';
    return;
  }
  const me = auth.getUser()?.id;
  el.innerHTML = table(
    ['E-mail', 'Nome', 'Papel', 'Último acesso', 'Acções'],
    accountRows.map((u) => [
      esc(u.email),
      esc(u.full_name),
      `<span class="pill ${u.role === 'admin' ? 'Confirmado' : 'Em-aberto'}">${esc(u.role)}</span>` +
        (u.role === 'cliente'
          ? `<div class="muted">${esc(u.client_name ?? 'sem ficha')}</div>`
          : ''),
      u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString('pt-PT') : '<span class="muted">nunca</span>',
      `<button class="btn warn" type="button" data-acc-reset="${esc(u.id)}">Repor palavra-passe</button> ` +
      (u.id === me
        ? '<span class="muted">esta é a sua conta</span>'
        : `<button class="btn danger" type="button" data-acc-revoke="${esc(u.id)}">Revogar</button>`),
    ]),
  );
}

async function loadAccounts() {
  const el = $('accountTable');
  el.innerHTML = '<p class="muted">A carregar…</p>';
  try {
    const res = await getAdminUsers().list();
    accountRows = res.users ?? [];
    renderAccountTable();
  } catch (err) {
    accountRows = [];
    el.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

$('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('accCreate');
  const role = $('accRole').value;
  const clientId = $('accClient').value;
  if (role === 'cliente' && !clientId) {
    showNotice('err', 'Escolha a ficha de cliente a ligar a esta conta.');
    return;
  }
  btn.disabled = true;
  try {
    const created = await getAdminUsers().create({
      email: $('accEmail').value,
      fullName: $('accName').value,
      role,
      clientId: role === 'cliente' ? clientId : '',
    });
    showCredentials(
      `E-mail:    ${created.email}\n` +
      `Palavra-passe: ${created.password}\n` +
      `Papel:     ${created.role}\n` +
      (created.role === 'cliente' ? `Portal:    ${new URL('../portal/', location.href).href}\n` : '') +
      '\nEntregue estas credenciais. A palavra-passe não volta a ser mostrada.',
    );
    $('accountForm').reset();
    $('accRole').value = 'operador';
    toggleClientField();
    showNotice('ok', `Conta criada para ${created.email}.`);
    await loadAccounts();
  } catch (err) {
    showNotice('err', err.message);
  } finally {
    btn.disabled = false;
  }
});

// O selector de ficha só faz sentido para o papel `cliente`.
function toggleClientField() {
  const isClient = $('accRole').value === 'cliente';
  $('accClientWrap').hidden = !isClient;
  $('accClient').required = isClient;
}

$('accRole').addEventListener('change', toggleClientField);

$('accCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastCredentials);
    showNotice('ok', 'Credenciais copiadas para a área de transferência.');
  } catch {
    showNotice('err', 'Não foi possível copiar. Selecione o texto manualmente.');
  }
});

$('accReload').addEventListener('click', loadAccounts);

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;

  if (t.dataset.accReset) {
    if (!confirm('Gerar uma nova palavra-passe para esta conta? A actual deixa de funcionar.')) return;
    t.disabled = true;
    try {
      const res = await getAdminUsers().reset(t.dataset.accReset);
      showCredentials(
        `E-mail:    ${accountRows.find((u) => u.id === res.id)?.email ?? '(conta)'}\n` +
        `Nova palavra-passe: ${res.password}\n\n` +
        'Entregue ao funcionário. A anterior deixa de funcionar de imediato.',
      );
      showNotice('ok', 'Palavra-passe reposta.');
      window.scrollTo(0, 0);
    } catch (err) {
      showNotice('err', err.message);
    } finally {
      t.disabled = false;
    }
    return;
  }

  if (t.dataset.accRevoke) {
    const alvo = accountRows.find((u) => u.id === t.dataset.accRevoke);
    if (!confirm(`Revogar o acesso de ${alvo?.email ?? 'esta conta'}? Não poderá voltar a entrar.`)) return;
    t.disabled = true;
    try {
      await getAdminUsers().revoke(t.dataset.accRevoke);
      showNotice('ok', `Acesso revogado: ${alvo?.email ?? ''}.`);
      await loadAccounts();
    } catch (err) {
      showNotice('err', err.message);
      t.disabled = false;
    }
  }
});

// ── leitura e apresentação ───────────────────────────────────────────────────

function table(head, rows) {
  if (!rows.length) return '<p class="muted">Sem registos.</p>';
  const th = head.map((h) => `<th>${esc(h)}</th>`).join('');
  const tb = rows
    .map((r) => '<tr>' + r.map((x) => `<td>${String(x ?? '').startsWith('<') ? x : esc(x)}</td>`).join('') + '</tr>')
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
}

const live = (rows) => rows.filter((r) => !r.deleted_at);

async function refresh() {
  if (!state.local) return;
  const [clients, payments, bills, conflicts, outbox] = await Promise.all([
    state.local.listRecords('clients'),
    state.local.listRecords('payments'),
    state.local.listRecords('bills'),
    state.local.listConflicts(),
    state.local.listOutbox(),
  ]);
  state.clients = clients;
  state.payments = payments;
  state.bills = bills;
  state.conflicts = conflicts;
  state.pending = outbox.length;
  render();
}

function render() {
  const clients = live(state.clients);
  const payments = state.payments;
  const bills = state.bills;

  const confirmed = payments.filter((p) => p.status === 'Confirmado').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const pendingAmount = payments.filter((p) => p.status === 'Pendente').reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const billed = bills.filter((b) => b.status !== 'Anulada').reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const open = bills.filter((b) => b.status === 'Em aberto' || b.status === 'Parcial').reduce((s, b) => s + (Number(b.amount) || 0), 0);

  $('metrics').innerHTML = [
    ['Clientes registados', clients.length],
    ['Cobranças registadas', money(billed)],
    ['Pagamentos confirmados', money(confirmed)],
    ['Pagamentos pendentes', money(pendingAmount)],
    ['Cobranças em aberto/parciais', money(open)],
    ['Movimentos pendentes', payments.filter((p) => p.status === 'Pendente').length],
  ].map(([k, v]) => `<div class="metric">${k}<b>${esc(v)}</b></div>`).join('');

  $('recent').innerHTML = table(
    ['Data', 'Cliente', 'Período', 'Valor', 'Estado'],
    [...payments].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5)
      .map((p) => [p.date, p.name, p.period, money(p.amount), `<span class="pill ${slug(p.status)}">${esc(p.status)}</span>`]),
  );

  fillClientSelects(clients);
  renderClientTable(clients);
  renderPaymentTable(payments);
  renderBillTable(bills);
  renderConflicts();

  $('statPending').textContent = String(state.pending);
  $('statConflicts').textContent = String(state.conflicts.length);
  $('statLast').textContent = state.lastSync
    ? new Date(state.lastSync).toLocaleString('pt-PT')
    : '—';
}

function fillClientSelects(clients) {
  const options =
    '<option value="">Escolha um cliente</option>' +
    [...clients]
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((c) => `<option value="${esc(c.id)}">${esc(c.ref)} — ${esc(c.name)}</option>`)
      .join('');
  for (const id of ['payClient', 'billClient', 'accClient']) {
    const el = $(id);
    const keep = el.value;
    el.innerHTML = options;
    if ([...el.options].some((o) => o.value === keep)) el.value = keep;
  }
}

function renderClientTable(clients) {
  const q = ($('clientSearch').value || '').trim().toLowerCase();
  // Um mesmo `ref` pode existir duas vezes em localidades distintas que
  // sincronizaram em paralelo: mostra a mais recente e oculta a duplicada.
  const byRef = new Map();
  for (const c of clients) {
    const prev = byRef.get(c.ref);
    if (!prev || String(c.updatedAt) > String(prev.updatedAt)) byRef.set(c.ref, c);
  }
  const shown = [...byRef.values()]
    .filter((c) => `${c.name} ${c.ref}`.toLowerCase().includes(q))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  $('clientTable').innerHTML = table(
    ['Referência', 'Nome', 'Contacto', 'WhatsApp', 'IBAN', 'Ano', 'Acções'],
    shown.map((c) => [
      esc(c.ref), esc(c.name), esc(c.contact), esc(c.whatsapp), esc(c.iban), esc(c.year),
      `<button class="btn secondary" type="button" data-edit-client="${esc(c.id)}">Editar</button> ` +
      `<button class="btn danger" type="button" data-del-client="${esc(c.id)}">Apagar</button>`,
    ]),
  );
}

function renderPaymentTable(payments) {
  const filter = $('payFilter').value;
  const q = ($('paySearch').value || '').trim().toLowerCase();
  const rows = [...payments]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .filter((p) => (filter === 'Todos' || p.status === filter))
    .filter((p) => `${p.name} ${p.ref} ${p.receipt}`.toLowerCase().includes(q))
    .map((p) => [
      esc(p.date), esc(p.name), esc(p.period), money(p.amount), esc(p.method),
      esc(p.receipt), esc(p.staff),
      `<span class="pill ${slug(p.status)}">${esc(p.status)}</span>`,
      p.status === 'Pendente' && state.role === 'admin'
        ? `<button class="btn good" type="button" data-pay="${esc(p.id)}" data-status="Confirmado">Confirmar</button> ` +
          `<button class="btn danger" type="button" data-pay="${esc(p.id)}" data-status="Rejeitado">Rejeitar</button>`
        : `<span class="muted">${esc(p.validated_by || '—')}</span>`,
    ]);
  $('paymentTable').innerHTML = table(
    ['Data', 'Cliente', 'Período', 'Valor', 'Método', 'Comprovativo', 'Funcionário', 'Estado', 'Acções'],
    rows,
  );
}

function renderBillTable(bills) {
  $('billTable').innerHTML = table(
    ['Cliente', 'Período', 'Emissão', 'Vencimento', 'Valor', 'Multa', 'Corte', 'Origem', 'Estado', 'Acções'],
    [...bills].reverse().map((b) => [
      esc(b.name), esc(b.period), esc(b.issue), esc(b.due), money(b.amount),
      money(b.late_fee || 0),
      b.cut
        ? '<span class="pill Rejeitado">corte</span>'
        : '<span class="muted">—</span>',
      esc(b.origin), `<span class="pill ${slug(b.status)}">${esc(b.status)}</span>`,
      `<button class="btn secondary" type="button" data-bill-cycle="${esc(b.id)}">Alterar estado</button> ` +
      `<button class="btn danger" type="button" data-bill-del="${esc(b.id)}">Apagar</button>`,
    ]),
  );
}

function renderConflicts() {
  const panel = $('conflictsPanel');
  if (!state.conflicts.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  $('conflictTable').innerHTML = table(
    ['Tabela', 'Registo', 'Decisão', 'Quando'],
    [...state.conflicts].reverse().slice(0, 20).map((c) => [
      esc(c.table), esc(c.recordId),
      `<span class="pill ${c.decision === 'server' ? 'Rejeitado' : 'Confirmado'}">${esc(c.decision)}</span>`,
      esc(c.at ? new Date(c.at).toLocaleString('pt-PT') : ''),
    ]),
  );
}

// ── escrita ──────────────────────────────────────────────────────────────────

function fail(message) {
  alert(message);
}

async function commit(fn) {
  try {
    await fn();
    await refresh();
    // Escrita local primeiro, rede depois: funciona offline.
    doSync();
  } catch (err) {
    fail(err.message || String(err));
  }
}

function clientById(id) {
  return state.clients.find((c) => c.id === id);
}

$('clientForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('clientId').value || uuid();
  const ref = $('ref').value.trim();
  const name = $('name').value.trim();
  if (!ref || !name) return fail('Referência e nome são obrigatórios.');

  const dup = live(state.clients).find((c) => c.ref === ref && c.id !== id);
  if (dup) return fail('Já existe um cliente com esta referência.');

  commit(() => state.engine.write('clients', {
    id,
    org_id: state.orgId,
    ref,
    name,
    contact: $('contact').value.trim(),
    whatsapp: $('whatsapp').value.trim(),
    iban: $('iban').value.trim(),
    year: Number($('year').value) || new Date().getFullYear(),
    deleted_at: null,
  }));
  e.target.reset();
  $('clientId').value = '';
  $('year').value = String(new Date().getFullYear());
});

$('clearClient').addEventListener('click', () => {
  setTimeout(() => { $('clientId').value = ''; }, 0);
});

$('paymentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const client = clientById($('payClient').value);
  if (!client) return fail('Escolha um cliente.');
  const amount = Number($('amount').value);
  if (!(amount > 0)) return fail('O valor tem de ser maior que zero.');
  if (!$('payDate').value) return fail('Indique a data do pagamento.');

  commit(() => state.engine.write('payments', {
    id: uuid(),
    org_id: state.orgId,
    client_id: client.id,
    ref: client.ref,
    name: client.name,
    period: $('period').value.trim(),
    date: $('payDate').value,
    amount,
    method: $('method').value,
    receipt: $('receipt').value.trim(),
    staff: $('staff').value.trim(),
    notes: $('payNotes').value.trim(),
    status: 'Pendente',
    validated_by: '',
    validated_at: null,
    deleted_at: null,
  }));
  e.target.reset();
  $('payDate').value = today();
});

$('billForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const client = clientById($('billClient').value);
  if (!client) return fail('Escolha um cliente.');
  const amount = Number($('billAmount').value);
  if (!(amount > 0)) return fail('O valor tem de ser maior que zero.');
  const lateFee = Number($('billLateFee').value || 0);
  if (!(lateFee >= 0)) return fail('A multa de atraso não pode ser negativa.');

  commit(() => state.engine.write('bills', {
    id: uuid(),
    org_id: state.orgId,
    client_id: client.id,
    ref: client.ref,
    name: client.name,
    period: $('billPeriod').value.trim(),
    issue: $('issueDate').value || null,
    due: $('dueDate').value || null,
    amount,
    late_fee: lateFee,
    cut: $('billCut').value === 'true',
    origin: $('origin').value,
    status: $('billStatus').value,
    notes: $('billNotes').value.trim(),
    deleted_at: null,
  }));
  e.target.reset();
});

// Delegação: os botões das tabelas são recriados a cada render.
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;

  if (t.dataset.editClient) {
    const c = clientById(t.dataset.editClient);
    if (!c) return;
    $('clientId').value = c.id;
    for (const k of ['ref', 'name', 'contact', 'whatsapp', 'iban', 'year']) $(k).value = c[k] ?? '';
    switchTab('clientes');
    window.scrollTo(0, 0);
    return;
  }

  if (t.dataset.delClient) {
    if (!confirm('Apagar este cliente? Os pagamentos e cobranças existentes são mantidos.')) return;
    await commit(() => state.engine.write('clients', { id: t.dataset.delClient, deleted_at: new Date().toISOString() }));
    return;
  }

  if (t.dataset.pay) {
    const p = state.payments.find((x) => x.id === t.dataset.pay);
    if (!p) return;
    const who = prompt('Nome de quem valida este pagamento:');
    if (who === null) return;
    await commit(() => state.engine.write('payments', {
      id: p.id,
      status: t.dataset.status,
      validated_by: who.trim(),
      validated_at: new Date().toISOString(),
    }));
    return;
  }

  if (t.dataset.billCycle) {
    const b = state.bills.find((x) => x.id === t.dataset.billCycle);
    if (!b) return;
    const states = ['Em aberto', 'Parcial', 'Liquidada', 'Anulada'];
    const next = states[(states.indexOf(b.status) + 1) % states.length];
    await commit(() => state.engine.write('bills', { id: b.id, status: next }));
    return;
  }

  if (t.dataset.billDel) {
    if (!confirm('Apagar esta cobrança?')) return;
    await commit(() => state.engine.write('bills', { id: t.dataset.billDel, deleted_at: new Date().toISOString() }));
  }
});

// ── sincronização ────────────────────────────────────────────────────────────

function setSync(stateName, text) {
  $('syncPill').dataset.state = stateName;
  $('syncText').textContent = text;
}

async function doSync() {
  if (!state.engine || state.syncing) return;
  state.syncing = true;
  setSync('syncing', 'A sincronizar…');
  $('syncBtn').disabled = true;
  $('syncBtn2').disabled = true;

  try {
    if (!navigator.onLine) {
      setSync('offline', `${state.pending} por enviar (offline)`);
      showNotice('', null);
      return;
    }
    const res = await state.engine.sync();
    state.lastSync = Date.now();

    const { push, pull } = res;
    if (push.error) {
      setSync('error', 'Falha de sincronização');
      showNotice('err', `Sincronização falhou: ${push.error}. As alterações continuam guardadas neste dispositivo e serão reenviadas.`);
    } else {
      setSync('ok', push.remaining ? `${push.remaining} por enviar` : 'Sincronizado');
      showNotice('', null);
      if (push.conflicts > 0) {
        showNotice('ok', `${push.conflicts} conflito(s) resolvido(s) pelo servidor. Revise no painel.`);
      }
      void pull;
    }
  } catch (err) {
    setSync('error', 'Erro de sincronização');
    showNotice('err', `Sincronização falhou: ${err.message || err}. Os dados ficam neste dispositivo até voltar a tentar.`);
  } finally {
    state.syncing = false;
    $('syncBtn').disabled = false;
    $('syncBtn2').disabled = false;
    await refresh();
    if (state.pending === 0 && navigator.onLine && $('syncPill').dataset.state === 'syncing') {
      setSync('ok', 'Sincronizado');
    }
  }
}

$('syncBtn').addEventListener('click', doSync);
$('syncBtn2').addEventListener('click', doSync);
window.addEventListener('online', () => {
  $('offlineBar').hidden = true;
  doSync();
});
window.addEventListener('offline', () => {
  $('offlineBar').hidden = false;
  setSync('offline', 'Sem ligação');
});
setInterval(() => {
  if (document.visibilityState === 'visible' && state.engine) doSync();
}, 90_000);

// ── separadores ──────────────────────────────────────────────────────────────

function switchTab(name) {
  // Ninguém chega ao painel de equipa sem papel de administrador.
  if (name === 'equipa' && state.role !== 'admin') name = 'painel';
  for (const b of document.querySelectorAll('[data-tab]')) {
    b.classList.toggle('active', b.dataset.tab === name);
  }
  for (const s of document.querySelectorAll('.tab')) {
    s.classList.toggle('hidden', s.id !== name);
  }
  if (name === 'equipa') loadAccounts();
  render();
}
document.querySelectorAll('[data-tab]').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

for (const id of ['clientSearch', 'paySearch', 'payFilter']) {
  $(id).addEventListener('input', render);
}

// ── exportação / importação ──────────────────────────────────────────────────

function download(name, data, type) {
  const a = document.createElement('a');
  const u = URL.createObjectURL(new Blob([data], { type }));
  a.href = u;
  a.download = name;
  a.click();
  URL.revokeObjectURL(u);
}

$('backup').addEventListener('click', () => {
  download(
    'ende-control-backup.json',
    JSON.stringify(
      { exportedAt: new Date().toISOString(), clients: live(state.clients), payments: state.payments, bills: state.bills },
      null,
      2,
    ),
    'application/json',
  );
});

$('restore').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.clients) || !Array.isArray(data.payments) || !Array.isArray(data.bills)) throw new Error('estrutura');
    if (!confirm('Importar a cópia? Registos locais iguais são substituídos pelos da cópia; nada é apagado.')) return;

    let n = 0;
    for (const [table, rows] of TABLES.map((t) => [t, data[t] ?? []])) {
      for (const row of rows) {
        if (!row?.id) continue;
        await state.engine.write(table, { ...row, org_id: row.org_id ?? state.orgId });
        n++;
      }
    }
    await refresh();
    showNotice('ok', `Cópia importada: ${n} registo(s).`);
    doSync();
  } catch {
    fail('Ficheiro de cópia inválido.');
  }
});

$('exportCsv').addEventListener('click', () => {
  const rows = [
    ['referencia', 'nome', 'contacto', 'whatsapp', 'iban', 'ano'],
    ...live(state.clients).map((c) => [c.ref, c.name, c.contact, c.whatsapp, c.iban, c.year]),
  ];
  const csv = rows
    .map((r) => r.map((v) => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(';'))
    .join('\n');
  download('clientes_ende.csv', '﻿' + csv, 'text/csv;charset=utf-8');
});

$('importCsv').addEventListener('click', async () => {
  const file = $('csvFile').files[0];
  if (!file) return fail('Escolha um CSV.');
  const lines = (await file.text()).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const delim = lines[0].includes(';') ? ';' : ',';

  const parse = (s) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' && s[i + 1] === '"' && quoted) { cur += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === delim && !quoted) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };

  const heads = parse(lines.shift()).map((x) => x.trim().toLowerCase());
  let count = 0;
  let dups = 0;

  for (const line of lines) {
    const cells = parse(line);
    const o = {};
    heads.forEach((h, i) => { o[h] = cells[i] || ''; });
    const ref = o.referencia || o.ref || o.linha;
    const nome = o.nome || o.nome_do_cliente;
    if (!ref || !nome) continue;
    if (live(state.clients).some((c) => c.ref === ref)) { dups++; continue; }
    await state.engine.write('clients', {
      id: uuid(),
      org_id: state.orgId,
      ref,
      name: nome,
      contact: o.contacto || o.contato || '',
      whatsapp: o.whatsapp || '',
      iban: o.iban || '',
      year: Number(o.ano) || new Date().getFullYear(),
      deleted_at: null,
    });
    count++;
  }

  await refresh();
  $('importResult').textContent = `Importados: ${count}. Referências duplicadas ignoradas: ${dups}.`;
  doSync();
});

// ── arranque ─────────────────────────────────────────────────────────────────

$('payDate').value = today();
$('year').value = String(new Date().getFullYear());
document.querySelector('header .sub').textContent =
  `Gestão interna de clientes, cobranças e pagamentos · v${APP_VERSION}`;

if (!navigator.onLine) {
  $('offlineBar').hidden = false;
  setSync('offline', 'Sem ligação');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* a app funciona sem SW; só perde o arranque offline */
  });
}

if (auth.getSession()) enterApp();
else showLogin();
