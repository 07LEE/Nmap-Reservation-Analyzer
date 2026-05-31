import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

// Load config file
const configPath = path.resolve('config/config.json');
if (!fs.existsSync(configPath)) {
  console.error('config.json file not found.');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const { targetDays, outputPath } = config;

// Load studios list file
const studiosPath = path.resolve('config/studios.json');
if (!fs.existsSync(studiosPath)) {
  console.error('studios.json file not found. Studio list configuration required.');
  process.exit(1);
}
const studios = JSON.parse(fs.readFileSync(studiosPath, 'utf-8'));

// Generate target date list (YYYY-MM-DD format in KST)
function getTargetDates(days) {
  const dates = [];
  const offset = 9 * 60 * 60 * 1000; // KST offset
  const now = new Date(Date.now() + offset);
  
  for (let i = 0; i < days; i++) {
    const targetDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const yyyy = targetDate.getUTCFullYear();
    const mm = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getUTCDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
  }
  return dates;
}

// Auto-extract linked resource IDs via Puppeteer when only bizId is provided
async function getAutoResourceIds(page, studio) {
  const resourceIds = new Set();
  const url = studio.url || `https://m.booking.naver.com/booking/10/bizes/${studio.bizId}`;
  
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    const state = await page.evaluate(() => {
      return window.__APOLLO_STATE__ || window.__PRELOADED_STATE__ || window.__NEXT_DATA__ || null;
    });

    if (state) {
      const keys = Object.keys(state);
      keys.forEach(key => {
        if (key.startsWith('BizItem:')) {
          const id = key.split(':')[1].split('_')[0];
          if (/^[0-9]+$/.test(id)) {
            resourceIds.add(id);
          }
        }
      });
    }
  } catch (e) {
    // Return empty list on error
  }

  return Array.from(resourceIds);
}

// Fetch reservation data for a specific studio and date
async function fetchReservations(page, studio, date) {
  let url = `https://m.booking.naver.com/booking/10/bizes/${studio.bizId}/items/${studio.resourceId}?startDate=${date}`;
  if (studio.url) {
    const baseUrl = studio.url.split('?')[0];
    if (baseUrl.includes('/items/')) {
      url = `${baseUrl}?startDate=${date}`;
    } else {
      url = `${baseUrl}/items/${studio.resourceId}?startDate=${date}`;
    }
  }
  let scheduleData = null;

  const responseHandler = async (response) => {
    const resUrl = response.url();
    if (resUrl.includes('opName=hourlySchedule') && !scheduleData) {
      try {
        scheduleData = await response.json();
      } catch (e) {
        // Ignore parse errors
      }
    }
  };

  page.on('response', responseHandler);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    
    // Wait up to 5 seconds for API response data
    for (let attempt = 0; attempt < 25; attempt++) {
      if (scheduleData) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  } catch (error) {
    console.error(`[ERROR] ${studio.name} (resource:${studio.resourceId}, date:${date}) load failed:`, error.message);
  }

  page.off('response', responseHandler);

  if (!scheduleData || !scheduleData.data || !scheduleData.data.schedule || !scheduleData.data.schedule.bizItemSchedule) {
    console.error(`[ERROR] ${studio.name} (resource:${studio.resourceId}, date:${date}) data collection failed`);
    return [];
  }

  const hourly = scheduleData.data.schedule.bizItemSchedule.hourly || [];
  const businessHoursOnly = hourly.filter(h => h.isUnitBusinessDay && h.unitStartTime && h.unitStartTime.startsWith(date));

  const results = businessHoursOnly.map(h => {
    let timeStr = 'unknown';
    if (h.unitStartTime) {
      const parts = h.unitStartTime.split(' ');
      if (parts.length > 1) {
        timeStr = parts[1].substring(0, 5);
      }
    }

    const isAvailable = h.unitBookingCount < h.unitStock;


    let slotDate = date;
    if (h.unitStartTime) {
      const parts = h.unitStartTime.split(' ');
      if (parts.length > 0) {
        slotDate = parts[0];
      }
    }

    return {
      studioName: studio.name,
      resourceId: studio.resourceId,
      date: slotDate,
      time: timeStr,
      status: isAvailable ? 'AVAILABLE' : 'UNAVAILABLE'
    };

  });

  return results;
}

// Main execution function
async function main() {
  const dates = getTargetDates(targetDays);
  console.log(`Target dates: ${dates.join(', ')}`);
  
  const allResults = [];

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  // Spoof mobile device user agent
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1');

  try {
    for (const studio of studios) {
      console.log(`Collecting: ${studio.name} (bizId: ${studio.bizId})`);
      
      let resourceIds = [];
      if (studio.resourceId) {
        resourceIds.push(studio.resourceId);
      } else {
        console.log(`[INFO] No resource ID found, running auto-detection...`);
        resourceIds = await getAutoResourceIds(page, studio);
        if (resourceIds.length === 0) {
          console.error(`[ERROR] Failed to auto-extract resource ID for ${studio.name}. Please set resourceId manually in studios.json.`);
          continue;
        }
        console.log(`[DONE] Detected resource IDs: ${resourceIds.join(', ')}`);
      }

      for (const resId of resourceIds) {
        const tempStudio = { ...studio, resourceId: resId };
        for (const date of dates) {
          const dayResults = await fetchReservations(page, tempStudio, date);
          allResults.push(...dayResults);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (allResults.length === 0) {
    console.log('No reservation data collected.');
    return;
  }

  // Convert to CSV format (with resource ID column)
  const csvHeaders = 'StudioName,ResourceID,Date,Time,Status\n';
  const csvRows = allResults.map(r => 
    `"${r.studioName}","${r.resourceId}","${r.date}","${r.time}","${r.status}"`
  ).join('\n');
  
  const csvContent = csvHeaders + csvRows;

  const resolvedOutputDir = path.resolve(outputPath);
  if (!fs.existsSync(resolvedOutputDir)) {
    fs.mkdirSync(resolvedOutputDir, { recursive: true });
  }

  const offset = 9 * 60 * 60 * 1000;
  const now = new Date(Date.now() + offset);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const timestamp = `${yyyy}${mm}${dd}`;

  const finalPath = path.join(resolvedOutputDir, `reservations_${timestamp}.csv`);
  fs.writeFileSync(finalPath, '\ufeff' + csvContent, 'utf-8');
  console.log(`Collection complete. Output saved to: ${finalPath}`);
}

main();
