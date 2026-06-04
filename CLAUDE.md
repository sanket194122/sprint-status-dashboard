# Sprint Dashboard - Project Context

## What This Is
A real-time JIRA sprint analytics dashboard built with Node.js + vanilla HTML. Fetches live data from JIRA, displays team-scoped sprint metrics with AI-powered risk analysis.

## Architecture
```
Node.js server (server.js, port 8501)
  ├── JIRA REST API v3 (POST /rest/api/3/search/jql)
  ├── JIRA Agile API (boards, sprints)
  ├── GitHub Models API (GPT-4o for AI analysis)
  └── Serves dashboard.html (single-page app)
```

## Key Files
- `scripts/server.js` — Node.js HTTP server, all JIRA fetching, analytics engine, AI integration
- `scripts/dashboard.html` — Complete frontend (CSS + JS inline), Apple/Blacklead dark neon aesthetic
- `Start-Dashboard.bat` — One-click launcher (starts server + opens browser)
- `README.md` — Setup instructions for teammates

## JIRA Configuration
- **Base URL:** https://nice-ce-cxone-prod.atlassian.net
- **Auth:** Basic Auth (CONFLUENCE_USERNAME + CONFLUENCE_TOKEN env vars)
- **API Version:** v3 (POST /rest/api/3/search/jql with cursor pagination via nextPageToken)
- **Custom Fields:**
  - Story Points: `customfield_10038`
  - Epic Link: `customfield_10014`
  - Team Name: dropdown field (found dynamically via /rest/api/3/field)
- **JQL Pattern:** `project = {KEY} AND sprint = {ID} AND "team name[dropdown]" = "{TEAM}"`
- **Sprint Discovery:** /rest/agile/1.0/board → /rest/agile/1.0/board/{id}/sprint

## AI Integration
- **Provider:** GitHub Models (models.inference.ai.azure.com)
- **Model:** gpt-4o
- **Auth:** GITHUB_TOKEN env var (GitHub PAT)
- **Cache:** 10 minutes (AI_CACHE_TTL)
- **Fallback:** If no token or API fails, all features use formula-based analysis
- **What AI does:** Analyzes epics holistically, provides per-epic risk + sprint retro preview

## Features Implemented
1. Project/Team/Sprint selector (all dropdowns, loaded from JIRA)
2. Sprint Completion Forecast (velocity-based prediction)
3. Carry-Over Risk (items likely to spill)
4. Daily Throughput (points per working day chart)
5. Aging WIP (items stuck 3+ days)
6. Availability Gap (capacity vs remaining work)
7. Focus Factor (planned vs unplanned work %)
8. Scope Creep detection (items added after sprint start)
9. Re-opened Issues tracking
10. Unassigned Work alerts
11. Sprint Score Card (grade A-D)
12. AI Sprint Retrospective Preview
13. Epic Delivery Risk (formula + AI enhanced)
14. Team Contribution (clickable drill-down)
15. Weekend-aware timeline
16. Dark mode toggle (neon aesthetic)
17. Auto-refresh 5 min + manual refresh button
18. Export as PDF

## UI Design
- Blacklead Studio / Apple inspired dark aesthetic
- Space Grotesk + Inter fonts
- Neon cyan (#00e5ff), green (#00ff88), pink (#ff4466), amber (#ffaa00)
- Glassmorphism cards with backdrop-blur
- Glow effects (text-shadow, box-shadow)
- Ambient radial gradient orbs in background

## Environment Variables
| Variable | Required | Purpose |
|---|---|---|
| CONFLUENCE_USERNAME | Yes | Atlassian email |
| CONFLUENCE_TOKEN | Yes | Atlassian API token |
| GITHUB_TOKEN | No | GitHub PAT for AI features |
| TEAMS_WEBHOOK_URL | No | MS Teams incoming webhook for alerts |
| PROJECT_KEY | No | Default project (CXDV) |
| TEAM_NAME | No | Default team (Titans) |
| SPRINT_NAME | No | Default sprint (CX.26.3.191) |
| DASHBOARD_PORT | No | Server port (8501) |

## Known Context
- Sprint is program-level (SAFe) — shared across all teams (~15k issues)
- Must filter by project + team name dropdown to get team-specific data
- JIRA v2 search is deprecated (410 Gone) — using v3 POST with cursor pagination
- Team field is a custom dropdown — resolved dynamically via field metadata API
- The Titans team in CXDV project has ~40 issues per sprint

## How to Continue Development
Open Claude Code in this directory and say:
"Continue developing the sprint dashboard at plugin/sprint-dashboard"
Claude will read this CLAUDE.md + the source files and have full context.
