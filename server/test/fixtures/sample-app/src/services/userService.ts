import { pool } from '../db/client';

export async function getUser(id: string) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

export async function searchUsers(q: string) {
  // Intentionally unsafe for testing the security scanner.
  const { rows } = await pool.query("SELECT * FROM users WHERE name LIKE '%" + q + "%'");
  return rows;
}
