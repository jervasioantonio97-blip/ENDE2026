# ENDE CONTROL — base de dados e sincronização

Primeira camada do projeto: esquema Supabase, armazenamento local e motor de
sincronização offline-first. A interface (PWA) vem depois, por cima disto.

## O que está feito

| Ficheiro | Função |
|---|---|
| `supabase/migrations/0001_init.sql` | Tabelas, índices, triggers, RLS e permissões |
| `src/core/sync-engine.js` | Push/pull, resolução de conflitos, cursor |
| `src/core/idb-store.js` | Armazenamento local em IndexedDB |
| `src/core/ids.js` | UUID com fallback para WebView sem contexto seguro |
| `tests/sync-engine.test.mjs` | 11 testes de comportamento |

O motor não conhece Supabase nem IndexedDB. Recebe dois adaptadores, por isso
corre igual no telemóvel, no PC e nos testes.

## Correr os testes

```pwsh
cd app
npm test
```

Sem dependências, sem instalação.

## Aplicar o esquema ao Supabase

O projeto `tbjqqpcyzlhuznbtgwqh` está actualmente **inacessível** (a base de
dados não responde — sinal típico de projeto pausado no plano gratuito).
Antes de qualquer coisa:

1. Abrir o dashboard Supabase → projeto → **Restore project** (se estiver pausado).
2. Confirmar que responde: `select 1;` no SQL Editor.
3. Depois, uma destas:

```pwsh
# via CLI (requer login: supabase login)
supabase link --project-ref tbjqqpcyzlhuznbtgwqh
supabase db push
```

ou colar `supabase/migrations/0001_init.sql` no SQL Editor.

> O CLI local (`supabase start`) precisa de Docker. Este computador não tem
> Docker instalado, por isso o desenvolvimento é contra o projeto remoto.

## Criar a primeira organização e o primeiro administrador

Depois de criar um utilizador em Authentication → Users:

```sql
insert into public.orgs (name) values ('ENDE') returning id;
-- copiar o id devolvido para o placeholders abaixo

insert into public.profiles (id, org_id, full_name, role)
values ('<uuid-do-utilizador>', '<uuid-da-org>', 'Administrador', 'admin');
```

Sem linha em `profiles`, o utilizador autenticado não vê nada: todas as
políticas dependem de `current_org_id()`.

## Regras que o esquema garante

- **Isolamento por organização** — RLS em todas as tabelas. Sem `org_id` na
  sessão, zero linhas.
- **Nada é apagado** — não existe política de `DELETE`; apagar é preencher
  `deleted_at`.
- **Pagamento validado é imutável** — operador não altera nem apaga; confirmar
  ou rejeitar exige `role = 'admin'`.
- **Referência de cliente única** só entre clientes vivos (`deleted_at is null`).
- **`rev`** detecta escrita concorrente; **`seq`** é o cursor de sincronização.

## Como o conflito é resolvido

1. Pagamento já validado no servidor → **servidor vence**, sempre.
2. Caso contrário, vence a alteração mais recente (`updatedAt`).
3. Tolerância de 2 minutos: se o dispositivo está atrasado, o servidor vence.
4. Toda a decisão fica registada em `conflicts` para revisão no painel.

Limitação conhecida: a comparação usa o relógio do dispositivo. Se dois
telefones tiverem horas muito diferentes, a regra 3 absorve desvios até 2
minutos. Para auditoria formal seria necessário um relógio lógico (HLC).

## Próximo passo

1. `src/remote-supabase.js` — adaptador real (`insert`/`update`/`pull`) quando a
   base de dados responder. Fica incompleto de propósito: nada para testar
   enquanto o projeto está pausado.
2. Casca PWA: `index.html` + `manifest.webmanifest` + Service Worker, com os
   separadores Clientes / Pagamentos / Cobranças e o indicador de sync.
3. Depois, Capacitor para gerar o APK Android.
