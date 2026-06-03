# Sprint Dashboard

Real-time JIRA sprint dashboard with AI-powered epic risk analysis.

## Prerequisites

- **Node.js** (v18+) — [Download](https://nodejs.org/)
- **JIRA credentials** (Atlassian email + API token)

## Quick Setup (2 minutes)

### 1. Copy these files to any folder:

```
sprint-dashboard/
  Start-Dashboard.bat
  scripts/
    server.js
    dashboard.html
```

### 2. Set environment variables (one-time)

Open PowerShell and run:

```powershell
# JIRA credentials (required)
[System.Environment]::SetEnvironmentVariable('CONFLUENCE_USERNAME', 'your.email@nice.com', 'User')
[System.Environment]::SetEnvironmentVariable('CONFLUENCE_TOKEN', 'your-atlassian-api-token', 'User')

# AI analysis (optional — dashboard works without it)
[System.Environment]::SetEnvironmentVariable('GITHUB_TOKEN', 'your-github-pat-token', 'User')
```

**To get your Atlassian API token:**
1. Go to https://id.atlassian.com/manage-profile/security/api-tokens
2. Click "Create API token"
3. Copy the token

**To get GitHub token (for AI risk analysis):**
1. Go to https://github.com/settings/tokens
2. Generate a classic token with any scope
3. Copy the token

### 3. Close and reopen your terminal (so env vars take effect)

### 4. Double-click `Start-Dashboard.bat`

The browser opens automatically at http://localhost:8501

## Usage

1. Enter **Project Key** (e.g., CXDV)
2. Click **"Load"** — populates Team and Sprint dropdowns
3. Select your **Team** and **Sprint**
4. Click **"Go"**

## Features

- Team-scoped sprint data (only your team's issues)
- Epic delivery risk with AI-powered insights
- Weekend-aware timeline tracking
- Per-member drill-down (click name to see issues)
- Dark mode toggle
- Auto-refresh every 5 minutes + manual refresh button
- Works with any project/team/sprint in your JIRA

## Configuration (optional overrides)

| Env Variable | Default | Description |
|---|---|---|
| CONFLUENCE_USERNAME | - | Atlassian email (required) |
| CONFLUENCE_TOKEN | - | Atlassian API token (required) |
| GITHUB_TOKEN | - | GitHub PAT for AI analysis (optional) |
| PROJECT_KEY | CXDV | Default project |
| TEAM_NAME | Titans | Default team |
| SPRINT_NAME | CX.26.3.191 | Default sprint |
| DASHBOARD_PORT | 8501 | Server port |
