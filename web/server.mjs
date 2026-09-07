// Static host + Claude proxy for the prompt-driven Three.js world builder.
//
// The browser never sees the API key. It POSTs a prompt to /api/build and gets
// back a server-sent event stream: status, reasoning summary, and the generated
// JavaScript as Claude writes it.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const THREE_DIR = path.join(HERE, 'node_modules', 'three');

const PORT = Number(process.env.PORT || 5173);
const MODEL = process.env.MODEL || 'claude-opus-5';
// Effort trades build quality against how long the user stares at a spinner.
// "medium" keeps a prompt-to-pixels round trip interactive; raise it to "high"
// for more elaborate scenes.
const EFFORT = process.env.EFFORT || 'medium';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 32000);

const SYSTEM_PROMPT = await fs.readFile(path.join(HERE, 'prompts', 'system.md'), 'utf8');

const client = new Anthropic(); // reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ant profile

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

// ---------------------------------------------------------------- prompt build

const HISTORY_TURNS = 6;
const HISTORY_CODE_CHARS = 5000;

function buildMessages({ prompt, history = [], scene = '' }) {
  const messages = [];

  for (const turn of history.slice(-HISTORY_TURNS)) {
    if (!turn || typeof turn.prompt !== 'string') continue;
    messages.push({ role: 'user', content: turn.prompt });
    const code = typeof turn.code === 'string' ? turn.code : '';
    messages.push({
      role: 'assistant',
      content:
        code.length > HISTORY_CODE_CHARS
          ? `${code.slice(0, HISTORY_CODE_CHARS)}\n// ... (truncated)`
          : code || '// (no code)',
    });
  }

  messages.push({ role: 'user', content: `${prompt}\n\n${scene}`.trim() });
  return messages;
}

// Claude is told to emit raw JS, but strip fences defensively — one stray
// ```javascript would turn the whole build into a syntax error.
function stripFences(text) {
  let out = text.trim();
  const open = out.match(/^```[a-zA-Z]*\s*\n/);
  if (open) {
    out = out.slice(open[0].length);
    const close = out.lastIndexOf('```');
    if (close !== -1) out = out.slice(0, close);
  }
  return out.trim();
}

// ------------------------------------------------------------------- SSE plumbing

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': open\n\n');
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

async function handleBuild(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: 'malformed JSON body' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json(res, 400, { error: 'prompt is required' });
  if (prompt.length > 4000) return json(res, 400, { error: 'prompt too long' });

  const send = openStream(res);
  const started = Date.now();
  let code = '';
  let aborted = false;
  req.on('close', () => { aborted = true; });

  send('status', { phase: 'thinking', message: `${MODEL} · effort ${EFFORT}` });

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Adaptive thinking, surfaced as a summary so the HUD can narrate the
      // build while the user waits. Without `display` the summary is empty.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORT },
      // On a policy decline the API re-runs the request on a fallback model
      // inside the same call rather than returning nothing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: buildMessages({ prompt, history: body.history, scene: body.scene }),
    });

    let inText = false;
    for await (const event of stream) {
      if (aborted) { stream.abort(); return; }
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') {
          send('reasoning', { text: event.delta.thinking });
        } else if (event.delta.type === 'text_delta') {
          if (!inText) {
            inText = true;
            send('status', { phase: 'writing', message: 'generating scene code' });
          }
          code += event.delta.text;
          send('code', { text: event.delta.text });
        }
      }
    }

    const final = await stream.finalMessage();

    if (final.stop_reason === 'refusal') {
      send('error', {
        message: `declined: ${final.stop_details?.explanation || 'request refused'}`,
      });
      return res.end();
    }
    if (final.stop_reason === 'max_tokens') {
      send('warn', { message: `output hit the ${MAX_TOKENS} token cap — build may be partial` });
    }

    send('usage', {
      model: final.model,
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
      ms: Date.now() - started,
    });
    send('done', { code: stripFences(code) });
  } catch (err) {
    send('error', { message: describe(err) });
  } finally {
    res.end();
  }
}

function describe(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'authentication failed — check ANTHROPIC_API_KEY';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'rate limited — wait a moment and try again';
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `model "${MODEL}" not found for this key`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'cannot reach the Claude API — check the network';
  }
  if (err instanceof Anthropic.APIError) {
    return `Claude API ${err.status ?? ''}: ${err.message}`.replace(/\s+/, ' ');
  }
  return err?.message || String(err);
}

// ------------------------------------------------------------------ static files

async function serveFile(res, filePath) {
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// Resolve a URL path inside a root without letting `..` climb out of it.
function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

function json(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url.startsWith('/api/build')) {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    return handleBuild(req, res);
  }

  if (url.startsWith('/api/health')) {
    return json(res, 200, {
      ok: true,
      model: MODEL,
      effort: EFFORT,
      credentials: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    });
  }

  // three.js is served out of node_modules so the page has no CDN dependency.
  if (url.startsWith('/vendor/three/')) {
    const target = safeJoin(THREE_DIR, url.slice('/vendor/three'.length));
    if (target && (await serveFile(res, target))) return;
    return json(res, 404, { error: 'not found' });
  }

  const rel = url === '/' ? '/index.html' : url;
  const target = safeJoin(PUBLIC, rel);
  if (target && (await serveFile(res, target))) return;
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  const creds = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
  console.log(`\n  world builder  →  http://localhost:${PORT}`);
  console.log(`  model          →  ${MODEL} (effort ${EFFORT})`);
  if (!creds) {
    console.log('\n  ANTHROPIC_API_KEY is not set. Either export it, or run `ant auth login`');
    console.log('  — the SDK picks up a stored profile automatically.\n');
  } else {
    console.log('');
  }
});
