#!/usr/bin/env node
// Register a site for the analytics tracker and print its API key.
//   node scripts/create-site.js example.com
const { randomUUID, randomBytes } = require('crypto');

process.env.LOG_LEVEL ||= 'warn';
const { db } = require('@scheduler/core');

const main = async () => {
  const domain = process.argv[2];
  if (!domain) throw new Error('usage: node scripts/create-site.js <domain>');
  await db.migrate();
  const apiKey = `site_${randomBytes(24).toString('base64url')}`;
  const { rows } = await db.pool.query(
    'INSERT INTO sites (id, domain, api_key) VALUES ($1, $2, $3) RETURNING id',
    [randomUUID(), domain, apiKey],
  );
  console.log(JSON.stringify({ siteId: rows[0].id, domain, apiKey }, null, 2));
  await db.pool.end();
};

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
