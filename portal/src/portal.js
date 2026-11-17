// Portal do cliente — apenas leitura.
//
// Mesmos módulos do painel (config e auth do Supabase), sessão própria
// (`ende.portal.session`) para não apagar a sessão do administrador quando
// alguém abre os dois no mesmo navegador.
//
// O RLS é quem limita as linhas: as políticas `*_read_own` da migração 0002
// só devolvem as linhas do cliente ligado ao perfil. Aqui pedimos sempre
// `client_id=eq.<o-meu>` como dupla salvaguarda e nunca escrevemos nada.

import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME } from '../../app/src/config.js';
import { createAuth } from '../../app/src/auth.js';
import { buildView, mapCSV } from './portal-data.js';

const $ = (id) => document.getElementById(id);

const auth = createAuth({
  url: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  storageKey: 'ende.portal.session',
});

let myClientId = null;
let clientLabel = '';
let lastView = null; // vista actual, para o CSV do mapa de conta

function showError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.classList.remove('hidden');
}

function hideError(id) {
  $(id).classList.add('hidden');
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('pt-PT', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

async function api(path) {
  const token = await auth.getFreshAccessToken();
  if (!token) throw new Error('Sessão expirada: entre novamente.');
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Falha ao ler os dados (HTTP ${res.status}).`);
  return res.json();
}

/** Lê o perfil e exige papel `cliente` com ficha ligada. */
async function loadProfile() {
  const user = auth.getUser();
  if (!user) return null;

  const rows = await api(`/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=role,client_id,full_name&limit=1`);
  if (!rows.length) throw new Error('A sua conta não está associada a nenhuma organização.');

  const profile = rows[0];
  if (profile.role !== 'cliente' || !profile.client_id) {
    await auth.signOut();
    throw new Error('Esta conta não tem acesso ao portal do cliente. Use o painel de gestão.');
  }
  myClientId = profile.client_id;

  const clients = await api(`/rest/v1/clients?id=eq.${encodeURIComponent(myClientId)}&select=ref,name&limit=1`);
  clientLabel = clients.length ? `${clients[0].ref} — ${clients[0].name}` : APP_NAME;
  return profile;
}

async function loadData() {
  if (!myClientId) await loadProfile();
  const cid = encodeURIComponent(myClientId);
  const [bills, payments] = await Promise.all([
    api(`/rest/v1/bills?client_id=eq.${cid}&select=period,status,amount,late_fee,cut,due,deleted_at&order=period.asc&limit=500`),
    api(`/rest/v1/payments?client_id=eq.${cid}&select=period,date,amount,status,receipt,deleted_at&order=date.asc&limit=500`),
  ]);
  return buildView({ bills, payments });
}

function render(view) {
  lastView = view;
  const s = view.summary;
  $('mPaid').textContent = String(s.paidCount);
  $('mPending').textContent = String(s.pendingCount);
  $('mPendingTotal').textContent = money(s.pendingTotal);
  $('mFee').textContent = money(s.lateFee);
  $('mFeeBox').classList.toggle('alert', s.lateFee > 0);
  $('mCut').textContent = s.cut ? 'Sim — contacte a ENDE' : 'Não';
  $('mCutBox').classList.toggle('alert', s.cut);

  // Pagos: um bloco por ano, do ano mais recente para o mais antigo.
  const paid = $('paidYears');
  if (!view.years.length) {
    paid.innerHTML = '<p class="muted">Sem meses pagos registados.</p>';
  } else {
    paid.innerHTML = view.years.map((group) => `
      <div class="yearhead">
        <h4>${esc(group.year)}</h4>
        <span class="muted">${group.months.length} mês(es) · ${money(group.total)} Kz</span>
      </div>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Período</th><th>Valor (Kz)</th><th>Estado</th></tr></thead>
          <tbody>
            ${group.months.map((m) => `
              <tr>
                <td>${esc(m.period)}</td>
                <td>${money(m.amount)}</td>
                <td><span class="pill Pago">Pago</span>${m.advance ? ' <span class="pill Adiantamento">Adiantamento</span>' : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`).join('');
  }

  // Pendentes: com vencimento, multa e corte à vista.
  const pending = $('pendingBox');
  if (!view.pending.length) {
    pending.innerHTML = '<p class="muted">Nada pendente — está tudo em dia.</p>';
  } else {
    pending.innerHTML = `
      <div class="tablewrap">
        <table>
          <thead><tr><th>Período</th><th>Vencimento</th><th>Valor (Kz)</th><th>Multa (Kz)</th><th>Corte</th></tr></thead>
          <tbody>
            ${view.pending.map((m) => `
              <tr>
                <td>${esc(m.period)}</td>
                <td>${esc(m.due || '—')}</td>
                <td>${money(m.amount)}</td>
                <td>${m.lateFee > 0 ? `<span class="pill multa">${money(m.lateFee)}</span>` : '—'}</td>
                <td>${m.cut ? '<span class="pill corte">Corte aplicado</span>' : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
}

async function refresh() {
  hideError('portalError');
  $('refreshBtn').disabled = true;
  try {
    render(await loadData());
  } catch (err) {
    showError('portalError', err.message);
  } finally {
    $('refreshBtn').disabled = false;
  }
}

function showPortal() {
  $('loginView').hidden = true;
  $('portalView').hidden = false;
  $('clientSub').textContent = clientLabel;
  refresh();
}

function showLogin(message = '') {
  $('portalView').hidden = true;
  $('loginView').hidden = false;
  if (message) showError('loginError', message);
  else hideError('loginError');
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  hideError('loginError');
  try {
    await auth.signIn({
      email: $('loginEmail').value.trim(),
      password: $('loginPassword').value,
    });
    await loadProfile();
    $('loginForm').reset();
    showPortal();
  } catch (err) {
    const msg =
      err?.status === 400 || err?.status === 401
        ? 'E-mail ou palavra-passe incorrectos.'
        : err.message;
    showLogin(msg);
    await auth.signOut();
  } finally {
    btn.disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await auth.signOut();
  myClientId = null;
  clientLabel = '';
  showLogin();
});

$('refreshBtn').addEventListener('click', refresh);

$('csvBtn').addEventListener('click', () => {
  if (!lastView) return;
  const a = document.createElement('a');
  const u = URL.createObjectURL(new Blob([mapCSV(lastView)], { type: 'text/csv;charset=utf-8' }));
  a.href = u;
  a.download = 'ende-mapa-de-conta.csv';
  a.click();
  URL.revokeObjectURL(u);
});

$('printBtn').addEventListener('click', () => window.print());

// Sessão guardada? Entra directamente; sem perfil válido, volta ao login.
(async () => {
  if (!auth.getSession()) {
    showLogin();
    return;
  }
  try {
    await loadProfile();
    showPortal();
  } catch (err) {
    showLogin(err.message);
  }
})();
