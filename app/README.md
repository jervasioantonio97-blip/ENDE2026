# ENDE CONTROL — base de dados, sincronização e PWA

Aplicação offline-first de gestão interna: clientes, pagamentos e cobranças.
Esquema Supabase, armazenamento local, motor de sincronização e interface PWA.

## O que está feito

| Ficheiro | Função |
|---|---|
| `supabase/migrations/0001_init.sql` | Tabelas, índices, triggers, RLS e permissões |
| `supabase/migrations/0002_portal_cliente.sql` | Papel `cliente`, `client_id`, multa/corte, RLS de leitura própria |
| `index.html` + `src/app.js` | Interface da PWA (separadores, formulários, sync) |
| `src/report.js` | Relatórios puros: âmbitos, períodos, adiantamentos, CSV |
| `src/charts.js` | Gráfico SVG do balanço (barras duplas + linha), sem CDN |
| `src/remote-supabase.js` | Adaptador `remote` contra o PostgREST |
| `src/auth.js` | Sessão GoTrue: entrar, renovar token, sair (chave de sessão configurável) |
| `src/admin-users.js` | Cliente da Edge Function `admin-users` (painel de equipa) |
| `supabase/functions/admin-users/index.ts` | Emite credenciais: criar, listar, repor, revogar |
| `src/config.js` | URL e chave publishable (públicas por desenho) |
| `src/core/sync-engine.js` | Push/pull, resolução de conflitos, cursor |
| `src/core/idb-store.js` | Armazenamento local em IndexedDB |
| `src/core/ids.js` | UUID com fallback para WebView sem contexto seguro |
| `sw.js` + `manifest.webmanifest` | Arranque offline e instalação como app |
| `scripts/seed.mjs` | Cria organização + perfil do primeiro admin |
| `scripts/make-icons.mjs` | Gera os PNG do manifest (sem dependências) |
| `tests/sync-engine.test.mjs` | 11 testes de comportamento do motor |
| `tests/remote-supabase.test.mjs` | 19 testes do adaptador remoto |
| `tests/admin-users.test.mjs` | 15 testes do cliente do painel de equipa |
| `tests/portal.test.mjs` | 19 testes do modelo de dados do portal do cliente |
| `tests/report.test.mjs` | 12 testes dos âmbitos, períodos e CSV de relatórios |
| `tests/charts.test.mjs` | 6 testes do gráfico SVG de balanço |

No repositório, ao lado de `app/`:

| Ficheiro | Função |
|---|---|
| `index.html` (raiz) | Router `?portal=admin\|cliente` + ecrã de escolha |
| `portal/index.html` + `portal/src/portal.js` | Portal do cliente (login, resumo, pagos, pendentes) |
| `portal/src/portal-data.js` | Modelo puro: `buildView`, `yearOf`, `monthOf` |

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
supabase migration list   # local 0001+0002 = remoto 0001+0002
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

## Painel de equipa (emitir credenciais)

O separador **Equipa** (visível só a `admin`) cria, lista, repõe e revoga
contas de funcionários — sem sair da aplicação.

- Botão "Gerar credenciais" → cria o utilizador no GoTrue, escreve o
  `profiles` com o `org_id` **do administrador que faz o pedido** e devolve
  uma palavra-passe gerada no servidor (16 caracteres, sem 0/O nem 1/l/I).
  A senha aparece uma única vez, com botão de copiar.
- "Repor palavra-passe" → gera outra; a anterior deixa de valer.
- "Revogar" → apaga o utilizador; `profiles` desaparece por cascade.
  Ninguém se revoga a si próprio.

A `service_role` vive **só** na Edge Function `admin-users`. O navegador envia
apenas o JWT da sessão; a função valida o papel do pedido em `profiles` antes
de qualquer operação. Papéis aceites: `admin`, `operador` e `cliente` (o mesmo
CHECK do esquema). Para `cliente` é obrigatório um `client_id` que pertença à
mesma organização — a função responde `404` se a ficha não for da org do
administrador.

```pwsh
supabase functions deploy admin-users --use-api   # sem Docker
```

O operador vê os separadores de trabalho mas **não** valida pagamentos (os
botões Confirmar/Rejeitar não são renderizados) e não chega ao separador
Equipa — a navegar para lá, cai no Painel.

## Portal do cliente e router de portais

O `index.html` da raiz do repositório funciona como router de dois portais:

| URL | Destino |
|---|---|
| `/?portal=admin` | `./app/` — painel de gestão |
| `/?portal=cliente` | `./portal/` — portal do cliente |
| `/` (sem parâmetro) | Ecrã de escolha com os dois links |

O valor vazio ou inválido mostra o ecrã de escolha; os caminhos são relativos,
por isso funcionam igual no GitHub Pages e no Vercel.

### O que o cliente vê

O portal (`/portal/`) é **só de leitura** — não tem botões de escrita:

- **Resumo**: meses pagos, meses pendentes, valor pendente, multa de atraso e
  corte.
- **Meses pagos**, agrupados por ano, com o valor de cada período.
- **Meses pendentes**, com vencimento, valor, multa de atraso e indicação de
  corte.

A fonte de dados é `bills` + `payments` confirmados, agrupados pelas funções
puras de `portal/src/portal-data.js`. O acesso é limitado pelas políticas
`*_read_own`: cada cliente só recebe as linhas do próprio `client_id` (ver
migração `0002`).

### Regras de papel

- Conta `cliente` criada no painel → é **reenviada** para o portal quando tenta
  entrar no painel.
- Conta `admin`/`operador` a entrar no portal → é **recusada** com aviso para
  usar o painel de gestão.
- O portal usa a própria chave de sessão (`ende.portal.session`), por isso não
  colide com a sessão do painel (`ende.session`) no mesmo navegador.

### Migração 0002 (portal do cliente)

- `profiles.client_id` — liga a conta à ficha do cliente (nullable, só preenchido
  no papel `cliente`).
- CHECK de `role` alargado a `admin|operador|cliente`.
- `bills.late_fee` (multa de atraso) e `bills.cut` (corte aplicado).
- Helpers `is_client()` / `current_client_id()` e políticas `*_read_own`;
  as políticas de escrita **excluem** o papel `cliente`.

## Relatórios, balanço e adiantamentos

O separador **Relatórios** (`src/report.js`, funções puras) cobre:

- **Âmbito**: *Todo o período* (omissão), *Ano inteiro* ou um mês exacto
  escolhido num **calendário** de 12 meses com navegação de anos.
- **Saída**: tabela no ecrã, **CSV** (`;`, aspas dobradas, BOM — abre no
  Excel) e **Imprimir/PDF** via `@media print` (só o conteúdo, sem chrome).
- 6 tipos de relatório: resumo, pagamentos, cobranças, clientes, métodos e
  balanço mensal.
- **Períodos**: aceita `MM/AAAA` e o dado legado de 2 dígitos (`12/26` → 2026);
  texto livre (ex. `16 de Novembro de 2026`) cai para a data do registo
  (`date`/`issue`/`due`) para não perder linhas.
- **Adiantamento** é derivado, sem coluna nova: um pagamento conta como
  adiantamento quando o seu período é posterior ao mês corrente.

O **gráfico de balanço** (`src/charts.js`) é SVG desenhado à mão (sem CDN,
offline-first): barras duplas por mês — ganhos (recebido, turquesa) e perdas
(cobrado, âmbar) — com a linha branca do balanço e estado vazio legível.

## Validação de pagamentos (modal)

Confirmar/Rejeitar abre um **modal** (substituiu o `prompt()` antigo, que
falhava em browsers com diálogo bloqueado):

1. Resumo do pagamento + campo «quem valida» (pré-preenchido com o e-mail).
2. Nome vazio → erro inline, o modal **não** fecha nem escreve.
3. **Cancelar** (ou clique fora / Esc) → fecha sem escrita.
4. **Confirmar**/**Rejeitar** → escreve `status`, `validated_by`,
   `validated_at` e faz sync. Operador não vê os botões (RLS + render).

Os formulários de pagamento e cobrança validam o campo **período** com
`pattern="MM/AAAA"`.

## Portal do cliente — mapa de conta

- **Descarregar CSV** (`ende-mapa-de-conta.csv`): uma linha por período —
  pagos primeiro, depois pendentes — com valor, vencimento, multa, corte,
  data, comprovativo e tipo (Adiantamento/Normal).
- **Imprimir/PDF**: o mesmo conteúdo em papel, sem o resto do portal.
- Pill **Adiantamento** nos meses pagos com período futuro.

## Tema e interface

- **Glass 3D verde turquesa** nos 3 sites (painel, portal, landing):
  orbs + grão, `backdrop-filter`, Space Grotesk + Inter, `color-scheme:dark`,
  tilt 3D só no login e `prefers-reduced-motion` respeitado.
- Contraste **WCAG AA** verificado ao vivo: botão primário turquesa
  (`#2dd4bf→#14b8a6`) com texto escuro `#04211f` (9,08…6,79:1); estados
  good/warn/danger com texto branco ≥ 4,5:1; acento `#5eead4` 11,5:1.
- **Som de clique removido** dos 3 sites (o `ENDE_CONTROL.html` legado
  não foi tocado).

## Como o conflito é resolvido

1. Pagamento já validado no servidor → **servidor vence**, sempre.
2. Caso contrário, vence a alteração mais recente (`updatedAt`).
3. Tolerância de 2 minutos: se o dispositivo está atrasado, o servidor vence.
4. Toda a decisão fica registada em `conflicts` para revisão no painel.

Limitação conhecida: a comparação usa o relógio do dispositivo. Se dois
telefones tiverem horas muito diferentes, a regra 3 absorve desvios até 2
minutos. Para auditoria formal seria necessário um relógio lógico (HLC).

## Publicação

- **GitHub Pages** (principal): `https://jervasioantonio97-blip.github.io/ENDE2026/`
  — o `main` dá push e o Pages publica. Links de acesso:
  - Escolha: `https://jervasioantonio97-blip.github.io/ENDE2026/`
  - Admin: `.../ENDE2026/?portal=admin`
  - Cliente: `.../ENDE2026/?portal=cliente`
- **Vercel** (alternativa, ligado ao GitHub): `https://ende-control-7xxat6pia-jerva.vercel.app/`
  — recebe o deploy de `main`, mas a *Deployment Protection* (Vercel
  Authentication) está activa: desactivar em
  `vercel.com → projecto → Settings → Deployment Protection → Disabled`.

A `service_role` e o token de acesso nunca vão para o cliente: as credenciais
do navegador são a chave publishable e o JWT da sessão. Os acessos de
demonstração estão em `contas-de-acesso.local.txt` (gitignored).

## Próximo passo

1. Capacitor para gerar o APK Android a partir desta mesma casca.
2. Convidar os restantes funcionários pelo separador **Equipa** (só é preciso
   estar logado como `admin`). Enquanto não existir linha em `profiles`, o RLS
   devolve zero linhas.
