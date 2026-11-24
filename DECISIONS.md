# Decisions

What Cyberverse may and may not do, and why. Anything that changes networking,
hosting, licensing or the packages it depends on gets an entry here first,
with who decided and when. Carried over from CyberLab's `QUESTIONS.md` when
Cyberverse became its own project (2026-11-24).

## Standing rules

- **Simulated only.** The engine models the network, services, sensors and
  attacks. Nothing in Cyberverse sends traffic on a real network. The lab
  range `10.88.0.0/16` exists only inside the engine.
- **The local server serves this computer only.** `npm start` and
  `npm run dev` bind to 127.0.0.1, answer only requests addressed to
  localhost, and refuse any other address.
- **The real DataQuant is never a target.** Its twin lives on `.internal`
  names.
- **No real credentials.** Lab passwords are made up and stay in the world
  files. Learners never see them, and neither does the manual.
- **Ask before adding a package.** Write it here with its version and licence.

## Decided

### 2026-11-23: host on Cloudflare

Cyberverse (simulated mode only) may run on the owner's Cloudflare account,
at `cyberverse.dataquant.dev` (the owner chose the address on 2026-11-24):
static UI, a Worker for the API, and one Durable Object per round. Every API
call needs a valid Cloudflare Access login, the Worker refuses all calls until
Access is set up, and there is no `workers.dev` address. Live mode is not part
of the hosted build. Steps: `docs/hosting-cloudflare.md`.

### 2026-11-23: wrangler as a dev dependency

`wrangler` 4.156.2 (Cloudflare's CLI, MIT/Apache-2.0), pinned, dev only, to
build, run locally and deploy the Worker. Nothing from it ships to learners.

### 2026-11-21: the first packages

`yaml` (runtime, reads the world files), `typescript` and `@types/node`
(dev only, for type-checking). Node runs the TypeScript directly, so there is
no build step for the local server.

## Open

### Live mode (`npm run compose`)

The generator writes draft Docker files that would run one organisation as
real containers: an internal network per zone, a gateway enforcing the zone
policy, Suricata, intentionally vulnerable images and a Kali box. **Nothing
may run until this is decided.** The questions: where it runs (a dedicated
VM is the suggestion, so the VM is the blast radius), host firewall rules so
lab containers can't reach the host, Suricata's host networking and
capabilities, and whether to mirror the images instead of pulling from Docker
Hub.
