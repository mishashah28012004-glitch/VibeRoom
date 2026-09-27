require('dotenv').config();
const pool = require('./db');

async function migrate() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(24)  NOT NULL,
        socket_id   VARCHAR(64)  NOT NULL DEFAULT '',
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_socket (socket_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        room_code     VARCHAR(20)  NOT NULL UNIQUE,
        host_user_id  INT UNSIGNED NULL,
        video_id      VARCHAR(32)  NOT NULL DEFAULT '',
        video_title   VARCHAR(255) NOT NULL DEFAULT '',
        playing       TINYINT(1)   NOT NULL DEFAULT 0,
        playback_time FLOAT        NOT NULL DEFAULT 0,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_rooms_host FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS room_participants (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        room_id    INT UNSIGNED NOT NULL,
        user_id    INT UNSIGNED NOT NULL,
        role       ENUM('host','moderator','participant','viewer') NOT NULL DEFAULT 'viewer',
        joined_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_room_user (room_id, user_id),
        CONSTRAINT fk_rp_room FOREIGN KEY (room_id) REFERENCES rooms(id)  ON DELETE CASCADE,
        CONSTRAINT fk_rp_user FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS room_events (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        room_id    INT UNSIGNED NOT NULL,
        user_id    INT UNSIGNED NULL,
        event_type VARCHAR(40)  NOT NULL,
        payload    JSON         NULL,
        created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_re_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS room_bans (
        room_id    INT UNSIGNED NOT NULL,
        user_id    INT UNSIGNED NOT NULL,
        removed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (room_id, user_id),
        CONSTRAINT fk_bans_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        CONSTRAINT fk_bans_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('Migration complete.');
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err.code || 'UNEXPECTED_ERROR');
  process.exit(1);
});
