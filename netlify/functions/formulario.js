"use strict";
/* Serve o formulário público em https://crm.publicacademy.com.br/formulario (sem .html)
   já com o "cartão de compartilhamento" (título, descrição e imagem) que o WhatsApp,
   Instagram e afins mostram ao receber o link. Esses robôs não executam JavaScript,
   então as tags precisam vir prontas no HTML — por isso passa por aqui.
   Os textos e a imagem são editados no CRM (menu Formulário → Link e cartão).
   Rotas (ver netlify.toml):  /formulario  e  /formulario-imagem  */
const SITE = "https://crm.publicacademy.com.br";
const SUPABASE_URL = "https://wwtwcstvbcybawhodhob.supabase.co";
// Chave "anon": pública por desenho, protegida por RLS (a mesma do index.html).
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3dHdjc3R2YmN5YmF3aG9kaG9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1OTMyMDUsImV4cCI6MjEwODE2OTIwNX0.zdIStjGOms4W5vlM5KD79RS0OhXvGO_jjLx9lgtXrYI";
const FORM_KEY = "mentoria_viver_de_shopee";
const IMG_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+\/=]+)$/;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function carregarConfig() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/formularios?slug=eq.${encodeURIComponent(FORM_KEY)}&select=config`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return (rows[0] && rows[0].config) || null;
  } catch (e) { return null; }
}

exports.handler = async (event) => {
  const site = process.env.URL || SITE;
  const cfg = await carregarConfig();
  const cartao = (cfg && cfg.compartilhar) || {};

  // Imagem do cartão: guardada no CRM como data URI; aqui vira um arquivo de verdade.
  if (event.queryStringParameters && event.queryStringParameters.img) {
    const m = IMG_RE.exec(cartao.imagem || "");
    if (!m) return { statusCode: 404, body: "" };
    return { statusCode: 200, headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=300" }, body: m[2], isBase64Encoded: true };
  }

  // A página em si é o formulario.html estático; só acrescentamos as tags do cartão.
  let html;
  try {
    const r = await fetch(site + "/formulario.html");
    if (!r.ok) throw new Error("HTTP " + r.status);
    html = await r.text();
  } catch (e) {
    return { statusCode: 502, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Formulário indisponível no momento." };
  }

  // O endereço mostrado no cartão é o domínio em que o link foi aberto (ex.: um domínio sem "crm").
  // Só vai para o texto das tags; o formulario.html é sempre buscado em `site`.
  const hostPedido = String((event.headers && (event.headers["x-forwarded-host"] || event.headers.host)) || "").split(",")[0].trim();
  const origem = /^[a-z0-9.-]+(:\d+)?$/i.test(hostPedido) ? "https://" + hostPedido : site;

  const titulo = String(cartao.titulo || (cfg && cfg.titulo) || "Mentoria Viver de Shopee").slice(0, 90);
  const descricao = String(cartao.descricao || (cfg && cfg.subtitulo) || "").slice(0, 200);
  const temImagem = IMG_RE.test(cartao.imagem || "");
  const tags = [
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Mentoria Viver de Shopee" />`,
    `<meta property="og:title" content="${esc(titulo)}" />`,
    `<meta property="og:description" content="${esc(descricao)}" />`,
    `<meta property="og:url" content="${esc(origem + "/formulario")}" />`,
    temImagem ? `<meta property="og:image" content="${esc(origem + "/formulario-imagem")}" />` : "",
    temImagem ? `<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />` : "",
    `<meta name="twitter:card" content="${temImagem ? "summary_large_image" : "summary"}" />`,
  ].filter(Boolean).join("\n");

  // Substituições por função: o texto do usuário pode ter "$&" e similares.
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(titulo)}</title>`)
    .replace(/<meta name="description"[^>]*>/, () => `<meta name="description" content="${esc(descricao)}" />`)
    .replace("</head>", () => tags + "\n</head>");

  return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" }, body: html };
};
