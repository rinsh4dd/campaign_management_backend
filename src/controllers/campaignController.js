import { db } from '../config/db.js';
import { checkAndRunCampaigns } from '../services/schedulerService.js';

/**
 * Handle all Data Query (GET) operations based on mode
 */
export const handleQuery = async (req, res) => {
  try {
    const { mode, id, page, limit } = req.body;
    if (!mode) return res.status(400).json({ error: "Missing required field: mode" });

    const p = page ? parseInt(page, 10) : 1;
    const l = limit ? parseInt(limit, 10) : 50;

    switch (mode) {
      case 'ALL':
        return res.status(200).json(await db.getAllCampaigns(p, l));

      case 'BY_ID':
        if (!id) return res.status(400).json({ error: "Missing required 'id' for BY_ID mode" });
        const campaign = await db.getCampaignById(id);
        if (!campaign) return res.status(404).json({ error: "Campaign not found" });
        const leads = await db.getLeadsByCampaignId(id, p, l);
        const logs = await db.getLogsByCampaignId(id, p, l);
        return res.status(200).json({ campaign, leads, logs });

      case 'LEADS':
        if (!id) return res.status(400).json({ error: "Missing required 'id' for LEADS mode" });
        const campLeads = await db.getLeadsByCampaignId(id, p, l);
        return res.status(200).json(campLeads);

      case 'LOGS':
        if (!id) return res.status(400).json({ error: "Missing campaign id for mode LOGS" });
        return res.status(200).json(await db.getLogsByCampaignId(id, p, l));
      case 'ALL_LOGS':
        return res.status(200).json(await db.getAllLogs(p, l));
      case 'ALL_LEADS':
        return res.status(200).json(await db.getAllLeads(p, l));
      default:
        return res.status(400).json({ error: `Invalid mode: ${mode}` });
    }
  } catch (err) {
    console.error(`Error in handleQuery (mode: ${req.body.mode}):`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

/**
 * Handle all Action (Modify) operations based on action type
 */
export const handleAction = async (req, res) => {
  const { action, id, payload } = req.body;

  try {
    switch (action) {
      case 'ADD':
        if (!payload || !payload.campaignName || !payload.searchQuery || !payload.actionCode || !payload.scheduledTime) {
          return res.status(400).json({
            error: "Missing required payload fields. Provide: campaignName, searchQuery, actionCode, scheduledTime"
          });
        }
        const newCampaign = await db.createCampaign({
          ...payload,
          leadLimit: payload.leadLimit || 5
        });
        await db.saveLog(newCampaign.id || newCampaign.ID, `Campaign created successfully.`);
        return res.status(201).json(newCampaign);

      case 'DELETE':
        if (!id) return res.status(400).json({ error: "Missing required 'id' for DELETE action" });
        await db.deleteCampaignById(id);
        return res.status(200).json({ message: `Campaign ${id} deleted.` });

      case 'TRIGGER':
        console.log('[API] Manually triggered campaign scheduler run.');
        checkAndRunCampaigns();
        return res.status(202).json({ message: "Background campaign run triggered." });

      default:
        return res.status(400).json({ error: `Invalid action: ${action}` });
    }
  } catch (err) {
    console.error(`Error in handleAction (action: ${action}):`, err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
