import { WritableStream } from 'node:stream/web';

/*
 * Konfigurasi API:
 * bodyParser: false diperlukan agar kita bisa men-stream body request (mis. POST)
 * ke upstream tanpa di-parse oleh Next.js.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Konfigurasi Lingkungan (ENV) ---
const MAX_JSON_SIZE_BYTES = parseInt(process.env.MAX_JSON_SIZE_BYTES || '2097152', 10); // 2MB
const UPSTREAM_BASE = 'https://www.sankavollerei.com/comic';
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn'; // 'info', 'warn', 'error'

// --- Header CORS ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Origin, Accept',
};

// --- Logika Rate Limiting (In-Memory, Best-Effort di Serverless) ---
// Note: Ini akan efektif pada "warm instance". Cold start akan me-reset state ini.
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '60', 10);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const ipRequestCounts = new Map();

function getIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip) {
  if (LOG_LEVEL === 'info') console.info(`[RateLimit] Checking IP: ${ip}`);
  const now = Date.now();
  const requests = ipRequestCounts.get(ip) || [];
  
  // Filter request lama
  const recentRequests = requests.filter(timestamp => (now - timestamp) < RATE_LIMIT_WINDOW_MS);
  
  if (recentRequests.length >= RATE_LIMIT_PER_MIN) {
    if (LOG_LEVEL === 'warn') console.warn(`[RateLimit] Limit exceeded for IP: ${ip}`);
    return true;
  }
  
  recentRequests.push(now);
  ipRequestCounts.set(ip, recentRequests);
  return false;
}
// --- Akhir Rate Limiting ---


// --- Logika Rewrite URL ---
const IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|webp|avif|gif|svg)(\?.*)?$/i;
const UPLOAD_HEURISTICS = /(\/uploads\/|\/wp-content\/uploads\/)/i;

/**
 * Melakukan traversal rekursif pada objek/array untuk me-rewrite URL gambar.
 * Memodifikasi objek secara langsung (in-place).
 * @param {any} obj - Objek atau array yang akan di-traverse.
 * @param {string} upstreamOrigin - Origin dari upstream (mis. https://www.sankavollerei.com)
 */
function recursiveRewrite(obj, upstreamOrigin) {
  if (Array.isArray(obj)) {
    for (const item of obj) {
      recursiveRewrite(item, upstreamOrigin);
    }
  } else if (typeof obj === 'object' && obj !== null) {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const value = obj[key];

        if (typeof value === 'string') {
          let originalUrl = value;
          let needsRewrite = false;

          // 1. Tangani URL relatif (mis. /uploads/...)
          if (originalUrl.startsWith('/')) {
            originalUrl = upstreamOrigin + originalUrl;
            // Asumsikan URL relatif yang mengandung heuristik perlu di-proxy
            if (UPLOAD_HEURISTICS.test(originalUrl)) {
              needsRewrite = true;
            }
          }
          
          // 2. Tangani URL absolut
          if (originalUrl.startsWith('http://') || originalUrl.startsWith('https://')) {
            if (IMAGE_EXTENSIONS.test(originalUrl) || UPLOAD_HEURISTICS.test(originalUrl)) {
              needsRewrite = true;
            }
          }

          // 3. Lakukan rewrite jika diperlukan
          if (needsRewrite) {
            try {
              // Pastikan URL valid sebelum di-encode
              new URL(originalUrl); // Melempar error jika tidak valid
              obj[key] = `/api/proxy-img?url=${encodeURIComponent(originalUrl)}`;
            } catch (e) {
              if (LOG_LEVEL === 'warn') console.warn(`[Rewrite] Skipping invalid URL: ${originalUrl}`);
            }
          }
        } else if (typeof value === 'object' && value !== null) {
          // Lanjut rekursif
          recursiveRewrite(value, upstreamOrigin);
        }
      }
    }
  }
}
// --- Akhir Logika Rewrite ---

/**
 * Men-stream response dari upstream ke client.
 * @param {Response} upstreamResponse - Response dari fetch()
 * @param {import('http').ServerResponse} res - Response server (Node.js)
 * @param {Record<string, string>} extraHeaders - Header tambahan
 */
async function streamPassthrough(upstreamResponse, res, extraHeaders = {}) {
  const headers = { ...CORS_HEADERS, ...extraHeaders };
  headers['Content-Type'] = upstreamResponse.headers.get('content-type') || 'application/octet-stream';
  
  if (upstreamResponse.headers.has('content-length')) {
      headers['Content-Length'] = upstreamResponse.headers.get('content-length');
  }

  res.writeHead(upstreamResponse.status, headers);

  if (upstreamResponse.body) {
    try {
      // Pipe Web API ReadableStream ke Node.js WritableStream (res)
      await upstreamResponse.body.pipeTo(new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
        abort(err) {
          console.error('[Proxy] Stream passthrough aborted:', err);
          res.end();
        }
      }));
    } catch (streamError) {
      console.error('[Proxy] Stream passthrough error:', streamError);
      res.end();
    }
  } else {
    res.end();
  }
}


// --- Handler Utama ---
export default async function handler(req, res) {
  // 1. Handle Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  // 2. Cek Rate Limit
  const ip = getIp(req);
  if (isRateLimited(ip)) {
    res.writeHead(429, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Rate limit exceeded', code: 429 }));
    return;
  }

  // 3. Ambil path dari query (hasil rewrite vercel.json)
  // req.url akan menjadi /api/proxy?rest=komikstation/home
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const restPath = searchParams.get('rest');

  // 4. Validasi Endpoint
  if (!restPath || !restPath.startsWith('komikstation/')) {
    if (LOG_LEVEL === 'warn') console.warn(`[Proxy] Invalid endpoint: ${restPath}`);
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid endpoint. Must start with komikstation/', code: 400 }));
    return;
  }

  const targetUrl = `${UPSTREAM_BASE}/${restPath}`;
  const upstreamOrigin = new URL(targetUrl).origin;
  if (LOG_LEVEL === 'info') console.info(`[Proxy] Fetching: ${req.method} ${targetUrl}`);

  try {
    // 5. Opsi Fetch
    const fetchOptions = {
      method: req.method,
      headers: {
        'User-Agent': 'KynayMicProxy/1.0',
        'Accept': 'application/json, text/*, */*',
        // Forward 'Authorization' jika ada
        ...(req.headers.authorization && { 'Authorization': req.headers.authorization }),
      },
      redirect: 'follow',
    };

    // 6. Handle body (POST/PUT passthrough)
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['content-type']) {
      fetchOptions.headers['Content-Type'] = req.headers['content-type'];
      fetchOptions.body = req; // Stream Node.js IncomingMessage
      fetchOptions.duplex = 'half'; // Diperlukan untuk stream body di Node fetch
    }

    // 7. Fetch Upstream
    const upstreamResponse = await fetch(targetUrl, fetchOptions);

    // 8. Cek Tipe Konten
    const upstreamContentType = upstreamResponse.headers.get('content-type') || '';

    if (upstreamContentType.includes('application/json')) {
      // 9. Handle JSON: Buffer, Cek Ukuran, Parse, Rewrite
      
      // Buffer manual untuk cek ukuran
      const text = await upstreamResponse.text();
      const size = Buffer.byteLength(text, 'utf8');

      if (size > MAX_JSON_SIZE_BYTES) {
        if (LOG_LEVEL === 'error') console.error(`[Proxy] JSON size (${size} bytes) exceeds limit (${MAX_JSON_SIZE_BYTES}) for ${targetUrl}`);
        // Kirim response error
        res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Upstream response too large to parse', code: 502, rewrote: false }));
        return;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // Upstream bilang JSON tapi bukan JSON valid
        if (LOG_LEVEL === 'error') console.error(`[Proxy] Failed to parse JSON from ${targetUrl}:`, e.message);
        // Kembalikan sebagai text/plain
        await streamPassthrough(new Response(text, upstreamResponse), res, { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      // 10. Lakukan Rewrite
      recursiveRewrite(data, upstreamOrigin);

      // 11. Kirim JSON yang sudah di-rewrite
      res.writeHead(upstreamResponse.status, { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));

    } else {
      // 12. Handle Non-JSON: Stream (Passthrough)
      if (LOG_LEVEL === 'info') console.info(`[Proxy] Streaming non-JSON passthrough for ${targetUrl} (Content-Type: ${upstreamContentType})`);
      await streamPassthrough(upstreamResponse, res);
    }

  } catch (error) {
    console.error(`[Proxy] Fatal error fetching ${targetUrl}:`, error);
    res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to fetch from upstream', code: 502, details: error.message }));
  }
}
