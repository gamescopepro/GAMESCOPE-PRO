# GAMESCOPE PRO

**GAMESCOPE PRO** is a global video game discovery catalog.

Visit the live website:  
https://gamescopepro.github.io/GAMESCOPE-PRO/

Project information:
- [About GAMESCOPE PRO](https://gamescopepro.github.io/GAMESCOPE-PRO/about/)
- [Frequently asked questions](https://gamescopepro.github.io/GAMESCOPE-PRO/faq/)
- [Data sources and catalog updates](https://gamescopepro.github.io/GAMESCOPE-PRO/data-sources/)

## Discover games across PlayStation, PC and Xbox

Explore video games for:

- PlayStation
- PC
- Xbox

Search for game titles, browse available platforms, check release dates, discover upcoming games, and review developer or publisher information when available.

## Website features

- Online game catalog and game search
- Upcoming and recently released game discovery
- Platform, genre, publisher and release-date information
- Personal game library, favorites, ratings and notes
- Multilingual interface
- Server-side RAWG rolling catalog scans for PlayStation and Xbox, upcoming/recent-release checks, and queued Steam product details every 15 minutes; broad SteamSpy discovery advances one page per day
- Upcoming games remain in the same searchable catalog as released games and are marked with their release status
- Manual online source check and latest update report

## Data and technology

The catalog combines RAWG metadata, Steam discovery via SteamSpy and public Steam Store endpoints, while GOG storefront discovery is temporarily disabled after its undocumented listing endpoint failed compatibility testing. IGDB is supported as an optional enrichment provider when Twitch application credentials are stored securely as Supabase Edge Function secrets. Coverage, availability and accuracy depend on each provider, its rate limits, and the pages checked by each run. The public website is hosted with GitHub Pages and uses Supabase for account and catalog services.

GAMESCOPE PRO is an independent community project and is not affiliated with Sony Interactive Entertainment, Microsoft, Valve or RAWG.
