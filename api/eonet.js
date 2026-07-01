/** Same-origin proxy for NASA EONET (avoids browser fetch quirks). */
export default async function handler(req, res) {
  const days = Math.min(3, Math.max(1, Number(req.query.days) || 1));
  const url = `https://eonet.gsfc.nasa.gov/api/v3/events?days=${days}`;

  try {
    const upstream = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ events: [], error: "eonet upstream failed" });
      return;
    }
    const data = await upstream.json();
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch {
    res.status(502).json({ events: [], error: "eonet proxy failed" });
  }
}