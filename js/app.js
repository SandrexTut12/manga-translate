function getGeminiUrl() {
  const key = localStorage.getItem('gemini_key') || '';
  return `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
}

const dropzone   = document.getElementById('dropzone');
const fileInput  = document.getElementById('fileInput');
const browseBtn  = document.getElementById('browseBtn');
const queueEl    = document.getElementById('queue');
const resultsEl  = document.getElementById('results');
const targetLang = document.getElementById('targetLang');

let processing = false;
const fileQueue = [];

// ── API Key save ──────────────────────────────────────────
const apiKeyInput = document.getElementById('apiKeyInput');
const saveKeyBtn  = document.getElementById('saveKeyBtn');
if (localStorage.getItem('gemini_key')) apiKeyInput.value = '••••••••••••';
saveKeyBtn.addEventListener('click', () => {
  const val = apiKeyInput.value.trim();
  if (!val || val.startsWith('•')) return;
  localStorage.setItem('gemini_key', val);
  apiKeyInput.value = '••••••••••••';
  saveKeyBtn.textContent = '✓';
  setTimeout(() => saveKeyBtn.textContent = 'შენახვა', 2000);
});

dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => { e.preventDefault(); dropzone.classList.remove('dragover'); handleFiles([...e.dataTransfer.files]); });
dropzone.addEventListener('click', () => fileInput.click());
browseBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });

function handleFiles(files) {
  const valid = files.filter(f => f.type.startsWith('image/'));
  if (!valid.length) return;
  valid.forEach(addToQueue);
  if (!processing) processNext();
}

function addToQueue(file) {
  const id = Date.now() + Math.random();
  const url = URL.createObjectURL(file);
  fileQueue.push({ id, file, url });
  queueEl.hidden = false;
  const item = document.createElement('div');
  item.className = 'queue-item';
  item.id = `qi-${id}`;
  item.innerHTML = `
    <img class="queue-thumb" src="${url}" alt="" />
    <div class="queue-info">
      <div class="queue-name">${esc(file.name)}</div>
      <div class="queue-status" id="qs-${id}">მოლოდინი...</div>
      <div class="queue-progress"><div class="queue-progress-bar" id="qp-${id}" style="width:0%"></div></div>
    </div>
    <button class="queue-btn-remove" onclick="removeItem('${id}')">✕</button>`;
  queueEl.appendChild(item);
}

window.removeItem = id => {
  const idx = fileQueue.findIndex(x => String(x.id) === String(id));
  if (idx !== -1) fileQueue.splice(idx, 1);
  document.getElementById(`qi-${id}`)?.remove();
  if (!queueEl.children.length) queueEl.hidden = true;
};

async function processNext() {
  if (!fileQueue.length) { processing = false; return; }
  processing = true;
  await translateImage(fileQueue.shift());
  processNext();
}

// ── Compress image ────────────────────────────────────────
async function compressImage(file, maxSide = 1600) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const origW = img.width, origH = img.height;
      const scale = Math.min(1, maxSide / Math.max(origW, origH));
      const cW = Math.round(origW * scale), cH = Math.round(origH * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cW; canvas.height = cH;
      canvas.getContext('2d').drawImage(img, 0, 0, cW, cH);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        // toDataURL for Gemini base64
        const reader = new FileReader();
        reader.onload = e => resolve({ b64: e.target.result.split(',')[1], blob, origW, origH, cW, cH, scale });
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.88);
    };
    img.src = url;
  });
}

// ── Gemini Vision ─────────────────────────────────────────
async function callGemini(b64, targetLangCode) {
  const langName = targetLangCode === 'ka' ? 'Georgian (ქართული)' : 'English';

  const prompt = `You are a professional manga/manhwa translator.

Analyze this manga/manhwa page image. Find ALL text elements: speech bubbles, thought bubbles, narration boxes, sound effects, signs.

For each text element return:
- original: the exact original text
- translated: translation into ${langName}
- x: left edge as fraction of image width (0.0–1.0)
- y: top edge as fraction of image height (0.0–1.0)
- w: width as fraction of image width (0.0–1.0)
- h: height as fraction of image height (0.0–1.0)
- type: "bubble" | "narration" | "sfx"

Return ONLY a valid JSON object, no explanation:
{
  "elements": [
    { "original": "...", "translated": "...", "x": 0.1, "y": 0.05, "w": 0.25, "h": 0.12, "type": "bubble" }
  ]
}`;

  if (!localStorage.getItem('gemini_key')) throw new Error('Gemini API key არ არის შეყვანილი — ⚙️ პარამეტრები');
  const res = await fetch(getGeminiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: b64 } },
          { text: prompt }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini error ${res.status}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text || '';

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Gemini-მ JSON ვერ დააბრუნა');
  return JSON.parse(match[0]);
}

// ── Draw translated text on canvas ───────────────────────
function wrapText(ctx, text, cx, cy, maxW, lineH) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const startY = cy - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, cx, startY + i * lineH));
}

async function renderOnCanvas(file, elements, origW, origH) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      for (const el of elements) {
        if (!el.translated) continue;
        const PAD = 4;
        const l = el.x * img.width  - PAD;
        const t = el.y * img.height - PAD;
        const w = el.w * img.width  + PAD * 2;
        const h = el.h * img.height + PAD * 2;

        // Fill background
        if (el.type === 'sfx') {
          ctx.fillStyle = 'rgba(255,255,180,0.92)';
        } else {
          ctx.fillStyle = '#ffffff';
        }
        ctx.beginPath();
        ctx.roundRect(l, t, w, h, 6);
        ctx.fill();

        // Text
        ctx.fillStyle = '#000000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fontSize = Math.max(10, Math.min(h * 0.35, 20));
        ctx.font = `bold ${fontSize}px 'Noto Sans Georgian', Arial, sans-serif`;
        wrapText(ctx, el.translated, l + w / 2, t + h / 2, w - 8, fontSize * 1.3);
      }
      resolve(canvas);
    };
    img.src = URL.createObjectURL(file);
  });
}

// ── Main flow ─────────────────────────────────────────────
async function translateImage({ id, file, url }) {
  setStatus(id, '🖼️ სურათის მომზადება...', 15);
  try {
    const { b64, origW, origH } = await compressImage(file);

    setStatus(id, '🤖 Gemini ანალიზი...', 40);
    const data = await callGemini(b64, targetLang.value);
    const elements = data.elements || [];

    if (!elements.length) {
      setStatus(id, '⚠️ ტექსტი ვერ მოიძებნა', 0);
      renderResult(file.name, url, null, [], targetLang.value);
      cleanup(id); return;
    }

    setStatus(id, '🎨 სურათის რედაქტირება...', 80);
    const canvas = await renderOnCanvas(file, elements, origW, origH);

    setStatus(id, '✅ დასრულდა', 100);
    renderResult(file.name, url, canvas, elements, targetLang.value);
    cleanup(id);
  } catch (err) {
    setStatus(id, `❌ ${err.message}`, 0);
    renderError(file.name, err.message);
  }
}

function cleanup(id) {
  setTimeout(() => {
    document.getElementById(`qi-${id}`)?.remove();
    if (!queueEl.children.length) queueEl.hidden = true;
  }, 1400);
}

function setStatus(id, text, pct) {
  const s = document.getElementById(`qs-${id}`);
  const p = document.getElementById(`qp-${id}`);
  if (s) s.textContent = text;
  if (p) p.style.width = pct + '%';
}

// ── Render result card ────────────────────────────────────
function renderResult(name, origUrl, canvas, elements, lang) {
  resultsEl.hidden = false;
  const langLabel = lang === 'ka' ? '🇬🇪 ქართული' : '🇬🇧 English';
  const translatedSrc = canvas ? canvas.toDataURL('image/png') : null;

  const listHtml = elements.length ? elements.map(el => `
    <div class="translation-item">
      <div class="orig-text">${esc(el.original)}</div>
      <div class="trans-text">${esc(el.translated)}</div>
    </div>`).join('') : '<div class="empty-translations">ტექსტი ვერ მოიძებნა</div>';

  const card = document.createElement('div');
  card.className = 'result-card';
  card.innerHTML = `
    <div class="result-header">
      <span class="result-filename">${esc(name)}</span>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="result-lang-badge">${langLabel}</span>
        ${translatedSrc ? `<a class="dl-btn" href="${translatedSrc}" download="translated_${esc(name)}">⬇ გადმოწერა</a>` : ''}
      </div>
    </div>
    <div class="result-body result-body--2col">
      <div class="result-col">
        <div class="col-label">ორიგინალი</div>
        <img src="${origUrl}" alt="original" />
      </div>
      <div class="result-col">
        <div class="col-label">თარგმანი</div>
        ${translatedSrc
          ? `<img src="${translatedSrc}" alt="translated" />`
          : `<div class="empty-translations">ტექსტი ვერ მოიძებნა</div>`}
      </div>
    </div>
    <div class="result-text-list">
      <div class="col-label" style="padding:12px 20px 4px">ტექსტური სია</div>
      <div class="translation-list" style="padding:0 20px 16px">${listHtml}</div>
    </div>`;

  resultsEl.insertBefore(card, resultsEl.firstChild);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderError(name, msg) {
  resultsEl.hidden = false;
  const d = document.createElement('div');
  d.className = 'error-card';
  d.innerHTML = `<strong>${esc(name)}</strong> — ${esc(msg)}`;
  resultsEl.insertBefore(d, resultsEl.firstChild);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
