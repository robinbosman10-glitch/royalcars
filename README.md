# Royal Cars — Management Portal

Een Nederlands personeelsportaal en Discord-bot voor Royal Cars, met een rood/zwart autothema, licht/donker-modus en inloggen met gebruikersnaam en wachtwoord.

## Functies

- Dashboard en live ledenlijst, gegroepeerd op de ingestelde Discord-rangen.
- Aannemen, promoveren, demoten en ontslaan via gecontroleerde rolwijzigingen en een bericht in een zelf gekozen Discord-kanaal.
- Discord-logkanalen koppelen en hun nieuwe berichten op het portaal bekijken.
- Accountbeheer op Discord-ID, met zelf gemaakte beheerrangen, groepsrechten en leden per rang. Alleen de vaste eigenaar kan accounts en rangen beheren.
- Aanname met een gekozen personeelsrang en aanvullende Discord-rollen; bij demotie kies je de lagere doelrang. Extra aanname-rollen blijven bij demotie behouden en worden bij ontslag verwijderd.
- Luxe autofotografie, het Royal Cars Amersfoort-logo en een ledenlijst met profielkaarten per rang.
- Instellingen voor rangen, actiekanalen, extra personeelsrollen en rollen die behouden blijven.
- Blijvende SQLite-opslag voor accounts, instellingen, sessies, activiteiten en uitgevoerde acties.
- Een openbaar, alleen-lezen ontwerpvoorbeeld op `/preview`, met fictieve voorbeeldgegevens.

## Lokaal starten

Gebruik Node.js 24. Kopieer `.env.example` naar `.env`, vul de eigen waarden in en voer uit:

```sh
npm ci
npm start
```

De login werkt zodra het vaste Directie-account en de sessiesleutel zijn ingesteld. Zonder botconfiguratie blijven Discord-acties uitgeschakeld. Een eerste bezoeker krijgt nooit automatisch beheerdersrechten.

## Inloggen en accounts

De website gebruikt gebruikersnaam en wachtwoord. Discord OAuth-login is uitgeschakeld; bestaande Discord-sessies worden niet meer geaccepteerd. Discord-ID’s blijven gekoppeld aan de bot, de ledenlijst en personeelsacties.

- Alleen het vaste account uit `OWNER_DISCORD_ID` kan accounts, inloggegevens en beheerrangen beheren.
- Onder **Accounts** kan de Directie een gebruikersnaam en wachtwoord instellen. Bestaande accounts zonder inloggegevens kunnen pas inloggen nadat die zijn ingesteld.
- Door de Directie ingestelde wachtwoorden werken direct, zonder verplichte wijziging bij de eerste login. Iedere gebruiker kan via het sleutelicoon de eigen inloggegevens wijzigen. Alleen de eerste installatie van het vaste Directie-account vereist een eigen wachtwoord.
- Een wachtwoordwijziging of reset meldt oude sessies af. Wachtwoorden en hashes worden nooit via de API of activiteitenlogs teruggestuurd.
- Wachtwoorden worden opgeslagen met unieke salt en scrypt (`N=32768, r=8, p=3`). Inloggen heeft sessiegebonden CSRF-controle, beperkte inlogpogingen en algemene foutmeldingen.
- Er is geen openbare registratie of openbare wachtwoordreset.

### Eerste Directie-account

Stel `OWNER_LOGIN_USERNAME` en een hash in `OWNER_LOGIN_PASSWORD_HASH` in, naast het vaste `OWNER_DISCORD_ID`. Genereer de hash lokaal met:

```sh
node scripts/hash-password.mjs
```

Het script verbergt de invoer en toont uitsluitend de hash. De eerste start bewaart de login in de persistente databank en verplicht een nieuw wachtwoord. Latere starts overschrijven bestaande inloggegevens niet. Zet nooit een leesbaar wachtwoord in GitHub of hostingvariabelen.

## Discord-bot koppelen

Gebruik de bestaande Royal Cars-applicatie in het [Discord Developer Portal](https://discord.com/developers/applications).

1. Stel `DISCORD_TOKEN` en `DISCORD_GUILD_ID` in de hostingomgeving in. De website heeft geen Discord Client ID, clientsecret of OAuth-redirect nodig.
2. Zet **Server Members Intent** aan. Schakel **Message Content Intent** in voor berichtinhoud en embeds uit gekoppelde logkanalen.
3. Geef de bot **Manage Roles**, **View Channels**, **Read Message History**, **Send Messages** en **Embed Links** in de betreffende kanalen. Plaats zijn hoogste rol boven de personeelsrollen die hij moet beheren.
4. Log in op de website en koppel de echte rangen en kanaal-ID’s onder **Instellingen**.

Een promotie mag uitsluitend naar een hoger ingestelde rang en een demotie naar een lagere rang. Koppel bij **Instellingen** het Discord-kanaal voor promoties. Ontslaan verwijdert de geconfigureerde personeelsrollen; de bot verwijdert geen serverleden. Losse, niet ingestelde Discord-rollen blijven behouden. Het portaal verleent nooit automatisch toegang op basis van alleen een Discord-rolnaam.

### Live ledenlijst in Discord

Voer `/ledenlijst` uit in het Discord-kanaal waar het overzicht moet staan. Het vaste Directie-account en leden met **Server beheren** kunnen de lijst plaatsen. De bot werkt hetzelfde bericht bij bij wijzigingen aan leden, rollen of de rangvolgorde in het portaal. De lijst gebruikt de gekoppelde rangen en volgorde van de website, van hoog naar laag.

Het bericht toont Discord-tags voor medewerkers en rangen zonder meldingen te versturen. Gebruik het commando opnieuw om het bestaande bericht te verversen. Wil je de lijst verplaatsen, verwijder dan eerst het oude bericht en voer het commando uit in het nieuwe kanaal. Bij een grote lijst geeft het bericht aan hoeveel medewerkers zichtbaar zijn.

## Hosting

De Dockerfile start website en Discord-bot in één proces. Gebruik één replica en een blijvend volume op `/data`; zet `DATA_DIR=/data`. De gezondheidstest is `/healthz`.

Na het koppelen van `royalcarsadmin.nl` moet `APP_URL=https://royalcarsadmin.nl` staan. Tot DNS en Discord zijn ingesteld kan het ontwerpvoorbeeld op de tijdelijke hosting-URL worden bekeken.

## Controle

```sh
npm test
```

De tests gebruiken mocks en sturen geen berichten naar een echte Discord-server.

## Relevante documentatie

- [Wachtwoordopslag (OWASP)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Railway custom domains](https://docs.railway.com/networking/domains)


## Beheerrangen en extra Discord-rollen

Onder **Accounts → Beheerrang maken** kies je een naam, kleur, pagina- en actierechten, logbronnen en Discord-ID’s. Gekoppelde accounts nemen de actuele rangrechten over. Verwijderen van een rang trekt de bijbehorende toegang in; het vaste Directie-account blijft beschermd. Bestaande accounts met individuele rechten blijven bruikbaar.

Onder **Personeel → Aannemen** kies je de personeelsrang en extra Discord-rollen. De Directie ziet de rollen die de bot kan beheren. Voor andere bevoegde accounts wordt de selectie beperkt door **Instellingen → Extra rollen bij aanname** en de eigen Discord-rolhiërarchie. Onder **Demoten** kies je de nieuwe, lagere rang.

Beheerrangen regelen toegang tot de website; personeelsrangen zijn gekoppeld aan Discord-rollen. De server bewaart gekozen extra rollen per medewerker, ook na een herstart. De databankmigratie behoudt bestaande accounts, instellingen en activiteiten.
