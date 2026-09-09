# Profile and Daily Search

- Open `/profile` from the main navigation. Edit current/expected CTC, experience,
  notice period, target roles, skills and location preferences, then Save profile.
- Upload or replace a PDF/DOCX resume, or select a previously uploaded resume.
  Existing manually entered fields are preserved; review them when replacing a resume.
- Import a profile JSON file to prefill the form. Save commits it to the local
  database. Download profile JSON exports the current form for reuse; saving does
  not overwrite an arbitrary JSON file on disk or its unsupported custom sections.
- Anywhere means an empty preferred-location list. It removes the location
  preference penalty, not employer work-authorization or country restrictions.
- Saving the profile recomputes existing lead scores transactionally, preserving
  lead status, notes and run IDs. This uses deterministic scoring, not paid reranking.
  Save after an active search finishes, so its old profile cannot overwrite new scores.
- The leads table's Links column includes the company website and careers page
  when known. A published ATS portal is the careers fallback. Location and source
  remain separate fields. Unknown links are not inferred from company names.
- New website, careers or ATS URLs from later sources reopen company enrichment;
  repeat observations do not trigger unnecessary network requests.

## Portal Searches and Coverage

The Search page provides public Naukri, LinkedIn and Indeed search links with
role and location selectors seeded from the saved profile. Anywhere omits an
explicit location filter; each portal may still apply its own country or account
defaults. These links open the portal, not an import or an automatic sync.

Automatic ingestion uses only configured providers. Read-only Gmail OAuth can
collect job-alert links from these portals; keyed aggregators may supply additional
listings. Browser scrapers remain opt-in and may be blocked or rate-limited.
Browser sign-in does not configure the API's credentials or browser sessions.
No method guarantees every job from any portal. Use the per-source run messages
to distinguish partial or blocked collection from an empty result.

For postings reviewed in a browser, the authenticated import endpoint is documented
in [BROWSER-IMPORT.md](BROWSER-IMPORT.md). Imported snippets remain low-confidence;
only a genuinely complete description should be declared full.

The Search form supports up to 1,000 listings and preserves custom valid result
limits and date windows saved through the API. Non-excluded listings are retained
even below the match threshold, which controls the matched-leads view.

## Daily Fetching

Settings > Automatic search > Every day persists a 1,440-minute interval. Off
disables it. This overrides `SEARCH_INTERVAL_MINUTES` without restarting the API.
The authenticated GET/PUT `/api/search/schedule` endpoints expose the same setting.

The API must remain running, with the machine awake and network available.
The scheduler checks once a minute, skips active runs, and reuses the last search
request. Unavailable selected sources or missing rerank credentials pause a run
and produce a server warning. Review sources on the Search page after changing
credentials. The displayed timestamp is an attempt, not proof of a successful run.

Gmail browser sign-in does not enable unattended Gmail API access. See
[GMAIL.md](GMAIL.md) for read-only OAuth setup. Browser-imported alert snippets stay
below the full-description matching threshold; they are not verified full jobs.
Neither daily searches nor profile saves submit applications or send email.
