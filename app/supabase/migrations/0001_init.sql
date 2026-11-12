-- ENDE CONTROL — esquema inicial (offline-first)
--
-- Aplicar com:  supabase db push
-- ou colar no SQL Editor do projeto Supabase.
--
-- Regras de desenho:
--   * Nenhum DELETE físico. Apagar = preencher deleted_at.
--   * seq é uma sequência global monotónica: serve de cursor de sincronização.
--   * rev incrementa a cada escrita no servidor: serve de detecção de conflito.
--   * RLS isola tudo por org_id (multi-empresa, multi-dispositivo).

begin;

create extension if not exists pgcrypto;
create sequence if not exists public.sync_seq;

-- ───────────────────────────────────────────────────── organizações e perfis

create table public.orgs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  org_id     uuid not null references public.orgs (id) on delete restrict,
  full_name  text not null default '',
  role       text not null default 'operador' check (role in ('admin', 'operador')),
  created_at timestamptz not null default now()
);

-- ───────────────────────────────────────────────────── helpers de RLS
-- security definer para não reentrar nas políticas de profiles.

create or replace function public.current_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select org_id from public.profiles where id = auth.uid()
$fn$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
    (select role = 'admin' from public.profiles where id = auth.uid()),
    false
  )
$fn$;

-- ───────────────────────────────────────────────────── clientes

create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete restrict,
  ref        text not null,
  name       text not null,
  contact    text not null default '',
  whatsapp   text not null default '',
  iban       text not null default '',
  year       int  not null default extract(year from now())::int,
  rev        int  not null default 1,
  seq        bigint not null default nextval('public.sync_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- A referência só é única entre clientes vivos: permite recriar uma referência apagada.
create unique index clients_org_ref_live
  on public.clients (org_id, ref)
  where deleted_at is null;

create index clients_seq on public.clients (seq);

-- ───────────────────────────────────────────────────── pagamentos

create table public.payments (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs (id) on delete restrict,
  client_id    uuid not null references public.clients (id) on delete restrict,
  ref          text not null default '',   -- instantâneo da referência do cliente
  name         text not null default '',   -- instantâneo do nome do cliente
  period       text not null,              -- ex.: 11/2026
  date         date not null,
  amount       numeric(14, 2) not null check (amount > 0),
  method       text not null default 'Numerário',
  receipt      text not null default '',
  staff        text not null default '',
  notes        text not null default '',
  status       text not null default 'Pendente'
               check (status in ('Pendente', 'Confirmado', 'Rejeitado')),
  validated_by text not null default '',
  validated_at timestamptz,
  rev          int  not null default 1,
  seq          bigint not null default nextval('public.sync_seq'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

create index payments_seq        on public.payments (seq);
create index payments_org_status on public.payments (org_id, status);
create index payments_client     on public.payments (client_id);

-- ───────────────────────────────────────────────────── cobranças

create table public.bills (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.orgs (id) on delete restrict,
  client_id  uuid not null references public.clients (id) on delete restrict,
  ref        text not null default '',
  name       text not null default '',
  period     text not null,
  issue      date,
  due        date,
  amount     numeric(14, 2) not null check (amount > 0),
  origin     text not null default 'Manual',
  status     text not null default 'Em aberto'
             check (status in ('Em aberto', 'Parcial', 'Liquidada', 'Anulada')),
  notes      text not null default '',
  rev        int  not null default 1,
  seq        bigint not null default nextval('public.sync_seq'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index bills_seq    on public.bills (seq);
create index bills_client on public.bills (client_id);

-- ───────────────────────────────────────────────────── sincronização

create or replace function public.touch_sync()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  new.updated_at := now();
  new.seq        := nextval('public.sync_seq');
  if tg_op = 'UPDATE' then
    new.rev := old.rev + 1;
  else
    -- O servidor é a fonte de verdade: o cliente não impõe rev nem created_at.
    new.rev        := 1;
    new.created_at := now();
  end if;
  return new;
end
$fn$;

create trigger clients_sync  before insert or update on public.clients
  for each row execute function public.touch_sync();
create trigger payments_sync before insert or update on public.payments
  for each row execute function public.touch_sync();
create trigger bills_sync    before insert or update on public.bills
  for each row execute function public.touch_sync();

-- Pagamentos validados são imutáveis para operadores.
-- Confirmar/Rejeitar exige role admin.
create or replace function public.guard_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'Pendente' and not public.is_admin() then
      raise exception 'Apenas administradores validam pagamentos'
        using errcode = '42501';
    end if;
    if new.status <> 'Pendente' then
      new.validated_at := coalesce(new.validated_at, now());
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not public.is_admin() then
      raise exception 'Apenas administradores validam pagamentos'
        using errcode = '42501';
    end if;
    new.validated_at := now();
  elsif old.status <> 'Pendente' and not public.is_admin() then
    raise exception 'Pagamento já validado não pode ser alterado'
      using errcode = '42501';
  end if;
  return new;
end
$fn$;

create trigger payments_guard before insert or update on public.payments
  for each row execute function public.guard_payment();

-- Um não-admin não pode mudar a própria role nem de organização.
create or replace function public.guard_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not public.is_admin()
     and (new.role is distinct from old.role
          or new.org_id is distinct from old.org_id) then
    raise exception 'Sem permissão para alterar perfil ou organização'
      using errcode = '42501';
  end if;
  return new;
end
$fn$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_profile();

-- ───────────────────────────────────────────────────── RLS

alter table public.orgs     enable row level security;
alter table public.profiles enable row level security;
alter table public.clients  enable row level security;
alter table public.payments enable row level security;
alter table public.bills    enable row level security;

create policy orgs_read on public.orgs
  for select to authenticated
  using (id = public.current_org_id());

create policy profiles_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or org_id = public.current_org_id());

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid()
              or (public.is_admin() and org_id = public.current_org_id()));

create policy clients_read on public.clients
  for select to authenticated
  using (org_id = public.current_org_id());
create policy clients_insert on public.clients
  for insert to authenticated
  with check (org_id = public.current_org_id());
create policy clients_update on public.clients
  for update to authenticated
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

create policy payments_read on public.payments
  for select to authenticated
  using (org_id = public.current_org_id());
create policy payments_insert on public.payments
  for insert to authenticated
  with check (org_id = public.current_org_id());
create policy payments_update on public.payments
  for update to authenticated
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

create policy bills_read on public.bills
  for select to authenticated
  using (org_id = public.current_org_id());
create policy bills_insert on public.bills
  for insert to authenticated
  with check (org_id = public.current_org_id());
create policy bills_update on public.bills
  for update to authenticated
  using (org_id = public.current_org_id())
  with check (org_id = public.current_org_id());

-- Sem política de DELETE: RLS já nega o apagamento físico.

-- ───────────────────────────────────────────────────── permissões

grant usage on schema public to authenticated;
grant select, insert, update on public.clients, public.payments, public.bills
  to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.orgs to authenticated;
grant usage, select on sequence public.sync_seq to authenticated;

commit;
