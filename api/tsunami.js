/** Same-origin proxy for NTWC + PTWC Atom feeds (tsunami.gov has no browser CORS). */

const ATOM_FEEDS = [
  {
    url: "https://www.tsunami.gov/events/xml/PAAQAtom.xml",
    source: "NTWC (Palmer, AK)",
  },
  {
    url: "https://www.tsunami.gov/events/xml/PHEBAtom.xml",
    source: "PTWC (Honolulu, HI)",
  },
];

const ALERT_CATEGORIES = new Set(["Warning", "Advisory", "Watch", "Threat"]);

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseAtomEntries(xml, source) {
  const events = [];
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  for (const entry of entries) {
    const lat = Number(entry.match(/<geo:lat>([^<]+)/)?.[1]);
    const lon = Number(entry.match(/<geo:long>([^<]+)/)?.[1]);
    const updated = entry.match(/<updated>([^<]+)/)?.[1];
    const title = decodeXml(entry.match(/<title>([^<]+)/)?.[1] || "Tsunami bulletin");
    const entryId = entry.match(/<id>([^<]+)/)?.[1] || updated;
    const summary = decodeXml(entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] || "");
    const category = summary.match(/Category:<\/strong>\s*([^<]+)/)?.[1]?.trim();
    const bulletinUrl =
      entry.match(/href="([^"]+\.txt)"/)?.[1] ||
      entry.match(/href="([^"]+PAAQ\.json)"/)?.[1] ||
      "https://www.tsunami.gov/";

    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !updated) continue;
    if (category && !ALERT_CATEGORIES.has(category)) continue;
    if (/no tsunami danger/i.test(summary)) continue;

    const headline = summary.match(/<strong>([^<]+)<\/strong>/)?.[1];
    events.push({
      id: `atom-${source}-${entryId}`,
      lat,
      lon,
      time: updated,
      title: headline || title,
      description: summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500),
      source,
      url: bulletinUrl,
      category,
    });
  }

  return events;
}

export default async function handler(req, res) {
  const events = [];

  for (const feed of ATOM_FEEDS) {
    try {
      const upstream = await fetch(feed.url, {
        headers: { Accept: "application/atom+xml" },
      });
      if (!upstream.ok) continue;
      events.push(...parseAtomEntries(await upstream.text(), feed.source));
    } catch {
      /* try next feed */
    }
  }

  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");
  res.status(200).json(events);
}