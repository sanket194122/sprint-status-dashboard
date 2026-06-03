#!/usr/bin/env node
/**
 * Sprint Dashboard - Express server
 * Proxies JIRA API calls and serves the HTML dashboard.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const JIRA_BASE_URL = process.env.JIRA_BASE_URL || 'https://nice-ce-cxone-prod.atlassian.net';
const USERNAME = process.env.CONFLUENCE_USERNAME || process.env.JIRA_USER || '';
const TOKEN = process.env.CONFLUENCE_TOKEN || process.env.JIRA_API_TOKEN || '';
const SPRINT_NAME = process.env.SPRINT_NAME || 'CX.26.3.191';
const TEAM_NAME = process.env.TEAM_NAME || 'Titans';
const PROJECT_KEY = process.env.PROJECT_KEY || 'CXDV';
const PORT = parseInt(process.env.DASHBOARD_PORT || '8501', 10);
const CACHE_TTL_MS = 300000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

if (!USERNAME || !TOKEN) {
    console.error('Error: Set CONFLUENCE_USERNAME and CONFLUENCE_TOKEN (or JIRA_USER and JIRA_API_TOKEN).');
    process.exit(1);
}

const AUTH_HEADER = 'Basic ' + Buffer.from(`${USERNAME}:${TOKEN}`).toString('base64');

// Keep-alive agent reuses TCP+TLS connections across requests
const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });

// ---------- Cache ----------
const cache = {};
function getCached(key) {
    const entry = cache[key];
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.data;
    return null;
}
function setCache(key, data) {
    cache[key] = { ts: Date.now(), data };
}
function clearCache() {
    Object.keys(cache).forEach(k => delete cache[k]);
}

// ---------- JIRA Fetch (with keep-alive + timing) ----------
function jiraFetch(apiPath, params = {}) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams(params).toString();
        const fullPath = qs ? `${apiPath}?${qs}` : apiPath;
        const cacheKey = fullPath;
        const cached = getCached(cacheKey);
        if (cached) { console.log(`  [cache hit] ${fullPath}`); return resolve(cached); }

        const t0 = Date.now();
        console.log(`  [fetch] ${fullPath} ...`);
        const parsed = new URL(JIRA_BASE_URL);
        const options = {
            hostname: parsed.hostname,
            port: 443,
            path: fullPath,
            method: 'GET',
            agent: agent,
            headers: {
                'Authorization': AUTH_HEADER,
                'Accept': 'application/json',
            },
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const elapsed = Date.now() - t0;
                if (res.statusCode >= 400) {
                    console.error(`  [FAIL ${res.statusCode}] ${fullPath} (${elapsed}ms) - ${body.substring(0, 150)}`);
                    return reject(new Error(`JIRA API ${res.statusCode}: ${body.substring(0, 200)}`));
                }
                console.log(`  [done ${res.statusCode}] ${fullPath} (${elapsed}ms)`);
                try {
                    const data = JSON.parse(body);
                    setCache(cacheKey, data);
                    resolve(data);
                } catch (e) {
                    reject(new Error(`JSON parse error: ${e.message}`));
                }
            });
        });
        req.on('error', (e) => { console.error(`  [ERROR] ${fullPath} - ${e.message}`); reject(e); });
        req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout after 15s: ${fullPath}`)); });
        req.end();
    });
}

// ---------- JIRA POST (for v3 search) ----------
function jiraPost(apiPath, body) {
    return new Promise((resolve, reject) => {
        const cacheKey = apiPath + JSON.stringify(body);
        const cached = getCached(cacheKey);
        if (cached) return resolve(cached);

        const t0 = Date.now();
        const jsonBody = JSON.stringify(body);
        const parsed = new URL(JIRA_BASE_URL);
        const options = {
            hostname: parsed.hostname,
            port: 443,
            path: apiPath,
            method: 'POST',
            agent: agent,
            headers: {
                'Authorization': AUTH_HEADER,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(jsonBody),
            },
        };
        console.log(`  [post] ${apiPath} ...`);
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const elapsed = Date.now() - t0;
                if (res.statusCode >= 400) {
                    console.error(`  [FAIL ${res.statusCode}] POST ${apiPath} (${elapsed}ms) - ${data.substring(0, 150)}`);
                    return reject(new Error(`JIRA API ${res.statusCode}: ${data.substring(0, 200)}`));
                }
                console.log(`  [done ${res.statusCode}] POST ${apiPath} (${elapsed}ms)`);
                try {
                    const result = JSON.parse(data);
                    setCache(cacheKey, result);
                    resolve(result);
                } catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
            });
        });
        req.on('error', (e) => { console.error(`  [ERROR] POST ${apiPath} - ${e.message}`); reject(e); });
        req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout after 15s: POST ${apiPath}`)); });
        req.write(jsonBody);
        req.end();
    });
}

// ---------- JIRA Data Functions ----------
async function findBoard(projectKey) {
    const data = await jiraFetch('/rest/agile/1.0/board', { projectKeyOrId: projectKey, maxResults: '50' });
    const boards = data.values || [];
    if (!boards.length) throw new Error(`No board found for project ${projectKey}`);
    const scrum = boards.find(b => b.type === 'scrum');
    return scrum ? scrum.id : boards[0].id;
}

async function findSprint(boardId, sprintNameFragment) {
    const fragment = sprintNameFragment.toLowerCase();
    // Search all states in parallel for speed
    const searches = ['active', 'future', 'closed'].map(async (state) => {
        const data = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint`, {
            state, startAt: '0', maxResults: '50'
        });
        const sprints = data.values || [];
        return sprints.find(s => s.name && s.name.toLowerCase().includes(fragment)) || null;
    });
    const results = await Promise.all(searches);
    const match = results.find(r => r !== null);
    if (match) return match;
    // Fallback: paginate closed sprints (may have many)
    let startAt = 50;
    while (true) {
        const data = await jiraFetch(`/rest/agile/1.0/board/${boardId}/sprint`, {
            state: 'closed', startAt: String(startAt), maxResults: '50'
        });
        const sprints = data.values || [];
        const found = sprints.find(s => s.name && s.name.toLowerCase().includes(fragment));
        if (found) return found;
        if (data.isLast || !sprints.length) break;
        startAt += 50;
    }
    throw new Error(`Sprint matching '${sprintNameFragment}' not found on board ${boardId}`);
}

async function getSprintIssues(sprintId, projectKey, teamName) {
    const fields = ['summary', 'status', 'assignee', 'customfield_10038', 'customfield_10014', 'issuetype', 'created', 'updated', 'resolutiondate', 'statuscategorychangedate'];
    const PAGE_SIZE = 100;

    projectKey = projectKey || PROJECT_KEY;
    teamName = teamName || TEAM_NAME;
    const jql = `project = ${projectKey} AND sprint = ${sprintId} AND "team name[dropdown]" = "${teamName}"`;
    console.log(`  [issues] JQL: ${jql}`);

    // v3 search uses cursor-based pagination (nextPageToken), not startAt
    const allIssues = [];
    let nextPageToken = null;

    while (true) {
        const body = { jql, fields, maxResults: PAGE_SIZE };
        if (nextPageToken) body.nextPageToken = nextPageToken;

        const page = await jiraPost('/rest/api/3/search/jql', body);
        const issues = page.issues || [];
        allIssues.push(...issues);

        const total = page.total || allIssues.length;
        console.log(`  [issues] Fetched ${allIssues.length}/${total}`);

        nextPageToken = page.nextPageToken || null;
        if (!nextPageToken || allIssues.length >= total) break;
    }

    console.log(`  [issues] Done: ${allIssues.length} issues for project ${PROJECT_KEY}.`);
    return normalizeIssues(allIssues);
}

function normalizeIssues(rawIssues) {
    return rawIssues.map(issue => {
        const f = issue.fields || {};
        const statusObj = f.status || {};
        const category = (statusObj.statusCategory || {}).name || 'To Do';
        const assigneeObj = f.assignee;
        const assigneeName = assigneeObj ? assigneeObj.displayName || 'Unassigned' : 'Unassigned';
        let storyPoints = f.customfield_10038;
        if (storyPoints != null) {
            storyPoints = parseFloat(storyPoints) || 0;
        } else {
            storyPoints = 0;
        }
        return {
            key: issue.key,
            summary: f.summary || '',
            status: statusObj.name || 'Unknown',
            statusCategory: category,
            assignee: assigneeName,
            storyPoints,
            epicKey: f.customfield_10014 || null,
            issueType: (f.issuetype || {}).name || 'Task',
            created: f.created || null,
            updated: f.updated || null,
            resolutionDate: f.resolutiondate || null,
            statusChangeDate: f.statuscategorychangedate || null,
        };
    });
}

const epicNameCache = {};
async function resolveEpicNames(epicKeys) {
    const result = {};
    const toFetch = [];
    for (const key of epicKeys) {
        if (!key) continue;
        if (epicNameCache[key]) { result[key] = epicNameCache[key]; continue; }
        toFetch.push(key);
    }
    if (toFetch.length > 0) {
        const fetches = toFetch.map(key =>
            jiraFetch(`/rest/api/3/issue/${key}`, { fields: 'summary' })
                .then(data => { epicNameCache[key] = (data.fields || {}).summary || key; })
                .catch(() => { epicNameCache[key] = key; })
        );
        await Promise.all(fetches);
    }
    for (const key of epicKeys) {
        if (key) result[key] = epicNameCache[key] || key;
    }
    return result;
}

// ---------- Analytics ----------

// Count working days (exclude Sat/Sun) between two dates
function countWorkingDays(from, to) {
    let count = 0;
    const d = new Date(from);
    while (d < to) {
        const day = d.getDay();
        if (day !== 0 && day !== 6) count++;
        d.setDate(d.getDate() + 1);
    }
    return count;
}

function computeTimeProgress(startDateStr, endDateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let start, end;
    try {
        start = new Date(startDateStr); start.setHours(0, 0, 0, 0);
        end = new Date(endDateStr); end.setHours(0, 0, 0, 0);
    } catch (e) {
        return { totalDays: 0, daysPassed: 0, daysRemaining: 0, timeElapsedPct: 0, workingDaysTotal: 0, workingDaysPassed: 0, workingDaysRemaining: 0 };
    }
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return { totalDays: 0, daysPassed: 0, daysRemaining: 0, timeElapsedPct: 0, workingDaysTotal: 0, workingDaysPassed: 0, workingDaysRemaining: 0 };
    }
    const totalDays = Math.max(Math.round((end - start) / 86400000), 1);
    let daysPassed = Math.round((today - start) / 86400000);
    daysPassed = Math.max(0, Math.min(daysPassed, totalDays));
    const daysRemaining = totalDays - daysPassed;

    // Weekend-aware calculation
    const effectiveToday = today < end ? today : end;
    const workingDaysTotal = Math.max(countWorkingDays(start, end), 1);
    const workingDaysPassed = countWorkingDays(start, effectiveToday);
    const workingDaysRemaining = workingDaysTotal - workingDaysPassed;
    const timeElapsedPct = Math.round((workingDaysPassed / workingDaysTotal) * 1000) / 10;

    return { totalDays, daysPassed, daysRemaining, timeElapsedPct, workingDaysTotal, workingDaysPassed, workingDaysRemaining };
}

function computeSummary(issues, timeProgress) {
    const totalPoints = issues.reduce((s, i) => s + i.storyPoints, 0);
    const completedPoints = issues.filter(i => i.statusCategory === 'Done').reduce((s, i) => s + i.storyPoints, 0);
    const inProgressPoints = issues.filter(i => i.statusCategory === 'In Progress').reduce((s, i) => s + i.storyPoints, 0);
    const remainingPoints = totalPoints - completedPoints;
    const completionPct = totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 1000) / 10 : 0;

    const perPerson = computePerPerson(issues);
    const perEpic = computePerEpic(issues, timeProgress);

    return { totalPoints, completedPoints, inProgressPoints, remainingPoints, completionPct, perPerson, perEpic, timeProgress };
}

function computePerPerson(issues) {
    const people = {};
    issues.forEach(i => {
        const name = i.assignee;
        if (!people[name]) people[name] = { name, assigned: 0, completed: 0, remaining: 0 };
        people[name].assigned += i.storyPoints;
        if (i.statusCategory === 'Done') people[name].completed += i.storyPoints;
        else people[name].remaining += i.storyPoints;
    });
    return Object.values(people)
        .sort((a, b) => b.assigned - a.assigned)
        .map(p => ({ ...p, completionPct: p.assigned > 0 ? Math.round((p.completed / p.assigned) * 1000) / 10 : 0 }));
}

function computePerEpic(issues, timeProgress) {
    const epics = {};
    issues.forEach(i => {
        const key = i.epicKey || 'No Epic';
        if (!epics[key]) epics[key] = { epicKey: key, epicName: key, total: 0, completed: 0, remaining: 0, contributors: {} };
        epics[key].total += i.storyPoints;
        if (i.statusCategory === 'Done') epics[key].completed += i.storyPoints;
        else epics[key].remaining += i.storyPoints;
        const assignee = i.assignee || 'Unassigned';
        epics[key].contributors[assignee] = (epics[key].contributors[assignee] || 0) + i.storyPoints;
    });
    const timePct = (timeProgress.timeElapsedPct || 0) / 100;
    return Object.values(epics)
        .sort((a, b) => b.total - a.total)
        .map(e => {
            const risk = calculateEpicRisk(e, timePct);
            const completionPct = e.total > 0 ? Math.round((e.completed / e.total) * 1000) / 10 : 0;
            const owner = Object.entries(e.contributors).sort((a, b) => b[1] - a[1])[0];
            const epicOwner = owner ? owner[0] : 'Unassigned';
            delete e.contributors;
            return { ...e, riskStatus: risk.status, riskReason: risk.reason, completionPct, epicOwner };
        });
}

// ---------- Advanced Analytics ----------

function computeAdvancedMetrics(issues, timeProgress, sprintStart, sprintEnd) {
    const now = new Date();
    const start = new Date(sprintStart);
    const end = new Date(sprintEnd);

    // #2 Sprint Completion Forecast
    const totalPoints = issues.reduce((s, i) => s + i.storyPoints, 0);
    const completedPoints = issues.filter(i => i.statusCategory === 'Done').reduce((s, i) => s + i.storyPoints, 0);
    const workingDaysPassed = timeProgress.workingDaysPassed || 1;
    const workingDaysTotal = timeProgress.workingDaysTotal || 1;
    const workingDaysRemaining = timeProgress.workingDaysRemaining || 0;
    const dailyVelocity = workingDaysPassed > 0 ? completedPoints / workingDaysPassed : 0;
    const remainingPoints = totalPoints - completedPoints;
    const daysNeeded = dailyVelocity > 0 ? Math.ceil(remainingPoints / dailyVelocity) : 999;
    const forecastDelta = workingDaysRemaining - daysNeeded;
    const forecast = {
        dailyVelocity: Math.round(dailyVelocity * 10) / 10,
        daysNeeded,
        forecastDelta,
        message: forecastDelta >= 0
            ? `On pace to finish ${forecastDelta} working day(s) early`
            : `At current velocity, sprint will be ${Math.abs(forecastDelta)} day(s) late`,
        status: forecastDelta >= 0 ? 'on-track' : forecastDelta >= -2 ? 'at-risk' : 'behind'
    };

    // #3 Carry-Over Risk
    const carryOverRisk = issues.filter(i => {
        if (i.statusCategory === 'Done') return false;
        if (i.statusCategory === 'To Do' && workingDaysRemaining <= 2) return true;
        if (i.storyPoints >= 5 && i.statusCategory === 'To Do') return true;
        return false;
    }).map(i => ({ key: i.key, summary: i.summary, points: i.storyPoints, status: i.status, assignee: i.assignee }));

    // #5 Daily Throughput
    const dailyThroughput = [];
    const d = new Date(start);
    while (d <= now && d <= end) {
        if (d.getDay() !== 0 && d.getDay() !== 6) {
            const dayStr = d.toISOString().split('T')[0];
            const resolved = issues.filter(i => i.resolutionDate && i.resolutionDate.startsWith(dayStr));
            dailyThroughput.push({ date: dayStr, count: resolved.length, points: resolved.reduce((s, i) => s + i.storyPoints, 0) });
        }
        d.setDate(d.getDate() + 1);
    }

    // #8 Aging Work-in-Progress
    const agingWIP = issues.filter(i => {
        if (i.statusCategory !== 'In Progress') return false;
        const lastChange = i.statusChangeDate ? new Date(i.statusChangeDate) : (i.updated ? new Date(i.updated) : null);
        if (!lastChange) return false;
        const daysInProgress = Math.round((now - lastChange) / 86400000);
        i._agingDays = daysInProgress;
        return daysInProgress >= 3;
    }).map(i => ({ key: i.key, summary: i.summary, assignee: i.assignee, points: i.storyPoints, daysStuck: i._agingDays }))
      .sort((a, b) => b.daysStuck - a.daysStuck);

    // #9 Availability Gap
    const inProgressPoints = issues.filter(i => i.statusCategory === 'In Progress').reduce((s, i) => s + i.storyPoints, 0);
    const todoPoints = issues.filter(i => i.statusCategory === 'To Do').reduce((s, i) => s + i.storyPoints, 0);
    const capacityPerDay = dailyVelocity;
    const remainingCapacity = capacityPerDay * workingDaysRemaining;
    const availabilityGap = {
        remainingWork: remainingPoints,
        estimatedCapacity: Math.round(remainingCapacity * 10) / 10,
        gap: Math.round((remainingCapacity - remainingPoints) * 10) / 10,
        status: remainingCapacity >= remainingPoints ? 'under-committed' : 'over-committed',
        message: remainingCapacity >= remainingPoints
            ? `Team has capacity for ${Math.round(remainingCapacity - remainingPoints)} more points`
            : `Team is over-committed by ${Math.round(remainingPoints - remainingCapacity)} points`
    };

    // #10 Focus Factor (stories+tasks vs bugs+support)
    const plannedWork = issues.filter(i => ['Story', 'Task', 'Sub-task'].includes(i.issueType));
    const unplannedWork = issues.filter(i => ['Bug', 'Support', 'Incident'].includes(i.issueType));
    const plannedPoints = plannedWork.reduce((s, i) => s + i.storyPoints, 0);
    const unplannedPoints = unplannedWork.reduce((s, i) => s + i.storyPoints, 0);
    const focusFactor = totalPoints > 0 ? Math.round((plannedPoints / totalPoints) * 100) : 100;

    // #11 Scope Creep
    const sprintStartDate = start.toISOString().split('T')[0];
    const scopeCreep = issues.filter(i => {
        if (!i.created) return false;
        return i.created.split('T')[0] > sprintStartDate;
    }).map(i => ({ key: i.key, summary: i.summary, points: i.storyPoints, addedOn: i.created.split('T')[0], assignee: i.assignee }));
    const scopeCreepPoints = scopeCreep.reduce((s, i) => s + i.points, 0);

    // #15 Re-opened Issues (approximation: Done items that moved back — we detect via statusCategory still not Done but has resolutionDate)
    const reopened = issues.filter(i => i.resolutionDate && i.statusCategory !== 'Done');

    // #19 Unassigned Work
    const unassigned = issues.filter(i => i.assignee === 'Unassigned' && i.statusCategory !== 'Done')
        .map(i => ({ key: i.key, summary: i.summary, points: i.storyPoints, status: i.status }));
    const unassignedPoints = unassigned.reduce((s, i) => s + i.points, 0);

    // #21 Sprint Score Card
    const commitmentMet = totalPoints > 0 ? Math.round((completedPoints / totalPoints) * 100) : 0;
    let grade = 'A';
    if (commitmentMet < 90) grade = 'B';
    if (commitmentMet < 75) grade = 'C';
    if (commitmentMet < 50) grade = 'D';
    // Adjust if sprint isn't over yet
    const sprintOver = now >= end;
    const scoreCard = {
        committed: totalPoints,
        delivered: completedPoints,
        commitmentPct: commitmentMet,
        grade: sprintOver ? grade : '-',
        scopeCreepPct: totalPoints > 0 ? Math.round((scopeCreepPoints / totalPoints) * 100) : 0,
        focusFactor,
        agingItems: agingWIP.length,
        unassignedPoints,
        carryOverCount: carryOverRisk.length,
        sprintOver,
    };

    return {
        forecast,
        carryOverRisk,
        dailyThroughput,
        agingWIP,
        availabilityGap,
        focusFactor,
        scopeCreep: { items: scopeCreep, totalPoints: scopeCreepPoints, pctOfSprint: totalPoints > 0 ? Math.round((scopeCreepPoints/totalPoints)*100) : 0 },
        reopened: reopened.map(i => ({ key: i.key, summary: i.summary, assignee: i.assignee })),
        unassigned: { items: unassigned, totalPoints: unassignedPoints },
        scoreCard,
    };
}

function calculateEpicRisk(epic, timeElapsed) {
    if (epic.total === 0) return { status: 'On Track', reason: 'No story points assigned' };
    const workProgress = epic.completed / epic.total;
    const remainingTime = 1 - timeElapsed;
    if (workProgress >= 1) return { status: 'On Track', reason: 'Epic fully completed' };
    if (timeElapsed === 0) return { status: 'On Track', reason: 'Sprint just started' };
    const velocityRatio = workProgress / timeElapsed;
    if (remainingTime <= 0) return { status: 'Not Deliverable', reason: `Sprint ended with ${epic.remaining} points remaining` };
    if (velocityRatio >= 0.8) return { status: 'On Track', reason: `${Math.round(workProgress * 100)}% done vs ${Math.round(timeElapsed * 100)}% time elapsed` };
    const requiredAccel = (epic.remaining / epic.total) / remainingTime;
    if (velocityRatio >= 0.5 && remainingTime > 0.3) {
        return { status: 'At Risk', reason: `Only ${Math.round(workProgress * 100)}% done with ${Math.round(timeElapsed * 100)}% time elapsed. Needs ${requiredAccel.toFixed(1)}x acceleration.` };
    }
    return { status: 'Not Deliverable', reason: `Only ${Math.round(workProgress * 100)}% done with ${Math.round(timeElapsed * 100)}% time elapsed. ${epic.remaining} pts remaining in ${Math.round(remainingTime * 100)}% of sprint.` };
}

// ---------- AI-Powered Risk Analysis (GitHub Models) ----------
let aiAnalysisCache = { ts: 0, data: null };
const AI_CACHE_TTL = 600000; // 10 min

async function getAIRiskAnalysis(epics, timeProgress, issues, advanced) {
    if (!GITHUB_TOKEN) return null;
    if (aiAnalysisCache.data && (Date.now() - aiAnalysisCache.ts) < AI_CACHE_TTL) return aiAnalysisCache.data;

    const epicSummary = epics.map(e => `- ${e.epicName||e.epicKey}: ${e.completed}/${e.total} pts done (${e.completionPct}%), owner: ${e.epicOwner}, formula risk: ${e.riskStatus}`).join('\n');
    const issueBreakdown = issues.slice(0, 60).map(i => `${i.key} [${i.statusCategory}] ${i.storyPoints}pts - ${i.assignee} - ${i.issueType}`).join('\n');

    const advContext = advanced ? `
ADVANCED METRICS:
- Daily velocity: ${advanced.forecast.dailyVelocity} pts/day
- Forecast: ${advanced.forecast.message}
- Aging WIP (stuck 3+ days): ${advanced.agingWIP.length} items
- Carry-over risk: ${advanced.carryOverRisk.length} items
- Scope creep: ${advanced.scopeCreep.pctOfSprint}% of sprint added after start
- Focus factor: ${advanced.focusFactor}% (planned vs unplanned work)
- Unassigned work: ${advanced.unassigned.totalPoints} points
- Availability gap: ${advanced.availabilityGap.message}
- Re-opened issues: ${advanced.reopened.length}` : '';

    const prompt = `You are a senior Agile delivery coach analyzing a sprint in detail.

SPRINT CONTEXT:
- Working days total: ${timeProgress.workingDaysTotal}
- Working days passed: ${timeProgress.workingDaysPassed}
- Working days remaining: ${timeProgress.workingDaysRemaining}
- Time elapsed: ${timeProgress.timeElapsedPct}%
${advContext}

EPICS IN SPRINT:
${epicSummary}

SAMPLE ISSUES (first 60):
${issueBreakdown}

Provide your analysis in this EXACT JSON format. All values must be plain strings (not objects or arrays):

{
  "epics": [
    { "epicKey": "EXACT-KEY", "aiRisk": "On Track", "aiInsight": "one sentence recommendation" }
  ],
  "sprintInsight": "A 2-3 sentence overall health summary of the sprint.",
  "retroPreview": "What is going well: bullet 1, bullet 2. What needs attention: bullet 1, bullet 2, bullet 3.",
  "forecastInsight": "One sentence about whether the team will meet the sprint goal based on velocity and remaining work.",
  "riskSummary": "One sentence about the biggest risk factor this sprint."
}

RULES:
- Every value must be a simple string, never an object or array
- epicKey must exactly match the keys provided above
- aiRisk must be exactly one of: "On Track", "At Risk", "Not Deliverable"
- Keep insights concise (1-2 sentences max each)
- Consider in-progress items as ~50% likely to complete
- Account for weekend-adjusted timeline
- Factor in workload distribution across team members`;

    try {
        console.log('  [AI] Calling GitHub Models (GPT-4o) for risk analysis...');
        const result = await callGitHubModels(prompt);
        aiAnalysisCache = { ts: Date.now(), data: result };
        console.log('  [AI] Analysis complete.');
        return result;
    } catch (e) {
        console.error(`  [AI] Failed: ${e.message}`);
        return null;
    }
}

function callGitHubModels(prompt, retries = 2) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: 'You are a senior Agile delivery coach. Respond only in valid JSON. Do not use markdown code fences.' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.3,
            max_tokens: 1500
        });
        const options = {
            hostname: 'models.inference.ai.azure.com',
            port: 443,
            path: '/chat/completions',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    console.error(`  [AI] API returned ${res.statusCode}: ${data.substring(0, 150)}`);
                    return reject(new Error(`GitHub Models API ${res.statusCode}`));
                }
                try {
                    const parsed = JSON.parse(data);
                    const text = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content || '';
                    console.log(`  [AI] Response length: ${text.length} chars`);
                    const jsonMatch = text.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const result = JSON.parse(jsonMatch[0]);
                        resolve(result);
                    } else {
                        console.error(`  [AI] No JSON found in response: ${text.substring(0, 100)}`);
                        reject(new Error('No JSON in AI response'));
                    }
                } catch (e) {
                    console.error(`  [AI] Parse error: ${e.message}`);
                    reject(e);
                }
            });
        });
        req.on('error', (e) => {
            console.error(`  [AI] Network error: ${e.message}`);
            if (retries > 0) {
                console.log(`  [AI] Retrying... (${retries} left)`);
                setTimeout(() => callGitHubModels(prompt, retries - 1).then(resolve).catch(reject), 1000);
            } else { reject(e); }
        });
        req.setTimeout(45000, () => { req.destroy(); reject(new Error('GitHub Models API timeout')); });
        req.write(body);
        req.end();
    });
}

function assessSprintHealth(summary, timeProgress) {
    const reasons = [];
    let score = 100;
    const total = summary.totalPoints;
    const completed = summary.completedPoints;
    const timePct = (timeProgress.timeElapsedPct || 0) / 100;

    if (total > 0 && timePct > 0) {
        const workPct = completed / total;
        const ratio = workPct / timePct;
        if (ratio < 0.5) { score -= 40; reasons.push(`Work severely behind: ${Math.round(workPct * 100)}% done vs ${Math.round(timePct * 100)}% time elapsed`); }
        else if (ratio < 0.75) { score -= 20; reasons.push(`Work behind schedule: ${Math.round(workPct * 100)}% done vs ${Math.round(timePct * 100)}% time elapsed`); }
    }

    const epics = summary.perEpic || [];
    const notDeliverable = epics.filter(e => e.riskStatus === 'Not Deliverable').length;
    const atRisk = epics.filter(e => e.riskStatus === 'At Risk').length;
    const totalEpics = Math.max(epics.length, 1);
    if (notDeliverable > 0) { score -= Math.round((notDeliverable / totalEpics) * 30); reasons.push(`${notDeliverable} epic(s) likely not deliverable`); }
    if (atRisk > 0) { score -= Math.round((atRisk / totalEpics) * 15); reasons.push(`${atRisk} epic(s) at risk`); }

    if (timePct > 0.75 && total > 0 && summary.remainingPoints > total * 0.4) {
        score -= 25; reasons.push('>40% work remaining with <25% sprint time left');
    }

    const perPerson = summary.perPerson || [];
    if (perPerson.length > 0) {
        const maxRemaining = Math.max(...perPerson.map(p => p.remaining));
        const avgRemaining = summary.remainingPoints / Math.max(perPerson.length, 1);
        if (avgRemaining > 0 && maxRemaining > avgRemaining * 2.5) {
            score -= 10; reasons.push('Workload imbalance detected');
        }
    }

    let status;
    if (score >= 70) status = 'Healthy';
    else if (score >= 40) status = 'At Risk';
    else status = 'Unhealthy';

    if (!reasons.length) reasons.push('Sprint progressing well');
    return { status, reasons, score: Math.max(score, 0) };
}

// ---------- Server State ----------
let boardId = null;
let sprintData = null;

async function ensureSprint(projectKey, sprintName) {
    projectKey = projectKey || PROJECT_KEY;
    sprintName = sprintName || SPRINT_NAME;
    const bid = await findBoard(projectKey);
    const sprint = await findSprint(bid, sprintName);
    return sprint;
}

// List sprints for a project board (active + future)
async function listSprints(projectKey) {
    const bid = await findBoard(projectKey);
    const results = await Promise.all(
        ['active', 'future'].map(state =>
            jiraFetch(`/rest/agile/1.0/board/${bid}/sprint`, { state, startAt: '0', maxResults: '50' })
        )
    );
    const sprints = [];
    results.forEach(r => sprints.push(...(r.values || [])));
    return sprints.map(s => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate }));
}

// Find team name custom field ID and list unique teams in a project
let teamFieldId = null;
async function findTeamFieldId() {
    if (teamFieldId) return teamFieldId;
    const fields = await jiraFetch('/rest/api/3/field');
    // Look for the field that matches "team name" in its clause names (that's what JQL uses)
    const teamField = fields.find(f =>
        f.clauseNames && f.clauseNames.some(c => c.toLowerCase().includes('team name'))
    );
    if (teamField) { teamFieldId = teamField.id; console.log(`  [teams] Found team field: ${teamField.id} (${teamField.name})`); return teamFieldId; }
    // Broader search by name
    const altField = fields.find(f => f.name && f.name.toLowerCase().includes('team name'));
    if (altField) { teamFieldId = altField.id; console.log(`  [teams] Found team field (by name): ${altField.id} (${altField.name})`); return teamFieldId; }
    throw new Error('Could not find "team name" custom field');
}

async function listTeams(projectKey) {
    const fieldId = await findTeamFieldId();
    const data = await jiraPost('/rest/api/3/search/jql', {
        jql: `project = ${projectKey} AND "team name[dropdown]" IS NOT EMPTY ORDER BY updated DESC`,
        fields: [fieldId],
        maxResults: 100
    });
    const teams = new Set();
    (data.issues || []).forEach(issue => {
        const val = (issue.fields || {})[fieldId];
        // Handle various possible structures: {value: "X"}, {name: "X"}, "X", or {displayName: "X"}
        if (!val) return;
        if (typeof val === 'string') { teams.add(val); return; }
        if (val.value) { teams.add(val.value); return; }
        if (val.name) { teams.add(val.name); return; }
        if (val.displayName) { teams.add(val.displayName); return; }
        // Could be an array of options
        if (Array.isArray(val)) { val.forEach(v => { if (v.value) teams.add(v.value); else if (v.name) teams.add(v.name); }); }
    });
    console.log(`  [teams] Found ${teams.size} teams: ${[...teams].join(', ')}`);
    return [...teams].sort();
}

// ---------- HTTP Server ----------
const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query || {};

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    try {
        if (pathname === '/' || pathname === '/index.html') {
            const htmlPath = path.join(__dirname, 'dashboard.html');
            const html = fs.readFileSync(htmlPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            return;
        }

        // List available sprints for a project
        if (pathname === '/api/sprints') {
            const projectKey = query.project || PROJECT_KEY;
            const sprints = await listSprints(projectKey);
            sendJSON(res, { sprints });
            return;
        }

        // List teams in a project
        if (pathname === '/api/teams') {
            const projectKey = query.project || PROJECT_KEY;
            const teams = await listTeams(projectKey);
            sendJSON(res, { teams });
            return;
        }

        // Get defaults
        if (pathname === '/api/defaults') {
            sendJSON(res, { projectKey: PROJECT_KEY, teamName: TEAM_NAME, sprintName: SPRINT_NAME });
            return;
        }

        // Main endpoint — accepts optional query params to override defaults
        if (pathname === '/api/all') {
            const projectKey = query.project || PROJECT_KEY;
            const teamName = query.team || TEAM_NAME;
            const sprintName = query.sprint || SPRINT_NAME;

            const sprint = await ensureSprint(projectKey, sprintName);
            const issues = await getSprintIssues(sprint.id, projectKey, teamName);
            const epicKeys = [...new Set(issues.map(i => i.epicKey).filter(Boolean))];
            console.log(`  [epics] Resolving ${epicKeys.length} epic names...`);
            const epicNames = epicKeys.length <= 50 ? await resolveEpicNames(epicKeys) : {};
            issues.forEach(i => { i.epicName = i.epicKey ? (epicNames[i.epicKey] || i.epicKey) : 'No Epic'; });
            const timeProgress = computeTimeProgress(sprint.startDate, sprint.endDate);
            const summary = computeSummary(issues, timeProgress);
            summary.perEpic.forEach(e => { if (epicNames[e.epicKey]) e.epicName = epicNames[e.epicKey]; });
            const health = assessSprintHealth(summary, timeProgress);

            // Advanced metrics (compute first, pass to AI for context)
            const advanced = computeAdvancedMetrics(issues, timeProgress, sprint.startDate, sprint.endDate);

            // AI-powered analysis (non-blocking, uses cached result if available)
            let aiAnalysis = null;
            try {
                aiAnalysis = await getAIRiskAnalysis(summary.perEpic, timeProgress, issues, advanced);
                if (aiAnalysis && aiAnalysis.epics) {
                    console.log(`  [AI] Got ${aiAnalysis.epics.length} epic analyses`);
                    aiAnalysis.epics.forEach(ai => {
                        const epic = summary.perEpic.find(e => e.epicKey === ai.epicKey);
                        if (epic) { epic.aiRisk = ai.aiRisk; epic.aiInsight = ai.aiInsight; }
                    });
                } else {
                    console.log(`  [AI] No analysis returned (token set: ${!!GITHUB_TOKEN})`);
                }
            } catch (e) { console.error(`  [AI] Error in /api/all handler: ${e.message}`); }

            // Ensure all AI fields are strings (fix [object Object])
            const aiSprintInsight = aiAnalysis && typeof aiAnalysis.sprintInsight === 'string' ? aiAnalysis.sprintInsight : (aiAnalysis ? JSON.stringify(aiAnalysis.sprintInsight) : null);
            const aiRetroPreview = aiAnalysis && typeof aiAnalysis.retroPreview === 'string' ? aiAnalysis.retroPreview : (aiAnalysis && aiAnalysis.retroPreview ? JSON.stringify(aiAnalysis.retroPreview) : null);
            const aiForecastInsight = aiAnalysis && typeof aiAnalysis.forecastInsight === 'string' ? aiAnalysis.forecastInsight : null;
            const aiRiskSummary = aiAnalysis && typeof aiAnalysis.riskSummary === 'string' ? aiAnalysis.riskSummary : null;

            sendJSON(res, {
                sprint: { id: sprint.id, name: sprint.name, state: sprint.state, startDate: sprint.startDate, endDate: sprint.endDate, teamName, projectKey },
                summary,
                health,
                issues,
                advanced,
                ai: {
                    enabled: !!GITHUB_TOKEN,
                    sprintInsight: aiSprintInsight,
                    retroPreview: aiRetroPreview,
                    forecastInsight: aiForecastInsight,
                    riskSummary: aiRiskSummary,
                },
            });
            return;
        }

        if (pathname === '/api/refresh' && req.method === 'POST') {
            clearCache();
            sendJSON(res, { status: 'cache cleared' });
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Error:`, err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
    }
});

function sendJSON(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ---------- Startup ----------
console.log('Sprint Dashboard starting...');
console.log(`  Project: ${PROJECT_KEY}`);
console.log(`  Sprint:  ${SPRINT_NAME}`);
console.log(`  Team:    ${TEAM_NAME}`);
console.log(`  JIRA:    ${JIRA_BASE_URL}`);
console.log(`  User:    ${USERNAME}`);
console.log(`  AI Risk: ${GITHUB_TOKEN ? 'Enabled (GitHub Models GPT-4o)' : 'Disabled (set GITHUB_TOKEN to enable)'}`);

// Start server immediately - don't block on JIRA
server.listen(PORT, '0.0.0.0', () => {
    console.log(`  Serving on http://localhost:${PORT}`);
    console.log(`  Open your browser now - data will load on first request.`);
});

// Pre-warm in background (non-blocking)
(async () => {
    try {
        boardId = await findBoard(PROJECT_KEY);
        console.log(`  Board ID resolved: ${boardId}`);
        sprintData = await findSprint(boardId, SPRINT_NAME);
        console.log(`  Sprint resolved: ${sprintData.name} [state=${sprintData.state || 'unknown'}]`);
        // Pre-fetch issues so first browser request is instant
        const issues = await getSprintIssues(sprintData.id);
        console.log(`  Pre-warmed: ${issues.length} issues cached.`);
    } catch (e) {
        console.error(`  WARNING: Background resolve failed: ${e.message}`);
        console.error('  Will retry when browser requests data.');
    }
})();
