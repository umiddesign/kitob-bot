require('dotenv').config();
const path = require('node:path');

const DATABASE_URL = process.env.DATABASE_URL;

let isPostgres = Boolean(DATABASE_URL);
let pgPool = null;
let sqliteDb = null;

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
  console.log("📁 Mahalliy SQLite bazasi ishlatilmoqda.");
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
    `);
    console.log("✅ SQLite jadvallari tayyor.");
  }
}

// User queries
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
  if (isPostgres) {
    await pgPool.query(`
      INSERT INTO books (code, title, author, description, cover_file_id, pdf_file_id, audio_file_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      code.trim(),
      title.trim(),
      author ? author.trim() : null,
      description ? description.trim() : null,
      cover_file_id || null,
      pdf_file_id || null,
      audio_file_id || null
    ]);
  } else {
    const stmt = sqliteDb.prepare(`
      INSERT INTO books (code, title, author, description, cover_file_id, pdf_file_id, audio_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      code.trim(),
      title.trim(),
      author ? author.trim() : null,
      description ? description.trim() : null,
      cover_file_id || null,
      pdf_file_id || null,
      audio_file_id || null
    );
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
    return stmt.run(cleanCode).changes > 0;
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
  deleteBookByCode
};
