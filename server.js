const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Readable } = require('stream');
const { File: MegaFile } = require('megajs');

const app = express();
const PORT = process.env.PORT || 3000;

app.enable('trust proxy');
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const DEFAULT_SALT = process.env.GOFILE_SALT || '12af056dacea0b';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const DEFAULT_LANGUAGE = 'en-US';

const TOKEN_CACHE_FILE = path.join(__dirname, '.gofile_token');
let cachedGofileToken = process.env.GOFILE_TOKEN || null;
try {
  if (fs.existsSync(TOKEN_CACHE_FILE)) {
    const saved = fs.readFileSync(TOKEN_CACHE_FILE, 'utf8').trim();
    if (saved) cachedGofileToken = saved;
  }
} catch (_) {}

let currentGofileSalt = DEFAULT_SALT;
let cachedWtGenerator = null;
let wtScriptFetchTime = 0;

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Detects file service provider from URL
 */
function detectService(rawUrl) {
  if (!rawUrl) return null;
  const url = rawUrl.trim();

  if (/drive\.google\.com/i.test(url)) return 'gdrive';
  if (/mediafire\.com/i.test(url)) return 'mediafire';
  if (/mega\.nz/i.test(url)) return 'mega';
  if (/anonfilesnew\.com/i.test(url)) return 'anonfiles';
  if (/pixeldrain\.com/i.test(url)) return 'pixeldrain';
  if (/gofile\.io/i.test(url)) return 'gofile';

  // Check bare IDs
  if (/^[a-zA-Z0-9_-]{4,50}$/.test(url)) return 'gofile';

  return 'generic';
}

// -------------------------------------------------------------
// GOFILE RESOLVER
// -------------------------------------------------------------
function computeGofileWT(accountToken, salt = currentGofileSalt, userAgent = DEFAULT_USER_AGENT, lang = DEFAULT_LANGUAGE) {
  const timeWindow = Math.floor(Date.now() / 1000 / 14400).toString();
  const payload = `${userAgent}::${lang}::${accountToken || ''}::${timeWindow}::${salt}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function getDynamicGofileWT(token) {
  const now = Date.now();
  if (!cachedWtGenerator || now - wtScriptFetchTime > 3600000) {
    try {
      const res = await fetch('https://gofile.io/js/wt.obf.js', {
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });
      if (res.ok) {
        const scriptText = await res.text();
        const sandbox = {
          console,
          window: {},
          globalThis: {},
          self: {},
          document: { createElement: () => ({}) },
          navigator: { userAgent: DEFAULT_USER_AGENT },
          crypto: crypto.webcrypto || require('crypto').webcrypto,
        };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.self = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(scriptText, sandbox);
        if (typeof sandbox.generateWT === 'function') {
          cachedWtGenerator = sandbox.generateWT;
          wtScriptFetchTime = now;
        }
      }
    } catch (e) {
      console.warn('[Gofile] Dynamic WT fetch warning:', e.message);
    }
  }

  if (cachedWtGenerator) {
    try {
      return await cachedWtGenerator(token || '');
    } catch (e) {
      console.warn('[Gofile] Dynamic WT generation warning:', e.message);
    }
  }

  return computeGofileWT(token, currentGofileSalt);
}

async function getGofileAccountToken(customToken) {
  if (customToken && customToken.trim()) return customToken.trim();
  if (cachedGofileToken) return cachedGofileToken;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch('https://api.gofile.io/accounts', {
      method: 'POST',
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (data?.status === 'ok' && data?.data?.token) {
      cachedGofileToken = data.data.token;
      try { fs.writeFileSync(TOKEN_CACHE_FILE, cachedGofileToken, 'utf8'); } catch (_) {}
      return cachedGofileToken;
    }
  } catch (err) {
    console.warn('[Gofile] Account creation fallback:', err.message);
  }
  return cachedGofileToken || null;
}

function parseGofileUrl(input) {
  const storeMatch = input.match(/https?:\/\/([^/]+\.gofile\.io)\/download\/(?:(?:web|direct)\/)?([a-zA-Z0-9_-]+)(?:\/([^?#]+))?/i);
  if (storeMatch) {
    return {
      type: 'store_url',
      server: storeMatch[1],
      contentId: storeMatch[2],
      filename: storeMatch[3] ? decodeURIComponent(storeMatch[3]) : 'downloaded_file',
      originalUrl: input,
    };
  }
  const dMatch = input.match(/gofile\.io\/d\/([a-zA-Z0-9_-]+)/i);
  if (dMatch) return { type: 'content_id', contentId: dMatch[1] };
  if (/^[a-zA-Z0-9_-]{4,50}$/.test(input)) return { type: 'content_id', contentId: input };
  return null;
}

async function resolveGofile(url, password, customToken, baseUrl) {
  const parsed = parseGofileUrl(url);
  if (!parsed) throw new Error('Invalid Gofile URL format.');

  const token = await getGofileAccountToken(customToken);

  if (parsed.type === 'store_url') {
    let probeSize = null;
    let effectiveName = parsed.filename;
    try {
      let probeRes = await fetch(parsed.originalUrl, {
        method: 'HEAD',
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          Referer: 'https://gofile.io/',
          ...(token ? { Cookie: `accountToken=${token}`, Authorization: `Bearer ${token}` } : {})
        },
        redirect: 'follow',
      });
      if (!probeRes || !probeRes.ok) {
        probeRes = await fetch(parsed.originalUrl, {
          method: 'GET',
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            Referer: 'https://gofile.io/',
            Range: 'bytes=0-0',
            ...(token ? { Cookie: `accountToken=${token}`, Authorization: `Bearer ${token}` } : {})
          },
          redirect: 'follow',
        });
      }
      if (probeRes && (probeRes.ok || probeRes.status === 206)) {
        const cl = probeRes.headers.get('content-length');
        const cr = probeRes.headers.get('content-range');
        if (cr) {
          const totalMatch = cr.match(/\/(\d+)/);
          if (totalMatch) probeSize = parseInt(totalMatch[1], 10);
        } else if (cl) {
          probeSize = parseInt(cl, 10);
        }
        const cd = probeRes.headers.get('content-disposition');
        if (cd && cd.includes('filename=')) {
          const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
          if (fnMatch) effectiveName = decodeURIComponent(fnMatch[1]);
        }
      }
    } catch (_) {}

    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
    const streamUrl = `${baseUrl}/api/stream?service=gofile&url=${encodeURIComponent(parsed.originalUrl)}&name=${encodeURIComponent(effectiveName)}${tokenQuery}`;

    return {
      id: parsed.contentId,
      service: 'Gofile',
      type: 'file',
      name: effectiveName,
      size: probeSize,
      rawSize: probeSize,
      sizeFormatted: probeSize ? formatBytes(probeSize) : 'Direct Stream',
      mimetype: 'application/octet-stream',
      rawLink: parsed.originalUrl,
      directStreamUrl: streamUrl,
      curlCommand: `curl -L -O "${streamUrl}"`,
    };
  }

  const contentId = parsed.contentId;
  const wt = await getDynamicGofileWT(token);
  const queryParams = new URLSearchParams({ page: '1', pageSize: '100', sortField: 'name', sortDirection: '1' });
  if (password && password.trim()) {
    queryParams.set('password', crypto.createHash('sha256').update(password.trim()).digest('hex'));
  }

  const apiUrl = `https://api.gofile.io/contents/${encodeURIComponent(contentId)}?${queryParams.toString()}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const apiHeaders = {
    'X-BL': DEFAULT_LANGUAGE,
    'User-Agent': DEFAULT_USER_AGENT,
    Accept: 'application/json',
  };
  if (token) apiHeaders['Authorization'] = `Bearer ${token}`;
  if (wt) apiHeaders['X-Website-Token'] = wt;

  const apiRes = await fetch(apiUrl, {
    headers: apiHeaders,
    signal: controller.signal,
  });
  clearTimeout(timeout);

  const result = await apiRes.json();
  if (result?.status !== 'ok') {
    throw new Error(`Gofile API returned: ${result?.status || 'Error'}`);
  }

  const itemData = result.data;
  const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';

  if (itemData.type === 'file') {
    const streamUrl = `${baseUrl}/api/stream?service=gofile&url=${encodeURIComponent(itemData.link)}&name=${encodeURIComponent(itemData.name)}${tokenQuery}`;
    return {
      id: itemData.id,
      service: 'Gofile',
      type: 'file',
      name: itemData.name,
      size: itemData.size,
      rawSize: itemData.size,
      sizeFormatted: formatBytes(itemData.size),
      mimetype: itemData.mimetype || 'application/octet-stream',
      rawLink: itemData.link,
      directStreamUrl: streamUrl,
      curlCommand: `curl -L -O "${streamUrl}"`,
    };
  }

  // Folder
  const files = [];
  const children = itemData.children || {};
  for (const childId of Object.keys(children)) {
    const child = children[childId];
    if (child.type === 'file') {
      const streamUrl = `${baseUrl}/api/stream?service=gofile&url=${encodeURIComponent(child.link)}&name=${encodeURIComponent(child.name)}${tokenQuery}`;
      files.push({
        id: child.id,
        name: child.name,
        size: child.size,
        rawSize: child.size,
        sizeFormatted: formatBytes(child.size),
        mimetype: child.mimetype || 'application/octet-stream',
        directStreamUrl: streamUrl,
        curlCommand: `curl -L -O "${streamUrl}"`,
      });
    }
  }

  // If folder contains only 1 file, promote it for seamless single-click remote upload & stream
  if (files.length === 1) {
    const single = files[0];
    return {
      id: single.id,
      service: 'Gofile',
      type: 'file',
      name: single.name,
      size: single.size,
      rawSize: single.rawSize,
      sizeFormatted: single.sizeFormatted,
      mimetype: single.mimetype,
      directStreamUrl: single.directStreamUrl,
      curlCommand: single.curlCommand,
      folderName: itemData.name || 'Folder',
      files,
    };
  }

  return {
    id: itemData.id,
    service: 'Gofile',
    type: 'folder',
    name: itemData.name || 'Folder',
    files,
  };
}

// -------------------------------------------------------------
// COOKIE JAR HELPER
// -------------------------------------------------------------
class CookieJar {
  constructor(initialCookies = '') {
    this.cookies = new Map();
    if (initialCookies) {
      this.parseAndAdd(initialCookies);
    }
  }

  parseAndAdd(cookieStr) {
    if (!cookieStr) return;
    const parts = cookieStr.split(/,(?=\s*[a-zA-Z0-9_-]+=)/);
    for (const part of parts) {
      const item = part.trim().split(';')[0].trim();
      const eqIdx = item.indexOf('=');
      if (eqIdx > 0) {
        const name = item.substring(0, eqIdx).trim();
        const val = item.substring(eqIdx + 1).trim();
        this.cookies.set(name, val);
      }
    }
  }

  updateFromHeaders(headers) {
    if (!headers) return;
    let rawList = [];
    if (typeof headers.getSetCookie === 'function') {
      rawList = headers.getSetCookie();
    } else {
      const single = headers.get('set-cookie');
      if (single) rawList = [single];
    }
    for (const c of rawList) {
      this.parseAndAdd(c);
    }
  }

  getCookieHeader() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

// -------------------------------------------------------------
// GOOGLE DRIVE RESOLVER & STREAMING
// -------------------------------------------------------------
function parseGoogleDriveId(url) {
  if (!url) return null;
  const trimmed = url.trim();
  const match = trimmed.match(/(?:(?:drive|docs)\.google\.com\/(?:(?:file|drive)\/(?:u\/\d+\/)?(?:d|folders)\/|open\?id=|uc\?id=|file\/d\/)|id=)([a-zA-Z0-9_-]{20,})/i) ||
                trimmed.match(/drive\.usercontent\.google\.com\/download\?[^#]*id=([a-zA-Z0-9_-]{20,})/i);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{25,55}$/.test(trimmed)) return trimmed;
  return null;
}

function parseSizeToBytes(sizeStr) {
  if (!sizeStr) return null;
  const m = sizeStr.trim().match(/^([\d.]+)\s*([KMGTPE]?B?)$/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult = {
    'B': 1,
    'K': 1024, 'KB': 1024,
    'M': 1024 * 1024, 'MB': 1024 * 1024,
    'G': 1024 * 1024 * 1024, 'GB': 1024 * 1024 * 1024,
    'T': 1024 * 1024 * 1024 * 1024, 'TB': 1024 * 1024 * 1024 * 1024
  };
  return Math.round(num * (mult[unit] || 1));
}

async function getGDriveFileInfo(fileId) {
  let fileName = null;
  let fileSize = null;
  let sizeFormatted = null;
  let mimeType = 'application/octet-stream';
  let isPrivate = false;

  // 1. Fetch public preview page for metadata (og:title, title, viewerData)
  try {
    const viewUrl = `https://drive.google.com/file/d/${fileId}/view`;
    const viewRes = await fetch(viewUrl, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      redirect: 'follow',
    });
    
    if (viewRes.url && viewRes.url.includes('accounts.google.com')) {
      isPrivate = true;
    } else if (viewRes.ok) {
      const viewHtml = await viewRes.text();
      const ogTitle = viewHtml.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
                      viewHtml.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
      if (ogTitle && ogTitle[1] && !ogTitle[1].includes('Google Drive')) {
        fileName = ogTitle[1].trim();
      }

      if (!fileName) {
        const titleMatch = viewHtml.match(/<title>([^<]+)<\/title>/i);
        if (titleMatch && titleMatch[1]) {
          const clean = titleMatch[1].replace(/\s*-\s*Google Drive\s*$/i, '').trim();
          if (clean && !clean.includes('Page not found') && !clean.includes('Error')) {
            fileName = clean;
          }
        }
      }

      const vMatch = viewHtml.match(/window\.viewerData\s*=\s*(\{[\s\S]*?\});/);
      if (vMatch) {
        const titleMatch = vMatch[1].match(/'title':\s*'([^']+)'/);
        if (titleMatch && titleMatch[1]) fileName = titleMatch[1];
      }
    }
  } catch (e) {
    console.warn('[GDrive View Notice]:', e.message);
  }

  // 2. Fetch download initiation page for virus scan warning & size info
  try {
    const dlUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`;
    const dlRes = await fetch(dlUrl, {
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
      redirect: 'manual',
    });

    const loc = dlRes.headers.get('location');
    if (loc && loc.includes('accounts.google.com')) {
      isPrivate = true;
    }

    if (dlRes.headers.get('content-type')?.includes('text/html')) {
      const dlHtml = await dlRes.text();
      const ucMatch = dlHtml.match(/class="uc-name-size"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*\(([^)]+)\)/i);
      if (ucMatch) {
        if (!fileName || fileName.startsWith('gdrive_file_')) {
          fileName = ucMatch[1].trim();
        }
        sizeFormatted = ucMatch[2].trim();
        fileSize = parseSizeToBytes(sizeFormatted);
      }
    }
  } catch (e) {
    console.warn('[GDrive DL Notice]:', e.message);
  }

  if (isPrivate) {
    throw new Error('This Google Drive file is private or requires Google login permissions. Make sure permissions are set to "Anyone with the link".');
  }

  return { fileName, fileSize, sizeFormatted, mimeType };
}

async function getGDriveDownloadSession(fileId, existingJar = null) {
  const jar = existingJar || new CookieJar();
  let url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0`;

  let res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      ...(jar.getCookieHeader() ? { Cookie: jar.getCookieHeader() } : {})
    },
    redirect: 'manual',
  });

  jar.updateFromHeaders(res.headers);

  let redirects = 0;
  while ((res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) && redirects < 5) {
    redirects++;
    const loc = res.headers.get('location');
    if (!loc) break;
    url = loc.startsWith('http') ? loc : new URL(loc, url).toString();
    res = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        ...(jar.getCookieHeader() ? { Cookie: jar.getCookieHeader() } : {})
      },
      redirect: 'manual',
    });
    jar.updateFromHeaders(res.headers);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/html')) {
    const html = await res.text();

    // Check for explicit Google Drive Quota / Rate limit error
    const quotaMatch = html.match(/<p class="uc-error-subcaption">([\s\S]*?)<\/p>/i) ||
                       html.match(/Too many users have viewed or downloaded this file recently/i);
    if (quotaMatch) {
      const reason = typeof quotaMatch[1] === 'string' ? quotaMatch[1].replace(/<[^>]+>/g, '').trim() : 'Google Drive download quota exceeded for this file.';
      throw new Error(`Google Drive Quota Error: ${reason}`);
    }

    let confirmUrl = null;

    // Pattern 1: UUID match in input or scripts
    const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i) || html.match(/"uuid"\s*:\s*"([^"]+)"/i);
    if (uuidMatch) {
      confirmUrl = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t&uuid=${uuidMatch[1]}`;
    }

    // Pattern 2: Download form match
    if (!confirmUrl) {
      const formMatch = html.match(/<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i) ||
                        html.match(/<form[^>]*action="([^"]*drive\.usercontent\.google\.com[^"]*)"[^>]*>([\s\S]*?)<\/form>/i);
      if (formMatch) {
        const formTag = formMatch[0].match(/action="([^"]+)"/i);
        let formAction = formTag ? formTag[1].replace(/&amp;/g, '&') : url;
        if (!formAction.startsWith('http')) formAction = new URL(formAction, url).toString();

        const parsedUrl = new URL(formAction);
        const inputRegex = /<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi;
        let inputMatch;
        while ((inputMatch = inputRegex.exec(formMatch[0])) !== null) {
          parsedUrl.searchParams.set(inputMatch[1], inputMatch[2]);
        }
        if (!parsedUrl.searchParams.has('id')) parsedUrl.searchParams.set('id', fileId);
        if (!parsedUrl.searchParams.has('confirm')) parsedUrl.searchParams.set('confirm', 't');
        confirmUrl = parsedUrl.toString();
      }
    }

    // Pattern 3: downloadUrl in JavaScript
    if (!confirmUrl) {
      const dlUrlMatch = html.match(/"downloadUrl"\s*:\s*"([^"]+)"/i);
      if (dlUrlMatch) {
        confirmUrl = dlUrlMatch[1].replace(/\\u003d/g, '=').replace(/\\u0026/g, '&');
      }
    }

    // Pattern 4: Direct href confirmation link
    if (!confirmUrl) {
      const hrefMatch = html.match(/href="(\/(?:uc|download)\?[^"]*export=download[^"]*)"/i);
      if (hrefMatch) {
        confirmUrl = `https://drive.usercontent.google.com${hrefMatch[1].replace(/&amp;/g, '&')}`;
      }
    }

    if (confirmUrl) {
      let finalUrl = confirmUrl;
      let finalRes = await fetch(confirmUrl, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          ...(jar.getCookieHeader() ? { Cookie: jar.getCookieHeader() } : {})
        },
        redirect: 'manual',
      });
      jar.updateFromHeaders(finalRes.headers);

      let confRedirects = 0;
      while ((finalRes.status === 301 || finalRes.status === 302 || finalRes.status === 303 || finalRes.status === 307) && confRedirects < 5) {
        confRedirects++;
        const loc = finalRes.headers.get('location');
        if (!loc) break;
        finalUrl = loc.startsWith('http') ? loc : new URL(loc, finalUrl).toString();
        finalRes = await fetch(finalUrl, {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            ...(jar.getCookieHeader() ? { Cookie: jar.getCookieHeader() } : {})
          },
          redirect: 'manual',
        });
        jar.updateFromHeaders(finalRes.headers);
      }

      return {
        url: finalUrl,
        cookieJar: jar,
        cookie: jar.getCookieHeader(),
        isConfirmed: true,
        initialResponse: finalRes,
      };
    }
  }

  return {
    url,
    cookieJar: jar,
    cookie: jar.getCookieHeader(),
    initialResponse: res,
    isConfirmed: false,
  };
}

async function resolveGoogleDrive(url, baseUrl) {
  const fileId = parseGoogleDriveId(url);
  if (!fileId) throw new Error('Invalid Google Drive URL. Could not extract File ID.');

  // 1. Fetch real drive metadata (name, size, permissions check)
  const meta = await getGDriveFileInfo(fileId);

  let fileName = meta.fileName || `gdrive_file_${fileId.slice(0, 8)}`;
  let fileSize = meta.sizeFormatted || 'Direct stream';
  let totalBytes = meta.fileSize || null;
  let mimeType = meta.mimeType || 'application/octet-stream';

  // 2. Refine exact byte metadata & probe download confirmation session
  try {
    const session = await getGDriveDownloadSession(fileId);
    let probeRes = session.initialResponse;

    if (!probeRes || (!probeRes.ok && probeRes.status !== 206)) {
      probeRes = await fetch(session.url, {
        headers: {
          'User-Agent': DEFAULT_USER_AGENT,
          ...(session.cookie ? { Cookie: session.cookie } : {}),
          Range: 'bytes=0-1023',
        },
      });
      if (session.cookieJar) session.cookieJar.updateFromHeaders(probeRes.headers);
    }

    if (probeRes && (probeRes.ok || probeRes.status === 206)) {
      const cd = probeRes.headers.get('content-disposition');
      if (cd && cd.includes('filename=')) {
        const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
        if (fnMatch) fileName = decodeURIComponent(fnMatch[1]);
      }
      const cr = probeRes.headers.get('content-range');
      if (cr) {
        const totalMatch = cr.match(/\/(\d+)/);
        if (totalMatch) {
          totalBytes = parseInt(totalMatch[1], 10);
          fileSize = formatBytes(totalBytes);
        }
      } else {
        const cl = probeRes.headers.get('content-length');
        if (cl && parseInt(cl, 10) > 0) {
          totalBytes = parseInt(cl, 10);
          fileSize = formatBytes(totalBytes);
        }
      }
      const ct = probeRes.headers.get('content-type');
      if (ct && !ct.includes('text/html')) mimeType = ct;

      if (probeRes.body) {
        probeRes.body.cancel().catch(() => {});
      }
    }
  } catch (probeErr) {
    console.warn('[GDrive Probe Notice]:', probeErr.message);
  }

  const streamUrl = `${baseUrl}/api/stream?service=gdrive&id=${fileId}&name=${encodeURIComponent(fileName)}`;
  return {
    id: fileId,
    service: 'Google Drive',
    type: 'file',
    name: fileName,
    size: totalBytes,
    rawSize: totalBytes,
    sizeFormatted: fileSize,
    mimetype: mimeType,
    rawLink: `https://drive.google.com/uc?id=${fileId}&export=download`,
    directStreamUrl: streamUrl,
    curlCommand: `curl -L -O "${streamUrl}"`,
  };
}

// -------------------------------------------------------------
// PIXELDRAIN RESOLVER
// -------------------------------------------------------------
function parsePixelDrain(rawUrl) {
  if (!rawUrl) return null;
  const matchFile = rawUrl.match(/pixeldrain\.com\/(?:u|api\/file)\/([a-zA-Z0-9_-]+)/i);
  if (matchFile) return { type: 'file', id: matchFile[1] };
  const matchList = rawUrl.match(/pixeldrain\.com\/(?:l|api\/list)\/([a-zA-Z0-9_-]+)/i);
  if (matchList) return { type: 'list', id: matchList[1] };
  if (/^[a-zA-Z0-9_-]{6,16}$/.test(rawUrl)) return { type: 'file', id: rawUrl };
  return null;
}

async function resolvePixelDrain(url, baseUrl) {
  const parsed = parsePixelDrain(url);
  if (!parsed) throw new Error('Invalid PixelDrain URL. Could not extract file or list ID.');

  if (parsed.type === 'list') {
    const listRes = await fetch(`https://pixeldrain.com/api/list/${parsed.id}`);
    if (!listRes.ok) throw new Error(`PixelDrain list returned HTTP ${listRes.status}`);
    const listData = await listRes.json();
    if (!listData.success) throw new Error(listData.value || 'Failed to load PixelDrain list');

    const files = (listData.files || []).map((f) => {
      const streamUrl = `${baseUrl}/api/stream?service=pixeldrain&id=${encodeURIComponent(f.id)}&name=${encodeURIComponent(f.name)}`;
      return {
        id: f.id,
        name: f.name,
        sizeFormatted: formatBytes(f.size),
        mimetype: f.mime_type || 'File',
        directStreamUrl: streamUrl,
      };
    });

    return {
      service: 'PixelDrain',
      type: 'folder',
      name: listData.title || `PixelDrain List ${parsed.id}`,
      files,
    };
  }

  // Single file
  const infoRes = await fetch(`https://pixeldrain.com/api/file/${parsed.id}/info`);
  if (!infoRes.ok) throw new Error(`PixelDrain API returned HTTP ${infoRes.status}`);
  const info = await infoRes.json();
  if (!info.success) throw new Error(info.value || 'PixelDrain file not found or deleted');

  const streamUrl = `${baseUrl}/api/stream?service=pixeldrain&id=${encodeURIComponent(parsed.id)}&name=${encodeURIComponent(info.name)}`;
  return {
    id: parsed.id,
    service: 'PixelDrain',
    type: 'file',
    name: info.name,
    size: info.size,
    sizeFormatted: formatBytes(info.size),
    mimetype: info.mime_type || 'application/octet-stream',
    rawLink: `https://pixeldrain.com/api/file/${parsed.id}?download`,
    directStreamUrl: streamUrl,
    curlCommand: `curl -L -O "${streamUrl}"`,
  };
}

// -------------------------------------------------------------
// MEDIAFIRE RESOLVER
// -------------------------------------------------------------
async function resolveMediaFire(url, baseUrl) {
  // If it's ALREADY a direct download link (download*.mediafire.com)
  if (/^https?:\/\/download\d*\.mediafire\.com\//i.test(url)) {
    let fileName = 'mediafire_file';
    try {
      fileName = path.basename(new URL(url).pathname) || 'mediafire_file';
    } catch (_) {}
    const streamUrl = `${baseUrl}/api/stream?service=mediafire&url=${encodeURIComponent(url)}&name=${encodeURIComponent(fileName)}`;
    return {
      service: 'MediaFire',
      type: 'file',
      name: fileName,
      sizeFormatted: 'Direct stream',
      mimetype: 'Direct Storage Stream',
      rawLink: url,
      directStreamUrl: streamUrl,
      curlCommand: `curl -L -O "${streamUrl}"`,
    };
  }

  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) throw new Error(`MediaFire page returned HTTP ${res.status}`);
  const html = await res.text();

  // Extract direct link
  const linkMatch = html.match(/href="((?:https?:)?\/\/download\d*\.mediafire\.com\/[^"]+)"/i) ||
                    html.match(/id="downloadButton"[^>]*href="([^"]+)"/i) ||
                    html.match(/href="([^"]+)"[^>]*id="downloadButton"/i) ||
                    html.match(/aria-label="Download file"[^>]*href="([^"]+)"/i) ||
                    html.match(/https?:\/\/download\d*\.mediafire\.com\/[^\s"'<>]+/i);

  if (!linkMatch) throw new Error('Could not find MediaFire direct download link on the page.');
  let rawDownloadLink = linkMatch[1] || linkMatch[0];
  if (!rawDownloadLink.startsWith('http')) {
    rawDownloadLink = 'http:' + rawDownloadLink;
  }
  rawDownloadLink = rawDownloadLink.replace(/^https:\/\/(download\d*\.mediafire\.com)/i, 'http://$1');

  // Extract file name
  const nameMatch = html.match(/class="filename">([^<]+)<\/div>/i) ||
                    html.match(/class="dl-btn-label"\s+title="([^"]+)"/i) ||
                    html.match(/<meta property="og:title" content="([^"]+)"/i);
  const fileName = nameMatch ? nameMatch[1].trim() : 'mediafire_file';

  // Extract file size
  const sizeMatch = html.match(/<li>Size:\s*<span>([^<]+)<\/span>/i) ||
                    html.match(/class="details">[^<]*<li><span>([0-9.]+\s*[KMGT]?B)<\/span>/i);
  const fileSize = sizeMatch ? sizeMatch[1].trim() : 'Direct stream';

  const streamUrl = `${baseUrl}/api/stream?service=mediafire&url=${encodeURIComponent(rawDownloadLink)}&name=${encodeURIComponent(fileName)}`;

  return {
    service: 'MediaFire',
    type: 'file',
    name: fileName,
    sizeFormatted: fileSize,
    mimetype: 'Direct Storage Stream',
    rawLink: rawDownloadLink,
    directStreamUrl: streamUrl,
    curlCommand: `curl -L -O "${streamUrl}"`,
  };
}

// -------------------------------------------------------------
// MEGA.NZ RESOLVER
// -------------------------------------------------------------
async function resolveMega(url, baseUrl) {
  const file = MegaFile.fromURL(url);
  await file.loadAttributes();

  if (file.directory) {
    const files = [];
    const children = file.children || [];
    for (const child of children) {
      if (!child.directory) {
        const childStreamUrl = `${baseUrl}/api/stream?service=mega&url=${encodeURIComponent(url)}&fileNode=${encodeURIComponent(child.nodeId || child.downloadId)}&name=${encodeURIComponent(child.name)}`;
        files.push({
          id: child.nodeId || child.name,
          name: child.name,
          sizeFormatted: formatBytes(child.size),
          mimetype: 'Decrypted MEGA Stream',
          directStreamUrl: childStreamUrl,
        });
      }
    }
    return {
      service: 'MEGA',
      type: 'folder',
      name: file.name || 'MEGA Folder',
      files,
    };
  }

  const streamUrl = `${baseUrl}/api/stream?service=mega&url=${encodeURIComponent(url)}&name=${encodeURIComponent(file.name)}`;

  return {
    service: 'MEGA',
    type: 'file',
    name: file.name,
    size: file.size,
    sizeFormatted: formatBytes(file.size),
    mimetype: 'Decrypted MEGA Stream',
    rawLink: url,
    directStreamUrl: streamUrl,
    curlCommand: `curl -L -O "${streamUrl}"`,
  };
}

// -------------------------------------------------------------
// ANONFILESNEW RESOLVER
// -------------------------------------------------------------
function parseAnonFilesId(url) {
  const match = url.match(/anonfilesnew\.com\/(?:s\/)?([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

function extractAnonFilesLink(html) {
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const s of scripts) {
    if (s.includes('filter.constructor') && s.includes('String.fromCharCode')) {
      const codeOnly = s.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
      const sandbox = {
        atob: (str) => Buffer.from(str, 'base64').toString('binary'),
      };
      const modifiedCode = codeOnly.replace(/\(0,\[\]\.filter\.constructor\(["']return this["']\)\)\(\)/g, 'sandbox');
      const fn = new Function('sandbox', 'atob', modifiedCode);
      fn(sandbox, sandbox.atob);
      return sandbox.basePath || Object.values(sandbox).find((v) => typeof v === 'string' && v.includes('anonfilesnew.com'));
    }
  }
  return null;
}

async function resolveAnonFiles(url, baseUrl) {
  const fileId = parseAnonFilesId(url);
  if (!fileId) throw new Error('Invalid AnonFilesNew URL. Could not find file ID.');

  const pageUrl = url.startsWith('http') ? url : `https://anonfilesnew.com/${fileId}`;
  const pageRes = await fetch(pageUrl, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!pageRes.ok) throw new Error(`AnonFiles returned HTTP ${pageRes.status}`);
  const html = await pageRes.text();

  // Extract file name
  const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i) ||
                    html.match(/<title>([^<]+)<\/title>/i);
  const fileName = nameMatch ? nameMatch[1].trim() : 'downloaded_file';

  // Extract file size
  const sizeMatch = html.match(/Download\s*\(([^)]+)\)/i);
  const fileSize = sizeMatch ? sizeMatch[1].trim() : 'Direct stream';

  // Extract obfuscated content link
  const intermediateLink = extractAnonFilesLink(html);
  if (!intermediateLink) {
    throw new Error('Could not decode direct download link from AnonFiles page.');
  }

  // Follow 302 redirect to retrieve direct CDN storage URL and exact Content-Length
  let rawDownloadLink = intermediateLink;
  let rawBytes = null;
  try {
    const headRes = await fetch(intermediateLink, {
      method: 'HEAD',
      redirect: 'manual',
      headers: { 'User-Agent': DEFAULT_USER_AGENT, Referer: pageUrl },
    });
    const cdnLocation = headRes.headers.get('location');
    if (cdnLocation) {
      rawDownloadLink = cdnLocation;
      try {
        const cdnHead = await fetch(cdnLocation, {
          method: 'HEAD',
          headers: { 'User-Agent': DEFAULT_USER_AGENT, Referer: pageUrl },
        });
        const cl = cdnHead.headers.get('content-length');
        if (cl) rawBytes = parseInt(cl, 10);
      } catch (_) {}
    } else {
      const cl = headRes.headers.get('content-length');
      if (cl) rawBytes = parseInt(cl, 10);
    }
  } catch (redirectErr) {
    console.warn('[AnonFiles] Redirect follow warning:', redirectErr.message);
  }

  const streamUrl = `${baseUrl}/api/stream?service=anonfiles&url=${encodeURIComponent(rawDownloadLink)}&name=${encodeURIComponent(fileName)}`;

  return {
    service: 'AnonFilesNew',
    type: 'file',
    name: fileName,
    size: rawBytes,
    rawSize: rawBytes,
    sizeFormatted: rawBytes ? formatBytes(rawBytes) : fileSize,
    mimetype: 'application/octet-stream',
    rawLink: rawDownloadLink,
    directStreamUrl: streamUrl,
    curlCommand: `curl -L -O "${streamUrl}"`,
  };
}

// -------------------------------------------------------------
// POST /api/resolve (Universal Handler)
// -------------------------------------------------------------
app.post('/api/resolve', async (req, res) => {
  try {
    const { url, password, token } = req.body;
    if (!url || !url.trim()) {
      return res.status(400).json({ success: false, error: 'Please provide a file URL.' });
    }

    const host = req.get('x-forwarded-host') || req.get('host');
    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const baseUrl = `${protocol}://${host}`;
    const service = detectService(url);

    let resultData;
    switch (service) {
      case 'gdrive':
        resultData = await resolveGoogleDrive(url, baseUrl);
        break;
      case 'mediafire':
        resultData = await resolveMediaFire(url, baseUrl);
        break;
      case 'mega':
        resultData = await resolveMega(url, baseUrl);
        break;
      case 'anonfiles':
        resultData = await resolveAnonFiles(url, baseUrl);
        break;
      case 'pixeldrain':
        resultData = await resolvePixelDrain(url, baseUrl);
        break;
      case 'gofile':
      default:
        resultData = await resolveGofile(url, password, token, baseUrl);
        break;
    }

    res.json({ success: true, data: resultData });
  } catch (err) {
    console.error('[Resolve Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// /api/stream (Universal Streaming Proxy - 0 Disk Writes)
// -------------------------------------------------------------
app.all('/api/stream', async (req, res) => {
  try {
    const service = req.query.service || detectService(req.query.url);
    const filename = req.query.name || 'download';

    // 1. MEGA Streaming (Decrypted on-the-fly)
    if (service === 'mega') {
      const megaUrl = req.query.url;
      if (!megaUrl) return res.status(400).send('Missing MEGA URL');

      const file = MegaFile.fromURL(megaUrl);
      await file.loadAttributes();

      let targetFile = file;
      if (file.directory && req.query.fileNode) {
        const found = (file.children || []).find((c) => String(c.nodeId || c.downloadId) === String(req.query.fileNode));
        if (found) targetFile = found;
      }

      const finalName = req.query.name || targetFile.name || 'mega_download';
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(finalName)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Accept-Ranges', 'bytes');

      const downloadOpts = {};
      if (req.headers.range) {
        const parts = req.headers.range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10) || 0;
        const end = parts[1] ? parseInt(parts[1], 10) : targetFile.size - 1;
        downloadOpts.start = start;
        downloadOpts.end = end;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${targetFile.size}`);
        res.setHeader('Content-Length', (end - start + 1));
      } else {
        res.status(200);
        res.setHeader('Content-Length', targetFile.size);
      }

      if (req.method === 'HEAD') {
        return res.end();
      }

      const downloadStream = targetFile.download(downloadOpts);
      req.on('close', () => downloadStream.destroy());
      return downloadStream.pipe(res);
    }

    // 2. Google Drive Streaming (Handles virus scan confirmations, quota limits, and 500+ GB continuous auto-resuming transfers)
    if (service === 'gdrive') {
      const fileId = req.query.id || parseGoogleDriveId(req.query.url);
      if (!fileId) return res.status(400).send('Missing Google Drive File ID');

      const clientRange = req.headers.range;
      let session = await getGDriveDownloadSession(fileId);

      // Probe metadata and total size if not already known
      let effectiveName = filename;
      let totalSize = null;

      let probeRes = session.initialResponse;
      if (!probeRes || (!probeRes.ok && probeRes.status !== 206)) {
        probeRes = await fetch(session.url, {
          headers: {
            'User-Agent': DEFAULT_USER_AGENT,
            ...(session.cookie ? { Cookie: session.cookie } : {}),
            Range: 'bytes=0-1023',
          },
        });
        if (session.cookieJar) session.cookieJar.updateFromHeaders(probeRes.headers);
      }

      if (probeRes.ok || probeRes.status === 206) {
        const cd = probeRes.headers.get('content-disposition');
        if (cd && cd.includes('filename=')) {
          const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
          if (fnMatch) effectiveName = decodeURIComponent(fnMatch[1]);
        }
        const cr = probeRes.headers.get('content-range');
        if (cr) {
          const totalMatch = cr.match(/\/(\d+)/);
          if (totalMatch) totalSize = parseInt(totalMatch[1], 10);
        } else {
          const cl = probeRes.headers.get('content-length');
          if (cl && parseInt(cl, 10) > 0) totalSize = parseInt(cl, 10);
        }
      }

      // Range math
      let startOffset = 0;
      let endLimit = totalSize ? totalSize - 1 : null;

      if (clientRange) {
        const m = clientRange.match(/bytes=(\d+)-(\d+)?/);
        if (m) {
          startOffset = parseInt(m[1], 10);
          if (m[2] && totalSize) {
            endLimit = Math.min(parseInt(m[2], 10), totalSize - 1);
          }
        }
        res.status(206);
        if (totalSize) {
          res.setHeader('Content-Range', `bytes ${startOffset}-${endLimit}/${totalSize}`);
          res.setHeader('Content-Length', endLimit - startOffset + 1);
        }
      } else {
        res.status(200);
        if (totalSize) {
          res.setHeader('Content-Length', totalSize);
        }
      }

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(effectiveName)}"; filename*=UTF-8''${encodeURIComponent(effectiveName)}`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=3600');

      if (req.method === 'HEAD') {
        return res.end();
      }

      // Continuous high-performance streaming with auto-resumption on session expiry/drop
      let currentOffset = startOffset;
      let isClientClosed = false;

      req.on('close', () => {
        isClientClosed = true;
      });

      let currentSession = session;
      let consecutiveFailures = 0;
      const MAX_CONSECUTIVE_FAILURES = 10;
      let lastError = null;

      while ((endLimit === null || currentOffset <= endLimit) && !isClientClosed) {
        let bytesTransferredThisCycle = 0;

        try {
          const rangeHeader = endLimit !== null 
            ? `bytes=${currentOffset}-${endLimit}`
            : `bytes=${currentOffset}-`;

          const upstreamRes = await fetch(currentSession.url, {
            headers: {
              'User-Agent': DEFAULT_USER_AGENT,
              ...(currentSession.cookie ? { Cookie: currentSession.cookie } : {}),
              Range: rangeHeader,
            },
          });

          // Update cookie jar from response headers
          if (currentSession.cookieJar) {
            currentSession.cookieJar.updateFromHeaders(upstreamRes.headers);
            currentSession.cookie = currentSession.cookieJar.getCookieHeader();
          }

          // Check if session token expired or challenged with HTML / 403 / 401
          const cType = upstreamRes.headers.get('content-type') || '';
          if (upstreamRes.status === 403 || upstreamRes.status === 401 || cType.includes('text/html')) {
            throw new Error(`Session expired or challenged (HTTP ${upstreamRes.status}, Content-Type: ${cType})`);
          }

          if (!upstreamRes.ok && upstreamRes.status !== 206) {
            throw new Error(`Google Drive returned HTTP ${upstreamRes.status}`);
          }

          // Stream upstream body with drain backpressure
          for await (const chunk of upstreamRes.body) {
            if (isClientClosed) break;
            currentOffset += chunk.length;
            bytesTransferredThisCycle += chunk.length;

            if (!res.write(chunk)) {
              await new Promise((resolve) => res.once('drain', resolve));
            }
          }

          // If we made byte progress during this cycle, reset consecutive failure counter
          if (bytesTransferredThisCycle > 0) {
            consecutiveFailures = 0;
          }

          // If we reached the end of the requested range, complete successfully!
          if (endLimit !== null && currentOffset > endLimit) {
            break;
          }

          // If upstream closed connection normally and endLimit was not reached
          if (bytesTransferredThisCycle === 0) {
            consecutiveFailures++;
            throw new Error('Zero bytes received from upstream connection');
          }
        } catch (err) {
          lastError = err;
          consecutiveFailures++;
          console.warn(`[GDrive Stream] Connection interrupted at byte ${currentOffset}/${totalSize || 'unknown'}: ${err.message}. (Attempt ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES || isClientClosed) {
            break;
          }

          // Exponential backoff before refreshing session
          const delayMs = Math.min(1000 * Math.pow(1.5, consecutiveFailures - 1), 8000);
          await new Promise((r) => setTimeout(r, delayMs));

          // Refresh session with cookies preserved
          try {
            console.log(`[GDrive] Refreshing session on-the-fly at offset ${currentOffset}...`);
            currentSession = await getGDriveDownloadSession(fileId, currentSession.cookieJar);
          } catch (refreshErr) {
            console.warn(`[GDrive] Session refresh warning: ${refreshErr.message}`);
          }
        }
      }

      // Termination handling
      if (endLimit !== null && currentOffset <= endLimit && !isClientClosed) {
        console.error(`[GDrive Stream Fatal] Transfer incomplete. Transferred ${currentOffset}/${totalSize} bytes: ${lastError?.message}`);
        if (!res.writableEnded) {
          res.destroy(new Error(`Upstream transfer truncated at byte ${currentOffset}/${totalSize}: ${lastError?.message}`));
        }
        return;
      }

      if (!isClientClosed && !res.writableEnded) {
        res.end();
      }
      return;
    }

    // 3. PixelDrain Streaming
    if (service === 'pixeldrain') {
      const fileId = req.query.id || (req.query.url ? (parsePixelDrain(req.query.url)?.id) : null);
      if (!fileId) return res.status(400).send('Missing PixelDrain file ID');

      const targetUrl = `https://pixeldrain.com/api/file/${fileId}?download`;
      const upstreamHeaders = {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: '*/*',
      };
      if (req.headers.range) {
        upstreamHeaders['Range'] = req.headers.range;
      }

      const upstreamRes = await fetch(targetUrl, {
        method: 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
      });

      if (!upstreamRes.ok && upstreamRes.status !== 206) {
        return res.status(upstreamRes.status).send(`PixelDrain returned HTTP ${upstreamRes.status}`);
      }

      res.status(upstreamRes.status);
      ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((h) => {
        const val = upstreamRes.headers.get(h);
        if (val) res.setHeader(h, val);
      });

      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Cache-Control', 'public, max-age=3600');

      const bodyStream = Readable.fromWeb(upstreamRes.body);
      req.on('close', () => bodyStream.destroy());
      return bodyStream.pipe(res);
    }

    // 3. MediaFire, AnonFiles, Gofile, PixelDrain, and Generic Streaming
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing target URL');

    const upstreamHeaders = {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
    };

    if (service === 'gofile') {
      const token = req.query.token || cachedGofileToken;
      upstreamHeaders['Referer'] = 'https://gofile.io/';
      if (token) {
        upstreamHeaders['Cookie'] = `accountToken=${token}`;
        upstreamHeaders['Authorization'] = `Bearer ${token}`;
      }
    } else if (service === 'mediafire') {
      upstreamHeaders['Referer'] = 'https://www.mediafire.com/';
      if (targetUrl.startsWith('https://download')) {
        targetUrl = targetUrl.replace(/^https:\/\//i, 'http://');
      }
    } else if (service === 'anonfiles') {
      upstreamHeaders['Referer'] = 'https://anonfilesnew.com/';
    } else if (service === 'pixeldrain') {
      upstreamHeaders['Referer'] = 'https://pixeldrain.com/';
    }

    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
    }

    // Handle HEAD request for instant remote uploader discovery & zero bandwidth waste
    if (req.method === 'HEAD') {
      let headRes = null;
      try {
        headRes = await fetch(targetUrl, {
          method: 'HEAD',
          headers: upstreamHeaders,
          redirect: 'follow',
        });
      } catch (_) {}

      // Fallback to range probe if server denies HEAD
      if (!headRes || !headRes.ok) {
        try {
          headRes = await fetch(targetUrl, {
            method: 'GET',
            headers: { ...upstreamHeaders, Range: 'bytes=0-0' },
            redirect: 'follow',
          });
        } catch (_) {}
      }

      if (headRes && (headRes.ok || headRes.status === 206)) {
        res.status(headRes.status === 206 && !req.headers.range ? 200 : headRes.status);
        ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((h) => {
          const val = headRes.headers.get(h);
          if (val) res.setHeader(h, val);
        });

        // If client requested full file without range, extract total size from content-range
        const cr = headRes.headers.get('content-range');
        if (!req.headers.range && cr) {
          const totalMatch = cr.match(/\/(\d+)/);
          if (totalMatch) {
            res.setHeader('Content-Length', totalMatch[1]);
            res.removeHeader('Content-Range');
          }
        }

        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Accept-Ranges', 'bytes');
        return res.end();
      }
    }

    const upstreamRes = await fetch(targetUrl, {
      method: 'GET',
      headers: upstreamHeaders,
      redirect: 'follow',
    });

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      return res.status(upstreamRes.status).send(`Upstream server returned HTTP ${upstreamRes.status}`);
    }

    res.status(upstreamRes.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((h) => {
      const val = upstreamRes.headers.get(h);
      if (val) res.setHeader(h, val);
    });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    let isClientClosed = false;
    req.on('close', () => { isClientClosed = true; });

    const clHeader = upstreamRes.headers.get('content-length');
    const expectedBytes = clHeader ? parseInt(clHeader, 10) : null;
    let totalBytesSent = 0;

    for await (const chunk of upstreamRes.body) {
      if (isClientClosed) break;
      totalBytesSent += chunk.length;
      const canWrite = res.write(chunk);
      if (!canWrite) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }

    if (!isClientClosed) {
      if (expectedBytes !== null && totalBytesSent < expectedBytes) {
        console.error(`[Stream Error] Upstream connection truncated: sent ${totalBytesSent}/${expectedBytes} bytes`);
        if (!res.writableEnded) {
          res.destroy(new Error(`Upstream connection truncated: sent ${totalBytesSent}/${expectedBytes} bytes`));
        }
        return;
      }
      res.end();
    }
  } catch (err) {
    console.error('[Stream Proxy Error]:', err.message);
    if (!res.headersSent) res.status(500).send(`Streaming proxy error: ${err.message}`);
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    services: ['Gofile', 'Google Drive', 'MediaFire', 'MEGA', 'AnonFilesNew', 'PixelDrain'],
  });
});

app.listen(PORT, () => {
  console.log(`=====================================================`);
  console.log(`🚀 Universal Direct Link Converter running on port ${PORT}`);
  console.log(`🔗 Local URL: http://localhost:${PORT}`);
  console.log(`⚡ Supported: Gofile, Google Drive, MediaFire, MEGA, AnonFiles, PixelDrain`);
  console.log(`=====================================================`);
});
