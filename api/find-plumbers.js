module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { zip } = req.query;

  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Please provide a valid 5-digit zip code.' });
  }

  try {
    // Step 1: Convert zip code to lat/lon via Nominatim (OpenStreetMap)
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`,
      { headers: { 'User-Agent': 'PlumberFinder/1.0' } }
    );
    const geoData = await geoRes.json();

    if (!geoData.length) {
      return res.status(404).json({ error: 'Zip code not found.' });
    }

    const { lat, lon } = geoData[0];

    // Step 2: Query Overpass API for plumbing businesses nearby (~15km radius)
    const overpassQuery = `
      [out:json][timeout:25];
      (
        node["shop"="plumber"](around:15000,${lat},${lon});
        node["craft"="plumber"](around:15000,${lat},${lon});
        node["trade"="plumber"](around:15000,${lat},${lon});
        node["amenity"="plumber"](around:15000,${lat},${lon});
        way["shop"="plumber"](around:15000,${lat},${lon});
        way["craft"="plumber"](around:15000,${lat},${lon});
      );
      out center tags;
    `;

    const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: overpassQuery,
      headers: { 'Content-Type': 'text/plain' }
    });

    const overpassData = await overpassRes.json();
    const elements = overpassData.elements || [];

    const businesses = elements
      .filter(el => el.tags && el.tags.name)
      .map(el => {
        const t = el.tags;
        const parts = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
        const city = t['addr:city'] || '';
        const state = t['addr:state'] || '';
        const postcode = t['addr:postcode'] || '';
        const address = [parts, city, state, postcode].filter(Boolean).join(', ') || null;

        return {
          name: t.name,
          phone: t.phone || t['contact:phone'] || null,
          address,
          website: t.website || t['contact:website'] || null,
          email: t.email || t['contact:email'] || null,
          openingHours: t.opening_hours || null,
        };
      });

    return res.status(200).json({ businesses, count: businesses.length, zip });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch results. Please try again.' });
  }
};
