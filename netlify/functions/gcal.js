"use strict";
/* Mantém o Google Agenda conectado de forma fixa.
   O navegador só consegue um acesso de 1 hora; aqui guardamos o "token de renovação" do Google
   (na tabela gcal_conexao, que só esta função lê) e entregamos um acesso novo sempre que o CRM pedir.
   Só usuário logado no CRM pode chamar (o login do Supabase é conferido a cada chamada).
   Variáveis no Netlify (Site configuration → Environment variables):
     GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SUPABASE_SERVICE_ROLE_KEY
   Ações (POST JSON): conectar {code} · token · desconectar */
const SUPABASE_URL = "https://wwtwcstvbcybawhodhob.supabase.co";
// Chave "anon": pública por desenho (a mesma do index.html); aqui só serve para conferir o login.
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3dHdjc3R2YmN5YmF3aG9kaG9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1OTMyMDUsImV4cCI6MjEwODE2OTIwNX0.zdIStjGOms4W5vlM5KD79RS0OhXvGO_jjLx9lgtXrYI";

const json = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(obj) });

async function usuarioLogado(auth) {
  if (!/^Bearer\s+\S+$/.test(auth || "")) return false;
  try {
    const r = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth } });
    return r.ok;
  } catch (e) { return false; }
}

const dbHeaders = (extra) => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json", ...(extra || {}) });
async function lerRefresh() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gcal_conexao?id=eq.principal&select=refresh_token`, { headers: dbHeaders() });
  if (!r.ok) throw new Error("db " + r.status);
  const rows = await r.json();
  return (rows[0] && rows[0].refresh_token) || null;
}
async function gravarRefresh(token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/gcal_conexao?on_conflict=id`, {
    method: "POST", headers: dbHeaders({ Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "principal", refresh_token: token, atualizado: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("db " + r.status);
}
async function apagarRefresh() {
  await fetch(`${SUPABASE_URL}/rest/v1/gcal_conexao?id=eq.principal`, { method: "DELETE", headers: dbHeaders() });
}
async function googleToken(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }).toString(),
  });
  let body = {}; try { body = await r.json(); } catch (e) {}
  return { ok: r.ok, body };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { erro: "metodo" });
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.SUPABASE_SERVICE_ROLE_KEY) return json(500, { erro: "configuracao" });
  const h = event.headers || {};
  if (!(await usuarioLogado(h.authorization || h.Authorization))) return json(401, { erro: "login" });
  let corpo = {}; try { corpo = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { erro: "json" }); }

  try {
    if (corpo.action === "conectar") {
      if (typeof corpo.code !== "string" || !corpo.code || corpo.code.length > 2048) return json(400, { erro: "codigo" });
      // "postmessage" é o redirect fixo do login em popup do Google
      const g = await googleToken({ grant_type: "authorization_code", code: corpo.code, redirect_uri: "postmessage" });
      if (!g.ok) return json(400, { erro: "google", detalhe: String(g.body.error || "") });
      if (g.body.refresh_token) await gravarRefresh(g.body.refresh_token);
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
    if (corpo.action === "desconectar") {
      const refresh = await lerRefresh();
      if (refresh) { try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }).toString() }); } catch (e) {} }
      await apagarRefresh();
      return json(200, { ok: true });
    }
    return json(400, { erro: "acao" });
  } catch (e) {
    return json(502, { erro: "servidor" });
  }
};
