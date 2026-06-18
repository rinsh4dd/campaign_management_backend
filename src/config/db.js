import pg from 'pg';
import sql from 'mssql';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const { Pool } = pg;
const isNotificationMock = process.env.NOTIFICATION_MOCK === 'true';

let pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon') ? { rejectUnauthorized: false } : false
});

pgPool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err);
});

/**
 * Initialize PostgreSQL connection and verify/create database tables.
 */
export const initDb = async () => {
  console.log('Connecting to PostgreSQL database...');
  await pgPool.query('SELECT NOW()');
  console.log('PostgreSQL connection established.');

  // Create PostgreSQL tables if they don't exist
  await pgPool.query(`
      CREATE TABLE IF NOT EXISTS MARKETING_CAMPAIGN (
        ID SERIAL PRIMARY KEY,
        CAMPAIGN_NAME VARCHAR(255) NOT NULL,
        SEARCH_QUERY VARCHAR(500) NOT NULL,
        ACTION_CODE VARCHAR(100) NOT NULL,
        STATUS VARCHAR(10) DEFAULT 'P', -- P: Pending, R: Running, D: Done, E: Error
        SCHEDULED_TIME TIMESTAMP,
        CREATED_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        COMPLETED_DATE TIMESTAMP,
        LEAD_LIMIT INT DEFAULT 5
      );
    `);

    // Add LEAD_LIMIT if it doesn't exist (for existing tables)
    try {
      await pgPool.query(`ALTER TABLE MARKETING_CAMPAIGN ADD COLUMN LEAD_LIMIT INT DEFAULT 5;`);
    } catch (e) {
      // Column might already exist, safe to ignore
    }

    try {
      await pgPool.query(`ALTER TABLE MARKETING_CAMPAIGN ADD COLUMN TIMEZONE VARCHAR(100);`);
    } catch (e) {
      // Column might already exist, safe to ignore
    }

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS USER_MAST (
        ID SERIAL PRIMARY KEY,
        ROLE VARCHAR(50) NOT NULL,
        NAME VARCHAR(255) NOT NULL,
        EMAIL VARCHAR(255) UNIQUE NOT NULL,
        PASSWORD VARCHAR(255) NOT NULL,
        CREATED_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed admin user if none exists
    const adminEmail = 'admin@flowbee.io';
    const { rows: adminRows } = await pgPool.query(`SELECT * FROM USER_MAST WHERE EMAIL = $1`, [adminEmail]);
    if (adminRows.length === 0) {
      const hashedPassword = await bcrypt.hash('admin@flowbee.io', 10);
      await pgPool.query(
        `INSERT INTO USER_MAST (ROLE, NAME, EMAIL, PASSWORD) VALUES ($1, $2, $3, $4)`,
        ['admin', 'Administrator', adminEmail, hashedPassword]
      );
      console.log('Seeded default admin user: admin@flowbee.io');
    }

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS MARKETING_LEAD
    (
        ID BIGSERIAL PRIMARY KEY,
        CAMPAIGN_ID BIGINT NOT NULL,
        CUSTOMER_NAME VARCHAR(500),
        EMAIL VARCHAR(500),
        MOBILE VARCHAR(50),
        ADDRESS TEXT,
        WEBSITE VARCHAR(500),
        PLACE_ID VARCHAR(200),
        NOTIFICATION_STATUS CHAR(1) DEFAULT 'P',
        CREATED_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS MARKETING_LOG
    (
        ID BIGSERIAL PRIMARY KEY,
        CAMPAIGN_ID BIGINT,
        LOG_MESSAGE TEXT,
        CREATED_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log('PostgreSQL database tables verified and created.');
};

let sqlPool = null;

/**
 * SQL Server connection pool initialization
 */
export const getSqlServerConnection = async () => {
  if (isNotificationMock) {
    return null;
  }
  
  if (sqlPool) {
    return sqlPool;
  }

  const connStr = process.env.SQL_SERVER_CONNECTION_STRING;
  const parts = connStr.split(';').reduce((acc, part) => {
    const [key, ...valParts] = part.split('=');
    if (key && valParts.length > 0) {
      acc[key.trim().toLowerCase()] = valParts.join('=').trim();
    }
    return acc;
  }, {});

  const cleanVal = (val) => {
    if (!val) return val;
    return val.trim().replace(/^['"]|['"]$/g, '');
  };

  const serverPart = cleanVal(parts['server'] || parts['data source'] || '');
  const [serverHost, serverPort] = serverPart.split(',');

  const config = {
    server: serverHost,
    port: serverPort ? parseInt(serverPort, 10) : 1433,
    database: cleanVal(parts['database'] || parts['initial catalog']),
    user: cleanVal(parts['user id'] || parts['uid']),
    password: cleanVal(parts['password'] || parts['pwd']),
    options: {
      encrypt: cleanVal(parts['encrypt']) === 'true',
      trustServerCertificate: cleanVal(parts['trustservercertificate']) === 'true' || true
    }
  };

  console.log('[db.js] Parsed SQL Server Config:', {
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    passwordLength: config.password ? config.password.length : 0,
    passwordMasked: config.password ? `${config.password.substring(0, 3)}...${config.password.substring(config.password.length - 3)}` : null,
    encrypt: config.options.encrypt,
    trustServerCertificate: config.options.trustServerCertificate
  });

  sqlPool = await new sql.ConnectionPool(config).connect();
  return sqlPool;
};

// Data Access Layer (DAL) Abstraction
export const db = {
  isNotificationMock,

  async getUserByEmail(email) {
    const { rows } = await pgPool.query(`SELECT * FROM USER_MAST WHERE EMAIL = $1`, [email]);
    return rows[0] || null;
  },

  async getUserById(id) {
    const { rows } = await pgPool.query(`SELECT * FROM USER_MAST WHERE ID = $1`, [id]);
    return rows[0] || null;
  },

  async updatePassword(id, hashedPw) {
    const { rowCount } = await pgPool.query(`UPDATE USER_MAST SET PASSWORD = $1 WHERE ID = $2`, [hashedPw, id]);
    return rowCount > 0;
  },
  
  async getPendingCampaigns() {
    const { rows } = await pgPool.query(
      `SELECT * FROM MARKETING_CAMPAIGN WHERE STATUS = 'P' AND SCHEDULED_TIME <= NOW()`
    );
    return rows;
  },

  async updateCampaignStatus(id, status, completedDate = null) {
    const { rows } = await pgPool.query(
      `UPDATE MARKETING_CAMPAIGN SET STATUS = $1, COMPLETED_DATE = $2 WHERE ID = $3 RETURNING *`,
      [status, completedDate, id]
    );
    return rows[0];
  },

  async createCampaign({ campaignName, searchQuery, actionCode, scheduledTime, leadLimit, timezone }) {
    const limit = leadLimit ? parseInt(leadLimit, 10) : 5;
    const { rows } = await pgPool.query(
      `INSERT INTO MARKETING_CAMPAIGN (CAMPAIGN_NAME, SEARCH_QUERY, ACTION_CODE, SCHEDULED_TIME, LEAD_LIMIT, TIMEZONE)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [campaignName, searchQuery, actionCode, scheduledTime, limit, timezone]
    );
    return rows[0];
  },

  async getCampaignById(id) {
    const { rows } = await pgPool.query(`SELECT * FROM MARKETING_CAMPAIGN WHERE ID = $1`, [id]);
    return rows[0] || null;
  },

  async getAllCampaigns(page = 1, pageSize = 50, search = "") {
    const offset = (page - 1) * pageSize;
    let query = `SELECT *, COUNT(*) OVER() AS total_count FROM MARKETING_CAMPAIGN`;
    let params = [pageSize, offset];
    
    if (search) {
      query += ` WHERE CAMPAIGN_NAME ILIKE $3 OR SEARCH_QUERY ILIKE $3`;
      params.push(`%${search}%`);
    }
    query += ` ORDER BY CREATED_DATE DESC LIMIT $1 OFFSET $2`;

    const { rows } = await pgPool.query(query, params);
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    return { data: rows, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  },

  async saveLead({ campaignId, customerName, email, mobile, address, website, placeId }) {
    const { rows } = await pgPool.query(
      `INSERT INTO MARKETING_LEAD (CAMPAIGN_ID, CUSTOMER_NAME, EMAIL, MOBILE, ADDRESS, WEBSITE, PLACE_ID)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [campaignId, customerName, email, mobile, address, website, placeId]
    );
    return rows[0];
  },

  async updateLeadNotificationStatus(leadId, status) {
    const { rows } = await pgPool.query(
      `UPDATE MARKETING_LEAD SET NOTIFICATION_STATUS = $1 WHERE ID = $2 RETURNING *`,
      [status, leadId]
    );
    return rows[0];
  },

  async getLeadsByCampaignId(campaignId, page = 1, pageSize = 50, search = "") {
    const offset = (page - 1) * pageSize;
    let query = `SELECT *, COUNT(*) OVER() AS total_count FROM MARKETING_LEAD WHERE CAMPAIGN_ID = $1`;
    let params = [campaignId, pageSize, offset];

    if (search) {
      query += ` AND (CUSTOMER_NAME ILIKE $4 OR MOBILE ILIKE $4 OR EMAIL ILIKE $4)`;
      params.push(`%${search}%`);
    }
    query += ` ORDER BY CREATED_DATE DESC LIMIT $2 OFFSET $3`;

    const { rows } = await pgPool.query(query, params);
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    return { data: rows, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  },

  async getAllLeads(page = 1, pageSize = 50, search = "") {
    const offset = (page - 1) * pageSize;
    let query = `SELECT L.*, C.CAMPAIGN_NAME, COUNT(*) OVER() AS total_count 
                 FROM MARKETING_LEAD L 
                 LEFT JOIN MARKETING_CAMPAIGN C ON L.CAMPAIGN_ID = C.ID`;
    let params = [pageSize, offset];

    if (search) {
      query += ` WHERE L.CUSTOMER_NAME ILIKE $3 OR L.MOBILE ILIKE $3 OR L.EMAIL ILIKE $3 OR C.CAMPAIGN_NAME ILIKE $3`;
      params.push(`%${search}%`);
    }
    query += ` ORDER BY L.ID DESC LIMIT $1 OFFSET $2`;

    const { rows } = await pgPool.query(query, params);
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    return { data: rows, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  },

  async saveLog(campaignId, logMessage) {
    const { rows } = await pgPool.query(
      `INSERT INTO MARKETING_LOG (CAMPAIGN_ID, LOG_MESSAGE) VALUES ($1, $2) RETURNING *`,
      [campaignId, logMessage]
    );
    return rows[0];
  },

  async getLogsByCampaignId(campaignId, page = 1, pageSize = 50, search = "") {
    const offset = (page - 1) * pageSize;
    let query = `SELECT *, COUNT(*) OVER() AS total_count FROM MARKETING_LOG WHERE CAMPAIGN_ID = $1`;
    let params = [campaignId, pageSize, offset];

    if (search) {
      query += ` AND LOG_MESSAGE ILIKE $4`;
      params.push(`%${search}%`);
    }
    query += ` ORDER BY CREATED_DATE DESC LIMIT $2 OFFSET $3`;

    const { rows } = await pgPool.query(query, params);
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    return { data: rows, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  },

  async getAllLogs(page = 1, pageSize = 50, search = "") {
    const offset = (page - 1) * pageSize;
    let query = `SELECT L.*, C.CAMPAIGN_NAME, COUNT(*) OVER() AS total_count 
                 FROM MARKETING_LOG L 
                 LEFT JOIN MARKETING_CAMPAIGN C ON L.CAMPAIGN_ID = C.ID`;
    let params = [pageSize, offset];

    if (search) {
      query += ` WHERE L.LOG_MESSAGE ILIKE $3 OR C.CAMPAIGN_NAME ILIKE $3`;
      params.push(`%${search}%`);
    }
    query += ` ORDER BY L.CREATED_DATE DESC LIMIT $1 OFFSET $2`;

    const { rows } = await pgPool.query(query, params);
    const total = rows.length > 0 ? parseInt(rows[0].total_count, 10) : 0;
    return { data: rows, meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) } };
  },

  async deleteAllCampaigns() {
    await pgPool.query(`DELETE FROM MARKETING_LOG`);
    await pgPool.query(`DELETE FROM MARKETING_LEAD`);
    await pgPool.query(`DELETE FROM MARKETING_CAMPAIGN`);
    return true;
  },

  async deleteCampaignById(id) {
    await pgPool.query(`DELETE FROM MARKETING_LOG WHERE CAMPAIGN_ID = $1`, [id]);
    await pgPool.query(`DELETE FROM MARKETING_LEAD WHERE CAMPAIGN_ID = $1`, [id]);
    await pgPool.query(`DELETE FROM MARKETING_CAMPAIGN WHERE ID = $1`, [id]);
    return true;
  }
};
