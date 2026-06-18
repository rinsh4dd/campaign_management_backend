import dotenv from 'dotenv';

dotenv.config();

/**
 * Lead Provider Service
 * Connects directly to the live Apify Google Maps Scraper (compass/crawler-google-places).
 * 
 * @param {string} searchQuery The search query (e.g. "Supermarkets in Dubai")
 * @param {number} leadLimit The maximum number of leads to fetch
 * @returns {Promise<Array>} List of business leads
 */
export const activeRuns = new Map(); // Tracks campaignId -> runId

export const fetchLeads = async (searchQuery, leadLimit = 5, campaignId = null) => {
  // Mock mode: return fake leads for testing without Apify
  if (process.env.LEAD_PROVIDER === 'mock') {
    console.log(`[LeadProvider] MOCK MODE - Returning up to ${leadLimit} dummy leads for: "${searchQuery}"`);
    return [
      {
        customerName: 'Al Raha Supermarket',
        email: 'alraha@example.com',
        mobile: '917909147518',
        address: 'Kozhikode Town, Kerala',
        website: 'https://alraha-supermarket.com',
        placeId: 'mock_place_001'
      },
      {
        customerName: 'Fresh Mart Kozhikode',
        email: 'freshmart@example.com',
        mobile: '917909147518',
        address: 'SM Street, Kozhikode',
        website: 'https://freshmart-kzd.com',
        placeId: 'mock_place_002'
      },
      {
        customerName: 'City Supermarket',
        email: null,
        mobile: '917909147518',
        address: 'Mavoor Road, Kozhikode',
        website: null,
        placeId: 'mock_place_003'
      }
    ].slice(0, leadLimit);
  }

  const apifyToken = process.env.APIFY_TOKEN;

  if (!apifyToken) {
    throw new Error('APIFY_TOKEN is missing in environment configuration. Cannot run scraper.');
  }

  console.log(`[LeadProvider] Initiating Apify Google Maps Scraper for: "${searchQuery}" with limit: ${leadLimit}`);
  
  const maxPlaces = leadLimit || Number(process.env.APIFY_MAX_PLACES || 5);
  
  // 1. Trigger the Apify Google Maps Scraper Actor Run
  // Reference: compass/crawler-google-places (compass~crawler-google-places)
  const runUrl = `https://api.apify.com/v2/acts/compass~crawler-google-places/runs?token=${apifyToken}`;
  const runResponse = await fetch(runUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
      searchStringsArray: [searchQuery],
      maxCrawledPlacesPerSearch: maxPlaces,
      maxCrawledPlaces: maxPlaces,
      scrapeResponseHeaders: false,
      includeContactDetails: true,
      scrapeSocialMediaProfiles: {
        facebooks: true,
        instagrams: true,
        twitters: true
      }
    })
  });

  if (!runResponse.ok) {
    const errorText = await runResponse.text();
    throw new Error(`Apify trigger failed (HTTP ${runResponse.status}): ${errorText}`);
  }

  const runResult = await runResponse.json();
  const runId = runResult.data.id;
  const datasetId = runResult.data.defaultDatasetId;
  console.log(`[LeadProvider] Actor run triggered. Run ID: ${runId}, Dataset ID: ${datasetId}`);

  if (campaignId) {
    activeRuns.set(campaignId, runId);
  }

  // 2. Poll status until execution completes (Limit: 5 minutes)
  let status = 'RUNNING';
  let pollCount = 0;
  const maxPolls = 60; // 60 polls * 5 seconds = 5 minutes max

  while (['RUNNING', 'READY'].includes(status) && pollCount < maxPolls) {
    pollCount++;
    // Wait 5 seconds between polls
    await new Promise(resolve => setTimeout(resolve, 5000));

    const pollUrl = `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`;
    const pollResponse = await fetch(pollUrl);
    if (!pollResponse.ok) {
      console.warn(`[LeadProvider] Status poll failed (HTTP ${pollResponse.status}). Retrying...`);
      continue;
    }

    const pollResult = await pollResponse.json();
    status = pollResult.data.status;
    console.log(`[LeadProvider] Scraper Run Status (Attempt ${pollCount}): ${status}`);

    if (status === 'SUCCEEDED') {
      break;
    } else if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
      throw new Error(`Apify run terminated with status: ${status}`);
    }
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(`Apify run timed out after ${pollCount * 5} seconds.`);
  }

  // 3. Fetch scraped items from dataset
  console.log(`[LeadProvider] Scraping succeeded. Fetching dataset items...`);
  const datasetUrl = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`;
  const datasetResponse = await fetch(datasetUrl);
  if (!datasetResponse.ok) {
    throw new Error(`Failed to retrieve dataset items (HTTP ${datasetResponse.status})`);
  }

  const items = await datasetResponse.json();
  console.log(`[LeadProvider] Retrieved ${items.length} items from dataset.`);

  // 4. Map dataset properties to campaign leads structure
  return items.map(item => {
    // Map email addresses safely (checks primary, secondary contact details crawled from page, or arrays)
    const email = item.email || item.contactEmail || (item.emails && item.emails[0]) || null;
    
    return {
      customerName: item.title || item.name || 'Unnamed Business',
      email: email,
      mobile: item.phone || item.phoneNormalized || null,
      address: item.address || item.street || 'No Address',
      website: item.website || null,
      placeId: item.placeId || item.cid || null
    };
  });
};

/**
 * Abort a running Apify scraper for a given campaign.
 * @param {number|string} campaignId 
 */
export const abortRun = async (campaignId) => {
  const runId = activeRuns.get(campaignId);
  if (!runId) {
    throw new Error(`No active Apify run found for campaign ID ${campaignId}`);
  }

  const apifyToken = process.env.APIFY_TOKEN;
  if (!apifyToken) throw new Error('APIFY_TOKEN is missing');

  console.log(`[LeadProvider] Aborting Apify Run ID ${runId} for Campaign ID ${campaignId}...`);
  const abortUrl = `https://api.apify.com/v2/actor-runs/${runId}/abort?token=${apifyToken}`;
  const response = await fetch(abortUrl, { method: 'POST' });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to abort run ${runId}: ${errorText}`);
  }

  console.log(`[LeadProvider] Successfully sent abort request for Run ID ${runId}.`);
  activeRuns.delete(campaignId);
  return true;
};
