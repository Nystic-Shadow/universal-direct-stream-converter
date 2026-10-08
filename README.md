# ⚡ Universal Direct Link & Stream Converter

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/Docker-0--Config%20Ready-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/Node.js-v20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/Status-Production%20Ready-10b981)]()

> **Convert restricted file-hosting URLs (Gofile, Google Drive, MediaFire, MEGA, AnonFiles, PixelDrain) into direct, high-speed, resume-capable binary streams for Remote Upload, cURL, wget, IDM, and aria2c with 0 disk storage.**

---

## 🌟 Key Features

- 🚀 **500+ GB Multi-Gigabyte Ready**: Designed with a high-throughput 64 MB chunk sequential streaming pipeline. Tested on 100+ GB and 500+ GB archives with zero stalling, memory bloat, or socket timeouts.
- 🛡️ **Google Drive Quota & Virus Scan Bypass**: Automatically completes Google's confirmation handshake (`uuid` & `NID` cookies) and uses bounded HTTP Range requests to bypass Google's `200 OK` "Download quota exceeded" HTML block.
- 🍪 **Bypasses Browser Session Cookies & 302 Redirects**: Fixes Gofile remote upload failures where services capture HTML login pages instead of actual files.
- 💾 **Zero Disk Storage Architecture**: Pure on-the-fly memory-safe streaming. Bytes pipe directly from upstream CDNs into client connections with Node.js backpressure flow control (`res.write` + `drain`).
- 🔄 **On-The-Fly Session Auto-Recovery**: If a massive 500 GB file takes hours to download and upstream session tokens expire mid-stream, the engine refreshes credentials and resumes at the **exact byte offset** without dropping the connection.
- ⏩ **Full HTTP Range & Multi-Part Acceleration**: Exposes RFC 5987 headers (`Accept-Ranges: bytes`, `206 Partial Content`, `Content-Disposition`, `Content-Length`). Fully compatible with multi-threaded downloaders (**IDM**, **aria2c**, **FDM**).
- 📱 **Sleek Cyberpunk/Glassmorphic Web UI**: Real-time provider auto-detection, one-click clipboard paste, dynamic metrics (exact byte size, MIME type, stream pipeline), and multi-tab command generator (**cURL**, **wget**, **aria2c**, **Python**).

---

## ☁️ Supported File Hosts

| Provider | Input Link Format | Features Handled |
| :--- | :--- | :--- |
| **Google Drive** | `drive.google.com/file/d/<ID>` | Quota-exceeded bypass, virus scan warning confirmation, 500+ GB sequential streaming, auto-token refresh |
| **Gofile** | `gofile.io/d/<ID>` or `store-*.gofile.io/download/web/...` | Hybrid browser/server website-token (`wt`) generator, account token negotiation, 302 bypass |
| **MediaFire** | `mediafire.com/file/<ID>` or `download*.mediafire.com/...` | Dynamic HTML scraping, CDN URL normalization (fixes TLS `ECONNRESET` drops) |
| **MEGA.nz** | `mega.nz/file/<ID>#<KEY>` or `mega.nz/folder/...` | Pure client-side streaming decryption via `megajs`, multi-file folder browsing |
| **PixelDrain** | `pixeldrain.com/u/<ID>` or `pixeldrain.com/l/<ID>` | Official REST API integration, instant metadata lookup, multi-file lists |
| **AnonFiles** | `anonfilesnew.com/<ID>/...` | Direct storage regex extraction and streaming proxy |

---

## 🚀 Quick Start (0-Config)

### Option 1: Docker Compose (Recommended)

Run with zero configuration:

```bash
docker compose up -d
```

Open your browser at **`http://localhost:3000`**.

### Option 2: Docker CLI

```bash
docker run -d \
  --name direct-stream-converter \
  -p 3000:3000 \
  --restart unless-stopped \
  ghcr.io/nystic-shadow/universal-direct-stream-converter:latest
```

### Option 3: Local Node.js Setup

```bash
git clone https://github.com/Nystic-Shadow/universal-direct-stream-converter.git
cd universal-direct-stream-converter
npm install
npm start
```

---

## 💻 CLI & Remote Upload Usage

Once resolved, you get a clean stream URL you can feed directly into any remote upload tool or terminal command:

### cURL
```bash
curl -L -O "http://localhost:3000/api/stream?service=gdrive&id=FILE_ID&name=archive.zip"
```

### wget
```bash
wget --content-disposition "http://localhost:3000/api/stream?service=gdrive&id=FILE_ID&name=archive.zip"
```

### aria2c (16 Parallel Threads for 500+ GB)
```bash
aria2c -s 16 -x 16 -k 1M -o "archive.zip" "http://localhost:3000/api/stream?service=gdrive&id=FILE_ID&name=archive.zip"
```

### Python Streaming Download
```python
import requests

url = "http://localhost:3000/api/stream?service=gdrive&id=FILE_ID&name=archive.zip"
with requests.get(url, stream=True) as r:
    r.raise_for_status()
    with open("archive.zip", "wb") as f:
        for chunk in r.iter_content(chunk_size=1048576): # 1MB buffers
            f.write(chunk)
```

---

## 🔌 REST API Documentation

### 1. Resolve File URL
Resolves metadata and generates a direct streaming endpoint.

- **Endpoint**: `POST /api/resolve`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
  ```json
  {
    "url": "https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/view"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "data": {
      "id": "1A2B3C4D5E6F7G8H9I0J",
      "service": "Google Drive",
      "type": "file",
      "name": "archive.zip",
      "size": 1048576000,
      "sizeFormatted": "1.00 GB",
      "mimetype": "application/octet-stream",
      "directStreamUrl": "http://localhost:3000/api/stream?service=gdrive&id=1A2B3C4D5E6F7G8H9I0J&name=archive.zip",
      "curlCommand": "curl -L -O \"http://localhost:3000/api/stream?service=gdrive&id=1A2B3C4D5E6F7G8H9I0J&name=archive.zip\""
    }
  }
  ```

### 2. Stream Binary Data
Streams raw bytes with HTTP Range and flow-control support.

- **Endpoint**: `GET /api/stream`
- **Query Parameters**:
  - `service`: `gdrive` | `gofile` | `mediafire` | `mega` | `pixeldrain` | `anonfiles`
  - `id`: File ID (for Google Drive or PixelDrain)
  - `url`: Direct source link (for MediaFire, AnonFiles, Gofile)
  - `name`: Desired output filename

### 3. Health Check
- **Endpoint**: `GET /api/health`
- **Response**:
  ```json
  {
    "status": "ok",
    "services": ["Gofile", "Google Drive", "MediaFire", "MEGA", "AnonFilesNew", "PixelDrain"]
  }
  ```

---

## 🛠️ Architecture & Under the Hood

```
[Client / Remote Uploader]
       │
       │ HTTP GET (with optional Range: bytes=A-B)
       ▼
┌────────────────────────────────────────────────────────┐
│ Universal Stream Converter (Node.js Express)           │
│ ────────────────────────────────────────────────────── │
│ 1. Zero-Storage Memory Pipe (Backpressure Handled)    │
│ 2. 64 MB Chunk Sequential Chunker                      │
│ 3. On-The-Fly UUID / Cookie Auto-Renewal               │
└────────────────────────────────────────────────────────┘
       │
       │ Authenticated / Bounded Range Handshake
       ▼
[Cloud Storage Provider: Google Drive / Gofile / PixelDrain / MEGA / MediaFire]
```

### Why Google Drive Fails on Full Downloads & How We Fix It
Google Drive limits direct downloads when an item receives high traffic ("Quota exceeded for this file"). Standard open-ended requests (`Range: bytes=0-` or no range) are returned with a `200 OK` HTML error page. However, Google's CDN continues to honor **bounded HTTP Range requests** (e.g. `bytes=0-67108863`). 

This server negotiates the virus-scan UUID and cookies, queries the exact file size via a 1-byte probe, and streams sequential 64 MB chunks transparently. To the downloader (curl, IDM, browser), it appears as one continuous, uninterrupted binary stream with exact `Content-Length` and full resume capabilities.

---

## 📄 License

MIT License &copy; 2026. Contributions and pull requests are welcome!
