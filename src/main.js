/**
 * main.js
 *
 * Finds indie and self published authors, and a real contact address where
 * one can genuinely be found, entirely through Amazon's own Kindle store
 * and Open Library, nothing gated or requiring a login anywhere.
 *
 * The Amazon side runs through a single real browser for the whole run,
 * since Amazon's own bot detection has been milder than Cloudflare's in
 * everything checked so far. If that turns out wrong on a real run, the
 * fix is the same disposable, one browser per request pattern already
 * proven on Kickstarter.
 */

import { Actor } from 'apify';
import { chromium } from 'playwright';
import { CheerioCrawler, log } from 'crawlee';
import { extractEmails, extractUrls, rankEmails } from './emailFinder.js';
import { discoverBooks, fetchAuthorPage } from './amazon.js';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    query = 'self published fantasy novel',
    maxSearchPages = 5,
    maxAuthors = 0,
    crawlAuthorSites = true,
    maxPagesPerSite = 4,
    minimumScore = 0,
} = input;

const browser = await chromium.launch({ headless: false });
const proxyConfiguration = await Actor.createProxyConfiguration({ groups: ['RESIDENTIAL'] });

async function newContextWithFreshProxy() {
    const proxyUrl = await proxyConfiguration.newUrl();
    const p = new URL(proxyUrl);
    return browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        proxy: { server: `${p.protocol}//${p.hostname}:${p.port}`, username: p.username, password: p.password },
    });
}

// Some fraction of any residential pool will simply be flagged already,
// the same variance already proven true on the Kickstarter tool. The fix
// there was the same as here: a fresh address on the next attempt, not
// giving up on the first bad one.
let context;
let page;
for (let attempt = 1; attempt <= 4; attempt += 1) {
    context = await newContextWithFreshProxy();
    page = await context.newPage();
    await page.goto('https://www.amazon.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);
    const title = await page.title().catch(() => '');
    if (!/sorry|something went wrong|robot check/i.test(title || '')) break;
    log.info(`Address ${attempt} looked flagged on the homepage already, trying a fresh one.`);
    await context.close().catch(() => undefined);
    if (attempt === 4) throw new Error('Four fresh addresses in a row were all flagged before even reaching a search page.');
}

const store = await Actor.openKeyValueStore('INDIE-AUTHOR-STATE', { forceCloud: true });
const savedState = (await store.getValue('SEEN_AUTHORS')) || { seen: [] };
const seenAuthors = new Set(savedState.seen || []);

log.info(`Searching the Kindle store for: ${query}`);
const books = await discoverBooks(page, { query, maxPages: maxSearchPages });
log.info(`Found ${books.length} book listings with a linked author page.`);

const byAuthor = new Map();
for (const b of books) {
    if (!byAuthor.has(b.authorUrl)) byAuthor.set(b.authorUrl, { authorName: b.authorName, authorUrl: b.authorUrl, books: [] });
    byAuthor.get(b.authorUrl).books.push(b.bookTitle);
}

const authors = [...byAuthor.values()].filter((a) => !seenAuthors.has(a.authorUrl));
log.info(`${authors.length} of those are authors not already processed in an earlier run.`);

const results = new Map();
const siteQueue = [];
let processed = 0;

for (const author of authors) {
    seenAuthors.add(author.authorUrl);

    const { bio, otherBooks, blocked } = await fetchAuthorPage(page, author.authorUrl);
    if (blocked) {
        log.warning(`Author page looked blocked, skipping: ${author.authorUrl}`);
        continue;
    }

    const hits = [...extractEmails(bio, { source: 'authorBio', sourceUrl: author.authorUrl })];
    const links = extractUrls(bio);

    results.set(author.authorUrl, {
        authorName: author.authorName,
        authorUrl: author.authorUrl,
        books: [...new Set([...author.books, ...otherBooks])],
        bio,
        linkedSites: links,
        rawHits: hits,
        pagesChecked: [author.authorUrl],
    });

    if (crawlAuthorSites && links.length > 0) {
        siteQueue.push({ url: links[0], userData: { authorUrl: author.authorUrl, depth: 0 } });
    }

    processed += 1;
    if (maxAuthors > 0 && processed >= maxAuthors) break;
}

await store.setValue('SEEN_AUTHORS', { seen: [...seenAuthors] });
log.info(`Processed ${processed} new authors this run.`);

if (crawlAuthorSites && siteQueue.length > 0) {
    log.info(`Crawling ${siteQueue.length} author websites for a contact page.`);

    const pagesSpent = new Map();
    const CONTACT_WORDS = ['contact', 'about', 'connect', 'reach', 'inquiries', 'work with', 'press'];

    const crawler = new CheerioCrawler({
        maxConcurrency: 8,
        maxRequestRetries: 2,
        requestHandlerTimeoutSecs: 45,
        failedRequestHandler: async ({ request }) => log.debug(`Gave up on ${request.url}`),

        async requestHandler({ request, $, body }) {
            const { authorUrl, depth } = request.userData;
            const record = results.get(authorUrl);
            if (!record) return;

            const origin = (() => { try { return new URL(request.url).origin; } catch { return request.url; } })();
            const spent = pagesSpent.get(origin) || 0;
            if (spent >= maxPagesPerSite) return;
            pagesSpent.set(origin, spent + 1);

            const isContactPage = /contact|about|connect/i.test(request.url);
            const source = isContactPage ? 'contactPage' : 'siteBody';

            const text = $('body').text().replace(/\s+/g, ' ');
            record.rawHits.push(...extractEmails(text, { source, sourceUrl: request.url }));

            $('a[href^="mailto:"]').each((_, el) => {
                const href = $(el).attr('href') || '';
                const address = href.replace(/^mailto:/i, '').split('?')[0];
                record.rawHits.push(...extractEmails(address, { source: 'mailtoLink', sourceUrl: request.url }));
            });

            record.pagesChecked.push(request.url);

            if (depth === 0) {
                const candidates = [];
                $('a[href]').each((_, el) => {
                    const href = $(el).attr('href');
                    const label = ($(el).text() || '').toLowerCase().trim();
                    if (!href) return;
                    if (!CONTACT_WORDS.some((w) => label.includes(w) || href.toLowerCase().includes(w))) return;
                    try {
                        const abs = new URL(href, request.url);
                        if (abs.origin !== origin) return;
                        candidates.push(abs.toString());
                    } catch { /* ignore */ }
                });
                for (const url of [...new Set(candidates)].slice(0, maxPagesPerSite - 1)) {
                    await crawler.addRequests([{ url, userData: { authorUrl, depth: 1 } }]);
                }
            }
        },
    });

    await crawler.run(siteQueue);
}

let withEmail = 0;
for (const record of results.values()) {
    const ownDomains = record.linkedSites.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } }).filter(Boolean);
    const { emails } = rankEmails(record.rawHits, ownDomains);
    const kept = emails.filter((e) => e.score >= minimumScore);
    if (kept.length) withEmail += 1;

    await Actor.pushData({
        authorName: record.authorName,
        authorUrl: record.authorUrl,
        books: record.books,
        bio: record.bio.slice(0, 2000),

        bestEmail: kept.length ? kept[0].email : null,
        bestEmailConfidence: kept.length ? kept[0].confidence : null,
        bestEmailScore: kept.length ? kept[0].score : null,
        bestEmailFoundOn: kept.length ? kept[0].sourceUrl : null,
        whyThisEmail: kept.length ? kept[0].reasons.join('; ') : null,

        allEmails: kept.map((e) => ({ email: e.email, score: e.score, confidence: e.confidence, source: e.source, sourceUrl: e.sourceUrl, reasons: e.reasons })),
        linkedSites: record.linkedSites,
        pagesChecked: record.pagesChecked,
        scrapedAt: new Date().toISOString(),
    });
}

log.info(`Done. Found at least one address for ${withEmail} of ${results.size} authors this run.`);

await browser.close();
await Actor.exit();
