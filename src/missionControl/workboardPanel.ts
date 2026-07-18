import type { INeonWorkboardSnapshot } from "../tasks/workboardSnapshot.js";

// Mission Control — server-rendered Neonika Workboard panel.
//
// Self-contained (own HTML escaper, no dependency on the large, concurrently
// edited gatewayHtml internals) so it can be injected with a single line and
// unit-tested via HTML-string assertions without a browser. Leak-safe by
// construction: the workboard snapshot is already redacted by the task store
// (titles/labels/links pass through redactText on write and read), and every
// dynamic field is HTML-escaped before it reaches an attribute or text node.
//
// Renders the live snapshot only: when no snapshot is supplied it shows an
// explicit empty/loading state rather than fabricating board data.

function escapeWorkboardPanelHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderWorkboardTaskRow(
  title: string,
  priority: string,
  owner: string,
  meta: string
): string {
  const metaSuffix = meta.length > 0 ? ` / ${escapeWorkboardPanelHtml(meta)}` : "";

  return `<div class="route-step" data-workboard-priority="${escapeWorkboardPanelHtml(
    priority
  )}"><div class="route-copy"><strong>${escapeWorkboardPanelHtml(
    title
  )}</strong><span>${escapeWorkboardPanelHtml(priority)} / @${escapeWorkboardPanelHtml(
    owner
  )}${metaSuffix}</span></div></div>`;
}

function renderWorkboardColumns(snapshot: INeonWorkboardSnapshot): string {
  const populated = snapshot.columns.filter((column) => column.count > 0);

  if (populated.length === 0) {
    return `<div class="route-list" data-workboard-empty="true"><div class="route-step"><div class="route-copy"><strong>Keine Aufgaben</strong><span>Der Arbeitsbereich ist leer.</span></div></div></div>`;
  }

  return populated
    .map((column) => {
      const rows = column.tasks
        .map((task) => {
          const due = task.due ? `fällig ${task.due}` : "";
          const runs = task.runIds.length > 0 ? `Runs ${task.runIds.length}` : "";
          const meta = [due, runs].filter((part) => part.length > 0).join(" / ");

          return renderWorkboardTaskRow(task.title, task.priority, task.ownerAgentId, meta);
        })
        .join("");

      return `<div class="route-list" data-workboard-column="${escapeWorkboardPanelHtml(
        column.status
      )}"><div class="route-step"><div class="route-copy"><strong>${escapeWorkboardPanelHtml(
        column.title
      )}</strong><span>${column.count} Aufgabe(n)</span></div></div>${rows}</div>`;
    })
    .join("");
}

/**
 * Render the server-rendered Workboard panel from a live snapshot. Pass the
 * snapshot from the async serving path; when omitted the panel shows a neutral
 * empty state (used by the static render and pre-fetch states).
 */
export function renderNeonMissionControlWorkboardPanel(
  snapshot?: INeonWorkboardSnapshot
): string {
  if (!snapshot) {
    return `<article class="panel" id="workboard">
          <div class="panel-header">
            <h2 class="panel-title">Neonika Arbeitsbereich</h2>
            <span class="tag" id="workboardStatus" data-workboard-state="loading">lädt</span>
          </div>
          <div class="panel-body">
            <div class="terminal">
              <div class="line"><strong>state</strong> <span>loading</span></div>
            </div>
          </div>
        </article>`;
  }

  const totals = snapshot.totals;

  return `<article class="panel" id="workboard">
          <div class="panel-header">
            <h2 class="panel-title">Neonika Arbeitsbereich</h2>
            <span class="tag" id="workboardStatus" data-workboard-state="${escapeWorkboardPanelHtml(
              snapshot.state
            )}">${totals.tasks} Aufgabe(n)</span>
          </div>
          <div class="panel-body stack">
            <div class="terminal" style="margin-bottom: 10px;">
              <div class="line"><strong>open</strong> <span data-workboard-open="${totals.open}">${totals.open}</span></div>
              <div class="line"><strong>blocked</strong> <span data-workboard-blocked="${totals.blocked}">${totals.blocked}</span></div>
              <div class="line"><strong>done</strong> <span data-workboard-done="${totals.done}">${totals.done}</span></div>
              <div class="line"><strong>overdue</strong> <span data-workboard-overdue="${totals.overdue}">${totals.overdue}</span></div>
              <div class="line"><strong>linked runs</strong> <span>${totals.linkedRuns}</span></div>
            </div>
            ${renderWorkboardColumns(snapshot)}
          </div>
        </article>`;
}
