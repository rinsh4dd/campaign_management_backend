import cron from 'node-cron';
import { db } from '../config/db.js';
import { fetchLeads } from './leadProvider.js';
import { queueNotificationsBatch } from './notificationService.js';

let isRunning = false;

/**
 * Main worker logic to execute campaigns whose scheduled time has arrived.
 */
export const checkAndRunCampaigns = async () => {
  if (isRunning) {
    console.log('[Scheduler] A previous campaign run is still executing. Skipping this minute.');
    return;
  }

  isRunning = true;
  try {
    const pendingCampaigns = await db.getPendingCampaigns();

    if (pendingCampaigns.length === 0) {
      isRunning = false;
      return;
    }

    console.log(`[Scheduler] Found ${pendingCampaigns.length} campaign(s) to execute.`);
    await db.saveLog(null, `Scheduler run started. Processing ${pendingCampaigns.length} pending campaign(s).`);

    // Load template settings from environmental variables
    const whatsappTemplateName = process.env.WHATSAPP_TEMPLATE_NAME;
    const whatsappTemplateId = process.env.WHATSAPP_TEMPLATE_ID;
    const whatsappEncryptedApiKey = process.env.WHATSAPP_ENCRYPTED_API_KEY;
    const whatsappSenderNo = process.env.WHATSAPP_SENDER_NO;
    const whatsappPayloadTemplate = process.env.WHATSAPP_PAYLOAD_TEMPLATE;

    for (const campaign of pendingCampaigns) {
      const campaignId = campaign.id;
      console.log(`[Scheduler] Executing Campaign ID ${campaignId}: "${campaign.campaign_name}"`);
      
      try {
        // 1. Update Campaign Status to 'R' (Running)
        await db.updateCampaignStatus(campaignId, 'R');
        await db.saveLog(campaignId, `Campaign status updated to 'R' (Running).`);

        // 2. Fetch Leads from Lead Provider
        const rawLeads = await fetchLeads(campaign.search_query, campaign.lead_limit);
        await db.saveLog(campaignId, `Fetched ${rawLeads.length} lead(s) for query: "${campaign.search_query}".`);

        const savedLeads = [];
        const notificationsToQueue = [];

        // Replacement placeholder helper
        const replacePlaceholders = (text, lead) => {
          if (!text) return '';
          return text
            .replace(/{CustomerName}/g, lead.customerName || '')
            .replace(/{Address}/g, lead.address || '')
            .replace(/{Website}/g, lead.website || '')
            .replace(/{Email}/g, lead.email || '')
            .replace(/{Mobile}/g, lead.mobile || '');
        };

        // Fetch existing leads for duplicate prevention
        const existingLeadsResponse = await db.getLeadsByCampaignId(campaignId, 1, 10000);
        const existingLeads = existingLeadsResponse.data || [];

        // 3. Save Leads and Build Notification Objects
        for (const rawLead of rawLeads) {
          // Duplicate prevention: prevent inserting same business place multiple times within the same campaign run
          const isDuplicate = existingLeads.some(l => l.place_id === rawLead.placeId);
          if (isDuplicate) {
            console.log(`[Scheduler] Skipping duplicate lead Place ID ${rawLead.placeId} for campaign ${campaignId}`);
            continue;
          }

          // Save lead details
          const savedLead = await db.saveLead({
            campaignId,
            customerName: rawLead.customerName,
            email: rawLead.email,
            mobile: rawLead.mobile,
            address: rawLead.address,
            website: rawLead.website,
            placeId: rawLead.placeId
          });
          savedLeads.push(savedLead);

          // 4. Build WhatsApp notification if lead has mobile and template configuration exists
          if (rawLead.mobile && whatsappTemplateId) {
            let payloadJson = null;
            if (whatsappPayloadTemplate) {
              try {
                const parsedTemplate = JSON.parse(whatsappPayloadTemplate);
                const payload = parsedTemplate.map(param => ({
                  parametername: param.parametername,
                  parametervalue: typeof param.parametervalue === 'string' ? replacePlaceholders(param.parametervalue, rawLead) : param.parametervalue,
                  section: param.section
                }));
                payloadJson = JSON.stringify(payload);
              } catch (e) {
                console.error(`[Scheduler] Failed to construct payload for lead ${savedLead.id}:`, e.message);
              }
            }

            notificationsToQueue.push({
              leadId: savedLead.id,
              NOTIFICATION_MODE: 'WATS',
              SOURCE_APP: 'MARKETING-SCHEDULER',
              REFERENCE_ID: String(campaignId),
              SCHEDULED_DATE: new Date(),
              TO_PHONE: rawLead.mobile,
              TEMPLATE_NAME: whatsappTemplateName || null,
              TEMPLATE_PAYLOAD_JSON: payloadJson,
              TEMPLATE_ID: whatsappTemplateId,
              ENCRYPTED_API_KEY: whatsappEncryptedApiKey || null,
              SENDER_NO: whatsappSenderNo || null,
              SUBJECT: null,
              BODY: null,
              ATTACHMENT: null,
              TO_MAIL: null,
              FROM_MAIL: null,
              EMAIL_USERNAME: null,
              EMAIL_PASSWORD: null,
              EMAIL_HOST: null,
              EMAIL_PORT: null,
              EMAIL_SSL: null
            });
          }
        }

        // 5. Dispatch Notification Batch & Update Statuses
        if (notificationsToQueue.length > 0) {
          try {
            await queueNotificationsBatch(notificationsToQueue);
            
            // Update queued leads to 'D' (Done)
            const queuedLeadIds = new Set(notificationsToQueue.map(n => n.leadId));
            for (const savedLead of savedLeads) {
              if (queuedLeadIds.has(savedLead.id)) {
                await db.updateLeadNotificationStatus(savedLead.id, 'D');
              } else {
                await db.updateLeadNotificationStatus(savedLead.id, 'E');
              }
            }
          } catch (batchErr) {
            console.error(`[Scheduler] Batch notification queueing failed for campaign ID ${campaignId}:`, batchErr.message);
            // Mark all as Failed ('E')
            for (const savedLead of savedLeads) {
              await db.updateLeadNotificationStatus(savedLead.id, 'E');
            }
            throw batchErr;
          }
        } else {
          // No notifications were queued
          for (const savedLead of savedLeads) {
            await db.updateLeadNotificationStatus(savedLead.id, 'E');
          }
        }

        // 6. Set Campaign to 'D' (Completed/Done) and set completed date
        await db.updateCampaignStatus(campaignId, 'D', new Date());
        await db.saveLog(campaignId, `Campaign completed successfully.`);
        console.log(`[Scheduler] Campaign ID ${campaignId} completed.`);
      } catch (campaignErr) {
        console.error(`[Scheduler] Error executing campaign ID ${campaignId}:`, campaignErr);
        await db.updateCampaignStatus(campaignId, 'E', null);
        await db.saveLog(campaignId, `Campaign failed. Error: ${campaignErr.message}`);
      }
    }
  } catch (err) {
    console.error('[Scheduler] Critical error in background execution loop:', err);
  } finally {
    isRunning = false;
  }
};

/**
 * Start the background cron scheduler.
 */
export const startScheduler = () => {
  console.log('[Scheduler] Initializing Background Scheduler (running every minute)...');
  
  cron.schedule('* * * * *', async () => {
    console.log(`[Scheduler] Timer tick triggered at ${new Date().toISOString()}`);
    await checkAndRunCampaigns();
  });
};
