# Cyberverse

A living miniverse for learning cybersecurity, mapped to the QCTO
Cybersecurity Analyst course (SAQA 118986).
Two organisations go about their day: **DataQuant**, a South African data
consultancy (a twin of the real company, on lab-only `.internal` names), and
**Siyakhula Local Municipality** (fictional, the mature organisation and
DataQuant's client). Staff and AI agents do their jobs, the business earns
money, sensors watch, and somebody is about to try their luck.

Every practical is one of two sides:

- **Prey:** you are the SOC analyst on shift. A live attacker adapts to what
  you do. You triage alerts, read logs, block, isolate, reset, switch controls
  on, and write the status report (EAS focus area 4.3).
- **Predator:** you are DataQuant's pentester with a signed scope letter and a
  Kali terminal. A defender bot watches. The floor starts in fog and fills in
  as your recon finds things.

The round ends in a two-sided debrief: what really happened (attacker,
detection, response, business), your score, the data that left the building,
and the blind spots where an attack step happened and no sensor saw it.

> **Status:** foundation, plus the first real floor. Practicals are floors in
> towers, drawn as a town on the start screen (see below). Defend floors 0 and
> 1 are built; the night shift and the pentest are placeholders that prove the
> loop works end to end. The rest are designed one by one.

## The towers

The start screen is a town. Blue buildings on the left defend, red ones on the
right attack, and each side has three towers: **intro**, **intermediate** and
**advanced**. Each storey of a building is a floor, lit once it can be played.
Click a building to see its floors. `practicals/towers.yaml` lists the towers
(`role` and `tier`, one building for each pair) and their floors; a floor
without a practical shows as "coming", and a tower with no floors is drawn
under construction.

- **Intro defend tower.** You're DataQuant's first security hire. Floors 0 to 6
  happen in DataQuant's small office; floor 7 is the night shift at Siyakhula
  (DataQuant has won its security contract by then).
- **Intro attack tower.** DataQuant's Offensive Security team. Designed after
  the intro defend tower.
- **Intermediate and advanced towers.** Under construction. The advanced towers
  are big organisations: branch offices joined by VPNs, a cloud estate and
  thousands of accounts.

The low floors are **guided**: a mentor card says why, one instruction at a
time says what to do, and each step ticks itself off when you do it, with a
short "Done" note beside whatever you just used. **Show me** makes the target
glow on the floor. Buttons that could hurt the business
are locked until the floor that teaches them. Guided floors run at their own
pace, can have no time limit, and end on a summary card instead of a score.

A guide lives in the practical file:

```yaml
guide:
  mentor: founder                     # a person in the organisation
  locked: { block: 3, isolate: 5 }    # action -> floor that unlocks it
  hold: [attack-surface-check]        # routine jobs kept off their schedule
  steps:
    - id: watch-login
      title: Watch a login
      say: What the mentor says.        # may use {ip:<system>}
      do: The one thing to do.
      hint: Shown with the glow on Show me.
      show: { host: crm }               # room, host, tab, or alert: drill|<rule id>
      script:                           # the world does this on cue
        - { after: 5, event: login, system: crm, user: ayanda, from: founder-laptop }
        # a login can forget its password first: fails: 3, every: 5
        # also: event: drill (a practice alert), event: guess (somebody on the
        # internet tries wrong passwords: user, src, tries, every), event: scan
        # (somebody scans a machine: system, and src on the internet or from one
        # of our machines), event: job (one of the organisation's processes runs
        # now, not on its schedule), event: phish (a lure to a person: to, src,
        # lure, and opens: seconds until they open it) and event: download
        # (somebody on the internet reads a path: system, src, path, port).
        # A guess with getsIn: true gets in on its last try.
      ask: { question: ..., options: [{ text: ..., correct: true, reply: ... }] }
      sort:                             # alerts to sort, each with the mentor's reply
        - { rule: nids-port-scan, from: vault, verdict: false-positive, right: ..., wrong: ... }
      done: { answer: correct }         # or look: room|host|tab|alert, or alert: closed
                                        # (drill: true, or rule: <id>, and a verdict),
                                        # or sorted: true (every alert in sort closed),
                                        # or action: block|isolate|rebuild|lock|reset|control
                                        # with a target (and user for lock and reset)
      wrong: Said when the step is done wrong, or an action hits the wrong target.
      replies: { 10.88.0.0/24: ... }    # per wrong target, on an action step
  outro: { title: ..., learned: [...] }
```

`npm run validate` checks every guide against the world at the practical's
level: rooms, machines, accounts, processes, the mentor, detection rules, guess
and scan addresses in the internet range, sort lists, and one correct answer per
question. A step the learner has already done when it starts (a block, a
control switched on, an alert closed) ticks itself off at once. A practical can
also switch on a control the organisation only plans
at its level (`controls: { cloud-ids: on }`); that changes the lab, not the
company's manual.

## Run it

Needs Node.js 22.18 or newer (it runs the TypeScript directly; there is no
build step).

```bash
cd cyberverse
npm install
npm run dev          # http://127.0.0.1:8788, this computer only
```

`npm run dev` is the one to leave running while the lab is being built:

- It restarts the server by itself when the game code, the world or the
  practicals change, and open pages reload themselves.
- Once a minute it checks GitHub for new commits on this branch and pulls them,
  so updates arrive without typing anything. It only fast-forwards, and it
  leaves your copy alone (and says why) if you have changed files or made
  commits of your own. `npm run dev -- --no-pull` turns the checking off.
- If the packages change it says so: stop it, run `npm install`, start it again.
- A restart ends any round in progress, because rounds live in the server's
  memory. Refreshing the page on its own keeps you in your round.

`npm start` runs the server once, with none of that.

Other commands:

```bash
npm run validate                      # check every world file at levels 1 to 4
npm run manual -- dataquant --level 2 # the operating manual, as Markdown
npm run round -- smoke-prey-night-shift --seed 7   # a headless round, printed
npm run compose -- siyakhula          # DRAFT live-mode files (not approved to run)
npm test                              # node:test, about two minutes
npm run typecheck
```

The server binds to 127.0.0.1 only and refuses any other address. Putting the
lab on a network goes through `DECISIONS.md` first.

### On your own domain, with Cloudflare

The lab can also run fully on Cloudflare (see `DECISIONS.md`,
2026-11-23). The screens are static files, each round runs in its own Durable
Object, and Cloudflare Access asks every learner to sign in. The steps are in
[docs/hosting-cloudflare.md](docs/hosting-cloudflare.md).

```bash
npm run cf:dev       # the Worker in Cloudflare's runtime, on http://localhost:8787
npm run cf:deploy    # build and upload, once wrangler.jsonc has your domain and Access settings
npm run cf:check     # build and type-check the Cloudflare folder
```

## How it fits together

```
worlds/                 the world files: one source, two outputs
  miniverse.yaml        lab range, the internet, attacker addresses, links between orgs
  detections.yaml       20 Suricata/Wazuh-style detection rules
  dataquant/            organisation.yaml + one file per department (9)
  siyakhula/            organisation.yaml + one file per department (8)
practicals/             one file per practical, and towers.yaml (the storylines)
src/world/              load, validate, resolve a level, generate the manual
src/engine/             the simulation: clock, world state, sensors and alerts,
                        staff bots, business pulse, attack toolkit, live attacker,
                        defender bot, attack terminal, scoring, learner's view,
                        guided floors (guide.ts)
src/server/             the API (api.ts, shared with Cloudflare) and the local web server
cloudflare/             the Cloudflare Worker, its round Durable Object, the Access check, the build
src/live/               DRAFT live mode: Docker Compose generator, eve.json parser
ui/                     the office floor and its windows (plain ES modules, no build step)
test/                   node:test suites
```

### One file, two outputs

Each department file describes the department at maturity levels 1 to 4
(items carry `from` / `until`). The same file feeds:

1. **The operating manual** (`src/world/manual.ts`): roles, processes, systems
   by name, information held, controls and policies, the maturity path. It is
   DataQuant's real manual.
2. **The lab** (`src/engine/`): people, schedules, machines, accounts,
   weaknesses, threats and sensors.

Fields marked LAB ONLY in `src/world/types.ts` (lab personas, passwords,
weaknesses, threats, addresses, live images, lab numbers) never reach the
manual. `test/manual.test.ts` checks that for both organisations at every
level.

The lab twin is deliberately broken: a control can be `status: in-place` in
the real company and `lab: off` in the twin. Lab names, clients and numbers
are made up, and the twin never shares machines or secrets with the real
DataQuant.

### The round screen

The office floor fills the screen and every panel floats over it as a window:
the guide, the SOC console, "Your actions", the machine you opened, and the
attack terminal. Drag a window by its bar (it snaps to the screen's edges and
to the other windows), resize it from its bottom-right corner or its left and
bottom edges, and fold it to just its bar with ▾. With the bar selected, the
arrow keys move it, Shift and the arrow keys resize it, and Enter folds it. The
layout is remembered in the browser; **Reset layout** in the top bar puts every
window back. The floor shrinks to fit whatever the open windows leave free. On
a phone the windows stack under the floor instead and only fold.

The map drags to look round, zooms with the scroll wheel, a pinch or + and −,
flies to a room on a double-click, and shows everything again with the fit
button or 0. The ? button (or the ? key) plays the short tour of the screen
that opens a tower's floor 0.

### A map that grows

The higher you climb, the more of the organisation you see. A practical's
`map:` block sets what its floor draws:

```yaml
map:
  rooms: [trust-risk, strategy-leadership]  # missing = every room
  outside: [internet]                       # internet and/or partners; missing = both
  perimeter: true                           # a firewall gate on the internet corner
  note: One line shown while the new rooms build in.
```

Rooms of a building that the floor has not opened yet sit dark ("not open
yet"). A room also builds in during the round when a guide step points into it,
an alert comes from it, or the learner opens one of its machines. When a floor
starts, the rooms that are new since the floor below rise in with a short
"what's new" note. An organisation's `sites:` group its rooms into buildings and
places on the map (Siyakhula's civic centre, services building and works depot;
Ikhaya's head office, cloud, stores and distribution centre), each `shift`ed to
leave ground between them.

### A living office

Each room the learner can see is furnished from its department and machines:
desks with screens, chairs and staff, AI agents as hovering bots, server racks
with blinking lights, plants, shelves, meeting tables, windows on the outside
walls and a sign on the back wall. The learner's own desk carries a "YOU"
marker, in the organisation's `home:` room. Outside there is lawn, trees, a
road with cars and street lamps. The game clock sets the light: day from
07:00 to 17:00, dusk for two hours either side, and night the rest of the
time, when the lamps and screens light the floor.

What happens to a machine shows on it: fire and smoke when it is down, a
padlock when it is encrypted, hazard tape when it is isolated, a spinner while
it is rebuilt, a red ring when the attacker owns it. A room with an open alert
gets a spinning beacon on its corner and a pulsing wash over its floor (amber
for medium, red for high and critical). The drawing code is in `ui/floor.js`,
with the furniture in `ui/props.js` and the shared isometric helpers in
`ui/iso.js`. Animations stop when the system asks for reduced motion.

### What a learner can see

The browser only ever gets the projection in `src/engine/view.ts`:

- **Prey** sees the floor, machines and alerts, and the logs of machines with
  a log agent. Leaks stay hidden until the round ends (in real life nobody
  knows yet). Alerts never say whether they are real.
- **Predator** sees only what recon found (fog of war) and never sees the
  defender's alerts.

### Simulated mode and live mode

Everything runs **simulated** today: the engine models the network, services,
sensors and attacks, deterministically from a seed. Nothing touches a real
network.

**Live mode** (`npm run compose`) is a draft for the office PC. It turns one
organisation at one level into Docker containers on internal-only networks in
the lab range, a gateway container that enforces the zone policy with
iptables, Suricata on the zone bridges, and a Kali box. It writes files for
review only. It is not approved to run (see `DECISIONS.md`).

## Safety

- Simulated mode only. Lab addresses are `10.88.0.0/16` and exist only inside
  the engine.
- Learners never attack the real DataQuant website or domain. The twin lives
  on `.internal` names.
- The server answers on localhost only, checks the Host header, and sets a
  strict content security policy.
- The Cloudflare build refuses every API call without a valid Cloudflare
  Access login, has no `workers.dev` address, and never serves the world
  files. Live mode is not part of it.
- No real credentials anywhere. Lab passwords are made up and live in the
  world files only.

## Where it came from

Cyberverse started on 2026-11-24 as version 8 of North Tech Africa's CyberLab
Simulator, and now lives on its own. The QCTO blueprints the practicals map to
are in `docs/qcto/`. Decisions that change what the lab may do (networks,
hosting, new packages) are recorded in `DECISIONS.md`.
