// ================== لوحة استضافة البوتات ==================
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const treeKill = require('tree-kill');
const AdmZip = require('adm-zip');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// -------- الإعدادات العامة --------
const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'Pablo';
const MAX_BOTS = 30; // حد أقصى احترازي حتى لا تنهار الاستضافة المجانية
const BOTS_DIR = path.join(__dirname, 'bots');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MAX_LOG_LINES = 300;

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// -------- قاعدة بيانات خفيفة (ملف JSON) --------
const adapter = new FileSync(DB_FILE);
const db = low(adapter);
db.defaults({ bots: [] }).write();

// تخزين العمليات الشغالة في الذاكرة (لا تُحفظ في db)
const runtime = {}; // { botId: { proc, logs: [], status: 'running'|'stopped'|'crashed', autoRestart } }

function getBot(id) {
  return db.get('bots').find({ id }).value();
}
function updateBot(id, patch) {
  db.get('bots').find({ id }).assign(patch).write();
}
function ensureRuntime(id) {
  if (!runtime[id]) runtime[id] = { proc: null, logs: [], status: 'stopped', autoRestart: false, starting: false };
  return runtime[id];
}
function pushLog(id, line) {
  const rt = ensureRuntime(id);
  const stamp = new Date().toLocaleTimeString('ar-EG');
  rt.logs.push(`[${stamp}] ${line}`);
  if (rt.logs.length > MAX_LOG_LINES) rt.logs.shift();
}

// -------- كشف نوع البوت وملف التشغيل تلقائياً --------
function detectRuntimeType(botDir) {
  const files = fs.readdirSync(botDir);
  if (files.includes('package.json')) return 'node';
  if (files.includes('requirements.txt') || files.some(f => f.endsWith('.py'))) return 'python';
  if (files.some(f => f.endsWith('.js'))) return 'node';
  return null;
}

function detectEntryFile(botDir, type) {
  const files = fs.readdirSync(botDir);
  if (type === 'node') {
    if (files.includes('package.json')) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(botDir, 'package.json'), 'utf8'));
        if (pkg.main && files.includes(pkg.main)) return pkg.main;
      } catch (e) {}
    }
    for (const cand of ['index.js', 'bot.js', 'main.js', 'app.js']) {
      if (files.includes(cand)) return cand;
    }
    const jsFiles = files.filter(f => f.endsWith('.js'));
    if (jsFiles.length) return jsFiles[0];
  } else if (type === 'python') {
    for (const cand of ['main.py', 'bot.py', 'app.py', 'run.py']) {
      if (files.includes(cand)) return cand;
    }
    const pyFiles = files.filter(f => f.endsWith('.py'));
    if (pyFiles.length) return pyFiles[0];
  }
  return null;
}

// -------- تثبيت المكتبات المطلوبة تلقائياً --------
function installDeps(bot, cb) {
  const botDir = path.join(BOTS_DIR, bot.id);
  const files = fs.readdirSync(botDir);
  let cmd, args;

  if (bot.type === 'node' && files.includes('package.json')) {
    cmd = 'npm';
    args = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  } else if (bot.type === 'python' && files.includes('requirements.txt')) {
    cmd = 'pip';
    args = ['install', '-r', 'requirements.txt', '--no-cache-dir'];
  } else {
    pushLog(bot.id, 'لا توجد مكتبات خارجية للتثبيت، جاري التشغيل مباشرة.');
    return cb(null);
  }

  pushLog(bot.id, `جاري تثبيت المكتبات (${cmd} ${args.join(' ')}) ...`);
  const install = spawn(cmd, args, { cwd: botDir, shell: true });
  install.stdout.on('data', d => pushLog(bot.id, d.toString().trim()));
  install.stderr.on('data', d => pushLog(bot.id, d.toString().trim()));
  install.on('close', code => {
    if (code === 0) {
      pushLog(bot.id, 'تم تثبيت المكتبات بنجاح ✅');
      cb(null);
    } else {
      pushLog(bot.id, `فشل تثبيت المكتبات (كود ${code}) ❌`);
      cb(new Error('install failed'));
    }
  });
}

// -------- تشغيل / إيقاف / إعادة تشغيل البوت --------
function startBot(id, opts = {}) {
  const bot = getBot(id);
  if (!bot) return;
  const rt = ensureRuntime(id);
  if (rt.proc) return; // شغال أصلاً

  rt.starting = true;
  installDeps(bot, (err) => {
    rt.starting = false;
    if (err && !opts.ignoreInstallError) {
      rt.status = 'crashed';
      return;
    }
    const botDir = path.join(BOTS_DIR, id);
    const entry = bot.entry;
    const cmd = bot.type === 'node' ? 'node' : 'python3';
    pushLog(id, `تشغيل البوت: ${cmd} ${entry}`);

    const proc = spawn(cmd, [entry], { cwd: botDir, env: { ...process.env } });
    rt.proc = proc;
    rt.status = 'running';
    updateBot(id, { lastStarted: Date.now() });

    proc.stdout.on('data', d => pushLog(id, d.toString().trim()));
    proc.stderr.on('data', d => pushLog(id, d.toString().trim()));

    proc.on('exit', (code, signal) => {
      pushLog(id, `توقف البوت (code=${code}, signal=${signal})`);
      rt.proc = null;
      const wasManualStop = rt.manualStop;
      rt.manualStop = false;
      if (!wasManualStop) {
        rt.status = 'crashed';
        if (rt.autoRestart) {
          pushLog(id, 'إعادة تشغيل تلقائي بعد 3 ثواني...');
          setTimeout(() => startBot(id, { ignoreInstallError: true }), 3000);
        }
      } else {
        rt.status = 'stopped';
      }
    });
  });
}

function stopBot(id) {
  const rt = ensureRuntime(id);
  if (rt.proc) {
    rt.manualStop = true;
    treeKill(rt.proc.pid, 'SIGTERM');
  }
}

function restartBot(id) {
  const rt = ensureRuntime(id);
  if (rt.proc) {
    rt.manualStop = true;
    treeKill(rt.proc.pid, 'SIGTERM', () => {
      setTimeout(() => startBot(id), 1000);
    });
  } else {
    startBot(id);
  }
}

// عند بدء تشغيل السيرفر: تشغيل البوتات التي كانت شغالة (اختياري - معطل افتراضياً لتفادي استهلاك الموارد)
// db.get('bots').value().forEach(b => { if (b.autoStartOnBoot) startBot(b.id); });

// ================== إعداد Express ==================
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'bot-host-panel-secret-' + PANEL_PASSWORD,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // أسبوع
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  return res.redirect('/login');
}

// -------- تسجيل الدخول --------
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});
app.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === PANEL_PASSWORD) {
    req.session.loggedIn = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'كلمة المرور غير صحيحة' });
});
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// -------- الصفحة الرئيسية (كل البوتات) --------
app.get('/', requireAuth, (req, res) => {
  const bots = db.get('bots').value().map(b => ({
    ...b,
    status: ensureRuntime(b.id).status
  }));
  res.render('dashboard', { bots, maxBots: MAX_BOTS });
});

// -------- رفع بوت جديد --------
const upload = multer({ dest: path.join(__dirname, 'tmp_uploads') });
app.post('/bots/create', requireAuth, upload.single('file'), (req, res) => {
  const bots = db.get('bots').value();
  if (bots.length >= MAX_BOTS) {
    return res.status(400).send('وصلت للحد الأقصى من البوتات المسموح بها.');
  }
  const name = (req.body.name || 'bot').replace(/[^a-zA-Z0-9_\-\u0600-\u06FF ]/g, '').trim() || 'bot';
  const id = 'bot_' + Date.now();
  const botDir = path.join(BOTS_DIR, id);
  fs.mkdirSync(botDir, { recursive: true });

  const uploadedPath = req.file.path;
  const originalName = req.file.originalname;

  try {
    if (originalName.toLowerCase().endsWith('.zip')) {
      const zip = new AdmZip(uploadedPath);
      zip.extractAllTo(botDir, true);
    } else {
      fs.copyFileSync(uploadedPath, path.join(botDir, originalName));
    }
  } finally {
    fs.unlinkSync(uploadedPath);
  }

  const type = detectRuntimeType(botDir);
  if (!type) {
    fs.rmSync(botDir, { recursive: true, force: true });
    return res.status(400).send('لم أستطع التعرف على نوع البوت (يجب أن يحتوي على ملف .js أو .py).');
  }
  const entry = detectEntryFile(botDir, type);
  if (!entry) {
    fs.rmSync(botDir, { recursive: true, force: true });
    return res.status(400).send('لم أجد ملف تشغيل رئيسي واضح داخل الملفات المرفوعة.');
  }

  db.get('bots').push({ id, name, type, entry, createdAt: Date.now(), autoRestart: true }).write();
  ensureRuntime(id).autoRestart = true;
  pushLog(id, `تم إنشاء البوت (${type}) - ملف التشغيل: ${entry}`);

  startBot(id);
  res.redirect('/bot/' + id);
});

// -------- صفحة بوت واحد (تفاصيل + محرر + لوق) --------
app.get('/bot/:id', requireAuth, (req, res) => {
  const bot = getBot(req.params.id);
  if (!bot) return res.status(404).send('البوت غير موجود');
  const botDir = path.join(BOTS_DIR, bot.id);
  const filesList = listFilesRecursive(botDir);
  const rt = ensureRuntime(bot.id);
  res.render('bot', {
    bot, files: filesList, logs: rt.logs.join('\n'),
    status: rt.status, autoRestart: rt.autoRestart
  });
});

function listFilesRecursive(dir, base = '') {
  let results = [];
  const items = fs.readdirSync(dir);
  for (const item of items) {
    if (item === 'node_modules' || item === '__pycache__' || item.startsWith('.')) continue;
    const full = path.join(dir, item);
    const rel = path.join(base, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(listFilesRecursive(full, rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}

// -------- عرض محتوى ملف --------
app.get('/bot/:id/file', requireAuth, (req, res) => {
  const bot = getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'not found' });
  const filePath = safeJoin(path.join(BOTS_DIR, bot.id), req.query.path);
  if (!filePath) return res.status(400).json({ error: 'مسار غير صالح' });
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content });
  } catch (e) {
    res.status(400).json({ error: 'لا يمكن قراءة هذا الملف (قد يكون ثنائي)' });
  }
});

// -------- حفظ ملف + إعادة تشغيل تلقائياً --------
app.post('/bot/:id/file', requireAuth, (req, res) => {
  const bot = getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'not found' });
  const filePath = safeJoin(path.join(BOTS_DIR, bot.id), req.body.path);
  if (!filePath) return res.status(400).json({ error: 'مسار غير صالح' });
  fs.writeFileSync(filePath, req.body.content, 'utf8');
  pushLog(bot.id, `تم تعديل الملف: ${req.body.path}`);
  if (req.body.restart === 'true') {
    restartBot(bot.id);
    pushLog(bot.id, 'تمت إعادة التشغيل لتطبيق التعديلات.');
  }
  res.json({ ok: true });
});

function safeJoin(baseDir, relPath) {
  if (!relPath) return null;
  const target = path.join(baseDir, relPath);
  if (!target.startsWith(path.resolve(baseDir))) return null;
  return target;
}

// -------- أزرار التحكم: تشغيل / إيقاف / إعادة تشغيل / حذف --------
app.post('/bot/:id/start', requireAuth, (req, res) => { startBot(req.params.id); res.redirect('back'); });
app.post('/bot/:id/stop', requireAuth, (req, res) => { stopBot(req.params.id); res.redirect('back'); });
app.post('/bot/:id/restart', requireAuth, (req, res) => { restartBot(req.params.id); res.redirect('back'); });

app.post('/bot/:id/autorestart', requireAuth, (req, res) => {
  const rt = ensureRuntime(req.params.id);
  rt.autoRestart = !rt.autoRestart;
  updateBot(req.params.id, { autoRestart: rt.autoRestart });
  res.redirect('back');
});

app.post('/bot/:id/delete', requireAuth, (req, res) => {
  const id = req.params.id;
  stopBot(id);
  setTimeout(() => {
    const botDir = path.join(BOTS_DIR, id);
    if (fs.existsSync(botDir)) fs.rmSync(botDir, { recursive: true, force: true });
    db.get('bots').remove({ id }).write();
    delete runtime[id];
  }, 500);
  res.redirect('/');
});

// -------- جلب اللوق (تحديث حي عبر polling بسيط) --------
app.get('/bot/:id/logs', requireAuth, (req, res) => {
  const rt = ensureRuntime(req.params.id);
  res.json({ logs: rt.logs.join('\n'), status: rt.status });
});

app.listen(PORT, () => {
  console.log(`لوحة استضافة البوتات تعمل على المنفذ ${PORT}`);
});
