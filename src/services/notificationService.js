import sql from 'mssql';
import { getSqlServerConnection, db } from '../config/db.js';

/**
 * Queue a batch of WhatsApp/Email notifications via Stored Procedure PR_INSERT_NOTIFICATION_QUEUE
 * 
 * @param {Array<object>} notifications - Array of notification objects to be queued
 * @returns {Promise<boolean>}
 */
export const queueNotificationsBatch = async (notifications) => {
  if (!notifications || notifications.length === 0) {
    console.log('[NotificationService] No notifications to queue in batch.');
    return true;
  }

  console.log(`[NotificationService] Queueing batch of ${notifications.length} notification(s).`);

  if (db.isNotificationMock) {
    console.log(`[Mock SP Exec] Executing PR_INSERT_NOTIFICATION_QUEUE with TVP batch (@DATA) of size ${notifications.length}:`);
    console.table(notifications.map(n => ({
      Mode: n.NOTIFICATION_MODE,
      ToPhone: n.TO_PHONE,
      TemplateName: n.TEMPLATE_NAME,
      Payload: n.TEMPLATE_PAYLOAD_JSON,
      TemplateId: n.TEMPLATE_ID,
      ApiKeyEnc: n.ENCRYPTED_API_KEY ? (n.ENCRYPTED_API_KEY.substring(0, 15) + '...') : null,
      Sender: n.SENDER_NO,
      Subject: n.SUBJECT,
      Body: n.BODY,
      ToMail: n.TO_MAIL
    })));
    return true;
  }

  try {
    const pool = await getSqlServerConnection();
    const request = pool.request();

    // Construct the Table-Valued Parameter (TVP) structure matching TYPE_NOTIFICATION_QUEUE
    const table = new sql.Table('dbo.TYPE_NOTIFICATION_QUEUE');
    table.columns.add('NOTIFICATION_MODE', sql.NVarChar(10), { nullable: false });
    table.columns.add('SOURCE_APP', sql.NVarChar(100), { nullable: true });
    table.columns.add('REFERENCE_ID', sql.NVarChar(100), { nullable: true });
    table.columns.add('SCHEDULED_DATE', sql.DateTime, { nullable: true });
    table.columns.add('TO_PHONE', sql.NVarChar(50), { nullable: true });
    table.columns.add('TEMPLATE_NAME', sql.NVarChar(200), { nullable: true });
    table.columns.add('TEMPLATE_PAYLOAD_JSON', sql.NVarChar(sql.MAX), { nullable: true });
    table.columns.add('TEMPLATE_ID', sql.NVarChar(100), { nullable: true });
    table.columns.add('ENCRYPTED_API_KEY', sql.NVarChar(500), { nullable: true });
    table.columns.add('SENDER_NO', sql.NVarChar(50), { nullable: true });
    table.columns.add('SUBJECT', sql.NVarChar(500), { nullable: true });
    table.columns.add('BODY', sql.NVarChar(sql.MAX), { nullable: true });
    table.columns.add('ATTACHMENT', sql.NVarChar(sql.MAX), { nullable: true });
    table.columns.add('TO_MAIL', sql.NVarChar(500), { nullable: true });
    table.columns.add('FROM_MAIL', sql.NVarChar(200), { nullable: true });
    table.columns.add('EMAIL_USERNAME', sql.NVarChar(200), { nullable: true });
    table.columns.add('EMAIL_PASSWORD', sql.NVarChar(500), { nullable: true });
    table.columns.add('EMAIL_HOST', sql.NVarChar(200), { nullable: true });
    table.columns.add('EMAIL_PORT', sql.Int, { nullable: true });
    table.columns.add('EMAIL_SSL', sql.NVarChar(1), { nullable: true });

    // Populate rows in the table
    for (const n of notifications) {
      table.rows.add(
        n.NOTIFICATION_MODE || 'WATS',
        n.SOURCE_APP || 'MARKETING',
        n.REFERENCE_ID != null ? String(n.REFERENCE_ID) : null,
        n.SCHEDULED_DATE || null,
        n.TO_PHONE || null,
        n.TEMPLATE_NAME || null,
        n.TEMPLATE_PAYLOAD_JSON || null,
        n.TEMPLATE_ID || null,
        n.ENCRYPTED_API_KEY || null,
        n.SENDER_NO || null,
        n.SUBJECT || null,
        n.BODY || null,
        n.ATTACHMENT || null,
        n.TO_MAIL || null,
        n.FROM_MAIL || null,
        n.EMAIL_USERNAME || null,
        n.EMAIL_PASSWORD || null,
        n.EMAIL_HOST || null,
        n.EMAIL_PORT != null ? parseInt(n.EMAIL_PORT, 10) : null,
        n.EMAIL_SSL || null
      );
    }

    // Pass the TVP as the input parameter @DATA
    request.input('DATA', table);

    await request.execute('PR_INSERT_NOTIFICATION_QUEUE');
    console.log(`[NotificationService] Batch of ${notifications.length} notification(s) successfully queued in SQL Server.`);
    return true;
  } catch (err) {
    console.error('[NotificationService] Failed to execute SP for notifications batch:', err.message);
    throw err;
  }
};
