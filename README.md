# GAMESCOPE PRO

**GAMESCOPE PRO** is a global video game discovery catalog for PlayStation, PC and Xbox.

Visit the live website:  
https://gamescopepro.github.io/GAMESCOPE-PRO/

Project information:
- [About GAMESCOPE PRO](https://gamescopepro.github.io/GAMESCOPE-PRO/about/)
- [Frequently asked questions](https://gamescopepro.github.io/GAMESCOPE-PRO/faq/)
- [Data sources and catalog updates](https://gamescopepro.github.io/GAMESCOPE-PRO/data-sources/)

## Discover games across PlayStation, PC and Xbox

Explore the shared online catalog for:
- PlayStation
- PC
- Xbox

Games that appear on more than one supported platform keep all applicable platforms. Mobile-only and unrelated platform records are excluded from the shared catalog and online search.

Search for game titles, browse platform availability, check release dates, discover upcoming games, and review developer or publisher information when available. Every title is shown with the available store links for its supported platforms.

## Website features

- Shared online game catalog and title search
- Upcoming and recently released game discovery
- Platform, genre, publisher and release-date information
- Search aliases and typo-tolerant matching for known game titles
- Platform-specific PlayStation, Xbox and Steam store links
- Multilingual interface and mobile-responsive layout
- Server-side RAWG rolling catalog scans for PlayStation and Xbox
- Queued Steam product metadata checks every 15 minutes
- Automatic shared-catalog sync and change reports every 15 minutes
- Manual online source check with a progress bar and update report

## Data and technology

The catalog combines RAWG metadata, Steam discovery via SteamSpy and public Steam Store endpoints. SteamSpy broad discovery advances one page per day; the bounded Steam Store detail queue is processed during the 15-minute server sync. GOG storefront discovery is temporarily disabled because the previously tested public listing endpoint did not return a compatible response. IGDB enrichment is implemented as an optional server-side provider and requires Twitch application credentials to be stored securely as Supabase Edge Function secrets.

The public website is hosted with GitHub Pages and uses Supabase for its shared game catalog, source synchronization, and change reports. Provider coverage and metadata quality depend on the sources, their limits, and the records each scan can check; no source guarantees a complete list of every game in the world.

GAMESCOPE PRO is an independent community project and is not affiliated with Sony Interactive Entertainment, Microsoft, Valve, RAWG, Twitch, or GOG.
