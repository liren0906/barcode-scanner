const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const XLSX       = require('xlsx');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// ── In-memory state ───────────────────────────────────
let items = [], columns = [], barcodeCol = '';

// ── Static files ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Routes ────────────────────────────────────────────
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/scanner', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scanner.html')));
app.get('/state',   (req, res) => res.json({ items, columns, barcodeCol }));

// Upload Excel
const upload = multer({ storage: multer.memoryStorage() });
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    const wb   = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (!data.length) return res.status(400).json({ error: 'Excel is empty' });

    columns    = Object.keys(data[0]);
    const auto = columns.find(c => /barcode|条码|货号|tracking|code|sku|scan|单号|运单/i.test(c));
    barcodeCol = auto || columns[0];
    items      = data.map((row, i) => ({ ...row, _id: i, _confirmed: false }));

    io.emit('data-loaded', { items, columns, barcodeCol });
    res.json({ ok: true, count: items.length, barcodeCol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change barcode column
app.post('/set-col', (req, res) => {
  const { col } = req.body;
  if (columns.includes(col)) {
    barcodeCol = col;
    io.emit('col-changed', { barcodeCol });
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'Column not found' });
  }
});

// Reset
app.post('/reset', (req, res) => {
  items = items.map(i => ({ ...i, _confirmed: false }));
  io.emit('reset-all');
  res.json({ ok: true });
});

// ── Socket.io ─────────────────────────────────────────
io.on('connection', (socket) => {
  // Send current state to new device
  socket.emit('state', { items, columns, barcodeCol });

  socket.on('scan', (code) => {
    const result = processCode(code);
    io.emit('scan-result', { code, ...result });
    if (result.confirmed) io.emit('item-confirmed', { id: result.id, code });
  });
});

// ── Smart matching ────────────────────────────────────
function normalize(str) {
  return String(str).replace(/[\s\-\.]/g, '').toUpperCase();
}

function processCode(code) {
  const normCode = normalize(code);
  let idx = items.findIndex(i => String(i[barcodeCol]).trim() === code.trim());
  if (idx === -1) idx = items.findIndex(i => normalize(i[barcodeCol]) === normCode);

  if (idx === -1) {
    const suggestions = items
      .filter(item => {
        if (item._confirmed) return false;
        const n = normalize(item[barcodeCol]);
        return n.includes(normCode) || normCode.includes(n) || levenshtein(n, normCode) <= 3;
      })
      .slice(0, 3)
      .map(i => String(i[barcodeCol]));
    return { confirmed: false, duplicate: false, found: false, suggestions };
  }

  if (items[idx]._confirmed) {
    return { confirmed: false, duplicate: true, found: true, id: items[idx]._id };
  }

  items[idx]._confirmed = true;
  return { confirmed: true, duplicate: false, found: true, id: items[idx]._id };
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => j === 0 ? i : 0)
  );
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

server.listen(PORT, () => {
  console.log(`✅ Barcode Scanner running on port ${PORT}`);
});
