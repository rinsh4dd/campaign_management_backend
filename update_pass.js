import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function updatePassword() {
  try {
    const newPassword = 'Sharaco@123';
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    
    await pgPool.query(
      `UPDATE USER_MAST SET PASSWORD = $1 WHERE EMAIL = 'admin@flowbee.io'`,
      [hashedPassword]
    );
    
    console.log("Password updated successfully to Sharaco@123.");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

updatePassword();
