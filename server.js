/**
 * Publifyer List Builder — Servidor Web Completo
 * ------------------------------------------------
 * Sirve el formulario en / y la API en /generate-list
 * Deployar en Railway: conectar repo → configurar env vars → listo.
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ─── Servir archivos estáticos (el formulario HTML) ──────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── CONFIG PUBLIFYER ─────────────────────────────────────────────────────────
const PUB = {
  baseUrl : process.env.PUBLIFYER_API_URL   || 'https://api.publifyer.com',
  token   : process.env.PUBLIFYER_API_TOKEN || '',
  siteId  : process.env.PUBLIFYER_SITE_ID   || '5',
};

// ─── PROTECCIÓN POR CONTRASEÑA (simple) ──────────────────────────────────────
// Si se define ACCESS_PASSWORD, el form pedirá esa clave antes de enviar.
// El endpoint /generate-list la valida en el header x-access-key.
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || '';

app.post('/generate-list', (req, res, next) => {
  if (!ACCESS_PASSWORD) return next(); // sin contraseña: libre
  const key = req.headers['x-access-key'] || '';
  if (key !== ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'Acceso no autorizado' });
  }
  next();
}, handleGenerateList);

app.post('/generate-list', handleGenerateList);

// ─── DEFINICIÓN DE TOOLS PARA CLAUDE ────────────────────────────────────────
const TOOLS = [
  {
    name        : 'buscar_creadores_ia',
    description : 'Busca creadores en Publifyer con IA usando lenguaje natural. Devuelve lista de resultados con adspace_id y datos básicos.',
    input_schema: {
      type      : 'object',
      properties: {
        query : { type: 'string', description: 'Consulta en lenguaje natural' },
        limit : { type: 'number', description: 'Número de resultados. Default 40, máximo 60.' },
      },
      required: ['query'],
    },
  },
  {
    name        : 'perfil_creador',
    description : 'Obtiene perfil completo de un creador: seguidores por plataforma, ER, categorías, contacto.',
    input_schema: {
      type      : 'object',
      properties: {
        adspace_id: { type: 'number', description: 'ID del adspace del creador' },
      },
      required: ['adspace_id'],
    },
  },
];

// ─── LLAMADAS A PUBLIFYER API ─────────────────────────────────────────────────
async function ejecutarTool(name, input) {
  const headers = {
    'Authorization': `Bearer ${PUB.token}`,
    'Content-Type' : 'application/json',
  };

  try {
    if (name === 'buscar_creadores_ia') {
      // TODO: confirmar endpoint con equipo técnico de Publifyer
      const res = await fetch(`${PUB.baseUrl}/api/v1/creators/search`, {
        method : 'POST',
        headers,
        body   : JSON.stringify({
          query  : input.query,
          site_id: PUB.siteId,
          limit  : input.limit || 40,
          ai     : true,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }

    if (name === 'perfil_creador') {
      // TODO: confirmar endpoint con equipo técnico de Publifyer
      const res = await fetch(
        `${PUB.baseUrl}/api/v1/adspaces/${input.adspace_id}/profile?site_id=${PUB.siteId}`,
        { method: 'GET', headers }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }

  } catch (err) {
    console.error(`[tool error] ${name}:`, err.message);
    return { error: err.message };
  }
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function buildSystemPrompt(brief) {
  return `Eres el agente List Builder de Publifyer Perú.
Tu trabajo es construir listas de influencers para campañas usando la API de Publifyer.

BRIEF DE CAMPAÑA:
${JSON.stringify(brief, null, 2)}

INSTRUCCIONES:
1. Llama buscar_creadores_ia con una query en español que capture el perfil ideal del brief.
2. Para los 20-25 resultados más relevantes, llama perfil_creador para obtener métricas completas.
3. Clasifica según ER:
   - TIER A: ER ≥ ${brief.er_minimo || 5}%
   - TIER B: ER entre 2% y ${brief.er_minimo || 5}%
   - TIER C: sin datos de ER pero perfil relevante
   - DESCARTAR: ER < 1.5% o contenido incompatible
4. Excluye: ${(brief.excluir_competencia || []).join(', ') || 'ninguno'}
5. Selecciona hasta ${brief.cantidad || 30} creadores.
6. Devuelve SOLO este JSON, sin texto adicional:

{
  "meta": { "campaign": "...", "total_found": 0, "total_selected": 0 },
  "tier_a": [],
  "tier_b": [],
  "tier_c": [],
  "descartados": []
}

Cada creador:
{
  "adspace_id": 0,
  "nombre": "...",
  "plataformas": { "tiktok": 0, "instagram": 0 },
  "er": 0,
  "categorias": [],
  "contacto": "...",
  "nota": "..."
}`;
}

// ─── LOOP AGENTICO ─────────────────────────────────────────────────────────────
async function runAgentLoop(brief) {
  const messages = [{
    role   : 'user',
    content: `Construye la lista de influencers para la campaña "${brief.campana?.nombre || 'sin nombre'}". Empieza ya.`,
  }];

  for (let i = 0; i < 12; i++) {
    const response = await anthropic.messages.create({
      model     : 'claude-opus-4-5',
      max_tokens: 4096,
      system    : buildSystemPrompt(brief),
      tools     : TOOLS,
      messages,
    });

    console.log(`[agent iter ${i+1}] stop_reason: ${response.stop_reason}`);

    if (response.stop_reason === 'end_turn') {
      const text = response.content.find(b => b.type === 'text');
      return text?.text || '{}';
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const results = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        console.log(`[tool] ${block.name}`, JSON.stringify(block.input).slice(0, 100));
        const result = await ejecutarTool(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: results });
    }
  }
  throw new Error('Agente superó límite de iteraciones');
}

// ─── GENERADOR DE HTML ────────────────────────────────────────────────────────
function buildHTML(data, brief) {
  function fmt(n) {
    return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1000 ? Math.round(n/1000)+'K' : n;
  }
  function card(c, color) {
    const plats = Object.entries(c.plataformas||{}).filter(([,v])=>v)
      .map(([k,v])=>`<span class="badge">${k}: ${fmt(v)}</span>`).join('');
    return `<div class="card">
      <div class="card-top" style="border-left:4px solid ${color}">
        <div><strong>${c.nombre}</strong>
          <span class="er-pill" style="background:${color}">${c.er ? c.er.toFixed(1)+'% ER' : 'Sin ER'}</span>
        </div>
        <select class="sel" onchange="this.closest('.card').style.background={approved:'#d1fae5',rejected:'#fee2e2',hold:'#fef3c7'}[this.value]||'#fff'">
          <option value="">— Revisar —</option>
          <option value="approved">✅ Aprobado</option>
          <option value="rejected">❌ Rechazado</option>
          <option value="hold">⏸ En espera</option>
        </select>
      </div>
      <div class="plats">${plats}</div>
      <div class="cats">${(c.categorias||[]).slice(0,4).map(x=>`<span class="cat">${x}</span>`).join('')}</div>
      <p class="nota">${c.nota||''}</p>
      ${c.contacto?`<p class="contact">📧 ${c.contacto}</p>`:''}
    </div>`;
  }

  const discRows = (data.descartados||[]).map(c=>
    `<tr><td>${c.nombre}</td><td>${c.er?c.er.toFixed(1)+'%':'—'}</td><td>${c.nota||c.motivo||'—'}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lista — ${data.meta?.campaign||''}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b}
header{background:#1e293b;color:#fff;padding:20px 32px}
header h1{font-size:1.25rem;font-weight:700}
header p{font-size:.8rem;color:#94a3b8;margin-top:4px}
.meta{display:flex;gap:20px;padding:12px 32px;background:#fff;border-bottom:1px solid #e2e8f0;font-size:.82rem;color:#475569;flex-wrap:wrap}
.meta strong{color:#1e293b}
.sec{padding:20px 32px}
.sec h2{font-size:.95rem;font-weight:700;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #e2e8f0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px;transition:background .2s}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px}
.card-top strong{font-size:.9rem;display:block}
.er-pill{display:inline-block;font-size:.67rem;font-weight:700;color:#fff;padding:2px 7px;border-radius:20px;margin-top:3px}
.plats{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:7px}
.badge{font-size:.7rem;background:#f1f5f9;color:#475569;padding:2px 8px;border-radius:12px}
.cats{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:7px}
.cat{font-size:.68rem;background:#ede9fe;color:#6d28d9;padding:2px 7px;border-radius:12px}
.nota{font-size:.76rem;color:#64748b;line-height:1.4;margin-bottom:5px}
.contact{font-size:.73rem;color:#0ea5e9}
.sel{font-size:.72rem;border:1px solid #e2e8f0;border-radius:6px;padding:3px 7px;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:.82rem}
th{background:#f1f5f9;padding:8px 12px;text-align:left}
td{padding:8px 12px;border-bottom:1px solid #e2e8f0}
.print-btn{background:#1e293b;color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:.82rem;margin:20px 32px;display:inline-block}
.back-btn{background:#e91e8c;color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:.82rem;margin:20px 8px 20px 32px;display:inline-block;text-decoration:none}
@media print{.print-btn,.back-btn,.sel{display:none}}
</style></head><body>
<header>
  <h1>📋 Lista — ${data.meta?.campaign||brief?.campana?.nombre||'Campaña'}</h1>
  <p>Generada por Publifyer List Builder · ${new Date().toLocaleDateString('es-PE',{day:'2-digit',month:'long',year:'numeric'})}</p>
</header>
<div class="meta">
  <span>Encontrados: <strong>${data.meta?.total_found||'—'}</strong></span>
  <span>Seleccionados: <strong>${data.meta?.total_selected||((data.tier_a||[]).length+(data.tier_b||[]).length+(data.tier_c||[]).length)}</strong></span>
  <span>Tier A 🔥: <strong>${(data.tier_a||[]).length}</strong></span>
  <span>Tier B ⚡: <strong>${(data.tier_b||[]).length}</strong></span>
  <span>Tier C 📋: <strong>${(data.tier_c||[]).length}</strong></span>
  <span>Descartados: <strong>${(data.descartados||[]).length}</strong></span>
</div>
<a class="back-btn" href="/">← Nuevo brief</a>
<button class="print-btn" onclick="window.print()">⬇ Exportar PDF</button>
${(data.tier_a||[]).length?`<div class="sec"><h2>🔥 Tier A — ER Alto</h2><div class="grid">${(data.tier_a||[]).map(c=>card(c,'#10b981')).join('')}</div></div>`:''}
${(data.tier_b||[]).length?`<div class="sec"><h2>⚡ Tier B — ER Medio</h2><div class="grid">${(data.tier_b||[]).map(c=>card(c,'#f59e0b')).join('')}</div></div>`:''}
${(data.tier_c||[]).length?`<div class="sec"><h2>📋 Tier C — Sin ER</h2><div class="grid">${(data.tier_c||[]).map(c=>card(c,'#6366f1')).join('')}</div></div>`:''}
${discRows?`<div class="sec"><h2>🗑 Descartados</h2><table><thead><tr><th>Creador</th><th>ER</th><th>Motivo</th></tr></thead><tbody>${discRows}</tbody></table></div>`:''}
</body></html>`;
}

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
async function handleGenerateList(req, res) {
  const brief = req.body;
  if (!brief?.campana) return res.status(400).json({ error: 'JSON inválido: falta campo campana' });

  console.log(`[request] ${new Date().toISOString()} — ${brief.campana.nombre}`);

  try {
    const rawJson = await runAgentLoop(brief);
    let data;
    try { data = JSON.parse(rawJson); }
    catch { const m = rawJson.match(/\{[\s\S]+\}/); data = m ? JSON.parse(m[0]) : {}; }

    const html = buildHTML(data, brief);
    res.json({ success: true, html, data, meta: data.meta });

  } catch (err) {
    console.error('[error]', err.message);
    res.status(500).json({ error: err.message });
  }
}

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Publifyer List Builder → http://localhost:${PORT}`);
  if (!PUB.token) console.warn('⚠  PUBLIFYER_API_TOKEN no configurado');
  if (!process.env.ANTHROPIC_API_KEY) console.warn('⚠  ANTHROPIC_API_KEY no configurado');
});
