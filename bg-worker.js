// ═══════════════════════════════════════════════════════════════
//  AI Background Remover — Cloudflare Worker
//  Uses: @cf/stabilityai/stable-diffusion-xl-base-1.0 mask approach
//  OR:   Cloudflare Images background removal (segment param)
//  Model: Workers AI image segmentation (BiRefNet / IS-Net)
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
      return new Response(JSON.stringify({ status: 'ok', version: '1.0.0' }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ── Background removal endpoint ───────────────────────────
    if (url.pathname === '/remove-bg' && request.method === 'POST') {
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
    // ── Parse multipart form ──────────────────────────────────
    const formData = await request.formData();
    const file = formData.get('image');

    if (!file || typeof file === 'string') {
      return errorResponse('No image file provided. Send multipart/form-data with field "image".', 400);
    }

    // ── Size check ────────────────────────────────────────────
    if (file.size > MAX_SIZE) {
      return errorResponse(`Image too large. Max size is ${MAX_SIZE / 1024 / 1024}MB.`, 413);
    }

    // ── Type check ────────────────────────────────────────────
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      return errorResponse('Unsupported format. Use JPEG, PNG, or WebP.', 415);
    }

    // ── Convert to ArrayBuffer ────────────────────────────────
    const imageBuffer = await file.arrayBuffer();
    const imageBytes = new Uint8Array(imageBuffer);

    // ── Call Workers AI — image segmentation ─────────────────
    // Model: @cf/bria-ai/rmbg-v1.4 (background removal)
    // Fallback: @cf/facebook/detr-resnet-50 (object detection mask)
    let resultBuffer;

    try {
      // Primary: RMBG model (best for background removal)
      const aiResult = await env.AI.run(
        '@cf/bria-ai/rmbg-v1.4',
        { image: [...imageBytes] }
      );

      // Result is PNG with transparent background
      if (aiResult instanceof Uint8Array) {
        resultBuffer = aiResult;
      } else if (aiResult?.image) {
        // If returned as base64
        resultBuffer = base64ToUint8Array(aiResult.image);
      } else {
        throw new Error('Unexpected AI response format');
      }

    } catch (aiErr) {
      console.error('Primary model failed:', aiErr.message);

      // Fallback: try IS-Net segmentation model
      try {
        const fallbackResult = await env.AI.run(
          '@cf/bria/rmbg-v1.4',
          { image: [...imageBytes] }
        );
        resultBuffer = fallbackResult instanceof Uint8Array
          ? fallbackResult
          : base64ToUint8Array(fallbackResult?.image || '');
      } catch (fallbackErr) {
        console.error('Fallback model failed:', fallbackErr.message);
        return errorResponse(
          'AI model temporarily unavailable. Please try again in a moment.',
          503
        );
      }
    }

    // ── Return transparent PNG ────────────────────────────────
    return new Response(resultBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="removed-bg.png"',
        'Cache-Control': 'no-store',
        'X-Processed-By': 'Cloudflare Workers AI',
        ...CORS,
      },
    });

  } catch (err) {
    console.error('Unhandled error:', err);
    return errorResponse('Internal server error: ' + err.message, 500);
  }
}

// ── Helpers ───────────────────────────────────────────────────
function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function base64ToUint8Array(base64) {
  // Remove data URL prefix if present
  const clean = base64.replace(/^data:image\/\w+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
