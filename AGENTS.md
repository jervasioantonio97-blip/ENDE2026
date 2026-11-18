# ENDE2026 — contexto do projecto

PWA offline-first de gestão de cobranças (ENDE). HTML/CSS/JS **estático**:
sem build, sem bundler, sem dependências, sem CDNs (tem de funcionar offline).

## Estrutura

| Caminho | O que é |
|---|---|
| `index.html` (raiz) | Router `?portal=admin\|cliente` + ecrã de escolha |
| `app/` | Painel de gestão (admin/operador): clientes, pagamentos, cobranças, relatórios, equipa |
| `portal/` | Portal do cliente (só leitura) |
| `ENDE_CONTROL.html` | Legado — **não tocar** |
| `contas-de-acesso.local.txt` | Credenciais de demonstração — gitignored, **nunca commitar nem subir** |
| `app/.env` | Credenciais Supabase locais — gitignored e `.vercelignore`d |

Documentação completa: **`app/README.md`** — ler antes de alterar qualquer coisa
dentro de `app/` (esquema, RLS, sync, regras de papel).

## Comandos

```pwsh
cd app
npm test                      # node --test "tests/*.test.mjs" — sem instalação
```

Servir localmente (na raiz do repo, para ver os 3 sites):

```pwsh
python -m http.server 8080    # /  |  /?portal=admin  |  /?portal=cliente
```

## Regras

- **Não introduzir** build, dependências nem CDNs — o projecto é offline-first
  por desenho (gráficos SVG desenhados à mão, ícones locais, fontes carregadas
  da web mas com fallback).
- Backend Supabase (projecto `mpxlxrscmajgbreldrnd`): RLS por organização,
  nada é apagado (`deleted_at`), pagamento validado é imutável (só `admin`
  confirma/rejeita), escrita concorrente detectada por `rev`.
- A `service_role` vive **só** na Edge Function `admin-users`; no navegador
  só a chave publishable e o JWT da sessão.
- Tema: glass 3D verde turquesa nos 3 sites, contraste WCAG AA,
  `prefers-reduced-motion` respeitado.
- Correr `npm test` em `app/` antes e depois de qualquer alteração em `app/src/`.

## Publicação

- **GitHub Pages** (principal) e **Vercel** automático a partir de `main`.
- `vercel.json` obriga `Cache-Control: no-cache` a `app/sw.js` e `portal/sw.js`
  — **não remover**, senão o PWA fica preso à versão antiga no browser do
  utilizador.
- Alterações em `vercel.json`/`headers` só fazem efeito no próximo deploy.
