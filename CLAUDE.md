# CRM Viver de Shopee — briefing do projeto

CRM de vendas para a mentoria **Viver de Shopee**. A equipe comercial acompanha leads num funil, cadastra alunos, controla tarefas e agenda, e vê indicadores no painel. Idioma da interface e do código de domínio: **português do Brasil**.

## Stack

- **Front-end:** um único arquivo, `index.html` (HTML + CSS + JS puro, sem build, sem framework, sem npm). Abre direto no navegador.
- **Banco e login:** Supabase (Postgres + Auth + Realtime), acessado direto do navegador com `@supabase/supabase-js@2.45.4` (CDN jsDelivr, com SRI).
- **CSV:** PapaParse 5.4.1 (cdnjs, com SRI) para importar e exportar leads.
- **Google Agenda:** script Google Identity Services (`accounts.google.com/gsi/client`, carregado sob demanda, sem SRI pois o Google não permite) + Calendar API v3 direto do navegador. `state.gcal` guarda só `clientId` e `calendarId` (públicos, no `kv`). Escopo `calendar.events`. Uma agenda só, **uma conexão para a equipe toda** (conta `publicdigital.lucianonunes@gmail.com`).
  - **Conexão fixa:** o login usa `initCodeClient` (popup); o `code` vai para a função `netlify/functions/gcal.js`, que troca por token de renovação e o guarda na tabela `gcal_conexao` (RLS sem política: só a função, com a `service_role`, lê). O navegador pede acesso novo à função (`gcalServidor("token")`, sem popup) ao abrir e a cada ~1 h; o acesso (1 h) fica só em `ui.gcal` (memória). A função confere o login Supabase do chamador em toda chamada. Ações: `conectar`, `token`, `desconectar`.
  - **Gmail (envio) — DESLIGADO por enquanto:** o código existe (`modalEmail`, ação `enviar` do `gcal.js`), mas o escopo `gmail.send` foi tirado de `GCAL_SCOPE` e os botões de e-mail voltaram a abrir o `mailto:`. Para ligar: pôr o escopo de volta e trocar os botões por `open-modal`/`email`. Como funciona: a mesma conexão teria o escopo `gmail.send` (só envia, não lê a caixa). O botão de e-mail do lead abre `modalEmail`, que chama `gcalServidor("enviar", {para, assunto, texto})`; a função monta o e-mail e envia pelo Gmail da conta conectada (o acesso nunca sai do servidor) e o envio entra no histórico do lead. Exige **Gmail API ativada** no Google Cloud, o escopo `gmail.send` na tela de permissão OAuth e **desconectar/conectar o Google de novo** no CRM (conexões antigas não têm o escopo; o erro vem como `sem_permissao`).
  - **Variáveis no Netlify** (nunca no código): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`. Mudou variável → novo deploy. O `GOOGLE_CLIENT_ID` do Netlify tem de ser o mesmo salvo no CRM (Agenda → Configurar).
  - **Google Cloud:** o app OAuth precisa estar **Em produção** (Público-alvo); em "Testando" o token de renovação morre em 7 dias. Origem autorizada: `https://crm.publicacademy.com.br`; sem URI de redirecionamento (popup usa `postmessage`).
  - **Na tela:** eventos do Google que não foram criados pelo CRM aparecem no calendário mensal, em "Compromissos de hoje" (Agenda) e em "Agenda de Hoje" (Painel), via `gcalExternos()`/`agendaHojeLista()`. Compromissos do CRM e do Google têm editar e excluir (`gcalEditar` faz PATCH; excluir faz DELETE). "Hoje" usa data local (`hojeLocalStr()`), não o `TODAY_STR` (UTC).
- **Fontes:** Google Fonts (Plus Jakarta Sans, Inter, JetBrains Mono). Ícones são SVGs inline no objeto `ICONS` (sem biblioteca externa).
- **Hospedagem:** Netlify (projeto `crmpublicacademy`, site estático + funções). DNS no Registro.br, subdomínio `crm.publicacademy.com.br` via CNAME. **O deploy é manual, arrastando uma pasta em Deploys** (o site NÃO está ligado ao GitHub: `git push` não publica). Arraste uma pasta limpa só com `index.html`, `formulario.html`, `privacidade.html`, `termos.html`, `sobre.html`, `netlify.toml` e `netlify/` (nunca a pasta do projeto inteira: leva `supabase/` e `.claude/`); pasta, não zip, senão as funções não sobem. Existe um site sobrando `eloquent-churros-c8d3f7` (criado ao tentar ligar o GitHub), pode ser excluído.
- **Repositório:** https://github.com/rhuanrodrioficial-code/crm-mentoria (privado, branch `main`).
- **Projeto Supabase:** `https://wwtwcstvbcybawhodhob.supabase.co`. A anon key está no `index.html` (`SUPABASE_ANON_KEY`); é pública por desenho e protegida por RLS. **Nunca** colocar a `service_role` no código.

## Estrutura de pastas

```
CRM Mentorados/
├── index.html            # o app inteiro (CSS no <style>, JS no <script>)
├── formulario.html       # formulário público que o cliente preenche (página separada, sem login)
├── privacidade.html      # Política de Privacidade pública (/privacidade), exigida pelo Google
├── termos.html           # Termos de Serviço públicos (/termos), exigidos pelo Google
├── sobre.html            # página inicial pública do app (/sobre), exigida pelo Google na verificação da marca
├── netlify.toml          # reescritas: /formulario e /formulario-imagem -> função
├── netlify/functions/formulario.js  # serve o link limpo /formulario com o cartão de compartilhamento (og:tags)
├── netlify/functions/gcal.js        # mantém o Google Agenda conectado (token de renovação no servidor)
├── supabase/
│   └── schema.sql        # tabelas (leads, kv, lead_notas, formularios, gcal_conexao...), RLS, triggers e realtime (idempotente)
├── CLAUDE.md             # este arquivo
├── .gitignore            # ignora .claude/
└── .claude/skills/       # skills instaladas (não vão para o git)
```

Dentro do `index.html`, em ordem: CSS (variáveis de tema, layout, componentes, responsivo) → HTML do esqueleto (`#appRoot`, `#viewRoot`, `#drawerRoot`, `#modalRoot`, `#toastRoot`) → JS (utilitários, `ICONS`, dados de referência, config Supabase, estado, ações, renderização por tela, eventos globais, `boot()`).

## Arquitetura do JS

- **Estado único:** objeto `state` (leads, tasks, eventos, equipe, meta, log, stages, convs...) e objeto `ui` (tela atual, drawer, modal, tema).
- **Renderização:** `render()` redesenha tudo a partir do `state`. Cada tela tem uma função `renderXxx()` que devolve uma string de HTML (template literal). Modais e drawer têm funções próprias (`modalNovoLead`, `renderDrawer`...).
- **Eventos:** um único listener de `click` delegado em `setupGlobalEvents()`. Botões usam `data-action="nome-da-acao"` (+ `data-lead-id`, `data-task-id`...) e o `switch (action)` trata cada um.
- **Ações:** funções que mudam o `state`, chamam `saveSlice("chave")` e `render()` (ex.: `addLead`, `moveStage`, `addTask`, `toggleTask`). Registrar no histórico com `addLogEntry(texto, leadId)` e avisar com `toast(msg)`.
- **Confirmações:** `customConfirm(msg, danger, onYes)`; entradas de texto: `customPrompt`. Nunca usar `alert/confirm/prompt` nativos.

## Persistência (Supabase)

- `saveSlice(key)` é o ponto único de gravação:
  - `"leads"` → `sbSyncLeads()` compara a lista da tela com o último estado conhecido (`sbLeadSnap`) e faz upsert dos alterados e delete dos removidos na tabela `leads`.
  - chaves em `SB_KV_KEYS` (`tasks`, `eventos`, `equipe`, `meta`, `log`, `demoMode`, `stages`, `automacao`, `automacaoAtiva`, `gcal`) → upsert com debounce de 500 ms na tabela `kv` (chave → JSON).
- Anotações avançadas do lead (aba Anotações): tabela `lead_notas` (uma linha por registro, cascata ao excluir o lead), gravada direto por `salvarNota`/`excluirNota` (não passa por `saveSlice`). Se a tabela não existir, o app segue normal e a aba avisa. Exporta CSV por lead (`exportarNotas`).
- Formulário público: `formulario.html` lê as perguntas da tabela `formularios` (um JSON por `slug`, `FORM_KEY`) e envia pela função SQL `enviar_formulario()` (security definer, liberada para `anon`). A função valida, cria o lead, classifica e grava as respostas em `lead_notas` e `form_respostas`. O visitante **não** tem acesso direto às tabelas. O construtor fica no menu Formulário do CRM (`renderFormulario`, `modalFormQuestion`, `mutarFormConfig`).
- Link do formulário: **sem .html** — `https://crm.publicacademy.com.br/formulario` (`publicFormUrl()`). A função `netlify/functions/formulario.js` busca `config.compartilhar` (título, descrição, imagem) no Supabase e injeta as tags Open Graph no `formulario.html`, porque o WhatsApp não executa JS; `/formulario-imagem` entrega a imagem do cartão. Exige deploy com a pasta `netlify/` e o `netlify.toml`. O `/formulario.html` continua abrindo, sem cartão.
- Domínio próprio do link: `config.compartilhar.dominio` (ex.: `mentoria.publicacademy.com.br`, sem "crm"), exige alias de domínio no Netlify + CNAME no Registro.br; `publicFormUrl()` usa esse domínio e a função monta og:url/og:image com o host em que o link foi aberto. Pré-visualização: botão Pré-visualizar abre `formulario.html?preview=1` num iframe e envia a configuração por `postMessage` (modo que nunca envia respostas).
- Aparência do formulário público: `config.visual` (cores em hex, tipo de fundo, logo e imagem de fundo como data URI redimensionada no navegador, etiqueta). O `formulario.html` deriva as variáveis CSS com `applyVisual()` e só aceita hex e data URI png/jpeg/webp (`imgSegura`); nunca URL externa. Editada no cartão Aparência do menu Formulário, com pré-visualização.
- Classificação do formulário: cada opção tem `pontos` e, em perguntas ligadas a um campo do lead, um `valor` (texto da lista ou R$). Soma dos pontos → prioridade (alta/média/baixa, limiares em `classificacao`) → etapa do funil (`etapas`). Nível, se nenhuma pergunta define, é deduzido do faturamento. Telefone/e-mail já existente não duplica o lead: vira a nota "Novo envio do formulário" e o lead **é movido para a etapa/prioridade da nova pontuação** (exceto se já estiver em `fechado`), com a mudança de etapa escrita na nota. Aplicar mudanças do SQL: rodar o `supabase/schema.sql` inteiro no SQL Editor (é idempotente).
- Mapeamento de colunas: `leadToRow()` / `leadFromRow()` (camelCase no app, snake_case no banco).
- Tempo real: `sbSubscribe()` ouve `leads` e `kv` e recarrega com `sbLoadAll()`, ignorando o eco das próprias gravações (`sbLastLocalWrite`).
- Segurança: RLS ligado nas duas tabelas; só `authenticated` lê e grava. Cadastro aberto está **desligado** no Supabase; usuários são criados manualmente em Authentication → Users. Todo usuário logado tem acesso total (equipe pequena e confiável).
- Sem as chaves do Supabase, o app abre em **modo pré-visualização** (`PREVIEW_SEM_LOGIN`) com dados demo, sem gravar nada no servidor.
- `localStorage` guarda só tema e `integr`; dados de leads/tarefas não ficam no navegador.

## Convenções

- **Escapar tudo:** qualquer dado vindo do banco, de CSV ou do usuário e inserido em HTML passa por `esc()`. Valores em `href` também (`esc(mailtoLink(...))`). Cores de etapa só aceitas em hex. Nunca concatenar dado cru em `innerHTML`.
- **Novas telas/ações:** seguir o padrão existente (função `renderXxx`, `data-action`, `case` no switch, `saveSlice` + `render`). Não introduzir framework nem build.
- **Ids de lead:** UUID em texto (`crypto.randomUUID()`), definido no `mk()`.
- **Etapas do funil:** chaves em `DEFAULT_STAGES` (`novo`, `contato`, `qualif`, `proposta`, `negoc`, `aguard`, `fechado`, `perdido`); o lead guarda a chave em `stage`. `fechado` = Aluno Matriculado.
- **Prioridade:** `alta | media | baixa` (objeto `PRI`).
- **Texto da interface:** pt-BR, tom direto, sem jargão técnico para o usuário final. Datas via `toLocaleDateString("pt-BR")`, moeda via `brl()`.
- **Comentários:** em português, curtos, explicando o porquê.
- **Responsivo:** todo componente novo precisa funcionar de celular (≤ 430 px) a desktop; já há breakpoints em 640, 430, 375, 340 e tablet 641–1024.
- **Banco:** mudou o schema? Atualizar `supabase/schema.sql` mantendo-o idempotente (`if not exists`, `drop policy if exists`...). Toda tabela nova com RLS habilitado.
- **Verificação rápida de sintaxe** (não há testes automatizados): extrair o `<script>` e rodar `node --check`.

## Identidade visual

- **Marca:** Viver de Shopee. Cor principal laranja Shopee **`#EE4D2D`** (hover `#D63E1F`; no escuro `#FF6740`). Logo é um SVG de sacola em fundo laranja (`LOGO_DATA_URI`).
- **Temas:** claro (padrão) e escuro, via classe `.app.light` / `.app.dark` com variáveis CSS (`--bg`, `--surface`, `--text`, `--brand`, `--border`...). Sempre usar as variáveis, nunca cores fixas.
- **Semânticas:** `--ok` verde `#12A971`, `--warn` âmbar `#E08A00`, `--bad` vermelho `#E5484D`, `--wa` verde WhatsApp, além de `--violet` e `--sky` de apoio. Versões `-weak` (translúcidas) para fundos de badge/chip.
- **Tipografia:** títulos e números de destaque em **Plus Jakarta Sans** (700–800, `letter-spacing` negativo); corpo em **Inter**; valores, KPIs e horários em **JetBrains Mono** (classe `.mono`, algarismos tabulares).
- **Forma:** cantos arredondados (cards 15 px, botões e campos 9–10 px, chips 6–7 px), bordas finas de 1 px, sombras suaves. Sidebar de 246 px (recolhível a 74 px), topo de 64 px.
- **Componentes prontos:** `.card`, `.btn .btn-p/.btn-g`, `.badge`, `.chip`, `.kpi`, `.kanban/.col/.lcard`, `table.crm`, `.drawer`, `.modal`, `.field-l`, `.seg`, `.tabs`, toast. Reaproveitar antes de criar estilo novo.
- **Avatares:** círculo com iniciais, cor derivada do nome (`avatarColor`, paleta `AV`).

## Módulos (menu)

Painel · Atendimento (WhatsApp) · Automação · Funil de Vendas (kanban com arrastar e soltar) · Leads (tabela, busca, importar/exportar CSV) · Clientes (alunos) · Formulário (construtor + respostas) · Agenda · Tarefas · Relatórios · Usuários · Guia do CRM (aba de ajuda em linguagem simples para quem nunca usou; chave interna `briefing`, função `renderBriefing`).

A tela técnica **Integrações** (e o botão de apagar todos os dados) foi removida da interface de propósito: o usuário final não deve ver jargão. O estado `state.integr` e as ações `integr-*` e `reset-data` continuam no código sem tela. O atalho "dados de demonstração" também foi removido (não há mais como criar leads fictícios pela interface); só o modo pré-visualização sem Supabase (`PREVIEW_SEM_LOGIN`) ainda usa `buildDemoData()`.

Lead tem painel lateral (drawer) com abas Dados, Comercial, Histórico, Anotações e Tarefas, ações de WhatsApp/ligação/e-mail/proposta e **editar/excluir**. Tarefas também podem ser editadas e excluídas.

## Estado atual e pendências

- **Funcionando com Supabase:** login, leads/alunos (criar, editar, excluir, mover de etapa, importar CSV), tarefas, agenda, equipe, meta, etapas do funil, histórico, tempo real.
- **Ainda não ligado:** Atendimento/WhatsApp (precisa de servidor próprio, ex.: Evolution API), que tem código legado que chama uma API REST antiga (`API_BASE`, objeto `api`) e **não funcionam** sem esse backend. Conversas ficam vazias no modo Supabase.
- **Código legado:** `apiFetch`, `api.*`, `tokens`, `buildStageMapping` e afins vêm de uma versão antiga com backend Node/MySQL. Não usar para dados novos; migrar para Supabase se for religar o módulo.
- **Permissões:** todos os usuários logados são equivalentes. Perfis por vendedor exigiriam coluna de dono nos leads e políticas RLS novas.
- **Publicação:** no ar em `https://crm.publicacademy.com.br` (Netlify, projeto `crmpublicacademy`, CNAME `crm` → `crmpublicacademy.netlify.app` no Registro.br, HTTPS Let's Encrypt ativo). Site URL e Redirect URLs já configurados no Supabase.

## Segurança (OWASP Top 10 / Supabase)

- **Cabeçalhos e CSP:** definidos no `netlify.toml` (HSTS, nosniff, `X-Frame-Options: SAMEORIGIN`, Referrer-Policy, Permissions-Policy e CSP separada para o CRM e para o `formulario.html`). Usar uma origem nova (CDN, API) exige liberá-la na CSP, senão o navegador bloqueia. A função `formulario.js` repete os cabeçalhos porque responde por reescrita.
- **Função `gcal.js`:** confere login, origem (mesmo site), tamanho do corpo, tem timeout nas chamadas externas e registra eventos (sem token) nos logs do Netlify.
- **Banco:** `schema.sql` revoga privilégios do `anon` (só lê `formularios` e usa `enviar_formulario`), bloqueia `gcal_conexao` para todos menos a `service_role` e tem `check` de limites. Rodar o arquivo inteiro no SQL Editor após mudar.
- **HTML:** ids em atributos `data-*` e nomes de etapa também passam por `esc()`.
- **No painel do Supabase (manual):** manter cadastro aberto desligado, senha mínima forte + proteção contra senha vazada, MFA para a equipe, confirmar de e-mail ligado e conferir em Advisors → Security se não há alertas.
