/**
 * Same-origin proxy for CIFFC / NRCan active wildfires (ArcGIS FeatureServer).
 * Official Canadian agency-reported fires — not EONET/IRWIN (US-only).
 */

const ARCGIS_QUERY =
  "https://services.arcgis.com/wjcPoefzjpzCgffS/arcgis/rest/services/activefires/FeatureServer/0/query" +
  "?where=1%3D1" +
  "&outFields=Agency,Fire_Name,Latitude,Longitude,Start_Date,Hectares__Ha_,Stage_of_Control,response_type,ObjectId" +
  "&returnGeometry=true" +
  "&outSR=4326" +
  "&f=json" +
  "&resultRecordCount=2000";

export default async function handler(req, res) {
  try {
    const upstream = await fetch(ARCGIS_QUERY, {
      headers: { Accept: "application/json" },
    });
    if (!upstream.ok) {
      res.status(upstream.status).json({ features: [], error: "canada fires upstream failed" });
      return;
    }
    const data = await upstream.json();
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch {
    res.status(502).json({ features: [], error: "canada fires proxy failed" });
  }
}
