// cityTemplate.js — Generates SEO-optimized HTML for city landing pages

function generateNESection(city, stateCode) {
    const stateContent = {
        MA: {
            headline: 'Selling in Massachusetts',
            body: `The Massachusetts market moves fast. Spring listings in ${city.name} routinely draw multiple offers within days — the right realtor makes all the difference. Most homes here are traditional New England styles: colonials, capes, and split-levels, many with oil heat, older roofing, and private wells or town water depending on the area.`,
            tips: [
                'Spring (April–June) is peak season — list early to capture the most buyers',
                'Disclosure laws require sellers to reveal known material defects',
                'Oil heat systems are common — budget for a pre-sale tank inspection',
                'Historic homes may have lead paint or knob-and-tube wiring',
                'Title V septic inspections are required at sale in many towns',
            ]
        },
        CT: {
            headline: 'Selling in Connecticut',
            body: `Connecticut's market has surged as remote work drives buyers out of New York City. ${city.name} offers a compelling mix of New England character and value — but sellers need a local agent who understands what buyers are actually paying. Fairfield County properties command premium prices from NYC commuters and hedge fund professionals.`,
            tips: [
                'CT has some of the highest property taxes in the country — buyers factor this into offers',
                'NYC commuter proximity drives strong demand in Fairfield and New Haven counties',
                'Shoreline properties carry seasonal premium pricing',
                'Connecticut requires a Real Property Transfer Tax at closing',
                'Older homes are common — budget for oil tank sweeps and asbestos disclosure',
            ]
        },
        RI: {
            headline: 'Selling in Rhode Island',
            body: `Rhode Island packs remarkable real estate diversity into the smallest state in the nation. From Providence's vibrant urban neighborhoods to Newport's historic mansions and South County's coastal retreats, the Ocean State offers something for every buyer. ${city.name}'s market reflects Rhode Island's tight inventory and rising prices.`,
            tips: [
                'RI has one of the lowest housing inventories in New England — a seller\'s advantage',
                'Coastal and waterfront properties in Washington and Newport counties command significant premiums',
                'Providence\'s arts district continues to draw Boston spillover buyers',
                'Rhode Island requires Lead Disclosure for homes built before 1978',
                'Septic system inspections (DEM approval) are required in many RI towns at sale',
            ]
        },
        VT: {
            headline: 'Selling in Vermont',
            body: `Vermont's real estate market has transformed dramatically since 2020, with remote workers and second-home buyers from Boston and New York pushing prices to record levels. ${city.name} has seen strong appreciation as buyers seek Vermont's combination of natural beauty, safety, and quality of life.`,
            tips: [
                'Vermont has a 1.25% property transfer tax — sellers should be aware it affects buyer budgets',
                'Ski property near Stowe, Killington, and Mad River Glen commands strong seasonal premiums',
                'Many VT homes use propane or oil heat — inspection is key',
                'Act 250 environmental regulations may affect properties with significant land',
                'Fall foliage season (late Sept–Oct) brings peak buyer interest for vacation homes',
            ]
        },
        NH: {
            headline: 'Selling in New Hampshire',
            body: `New Hampshire's lack of income tax and sales tax makes it one of the most tax-friendly states in the Northeast — a powerful draw for Massachusetts and Connecticut buyers looking to lower their cost of living without leaving New England. ${city.name}'s market benefits from this sustained demand.`,
            tips: [
                'No state income or sales tax is NH\'s biggest draw for out-of-state buyers',
                'Southern NH towns are popular with MA commuters seeking more space',
                'Lakes Region properties carry strong vacation home premiums',
                'White Mountains towns see strong second-home and investment demand',
                'Septic and well inspections are standard — budget for these at listing time',
            ]
        },
        ME: {
            headline: 'Selling in Maine',
            body: `Maine has experienced one of the most dramatic real estate booms in the country since 2020, driven by remote workers, retirees, and second-home buyers from Boston and beyond. ${city.name}'s market reflects a state where inventory remains tight and buyer demand continues to outpace supply.`,
            tips: [
                'Maine\'s coastal properties — especially in York and Cumberland counties — command significant premiums',
                'Portland and the greater Portland metro are among the fastest-appreciating markets in New England',
                'Maine requires a Real Estate Transfer Tax split between buyer and seller',
                'Private wells and septic systems are common — inspection required at sale in most towns',
                'Winter listings attract serious buyers — less competition, faster closings',
            ]
        }
    };
    const c = stateContent[stateCode] || stateContent['MA'];
    const tipsHtml = c.tips.map(t => `<li style="padding:8px 0;border-bottom:1px solid var(--border);font-size:0.95rem;display:flex;gap:10px;align-items:flex-start;"><span style="color:var(--accent);font-weight:700;flex-shrink:0;">✓</span>${t}</li>`).join('');
    return `
<section class="section section-alt">
    <div style="max-width:1000px;margin:0 auto;display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:start;">
        <div>
            <div class="eyebrow">Local Market Insight</div>
            <h2 style="margin-bottom:16px;">${c.headline}</h2>
            <p style="font-size:1.02rem;color:var(--muted);line-height:1.8;margin-bottom:24px;">${c.body}</p>
            <a href="/login?tab=signup&type=seller" style="display:inline-block;background:var(--accent);color:white;padding:13px 28px;border-radius:8px;font-weight:700;font-size:0.95rem;text-decoration:none;">List My ${city.name} Home Free →</a>
        </div>
        <div style="background:white;border:1px solid var(--border);border-radius:16px;padding:32px;">
            <div style="font-family:'Playfair Display',serif;font-size:1.15rem;font-weight:700;color:var(--primary);margin-bottom:16px;">What Sellers in ${city.name} Should Know</div>
            <ul style="list-style:none;">${tipsHtml}</ul>
        </div>
    </div>
    <div style="max-width:1000px;margin:0 auto;"></div>
</section>`;
}

function generateCityPage(city, liveData = {}) {
    const { listingCount = 0, realtorCount = 0 } = liveData;
    const stateCode = (city.state_code || 'MA').toUpperCase();
    const stateName = city.state_name || 'Massachusetts';
    const neStates = ['MA', 'CT', 'RI', 'VT', 'NH', 'ME'];
    const neContent = neStates.includes(stateCode) ? generateNESection(city, stateCode) : '';
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
    <meta property="og:image" content="https://realtorfinder.net/og-default.png">

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${metaDesc}">
    <meta name="twitter:image" content="https://realtorfinder.net/og-default.png">

    <!-- Schema.org -->
    <script type="application/ld+json">${schemaOrg}</script>

    <!-- Fonts & Analytics -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;900&family=Work+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-BRGVVNKT65"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BRGVVNKT65');</script>
    <!-- Microsoft Clarity -->
    <script type="text/javascript">
        (function(c,l,a,r,i,t,y){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
            y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "wxvaz0g7tq");
    </script>

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

        /* LEAD MODAL */
        .modal-overlay {
            display: none; position: fixed; inset: 0; z-index: 1000;
            background: rgba(10,37,64,0.7); backdrop-filter: blur(4px);
            align-items: center; justify-content: center; padding: 20px;
        }
        .modal-overlay.open { display: flex; }
        .modal {
            background: #fff; border-radius: 20px; padding: 44px 40px;
            max-width: 480px; width: 100%; position: relative;
            box-shadow: 0 24px 64px rgba(0,0,0,0.18);
            animation: modalIn 0.22s ease;
        }
        @keyframes modalIn { from { opacity:0; transform:translateY(16px); } to { opacity:1; transform:none; } }
        @media (max-width: 520px) { .modal { padding: 32px 24px; } }
        .modal-close {
            position: absolute; top: 16px; right: 20px;
            background: none; border: none; font-size: 1.5rem;
            color: var(--muted); cursor: pointer; line-height: 1;
        }
        .modal-close:hover { color: var(--text); }
        .modal-eyebrow { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--accent); margin-bottom: 8px; }
        .modal h2 { font-family: 'Playfair Display', serif; font-size: 1.7rem; font-weight: 900; color: var(--primary); margin-bottom: 6px; line-height: 1.2; }
        .modal-sub { font-size: 0.93rem; color: var(--muted); margin-bottom: 28px; }

        /* Type toggle */
        .type-toggle { display: flex; gap: 10px; margin-bottom: 24px; }
        .type-btn {
            flex: 1; padding: 11px 8px; border-radius: 10px; font-size: 0.9rem;
            font-weight: 600; cursor: pointer; transition: all 0.15s;
            border: 2px solid var(--border); background: #fff; color: var(--muted);
        }
        .type-btn.active { border-color: var(--accent); background: #fff8f5; color: var(--accent); }

        /* Form fields */
        .form-group { margin-bottom: 16px; }
        .form-group label { display: block; font-size: 0.85rem; font-weight: 600; color: var(--text); margin-bottom: 6px; }
        .form-group input {
            width: 100%; padding: 12px 14px; border: 1.5px solid var(--border);
            border-radius: 10px; font-size: 0.97rem; font-family: inherit;
            transition: border-color 0.15s; outline: none; background: #fff;
        }
        .form-group input:focus { border-color: var(--accent); }
        .form-group input::placeholder { color: #b0b7c3; }
        .form-submit {
            width: 100%; padding: 15px; border-radius: 10px; border: none;
            background: var(--accent); color: #fff; font-size: 1rem; font-weight: 700;
            cursor: pointer; transition: all 0.2s; margin-top: 4px; font-family: inherit;
        }
        .form-submit:hover { background: var(--accent-dark); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(255,107,53,0.3); }
        .form-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
        .form-note { font-size: 0.78rem; color: var(--muted); text-align: center; margin-top: 12px; }

        /* Success state */
        .modal-success { display: none; text-align: center; padding: 12px 0; }
        .modal-success .check { font-size: 3rem; margin-bottom: 16px; }
        .modal-success h3 { font-family: 'Playfair Display', serif; font-size: 1.5rem; color: var(--primary); margin-bottom: 10px; }
        .modal-success p { color: var(--muted); font-size: 0.97rem; line-height: 1.6; }

        /* Inline lead section */
        .lead-section {
            background: var(--primary);
            padding: 72px 5%;
        }
        .lead-inner {
            max-width: 1000px; margin: 0 auto;
            display: grid; grid-template-columns: 1fr 1fr; gap: 60px; align-items: center;
        }
        @media (max-width: 768px) { .lead-inner { grid-template-columns: 1fr; gap: 36px; } }
        .lead-copy { color: #fff; }
        .lead-copy .eyebrow { color: rgba(255,107,53,0.9); }
        .lead-copy h2 { color: #fff; margin-bottom: 14px; }
        .lead-copy p { color: rgba(255,255,255,0.78); font-size: 1.02rem; line-height: 1.7; }
        .lead-form-card {
            background: #fff; border-radius: 16px; padding: 36px;
            box-shadow: 0 16px 48px rgba(0,0,0,0.2);
        }
        .lead-form-card .type-toggle { margin-bottom: 20px; }
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
    <div class="hero-eyebrow">${city.county ? city.county + ' County, ' : ''}${stateName}</div>
    <h1>Sell Your Home in <em>${city.name}</em> the Smart Way</h1>
    <p class="hero-sub">List your ${city.name} property and let local realtors compete for the right to represent you — so you get the best agent, not just the first one you find.</p>
    <div class="hero-ctas">
        <button class="btn-primary" onclick="openLead('seller')">List My Home — Free</button>
        <button class="btn-outline" onclick="openLead('realtor')">I'm a Realtor →</button>
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
    ${listingCount > 0 ? `<div class="stat"><div class="stat-num">${listingCount}</div><div class="stat-label">Active Listings</div></div>` : realtorCount > 0 ? `<div class="stat"><div class="stat-num">${realtorCount}</div><div class="stat-label">Active Realtors</div></div>` : `<div class="stat"><div class="stat-num">$0</div><div class="stat-label">Cost to List</div></div>`}
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
                <button class="btn-accent" onclick="openLead('seller')">List My ${city.name} Home Free</button>
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
                <button class="btn-white" onclick="openLead('realtor')">Get Access in ${city.name}</button>
            </div>
        </div>
    </div>
</section>

<!-- MARKET SNAPSHOT -->
<section class="section section-alt section-center">
    <div class="eyebrow">Market Snapshot</div>
    <h2>${city.name}, ${stateCode} Real Estate Market</h2>
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

${neContent}

<!-- NEARBY CITIES -->
<section class="section section-alt section-center">
    <div class="eyebrow">Also Serving</div>
    <h2>${stateName} Coverage</h2>
    <p class="section-intro">RealtorFinder connects sellers and realtors across ${city.county ? city.county + ' County and ' : ''}${stateName}, including ${city.nearby || 'nearby communities'}.</p>
    <div class="nearby-links" id="nearbyLinks"></div>
    <p style="margin-top:20px;"><a href="/locations/${stateCode.toLowerCase()}" style="color:var(--accent);font-weight:600;">View all ${stateName} cities →</a></p>
</section>

<!-- LIVE LISTINGS -->
<section class="section section-center" id="live-listings-section">
    <div class="eyebrow">Currently on RealtorFinder</div>
    <h2>Active Listings in ${city.name}</h2>
    <p class="section-intro">Homes in ${city.name} listed right now — sellers looking for the right realtor.</p>
    <div id="liveListingsGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1.25rem;max-width:1100px;margin:0 auto 2rem;text-align:left;"></div>
    <p id="noListingsMsg" style="display:none;color:var(--muted);font-size:1rem;margin-bottom:1.5rem;">No active listings in ${city.name} yet — <button onclick="openLead('seller')" style="background:none;border:none;color:var(--accent);font-weight:600;cursor:pointer;font-size:1rem;text-decoration:underline;">be the first to list your home</button>.</p>
</section>

<!-- INLINE LEAD CAPTURE -->
<section class="lead-section">
    <div class="lead-inner">
        <div class="lead-copy">
            <div class="eyebrow">Get Started Today</div>
            <h2>Connect with the Best Realtors in ${city.name}</h2>
            <p>Whether you're selling your home or you're a realtor looking for listings, RealtorFinder connects the right people. Free for sellers, no referral fees for realtors.</p>
        </div>
        <div class="lead-form-card">
            <div id="inlineFormWrap">
                <div class="type-toggle">
                    <button class="type-btn active" id="inline-seller-btn" onclick="setInlineType('seller')">🏠 I'm a Seller</button>
                    <button class="type-btn" id="inline-realtor-btn" onclick="setInlineType('realtor')">🤝 I'm a Realtor</button>
                </div>
                <form id="inlineLeadForm" onsubmit="submitInlineLead(event)">
                    <input type="hidden" id="inlineType" value="seller">
                    <div class="form-group">
                        <label for="inlineName">Your Name</label>
                        <input type="text" id="inlineName" placeholder="Jane Smith" autocomplete="name">
                    </div>
                    <div class="form-group">
                        <label for="inlineEmail">Email Address *</label>
                        <input type="email" id="inlineEmail" placeholder="jane@email.com" required autocomplete="email">
                    </div>
                    <div class="form-group">
                        <label for="inlinePhone">Phone <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
                        <input type="tel" id="inlinePhone" placeholder="(555) 555-5555" autocomplete="tel">
                    </div>
                    <button type="submit" class="form-submit" id="inlineSubmitBtn">Get Started Free →</button>
                    <p class="form-note">No spam. No credit card. Cancel anytime.</p>
                </form>
            </div>
            <div id="inlineSuccess" class="modal-success">
                <div class="check">✅</div>
                <h3>You're on the list!</h3>
                <p>We'll follow up within 24 hours with next steps. Check your email for a confirmation.</p>
            </div>
        </div>
    </div>
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
    // Nearby city links
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

    // ── Modal ──────────────────────────────────────────────
    const CITY_SLUG  = '${city.slug}';
    const CITY_NAME  = '${city.name.replace(/'/g, "\\'")}';
    const STATE_CODE = '${stateCode}';

    function openLead(type) {
        document.getElementById('modalType').value = type;
        document.getElementById('modal-seller-btn').classList.toggle('active', type === 'seller');
        document.getElementById('modal-realtor-btn').classList.toggle('active', type === 'realtor');
        document.getElementById('modalSubmitBtn').textContent =
            type === 'seller' ? 'Connect Me with Realtors →' : 'Get Listing Access →';
        document.getElementById('modalFormWrap').style.display = '';
        document.getElementById('modalSuccess').style.display = 'none';
        document.getElementById('leadModal').classList.add('open');
        document.getElementById('modalEmail').focus();
    }

    function closeLead() {
        document.getElementById('leadModal').classList.remove('open');
    }

    function setModalType(type) {
        document.getElementById('modalType').value = type;
        document.getElementById('modal-seller-btn').classList.toggle('active', type === 'seller');
        document.getElementById('modal-realtor-btn').classList.toggle('active', type === 'realtor');
        document.getElementById('modalAddressGroup').style.display = type === 'seller' ? '' : 'none';
        document.getElementById('modalSubmitBtn').textContent =
            type === 'seller' ? 'Connect Me with Realtors →' : 'Get Listing Access →';
    }

    async function submitModalLead(e) {
        e.preventDefault();
        const btn = document.getElementById('modalSubmitBtn');
        btn.disabled = true;
        btn.textContent = 'Submitting…';
        await submitLead(
            document.getElementById('modalType').value,
            document.getElementById('modalName').value,
            document.getElementById('modalEmail').value,
            document.getElementById('modalPhone').value,
            document.getElementById('modalAddress').value,
            () => {
                document.getElementById('modalFormWrap').style.display = 'none';
                document.getElementById('modalSuccess').style.display = 'block';
            },
            () => { btn.disabled = false; btn.textContent = 'Try Again'; }
        );
    }

    document.getElementById('leadModal').addEventListener('click', e => {
        if (e.target === e.currentTarget) closeLead();
    });

    // ── Inline form ────────────────────────────────────────
    function setInlineType(type) {
        document.getElementById('inlineType').value = type;
        document.getElementById('inline-seller-btn').classList.toggle('active', type === 'seller');
        document.getElementById('inline-realtor-btn').classList.toggle('active', type === 'realtor');
        document.getElementById('inlineSubmitBtn').textContent =
            type === 'seller' ? 'Connect Me with Realtors →' : 'Get Listing Access →';
    }

    async function submitInlineLead(e) {
        e.preventDefault();
        const btn = document.getElementById('inlineSubmitBtn');
        btn.disabled = true;
        btn.textContent = 'Submitting…';
        await submitLead(
            document.getElementById('inlineType').value,
            document.getElementById('inlineName').value,
            document.getElementById('inlineEmail').value,
            document.getElementById('inlinePhone').value,
            '',
            () => {
                document.getElementById('inlineFormWrap').style.display = 'none';
                document.getElementById('inlineSuccess').style.display = 'block';
            },
            () => { btn.disabled = false; btn.textContent = 'Get Started Free →'; }
        );
    }

    // ── Shared submit ──────────────────────────────────────
    async function submitLead(type, name, email, phone, address, onSuccess, onError) {
        try {
            const res = await fetch('/api/city-lead', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, name, email, phone, address, city_slug: CITY_SLUG, city_name: CITY_NAME, state_code: STATE_CODE })
            });
            if (res.ok) {
                gtag('event', 'generate_lead', { lead_type: type, city: CITY_NAME, state: STATE_CODE });
                onSuccess();
            } else { onError(); }
        } catch { onError(); }
    }
</script>

<!-- LEAD MODAL -->
<div class="modal-overlay" id="leadModal">
    <div class="modal">
        <button class="modal-close" onclick="closeLead()" aria-label="Close">×</button>
        <div id="modalFormWrap">
            <div class="modal-eyebrow">Free — No Commitment</div>
            <h2>Get Started in ${city.name}</h2>
            <p class="modal-sub">Tell us who you are and we'll connect you with the right people.</p>
            <div class="type-toggle">
                <button class="type-btn active" id="modal-seller-btn" onclick="setModalType('seller')">🏠 I'm a Seller</button>
                <button class="type-btn" id="modal-realtor-btn" onclick="setModalType('realtor')">🤝 I'm a Realtor</button>
            </div>
            <form onsubmit="submitModalLead(event)">
                <input type="hidden" id="modalType" value="seller">
                <div class="form-group">
                    <label for="modalName">Your Name</label>
                    <input type="text" id="modalName" placeholder="Jane Smith" autocomplete="name">
                </div>
                <div class="form-group" id="modalAddressGroup">
                    <label for="modalAddress">Home Address <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
                    <input type="text" id="modalAddress" placeholder="123 Main St, ${city.name}" autocomplete="street-address">
                </div>
                <div class="form-group">
                    <label for="modalEmail">Email Address *</label>
                    <input type="email" id="modalEmail" placeholder="jane@email.com" required autocomplete="email">
                </div>
                <div class="form-group">
                    <label for="modalPhone">Phone <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
                    <input type="tel" id="modalPhone" placeholder="(555) 555-5555" autocomplete="tel">
                </div>
                <button type="submit" class="form-submit" id="modalSubmitBtn">Connect Me with Realtors →</button>
                <p class="form-note">No spam. No credit card. Cancel anytime.</p>
            </form>
        </div>
        <div class="modal-success" id="modalSuccess">
            <div class="check">✅</div>
            <h3>You're on the list!</h3>
            <p>We'll follow up within 24 hours. Check your email for a confirmation.</p>
            <button onclick="closeLead()" class="btn-accent" style="margin-top:20px;border:none;cursor:pointer;">Done</button>
        </div>
    </div>
</div>

<script>
(async function() {
    try {
        const r = await fetch('/api/listings?city=${encodeURIComponent(city.name)}&limit=6');
        const data = await r.json();
        const listings = Array.isArray(data) ? data : (data.listings || []);
        const grid = document.getElementById('liveListingsGrid');
        if (!listings.length) {
            document.getElementById('noListingsMsg').style.display = 'block';
            return;
        }
        grid.innerHTML = listings.map(l => {
            const img = l.image_urls && l.image_urls.length ? l.image_urls[0] : '';
            return '<a href="/listing/' + l.id + '" style="display:block;background:white;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit;transition:box-shadow 0.2s;" onmouseover="this.style.boxShadow=\'0 8px 24px rgba(0,0,0,0.1)\'" onmouseout="this.style.boxShadow=\'none\'">'
                + (img ? '<div style="height:160px;background:center/cover url(' + JSON.stringify(img) + ')"></div>' : '<div style="height:160px;background:#e8ded8;display:flex;align-items:center;justify-content:center;font-size:2rem;">🏠</div>')
                + '<div style="padding:1rem;">'
                + '<div style="font-family:\'Playfair Display\',serif;font-size:1.3rem;font-weight:900;color:#0A2540;margin-bottom:0.25rem;">$' + Number(l.price).toLocaleString() + '</div>'
                + '<div style="font-size:0.85rem;color:#6b7280;margin-bottom:0.5rem;">' + (l.address || '') + '</div>'
                + '<div style="font-size:0.82rem;color:#9ca3af;">' + [l.bedrooms ? l.bedrooms + ' bd' : '', l.bathrooms ? l.bathrooms + ' ba' : '', l.sqft ? Number(l.sqft).toLocaleString() + ' sqft' : ''].filter(Boolean).join(' · ') + '</div>'
                + '</div></a>';
        }).join('');
    } catch(e) {}
})();
</script>

</body>
</html>`;
}

module.exports = { generateCityPage };
