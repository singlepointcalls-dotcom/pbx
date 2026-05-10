#!/usr/bin/env node
'use strict';

/**
 * Seed script: creates requested operator accounts.
 * Run: node src/db/seed-accounts.js
 *
 * ⚠ SECURITY WARNING: The passwords below are below the system's 12-character
 * minimum policy. Change them immediately after first login in production.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const ACCOUNTS = [
  {
    username:  'user1',
    password:  'user123',
    full_name: 'Operator User 1',
    email:     'user1@singlepointcalls.co.uk',
    role:      'operator',
  },
  {
    username:  'leon123',
    password:  '@leon123',
    full_name: 'Leon (Administrator)',
    email:     'leon@singlepointcalls.co.uk',
    role:      'admin',
  },
];

async function createAccounts() {
  console.log('Creating operator accounts…\n');

  for (const account of ACCOUNTS) {
    const hash = await bcrypt.hash(account.password, 12);
    const result = await pool.query(
      `INSERT INTO operators (username, password_hash, full_name, email, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             full_name     = EXCLUDED.full_name,
             email         = EXCLUDED.email,
             role          = EXCLUDED.role
       RETURNING id, username, role`,
      [account.username, hash, account.full_name, account.email, account.role]
    );

    const row = result.rows[0];
    console.log(`✅  ${row.role.toUpperCase().padEnd(9)} | username: ${row.username.padEnd(12)} | id: ${row.id}`);
  }

  console.log('\n⚠  REMINDER: Both accounts use short passwords that do not meet the');
  console.log('   12-character security policy. Change them at Admin → Operators after');
  console.log('   first login.\n');

  await pool.end();
}

createAccounts().catch(err => {
  console.error('Account creation failed:', err.message);
  process.exit(1);
});
