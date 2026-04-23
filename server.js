require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;
const XAI_API_KEY = process.env.XAI_API_KEY;

if (!XAI_API_KEY) {
  console.error('ERROR: XAI_API_KEY not found in .env');
  process.exit(1);
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────
//  STT Proxy — POST /api/stt
//  Accepts audio blob, forwards to xAI /v1/stt
// ──────────────────────────────────────────────
app.post('/api/stt', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const FormData = (await import('node-fetch')).default ? require('form-data') : require('form-data');
    const formData = new (require('form-data'))();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname || 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm',
    });
    formData.append('model', 'grok-stt');

    const response = await fetch('https://api.x.ai/v1/stt', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XAI_API_KEY}`,
        ...formData.getHeaders(),
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('xAI STT error:', response.status, errText);
      return res.status(response.status).json({ error: `STT API error: ${response.status}`, details: errText });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('STT proxy error:', err);
    res.status(500).json({ error: 'STT processing failed', details: err.message });
  }
});

// ──────────────────────────────────────────────
//  TTS Proxy — POST /api/tts
//  Accepts { text, voice_id }, returns MP3 audio
// ──────────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice_id = 'eve', language = 'en' } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const response = await fetch('https://api.x.ai/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text, voice_id, language }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('xAI TTS error:', response.status, errText);
      return res.status(response.status).json({ error: `TTS API error: ${response.status}`, details: errText });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
    });

    response.body.pipe(res);
  } catch (err) {
    console.error('TTS proxy error:', err);
    res.status(500).json({ error: 'TTS processing failed', details: err.message });
  }
});

// ──────────────────────────────────────────────
//  Page Fetcher — POST /api/fetch-page
//  Accepts { url }, returns readable text
// ──────────────────────────────────────────────
app.post('/api/fetch-page', async (req, res) => {
  try {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });

    // Auto-prepend protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) BuzzVoice/1.0 AudioBrowser',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
      follow: 5,
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch page: HTTP ${response.status}` });
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const webmcp = await detectWebMCP(dom.window.document, html, url);

    if (!article) {
      const bodyText = dom.window.document.body?.textContent?.trim() || '';
      const title = dom.window.document.title || url;
      return res.json({
        title,
        text: bodyText.substring(0, 5000),
        excerpt: bodyText.substring(0, 200),
        links: extractLinks(dom.window.document, url),
        webmcp,
      });
    }

    const cleanText = article.textContent
      .replace(/\s+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    res.json({
      title: article.title || dom.window.document.title || url,
      text: cleanText.substring(0, 8000),
      excerpt: article.excerpt || cleanText.substring(0, 200),
      links: extractLinks(dom.window.document, url),
      webmcp,
    });
  } catch (err) {
    console.error('Fetch page error:', err);
    res.status(500).json({ error: 'Failed to fetch page', details: err.message });
  }
});

// ──────────────────────────────────────────────
//  Imperative WebMCP Tool Extractor
//  Parses a minified JS bundle for tool schemas
// ──────────────────────────────────────────────
function extractImperativeTools(jsText, pageUrl) {
  const tools = [];
  let pos = 0;

  while (true) {
    // Find pattern: name:`tool_name` (backtick or single/double quote)
    const nameIdx = jsText.indexOf('name:`', pos);
    if (nameIdx === -1) break;

    // Must be inside an object — look for { within 10 chars before
    const before = jsText.substring(Math.max(0, nameIdx - 10), nameIdx);
    if (!before.includes('{')) { pos = nameIdx + 1; continue; }

    const nameStart = nameIdx + 6;
    const nameEnd   = jsText.indexOf('`', nameStart);
    if (nameEnd === -1) { pos = nameIdx + 1; continue; }
    const name = jsText.substring(nameStart, nameEnd);

    // Find description
    const descIdx = jsText.indexOf('description:`', nameIdx);
    if (descIdx === -1 || descIdx > nameIdx + 600) { pos = nameIdx + 1; continue; }
    const descStart = descIdx + 13;
    const descEnd   = jsText.indexOf('`', descStart);
    const description = jsText.substring(descStart, descEnd);

    // Find inputSchema and count braces to get the full object
    const schemaKeyIdx = jsText.indexOf('inputSchema:', nameIdx);
    if (schemaKeyIdx === -1 || schemaKeyIdx > nameIdx + 2000) { pos = nameIdx + 1; continue; }
    const schemaStart = jsText.indexOf('{', schemaKeyIdx);
    let depth = 0, schemaEnd = schemaStart;
    for (let i = schemaStart; i < Math.min(jsText.length, schemaStart + 3000); i++) {
      if      (jsText[i] === '{') depth++;
      else if (jsText[i] === '}') { depth--; if (depth === 0) { schemaEnd = i + 1; break; } }
    }
    const schemaStr = jsText.substring(schemaStart, schemaEnd)
      .replace(/`([^`]*)`/g, '"$1"')       // backtick → double quotes
      .replace(/([{,])(\s*)(\w+):/g, '$1$2"$3":')  // unquoted keys
      .replace(/enum:\w+/g, 'enum:[]')      // variable enum refs
      .replace(/,\s*([}\]])/g, '$1');       // trailing commas

    let schema = null;
    try { schema = JSON.parse(schemaStr); } catch (_) {}

    const parameters = [];
    if (schema?.properties) {
      for (const [pname, pdef] of Object.entries(schema.properties)) {
        parameters.push({
          name:        pname,
          description: pdef.description || '',
          type:        pdef.type        || 'string',
          required:    (schema.required || []).includes(pname),
          ...(pdef.enum ? { options: pdef.enum.map(v => ({ value: v, label: v })) } : {}),
        });
      }
    }

    // Try to extract the navigation URL pattern from the execute function
    const executeIdx = jsText.indexOf('execute:', schemaEnd);
    let action = null;
    if (executeIdx !== -1 && executeIdx < schemaEnd + 400) {
      const snip = jsText.substring(executeIdx, executeIdx + 400);
      // Look for quoted path starting with /
      const urlMatch = snip.match(/['"` ](\/?[a-zA-Z0-9_/-]+\??[^'"` ]{0,60})['"` ]/);
      if (urlMatch && urlMatch[1].startsWith('/')) {
        try { action = new URL(urlMatch[1].split('?')[0], pageUrl).href; } catch (_) {}
      }
    }

    if (name) {
      tools.push({ name, description, parameters, tag: 'script', action, method: 'GET', source: 'imperative' });
    }
    pos = nameEnd + 1;
  }
  return tools;
}

// ──────────────────────────────────────────────
//  WebMCP Detection
// ──────────────────────────────────────────────
async function detectWebMCP(doc, html, pageUrl) {
  const tools = [];

  // 1. Declarative API — elements with mcp-tool / data-mcp-tool attributes
  const mcpEls = doc.querySelectorAll('[mcp-tool], [data-mcp-tool]');
  mcpEls.forEach((el) => {
    const name        = el.getAttribute('mcp-name')        || el.getAttribute('data-mcp-name')        || el.getAttribute('id') || 'tool';
    const description = el.getAttribute('mcp-description') || el.getAttribute('data-mcp-description') || '';
    const method      = (el.getAttribute('method') || 'GET').toUpperCase();
    const action      = el.getAttribute('action') || el.getAttribute('href') || null;

    const params = [];
    el.querySelectorAll('input, select, textarea, [mcp-parameter], [data-mcp-parameter]').forEach((p) => {
      // Skip non-data inputs
      const ptype = (p.getAttribute('type') || 'text').toLowerCase();
      if (['submit', 'button', 'reset', 'image'].includes(ptype)) return;

      const pname    = p.getAttribute('name') || p.getAttribute('id') || p.getAttribute('mcp-name') || 'value';
      const pdesc    = p.getAttribute('mcp-description') || p.getAttribute('data-mcp-description')
                       || p.getAttribute('placeholder') || p.getAttribute('aria-label')
                       || p.getAttribute('title') || '';
      const required = p.hasAttribute('required') || p.getAttribute('mcp-required') === 'true';
      const min      = p.getAttribute('min')       || p.getAttribute('minlength')  || null;
      const max      = p.getAttribute('max')       || p.getAttribute('maxlength')  || null;
      const pattern  = p.getAttribute('pattern')   || null;

      // Enumerate <select> choices
      let options = null;
      if (p.tagName.toLowerCase() === 'select') {
        options = Array.from(p.querySelectorAll('option'))
          .filter(o => o.value)
          .map(o => ({ value: o.value, label: o.textContent.trim() }));
      }

      // Nearest <label> for extra context
      let label = '';
      const labelEl = p.id ? doc.querySelector(`label[for="${p.id}"]`) : null;
      if (labelEl) label = labelEl.textContent.trim();

      params.push({
        name: pname,
        description: pdesc || label,
        type: ptype,
        required,
        ...(options  ? { options }  : {}),
        ...(min      ? { min }      : {}),
        ...(max      ? { max }      : {}),
        ...(pattern  ? { pattern }  : {}),
      });
    });

    tools.push({ name, description, parameters: params, tag: el.tagName.toLowerCase(), action, method });
  });

  // 1b. Alternative declarative style: toolname / tooldescription / toolparamdescription
  //     (used by the Google Chrome Labs WebMCP French Bistro demo)
  if (tools.length === 0) {
    doc.querySelectorAll('[toolname], [data-toolname]').forEach((el) => {
      const name        = el.getAttribute('toolname')        || el.getAttribute('data-toolname')        || el.getAttribute('id') || 'tool';
      const description = el.getAttribute('tooldescription') || el.getAttribute('data-tooldescription') || '';
      const method      = (el.getAttribute('method') || 'GET').toUpperCase();
      const action      = el.getAttribute('action') || el.getAttribute('href') || null;

      const params = [];
      el.querySelectorAll('input, select, textarea').forEach((p) => {
        const ptype = (p.getAttribute('type') || 'text').toLowerCase();
        if (['submit', 'button', 'reset', 'image'].includes(ptype)) return;

        const pname    = p.getAttribute('name') || p.getAttribute('id') || 'value';
        const pdesc    = p.getAttribute('toolparamdescription') || p.getAttribute('data-toolparamdescription')
                         || p.getAttribute('placeholder') || p.getAttribute('aria-label') || p.getAttribute('title') || '';
        const required = p.hasAttribute('required');
        const min      = p.getAttribute('min') || p.getAttribute('minlength') || null;
        const max      = p.getAttribute('max') || p.getAttribute('maxlength') || null;

        let options = null;
        if (p.tagName.toLowerCase() === 'select') {
          options = Array.from(p.querySelectorAll('option'))
            .filter(o => o.value)
            .map(o => ({ value: o.value, label: o.textContent.trim() }));
        }

        const labelEl = p.id ? doc.querySelector(`label[for="${p.id}"]`) : null;
        const label   = labelEl ? labelEl.textContent.trim() : '';

        params.push({
          name: pname,
          description: pdesc || label,
          type: ptype,
          required,
          ...(options ? { options } : {}),
          ...(min     ? { min }     : {}),
          ...(max     ? { max }     : {}),
        });
      });

      tools.push({ name, description, parameters: params, tag: el.tagName.toLowerCase(), action, method });
    });
  }

  // 2. Imperative API — scan scripts for WebMCP usage
  const lc = html.toLowerCase();
  const imperative =
    lc.includes('navigator.modelcontext') ||
    lc.includes('__webmcp') ||
    lc.includes('registertool') ||
    (lc.includes('webmcp') && lc.includes('tool'));

  // 3. Meta declaration
  const meta = !!doc.querySelector('meta[name="webmcp"], meta[name="mcp"]');

  // 2b. If imperative but no tools yet — fetch JS bundles and extract tool schemas
  if (tools.length === 0 && imperative && pageUrl) {
    const scriptEls = Array.from(doc.querySelectorAll('script[src]'));
    for (const el of scriptEls) {
      const src = el.getAttribute('src');
      if (!src) continue;
      try {
        const scriptUrl = new URL(src, pageUrl).href;
        const r = await fetch(scriptUrl, { timeout: 12000, headers: { 'User-Agent': 'BuzzVoice/1.0' } });
        if (!r.ok) continue;
        const jsText = await r.text();
        const extracted = extractImperativeTools(jsText, pageUrl);
        if (extracted.length > 0) {
          tools.push(...extracted);
          break; // found tools — stop scanning more scripts
        }
      } catch (_) { /* skip unreadable scripts */ }
    }
  }

  const compliant = mcpEls.length > 0 || (doc.querySelectorAll('[toolname]').length > 0) || imperative || meta || tools.length > 0;
  const source    = tools.length > 0 && tools[0].source === 'imperative' ? 'imperative'
                  : mcpEls.length > 0 || doc.querySelectorAll('[toolname]').length > 0 ? 'declarative'
                  : imperative ? 'imperative' : meta ? 'meta' : 'none';

  return { compliant, tools, source };
}

// ──────────────────────────────────────────────
//  Grok Tool-Call — POST /api/grok-tool-call
//  Maps user voice text to a WebMCP tool+params
// ──────────────────────────────────────────────
app.post('/api/grok-tool-call', async (req, res) => {
  try {
    const { text, tools, pageUrl, pageTitle } = req.body;
    if (!text || !tools?.length) return res.status(400).json({ error: 'text and tools required' });

    // Build a compact but complete schema description for Grok
    const toolSchemas = tools.map(t => ({
      name: t.name,
      description: t.description,
      method: t.method || 'GET',
      action: t.action,
      parameters: t.parameters.map(p => ({
        name: p.name,
        description: p.description,
        type: p.type,
        required: p.required,
        ...(p.options  ? { options: p.options }   : {}),
        ...(p.min      ? { min: p.min }            : {}),
        ...(p.max      ? { max: p.max }            : {}),
        ...(p.pattern  ? { pattern: p.pattern }    : {}),
      }))
    }));

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${XAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'grok-3-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a voice browser assistant that fills web forms from spoken user input. '
              + 'The user has spoken a command and you must identify the best matching WebMCP tool and provide a value for EVERY parameter it defines. '
              + 'Rules:\n'
              + '- You MUST return a value for every parameter, even if you must infer a reasonable default.\n'
              + '- For "select" parameters, choose a value from the provided options list.\n'
              + '- For date parameters, use ISO 8601 format (YYYY-MM-DD). Today is ' + new Date().toISOString().slice(0,10) + '.\n'
              + '- For time parameters, use HH:MM (24h) format.\n'
              + '- For number parameters, return a plain integer or decimal.\n'
              + '- If the user did not specify a value for a field, infer the most reasonable value from context or use a sensible default.\n'
              + 'Respond ONLY with a valid JSON object in this exact shape: '
              + '{ "tool": "<tool_name>", "method": "GET|POST", "params": { "<field_name>": "<value>", ... }, "reply": "<short spoken confirmation of what you are submitting>" }. '
              + 'If no tool matches, set "tool" to null.',
          },
          {
            role: 'user',
            content:
              `Page: ${pageTitle} (${pageUrl})\n`
              + `User said: "${text}"\n\n`
              + `Available WebMCP tools:\n${JSON.stringify(toolSchemas, null, 2)}`,
          },
        ],
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const content = JSON.parse(data.choices[0].message.content);
    res.json(content);
  } catch (e) {
    console.error('grok-tool-call error:', e);
    res.status(500).json({ error: e.message });
  }
});

function extractLinks(document, baseUrl) {
  const links = [];
  const anchors = document.querySelectorAll('a[href]');
  const seen = new Set();

  anchors.forEach((a, i) => {
    if (links.length >= 20) return;
    const text = a.textContent?.trim();
    let href = a.getAttribute('href');
    if (!text || text.length < 2 || !href) return;
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return;

    try {
      href = new URL(href, baseUrl).href;
    } catch { return; }

    if (seen.has(href)) return;
    seen.add(href);

    links.push({ index: links.length + 1, text: text.substring(0, 80), url: href });
  });

  return links;
}

// ──────────────────────────────────────────────
//  Fallback — serve index.html for SPA
// ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  🎙️  BuzzVoice Audio Browser`);
  console.log(`  ──────────────────────────`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  xAI API key: ${XAI_API_KEY.substring(0, 8)}...${XAI_API_KEY.substring(XAI_API_KEY.length - 4)}`);
  console.log(`  Ready for voice browsing!\n`);
});
