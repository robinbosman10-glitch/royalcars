# Royal Cars — Management Portal

Een Nederlands personeelsportaal en Discord-bot voor Royal Cars, met een rood/zwart autothema, licht/donker-modus en Discord-login.

## Functies

- Dashboard en live ledenlijst, gegroepeerd op de ingestelde Discord-rangen.
- Aannemen, demoten en ontslaan via gecontroleerde rolwijzigingen en een bericht in een zelf gekozen Discord-kanaal.
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

Zonder Discord-configuratie start de website wel; inloggen en personeelsacties blijven uitgeschakeld. Het eerste Discord-account krijgt nooit automatisch beheerdersrechten.

## Discord koppelen

Gebruik de bestaande Royal Cars-applicatie in het [Discord Developer Portal](https://discord.com/developers/applications).

1. Vul de variabelen uit `.env.example` in de hostingomgeving in. Zet het bot-token en de OAuth-clientsecret uitsluitend bij de geheime hostingvariabelen, nooit in GitHub of chat.
2. Registreer bij OAuth2 exact de callback-URL `https://royalcarsadmin.nl/auth/discord/callback`. Lokaal gebruik je `http://localhost:3000/auth/discord/callback`.
3. Zet **Server Members Intent** aan. Schakel **Message Content Intent** in als gekoppelde logkanalen ook berichtinhoud en embeds moeten tonen.
4. Geef de bot **Manage Roles**, **View Channels**, **Read Message History**, **Send Messages** en **Embed Links** in de betreffende kanalen. Plaats zijn hoogste rol boven alle personeelsrollen die hij moet beheren.
5. Stel `OWNER_DISCORD_ID` in op Robins eigen Discord-gebruikers-ID en `DISCORD_GUILD_ID` op de Royal Cars-server-ID.
6. Log als eigenaar in. Koppel de echte rangen en kanaal-ID's onder **Instellingen**, en maak toegestane accounts aan onder **Accounts**.

Een demotie mag uitsluitend naar een lager ingestelde rang. Ontslaan verwijdert de geconfigureerde personeelsrollen; de bot verwijdert geen serverleden. Losse, niet ingestelde Discord-rollen blijven behouden. Het portaal verleent nooit automatisch toegang op basis van alleen een Discord-rolnaam.

## Hosting

De Dockerfile start website en Discord-bot in één proces. Gebruik één replica en een blijvend volume op `/data`; zet `DATA_DIR=/data`. De gezondheidstest is `/healthz`.

Na het koppelen van `royalcarsadmin.nl` moet `APP_URL=https://royalcarsadmin.nl` staan. Tot DNS en Discord zijn ingesteld kan het ontwerpvoorbeeld op de tijdelijke hosting-URL worden bekeken.

## Controle

```sh
npm test
```

De tests gebruiken mocks en sturen geen berichten naar een echte Discord-server.

## Relevante documentatie

- [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Railway custom domains](https://docs.railway.com/networking/domains)


## Beheerrangen en extra Discord-rollen

Onder **Accounts → Beheerrang maken** kies je een naam, kleur, pagina- en actierechten, logbronnen en Discord-ID’s. Gekoppelde accounts nemen de actuele rangrechten over. Verwijderen van een rang trekt de bijbehorende toegang in; het vaste Directie-account blijft beschermd. Bestaande accounts met individuele rechten blijven bruikbaar.

Onder **Personeel → Aannemen** kies je de personeelsrang en extra Discord-rollen. De Directie ziet de rollen die de bot kan beheren. Voor andere bevoegde accounts wordt de selectie beperkt door **Instellingen → Extra rollen bij aanname** en de eigen Discord-rolhiërarchie. Onder **Demoten** kies je de nieuwe, lagere rang.

Beheerrangen regelen toegang tot de website; personeelsrangen zijn gekoppeld aan Discord-rollen. De server bewaart gekozen extra rollen per medewerker, ook na een herstart. De databankmigratie behoudt bestaande accounts, instellingen en activiteiten.
