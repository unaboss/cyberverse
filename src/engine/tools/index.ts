// The desk: every tool a floor gives the learner, by name. A practical lists
// its tools under `tools:`, each with its own settings, and the round builds
// one of each. See tool.ts for what a tool is.

import type { LabEvent } from '../core.ts';
import type { ActionResult } from '../response.ts';
import { toolUse, type ToolArgs, type ToolModule, type ToolParts, type Tool } from './tool.ts';
import { riskTool } from './risk.ts';
import { scanTool } from './scan.ts';
import { honeypotTool } from './honeypot.ts';
import { powerTool } from './power.ts';
import { benchTool } from './bench.ts';
import { ticketsTool } from './tickets.ts';
import { wifiTool } from './wifi.ts';
import { sessionsTool } from './sessions.ts';
import { trafficTool } from './traffic.ts';
import { composeTool } from './compose.ts';
import { recoveryTool } from './recovery.ts';
import { evidenceTool } from './evidence.ts';
import { sqlTool } from './sql.ts';
import { scriptTool } from './script.ts';
import { cloudTool } from './cloud.ts';
import { segmentsTool } from './segments.ts';
import { designTool } from './design.ts';
import { approvalsTool } from './approvals.ts';
import { sheetTool } from './sheet.ts';
import { budgetTool } from './budget.ts';

/** Every tool a practical can ask for. */
export const TOOL_MODULES: Record<string, ToolModule<never>> = {
  risk: riskTool as ToolModule<never>,
  scan: scanTool as ToolModule<never>,
  honeypot: honeypotTool as ToolModule<never>,
  power: powerTool as ToolModule<never>,
  bench: benchTool as ToolModule<never>,
  tickets: ticketsTool as ToolModule<never>,
  wifi: wifiTool as ToolModule<never>,
  sessions: sessionsTool as ToolModule<never>,
  traffic: trafficTool as ToolModule<never>,
  compose: composeTool as ToolModule<never>,
  recovery: recoveryTool as ToolModule<never>,
  evidence: evidenceTool as ToolModule<never>,
  sql: sqlTool as ToolModule<never>,
  script: scriptTool as ToolModule<never>,
  cloud: cloudTool as ToolModule<never>,
  segments: segmentsTool as ToolModule<never>,
  design: designTool as ToolModule<never>,
  approvals: approvalsTool as ToolModule<never>,
  sheet: sheetTool as ToolModule<never>,
  budget: budgetTool as ToolModule<never>,
};

/** What each tool's window is called on the desk. */
export const TOOL_TITLES: Record<string, string> = {
  risk: 'Risk register',
  scan: 'Vulnerability scan',
  honeypot: 'Honeypot',
  power: 'UPS panel',
  bench: 'Workbench',
  tickets: 'Helpdesk queue',
  wifi: 'Wi-Fi survey',
  sessions: 'Webmail sessions',
  traffic: 'Traffic monitor',
  compose: 'Write-up',
  recovery: 'Recovery console',
  evidence: 'Evidence locker',
  sql: 'Query console',
  script: 'Script editor',
  cloud: 'Cloud console',
  segments: 'Store network map',
  design: 'Design board',
  approvals: 'Payments and approvals',
  sheet: 'Spreadsheet',
  budget: 'Security budget',
};

export class Toolbox {
  readonly tools = new Map<string, Tool>();
  private readonly parts: ToolParts;

  constructor(config: Record<string, unknown>, parts: ToolParts) {
    this.parts = parts;
    for (const [id, settings] of Object.entries(config)) {
      const module = TOOL_MODULES[id];
      if (module) {
        this.tools.set(id, (module as ToolModule<unknown>).create(settings ?? {}, parts));
      }
    }
  }

  start(): void {
    this.parts.bus.on((event) => this.observe(event));
    for (const tool of this.tools.values()) tool.start();
  }

  private observe(event: LabEvent): void {
    for (const tool of this.tools.values()) tool.observe(event);
  }

  act(toolId: string, op: string, args: ToolArgs): ActionResult {
    const tool = this.tools.get(toolId);
    if (!tool) {
      return { ok: false, message: 'That tool is not on your desk on this floor.' };
    }
    const outcome = tool.act(op, args);
    if (!outcome.ok) {
      return { ok: false, message: outcome.message };
    }
    this.parts.bus.emit(toolUse(this.parts.org, toolId, op, outcome));
    return { ok: true, message: outcome.message };
  }

  view(): Record<string, unknown> {
    return Object.fromEntries([...this.tools].map(([id, tool]) => [id, { title: TOOL_TITLES[id] ?? id, ...(tool.view() as object) }]));
  }
}
