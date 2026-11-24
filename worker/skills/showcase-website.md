# Skill: Showcase website (site vitrine) for a local business
- Deliver ONE complete, self-contained `index.html` (inline CSS, no build step, no external JS framework). It must open directly in a browser.
- Mobile first and responsive: `<meta name="viewport" content="width=device-width, initial-scale=1">`, fluid layout, readable at 360 px.
- Sections: header with business name + short tagline; services/products; about; opening hours; address with an embedded OpenStreetMap iframe or a plain link to the map; contact (phone, email as `mailto:`); footer with the business name, address and contact. Anything the client has not provided (legal registration number, prices, team) is listed as questions in the delivery notes, never invented or left as a visible placeholder.
- Use only facts given by the client or the public listing. Never invent prices, reviews, awards, staff names or opening hours.
- Visuals without stock photos: CSS gradients, simple inline SVG icons, tasteful color palette suited to the trade (bakery: warm; garage: industrial; beauty: soft).
- SEO basics: `<title>`, meta description, `lang="fr"`, semantic tags (header, main, section, footer), alt text on every image, one `<h1>`.
- Accessibility: contrast ratio >= 4.5:1, focus styles, buttons/links with clear labels.
- Performance: no heavy assets; total file under 80 KB.
- Add a short HTML comment at the top explaining how to publish it for free (e.g. upload to any static host) — no promises about hosting.
