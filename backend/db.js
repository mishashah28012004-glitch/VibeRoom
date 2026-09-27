require('dotenv').config();
const mysql = require('mysql2/promise');

const requiredDatabaseSettings = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS'];
const missingDatabaseSettings = requiredDatabaseSettings.filter(key => !process.env[key]);
if (missingDatabaseSettings.length) {
  throw new Error(`Missing required database environment variables: ${missingDatabaseSettings.join(', ')}`);
}

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               Number(process.env.DB_PORT) || 3306,
  database:           process.env.DB_NAME,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASS,
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

module.exports = pool;
