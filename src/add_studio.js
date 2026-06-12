import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

// Check for required arguments
let urlInput = process.argv[2];
if (!urlInput) {
  console.error('Error: Please provide a URL. (e.g. npm run add "https://...")');
  process.exit(1);
}

// Validate URL format and ensure it targets naver.com
try {
  const parsedUrl = new URL(urlInput);
  if (!parsedUrl.hostname.endsWith('naver.com')) {
    console.error('Error: Invalid URL. Only Naver domain (naver.com) is supported.');
    process.exit(1);
  }
} catch (e) {
  console.error('Error: Invalid URL format. Please provide a valid HTTP/HTTPS URL.');
  process.exit(1);
}

async function main() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1');

  let finalBookingUrl = null;
  let placeStudioName = null;

  // 1. If it's a Naver Map / Place URL, perform reverse-tracing to extract booking URL
  if (urlInput.includes('map.naver.com') || urlInput.includes('place.naver.com')) {
    const placeMatch = urlInput.match(/place\/([0-9]+)/);
    if (!placeMatch) {
      console.error('Error: Could not find place ID from the Naver Map URL.');
      await browser.close();
      process.exit(1);
    }
    const placeId = placeMatch[1];
    const placeMobileUrl = `https://m.place.naver.com/place/${placeId}/ticket`;
    console.log(`Map URL detected. Accessing place details page to extract booking link: ${placeMobileUrl}`);

    try {
      await page.goto(placeMobileUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      
      // Try to extract booking link from window metadata state
      const bookingData = await page.evaluate(() => {
        const state = window.__PRELOADED_STATE__ || window.__APOLLO_STATE__ || null;
        if (!state) return null;

        const stateStr = JSON.stringify(state);
        // Try matching detailed items URL first
        let match = stateStr.match(/https:\\?\/\\?\/m\.booking\.naver\.com\\?\/booking\\?\/[0-9]+\\?\/bizes\\?\/[0-9]+\\?\/items\\?\/[0-9]+/);
        if (!match) {
          // Fallback to basic bizes URL
          match = stateStr.match(/https:\\?\/\\?\/m\.booking\.naver\.com\\?\/booking\\?\/[0-9]+\\?\/bizes\\?\/[0-9]+/);
        }
        if (match) {
          // Clean escape backslashes and HTML entities from JSON string matching
          return match[0].replace(/\\/g, '').replace(/&amp;/g, '&');
        }
        return null;
      });

      if (bookingData) {
        finalBookingUrl = bookingData;
        console.log(`Successfully extracted booking URL: ${finalBookingUrl}`);
      } else {
        // Fallback: search regex directly in the HTML source text
        const htmlContent = await page.content();
        const bookingMatch = htmlContent.match(/https:\/\/m\.booking\.naver\.com\/booking\/[^\s'"]+/);
        if (bookingMatch) {
          finalBookingUrl = bookingMatch[0].replace(/&amp;/g, '&');
          console.log(`Extracted booking URL from body text: ${finalBookingUrl}`);
        }
      }
      // Try to extract real business name from place page
      const extractedName = await page.evaluate(() => {
        // First Priority: Get from Preloaded state Place entity (100% reliable)
        const state = window.__PRELOADED_STATE__ || window.__APOLLO_STATE__ || null;
        if (state) {
          // Direct property check (safe chain)
          if (state.place && state.place.name) return state.place.name;
          if (state.place && state.place.summary && state.place.summary.name) return state.place.summary.name;
          if (state.summary && state.summary.name) return state.summary.name;

          // Recursive Apollo Cache key search
          const keys = Object.keys(state);
          for (const key of keys) {
            if ((key.startsWith('Place:') || key.startsWith('Business:')) && state[key] && state[key].name) {
              return state[key].name;
            }
          }

          // Fallback regex matching for the longest valid Korean business name
          const stateStr = JSON.stringify(state);
          const nameMatches = stateStr.match(/"name"\s*:\s*"([^"]+)"/g);
          if (nameMatches) {
            for (const m of nameMatches) {
              const val = m.match(/"name"\s*:\s*"([^"]+)"/)[1];
              if (val && val.length > 5 && !/^[a-zA-Z0-9_\s:]+$/.test(val)) {
                return val;
              }
            }
          }
        }

        // Second Priority: Fallback to highly specific CSS selectors
        const el = document.querySelector('.Fc13A, .biz_name, .top_title, [place-name]');
        if (el && el.innerText.trim() !== '플레이스') {
          return el.innerText.trim();
        }
        return null;
      });

      if (extractedName) {
        placeStudioName = extractedName;
        console.log(`Extracted place business name: ${placeStudioName}`);
      }
    } catch (e) {
      console.error('Error: Failed to load place details page:', e.message);
    }

    if (!finalBookingUrl) {
      console.error('Error: Could not find Naver Booking link associated with this place.');
      await browser.close();
      process.exit(1);
    }
  } else {
    // 2. Direct Naver Booking link
    finalBookingUrl = urlInput;
  }

  // 3. Extract IDs and run the standard studio registration logic
  const bizMatch = finalBookingUrl.match(/bizes\/([0-9]+)/);
  const itemMatch = finalBookingUrl.match(/items\/([0-9]+)/);

  if (!bizMatch) {
    console.error('Error: Invalid Booking URL. Could not find business ID (bizes/...).');
    await browser.close();
    process.exit(1);
  }

  const bizId = bizMatch[1];
  const resourceId = itemMatch ? itemMatch[1] : null;

  console.log(`Analyzing booking page to extract studio name: ${finalBookingUrl}`);
  let studioName = placeStudioName || 'Unknown Studio';

  // Only crawl title/selectors from booking page if placeStudioName was not fetched
  if (!placeStudioName) {
    try {
      await page.goto(finalBookingUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      
      // First Priority: extract studio name from the browser window title (100% reliable)
      const pageTitle = await page.title();
      if (pageTitle && pageTitle.includes('::')) {
        studioName = pageTitle.split('::')[1].trim();
      } else {
        // Second Priority fallback: query selectors
        studioName = await page.evaluate(() => {
          const el = document.querySelector('.top_title, .biz_name, .header_title, h2, h3');
          return el ? el.innerText.trim() : null;
        });
        if (!studioName) {
          studioName = pageTitle || 'Unknown Studio';
        }
      }
    } catch (e) {
      console.error('Warning: Failed to fetch studio name from web page. Using fallback.');
    } finally {
      await browser.close();
    }
  } else {
    await browser.close();
  }

  // Load existing list
  const studiosPath = path.resolve('config/studios.json');
  let studios = [];
  if (fs.existsSync(studiosPath)) {
    try {
      studios = JSON.parse(fs.readFileSync(studiosPath, 'utf-8'));
    } catch (e) {
      studios = [];
    }
  }

  // Check duplicates
  const isDuplicate = studios.some(s => s.bizId === bizId && s.resourceId === resourceId);
  if (isDuplicate) {
    console.log(`[INFO] Studio already exists in list (bizId:${bizId}, resourceId:${resourceId}). No changes made.`);
    process.exit(0);
  }

  // Create new entry
  const newStudio = {
    name: studioName,
    bizId: bizId,
    resourceId: resourceId || "",
    url: finalBookingUrl.split('?')[0]
  };

  studios.push(newStudio);
  fs.writeFileSync(studiosPath, JSON.stringify(studios, null, 2), 'utf-8');

  console.log(`\n[SUCCESS] New studio successfully registered!`);
  console.log(`Name: ${newStudio.name}`);
  console.log(`Business ID (bizId): ${newStudio.bizId}`);
  console.log(`Resource ID (resourceId): ${newStudio.resourceId}`);
  console.log(`URL: ${newStudio.url}`);
}

main().catch(console.error);
