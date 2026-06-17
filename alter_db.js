import { pgPool } from './src/config/db.js';

async function alterTable() {
  try {
    await pgPool.query(`ALTER TABLE MARKETING_CAMPAIGN ADD COLUMN IF NOT EXISTS LEAD_LIMIT INT DEFAULT 5;`);
    console.log("Table altered successfully.");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

alterTable();
