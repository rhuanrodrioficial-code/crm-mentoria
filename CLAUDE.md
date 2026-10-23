# CRM Viver de Shopee — briefing do projeto

CRM de vendas para a mentoria **Viver de Shopee**. A equipe comercial acompanha leads num funil, cadastra alunos, controla tarefas e agenda, e vê indicadores no painel. Idioma da interface e do código de domínio: **português do Brasil**.

## Stack

- **Front-end:** um único arquivo, `index.html` (HTML + CSS + JS puro, sem build, sem framework, sem npm). Abre direto no navegador.
- **Banco e login:** Supabase (Postgres + Auth + Realtime), acessado direto do navegador com `@supabase/supabase-js@2.45.4` (CDN jsDelivr, com SRI).
- **CSV:** PapaParse 5.4.1 (cdnjs, com SRI) para importar e exportar leads.
- **Google Agenda:** script Google Identity Services (`accounts.google.com/gsi/client`, carregado sob demanda, sem SRI pois o Google não permite) + Calendar API v3 direto do navegador. `state.gcal` guarda só `clientId` e `calendarId` (públicos, no `kv`); o token OAuth fica só em `ui.gcal` (memória, reconectar ao recarregar). Escopo `calendar.events`. Uma agenda só; quem usa precisa conectar uma conta Google com acesso a ela.
- **Fontes:** Google Fonts (Plus Jakarta Sans, Inter, JetBrains Mono). Ícones são SVGs inline no objeto `ICONS` (sem biblioteca externa).
- **Hospedagem:** Netlify (site estático). DNS no Registro.br, subdomínio `crm.publicacademy.com.br` via CNAME.
- **Repositório:** https://github.com/rhuanrodrioficial-code/crm-mentoria (privado, branch `main`).
- **Projeto Supabase:** `https://wwtwcstvbcybawhodhob.supabase.co`. A anon key está no `index.html` (`SUPABASE_ANON_KEY`); é pública por desenho e protegida por RLS. **Nunca** colocar a `service_role` no código.

## Estrutura de pastas

```
CRM Mentorados/
├── index.html            # o app inteiro (CSS no <style>, JS no <script>)
├── formulario.html       # formulário público que o cliente preenche (página separada, sem login)
├── netlify.toml          # reescritas: /formulario e /formulario-imagem -> função
├── netlify/functions/formulario.js  # serve o link limpo /formulario com o cartão de compartilhamento (og:tags)
├── supabase/
│   └── schema.sql        # tabelas, RLS, triggers e realtime (idempotente)
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
- Classificação do formulário: cada opção tem `pontos` e, em perguntas ligadas a um campo do lead, um `valor` (texto da lista ou R$). Soma dos pontos → prioridade (alta/média/baixa, limiares em `classificacao`) → etapa do funil (`etapas`). Nível, se nenhuma pergunta define, é deduzido do faturamento. Telefone/e-mail já existente não duplica o lead (vira "Novo envio do formulário").
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

Painel · Atendimento (WhatsApp) · Automação · Funil de Vendas (kanban com arrastar e soltar) · Leads (tabela, busca, importar/exportar CSV) · Clientes (alunos) · Formulário (construtor + respostas) · Agenda · Tarefas · Relatórios · Usuários · Briefing do Sistema · Integrações.

Lead tem painel lateral (drawer) com abas Dados, Comercial, Histórico, Anotações e Tarefas, ações de WhatsApp/ligação/e-mail/proposta e **editar/excluir**. Tarefas também podem ser editadas e excluídas.

## Estado atual e pendências

- **Funcionando com Supabase:** login, leads/alunos (criar, editar, excluir, mover de etapa, importar CSV), tarefas, agenda, equipe, meta, etapas do funil, histórico, tempo real.
- **Ainda não ligado:** Atendimento/WhatsApp (precisa de servidor próprio, ex.: Evolution API), que tem código legado que chama uma API REST antiga (`API_BASE`, objeto `api`) e **não funcionam** sem esse backend. Conversas ficam vazias no modo Supabase.
- **Código legado:** `apiFetch`, `api.*`, `tokens`, `buildStageMapping` e afins vêm de uma versão antiga com backend Node/MySQL. Não usar para dados novos; migrar para Supabase se for religar o módulo.
- **Permissões:** todos os usuários logados são equivalentes. Perfis por vendedor exigiriam coluna de dono nos leads e políticas RLS novas.
- **Publicação:** no ar em `https://crm.publicacademy.com.br` (Netlify, projeto `crmpublicacademy`, CNAME `crm` → `crmpublicacademy.netlify.app` no Registro.br, HTTPS Let's Encrypt ativo). Site URL e Redirect URLs já configurados no Supabase.
