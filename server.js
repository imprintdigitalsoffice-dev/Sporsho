// স্বাধীন স্পর্শ — ব্যাকএন্ড সার্ভার
// এই সার্ভারের কাজ: Gemini API key নিরাপদে রাখা এবং ফ্রন্টএন্ডের হয়ে
// ব্যাকগ্রাউন্ড-রিমুভাল রিকোয়েস্ট Gemini-তে পাঠানো।
// key কখনোই ব্রাউজার/ফ্রন্টএন্ড কোডে যাবে না — এখানেই থাকবে, .env ফাইলে।

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // ১০ MB পর্যন্ত ছবি গ্রহণযোগ্য
});

// ---------- ডেটাবেজ সেটআপ (PostgreSQL — Render-এর ফ্রি Postgres addon ব্যবহার হবে) ----------
// Render-এ ফ্রি Postgres সংযুক্ত করলে DATABASE_URL এনভায়রনমেন্ট ভ্যারিয়েবল
// নিজে থেকেই বসে যায় — আলাদা করে কিছু বসাতে হয় না।
if (!process.env.DATABASE_URL) {
  console.error('⚠️  DATABASE_URL সেট করা নেই! Render-এ ফ্রি Postgres সংযুক্ত করা আছে কিনা চেক করুন।');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS print_jobs (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      customer_name TEXT,
      items_json TEXT NOT NULL,
      total NUMERIC NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const { rows } = await pool.query('SELECT * FROM settings WHERE key = $1', ['print_rates']);
  if (rows.length === 0) {
    await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [
      'print_rates', JSON.stringify({ color: 5, bw: 2 })
    ]);
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('⚠️  GEMINI_API_KEY সেট করা নেই! .env ফাইলে GEMINI_API_KEY=আপনার_কী বসান।');
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// প্রোডাকশনে গেলে origin নির্দিষ্ট করে দিন, যেমন:
// app.use(cors({ origin: 'https://apnar-domain.com' }));
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// ---------- ফ্রন্টএন্ড (HTML ফাইল) সার্ভ করা ----------
// public ফোল্ডারের ভেতরের সব ফাইল (welcome page, photo editor, print manager)
// এই একই সার্ভার থেকে সরাসরি পাওয়া যাবে — আলাদা করে হোস্ট করতে হবে না।
app.use(express.static(path.join(__dirname, 'public')));

const BG_INSTRUCTIONS = {
  white: 'Replace the background with a solid pure white (#FFFFFF) background, like a professional passport photo studio backdrop.',
  blue: 'Replace the background with a solid professional light blue (#4A6FA5) background, like a passport photo studio backdrop.',
  transparent: 'Remove the background completely, producing a clean transparent background (PNG with alpha channel), leaving only the subject.'
};

app.post('/api/remove-background', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'কোনো ছবি পাওয়া যায়নি' });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'সার্ভারে GEMINI_API_KEY সেট করা নেই' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const bgChoice = req.body.background;
    const bgInstruction = BG_INSTRUCTIONS[bgChoice] || BG_INSTRUCTIONS.white;

    const prompt = `You are editing a portrait photo for an official passport/ID photo studio. ` +
      `Carefully identify the person (the main subject) in the foreground and preserve all fine details, ` +
      `especially hair strands and clothing edges. ${bgInstruction} ` +
      `Do not change the person's face, expression, pose, clothing, or the lighting on the subject. ` +
      `Keep the subject sharp, in focus, and in its original position. Return only the edited image.`;

    const interaction = await ai.interactions.create({
      model: 'gemini-3.1-flash-image',
      input: [
        { type: 'text', text: prompt },
        { type: 'image', mime_type: req.file.mimetype || 'image/jpeg', data: base64Image }
      ]
    });

    const output = interaction.output_image;
    if (!output || !output.data) {
      return res.status(502).json({ error: 'Gemini থেকে কোনো ছবি ফেরত আসেনি, আবার চেষ্টা করুন' });
    }

    res.json({ image: output.data, mimeType: output.mime_type || 'image/png' });
  } catch (err) {
    console.error('Gemini error:', err);
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে: ' + (err.message || 'অজানা সমস্যা') });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ---------- প্রিন্ট ম্যানেজার: রেট সেটিংস ----------
app.get('/api/print/rates', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', ['print_rates']);
    res.json(JSON.parse(rows[0].value));
  } catch (err) {
    console.error('Rate load error:', err);
    res.status(500).json({ error: 'রেট লোড করা যায়নি' });
  }
});

app.post('/api/print/rates', async (req, res) => {
  try {
    const { color, bw } = req.body;
    const value = JSON.stringify({ color: Number(color) || 0, bw: Number(bw) || 0 });
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['print_rates', value]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Rate save error:', err);
    res.status(500).json({ error: 'রেট সেভ করা যায়নি' });
  }
});

// ---------- প্রিন্ট ম্যানেজার: জব হিস্ট্রি ----------
app.post('/api/print/jobs', async (req, res) => {
  try {
    const { customerName, items, total } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'কোনো আইটেম পাওয়া যায়নি' });
    }
    const { rows } = await pool.query(
      `INSERT INTO print_jobs (customer_name, items_json, total)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [customerName || '', JSON.stringify(items), Number(total) || 0]
    );

    res.json({
      id: rows[0].id,
      createdAt: rows[0].created_at,
      customerName: customerName || '',
      items, total
    });
  } catch (err) {
    console.error('Print job save error:', err);
    res.status(500).json({ error: 'বিল সেভ করা যায়নি' });
  }
});

app.get('/api/print/jobs', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const { rows } = await pool.query(
      'SELECT * FROM print_jobs ORDER BY id DESC LIMIT $1', [limit]
    );
    const jobs = rows.map(r => ({
      id: r.id,
      createdAt: r.created_at,
      customerName: r.customer_name,
      items: JSON.parse(r.items_json),
      total: Number(r.total)
    }));
    res.json(jobs);
  } catch (err) {
    console.error('History load error:', err);
    res.status(500).json({ error: 'হিস্ট্রি লোড করা যায়নি' });
  }
});

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ ব্যাকএন্ড সার্ভার চলছে: http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ ডেটাবেজ শুরু করা যায়নি:', err.message);
    console.error('DATABASE_URL ঠিক আছে কিনা, Render-এ ফ্রি Postgres সংযুক্ত আছে কিনা চেক করুন।');
    // ডেটাবেজ ছাড়াও সার্ভার চালু রাখা হচ্ছে, যাতে অন্তত /api/health দিয়ে সমস্যা ধরা যায়
    app.listen(PORT, () => {
      console.log(`⚠️  সার্ভার চালু হয়েছে কিন্তু ডেটাবেজ ছাড়া: http://localhost:${PORT}`);
    });
  });
