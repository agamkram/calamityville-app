/**
 * Same-origin proxy for GDACS multi-hazard events (floods, wildfires, storms, volcanoes).
 * Browser CORS is blocked on gdacs.org.
 *
 * SEARCH JSON often hangs; RSS feeds stay responsive. We fetch RSS and normalize to a
 * GeoJSON FeatureCollection so the client parser stays unchanged.
 */

const ALLOWED_TYPES = new Set(["WF", "FL", "VO", "TC"]);
const MAX_FEATURES = 200;

function rssUrl(hours) {
  if (hours <= 24) return "https://www.gdacs.org/xml/rss_24h.xml";
  if (hours <= 72) return "https://www.gdacs.org/xml/rss_7d.xml";
  return "https://www.gdacs.org/xml/rss.xml";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1].trim()) : "";
}

function alertRank(level) {
  const v = String(level || "").toLowerCase();
  if (v === "red") return 3;
  if (v === "orange") return 2;
  if (v === "green") return 1;
  return 0;
}

function parseRssItems(xml, eventlist) {
  const wanted = new Set(
    String(eventlist || "WF;FL;VO;TC")
      .split(/[;,]/)
      .map((s) => s.trim().toUpperCase())
      .filter((t) => ALLOWED_TYPES.has(t))
  );
  if (!wanted.size) {
    for (const t of ALLOWED_TYPES) wanted.add(t);
  }

  const chunks = xml.split(/<item>/i).slice(1);
  const features = [];

  for (const raw of chunks) {
    const block = raw.split(/<\/item>/i)[0] || raw;
    const eventtype = tagText(block, "gdacs:eventtype").toUpperCase();
    if (!wanted.has(eventtype)) continue;

    const alertlevel = tagText(block, "gdacs:alertlevel") || tagText(block, "gdacs:episodealertlevel");
    // Green wildfires dominate RSS; FIRMS/Canada already cover satellite/agency fires.
    if (eventtype === "WF" && alertRank(alertlevel) < 2) continue;

    let lat = Number(tagText(block, "geo:lat"));
    let lon = Number(tagText(block, "geo:long"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const point = tagText(block, "georss:point").trim().split(/\s+/);
      lat = Number(point[0]);
      lon = Number(point[1]);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eventid = tagText(block, "gdacs:eventid") || tagText(block, "guid");
    const episodeid = tagText(block, "gdacs:episodeid") || "0";
    const country = tagText(block, "gdacs:country");
    const eventname = tagText(block, "gdacs:eventname");
    const rssTitle = tagText(block, "title");
    const gdacsTitle = tagText(block, "gdacs:title");
    // gdacs:title is often the placeholder "Event in rss format".
    const name =
      eventname ||
      (rssTitle && !/^event in rss format$/i.test(rssTitle) ? rssTitle : "") ||
      (gdacsTitle && !/^event in rss format$/i.test(gdacsTitle) ? gdacsTitle : "") ||
      rssTitle ||
      "GDACS event";
    const description = tagText(block, "description") || tagText(block, "gdacs:description");
    const severity = tagText(block, "gdacs:severity");
    const fromdate = tagText(block, "gdacs:fromdate");
    const todate = tagText(block, "gdacs:todate");
    const datemodified = tagText(block, "gdacs:datemodified") || tagText(block, "pubDate");
    const link = tagText(block, "link");

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        eventtype,
        eventid,
        episodeid,
        alertlevel,
        country,
        iso3: tagText(block, "gdacs:iso3"),
        name,
        eventname: name,
        description,
        htmldescription: description,
        severitydata: severity ? { severitytext: severity } : undefined,
        fromdate,
        todate,
        datemodified,
        Class: "Point_Centroid",
        url: link ? { report: link } : undefined,
        _alertRank: alertRank(alertlevel),
      },
    });
  }

  features.sort((a, b) => (b.properties._alertRank || 0) - (a.properties._alertRank || 0));
  return features.slice(0, MAX_FEATURES).map((f) => {
    delete f.properties._alertRank;
    return f;
  });
}

export default async function handler(req, res) {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 72));
  const eventlist = String(req.query.eventlist || "WF;FL;VO;TC");
  const url = rssUrl(hours);

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "application/xml,text/xml,*/*", "User-Agent": "calamityville" },
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ features: [], error: "gdacs rss upstream failed" });
      return;
    }
    const xml = await upstream.text();
    const features = parseRssItems(xml, eventlist);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ type: "FeatureCollection", features, source: "gdacs-rss" });
  } catch {
    res.status(502).json({ features: [], error: "gdacs proxy failed" });
  }
}
