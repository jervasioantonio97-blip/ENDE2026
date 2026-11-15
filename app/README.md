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

## Esquema aplicado ao Supabase

O esquema está **aplicado** no projeto `mpxlxrscmajgbreldrnd`
(“GESTÃO DE COBRANÇAS ENDE”, região `eu-west-1`):

```pwsh
supabase link --project-ref mpxlxrscmajgbreldrnd
supabase db push          # aplica supabase/migrations/*.sql
supabase migration list   # local 0001 = remoto 0001
```

Verificação: `GET https://mpxlxrscmajgbreldrnd.supabase.co/rest/v1/clients`
devolve `200 []` — a tabela existe e o RLS devolve zero linhas ao anon.

Credenciais do cliente em `.env` (copiar de `.env.example`).

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

1. `src/remote-supabase.js` — adaptador real (`insert`/`update`/`pull`). O
   esquema já está aplicado, por isso já há tabela para testar contra.
2. Casca PWA: `index.html` + `manifest.webmanifest` + Service Worker, com os
   separadores Clientes / Pagamentos / Cobranças e o indicador de sync.
3. Depois, Capacitor para gerar o APK Android.
