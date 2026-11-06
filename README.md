# Faceless Radar

Sajt koji svaki dan istražuje **faceless YouTube kanale**: koje su niše najpopularnije, kako izgledaju njihovi thumbnaili,
koji videi nadmašuju prosjek svog kanala (outlier skor) i koliko niša okvirno zarađuje (RPM procjene sa izvorima).

Ovo je originalan projekat: ne koristi kod, dizajn ni podatke sa 1of10.com ili bilo kojeg drugog alata.
Svi podaci dolaze iz službenog YouTube Data API-ja.

## Šta je u projektu

```
config/niches.json     43 niše sa pretragama i RPM izvorima (ovdje dodaješ nove niše)
config/settings.json   pragovi: prozor od 90 dana, outlier prag 5x, budžet kvote
scripts/collect.mjs    dnevni collector: pretraga niša, osvježavanje kanala, outlier skor, skor prilike
site/                  statični sajt (index.html + assets + data/*.json), ovo se objavljuje
state/state.json       interno stanje collectora (rotacija pretraga), ne objavljuje se
.github/workflows/     deploy.yml: svaki dan skupi podatke, snimi ih u repo i objavi sajt
docs/                  DAILY_ANALYSIS_PROMPT.md: uputstvo za dnevni AI pregled (faceless provjera, formule thumbnaila)
tests/                 test collectora na lažnom YouTube API-ju (npm test)
```

## Postavljanje (jednom, oko 15 minuta)

1. **YouTube API ključ.** Na https://console.cloud.google.com napravi projekat, uključi "YouTube Data API v3",
   pa u Credentials napravi API key i ograniči ga samo na YouTube Data API v3. Besplatno je, kvota je 10.000 jedinica dnevno.
2. **GitHub repo.** Napravi novi (privatni ili javni) repozitorijum i postavi ovaj folder u njega, na granu `main`.
3. **Tajna.** U repou: Settings, Secrets and variables, Actions, New repository secret. Ime: `YOUTUBE_API_KEY`, vrijednost: tvoj ključ.
   Ključ nikad ne upisuj u kod ili u fajlove.
4. **Pages.** Settings, Pages, Source: **GitHub Actions**.
5. **Prvi run.** Actions, "Daily update and deploy", Run workflow. Nakon par minuta sajt ima prve podatke.
   Od tada se pokreće sam svaki dan u 04:17 UTC.

Alternativa za hosting: Cloudflare Pages ili Vercel, publish direktorij `site`, bez build komande.
GitHub Action i dalje radi dnevno prikupljanje i snima podatke u repo, a host se sam osvježi na svaki push.

## Kako rade brojevi

- **Outlier skor** = pregledi videa podijeljeni medijanom pregleda zadnjih 30 videa istog formata (dugi ili Shorts) na tom kanalu.
- **Skor prilike (0 do 100)** = do 40 bodova za udio kanala sa 5x videom u 60 dana, do 25 za pobjede novih kanala (mlađi od godinu dana),
  do 20 za RPM procjenu (neutralnih 10 ako nema), do 15 za nisku zasićenost (malo kanala preko milion pretplatnika).
  To je heuristika za sortiranje niša, ne prognoza.
- **Faceless provjera.** YouTube ne zna da li kanal pokazuje lice, pa API to ne može dati. Pretrage ciljaju faceless formate,
  a dnevni AI pregled (`docs/DAILY_ANALYSIS_PROMPT.md`) označava kanale kao faceless ili ne. Dok kanal nije pregledan, na sajtu piše
  "Not reviewed yet", a prekidač "Verified faceless only" sakriva sve nepregledano.
- **RPM** su procjene iz javnih članaka trećih strana. Međusobno se razlikuju, zato se prikazuju kao raspon sa izvorima.

## Kvota

Jedna pretraga košta 100 jedinica, a sve ostalo 1. Jedan dnevni run radi 40 pretraga (4.000) plus osvježavanje do 400 kanala (oko 800),
dakle oko 5.000 od 10.000. Zato prva dva dana pokriju dugi format svih 43 niše, a kratki (Shorts) dolaze u narednim danima.
Ako dodaš mnogo niša, povećaj `maxSearchesPerRun` samo uz oprez, jer `quotaBudget` (9.000) zaustavlja run prije prekoračenja.

## Dnevna AI analiza

Brojeve skuplja collector, a procjenu ("da li je ovo faceless", "zašto ovaj thumbnail radi", nove niše koje rastu) radi dnevni zadatak
po uputstvu u `docs/DAILY_ANALYSIS_PROMPT.md`. Zakazuje se oko 2 sata nakon collectora, a piše samo u `reviews.json`, `niche_notes.json`,
`analysis.json` i `config/niches.json`.

## Lokalno

```bash
npm run offline     # napravi početne fajlove bez API poziva
npm run serve       # http://localhost:8080
YOUTUBE_API_KEY=... npm run collect
npm test            # 10 provjera na sintetičkom YouTube API-ju (nikakvi podaci se ne isporučuju)
```

Sajt se mora otvarati preko http (npm run serve), ne dvoklikom na index.html, jer učitava JSON fajlove.

## Pravila koja treba poštovati

- Koristi podatke u skladu sa [YouTube API Services uslovima](https://developers.google.com/youtube/terms/api-services-terms-of-service).
  Sajt već u podnožju linkuje YouTube Terms of Service i Google Privacy Policy, ostavi to tako.
- Thumbnaili se učitavaju direktno sa YouTubea i svaki vodi na originalni video. Ne kopiraj ih u svoje fajlove.
- RPM i skor prilike nisu obećanje zarade, i tako ih predstavi ako sajt objaviš javno.
