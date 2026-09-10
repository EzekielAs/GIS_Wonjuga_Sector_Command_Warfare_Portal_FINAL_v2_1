require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
(async () => {
  const sql = fs.readFileSync('db/schema.sql', 'utf8');
  await pool.query(sql);
  console.log('Tables created!');
  await pool.end();
})();