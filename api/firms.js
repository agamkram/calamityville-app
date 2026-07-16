/**
 * Same-origin proxy for NASA FIRMS global active-fire CSVs (no browser CORS).
 * Query: ?hours=24|48|72 — picks 24h / 48h / 7d MODIS product.
 */

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv";

function firmsUrl(hours) {
  if (hours <= 24) return `${FIRMS_BASE}/MODIS_C6_1_Global_24h.csv`;
  if (hours <= 48) return `${FIRMS_BASE}/MODIS_C6_1_Global_48h.csv`;
  return `${FIRMS_BASE}/MODIS_C6_1_Global_7d.csv`;
}

export default async function handler(req, res) {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 72));
  const url = firmsUrl(hours);

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "text/csv", "User-Agent": "calamityville" },
    });
    if (!upstream.ok) {
      res.status(upstream.status).send("");
      return;
    }
    const text = await upstream.text();
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).send(text);
  } catch {
    res.status(502).send("");
  }
}
