/**
 * amazon.js
 *
 * Discovery browses Amazon's own Kindle store search results for a genre or
 * keyword, which is naturally full of indie and self published titles,
 * especially outside the handful of categories the big five dominate.
 *
 * Enrichment opens each author's own public Amazon page. Amazon
 * deliberately does not allow a real clickable link in an author bio, on
 * purpose, to keep readers from leaving the site, but it does allow the
 * plain text of a website address, and indie authors are specifically
 * advised to type theirs in for exactly that reason. That plain text is
 * what this reads.
 *
 * Amazon runs its own bot detection, milder than Cloudflare's kind, usually
 * satisfied by an ordinary real browser with realistic headers rather than
 * needing anything heavier.
 */

import { log } from 'crawlee';

function looksBlocked(title) {
    return /sorry|something went wrong|robot check/i.test(title || '');
}

/**
 * Searches the Kindle store for a query, walking result pages, pulling every
 * book's title, author name, and author page link where one is shown.
 */
export async function discoverBooks(page, { query, maxPages = 5 }) {
    const books = [];

    // The caller already lands this page on the homepage with a proxy
    // address confirmed clean before this function is ever called. A short
    // pause here just keeps the pacing looking human before the first
    // search request goes out.
    await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));

    for (let p = 1; p <= maxPages; p += 1) {
        const url = `https://www.amazon.com/s?k=${encodeURIComponent(query)}&i=digital-text&page=${p}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);

        const title = await page.title().catch(() => '');
        if (looksBlocked(title)) {
            const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '');
            const url = page.url();
            log.warning(`Search page ${p} looked blocked (title: "${title}"). Landed on: ${url}. Body starts with: ${bodyText}`);
            break;
        }

        const pageBooks = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('[data-component-type="s-search-result"]').forEach((card) => {
                const titleEl = card.querySelector('h2 a, h2 span');
                const bookTitle = titleEl ? titleEl.textContent.trim() : null;

                const bookLinkEl = card.querySelector('h2 a');
                const bookUrl = bookLinkEl ? new URL(bookLinkEl.getAttribute('href'), location.href).toString() : null;

                // Author bylines show up as a row of plain text and links just
                // under the title, one of which points at the author's own page.
                let authorName = null;
                let authorUrl = null;
                card.querySelectorAll('a').forEach((a) => {
                    const href = a.getAttribute('href') || '';
                    if (href.includes('/e/') || href.includes('/stores/author/')) {
                        authorName = a.textContent.trim();
                        authorUrl = new URL(href, location.href).toString();
                    }
                });

                if (bookTitle && authorUrl) {
                    out.push({ bookTitle, bookUrl, authorName, authorUrl });
                }
            });
            return out;
        }).catch(() => []);

        if (pageBooks.length === 0) {
            log.info(`Search page ${p} returned nothing usable. Stopping here.`);
            break;
        }

        books.push(...pageBooks);
    }

    return books;
}

/**
 * Reads one author's own Amazon page. Returns their bio text, exactly as
 * written, plus the list of their other books shown on that same page.
 */
export async function fetchAuthorPage(page, authorUrl) {
    await page.goto(authorUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined);

    const title = await page.title().catch(() => '');
    if (looksBlocked(title)) {
        return { bio: '', otherBooks: [], blocked: true };
    }

    const data = await page.evaluate(() => {
        const bioEl = document.querySelector(
            '[data-a-target="bio-content"], .a-expander-content, #bio, .bio',
        );
        const bio = bioEl ? bioEl.textContent.trim() : document.body.innerText.slice(0, 5000);

        const otherBooks = [];
        document.querySelectorAll('[data-asin]').forEach((el) => {
            const t = el.querySelector('h3, h2, .a-size-medium');
            if (t && t.textContent.trim()) otherBooks.push(t.textContent.trim());
        });

        return { bio, otherBooks: [...new Set(otherBooks)] };
    }).catch(() => ({ bio: '', otherBooks: [] }));

    return { ...data, blocked: false };
}
