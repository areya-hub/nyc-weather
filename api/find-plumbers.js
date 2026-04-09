const cheerio = require('cheerio');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { zip } = req.query;

  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Please provide a valid 5-digit zip code.' });
  }

  try {
    const url = `https://www.yellowpages.com/search?search_terms=plumbers&geo_location_terms=${zip}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      }
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Upstream returned ${response.status}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const businesses = [];

    $('.result').each((_, el) => {
      const name = $(el).find('.business-name span').first().text().trim()
        || $(el).find('.business-name').text().trim();
      if (!name) return;

      const phone = $(el).find('.phones.phone.primary').text().trim()
        || $(el).find('.phones').first().text().trim();

      const street = $(el).find('.street-address').text().trim();
      const locality = $(el).find('.locality').text().trim();
      const address = [street, locality].filter(Boolean).join(', ');

      const ratingClass = $(el).find('[class*="rating-"]').attr('class') || '';
      const ratingMatch = ratingClass.match(/rating-(\d+)/);
      const rating = ratingMatch ? (parseInt(ratingMatch[1]) / 10).toFixed(1) : null;

      const reviewCount = $(el).find('.count').text().replace(/[()]/g, '').trim();

      const categories = [];
      $(el).find('.categories a').each((_, a) => categories.push($(a).text().trim()));

      businesses.push({
        name,
        phone: phone || null,
        address: address || null,
        rating: rating ? parseFloat(rating) : null,
        reviewCount: reviewCount || null,
        categories: categories.length ? categories : null,
      });
    });

    return res.status(200).json({ businesses, count: businesses.length, zip });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch results. Please try again.' });
  }
};
