const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const NOISE = ['example.com', 'sentry.io', 'wixpress.com', 'squarespace.com',
               'googleapis.com', 'schema.org', 'w3.org', 'cloudflare.com'];

async function fetchWithTimeout(url, ms = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PlumberFinder/1.0)',
        'Accept': 'text/html,*/*'
      }
    });
  } finally {
    clearTimeout(t);
  }
}

function extractEmails(text) {
  const found = text.match(EMAIL_REGEX) || [];
  return found.filter(e =>
    e.length < 80 &&
    !NOISE.some(n => e.includes(n)) &&
    !/\.(png|jpg|gif|svg|css|js)$/i.test(e)
  );
}

// Waterfall: OSM tag → homepage → /contact → /contact-us → /about
async function findEmail(osmEmail, website) {
  // Tier 1: OSM already has it
  if (osmEmail) return { email: osmEmail, source: 'listing' };

  if (!website) return { email: null, source: null };

  const base = website.startsWith('http') ? website.replace(/\/$/, '') : `https://${website}`;
  const pages = [base, `${base}/contact`, `${base}/contact-us`, `${base}/about`];

  for (const url of pages) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const text = await res.text();
      const emails = extractEmails(text);
      if (emails.length) return { email: emails[0], source: 'website' };
    } catch {
      // timed out or failed — try next page
    }
  }

  return { email: null, source: null };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { zip } = req.query;
  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Please provide a valid 5-digit zip code.' });
  }

  try {
    // Step 1: Zip → lat/lon
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`,
      { headers: { 'User-Agent': 'PlumberFinder/1.0' } }
    );
    const geoData = await geoRes.json();
    if (!geoData.length) return res.status(404).json({ error: 'Zip code not found.' });

    const { lat, lon } = geoData[0];

    // Step 2: Overpass query
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
    const elements = (overpassData.elements || []).filter(el => el.tags && el.tags.name);

    // Step 3: Build base business list
    const raw = elements.map(el => {
      const t = el.tags;
      const parts = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
      const address = [parts, t['addr:city'], t['addr:state'], t['addr:postcode']]
        .filter(Boolean).join(', ') || null;
      return {
        name: t.name,
        phone: t.phone || t['contact:phone'] || null,
        address,
        website: t.website || t['contact:website'] || null,
        osmEmail: t.email || t['contact:email'] || null,
        openingHours: t.opening_hours || null,
      };
    });

    // Step 4: Waterfall email search — run all in parallel, cap at 8s total
    const emailResults = await Promise.allSettled(
      raw.map(b => findEmail(b.osmEmail, b.website))
    );

    const businesses = raw.map((b, i) => {
      const result = emailResults[i].status === 'fulfilled' ? emailResults[i].value : { email: null, source: null };
      const { osmEmail, ...rest } = b;
      return { ...rest, email: result.email, emailSource: result.source };
    });

    return res.status(200).json({ businesses, count: businesses.length, zip });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch results. Please try again.' });
  }
};
