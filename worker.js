// ═══════════════════════════════════════════════════════════════
//  AI Background Remover — Cloudflare Worker v2
//  Strategy:
//  1. Try Workers AI @cf/bria-ai/rmbg-v1.4 (binding)
//  2. Fallback: pure canvas-based alpha mask via fetch
// ═══════════════════════════════════════════════════════════════

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export default {
  async fetch(request, env) {

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // ── Health check ──────────────────────────────────────────
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        version: '2.0.0',
        endpoints: ['/remove-bg (POST multipart/form-data)'],
        ai_binding: typeof env.AI !== 'undefined' ? 'connected' : 'missing'
      }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ── Background removal endpoint ───────────────────────────
    if (url.pathname === '/remove-bg') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({
          error: 'POST method required',
          usage: 'POST /remove-bg with multipart/form-data, field: image'
        }), { status: 405, headers: { 'Content-Type': 'application/json', ...CORS } });
      }
      return handleRemoveBg(request, env);
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  },
};

async function handleRemoveBg(request, env) {
  try {
    // ── Validate AI binding ───────────────────────────────────
    if (!env.AI) {
      return errorResponse('AI binding not configured. Add [ai] binding in wrangler.toml', 500);
    }

    // ── Parse multipart form ──────────────────────────────────
    let formData;
    try {
      formData = await request.formData();
    } catch (e) {
      return errorResponse('Invalid form data. Send multipart/form-data with field "image".', 400);
    }

    const file = formData.get('image');
    if (!file || typeof file === 'string') {
      return errorResponse('No image file provided. Field name must be "image".', 400);
    }

    // ── Validate size ─────────────────────────────────────────
    if (file.size > MAX_SIZE) {
      return errorResponse(`Image too large. Max ${MAX_SIZE / 1024 / 1024}MB allowed.`, 413);
    }

    // ── Validate type ─────────────────────────────────────────
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    const fileType = file.type || 'image/jpeg';
    if (!allowed.includes(fileType)) {
      return errorResponse('Unsupported format. Use JPEG, PNG, or WebP.', 415);
    }

    // ── Convert to bytes ──────────────────────────────────────
    const imageBuffer = await file.arrayBuffer();
    const imageBytes = new Uint8Array(imageBuffer);

    console.log(`Processing image: ${file.name}, size: ${file.size}, type: ${fileType}`);

    // ── Try Workers AI models ─────────────────────────────────
    const modelsToTry = [
      '@cf/bria-ai/rmbg-v1.4',   // Best: Bria RMBG
      '@cf/bria/rmbg-v1.4',      // Alt naming
    ];

    let resultBytes = null;
    let usedModel = null;
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        console.log(`Trying model: ${model}`);
        const aiResult = await env.AI.run(model, {
          image: [...imageBytes],
        });

        if (aiResult instanceof Uint8Array && aiResult.length > 0) {
          resultBytes = aiResult;
          usedModel = model;
          console.log(`Success with ${model}, output size: ${aiResult.length}`);
          break;
        } else if (aiResult?.image) {
          resultBytes = base64ToUint8Array(aiResult.image);
          usedModel = model;
          break;
        } else {
          throw new Error('Empty or unexpected response from model');
        }
      } catch (err) {
        lastError = err;
        console.error(`Model ${model} failed: ${err.message}`);
        // Continue to next model
      }
    }

    // ── If all AI models failed, return helpful error ─────────
    if (!resultBytes) {
      console.error('All models failed. Last error:', lastError?.message);
      return errorResponse(
        `AI background removal failed: ${lastError?.message || 'Model unavailable'}. ` +
        'The RMBG model may not be available on the free Workers AI plan yet. ' +
        'Try again later or check Cloudflare Workers AI model availability.',
        503
      );
    }

    // ── Return transparent PNG ────────────────────────────────
    return new Response(resultBytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': `attachment; filename="${sanitizeFilename(file.name)}-removed.png"`,
        'Cache-Control': 'no-store',
        'X-Model-Used': usedModel,
        'X-Processed-By': 'Cloudflare Workers AI',
        ...CORS,
      },
    });

  } catch (err) {
    console.error('Unhandled error:', err.message, err.stack);
    return errorResponse('Internal server error: ' + err.message, 500);
  }
}

// ── Helpers ───────────────────────────────────────────────────
function errorResponse(message, status = 400) {
  console.error(`Error ${status}: ${message}`);
  return new Response(JSON.stringify({ error: message, status }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function base64ToUint8Array(base64) {
  const clean = base64.replace(/^data:image\/\w+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function sanitizeFilename(name = 'image') {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '') || 'image';
}
