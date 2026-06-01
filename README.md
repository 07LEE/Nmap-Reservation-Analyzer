# Nmap Reservation Analyzer

A local data collection and analysis pipeline for Naver Map reservation systems.
It uses headless browser automation to scrape time-slot availability data and a
browser-based dashboard to visualize the results.

## How It Works

The system operates in two independent phases.

Phase 1: Data Collection

`src/collect.js` launches a headless Chromium instance via Puppeteer and navigates
to each studio's Naver booking page. It intercepts the `hourlySchedule` GraphQL
API response emitted by the page, extracts per-slot availability records, and
writes the aggregated result to a date-stamped CSV file under `data/`.

Phase 2: Data Visualization

`dashboard/report.html` is a self-contained, single-file dashboard. It has no
server-side dependency. Load it via a local HTTP server, drag-and-drop one or
more CSV files exported from Phase 1, and it parses and renders the data
entirely in the browser using vanilla JavaScript and CSS.

## Technologies

- Node.js (ESM): runtime for the data collection pipeline
- Puppeteer: headless Chromium automation for page navigation and network interception
- GraphQL network interception: captures the `opName=hourlySchedule` API call
  without any authentication token or reverse-engineered API key
- Vanilla JavaScript (ES2020): CSV parsing, DOM rendering, chart generation
- CSS custom properties: theming and layout for the dashboard
- Google Fonts (Inter, Outfit): typography

## Project Structure

```
.
├── config/
│   ├── config.json       # targetDays, outputPath
│   └── studios.json      # list of studios with bizId and resourceId
├── data/                 # output directory for collected CSV files
├── dashboard/
│   └── report.html       # browser-based analysis dashboard
├── src/
│   ├── collect.js        # data collection entry point
│   └── add_studio.js     # utility to register a new studio
├── package.json
└── README.md
```

## Setup

```bash
npm install
```

Configure `config/studios.json` with target studio entries. Each entry requires
a `bizId`. If `resourceId` is omitted, the collector attempts auto-detection via
Apollo state inspection.

## Usage

Collect reservation data:

```bash
npm start
```

Output is written to `data/reservations_YYYYMMDD.csv`.

Serve the dashboard locally:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/dashboard/report.html` in a browser. Drop one or more
CSV files onto the upload zone to load data.

## Cron Automation

To run collection on a schedule, add an entry to crontab. Example for daily
execution at 08:00 KST:

```
0 23 * * * cd /path/to/navermap && npm start >> data/cron.log 2>&1
```

## Notes

- The dashboard runs entirely client-side. No data is transmitted externally.
- The `file://` protocol triggers browser security restrictions. Always use a
  local HTTP server.
- Multiple CSV files can be loaded simultaneously for multi-date analysis.
