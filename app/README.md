# ENDE CONTROL — base de dados, sincronização e PWA

Aplicação offline-first de gestão interna: clientes, pagamentos e cobranças.
Esquema Supabase, armazenamento local, motor de sincronização e interface PWA.

## O que está feito

| Ficheiro | Função |
|---|---|
| `supabase/migrations/0001_init.sql` | Tabelas, índices, triggers, RLS e permissões |
| `index.html` + `src/app.js` | Interface da PWA (separadores, formulários, sync) |
| `src/remote-supabase.js` | Adaptador `remote` contra o PostgREST |
| `src/auth.js` | Sessão GoTrue: entrar, renovar token, sair |
| `src/config.js` | URL e chave publishable (públicas por desenho) |
| `src/core/sync-engine.js` | Push/pull, resolução de conflitos, cursor |
| `src/core/idb-store.js` | Armazenamento local em IndexedDB |
| `src/core/ids.js` | UUID com fallback para WebView sem contexto seguro |
| `sw.js` + `manifest.webmanifest` | Arranque offline e instalação como app |
| `scripts/seed.mjs` | Cria organização + perfil do primeiro admin |
| `scripts/make-icons.mjs` | Gera os PNG do manifest (sem dependências) |
| `tests/sync-engine.test.mjs` | 11 testes de comportamento do motor |
| `tests/remote-supabase.test.mjs` | 19 testes do adaptador remoto |

O motor não conhece Supabase nem IndexedDB. Recebe dois adaptadores, por isso
corre igual no telemóvel, no PC e nos testes.

## Correr a aplicação

A interface está em `index.html` e é estática: não há build nem dependências.

```pwsh
cd app
python -m http.server 8080   # ou qualquer servidor estático
# http://localhost:8080/
```

Em produção é servida por GitHub Pages em `./app/`.

## Testes

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

O caminho curto é o script (chave de serviço só por ambiente, nunca no
repositório):

```pwsh
$env:SUPABASE_URL = 'https://mpxlxrscmajgbreldrnd.supabase.co'
$env:SUPABASE_SERVICE_ROLE_KEY = '<service_role>'
$env:SEED_USER_EMAIL = 'admin@exemplo.com'
$env:SEED_USER_PASSWORD = '<palavra-passe>'   # só se ainda não existir
node scripts/seed.mjs
```

O script cria a organização, cria/valida o utilizador e garante o perfil
`admin`. Equivalente manual, depois de criar o utilizador em Authentication →
Users:

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

1. Capacitor para gerar o APK Android a partir desta mesma casca.
2. Convidar os restantes funcionários: criar utilizador em Authentication →
   Users e, depois, o correspondente `profiles` (papel `operador`) — ver
   secção acima. Enquanto não existir essa linha, o RLS devolve zero linhas.
