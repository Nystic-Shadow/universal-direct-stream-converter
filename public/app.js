document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const form = document.getElementById('convertForm');
  const urlInput = document.getElementById('urlInput');
  const submitBtn = document.getElementById('submitBtn');
  const btnText = submitBtn.querySelector('.btn-text');
  const spinner = document.getElementById('spinner');
  const pasteBtn = document.getElementById('pasteBtn');
  const clearBtn = document.getElementById('clearBtn');
  const detectedLabel = document.getElementById('detectedLabel');
  const providersBar = document.getElementById('providersBar');

  // Error Card
  const errorCard = document.getElementById('errorCard');
  const errorTitle = document.getElementById('errorTitle');
  const errorMsg = document.getElementById('errorMsg');

  // Results Section
  const resultsSection = document.getElementById('resultsSection');
  const fileResult = document.getElementById('fileResult');
  const fileName = document.getElementById('fileName');
  const fileMimeTag = document.getElementById('fileMimeTag');
  const serviceBadge = document.getElementById('serviceBadge');
  const fileSizeBadge = document.getElementById('fileSizeBadge');

  // Metrics
  const metricProvider = document.getElementById('metricProvider');
  const metricSize = document.getElementById('metricSize');
  const metricBytes = document.getElementById('metricBytes');
  const metricPipeline = document.getElementById('metricPipeline');

  // Direct Stream
  const directStreamInput = document.getElementById('directStreamInput');
  const copyStreamBtn = document.getElementById('copyStreamBtn');
  const downloadLinkBtn = document.getElementById('downloadLinkBtn');

  // Quota Warning
  const quotaWarningCard = document.getElementById('quotaWarningCard');
  const quotaWarningMsg = document.getElementById('quotaWarningMsg');

  // Terminal Switcher
  const termTabs = document.querySelectorAll('.term-tab');
  const terminalCode = document.getElementById('terminalCode');
  const copyTermBtn = document.getElementById('copyTermBtn');

  // Folder Result
  const folderResult = document.getElementById('folderResult');
  const folderName = document.getElementById('folderName');
  const folderSubtitle = document.getElementById('folderSubtitle');
  const folderItemsList = document.getElementById('folderItemsList');
  const copyAllFolderBtn = document.getElementById('copyAllFolderBtn');

  let currentActiveTab = 'curl';
  let currentResult = null;
  let currentFolderFiles = [];

  const DEFAULT_SALT = '12af056dacea0b';
  const FALLBACK_TOKEN = 'I8oNxxJagZmYKfK5IIac9n5kHacDn2at';

  // Format Bytes helper
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  // Detect Service
  function detectServiceKey(url) {
    if (!url) return null;
    if (/(?:drive|docs)(?:\.usercontent)?\.google\.com|googleusercontent\.com/i.test(url)) return 'gdrive';
    if (/mediafire\.com/i.test(url)) return 'mediafire';
    if (/mega\.nz/i.test(url)) return 'mega';
    if (/anonfilesnew\.com/i.test(url)) return 'anonfiles';
    if (/pixeldrain\.com/i.test(url)) return 'pixeldrain';
    if (/gofile\.io/i.test(url) || /^[a-zA-Z0-9_-]{4,50}$/.test(url.trim())) return 'gofile';
    return 'generic';
  }

  function getServiceName(key) {
    switch (key) {
      case 'gdrive': return 'Google Drive';
      case 'mediafire': return 'MediaFire';
      case 'mega': return 'MEGA';
      case 'anonfiles': return 'AnonFiles';
      case 'pixeldrain': return 'PixelDrain';
      case 'gofile': return 'Gofile';
      default: return 'Generic';
    }
  }

  // Live Auto-Detection on Input
  function updateInputState() {
    const val = urlInput.value.trim();
    if (val.length > 0) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }

    const serviceKey = detectServiceKey(val);
    document.querySelectorAll('.provider-pill').forEach(pill => {
      if (serviceKey && pill.dataset.service === serviceKey) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });

    if (serviceKey && serviceKey !== 'generic') {
      detectedLabel.textContent = `Detected: ${getServiceName(serviceKey)}`;
      detectedLabel.classList.add('detected');
    } else {
      detectedLabel.textContent = 'Auto-detecting provider';
      detectedLabel.classList.remove('detected');
    }
  }

  urlInput.addEventListener('input', updateInputState);

  // Clear Button
  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    updateInputState();
    urlInput.focus();
  });

  // Paste Button
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        updateInputState();
        urlInput.focus();
      }
    } catch (err) {
      console.warn('Clipboard read error:', err);
    }
  });

  // Provider Pill click - simply focus the input
  document.querySelectorAll('.provider-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      urlInput.focus();
    });
  });

  // SHA-256 for browser
  async function sha256Hex(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Parse Gofile input
  function parseGofileInput(raw) {
    const input = raw.trim();
    const storeMatch = input.match(/https?:\/\/([^/]+\.gofile\.io)\/download\/(?:web|direct)\/([a-zA-Z0-9_-]+)(?:\/([^?#]+))?/i);
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

  async function getClientToken() {
    const cached = localStorage.getItem('gofile_browser_token');
    if (cached) return cached;
    try {
      const res = await fetch('https://api.gofile.io/accounts', { method: 'POST' });
      const data = await res.json();
      if (data?.status === 'ok' && data?.data?.token) {
        localStorage.setItem('gofile_browser_token', data.data.token);
        return data.data.token;
      }
    } catch (_) {}
    return FALLBACK_TOKEN;
  }

  // Form Submit
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    hideResults();

    const rawUrl = urlInput.value.trim();
    if (!rawUrl) return;

    setLoading(true);
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to resolve file URL');
      }

      displayResult(data.data);
    } catch (err) {
      showError('Resolution Failed', err.message);
    } finally {
      setLoading(false);
    }
  });

  // Display Result
  function displayResult(result) {
    currentResult = result;
    resultsSection.classList.remove('hidden');

    if (result.type === 'file' || (result.type === 'folder' && result.directStreamUrl)) {
      fileResult.classList.remove('hidden');
      if (result.files && result.files.length > 1) {
        folderResult.classList.remove('hidden');
      } else {
        folderResult.classList.add('hidden');
      }

      const sName = result.service || 'File';
      fileName.textContent = result.name || 'download_file';
      fileMimeTag.textContent = result.mimetype || 'application/octet-stream';

      serviceBadge.textContent = `☁️ ${sName}`;
      fileSizeBadge.textContent = `📦 ${result.sizeFormatted || 'Direct Stream'}`;

      metricProvider.textContent = sName;
      metricSize.textContent = result.sizeFormatted || 'Direct Stream';

      const raw = result.rawSize || result.size;
      metricBytes.textContent = raw ? `${Number(raw).toLocaleString()} B` : (result.sizeFormatted || 'Streaming Byte Pipeline');

      if (result.quotaExceeded) {
        if (quotaWarningCard) {
          quotaWarningCard.classList.remove('hidden');
          if (result.quotaNotice && quotaWarningMsg) {
            quotaWarningMsg.textContent = result.quotaNotice;
          }
        }
        metricPipeline.textContent = 'Quota-Locked by Google (Bypass Available)';
        metricPipeline.classList.add('warning-pipeline');
      } else {
        if (quotaWarningCard) quotaWarningCard.classList.add('hidden');
        metricPipeline.classList.remove('warning-pipeline');
        if (sName === 'Google Drive') {
          metricPipeline.textContent = 'Continuous Auto-Resuming Stream';
        } else {
          metricPipeline.textContent = 'Zero-Storage Raw Byte Pipe';
        }
      }

      directStreamInput.value = result.directStreamUrl || '';
      downloadLinkBtn.href = result.directStreamUrl || '#';

      updateTerminalSnippet();
    } else {
      fileResult.classList.add('hidden');
      folderResult.classList.remove('hidden');

      folderName.textContent = result.name || 'Folder Archive';
      folderSubtitle.textContent = `Contains ${(result.files || []).length} file(s)`;
      currentFolderFiles = result.files || [];

      renderFolderList(currentFolderFiles);
    }

    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Update Terminal Command Snippet
  function updateTerminalSnippet() {
    if (!currentResult || !currentResult.directStreamUrl) return;
    const url = currentResult.directStreamUrl;
    const fn = currentResult.name || 'download';

    if (currentActiveTab === 'curl') {
      terminalCode.textContent = `curl -L -O "${url}"`;
    } else if (currentActiveTab === 'wget') {
      terminalCode.textContent = `wget --content-disposition "${url}"`;
    } else if (currentActiveTab === 'aria2c') {
      terminalCode.textContent = `aria2c -s 16 -x 16 -k 1M -o "${fn}" "${url}"`;
    } else if (currentActiveTab === 'python') {
      terminalCode.textContent = `import requests\n\nwith requests.get("${url}", stream=True) as r:\n    r.raise_for_status()\n    with open("${fn}", "wb") as f:\n        for chunk in r.iter_content(chunk_size=1048576):\n            f.write(chunk)`;
    }
  }

  // Terminal Tab Switching
  termTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      termTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentActiveTab = tab.dataset.tab;
      updateTerminalSnippet();
    });
  });

  // Copy Terminal Command
  copyTermBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(terminalCode.textContent);
      const original = copyTermBtn.textContent;
      copyTermBtn.textContent = 'Copied!';
      setTimeout(() => { copyTermBtn.textContent = original; }, 1500);
    } catch (_) {}
  });

  // Copy Stream Input Button
  copyStreamBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(directStreamInput.value);
      const span = copyStreamBtn.querySelector('span');
      const original = span.textContent;
      span.textContent = 'Copied!';
      copyStreamBtn.style.borderColor = '#10b981';
      setTimeout(() => {
        span.textContent = original;
        copyStreamBtn.style.borderColor = '';
      }, 1500);
    } catch (_) {}
  });

  // Render Folder Items
  function renderFolderList(files) {
    folderItemsList.innerHTML = '';
    files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'folder-row-item';
      row.innerHTML = `
        <div class="folder-row-left">
          <span class="folder-item-name">${f.name}</span>
          <span class="folder-item-size">${f.sizeFormatted || 'File'} • ${f.mimetype || 'Stream'}</span>
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="pill-action-btn copy-item-btn" data-url="${f.directStreamUrl}">Copy</button>
          <a href="${f.directStreamUrl}" target="_blank" rel="noopener" class="pill-action-btn" style="text-decoration: none;">Download</a>
        </div>
      `;
      folderItemsList.appendChild(row);
    });

    document.querySelectorAll('.copy-item-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(btn.dataset.url);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
    });
  }

  // Copy All Folder Links
  copyAllFolderBtn.addEventListener('click', async () => {
    const allLinks = currentFolderFiles.map(f => f.directStreamUrl).join('\n');
    await navigator.clipboard.writeText(allLinks);
    copyAllFolderBtn.textContent = 'Copied All!';
    setTimeout(() => { copyAllFolderBtn.textContent = 'Copy All Stream Links'; }, 1500);
  });

  // UI State Helpers
  function setLoading(loading) {
    if (loading) {
      submitBtn.disabled = true;
      btnText.textContent = 'Resolving Stream...';
      spinner.classList.remove('hidden');
    } else {
      submitBtn.disabled = false;
      btnText.textContent = 'Generate Direct Stream Link';
      spinner.classList.add('hidden');
    }
  }

  function showError(title, msg) {
    errorTitle.textContent = title;
    errorMsg.textContent = msg;
    errorCard.classList.remove('hidden');
    errorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideError() {
    errorCard.classList.add('hidden');
  }

  function hideResults() {
    resultsSection.classList.add('hidden');
    fileResult.classList.add('hidden');
    folderResult.classList.add('hidden');
    if (quotaWarningCard) quotaWarningCard.classList.add('hidden');
  }
});
