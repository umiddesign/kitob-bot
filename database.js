require('dotenv').config();
const path = require('node:path');

const DATABASE_URL = process.env.DATABASE_URL;
const VAULT_URL = process.env.VAULT_URL || 'https://kitob-bot.alwaysdata.net/db_sync.php';
const VAULT_KEY = process.env.VAULT_KEY || 'kb_vault_8515917861_secret';

let isPostgres = Boolean(DATABASE_URL);
let pgPool = null;
let sqliteDb = null;

async function syncToVault(payload) {
  if (isPostgres || !VAULT_URL) return;
  try {
    await fetch(VAULT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Key': VAULT_KEY
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error("Cloud Vault sync ogohlantirishi:", err.message);
  }
}

async function restoreFromVault() {
  if (isPostgres || !VAULT_URL) return;
  try {
    const res = await fetch(VAULT_URL, {
      headers: { 'X-Vault-Key': VAULT_KEY }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.ok) return;

    if (Array.isArray(data.books)) {
      const bookStmt = sqliteDb.prepare(`
        INSERT INTO books (id, code, title, author, description, cover_file_id, pdf_file_id, audio_file_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          title = excluded.title,
          author = excluded.author,
          description = excluded.description,
          cover_file_id = excluded.cover_file_id,
          pdf_file_id = excluded.pdf_file_id,
          audio_file_id = excluded.audio_file_id
      `);
      for (const b of data.books) {
        bookStmt.run(
          b.id,
          b.code,
          b.title,
          b.author || null,
          b.description || null,
          b.cover_file_id || null,
          b.pdf_file_id || null,
          b.audio_file_id || null,
          b.created_at || new Date().toISOString()
        );
      }
    }

    if (Array.isArray(data.users)) {
      const userStmt = sqliteDb.prepare(`
        INSERT INTO users (id, username, first_name, joined_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name
      `);
      for (const u of data.users) {
        userStmt.run(u.id, u.username || null, u.first_name || '', u.joined_at || new Date().toISOString());
      }
    }

    if (Array.isArray(data.join_requests)) {
      const reqStmt = sqliteDb.prepare(`
        INSERT INTO join_requests (user_id, chat_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, chat_id) DO NOTHING
      `);
      for (const r of data.join_requests) {
        reqStmt.run(r.user_id, String(r.chat_id), r.created_at || new Date().toISOString());
      }
    }

    console.log(`☁️ Doimiy bulutli bazadan tiklandi: ${data.books?.length || 0} ta kitob, ${data.users?.length || 0} ta foydalanuvchi.`);
  } catch (err) {
    console.error("Cloud Vault tiklash xatosi:", err.message);
  }
}

if (isPostgres) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Neon, Supabase, Render require SSL
    max: 20, // Max concurrent connections in pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  console.log("🐘 PostgreSQL bulutli ma'lumotlar bazasiga ulanmoqda...");
} else {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(__dirname, 'books.db');
  sqliteDb = new DatabaseSync(dbPath);
  console.log("📁 Mahalliy SQLite + Doimiy Bulutli Zaxira bazasi ishlatilmoqda.");
}

async function initDB() {
  if (isPostgres) {
    const client = await pgPool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGINT PRIMARY KEY,
          username TEXT,
          first_name TEXT,
          joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS books (
          id SERIAL PRIMARY KEY,
          code TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          author TEXT,
          description TEXT,
          cover_file_id TEXT,
          pdf_file_id TEXT,
          audio_file_id TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_books_code ON books(LOWER(code));
        CREATE INDEX IF NOT EXISTS idx_books_title ON books(LOWER(title));

        CREATE TABLE IF NOT EXISTS join_requests (
          user_id BIGINT,
          chat_id TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, chat_id)
        );
      `);
      console.log("✅ PostgreSQL jadvallari tayyor.");
    } finally {
      client.release();
    }
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        description TEXT,
        cover_file_id TEXT,
        pdf_file_id TEXT,
        audio_file_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_books_code ON books(LOWER(code));
      CREATE INDEX IF NOT EXISTS idx_books_title ON books(LOWER(title));

      CREATE TABLE IF NOT EXISTS join_requests (
        user_id INTEGER,
        chat_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, chat_id)
      );
    `);
    await restoreFromVault();
    console.log("✅ SQLite va Bulutli Baza tayyor.");
  }
}

// User queries
const syncedUsers = new Set();
async function addUser(id, username, firstName) {
  try {
    if (isPostgres) {
      await pgPool.query(`
        INSERT INTO users (id, username, first_name)
        VALUES ($1, $2, $3)
        ON CONFLICT(id) DO UPDATE SET
          username = EXCLUDED.username,
          first_name = EXCLUDED.first_name;
      `, [id, username || null, firstName || '']);
    } else {
      const stmt = sqliteDb.prepare(`
        INSERT INTO users (id, username, first_name)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          first_name = excluded.first_name;
      `);
      stmt.run(id, username || null, firstName || '');
      if (!syncedUsers.has(id)) {
        syncedUsers.add(id);
        syncToVault({ action: 'add_user', user: { id, username: username || null, first_name: firstName || '' } });
      }
    }
  } catch (err) {
    console.error("addUser xatosi:", err.message);
  }
}

async function getUserCount() {
  if (isPostgres) {
    const res = await pgPool.query(`SELECT COUNT(*) as count FROM users`);
    return Number(res.rows[0].count);
  } else {
    const stmt = sqliteDb.prepare(`SELECT COUNT(*) as count FROM users`);
    return stmt.get().count;
  }
}

async function getAllUserIds() {
  if (isPostgres) {
    const res = await pgPool.query(`SELECT id FROM users`);
    return res.rows.map(r => Number(r.id));
  } else {
    const stmt = sqliteDb.prepare(`SELECT id FROM users`);
    return stmt.all().map(r => r.id);
  }
}

// Book queries
async function bookCodeExists(code) {
  const cleanCode = code.trim().toLowerCase();
  if (isPostgres) {
    const res = await pgPool.query(`SELECT id FROM books WHERE LOWER(code) = $1 LIMIT 1`, [cleanCode]);
    return res.rowCount > 0;
  } else {
    const stmt = sqliteDb.prepare(`SELECT id FROM books WHERE LOWER(code) = LOWER(?)`);
    return Boolean(stmt.get(cleanCode));
  }
}

async function addBook({ code, title, author, description, cover_file_id, pdf_file_id, audio_file_id }) {
  const cleanBook = {
    code: code.trim(),
    title: title.trim(),
    author: author ? author.trim() : null,
    description: description ? description.trim() : null,
    cover_file_id: cover_file_id || null,
    pdf_file_id: pdf_file_id || null,
    audio_file_id: audio_file_id || null
  };

  if (isPostgres) {
    await pgPool.query(`
      INSERT INTO books (code, title, author, description, cover_file_id, pdf_file_id, audio_file_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      cleanBook.code,
      cleanBook.title,
      cleanBook.author,
      cleanBook.description,
      cleanBook.cover_file_id,
      cleanBook.pdf_file_id,
      cleanBook.audio_file_id
    ]);
  } else {
    const stmt = sqliteDb.prepare(`
      INSERT INTO books (code, title, author, description, cover_file_id, pdf_file_id, audio_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        title = excluded.title,
        author = excluded.author,
        description = excluded.description,
        cover_file_id = excluded.cover_file_id,
        pdf_file_id = excluded.pdf_file_id,
        audio_file_id = excluded.audio_file_id
    `);
    stmt.run(
      cleanBook.code,
      cleanBook.title,
      cleanBook.author,
      cleanBook.description,
      cleanBook.cover_file_id,
      cleanBook.pdf_file_id,
      cleanBook.audio_file_id
    );
    await syncToVault({ action: 'add_book', book: cleanBook });
  }
}

async function getBookByCode(code) {
  const cleanCode = code.trim().toLowerCase();
  if (isPostgres) {
    const res = await pgPool.query(`SELECT * FROM books WHERE LOWER(code) = $1 LIMIT 1`, [cleanCode]);
    return res.rows[0] || null;
  } else {
    const stmt = sqliteDb.prepare(`SELECT * FROM books WHERE LOWER(code) = LOWER(?)`);
    return stmt.get(cleanCode) || null;
  }
}

async function getBookById(id) {
  if (isPostgres) {
    const res = await pgPool.query(`SELECT * FROM books WHERE id = $1`, [id]);
    return res.rows[0] || null;
  } else {
    const stmt = sqliteDb.prepare(`SELECT * FROM books WHERE id = ?`);
    return stmt.get(id) || null;
  }
}

async function searchBooks(query) {
  const term = `%${query.trim().toLowerCase()}%`;
  if (isPostgres) {
    const res = await pgPool.query(`
      SELECT * FROM books 
      WHERE LOWER(code) LIKE $1 OR LOWER(title) LIKE $2 OR LOWER(author) LIKE $3
      ORDER BY id DESC
      LIMIT 20
    `, [term, term, term]);
    return res.rows;
  } else {
    const stmt = sqliteDb.prepare(`
      SELECT * FROM books 
      WHERE LOWER(code) LIKE ? OR LOWER(title) LIKE ? OR LOWER(author) LIKE ?
      ORDER BY id DESC
      LIMIT 20
    `);
    return stmt.all(term, term, term);
  }
}

async function getAllBooks(limit = 6, offset = 0) {
  if (isPostgres) {
    const res = await pgPool.query(`
      SELECT * FROM books 
      ORDER BY id DESC 
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    return res.rows;
  } else {
    const stmt = sqliteDb.prepare(`
      SELECT * FROM books 
      ORDER BY id DESC 
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset);
  }
}

async function getTotalBooksCount() {
  if (isPostgres) {
    const res = await pgPool.query(`SELECT COUNT(*) as count FROM books`);
    return Number(res.rows[0].count);
  } else {
    const stmt = sqliteDb.prepare(`SELECT COUNT(*) as count FROM books`);
    return stmt.get().count;
  }
}

async function deleteBookByCode(code) {
  const cleanCode = code.trim().toLowerCase();
  if (isPostgres) {
    const res = await pgPool.query(`DELETE FROM books WHERE LOWER(code) = $1`, [cleanCode]);
    return res.rowCount > 0;
  } else {
    const stmt = sqliteDb.prepare(`DELETE FROM books WHERE LOWER(code) = LOWER(?)`);
    const deleted = stmt.run(cleanCode).changes > 0;
    await syncToVault({ action: 'delete_book', code: cleanCode });
    return deleted;
  }
}

async function addJoinRequest(userId, chatId) {
  try {
    if (isPostgres) {
      await pgPool.query(`
        INSERT INTO join_requests (user_id, chat_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, chat_id) DO NOTHING;
      `, [userId, String(chatId)]);
    } else {
      const stmt = sqliteDb.prepare(`
        INSERT INTO join_requests (user_id, chat_id)
        VALUES (?, ?)
        ON CONFLICT (user_id, chat_id) DO NOTHING;
      `);
      stmt.run(userId, String(chatId));
      syncToVault({ action: 'add_join_request', user_id: userId, chat_id: String(chatId) });
    }
  } catch (err) {
    console.error("addJoinRequest xatosi:", err.message);
  }
}

async function hasJoinRequest(userId, chatId) {
  try {
    if (isPostgres) {
      const res = await pgPool.query(`
        SELECT 1 FROM join_requests
        WHERE user_id = $1 AND chat_id = $2
        LIMIT 1;
      `, [userId, String(chatId)]);
      return res.rowCount > 0;
    } else {
      const stmt = sqliteDb.prepare(`
        SELECT 1 FROM join_requests
        WHERE user_id = ? AND chat_id = ?
        LIMIT 1;
      `);
      return Boolean(stmt.get(userId, String(chatId)));
    }
  } catch (err) {
    console.error("hasJoinRequest xatosi:", err.message);
    return false;
  }
}

module.exports = {
  initDB,
  addUser,
  getUserCount,
  getAllUserIds,
  bookCodeExists,
  addBook,
  getBookByCode,
  getBookById,
  searchBooks,
  getAllBooks,
  getTotalBooksCount,
  deleteBookByCode,
  addJoinRequest,
  hasJoinRequest
};
