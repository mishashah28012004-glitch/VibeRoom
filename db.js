require('dotenv').config();
const mysql = require('mysql2/promise');

// ── detect placeholder values and warn immediately ────────────────────────────
const DB_PASS = process.env.DB_PASS || '';
if (DB_PASS === 'your_password_here') {
  console.error('');
  console.error('╔══════════════════════════════════════════════════════════════╗');
  console.error('║  DATABASE ERROR: .env has placeholder DB_PASS value          ║');
  console.error('║  Open .env and set DB_PASS to your real MySQL root password  ║');
  console.error('╚══════════════════════════════════════════════════════════════╝');
  console.error('');
}

const pool = mysql.createPool({
  host:               process.env.DB_HOST  || 'localhost',
  port:               Number(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME  || 'watchparty',
  user:               process.env.DB_USER  || 'root',
  password:           DB_PASS,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

// test on startup — gives immediate feedback in the terminal
pool.getConnection()
  .then(conn => {
    console.log('[DB] ✓ Connected to MySQL —', process.env.DB_NAME || 'watchparty');
    conn.release();
  })
  .catch(err => {
    console.error('[DB] ✗ Cannot connect to MySQL');
    console.error(`     Code   : ${err.code}`);
    console.error(`     Message: ${err.message}`);
    console.error('');
    console.error('     Fix: open .env and correct DB_HOST, DB_PORT, DB_USER, DB_PASS, DB_NAME');
    console.error('     Then restart the server with: npm run dev');
  });

module.exports = pool;
