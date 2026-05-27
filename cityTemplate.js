// cityTemplate.js — Generates SEO-optimized HTML for city landing pages

function generateCityPage(city, liveData = {}) {
    const { listingCount = 0, realtorCount = 0 } = liveData;
    const stateCode = (city.state_code || 'MA').toUpperCase();
    const stateName = city.state_name || 'Massachusetts';
    const title = `Sell Your Home in ${city.name}, ${stateCode} | RealtorFinder`;
    const metaDesc = `List your ${city.name}, ${stateCode} home on RealtorFinder and let local realtors compete for your listing. Free for sellers. Realtors: bid on ${city.name} listings before they hit Zillow.`;
    const canonicalUrl = `https://www.realtorfinder.net/locations/${stateCode.toLowerCase()}/${city.slug}`;
    const schemaOrg = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'RealEstateAgent',
        'name': `RealtorFinder — ${city.name}, ${stateCode}`,
        'description': metaDesc,
        'url': canonicalUrl,
        'areaServed': {
            '@type': 'City',
            'name': city.name,
            'addressRegion': stateCode,
            'addressCountry': 'US'
        },
        'serviceType': 'Real Estate Listing Marketplace'
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${metaDesc}">
    <link rel="canonical" href="${canonicalUrl}">

    <!-- Open Graph -->
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${metaDesc}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="RealtorFinder">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${metaDesc}">

    <!-- Schema.org -->
    <script type="application/ld+json">${schemaOrg}</script>

    <!-- Fonts & Analytics -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>

    <style>
        :root {
            --primary: #0A2540;
            --accent: #FF6B35;
            --accent-dark: #e55a2b;
            --text: #1a1a2e;
            --muted: #6b7280;
            --border: #e5e7eb;
            --soft-bg: #f8f9fa;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Work Sans', sans-serif; color: var(--text); line-height: 1.6; }
        a { color: inherit; text-decoration: none; }

        /* NAV */
        nav {
            position: fixed; top: 0; left: 0; right: 0; z-index: 100;
            background: rgba(255,255,255,0.97); backdrop-filter: blur(10px);
            border-bottom: 1px solid var(--border);
            padding: 0 5%;
            display: flex; align-items: center; justify-content: space-between;
            height: 68px;
        }
        .nav-logo { font-family: 'Playfair Display', serif; font-size: 1.5rem; font-weight: 900; color: var(--primary); }
        .nav-logo span { color: var(--accent); }
        .nav-links { display: flex; align-items: center; gap: 28px; }
        .nav-links a { font-weight: 500; color: var(--primary); font-size: 0.95rem; }
        .nav-links a:hover { color: var(--accent); }
        .nav-cta { background: var(--accent); color: #fff !important; padding: 10px 22px; border-radius: 8px; font-weight: 600; }
        .nav-cta:hover { background: var(--accent-dark) !important; }
        @media (max-width: 640px) { .nav-links .hide-mobile { display: none; } }

        /* HERO */
        .hero {
            background: linear-gradient(135deg, var(--primary) 0%, #0d3a5c 60%, #133a5e 100%);
            color: #fff;
            padding: 140px 5% 80px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        .hero::before {
            content: '';
            position: absolute; top: -40%; right: -20%;
            width: 700px; height: 700px;
            background: radial-gradient(circle, rgba(255,107,53,0.12) 0%, transparent 65%);
            border-radius: 50%;
        }
        .hero-eyebrow {
            display: inline-block;
            background: rgba(255,107,53,0.2); color: #FF6B35;
            border: 1px solid rgba(255,107,53,0.4);
            border-radius: 20px; padding: 6px 18px;
            font-size: 0.85rem; font-weight: 600; letter-spacing: 0.05em;
            text-transform: uppercase; margin-bottom: 20px;
            position: relative; z-index: 1;
        }
        .hero h1 {
            font-family: 'Playfair Display', serif;
            font-size: clamp(2.2rem, 5vw, 3.8rem);
            font-weight: 900; line-height: 1.1;
            max-width: 820px; margin: 0 auto 20px;
            position: relative; z-index: 1;
        }
        .hero h1 em { color: var(--accent); font-style: normal; }
        .hero-sub {
            font-size: clamp(1rem, 2vw, 1.2rem);
            opacity: 0.88; max-width: 620px; margin: 0 auto 36px;
            position: relative; z-index: 1;
        }
        .hero-ctas { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; position: relative; z-index: 1; }
        .btn-primary {
            background: var(--accent); color: #fff;
            padding: 15px 32px; border-radius: 10px;
            font-weight: 700; font-size: 1rem;
            transition: all 0.2s; display: inline-block; border: none; cursor: pointer;
        }
        .btn-primary:hover { background: var(--accent-dark); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(255,107,53,0.35); }
        .btn-outline {
            background: transparent; color: #fff;
            padding: 15px 32px; border-radius: 10px;
            font-weight: 600; font-size: 1rem; border: 2px solid rgba(255,255,255,0.5);
            transition: all 0.2s; display: inline-block; cursor: pointer;
        }
        .btn-outline:hover { border-color: #fff; background: rgba(255,255,255,0.08); }

        /* STATS BAR */
        .stats-bar {
            background: #fff; border-bottom: 1px solid var(--border);
            padding: 20px 5%;
            display: flex; justify-content: center; gap: 60px; flex-wrap: wrap;
        }
        .stat { text-align: center; }
        .stat-num { font-family: 'Playfair Display', serif; font-size: 1.9rem; font-weight: 900; color: var(--primary); }
        .stat-num span { color: var(--accent); }
        .stat-label { font-size: 0.82rem; color: var(--muted); font-weight: 500; margin-top: 2px; }

        /* SECTIONS */
        .section { padding: 80px 5%; }
        .section-alt { background: var(--soft-bg); }
        .section-center { text-align: center; }
        .eyebrow {
            font-size: 0.8rem; font-weight: 700; letter-spacing: 0.1em;
            text-transform: uppercase; color: var(--accent); margin-bottom: 10px;
        }
        h2 {
            font-family: 'Playfair Display', serif;
            font-size: clamp(1.8rem, 3vw, 2.6rem);
            font-weight: 900; color: var(--primary);
            line-height: 1.15; margin-bottom: 16px;
        }
        .section-intro { font-size: 1.05rem; color: var(--muted); max-width: 640px; margin: 0 auto 48px; }

        /* TWO-PANEL */
        .two-panel { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; max-width: 1100px; margin: 0 auto; align-items: stretch; }
        @media (max-width: 768px) { .two-panel { grid-template-columns: 1fr; } }
        .panel {
            background: #fff; border-radius: 16px; padding: 36px;
            border: 1px solid var(--border);
            display: flex; flex-direction: column;
        }
        .panel.accent-panel { background: var(--primary); color: #fff; border-color: var(--primary); }
        .panel h3 { font-family: 'Playfair Display', serif; font-size: 1.5rem; font-weight: 700; margin-bottom: 12px; }
        .panel p { font-size: 0.98rem; line-height: 1.7; opacity: 0.9; margin-bottom: 20px; flex: 1; }
        .panel ul { list-style: none; margin-bottom: 24px; flex: 1; }
        .panel ul li { padding: 7px 0; font-size: 0.95rem; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; align-items: flex-start; gap: 10px; }
        .panel:not(.accent-panel) ul li { border-bottom-color: var(--border); }
        .panel ul li::before { content: '✓'; color: var(--accent); font-weight: 700; flex-shrink: 0; margin-top: 1px; }
        .panel .panel-cta { margin-top: auto; }
        .btn-white { background: #fff; color: var(--primary); padding: 13px 28px; border-radius: 8px; font-weight: 700; font-size: 0.95rem; display: inline-block; transition: all 0.2s; }
        .btn-white:hover { background: var(--soft-bg); transform: translateY(-1px); }
        .btn-accent { background: var(--accent); color: #fff; padding: 13px 28px; border-radius: 8px; font-weight: 700; font-size: 0.95rem; display: inline-block; transition: all 0.2s; }
        .btn-accent:hover { background: var(--accent-dark); transform: translateY(-1px); }

        /* HOW IT WORKS */
        .steps { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 28px; max-width: 1000px; margin: 0 auto; }
        .step { text-align: center; padding: 28px 20px; }
        .step-num {
            width: 52px; height: 52px; border-radius: 50%;
            background: linear-gradient(135deg, var(--accent) 0%, #ff8c5a 100%);
            color: #fff; font-family: 'Playfair Display', serif;
            font-size: 1.4rem; font-weight: 900;
            display: flex; align-items: center; justify-content: center;
            margin: 0 auto 16px;
        }
        .step h4 { font-family: 'Playfair Display', serif; font-size: 1.1rem; font-weight: 700; margin-bottom: 8px; color: var(--primary); }
        .step p { font-size: 0.9rem; color: var(--muted); line-height: 1.6; }

        /* MARKET SNAPSHOT */
        .market-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; max-width: 900px; margin: 0 auto 40px; }
        .market-card {
            background: #fff; border: 1px solid var(--border); border-radius: 12px;
            padding: 24px; text-align: center;
        }
        .market-card .value { font-family: 'Playfair Display', serif; font-size: 2rem; font-weight: 900; color: var(--primary); }
        .market-card .trend { font-size: 0.82rem; color: #16a34a; font-weight: 600; margin: 4px 0; }
        .market-card .label { font-size: 0.82rem; color: var(--muted); }

        /* NEARBY */
        .nearby-links { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 32px; }
        .nearby-link {
            background: #fff; border: 1px solid var(--border);
            border-radius: 8px; padding: 9px 18px;
            font-size: 0.9rem; font-weight: 500; color: var(--primary);
            transition: all 0.2s;
        }
        .nearby-link:hover { border-color: var(--accent); color: var(--accent); background: #fff8f5; }

        /* CTA BAND */
        .cta-band {
            background: linear-gradient(135deg, var(--accent) 0%, #ff8c5a 100%);
            padding: 70px 5%; text-align: center; color: #fff;
        }
        .cta-band h2 { color: #fff; margin-bottom: 14px; }
        .cta-band p { opacity: 0.92; font-size: 1.05rem; max-width: 560px; margin: 0 auto 32px; }
        .btn-white-outline { background: transparent; color: #fff; border: 2px solid rgba(255,255,255,0.7); padding: 13px 28px; border-radius: 8px; font-weight: 700; font-size: 0.95rem; display: inline-block; transition: all 0.2s; margin-left: 12px; }
        .btn-white-outline:hover { border-color: #fff; background: rgba(255,255,255,0.1); }

        /* FOOTER */
        footer {
            background: var(--primary); color: rgba(255,255,255,0.7);
            padding: 40px 5%; text-align: center; font-size: 0.85rem;
        }
        footer a { color: rgba(255,255,255,0.7); margin: 0 10px; }
        footer a:hover { color: #fff; }
        .footer-logo { font-family: 'Playfair Display', serif; font-size: 1.3rem; font-weight: 900; color: #fff; margin-bottom: 12px; }
        .footer-logo span { color: var(--accent); }
    </style>
</head>
<body>

<nav>
    <a href="/" class="nav-logo">Realtor<span>Finder</span></a>
    <div class="nav-links">
        <a href="/locations" class="hide-mobile">All Cities</a>
        <a href="/realtors" class="hide-mobile">For Realtors</a>
        <a href="/login" class="nav-cta">Get Started Free</a>
    </div>
</nav>

<!-- HERO -->
<section class="hero">
    <div class="hero-eyebrow">${city.county} County, Western MA</div>
    <h1>Sell Your Home in <em>${city.name}</em> the Smart Way</h1>
    <p class="hero-sub">List your ${city.name} property and let local realtors compete for the right to represent you — so you get the best agent, not just the first one you find.</p>
    <div class="hero-ctas">
        <a href="/signup" class="btn-primary">List My Home — Free</a>
        <a href="/realtors" class="btn-outline">I'm a Realtor →</a>
    </div>
</section>

<!-- STATS BAR -->
<div class="stats-bar">
    <div class="stat">
        <div class="stat-num">${city.median_price}</div>
        <div class="stat-label">Median Home Price</div>
    </div>
    <div class="stat">
        <div class="stat-num"><span>↑</span>${(city.price_trend || '').replace('up ', '')}</div>
        <div class="stat-label">Year-Over-Year</div>
    </div>
    <div class="stat">
        <div class="stat-num">${city.avg_dom || '—'}<span>${city.avg_dom ? ' days' : ''}</span></div>
        <div class="stat-label">Avg. Days on Market</div>
    </div>
    ${realtorCount > 0 ? `<div class="stat"><div class="stat-num">${realtorCount}</div><div class="stat-label">Active Realtors</div></div>` : `<div class="stat"><div class="stat-num">$0</div><div class="stat-label">Cost to List for Sellers</div></div>`}
</div>

<!-- WHO IS THIS FOR -->
<section class="section">
    <div class="two-panel">
        <div class="panel">
            <div class="eyebrow">For Sellers</div>
            <h3>Sell Your ${city.name} Home Smarter</h3>
            <p>${city.seller_hook} Stop settling for the first agent who calls you back.</p>
            <ul>
                <li>List your home for free — no upfront fees</li>
                <li>Receive bids from licensed local realtors</li>
                <li>Compare commission rates and marketing plans</li>
                <li>Choose the agent who earns your business</li>
                <li>Faster sales, better outcomes</li>
            </ul>
            <div class="panel-cta">
                <a href="/signup" class="btn-accent">List My ${city.name} Home Free</a>
            </div>
        </div>
        <div class="panel accent-panel">
            <div class="eyebrow" style="color:rgba(255,107,53,0.9);">For Realtors</div>
            <h3>Win Listings in ${city.name}</h3>
            <p>${city.realtor_hook} RealtorFinder gives you access to motivated sellers before they sign with someone else.</p>
            <ul>
                <li>Browse new ${city.name} listings instantly</li>
                <li>Submit bids with your rate and pitch</li>
                <li>Beat out-of-area agents with local expertise</li>
                <li>Plans from $99/month — cancel anytime</li>
                <li>No leads fees, no referral cuts</li>
            </ul>
            <div class="panel-cta">
                <a href="/realtors" class="btn-white">See Realtor Pricing</a>
            </div>
        </div>
    </div>
</section>

<!-- MARKET SNAPSHOT -->
<section class="section section-alt section-center">
    <div class="eyebrow">Market Snapshot</div>
    <h2>${city.name}, MA Real Estate Market</h2>
    <p class="section-intro">${city.name} is ${city.description}. Here's a quick look at current market conditions.</p>
    <div class="market-grid">
        <div class="market-card">
            <div class="value">${city.median_price}</div>
            <div class="trend">↑ ${city.price_trend}</div>
            <div class="label">Median Sale Price</div>
        </div>
        <div class="market-card">
            <div class="value">${city.avg_dom}</div>
            <div class="trend">Days avg.</div>
            <div class="label">Days on Market</div>
        </div>
        <div class="market-card">
            <div class="value">${city.population}</div>
            <div class="trend">Residents</div>
            <div class="label">Population</div>
        </div>
        <div class="market-card">
            <div class="value">$0</div>
            <div class="trend">Free for sellers</div>
            <div class="label">Cost to List</div>
        </div>
    </div>
    <p style="font-size:0.85rem;color:var(--muted);">Popular neighborhoods include ${city.neighborhoods}.</p>
</section>

<!-- HOW IT WORKS -->
<section class="section section-center">
    <div class="eyebrow">How It Works</div>
    <h2>List in ${city.name} in 3 Steps</h2>
    <div class="steps">
        <div class="step">
            <div class="step-num">1</div>
            <h4>Post Your Listing</h4>
            <p>Create a free listing with your property details, photos, and timeline. No credit card required.</p>
        </div>
        <div class="step">
            <div class="step-num">2</div>
            <h4>Realtors Compete</h4>
            <p>Licensed ${city.name}-area agents submit bids with their commission rate and marketing strategy.</p>
        </div>
        <div class="step">
            <div class="step-num">3</div>
            <h4>You Choose</h4>
            <p>Review bids side-by-side and pick the realtor who offers the best fit for your goals.</p>
        </div>
    </div>
</section>

<!-- NEARBY CITIES -->
<section class="section section-alt section-center">
    <div class="eyebrow">Also Serving</div>
    <h2>${stateName} Coverage</h2>
    <p class="section-intro">RealtorFinder connects sellers and realtors across ${city.county ? city.county + ' County and ' : ''}${stateName}, including ${city.nearby || 'nearby communities'}.</p>
    <div class="nearby-links" id="nearbyLinks"></div>
    <p style="margin-top:20px;"><a href="/locations/${stateCode.toLowerCase()}" style="color:var(--accent);font-weight:600;">View all ${stateName} cities →</a></p>
</section>

<!-- FINAL CTA -->
<section class="cta-band">
    <h2>Ready to Sell in ${city.name}?</h2>
    <p>Join the sellers and realtors already using RealtorFinder across western Massachusetts. Listing is always free.</p>
    <a href="/signup" class="btn-white">List My Home — Free</a>
    <a href="/realtors" class="btn-white-outline">I'm a Realtor</a>
</section>

<footer>
    <div class="footer-logo">Realtor<span>Finder</span></div>
    <p>Connecting ${city.name} home sellers with the best local realtors since 2025.</p>
    <p style="margin-top:12px;">
        <a href="/">Home</a>
        <a href="/locations">All Cities</a>
        <a href="/realtors">For Realtors</a>
        <a href="/login">Sign Up</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
    </p>
    <p style="margin-top:16px;font-size:0.78rem;opacity:0.5;">© ${new Date().getFullYear()} RealtorFinder. All rights reserved. Market data is approximate and for informational purposes only.</p>
</footer>

<script>
    // Populate nearby city links from same state
    fetch('/api/cities/${stateCode.toLowerCase()}')
        .then(r => r.json())
        .then(cities => {
            const container = document.getElementById('nearbyLinks');
            cities.filter(c => c.slug !== '${city.slug}').slice(0, 12).forEach(c => {
                const a = document.createElement('a');
                a.href = '/locations/${stateCode.toLowerCase()}/' + c.slug;
                a.className = 'nearby-link';
                a.textContent = c.name + ', ${stateCode}';
                container.appendChild(a);
            });
        })
        .catch(() => {});
</script>

</body>
</html>`;
}

module.exports = { generateCityPage };
