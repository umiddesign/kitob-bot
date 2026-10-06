const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const dbPath = path.join(__dirname, 'books.db');
const db = new DatabaseSync(dbPath);

// Initialize tables
db.exec(`
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
`);

// User queries
function addUser(id, username, firstName) {
  const stmt = db.prepare(`
    INSERT INTO users (id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name;
  `);
  stmt.run(id, username || null, firstName || '');
}

function getUserCount() {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM users`);
  return stmt.get().count;
}

function getAllUserIds() {
  const stmt = db.prepare(`SELECT id FROM users`);
  return stmt.all().map(row => row.id);
}

// Book queries
function bookCodeExists(code) {
  const stmt = db.prepare(`SELECT id FROM books WHERE LOWER(code) = LOWER(?)`);
  return Boolean(stmt.get(code));
}

function addBook({ code, title, author, description, cover_file_id, pdf_file_id, audio_file_id }) {
  const stmt = db.prepare(`
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

function getBookByCode(code) {
  const stmt = db.prepare(`SELECT * FROM books WHERE LOWER(code) = LOWER(?)`);
  return stmt.get(code.trim());
}

function getBookById(id) {
  const stmt = db.prepare(`SELECT * FROM books WHERE id = ?`);
  return stmt.get(id);
}

function searchBooks(query) {
  const term = `%${query.trim().toLowerCase()}%`;
  const stmt = db.prepare(`
    SELECT * FROM books 
    WHERE LOWER(code) LIKE ? OR LOWER(title) LIKE ? OR LOWER(author) LIKE ?
    LIMIT 20
  `);
  return stmt.all(term, term, term);
}

function getAllBooks(limit = 10, offset = 0) {
  const stmt = db.prepare(`
    SELECT * FROM books 
    ORDER BY id DESC 
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset);
}

function getTotalBooksCount() {
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM books`);
  return stmt.get().count;
}

function deleteBookByCode(code) {
  const stmt = db.prepare(`DELETE FROM books WHERE LOWER(code) = LOWER(?)`);
  return stmt.run(code.trim()).changes > 0;
}

module.exports = {
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
