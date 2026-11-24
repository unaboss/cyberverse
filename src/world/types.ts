// The world format: what a company in the miniverse is made of.
//
// A company is an organisation file plus one file per department. Every item
// in a department can be gated by maturity level (`from` / `until`), so one
// file describes the department at levels 1 to 4. The same file feeds two
// outputs: the real operating manual (src/world/manual.ts) and the lab
// (src/engine). Fields marked LAB ONLY never appear in the manual.

export type Level = 1 | 2 | 3 | 4;
export const LEVELS: readonly Level[] = [1, 2, 3, 4];

export interface Gated {
  /** First maturity level at which this exists. Defaults to 1. */
  from?: Level;
  /** Last maturity level at which this exists. Defaults to 4. */
  until?: Level;
}

export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export type Stage =
  | 'recon'
  | 'initial-access'
  | 'execution'
  | 'privilege-escalation'
  | 'credential-access'
  | 'lateral-movement'
  | 'collection'
  | 'exfiltration'
  | 'impact';

export const STAGES: readonly Stage[] = [
  'recon',
  'initial-access',
  'execution',
  'privilege-escalation',
  'credential-access',
  'lateral-movement',
  'collection',
  'exfiltration',
  'impact',
];

// ---------------------------------------------------------------- miniverse

export interface MiniverseDef {
  id: string;
  name: string;
  /** Every lab address must sit inside this range. */
  labRange: string;
  /** The "outside world": where attackers and the public internet live. */
  internet: { cidr: string; attackerPool: string[] };
  organisations: string[];
  links: LinkDef[];
}

export interface LinkDef extends Gated {
  id: string;
  name: string;
  kind: 'vpn' | 'api' | 'supplier';
  /** "org/system" that opens the link. */
  src: string;
  /** "org/system" it reaches. */
  dst: string;
  ports: number[];
  description: string;
}

// ------------------------------------------------------------- organisation

export interface OrganisationDef {
  id: string;
  name: string;
  kind: string;
  domain: string;
  tagline: string;
  /** The organisation's current maturity level. */
  level: Level;
  /** True for a fictional organisation, false for a twin of a real one. */
  fictional: boolean;
  colour: string;
  /** Rands per hour the business earns or serves while its critical systems run. */
  revenuePerHour: number;
  floor: { width: number; height: number };
  zones: ZoneDef[];
  /** Which zone may talk to which. Same-zone traffic is always allowed. */
  policy: FlowDef[];
  departments: string[];
  /** How the map groups the rooms into buildings and places. Missing = one building. */
  sites?: SiteDef[];
  /** The room the security team sits in: the learner's own desk on the map. */
  home?: string;
}

export type SiteKind = 'building' | 'depot' | 'cloud' | 'stores';

/** A building or place on the map, holding some of the organisation's rooms. */
export interface SiteDef {
  id: string;
  name: string;
  /** How the map draws it. Missing = an office building. */
  kind?: SiteKind;
  rooms: string[];
  /** Grid squares the map moves the site by, to leave ground between buildings. */
  shift?: { x: number; y: number };
}

export interface ZoneDef extends Gated {
  id: string;
  name: string;
  cidr: string;
}

export interface FlowDef extends Gated {
  /** A zone id, or "internet". */
  src: string;
  dst: string;
  ports: number[] | 'any';
  note?: string;
}

// --------------------------------------------------------------- department

export interface DepartmentDef {
  id: string;
  name: string;
  purpose: string;
  /** Where the department sits on the office floor (grid cells). */
  room: RoomDef;
  people: PersonDef[];
  processes: ProcessDef[];
  systems: SystemDef[];
  data: DataDef[];
  connections: ConnectionDef[];
  /** LAB ONLY: realistic attacks against this department. */
  threats: ThreatDef[];
  controls: ControlDef[];
  maturity: Record<Level, string>;
  /** QCTO module, topic or external-assessment ids this department exercises. */
  qcto: string[];
}

export interface RoomDef {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PersonDef extends Gated {
  id: string;
  role: string;
  kind: 'human' | 'agent';
  /** Fictional lab persona. Never a real person's name. */
  name: string;
  /** For agents: what it is allowed to touch. */
  permissions?: string[];
  /** 0 (clicks anything) to 1 (never falls for a lure). LAB ONLY. */
  awareness?: number;
  description?: string;
}

export interface ProcessDef extends Gated {
  id: string;
  name: string;
  /** Person id. */
  owner: string;
  /** How often it runs in the lab, for example "20m" or "2h". */
  every: string;
  /**
   * The real rhythm, for the manual, when the lab compresses it (a weekly
   * review runs every few hours in a round). Defaults to `every`.
   */
  cadence?: string;
  /** "work" runs 08:00-17:00 only; "always" runs around the clock. */
  hours: 'work' | 'always';
  /** The manual's description of the process. */
  steps: string[];
  /** Still a draft with the owner: the manual marks it as proposed. */
  proposed?: boolean;
  /** LAB ONLY: what the staff bot does in the lab each time it runs. */
  activity: ActivityDef[];
}

export type ActivityAction = 'login' | 'http' | 'file' | 'mail' | 'scan' | 'query' | 'transfer';

export interface ActivityDef {
  action: ActivityAction;
  /** System id in this organisation, or "org/system". */
  system: string;
  /** Person id the bot acts as. Defaults to the process owner. */
  as?: string;
  /** Account name to log in with, when it is not the person's own. */
  account?: string;
  /** Source system (the person's device) for network activity, or "internet" for the public. */
  via?: string;
  path?: string;
  /** Chance (0..1) the person mistypes their password first. */
  typo?: number;
  bytes?: number;
}

export interface SystemDef extends Gated {
  id: string;
  name: string;
  hostname: string;
  kind: string;
  zone: string;
  ip: string;
  os: string;
  /** A critical system takes revenue down with it. */
  critical?: boolean;
  services: ServiceDef[];
  /** LAB ONLY: accounts with lab passwords. */
  accounts?: AccountDef[];
  /** LAB ONLY: deliberate flaws in the lab twin. */
  weaknesses?: WeaknessDef[];
  /** LAB ONLY: how live mode runs this machine. */
  live?: LiveDef;
  /** LAB ONLY: this machine's log is the network sensor's flow log (the sensor box itself). */
  logs?: 'nids';
  description?: string;
}

export interface ServiceDef {
  port: number;
  proto?: 'tcp' | 'udp';
  name: string;
  product: string;
  version: string;
}

export interface AccountDef {
  user: string;
  /** LAB ONLY: a made-up lab password. */
  password: string;
  role: 'user' | 'admin' | 'service';
  person?: string;
  mfa?: boolean;
  /** Service the account logs in through, for example "ssh" or "https". */
  service?: string;
}

export type WeaknessKind =
  | 'weak-password'
  | 'default-credentials'
  | 'vulnerable-service'
  | 'exposed-secret'
  | 'misconfiguration'
  | 'privilege-escalation'
  | 'phishable';

export interface WeaknessDef extends Gated {
  id: string;
  name: string;
  kind: WeaknessKind;
  /** Port the weakness is reached through. */
  port?: number;
  /** Exploit module name, for vulnerable services. */
  module?: string;
  cve?: string;
  /** Access level an attacker gains. */
  grants?: 'user' | 'root';
  /** The account a password weakness concerns. */
  account?: string;
  /** URL path the weakness lives on, for web flaws such as SQL injection. */
  path?: string;
  /** For exposed secrets: the credential it reveals, "org/system:user". */
  reveals?: string;
  /** Data ids it gives direct read access to, for example through SQL injection. */
  exposes?: string[];
  description: string;
}

export interface DataDef extends Gated {
  id: string;
  name: string;
  sensitivity: Sensitivity;
  /** Personal information under POPIA. */
  personalInformation: boolean;
  system: string;
  path: string;
  records?: number;
  /** Rands of harm if it leaks: fines, notification, lost clients. */
  impact: number;
  description?: string;
}

export interface ConnectionDef extends Gated {
  /** A department id, "org:<id>" or "external:<name>". */
  to: string;
  kind: string;
  trust: string;
}

export interface ThreatDef extends Gated {
  id: string;
  name: string;
  /** MITRE ATT&CK technique id. */
  attack: string;
  stage: Stage;
  /** System id the threat lands on. */
  target: string;
  /** Weakness id it uses. */
  uses?: string;
  description: string;
  qcto?: string[];
}

export type ControlKind = 'preventive' | 'detective' | 'corrective';

export interface ControlDef extends Gated {
  id: string;
  name: string;
  kind: ControlKind;
  /** The real company's status, for the manual. */
  status: 'in-place' | 'planned';
  /**
   * LAB ONLY: whether the lab twin has it switched on at the start of a round.
   * Defaults to on when in place. The twin is deliberately broken, so a real
   * control can be off in the lab; a practical can switch it either way.
   */
  lab?: 'on' | 'off';
  /** Weakness ids this control removes while it is on. */
  fixes?: string[];
  /** A sensor this control provides while it is on. */
  sensor?: SensorDef;
  /** Detection rule ids it switches on. */
  rules?: string[];
  /** Account lockout after this many failed logins, while on. */
  lockoutAfter?: number;
  /** While on, every person's account needs a second factor. */
  mfa?: boolean;
  /** The policy text for the manual. */
  policy?: string;
  /** Still a draft with the owner: the manual marks it as proposed. */
  proposed?: boolean;
  description: string;
}

export type SensorType = 'nids' | 'hids' | 'weblog' | 'mail' | 'decoy';

export interface SensorDef {
  type: SensorType;
  /** Zone ids (nids) or system ids (hids, weblog, mail) it covers. */
  covers: string[];
}

export interface LiveDef {
  image: string;
  env?: Record<string, string>;
  command?: string;
}

// ---------------------------------------------------------- detection rules

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export interface RuleDef {
  id: string;
  name: string;
  sensor: SensorType;
  severity: Severity;
  attack: string;
  /** What a matching event looks like. */
  match: RuleMatch;
  /** Raise only after this many matches. Omitted means every match alerts. */
  threshold?: { count: number; withinSec: number; groupBy: EventKey[]; distinct?: EventKey };
  /** Raise only if an earlier pattern was seen with the same keys. */
  after?: { kind: string; count: number; withinSec: number; sameKeys: EventKey[] };
  /** Minimum seconds between repeat alerts for the same group. */
  cooldownSec?: number;
  description: string;
  /** What the analyst should do. */
  response: string;
}

export type EventKey = 'src' | 'dst' | 'dstPort' | 'user' | 'host' | 'service';

export interface RuleMatch {
  kind: string;
  service?: string;
  outcome?: 'ok' | 'fail';
  /** All of these tags must be on the event. */
  tags?: string[];
  /** Minimum bytes, for transfers. */
  minBytes?: number;
}

// ------------------------------------------------------------- practicals

export interface PracticalDef {
  id: string;
  title: string;
  /** "placeholder" until we design the practical together. */
  status: 'placeholder' | 'draft' | 'ready';
  role: 'prey' | 'predator';
  org: string;
  /** Override the organisation's level for this practical. */
  level?: Level;
  /** Time of day the round starts, "HH:MM". */
  startTime: string;
  /** 0 means no time limit (guided floors end when the last step is done). */
  durationMin: number;
  /** Simulated seconds per real second. */
  speed?: number;
  briefing: string;
  /**
   * Control overrides: control id -> on, off, or project (off, and the learner
   * can't just switch it on: it needs a budget and a plan). A control the
   * organisation only gets at a higher level is added for this floor.
   */
  controls?: Record<string, 'on' | 'off' | 'project'>;
  attacker?: AttackerProfileDef;
  defender?: { enabled: boolean; reaction: number };
  /**
   * Predator floors only: systems the learner already has a shell on when the
   * round starts, so an internal floor can begin from a foothold a previous
   * engagement reached instead of making the learner win it again. Each is a
   * system id in the practical's organisation.
   */
  foothold?: string | string[];
  /** Step-by-step guidance for the low floors of a tower. */
  guide?: GuideDef;
  /**
   * Desk tools this floor gives the learner, each with its own window (a risk
   * register, a vulnerability scanner, a honeypot...). See src/engine/tools.
   */
  tools?: Record<string, unknown>;
  /**
   * How much of the organisation the floor's map shows, so the map grows as a
   * tower climbs: floor 0 is a room or two, the top floor the whole building.
   */
  map?: MapDef;
  qcto: string[];
}

/** What a floor's map draws. */
export interface MapDef {
  /**
   * Departments drawn on the map. Missing means every department. A room the
   * floor needs later (a guide step points into it, an alert lands in it) is
   * built in when it is needed.
   */
  rooms?: string[];
  /** What lies beyond the walls: the internet and the partners. Missing means both. */
  outside?: Array<'internet' | 'partners'>;
  /** The firewall at the building's edge, drawn once the floor teaches it. */
  perimeter?: boolean;
  /** One line on what this floor's map adds, shown while the new rooms build in. */
  note?: string;
}

// ------------------------------------------------------------------ towers

/** How hard a tower is. The start screen draws one building per role and tier. */
export type TowerTier = 'intro' | 'intermediate' | 'advanced';

export const TOWER_TIERS: readonly TowerTier[] = ['intro', 'intermediate', 'advanced'];

/** A storyline of practicals that climbs from easy to hard. */
export interface TowerDef {
  id: string;
  name: string;
  role: 'prey' | 'predator';
  tier: TowerTier;
  blurb: string;
  floors: TowerFloorDef[];
}

export interface TowerFloorDef {
  floor: number;
  title: string;
  /** The practical that plays this floor. Missing while it is still being designed. */
  practical?: string;
  /** One line on what the floor teaches. */
  teaches: string;
}

// ------------------------------------------------------------------- guide

/** Learner actions a guided floor can lock until a later floor. */
export type LockableAction = 'block' | 'unblock' | 'isolate' | 'release' | 'rebuild' | 'lock' | 'reset' | 'control';

export interface GuideDef {
  /** Person id in the practical's organisation who speaks on the guide card. */
  mentor: string;
  /** Actions switched off on this floor -> the floor that unlocks them. */
  locked?: Partial<Record<LockableAction, number>>;
  /** True when the floor is scored out of 100 like a full round. */
  scored?: boolean;
  /**
   * Minutes of lab time the floor should take. The top bar counts down to it and
   * the summary says how long the learner took; running over never fails the floor.
   */
  target?: number;
  /**
   * The organisation's processes that stay off their schedule for the whole
   * floor, so a routine job never raises an alert the card knows nothing about.
   */
  hold?: string[];
  steps: GuideStepDef[];
  outro: { title: string; learned: string[]; next?: string };
}

export interface GuideStepDef {
  id: string;
  title: string;
  /** What the mentor says when the step starts. Text may use {ip:<system>}. */
  say: string;
  /** The one thing to do, in plain words. */
  do: string;
  /** Extra help, shown with the glow when the learner presses Show me. */
  hint: string;
  /**
   * What glows on Show me. `alert` is "drill" or a detection rule id; `tab` is a
   * SOC console tab or one of the floor's desk tools.
   */
  show?: { room?: string; host?: string; tab?: string; alert?: 'drill' | string };
  /** Things the world does when the step starts, seconds after it starts. */
  script?: ScriptDef[];
  /**
   * Seconds the step can take to finish by itself (a restore running in a desk
   * tool), so the learner is offered Skip ahead while it runs.
   */
  wait?: number;
  /** A question, shown once the step's script has run. */
  ask?: { question: string; options: { text: string; correct?: boolean; reply: string }[] };
  /** Alerts to sort into real and harmless, each with the mentor's reply (done: sorted). */
  sort?: SortDef[];
  /**
   * On an action step, what the mentor says when the learner does the action
   * to something else, by target. Anything not listed gets `wrong`.
   */
  replies?: Record<string, string>;
  done: GuideDoneDef;
  /** Said when the step is done. */
  praise?: string;
  /** Said instead of praise when an alert was closed with the wrong verdict. */
  wrong?: string;
}

export type GuideDoneDef =
  | { look: 'room'; id?: string }
  | { look: 'host'; id: string }
  /** A SOC console tab (alerts, controls, blocks) or one of the floor's desk tools. */
  | { look: 'tab'; id: string }
  /** Opening an alert. With a rule, only an alert from that detection rule counts. */
  | { look: 'alert'; rule?: string }
  | { answer: 'correct' }
  /** Closing an alert: the step's drill, or one from a detection rule. */
  | { alert: 'closed'; drill?: boolean; rule?: string; verdict?: 'true-positive' | 'false-positive' }
  /** Every alert in the step's `sort` list closed, right or wrong. */
  | { sorted: true }
  /**
   * On an attack floor, a milestone the learner reaches with the terminal: a
   * scan that finds a host, a cracked or working login, a shell, a credential
   * dump, or data taken out. Matched on what the command actually achieved,
   * not on the text the learner typed.
   */
  | { command: GuideTermDone }
  /**
   * The learner did something: block an address, isolate, rebuild or reset on
   * a machine, or switch a control on. The same action on anything else gets
   * the step's `wrong` reply and the step stays.
   */
  | GuideActionDone;

export interface GuideTermDone {
  /**
   * What the command reached:
   * - `read`   a command whose line contains `text` (reading the scope letter)
   * - `scan`   a port scan found the host `of` (or any host, if `of` is left out)
   * - `crack`  a password guessed with hydra on `of` (optionally for `user`)
   * - `login`  a working login to `of` (hydra, ssh, psql; optionally `user`)
   * - `shell`  a shell opened on `of` by an exploit
   * - `dump`   credentials dumped on `of`
   * - `exfil`  data copied off `of`
   */
  did: 'read' | 'scan' | 'crack' | 'login' | 'shell' | 'dump' | 'exfil';
  /** The system (an id within the scope organisation) it is done to. */
  of?: string;
  /** For `read`: a word the command line must contain. */
  text?: string;
  /** For `crack` and `login`: the account. */
  user?: string;
}

export interface GuideActionDone {
  /**
   * A built-in action (block, isolate, rebuild, lock, reset, control) or a desk
   * tool's operation, "tool.op", for example "risk.score".
   */
  action: string;
  /**
   * An address (block), a system id (isolate, rebuild, lock, reset), a control id,
   * or what a tool's operation was done to. Left out, anything counts.
   */
  target?: string;
  /** Several targets: the step is done once each one has been done right. */
  targets?: string[];
  /** The targets must be done in the order listed. */
  order?: boolean;
  /** The account, for lock and reset. */
  user?: string;
}

/**
 * One alert a guided step expects the learner to sort. It is matched by its
 * detection rule and, when given, where it came from.
 */
export interface SortDef {
  rule: string;
  /** One of the organisation's systems the alert came from. */
  from?: string;
  /** An address the alert came from. */
  src?: string;
  verdict: 'true-positive' | 'false-positive';
  /** What the mentor says when the learner gets it right, and when they don't. */
  right: string;
  wrong: string;
}

export type ScriptDef =
  | {
      after: number;
      event: 'guess';
      /** Somebody on the internet guesses passwords for one account. Every guess is wrong. */
      system: string;
      user: string;
      /** An address in the miniverse's internet range. */
      src: string;
      tries: number;
      /** Seconds between guesses. */
      every: number;
      /** The last try is the account's real password: a vendor default, say. */
      getsIn?: boolean;
    }
  | {
      after: number;
      event: 'login';
      /** System id in the practical's organisation. */
      system: string;
      user: string;
      /** System id the login comes from. */
      from: string;
      outcome?: 'ok' | 'fail';
      /** Wrong passwords typed first, like a person who forgot theirs, before the right one. */
      fails?: number;
      /** Seconds between those tries (default 4). */
      every?: number;
    }
  | {
      after: number;
      event: 'scan';
      /** Somebody checks which ports a system has open. Always hostile. */
      system: string;
      /** An address in the miniverse's internet range... */
      src?: string;
      /** ...or one of the organisation's machines, taken over. */
      from?: string;
      /** How many of the most common ports (default 100). */
      ports?: number;
    }
  | {
      after: number;
      event: 'phish';
      /** Person id the lure is sent to. */
      to: string;
      /** The sender's address, in the internet range. */
      src: string;
      /** The attachment's name. */
      lure: string;
      /** Seconds after delivery when the person opens it, on their own device. Never, if left out. */
      opens?: number;
    }
  | {
      after: number;
      event: 'sweep';
      /**
       * A slow scan from one of the organisation's machines: one probe at a time,
       * address after address, too slow for a threshold rule to notice. It stops
       * while the machine it runs on is isolated.
       */
      from: string;
      /** The zone it works through, address by address. */
      zone: string;
      ports: number[];
      /** Seconds between probes. */
      every: number;
      /** Seconds it keeps going. */
      for: number;
    }
  | {
      after: number;
      event: 'download';
      /** Somebody on the internet reads files from a system's web or storage service. */
      system: string;
      src: string;
      path: string;
      /** The port, when the system serves more than one. */
      port?: number;
    }
  | {
      after: number;
      event: 'job';
      /** A process of the organisation, run now instead of on its schedule. */
      process: string;
    }
  | {
      after: number;
      event: 'drill';
      /** System the drill alert points at. */
      system: string;
      name: string;
      severity: Severity;
      summary: string;
      response: string;
    };

export interface AttackerProfileDef {
  name: string;
  /** 0 (loud) to 1 (patient and quiet). */
  stealth: number;
  /** How many source addresses it can burn before giving up. */
  sources: number;
  /** "org/data-id" it is after. */
  objective: string;
  /** Seconds between stages, before jitter. */
  pace: number;
}
