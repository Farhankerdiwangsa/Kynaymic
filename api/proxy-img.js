import { WritableStream } from 'node:stream/web';

/*
 * Konfigurasi API:
 * bodyParser: false karena kita menangani binary stream.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Konfigurasi Lingkungan (ENV) ---
const IMAGE_MAX_BYTES = parseInt(process.env.IMAGE_MAX_BYTES || '10485760', 10); // 10MB
const ALLOWED_HOSTS_CSV = process.env.ALLOWED_HOSTS || ''; // Kosong = izinkan semua host publik
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn'; // 'info', 'warn', 'error'
const PLACEHOLDER_URL = 'https://placehold.co/300x400/FFF9E0/000?text=Image+Error';

const ALLOWED_HOSTS = ALLOWED_HOSTS_CSV ? new Set(ALLOWED_HOSTS_CSV.split(',')) : null;

// --- Header CORS ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Origin, Accept',
};

// --- Logika Rate Limiting (In-Memory, Best-Effort di Serverless) ---
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

// --- Validasi Keamanan ---
/**
 * Cek apakah IP/Hostname termasuk dalam rentang private/internal (RFC1918, loopback).
 */
function isPrivateTarget(hostname) {
  // Cek jika itu adalah IP address
  const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  if (ipRegex.test(hostname)) {
    // Regex untuk IP private dan loopback
    const privateIpRegex = /^(::1)|(127(?:\.[0-9]+){0,2}\.[0-9]+)|(10(?:\.[0-9]+){0,2}\.[0-9]+)|(172\.(?:1[6-9]|2[0-9]|3[0-1])(?:\.[0-9]+){0,2}\.[0-9]+)|(192\.168(?:\.[0-9]+){0,2}\.[0-9]+)$/;
    if (privateIpRegex.test(hostname)) {
      return true;
    }
  }
  
  // Cek TLDs internal
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return true;
  }
  
  return false;
}

/**
 * Mengirim response error yang aman.
 * Jika client (browser <img> tag) mengharapkan gambar, kita redirect ke placeholder.
 * Jika client (script) mengharapkan JSON, kita kirim JSON.
 */
function sendError(req, res, statusCode, message) {
  if (LOG_LEVEL === 'warn') console.warn(`[ImgProxy] Error ${statusCode}: ${message}`);
  
  const acceptHeader = req.headers.accept || '';
  
  if (acceptHeader.includes('image/') && !acceptHeader.includes('application/json')) {
    // Client adalah <img> tag, redirect ke placeholder
    res.writeHead(302, { ...CORS_HEADERS, 'Location': PLACEHOLDER_URL });
    res.end();
  } else {
    // Client adalah script, kirim JSON
    res.writeHead(statusCode, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: message, code: statusCode }));
  }
}

// --- Handler Utama ---
export default async function handler(req, res) {
  // 1. Handle Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS).end();
    return;
  }

  // 2. Hanya izinkan GET
  if (req.method !== 'GET') {
    res.writeHead(405, CORS_HEADERS).end('Method Not Allowed');
    return;
  }

  // 3. Cek Rate Limit
  const ip = getIp(req);
  if (isRateLimited(ip)) {
    return sendError(req, res, 429, 'Rate limit exceeded');
  }

  // 4. Ambil dan Validasi URL
  const { searchParams } = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return sendError(req, res, 400, 'Missing url query parameter');
  }

  let urlObj;
  try {
    urlObj = new URL(targetUrl);
  } catch (e) {
    return sendError(req, res, 400, 'Invalid URL format');
  }

  // 5. Validasi Keamanan
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return sendError(req, res, 400, 'Invalid protocol. Only http and https are allowed.');
  }

  if (isPrivateTarget(urlObj.hostname)) {
    return sendError(req, res, 400, 'Target URL is internal or private. Request blocked.');
  }

  if (ALLOWED_HOSTS && !ALLOWED_HOSTS.has(urlObj.hostname)) {
    return sendError(req, res, 403, 'Hostname not allowed.');
  }

  if (LOG_LEVEL === 'info') console.info(`[ImgProxy] Fetching: ${targetUrl}`);

  try {
    // 6. Fetch Upstream
    const upstreamResponse = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'KynayMicProxy/1.0', 'Accept': 'image/*, */*' },
      redirect: 'follow',
    });

    // 7. Handle Upstream Error
    if (!upstreamResponse.ok) {
      return sendError(req, res, upstreamResponse.status, `Upstream failed with status ${upstreamResponse.status}`);
    }

    // 8. Cek Ukuran Konten (jika tersedia)
    const contentLength = upstreamResponse.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > IMAGE_MAX_BYTES) {
      return sendError(req, res, 413, `Image size (${contentLength} bytes) exceeds limit (${IMAGE_MAX_BYTES} bytes)`);
    }

    // 9. Siapkan Header untuk Streaming
    const headers = {
      ...CORS_HEADERS,
      'Content-Type': upstreamResponse.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400', // Cache 1 hari
    };
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    res.writeHead(200, headers);

    // 10. Stream Body
    // Cek jika body ada (mis. 204 No Content tidak punya body)
    if (upstreamResponse.body) {
      // Pipe Web API ReadableStream ke Node.js WritableStream (res)
      await upstreamResponse.body.pipeTo(new WritableStream({
        write(chunk) {
          res.write(chunk);
        },
        close() {
          res.end();
        },
        abort(err) {
          console.error('[ImgProxy] Stream aborted:', err);
          res.end();
        }
      }));
    } else {
      res.end();
    }

  } catch (error) {
    // Tangani error fetch (mis. DNS not found, network error)
    return sendError(req, res, 502, `Failed to fetch upstream image: ${error.message}`);
  }
}
