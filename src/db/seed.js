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
      'Demo GP Surgery',
      'DEMO001',
      ['+441604000001'],
      'Thank you for calling Demo GP Surgery. How can I help you today?\n\n' +
        '- Take the caller\'s full name, telephone number, and reason for calling\n' +
        '- Ask whether this is urgent or can wait until surgery hours\n' +
        '- For emergencies: dispatch the on-call GP immediately\n' +
        '- For non-urgent: take a message and advise a callback within 2 working hours',
      'Thank you for calling Demo GP Surgery. You\'re through to the answering service.',
      'Europe/London',
    ]
  );

  if (clientResult.rows.length > 0) {
    const clientId = clientResult.rows[0].id;
    // Create sample contact
    await pool.query(
      `INSERT INTO contacts (client_id, name, title, phone, email, notify_email, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [clientId, 'Dr. Jane Smith', 'On-Call GP', '+447700900001', 'drsmith@demo.co.uk', true, 1]
    );
    console.log('Created sample client: Demo GP Surgery (+441604000001)');
  }

  console.log('Seeding complete.');
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
