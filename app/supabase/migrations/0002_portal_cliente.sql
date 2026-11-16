-- ENDE CONTROL — portal do cliente (0002)
--
-- O administrador emite uma conta com papel 'cliente' vinculada a uma ficha
-- de `clients`. Essa conta entra num portal separado (/portal/) e só vê as
-- linhas DAQUELE cliente: pagos, pendentes, multa de atraso e corte.
--
-- Regras novas:
--   * role 'cliente' exige client_id; os restantes papéis não podem tê-lo.
--   * O papel 'cliente' é só de leitura: as políticas de INSERT/UPDATE passam
--     a excluí-lo (o RLS é permissivo — sem isto ele veria a organização toda).
--   * `bills.late_fee` e `bills.cut` são registados pelo administrador e
--     mostrados no portal como estado da cobrança.

begin;

-- ───────────────────────────────────────────────────── papel e ligação

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin', 'operador', 'cliente'));

alter table public.profiles
  add column client_id uuid references public.clients (id) on delete set null;

-- Só o papel 'cliente' pode ter ficha ligada, e tem de ter.
alter table public.profiles
  add constraint profiles_cliente_ligado
    check (client_id is null or role = 'cliente'),
  add constraint profiles_cliente_sem_ficha
    check (role <> 'cliente' or client_id is not null);

create index profiles_org_role on public.profiles (org_id, role);

-- ───────────────────────────────────────────────────── multa e corte

alter table public.bills
  add column late_fee numeric(14, 2) not null default 0
    check (late_fee >= 0),
  add column cut boolean not null default false;

-- ───────────────────────────────────────────────────── helpers de RLS

create or replace function public.is_client()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select role = 'cliente' from public.profiles where id = auth.uid()),
    false
  )
$fn$;

create or replace function public.current_client_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select client_id from public.profiles
  where id = auth.uid() and role = 'cliente'
$fn$;

-- ───────────────────────────────────────────────────── RLS: leitura do portal
-- O cliente vê a SISSO. Os papéis de trabalho continuam a ver a organização.

drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients
  for select to authenticated
  using (org_id = public.current_org_id() and not public.is_client());
create policy clients_read_own on public.clients
  for select to authenticated
  using (public.is_client()
         and id = public.current_client_id()
         and deleted_at is null);

drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments
  for select to authenticated
  using (org_id = public.current_org_id() and not public.is_client());
create policy payments_read_own on public.payments
  for select to authenticated
  using (public.is_client()
         and client_id = public.current_client_id()
         and deleted_at is null);

drop policy if exists bills_read on public.bills;
create policy bills_read on public.bills
  for select to authenticated
  using (org_id = public.current_org_id() and not public.is_client());
create policy bills_read_own on public.bills
  for select to authenticated
  using (public.is_client()
         and client_id = public.current_client_id()
         and deleted_at is null);

-- ───────────────────────────────────────────────────── RLS: escrita
-- O portal não escreve nada. Sem isto, o RLS permissivo deixaria o 'cliente'
-- inserir e actualizar linhas da organização inteira.

drop policy if exists clients_insert on public.clients;
create policy clients_insert on public.clients
  for insert to authenticated
  with check (org_id = public.current_org_id() and not public.is_client());

drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients
  for update to authenticated
  using (org_id = public.current_org_id() and not public.is_client())
  with check (org_id = public.current_org_id() and not public.is_client());

drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments
  for insert to authenticated
  with check (org_id = public.current_org_id() and not public.is_client());

drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments
  for update to authenticated
  using (org_id = public.current_org_id() and not public.is_client())
  with check (org_id = public.current_org_id() and not public.is_client());

drop policy if exists bills_insert on public.bills;
create policy bills_insert on public.bills
  for insert to authenticated
  with check (org_id = public.current_org_id() and not public.is_client());

drop policy if exists bills_update on public.bills;
create policy bills_update on public.bills
  for update to authenticated
  using (org_id = public.current_org_id() and not public.is_client())
  with check (org_id = public.current_org_id() and not public.is_client());

-- Perfil: o cliente lê o SEU. Ninguém, fora admin, actualiza perfis.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid()
         or (org_id = public.current_org_id() and not public.is_client()));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using ((id = auth.uid() and not public.is_client()) or public.is_admin())
  with check ((id = auth.uid() and not public.is_client())
              or (public.is_admin() and org_id = public.current_org_id()));

commit;
