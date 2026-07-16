/**
 * Same-origin proxy for GDACS multi-hazard events (floods, wildfires, storms, volcanoes).
 * Browser CORS is blocked on gdacs.org.
 */

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 72));
  const end = new Date();
  // Pad start so multi-day floods/fires that began earlier but are still active appear.
  const start = new Date(end.getTime() - (hours + 21 * 24) * 3600_000);
  const eventlist = String(req.query.eventlist || "WF;FL;VO;TC");

  const url =
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH" +
    `?eventlist=${encodeURIComponent(eventlist)}` +
    "&alertlevel=Green;Orange;Red" +
    `&fromdate=${isoDate(start)}` +
    `&todate=${isoDate(end)}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "calamityville" },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ features: [], error: "gdacs upstream failed" });
      return;
    }
    const data = await upstream.json();
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch {
    res.status(502).json({ features: [], error: "gdacs proxy failed" });
  }
}
