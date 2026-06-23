# Project Spec: Couch Multiplayer Game Platform

Arbeitsname: **Couch Games**  
Status: aus Signal-Sprachnachrichten verdichtete Produkt- und Umsetzungsspezifikation  
Datum: 2026-06-13

## 1. Produktidee

Couch Games ist eine browser- und TV-basierte Multiplayer-Plattform für kurze gemeinsame Spiele im selben Raum. Ein großer Bildschirm zeigt die Lobby und das laufende Spiel; die Handys der Spieler werden durch Scannen eines QR-Codes zu Controllern.

Das Produkt soll sich wie eine digitale Alternative zu Gesellschafts-, Karten- oder Partyspielen anfühlen: Menschen sitzen gemeinsam auf dem Sofa, öffnen eine Lobby auf Fernseher, Laptop oder Beamer, scannen mit ihren Handys einen QR-Code und können sofort spielen.

## 2. Kernprinzipien

- Spiele laufen nicht primär auf dem Handy. Das Handy ist immer Controller.
- Der große Bildschirm ist die gemeinsame Spieloberfläche.
- Einstieg erfolgt ohne Account-Zwang über QR-Code oder teilbaren Link.
- Jede Lobby hat eine eindeutige URL.
- Die Plattform enthält ausschließlich Multiplayer-Spiele.
- Spiele sollen kurz, niedrigschwellig und sofort verständlich sein.
- Die Plattform soll später auch AI-/Vibe-Coding-Spiele aufnehmen können.

## 3. Zielgruppen

Primär:
- Freundesgruppen auf dem Sofa
- Paare, WGs, Familien, kleine Partys
- Menschen, die spontan ein digitales Partyspiel spielen wollen, ohne App-Setup und Controller

Sekundär:
- Remote-Freunde, die jeweils einen Laptop/Screen nutzen und mit dem Handy steuern
- Entwickler oder Creator, die kleine Multiplayer-Spiele einreichen
- AI-/Vibe-Coding-Nutzer, die schnell neue Couch-Games erstellen wollen

## 4. MVP-Ziele

Der MVP muss zeigen, dass das zentrale Spielgefühl funktioniert:

1. Nutzer öffnet Website auf großem Bildschirm.
2. Nutzer erstellt eine Lobby.
3. Plattform zeigt einen QR-Code und einen teilbaren Link.
4. Weitere Spieler scannen den QR-Code und treten der Lobby bei.
5. Jeder Spieler sieht auf dem Handy einen Controller.
6. Host wählt ein Spiel aus.
7. Spiel startet manuell durch Host oder automatisch bei voller Spielerzahl.
8. Spieler steuern das gemeinsame Spiel per Handy.

## 5. Nicht-Ziele für MVP

- Kein vollständiger App-Store für externe Games.
- Kein Login-System.
- Keine komplexe Persistenz von Spielerprofilen.
- Keine native TV-App im ersten Schritt, sofern Browser/Laptop gut funktioniert.
- Kein vollwertiger AI-Game-Builder im MVP.
- Keine allgemeine Mobile-Game-Plattform, bei der jeder auf seinem Handy spielt.

## 6. Plattform-Oberfläche

### 6.1 Startbildschirm

Beim Öffnen der Plattform sieht der Nutzer sofort:

- Button: Neue Lobby erstellen
- Eingabe oder Auswahl: Bestehender Lobby beitreten
- Liste zuletzt/gebookmarkter Lobbys aus lokalem Browser-Speicher
- Spielkatalog/Homescreen mit verfügbaren Multiplayer-Spielen

Es soll kein schwerer Onboarding-Flow davor liegen.

### 6.2 Lobby-Erstellung

Wenn ein Nutzer eine Lobby erstellt:

- System erzeugt eindeutige Lobby-ID und URL.
- Modal zeigt QR-Code.
- Modal bietet Share-Button für URL.
- Lobby erhält einen einfachen, merkbaren Anzeigenamen.
- Erster beitretender Spieler wird automatisch Host.

### 6.3 Lobby-Ansicht

Die Lobby ist kein eigener schwerer Bereich, sondern eher ein Overlay/Status rund um den Spiele-Homescreen:

- Oben: Lobbyname, Spielerzahl, Host-Indikator
- Mitte: Spielkatalog oder laufendes Spiel
- Unten/seitlich: kleine Chatbox oder Aktivitätsfeed
- QR-/Share-Funktion bleibt erreichbar

## 7. Spielerbeitritt

Spieler treten grundsätzlich über QR-Code oder denselben Link bei.

Flow:

1. Spieler scannt QR-Code mit Handy.
2. Handy öffnet Controller-Web-App oder native Controller-App.
3. Spieler gibt optional Anzeigenamen ein.
4. Spieler erscheint in Lobby.
5. Controller bleibt mit Lobby und späterem Spiel verbunden.

Wenn der Link remote geteilt wird, kann er zunächst wieder einen QR-Code anzeigen, damit das Handy als Controller gekoppelt werden kann.

## 8. Host-Regeln

- Der erste beitretende Spieler wird Host.
- Host kann ein Spiel auswählen.
- Host kann das Spiel starten, sobald Mindestspielerzahl erreicht ist.
- Wenn die Maximalspielerzahl des gewählten Spiels erreicht ist, startet das Spiel automatisch.
- Host-Funktionalität bleibt minimal: auswählen, starten, eventuell Spiel zurücksetzen.

Offene Designfrage:
- Was passiert, wenn der Host disconnectet? Vorschlag: nächster beigetretener Spieler wird Host.

## 9. Controller-Konzept

Das Handy ist immer Controller, nie primäre Spielanzeige.

Controller-Anforderungen:

- Läuft mindestens als mobile Web-App.
- Später optional native iOS-/Android-App.
- Verbindet sich per Lobby-Token.
- Zeigt spielabhängige Eingabeelemente.
- Verhindert Zoom-/Scroll-Probleme.
- Bleibt bei Display-Sleep möglichst stabil.

Controller-Modi:

- MVP: universeller Controller im PlayStation-Stil
  - D-Pad oder Joystick
  - A/B/X/Y oder 2-4 Aktionsbuttons
  - Start/Back optional
- Später: Spiel-spezifische Controller-Layouts
  - Joystick
  - Pfeiltasten
  - Reaktionsbutton
  - Karten-/Auswahlhand
  - Slider, Drehregler, Textinput

## 10. Screen-/TV-Konzept

Priorität:

1. Browser-Version für Laptop/Desktop/Beamer
2. Browser auf Smart-TV, sofern praktikabel
3. Native Android-TV-App
4. Weitere TV-Plattformen nach Validierung

Grundannahme:
Das Produkt wird für physisches Zusammenspielen am großen Bildschirm geframed. Remote-Spiel bleibt möglich, aber nicht der primäre Pitch.

## 11. Game-Katalog

Die Plattform zeigt nur Multiplayer-Spiele.

Jedes Spiel definiert:

- Titel
- Beschreibung
- Mindestspielerzahl
- Maximalspielerzahl
- Controller-Layout
- Spiel-Entry-Point
- unterstützte Bildschirmseitenverhältnisse
- geschätzte Rundendauer
- Status: intern, eingereicht, veröffentlicht

Für den MVP reichen 1-3 eigene Spiele, damit Plattform und Controller-Paradigma validiert werden.

## 12. Game-Runtime

Spiele laufen als eingebettete Apps innerhalb der Plattform.

MVP-Architektur:

- Shell-App verwaltet Lobby, Spieler, Verbindungen und Spielauswahl.
- Game-App bekommt eine Runtime-API.
- Controller sendet Input-Events an Lobby/Game-Server.
- Game-App rendert auf dem großen Bildschirm.
- Game-State liegt serverseitig oder in einer autoritativen Game-Session.

Runtime-API, erste Skizze:

~~~ts
type Player = {
  id: string;
  name: string;
  joinedAt: string;
  isHost: boolean;
};

type GameManifest = {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  controllerLayout: ControllerLayout;
};

type ControllerEvent = {
  playerId: string;
  type: "button" | "axis" | "text" | "gesture";
  control: string;
  value: unknown;
  timestamp: number;
};
~~~

## 13. Lobby- und Verbindungsarchitektur

Empfohlener MVP:

- Web-App mit Echtzeitkanal über WebSocket.
- Lobby-Server hält temporären State.
- Lobby-IDs sind kurzlebig und zufällig.
- Clients reconnecten über Lobby-ID und Player-Token.
- Keine Accounts notwendig.

Datenobjekte:

- Lobby
- Player
- Device
- GameSession
- GameManifest
- ControllerLayout
- ChatMessage

## 14. Datenmodell

~~~ts
type Lobby = {
  id: string;
  slug: string;
  name: string;
  hostPlayerId: string | null;
  createdAt: string;
  expiresAt: string;
  currentGameId: string | null;
  state: "waiting" | "playing" | "ended";
};

type Device = {
  id: string;
  playerId: string;
  lobbyId: string;
  role: "controller" | "screen";
  connectedAt: string;
  lastSeenAt: string;
};

type GameSession = {
  id: string;
  lobbyId: string;
  gameId: string;
  state: "ready" | "running" | "finished";
  startedAt: string | null;
  endedAt: string | null;
};
~~~

## 15. Wichtige User Stories

### US-01: Neue Lobby erstellen

Als Nutzer möchte ich auf dem großen Bildschirm eine neue Lobby erstellen, damit meine Freunde schnell beitreten können.

Akzeptanzkriterien:
- QR-Code wird angezeigt.
- Link kann geteilt werden.
- Lobby ist ohne Account nutzbar.
- Erster Spieler wird Host.

### US-02: Per Handy beitreten

Als Spieler möchte ich den QR-Code scannen und sofort als Controller verbunden sein.

Akzeptanzkriterien:
- Handy zeigt Controller.
- Spieler erscheint auf dem großen Bildschirm.
- Verbindung bleibt beim Spielstart bestehen.

### US-03: Spiel starten

Als Host möchte ich ein Spiel auswählen und starten.

Akzeptanzkriterien:
- Nur spielbare Games sind startbar, wenn Mindestspielerzahl erreicht ist.
- Bei Maximalspielerzahl startet das Spiel automatisch.
- Controller-Layout wird passend geladen.

### US-04: Remote-Link

Als Nutzer möchte ich einen Lobby-Link verschicken, damit jemand remote beitreten kann.

Akzeptanzkriterien:
- Link öffnet eine Beitrittsseite.
- Beitrittsseite kann erneut QR-Code zeigen.
- Handy bleibt Controller.
- Spiel läuft weiterhin auf einem größeren Screen.

## 16. AI-/Vibe-Coding-Erweiterung

Später kann die Plattform erlauben, direkt aus der Lobby heraus neue Spiele zu erstellen.

Vision:
- Freunde sitzen auf dem Sofa.
- Sie beschreiben ein Spiel in natürlicher Sprache.
- System generiert ein spielbares Couch-Game.
- Presets helfen bei Genres und Engines.

Mögliche Presets:
- Reaktionsspiel
- Quiz
- Jump'n'Run
- Arena/Duell
- Zeichnen/Raten
- Rhythmusspiel
- Kartenspiel-Variante

Für den Anfang sollte diese Funktion nur als separater Experiment-Bereich gedacht werden, nicht als MVP-Abhängigkeit.

## 17. Technische Empfehlung für MVP

Frontend:
- Web-App für Screen und Controller
- Responsive, aber getrennte Rollen: Screen View und Controller View

Backend:
- Node/TypeScript Realtime-Server
- WebSocket oder Socket.IO
- Temporäre Lobby-State-Persistenz

Game Runtime:
- JavaScript/TypeScript Games
- Manifest pro Game
- Event-basierte Controller-Eingaben

Hosting:
- Web-first
- Später Packaging für TV-Plattformen prüfen

## 18. MVP-Schnitt

Phase 1:
- Lobby erstellen und beitreten
- QR-Code und Share-Link
- Spielerlisten
- Controller-Verbindung
- Dummy-Game mit Button-Input

Phase 2:
- Erstes echtes Partyspiel
- Host-Start und Auto-Start
- Controller-Layout-Konfiguration
- Reconnect

Phase 3:
- Game-Katalog
- 2-3 weitere Spiele
- Remote-Join polish
- Basis-Chat oder Aktivitätsfeed

Phase 4:
- Spiel-Einreichung oder AI-Game-Prototyping
- TV-App-Strategie

## 19. Offene Fragen

- Soll der Controller im MVP nur Web sein oder sofort als native App vorbereitet werden?
- Welche TV-Plattform ist zuerst relevant: Browser, Android TV, Apple TV, Fire TV?
- Wie lange leben Lobbys?
- Braucht der Chat im MVP echte Nachrichten oder reicht ein Aktivitätsfeed?
- Welche 1-3 Spiele eignen sich am besten als Proof of Concept?
- Wie wird ein externer Game-Submit technisch und sicher isoliert?
- Wie stark soll Remote-Spiel im ersten Pitch sichtbar sein?
- Arbeitsname: eher Sofa/Couch-Marke oder neutraler Game-Plattform-Name?

## 20. Erste Umsetzungsempfehlung

Nicht mit TV-App oder AI-Game-Builder anfangen. Der schnellste überzeugende Prototyp ist:

1. Screen-Web-App mit Lobby und QR-Code.
2. Mobile Controller-Web-App.
3. WebSocket-Lobby-Server.
4. Ein simples Echtzeitspiel, das ohne Erklärung funktioniert.
5. Danach erst Game-Katalog und Controller-Layout-System abstrahieren.

Wenn dieser Kern Spaß macht, tragen die späteren Ideen: TV-Packaging, Game-Submission und Vibe-Coding direkt auf dem Sofa.

## 21. Technische Spezifikation

Dieser Abschnitt konsolidiert und vertieft die über das Dokument verteilten technischen Notizen (insbesondere §12 Game-Runtime, §13 Lobby-/Verbindungsarchitektur, §14 Datenmodell und §17 Technische Empfehlung) zu einer zusammenhängenden Engineering-Spezifikation für den MVP. Er erweitert die dort skizzierten Typen, statt sie neu zu erfinden, und hält die Nicht-Ziele aus §5 ein (keine Accounts, keine native TV-App zuerst, kein vollwertiger AI-Game-Builder im MVP). Querverweise der Form „21.x" beziehen sich auf die Unterabschnitte dieses Kapitels.

Hinweis zu noch offenen Typdefinitionen: Die in §13 als Datenobjekte genannten `ControllerLayout` und `ChatMessage` sind im bisherigen Datenmodell (§12/§14) noch nicht als TypeScript-Typen ausgeführt. Sie werden in diesem Abschnitt referenziert (u. a. von `GameManifest.controllerLayout`) und sollten vor Umsetzung der jeweiligen Phase konkret typisiert und ins geteilte Types-Paket aufgenommen werden.

### 21.1 Systemüberblick & Architektur-Topologie

Die Plattform besteht aus vier logischen Komponenten, die über einen einzigen Echtzeitkanal (WebSocket via Socket.IO, vgl. §13/§17) kommunizieren. Der Realtime-/Lobby-Server ist die einzige Quelle der Wahrheit für Lobby- und Verbindungs-State; alle Clients sind dumme Views bzw. Eingabegeräte.

- **Screen-Client** (Browser auf Laptop/Beamer/Smart-TV, vgl. §10): rendert Lobby-Overlay und laufendes Spiel. Verbindet sich als `Device` mit `role: "screen"` (§14). Sendet keine Lobby-Wahrheit, sondern empfängt Render-/State-Snapshots.
- **Controller-Client** (mobile Web-App, vgl. §9): pro Spieler ein `Device` mit `role: "controller"`. Erzeugt aus Tastendrücken `ControllerEvent`-Objekte (§12) und sendet sie an den Server. Hält keinen autoritativen State.
- **Realtime-/Lobby-Server** (Node/TypeScript, §17): hält `Lobby`, `Device`, `GameSession` (§14) sowie `Player` (§12) im Speicher, verwaltet Beitritt/Reconnect über Lobby-ID + Player-Token (§13), wählt anhand `GameManifest` (§12) Spiele aus und broadcastet State-Updates an alle Geräte einer Lobby (Socket.IO-Room je `lobbyId`).
- **Game-Runtime-Host**: führt pro `GameSession` die autoritative Spiellogik. Konsumiert validierte `ControllerEvent`s, berechnet den nächsten State und gibt Snapshots an den Server zurück, der sie an die Screen-Clients verteilt.

**Autoritatives Modell (MVP-Entscheidung):** §12 lässt offen, ob der Game-State serverseitig oder in einer autoritativen Game-Session liegt. Für den MVP wird bewusst das serverseitig-autoritative Modell gewählt: Eingaben fließen Controller → Server → Game-Runtime, State fließt Game-Runtime → Server → Screen. Clients vertrauen ausschließlich den Server-Snapshots; lokale Vorhersage (Client-Prediction) ist im MVP nicht vorgesehen. Das hält Cheating und Desync minimal, und Reconnect bedeutet nur das Nachladen des aktuellen Snapshots. Der Preis ist die volle Round-Trip-Latenz pro Eingabe; das zugehörige Latenzbudget definiert 21.11. Reaktionsspiele, die eine spürbar geringere Latenz brauchen, können später auf eine autoritative clientseitige Game-Session auf dem Screen umgestellt werden, ohne die übrigen Komponenten zu ändern.

**Datenfluss QR/Join → Lobby → Spielauswahl → Spiel:**

~~~text
[Handy] --scan QR--> /lobby/:slug  --WS join(token)-->  +----------------------+
                                                        |  Realtime-/Lobby-    |
[Screen] --create lobby-----------WS--------------------|  Server (autoritativ)|
   ^   |                                                |  Lobby/Player/Device |
   |   | broadcast: playerJoined / lobbyState           |  GameSession         |
   |   +<-----------------------------------------------|                      |
   |                                                    +----------+-----------+
   | stateSnapshot                  ControllerEvent (§12)          | drives
   |                                from Controller-Client         v
   +<---------- broadcast -------------------------------- [Game-Runtime-Host]
~~~

Ablauf: (1) Screen erstellt Lobby, Server vergibt `id`/`slug` und zeigt QR-Code (§6.2). (2) Handys scannen, treten dem Room bei, erscheinen als `Player`; der erste beitretende Spieler wird Host (§8). (3) Host wählt aus dem Katalog ein `GameManifest`; Server legt eine `GameSession` (`state: "ready"`) an. (4) Host-Start oder Auto-Start bei Maximalspielerzahl setzt `Lobby.state` auf `playing` und `GameSession.state` auf `running`, der Game-Runtime-Host startet die Loop. Es gibt bewusst kein Account-/Login-System und keine native TV-App (vgl. §5); native Controller- und TV-Pakete sind Post-MVP-Optionen.

### 21.2 Technologie-Stack & Begründung

Der MVP-Stack folgt den Vorgaben aus §17: Node/TypeScript-Server, WebSocket-basiertes Realtime-Protokoll, web-first. Alle Schichten sind auf minimale Komplexität ausgelegt; spätere Optionen ersetzen oder erweitern einzelne Teile, ohne die Gesamtarchitektur zu kippen.

| Schicht | Wahl | Begründung | Spätere Option |
|---|---|---|---|
| Frontend-Framework | React 19 + TypeScript | Weit verbreitet, großes Ökosystem, einfache Komponentenaufteilung in Screen View und Controller View; leichtgewichtiges Client-Routing genügt (keine SSR-Routing-Komplexität) | SvelteKit, falls SSR für Lobby-URLs relevant wird |
| Build-Tool | Vite | Schnelle HMR, native ESM, minimale Konfiguration; passt zu React und zu einem Monorepo mit mehreren Packages | unverändert |
| Realtime | Socket.IO auf Node.js/TypeScript | Abstrahiert WebSocket-Fallbacks, bietet Rooms (je Lobby eine Room), automatisches Reconnect und Event-Namespacing für `ControllerEvent`-, `Lobby`- und `GameSession`-Updates | natives WebSocket oder uWebSockets.js, wenn Skalierung relevant wird |
| Shared-Types-Paket | `@couch/types` (internes pnpm-Workspace-Package) | Einzige Quelle für `Player`, `GameManifest`, `ControllerEvent`, `ControllerLayout`, `Lobby`, `Device`, `GameSession` (§12/§14, plus die noch zu typisierenden Objekte aus §13); verhindert Typendrift zwischen Client und Server | unverändert; ggf. Zod für Runtime-Validierung ergänzen |
| Monorepo-Tooling | pnpm Workspaces | Einfaches Workspace-Setup ohne eigenes Build-Graph-Tool; löst interne Abhängigkeiten (`@couch/types`, `@couch/server`, `@couch/client`) ohne Overhead | Turborepo als optionaler Build-Cache-Layer |
| QR-Erzeugung | `qrcode` (npm, clientseitig) | Kleine Bibliothek, erzeugt QR-Code aus Lobby-URL direkt im Browser; kein Serveraufruf notwendig | unverändert |
| In-Memory-State | Node.js `Map` im Server-Prozess | Ausreichend für MVP; Lobbys sind kurzlebig (vgl. §13), kein Persistenz-Bedarf im ersten Schnitt | Redis für Multi-Instance-Deployments oder Lobby-Persistenz (Post-MVP) |
| Styling | Tailwind CSS | Utility-first, kein eigener CSS-Datei-Wildwuchs, gut geeignet für responsive Screen- und Controller-Layouts | unverändert |

**Monorepo-Struktur (Skizze)**

~~~text
apps/
  client/       # React + Vite: Screen View & Controller View
  server/       # Node/TypeScript + Socket.IO: Lobby-Server
packages/
  types/        # @couch/types: geteilte Typen aus §12/§14 (+ §13)
~~~

**Begründung der Abgrenzung**

- Kein serverseitiges Rendering im MVP: Screen View und Controller View sind reine SPAs; Lobby-URLs werden clientseitig aufgelöst. Das reduziert Deploy-Komplexität.
- Kein eigener Auth-Layer: konsistent mit §5 (kein Login-System). Identität läuft über kurzlebige Player-/Device-Tokens im Lobby-State (siehe 21.8).
- Redis als explizite Post-MVP-Option: Im MVP genügt ein einzelner Node-Prozess mit In-Memory-State. Redis wird erst relevant, wenn horizontal skaliert oder Lobby-State über Neustarts hinweg persistiert werden soll.
- `@couch/types` als Monorepo-Package stellt sicher, dass `ControllerEvent`, `Lobby`, `Device` und `GameSession` nur einmal definiert und von Client und Server gleichermaßen importiert werden.

### 21.3 Echtzeit-Protokoll & Nachrichtenverträge (WebSocket)

Die Echtzeitkommunikation läuft über einen WebSocket-Kanal (Socket.IO als MVP-Default, da Heartbeat, Reconnect und Raum-Konzept bereits enthalten sind). Jede Nachricht ist ein einheitliches Envelope; die fachliche Last steckt in `payload`. Socket.IO-Rooms entsprechen `lobbyId`; das Broadcasting erfolgt nur an die Mitglieder einer Lobby.

Nachrichtenkategorien (`category`):
- `lobby`: Beitritt, Verlassen, Hostwechsel, Lobby-State (siehe §14 `Lobby`).
- `player`: Spielerliste, Namensänderung (siehe §12 `Player`).
- `game`: Spielauswahl, Start/Stop, Game-State-Snapshots (siehe §14 `GameSession`).
- `controller`: Input-Events vom Handy (transportiert §12 `ControllerEvent`).
- `system`: Handshake, Reconnect, Heartbeat, Fehler.

Handshake: Beim Verbinden sendet der Client `system/join` mit `lobbyId`, optionalem Anzeigenamen und `role` (`controller` | `screen`, siehe §14 `Device`). Der Server validiert die Lobby, legt bzw. aktualisiert `Player` und `Device` an und antwortet mit `system/joined` inklusive `playerId` und einem signierten `reconnectToken` (kurzlebig, HMAC, kein Account nötig — §5/§13). Danach pusht der Server den aktuellen `lobby`- und `player`-State.

Reconnect: Nach Verbindungsabbruch sendet der Client `system/reconnect` mit `lobbyId` und `reconnectToken`. Der Server prüft Token und Ablauf, verknüpft die neue Verbindung mit dem bestehenden `playerId`/`Device` und aktualisiert `lastSeenAt` (§14). Schlägt die Prüfung fehl, fällt der Client auf einen frischen `join` zurück. Die Lebensdauer des `reconnectToken` ist an `Lobby.expiresAt` gebunden (siehe 21.4); das Verhalten bei dauerhaftem Host-Verlust folgt der Host-Neuzuweisung aus §8 (offene Frage §19), umgesetzt in 21.4.

Heartbeat: Der Socket.IO-Ping/Pong hält die Verbindung warm und aktualisiert serverseitig `lastSeenAt`; bleibt der Pong aus, gilt das `Device` als getrennt.

Autoritätsmodell: Der Server ist autoritativ. Controller senden ausschließlich `controller/input`; der Server validiert (richtige Lobby, laufende `GameSession`, gültiger Spieler) und broadcastet den abgeleiteten State per `game/state`. Clients rendern nur, sie berechnen keinen verbindlichen State.

**Feldhoheit:** Bei Konflikten ist das Envelope autoritativ. `Envelope.senderId` und `Envelope.ts` gelten; die in `ControllerEvent` (§12) ebenfalls enthaltenen Felder `playerId` und `timestamp` werden serverseitig ignoriert bzw. aus der Socket-Session überschrieben (siehe auch 21.8). Ebenso ist bei doppeltem `lobbyId` (Envelope und Payload) der Envelope-Wert maßgeblich; das Payload-`lobbyId` dient nur der Selbstbeschreibung.

~~~ts
type MessageCategory = "lobby" | "player" | "game" | "controller" | "system";

type Envelope<T = unknown> = {
  v: 1;                       // Protokollversion
  category: MessageCategory;
  type: string;              // z. B. "join", "input", "state", "error"
  lobbyId: string;           // Ziel-Room (§14 Lobby.id), autoritativ
  senderId: string | null;   // Player.id (§12), null vor dem Join
  payload: T;
  ts: number;                // Zeitstempel (ms)
};

type JoinPayload = {
  lobbyId: string;
  name?: string;
  role: "controller" | "screen";   // §14 Device.role
};

type JoinedPayload = {
  playerId: string;                // §12 Player.id
  reconnectToken: string;          // kurzlebig, serverseitig signiert
};

type ReconnectPayload = {
  lobbyId: string;
  reconnectToken: string;
};

// transportiert §12 ControllerEvent; Envelope-Felder sind autoritativ
type ControllerInput = Envelope<ControllerEvent> & {
  category: "controller";
  type: "input";
};

// autoritativer State-Broadcast je GameSession (§14)
type GameStatePayload = {
  sessionId: string;
  state: "ready" | "running" | "finished";
  snapshot: unknown;               // game-spezifisch
};

// Fehler: category "system", type "error"
type ErrorEnvelope = Envelope<ErrorPayload> & {
  category: "system";
  type: "error";
};

type ErrorPayload = {
  code: "lobby_not_found" | "invalid_token" | "not_allowed" | "bad_request";
  message: string;
};
~~~

Nicht-Ziele bleiben gewahrt: keine Accounts, nur Token; State ist temporär (§13). Spielspezifische Controller-Layouts und native Apps sind über die offene `payload`-Struktur später/Post-MVP möglich, ohne das Envelope zu brechen (`v` erlaubt Versionierung).

### 21.4 Datenmodell, State-Management & Lobby-Lebenszyklus

#### Autoritativer In-Memory-Store

Der Server hält den gesamten Lobby-State in einem einzelnen, prozesslokalen `Map<string, LobbyEntry>`-Store, der per `lobbyId` schlüsselt. Eine externe Persistenzschicht (Redis, Datenbank) ist im MVP nicht vorgesehen; ein Neustart des Servers invalidiert alle laufenden Lobbys. Für spätere Skalierung kann der Store durch eine Redis-Adapter-Schicht ersetzt werden, ohne die API-Oberfläche zu ändern.

~~~ts
type LobbyEntry = {
  lobby: Lobby;
  players: Map<string, Player>;
  devices: Map<string, Device>;
  session: GameSession | null;
};

// Erweiterter Player-Typ aus §12 – Zusatzfelder optional, daher
// bleiben bestehende §12-Konstruktionsstellen typkompatibel.
type Player = {
  id: string;
  name: string;
  joinedAt: string;
  isHost: boolean;
  // Reconnect-Verwaltung (server-intern):
  socketId?: string | null;        // null = aktuell getrennt
  disconnectedAt?: string | null;  // ISO-Timestamp des letzten Disconnect
  reconnectToken?: string;         // server-only, nie an andere Clients gespielt
};
~~~

Die Typen `Lobby` und `Device` aus §14 bleiben unverändert. `GameSession` wird ebenfalls aus §14 übernommen.

#### Lobby-Lebenszyklus

Eine Lobby durchläuft drei Zustände, die dem `state`-Feld in `Lobby` entsprechen. Der Server ist der einzige Schreiber von `Lobby.state` und koppelt die Übergänge an `GameSession.state`: Start setzt `waiting → playing` (und `GameSession.state → running`), Spielende setzt `GameSession.state → finished` und in der Folge `playing → ended`.

| Zustand   | Beschreibung                                            | Eintritt                                      | Austritt                              |
|-----------|---------------------------------------------------------|-----------------------------------------------|---------------------------------------|
| `waiting` | Lobby offen, Spieler treten bei, Spielauswahl möglich  | Lobby-Erstellung                              | Host startet Spiel / Auto-Start       |
| `playing` | Spiel läuft, `GameSession.state = "running"`           | `GameSession` wird gestartet                  | Spiel endet / Host bricht ab          |
| `ended`   | Runde beendet, Ergebnisanzeige möglich                 | `GameSession.state` wechselt auf `"finished"` | TTL abgelaufen oder Lobby-Reset       |

Nach `ended` kann die Lobby durch einen expliziten Reset (Host-Aktion) zurück in `waiting` wechseln, sofern die TTL noch nicht abgelaufen ist.

#### TTL und Expiry

Jede Lobby erhält beim Anlegen `createdAt` (ISO-Timestamp) und `expiresAt` (= `createdAt + TTL`). Die Standard-TTL beträgt **4 Stunden**. Ein serverseitiger Intervall-Job (`setInterval`, alle 60 Sekunden) entfernt Lobbys, bei denen `Date.parse(expiresAt) < Date.now()` und `state !== "playing"` gilt. Laufende Lobbys (`playing`) werden erst nach einer Kulanzzeit von 30 Minuten über die TTL hinaus abgeräumt.

#### Reconnect-Grace-Period

Verliert ein Spieler seine WebSocket-Verbindung, wird `Player.socketId` auf `null` und `Player.disconnectedAt` auf den aktuellen Timestamp gesetzt. Innerhalb von **30 Sekunden** (konfigurierbar) kann der Client die Verbindung über Lobby-ID und `reconnectToken` wiederherstellen. Der Server gleicht das Token serverseitig ab und reassoziiert den bestehenden `Player`-Eintrag mit der neuen Socket-Verbindung. Kehrt ein Spieler erst nach Ablauf der Grace-Period zurück, erhält er einen neuen `Player`-Eintrag (neue `id`); war er zuvor Host, ist die Host-Rolle dann bereits weitergereicht und kehrt nicht automatisch zu ihm zurück.

#### Host-Neuzuweisung

Die offene Designfrage aus §8 wird wie folgt aufgelöst: Disconnectet der aktuelle Host und läuft die Grace-Period ab, ohne dass er zurückkehrt, übernimmt der **nächste Spieler in Beitrittsreihenfolge** (`joinedAt` aufsteigend, unter verbundenen Spielern) die Host-Rolle. Der Server setzt `lobby.hostPlayerId` auf dessen `id` und sendet ein `host:changed`-Event an alle verbundenen Clients. Gibt es keinen weiteren Spieler, verbleibt `hostPlayerId` auf `null`; die Lobby geht nicht automatisch in `ended` über, solange die TTL noch läuft.

#### Abgrenzung Post-MVP

Persistente Spielerprofile, account-gebundene Lobby-Historien oder datenbankseitige Lobby-Sicherung sind explizit **kein MVP-Ziel** (vgl. §5). Der In-Memory-Ansatz ist bewusst einfach gehalten, um den Kern des Spielgefühls ohne Infrastruktur-Overhead zu validieren.

### 21.5 Game-Runtime-API & Game-SDK (Einbettung/Sandbox)

Spiele laufen gemäß §12 als eingebettete Apps innerhalb der Screen-Shell. Im MVP umfasst der Katalog ausschließlich eigene, intern gebaute Spiele (§11), die die Shell selbst ausliefert.

**Einbettungsmodell.** Jedes Spiel läuft im Screen-View in einem `<iframe sandbox="allow-scripts">` ohne `allow-same-origin`, geladen von einer separaten Origin (z. B. `games.couch.gg`). Das Spiel hat dadurch keinen Zugriff auf Cookies, Lobby-State oder DOM der Shell. Die gesamte Kommunikation läuft über `window.postMessage` mit strenger `targetOrigin`- und `event.origin`-Prüfung. Das Spiel öffnet selbst keine WebSocket-Verbindung; Controller-Input wird vom Shell-/Lobby-Server (§13/§17) entgegengenommen und als bereits validierte `ControllerEvent`s (§12) an das iframe weitergereicht. So bleibt die autoritative `GameSession` (§14) serverseitig.

**Erweitertes GameManifest.** Aufbauend auf §11/§12 ohne Bruch bestehender Felder:

~~~ts
type GameManifest = {
  id: string;
  title: string;
  minPlayers: number;
  maxPlayers: number;
  controllerLayout: ControllerLayout;        // §11/§12: Standard-Layout pro Spiel
  entryUrl: string;                           // iframe-src, §11 Entry-Point
  aspectRatios: string[];                     // §11, z. B. ["16:9"]
  estimatedRoundSeconds: number;              // §11
  status: "internal" | "submitted" | "published"; // §11
  origin: "builtin" | "external";             // "external" = Post-MVP, §16
};
~~~

**Lifecycle & Host↔Game-Vertrag.** Die Shell ruft Hooks per `postMessage` auf; das Spiel antwortet bzw. emittiert Render-Patches. `external`-Spiele und der QR-/AI-Submit (§16) sind ausdrücklich Post-MVP und bleiben dort isoliert.

| Richtung | Nachricht | Bedeutung |
|---|---|---|
| Host → Game | `init` | Manifest, Spielerliste, Seed, `reducedMotion`-Flag |
| Host → Game | `start` / `end` | Runde starten/beenden |
| Host → Game | `playerJoin` / `playerLeave` | Spielerwechsel (§14 Player) |
| Host → Game | `controllerEvent` | validiertes `ControllerEvent` |
| Game → Host | `ready` / `roundEnded` | Protokoll-Events; `roundEnded` bildet serverseitig auf `GameSession.state = "finished"` (§14) ab |
| Game → Host | `setControllerLayout` | optionales spielspezifisches Layout (§9, später) |

~~~ts
interface GameSDK {
  init(ctx: {
    manifest: GameManifest;
    players: Player[];
    seed: string;
    reducedMotion: boolean;       // System-Hinweis, Animationen drosseln
  }): void;
  onPlayerJoin(player: Player): void;
  onPlayerLeave(playerId: string): void;
  onControllerEvent(event: ControllerEvent): void;
  start(): void;
  end(reason?: string): void;
}

// Screen-Rendering: das Spiel rendert autonom im iframe-Canvas/DOM
// und meldet nur Statuswechsel zurück (kein Pixel-Streaming).
function host(sdk: GameSDK): void; // bindet postMessage-Bridge an Hooks
~~~

Das Spiel rendert eigenständig in seinem iframe (Canvas/DOM) im per `aspectRatios` deklarierten Verhältnis; die Shell skaliert nur den Container. Das `reducedMotion`-Flag aus dem `init`-Kontext erlaubt es Spielen, Animationen zu drosseln. Spielspezifische Controller-Layouts (§9) sind über `setControllerLayout` als spätere Erweiterung vorgesehen; im MVP gilt das `controllerLayout` aus dem Manifest.

### 21.6 Frontend-Architektur (Screen- & Controller-View)

Die Web-App teilt sich in zwei klar getrennte Rollen, wie in §6 und §9 beschrieben: die **Screen-View** (großer Bildschirm) und die **Controller-View** (Handy). Beide sind Teil derselben Web-App; das Routing entscheidet anhand der URL, welche Oberfläche gerendert wird.

#### Routing

| Pfad | Rolle | Beschreibung |
|---|---|---|
| `/` | neutral | Startbildschirm: Lobby erstellen, beitreten, Katalog (§6.1) |
| `/l/:slug` | Screen | Lobby-Ansicht und laufendes Spiel auf dem großen Bildschirm |
| `/c/:slug` | Controller | Controller-View für das Handy; verbindet sich über `Lobby.slug` und reconnectet über persistierten Player-Token |

Das Slug-Feld aus dem `Lobby`-Typ (§14) ist die einzige Routing-Variable. Der Server gibt bei `/l/:slug` und `/c/:slug` dieselbe HTML-Shell aus; die React-Anwendung übernimmt das clientseitige Routing und lädt die passende View.

#### QR-Erzeugung auf dem Screen

Die Screen-View erzeugt den QR-Code clientseitig mit einer leichtgewichtigen Bibliothek wie **qrcode** (npm). Als Inhalt dient die vollständige URL der Controller-View (`https://couch.gg/c/:slug`). Der QR-Code wird als `<canvas>` oder inline-SVG gerendert und aktualisiert sich automatisch, wenn sich der Slug ändert. Kein serverseitiges Rendering des QR-Codes nötig.

#### Geteiltes Types-Paket

Alle Typen aus §12 und §14 (`Player`, `GameManifest`, `ControllerEvent`, `ControllerLayout`, `Lobby`, `Device`, `GameSession`) liegen in einem gemeinsamen Paket, z. B. `packages/types` in einem Monorepo. Screen-App, Controller-App und Server importieren daraus. Dadurch gibt es keine Typabweichungen zwischen Client und Server; ein Fehler beim Import schlägt beim Build an, nicht erst zur Laufzeit. Die folgende Datei-Aufteilung ist eine Umsetzungs-Konvention dieses Abschnitts (im Originalspec nicht vorgegeben):

~~~ts
// packages/types/src/index.ts – re-exportiert §12/§14-Typen
export type { Player, GameManifest, ControllerEvent, ControllerLayout } from "./game";
export type { Lobby, Device, GameSession } from "./lobby";
~~~

`ControllerLayout` (in §13 als Datenobjekt gelistet) muss dafür konkret typisiert werden, da `GameManifest.controllerLayout` darauf verweist (siehe Einleitung zu §21).

#### Mobile-Controller-Constraints (§9)

**Zoom verhindern**

Dem Controller-HTML-Shell wird folgender Viewport-Meta-Tag gesetzt:

~~~html
<meta name="viewport"
  content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
~~~

Zusätzlich verhindert `touch-action: none` auf dem Controller-Root-Element unbeabsichtigte Browser-Gesten:

~~~ts
// Controller-Root-Element
style={{ touchAction: "none", userSelect: "none" }}
~~~

**Scroll unterbinden**

Die Controller-Route setzt `height: 100dvh`, `overflow: hidden` und `overscroll-behavior: none` auf dem Wurzelelement (nur auf dieser Route aktiv). `100dvh` statt `100vh` vermeidet die Sprünge der mobilen Adressleiste; `overscroll-behavior` unterbindet Pull-to-Refresh und Gummiband-Scrollen, ohne `position: fixed` auf `body` zu erzwingen.

**Wake Lock gegen Display-Sleep**

Nach dem Verbinden versucht die Controller-View die Screen Wake Lock API:

~~~ts
let wakeLock: WakeLockSentinel | null = null;

async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // Nicht unterstützt oder verweigert – kein Fehler, stilles Fallback
    }
  }
}
~~~

Die API ist in aktuellen Chromium-Browsern auf Android verfügbar; auf iOS Safari wird sie ignoriert. Das ist akzeptiert; ein Fallback ist für MVP nicht vorgesehen.

**Input-Debouncing / geringe Latenz**

`ControllerEvent`-Emissionen (§12) werden direkt beim `pointerdown`- bzw. `pointerup`-Event abgesetzt, nicht beim `click`-Event, um Browserlatenz zu vermeiden. Für Achseneingaben (D-Pad, Joystick) wird ein Throttle von maximal 50 ms angewendet, das jedoch den letzten Wert nachzieht (trailing emit) und bei `pointerup` den Ruhewert sendet, damit der Steuerknüppel im Spiel nicht hängen bleibt:

~~~ts
const THROTTLE_MS = 50;
let lastSent = 0;
let trailing: ReturnType<typeof setTimeout> | null = null;

function handleAxisMove(event: PointerEvent) {
  const now = Date.now();
  const send = () => {
    lastSent = Date.now();
    socket.emit("controllerEvent", buildAxisEvent(event));
  };
  if (now - lastSent >= THROTTLE_MS) {
    send();
  } else {
    if (trailing) clearTimeout(trailing);
    trailing = setTimeout(send, THROTTLE_MS); // letzten Wert nachziehen
  }
}

function handleAxisUp() {
  if (trailing) clearTimeout(trailing);
  socket.emit("controllerEvent", buildAxisEvent(null)); // Ruhewert
}
~~~

Button-Events werden ohne Throttle, aber als Einzel-Emit pro Zustandswechsel (down/up) gesendet, damit kein Input verloren geht.

#### Reconnect & Token-Persistenz

Der bei `POST /api/lobbies/:id/join` erhaltene `playerToken` (siehe 21.7) wird im `localStorage` gehalten, damit ein Tab-Reload oder ein kurzer Verbindungsverlust nicht zum Verlust des Platzes führt. Beim Laden von `/c/:slug` prüft die Controller-View den gespeicherten Token und reconnectet über `lobbyId` + Token (§13), statt einen neuen Spieler anzulegen. So bleibt die Verbindung — wie in US-02 gefordert — auch über den Spielstart hinaus bestehen.

### 21.7 Backend-Services & HTTP/WS-API

Der Node/TypeScript-Server (§17) exponiert zwei Schichten: eine kleine REST-API für die initiale Ressourcenerzeugung und einen WebSocket-Kanal (Socket.IO) für den gesamten Echtzeitbetrieb. Alle Endpunkte sind zustandslos gegenüber persistenter Nutzerdaten; der temporäre Lobby-State wird ausschließlich im Prozessspeicher (z. B. einer `Map<string, Lobby>`) gehalten. Ein Login-System oder Nutzerprofile existieren im MVP nicht (§5).

#### HTTP-Endpunkte

| Methode & Pfad | Zweck | Eingabe (JSON-Body / Query) | Ausgabe (JSON) |
|---|---|---|---|
| `POST /api/lobbies` | Neue Lobby anlegen | `{ name?: string }` | `{ id, slug, url, screenToken }` |
| `GET /api/lobbies/:slug` | Lobby-Info lesen | — | `Lobby` (ohne Tokens) |
| `GET /api/games` | Liste verfügbarer `GameManifest`-Einträge | — | `GameManifest[]` |
| `POST /api/lobbies/:id/join` | Controller tritt bei; gibt `playerToken` aus | `{ playerName: string }` | `{ playerId, playerToken }` |

Der WebSocket-Verkehr läuft nicht über eine eigene REST-Route, sondern über den Socket.IO-Handshake auf `/socket.io/`; der Client übergibt `lobbyId` und `token` als Verbindungs-Query (`io(url, { query: { lobbyId, token } })`).

`POST /api/lobbies` ist der Einstiegspunkt des Screen-Clients. Er liefert ein `screenToken`, das ausschließlich das Screen-Device authentifiziert — nicht den Host-Spieler. Der Host ist laut §6.2 und §8 der erste beitretende Controller-Spieler; `Lobby.hostPlayerId` (§14) wird gesetzt, sobald der erste `playerToken` über `POST /api/lobbies/:id/join` ausgestellt wird.

`POST /api/lobbies/:id/join` löst das Bootstrap-Problem: Ein neuer Controller besitzt zu diesem Zeitpunkt noch kein Token. Er sendet nur seinen Anzeigenamen; der Server legt einen `Player`-Eintrag an, stellt ein `playerToken` aus und gibt beides zurück. Ist dies der erste Spieler, setzt der Server `Lobby.hostPlayerId` auf seine `playerId`. Danach verbindet sich der Controller per WebSocket mit dem erhaltenen `playerToken`.

#### ID-, Slug- und Token-Erzeugung

- **Lobby-ID**: UUID v4, interner Primary Key.
- **Slug**: 6 zufällige alphanumerische Zeichen aus einem kollisionsarmen Alphabet ohne `0`, `O`, `I`, `l` (z. B. `X3K9PQ`). Erzeugung mit `crypto.randomBytes` + Base36-Mapping; Kollision gegen die aktive Lobby-Map geprüft, bei Treffer neu gezogen (erwartet < 1 Wiederholung bei < 10 000 gleichzeitigen Lobbys).
- **screenToken / playerToken**: je 32 Byte, `crypto.randomBytes(32).toString('hex')`; einmalig ausgegeben und nie erneut übertragen. Clients speichern das Token im `localStorage`, damit Reconnect über die gesamte Lobby-Lebenszeit (bis zu 4 h) möglich ist.
- Lobby-URL: `https://couch.gg/lobby/:slug` — dieser Wert ist der QR-Code-Payload (§6.2).

Der Server hält eine separate `token → { rolle: "screen" | "controller", playerId?, lobbyId }`-Map im Prozessspeicher; das Datenmodell (§12/§14) selbst bleibt damit tokenfrei (§5).

#### WebSocket-Verbindungsaufbau

Der Client übergibt `lobbyId` und `token` beim Socket.IO-Handshake. Der Server prüft: (1) Existiert die Lobby? (2) Ist `token` ein gültiges `screenToken` oder registriertes `playerToken`? Aus dem Tokentyp ergibt sich unmittelbar die Rolle (`screen` bzw. `controller`). Bei Erfolg wird ein `Device`-Eintrag (§14) angelegt; bei Fehler wird die Verbindung mit `connect_error` abgewiesen.

#### WS-Nachrichten — eingehend (Socket.IO-Events)

| Event | Payload | Wer darf senden | Effekt |
|---|---|---|---|
| `game:select` | `{ gameId: string }` | Host-Controller | `Lobby.currentGameId` setzen, `GameManifest` laden |
| `game:start` | `{}` | Host-Controller | `Lobby.state → "playing"`, neue `GameSession` (`state → "running"`) anlegen, alle Devices erhalten das passende `controllerLayout` |
| `game:reset` | `{}` | Host-Controller | `GameSession.state → "finished"`, `Lobby.state → "waiting"` |
| `controller:input` | `ControllerEvent` | beliebiger Controller | an `GameSession`-Handler weiterleiten |

Der Server ermittelt anhand von `Lobby.hostPlayerId` (§14), ob ein Controller der Host ist. Host-Rechte sind an den `Player`, nicht an das `Device` gebunden.

#### WS-Nachrichten — ausgehend (Socket.IO-Events)

| Event | Payload | Empfänger |
|---|---|---|
| `lobby:state` | `Lobby & { players: Player[] }` | alle Devices der Lobby |
| `game:started` | `{ gameId, sessionId, controllerLayout }` | alle Devices |
| `game:ended` | `{ sessionId, result?: unknown }` | alle Devices |
| `controller:input` | `ControllerEvent` | Screen-Device der Lobby |
| `error` | `{ code: string, message: string }` | auslösendes Device |

Auto-Start (§8): Nach jedem erfolgreichen `POST /api/lobbies/:id/join` prüft der Server, ob ein Spiel gewählt wurde, `Lobby.state === "waiting"` gilt und `players.length >= GameManifest.maxPlayers` erreicht ist. Nur dann löst er intern `game:start` aus; ein bereits laufendes Spiel wird so nicht doppelt gestartet.

#### Token-Sicherheit und Sitzungsgrenzen

Tokens sind an die Lobby-Lebenszeit gebunden. Nach Ablauf von `Lobby.expiresAt` (empfohlen: 4 Stunden Inaktivität) werden alle Tokens invalidiert. Reconnect innerhalb der Gültigkeit funktioniert mit demselben `playerToken` via `lobbyId`. Ein Account-System ist kein MVP-Ziel (§5) und wird an keiner Stelle dieser API vorausgesetzt.

### 21.8 Identität, Tokens, Sicherheit & Game-Isolation

Das Sicherheitsmodell kommt ohne Accounts aus (§5). Identität ist anonym und kurzlebig: Beim ersten Beitritt erzeugt der Server pro Gerät ein `deviceToken` und pro Spieler ein `playerToken` (kryptografisch zufällig, 128 Bit, base64url). Beide werden im `localStorage` des Browsers gehalten; daraus speist sich auch die Liste gebookmarkter Lobbys aus §6.1. Der Server hält nur einen Hash (`sha256`) der Tokens, nie den Klartext. Es werden keine PII erhoben: `Player.name` (§12) ist ein Anzeigename ohne Verifikation; „optional" bezieht sich auf den Produktfluss (§7) — lässt der Spieler ihn aus, setzt der Server einen Default (z. B. „Spieler 3"), sodass das Pflichtfeld `name: string` aus §12 gewahrt bleibt.

Lobby-Zugriff erfolgt über `Lobby.slug` (raten-resistent) plus Token. Der Slug allein erlaubt nur das Beitritts-Onboarding; Reconnect an eine laufende Session erfordert das passende `playerToken` (§13). `Device.role` (`controller` | `screen`, §14) wird serverseitig beim Handshake gesetzt, nie vom Client diktiert. Tokens und Lobbys verfallen mit `Lobby.expiresAt`. Es gibt keine separate Rotation; bei der Host-Neuzuweisung (§8, siehe 21.4) wandert nur die Host-Rolle (`Lobby.hostPlayerId`) — die Tokens der Spieler bleiben unverändert, sodass kein Re-Auth nötig ist.

Missbrauchsschutz und Validierung am Realtime-Server (§17):

| Vektor | Maßnahme |
| --- | --- |
| Lobby-Erstellung | Rate-Limit pro IP (z. B. 5/min) via Token-Bucket |
| Nachrichten-/Event-Flut | Per-Socket-Throttle auf `ControllerEvent`/`ChatMessage`; Drop bei Überlauf |
| Fremde Origins | WebSocket-`Origin`-Check + CORS-Allowlist auf eigene Domains |
| Manipulierte Inputs | Schema-Validierung (Zod) jedes `ControllerEvent`; `playerId` und `timestamp` werden aus der Socket-Session abgeleitet, nicht aus dem Payload übernommen (siehe 21.3) |

Autoritativ bleibt der Server: Clients senden nur Eingaben, der Game-State liegt in der `GameSession` (§12).

Isolation nicht vertrauenswürdiger oder AI-generierter Spiele (Post-MVP, §16): Solche Games laufen ausschließlich in einem sandboxed iframe (`sandbox="allow-scripts"`, ohne `allow-same-origin`) auf einer separaten Origin. Sie erhalten keinen direkten Netzwerk-, `localStorage`- oder Cookie-Zugriff; die komplette Runtime-API (Spielerliste, Inputs, Rendering) wird über eine schmale, getypte `postMessage`-Brücke bereitgestellt (siehe 21.5). Eine strikte CSP (`default-src 'none'`, nur erlaubte Asset-Quellen) und das Sperren von `eval`/Top-Level-Navigation begrenzen die Angriffsfläche. Damit ist die Frage aus §19 („Wie wird ein externer Game-Submit sicher isoliert?") für den späteren Ausbau beantwortet, ohne den MVP zu belasten.

### 21.9 Hosting, Deployment & Skalierung

#### Architekturprinzip MVP

Der MVP betreibt einen einzigen zustandsbehafteten Node-Prozess. Alle Lobby- und Session-Objekte (`Lobby`, `Device`, `GameSession`, `Player`) aus §12/§14 leben im In-Memory-State dieses Prozesses. Ein externer Datenspeicher ist für den MVP nicht erforderlich; Lobbys sind kurzlebig und nicht persistent. Als Transport wird Socket.IO gewählt (zulässig nach §17), weil Reconnect, Heartbeat und Rooms bereits enthalten sind; rohe WebSockets blieben als Option, würden diese Mechanik aber selbst erfordern.

#### Environments

| Environment | Zweck | Konfiguration |
|---|---|---|
| `development` | Lokale Entwicklung | `NODE_ENV=development`, Hot-Reload, lokaler WS-Port |
| `production` | Öffentlicher Betrieb | `NODE_ENV=production`, TLS-Termination über Proxy, Secrets per Env-Vars |

Umgebungsspezifische Werte (Ports, CORS-Origins, Lobby-TTL) werden ausschließlich über Umgebungsvariablen gesetzt, nicht in versionierten Dateien.

#### Container-Deployment

Der Server wird als einzelner Docker-Container gebaut. Empfohlene Plattform für den MVP: **Fly.io** oder **Render**, da beide WebSocket-Verbindungen ohne weitere Konfiguration unterstützen und das Deployment direkt aus einem `Dockerfile` erlauben.

~~~dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/server.js"]
~~~

Fly.io-spezifisch: Eine einzige `fly.toml` mit `[http_service] internal_port = 3000` reicht für den MVP-Start in einer Region.

#### Healthcheck & Graceful Shutdown

Der Server stellt einen leichten `GET /healthz`-Endpunkt bereit (liefert `200 OK`), den Fly.io/Render als Readiness-/Liveness-Probe nutzen. Bei einem Re-Deploy gehen alle aktiven Lobbys verloren, da der State rein In-Memory ist; das ist im MVP akzeptiert (Lobbys sind ephemer, §13). Ein `SIGTERM`-Handler schließt offene Sockets sauber (`io.close()`) und sendet den Clients zuvor ein `server:shutdown`-Event, damit sie einen Reconnect/Neueinstieg anbieten können.

#### CI-Pipeline (MVP-schlank)

Ein GitHub-Actions-Workflow mit drei Schritten:

1. **Lint** — ESLint und TypeScript-Typcheck (`tsc --noEmit`)
2. **Test** — Unit- und Integrationstests mit Vitest
3. **Build & Deploy** — `npm run build` (esbuild/tsc), dann `flyctl deploy` (nur auf `main`)

Push auf Feature-Branches führt ausschließlich Lint und Test aus; Deploy wird nur auf `main` ausgelöst.

#### Skalierung: MVP vs. Post-MVP

**MVP — ein Prozess, eine Region:**  
Alle WebSocket-Verbindungen (Screen-Devices und Controller-Devices) laufen in einem einzigen Socket.IO-Namespace auf einem Node-Prozess. Events vom Typ `ControllerEvent` werden direkt im selben Prozess an die zugehörige `GameSession` weitergeleitet.

**Später — horizontale Skalierung (Post-MVP):**  
Sobald ein Prozess nicht mehr ausreicht, werden mehrere Instanzen hinter einem Load-Balancer betrieben. Da WebSocket-Verbindungen zustandsbehaftet sind, sind **Sticky Sessions** auf Load-Balancer-Ebene erforderlich. Zur Weiterleitung von Events zwischen Prozessen wird der **Socket.IO Redis-Adapter** eingesetzt: Jede Instanz publiziert Events in einen gemeinsamen Redis-Pub/Sub-Kanal; alle anderen Instanzen empfangen und leiten sie weiter.

~~~ts
// Post-MVP: Socket.IO Redis-Adapter (nicht MVP)
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
~~~

Diese Erweiterung erfordert keine Änderungen an den bestehenden Typen (`Lobby`, `Device`, `GameSession`) oder an der Game-Runtime-API aus §12.

#### Nicht-Ziele in diesem Bereich

- Kein Kubernetes oder komplexes Orchestrierungs-Setup im MVP.
- Keine persistente Datenbank im MVP (Lobbys sind ephemer).
- Keine native TV-App-Infrastruktur; Hosting bezieht sich ausschließlich auf die Web-Plattform (§5, §10).

### 21.10 Test-, Qualitäts- & Observability-Strategie

#### Unit-Tests

Reine Logik ohne I/O wird mit **Vitest** getestet. Prüfpunkte:

- **Slug- und Token-Erzeugung**: Kollisionsfreiheit bei 10 000 Iterationen, Zeichensatz- und Längenbeschränkungen gemäß `Lobby.slug` (§14) und dem Player-/Lobby-Token-Format aus §13.
- **Lobby-State-Reducer**: Übergänge `waiting → playing → ended`, Host-Rotation bei Disconnect (§8), automatischer Spielstart bei Maximalspielerzahl.
- **ControllerEvent-Validierung**: Typguards für `type: "button" | "axis" | "text" | "gesture"` und `value`-Plausibilität (§12).
- **GameManifest-Parsing**: Pflichtfelder `minPlayers`, `maxPlayers`, `controllerLayout` vorhanden und konsistent.

Ziel-Coverage: ≥ 80 % auf allen State-Reducer- und Utility-Funktionen; keine Coverage-Pflicht für Framework-Glue.

#### Integrationstests

Mit **Supertest** (HTTP) und einem echten **Socket.IO**-Testclient werden gegen eine in-process-Instanz des Lobby-Servers geprüft:

- WebSocket-Handshake: Client verbindet sich, erhält `lobby:state`-Event mit korrekter `Lobby`-Struktur.
- Reconnect-Flow: Client trennt Verbindung, reconnectet innerhalb der Grace-Period mit demselben Player-Token und `Device.role`; Server stellt Session wieder her. Die Grace-Period (MVP-Annahme 30 s) ist eine getroffene Designentscheidung; sie ist von der Lobby-Lebensdauer `Lobby.expiresAt` (§14) zu unterscheiden, deren genaue Dauer in §19 noch offen ist (siehe 21.4).
- Host-Übergabe: Host-Socket schließt; nächster Spieler laut Joinreihenfolge wird neuer Host (`Lobby.hostPlayerId` aktualisiert).
- Lobby-Expiry: `Lobby.expiresAt` wird serverseitig durchgesetzt; abgelaufene Lobbys lehnen neue Joins ab.

#### End-to-End-Tests

**Playwright** treibt einen vollständigen Durchlauf mit mehreren simulierten Clients:

~~~ts
// Beispielstruktur eines E2E-Szenarios
// screen öffnet die Plattform und erstellt eine Lobby
// ctrl1 / ctrl2 simulieren Handy-Controller
test("Lobby-Beitritt und Spielstart", async ({ browser }) => {
  const screen = await browser.newPage();      // Screen-View (großer Bildschirm)
  const ctrl1  = await browser.newPage();      // Controller Spieler 1
  const ctrl2  = await browser.newPage();      // Controller Spieler 2

  await screen.goto("/");
  const lobbyUrl = await createLobby(screen);  // QR-/Share-Link extrahieren

  await ctrl1.goto(lobbyUrl);
  await ctrl2.goto(lobbyUrl);

  // Assertions: beide Spieler sichtbar auf Screen-View,
  // Host-Indikator korrekt, Start-Button aktiv bei minPlayers erreicht
});
~~~

Abgedeckte Szenarios MVP:
- Lobby erstellen → QR-URL extrahieren → zwei Controller beitreten → Spielerliste aktualisiert
- Host startet Dummy-Spiel → `GameSession.state` wechselt auf `running` → Controller empfangen Layout-Event
- Controller-Input (`ControllerEvent`) erscheint auf der Screen-View (Funktions-Smoke-Test). Latenz wird nicht als hartes E2E-Assert geprüft (zu flaky im Browser/CI), sondern über die Metrik `couch_event_latency_ms` beobachtet (siehe unten und 21.11).

#### Observability

**Strukturiertes Logging** mit `pino` (JSON, Level-Steuerung per `LOG_LEVEL`-Env-Variable). Jeder Log-Eintrag enthält `lobbyId`, `playerId` (wenn kontextrelevant) und `ts` (Unix-ms).

**Basis-Metriken** werden als einfache In-Process-Counter gehalten und über einen `/metrics`-HTTP-Endpunkt im **Prometheus-Textformat** exponiert:

| Metrik | Typ | Beschreibung |
|---|---|---|
| `couch_lobbies_active` | Gauge | Aktuell offene Lobbys (`state: "waiting"\|"playing"`) |
| `couch_devices_connected` | Gauge | Verbundene WebSocket-Clients (Screen + Controller) |
| `couch_events_total` | Counter | Empfangene `ControllerEvent`-Nachrichten |
| `couch_event_latency_ms` | Histogram | Zeit zwischen Client-`timestamp` und Server-Empfang |

**Fehler-Tracking**: Unbehandelte Exceptions und unerwartete Socket-Fehler werden mit `pino` auf Level `error` geloggt; im MVP genügt das Stdout-Log. Post-MVP: Anbindung an Sentry oder Ähnliches.

Kein externer Monitoring-Stack ist MVP-Pflicht; die Prometheus-Exposition erlaubt späteres Andocken ohne Serveränderungen.

### 21.11 Performance- & Latenzbudgets

Couch-Gaming im selben Raum stellt andere Anforderungen als klassisches Online-Gaming: Spieler sehen den gemeinsamen Bildschirm sofort und nehmen Verzögerungen zwischen Tastendruck und Reaktion auf dem Screen unmittelbar wahr. Als Orientierung gilt: **Zielwert < 100 ms** End-to-End, ab etwa **150 ms** wird die Verzögerung spürbar, **200 ms** ist die harte Obergrenze, ab der das UI dem Spieler aktiv Feedback über den Verbindungsstatus geben muss.

#### Eingabe-Latenz (Controller → Screen)

| Pfad | Zielwert | Anmerkung |
|---|---|---|
| `ControllerEvent` absetzen → Server empfangen | < 30 ms | lokales WLAN, keine Mobilfunkverbindung |
| Server verarbeiten → Broadcast an Screen-`Device` | < 10 ms | serverseitige Verarbeitung ohne DB-Round-Trip |
| Screen empfangen → nächster Render-Frame | < 16 ms | entspricht 60 fps |
| Netz-/Queueing-Puffer | < 44 ms | Reserve für Funk-Jitter, TLS, Socket-Queueing |
| **Gesamt-End-to-End** | **< 100 ms** | Ziel für gutes lokales Netz |

Die ersten drei Komponenten summieren sich auf ~56 ms; die verbleibende Differenz zum 100-ms-Ziel ist bewusst als Puffer für Funk-Jitter und Queueing eingeplant. Bei schlechten Netzwerkbedingungen (Mobilfunk, Remote-Teilnehmer) sind bis zu 200 ms akzeptabel.

#### Render-Ziel auf dem Screen

Der Screen rendert mit 60 fps. Spiele müssen ihren Update-Loop so gestalten, dass ein Frame-Budget von 16 ms eingehalten wird. Schwere Berechnungen (z. B. Kollisionserkennung für viele Objekte) sind in Web Workers auszulagern, damit der Haupt-Thread frei bleibt.

#### Nachrichten-Payload

`ControllerEvent`-Nachrichten werden als kompaktes JSON über den WebSocket-Kanal übertragen. Ein typisches Event soll 200 Byte nicht überschreiten:

~~~ts
// Beispiel: kompaktes Button-Event
const event: ControllerEvent = {
  playerId: "p1",        // kurze ID, z. B. 8 Zeichen
  type: "button",
  control: "a",          // kurzer Bezeichner
  value: 1,              // 0 oder 1 für digitale Buttons
  timestamp: Date.now()  // Unix-Millisekunden
};
~~~

Binäres Framing (z. B. MessagePack) ist für Post-MVP reserviert, wenn Profiling echte Engpässe durch JSON-Overhead belegt.

#### Server-Tick und Broadcast-Strategie

Der Lobby-Server betreibt keinen festen globalen Tick. Stattdessen gilt:

- **Event-getriebener Broadcast**: Eingehende `ControllerEvent`-Nachrichten werden unmittelbar an alle `Device`-Einträge mit `role: "screen"` innerhalb derselben `Lobby` weitergeleitet (Fan-out per `lobbyId`).
- **State-Snapshots**: Der `GameSession`-State wird nur bei Zustandswechseln (`ready → running`, `running → finished`) als vollständiger Snapshot gepusht, nicht als kontinuierlicher Tick.
- **Heartbeat**: Alle 5 Sekunden sendet der Server einen Ping. Bleibt ein Client 15 Sekunden ohne Antwort, markiert der Server das `Device` als getrennt, entfernt es aus dem Broadcast-Set der Lobby und startet den Reconnect-/Slot-Freigabe-Timer (siehe 21.4).

Diese Heartbeat-/Reconnect-Mechanik setzt den Socket.IO-Transport voraus; bei rohen WebSockets müsste sie selbst implementiert werden (§13/§17 lassen die Wahl offen).

#### Reconnect-Zeitbudget

Ein Spieler, der kurz die Verbindung verliert, soll innerhalb von **10 Sekunden** automatisch reconnecten und seinen Platz in der laufenden `GameSession` wieder einnehmen. Clients identifizieren sich beim Wiederverbinden über `lobbyId` und einen kurzlebigen Player-Token (vgl. §13). Nach 30 Sekunden ohne Reconnect gilt der Slot als frei; das jeweilige Spiel behandelt diesen Spieler dann als ausgeschieden. Hinweis: Der `Player`-Typ (§12) führt kein eigenes Aktiv-/Inaktiv-Feld — „inaktiv" ist rein spielinterne Logik, abgeleitet aus dem fehlenden `socketId` (siehe 21.4).

#### Maximale Spielerzahl pro Lobby

Die Plattform-Annahme für MVP-Spiele ist eine **maximale Spielerzahl von 8 Spielern pro `Lobby`**. Diese Grenze basiert auf:

- Couch-Szenario: physisch passen selten mehr als 6–8 Personen sinnvoll vor einen Bildschirm.
- Broadcast-Last: bei 8 Controllern und einem Screen sind maximal 9 gleichzeitige WebSocket-Verbindungen pro Lobby zu erwarten; das ist mit einer einzelnen Node.js-Instanz problemlos handhabbar.

Spiele können über `GameManifest.maxPlayers` eine niedrigere Grenze setzen. Werte über 8 sind für Post-MVP-Szenarien (z. B. Remote-Partys mit mehreren Screens) vorgesehen und erfordern gesonderte Lastanalyse.

### 21.12 Zuordnung Tech-Komponenten zu MVP-Phasen

Die folgende Tabelle ordnet die technischen Bausteine dieses Kapitels (Unterabschnitte 21.1–21.11) den vier MVP-Phasen aus §18 zu. Jede Phase baut auf der vorherigen auf; kein Baustein aus Phase N setzt einen Baustein aus Phase N+1 voraus.

| Phase | Bezeichnung (§18) | Technische Bausteine | Abgedeckte Unterabschnitte |
|---|---|---|---|
| 1 | Lobby / QR / Controller / Dummy-Game | WebSocket-Server (Node/TypeScript, Socket.IO), Lobby-State im Arbeitsspeicher, `Lobby`- und `Player`-Objekte, QR-Code-Generierung (z. B. `qrcode`), Share-Link-Routing, Screen-Web-App (React/Vite), Controller-Web-App (mobil-optimiert), universelles Controller-Layout (D-Pad + Aktionsbuttons), `ControllerEvent`-Verarbeitung, Dummy-Game ohne echten Spielzustand | 21.1–21.4, 21.6, 21.7 |
| 2 | Erstes echtes Spiel / Auto-Start / Reconnect | `GameSession`- und `Device`-Objekte, `GameManifest`-Laden und -Validierung, Auto-Start-Logik bei `maxPlayers`, Host-Migration bei Disconnect (Vorschlag gemäß §8), Player-Token-basiertes Reconnect, serverseitiger Spielzustand, erstes vollständiges Partyspiel (Manifest-konform), Controller-Layout-Konfiguration per `GameManifest.controllerLayout` | 21.3–21.5, 21.7 |
| 3 | Katalog / weitere Spiele / Chat | Game-Katalog-API und -UI (Filterung nach `minPlayers`/`maxPlayers`, Status `published`), 2–3 zusätzliche Spiele mit eigenem Manifest, Remote-Join-Polish (Beitrittsseite zeigt erneut QR-Code), Basis-Chat oder Aktivitätsfeed (`ChatMessage`, §13 — Typ noch zu definieren), Lobby-URL-Bookmarks im `localStorage` | 21.5, 21.7, 21.10 |
| 4 | Submission / AI / TV | Spiel-Einreichungs-Flow (Isolation, Sandboxing), AI-/Vibe-Coding-Experimentbereich (Post-MVP, kein MVP-Blocker gemäß §5), TV-App-Strategie (Browser auf Smart-TV zuerst, dann Android-TV-Packaging gemäß §10) | 21.5, 21.8, 21.9 |

**Hinweis zu Phase 4:** AI-Game-Builder und native TV-App sind ausdrücklich Post-MVP (§5). Sie werden hier der Vollständigkeit halber aufgeführt, blockieren aber keine früheren Phasen.

#### Empfohlene Bau-Reihenfolge

In Anlehnung an §20 gilt: Der schnellste Weg zum spielbaren Kern ist eine strikte Phasentreue ohne Vorgriff auf spätere Bausteine.

1. **WebSocket-Server + Lobby-State** als erstes Artefakt — alle anderen Komponenten hängen davon ab.
2. **Screen-Web-App und Controller-Web-App** parallel entwickeln, sobald der Server einen stabilen `Lobby`- und `Player`-Handshake liefert.
3. **QR-Code und Share-Link** direkt in Phase 1 integrieren — sie sind der zentrale Einstiegspunkt und müssen von Beginn an testbar sein.
4. **Dummy-Game** als frühester Smoke-Test für die Ende-zu-Ende-Strecke: `ControllerEvent` → Server → Screen.
5. Erst wenn Phase 1 stabil läuft: `GameManifest`, `GameSession` und Reconnect-Logik (Phase 2).
6. Katalog-UI und Chat (Phase 3) erst nach mindestens einem echten Spiel, das die Manifest-Schnittstelle vollständig implementiert.
7. TV-Packaging und Submission-Infrastruktur (Phase 4) nur nach Validierung des Kerns durch echte Nutzung.

Dieses Vorgehen stellt sicher, dass zu jedem Zeitpunkt ein lauffähiger und demonstrierbarer Stand existiert — gemäß der Prämisse aus §20, dass der spielbare Kern Priorität vor allen Erweiterungen hat.
