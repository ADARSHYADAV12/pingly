import type { Session, SessionState } from '../shared/types';
import { workingSetChanged } from '../shared/dock-state';

interface DockPayload {
  sessions: Session[];
  autoCollapseMs: number;
}

declare global {
  interface Window {
    pingly: {
      onSessions(cb: (p: DockPayload) => void): void;
      onSounds(cb: (s: { done: string; attention: string }) => void): void;
      onSound(cb: (name: 'done' | 'attention') => void): void;
      onToggle(cb: () => void): void;
      onHover(cb: (on: boolean) => void): void;
      onJumpResult(cb: (r: { cwd: string; result: string }) => void): void;
      setRect(r: { x: number; y: number; width: number; height: number }): void;
      setVisible(on: boolean): void;
      dismiss(cwd: string): void;
      jump(cwd: string): void;
    };
  }
}

const MAX_CARDS = 4;
const LEAVE_MS = 160;

const AGENT: Record<string, { label: string }> = {
  'claude-code': { label: 'Claude Code' },
  cursor: { label: 'Cursor' },
  codex: { label: 'Codex' },
  generic: { label: 'Agent' }
};

/** Short, human, never annoying. The agent's own text goes in the line underneath. */
const COPY: Record<SessionState, { title: string; fallback: (a: string) => string; action: string }> = {
  done: {
    title: 'Response ready',
    fallback: (a) => `${a} has finished and is waiting for you.`,
    action: 'Resume Coding'
  },
  'needs-input': {
    title: 'Waiting for your input',
    fallback: (a) => `${a} needs an answer before it can carry on.`,
    action: 'Open Session'
  },
  error: {
    title: 'Something went wrong',
    fallback: (a) => `${a} stopped before it could finish.`,
    action: 'Take me there'
  },
  working: {
    title: 'Working on it',
    fallback: (a) => `${a} is still going.`,
    action: 'Open Session'
  }
};

const stage = document.getElementById('stage') as HTMLDivElement;
const inner = document.getElementById('inner') as HTMLDivElement;

let sessions: Session[] = [];
let autoCollapseMs = 10000;
let pinned = false; // tray left-click keeps the dock expanded
let hovering = false;
let signature = '';
/** cwd -> transient message shown under a card, e.g. why a jump did not focus anything */
const notes = new Map<string, string>();

/* ---------- helpers ---------- */

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text; // never innerHTML — messages come from agents
  return n;
}

/** Inline SVG only; the CSP blocks every external resource. */
function svg(paths: string, viewBox = '0 0 24 24', stroke = true): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('fill', stroke ? 'none' : 'currentColor');
  if (stroke) {
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.9');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
  }
  s.innerHTML = paths;
  return s;
}

const ICON = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  wait: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 7v6"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>'
};

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A time node that keeps counting; `tpl` uses {t} as the placeholder. */
function live(origin: number, tpl: string, cls: string, short = false): HTMLElement {
  const n = el('span', cls);
  n.dataset.live = String(origin);
  n.dataset.tpl = tpl;
  if (short) n.dataset.short = '1';
  n.textContent = tpl.replace('{t}', short ? clock(Date.now() - origin) : fmt(Date.now() - origin));
  return n;
}

function tickTimes(): void {
  const now = Date.now();
  for (const n of document.querySelectorAll<HTMLElement>('[data-live]')) {
    const age = now - Number(n.dataset.live);
    n.textContent = n.dataset.tpl!.replace('{t}', n.dataset.short ? clock(age) : fmt(age));
  }
}

/* ---------- mascot ---------- */

/** Same geometry as the tray icon, on a 32-unit grid. */
function mascot(): SVGElement {
  return svg(
    `<g fill="none" stroke="#F5A524" stroke-width="1.5" stroke-linecap="round">
       <path d="M16 10.5V6.9"/>
     </g>
     <circle cx="16" cy="5.6" r="2" fill="#F5A524"/>
     <g stroke="#EFEBE4" stroke-width="4.6" stroke-linecap="round" fill="none">
       <path d="M8.6 19L6.6 23"/><path d="M23.4 19L26 15.6"/>
     </g>
     <rect x="9.6" y="26.2" width="4.6" height="2.9" rx="1.4" fill="#F5A524"/>
     <rect x="17.8" y="26.2" width="4.6" height="2.9" rx="1.4" fill="#F5A524"/>
     <rect x="6.4" y="10.8" width="19.2" height="17" rx="8.2" fill="#EFEBE4"/>
     <rect x="9.4" y="13.9" width="13.2" height="9.6" rx="4.3" fill="#131316"/>
     <g class="eyes" stroke="#F2F0EA" stroke-width="1.15" stroke-linecap="round" fill="none">
       <path d="M12.2 18.7q1.05-1.5 2.1 0"/><path d="M17.7 18.7q1.05-1.5 2.1 0"/>
     </g>
     <path d="M15 21.1q1 .9 2 0" stroke="#F2F0EA" stroke-width="1" stroke-linecap="round" fill="none"/>`,
    '0 0 32 32',
    false
  );
}

/* ---------- state decisions ---------- */

const urgent = (s: Session): boolean => s.state === 'needs-input' || s.state === 'error';

/** How long a card stays open after it arrives. Urgent states get longer to be noticed. */
const URGENT_EXPAND_MS = 30_000;

/**
 * The card pops open when something happens, then shrinks back to the pill. Nothing holds
 * the dock open indefinitely: while an agent is working you are looking somewhere else,
 * and a permission prompt from one project must not cover the screen while another runs.
 * Collapsing is not dismissing — the session stays, and its dot stays lit in the pill.
 */
function isExpanded(now: number): boolean {
  if (!sessions.length) return false;
  if (pinned || hovering) return true;
  return sessions.some((s) => {
    if (s.state === 'working') return false;
    return now - s.changedAt < (urgent(s) ? URGENT_EXPAND_MS : autoCollapseMs);
  });
}

/* ---------- rendering ---------- */

function metaItem(icon: string, text: string): HTMLElement {
  const n = el('span');
  n.append(svg(icon), document.createTextNode(text));
  return n;
}

function card(s: Session): HTMLElement {
  const agent = AGENT[s.agent] ?? AGENT.generic;
  const copy = COPY[s.state];
  const c = el('div', 'card');

  const art = el('div', 'mascot');
  art.append(mascot());
  c.append(art);

  const body = el('div', 'body');

  // header: who it is, then the quiet brand mark and the ghost close
  const top = el('div', 'top');
  top.append(el('span', 'agent', agent.label));
  const brand = el('span', 'brand');
  brand.append(el('i', `dot ${s.state}`), document.createTextNode('Pingly'));
  const close = el('button', 'close', '×') as HTMLButtonElement;
  close.title = 'Dismiss';
  close.setAttribute('aria-label', 'Dismiss');
  close.onclick = (e) => {
    e.stopPropagation();
    dismiss(c, s.cwd);
  };
  top.append(brand, close);
  body.append(top);

  // status is the loudest thing on the card
  const status = el('h2', 'status', copy.title);
  const badge = el('span', `badge ${s.state}`);
  badge.append(svg(s.state === 'done' ? ICON.check : s.state === 'error' ? ICON.alert : ICON.wait));
  status.append(badge);
  body.append(status);

  body.append(el('p', 'message', s.message || copy.fallback(agent.label)));
  if (s.detail) body.append(el('div', 'detail', s.detail));

  // metadata left, action right
  const foot = el('div', 'foot');
  const meta = el('div', 'meta');
  // A still-running agent has not finished anything, so it must not claim to have:
  // the old fallback rendered a static "Finished in 0s" on every working card.
  // Anything still in progress gets a ticking clock; only `done`/`error` report a total.
  const timed = (origin: number, tpl: string): HTMLElement => {
    const n = live(origin, tpl, '');
    n.prepend(svg(ICON.clock));
    return n;
  };
  meta.append(
    s.state === 'needs-input'
      ? timed(s.changedAt, 'Waiting {t}')
      : s.state === 'working'
        ? timed(s.startedAt, 'Working {t}')
        : metaItem(ICON.clock, `Finished in ${fmt(s.changedAt - s.startedAt)}`)
  );
  // the host is already implied by the agent name in the header, so only the project follows
  meta.append(metaItem(ICON.folder, s.project));
  foot.append(meta);

  const action = el('button', 'action') as HTMLButtonElement;
  action.append(document.createTextNode(copy.action), el('span', 'arrow', '→'));
  action.onclick = (e) => {
    e.stopPropagation();
    window.pingly.jump(s.cwd);
  };
  foot.append(action);
  body.append(foot);

  const note = notes.get(s.cwd);
  if (note) body.append(el('div', 'jump-note', note));

  c.append(body);
  // click anywhere on the card opens the session
  c.onclick = () => window.pingly.jump(s.cwd);
  return c;
}

function dismiss(node: HTMLElement, cwd: string): void {
  node.classList.add('leaving');
  setTimeout(() => window.pingly.dismiss(cwd), LEAVE_MS);
}

/**
 * The idle state, deliberately minimal: while an agent is working you are looking at
 * something else, so this is a dot and a clock. Everything else is one hover away.
 */
function pill(): HTMLElement {
  const p = el('div', 'pill');
  if (sessions.length === 1) {
    const s = sessions[0];
    p.append(el('span', `dot ${s.state}`));
    p.append(
      s.state === 'working'
        ? live(s.startedAt, '{t}', 'meta', true) // how long it has been running
        : urgent(s)
          ? live(s.changedAt, '{t}', 'meta', true) // how long it has been waiting on you
          : el('span', 'meta', clock(s.changedAt - s.startedAt))
    );
    return p;
  }
  const dots = el('div', 'dots');
  for (const s of sessions.slice(0, 3)) dots.append(el('span', `dot ${s.state}`));
  p.append(dots, el('span', 'meta', String(sessions.length)));
  return p;
}

function render(force = false): void {
  const now = Date.now();
  const expanded = isExpanded(now);
  // Once a card collapses, a pill remains for anything still live — an amber dot for a
  // prompt you have not answered, a clock for work in progress. Finished-and-collapsed
  // needs nothing from you, so it goes away entirely.
  const visible = expanded || sessions.some((s) => s.state === 'working' || urgent(s));

  const sig = JSON.stringify([
    expanded,
    visible,
    [...notes],
    sessions.map((s) => [s.cwd, s.state, s.message, s.detail, s.agent, s.changedAt])
  ]);
  if (sig === signature && !force) {
    // Re-assert visibility on every tick even when nothing changed. Main only
    // acts on a transition (`visible && !isVisible()`), so a single missed
    // message — a sleep/resume, a stalled renderer — would otherwise strand the
    // window *shown over an empty DOM* forever, with events still arriving and
    // nothing ever painting. Re-sending is a no-op for main when it agrees, and
    // heals the mismatch within a second when it does not.
    window.pingly.setVisible(visible);
    return void tickTimes();
  }
  signature = sig;

  window.pingly.setVisible(visible);
  if (!visible) {
    stage.classList.remove('on');
    stage.style.height = '0px';
    inner.replaceChildren();
    reportRect();
    return;
  }

  inner.replaceChildren();
  if (!expanded) {
    inner.append(pill());
  } else {
    for (const s of sessions.slice(0, MAX_CARDS)) inner.append(card(s));
    if (sessions.length > MAX_CARDS) inner.append(el('div', 'more', `+${sessions.length - MAX_CARDS} more`));
  }

  stage.classList.add('on');
  stage.style.height = `${inner.offsetHeight}px`;
  reportRect();
}

/**
 * Main owns hit-testing; it only needs to know where the visible content actually is.
 * The union of the children, not #inner itself — #inner is padded to give the shadow
 * room, and that gutter must stay click-through.
 */
function reportRect(): void {
  const kids = [...inner.children].map((k) => k.getBoundingClientRect());
  if (!kids.length) return window.pingly.setRect({ x: 0, y: 0, width: 0, height: 0 });
  const left = Math.min(...kids.map((r) => r.left));
  const top = Math.min(...kids.map((r) => r.top));
  window.pingly.setRect({
    x: left,
    y: top,
    width: Math.max(...kids.map((r) => r.right)) - left,
    height: Math.max(...kids.map((r) => r.bottom)) - top
  });
}

/* ---------- wiring ---------- */

const audio: Partial<Record<'done' | 'attention', HTMLAudioElement>> = {};

window.pingly.onSounds((s) => {
  audio.done = new Audio(s.done);
  audio.done.volume = 0.35;
  audio.attention = new Audio(s.attention);
  audio.attention.volume = 0.55;
});

window.pingly.onSound((name) => {
  const a = audio[name];
  if (!a) return;
  a.currentTime = 0;
  void a.play().catch((e) => console.log(`sound failed: ${name} ${e}`));
});

window.pingly.onSessions((p) => {
  if (workingSetChanged(sessions, p.sessions) && p.sessions.some((s) => s.state === 'working')) {
    // A new turn must always begin as the promised dot + clock. Stale tray pin or hover
    // state from an older card must never make a working session occupy the full dock.
    pinned = false;
    hovering = false;
  }
  sessions = p.sessions;
  autoCollapseMs = p.autoCollapseMs;
  render();
});

window.pingly.onToggle(() => {
  pinned = !pinned;
  render();
});

window.pingly.onHover((on) => {
  hovering = on;
  render();
});

window.pingly.onJumpResult(({ cwd, result }) => {
  if (result === 'focused') return; // it worked; the dock is behind them now
  notes.set(
    cwd,
    result === 'flashed' ? 'Windows blocked the switch — flashing its taskbar button' : 'No matching window found'
  );
  render();
  setTimeout(() => (notes.delete(cwd), render()), 5000);
});

// Only reachable if the window ever holds focus, which it deliberately never takes.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const top = inner.querySelector<HTMLElement>('.card');
  const cwd = sessions[0]?.cwd;
  if (top && cwd) dismiss(top, cwd);
});

setInterval(() => render(), 1000);
