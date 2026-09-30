# PayPal-Kontoverknüpfung und Ausgleich

Der Empfänger verbindet sein Konto über „PayPal verbinden“. Anmeldung, Kontoprüfung und Zahlungsoptionen bleiben bei PayPal. ManaWG fragt keine Merchant-ID oder PayPal.me-Adresse ab und speichert keine PayPal-Passwörter.

Der Zahler verwendet „Mit PayPal ausgleichen“. Die vorhandene Orders/Capture-Anbindung verbucht erst den serverseitig bestätigten erfolgreichen Capture. Eine Rückkehr, ein Abbruch oder die Zustimmung im PayPal-Fenster allein begleicht keine Schuld. Manueller Ausgleich bleibt verfügbar.

## Betreiber-Konfiguration

PayPal muss ManaWG als Plattformpartner zulassen; benötigt wird eine Platform REST App. Reines „Log in with PayPal“ verknüpft Identitäten, erteilt aber keine Zahlungsberechtigung für einen Empfänger. Die Verknüpfung verwendet deshalb die offizielle Partner-Referrals-Anbindung.

| Einstellung | Bedeutung |
| --- | --- |
| `PAYPAL_ENV` | `sandbox` für Tests oder `live` für Produktion |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Serverseitiger Zugang der Plattform-App |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Passende öffentliche Client-ID für den Checkout |
| `PAYPAL_PARTNER_ATTRIBUTION_ID` / `NEXT_PUBLIC_PAYPAL_PARTNER_ATTRIBUTION_ID` | Passender PayPal-BN-Code |
| `PAYPAL_PARTNER_MERCHANT_ID` | Händlerkennung des Plattformbetreibers, nicht eines WG-Mitglieds |
| `NEXT_PUBLIC_APP_URL` | Vertrauenswürdiger Ursprung der jeweiligen Umgebung |

Der Rückweg ist `<NEXT_PUBLIC_APP_URL>/api/paypal/return?state=<zufällige Versuchskennung>`. Der WG-Einladungscode verbleibt im signierten HttpOnly-Cookie und wird nicht an PayPal übermittelt. PayPal erhält eine stabile pseudonyme Kundenkennung; jeder Verbindungsversuch hat zusätzlich eine zufällige Kennung. Die Rückkehr prüft diese Kennung und leitet nur weiter; der anschließende authentifizierte Bestätigungsaufruf prüft Provider-Daten und speichert die Kontozuordnung.

PayPal entscheidet, welche Konten und Produkte im jeweiligen Land zugelassen sind. Die aktuelle Länderübersicht führt Deutschland für Casual/Personal Seller bei PayPal Checkout nicht als verfügbar. Die App verspricht deshalb weder Privatkonto-Unterstützung für jedes Land noch Gebührenfreiheit oder eine Freunde-und-Familie-Überweisung. Gegebenenfalls verlangt PayPal weitere Kontoangaben oder ein Geschäftskonto.

## Freischaltung und Nachweis

1. Plattformfreigabe und Platform REST App im PayPal-Entwicklerkonto einrichten. Geheimnisse ausschließlich in den jeweiligen geschützten Umgebungsvariablen hinterlegen, nicht in Git oder Chat.
2. Sandbox-Zugänge nur in Preview/Test verwenden; öffentlichen Client und serverseitige App konsistent konfigurieren. Live-Zugänge nur in Production.
3. Kontoverknüpfung im Sandbox-Browser mit Rückkehr, Abbruch, fehlender Einwilligung und unvollständiger Freigabe prüfen.
4. Sandbox-Zahlung ausführen und den tatsächlichen Capture samt Empfänger, Betrag, Währung und einmaliger Saldoänderung prüfen. Einen zweiten Versuch sowie Abbruch/Fehler ohne Zahlung prüfen.
5. Erst danach die vorhandenen Release-Gates verwenden. Lokale Fixture-Tests ersetzen keinen Provider- oder Produktionsnachweis.

Am 27.09.2026 wurden bei Vercel die Namen der Umgebungsvariablen geprüft: Production und Preview enthielten keine `PAYPAL_*` oder `NEXT_PUBLIC_PAYPAL_*`-Konfiguration. Production hatte `NEXT_PUBLIC_APP_URL`, Preview nicht. Lokale Hauptcheckout-Umgebungsdateien enthielten ebenfalls keine der geprüften PayPal-Zugangsvariablen. Werte wurden nicht abgerufen. Dieser historische Vercel-Befund belegte nur fehlende Host-Variablen; die lokalen Sandbox-Zugangsdaten und Verkäuferfreigabe wurden später separat nachgewiesen (siehe 30.09.2026).

## Historische Betreiber-Prüfung am 28.09.2026

Der bestehende Developer-Zugang kann inzwischen die Sandbox-App-Liste und die vorhandene `Default Application` öffnen. Eine erneute persönliche Anmeldung ist deshalb aktuell nicht der Blocker. Es wurden keine App-Einstellungen gespeichert und keine Schlüsselwerte ausgegeben.

Im geprüften Erstellungsformular ist der Typ `Platform` verfügbar. PayPal gibt dafür den Namen `Platform Partner App` fest vor und erzeugt automatisch ein neues Sandbox-Geschäftskonto. Deutschland steht in der dort angebotenen Regionenliste nicht zur Auswahl. Als konkreter, noch ungesendeter Entwurf wurde `United States` gewählt; dessen späterer Sandbox-Nachweis würde keine Deutschland-/Live-Freigabe ersetzen.

`Create App` erzeugt neue API-Zugangsdaten und bestätigt laut Formular das [PayPal Developer Agreement für US-Konten](https://www.paypal.com/us/webapps/mpp/ua/xdeveloper-full). Diese neue Zugangs-/Vertragsaktion benötigt eine ausdrückliche Betreiberfreigabe. Der Button wurde nicht betätigt. Erst danach lassen sich die tatsächliche Partner-API-Freigabe und ein isolierter Sandbox-Ablauf prüfen; die vorhandene Standard-App wird nicht stillschweigend als geeignete Platform-App behandelt.

## Sandbox-Status am 30.09.2026

Die Sandbox wurde bereits in einer vorherigen Sitzung eingerichtet. Die vorhandenen Plattformzugangsdaten sowie Verkäufer- und Käufer-Testkonten liegen in owner-only Dateien; in dieser Prüfung wurden sie weder ausgegeben noch geändert. Der aktuelle Kandidat `cca08ac6` wurde mit diesen bestehenden Zugangsdaten geprüft: OAuth antwortete mit HTTP 200, der Verkäufer-Readiness-Aufruf mit HTTP 200 und `isPayPalMerchantReady` mit `true`.

Ein älterer Prüf-Wrapper lieferte HTTP 401, weil er die Partner-Händlerkennung als Zielverkäufer übergab. Der Readiness-Aufruf erwartet die Händlerkennung des verbundenen Verkäufers. Die 401 ist daher ein Fehler in diesem Prüfaufruf, kein Nachweis für fehlende Sandbox-Zugänge oder einen Fehler im aktuellen Kandidaten.

Ein separater Return-Label-Probe auf Basis des Sandbox-Worktrees `16ef0b2` beobachtete nach dem Verkäufer-Onboarding keine Rückleitung oder keinen App-Redirect. Die Probe stellte den ursprünglichen Quellstand wieder her und wurde nicht in Production übernommen; sie bestätigt weder die Rückleitung des aktuellen Kandidaten noch die automatische Verkäuferverknüpfung.

Ein neuer Entwickler-Dashboard-Tab führte zwar zur PayPal-Anmeldeseite; das widerlegt die bereits vorhandene Sandbox-Berechtigung nicht. Der Vercel-Namensreadback vom 30.09.2026 zeigte weiterhin keine `PAYPAL_*`- oder `NEXT_PUBLIC_PAYPAL_*`-Variablen in Production oder Preview. Es wurden keine Variablen deployt. Der aktuelle Kandidat erstellte mit bestehenden Sandbox-Zugangsdaten einen Order über EUR 0,01 (Orders API HTTP 201, Status `CREATED`). Käuferfreigabe und Capture sind noch offen; es wurde kein zweiter Order erstellt. Production bleibt ohne PayPal-Konfiguration.

## Offizielle Quellen

- [Empfänger vor einer Zahlung verbinden](https://developer.paypal.com/platforms/seller-onboarding/before-payment)
- [Partner-Referrals-Spezifikation](https://developer.paypal.com/api/partner-referrals/v2/schema.json)
- [Onboarding und Länderunterstützung](https://developer.paypal.com/platforms/seller-onboarding)
- [Plattformfreigabe](https://developer.paypal.com/platforms/get-started)
- [Plattformkonto einrichten](https://developer.paypal.com/platforms/create-account)
