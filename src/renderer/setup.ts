export {}; // makes this a module so the global augmentation below is legal

interface AdapterStatus {
  id: string;
  displayName: string;
  configPath: string;
  description: string;
  installed: boolean;
  wired: boolean;
  needsRestart: boolean;
}

declare global {
  interface Window {
    pinglySetup: {
      list(): Promise<AdapterStatus[]>;
      runtime(): Promise<{ nodeFound: boolean; nodePath: string }>;
      setWired(id: string, on: boolean): Promise<void>;
      demo(): Promise<void>;
    };
  }
}

const rows = document.getElementById('rows') as HTMLDivElement;
const note = document.getElementById('note') as HTMLDivElement;
const summary = document.getElementById('summary') as HTMLSpanElement;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Same mascot as the tray icon and the notification card. */
document.getElementById('mascot')!.innerHTML = `
<svg viewBox="0 0 32 32" fill="none">
  <path d="M16 10.5V6.9" stroke="#F5A524" stroke-width="1.5" stroke-linecap="round"/>
  <circle cx="16" cy="5.6" r="2" fill="#F5A524"/>
  <g stroke="#EFEBE4" stroke-width="4.6" stroke-linecap="round">
    <path d="M8.6 19L6.6 23"/><path d="M23.4 19L26 15.6"/>
  </g>
  <rect x="9.6" y="26.2" width="4.6" height="2.9" rx="1.4" fill="#F5A524"/>
  <rect x="17.8" y="26.2" width="4.6" height="2.9" rx="1.4" fill="#F5A524"/>
  <rect x="6.4" y="10.8" width="19.2" height="17" rx="8.2" fill="#EFEBE4"/>
  <rect x="9.4" y="13.9" width="13.2" height="9.6" rx="4.3" fill="#131316"/>
  <g stroke="#F2F0EA" stroke-width="1.15" stroke-linecap="round">
    <path d="M12.2 18.7q1.05-1.5 2.1 0"/><path d="M17.7 18.7q1.05-1.5 2.1 0"/>
  </g>
  <path d="M15 21.1q1 .9 2 0" stroke="#F2F0EA" stroke-width="1" stroke-linecap="round"/>
</svg>`;

async function refresh(): Promise<void> {
  const [list, rt] = await Promise.all([window.pinglySetup.list(), window.pinglySetup.runtime()]);

  // Every hook shells out to node. Without it, connecting anything is pointless.
  const warn = document.getElementById('nodewarn') as HTMLDivElement;
  warn.textContent = rt.nodeFound
    ? ''
    : 'Node.js was not found on this PC. Pingly’s hooks run through it, so nothing will fire until you install Node and reconnect.';
  const found = list.filter((a) => a.installed);
  const on = found.filter((a) => a.wired).length;

  summary.textContent = !found.length
    ? 'None detected on this PC'
    : on === 0
      ? `${found.length} detected · none connected yet`
      : `${on} of ${found.length} connected`;

  rows.replaceChildren();
  for (const a of list) {
    const row = el('div', 'row');
    const info = el('div', 'info');

    const name = el('div', 'name');
    name.append(
      el('span', undefined, a.displayName),
      el(
        'span',
        `state${a.wired ? ' on' : ''}`,
        !a.installed ? 'Not installed' : a.wired ? 'Connected' : 'Not connected'
      )
    );
    info.append(name);

    // say plainly what connecting will do, before they click it
    info.append(
      el('div', 'what', a.installed ? a.description : 'Nothing found at the path below, so there is nothing to connect.')
    );
    info.append(el('div', 'path', a.configPath));
    row.append(info);

    const btn = el('button', a.installed && !a.wired ? 'primary' : undefined) as HTMLButtonElement;
    btn.textContent = a.wired ? 'Disconnect' : 'Connect';
    btn.disabled = !a.installed || (!rt.nodeFound && !a.wired);
    btn.onclick = async () => {
      btn.disabled = true;
      const wasWired = a.wired;
      await window.pinglySetup.setWired(a.id, !wasWired);
      note.textContent = wasWired
        ? `Removed Pingly's hooks from ${a.displayName}. Your own settings were left untouched.`
        : a.needsRestart
          ? `${a.displayName} is connected. Restart it — hooks only load when a session starts.`
          : `${a.displayName} is connected and picks this up straight away. No restart needed.`;
      await refresh();
    };
    row.append(btn);
    rows.append(row);
  }
}

(document.getElementById('demo') as HTMLButtonElement).onclick = async () => {
  await window.pinglySetup.demo();
  note.textContent = 'Sent one to the top of your screen — that is all you will ever see from Pingly.';
};

void refresh();
