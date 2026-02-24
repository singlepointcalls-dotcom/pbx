#!/usr/bin/env node
'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function seed() {
  console.log('Seeding database...');

  // Create default admin operator
  const hash = await bcrypt.hash('admin123', 12);
  await pool.query(
    `INSERT INTO operators (username, password_hash, full_name, email, role)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (username) DO NOTHING`,
    ['admin', hash, 'System Administrator', 'admin@localhost', 'admin']
  );
  console.log('Created default admin operator: admin / admin123');

  // Create a sample client
  const clientResult = await pool.query(
    `INSERT INTO clients (name, account_number, dids, script, greeting, timezone)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (account_number) DO NOTHING
     RETURNING id`,
    [
      'Demo Medical Practice',
      'DEMO001',
      ['+15551234567'],
      'Thank you for calling Demo Medical Practice. How can I help you today?\n\n' +
        '- Get caller name, phone number, and reason for calling\n' +
        '- Ask if this is an emergency\n' +
        '- For emergencies: dispatch on-call physician immediately\n' +
        '- For non-urgent: take a message and advise callback within 2 business hours',
      'Thank you for calling Demo Medical Practice. This is the answering service.',
      'America/New_York',
    ]
  );

  if (clientResult.rows.length > 0) {
    const clientId = clientResult.rows[0].id;
    // Create sample contact
    await pool.query(
      `INSERT INTO contacts (client_id, name, title, phone, email, notify_email, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [clientId, 'Dr. Jane Smith', 'On-Call Physician', '+15559876543', 'drsmith@demo.com', true, 1]
    );
    console.log('Created sample client: Demo Medical Practice (+15551234567)');
  }

  console.log('Seeding complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
