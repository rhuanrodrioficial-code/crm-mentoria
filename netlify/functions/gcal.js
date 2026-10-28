"use strict";
/* Mantém o Google Agenda conectado de forma fixa.
   O navegador só consegue um acesso de 1 hora; aqui guardamos o "token de renovação" do Google
   (na tabela gcal_conexao, que só esta função lê) e entregamos um acesso novo sempre que o CRM pedir.
   Só usuário logado no CRM pode chamar (o login do Supabase é conferido a cada chamada).
   Variáveis no Netlify (Site configuration → Environment variables):
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SUPABASE_SERVICE_ROLE_KEY
   Ações (POST JSON): conectar {code} · token · enviar {para, assunto, texto} · desconectar */
const SUPABASE_URL = "https://wwtwcstvbcybawhodhob.supabase.co";
// Chave "anon": pública por desenho (a mesma do index.html); aqui só serve para conferir o login.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3dHdjc3R2YmN5YmF3aG9kaG9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1OTMyMDUsImV4cCI6MjEwODE2OTIwNX0.zdIStjGOms4W5vlM5KD79RS0OhXvGO_jjLx9lgtXrYI";

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify(obj) });
// Tempo máximo de cada chamada externa: a função não fica presa se o Google/Supabase travar.
const T = () => ({ signal: AbortSignal.timeout(10000) });
// Registro para auditoria (OWASP A09). Nunca grava token, código ou segredo.
const log = (evento, extra) => console.log(JSON.stringify({ evento, ...(extra || {}), em: new Date().toISOString() }));

async function usuarioLogado(auth) {
  if (!/^Bearer\s+\S+$/.test(auth || "")) return false;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth }, ...T() });
    return r.ok;
  } catch (e) { return false; }
}

const dbHeaders = (extra) => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json", ...(extra || {}) });
async function lerRefresh() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gcal_conexao?id=eq.principal&select=refresh_token`, { headers: dbHeaders(), ...T() });
  if (!r.ok) throw new Error("db " + r.status);
  const rows = await r.json();
  return (rows[0] && rows[0].refresh_token) || null;
}
async function gravarRefresh(token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gcal_conexao?on_conflict=id`, {
    method: "POST", headers: dbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "principal", refresh_token: token, atualizado: new Date().toISOString() }), ...T(),
  });
  if (!r.ok) throw new Error("db " + r.status);
}
async function apagarRefresh() {
  await fetch(`${SUPABASE_URL}/rest/v1/gcal_conexao?id=eq.principal`, { method: "DELETE", headers: dbHeaders(), ...T() });
}
async function googleToken(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }).toString(), ...T(),
  });
  let body = {}; try { body = await r.json(); } catch (e) {}
  return { ok: r.ok, body };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { erro: "metodo" });
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { erro: "configuracao" });
  const h = event.headers || {};
  // Só aceita chamadas vindas do próprio site (defesa extra contra requisições de outros sites).
  const origem = h.origin || h.Origin;
  const host = String(h["x-forwarded-host"] || h.host || "").split(",")[0].trim();
  let origemOk = true;
  if (origem) { try { origemOk = new URL(origem).host === host; } catch (e) { origemOk = false; } }
  if (!origemOk) { log("origem_negada"); return json(403, { erro: "origem" }); }
  if ((event.body || "").length > 20000) return json(413, { erro: "tamanho" });
  if (!(await usuarioLogado(h.authorization || h.Authorization))) { log("login_negado"); return json(401, { erro: "login" }); }
  let corpo = {}; try { corpo = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { erro: "json" }); }

  try {
    if (corpo.action === "conectar") {
      if (typeof corpo.code !== "string" || !corpo.code || corpo.code.length > 2048) return json(400, { erro: "codigo" });
      // "postmessage" é o redirect fixo do login em popup do Google
      const g = await googleToken({ grant_type: "authorization_code", code: corpo.code, redirect_uri: "postmessage" });
      if (!g.ok) return json(400, { erro: "google", detalhe: String(g.body.error || "") });
      if (g.body.refresh_token) await gravarRefresh(g.body.refresh_token);
      log("conectar", { fixo: !!g.body.refresh_token });
      // sem refresh_token o Google já tinha dado permissão antes: funciona por 1 hora, mas não fica fixo
      return json(200, { access_token: g.body.access_token, expires_in: g.body.expires_in, fixo: !!g.body.refresh_token });
    }
    if (corpo.action === "token") {
      const refresh = await lerRefresh();
      if (!refresh) return json(404, { erro: "nao_conectado" });
      const g = await googleToken({ grant_type: "refresh_token", refresh_token: refresh });
      if (!g.ok) {
        if (g.body.error === "invalid_grant") { await apagarRefresh(); return json(401, { erro: "expirou" }); }
        return json(502, { erro: "google", detalhe: String(g.body.error || "") });
      }
      return json(200, { access_token: g.body.access_token, expires_in: g.body.expires_in });
    }
    if (corpo.action === "enviar") {
      // Envia pelo Gmail da conta conectada (escopo gmail.send). O acesso nunca sai do servidor.
      const { para, assunto, texto } = corpo;
      if (typeof para !== "string" || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(para) || para.length > 200) return json(400, { erro: "destinatario" });
      if (typeof assunto !== "string" || !assunto.trim() || assunto.length > 200 || /[\r\n]/.test(assunto)) return json(400, { erro: "assunto" });
      if (typeof texto !== "string" || !texto.trim() || texto.length > 8000) return json(400, { erro: "texto" });
      const refresh = await lerRefresh();
      if (!refresh) return json(404, { erro: "nao_conectado" });
      const g = await googleToken({ grant_type: "refresh_token", refresh_token: refresh });
      if (!g.ok) {
        if (g.body.error === "invalid_grant") { await apagarRefresh(); return json(401, { erro: "expirou" }); }
        return json(502, { erro: "google", detalhe: String(g.body.error || "") });
      }
      const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
      const mime = [
        "To: " + para,
        "Subject: =?UTF-8?B?" + b64(assunto) + "?=",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64(texto).replace(/(.{76})/g, "$1\r\n"),
      ].join("\r\n");
      const raw = Buffer.from(mime, "utf8").toString("base64url");
      const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", headers: { Authorization: "Bearer " + g.body.access_token, "Content-Type": "application/json" }, body: JSON.stringify({ raw }), ...T(),
      });
      if (!r.ok) {
        log("enviar_falhou", { status: r.status });
        // 403: a conexão foi feita antes de existir a permissão de e-mail
        return json(r.status === 403 ? 403 : 502, { erro: r.status === 403 ? "sem_permissao" : "google" });
      }
      log("enviar");
      return json(200, { ok: true });
    }
    if (corpo.action === "desconectar") {
      const refresh = await lerRefresh();
      if (refresh) { try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }).toString(), ...T() }); } catch (e) {} }
      await apagarRefresh();
      log("desconectar");
      return json(200, { ok: true });
    }
    return json(400, { erro: "acao" });
  } catch (e) {
    log("erro", { acao: String(corpo.action || ""), msg: String((e && e.message) || "").slice(0, 80) });
    return json(502, { erro: "servidor" });
  }
};
